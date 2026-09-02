/** Signed-in people's GitHub connection and the token endpoint used by a repository session. */
import type { UserRow } from "./db";
import type { AppContext } from "./context";
import { authenticate } from "./context";
import { accessibleRepos, exchangeCode, GitHubError, installationToken, refreshOAuthToken, viewer, type GitHubRepo, type OAuthToken } from "./github";
import { HttpError, json, readJson, str } from "./http";
import { sandboxCaller } from "./sandbox";

function configured(ctx: AppContext) {
  const app = ctx.config.githubApp;
  if (!app) throw new HttpError(503, "github_not_configured", "This Salon does not have a GitHub App configured yet.");
  return app;
}

export async function info(ctx: AppContext, req: Request): Promise<Response> {
  const user = await authenticate(ctx, req);
  const account = ctx.db.githubAccount(user.email);
  const app = ctx.config.githubApp;
  return json({
    data: {
      configured: !!app,
      connected: !!account,
      login: account?.login ?? null,
      clientId: app?.clientId ?? null,
      installUrl: app ? `https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new` : null,
    },
  });
}

export async function callback(ctx: AppContext, req: Request): Promise<Response> {
  const user = await authenticate(ctx, req);
  const app = configured(ctx);
  const body = await readJson(req);
  const code = str(body.code, 500).trim();
  const redirectUri = str(body.redirectUri, 1000).trim();
  if (!code) throw new HttpError(400, "github_code_missing", "GitHub returned no authorization code.");
  let redirect: URL;
  try {
    redirect = new URL(redirectUri);
  } catch {
    throw new HttpError(400, "github_redirect_bad", "The GitHub redirect address is invalid.");
  }
  const here = new URL(req.url);
  // Behind Traefik Bun sees an http request even though the browser and
  // GitHub used PUBLIC_URL's https origin. Accept the configured public
  // origin as authoritative; keep the direct request origin for local dev.
  const allowedOrigins = new Set([here.origin, ctx.config.publicUrl].filter((origin): origin is string => !!origin));
  if (!allowedOrigins.has(redirect.origin) || redirect.pathname !== "/") throw new HttpError(400, "github_redirect_bad", "The GitHub redirect address does not belong to this Salon.");
  try {
    const token = await exchangeCode(app, code, redirectUri);
    const who = await viewer(app, token.token);
    await saveToken(ctx, user, who.login, token);
    return json({ data: { login: who.login } });
  } catch (err) {
    githubProblem(err, "GitHub would not connect this account.");
  }
}

export async function repos(ctx: AppContext, req: Request): Promise<Response> {
  const user = await authenticate(ctx, req);
  try {
    return json({ data: await reposFor(ctx, user) });
  } catch (err) {
    githubProblem(err, "GitHub would not list your repositories.");
  }
}

export async function reposFor(ctx: AppContext, user: UserRow): Promise<GitHubRepo[]> {
  const app = configured(ctx);
  return accessibleRepos(app, await userToken(ctx, user));
}

/** A fresh, one-repository credential for Fountain or a running session. */
export async function repoToken(ctx: AppContext, slug: string): Promise<string> {
  try {
    return (await installationToken(configured(ctx), slug)).token;
  } catch (err) {
    githubProblem(err, `GitHub would not grant access to ${slug}.`);
  }
}

export async function sandboxToken(ctx: AppContext, req: Request): Promise<Response> {
  const caller = await sandboxCaller(ctx, req);
  const project = caller.chat.project_id ? ctx.db.getProject(caller.chat.project_id) : null;
  if (!project?.github_repo) throw new HttpError(404, "no_github_repo", "This session is not connected to a GitHub repository.");
  return json({ token: await repoToken(ctx, project.github_repo) });
}

async function userToken(ctx: AppContext, user: UserRow): Promise<string> {
  const account = ctx.db.githubAccount(user.email);
  if (!account) throw new HttpError(409, "github_not_connected", "Connect GitHub first.");
  const expires = account.expires_at ? Date.parse(account.expires_at) : Number.POSITIVE_INFINITY;
  if (expires > Date.now() + 5 * 60_000) return ctx.cipher.decrypt(account.token_enc);
  if (!account.refresh_token_enc) throw new HttpError(401, "github_connection_expired", "Your GitHub connection has expired. Connect it again.");
  try {
    const refreshed = await refreshOAuthToken(configured(ctx), await ctx.cipher.decrypt(account.refresh_token_enc));
    await saveToken(ctx, user, account.login, refreshed);
    return refreshed.token;
  } catch (err) {
    githubProblem(err, "Your GitHub connection has expired. Connect it again.");
  }
}

async function saveToken(ctx: AppContext, user: UserRow, login: string, value: OAuthToken): Promise<void> {
  const t = Date.now();
  ctx.db.putGitHubAccount({
    email: user.email,
    login,
    token_enc: await ctx.cipher.encrypt(value.token),
    refresh_token_enc: value.refreshToken ? await ctx.cipher.encrypt(value.refreshToken) : null,
    expires_at: value.expiresIn ? new Date(t + value.expiresIn * 1000).toISOString() : null,
    refresh_expires_at: value.refreshTokenExpiresIn ? new Date(t + value.refreshTokenExpiresIn * 1000).toISOString() : null,
    updated_at: new Date(t).toISOString(),
  });
}

function githubProblem(err: unknown, fallback: string): never {
  if (err instanceof HttpError) throw err;
  if (err instanceof GitHubError) {
    if (err.status === 401 || err.status === 403) throw new HttpError(401, "github_connection_expired", fallback);
    if (err.status === 404) throw new HttpError(404, "github_repo_unavailable", err.message);
    if (err.status === 422) throw new HttpError(422, "bad_github_repo", err.message);
    throw new HttpError(502, "github_unreachable", `${fallback} ${err.message}`);
  }
  throw err;
}
