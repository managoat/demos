/**
 * Projects and work items. A project has an owner — whose Fountain key every
 * conversation in it runs on — and members, who see the same items and talk
 * to the same conversations. Items belong to the project, not to a person.
 *
 * Owner-only: project settings (name, notes, environment, vault), sharing,
 * deletion. Everything else — items, teammates, conversations — is any
 * member's.
 */
import { channelIsItem, channelPrefix, newId, parseChannel, recoveredTitle } from "../shared/channel";
import { computerKey, projectRemovedKey } from "../shared/computers";
import { emptyCounts, isClosed, isItemStatus, isProposedStatus, parseItemStatus, type ItemCounts, type ItemStatus, type Proposal, type ProposedStatus } from "../shared/status";
import { authenticate, ownerClient, projectAccess, requireOwner, userClient, type AppContext } from "./context";
import { NO_PROPOSAL, now, parseAgentIds, type ItemPatch, type ItemRow, type ProjectRow, type RemovedComputerRow, type Role } from "./db";
import { FountainHttpError, type ConversationSummary, type FountainClient } from "./fountain";
import { HttpError, isEmail, json, normalizeEmail, optId, readJson, str } from "./http";
import { heldRequests, type HeldRequest } from "./watch";

export interface ProjectDto {
  id: string;
  name: string;
  notes: string;
  environmentId: string | null;
  vaultId: string | null;
  /** Who new work here starts with unless someone picks otherwise; null is "ask every time". */
  defaultAgentId: string | null;
  createdAt: string;
  ownerEmail: string;
  role: Role;
  members: { email: string; addedAt: string }[];
  counts: ItemCounts;
}

export interface ItemDto {
  id: string;
  projectId: string;
  title: string;
  notes: string;
  status: ItemStatus;
  agentIds: string[];
  createdAt: string;
  /** What a teammate says should happen to this item, waiting on a person. Null when nobody has said. */
  proposal: Proposal | null;
  /** Computers taken out of this item's tree — not shown, not gone (see `removeComputer`). */
  removedComputers: RemovedComputerDto[];
}

/** One computer a work item no longer shows, and who took it out. */
export interface RemovedComputerDto {
  /** Its sandbox id, or `conv:<id>` for one that never got a sandbox (shared/computers.ts). */
  key: string;
  at: string;
  by: string;
}

/** What closing a work item — or removing computers from one — did to its computers. */
export interface RetiredDto {
  /** Conversations retired. */
  conversations: number;
  /** Distinct computers they were on; Fountain takes each down with the last live conversation on it. */
  computers: number;
  /** Conversations Fountain would not retire; their computers may still be up. */
  failed: number;
  /** Why, when something did not go. */
  error?: string;
}

function projectDto(ctx: AppContext, p: ProjectRow, role: Role, counts?: ItemCounts): ProjectDto {
  return {
    id: p.id,
    name: p.name,
    notes: p.notes,
    environmentId: p.environment_id,
    vaultId: p.vault_id,
    defaultAgentId: p.default_agent_id,
    createdAt: p.created_at,
    ownerEmail: p.owner_email,
    role,
    members: ctx.db.members(p.id).map((m) => ({ email: m.email, addedAt: m.added_at })),
    counts: counts ?? ctx.db.itemCounts([p.id]).get(p.id) ?? emptyCounts(),
  };
}

/**
 * The item as the browser reads it. `removed` is passed in rather than read
 * here so a whole project's items cost one query for the lot, not one each;
 * a caller with nothing to say passes nothing, which is the common case
 * (a fresh item has removed nothing).
 */
export function itemDto(w: ItemRow, removed: RemovedComputerRow[] = []): ItemDto {
  return {
    id: w.id,
    projectId: w.project_id,
    title: w.title,
    notes: w.notes,
    status: parseItemStatus(w.status),
    agentIds: parseAgentIds(w.agent_ids),
    createdAt: w.created_at,
    proposal: proposalOf(w),
    removedComputers: removed.map((r) => ({ key: r.key, at: r.removed_at, by: r.removed_by })),
  };
}

