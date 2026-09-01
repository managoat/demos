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
 *   POST   /api/chats/:id/members         host: { email }
 *   DELETE /api/chats/:id/members/:email  host, or yourself (leave)
 *   POST   /api/chats/:id/invite          host: mint (or re-mint) the join link's token
 *   POST   /api/join/:token               become a member of the chat the link names
 */
import { imagesProblem } from "../shared/images";
import { parseSettings } from "../shared/settings";
import { agentFor } from "./agents";
import { authenticate, chatAccess, ownerClient, requireOwner, userClient, type AppContext } from "./context";
import { randomToken } from "./crypto";
import { now, type ChatRow, type Role, type UserRow } from "./db";
import { FountainHttpError, type ConversationSummary } from "./fountain";
import { HttpError, isEmail, json, normalizeEmail, readJson, str } from "./http";

export interface ChatDto {
  id: string;
  title: string;
  ownerEmail: string;
  role: Role;
  members: { email: string; addedAt: string }[];
  conversationId: string;
  agentId: string;
  settings: { runtime: string; model: string; presetId: string | null; presetName: string | null; environmentId: string | null; vaultId: string | null };
  createdAt: string;
  /** The host only: the join link's token, when one has been made. */
  inviteToken?: string | null;
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
    settings: { runtime: chat.runtime, model: chat.model, presetId: chat.preset_id, presetName: chat.preset_name, environmentId: chat.environment_id, vaultId: chat.vault_id },
    createdAt: chat.created_at,
    status: conv?.status ?? null,
    lastActiveAt: conv?.last_active_at ?? null,
    turnCount: conv?.turn_count ?? null,
    unavailable,
  };
  if (role === "owner") dto.inviteToken = chat.invite_token;
  return dto;
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

  const client = await userClient(ctx, user);
  const id = crypto.randomUUID();
  let conversation: ConversationSummary;
  let presetName: string | null;
  let agentId: string;
  try {
    const made = await agentFor(client, settings);
    agentId = made.agentId;
    presetName = made.presetName;
    const create: Record<string, unknown> = { agent_id: agentId, prompt, channel_id: `salon:${id}`, fresh: true };
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
    owner_email: user.email,
    conversation_id: conversation.id,
    title,
    runtime: settings.runtime,
    model: settings.model,
    preset_id: settings.presetId,
    preset_name: presetName,
    environment_id: settings.environmentId,
    vault_id: settings.vaultId,
    agent_id: agentId,
    invite_token: null,
    created_at: now(),
  };
  ctx.db.insertChat(chat);
  ctx.db.addSend(id, user.email);
  return json({ data: toDto(ctx, chat, "owner", conversation, false) }, 201);
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
