/**
 * Getting in. Two doors, and they are not the same door.
 *
 *   POST /api/auth/session   a Fountain key (from OAuth+PKCE or pasted) is
 *                            posted here; the server asks Fountain whose it
 *                            is, records the user by that email, keeps the key
 *                            encrypted so their machine's tabs can run on it,
 *                            and issues a session cookie.
 *
 *   POST /api/join/:token    no key, no account, no sign-in. The invite token
 *                            names a paddock; the server mints a guest row and
 *                            a session for it. This is the "let a user in
 *                            without paying" door, and the cost of it is that
 *                            the owner pays for everything the guest does.
 *
 * Signing out ends the session but keeps the key, for the same reason salon
 * does: a guest's turn on a machine you own must not fail because you closed
 * a tab. The key is replaced on every sign-in and revocable in Fountain.
 */
import { actorLabel, authenticate, type AppContext, type Identity } from "./context";
import { guestHandle, randomToken, sha256 } from "./crypto";
import { FountainClient, FountainHttpError } from "./fountain";
import type { PaddockRow, Role } from "./db";
import { clearedSessionCookie, cookieValue, HttpError, json, readJson, SESSION_COOKIE, sessionCookie, str } from "./http";

export function config(ctx: AppContext): Response {
  return json({ fountainUrl: ctx.config.fountainUrl });
}

/** What the browser is told about itself. Never a key, never anyone else's. */
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
    // Everywhere this person can go. A guest has exactly one; somebody who
    // used to be a guest has two, which is the whole point of upgrading.
    paddocks: id.kind === "user" ? ctx.db.paddocksFor(id.user.email) : [{ id: id.guest.paddock_id, ownerEmail: "", role: "guest" }],
    ...extra,
  };
}

/**
 * The machine that belongs to this account, made if it is not there yet.
 *
 * An account *is* a Fountain account — you cannot sign in here without a key —
 * so everybody who gets this far is entitled to a machine of their own, and
 * the row for it costs nothing: no agent, no sandbox, nothing on Fountain
 * until somebody opens it. Leaving it to the browser to ask for one meant
 * anybody who arrived through an invite link never got theirs, because the
 * app only claimed a machine when it had nowhere at all to land.
 */
export function ownPaddock(ctx: AppContext, email: string): PaddockRow {
  return ctx.db.ensurePaddock(randomToken(9), email);
}

export async function me(ctx: AppContext, req: Request): Promise<Response> {
  const id = await authenticate(ctx, req);
  if (id.kind === "guest") return json(meDto(ctx, id, "guest", id.guest.paddock_id));
  const own = ownPaddock(ctx, id.user.email);
  return json(meDto(ctx, id, "owner", own.id));
}