/** The proposal standing on an item, if one does. Anything we do not recognise is nobody proposing anything. */
function proposalOf(w: ItemRow): Proposal | null {
  if (!isProposedStatus(w.proposed_status)) return null;
  return { status: w.proposed_status, agentId: w.proposed_agent_id || null, email: w.proposed_email, at: w.proposed_at };
}

/** The columns that record one: what is proposed, and who by. */
export function proposalFields(status: ProposedStatus, agentId: string | null, email: string): Pick<ItemRow, keyof typeof NO_PROPOSAL> {
  return { proposed_status: status, proposed_agent_id: agentId ?? "", proposed_email: email, proposed_at: now() };
}

/** A fresh work item, with the limits and defaults that apply wherever one is made — the API, or an agent over MCP. */
export function newItemRow(projectId: string, title: unknown, notes: unknown): ItemRow {
  return {
    id: newId(),
    project_id: projectId,
    title: str(title, 300).trim() || "Untitled work item",
    notes: str(notes, 20000),
    status: "open",
    agent_ids: "[]",
    created_at: now(),
    ...NO_PROPOSAL,
  };
}

// ── projects ─────────────────────────────────────────────────────────────

export async function list(ctx: AppContext, req: Request): Promise<Response> {
  const user = await authenticate(ctx, req);
  const rows = ctx.db.projectsFor(user.email);
  const counts = ctx.db.itemCounts(rows.map((p) => p.id));
  return json({ data: rows.map((p) => projectDto(ctx, p, p.owner_email === user.email ? "owner" : "member", counts.get(p.id))) });
}

/** What is happening in one project: how many conversations are working, and when anything last happened. */
export interface Activity {
  live: number;
  latest: string | null;
}

/**
 * One conversation that has stopped with something nobody has read.
 *
 * It carries where it is as well as what it is, because the whole point of
 * the feed is that you are somewhere else: a browser reading this is not in
 * the project the entry names and has no store for it, so the project and
 * item are spelled out here rather than looked up there.
 */
export interface FeedEntry {
  conversationId: string;
  projectId: string;
  projectName: string;
  itemId: string;
  /** Null for an item deleted here whose conversation still names it. */
  itemTitle: string | null;
  /** Fountain generates one from the first turn; null until there is one. */
  title: string | null;
  agentId: string | null;
  /** `idle` — the turn ended and it is waiting on you. `failed` — it fell over. */
  status: "idle" | "failed";
  /** When it last said anything. */
  at: string;
}

/**
 * One agent blocked on a permission request, wherever it is.
 *
 * The feed's other half answers "what finished"; this answers "what is waiting
 * on *you*", which is the louder of the two — a finished conversation waits
 * indefinitely, and this one is denied by Fountain when `expiresAt` passes.
 * Carries where it is for the same reason a `FeedEntry` does: whoever is
 * reading is in another project and has no store for this one.
 */
export interface WaitingEntry {
  conversationId: string;
  projectId: string;
  projectName: string;
  itemId: string;
  /** Null for an item deleted here whose conversation still names it. */
  itemTitle: string | null;
  /** Fountain generates one from the first turn; null until there is one. */
  title: string | null;
  agentId: string | null;
  /** The id to answer with, so a client can go straight to the request. */
  requestId: string;
  /** The tool it wants to run, in the runtime's words. */
  tool: string | null;
  askedAt: string;
  /** When Fountain answers for you, with a refusal. */
  expiresAt: string;
}

export interface ActivityDto {
  projects: Record<string, Activity>;
  /** Newest first, capped. */
  feed: FeedEntry[];
  /** Entries past the cap, so the panel says what it is not showing rather than implying there is no more. */
  dropped: number;
  /** Held permission requests, oldest first — the ones closest to running out. */
  waiting: WaitingEntry[];
}

