/**
 * The GitHub App, server-side.
 *
 * This is the only place the App's private key and OAuth client secret exist.
 * Neither is ever sent to a browser or to a sandbox — the whole reason this
 * process exists is that a private key mints installation tokens for *every*
 * installation of the App, which is a far broader credential than anything it
 * hands out.
 *
 * What it hands out instead:
 *   - a **user token**, from "Sign in with GitHub", which acts as the person
 *     and can only touch what they can touch;
 *   - a **read-only installation token**, scoped to one repository and good
 *     for an hour, which is all an unattended agent ever gets.
 *
 * Nothing hands out a token that can write. The write token is minted inside
 * this process, used for one proposal, and dropped — because the agent that
 * would otherwise carry it spends the round reading untrusted repository
 * content, and a prompt injection that reaches a write credential is the one
 * failure this design exists to make impossible.
 */
import crypto from "node:crypto";

export interface AppConfig {
  appId: string;
  privateKey: string;
  clientId: string;
  clientSecret: string;
}

const API = "https://api.github.com";

/** A signed app JWT, valid for ten minutes — GitHub's maximum. */
export function appJwt(appId: string, privateKey: string, now = Math.floor(Date.now() / 1000)): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const header = b64({ alg: "RS256", typ: "JWT" });
  // iat is backdated a minute to survive clock skew between us and GitHub.
  const payload = b64({ iat: now - 60, exp: now + 540, iss: String(appId) });
  const signature = crypto.createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

/**
 * A private key pasted through a form or squeezed into an env var often
 * arrives with literal "\n". That fails deep inside OpenSSL with an opaque
 * message, so repair it here where the error can be clear.
 */
export function normalizeKey(raw: string | undefined): string | null {
  if (!raw) return null;
  const key = raw.includes("\\n") && !raw.includes("\n") ? raw.replace(/\\n/g, "\n") : raw;
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(key) ? key.trim() + "\n" : null;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function gh<T>(url: string, token: string, init: RequestInit = {}, fetchImpl = fetch): Promise<T> {
  const res = await fetchImpl(url, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "rounds-doorman",
      "x-github-api-version": "2022-11-28",
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });
  const body = await res.text();
  if (!res.ok) {
    let detail = body.slice(0, 200);
    try {
      detail = (JSON.parse(body) as { message?: string }).message ?? detail;
    } catch {
      // keep the raw body
    }
    throw new GitHubError(detail, res.status);
  }
  return (body ? JSON.parse(body) : null) as T;
}

export interface Deps {
  fetchImpl?: typeof fetch;
  api?: string;
  oauthHost?: string;
}

