/**
 * The workbench as an MCP server: `POST /mcp` is the work-item tree, in
 * tools, for an agent that is already inside it. "Split this into three
 * items" stops being something a person has to go and do.
 *
 * A teammate in a sandbox already holds a Fountain key (`$FOUNTAIN_TOKEN`,
 * minted per conversation, `sprite` scope) and the id of the conversation
 * it is running (`$FOUNTAIN_CONVERSATION_ID`). That is everything this
 * endpoint needs, so nothing new is issued and nothing new is stored:
 *
 *   - **The bearer token says who is asking.** The workbench asks Fountain
 *     `GET /api/auth/me` and takes the email, which is exactly what
 *     sign-in does — a Fountain key is already how a person proves who
 *     they are here. A key whose email has never signed in is refused: the
 *     workbench does not learn about people from a header. The verdict is
 *     cached briefly, under a hash of the key, so a revoke still bites.
 *
 *   - **`X-Fountain-Conversation-Id` pins the session to one project.**
 *     With it, the workbench reads that conversation on the caller's own
 *     key and takes the project out of its `channel_id`, so a sandbox
 *     reaches only the project it is working in — and the tools stop
 *     needing to be told which project that is. Without it the tools span
 *     every project the key's user is in and take a `project` argument.
 *
 * Streamable HTTP, one JSON-RPC 2.0 message per POST, answered as JSON —
 * the shape Fountain's own MCP endpoints use (`Fountain.Team.Mcp`), so a
 * client configured for one is configured for both.
 *
 * This is not a second way into Fountain. Nothing here forwards to it
 * beyond the two identity reads above; `server/proxy.ts` remains the only
 * boundary a member's conversations cross. What a key gets here is the
 * workbench tree of the person it belongs to — no more than handing the
 * same key to the sign-in form would, which is the deal already.
 */
import { parseChannel } from "../shared/channel";
import { emptyCounts, ITEM_STATUSES, isItemStatus } from "../shared/status";
import { projectAccess, type AppContext } from "./context";
import { sha256 } from "./crypto";
import type { ItemRow, ProjectRow, Role, UserRow } from "./db";
import { FountainClient, FountainHttpError } from "./fountain";
import { HttpError, json, readJson, str } from "./http";
import { itemDto, newItemRow } from "./projects";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "fountain-workbench", version: "1" };
const CONVERSATION_HEADER = "x-fountain-conversation-id";

/** How long a key's verdict from Fountain is reused. Short: a revoked key must stop working. */
const KEY_CACHE_TTL_MS = 60 * 1000;

/** sha256(key) → the email Fountain said it belongs to, and when it said so. */
const verified = new Map<string, { email: string; at: number }>();

/** For tests: forget every verified key. */
export function resetMcpCache(): void {
  verified.clear();
}

// ── the tools ────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "list_projects",
    description:
      "The projects you can work in: id, name, your role, and how many work items are open. " +
      "Start here when you have to name a project. Inside a conversation this is the one project it belongs to.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_work_items",
    description:
      "A project's work items — id, title, notes, status, and which teammates have worked on each. " +
      "The item this conversation is on is marked `current`. Read this before creating an item, so you " +
      "add to the list rather than duplicate it.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project id or name; omit inside a conversation, or when you are in only one" },
        status: {
          type: "string",
          enum: ITEM_STATUSES,
          description: "Only items in this state: 'open' still to do, 'done' finished, 'wont' decided against",
        },
      },
    },
  },
  {
    name: "create_work_item",
    description:
      "Add a work item to a project. The title is one line saying what is to be done — it is what the " +
      "team reads in the list; the notes are the context whoever picks it up will need (repro, links, what " +
      "'done' looks like). It appears on every open screen at once. Nobody is put on it: a teammate is " +
      "assigned by starting a conversation on it from the workbench.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "One line: what is to be done" },
        notes: { type: "string", description: "The context for whoever picks it up" },
        project: { type: "string", description: "Project id or name; omit inside a conversation, or when you are in only one" },
      },
      required: ["title"],
    },
  },
  {
    name: "update_work_item",
    description:
      "Rewrite a work item's title or notes — sharpen a title, or write up what you found. " +
      "Closing one — done, or won't do — is not here on purpose: either retires every conversation on the " +
      "item and takes its computers down, quite possibly your own, so it stays a person's call in the " +
      "workbench. If you conclude an item should not be done, say why in its notes; a person closes it.",
    inputSchema: {
      type: "object",
      properties: {
        item: { type: "string", description: "The work item id, from list_work_items" },
        title: { type: "string", description: "The new title" },
        notes: { type: "string", description: "The new notes; replaces what is there" },
      },
      required: ["item"],
    },
  },
];

// ── the endpoint ─────────────────────────────────────────────────────────