/**
 * A conversation is in the feed when it has stopped and nobody has read what
 * it last said. `running` and `pending` are still working — the projects list
 * counts those as live and they are not news; `terminated` is a conversation
 * whose work is over, and closing a work item retires every conversation on
 * it, so counting those would turn "done" into a screenful of notifications.
 */
const FEED_STATUSES = new Set(["idle", "failed"]);

/**
 * The feed is a list, not an archive: an account that has ignored its
 * conversations for a month should not push a thousand rows down the wire.
 */
const FEED_MAX = 50;

/**
 * What is happening across every project the caller is in, in the two shapes
 * the app reads it in: per project, how much is working and when anything last
 * happened (the projects list); and a flat feed of conversations that have
 * stopped with something unread (the notification panel in the top bar).
 *
 * Both come out of one pass over the same listing, because they are the same
 * question asked twice — one Fountain call per distinct owner, all in
 * parallel; an owner whose key fails just reports nothing.
 *
 * `unread` is Fountain's own (`last_active_at` later than `last_read_at`), and
 * it is the owner's: every conversation in a project runs on the owner's key,
 * so opening a thread marks it read for everyone in the project, exactly as
 * the sidebar's unread dot already works. A shared project shares its inbox.
 *
 * The one thing the listing cannot answer is who is *blocked*: a held
 * permission request is not on the conversation record at all, and the
 * conversation holding one is `running`, which this counts as live and not as
 * news. That is folded off the owner's stage stream instead (server/watch.ts,
 * which is also where the choice between asking Fountain and streaming is
 * argued) and joined on here, in the same pass, out of the same listing.
 */
export async function activity(ctx: AppContext, req: Request): Promise<Response> {
  const user = await authenticate(ctx, req);
  const rows = ctx.db.projectsFor(user.email);
  const mine = new Map(rows.map((p) => [p.id, p]));
  const byOwner = new Map<string, ProjectRow>();
  for (const p of rows) if (!byOwner.has(p.owner_email)) byOwner.set(p.owner_email, p);
  // Computers these projects have removed. A machine somebody took out of a
  // work item must not be able to ring the bell from outside it — the feed is
  // the one place a removed conversation could still reach a reader who has
  // seen it gone (server/proxy.ts leaves it out of the project's own listing).
  const removed = ctx.db.removedKeys(rows.map((p) => p.id));
  const out: Record<string, Activity> = {};
  for (const p of rows) out[p.id] = { live: 0, latest: null };
  const feed: FeedEntry[] = [];
  const waiting: WaitingEntry[] = [];
  await Promise.allSettled(
    [...byOwner.values()].map(async (p) => {
      const client = await ownerClient(ctx, p);
      const convs = await client.conversations({ roots_only: "true" });
      // What this owner's agents are blocked on, by conversation. Best effort
      // and separately settled: a stream that is not answering must not cost
      // this owner the feed, which is the part that works without it.
      const held = await heldRequests(p.owner_email, client, convs).catch(() => new Map<string, HeldRequest>());
      for (const c of convs) {
        const ref = parseChannel(c.channel_id);
        if (!ref) continue;
        const project = mine.get(ref.projectId);
        // Only this owner's projects: the same id under another owner is not this conversation's.
        if (!project || project.owner_email !== p.owner_email) continue;
        if (removed.size > 0 && removed.has(projectRemovedKey(project.id, ref.itemId, computerKey(c)))) continue;
        const a = out[project.id]!;
        if (c.status === "running" || c.status === "pending") a.live += 1;
        const at = c.last_active_at ?? c.updated_at ?? c.inserted_at ?? null;
        if (at && (!a.latest || at > a.latest)) a.latest = at;
        const ask = held.get(c.id);
        if (ask) {
          waiting.push({
            conversationId: c.id,
            projectId: project.id,
            projectName: project.name,
            itemId: ref.itemId,
            itemTitle: ctx.db.getItem(ref.itemId)?.title ?? null,
            title: typeof c.title === "string" && c.title ? c.title : null,
            agentId: typeof c.agent_id === "string" && c.agent_id ? c.agent_id : null,
            requestId: ask.requestId,
            tool: ask.tool,
            askedAt: ask.askedAt,
            expiresAt: ask.expiresAt,
          });
        }
        if (!at || c.unread !== true || !FEED_STATUSES.has(c.status ?? "")) continue;
        feed.push({
          conversationId: c.id,
          projectId: project.id,
          projectName: project.name,
          itemId: ref.itemId,
          itemTitle: ctx.db.getItem(ref.itemId)?.title ?? null,
          title: typeof c.title === "string" && c.title ? c.title : null,
          agentId: typeof c.agent_id === "string" && c.agent_id ? c.agent_id : null,
          status: c.status === "failed" ? "failed" : "idle",
          at,
        });
      }
    }),
  );
  // Ties break on id so the order is total, and the panel does not shuffle
  // two conversations that stopped in the same millisecond under the pointer.
  feed.sort((a, b) => b.at.localeCompare(a.at) || a.conversationId.localeCompare(b.conversationId));
  // Waiting sorts the other way up: oldest first is closest to being denied,
  // and the one about to run out is the one to answer.
  waiting.sort((a, b) => a.askedAt.localeCompare(b.askedAt) || a.conversationId.localeCompare(b.conversationId));
  const dto: ActivityDto = { projects: out, feed: feed.slice(0, FEED_MAX), dropped: Math.max(0, feed.length - FEED_MAX), waiting };
  return json({ data: dto });
}

