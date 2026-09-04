/**
 * Signing in, which here is two round trips to GitHub rather than one.
 *
 * **Authorize** gets an identity: who you are, and a token that speaks as you.
 * **Install** gets access: which repositories drydock may see. They are
 * separate on purpose and in that order, because the second one is a decision
 * a person makes about their code and it should be made by somebody the app
 * can already name.
 *
 * A person can be signed in with no installation. That is not a broken state
 * and the UI does not treat it as one — it is the state everybody is in for
 * the ten seconds between the two, and the state anybody who declines stays
 * in. `Viewer.hasInstallation` is how the shell knows which of the two home
 * screens to render.
 */
import { randomToken, sha256 } from "./crypto";
import type { AppContext } from "./context";
import { authenticate, requireGitHub, userToken } from "./context";
import { GitHubError, asHttpError } from "./github";
import type { Capabilities, SessionInfo, Viewer } from "../shared/api";
import { SESSION_COOKIE, clearedSessionCookie, cookieValue, json, sessionCookie } from "./http";

/** Where GitHub sends a browser back to. Registered on the App; must match exactly. */
export function callbackUrl(ctx: AppContext): string {
  return `${ctx.config.publicUrl}/api/auth/callback`;
}

/**
 * `GET /api/session` — everything the shell needs before its first render.
 *
 * One call rather than three (who am I, may I sign in, what works here)
 * because the answer to all three changes together and a shell that renders
 * from two of them has a frame where it disagrees with itself.
 */
export async function session(ctx: AppContext, req: Request): Promise<Response> {
  const capabilities: Capabilities = {
    exec: !!ctx.sprites,
    github: !!ctx.github,
    fountain: !!ctx.fountain,
    models: await models(ctx),
  };
  const gh = ctx.github;
  const state = randomToken(18);
  if (gh) ctx.db.putState(state, "signin", null);

  const info: SessionInfo = {
    viewer: await viewerOf(ctx, req),
    signInUrl: gh ? gh.authorizeUrl(callbackUrl(ctx), state) : "",
    installUrl: gh ? gh.installUrl() : "",
    capabilities,
  };
  return json({ data: info });
}

async function viewerOf(ctx: AppContext, req: Request): Promise<Viewer | null> {
  const token = cookieValue(req, SESSION_COOKIE);
  if (!token) return null;
  const user = ctx.db.sessionUser(await sha256(token));
  if (!user) return null;

  // Asked live rather than stored, because it is a fact about GitHub that
  // changes without telling us: somebody installs the App in another tab, or
  // an admin removes it. A cached `true` here is a repository picker that
  // renders empty with no explanation.
  let hasInstallation = false;
  if (ctx.github && user.tokenEnc) {
    try {
      const list = await ctx.github.installationsFor(await ctx.cipher.decrypt(user.tokenEnc));
      hasInstallation = list.length > 0;
    } catch {
      // A revoked or expired user token. Not fatal to the session: the shell
      // shows the install prompt, and the first real call re-authenticates.
      hasInstallation = false;
    }
  }

  return {
    id: user.githubId,
    login: user.login,
    name: user.name,
    avatarUrl: user.avatarUrl,
    hasInstallation,
  };
}

/**
 * `GET /api/auth/callback` — GitHub coming back, from either round trip.
 *
 * Both land here. The sign-in flow arrives with `code` and our `state`; the
 * installation flow arrives with `installation_id` and `setup_action` and,
 * because the App's setup URL is this same path, sometimes with a `code` as
 * well. Handling them in one place is what makes "install, then sign in" and
 * "sign in, then install" both end at the same screen.
 *
 * The response is a redirect rather than JSON: this URL is opened by a browser
 * following GitHub, not by the SPA's fetch.
 */
export async function callback(ctx: AppContext, req: Request): Promise<Response> {
  const gh = requireGitHub(ctx);
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const installationId = url.searchParams.get("installation_id");

  // An installation with no code: the person was already signed in and just
  // granted repository access. Nothing to exchange — send them back in.
  if (!code) {
    return redirect(installationId ? "/?installed=1" : "/?error=github_declined");
  }

  // The state is one-use. A replayed callback finds nothing and is refused,
  // which is the entire defence against a login CSRF here.
  if (!state || !ctx.db.takeState(state)) {
    return redirect("/?error=stale_signin");
  }

  let token: string;
  let profile: { id: number; login: string; name: string | null; avatar_url: string };
  try {
    token = await gh.exchangeCode(code, callbackUrl(ctx));
    profile = await gh.viewer(token);
  } catch (err) {
    if (err instanceof GitHubError) return redirect(`/?error=${encodeURIComponent("github_" + err.status)}`);
    throw asHttpError(err, "sign you in");
  }

  const user = ctx.db.upsertUser({
    githubId: String(profile.id),
    login: profile.login,
    name: profile.name,
    avatarUrl: profile.avatar_url,
    tokenEnc: await ctx.cipher.encrypt(token),
  });

  const sessionToken = randomToken();
  ctx.db.createSession(user.id, await sha256(sessionToken), ctx.config.sessionMaxAgeMs);
  return redirect(installationId ? "/?installed=1" : "/", {
    "set-cookie": sessionCookie(sessionToken, req, Math.floor(ctx.config.sessionMaxAgeMs / 1000)),
  });
}

