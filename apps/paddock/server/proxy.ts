/**
 * The machine-scoped Fountain proxy: `/f/<paddock>/api/…` is that machine, on
 * the owner's key, for everyone in the paddock — and nothing else Fountain
 * can do.
 *
 * A guest's browser builds an ordinary client with this as its base URL and
 * never holds a key. Salon's equivalent admits exactly one conversation;
 * paddock has to admit a machine, which is a wider surface and therefore the
 * whole security question of this file. Three rules keep it honest:
 *
 *   1. **Tabs are derived, never stored.** The set of reachable conversations
 *      is `tabsOf` from `shared/tabs.ts` — the *same* function the client
 *      renders the tab strip with — run over the owner's conversation list.
 *      A second implementation of "is this a tab on that box?" would be a hole
 *      the day the two disagreed.
 *
 *   2. **The ops tab is excluded explicitly.** It is the tab paddock changes
 *      the machine through, so a guest who could prompt it would route around
 *      every permission below by simply asking.
 *
 *   3. **Everything is an allowlist.** Unlisted method/path pairs are 404.
 *      Reading the machine's config is open to the paddock; changing it is the
 *      owner's alone. Even for the owner it is a list of shapes rather than
 *      "anything under /api" — forwarding freely would hand their whole
 *      Fountain account to anything that could script their browser, and the
 *      owner's authority here stops at their own machine.
 */
import { opsTab, tabsOf, type Tab } from "../shared/tabs";
import { WORK_ROOT } from "../shared/spec";
import { withAuthor } from "../shared/author";
import { actorLabel, ownerClient, paddockAccess, type AppContext, type Identity } from "./context";
import type { PaddockRow, Role } from "./db";
import { asHttpError, type ConversationSummary, type FountainClient } from "./fountain";
import { HttpError, readJson, str } from "./http";
import { withPromptLock } from "./prompt-lock";
import { hub } from "./hub";

/** What a role may do to one tab. Anything absent is a 404. */
function tabAllowed(method: string, sub: string, role: Role): boolean {
  if (method === "GET") {
    return sub === "" || sub === "/turns" || sub === "/events" || sub === "/stream" || /^\/turns\/[^/]+\/images\/[^/]+$/.test(sub);
  }
  if (method !== "POST") return false;
  if (sub === "/prompts" || sub === "/interrupt" || sub === "/read") return true;
  // Ending a tab ends it for everybody on the machine. The owner's call.
  if (sub === "/terminate") return role === "owner";
  return false;
}

/**
 * Reading the machine's configuration: everyone in the paddock.
 *
 * A guest sees the Machine panel read-only, which means they see repository
 * URLs, package names and secret *key names* — never a value, because Fountain
 * does not serve values back to anyone. That is a deliberate call rather than
 * an oversight: a guest who can prompt the agent can already have it print
 * `env`, so hiding the names from the panel would buy nothing and would make
 * the panel lie about the machine they are on.
 */
const READ_PATHS: { method: string; re: RegExp }[] = [
  { method: "GET", re: /^\/api\/catalog$/ },
  { method: "GET", re: /^\/api\/agents\/[^/]+$/ },
  { method: "GET", re: /^\/api\/environments\/[^/]+$/ },
  { method: "GET", re: /^\/api\/(environments|vaults)\/[^/]+\/secrets$/ },
];

/**
 * Changing the machine, and finding out what the owner's account holds: the
 * owner alone.
 *
 * Deliberately a list of shapes rather than "anything under /api". These are
 * the calls the Machine panel and first-run make, and no others — forwarding
 * arbitrary paths for the owner would hand their whole Fountain account to
 * anything that could script their browser. Nothing here deletes an agent, an
 * environment or a vault; losing those loses the machine.
 */
const OWNER_PATHS: { method: string; re: RegExp }[] = [
  { method: "GET", re: /^\/api\/auth\/me$/ },
  { method: "GET", re: /^\/api\/agents$/ },
  { method: "POST", re: /^\/api\/agents$/ },
  { method: "PUT", re: /^\/api\/agents\/[^/]+$/ },
  { method: "GET", re: /^\/api\/environments$/ },
  { method: "POST", re: /^\/api\/environments$/ },
  { method: "PUT", re: /^\/api\/environments\/[^/]+$/ },
  { method: "GET", re: /^\/api\/vaults$/ },
  { method: "POST", re: /^\/api\/vaults$/ },
  { method: "PUT", re: /^\/api\/(environments|vaults)\/[^/]+\/secrets\/[^/]+$/ },
  { method: "DELETE", re: /^\/api\/(environments|vaults)\/[^/]+\/secrets\/[^/]+$/ },
];