export async function create(ctx: AppContext, req: Request): Promise<Response> {
  const user = await authenticate(ctx, req);
  const body = await readJson(req);
  const name = str(body.name, 200).trim();
  if (!name) throw new HttpError(422, "name_required", "A project needs a name.");
  const row: ProjectRow = {
    id: newId(),
    owner_email: user.email,
    name,
    notes: str(body.notes),
    environment_id: optId(body.environmentId),
    vault_id: optId(body.vaultId),
    default_agent_id: optId(body.defaultAgentId),
    created_at: now(),
  };
  ctx.db.insertProject(row);
  return json({ data: projectDto(ctx, row, "owner") }, 201);
}

export async function show(ctx: AppContext, req: Request, id: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { project, role } = projectAccess(ctx, user, id);
  // One query for the project's removals, handed out per item: an items list
  // must not be an item's worth of queries.
  const removed = byItem(ctx.db.removedInProject(id));
  return json({ data: { project: projectDto(ctx, project, role), items: ctx.db.items(id).map((w) => itemDto(w, removed.get(w.id))) } });
}

export async function patch(ctx: AppContext, req: Request, id: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { role } = projectAccess(ctx, user, id);
  requireOwner(role);
  const body = await readJson(req);
  const p: Partial<Pick<ProjectRow, "name" | "notes" | "environment_id" | "vault_id" | "default_agent_id">> = {};
  if (typeof body.name === "string") p.name = str(body.name, 200).trim() || "Untitled project";
  if (typeof body.notes === "string") p.notes = str(body.notes);
  if ("environmentId" in body) p.environment_id = optId(body.environmentId);
  if ("vaultId" in body) p.vault_id = optId(body.vaultId);
  // Not checked against Fountain: agents come and go on the owner's account,
  // so the browser resolves it against the team and ignores one that is gone.
  if ("defaultAgentId" in body) p.default_agent_id = optId(body.defaultAgentId);
  ctx.db.updateProject(id, p);
  ctx.events.emit(id, { kind: "project" });
  return json({ data: projectDto(ctx, ctx.db.getProject(id)!, role) });
}

