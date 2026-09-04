/**
 * Who is asking, and what they may do.
 *
 * This is the file salon's equivalent is *not* copied from. Salon's
 * `authenticate` returns a `UserRow`, because every caller there has a
 * Fountain account. Paddock admits people with no account at all, and a
 * function that returned something user-shaped for both would let a caller
 * write `user.email` on an anonymous guest and get `null` — which compares
 * equal to a paddock's `owner_email` in exactly no cases, until the day
 * somebody writes `!==` and inverts it.
 *
 * So identity is a discriminated union and the role is computed from it once,
 * here. Everything downstream takes a `Role` and never re-derives it.
 */
import type { Config } from "./config";
import type { Cipher } from "./crypto";
import { sha256 } from "./crypto";
import type { Db, GuestRow, PaddockRow, Role, UserRow } from "./db";
import { FountainClient } from "./fountain";
import { HttpError, SESSION_COOKIE, cookieValue } from "./http";

export interface AppContext {
  db: Db;
  cipher: Cipher;
  config: Config;
}

/** A signed-in Fountain user, or somebody who followed a link. Never both. */
export type Identity =
  | { kind: "user"; user: UserRow }
  | { kind: "guest"; guest: GuestRow };

/** How an identity refers to itself in a transcript and in the People list. */
export function actorLabel(id: Identity): string {
  return id.kind === "user" ? id.user.email : id.guest.handle;
}

/** The session's identity. 401 when there is none. */
export async function authenticate(ctx: AppContext, req: Request): Promise<Identity> {
  const token = cookieValue(req, SESSION_COOKIE);
  if (!token) throw new HttpError(401, "unauthenticated", "Sign in, or open an invite link.");
  const session = ctx.db.session(await sha256(token));
  if (!session) throw new HttpError(401, "unauthenticated", "That session has ended.");

  if (session.email) {
    const user = ctx.db.getUser(session.email);
    if (!user) throw new HttpError(401, "unauthenticated", "That account is gone.");
    return { kind: "user", user };
  }
  if (session.guest_id) {
    const guest = ctx.db.getGuest(session.guest_id);
    // A guest row deleted by a re-mint: the link they came in on is dead, and
    // so is this session. Say so rather than 500ing on a dangling id.
    if (!guest) throw new HttpError(401, "invite_revoked", "That invite link was replaced. Ask for a new one.");
    ctx.db.touchGuest(guest.id);
    return { kind: "guest", guest };
  }
  throw new HttpError(401, "unauthenticated", "That session is not usable.");
}

/**
 * The paddock this identity may reach, and in what role. 404 for one they are
 * not in — its existence is not theirs to learn.
 *
 * A guest is bound to one paddock by construction: the row was created when
 * they followed that paddock's link, so there is no lookup to get wrong.
 */
export interface Access {
  paddock: PaddockRow;
  role: Role;
  /**
   * The tabs this caller may reach, or `null` for the owner, who may reach
   * every tab on their own machine.
   *
   * Invitations name a tab, not a machine — somebody invited to Terminal 2
   * gets Terminal 2 and no view of the rest of the box. Returning the allowed
   * set here, once, is what stops every later check having to remember that.
   */
  tabs: string[] | null;
}

export function paddockAccess(ctx: AppContext, id: Identity, paddockId: string): Access {
  const paddock = ctx.db.getPaddock(paddockId);
  if (!paddock) throw new HttpError(404, "not_found", "No such paddock.");

  if (id.kind === "guest") {
    if (id.guest.paddock_id !== paddock.id) throw new HttpError(404, "not_found", "No such paddock.");
    // Exactly one, by construction: the guest row was made when they followed
    // that tab's link, so there is no lookup here to get wrong.
    return { paddock, role: "guest", tabs: [id.guest.conversation_id] };
  }
  if (paddock.owner_email === id.user.email) return { paddock, role: "owner", tabs: null };
  const tabs = ctx.db.memberTabs(paddock.id, id.user.email);
  if (tabs.length) return { paddock, role: "member", tabs };
  throw new HttpError(404, "not_found", "No such paddock.");
}

/** Owner-only routes: everything that changes the machine. */
export function requireOwner(role: Role): void {
  if (role !== "owner") {
    throw new HttpError(403, "owner_only", "Only the owner of this machine can change it.");
  }
}

/**
 * A Fountain client on the machine owner's key — what every tab runs on, and
 * who pays. A guest's turn goes through here and the guest never holds a key.
 */
export async function ownerClient(ctx: AppContext, paddock: PaddockRow): Promise<FountainClient> {
  const owner = ctx.db.getUser(paddock.owner_email);
  if (!owner) throw new HttpError(409, "owner_gone", "This machine's owner no longer has an account here.");
  return new FountainClient(ctx.config.fountainUrl, await ctx.cipher.decrypt(owner.key_enc));
}
