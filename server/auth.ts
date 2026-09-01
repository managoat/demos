/**
 * Sign-in. Every user authenticates with Fountain: the browser obtains a
 * Fountain API key (OAuth + PKCE, or a pasted key) and hands it here; the
 * server asks Fountain who it belongs to (`GET /api/auth/me`), records the
 * user by that email, keeps the key (encrypted) so the chats they host can
 * run on it, and issues a session cookie.
 *
 * Signing out ends the session but keeps the key: a guest's turn in a chat
 * you host must not fail because you closed a tab. The key is replaced on
 * every sign-in, and revocable in Fountain under Account → API keys.
 */
import { authenticate, type AppContext } from "./context";
import { randomToken, sha256 } from "./crypto";
import { FountainClient, FountainHttpError } from "./fountain";
import { HttpError, clearedSessionCookie, cookieValue, json, readJson, SESSION_COOKIE, sessionCookie, str } from "./http";

export function config(ctx: AppContext): Response {
  return json({ fountainUrl: ctx.config.fountainUrl });
}

export async function me(ctx: AppContext, req: Request): Promise<Response> {
  const user = await authenticate(ctx, req);
  return json({ email: user.email, fountainUrl: ctx.config.fountainUrl });
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
  ctx.db.createSession(await sha256(token), email);
  ctx.db.expireSessions(ctx.config.sessionMaxAgeMs);
  return json({ email, fountainUrl: ctx.config.fountainUrl }, 200, { "set-cookie": sessionCookie(token, req, ctx.config.sessionMaxAgeMs / 1000) });
}

export async function signOut(ctx: AppContext, req: Request): Promise<Response> {
  const token = cookieValue(req, SESSION_COOKIE);
  if (token) ctx.db.deleteSession(await sha256(token));
  return json({ ok: true }, 200, { "set-cookie": clearedSessionCookie(req) });
}
