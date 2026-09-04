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
import type { Role } from "./db";
import { clearedSessionCookie, cookieValue, HttpError, json, readJson, SESSION_COOKIE, sessionCookie, str } from "./http";

export function config(ctx: AppContext): Response {
  return json({ fountainUrl: ctx.config.fountainUrl });
}

/** What the browser is told about itself. Never a key, never anyone else's. */
export function meDto(id: Identity, role: Role | null, paddockId: string | null): Record<string, unknown> {
  return {
    label: actorLabel(id),
    kind: id.kind,
    email: id.kind === "user" ? id.user.email : null,
    role,
    paddockId,
  };
}

export async function me(ctx: AppContext, req: Request): Promise<Response> {
  const id = await authenticate(ctx, req);
  if (id.kind === "guest") {
    return json(meDto(id, "guest", id.guest.paddock_id));
  }
  const own = ctx.db.paddockOf(id.user.email);
  return json(meDto(id, own ? "owner" : null, own?.id ?? null));
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

  ctx.db.upsertUser(email, who.id ?? null, await ctx.cipher.encrypt(apiKey));
  const token = randomToken();
  ctx.db.createUserSession(await sha256(token), email);
  ctx.db.expireSessions(ctx.config.sessionMaxAgeMs);

  const own = ctx.db.paddockOf(email);
  const id: Identity = { kind: "user", user: ctx.db.getUser(email)! };
  return json(meDto(id, own ? "owner" : null, own?.id ?? null), 200, {
    "set-cookie": sessionCookie(token, req, ctx.config.sessionMaxAgeMs / 1000),
  });
}

/**
 * Following an invite link. Deliberately does not authenticate first: the
 * whole point is that the visitor has nothing to authenticate with.
 *
 * A visitor who *is* signed in keeps their identity — being handed a link
 * should not silently downgrade the owner of the machine to a guest on it.
 */
export async function join(ctx: AppContext, req: Request, token: string): Promise<Response> {
  const paddock = ctx.db.paddockByInvite(token);
  if (!paddock) throw new HttpError(404, "bad_invite", "That invite link is not valid any more.");

  const existing = cookieValue(req, SESSION_COOKIE);
  if (existing) {
    const session = ctx.db.session(await sha256(existing));
    if (session?.email) {
      const user = ctx.db.getUser(session.email);
      if (user) {
        const role: Role = paddock.owner_email === user.email ? "owner" : "member";
        if (role === "member") ctx.db.addMember(paddock.id, user.email, `link:${paddock.owner_email}`);
        return json(meDto({ kind: "user", user }, role, paddock.id));
      }
    }
  }

  const guest = ctx.db.createGuest(randomToken(9), paddock.id, guestHandle());
  const sessionToken = randomToken();
  ctx.db.createGuestSession(await sha256(sessionToken), guest.id);
  return json(meDto({ kind: "guest", guest }, "guest", paddock.id), 200, {
    "set-cookie": sessionCookie(sessionToken, req, ctx.config.sessionMaxAgeMs / 1000),
  });
}

export async function signOut(ctx: AppContext, req: Request): Promise<Response> {
  const token = cookieValue(req, SESSION_COOKIE);
  if (token) ctx.db.deleteSession(await sha256(token));
  return json({ ok: true }, 200, { "set-cookie": clearedSessionCookie(req) });
}
