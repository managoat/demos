/**
 * Chats: a conversation on Fountain under the host's key, plus the people
 * Salon lets into it. The host pays; a guest never holds the host's key and
 * reaches the conversation only through `/f/<chat>` (server/proxy.ts).
 *
 *   GET    /api/chats                     mine: hosted and invited to, with the conversation's own state
 *   POST   /api/chats                     start one: { prompt, images?, settings, title? }
 *   GET    /api/chats/:id                 the chat, its people, and who sent each turn
 *   PATCH  /api/chats/:id                 host: { title }
 *   DELETE /api/chats/:id                 host: retire the conversation and forget the chat
 *   POST   /api/chats/:id/archive         host: end the conversation, keep the chat
 *   POST   /api/chats/:id/restore         host: a new conversation on the same setup, on the pushed branch
 *   POST   /api/chats/:id/members         host: { email }
 *   DELETE /api/chats/:id/members/:email  host, or yourself (leave)
 *   POST   /api/chats/:id/invite          host: mint (or re-mint) the join link's token
 *   POST   /api/join/:token               become a member of the chat the link names
 */
import { withAuthor } from "../shared/author";
import { imagesProblem } from "../shared/images";
import { runtimeFor } from "../shared/models";
import { parseSettings } from "../shared/settings";
import { agentFor, type ProjectContext } from "./agents";
import type { ChosenConnector } from "./connectors";
import { authenticate, chatAccess, ownerClient, requireOwner, userClient, type AppContext } from "./context";
import { randomToken } from "./crypto";
import { now, type ChatRow, type Role, type UserRow } from "./db";
import { FountainHttpError, type ConversationSummary } from "./fountain";
import { HttpError, isEmail, json, normalizeEmail, readJson, str } from "./http";
import { projectOwnerClient, refreshEnvironment } from "./projects";

export interface ChatDto {
  id: string;
  title: string;
  ownerEmail: string;
  role: Role;
  members: { email: string; addedAt: string }[];
  conversationId: string;
  agentId: string;
  /** What the chat was started with, as the header shows it: "Opus 5 · Gmail, PDFs". */
  settings: { model: string; skills: string[]; connectors: ChosenConnector[] };
  /** The project the chat was started in, when it was. */
  project: { id: string; name: string; repoUrl: string; base: string } | null;
  createdAt: string;
  /** The host only: the join link's token, when one has been made. */
  inviteToken?: string | null;
  /** Set when the host archived it: the computer was let go, the chat kept; restore starts it again on the branch. */
  archivedAt: string | null;
  /** From Fountain, when the host's key answered. */
  status: string | null;
  lastActiveAt: string | null;
  turnCount: number | null;
  /** The host's key did not answer, so nothing above `createdAt` is known. */
  unavailable: boolean;
}

function toDto(ctx: AppContext, chat: ChatRow, role: Role, conv: ConversationSummary | null, unavailable: boolean): ChatDto {
  const dto: ChatDto = {
    id: chat.id,
    title: chat.title || conv?.title || firstLine(conv?.first_prompt) || "New chat",
    ownerEmail: chat.owner_email,
    role,
    members: ctx.db.members(chat.id).map((m) => ({ email: m.email, addedAt: m.added_at })),
    conversationId: chat.conversation_id,
    agentId: chat.agent_id,
    settings: { model: chat.model, skills: parseJson<string[]>(chat.skills, []), connectors: parseJson<ChosenConnector[]>(chat.connectors, []) },
    project: projectOf(ctx, chat),
    archivedAt: chat.archived_at,
    createdAt: chat.created_at,
    status: conv?.status ?? null,
    lastActiveAt: conv?.last_active_at ?? null,
    turnCount: conv?.turn_count ?? null,
    unavailable,
  };
  if (role === "owner") dto.inviteToken = chat.invite_token;
  return dto;
}

function projectOf(ctx: AppContext, chat: ChatRow): ChatDto["project"] {
  const p = chat.project_id ? ctx.db.getProject(chat.project_id) : null;
  return p ? { id: p.id, name: p.name, repoUrl: p.repo_url, base: p.base } : null;
}

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function firstLine(s: string | null | undefined): string | null {
  if (!s) return null;
  const line = s.split("\n").find((l) => l.trim()) ?? "";
  return line.trim().slice(0, 80) || null;
}

/** The conversation behind one chat, on the host's key; null when the host's key would not answer. */
async function conversationOf(ctx: AppContext, chat: ChatRow): Promise<{ conv: ConversationSummary | null; unavailable: boolean }> {
  try {
    const client = await ownerClient(ctx, chat);
    return { conv: await client.conversation(chat.conversation_id), unavailable: false };
  } catch {
    return { conv: null, unavailable: true };
  }
}