/**
 * `GET /api/auth/install` — a signed-in person going to grant repository
 * access, with a state so the return trip is recognisable.
 *
 * A redirect rather than a link the SPA builds, because the state has to be
 * minted server-side and handing the browser a URL it did not ask for is how
 * an installation ends up attributed to the wrong account.
 */
export async function install(ctx: AppContext, req: Request): Promise<Response> {
  const gh = requireGitHub(ctx);
  await authenticate(ctx, req);
  const state = randomToken(18);
  ctx.db.putState(state, "install", null);
  return redirect(gh.installUrl(state));
}

export async function signOut(ctx: AppContext, req: Request): Promise<Response> {
  const token = cookieValue(req, SESSION_COOKIE);
  if (token) ctx.db.endSession(await sha256(token));
  return json({ data: { ok: true } }, 200, { "set-cookie": clearedSessionCookie(req) });
}

/**
 * `GET /api/github/installations` — the accounts this person has installed
 * the App on, so a repository picker can say whose repositories it is showing
 * and offer to add another.
 */
export async function installations(ctx: AppContext, req: Request): Promise<Response> {
  const gh = requireGitHub(ctx);
  const user = await authenticate(ctx, req);
  try {
    return json({ data: await gh.installationsFor(await userToken(ctx, user)) });
  } catch (err) {
    throw asHttpError(err, "list your installations");
  }
}

/**
 * `POST /api/github/webhook` — GitHub telling us an installation changed.
 *
 * Deliberately thin, and **switched off on the registration**. Nothing in
 * drydock is derived from a webhook: which repositories a person can see is
 * asked live on every render, because that is a fact about GitHub which changes
 * without telling us, and a cached `true` here is a picker that renders empty
 * with no explanation. So the App has no hook URL and this deployment has no
 * `GITHUB_WEBHOOK_SECRET` — one fewer secret in the envelope, for a feature
 * nothing reads.
 *
 * The route stays because turning the hook back on should be a change to the
 * App's settings rather than a change to this file, and because the two events
 * below are worth a log line the day somebody wonders why their repository list
 * shrank. Without a secret configured it refuses everything, which is the
 * correct behaviour for an endpoint that is not in use.
 *
 * Unsigned requests are refused rather than ignored. An endpoint that accepts
 * anything and does nothing is one refactor away from an endpoint that accepts
 * anything and does something.
 */
export async function webhook(ctx: AppContext, req: Request): Promise<Response> {
  const secret = ctx.config.github?.webhookSecret;
  if (!secret) return json({ error: "no_webhook", message: "This drydock has no webhook secret configured." }, 503);

  const signature = req.headers.get("x-hub-signature-256") ?? "";
  const body = await req.text();
  if (!(await validSignature(secret, body, signature))) {
    return json({ error: "bad_signature", message: "That signature does not match." }, 401);
  }

  const event = req.headers.get("x-github-event") ?? "";
  if (event === "installation" || event === "installation_repositories") {
    const parsed = JSON.parse(body) as { action?: string; installation?: { id?: number; account?: { login?: string } } };
    console.log(
      `drydock: github ${event} ${parsed.action ?? "?"} for ${parsed.installation?.account?.login ?? "?"} (${parsed.installation?.id ?? "?"})`,
    );
  }
  return json({ data: { ok: true } });
}

/**
 * HMAC-SHA256, compared in constant time.
 *
 * `crypto.subtle.verify` does the comparison itself and does it correctly,
 * which is the reason to use it rather than hashing and comparing strings —
 * an early-exit `===` on a signature leaks how much of it was right.
 */
async function validSignature(secret: string, body: string, header: string): Promise<boolean> {
  const [scheme, hex] = header.split("=");
  if (scheme !== "sha256" || !hex || hex.length !== 64 || !/^[0-9a-f]+$/.test(hex)) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "verify",
  ]);
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return await crypto.subtle.verify("HMAC", key, bytes, new TextEncoder().encode(body));
}

/**
 * The models this Fountain suggests, for the composer's picker.
 *
 * Suggestions rather than an allowlist — Fountain accepts any
 * `provider/model` under a known provider — so a failure here is a picker with
 * one entry rather than an error. Read once and cached for the process: a
 * Fountain that offers Opus at boot offers it at midnight.
 */
let cachedModels: string[] | null = null;
async function models(ctx: AppContext): Promise<string[]> {
  if (cachedModels) return cachedModels;
  if (!ctx.fountain) return [];
  try {
    const catalog = await ctx.fountain.catalog();
    const all = Object.values(catalog.models ?? {}).flat();
    cachedModels = [...new Set(all)].slice(0, 40);
  } catch {
    cachedModels = [];
  }
  return cachedModels;
}

function redirect(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: { location, ...headers } });
}
