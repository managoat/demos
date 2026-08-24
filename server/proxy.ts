/**
 * The project-scoped Fountain proxy: `/f/<project>/api/...` is the Fountain
 * API as seen from inside one project, on the owner's key, narrowed to that
 * project's conversations.
 *
 * A member's browser builds an ordinary SDK client with this as its base
 * URL and never holds a Fountain key. What it can reach:
 *
 *   GET  /api/conversations                 the owner's list, only `workbench:<project>/…`
 *   POST /api/conversations                 start one; channel must be an item of this project,
 *                                           environment and vault are the project's, not the caller's
 *   *    /api/conversations/:id/…           get, turns, events, prompts, read, interrupt, terminate,
 *                                           requests, tree, stream — after checking :id is in the project
 *   GET  /api/agents, /api/agents/:id/avatar  the owner's agents (the team)
 *   GET  /api/environments, /api/vaults     the owner sees all; a member sees the project's
 *   GET  /api/events/stream                 the owner's stream, filtered to the project, plus
 *                                           `event: workbench` when items or settings change
 *
 * Everything else is 404. The conversation → project map is cached, since
 * a `channel_id` does not change.
 */
import { channelFor, channelPrefix, parseChannel } from "../shared/channel";
import { authenticate, ownerClient, projectAccess, type AppContext } from "./context";
import type { ProjectRow, Role } from "./db";
import type { ConversationSummary, FountainClient } from "./fountain";
import { HttpError, json, readJson } from "./http";
import { addTeammate, reconcileItems } from "./projects";

const CACHE_TTL_MS = 10 * 60 * 1000;

/** conversation id → the project its channel names (null: none of ours), with when we learned it. */
const convProject = new Map<string, { projectId: string | null; at: number }>();

function remember(c: ConversationSummary): void {
  convProject.set(c.id, { projectId: parseChannel(c.channel_id)?.projectId ?? null, at: Date.now() });
}

/** For tests: forget every cached conversation. */
export function resetProxyCache(): void {
  convProject.clear();
}

async function belongs(client: FountainClient, projectId: string, conversationId: string): Promise<boolean> {
  const hit = convProject.get(conversationId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.projectId === projectId;
  const c = await client.conversation(conversationId);
  if (!c) {
    convProject.set(conversationId, { projectId: null, at: Date.now() });
    return false;
  }
  remember(c);
  return parseChannel(c.channel_id)?.projectId === projectId;
}

interface Scope {
  project: ProjectRow;
  role: Role;
  client: FountainClient;
}

export async function handleProxy(ctx: AppContext, req: Request, projectId: string, path: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { project, role } = projectAccess(ctx, user, projectId);
  const client = await ownerClient(ctx, project);
  const scope: Scope = { project, role, client };
  const url = new URL(req.url);
  const method = req.method.toUpperCase();

  if (path === "/api/conversations") {
    if (method === "GET") return listConversations(ctx, scope, url);
    if (method === "POST") return startConversation(ctx, scope, req);
    throw new HttpError(405, "method_not_allowed");
  }

  const conv = /^\/api\/conversations\/([^/]+)(\/.*)?$/.exec(path);
  if (conv) {
    const id = decodeURIComponent(conv[1]!);
    const sub = conv[2] ?? "";
    if (!conversationRouteAllowed(method, sub, role)) throw new HttpError(404, "not_found");
    if (!(await belongs(client, projectId, id))) throw new HttpError(404, "not_found", "No such conversation in this project.");
    return forward(client, req, path, url.search);
  }

  if (method === "GET" && (path === "/api/agents" || /^\/api\/agents\/[^/]+\/avatar$/.test(path))) {
    return forward(client, req, path, url.search);
  }

  if (method === "GET" && (path === "/api/environments" || path === "/api/vaults")) {
    const res = await forward(client, req, path, url.search);
    if (role === "owner" || !res.ok) return res;
    // A member sees the computer the project runs on, not the owner's whole shelf.
    const body = (await res.json()) as { data?: { id: string }[] };
    const keep = path === "/api/environments" ? project.environment_id : project.vault_id;
    return json({ ...body, data: (body.data ?? []).filter((x) => x.id === keep) }, res.status);
  }

  if (method === "GET" && path === "/api/events/stream") return stream(ctx, scope, req, url);

  throw new HttpError(404, "not_found");
}

function conversationRouteAllowed(method: string, sub: string, role: Role): boolean {
  if (sub === "" || sub === "/") return method === "GET" || (method === "DELETE" && role === "owner");
  if (method === "GET") return ["/turns", "/events", "/tree", "/stream"].includes(sub);
  if (method === "POST") return ["/prompts", "/read", "/interrupt", "/terminate"].includes(sub) || /^\/requests\/[^/]+$/.test(sub);
  return false;
}

// ── conversations ────────────────────────────────────────────────────────

async function listConversations(ctx: AppContext, { project, client }: Scope, url: URL): Promise<Response> {
  const query: Record<string, string> = {};
  for (const [k, v] of url.searchParams) if (["roots_only", "agent_id", "status"].includes(k)) query[k] = v;
  const res = await client.fetch(`/api/conversations?${new URLSearchParams(query)}`);
  const text = await res.text();
  if (!res.ok) return passthrough(res, text);
  const body = JSON.parse(text) as { data?: ConversationSummary[] };
  const all = body.data ?? [];
  for (const c of all) remember(c);
  const prefix = channelPrefix(project.id);
  const mine = all.filter((c) => typeof c.channel_id === "string" && c.channel_id.startsWith(prefix));
  if (reconcileItems(ctx, project, mine)) ctx.events.emit(project.id, { kind: "items" });
  return json({ ...body, data: mine });
}

async function startConversation(ctx: AppContext, { project, client }: Scope, req: Request): Promise<Response> {
  const body = await readJson(req);
  const ref = parseChannel(typeof body.channel_id === "string" ? body.channel_id : null);
  if (!ref || ref.projectId !== project.id) throw new HttpError(422, "bad_channel", "A conversation must be started on one of this project's work items.");
  const item = ctx.db.getItem(ref.itemId);
  if (!item || item.project_id !== project.id) throw new HttpError(404, "not_found", "No such work item.");
  if (typeof body.agent_id !== "string" || !body.agent_id) throw new HttpError(422, "agent_required", "Pick a teammate.");

  // The computer is the project's: whatever the caller sent, the project decides.
  const out: Record<string, unknown> = {
    agent_id: body.agent_id,
    channel_id: channelFor(project.id, item.id),
    fresh: true,
  };
  if (typeof body.title === "string") out.title = body.title;
  if (typeof body.prompt === "string" && body.prompt) out.prompt = body.prompt;
  if (Array.isArray(body.images)) out.images = body.images;
  if (project.environment_id) out.environment_id = project.environment_id;
  if (project.vault_id) out.vault_id = project.vault_id;
  if (typeof body.sandbox_id === "string" && body.sandbox_id) {
    // Joining a computer: it must be one of this project's conversations' — same agent, same project.
    const convs = await client.conversations({ roots_only: "false" });
    for (const c of convs) remember(c);
    const host = convs.find((c) => c.sandbox_id === body.sandbox_id && parseChannel(c.channel_id)?.projectId === project.id);
    if (!host) throw new HttpError(404, "not_found", "That computer is not one of this project's.");
    if (host.agent_id !== body.agent_id) throw new HttpError(422, "agent_mismatch", "A computer is shared only by conversations of the same teammate.");
    out.sandbox_id = body.sandbox_id;
  }

  const res = await client.fetch("/api/conversations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(out) });
  const text = await res.text();
  if (res.ok) {
    try {
      const created = (JSON.parse(text) as { data?: ConversationSummary }).data;
      if (created) remember(created);
    } catch {
      // not ours to fix
    }
    if (addTeammate(ctx, item.id, body.agent_id)) ctx.events.emit(project.id, { kind: "items" });
  }
  return passthrough(res, text);
}

// ── forwarding ───────────────────────────────────────────────────────────

/** Send the request on as it is — method, query, body, accept — and hand the answer back, streamed. */
async function forward(client: FountainClient, req: Request, path: string, search: string): Promise<Response> {
  const headers: Record<string, string> = {};
  for (const h of ["accept", "content-type", "last-event-id"]) {
    const v = req.headers.get(h);
    if (v) headers[h] = v;
  }
  const method = req.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : await req.arrayBuffer();
  const res = await client.fetch(`${path}${search}`, { method, headers, body, signal: req.signal });
  const out = new Headers();
  for (const h of ["content-type", "cache-control", "content-disposition"]) {
    const v = res.headers.get(h);
    if (v) out.set(h, v);
  }
  return new Response(res.body, { status: res.status, headers: out });
}

function passthrough(res: Response, text: string): Response {
  return new Response(text, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } });
}