export async function list(ctx: AppContext, req: Request): Promise<Response> {
  const user = await authenticate(ctx, req);
  const rows = ctx.db.chatsFor(user.email);
  // One listing per host rather than one read per chat: a guest in twenty of
  // one person's chats costs one request, not twenty.
  const byOwner = new Map<string, ChatRow[]>();
  for (const c of rows) byOwner.set(c.owner_email, [...(byOwner.get(c.owner_email) ?? []), c]);
  const out: ChatDto[] = [];
  await Promise.all(
    [...byOwner.entries()].map(async ([owner, chats]) => {
      let convs: Map<string, ConversationSummary> | null = null;
      try {
        const client = await ownerClient(ctx, chats[0]!);
        convs = new Map((await client.conversations({ roots_only: "false" })).map((c) => [c.id, c]));
      } catch (err) {
        console.warn(`salon: could not list conversations for ${owner}:`, err instanceof Error ? err.message : err);
      }
      for (const c of chats) {
        const role: Role = c.owner_email === user.email ? "owner" : "member";
        out.push(toDto(ctx, c, role, convs?.get(c.conversation_id) ?? null, convs === null));
      }
    }),
  );
  out.sort((a, b) => (b.lastActiveAt ?? b.createdAt).localeCompare(a.lastActiveAt ?? a.createdAt));
  return json({ data: out });
}

export async function create(ctx: AppContext, req: Request): Promise<Response> {
  const user = await authenticate(ctx, req);
  const body = await readJson(req);
  const prompt = str(body.prompt, 100_000).trim();
  const problem = imagesProblem(body.images);
  if (problem) throw new HttpError(422, "bad_images", problem);
  const images = Array.isArray(body.images) && body.images.length ? body.images : null;
  if (!prompt && !images) throw new HttpError(422, "prompt_required", "Say something to start the chat.");
  const settings = parseSettings(body.settings);
  if (typeof settings === "string") throw new HttpError(422, "bad_settings", settings);
  const title = str(body.title, 120).trim();

  // In a project, the chat is the project owner's: their computer setup, their key, their bill — whoever starts it.
  let host = user;
  let client = await userClient(ctx, user);
  let project: ProjectContext | null = null;
  const projectRow = settings.projectId ? ctx.db.getProject(settings.projectId) : null;
  if (settings.projectId) {
    if (!projectRow || !ctx.db.projectRoleIn(projectRow.id, user.email)) throw new HttpError(404, "not_found", "No such project.");
    ({ owner: host, client } = await projectOwnerClient(ctx, projectRow));
    await refreshEnvironment(ctx, client, projectRow);
    settings.environmentId = projectRow.environment_id;
    project = { name: projectRow.name, repoUrl: projectRow.repo_url, repoPath: projectRow.mount_path, base: projectRow.base };
  }
  const id = crypto.randomUUID();
  let conversation: ConversationSummary;
  let connectors: ChosenConnector[];
  let agentId: string;
  try {
    const made = await agentFor(client, settings, ctx.config.publicUrl, project);
    agentId = made.agentId;
    connectors = made.connectors;
    const tagged = projectRow && (ctx.db.projectMembers(projectRow.id).length > 0 || user.email !== host.email) ? withAuthor(user.email, prompt) : prompt;
    const create: Record<string, unknown> = { agent_id: agentId, prompt: tagged, channel_id: `salon:${id}`, fresh: true };
    if (images) create.images = images;
    if (settings.environmentId) create.environment_id = settings.environmentId;
    if (settings.vaultId) create.vault_id = settings.vaultId;
    if (title) create.title = title;
    conversation = await client.createConversation(create);
  } catch (err) {
    if (err instanceof FountainHttpError) throw err.toHttp("Fountain would not start the chat.");
    throw err;
  }

  const chat: ChatRow = {
    id,
    owner_email: host.email,
    conversation_id: conversation.id,
    title,
    runtime: runtimeFor(settings.model),
    model: settings.model,
    skills: JSON.stringify(settings.skills),
    connectors: JSON.stringify(connectors),
    preset_id: settings.presetId,
    preset_name: null,
    environment_id: settings.environmentId,
    vault_id: settings.vaultId,
    agent_id: agentId,
    invite_token: null,
    project_id: projectRow?.id ?? null,
    archived_at: null,
    created_at: now(),
  };
  ctx.db.insertChat(chat);
  if (projectRow) {
    // The project's people are the chat's people, the one who started it included.
    for (const m of ctx.db.projectMembers(projectRow.id)) ctx.db.addMember(id, m.email, `project:${projectRow.id}`);
    if (user.email !== host.email) ctx.db.addMember(id, user.email, `project:${projectRow.id}`);
  }
  ctx.db.addSend(id, user.email);
  return json({ data: toDto(ctx, chat, user.email === host.email ? "owner" : "member", conversation, false) }, 201);
}

export async function show(ctx: AppContext, req: Request, id: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { chat, role } = chatAccess(ctx, user, id);
  const { conv, unavailable } = await conversationOf(ctx, chat);
  return json({ data: { chat: toDto(ctx, chat, role, conv, unavailable), sends: ctx.db.sends(chat.id).map((s) => ({ seq: s.seq, email: s.email, at: s.at })) } });
}

