/**
 * Threads: opening one, watching it settle, and reading what it says about
 * itself.
 *
 * The whole of a thread's *live* state — is the machine up, is a turn running,
 * how many turns have there been, which sandbox is it on — belongs to Fountain
 * and is asked for rather than stored. What this file adds is the small amount
 * that Fountain has no opinion about: which branch this thread was supposed to
 * cut, what it was opened from, and whether its opening turn has finished yet.
 *
 * `reconcile` is where those two meet, and it is the only place in the app that
 * writes anything as a *consequence* of what Fountain said. It runs on every
 * read of a thread, which sounds expensive and is not: the read was going to
 * fetch the conversation anyway, and everything `reconcile` does afterwards is
 * conditional on a state change that happens at most twice in a thread's life.
 */
import type { Db, ProjectRow, ThreadRow, UserRow } from "./db";
import type { Fountain } from "./fountain";
import { FountainHttpError, asHttpError } from "./fountain";
import type { Sprites } from "./sprites";
import type { GitHub } from "./github";
import { HttpError } from "./http";
import { branchFor, mountPathFor, slugify, threadChannel, HOME } from "../shared/ids";
import { RECEIPT_PATH, bootstrapPrompt, parseReceipt, starters, type Origin, type Receipt } from "../shared/spec";
import type { MachineState, Thread, ThreadHeader, ThreadOrigin, ThreadStatus } from "../shared/api";
import { refreshCloneToken } from "./projects";
import type { Conversation } from "../shared/fountain-types";

export interface NewThread {
  /** What to call it. Blank takes a name from the origin, or from the clock. */
  title: string;
  origin: Origin;
  /** What the person typed on the New thread screen, if anything. */
  prompt: string;
}

/**
 * Open a thread.
 *
 * One Fountain call does all of it — create the conversation, provision the
 * machine, and send the opening turn — because those three are one thing and
 * splitting them is how paddock started getting 422s. What comes back already
 * names the sandbox, so the row is written knowing which machine it got.
 */
export async function openThread(
  deps: { db: Db; fountain: Fountain; github: GitHub | null },
  user: UserRow,
  project: ProjectRow,
  input: NewThread,
): Promise<ThreadRow> {
  const title = input.title.trim() || titleFrom(input.origin);
  const slug = freeSlug(deps.db, project.id, title);
  const branch = project.repoFullName ? branchFor(user.login, slug) : null;
  const workdir = project.repoFullName ? mountPathFor(project.repoFullName) : HOME;

  // The token in the vault is the one this machine will clone with, and an
  // installation token lives an hour. Every machine is new here, so this is
  // never a formality.
  await refreshCloneToken(deps, project);

  const channel = threadChannel(project.id, slug, project.rev);
  let conversation: Conversation;
  try {
    conversation = await deps.fountain.createConversation({
      agent_id: project.agentId,
      environment_id: project.environmentId,
      vault_id: project.vaultId,
      title,
      channel_id: channel,
      prompt: bootstrapPrompt({
        repo: project.repoFullName,
        repoPath: project.repoFullName ? workdir : null,
        branch: branch ?? "",
        origin: input.origin,
        base: baseOf(input.origin) ?? project.defaultBranch,
      }),
    });
  } catch (err) {
    throw asHttpError(err, "open this thread");
  }

  return deps.db.createThread({
    id: crypto.randomUUID(),
    projectId: project.id,
    conversationId: conversation.id,
    sandboxId: conversation.sandbox_id ?? null,
    slug,
    title,
    branch,
    workdir,
    originKind: input.origin.kind,
    originBase: baseOf(input.origin),
    originNumber: "number" in input.origin ? input.origin.number : null,
    originTitle: "title" in input.origin ? input.origin.title : null,
    originUrl: originUrl(project.repoFullName, input.origin),
    rev: project.rev,
    queuedPrompt: input.prompt.trim() || null,
    createdByLogin: user.login,
  });
}

/**
 * Ask Fountain what is true, write down the parts that have just become true
 * for the first time, and hand back the view the browser renders.
 *
 * The three things that can newly become true, in the order they happen:
 *
 *   1. **A sandbox exists.** Cached on the row so the file and diff routes do
 *      not have to fetch the conversation first.
 *   2. **The opening turn finished.** The thread is marked open, the receipt
 *      is read, and the branch the machine *actually* ended up on replaces the
 *      one that was asked for — those differ when a base ref was deleted, and
 *      the branch shown in the UI must be the real one because it is what a
 *      pull request will be opened from.
 *   3. **There is a queued prompt.** Sent exactly once, by whichever request
 *      wins the race; `takeQueuedPrompt` is an atomic `UPDATE … RETURNING`ec
 *      precisely so that two browsers watching the same thread do not both
 *      send it.
 */
