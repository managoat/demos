/**
 * The repository in the chat's computer, read now, through Fountain. Fountain
 * offers three read-only views of a sandbox's disk — a directory, a file,
 * `git diff` — to a full-scope key (its ADR 0039: no exec, ever; to run a
 * command, send a prompt). Salon holds the host's key, so it reads on their
 * behalf and hands the answer to everyone in the chat:
 *
 *   POST /api/chats/:id/changes/refresh  { reason?: "manual" | "stop" }  a snapshot, read through Fountain, into changes.ts#record
 *   GET  /api/chats/:id/files?path=      one directory of the repository
 *   GET  /api/chats/:id/file?path=       one file of it, at most FILE_MAX_BYTES
 *
 * A snapshot from here is the same record the hook posts (shared/changes.ts),
 * assembled from what the routes can see: the diff against the base branch,
 * the two diffs that stand in for `git status` (index against HEAD, tree
 * against index), and the `.git` ref files for the branch, the head and
 * whether the upstream has it. Two things it cannot see, and says so:
 * untracked files (git diff does not show them) and the pull request (that
 * is `gh`, a network call), which is carried over from the last snapshot on
 * the same branch.
 *
 * Every path is relative to the repository root and kept under it here,
 * before Fountain confines it to the home directory again. A sandbox that is
 * parked is not woken for a read: Fountain answers `409 sandbox_not_ready`
 * and it passes through with its code, like every refusal.
 */
import { AHEAD_UNKNOWN, CHANGE_REASONS, DIFF_MAX_CHARS, statusFromDiffs, type ChangesDto, type ChangesSnapshot } from "../shared/changes";
import { cleanPath, FILE_MAX_BYTES, type DirEntry, type DirListing, type FileContents } from "../shared/files";
import { record, toDto } from "./changes";
import { authenticate, chatAccess, ownerClient, type AppContext } from "./context";
import type { ChatRow, ProjectRow } from "./db";
import { FountainClient, FountainHttpError } from "./fountain";
import { HttpError, json, readJson } from "./http";

/** A turn-end refresh is skipped when a snapshot this recent is held: the hook's own Stop post, usually. */
const FRESH_MS = 8_000;

interface Computer {
  client: FountainClient;
  sandboxId: string;
  project: ProjectRow;
}

/** The chat's computer, if it has one now: the project behind it, the host's client, the sandbox the conversation runs on. */
async function computer(ctx: AppContext, chat: ChatRow): Promise<Computer> {
  const project = chat.project_id ? ctx.db.getProject(chat.project_id) : null;
  if (!project) throw new HttpError(422, "no_repository", "This chat has no repository: it was not started in a project.");
  if (chat.archived_at) throw new HttpError(409, "no_computer", "The chat is archived, so its computer is gone. Restore it to read the repository again.");
  const client = await ownerClient(ctx, chat);
  let conv;
  try {
    conv = await client.conversation(chat.conversation_id);
  } catch (err) {
    throw err instanceof FountainHttpError ? err.toHttp("Fountain would not say where the chat runs.") : err;
  }
  if (!conv?.sandbox_id) throw new HttpError(409, "no_computer", conv?.status === "terminated" ? "The conversation has ended; there is no computer to read." : "The chat has no computer right now. It gets one on its first turn.");
  return { client, sandboxId: conv.sandbox_id, project };
}

/** Fountain's refusal as this server reports it. A Fountain without the routes at all is told apart from a missing path. */
function passThrough(err: unknown, fallback: string): never {
  if (err instanceof FountainHttpError) {
    if (err.status === 404 && err.code !== "path_not_found" && err.code !== "ref_not_found") {
      throw new HttpError(501, "files_unavailable", "This Fountain cannot read a computer's files yet, or the computer is gone.");
    }
    throw err.toHttp(fallback);
  }
  throw err;
}

function absolute(project: ProjectRow, rel: string): string {
  return rel ? `${project.mount_path}/${rel}` : project.mount_path;
}

/** A path the request named, relative to the repository and inside it, or a 422. */
function pathParam(req: Request, required: boolean): string {
  const raw = new URL(req.url).searchParams.get("path") ?? "";
  const path = cleanPath(raw);
  if (path === null || (required && !path)) throw new HttpError(422, "bad_path", required ? "Say which file, as a path inside the repository." : "That path is not inside the repository.");
  return path;
}

// ── the routes ───────────────────────────────────────────────────────────

export async function list(ctx: AppContext, req: Request, chatId: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { chat } = chatAccess(ctx, user, chatId);
  const path = pathParam(req, false);
  const c = await computer(ctx, chat);
  try {
    const got = await c.client.sandboxFiles(c.sandboxId, absolute(c.project, path));
    const out: DirListing = {
      path,
      entries: got.entries.map((e): DirEntry => ({ name: e.name, type: isEntryType(e.type) ? e.type : "other", size: typeof e.size === "number" ? e.size : null })),
      truncated: got.truncated === true,
    };
    return json({ data: out });
  } catch (err) {
    passThrough(err, "Fountain would not list that directory.");
  }
}

export async function show(ctx: AppContext, req: Request, chatId: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { chat } = chatAccess(ctx, user, chatId);
  const path = pathParam(req, true);
  const c = await computer(ctx, chat);
  try {
    const got = await c.client.sandboxFile(c.sandboxId, absolute(c.project, path), FILE_MAX_BYTES);
    const out: FileContents = { path, size: got.size, truncated: got.truncated === true, encoding: got.encoding === "base64" ? "base64" : "utf-8", content: got.content };
    return json({ data: out });
  } catch (err) {
    passThrough(err, "Fountain would not read that file.");
  }
}