export async function remove(ctx: AppContext, req: Request, id: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { role } = projectAccess(ctx, user, id);
  requireOwner(role);
  ctx.db.deleteProject(id);
  ctx.events.emit(id, { kind: "project", deleted: true });
  return json({ ok: true });
}

// ── members ──────────────────────────────────────────────────────────────

export async function addMember(ctx: AppContext, req: Request, id: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { project, role } = projectAccess(ctx, user, id);
  requireOwner(role);
  const body = await readJson(req);
  const email = normalizeEmail(body.email);
  if (!isEmail(email)) throw new HttpError(422, "bad_email", "That is not an email address.");
  if (email === project.owner_email) throw new HttpError(422, "is_owner", "That is the owner.");
  ctx.db.addMember(id, email, user.email);
  ctx.events.emit(id, { kind: "project" });
  return json({ data: projectDto(ctx, project, role) });
}

/** The owner removes anyone; a member removes themself (leaves). */
export async function removeMember(ctx: AppContext, req: Request, id: string, rawEmail: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { project, role } = projectAccess(ctx, user, id);
  const email = normalizeEmail(decodeURIComponent(rawEmail));
  if (role !== "owner" && email !== user.email) requireOwner(role);
  ctx.db.removeMember(id, email);
  ctx.events.emit(id, { kind: "project" });
  return json({ data: projectDto(ctx, project, role) });
}

// ── items ────────────────────────────────────────────────────────────────

export async function createItem(ctx: AppContext, req: Request, id: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  projectAccess(ctx, user, id);
  const body = await readJson(req);
  const row = newItemRow(id, body.title, body.notes);
  ctx.db.insertItem(row);
  ctx.events.emit(id, { kind: "items" });
  return json({ data: itemDto(row) }, 201);
}

export async function patchItem(ctx: AppContext, req: Request, id: string, itemId: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { project } = projectAccess(ctx, user, id);
  const cur = ctx.db.getItem(itemId);
  if (!cur || cur.project_id !== id) throw new HttpError(404, "not_found", "No such work item.");
  const body = await readJson(req);
  const p: ItemPatch = {};
  if (typeof body.title === "string") p.title = str(body.title, 300).trim() || "Untitled work item";
  if (typeof body.notes === "string") p.notes = str(body.notes, 20000);
  if (isItemStatus(body.status)) p.status = body.status;
  if (Array.isArray(body.agentIds)) p.agent_ids = JSON.stringify(body.agentIds.filter((x: unknown): x is string => typeof x === "string").slice(0, 100));
  // A person answering the question ends it: deciding the status either way
  // settles a standing proposal, and `proposal: null` dismisses one without
  // deciding, leaving the item open. Nobody proposes from here — a proposal is
  // an agent saying what it thinks (server/mcp.ts); a person just decides.
  if (p.status !== undefined || body.proposal === null) Object.assign(p, NO_PROPOSAL);
  ctx.db.updateItem(itemId, p);
  ctx.events.emit(id, { kind: "items" });
  // Both ways of closing an item end the work, so both take its computers
  // down; going from one closed state to the other has nothing left to retire.
  const closing = p.status !== undefined && isClosed(p.status) && !isClosed(cur.status);
  const item = itemDto(ctx.db.getItem(itemId)!, ctx.db.removedComputers(itemId));
  return json(closing ? { data: item, retired: await retire(ctx, project, itemId) } : { data: item });
}

export async function removeItem(ctx: AppContext, req: Request, id: string, itemId: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  projectAccess(ctx, user, id);
  const cur = ctx.db.getItem(itemId);
  if (!cur || cur.project_id !== id) throw new HttpError(404, "not_found", "No such work item.");
  ctx.db.deleteItem(itemId);
  ctx.events.emit(id, { kind: "items" });
  return json({ ok: true });
}

