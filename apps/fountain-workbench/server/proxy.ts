/**
 * The project-scoped Fountain proxy: `/f/<project>/api/...` is the Fountain
 * API as seen from inside one project, on the owner's key, narrowed to that
 * project's conversations.
 *
 * A member's browser builds an ordinary SDK client with this as its base
 * URL and never holds a Fountain key. What it can reach:
 *
 *   GET  /api/conversations                 the owner's list, only `workbench:<project>/…`, less the
 *                                           computers their work items have removed (server/projects.ts)
 *   POST /api/conversations                 start one; channel must name an item of this project and is
 *                                           re-minted per conversation; environment and vault are the project's;
 *                                           a sandbox_id must be a computer of that same item, same teammate
 *   *    /api/conversations/:id/…           get, turns, events, prompts (images checked against
 *                                           Fountain's rules), read, interrupt, terminate, requests,
 *                                           tree, stream, a turn's image bytes, egress (the broker's
 *                                           record of what its sandbox reached) — after checking :id
 *                                           is in the project
 *   GET  /api/sandboxes/:id                 one computer, if a conversation of the project is on it
 *   GET  /api/sandboxes/:id/{files,file,diff}  its disk, read by Fountain (ADR 0039), if it is that computer
 *   GET  /api/search                        full text, cut down to hits in this project's conversations,
 *                                           and — unless one conversation is named — less the removed ones
 *   GET  /api/agents, /api/agents/:id/avatar  the owner's agents (the team), with the values of
 *                                           every MCP server's `env` and `headers` withheld, every
 *                                           inline skill's body withheld, and — for a member —
 *                                           the owner's prose (`system`, `metadata`) withheld too
 *   GET  /api/environments, /api/vaults     the owner sees all; a member sees the project's
 *   GET  /api/events/stream                 the owner's stream, filtered to the project, plus
 *                                           `event: workbench` when items or settings change
 *
 * Everything else is 404. The conversation → tree-position map is cached,
 * since a `channel_id` does not change.
 *
 * A removed computer is left out of the listing and the palette, and that is
 * as far as it goes: a conversation that ran on one is not deleted, so its own
 * routes still answer and its link still opens. The stream needs no rule of
 * its own — removing a computer retires it first (server/projects.ts), and a
 * retired conversation has nothing left to say.
 */
import { channelPrefix, newConversationChannel, parseChannel } from "../shared/channel";
import { computerKey, removedKey } from "../shared/computers";
import { imagesProblem } from "../shared/images";
import { authenticate, ownerClient, projectAccess, type AppContext } from "./context";
import type { ProjectRow, Role } from "./db";
import type { ConversationSummary, FountainClient, SearchHit } from "./fountain";
import { HttpError, json, readJson } from "./http";
import { addTeammate, reconcileItems } from "./projects";

const CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * conversation id → where it sits in the workbench tree (a null project: none
 * of ours), with when we learned it. The item and the computer ride along
 * because `search` has to drop hits on a computer the item has removed, and a
 * hit carries nothing but an id; every listing refreshes the lot, so the
 * placement is as fresh as the last time anybody looked at the project.
 */
const convProject = new Map<string, { projectId: string | null; itemId: string | null; key: string; at: number }>();

function remember(c: ConversationSummary): void {
  const ref = parseChannel(c.channel_id);
  convProject.set(c.id, { projectId: ref?.projectId ?? null, itemId: ref?.itemId ?? null, key: computerKey(c), at: Date.now() });
}

/** For tests: forget every cached conversation. */
export function resetProxyCache(): void {
  convProject.clear();
  sandboxProject.clear();
}

/** Whether we still trust what we know about this conversation. */
function known(conversationId: string): boolean {
  const hit = convProject.get(conversationId);
  return !!hit && Date.now() - hit.at < CACHE_TTL_MS;
}