export async function handleMcp(ctx: AppContext, req: Request): Promise<Response> {
  if (req.method.toUpperCase() !== "POST") {
    throw new HttpError(405, "method_not_allowed", "The workbench MCP server takes one JSON-RPC message per POST.");
  }
  const caller = await authenticate(ctx, req);
  const body = await readJson<Record<string, unknown>>(req);
  if (Array.isArray(body)) return rpcError(null, -32600, "batched requests are not supported");

  const id = typeof body.id === "string" || typeof body.id === "number" ? body.id : null;
  const method = typeof body.method === "string" ? body.method : "";
  if (!method) return rpcError(id, -32600, "invalid request");
  // A notification carries no id and expects no answer.
  if (id === null && method.startsWith("notifications/")) return new Response(null, { status: 202 });
  const params = (body.params ?? {}) as Record<string, unknown>;

  switch (method) {
    case "initialize":
      return rpcResult(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS });
    case "tools/call":
      return rpcResult(id, callTool(ctx, caller, params));
    default:
      // A notification of something we do not know is still nothing to answer.
      return id === null ? new Response(null, { status: 202 }) : rpcError(id, -32601, `method not found: ${method}`);
  }
}

function callTool(ctx: AppContext, caller: Caller, params: Record<string, unknown>): unknown {
  const name = typeof params.name === "string" ? params.name : "";
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  try {
    switch (name) {
      case "list_projects":
        return content(listProjects(ctx, caller));
      case "list_work_items":
        return content(listWorkItems(ctx, caller, args));
      case "create_work_item":
        return content(createWorkItem(ctx, caller, args));
      case "update_work_item":
        return content(updateWorkItem(ctx, caller, args));
      default:
        return toolError(`no such tool: ${name || "(unnamed)"} — call tools/list`);
    }
  } catch (err) {
    // What the agent did wrong is the agent's to fix, and reads as a tool
    // result; anything else is the server's problem and stays an exception.
    if (err instanceof ToolError) return toolError(err.message);
    throw err;
  }
}

// ── who is asking ────────────────────────────────────────────────────────

interface Caller {
  user: UserRow;
  /** The project (and item) of the conversation the caller named, when it named one. */
  pinned: { project: ProjectRow; role: Role; itemId: string } | null;
}

async function authenticate(ctx: AppContext, req: Request): Promise<Caller> {
  const header = req.headers.get("authorization") ?? "";
  const key = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!key) {
    throw new HttpError(401, "unauthenticated", "Send a Fountain API key as `Authorization: Bearer …`; inside a sandbox that is $FOUNTAIN_TOKEN.");
  }
  const email = await whose(ctx, key);
  const user = ctx.db.getUser(email);
  if (!user) throw new HttpError(401, "unknown_user", `${email} has never signed in to the workbench, so there is nothing here to reach. Sign in once first.`);
  return { user, pinned: await pin(ctx, user, key, req) };
}

/** The email Fountain says a key belongs to. */
async function whose(ctx: AppContext, key: string): Promise<string> {
  const hash = await sha256(key);
  const hit = verified.get(hash);
  if (hit && Date.now() - hit.at < KEY_CACHE_TTL_MS) return hit.email;

  let who: { email: string };
  try {
    who = await new FountainClient(ctx.config.fountainUrl, key).me();
  } catch (err) {
    if (err instanceof FountainHttpError && (err.status === 401 || err.status === 403)) throw new HttpError(401, "bad_key", "Fountain rejected that key.");
    throw new HttpError(502, "fountain_unreachable", `Could not reach ${ctx.config.fountainUrl} to verify the key.`);
  }
  const email = who.email.trim().toLowerCase();
  if (!email) throw new HttpError(502, "no_email", "Fountain did not say who the key belongs to.");
  verified.set(hash, { email, at: Date.now() });
  return email;
}

/**
 * The project a caller is confined to, from the conversation it named. Read
 * on the caller's own key — a conversation Fountain will not show that key
 * is not one this caller is in.
 */
async function pin(ctx: AppContext, user: UserRow, key: string, req: Request): Promise<Caller["pinned"]> {
  const id = req.headers.get(CONVERSATION_HEADER)?.trim();
  if (!id) return null;
  const conv = await new FountainClient(ctx.config.fountainUrl, key).conversation(id);
  if (!conv) throw new HttpError(404, "no_conversation", `Fountain has no conversation ${id} for this key.`);
  const ref = parseChannel(conv.channel_id);
  if (!ref) {
    throw new HttpError(404, "not_a_workbench_conversation", "That conversation is not on a workbench work item, so there is no project to be in. Drop the header to reach your projects by name.");
  }
  const { project, role } = projectAccess(ctx, user, ref.projectId);
  return { project, role, itemId: ref.itemId };
}

// ── what the tools do ────────────────────────────────────────────────────

function listProjects(ctx: AppContext, caller: Caller): unknown {
  const rows = caller.pinned ? [caller.pinned.project] : ctx.db.projectsFor(caller.user.email);
  const counts = ctx.db.itemCounts(rows.map((p) => p.id));
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    notes: p.notes,
    role: p.owner_email === caller.user.email ? "owner" : "member",
    ownerEmail: p.owner_email,
    items: counts.get(p.id) ?? emptyCounts(),
    ...(caller.pinned ? { current: true } : {}),
  }));
}