/**
 * Take a computer out of a work item.
 *
 * Terminating a computer is not the same as being done with it. Fountain
 * keeps a terminated conversation for good — the transcript is the record of
 * what was done, and the bill is the owner's — so an item worked on for a
 * week ends up a column of dead machines with the live one somewhere in it,
 * and nothing in the app could say "this one is finished with". This is that:
 * the computer stops being part of the item's tree. It is a workbench
 * decision, written here, not a delete on Fountain: the conversations stay,
 * their transcripts stay searchable by direct link, and `GET /api/me/cost`
 * still counts every token they spent, because removing a machine from a
 * to-do list does not unspend the money.
 *
 * It is the project's decision, not the reader's: a shared project shares its
 * tree, the same way it shares its items and its unread marks, so any member
 * may remove and everyone sees it gone.
 *
 * **Removing retires it first.** A computer nobody can see must not still be
 * running: whatever is live on it is terminated on the way out, by exactly the
 * path that closing the item takes, and what actually went is reported back so
 * the browser can say so. A removal whose terminate failed is still a removal —
 * the machine may be up, and the answer says which, rather than the item
 * quietly keeping a row nobody asked for.
 *
 * **One or many, in one request.** An item that has been worked on for a week
 * has a week of dead machines on it, and clearing those one at a time is the
 * chore this is supposed to end, not a smaller version of it. So the body
 * takes `key` or `keys`, and the retire is a single pass over a single
 * listing however many are named — the alternative, a request each, is a
 * conversation listing each.
 *
 * Which computers are worth sweeping is *not* decided here. Whether a machine
 * is still up is read off its conversations and its sandbox record together,
 * and the browser is the side that holds both (src/lib/sidebar.ts, `isLive`);
 * a second definition on this side would be a second answer. The browser names
 * the computers, this removes exactly those.
 */
export async function removeComputer(ctx: AppContext, req: Request, id: string, itemId: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { project } = projectAccess(ctx, user, id);
  const item = ctx.db.getItem(itemId);
  if (!item || item.project_id !== id) throw new HttpError(404, "not_found", "No such work item.");
  const keys = computerKeys(await readJson(req));
  if (keys.length === 0) throw new HttpError(422, "key_required", "Which computer?");
  const retired = await retire(ctx, project, itemId, new Set(keys));
  for (const key of keys) ctx.db.removeComputer(itemId, key, user.email);
  ctx.events.emit(id, { kind: "items" });
  return json({ data: itemDto(ctx.db.getItem(itemId)!, ctx.db.removedComputers(itemId)), retired, removed: keys.length });
}

/** `{ key }` or `{ keys }`, deduped and trimmed. Capped: a sweep is an item's computers, not a payload. */
function computerKeys(body: Record<string, unknown>): string[] {
  const raw = Array.isArray(body.keys) ? body.keys : [body.key];
  const out = new Set<string>();
  for (const k of raw.slice(0, 200)) {
    const key = str(k, 200).trim();
    if (key) out.add(key);
  }
  return [...out];
}

/**
 * Put one back. Nothing was destroyed, so this is the whole of the undo: the
 * conversations that ran on it are still on Fountain and reappear in the
 * item's tree on the next listing. A computer that has since been torn down
 * comes back as what it is — gone, with its transcripts.
 */
export async function restoreComputer(ctx: AppContext, req: Request, id: string, itemId: string, rawKey: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  projectAccess(ctx, user, id);
  const item = ctx.db.getItem(itemId);
  if (!item || item.project_id !== id) throw new HttpError(404, "not_found", "No such work item.");
  ctx.db.restoreComputer(itemId, decodeURIComponent(rawKey));
  ctx.events.emit(id, { kind: "items" });
  return json({ data: itemDto(ctx.db.getItem(itemId)!, ctx.db.removedComputers(itemId)) });
}

/** Removals grouped by the item they are on, for a page that needs a project's worth at once. */
export function byItem(rows: RemovedComputerRow[]): Map<string, RemovedComputerRow[]> {
  const out = new Map<string, RemovedComputerRow[]>();
  for (const r of rows) {
    const arr = out.get(r.item_id);
    if (arr) arr.push(r);
    else out.set(r.item_id, [r]);
  }
  return out;
}

