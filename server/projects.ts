/**
 * Projects and work items. A project has an owner — whose Fountain key every
 * conversation in it runs on — and members, who see the same items and talk
 * to the same conversations. Items belong to the project, not to a person.
 *
 * Owner-only: project settings (name, notes, environment, vault), sharing,
 * deletion. Everything else — items, teammates, conversations — is any
 * member's.
 */
import { channelPrefix, newId, parseChannel, recoveredTitle } from "../shared/channel";
import { authenticate, ownerClient, projectAccess, requireOwner, userClient, type AppContext } from "./context";
import { now, parseAgentIds, type ItemRow, type ProjectRow, type Role } from "./db";
import type { ConversationSummary } from "./fountain";
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
  counts: { open: number; done: number };
}

export interface ItemDto {
  id: string;
  projectId: string;
  title: string;
  notes: string;
  status: "open" | "done";
  agentIds: string[];
  createdAt: string;
}

function projectDto(ctx: AppContext, p: ProjectRow, role: Role, counts?: { open: number; done: number }): ProjectDto {
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
    counts: counts ?? ctx.db.itemCounts([p.id]).get(p.id) ?? { open: 0, done: 0 },
  };
}

function itemDto(w: ItemRow): ItemDto {
  return { id: w.id, projectId: w.project_id, title: w.title, notes: w.notes, status: w.status === "done" ? "done" : "open", agentIds: parseAgentIds(w.agent_ids), createdAt: w.created_at };
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
  const row: ItemRow = {
    id: newId(),
    project_id: id,
    title: str(body.title, 300).trim() || "Untitled work item",
    notes: str(body.notes, 20000),
    status: "open",
    agent_ids: "[]",
    created_at: now(),
  };
  ctx.db.insertItem(row);
  ctx.events.emit(id, { kind: "items" });
  return json({ data: itemDto(row) }, 201);
}

export async function patchItem(ctx: AppContext, req: Request, id: string, itemId: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  projectAccess(ctx, user, id);
  const cur = ctx.db.getItem(itemId);
  if (!cur || cur.project_id !== id) throw new HttpError(404, "not_found", "No such work item.");
  const body = await readJson(req);
  const p: Partial<Pick<ItemRow, "title" | "notes" | "status" | "agent_ids">> = {};
  if (typeof body.title === "string") p.title = str(body.title, 300).trim() || "Untitled work item";
  if (typeof body.notes === "string") p.notes = str(body.notes, 20000);
  if (body.status === "open" || body.status === "done") p.status = body.status;
  if (Array.isArray(body.agentIds)) p.agent_ids = JSON.stringify(body.agentIds.filter((x: unknown): x is string => typeof x === "string").slice(0, 100));
  ctx.db.updateItem(itemId, p);
  ctx.events.emit(id, { kind: "items" });
  return json({ data: itemDto(ctx.db.getItem(itemId)!) });
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
        status: w.status === "done" ? "done" : "open",
        agent_ids: JSON.stringify(Array.isArray(w.agentIds) ? w.agentIds.filter((x: unknown): x is string => typeof x === "string") : []),
        created_at: str(w.createdAt, 40) || now(),
      })
    ) {
      ni += 1;
      touched.add(p.id);
    }
  }
  for (const id of touched) ctx.events.emit(id, { kind: "items" });
  return json({ data: { projects: np, items: ni } });
}