export async function handleProxy(ctx: AppContext, req: Request, paddockId: string, path: string, id: Identity): Promise<Response> {
  const { paddock, role } = paddockAccess(ctx, id, paddockId);
  const client = await ownerClient(ctx, paddock);
  const method = req.method.toUpperCase();
  const url = new URL(req.url);

  // ── the tab strip ───────────────────────────────────────────────────────
  // Filtered, always. The owner's raw conversation list would show a guest
  // every other conversation on the account, which is nobody's business here.
  if (method === "GET" && path === "/api/conversations") {
    const tabs = await visibleTabs(client);
    return jsonRes({ data: tabs.map((t) => t.conversation) });
  }

  if (method === "POST" && path === "/api/conversations") return newConversation(ctx, req, paddock, client, id, role);

  // ── one tab ─────────────────────────────────────────────────────────────
  const m = /^\/api\/conversations\/([^/]+)(\/.*)?$/.exec(path);
  if (m) {
    const conversationId = decodeURIComponent(m[1]!);
    const sub = m[2] ?? "";
    const tabs = await visibleTabs(client);
    const tab = tabs.find((t) => t.conversation.id === conversationId);
    if (!tab) throw new HttpError(404, "not_found", "No such tab on this machine.");
    if (!tabAllowed(method, sub, role)) throw new HttpError(404, "not_found");
    if (method === "POST" && sub === "/prompts") return prompt(ctx, req, paddock, client, tab, id);
    return forward(client, req, method, `/api/conversations/${encodeURIComponent(conversationId)}${sub}${url.search}`, method === "POST" ? "{}" : null);
  }

  // ── reading the machine ─────────────────────────────────────────────────
  // Everyone in the paddock, but only *this* paddock's box. Fountain would
  // happily serve any sandbox the owner's key can see.
  const sb = /^\/api\/sandboxes\/([^/]+)(\/(?:files|file|diff))?$/.exec(path);
  if (sb && method === "GET") {
    const boxId = decodeURIComponent(sb[1]!);
    const owner = await machineOf(client);
    if (!owner || boxId !== owner.sandboxId) throw new HttpError(404, "not_found", "That is not this machine.");
    return forward(client, req, method, `${path}${url.search}`, null);
  }

  // ── the config surface ──────────────────────────────────────────────────
  if (READ_PATHS.some((p) => p.method === method && p.re.test(path))) {
    return forward(client, req, method, `${path}${url.search}`, null);
  }
  if (OWNER_PATHS.some((p) => p.method === method && p.re.test(path))) {
    if (role !== "owner") throw new HttpError(404, "not_found");
    const body = method === "GET" || method === "DELETE" ? null : await req.text();
    return forward(client, req, method, `${path}${url.search}`, body);
  }

  throw new HttpError(404, "not_found");
}

// ── the machine, and the tabs on it ───────────────────────────────────────

/**
 * The machine and the agent behind it, from the owner's conversation list
 * alone — the newest live paddock conversation names both, exactly as the
 * client's `findBox` does. Nothing is stored, so nothing goes stale.
 */
async function machineOf(client: FountainClient): Promise<{ agentId: string; sandboxId: string; all: ConversationSummary[] } | null> {
  let all: ConversationSummary[];
  try {
    all = await client.listConversations();
  } catch (err) {
    throw asHttpError(err, "find this machine");
  }
  const newest = all
    .filter((c) => c.sandbox_id && c.agent_id && c.channel_id?.startsWith("paddock:") && ["pending", "idle", "running"].includes(c.status))
    .sort((a, b) => b.inserted_at.localeCompare(a.inserted_at))[0];
  return newest ? { agentId: newest.agent_id!, sandboxId: newest.sandbox_id!, all } : null;
}