export async function signIn(ctx: AppContext, req: Request): Promise<Response> {
  const body = await readJson(req);
  const apiKey = str(body.apiKey, 2000).trim();
  if (!apiKey) throw new HttpError(400, "missing_key", "A Fountain API key is required.");

  let who: { id: string; email: string };
  try {
    who = await new FountainClient(ctx.config.fountainUrl, apiKey).me();
  } catch (err) {
    if (err instanceof FountainHttpError && (err.status === 401 || err.status === 403)) {
      throw new HttpError(401, "bad_key", "Fountain rejected that key.");
    }
    throw new HttpError(502, "fountain_unreachable", `Could not reach ${ctx.config.fountainUrl} to verify the key.`);
  }
  const email = who.email.trim().toLowerCase();
  if (!email) throw new HttpError(502, "no_email", "Fountain did not say who the key belongs to.");

  // Who is signing in *from* — a guest upgrading keeps their seat.
  const previous = await currentGuest(ctx, req);

  ctx.db.upsertUser(email, who.id ?? null, await ctx.cipher.encrypt(apiKey));

  /**
   * The upgrade. A guest is anonymous, tied to one terminal, and evicted the
   * moment that link is re-minted; signing in turns that into a real
   * membership of the same terminal — durable, named, and theirs on any
   * device. The guest row goes, because keeping both would leave them in the
   * room twice under two names.
   *
   * Deliberately silent about which account: whoever holds the link is who
   * gets promoted, and that is already the deal the link makes.
   */
  let upgraded: { paddockId: string; conversationId: string; from: string } | null = null;
  if (previous && ctx.db.getPaddock(previous.paddock_id)?.owner_email !== email) {
    ctx.db.addMember(previous.paddock_id, previous.conversation_id, email, `upgraded:${previous.handle}`);
    upgraded = { paddockId: previous.paddock_id, conversationId: previous.conversation_id, from: previous.handle };
  }
  if (previous) ctx.db.deleteGuest(previous.id);

  const token = randomToken();
  ctx.db.createUserSession(await sha256(token), email);
  ctx.db.expireSessions(ctx.config.sessionMaxAgeMs);

  const own = ownPaddock(ctx, email);
  const id: Identity = { kind: "user", user: ctx.db.getUser(email)! };
  // Land where they were, if they were somewhere. Signing in to keep a seat
  // and then being dropped somewhere else is not keeping it.
  const landing = upgraded?.paddockId ?? own.id;
  const role: Role = own.id === landing ? "owner" : "member";
  return json(meDto(ctx, id, role, landing, upgraded ? { upgradedFrom: upgraded.from } : {}), 200, {
    "set-cookie": sessionCookie(token, req, ctx.config.sessionMaxAgeMs / 1000),
  });
}

/** The guest this request is currently, if it is one. */
async function currentGuest(ctx: AppContext, req: Request) {
  const token = cookieValue(req, SESSION_COOKIE);
  if (!token) return null;
  const session = ctx.db.session(await sha256(token));
  return session?.guest_id ? ctx.db.getGuest(session.guest_id) : null;
}

/**
 * Following an invite link. Deliberately does not authenticate first: the
 * whole point is that the visitor has nothing to authenticate with.
 *
 * A visitor who *is* signed in keeps their identity — being handed a link
 * should not silently downgrade the owner of the machine to a guest on it.
 */
export async function join(ctx: AppContext, req: Request, token: string): Promise<Response> {
  // A link names one tab. Whoever follows it gets that tab and nothing else
  // on the machine — see `paddockAccess`.
  const invite = ctx.db.invite(token);
  const paddock = invite ? ctx.db.getPaddock(invite.paddock_id) : null;
  if (!invite || !paddock) throw new HttpError(404, "bad_invite", "That invite link is not valid any more.");

  const existing = cookieValue(req, SESSION_COOKIE);
  if (existing) {
    const session = ctx.db.session(await sha256(existing));
    if (session?.email) {
      const user = ctx.db.getUser(session.email);
      if (user) {
        // Their own machine still belongs in the list they are handed back,
        // even though the link lands them on somebody else's.
        ownPaddock(ctx, user.email);
        const role: Role = paddock.owner_email === user.email ? "owner" : "member";
        if (role === "member") ctx.db.addMember(paddock.id, invite.conversation_id, user.email, `link:${paddock.owner_email}`);
        return json(meDto(ctx, { kind: "user", user }, role, paddock.id));
      }
    }
  }

  const guest = ctx.db.createGuest(randomToken(9), paddock.id, invite.conversation_id, guestHandle());
  const sessionToken = randomToken();
  ctx.db.createGuestSession(await sha256(sessionToken), guest.id);
  return json(meDto(ctx, { kind: "guest", guest }, "guest", paddock.id), 200, {
    "set-cookie": sessionCookie(sessionToken, req, ctx.config.sessionMaxAgeMs / 1000),
  });
}

export async function signOut(ctx: AppContext, req: Request): Promise<Response> {
  const token = cookieValue(req, SESSION_COOKIE);
  if (token) ctx.db.deleteSession(await sha256(token));
  return json({ ok: true }, 200, { "set-cookie": clearedSessionCookie(req) });
}
