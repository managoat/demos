/**
 * One process: the built SPA, and the handful of endpoints that need a secret.
 *
 * Bun serves `dist/` directly, so there is no nginx and no second process to
 * supervise — and because the API is same-origin with the page, there is no
 * CORS to configure and nothing to get wrong.
 *
 * Everything under /gh exists because it touches something the outside must
 * not hold: the GitHub App's private key, its client secret, or the ability to
 * write to somebody's repository. The unattended agents run with a read-only
 * token and ask this process to open their pull requests.
 */
import { buildRoutes } from "./routes";
import { loadConfig } from "./config";

const PORT = Number(process.env.PORT ?? 8080);
const DIST = process.env.DIST_DIR ?? "dist";

const config = loadConfig(process.env);
const routes = buildRoutes(config);

if (!config.app) {
  // There is no longer a pasted-token path to fall back to, so this is fatal
  // to the product even though the process still serves the page.
  console.warn(
    "github app not configured — /gh answers 503, and nothing can be enrolled or proposed. " +
      "Set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET and GRANT_SECRET.",
  );
} else if (!config.grantSecret) {
  console.warn("GRANT_SECRET is not set — repositories cannot be enrolled, because a grant cannot be signed.");
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 30,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/healthz") return new Response("ok\n", { headers: { "content-type": "text/plain" } });

    if (url.pathname.startsWith("/gh/")) {
      try {
        return await routes(req, url);
      } catch (err) {
        // Never leak an internal error outward; the secret lives in here.
        console.error(`unhandled ${url.pathname}:`, err);
        return Response.json({ error: "Something went wrong." }, { status: 500 });
      }
    }

    // Static site, with SPA fallback so a deep link still boots the app.
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(`${DIST}${path}`);
    if (await file.exists()) {
      const immutable = path.startsWith("/assets/");
      return new Response(file, {
        headers: immutable ? { "cache-control": "public, max-age=31536000, immutable" } : { "cache-control": "no-cache" },
      });
    }
    return new Response(Bun.file(`${DIST}/index.html`), { headers: { "cache-control": "no-cache" } });
  },
});

console.log(`rounds on :${server.port} (dist=${DIST}, github app ${config.app ? "configured" : "absent"})`);
