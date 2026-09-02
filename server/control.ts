/**
 * Salon's multiplayer intent/control seam.
 *
 * Routes are intentionally exported as ordinary handlers so app.ts can wire
 * them without putting policy in the route table. The schema installer is
 * idempotent; db.ts should eventually own these tables, but existing installs
 * are safe as soon as any handler is called.
 */
import { splitAuthor, withAuthor } from "../shared/author";
import {
  canControl,
  notesPrompt,
  parseNoteInput,
  parseNoteQueue,
  parsePermissionAnswer,
  parsePresenceHeartbeat,
  promptWithQueuedNotes,
  type ControlAction,
  type ControlEventDto,
  type ControlOutcome,
  type RoomNoteDto,
} from "../shared/control";
import { authenticate, chatAccess, ownerClient, type AppContext } from "./context";
import type { ChatRow, Role } from "./db";
import { now } from "./db";
import { FountainHttpError, type FountainClient } from "./fountain";
import { hub } from "./hub";
import { HttpError, json, readJson } from "./http";
import { withPromptLock } from "./prompt-lock";

interface NoteRow {
  id: string;
  chat_id: string;
  body: string;
  author: string;
  queued: 0 | 1;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  sent_at: string | null;
  sent_by: string | null;
}

interface ControlRow {
  id: string;
  chat_id: string;
  actor: string;
  action: ControlAction;
  outcome: ControlOutcome;
  conversation_id: string;
  turn_id: string | null;
  request_id: string | null;
  option_id: string | null;
  winner: string | null;
  created_at: string;
}

interface FountainTurn {
  id: string;
  turn_number: number;
  prompt: string;
  status: string;
  origin?: string | null;
}

export interface ActiveTurnDto {
  id: string;
  author: string;
  status: string;
}

const installed = new WeakSet<object>();

export function installControlSchema(ctx: AppContext): void {
  if (installed.has(ctx.db.sql)) return;
  ctx.db.sql.exec(`
    CREATE TABLE IF NOT EXISTS room_notes (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      author TEXT NOT NULL,
      queued INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by TEXT,
      sent_at TEXT,
      sent_by TEXT
    );
    CREATE INDEX IF NOT EXISTS room_notes_chat ON room_notes(chat_id, created_at);
    CREATE TABLE IF NOT EXISTS control_actions (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      turn_id TEXT,
      request_id TEXT,
      option_id TEXT,
      outcome TEXT NOT NULL,
      winner TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS control_actions_chat ON control_actions(chat_id, created_at);
    CREATE INDEX IF NOT EXISTS control_actions_request ON control_actions(chat_id, request_id, created_at);
  `);
  installed.add(ctx.db.sql);
}

function noteDto(row: NoteRow): RoomNoteDto {
  return {
    id: row.id,
    chatId: row.chat_id,
    body: row.body,
    author: row.author,
    delivery: row.queued ? "next_turn" : "manual",
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    sentAt: row.sent_at,
    sentBy: row.sent_by,
  };
}

function controlDto(row: ControlRow): ControlEventDto {
  return {
    id: row.id,
    chatId: row.chat_id,
    actor: row.actor,
    action: row.action,
    outcome: row.outcome,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    turnAuthor: null,
    requestId: row.request_id,
    optionId: row.option_id,
    winner: row.winner,
    errorCode: null,
    createdAt: row.created_at,
  };
}

export async function listNotes(ctx: AppContext, req: Request, chatId: string): Promise<Response> {
  installControlSchema(ctx);
  const user = await authenticate(ctx, req);
  const { chat } = chatAccess(ctx, user, chatId);
  return json({ data: notes(ctx, chat.id, false) });
}

