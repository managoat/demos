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
 *
 * Issue #14 added a third member to that union rather than a flag on an
 * existing one, for the same reason: the anonymous owner of an unclaimed
 * computer is neither a user nor a guest, and every place that would have had
 * to remember which it was pretending to be is a place it could be forgotten.
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

/**
 * A signed-in Fountain user, somebody who followed a link, or the anonymous
 * owner of a computer nobody has claimed yet. Exactly one of the three.
 *
 * The third is *not* a guest. A guest borrows one terminal in a machine
 * somebody else owns and pays for; a starter possesses a whole machine, on
 * this application's introductory grant, and is the only person who may claim
 * it. Folding them together would put "may claim this computer" one boolean
 * away from every invite link ever minted.
 *
 * It is not a user either, and that is the other half: `id.user.email` on
 * somebody with no account would be `undefined`, and `undefined` compares
 * unequal to every `owner_email` right up until somebody writes `!==`.
 */
export type Identity =
  | { kind: "user"; user: UserRow }
  | { kind: "guest"; guest: GuestRow }
  | { kind: "starter"; paddock: PaddockRow };

/** How an identity refers to itself in a transcript and in the People list. */
export function actorLabel(id: Identity): string {
  if (id.kind === "user") return id.user.email;
  if (id.kind === "guest") return id.guest.handle;
  // Nobody else is ever in an unclaimed computer — a starter cannot invite, and
  // cannot be invited — so this labels one person talking to their own machine.
  return "you";
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
  if (session.starter_paddock_id) {
    const paddock = ctx.db.getPaddock(session.starter_paddock_id);
    // Two dangling cases, and they are different things to be told. The
    // cleanup job deleted the row: that computer's introductory time is up.
    // The row is there but claimed: this session was superseded by the user
    // session the claim issued, and reloading lands on the signed-in one.
    if (!paddock) throw new HttpError(401, "start_expired", "That computer's free time is up. Sign in to start a new one.");
    if (paddock.claim_status !== "unclaimed") throw new HttpError(401, "unauthenticated", "That computer has been claimed. Sign in to open it.");
    return { kind: "starter", paddock };
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
   * The owner's oldest computer, and so the one that owns every tab whose
   * channel names no computer at all. Decided here, once, from the row order
   * — see `db.paddocksOf` and `tabs.belongsTo`.
   */
  original: boolean;
  /**
   * The tabs this caller may reach, or `null` for the owner, who may reach
   * every tab on their own machine.
   *
   * Invitations name a tab, not a machine — somebody invited to Terminal 2
   * gets Terminal 2 and no view of the rest of the box. Returning the allowed
   * set here, once, is what stops every later check having to remember that.
   */
  tabs: string[] | null;
  /**
   * Whether this computer has an owner yet.
   *
   * An unclaimed one is a real machine on a real tenant, and its anonymous
   * owner may use Terminal 1, read the files and claim it. Everything that
   * costs more, configures more or lets somebody else in waits for the claim —
   * see `requireClaimed`, which is what actually says no.
   */
  claimed: boolean;
}

export function paddockAccess(ctx: AppContext, id: Identity, paddockId: string): Access {
  const paddock = ctx.db.getPaddock(paddockId);
  if (!paddock) throw new HttpError(404, "not_found", "No such paddock.");
  // A property of the machine rather than of the caller, so a guest's view of
  // which tabs are on it is the same as the owner's.
  const original = ctx.db.isOriginal(paddock);

  const claimed = paddock.claim_status === "claimed";

  if (id.kind === "guest") {
    if (id.guest.paddock_id !== paddock.id) throw new HttpError(404, "not_found", "No such paddock.");
    // Exactly one, by construction: the guest row was made when they followed
    // that tab's link, so there is no lookup here to get wrong.
    return { paddock, role: "guest", original, tabs: [id.guest.conversation_id], claimed };
  }
  if (id.kind === "starter") {
    // The session names the computer, so this is an equality check and not a
    // lookup: a starter can reach the one machine they started and no other,
    // including any other unclaimed one.
    if (id.paddock.id !== paddock.id) throw new HttpError(404, "not_found", "No such paddock.");
    return { paddock, role: "owner", original, tabs: null, claimed };
  }
  if (paddock.owner_email === id.user.email) return { paddock, role: "owner", original, tabs: null, claimed };
  const tabs = ctx.db.memberTabs(paddock.id, id.user.email);
  if (tabs.length) return { paddock, role: "member", original, tabs, claimed };
  throw new HttpError(404, "not_found", "No such paddock.");
}

/**
 * What the browser is told about itself. Never a key, never anyone else's.
 *
 * Here rather than in `auth.ts` because both doors into the app answer with
 * it — signing in and starting a computer — and a shared helper in one of them
 * would make the other import its opposite.
 */
export function meDto(
  ctx: AppContext,
  id: Identity,
  role: Role | null,
  paddockId: string | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    label: actorLabel(id),
    kind: id.kind,
    email: id.kind === "user" ? id.user.email : null,
    role,
    paddockId,
    // Everywhere this person can go: the computers they own, oldest first,
    // then anything shared with them. A guest has exactly one and is told
    // nothing about it — not even its name, which is the owner's word for
    // their own machine. A starter has exactly one too, and it is theirs.
    paddocks: reachableFor(ctx, id),
    // Only ever present on a starter, and it is the whole difference between
    // "your computer" and "your computer, until Tuesday, unless you claim it".
    ...(id.kind === "starter" ? { claim: { status: "unclaimed" as const, expiresAt: id.paddock.claim_expires_at } } : {}),
    ...extra,
  };
}