/**
 * An item's computers, once it is closed — done or won't do alike: the work
 * is over either way, so the machines go. With `keys`, just those computers:
 * what removing them from the item has to do first (`removeComputer`).
 *
 * Fountain has no "destroy this sandbox" — a sprite is torn down with the
 * last live conversation on it (ADR 0023), so retiring every conversation of
 * the item is how its computers go, and a machine something outside the item
 * still holds rightly stays up. Terminating is idempotent, so an already-dead
 * conversation is simply skipped.
 *
 * Best effort: the item is closed whatever Fountain says. What actually went is
 * reported back, so the browser can say so rather than imply a machine is
 * gone when it is still running.
 */
async function retire(ctx: AppContext, project: ProjectRow, itemId: string, keys?: ReadonlySet<string>): Promise<RetiredDto> {
  const out: RetiredDto = { conversations: 0, computers: 0, failed: 0 };
  let convs: ConversationSummary[];
  let client: FountainClient;
  try {
    client = await ownerClient(ctx, project);
    convs = await client.conversations({ roots_only: "false" });
  } catch (err) {
    return { ...out, error: reason(err) };
  }
  const live = convs.filter((c) => channelIsItem(c.channel_id, project.id, itemId) && c.status !== "terminated" && (keys === undefined || keys.has(computerKey(c))));
  const computers = new Set<string>();
  await Promise.all(
    live.map(async (c) => {
      try {
        await client.terminate(c.id);
        out.conversations += 1;
        if (c.sandbox_id) computers.add(c.sandbox_id);
      } catch (err) {
        out.failed += 1;
        out.error ??= reason(err);
      }
    }),
  );
  out.computers = computers.size;
  return out;
}