export async function createNote(ctx: AppContext, req: Request, chatId: string): Promise<Response> {
  installControlSchema(ctx);
  const user = await authenticate(ctx, req);
  const { chat } = chatAccess(ctx, user, chatId);
  const parsed = parseNoteInput(await readJson(req));
  if (typeof parsed === "string") throw new HttpError(422, "bad_note", parsed);
  const createdAt = now();
  const row: NoteRow = {
    id: crypto.randomUUID(),
    chat_id: chat.id,
    body: parsed.body,
    author: user.email,
    queued: parsed.delivery === "next_turn" ? 1 : 0,
    created_at: createdAt,
    resolved_at: null,
    resolved_by: null,
    sent_at: null,
    sent_by: null,
  };
  ctx.db.sql
    .query(`INSERT INTO room_notes (id, chat_id, body, author, queued, created_at, resolved_at, resolved_by, sent_at, sent_by)
            VALUES ($id, $chatId, $body, $author, $queued, $createdAt, NULL, NULL, NULL, NULL)`)
    .run({ id: row.id, chatId: row.chat_id, body: row.body, author: row.author, queued: row.queued, createdAt: row.created_at });
  const dto = noteDto(row);
  hub.publish(chat.id, "note", dto);
  return json({ data: dto }, 201);
}

export async function queueNote(ctx: AppContext, req: Request, chatId: string, noteId: string): Promise<Response> {
  installControlSchema(ctx);
  const user = await authenticate(ctx, req);
  const { chat, role } = chatAccess(ctx, user, chatId);
  const row = note(ctx, chat.id, noteId);
  if (row.author !== user.email && role !== "owner") throw new HttpError(403, "not_yours", "Only the person who wrote this note, or the host, can change its delivery.");
  if (row.sent_at) throw new HttpError(409, "note_already_sent", "That note has already been sent.");
  const parsed = parseNoteQueue(await readJson(req));
  if (typeof parsed === "string") throw new HttpError(422, "bad_note_queue", parsed);
  ctx.db.sql.query("UPDATE room_notes SET queued = $queued WHERE id = $id").run({ id: row.id, queued: parsed === "next_turn" ? 1 : 0 });
  const updated = note(ctx, chat.id, row.id);
  const dto = noteDto(updated);
  hub.publish(chat.id, "note", dto);
  return json({ data: dto });
}

export async function resolveNote(ctx: AppContext, req: Request, chatId: string, noteId: string): Promise<Response> {
  installControlSchema(ctx);
  const user = await authenticate(ctx, req);
  const { chat } = chatAccess(ctx, user, chatId);
  const row = note(ctx, chat.id, noteId);
  const body = await readJson(req);
  const resolved = body.resolved !== false;
  ctx.db.sql.query("UPDATE room_notes SET resolved_at = $at, resolved_by = $by WHERE id = $id").run({ id: row.id, at: resolved ? now() : null, by: resolved ? user.email : null });
  const dto = noteDto(note(ctx, chat.id, row.id));
  hub.publish(chat.id, "note", dto);
  return json({ data: dto });
}

export async function deleteNote(ctx: AppContext, req: Request, chatId: string, noteId: string): Promise<Response> {
  installControlSchema(ctx);
  const user = await authenticate(ctx, req);
  const { chat, role } = chatAccess(ctx, user, chatId);
  const row = note(ctx, chat.id, noteId);
  if (row.author !== user.email && role !== "owner") throw new HttpError(403, "not_yours", "Only the person who wrote this note, or the host, can remove it.");
  ctx.db.sql.query("DELETE FROM room_notes WHERE id = $id").run({ id: row.id });
  hub.publish(chat.id, "note", { ...noteDto(row), deleted: true });
  return json({ ok: true });
}