export async function reconcile(
  deps: { db: Db; fountain: Fountain },
  project: ProjectRow,
  row: ThreadRow,
): Promise<Thread> {
  if (row.closedAt) return view(project, row, null, "closed");
  if (!row.conversationId) return view(project, row, null, "building");

  // Narrowed once, here, rather than asserted at each of the three uses below.
  const conversationId = row.conversationId;

  let conversation: Conversation;
  try {
    conversation = await deps.fountain.getConversation(conversationId);
  } catch (err) {
    // A conversation Fountain no longer has is a thread whose machine was
    // reclaimed — which is what ephemeral means and not an error. Close the
    // row so the sidebar stops offering it.
    if (err instanceof FountainHttpError && err.status === 404) {
      deps.db.closeThread(row.id);
      return view(project, { ...row, closedAt: new Date().toISOString() }, null, "closed");
    }
    throw asHttpError(err, "read this thread");
  }

  if (conversation.sandbox_id && conversation.sandbox_id !== row.sandboxId) {
    deps.db.attachSandbox(row.id, conversation.sandbox_id);
    row = { ...row, sandboxId: conversation.sandbox_id };
  }

  const status = statusOf(conversation);

  // The opening turn has landed. This is the moment the thread becomes a
  // thread rather than a machine being built.
  if (!row.openedAt && conversation.turn_count >= 1 && status !== "building" && status !== "running") {
    deps.db.markOpened(row.id);
    row = { ...row, openedAt: new Date().toISOString() };

    const receipt = await readReceipt(deps.fountain, row.sandboxId);
    if (receipt?.branch && receipt.branch !== row.branch) {
      deps.db.setBranch(row.id, receipt.branch);
      row = { ...row, branch: receipt.branch };
    }

    const queued = deps.db.takeQueuedPrompt(row.id);
    if (queued) {
      try {
        await deps.fountain.prompt(conversationId, queued);
      } catch (err) {
        // Losing the first thing somebody typed is worse than showing it
        // twice, so it goes back in the queue for the next read to retry.
        console.error(`drydock: could not send the queued prompt for thread ${row.id}:`, err);
        deps.db.requeuePrompt(row.id, queued);
      }
    }
  }

  return view(project, row, conversation, status);
}

/** Every open thread of a project, reconciled. Concurrently, because they are independent. */
export async function listThreads(
  deps: { db: Db; fountain: Fountain },
  project: ProjectRow,
): Promise<Thread[]> {
  const rows = deps.db.threadsOf(project.id);
  return await Promise.all(rows.map((r) => reconcile(deps, project, r)));
}

/**
 * The card above the transcript.
 *
 * Every line of it comes from the receipt the machine wrote, so a thread whose
 * first turn has not finished renders as "setting up" rather than as a card
 * full of what was requested. The distinction is the point: this card is the
 * app's only claim about a machine it does not otherwise show you, and a claim
 * that turns out to be a prediction is worse than no card.
 */
export async function header(
  deps: { fountain: Fountain },
  project: ProjectRow,
  row: ThreadRow,
  setupScript: string,
): Promise<ThreadHeader> {
  const receipt = row.openedAt ? await readReceipt(deps.fountain, row.sandboxId) : null;
  const origin = originOf(row);
  return {
    copyOf: project.repoFullName,
    branchedFrom:
      receipt?.branch && receipt.base ? { branch: receipt.branch, base: receipt.base, sha: receipt.sha ?? null } : null,
    created: receipt ? { dir: receipt.path, files: receipt.files } : null,
    hasSetupScript: setupScript.trim().length > 0,
    starters: starters(toOrigin(origin), project.repoFullName),
  };
}

/**
 * Close a thread, and let the machine go with it.
 *
 * `terminate` rather than `delete`: the conversation stays readable so a
 * closed thread's transcript is still there, and the sandbox goes because
 * nothing else was ever attached to it. A failure to terminate does not stop
 * the row closing — the machine is ephemeral and Fountain reclaims it on its
 * own timetable regardless.
 */
export async function closeThread(deps: { db: Db; fountain: Fountain }, row: ThreadRow): Promise<void> {
  if (row.conversationId) {
    try {
      await deps.fountain.terminateConversation(row.conversationId);
    } catch (err) {
      console.error(`drydock: could not terminate the conversation for thread ${row.id}:`, err);
    }
  }
  deps.db.closeThread(row.id);
}

/**
 * The sprite behind a thread, for the terminal and the Run panel.
 *
 * Two failures, told apart because they need different words on screen: this
 * deployment cannot exec at all, and this particular machine is not up yet.
 */
export async function spriteOf(
  deps: { fountain: Fountain; sprites: Sprites | null },
  row: ThreadRow,
): Promise<{ spriteName: string; workdir: string }> {
  if (!deps.sprites) {
    throw new HttpError(501, "no_exec", "This drydock has no Sprites token, so it cannot run commands directly on a machine.");
  }
  if (!row.sandboxId) {
    throw new HttpError(409, "no_machine", "This thread's machine is still being built.");
  }
  let sprite: string | null = null;
  try {
    const sandbox = await deps.fountain.sandbox(row.sandboxId);
    if (sandbox.status !== "ready") {
      throw new HttpError(409, "machine_not_ready", `This thread's machine is ${sandbox.status}.`);
    }
    sprite = sandbox.sprite_name ?? null;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw asHttpError(err, "find this thread's machine");
  }
  if (!sprite) {
    throw new HttpError(501, "not_a_sprite", "This machine is not on Sprites, so drydock cannot reach it directly.");
  }
  return { spriteName: sprite, workdir: row.workdir };
}