function listWorkItems(ctx: AppContext, caller: Caller, args: Record<string, unknown>): unknown {
  const project = resolveProject(ctx, caller, args.project);
  const status = isItemStatus(args.status) ? args.status : null;
  const items = ctx.db
    .items(project.id)
    .map(itemDto)
    .filter((w) => !status || w.status === status)
    .map((w) => (caller.pinned?.itemId === w.id ? { ...w, current: true } : w));
  return { project: { id: project.id, name: project.name }, items };
}

function createWorkItem(ctx: AppContext, caller: Caller, args: Record<string, unknown>): unknown {
  const project = resolveProject(ctx, caller, args.project);
  if (!str(args.title, 300).trim()) throw new ToolError("a work item needs a title — one line saying what is to be done");
  const row = newItemRow(project.id, args.title, args.notes);
  ctx.db.insertItem(row);
  ctx.events.emit(project.id, { kind: "items" });
  return {
    created: true,
    project: { id: project.id, name: project.name },
    item: itemDto(row),
    hint: "It is in the project's list now. Nobody is on it: a teammate is assigned by starting a conversation on it from the workbench.",
  };
}

function updateWorkItem(ctx: AppContext, caller: Caller, args: Record<string, unknown>): unknown {
  const id = str(args.item, 64).trim();
  if (!id) throw new ToolError("which work item? pass the `item` id from list_work_items");
  const item = ctx.db.getItem(id);
  if (!item) throw new ToolError(`no work item ${id}`);
  const project = projectOf(ctx, caller, item);

  const patch: Partial<Pick<ItemRow, "title" | "notes">> = {};
  if (typeof args.title === "string") {
    const title = str(args.title, 300).trim();
    if (!title) throw new ToolError("a work item needs a title");
    patch.title = title;
  }
  if (typeof args.notes === "string") patch.notes = str(args.notes, 20000);
  if (Object.keys(patch).length === 0) throw new ToolError("nothing to change — pass title, notes, or both");

  ctx.db.updateItem(item.id, patch);
  ctx.events.emit(project.id, { kind: "items" });
  return { updated: true, project: { id: project.id, name: project.name }, item: itemDto(ctx.db.getItem(item.id)!) };
}

// ── naming a project ─────────────────────────────────────────────────────

/** An id or a name resolved against what the caller can reach; the pinned project admits only itself. */
function resolveProject(ctx: AppContext, caller: Caller, ref: unknown): ProjectRow {
  const wanted = str(ref, 200).trim();
  if (caller.pinned) {
    const p = caller.pinned.project;
    if (wanted && wanted !== p.id && wanted.toLowerCase() !== p.name.toLowerCase()) {
      throw new ToolError(`this conversation is in ${label(p)} and cannot reach another project`);
    }
    return p;
  }
  const rows = ctx.db.projectsFor(caller.user.email);
  if (rows.length === 0) throw new ToolError("you are not in any project on this workbench yet");
  if (!wanted) {
    if (rows.length === 1) return rows[0]!;
    throw new ToolError(`name a project: ${rows.map(label).join(", ")}`);
  }
  const byId = rows.find((p) => p.id === wanted);
  if (byId) return byId;
  const lower = wanted.toLowerCase();
  const exact = rows.filter((p) => p.name.toLowerCase() === lower);
  const near = exact.length > 0 ? exact : rows.filter((p) => p.name.toLowerCase().includes(lower));
  if (near.length === 1) return near[0]!;
  if (near.length > 1) throw new ToolError(`${JSON.stringify(wanted)} matches ${near.map(label).join(", ")} — name one by id`);
  throw new ToolError(`no project called ${JSON.stringify(wanted)}; you are in ${rows.map(label).join(", ")}`);
}

/** The project of an item the caller named. One they cannot reach reads as one that is not there. */
function projectOf(ctx: AppContext, caller: Caller, item: ItemRow): ProjectRow {
  if (caller.pinned) {
    if (caller.pinned.project.id !== item.project_id) throw new ToolError(`work item ${item.id} is in another project; this conversation is in ${label(caller.pinned.project)}`);
    return caller.pinned.project;
  }
  const project = ctx.db.getProject(item.project_id);
  if (!project || !ctx.db.roleIn(item.project_id, caller.user.email)) throw new ToolError(`no work item ${item.id}`);
  return project;
}

function label(p: ProjectRow): string {
  return `${p.name} (${p.id})`;
}

// ── JSON-RPC ─────────────────────────────────────────────────────────────

/** Something the agent got wrong: it comes back as a tool result it can read and retry, not a protocol error. */
class ToolError extends Error {}

function rpcResult(id: string | number | null, result: unknown): Response {
  return json({ jsonrpc: "2.0", id, result });
}

function rpcError(id: string | number | null, code: number, message: string): Response {
  return json({ jsonrpc: "2.0", id, error: { code, message } });
}

function content(value: unknown): unknown {
  return { content: [{ type: "text", text: JSON.stringify(value) }], isError: false };
}

function toolError(message: string): unknown {
  return { content: [{ type: "text", text: message }], isError: true };
}