/** The tabs of this machine, as everyone in the paddock may see them: ops excluded. */
async function visibleTabs(client: FountainClient): Promise<Tab[]> {
  const machine = await machineOf(client);
  if (!machine) return [];
  const conversations = machine.all as unknown as Parameters<typeof tabsOf>[0];
  // `rev` only decides staleness in the UI, which the proxy has no opinion
  // about; 0 keeps every tab in the set rather than fetching the agent for a
  // number nothing here reads.
  const tabs = tabsOf(conversations, { sandboxId: machine.sandboxId, agentId: machine.agentId, rev: 0, workRoot: WORK_ROOT });
  const ops = opsTab(tabs);
  return tabs.filter((t) => t !== ops);
}

// ── turns ─────────────────────────────────────────────────────────────────

/**
 * A turn, from whoever sent it.
 *
 * Two things happen here that did not in phase 1. The prompt is tagged with
 * the sender once more than one person is in the paddock, so the transcript
 * can say `[from guest-7f3a]`; and the send goes through the paddock's lock,
 * so the order Fountain sees is the order people pressed Enter rather than
 * whatever the network decided. A box runs one turn at a time, so without the
 * lock the loser of a race just looks ignored.
 */
async function prompt(ctx: AppContext, req: Request, paddock: PaddockRow, client: FountainClient, tab: Tab, id: Identity): Promise<Response> {
  const body = await readJson(req);
  const text = str(body.prompt, 100_000);
  if (!text.trim()) throw new HttpError(422, "empty_prompt", "Say something.");

  const alone = ctx.db.members(paddock.id).length === 0 && ctx.db.guests(paddock.id).length === 0;
  const outgoing = alone ? text : withAuthor(actorLabel(id), text);

  return withPromptLock(paddock.id, async () => {
    const res = await forward(client, req, "POST", `/api/conversations/${encodeURIComponent(tab.conversation.id)}/prompts`, JSON.stringify({ prompt: outgoing }));
    if (res.ok) hub.publish(paddock.id, "turn", { conversationId: tab.conversation.id, by: actorLabel(id) });
    return res;
  });
}

/**
 * A new conversation: either the first one, which provisions the machine, or
 * another tab attached to the machine already there.
 *
 * The distinction is not the caller's to make. If a machine exists this is a
 * tab on it, with the agent and sandbox filled in here — which is what stops a
 * guest attaching a tab to a box that is not this paddock's. Only the owner
 * may take the other branch, because it spends money.
 */
async function newConversation(
  ctx: AppContext,
  req: Request,
  paddock: PaddockRow,
  client: FountainClient,
  id: Identity,
  role: Role,
): Promise<Response> {
  const body = await readJson(req);
  const channel = str(body.channel_id, 200);
  if (!channel.startsWith("paddock:")) throw new HttpError(422, "bad_channel", "A tab needs a paddock channel id.");
  const machine = await machineOf(client);

  if (!machine) {
    if (role !== "owner") throw new HttpError(409, "no_machine", "This machine is not running, and only its owner can start it.");
    // First run: forwarded as the client built it, so the persistent-mode and
    // environment/vault choices stay in one place (shared/spec + identity).
    return forward(client, req, "POST", "/api/conversations", JSON.stringify(body));
  }

  const res = await forward(
    client,
    req,
    "POST",
    "/api/conversations",
    JSON.stringify({ agent_id: machine.agentId, sandbox_id: machine.sandboxId, title: str(body.title, 200) || undefined, channel_id: channel }),
  );
  if (res.ok) {
    const created = (await res.clone().json()) as { data?: { id?: string } };
    if (created.data?.id) ctx.db.recordTabOpener(created.data.id, paddock.id, actorLabel(id));
    hub.publish(paddock.id, "tabs", { opened: created.data?.id ?? null, by: actorLabel(id) });
  }
  return res;
}

// ── plumbing ──────────────────────────────────────────────────────────────

/**
 * One call, on the owner's key, streamed straight back. `/stream` is SSE and
 * must not be buffered, so the body is passed through rather than read.
 */
async function forward(client: FountainClient, req: Request, method: string, target: string, body: string | null): Promise<Response> {
  let res: Response;
  try {
    res = await client.raw(method, target, { body, signal: req.signal, accept: req.headers.get("accept") ?? undefined });
  } catch (err) {
    throw asHttpError(err, "reach this machine");
  }
  const headers: Record<string, string> = {};
  const type = res.headers.get("content-type");
  if (type) headers["content-type"] = type;
  if (type?.includes("text/event-stream")) headers["cache-control"] = "no-cache";
  return new Response(res.body, { status: res.status, headers });
}

function jsonRes(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json; charset=utf-8" } });
}