function reachableFor(ctx: AppContext, id: Identity): { id: string; name: string; ownerEmail: string; role: Role; original: boolean }[] {
  if (id.kind === "user") return ctx.db.paddocksFor(id.user.email);
  if (id.kind === "starter") {
    return [{ id: id.paddock.id, name: id.paddock.name, ownerEmail: "", role: "owner", original: true }];
  }
  return [guestReachable(ctx, id.guest.paddock_id)];
}

/**
 * The one computer a guest can reach, told as little as possible about it.
 *
 * No name and no owner: they were lent one terminal, not shown around
 * somebody's account. `original` is the exception, and it is not a courtesy —
 * it decides whether a tab whose channel names no computer is on this machine
 * (`tabs.belongsTo`), so a guest of a paddock that predates computers renders
 * an empty strip without it. What it discloses is that this is the oldest row
 * on that account, which is not something anybody can act on.
 */
function guestReachable(ctx: AppContext, paddockId: string) {
  const paddock = ctx.db.getPaddock(paddockId);
  const original = !!paddock && ctx.db.isOriginal(paddock);
  return { id: paddockId, name: "", ownerEmail: "", role: "guest" as Role, original };
}

/** Owner-only routes: everything that changes the machine. */
export function requireOwner(role: Role): void {
  if (role !== "owner") {
    throw new HttpError(403, "owner_only", "Only the owner of this machine can change it.");
  }
}

/**
 * The claim gate: what an unclaimed computer is not allowed to do yet.
 *
 * A visitor who has not registered gets one terminal, the files, and the
 * button that makes the machine theirs. Everything else — a second terminal,
 * any change to what the machine is made of, inviting anybody, rebuilding it —
 * waits, because until somebody claims it this machine is running on *this
 * application's* money and under no account anyone can be held to.
 *
 * Enforced here rather than by hiding a button. The client does hide them, and
 * that is a courtesy; a hidden control is not an authorization decision.
 */
export function requireClaimed(access: Pick<Access, "claimed">, what: string): void {
  if (!access.claimed) {
    throw new HttpError(403, "claim_required", `Claim this computer to ${what}.`);
  }
}

/**
 * A Fountain client for one machine — what every tab runs on, and who pays.
 * A guest's turn goes through here and the guest never holds a key.
 *
 * The key is the *computer's* before it is the owner's, and the order matters
 * in both directions. An unclaimed computer has no owner at all and runs on
 * the credential its claimable principal was opened with. A claimed one runs
 * on the credential the claim handed back, which selects this principal out of
 * however many that Fountain account now owns — the owner's own account key
 * would reach their account's resources and not this tenant's.
 *
 * Falling back to `users.key_enc` is what keeps every computer made before
 * issue #14 working: those are ordinary machines in their owner's own tenant,
 * and their `compute_key_enc` is null.
 */
export async function ownerClient(ctx: AppContext, paddock: PaddockRow): Promise<FountainClient> {
  if (paddock.compute_key_enc) {
    return new FountainClient(ctx.config.fountainUrl, await ctx.cipher.decrypt(paddock.compute_key_enc));
  }
  const owner = paddock.owner_email ? ctx.db.getUser(paddock.owner_email) : null;
  if (!owner) throw new HttpError(409, "owner_gone", "This machine's owner no longer has an account here.");
  return new FountainClient(ctx.config.fountainUrl, await ctx.cipher.decrypt(owner.key_enc));
}