/** Send every unsent room note as one attributed turn. Busy means no mutation. */
export async function sendNotes(ctx: AppContext, req: Request, chatId: string): Promise<Response> {
  installControlSchema(ctx);
  const user = await authenticate(ctx, req);
  const { chat } = chatAccess(ctx, user, chatId);
  return withPromptLock(chat.id, async () => {
    const executing = ctx.db.sql.query("SELECT 1 FROM plan_executions WHERE plan_id IN (SELECT id FROM plans WHERE chat_id = $chat) AND status IN ('queued', 'running') LIMIT 1").get({ chat: chat.id });
    if (executing) throw new HttpError(409, "plan_execution_busy", "Wait for the approved plan node to be finalized before sending room notes.");
    const pending = notes(ctx, chat.id, true);
    if (pending.length === 0) throw new HttpError(422, "nothing_to_send", "There are no unsent room notes.");
    const prompt = notesPrompt(pending);
    const tagged = ctx.db.participants(chat).length > 1 ? withAuthor(user.email, prompt) : prompt;
    const client = await ownerClient(ctx, chat);
    const res = await client.fetch(`/api/conversations/${encodeURIComponent(chat.conversation_id)}/prompts`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: tagged }),
    });
    if (!res.ok) throw new FountainHttpError(res.status, await res.text()).toHttp("Fountain would not take the room notes.");
    const seq = ctx.db.addSend(chat.id, user.email);
    hub.publish(chat.id, "turn", { id: `pending:${seq}`, author: user.email, status: "pending" });
    const sent = markNotesSent(ctx, chat.id, pending.map((item) => item.id), user.email);
    for (const item of sent) hub.publish(chat.id, "note", item);
    return json({ data: { sent: sent.length, prompt, notes: sent } }, 202);
  });
}

/**
 * Called by the normal prompt endpoint before forwarding. The returned ids
 * must only be marked after Fountain accepts the prompt.
 */
export function preparePromptWithQueuedNotes(ctx: AppContext, chatId: string, prompt: string): { prompt: string; noteIds: string[] } {
  installControlSchema(ctx);
  const queued = notes(ctx, chatId, true).filter((item) => item.delivery === "next_turn");
  return { prompt: promptWithQueuedNotes(prompt, queued), noteIds: queued.map((item) => item.id) };
}

/** Called after the associated prompt was accepted by Fountain. */
export function markQueuedNotesSent(ctx: AppContext, chatId: string, noteIds: readonly string[], sender: string): RoomNoteDto[] {
  installControlSchema(ctx);
  const sent = markNotesSent(ctx, chatId, noteIds, sender);
  for (const item of sent) hub.publish(chatId, "note", item);
  return sent;
}

export async function heartbeat(ctx: AppContext, req: Request, chatId: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { chat } = chatAccess(ctx, user, chatId);
  const parsed = parsePresenceHeartbeat(await readJson(req));
  if (typeof parsed === "string") throw new HttpError(422, "bad_presence", parsed);
  return json({ data: hub.heartbeat(chat.id, user.email, parsed) });
}

export async function leave(ctx: AppContext, req: Request, chatId: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { chat } = chatAccess(ctx, user, chatId);
  const parsed = parsePresenceHeartbeat(await readJson(req));
  if (typeof parsed === "string") throw new HttpError(422, "bad_presence", parsed);
  return json({ data: hub.leave(chat.id, user.email, parsed.clientId) });
}

export async function state(ctx: AppContext, req: Request, chatId: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { chat } = chatAccess(ctx, user, chatId);
  return json({ data: { presence: hub.presence(chat.id), activeTurn: await activeTurn(ctx, chat) } });
}

export async function listControlEvents(ctx: AppContext, req: Request, chatId: string): Promise<Response> {
  installControlSchema(ctx);
  const user = await authenticate(ctx, req);
  const { chat } = chatAccess(ctx, user, chatId);
  const rows = ctx.db.sql.query("SELECT * FROM control_actions WHERE chat_id = $chatId ORDER BY created_at, rowid").all({ chatId: chat.id }) as ControlRow[];
  return json({ data: rows.map(controlDto) });
}

export async function interrupt(ctx: AppContext, req: Request, chatId: string): Promise<Response> {
  installControlSchema(ctx);
  const user = await authenticate(ctx, req);
  const { chat, role } = chatAccess(ctx, user, chatId);
  const client = await ownerClient(ctx, chat);
  const turn = await controlTurn(ctx, chat, client, false);
  if (!canControl(user.email, role, turn?.author ?? null)) {
    const event = recordControl(ctx, chat, user.email, "interrupt", "denied", turn, null, null, null);
    hub.publish(chat.id, "control", event);
    throw new HttpError(403, "control_not_allowed", "Only the person who started this turn, or the host, can interrupt it.");
  }
  const res = await client.fetch(`/api/conversations/${encodeURIComponent(chat.conversation_id)}/interrupt`, { method: "POST" });
  if (!res.ok) {
    const err = new FountainHttpError(res.status, await res.text());
    const event = { ...recordControl(ctx, chat, user.email, "interrupt", "failed", turn, null, null, null), errorCode: err.code };
    hub.publish(chat.id, "control", event);
    throw err.toHttp("Fountain would not interrupt the turn.");
  }
  const event = recordControl(ctx, chat, user.email, "interrupt", "succeeded", turn, null, null, null);
  hub.publish(chat.id, "control", event);
  return json({ data: event }, 202);
}

