/**
 * The route table, built over an `AppContext` so tests can stand one up on
 * an in-memory database and a fake Fountain.
 *
 *   GET    /healthz
 *   GET    /api/config                      { fountainUrl }
 *   POST   /api/session { apiKey }          sign in; sets the cookie
 *   DELETE /api/session                     sign out
 *   GET    /api/me
 *   GET    /api/me/menu                     the model catalog and my connections, for the composer's menus
 *   GET    /api/chats                       mine: hosted and invited to
 *   POST   /api/chats                       start one
 *   GET    /api/chats/:id
 *   PATCH  /api/chats/:id                   host
 *   DELETE /api/chats/:id                   host
 *   POST   /api/chats/:id/members           host
 *   DELETE /api/chats/:id/members/:email    host, or yourself
 *   POST   /api/chats/:id/invite            host: a join link
 *   POST   /api/join/:token                 take the link up
 *   GET    /api/chats/:id/stream            what Salon itself records, live, server-sent (hub.ts)
 *   GET    /api/chats/:id/games             the chat's games (games.ts)
 *   POST   /api/chats/:id/games             start one
 *   GET    /api/chats/:id/games/:game
 *   POST   /api/chats/:id/games/:game/moves a move, from the player whose go it is
 *   GET    /api/chats/:id/changes           the repository's latest changes, with the diff (changes.ts)
 *   GET    /api/chats/:id/changes/history   the snapshots before it, without
 *   POST   /mcp                             the model's way to start a game, on the conversation's key (mcp.ts)
 *   POST   /hooks/changes                   the computer's way to report changes, on the same key (changes.ts)
 *   *      /f/:id/api/...                   Fountain, scoped to the chat (proxy.ts)
 */
import { existsSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import * as auth from "./auth";
import * as changes from "./changes";
import * as chats from "./chats";
import type { AppContext } from "./context";
import * as games from "./games";
import { errorResponse, HttpError, json } from "./http";
import * as hub from "./hub";
import { handleMcp } from "./mcp";
import * as menu from "./menu";
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
  on("GET", "/api/me/menu", (req) => menu.show(ctx, req));

  on("GET", "/api/chats", (req) => chats.list(ctx, req));
  on("POST", "/api/chats", (req) => chats.create(ctx, req));
  on("GET", "/api/chats/:id", (req, p) => chats.show(ctx, req, p.id!));
  on("PATCH", "/api/chats/:id", (req, p) => chats.patch(ctx, req, p.id!));
  on("DELETE", "/api/chats/:id", (req, p) => chats.remove(ctx, req, p.id!));
  on("POST", "/api/chats/:id/members", (req, p) => chats.addMember(ctx, req, p.id!));
  on("DELETE", "/api/chats/:id/members/:email", (req, p) => chats.removeMember(ctx, req, p.id!, p.email!));
  on("POST", "/api/chats/:id/invite", (req, p) => chats.invite(ctx, req, p.id!));
  on("POST", "/api/join/:token", (req, p) => chats.join(ctx, req, p.token!));

  on("GET", "/api/chats/:id/stream", (req, p) => hub.stream(ctx, req, p.id!));
  on("GET", "/api/chats/:id/games", (req, p) => games.list(ctx, req, p.id!));
  on("POST", "/api/chats/:id/games", (req, p) => games.create(ctx, req, p.id!));
  on("GET", "/api/chats/:id/games/:game", (req, p) => games.show(ctx, req, p.id!, p.game!));
  on("POST", "/api/chats/:id/games/:game/moves", (req, p) => games.makeMove(ctx, req, p.id!, p.game!));
  on("GET", "/api/chats/:id/changes", (req, p) => changes.latest(ctx, req, p.id!));
  on("GET", "/api/chats/:id/changes/history", (req, p) => changes.history(ctx, req, p.id!));

  on("*", "/mcp", (req) => handleMcp(ctx, req));
  on("*", "/hooks/changes", (req) => changes.hook(ctx, req));
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

/** The built SPA: files as they are, anything else is index.html. */
function serveStatic(dir: string, path: string): Response {
  const rel = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, "");
  const file = join(dir, rel);
  if (file.startsWith(join(dir)) && existsSync(file) && statSync(file).isFile()) {
    const immutable = /\/assets\/[^/]+[-.][a-zA-Z0-9_]{6,}\.(js|css|map)$/.test(rel);
    return new Response(Bun.file(file), { headers: { "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" } });
  }
  return new Response(Bun.file(join(dir, "index.html")), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
}