function reason(err: unknown): string {
  if (err instanceof FountainHttpError) return `Fountain answered ${err.status}.`;
  if (err instanceof HttpError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/** Put an agent on an item, if it is not there already. True when something changed. */
export function addTeammate(ctx: AppContext, itemId: string, agentId: string): boolean {
  const w = ctx.db.getItem(itemId);
  if (!w) return false;
  const ids = parseAgentIds(w.agent_ids);
  if (ids.includes(agentId)) return false;
  ctx.db.updateItem(itemId, { agent_ids: JSON.stringify([...ids, agentId]) });
  return true;
}

// ── recovery: the tree from Fountain, and the old browser-local tree ───────

/**
 * Fold a project's conversation list into its items: an item a conversation
 * names that the project does not have becomes a placeholder, and a teammate
 * a conversation ran that the item does not list is added. So nothing that
 * happened on Fountain under this project is invisible. True when anything changed.
 */
export function reconcileItems(ctx: AppContext, project: ProjectRow, conversations: ConversationSummary[]): boolean {
  let changed = false;
  const prefix = channelPrefix(project.id);
  for (const c of conversations) {
    if (!c.channel_id?.startsWith(prefix)) continue;
    const ref = parseChannel(c.channel_id);
    if (!ref) continue;
    const existing = ctx.db.getItem(ref.itemId);
    if (!existing) {
      changed =
        ctx.db.insertItem({
          id: ref.itemId,
          project_id: project.id,
          title: recoveredTitle(c.title) ?? `Recovered item ${ref.itemId.slice(0, 6)}`,
          notes: "",
          status: "open",
          agent_ids: JSON.stringify(c.agent_id ? [c.agent_id] : []),
          created_at: c.inserted_at ?? now(),
          ...NO_PROPOSAL,
        }) || changed;
    } else if (existing.project_id === project.id && c.agent_id) {
      changed = addTeammate(ctx, existing.id, c.agent_id) || changed;
    }
  }
  return changed;
}

/**
 * Rebuild projects from the caller's own Fountain conversations: every
 * `workbench:<project>/<item>` channel naming a project nobody here has
 * becomes one the caller owns (with the environment and vault the
 * conversation ran with), and its items follow. Names get placeholders.
 */
export async function recover(ctx: AppContext, req: Request): Promise<Response> {
  const user = await authenticate(ctx, req);
  const convs = await (await userClient(ctx, user)).conversations({ roots_only: "true" });
  let projects = 0;
  let items = 0;
  const touched = new Set<string>();
  for (const c of convs) {
    const ref = parseChannel(c.channel_id);
    if (!ref) continue;
    let p = ctx.db.getProject(ref.projectId);
    if (!p) {
      p = {
        id: ref.projectId,
        owner_email: user.email,
        name: `Recovered project ${ref.projectId.slice(0, 6)}`,
        notes: "",
        environment_id: c.environment_id ?? null,
        vault_id: c.vault_id ?? null,
        // The conversations say who worked here, not who should by default.
        default_agent_id: null,
        created_at: c.inserted_at ?? now(),
      };
      if (ctx.db.insertProject(p)) projects += 1;
    }
    if (p.owner_email !== user.email) continue; // someone else's project id; not this key's to fill
    const before = ctx.db.items(p.id).length;
    if (reconcileItems(ctx, p, [c])) {
      items += ctx.db.items(p.id).length - before;
      touched.add(p.id);
    }
  }
  for (const id of touched) ctx.events.emit(id, { kind: "items" });
  return json({ data: { projects, items } });
}

/**
 * Import the tree an earlier build kept in one browser's localStorage. Ids
 * are kept, so the `channel_id`s already on Fountain still match. A project
 * id that exists here already (anyone's) is skipped; its items are added
 * only if the caller owns it.
 */
export async function importState(ctx: AppContext, req: Request): Promise<Response> {
  const user = await authenticate(ctx, req);
  const body = await readJson<{ projects?: unknown; items?: unknown }>(req);
  const projects = Array.isArray(body.projects) ? body.projects : [];
  const items = Array.isArray(body.items) ? body.items : [];
  let np = 0;
  let ni = 0;
  for (const raw of projects.slice(0, 500)) {
    const p = raw as Record<string, unknown>;
    if (typeof p.id !== "string" || !/^[\w-]{1,64}$/.test(p.id)) continue;
    if (
      ctx.db.insertProject({
        id: p.id,
        owner_email: user.email,
        name: str(p.name, 200).trim() || "Untitled project",
        notes: str(p.notes),
        environment_id: optId(p.environmentId),
        vault_id: optId(p.vaultId),
        default_agent_id: optId(p.defaultAgentId),
        created_at: str(p.createdAt, 40) || now(),
      })
    )
      np += 1;
  }
  const touched = new Set<string>();
  for (const raw of items.slice(0, 5000)) {
    const w = raw as Record<string, unknown>;
    if (typeof w.id !== "string" || !/^[\w-]{1,64}$/.test(w.id) || typeof w.projectId !== "string") continue;
    const p = ctx.db.getProject(w.projectId);
    if (!p || p.owner_email !== user.email) continue;
    if (
      ctx.db.insertItem({
        id: w.id,
        project_id: p.id,
        title: str(w.title, 300).trim() || "Untitled work item",
        notes: str(w.notes, 20000),
        status: parseItemStatus(w.status),
        agent_ids: JSON.stringify(Array.isArray(w.agentIds) ? w.agentIds.filter((x: unknown): x is string => typeof x === "string") : []),
        created_at: str(w.createdAt, 40) || now(),
        // A browser's old tree predates proposals; whatever it holds, nothing is proposed on it.
        ...NO_PROPOSAL,
      })
    ) {
      ni += 1;
      touched.add(p.id);
    }
  }
  for (const id of touched) ctx.events.emit(id, { kind: "items" });
  return json({ data: { projects: np, items: ni } });
}

