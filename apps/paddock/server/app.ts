/**
 * The routes.
 *
 *   GET    /healthz
 *   GET    /api/config                        which Fountain this server signs in with
 *   GET    /api/me                            who the session is
 *   POST   /api/auth/session                  sign in with a Fountain key
 *   DELETE /api/auth/session                  sign out
 *   POST   /api/join/:token                   follow an invite link (no account needed)
 *
 *   GET    /api/paddock                       the caller's machine and its people
 *   POST   /api/paddock                       owner: claim it
 *   POST   /api/paddock/:id/members           owner: invite by email
 *   DELETE /api/paddock/:id/members/:email    owner, or leave
 *   POST   /api/paddock/:id/invite            owner: mint the link (evicts old guests)
 *   DELETE /api/paddock/:id/invite            owner: close the link
 *   POST   /api/paddock/:id/presence          heartbeat
 *   GET    /api/paddock/:id/stream            presence, tabs, turns
 *
 *   *      /f/:id/api/conversations…          Fountain, scoped to that machine's tabs
 *
 * The shape of this list is the permission model. Tabs are reachable through
 * `/f/` by everyone in the paddock; the machine itself is reachable only
 * through owner-only routes that do not exist under `/f/` at all. A guest
 * cannot reach the config surface because there is no path from where they
 * are to where it lives — not because a check says no.
 */
import { authenticate, type AppContext } from "./context";
import * as auth from "./auth";
import * as people from "./people";
import { handleProxy } from "./proxy";
import { errorResponse, HttpError, json } from "./http";

type Handler = (req: Request, params: Record<string, string>) => Response | Promise<Response>;

interface Route {
  method: string;
  pattern: string[];
  handler: Handler;
}

export function buildRouter(ctx: AppContext): (req: Request) => Promise<Response> {
  const routes: Route[] = [];
  const on = (method: string, path: string, handler: Handler) => {
    routes.push({ method, pattern: path.split("/").filter(Boolean), handler });
  };

  on("GET", "/healthz", () => new Response("ok\n", { headers: { "content-type": "text/plain" } }));
  on("GET", "/api/config", () => auth.config(ctx));
  on("GET", "/api/me", (req) => auth.me(ctx, req));
  on("POST", "/api/auth/session", (req) => auth.signIn(ctx, req));
  on("DELETE", "/api/auth/session", (req) => auth.signOut(ctx, req));
  on("POST", "/api/join/:token", (req, p) => auth.join(ctx, req, p.token!));

  on("GET", "/api/paddock", (req) => people.show(ctx, req));
  on("POST", "/api/paddock", (req) => people.claim(ctx, req));
  on("POST", "/api/paddock/:id/members", (req, p) => people.addMember(ctx, req, p.id!));
  on("DELETE", "/api/paddock/:id/members/:email", (req, p) => people.removeMember(ctx, req, p.id!, p.email!));
  on("POST", "/api/paddock/:id/invite", (req, p) => people.mintInvite(ctx, req, p.id!));
  on("DELETE", "/api/paddock/:id/invite", (req, p) => people.closeInvite(ctx, req, p.id!));
  on("POST", "/api/paddock/:id/presence", (req, p) => people.presence(ctx, req, p.id!));
  on("GET", "/api/paddock/:id/stream", (req, p) => people.stream(ctx, req, p.id!));

  on("*", "/f/:id/*", async (req, p) => {
    const id = await authenticate(ctx, req);
    return handleProxy(ctx, req, p.id!, "/" + (p.rest ?? ""), id);
  });

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      const segments = path.split("/").filter(Boolean);
      for (const route of routes) {
        if (route.method !== "*" && route.method !== req.method.toUpperCase()) continue;
        const params = match(route.pattern, segments);
        if (params) return await route.handler(req, params);
      }
      if (path.startsWith("/api/") || path.startsWith("/f/")) {
        throw new HttpError(404, "not_found", `No route ${req.method} ${path}.`);
      }
      return await serveStatic(ctx, path);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

/** `:name` captures a segment; a trailing `*` captures the rest as `rest`. */
function match(pattern: string[], segments: string[]): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const part = pattern[i]!;
    if (part === "*") {
      params.rest = segments.slice(i).join("/");
      return params;
    }
    const seg = segments[i];
    if (seg === undefined) return null;
    if (part.startsWith(":")) params[part.slice(1)] = decodeURIComponent(seg);
    else if (part !== seg) return null;
  }
  return segments.length === pattern.length ? params : null;
}

/** The built SPA, with the usual fallback so client-side routing works. */
async function serveStatic(ctx: AppContext, path: string): Promise<Response> {
  if (!ctx.config.staticDir) return json({ error: "not_found" }, 404);
  const rel = path === "/" ? "index.html" : path.replace(/^\/+/, "");
  // No traversal out of the bundle.
  if (rel.includes("..")) return json({ error: "not_found" }, 404);
  const file = Bun.file(`${ctx.config.staticDir}/${rel}`);
  if (await file.exists()) return new Response(file);
  const index = Bun.file(`${ctx.config.staticDir}/index.html`);
  if (await index.exists()) return new Response(index, { headers: { "content-type": "text/html; charset=utf-8" } });
  return json({ error: "not_found" }, 404);
}