const inFlight = new Map<string, Promise<ChangesDto>>();

/**
 * Read the repository now and keep what was read. One read at a time per
 * chat — every browser in the room asks when a turn ends, and they share
 * one — and a turn-end ask is answered from a snapshot fresh enough to be
 * the hook's, which posted before the turn's end reached anyone.
 */
export async function refresh(ctx: AppContext, req: Request, chatId: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { chat } = chatAccess(ctx, user, chatId);
  const body = await readJson(req);
  const reason: ChangesSnapshot["reason"] = body.reason === "stop" ? "stop" : "manual";
  if (reason === "stop") {
    const latest = ctx.db.latestChanges(chat.id);
    if (latest && Date.now() - Date.parse(latest.at) < FRESH_MS) return json({ data: toDto(latest), fresh: true });
  }
  let job = inFlight.get(chat.id);
  if (!job) {
    job = (async () => {
      const c = await computer(ctx, chat);
      const snap = await snapshot(ctx, chat, c, reason);
      return record(ctx, chat, snap, "fountain");
    })();
    inFlight.set(chat.id, job);
    job.finally(() => inFlight.delete(chat.id)).catch(() => undefined);
  }
  return json({ data: await job }, 201);
}

/** The snapshot as the routes can assemble it. Exported for the tests; the route is the way in. */
export async function snapshot(ctx: AppContext, chat: ChatRow, c: Computer, reason: ChangesSnapshot["reason"]): Promise<ChangesSnapshot> {
  const repo = c.project.mount_path;
  try {
    const head = await whereHeadIs(c, repo);
    const [against, unstaged, staged] = await Promise.all([
      diffAgainstBase(c, repo, c.project.base, head.branch === c.project.base),
      c.client.sandboxDiff(c.sandboxId, repo, { maxBytes: DIFF_MAX_CHARS + 1 }),
      c.client.sandboxDiff(c.sandboxId, repo, { staged: true, maxBytes: DIFF_MAX_CHARS + 1 }),
    ]);
    let ahead: number | null = null;
    if (head.branch) {
      const upstream = await resolveRef(c, repo, `refs/remotes/origin/${head.branch}`);
      ahead = !upstream ? null : upstream === head.sha ? 0 : AHEAD_UNKNOWN;
    }
    const latest = ctx.db.latestChanges(chat.id);
    const pr = latest?.pr && latest.branch === head.branch ? (JSON.parse(latest.pr) as ChangesSnapshot["pr"]) : null;
    return {
      branch: head.branch,
      head: head.sha,
      base: c.project.base,
      status: statusFromDiffs(staged.diff, unstaged.diff),
      diff: against.diff,
      reason: (CHANGE_REASONS as readonly string[]).includes(reason) ? reason : "manual",
      pr,
      ahead,
      truncated: against.truncated === true,
    };
  } catch (err) {
    passThrough(err, "Fountain would not read the repository.");
  }
}

/**
 * `git diff <base>`: the local base branch as cloned, else the remote's,
 * else the tree against HEAD. On the base branch itself the local ref is
 * HEAD, so the remote's comes first there: what was committed on it shows.
 */
async function diffAgainstBase(c: Computer, repo: string, base: string, onBase: boolean): Promise<{ diff: string; truncated: boolean }> {
  for (const ref of onBase ? [`origin/${base}`, base, null] : [base, `origin/${base}`, null]) {
    try {
      return await c.client.sandboxDiff(c.sandboxId, repo, { ref, maxBytes: DIFF_MAX_CHARS + 1 });
    } catch (err) {
      if (ref !== null && err instanceof FountainHttpError && err.code === "ref_not_found") continue;
      throw err;
    }
  }
  throw new Error("unreachable");
}

/** `.git/HEAD`: `ref: refs/heads/x` on a branch, a sha when detached. */
async function whereHeadIs(c: Computer, repo: string): Promise<{ branch: string; sha: string }> {
  const head = (await readText(c, `${repo}/.git/HEAD`)).trim();
  if (head.startsWith("ref: ")) {
    const ref = head.slice(5).trim();
    const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    return { branch, sha: await resolveRef(c, repo, ref) };
  }
  return { branch: "", sha: head };
}

/** A ref's sha: the loose file, else its line in packed-refs, else "". */
async function resolveRef(c: Computer, repo: string, ref: string): Promise<string> {
  try {
    return (await readText(c, `${repo}/.git/${ref}`)).trim();
  } catch (err) {
    if (!(err instanceof FountainHttpError && err.code === "path_not_found")) throw err;
  }
  let packed = "";
  try {
    packed = await readText(c, `${repo}/.git/packed-refs`);
  } catch (err) {
    if (err instanceof FountainHttpError && err.code === "path_not_found") return "";
    throw err;
  }
  for (const line of packed.split("\n")) {
    const [sha, name] = line.trim().split(/\s+/);
    if (name === ref && sha && !sha.startsWith("#") && !sha.startsWith("^")) return sha;
  }
  return "";
}

async function readText(c: Computer, path: string): Promise<string> {
  const f = await c.client.sandboxFile(c.sandboxId, path);
  return f.encoding === "base64" ? Buffer.from(f.content, "base64").toString("utf8") : f.content;
}

function isEntryType(t: string): t is DirEntry["type"] {
  return t === "file" || t === "directory" || t === "symlink" || t === "other";
}
