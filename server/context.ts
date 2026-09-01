/** What every handler needs: the database, the cipher, the config, and who is asking. */
import type { Config } from "./config";
import type { Cipher } from "./crypto";
import { sha256 } from "./crypto";
import { Db, type ChatRow, type Role, type UserRow } from "./db";
import { FountainClient } from "./fountain";
import { HttpError, SESSION_COOKIE, cookieValue } from "./http";

export interface AppContext {
  db: Db;
  cipher: Cipher;
  config: Config;
}

/** The signed-in user, from the session cookie. 401 otherwise. */
export async function authenticate(ctx: AppContext, req: Request): Promise<UserRow> {
  const token = cookieValue(req, SESSION_COOKIE);
  if (!token) throw new HttpError(401, "unauthenticated", "Sign in first.");
  const user = ctx.db.sessionUser(await sha256(token));
  if (!user) throw new HttpError(401, "unauthenticated", "That session has ended. Sign in again.");
  return user;
}

/** The chat and the caller's role in it. 404 for a chat the caller is not in — its existence is not theirs to learn. */
export function chatAccess(ctx: AppContext, user: UserRow, chatId: string): { chat: ChatRow; role: Role } {
  const role = ctx.db.roleIn(chatId, user.email);
  const chat = role ? ctx.db.getChat(chatId) : null;
  if (!role || !chat) throw new HttpError(404, "not_found", "No such chat.");
  return { chat, role };
}

export function requireOwner(role: Role): void {
  if (role !== "owner") throw new HttpError(403, "host_only", "Only the chat's host can do that.");
}

/** A Fountain client on the chat host's key — what the chat runs on, and who pays. */
export async function ownerClient(ctx: AppContext, chat: ChatRow): Promise<FountainClient> {
  const owner = ctx.db.getUser(chat.owner_email);
  if (!owner) throw new HttpError(409, "host_gone", "The chat's host no longer has an account here.");
  return new FountainClient(ctx.config.fountainUrl, await ctx.cipher.decrypt(owner.key_enc));
}

/** A client on the caller's own key. */
export async function userClient(ctx: AppContext, user: UserRow): Promise<FountainClient> {
  return new FountainClient(ctx.config.fountainUrl, await ctx.cipher.decrypt(user.key_enc));
}