export async function answerPermission(ctx: AppContext, req: Request, chatId: string, requestId?: string): Promise<Response> {
  installControlSchema(ctx);
  const user = await authenticate(ctx, req);
  const { chat, role } = chatAccess(ctx, user, chatId);
  const parsed = parsePermissionAnswer(await readJson(req), requestId);
  if (typeof parsed === "string") throw new HttpError(422, "bad_permission_answer", parsed);
  const client = await ownerClient(ctx, chat);
  const turn = await controlTurn(ctx, chat, client, true);
  if (!canControl(user.email, role, turn?.author ?? null)) {
    const event = recordControl(ctx, chat, user.email, "permission_answer", "denied", turn, parsed.requestId, parsed.optionId, null);
    hub.publish(chat.id, "control", event);
    throw new HttpError(403, "control_not_allowed", "Only the person who started this turn, or the host, can answer its permission requests.");
  }
  const res = await client.fetch(`/api/conversations/${encodeURIComponent(chat.conversation_id)}/requests/${encodeURIComponent(parsed.requestId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ option_id: parsed.optionId }),
  });
  if (!res.ok) {
    const err = new FountainHttpError(res.status, await res.text());
    const lost = err.code === "permission_request_resolved";
    const winner = lost ? await firstRecordedAnswer(ctx, chat.id, parsed.requestId) : null;
    const event = { ...recordControl(ctx, chat, user.email, "permission_answer", lost ? "first_answer_lost" : "failed", turn, parsed.requestId, parsed.optionId, winner?.actor ?? null), errorCode: err.code };
    hub.publish(chat.id, "control", event);
    if (lost) {
      return json({ error: err.code, message: err.detail ?? "That permission request was already answered.", answeredBy: winner?.actor ?? null, data: event }, res.status);
    }
    throw err.toHttp("Fountain would not accept the permission answer.");
  }
  const event = recordControl(ctx, chat, user.email, "permission_answer", "succeeded", turn, parsed.requestId, parsed.optionId, null);
  hub.publish(chat.id, "control", event);
  return json({ data: event }, 202);
}

export async function activeTurn(ctx: AppContext, chat: ChatRow): Promise<ActiveTurnDto | null> {
  return controlTurn(ctx, chat, await ownerClient(ctx, chat), false);
}

async function controlTurn(ctx: AppContext, chat: ChatRow, client: FountainClient, allowLatest: boolean): Promise<ActiveTurnDto | null> {
  const res = await client.fetch(`/api/conversations/${encodeURIComponent(chat.conversation_id)}/turns`);
  const text = await res.text();
  if (!res.ok) throw new FountainHttpError(res.status, text).toHttp("Fountain would not list the turns.");
  const parsed = JSON.parse(text) as { data?: FountainTurn[] };
  const turns = Array.isArray(parsed.data) ? parsed.data.filter(validTurn).sort((a, b) => a.turn_number - b.turn_number) : [];
  const live = [...turns].reverse().find((turn) => turn.status === "running" || turn.status === "pending");
  const target = live ?? (allowLatest ? [...turns].reverse().find((turn) => turn.origin !== "autonomous") : undefined);
  if (!target) return null;
  let seq = 0;
  let author: string | null = null;
  for (const turn of turns) {
    if (turn.origin === "autonomous") continue;
    seq++;
    if (turn.id !== target.id) continue;
    author = splitAuthor(turn.prompt).email ?? ctx.db.sends(chat.id).find((send) => send.seq === seq)?.email ?? chat.owner_email;
    break;
  }
  return { id: target.id, author: author ?? chat.owner_email, status: target.status };
}

function validTurn(value: FountainTurn): boolean {
  return !!value && typeof value.id === "string" && typeof value.turn_number === "number" && typeof value.prompt === "string" && typeof value.status === "string";
}

function notes(ctx: AppContext, chatId: string, unsentOnly: boolean): RoomNoteDto[] {
  const where = unsentOnly ? " AND sent_at IS NULL AND resolved_at IS NULL" : "";
  const rows = ctx.db.sql.query(`SELECT * FROM room_notes WHERE chat_id = $chatId${where} ORDER BY created_at, rowid`).all({ chatId }) as NoteRow[];
  return rows.map(noteDto);
}

function note(ctx: AppContext, chatId: string, noteId: string): NoteRow {
  const row = ctx.db.sql.query("SELECT * FROM room_notes WHERE id = $id AND chat_id = $chatId").get({ id: noteId, chatId }) as NoteRow | null;
  if (!row) throw new HttpError(404, "not_found", "No such note in this chat.");
  return row;
}

function markNotesSent(ctx: AppContext, chatId: string, noteIds: readonly string[], sender: string): RoomNoteDto[] {
  if (noteIds.length === 0) return [];
  const at = now();
  const update = ctx.db.sql.query("UPDATE room_notes SET sent_at = $at, sent_by = $sender WHERE id = $id AND chat_id = $chatId AND sent_at IS NULL");
  const tx = ctx.db.sql.transaction((ids: readonly string[]) => {
    for (const id of ids) update.run({ id, chatId, at, sender });
  });
  tx(noteIds);
  const wanted = new Set(noteIds);
  return notes(ctx, chatId, false).filter((item) => wanted.has(item.id) && item.sentAt === at);
}

function recordControl(
  ctx: AppContext,
  chat: ChatRow,
  actor: string,
  action: ControlAction,
  outcome: ControlOutcome,
  turn: ActiveTurnDto | null,
  requestId: string | null,
  optionId: string | null,
  winner: string | null,
): ControlEventDto {
  const row: ControlRow = {
    id: crypto.randomUUID(),
    chat_id: chat.id,
    actor,
    action,
    outcome,
    conversation_id: chat.conversation_id,
    turn_id: turn?.id ?? null,
    request_id: requestId,
    option_id: optionId,
    winner,
    created_at: now(),
  };
  ctx.db.sql
    .query(`INSERT INTO control_actions
      (id, chat_id, actor, action, conversation_id, turn_id, request_id, option_id, outcome, winner, created_at)
      VALUES ($id, $chatId, $actor, $action, $conversationId, $turnId, $requestId, $optionId, $outcome, $winner, $createdAt)`)
    .run({
      id: row.id,
      chatId: row.chat_id,
      actor: row.actor,
      action: row.action,
      outcome: row.outcome,
      conversationId: row.conversation_id,
      turnId: row.turn_id,
      requestId: row.request_id,
      optionId: row.option_id,
      winner: row.winner,
      createdAt: row.created_at,
    });
  return controlDto(row);
}

function firstAnswer(ctx: AppContext, chatId: string, requestId: string): ControlEventDto | null {
  const row = ctx.db.sql
    .query("SELECT * FROM control_actions WHERE chat_id = $chatId AND request_id = $requestId AND action = 'permission_answer' AND outcome = 'succeeded' ORDER BY created_at, rowid LIMIT 1")
    .get({ chatId, requestId }) as ControlRow | null;
  return row ? controlDto(row) : null;
}

async function firstRecordedAnswer(ctx: AppContext, chatId: string, requestId: string): Promise<ControlEventDto | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const winner = firstAnswer(ctx, chatId, requestId);
    if (winner) return winner;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  return firstAnswer(ctx, chatId, requestId);
}

// Exported for focused policy tests and future project-configurable rules.
export function authorizedForTurn(actor: string, role: Role, turnAuthor: string | null): boolean {
  return canControl(actor, role, turnAuthor);
}
