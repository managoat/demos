/**
 * The endpoints that need a secret, and the ones that need to be trusted.
 *
 *   GET  /gh/app                     what the App is, so the UI can offer to install it
 *   GET  /gh/callback?code&state     finish "Sign in with GitHub"; hands back a user token
 *   POST /gh/installations {token}   where this person has the App installed
 *   POST /gh/repos   {token}         which repositories they could enroll
 *   POST /gh/grant   {token, repo}   mint a durable grant for an unattended agent
 *   POST /gh/token   {grant}         trade a grant for a one-hour, READ-ONLY token
 *   POST /gh/state   {grant}         what a round needs to know before it decides
 *   POST /gh/propose {grant, ...}    open the pull request — the only path that writes
 *
 * Two rules run through all of it.
 *
 * The first: anything that mints a credential for a repository first proves
 * the caller can push there. Without that check, asking for a grant would be
 * a way to borrow the App's access to somebody else's repository.
 *
 * The second, and it is the reason this file changed shape: **the agent never
 * receives a credential that can write.** `/gh/token` hands out `contents:
 * read` and nothing more. When a round wants to open a pull request it sends
 * the change here and this process writes it, having checked the repository's
 * policy and its own history first. See `propose.ts` for why a prompt is the
 * wrong place to keep a rule.
 */
import { accessibleRepos, canPush, exchangeCode, GitHubError, installationToken, userInstallations, viewer, type Deps } from "./github";
import { issueGrant, readGrant, type Grant } from "./grant";
import { propose, readProposal, Refused, roundState } from "./propose";
import type { Config } from "./config";

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * A proposal carries file contents, so the body is bigger than anything else
 * here — but not unbounded. `propose.ts` enforces the real limits; this is the
 * blunt guard that stops a runaway round from streaming a repository at us
 * before any of that runs.
 */
const MAX_BODY = 2 * 1024 * 1024;

export type Routes = (req: Request, url: URL) => Promise<Response>;

