/**
 * Review comments on a chat's changes (shared/comments.ts): Salon's own
 * records, one per line somebody spoke about, shown to everyone on the
 * panel and never a turn on their own.
 *
 *   GET    /api/chats/:id/comments                 every comment, oldest first
 *   POST   /api/chats/:id/comments                 { path, side, line, body } — anyone in the chat
 *   POST   /api/chats/:id/comments/:c/resolve      anyone in the chat; `{ resolved: false }` reopens
 *   DELETE /api/chats/:id/comments/:c              its author, or the host
 *   POST   /api/chats/:id/comments/send            the open, unsent ones become one prompt, sent as the caller's turn
 *
 * Every change goes out as a `comment` event on the chat's stream
 * (server/hub.ts). `send` goes to Fountain on the host's key like any
 * prompt through the proxy, tagged with who pressed the button, and
 * Fountain's refusal (a turn still running is `conversation_busy`)
 * comes back with its code.
 */
import { withAuthor } from "../shared/author";
import { lineText, parseComment, pending, reviewPrompt, type CommentDto } from "../shared/comments";
import { toDto as changesDto } from "./changes";
import { authenticate, chatAccess, ownerClient, type AppContext } from "./context";
import { now, type CommentRow } from "./db";
import { FountainHttpError } from "./fountain";
import { hub } from "./hub";
import { HttpError, json, readJson } from "./http";

export function toDto(r: CommentRow): CommentDto {
  return {
    id: r.id,
    chatId: r.chat_id,
    changesSeq: r.changes_seq,
    path: r.path,
    side: r.side as CommentDto["side"],
    line: r.line,
    quote: r.quote,
    body: r.body,
    author: r.author,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    resolvedBy: r.resolved_by,
    sentAt: r.sent_at,
    sentBy: r.sent_by,
  };
}

export async function list(ctx: AppContext, req: Request, chatId: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { chat } = chatAccess(ctx, user, chatId);
  return json({ data: ctx.db.comments(chat.id).map(toDto) });
}

export async function create(ctx: AppContext, req: Request, chatId: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { chat } = chatAccess(ctx, user, chatId);
  const parsed = parseComment(await readJson(req));
  if (typeof parsed === "string") throw new HttpError(422, "bad_comment", parsed);
  const latest = ctx.db.latestChanges(chat.id);
  if (!latest) throw new HttpError(409, "no_changes", "There are no changes to comment on yet.");
  const row: CommentRow = {
    id: crypto.randomUUID(),
    chat_id: chat.id,
    changes_seq: latest.seq,
    path: parsed.path,
    side: parsed.side,
    line: parsed.line,
    quote: lineText(latest.diff, parsed.path, parsed.side, parsed.line),
    body: parsed.body,
    author: user.email,
    created_at: now(),
    resolved_at: null,
    resolved_by: null,
    sent_at: null,
    sent_by: null,
  };
  ctx.db.insertComment(row);
  const dto = toDto(row);
  hub.publish(chat.id, "comment", dto);
  return json({ data: dto }, 201);
}

export async function resolve(ctx: AppContext, req: Request, chatId: string, commentId: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { chat } = chatAccess(ctx, user, chatId);
  const row = ctx.db.getComment(commentId);
  if (!row || row.chat_id !== chat.id) throw new HttpError(404, "not_found", "No such comment in this chat.");
  const body = await readJson(req);
  const resolved = body.resolved !== false;
  const updated = ctx.db.updateComment(row.id, { resolved_at: resolved ? now() : null, resolved_by: resolved ? user.email : null })!;
  const dto = toDto(updated);
  hub.publish(chat.id, "comment", dto);
  return json({ data: dto });
}

export async function remove(ctx: AppContext, req: Request, chatId: string, commentId: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { chat, role } = chatAccess(ctx, user, chatId);
  const row = ctx.db.getComment(commentId);
  if (!row || row.chat_id !== chat.id) throw new HttpError(404, "not_found", "No such comment in this chat.");
  if (row.author !== user.email && role !== "owner") throw new HttpError(403, "not_yours", "Only the person who wrote it, or the host, can remove a comment.");
  ctx.db.deleteComment(row.id);
  hub.publish(chat.id, "comment", { ...toDto(row), deleted: true });
  return json({ ok: true });
}

/**
 * The open, unsent comments as one prompt, sent as the caller's turn. Every
 * comment names its author inside; the whole thing carries the sender's tag
 * when the room has more than one person, as any prompt does.
 */
export async function send(ctx: AppContext, req: Request, chatId: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { chat } = chatAccess(ctx, user, chatId);
  const open = pending(ctx.db.comments(chat.id).map(toDto));
  if (open.length === 0) throw new HttpError(422, "nothing_to_send", "There are no open comments to send.");
  const latest = ctx.db.latestChanges(chat.id);
  const prompt = reviewPrompt(open, latest ? changesDto(latest, false) : null);
  const tagged = ctx.db.participants(chat).length > 1 ? withAuthor(user.email, prompt) : prompt;
  const client = await ownerClient(ctx, chat);
  const res = await client.fetch(`/api/conversations/${encodeURIComponent(chat.conversation_id)}/prompts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: tagged }),
  });
  if (!res.ok) throw new FountainHttpError(res.status, await res.text()).toHttp("Fountain would not take the comments.");
  ctx.db.addSend(chat.id, user.email);
  const t = now();
  const sent: CommentDto[] = [];
  for (const c of open) {
    const updated = ctx.db.updateComment(c.id, { sent_at: t, sent_by: user.email })!;
    const dto = toDto(updated);
    sent.push(dto);
    hub.publish(chat.id, "comment", dto);
  }
  return json({ data: { sent: sent.length, prompt, comments: sent } }, 202);
}