async function belongs(client: FountainClient, projectId: string, conversationId: string): Promise<boolean> {
  const hit = convProject.get(conversationId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.projectId === projectId;
  const c = await client.conversation(conversationId);
  if (!c) {
    convProject.set(conversationId, { projectId: null, itemId: null, key: "", at: Date.now() });
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
    // A prompt's images are judged here, on the way in: the request goes on
    // over the owner's key, so what the proxy admits is the workbench's to say.
    if (method === "POST" && sub === "/prompts") {
      const body = await readJson(req);
      checkImages(body.images);
      return forward(client, req, path, url.search, JSON.stringify(body));
    }
    return forward(client, req, path, url.search);
  }

  const sandbox = /^\/api\/sandboxes\/([^/]+)$/.exec(path);
  if (sandbox && method === "GET") return showSandbox(scope, decodeURIComponent(sandbox[1]!));

  // The disk of one of the project's computers, read by Fountain: a directory,
  // a file, or `git diff` (ADR 0039). Full-scope only upstream, which the
  // owner's key is; the sandbox's own key could not make this call, so the
  // proxy is the one door. Fountain redacts the sandbox's secrets on the way
  // out and refuses to wake a parked machine; both pass through as they are.
  const disk = /^\/api\/sandboxes\/([^/]+)\/(files|file|diff)$/.exec(path);
  if (disk && method === "GET") {
    if (!(await sandboxBelongs(scope, decodeURIComponent(disk[1]!)))) throw new HttpError(404, "not_found", "No such computer in this project.");
    return forward(client, req, path, url.search);
  }

  if (method === "GET" && path === "/api/search") return search(ctx, scope, url);

  if (method === "GET" && path === "/api/agents") {
    const res = await forward(client, req, path, url.search);
    if (!res.ok) return res;
    const body = (await res.json()) as { data?: unknown[] };
    return json({ ...body, data: (body.data ?? []).map((a) => visibleAgent(a, role)) }, res.status);
  }

  if (method === "GET" && /^\/api\/agents\/[^/]+\/avatar$/.test(path)) {
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

// ── agents ───────────────────────────────────────────────────────────────

/** What a value the workbench will not pass on is replaced with, so the shape survives and the value does not. */
const WITHHELD = "[withheld by the workbench]";

/**
 * An agent shaped by the rules that have **no role in them** — what nobody
 * gets out of this workbench, whoever is asking. Two questions, two answers:
 *
 *   *Is this a secret?* — `mcp_servers[*].env` and `.headers`. Nobody sees the
 *   values, owner included; see `withoutMcpSecrets`.
 *
 *   *Does any page need it?* — `skills[*].content`, the whole SKILL.md body of
 *   every inline skill. Nothing renders it: the panel lists a skill by name
 *   (`skillsOf` in `src/lib/details.ts` reads `name`, `source` and `ref`), and
 *   this list is refetched on every project mount (`refreshResources`). A few
 *   kilobytes per skill per agent per page load, for a field with no reader, is
 *   not a payload the workbench should be moving. If the panel later wants to
 *   show a body — it is a fair thing to want — it should come back on a route
 *   of its own, asked for when a skill is expanded, and that route gets to
 *   decide who may read it on its own terms.
 *
 * This is a function of its own, and exported, because these two are not the
 * proxy's to keep. `GET /api/me/resources` (`server/auth.ts`) is the second way
 * out of Fountain's agent rendering — the create-project form needs the
 * caller's own agents before there is a project to ask through — and it is the
 * caller's own key, so `visibleAgent`'s role rule does not apply to it while
 * both of these do. That route was written as `withoutMcpSecrets` alone and
 * therefore shipped every skill body for a day: a rule spread over two call
 * sites is a rule one of them can be missing. Naming the set is what makes a
 * third route inherit it rather than reassemble it.
 */
export function agentForEveryone(agent: unknown): unknown {
  const out = withoutMcpSecrets(agent);
  if (!isRecord(out)) return out;
  return { ...out, ...withoutSkillBodies(out.skills) };
}

/**
 * An agent as *this reader* may see it: the rules above, plus the one that
 * does turn on who is asking.
 *
 *   *Is this the owner's to hand out?* — `system` and `metadata`. A member is
 *   a member of one *project*, but this route is the owner's whole account:
 *   the team picker needs agents that do not fit this project, so the list is
 *   forwarded unfiltered. Sharing one project therefore hands over the standing
 *   instructions of every agent on the account, including ones no project of
 *   yours uses, which is wider than what a person thinks they are sharing when
 *   they type an email into Settings & sharing. So a member gets the teammate —
 *   name, model, runtime, which skills and which servers — and not the owner's
 *   prose. The owner sees their own account whole, exactly as the environments
 *   and vaults rule below already has it.
 *
 * The role here is deliberate and is not a softening of the other two rules'
 * refusal to have one. A credential in `headers` is a secret from everyone and
 * the owner reading it back changes nothing; a system prompt is the owner's own
 * writing, and withholding it from the person who wrote it would buy nothing
 * they could not get from Fountain with their own key.
 */
function visibleAgent(agent: unknown, role: Role): unknown {
  const shaped = agentForEveryone(agent);
  if (role === "owner" || !isRecord(shaped)) return shaped;
  const out: Record<string, unknown> = { ...shaped };
  for (const field of ["system", "metadata"]) if (field in out) out[field] = WITHHELD;
  return out;
}

/**
 * The `skills` of an agent with every inline body replaced, or nothing to
 * merge when there are none. The entry keeps its `name`, and keeps the absence
 * of a `source` that is what marks it inline — so the panel still tells an
 * inline skill from a github one, and still says which.
 */
function withoutSkillBodies(skills: unknown): { skills?: unknown } {
  if (!Array.isArray(skills)) return {};
  return { skills: skills.map((s) => (isRecord(s) && "content" in s ? { ...s, content: WITHHELD } : s)) };
}

/**
 * An agent, with the parts of its MCP configuration that are *designed* to
 * carry credentials taken out: the values of every server's `env` and
 * `headers`. The names stay, because the names are what a reader is asking
 * about — "what is this teammate plugged into" — and the values are what
 * nobody outside Fountain needs.
 *
 * This is a boundary and not a display choice. `GET /api/agents` is the
 * owner's agents as Fountain renders them (`FountainWeb.AgentJSON.data/1`),
 * and it renders `mcp_servers` whole — so an MCP server configured the way
 * this repo's own README configures one, with `Authorization: Bearer ftn_…`
 * in its headers, put the owner's Fountain key in every member's browser the
 * moment the member opened the project. Nothing read the field, so nothing
 * showed it; the details panel reads it now, which is what made an
 * already-crossed line visible. The fix belongs here rather than in the
 * panel: the proxy is the boundary, and a member's browser should not hold
 * what it must not show.
 *
 * The owner is not exempt. Their own key would read these from Fountain
 * directly, so exempting them buys nothing and costs the one rule — and a
 * rule with a role in it is one an later route can forget to apply. (One of
 * the rules in `visibleAgent` does have a role in it, for a reason said
 * there: it is answering a different question than this one.)
 *
 * Every route that hands an agent out reaches this through `agentForEveryone`
 * rather than calling it directly, so that "what nobody gets" stays one set.
 *
 * What this does **not** claim: a credential written into an `args` entry or
 * a query string on a `url` still passes, because those fields are the
 * server's identity and blanking them would leave the panel unable to say
 * what is plugged in at all. The two fields cut here are the two that exist
 * to hold secrets; the rest is a config a reader has to be able to read.
 */
function withoutMcpSecrets(agent: unknown): unknown {
  if (!isRecord(agent) || !isRecord(agent.mcp_servers)) return agent;
  const servers: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(agent.mcp_servers)) {
    if (!isRecord(entry)) {
      servers[name] = entry;
      continue;
    }
    const out: Record<string, unknown> = { ...entry };
    for (const field of ["env", "headers"]) if (field in out) out[field] = blankValues(out[field]);
    servers[name] = out;
  }
  return { ...agent, mcp_servers: servers };
}

/**
 * The values of a name → value map, blanked. Fountain stores these as Claude's
 * own map, but `Fountain.Runtimes.ACP.name_value_list/1` also accepts the
 * `[{name, value}]` list ACP delivers, so a row written that way is blanked
 * too rather than passed through the gap between the two shapes.
 */
function blankValues(v: unknown): unknown {
  if (Array.isArray(v)) return v.map((e) => (isRecord(e) && "value" in e ? { ...e, value: WITHHELD } : e));
  if (isRecord(v)) return Object.fromEntries(Object.keys(v).map((k) => [k, WITHHELD]));
  return v;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** The images on a prompt must be ones Fountain would take, said here rather than as a 422 from there. */
function checkImages(images: unknown): void {
  const problem = imagesProblem(images);
  if (problem) throw new HttpError(422, "bad_images", problem);
}

function conversationRouteAllowed(method: string, sub: string, role: Role): boolean {
  if (sub === "" || sub === "/") return method === "GET" || (method === "DELETE" && role === "owner");
  // `/turns/:turn/images/:position` is the bytes of an image sent on a prompt,
  // which is how the transcript shows one back.
  // `/egress` is the broker's log of what the sandbox reached and which
  // credential went with it — names of secrets, never values — and every
  // member reads the transcript that made those requests, so every member
  // reads this. The account-wide binding config stays on the owner's side
  // of the line (`server/brokering.ts`).
  if (method === "GET") return ["/turns", "/events", "/tree", "/stream", "/egress"].includes(sub) || /^\/turns\/[^/]+\/images\/\d+$/.test(sub);
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
  // Reconciled before the removals are applied: a computer taken out of an
  // item does not take the item with it, and an item this database has never
  // heard of is still one to record.
  if (reconcileItems(ctx, project, mine)) ctx.events.emit(project.id, { kind: "items" });
  const removed = removedSet(ctx, project.id);
  return json({ ...body, data: removed.size === 0 ? mine : mine.filter((c) => !isRemoved(removed, c)) });
}

/** For a path that deliberately does not apply removals. */
const NO_REMOVALS: ReadonlySet<string> = new Set();

/** What this project has taken out of its tree, as `<item>\n<key>`. Empty for almost every project. */
function removedSet(ctx: AppContext, projectId: string): Set<string> {
  return new Set(ctx.db.removedInProject(projectId).map((r) => removedKey(r.item_id, r.key)));
}

/** Whether this conversation ran on a computer its work item has removed. */
function isRemoved(removed: ReadonlySet<string>, c: ConversationSummary): boolean {
  const itemId = parseChannel(c.channel_id)?.itemId;
  return !!itemId && removed.has(removedKey(itemId, computerKey(c)));
}

async function startConversation(ctx: AppContext, { project, client }: Scope, req: Request): Promise<Response> {
  const body = await readJson(req);
  const ref = parseChannel(typeof body.channel_id === "string" ? body.channel_id : null);
  if (!ref || ref.projectId !== project.id) throw new HttpError(422, "bad_channel", "A conversation must be started on one of this project's work items.");
  const item = ctx.db.getItem(ref.itemId);
  if (!item || item.project_id !== project.id) throw new HttpError(404, "not_found", "No such work item.");
  if (typeof body.agent_id !== "string" || !body.agent_id) throw new HttpError(422, "agent_required", "Pick a teammate.");

  // The computer is the project's: whatever the caller sent, the project decides.
  // The channel is this conversation's own (see shared/channel.ts): a shared one
  // would hand the binding to the newcomer and unbind the conversation before it.
  const out: Record<string, unknown> = {
    agent_id: body.agent_id,
    channel_id: newConversationChannel(project.id, item.id),
    fresh: true,
  };
  if (typeof body.title === "string") out.title = body.title;
  if (typeof body.prompt === "string" && body.prompt) out.prompt = body.prompt;
  if (body.images != null) {
    checkImages(body.images);
    if (Array.isArray(body.images) && body.images.length) out.images = body.images;
  }
  if (project.environment_id) out.environment_id = project.environment_id;
  if (project.vault_id) out.vault_id = project.vault_id;
  if (typeof body.sandbox_id === "string" && body.sandbox_id) {
    // Joining a computer: it must be one of this project's conversations' — same agent, same project.
    const convs = await client.conversations({ roots_only: "false" });
    for (const c of convs) remember(c);
    const host = convs.find((c) => c.sandbox_id === body.sandbox_id && parseChannel(c.channel_id)?.projectId === project.id);
    if (!host) throw new HttpError(404, "not_found", "That computer is not one of this project's.");
    if (host.agent_id !== body.agent_id) throw new HttpError(422, "agent_mismatch", "A computer is shared only by conversations of the same teammate.");
    // A computer belongs to the work item it was started for: the checkout and
    // the disk are that item's context. Fountain would share it by identity
    // alone; the workbench does not.
    if (parseChannel(host.channel_id)?.itemId !== item.id) throw new HttpError(422, "item_mismatch", "That computer belongs to another work item.");
    // Removed from the item, so not one of its computers any more. Nothing in
    // the app offers this, but the route is the boundary, not the button.
    if (removedSet(ctx, project.id).has(removedKey(item.id, body.sandbox_id))) {
      throw new HttpError(422, "computer_removed", "That computer was removed from this work item. Put it back first, or start a new one.");
    }
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

// ── sandboxes ────────────────────────────────────────────────────────────

/**
 * One computer, by id — the record the conversation list does not carry
 * (sprite name, status, which conversation is mid-turn). It is the
 * project's if any conversation on it is; the conversations listed on it
 * are narrowed to the project's.
 */
async function showSandbox({ project, client }: Scope, id: string): Promise<Response> {
  const res = await client.fetch(`/api/sandboxes/${encodeURIComponent(id)}`);
  const text = await res.text();
  if (!res.ok) return passthrough(res, text);
  const body = JSON.parse(text) as { data?: { conversations?: { id: string }[] } };
  const convs = body.data?.conversations ?? [];
  const mine: { id: string }[] = [];
  for (const c of convs) if (await belongs(client, project.id, c.id)) mine.push(c);
  if (mine.length === 0) throw new HttpError(404, "not_found", "No such computer in this project.");
  sandboxProject.set(id, { projectId: project.id, at: Date.now() });
  return json({ ...body, data: { ...body.data, conversations: mine } });
}

/** sandbox id → the project it was last found to belong to. A disk read should not cost a second upstream call every time. */
const sandboxProject = new Map<string, { projectId: string; at: number }>();

/** Whether a conversation of this project is on the computer — read off its record, cached briefly. */
async function sandboxBelongs({ project, client }: Scope, id: string): Promise<boolean> {
  const hit = sandboxProject.get(id);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.projectId === project.id;
  const res = await client.fetch(`/api/sandboxes/${encodeURIComponent(id)}`);
  if (!res.ok) return false;
  const body = (await res.json()) as { data?: { conversations?: { id: string }[] } };
  for (const c of body.data?.conversations ?? []) {
    if (await belongs(client, project.id, c.id)) {
      sandboxProject.set(id, { projectId: project.id, at: Date.now() });
      return true;
    }
  }
  return false;
}

// ── search ───────────────────────────────────────────────────────────────

/** Fountain's largest page, and how many of them we will read looking for this project's hits. */
const SEARCH_PAGE = 100;
const SEARCH_PAGES = 5;
/** What a caller may narrow by; `limit` and `offset` are ours, not theirs (see below). */
const SEARCH_FILTERS = ["agent_id", "since", "kinds"];

/**
 * Full-text search over this project's conversations.
 *
 * The decision this route turns on: search runs on the **owner's** key, so
 * Fountain answers for the owner's whole account — their other projects, and
 * personal conversations that have nothing to do with this one. A member must
 * see this project's hits and no others. Two ways to get there, and only one
 * of them scales:
 *
 *   *Scope on the way out.* `conversation_id` takes exactly one id, so "every
 *   conversation in this project" is one request per conversation — a fan-out
 *   per keystroke against the same rate limit, growing with the project. Right
 *   for one named conversation, which is why that case below does take this
 *   path and lets Fountain do the narrowing; no good for the palette.
 *
 *   *Filter on the way back.* One request, and the answer is cut down to the
 *   hits whose conversation is provably this project's. It is the rule `keep()`
 *   already applies to the owner's user-wide event stream, which crosses this
 *   proxy for the same reason and is filtered per record on the same authority
 *   — `belongs()`, which reads the conversation's own `channel_id`. Default
 *   deny: a hit whose conversation we cannot place is dropped, not passed.
 *
 * So: filter on the way back, and keep the one rule rather than a second one.
 * The owner's snippets reach this process, which already holds the owner's key
 * and can read anything with it; what matters is that they do not reach a
 * member, and only an id we have placed in this project gets past `keepHits`.
 *
 * What it costs is paging. Fountain's `limit` and `offset` count the owner's
 * hits, not this project's, so forwarding them would answer "nothing" to a
 * member whose first hit sits on the owner's fourth page. The proxy pages
 * upstream itself and serves its own window over what survives — and says
 * `has_more` when it stopped digging rather than pretending it reached the end.
 */
async function search(ctx: AppContext, { project, client }: Scope, url: URL): Promise<Response> {
  const q = url.searchParams.get("q") ?? "";
  if (!q.trim()) throw new HttpError(400, "bad_query", "Search for something.");
  // A transcript outlives the computer it was typed on, so a search is the
  // one way a removed computer could come back on screen. `keepHits` places
  // every hit it keeps, which is the same read that says which computer it
  // was on: dropping them here costs no extra request.
  const removed = removedSet(ctx, project.id);
  const limit = Math.min(Math.max(int(url.searchParams.get("limit"), 20), 1), SEARCH_PAGE);
  const offset = Math.max(int(url.searchParams.get("offset"), 0), 0);

  // Rebuilt, never forwarded as it came: a repeated `conversation_id` would
  // leave us checking the first and Fountain reading the last.
  const base = new URLSearchParams({ q });
  for (const k of SEARCH_FILTERS) {
    const v = url.searchParams.get(k);
    if (v) base.set(k, v);
  }

  // One conversation, named: check it is this project's and let Fountain scope
  // the query. Nothing outside the conversation is fetched at all.
  const only = url.searchParams.get("conversation_id");
  if (only) {
    if (!(await belongs(client, project.id, only))) throw new HttpError(404, "not_found", "No such conversation in this project.");
    base.set("conversation_id", only);
    base.set("limit", String(limit));
    base.set("offset", String(offset));
    const res = await client.fetch(`/api/search?${base}`);
    const text = await res.text();
    if (!res.ok) return passthrough(res, text);
    // Scoped by Fountain and checked again here, so that one rule governs
    // every hit that leaves this route and no path is exempt from it.
    //
    // Removals are not applied on this path, and that is the point of having
    // it: this is find-in-page inside one open conversation, and a removed
    // conversation is not deleted — its link still opens, so searching what
    // is on screen must still find it. The palette, which is a way of
    // *discovering* conversations, does apply them.
    const body = JSON.parse(text) as { data?: SearchHit[] };
    return json({ ...body, data: await keepHits(client, project.id, body.data ?? [], NO_REMOVALS) });
  }

  const wanted = offset + limit;
  const kept: SearchHit[] = [];
  let read = 0;
  let ended = false;
  for (let page = 0; page < SEARCH_PAGES && kept.length <= wanted; page++) {
    const qs = new URLSearchParams(base);
    qs.set("limit", String(SEARCH_PAGE));
    qs.set("offset", String(read));
    const res = await client.fetch(`/api/search?${qs}`);
    const text = await res.text();
    if (!res.ok) return passthrough(res, text);
    const body = JSON.parse(text) as { data?: SearchHit[]; meta?: { has_more?: boolean } };
    const hits = body.data ?? [];
    kept.push(...(await keepHits(client, project.id, hits, removed)));
    read += hits.length;
    if (hits.length === 0 || body.meta?.has_more !== true) {
      ended = true;
      break;
    }
  }

  return json({ data: kept.slice(offset, wanted), meta: { limit, offset, has_more: kept.length > wanted || !ended } });
}

/**
 * The hits this project may see. A hit carries a `conversation_id` and nothing
 * else we can trust, so each one is placed by `belongs()` — the same authority
 * the conversation routes and the stream use — and dropped unless it lands in
 * this project.
 *
 * Placing them one at a time would be a request per hit against the owner's
 * whole account, so the first id we do not already know warms every id at once
 * off the conversation list; after that the checks are cache hits.
 */
async function keepHits(client: FountainClient, projectId: string, hits: SearchHit[], removed: ReadonlySet<string>): Promise<SearchHit[]> {
  let primed = false;
  const out: SearchHit[] = [];
  for (const hit of hits) {
    const id = hit?.conversation_id;
    if (typeof id !== "string" || !id) continue;
    if (!primed && !known(id)) {
      for (const c of await client.conversations({ roots_only: "false" })) remember(c);
      primed = true;
    }
    if (!(await belongs(client, projectId, id))) continue;
    // Placed by the line above, so the tree position is there to read.
    const at = convProject.get(id);
    if (removed.size > 0 && at?.itemId && removed.has(removedKey(at.itemId, at.key))) continue;
    out.push(hit);
  }
  return out;
}

function int(v: string | null, fallback: number): number {
  const n = Number(v);
  return v !== null && Number.isFinite(n) ? Math.trunc(n) : fallback;
}

// ── forwarding ───────────────────────────────────────────────────────────

/**
 * Send the request on as it is — method, query, body, accept — and hand the
 * answer back, streamed. A read follows the browser's abort (a closed
 * stream should not hold a Fountain connection); a mutation does not — a
 * terminate that Fountain is half-way through must finish whether or not
 * the tab that asked for it is still waiting.
 *
 * `sendBody` replaces the request's own, for a route that had to read it to
 * check it (a prompt's images) and so cannot hand the stream on.
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
  for (const h of ["content-type", "cache-control", "content-disposition"]) {
    const v = res.headers.get(h);
    if (v) out.set(h, v);
  }
  // 204 and friends may not carry a body, even an empty stream.
  const bodyless = res.status === 204 || res.status === 205 || res.status === 304;
  return new Response(bodyless ? null : res.body, { status: res.status, headers: out });
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