export function buildRoutes(config: Config, deps: Deps = {}): Routes {
  const cors = (req: Request): Record<string, string> => {
    const origin = req.headers.get("origin");
    if (!origin || !config.allowedOrigins.includes(origin)) return {};
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      vary: "origin",
    };
  };

  const json = (req: Request, body: unknown, status = 200) => Response.json(body, { status, headers: cors(req) });

  /** Parse a JSON body, refusing an oversized one before it is buffered. */
  const readBody = async (req: Request): Promise<Record<string, unknown>> => {
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY) throw new Refused("That request is too large.", "invalid", 413);
    const text = await req.text();
    if (text.length > MAX_BODY) throw new Refused("That request is too large.", "invalid", 413);
    try {
      const parsed: unknown = JSON.parse(text || "{}");
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      throw new Refused("That is not JSON.", "invalid", 400);
    }
  };

  return async (req, url) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });

    if (url.pathname === "/gh/app") {
      // Public, deliberately: it says what the App is and what it wants, and
      // carries nothing secret.
      return json(req, {
        configured: config.app !== null,
        slug: config.slug,
        clientId: config.app?.clientId ?? null,
        installUrl: config.slug ? `https://github.com/apps/${config.slug}/installations/new` : null,
      });
    }

    if (!config.app) {
      return json(req, { error: "This deployment has no GitHub App configured." }, 503);
    }
    const app = config.app;

    /** Every round-facing route is authorized by a grant, and by nothing else. */
    const grantFrom = (body: Record<string, unknown>): Grant => {
      if (!config.grantSecret) throw new Refused("Grants are not enabled on this deployment.", "invalid", 503);
      const grant = readGrant(typeof body.grant === "string" ? body.grant : undefined, config.grantSecret);
      // The repository is read off the signature. A request that names one is
      // ignored — that is the whole reason a grant is signed.
      if (!grant) throw new Refused("That grant is not valid.", "invalid", 401);
      return grant;
    };

    try {
      if (url.pathname === "/gh/callback" && req.method === "GET") {
        const code = url.searchParams.get("code");
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        if (!code) return json(req, { error: "Missing code" }, 400);
        const { token, expiresIn } = await exchangeCode(app, code, redirectUri, deps);
        const who = await viewer(token, deps);
        return json(req, { token, login: who.login, expiresIn: expiresIn ?? null });
      }

      if (url.pathname === "/gh/installations" && req.method === "POST") {
        // The step between signing in and enrolling: the App has to be on the
        // account before a grant can mean anything. Answering this lets the UI
        // say so up front instead of failing halfway through an enrollment.
        const body = await readBody(req);
        if (typeof body.token !== "string") return json(req, { error: "Send {token}." }, 400);
        const installations = await userInstallations(body.token, deps);
        return json(req, { installed: installations.length > 0, installations });
      }

      if (url.pathname === "/gh/repos" && req.method === "POST") {
        // Sign-in already told us what the App can reach, so making somebody
        // type `owner/name` from memory is a question we can answer for them.
        // Their own token, their own access — this adds no reach, it just
        // stops the first enrollment being a guess.
        const body = await readBody(req);
        if (typeof body.token !== "string") return json(req, { error: "Send {token}." }, 400);
        return json(req, { repos: await accessibleRepos(body.token, deps) });
      }

      if (url.pathname === "/gh/grant" && req.method === "POST") {
        if (!config.grantSecret) return json(req, { error: "Grants are not enabled on this deployment." }, 503);
        const body = await readBody(req);
        const repo = typeof body.repo === "string" ? body.repo : "";
        if (typeof body.token !== "string" || !repo || !SLUG.test(repo)) {
          return json(req, { error: "Send {token, repo} where repo is owner/name." }, 400);
        }
        // The person must be able to push there, or this would be a way to
        // borrow the App's access to a repository that is not theirs.
        const who = await viewer(body.token, deps);
        if (!(await canPush(body.token, repo, deps))) {
          return json(req, { error: `${who.login} cannot push to ${repo}.` }, 403);
        }
        // And the App has to be installed on it, or the grant is a dud that
        // only fails later, on a schedule, where nobody is watching.
        await installationToken(app, repo, deps);
        return json(req, {
          grant: issueGrant({ login: who.login, repo, issuedAt: Math.floor(Date.now() / 1000) }, config.grantSecret),
          login: who.login,
          repo,
        });
      }

      if (url.pathname === "/gh/token" && req.method === "POST") {
        const grant = grantFrom(await readBody(req));
        // Read-only, always. The agent clones with this and does nothing else
        // with it; opening a pull request goes through /gh/propose, where the
        // credential that can write never leaves this process.
        const minted = await installationToken(app, grant.repo, deps);
        return json(req, { token: minted.token, expiresAt: minted.expiresAt, repo: grant.repo, permissions: "contents:read" });
      }

      if (url.pathname === "/gh/state" && req.method === "POST") {
        const grant = grantFrom(await readBody(req));
        return json(req, await roundState(app, grant.repo, deps));
      }

      if (url.pathname === "/gh/propose" && req.method === "POST") {
        const body = await readBody(req);
        const grant = grantFrom(body);
        const proposal = readProposal(body);
        const opened = await propose(app, grant.repo, proposal, deps);
        return json(req, opened, 201);
      }
    } catch (err) {
      if (err instanceof Refused) {
        // A refusal is an answer, not a failure: the round is meant to record
        // it and carry on, so the reason travels in the body.
        return json(req, { error: err.message, reason: err.reason, ...(err.pr ? { pr: err.pr } : {}) }, err.status);
      }
      if (err instanceof GitHubError) {
        // Anything GitHub blames on the request is the caller's to fix, and
        // saying so is more useful than a blanket 502; 403 is folded into 401
        // because from here both mean "your credential will not do this".
        const status = err.status === 403 ? 401 : err.status >= 400 && err.status < 500 ? err.status : 502;
        return json(req, { error: err.message }, status);
      }
      throw err;
    }

    return json(req, { error: "Not found" }, 404);
  };
}