export async function patch(ctx: AppContext, req: Request, id: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { chat, role } = chatAccess(ctx, user, id);
  requireOwner(role);
  const body = await readJson(req);
  if (typeof body.title === "string") ctx.db.updateChat(chat.id, { title: str(body.title, 120).trim() });
  return await show(ctx, req, id);
}

export async function remove(ctx: AppContext, req: Request, id: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { chat, role } = chatAccess(ctx, user, id);
  requireOwner(role);
  try {
    await (await ownerClient(ctx, chat)).terminate(chat.conversation_id);
  } catch (err) {
    // The chat is forgotten either way; a computer that outlives it is reclaimed by Fountain's own idle rules.
    console.warn(`salon: terminate ${chat.conversation_id} failed:`, err instanceof Error ? err.message : err);
  }
  ctx.db.deleteChat(chat.id);
  return json({ ok: true });
}

/**
 * Archive: end the conversation, so the computer goes, and keep the chat —
 * its transcript on Fountain, its changes and comments here. What was not
 * pushed is gone with the computer; the checks strip said so beforehand.
 */
export async function archive(ctx: AppContext, req: Request, id: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { chat, role } = chatAccess(ctx, user, id);
  requireOwner(role);
  if (chat.archived_at) return await show(ctx, req, id);
  try {
    await (await ownerClient(ctx, chat)).terminate(chat.conversation_id);
  } catch (err) {
    if (err instanceof FountainHttpError) throw err.toHttp("Fountain would not end the conversation.");
    throw err;
  }
  ctx.db.updateChat(chat.id, { archived_at: now() });
  return await show(ctx, req, id);
}

/**
 * Restore: a fresh conversation on the same agent and environment — a new
 * computer — told to pick the branch up where it was pushed. The old
 * conversation stays on Fountain; this chat now shows the new one, and
 * its user turns count from one again.
 */
export async function restore(ctx: AppContext, req: Request, id: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { chat, role } = chatAccess(ctx, user, id);
  requireOwner(role);
  if (!chat.archived_at) return await show(ctx, req, id);
  const latest = ctx.db.latestChanges(chat.id);
  const branch = latest?.branch && latest.branch !== latest.base ? latest.branch : null;
  const prompt = branch
    ? `We are picking this chat up again on a new computer. Fetch and check out the branch ${branch} from origin (it was pushed from the previous computer), then say in a sentence where things stand.`
    : "We are picking this chat up again on a new computer. Say in a sentence where things stand.";
  const client = await ownerClient(ctx, chat);
  let conversation: ConversationSummary;
  try {
    const create: Record<string, unknown> = { agent_id: chat.agent_id, prompt, channel_id: `salon:${chat.id}`, fresh: true };
    if (chat.environment_id) create.environment_id = chat.environment_id;
    if (chat.vault_id) create.vault_id = chat.vault_id;
    if (chat.title) create.title = chat.title;
    conversation = await client.createConversation(create);
  } catch (err) {
    if (err instanceof FountainHttpError) throw err.toHttp("Fountain would not start the chat again.");
    throw err;
  }
  ctx.db.clearSends(chat.id);
  ctx.db.updateChat(chat.id, { archived_at: null, conversation_id: conversation.id });
  ctx.db.addSend(chat.id, user.email);
  return await show(ctx, req, id);
}

export async function addMember(ctx: AppContext, req: Request, id: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { chat, role } = chatAccess(ctx, user, id);
  requireOwner(role);
  const body = await readJson(req);
  const email = normalizeEmail(body.email);
  if (!isEmail(email)) throw new HttpError(422, "bad_email", "That is not an email address.");
  if (email === chat.owner_email) throw new HttpError(422, "is_host", "You host this chat already.");
  ctx.db.addMember(chat.id, email, user.email);
  return await show(ctx, req, id);
}

export async function removeMember(ctx: AppContext, req: Request, id: string, rawEmail: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { chat, role } = chatAccess(ctx, user, id);
  const email = normalizeEmail(decodeURIComponent(rawEmail));
  if (role !== "owner" && email !== user.email) throw new HttpError(403, "host_only", "Only the host can remove someone else.");
  ctx.db.removeMember(chat.id, email);
  if (email === user.email) return json({ ok: true, left: true });
  return await show(ctx, req, id);
}

export async function invite(ctx: AppContext, req: Request, id: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { chat, role } = chatAccess(ctx, user, id);
  requireOwner(role);
  const token = randomToken(18);
  ctx.db.updateChat(chat.id, { invite_token: token });
  return json({ data: { token } });
}

export async function join(ctx: AppContext, req: Request, token: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const chat = ctx.db.chatByInvite(token);
  if (!chat) throw new HttpError(404, "bad_invite", "That invite link is not valid any more.");
  const role: Role = chat.owner_email === user.email ? "owner" : "member";
  if (role === "member") ctx.db.addMember(chat.id, user.email, `link:${chat.owner_email}`);
  const { conv, unavailable } = await conversationOf(ctx, chat);
  return json({ data: toDto(ctx, chat, role, conv, unavailable) });
}

export function isOwner(user: UserRow, chat: ChatRow): boolean {
  return chat.owner_email === user.email;
}