/** Exchange an OAuth code for a user access token. Needs the client secret, which is why it is here. */
export async function exchangeCode(
  cfg: AppConfig,
  code: string,
  redirectUri: string,
  deps: Deps = {},
): Promise<{ token: string; expiresIn?: number; refreshToken?: string }> {
  const host = deps.oauthHost ?? "https://github.com";
  const res = await (deps.fetchImpl ?? fetch)(`${host}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const body = (await res.json()) as { access_token?: string; error_description?: string; error?: string; expires_in?: number; refresh_token?: string };
  if (!res.ok || !body.access_token) {
    throw new GitHubError(body.error_description ?? body.error ?? "GitHub refused the sign-in", 400);
  }
  const out: { token: string; expiresIn?: number; refreshToken?: string } = { token: body.access_token };
  if (body.expires_in) out.expiresIn = body.expires_in;
  if (body.refresh_token) out.refreshToken = body.refresh_token;
  return out;
}

export async function viewer(token: string, deps: Deps = {}): Promise<{ login: string }> {
  return gh<{ login: string }>(`${deps.api ?? API}/user`, token, {}, deps.fetchImpl);
}

/** Whether this person may push to this repo — the check before we mint anything for it. */
export async function canPush(token: string, slug: string, deps: Deps = {}): Promise<boolean> {
  try {
    const repo = await gh<{ permissions?: { push?: boolean } }>(`${deps.api ?? API}/repos/${slug}`, token, {}, deps.fetchImpl);
    return repo.permissions?.push === true;
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) return false;
    throw err;
  }
}

/** What the agent gets: enough to clone, and nothing else. */
export const READ_ONLY: Record<string, string> = { contents: "read", metadata: "read" };

/**
 * What reading a repository's state takes, which is more than cloning does.
 *
 * `.rounds.yml` is `contents`, but the round's own past pull requests are
 * `pull_requests` — and on a private repository GitHub answers a token
 * without it "Resource not accessible by integration" rather than an empty
 * list, which stops the round before it clones anything.
 *
 * It is deliberately not folded into `READ_ONLY`: that one is handed to the
 * agent, and the agent has no business reading pull requests directly. It
 * asks `/gh/state` and gets one parsed answer. This set never leaves the
 * server.
 */
export const READ_STATE: Record<string, string> = { contents: "read", metadata: "read", pull_requests: "read" };

/**
 * What opening a pull request takes. Never leaves this process — see
 * `propose.ts`, which mints one, uses it, and lets it go.
 *
 * `workflows` is here because most of chant's best findings live in
 * `.github/workflows`, and GitHub refuses a commit that touches one without it.
 */
export const WRITE: Record<string, string> = { contents: "write", pull_requests: "write", workflows: "write" };

/**
 * An installation token for one repository, good for an hour.
 *
 * Scoped twice over: `repositories` limits it to the single repo even when the
 * installation covers many, and `permissions` narrows it below what the
 * installation itself holds. GitHub takes the intersection, so asking for
 * `contents: read` can only ever give back something weaker than the App has —
 * never something stronger.
 */
export async function installationToken(
  cfg: AppConfig,
  slug: string,
  deps: Deps = {},
  permissions: Record<string, string> = READ_ONLY,
): Promise<{ token: string; expiresAt: string }> {
  const api = deps.api ?? API;
  const jwt = appJwt(cfg.appId, cfg.privateKey);
  const [owner, repo] = slug.split("/") as [string, string];
  let installation: { id: number };
  try {
    installation = await gh<{ id: number }>(`${api}/repos/${slug}/installation`, jwt, {}, deps.fetchImpl);
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) {
      throw new GitHubError(`The GitHub App is not installed on ${slug}.`, 404);
    }
    throw err;
  }
  const token = await gh<{ token: string; expires_at: string }>(
    `${api}/app/installations/${installation.id}/access_tokens`,
    jwt,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repositories: [repo], owner, permissions }) },
    deps.fetchImpl,
  );
  if (!token?.token) throw new GitHubError("GitHub returned no token", 502);
  return { token: token.token, expiresAt: token.expires_at };
}

// ── reading a repository ───────────────────────────────────────────────────

export interface PullSummary {
  number: number;
  /** "open" | "closed" */
  state: string;
  merged: boolean;
  /** The head branch, e.g. `rounds/dockerfile`. */
  head: string;
  url: string;
  title: string;
  /** Its labels, lowercased by GitHub or not — `rounds:reconsider` matters. */
  labels: string[];
}

export async function repoInfo(token: string, slug: string, deps: Deps = {}): Promise<{ defaultBranch: string }> {
  const repo = await gh<{ default_branch: string }>(`${deps.api ?? API}/repos/${slug}`, token, {}, deps.fetchImpl);
  return { defaultBranch: repo.default_branch };
}

/**
 * Every pull request whose head branch carries the prefix, in any state.
 *
 * This is the round's memory. A rounds branch that was closed unmerged is a
 * human saying no, and it has to stay a no across every future round — which
 * is why the answer comes from GitHub rather than from anything we store.
 */
export async function listPullsWithPrefix(token: string, slug: string, prefix: string, deps: Deps = {}): Promise<PullSummary[]> {
  const pulls = await gh<
    Array<{
      number: number;
      state: string;
      merged_at: string | null;
      html_url: string;
      title: string;
      head: { ref: string };
      labels?: Array<{ name?: string }>;
    }>
  >(`${deps.api ?? API}/repos/${slug}/pulls?state=all&per_page=100&sort=created&direction=desc`, token, {}, deps.fetchImpl);
  return pulls
    .filter((p) => p.head.ref.startsWith(prefix))
    .map((p) => ({
      number: p.number,
      state: p.state,
      merged: p.merged_at !== null,
      head: p.head.ref,
      url: p.html_url,
      title: p.title,
      // Labels come back on the list itself, so reading them costs nothing —
      // and `rounds:reconsider` is the only way a decline is ever undone.
      labels: (p.labels ?? []).flatMap((l) => (typeof l.name === "string" ? [l.name] : [])),
    }));
}

/** A file's text at a ref, or null when it is not there. */
export async function readFile(token: string, slug: string, path: string, ref: string, deps: Deps = {}): Promise<string | null> {
  try {
    const file = await gh<{ content?: string; encoding?: string }>(
      `${deps.api ?? API}/repos/${slug}/contents/${path}?ref=${encodeURIComponent(ref)}`,
      token,
      {},
      deps.fetchImpl,
    );
    if (!file.content || file.encoding !== "base64") return null;
    return Buffer.from(file.content, "base64").toString("utf8");
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) return null;
    throw err;
  }
}

// ── writing one ────────────────────────────────────────────────────────────

/** A file as the agent proposes it: new text, or gone. */
export type FileChange = { path: string; content: string } | { path: string; deleted: true };

/**
 * Commit the changes on top of `base` and return the new commit's sha.
 *
 * Built through the git data API rather than a push, because there is no
 * working copy on this side — and because it means the commit's parent is
 * exactly the commit the agent audited, which is the thing it verified
 * against. Nothing here can fast-forward over work that landed since.
 */
export async function commitChanges(
  token: string,
  slug: string,
  input: { base: string; message: string; files: FileChange[] },
  deps: Deps = {},
): Promise<string> {
  const api = deps.api ?? API;
  const baseCommit = await gh<{ tree: { sha: string } }>(`${api}/repos/${slug}/git/commits/${input.base}`, token, {}, deps.fetchImpl);

  const post = <T>(path: string, body: unknown) =>
    gh<T>(`${api}/repos/${slug}${path}`, token, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, deps.fetchImpl);

  const entries = await Promise.all(
    input.files.map(async (f) => {
      if ("deleted" in f) return { path: f.path, mode: "100644", type: "blob", sha: null };
      const blob = await post<{ sha: string }>("/git/blobs", { content: Buffer.from(f.content, "utf8").toString("base64"), encoding: "base64" });
      return { path: f.path, mode: "100644", type: "blob", sha: blob.sha };
    }),
  );

  const tree = await post<{ sha: string }>("/git/trees", { base_tree: baseCommit.tree.sha, tree: entries });
  const author = { name: "Rounds", email: "rounds@users.noreply.github.com" };
  const commit = await post<{ sha: string }>("/git/commits", { message: input.message, tree: tree.sha, parents: [input.base], author, committer: author });
  return commit.sha;
}

/**
 * Point `refs/heads/<branch>` at a commit, creating the branch if it is new.
 *
 * The update is allowed to be non-fast-forward, and only here: the caller has
 * already established that this is a `rounds/` branch with no open pull
 * request on it, so the only thing being overwritten is an abandoned attempt
 * of our own. Every other branch in the repository is out of reach — the
 * branch name is derived from a signed grant, never taken from a request.
 */
export async function putBranch(token: string, slug: string, branch: string, sha: string, deps: Deps = {}): Promise<void> {
  const api = deps.api ?? API;
  const ref = `refs/heads/${branch}`;
  try {
    await gh(
      `${api}/repos/${slug}/git/refs`,
      token,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ref, sha }) },
      deps.fetchImpl,
    );
  } catch (err) {
    // 422 is what GitHub answers for "Reference already exists".
    if (!(err instanceof GitHubError && err.status === 422)) throw err;
    await gh(
      `${api}/repos/${slug}/git/${ref}`,
      token,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ sha, force: true }) },
      deps.fetchImpl,
    );
  }
}

export async function openPull(
  token: string,
  slug: string,
  input: { title: string; body: string; head: string; base: string },
  deps: Deps = {},
): Promise<{ number: number; url: string }> {
  const pr = await gh<{ number: number; html_url: string }>(
    `${deps.api ?? API}/repos/${slug}/pulls`,
    token,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) },
    deps.fetchImpl,
  );
  return { number: pr.number, url: pr.html_url };
}

/** Where this person has the App installed. Drives the "install it" gate in the UI. */
/**
 * A repository this person could enroll: one the App is installed on and they
 * can push to.
 *
 * `pushedAt` and the flags are here because the first question the UI has to
 * answer is "which of my forty repositories did I mean" — a list sorted by
 * nothing is as much work as typing the name was.
 */
export interface AccessibleRepo {
  /** `owner/name`. */
  slug: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  /** ISO 8601, or null when GitHub has no push on record. */
  pushedAt: string | null;
  description: string | null;
}

/** How many pages of 100 to walk per installation before calling it enough. */
const REPO_PAGES = 5;

/**
 * Every repository the signed-in person can enroll, across every installation
 * they can see.
 *
 * Asked with their own token against `/user/installations/{id}/repositories`,
 * so the answer is the intersection GitHub itself computes: repositories the
 * App was installed on *and* this person has access to. Nothing here is taken
 * on trust — enrolling still proves push access and mints an installation
 * token — but it means the common case is picking from a list rather than
 * typing a slug and finding out it was the wrong one.
 *
 * Repositories they cannot push to are dropped, because a grant for one would
 * be refused; archived ones are kept but flagged, since a round would audit
 * one happily and never be able to open anything.
 */
export async function accessibleRepos(token: string, deps: Deps = {}): Promise<AccessibleRepo[]> {
  const api = deps.api ?? API;
  const installations = await userInstallations(token, deps);
  const seen = new Set<string>();
  const out: AccessibleRepo[] = [];
  for (const installation of installations) {
    for (let page = 1; page <= REPO_PAGES; page++) {
      const body = await gh<{ repositories?: RawRepo[] }>(
        `${api}/user/installations/${installation.id}/repositories?per_page=100&page=${page}`,
        token,
        {},
        deps.fetchImpl,
      );
      const repositories = body.repositories ?? [];
      for (const r of repositories) {
        const slug = r.full_name ?? "";
        // Push access is the same thing enrolling checks. Offering a
        // repository the grant would refuse is worse than not offering it.
        if (!slug || seen.has(slug) || r.permissions?.push !== true) continue;
        seen.add(slug);
        out.push({
          slug,
          private: r.private === true,
          fork: r.fork === true,
          archived: r.archived === true,
          pushedAt: typeof r.pushed_at === "string" ? r.pushed_at : null,
          description: typeof r.description === "string" ? r.description : null,
        });
      }
      if (repositories.length < 100) break;
    }
  }
  return out;
}

interface RawRepo {
  full_name?: string;
  private?: boolean;
  fork?: boolean;
  archived?: boolean;
  pushed_at?: string | null;
  description?: string | null;
  permissions?: { push?: boolean };
}

export async function userInstallations(
  token: string,
  deps: Deps = {},
): Promise<Array<{ id: number; account: string; repositorySelection: string }>> {
  const body = await gh<{ installations?: Array<{ id: number; account?: { login?: string }; repository_selection?: string }> }>(
    `${deps.api ?? API}/user/installations?per_page=100`,
    token,
    {},
    deps.fetchImpl,
  );
  return (body.installations ?? []).map((i) => ({
    id: i.id,
    account: i.account?.login ?? "",
    repositorySelection: i.repository_selection ?? "selected",
  }));
}
