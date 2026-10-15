/**
 * The endpoints that need a secret. Two of them.
 *
 *   GET  /gh/app                     what the App is, so the UI can offer to install it
 *   GET  /gh/callback?code&state     finish "Sign in with GitHub"; hands back a user token
 *
 * Both are same-origin with the page that calls them, so there is no CORS.
 */
import { exchangeCode, GitHubError, viewer, type Deps } from "./github";
import type { Config } from "./config";

export type Routes = (req: Request, url: URL) => Promise<Response>;

export function buildRoutes(config: Config, deps: Deps = {}): Routes {
  const json = (body: unknown, status = 200) => Response.json(body, { status });

  return async (req, url) => {
    if (url.pathname === "/gh/app") {
      // Public, deliberately: it says what the App is and what it wants, and
      // carries nothing secret.
      return json({
        configured: config.app !== null,
        slug: config.slug,
        clientId: config.app?.clientId ?? null,
        installUrl: config.slug ? `https://github.com/apps/${config.slug}/installations/new` : null,
      });
    }

    if (!config.app) {
      return json({ error: "This deployment has no GitHub App configured. Use a token instead." }, 503);
    }
    const app = config.app;

    try {
      if (url.pathname === "/gh/callback" && req.method === "GET") {
        const code = url.searchParams.get("code");
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        if (!code) return json({ error: "Missing code" }, 400);
        const { token, expiresIn } = await exchangeCode(app, code, redirectUri, deps);
        const who = await viewer(token, deps);
        return json({ token, login: who.login, expiresIn: expiresIn ?? null });
      }
    } catch (err) {
      if (err instanceof GitHubError) {
        // Anything GitHub blames on the request is the caller's to fix, and
        // saying so is more useful than a blanket 502; 403 is folded into 401
        // because from here both mean "your credential will not do this".
        const status = err.status === 403 ? 401 : err.status >= 400 && err.status < 500 ? err.status : 502;
        return json({ error: err.message }, status);
      }
      throw err;
    }

    return json({ error: "Not found" }, 404);
  };
}