// ── the small decisions ────────────────────────────────────────────────

/**
 * Fountain's five conversation states, as the four a person cares about.
 *
 * `pending` deserves the separate `building` rather than being folded into
 * `running`, because the two mean different things to somebody watching a
 * spinner: one of them is a large repository being cloned and the other is an
 * agent thinking. Telling them apart is most of what a good waiting state does.
 */
function statusOf(c: Conversation): ThreadStatus {
  if (c.status === "failed") return "failed";
  if (c.status === "terminated") return "closed";
  if (c.status === "running") return c.sandbox?.status === "ready" ? "running" : "building";
  if (c.status === "pending") return "building";
  return c.sandbox && c.sandbox.status !== "ready" ? "building" : "ready";
}

function machineOf(c: Conversation | null): MachineState {
  if (!c?.sandbox) return { sandboxId: c?.sandbox_id ?? null, status: c?.sandbox_id ? "pending" : "none", spriteName: null };
  return { sandboxId: c.sandbox.id, status: c.sandbox.status, spriteName: c.sandbox.sprite_name ?? null };
}

function view(project: ProjectRow, row: ThreadRow, c: Conversation | null, status: ThreadStatus): Thread {
  return {
    id: row.id,
    projectId: row.projectId,
    conversationId: row.conversationId,
    slug: row.slug,
    title: row.title,
    branch: row.branch,
    workdir: row.workdir,
    origin: originOf(row),
    status,
    stale: row.rev < project.rev,
    machine: machineOf(c),
    openedAt: row.openedAt,
    lastActiveAt: c?.last_active_at ?? null,
    turnCount: c?.turn_count ?? 0,
    unread: !!(c as { unread?: boolean } | null)?.unread,
    createdAt: row.createdAt,
    createdByLogin: row.createdByLogin,
  };
}

/**
 * Read the receipt, treating every failure as "not yet".
 *
 * There are four ways this legitimately comes back empty and none of them is
 * an error worth showing: the turn has not run, the machine is parked
 * (`sandbox_not_ready` — and the read deliberately does *not* wake it), the
 * machine is gone, or the agent wrote something that is not the JSON it was
 * given. The caller renders the same thing for all four.
 */
async function readReceipt(fountain: Fountain, sandboxId: string | null): Promise<Receipt | null> {
  if (!sandboxId) return null;
  try {
    const file = await fountain.file(sandboxId, RECEIPT_PATH);
    return parseReceipt(file.content ?? "");
  } catch {
    return null;
  }
}

export function originOf(row: ThreadRow): ThreadOrigin {
  return {
    kind: (row.originKind as ThreadOrigin["kind"]) || "blank",
    base: row.originBase,
    number: row.originNumber,
    title: row.originTitle,
    url: row.originUrl,
  };
}

function toOrigin(o: ThreadOrigin): Origin {
  if (o.kind === "pr" && o.number != null) return { kind: "pr", base: o.base ?? "main", number: o.number, title: o.title ?? "" };
  if (o.kind === "issue" && o.number != null) return { kind: "issue", base: o.base ?? "main", number: o.number, title: o.title ?? "" };
  if (o.kind === "branch") return { kind: "branch", base: o.base ?? "main" };
  return { kind: "blank" };
}

function baseOf(o: Origin): string | null {
  return "base" in o ? o.base : null;
}

function originUrl(repo: string | null, o: Origin): string | null {
  if (!repo) return null;
  if (o.kind === "pr") return `https://github.com/${repo}/pull/${o.number}`;
  if (o.kind === "issue") return `https://github.com/${repo}/issues/${o.number}`;
  return null;
}

function titleFrom(o: Origin): string {
  if (o.kind === "pr") return `#${o.number} ${o.title}`.trim();
  if (o.kind === "issue") return `#${o.number} ${o.title}`.trim();
  if (o.kind === "branch") return o.base;
  return "New thread";
}

/**
 * A slug nobody else in this project is using.
 *
 * The unique index enforces it; this is what stops the insert failing. Two
 * threads called "Fix the build" is an ordinary thing to want, and the second
 * one becoming `fix-the-build-2` is what everybody expects to happen.
 */
function freeSlug(db: Db, projectId: string, title: string): string {
  const base = slugify(title);
  if (!db.slugTaken(projectId, base)) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}-${n}`;
    if (!db.slugTaken(projectId, candidate)) return candidate;
  }
  return `${base}-${crypto.randomUUID().slice(0, 6)}`;
}
