/**
 * The route table, built over an `AppContext` so tests can stand one up on
 * an in-memory database and a fake Fountain.
 *
 *   GET    /api/config                      { fountainUrl }
 *   POST   /api/session { apiKey }          sign in; sets the cookie
 *   DELETE /api/session                     sign out
 *   GET    /api/me
 *   GET    /api/me/resources                my environments and vaults, for a new project
 *   GET    /api/projects                    mine: owned and shared with me
 *   POST   /api/projects
 *   GET    /api/projects/activity           live counts and last activity, per project
 *   POST   /api/projects/recover            rebuild my projects from my Fountain conversations
 *   POST   /api/import                      the tree an old browser kept in localStorage
 *   GET    /api/projects/:id                project + items
 *   PATCH  /api/projects/:id                owner
 *   DELETE /api/projects/:id                owner
 *   POST   /api/projects/:id/members        owner: { email }
 *   DELETE /api/projects/:id/members/:email owner, or yourself
 *   POST   /api/projects/:id/items
 *   PATCH  /api/projects/:id/items/:item
 *   DELETE /api/projects/:id/items/:item
 *   *      /f/:id/api/...                   Fountain, scoped to the project (proxy.ts)
 *   GET    /healthz
 */
import { existsSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import * as auth from "./auth";
import type { AppContext } from "./context";
import { errorResponse, HttpError, json } from "./http";
import * as projects from "./projects";
import { handleProxy } from "./proxy";

type Handler = (req: Request, params: Record<string, string>) => Promise<Response> | Response;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

function compile(path: string): { pattern: RegExp; keys: string[] } {
  const keys: string[] = [];
  const src = path
    .split("/")
    .map((seg) => {
      if (seg.startsWith(":")) {
        keys.push(seg.slice(1));
        return "([^/]+)";
      }
      if (seg === "*") {
        keys.push("rest");
        return "(.*)";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { pattern: new RegExp(`^${src}$`), keys };
}

export function buildApp(ctx: AppContext): (req: Request) => Promise<Response> {
  const routes: Route[] = [];
  const on = (method: string, path: string, handler: Handler) => routes.push({ method, ...compile(path), handler });

  on("GET", "/healthz", () => new Response("ok\n", { headers: { "content-type": "text/plain" } }));
  on("GET", "/api/config", () => auth.config(ctx));
  on("POST", "/api/session", (req) => auth.signIn(ctx, req));
  on("DELETE", "/api/session", (req) => auth.signOut(ctx, req));
  on("GET", "/api/me", (req) => auth.me(ctx, req));
  on("GET", "/api/me/resources", (req) => auth.myResources(ctx, req));

  on("GET", "/api/projects", (req) => projects.list(ctx, req));
  on("POST", "/api/projects", (req) => projects.create(ctx, req));
  on("GET", "/api/projects/activity", (req) => projects.activity(ctx, req));
  on("POST", "/api/projects/recover", (req) => projects.recover(ctx, req));
  on("POST", "/api/import", (req) => projects.importState(ctx, req));
  on("GET", "/api/projects/:id", (req, p) => projects.show(ctx, req, p.id!));
  on("PATCH", "/api/projects/:id", (req, p) => projects.patch(ctx, req, p.id!));
  on("DELETE", "/api/projects/:id", (req, p) => projects.remove(ctx, req, p.id!));
  on("POST", "/api/projects/:id/members", (req, p) => projects.addMember(ctx, req, p.id!));
  on("DELETE", "/api/projects/:id/members/:email", (req, p) => projects.removeMember(ctx, req, p.id!, p.email!));
  on("POST", "/api/projects/:id/items", (req, p) => projects.createItem(ctx, req, p.id!));
  on("PATCH", "/api/projects/:id/items/:item", (req, p) => projects.patchItem(ctx, req, p.id!, p.item!));
  on("DELETE", "/api/projects/:id/items/:item", (req, p) => projects.removeItem(ctx, req, p.id!, p.item!));

  on("*", "/f/:id/*", (req, p) => handleProxy(ctx, req, p.id!, "/" + (p.rest ?? "")));

  const staticDir = ctx.config.staticDir;

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      for (const r of routes) {
        if (r.method !== "*" && r.method !== req.method.toUpperCase()) continue;
        const m = r.pattern.exec(path);
        if (!m) continue;
        const params: Record<string, string> = {};
        r.keys.forEach((k, i) => (params[k] = m[i + 1] ?? ""));
        return await r.handler(req, params);
      }
      if (path.startsWith("/api/") || path.startsWith("/f/")) throw new HttpError(404, "not_found", `No route ${req.method} ${path}.`);
      if (staticDir && (req.method === "GET" || req.method === "HEAD")) return serveStatic(staticDir, path);
      return json({ error: "not_found" }, 404);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

/** The built SPA: files as they are, anything else is index.html (hash routes need no rewrite, but a deep link still lands here). */
function serveStatic(dir: string, path: string): Response {
  const rel = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, "");
  const file = join(dir, rel);
  if (file.startsWith(join(dir)) && existsSync(file) && statSync(file).isFile()) {
    const immutable = /\/assets\/[^/]+[-.][a-zA-Z0-9_]{6,}\.(js|css|map)$/.test(rel);
    return new Response(Bun.file(file), { headers: { "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" } });
  }
  return new Response(Bun.file(join(dir, "index.html")), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
}
