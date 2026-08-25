/**
 * Sign-in. Every user authenticates with Fountain: the browser obtains a
 * Fountain API key (OAuth + PKCE, or a pasted key) and hands it here; the
 * server asks Fountain who it belongs to (`GET /api/auth/me`), records the
 * user by that email, keeps the key (encrypted) so the user's projects can
 * run on it, and issues a session cookie.
 *
 * Signing out ends the session but keeps the key: other members' work in
 * this user's projects must not stop because the owner closed a tab. The
 * key is replaced on every sign-in, and revocable in Fountain under
 * Account → API keys.
 */
import { authenticate, userClient, type AppContext } from "./context";
import { randomToken, sha256 } from "./crypto";
import { FountainClient, FountainHttpError } from "./fountain";
import { HttpError, clearedSessionCookie, cookieValue, json, readJson, SESSION_COOKIE, sessionCookie, str } from "./http";
import { withoutMcpSecrets } from "./proxy";

export function config(ctx: AppContext): Response {
  return json({ fountainUrl: ctx.config.fountainUrl });
}

export async function me(ctx: AppContext, req: Request): Promise<Response> {
  const user = await authenticate(ctx, req);
  return json({ email: user.email, fountainUrl: ctx.config.fountainUrl, keyUpdatedAt: user.key_updated_at });
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

/**
 * The caller's own environments, vaults and agents — what a new project can be
 * made of, before the project exists to have a Fountain view of its own.
 *
 * The agents are here for the same reason the other two are: the create-project
 * form asks who new work starts with, and until the project is made there is no
 * `/f/<project>/api/agents` to ask. They go out with every MCP server's `env`
 * and `headers` blanked, exactly as the proxy sends them — the caller's own key
 * would read the values from Fountain directly, so withholding them costs
 * nothing and keeps one rule rather than one per route.
 */
export async function myResources(ctx: AppContext, req: Request): Promise<Response> {
  const user = await authenticate(ctx, req);
  const client = await userClient(ctx, user);
  const [envs, vaults, agents] = await Promise.all([client.fetch("/api/environments"), client.fetch("/api/vaults"), client.fetch("/api/agents")]);
  if (!envs.ok || !vaults.ok || !agents.ok) {
    throw new HttpError(502, "fountain_error", "Fountain would not list your environments, vaults and agents. Is your key still valid? Sign in again to refresh it.");
  }
  const e = (await envs.json()) as { data?: unknown[] };
  const v = (await vaults.json()) as { data?: unknown[] };
  const a = (await agents.json()) as { data?: unknown[] };
  return json({ data: { environments: e.data ?? [], vaults: v.data ?? [], agents: (a.data ?? []).map(withoutMcpSecrets) } });
}
