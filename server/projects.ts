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
import { emptyCounts, isClosed, isItemStatus, isProposedStatus, parseItemStatus, type ItemCounts, type ItemStatus, type Proposal, type ProposedStatus } from "../shared/status";
import { authenticate, ownerClient, projectAccess, requireOwner, userClient, type AppContext } from "./context";
import { NO_PROPOSAL, now, parseAgentIds, type ItemPatch, type ItemRow, type ProjectRow, type Role } from "./db";
import { FountainHttpError, type ConversationSummary, type FountainClient } from "./fountain";
import { HttpError, isEmail, json, normalizeEmail, optId, readJson, str } from "./http";

export interface ProjectDto {
  id: string;
  name: string;
  notes: string;
  environmentId: string | null;
  vaultId: string | null;
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
}

/** What closing a work item did to its computers. */
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
    createdAt: p.created_at,
    ownerEmail: p.owner_email,
    role,
    members: ctx.db.members(p.id).map((m) => ({ email: m.email, addedAt: m.added_at })),
    counts: counts ?? ctx.db.itemCounts([p.id]).get(p.id) ?? emptyCounts(),
  };
}

export function itemDto(w: ItemRow): ItemDto {
  return {
    id: w.id,
    projectId: w.project_id,
    title: w.title,
    notes: w.notes,
    status: parseItemStatus(w.status),
    agentIds: parseAgentIds(w.agent_ids),
    createdAt: w.created_at,
    proposal: proposalOf(w),
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

/**
 * What is happening in each of the caller's projects: how many conversations
 * are working, and when anything last happened. One Fountain call per
 * distinct owner, all in parallel; an owner whose key fails just reports nothing.
 */
export async function activity(ctx: AppContext, req: Request): Promise<Response> {
  const user = await authenticate(ctx, req);
  const rows = ctx.db.projectsFor(user.email);
  const mine = new Set(rows.map((p) => p.id));
  const byOwner = new Map<string, ProjectRow>();
  for (const p of rows) if (!byOwner.has(p.owner_email)) byOwner.set(p.owner_email, p);
  const out: Record<string, { live: number; latest: string | null }> = {};
  for (const p of rows) out[p.id] = { live: 0, latest: null };
  await Promise.allSettled(
    [...byOwner.values()].map(async (p) => {
      const client = await ownerClient(ctx, p);
      const convs = await client.conversations({ roots_only: "true" });
      for (const c of convs) {
        const ref = parseChannel(c.channel_id);
        if (!ref || !mine.has(ref.projectId)) continue;
        // Only this owner's projects: the same id under another owner is not this conversation's.
        if (ctx.db.getProject(ref.projectId)?.owner_email !== p.owner_email) continue;
        const a = out[ref.projectId]!;
        if (c.status === "running" || c.status === "pending") a.live += 1;
        const at = c.last_active_at ?? c.updated_at ?? c.inserted_at ?? null;
        if (at && (!a.latest || at > a.latest)) a.latest = at;
      }
    }),
  );
  return json({ data: out });
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
    created_at: now(),
  };
  ctx.db.insertProject(row);
  return json({ data: projectDto(ctx, row, "owner") }, 201);
}

export async function show(ctx: AppContext, req: Request, id: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { project, role } = projectAccess(ctx, user, id);
  return json({ data: { project: projectDto(ctx, project, role), items: ctx.db.items(id).map(itemDto) } });
}

export async function patch(ctx: AppContext, req: Request, id: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { role } = projectAccess(ctx, user, id);
  requireOwner(role);
  const body = await readJson(req);
  const p: Partial<Pick<ProjectRow, "name" | "notes" | "environment_id" | "vault_id">> = {};
  if (typeof body.name === "string") p.name = str(body.name, 200).trim() || "Untitled project";
  if (typeof body.notes === "string") p.notes = str(body.notes);
  if ("environmentId" in body) p.environment_id = optId(body.environmentId);
  if ("vaultId" in body) p.vault_id = optId(body.vaultId);
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
  const item = itemDto(ctx.db.getItem(itemId)!);
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
 * An item's computers, once it is closed — done or won't do alike: the work
 * is over either way, so the machines go.
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
async function retire(ctx: AppContext, project: ProjectRow, itemId: string): Promise<RetiredDto> {
  const out: RetiredDto = { conversations: 0, computers: 0, failed: 0 };
  let convs: ConversationSummary[];
  let client: FountainClient;
  try {
    client = await ownerClient(ctx, project);
    convs = await client.conversations({ roots_only: "false" });
  } catch (err) {
    return { ...out, error: reason(err) };
  }
  const live = convs.filter((c) => channelIsItem(c.channel_id, project.id, itemId) && c.status !== "terminated");
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

