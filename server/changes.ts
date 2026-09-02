/**
 * Changes: what the chat's computer has done to the repository, kept here
 * and shown beside the transcript to everyone in the chat.
 *
 *   POST /hooks/changes                 a snapshot, from the hook inside the computer (server/sandbox.ts)
 *   GET  /api/chats/:id/changes         the latest record, with its diff
 *   GET  /api/chats/:id/changes/history the records before it, without their diffs
 *
 *   POST /api/chats/:id/changes/refresh a snapshot the server reads itself, through Fountain (server/files.ts)
 *
 * `record` is the one way in. The hook is one caller; `files.ts#refresh`,
 * which reads the computer through Fountain's sandbox routes on every
 * runtime, is the other — same table, same stream, same panel. The server
 * keeps the last twenty snapshots per chat: enough to see a turn's before
 * and after, not a history of the branch — that is git's.
 */
import { DIFF_MAX_CHARS, parseSnapshot, summarise, type ChangesDto, type ChangesSnapshot } from "../shared/changes";
import { authenticate, chatAccess, type AppContext } from "./context";
import { now, type ChangesRow, type ChatRow } from "./db";
import { hub } from "./hub";
import { HttpError, json, readJson } from "./http";
import { sandboxCaller } from "./sandbox";

export const KEEP = 20;

export function toDto(r: ChangesRow, withDiff = true): ChangesDto {
  return {
    chatId: r.chat_id,
    seq: r.seq,
    branch: r.branch,
    head: r.head,
    base: r.base,
    status: r.status,
    files: JSON.parse(r.files) as ChangesDto["files"],
    diff: withDiff ? r.diff : "",
    truncated: r.truncated === 1,
    pr: r.pr ? (JSON.parse(r.pr) as ChangesDto["pr"]) : null,
    ahead: r.ahead,
    source: r.source as ChangesDto["source"],
    reason: r.reason as ChangesDto["reason"],
    at: r.at,
  };
}

/** Keep a snapshot, prune the old ones, and tell every browser in the chat. */
export function record(ctx: AppContext, chat: ChatRow, snap: ChangesSnapshot, source: ChangesDto["source"]): ChangesDto {
  const truncated = snap.truncated === true || snap.diff.length > DIFF_MAX_CHARS;
  const diff = truncated ? snap.diff.slice(0, DIFF_MAX_CHARS) : snap.diff;
  const row = ctx.db.insertChanges({
    chat_id: chat.id,
    branch: snap.branch,
    head: snap.head,
    base: snap.base,
    status: snap.status,
    files: JSON.stringify(summarise(diff)),
    diff,
    truncated: truncated ? 1 : 0,
    pr: snap.pr ? JSON.stringify(snap.pr) : null,
    ahead: snap.ahead,
    source,
    reason: snap.reason,
    at: now(),
  });
  ctx.db.pruneChanges(chat.id, KEEP);
  const dto = toDto(row);
  hub.publish(chat.id, "changes", toDto(row, false));
  return dto;
}

// ── the routes ───────────────────────────────────────────────────────────

/** The hook's POST: the conversation's own key and id name the chat. */
export async function hook(ctx: AppContext, req: Request): Promise<Response> {
  if (req.method.toUpperCase() !== "POST") throw new HttpError(405, "method_not_allowed", "The changes hook takes a POST.");
  const caller = await sandboxCaller(ctx, req);
  const snap = parseSnapshot(await readJson(req));
  if (typeof snap === "string") throw new HttpError(422, "bad_snapshot", snap);
  const dto = record(ctx, caller.chat, snap, "hook");
  return json({ data: { seq: dto.seq, files: dto.files.length, truncated: dto.truncated } }, 201);
}

export async function latest(ctx: AppContext, req: Request, chatId: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { chat } = chatAccess(ctx, user, chatId);
  const row = ctx.db.latestChanges(chat.id);
  return json({ data: row ? toDto(row) : null });
}

export async function history(ctx: AppContext, req: Request, chatId: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { chat } = chatAccess(ctx, user, chatId);
  return json({ data: ctx.db.changesHistory(chat.id).map((r) => toDto(r, false)) });
}
