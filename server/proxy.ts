/**
 * The chat-scoped Fountain proxy: `/f/<chat>/api/conversations/<id>/…` is
 * that one conversation, on the host's key, for everyone in the chat.
 *
 * A guest's browser builds an ordinary SDK client with this as its base URL
 * and never holds a Fountain key. What it can reach — and only for the
 * conversation the chat is bound to:
 *
 *   GET  …/<id>                    the record
 *   GET  …/<id>/turns              the prompts
 *   GET  …/<id>/events, /stream    the transcript (blocks) and its live tail
 *   GET  …/<id>/turns/:t/images/:n an image sent on a prompt
 *   POST …/<id>/prompts            send a turn — tagged with who sent it once
 *                                  the room has more than one person, and
 *                                  recorded (db.sends) so the bubble can say so
 *   POST …/<id>/interrupt, /read, /requests/:r
 *   POST …/<id>/terminate          the host only
 *
 * Everything else is 404.
 */
import { withAuthor } from "../shared/author";
import { imagesProblem } from "../shared/images";
import { authenticate, chatAccess, ownerClient, type AppContext } from "./context";
import type { Role } from "./db";
import type { FountainClient } from "./fountain";
import { HttpError, json, readJson, str } from "./http";
import { mentionedWorkspaceMembers } from "./account";

export async function handleProxy(ctx: AppContext, req: Request, chatId: string, path: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { chat, role } = chatAccess(ctx, user, chatId);
  const url = new URL(req.url);
  const method = req.method.toUpperCase();

  const m = /^\/api\/conversations\/([^/]+)(\/.*)?$/.exec(path);
  if (!m) throw new HttpError(404, "not_found");
  const id = decodeURIComponent(m[1]!);
  const sub = m[2] ?? "";
  if (id !== chat.conversation_id) throw new HttpError(404, "not_found", "No such conversation in this chat.");
  if (!allowed(method, sub, role)) throw new HttpError(404, "not_found");

  const client = await ownerClient(ctx, chat);

  if (method === "POST" && sub === "/prompts") {
    const body = await readJson(req);
    const problem = imagesProblem(body.images);
    if (problem) throw new HttpError(422, "bad_images", problem);
    let prompt = str(body.prompt, 100_000);
    const mentions = mentionedWorkspaceMembers(ctx, user.email, prompt).filter((email) => email !== chat.owner_email && email !== user.email);
    if (ctx.db.participants(chat).length > 1 || mentions.length > 0) prompt = withAuthor(user.email, prompt);
    const out: Record<string, unknown> = { prompt };
    if (Array.isArray(body.images) && body.images.length) out.images = body.images;
    const res = await forward(client, req, path, url.search, JSON.stringify(out));
    if (res.ok) {
      ctx.db.addSend(chat.id, user.email);
      for (const email of mentions) {
        ctx.db.addMember(chat.id, email, `mention:${user.email}`);
        ctx.db.addMentionNotification(email, chat.id, user.email);
      }
    }
    return res;
  }

  return forward(client, req, path, url.search);
}

function allowed(method: string, sub: string, role: Role): boolean {
  if (sub === "" || sub === "/") return method === "GET";
  if (method === "GET") return ["/turns", "/events", "/stream"].includes(sub) || /^\/turns\/[^/]+\/images\/\d+$/.test(sub);
  if (method === "POST") {
    if (sub === "/terminate") return role === "owner";
    return ["/prompts", "/read", "/interrupt"].includes(sub) || /^\/requests\/[^/]+$/.test(sub);
  }
  return false;
}

/**
 * Send the request on as it is — method, query, body, accept — and hand the
 * answer back, streamed. A read follows the browser's abort; a mutation does
 * not — a terminate Fountain is half-way through must finish whether or not
 * the tab that asked for it is still waiting.
 */
async function forward(client: FountainClient, req: Request, path: string, search: string, sendBody?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  for (const h of ["accept", "content-type", "last-event-id"]) {
    const v = req.headers.get(h);
    if (v) headers[h] = v;
  }
  const method = req.method.toUpperCase();
  const read = method === "GET" || method === "HEAD";
  if (sendBody !== undefined) headers["content-type"] = "application/json";
  const body = sendBody !== undefined ? sendBody : read ? undefined : await req.arrayBuffer();
  const res = await client.fetch(`${path}${search}`, { method, headers, body, signal: read ? req.signal : undefined });
  const out = new Headers();
  for (const h of ["content-type", "cache-control", "content-disposition", "retry-after"]) {
    const v = res.headers.get(h);
    if (v) out.set(h, v);
  }
  const bodyless = res.status === 204 || res.status === 205 || res.status === 304;
  return new Response(bodyless ? null : res.body, { status: res.status, headers: out });
}

export { json };
