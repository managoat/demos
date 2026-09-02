/**
 * Salon's GitHub App boundary. The App's private key and OAuth client secret
 * stay in this process. A person's OAuth token is encrypted in SQLite and is
 * used only to list the intersection of repositories they can push to and
 * repositories where the App is installed. Computers receive short-lived
 * installation tokens scoped to one repository.
 */
import crypto from "node:crypto";

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  clientId: string;
  clientSecret: string;
  slug: string;
  /** Test seams; production leaves these unset. */
  api?: string;
  oauthHost?: string;
}

export interface GitHubRepo {
  slug: string;
  private: boolean;
  archived: boolean;
  defaultBranch: string;
  description: string | null;
  pushedAt: string | null;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

const API = "https://api.github.com";

export function normalizePrivateKey(raw: string | undefined): string | null {
  if (!raw) return null;
  const key = raw.includes("\\n") && !raw.includes("\n") ? raw.replace(/\\n/g, "\n") : raw;
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(key) ? `${key.trim()}\n` : null;
}

export function appJwt(appId: string, privateKey: string, at = Math.floor(Date.now() / 1000)): string {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = b64({ alg: "RS256", typ: "JWT" });
  const payload = b64({ iat: at - 60, exp: at + 540, iss: String(appId) });
  const unsigned = `${header}.${payload}`;
  const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(privateKey).toString("base64url");
  return `${unsigned}.${signature}`;
}

async function gh<T>(cfg: GitHubAppConfig, path: string, token: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${cfg.api ?? API}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "salon",
      "x-github-api-version": "2022-11-28",
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 240) || `GitHub returned HTTP ${res.status}`;
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? message;
    } catch {
      // The short response above is the useful detail.
    }
    throw new GitHubError(message, res.status);
  }
  return (text ? JSON.parse(text) : null) as T;
}

export interface OAuthToken {
  token: string;
  expiresIn: number | null;
  refreshToken: string | null;
  refreshTokenExpiresIn: number | null;
}

export async function exchangeCode(cfg: GitHubAppConfig, code: string, redirectUri: string): Promise<OAuthToken> {
  return oauthToken(cfg, {
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code,
    redirect_uri: redirectUri,
  });
}

export async function refreshOAuthToken(cfg: GitHubAppConfig, refreshToken: string): Promise<OAuthToken> {
  return oauthToken(cfg, {
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

async function oauthToken(cfg: GitHubAppConfig, body: Record<string, string>): Promise<OAuthToken> {
  const res = await fetch(`${cfg.oauthHost ?? "https://github.com"}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    refresh_token_expires_in?: number;
    error_description?: string;
    error?: string;
  };
  if (!res.ok || !value.access_token) throw new GitHubError(value.error_description ?? value.error ?? "GitHub refused the connection.", 400);
  return {
    token: value.access_token,
    expiresIn: value.expires_in ?? null,
    refreshToken: value.refresh_token ?? null,
    refreshTokenExpiresIn: value.refresh_token_expires_in ?? null,
  };
}

export async function viewer(cfg: GitHubAppConfig, token: string): Promise<{ login: string }> {
  return gh<{ login: string }>(cfg, "/user", token);
}

/** Repositories both the person and one of this App's installations can reach. */
export async function accessibleRepos(cfg: GitHubAppConfig, token: string): Promise<GitHubRepo[]> {
  const installs = await gh<{ installations?: { id: number }[] }>(cfg, "/user/installations?per_page=100", token);
  const seen = new Set<string>();
  const out: GitHubRepo[] = [];
  for (const installation of installs.installations ?? []) {
    for (let page = 1; page <= 5; page++) {
      const body = await gh<{ repositories?: RawRepo[] }>(cfg, `/user/installations/${installation.id}/repositories?per_page=100&page=${page}`, token);
      const repos = body.repositories ?? [];
      for (const repo of repos) {
        const slug = repo.full_name ?? "";
        if (!slug || seen.has(slug) || repo.permissions?.push !== true) continue;
        seen.add(slug);
        out.push({
          slug,
          private: repo.private === true,
          archived: repo.archived === true,
          defaultBranch: repo.default_branch || "main",
          description: typeof repo.description === "string" ? repo.description : null,
          pushedAt: typeof repo.pushed_at === "string" ? repo.pushed_at : null,
        });
      }
      if (repos.length < 100) break;
    }
  }
  return out.sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? "") || a.slug.localeCompare(b.slug));
}

interface RawRepo {
  full_name?: string;
  private?: boolean;
  archived?: boolean;
  default_branch?: string;
  description?: string | null;
  pushed_at?: string | null;
  permissions?: { push?: boolean };
}

/** A one-hour token narrowed to one repository and only the operations a coding session needs. */
export async function installationToken(cfg: GitHubAppConfig, slug: string): Promise<{ token: string; expiresAt: string }> {
  const parts = slug.split("/");
  if (parts.length !== 2 || parts.some((p) => !/^[A-Za-z0-9_.-]+$/.test(p))) throw new GitHubError("That is not a GitHub repository.", 422);
  const [owner, repo] = parts as [string, string];
  const jwt = appJwt(cfg.appId, cfg.privateKey);
  let installation: { id: number };
  try {
    installation = await gh<{ id: number }>(cfg, `/repos/${owner}/${repo}/installation`, jwt);
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) throw new GitHubError(`The Salon GitHub App is not installed on ${slug}.`, 404);
    throw err;
  }
  const answer = await gh<{ token: string; expires_at: string }>(cfg, `/app/installations/${installation.id}/access_tokens`, jwt, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repositories: [repo], owner, permissions: { contents: "write", metadata: "read", pull_requests: "write", workflows: "write" } }),
  });
  if (!answer.token) throw new GitHubError("GitHub returned no installation token.", 502);
  return { token: answer.token, expiresAt: answer.expires_at };
}