// ── the event stream ─────────────────────────────────────────────────────

const enc = new TextEncoder();

/**
 * Read the owner's user-wide stream and pass on the records that belong to
 * this project: comments (heartbeats), the `conversations` notice, and any
 * log event whose `conversation_id` is one of the project's. Everything
 * else is dropped. `Last-Event-ID` is forwarded, so a reconnect replays;
 * duplicates from a lagging id are the client's to ignore, and it does.
 * Records the workbench raises itself (`event: workbench`) are mixed in.
 */
async function stream(ctx: AppContext, { project, client }: Scope, req: Request, url: URL): Promise<Response> {
  const headers: Record<string, string> = { accept: "text/event-stream" };
  const last = req.headers.get("last-event-id");
  if (last) headers["last-event-id"] = last;
  const ctrl = new AbortController();
  const upstream = await client.fetch(`/api/events/stream${url.search}`, { headers, signal: ctrl.signal });
  if (!upstream.ok || !upstream.body) return passthrough(upstream, await upstream.text());

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let unsubscribe = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      unsubscribe = ctx.events.subscribe(project.id, (data) => {
        try {
          controller.enqueue(enc.encode(`event: workbench\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // closed
        }
      });
      void (async () => {
        let buffer = "";
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
            let idx: number;
            while ((idx = buffer.indexOf("\n\n")) !== -1) {
              const raw = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              if (await keep(client, project.id, raw)) controller.enqueue(enc.encode(raw + "\n\n"));
            }
          }
        } catch {
          // upstream dropped; the client reconnects
        } finally {
          unsubscribe();
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      })();
    },
    cancel() {
      unsubscribe();
      ctrl.abort();
    },
  });
  req.signal.addEventListener("abort", () => ctrl.abort());
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
}

/** Whether one raw SSE record is this project's to see. */
async function keep(client: FountainClient, projectId: string, raw: string): Promise<boolean> {
  const lines = raw.split("\n").filter((l) => l !== "");
  if (lines.length === 0) return false;
  if (lines.every((l) => l.startsWith(":"))) return true;
  let event = "message";
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (event === "conversations") return true;
  if (data.length === 0) return false;
  let id: string | undefined;
  try {
    id = (JSON.parse(data.join("\n")) as { conversation_id?: string }).conversation_id;
  } catch {
    return false;
  }
  if (!id) return false;
  return belongs(client, projectId, id);
}
