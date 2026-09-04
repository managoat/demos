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
  // Which remote MCP servers the owner has already authorized, and where they
  // would go to authorize another. Owner-only rather than in READ_PATHS: a
  // connection carries `account_email`, which is the owner's identity at a
  // third party and nobody else's business. Nothing is lost — a guest's Machine
  // panel renders no editors at all.
  //
  // Read, and only read. Paddock does not POST /api/connection-providers, even
  // though creating one from a `dcr: true` catalog entry would turn "connect
  // Sentry" into two clicks: that call makes account-level state, and the rule
  // this file is built on is that the owner's authority *here* stops at their
  // own machine. Widening it for convenience would make the paragraph at the
  // top of this file untrue, and the paragraph is load-bearing.
  { method: "GET", re: /^\/api\/connections$/ },
  { method: "GET", re: /^\/api\/connections\/providers$/ },
];

export async function handleProxy(ctx: AppContext, req: Request, paddockId: string, path: string, id: Identity): Promise<Response> {
  const { paddock, role, tabs: allowed } = paddockAccess(ctx, id, paddockId);
  const client = await ownerClient(ctx, paddock);
  const method = req.method.toUpperCase();
  const url = new URL(req.url);

  // ── the tab strip ───────────────────────────────────────────────────────
  // Filtered, always. The owner's raw conversation list would show a guest
  // every other conversation on the account, which is nobody's business here.
  if (method === "GET" && path === "/api/conversations") {
    const tabs = await visibleTabs(client, allowed);
    return jsonRes({ data: tabs.map((t) => t.conversation) });
  }

  if (method === "POST" && path === "/api/conversations") {
    // Whose machine gets another terminal on it is the owner's call. An
    // invitation names one tab, so somebody holding one has no business
    // creating a second — and a guest making tabs on a stranger's box is
    // exactly the thing an anonymous link should not buy.
    if (role !== "owner") throw new HttpError(403, "owner_only", "Only the owner of this machine can open a tab on it.");
    return newConversation(ctx, req, paddock, client, id);
  }

  // ── one tab ─────────────────────────────────────────────────────────────
  const m = /^\/api\/conversations\/([^/]+)(\/.*)?$/.exec(path);
  if (m) {
    const conversationId = decodeURIComponent(m[1]!);
    const sub = m[2] ?? "";
    const tabs = await visibleTabs(client, allowed);
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
async function machineOf(
  client: FountainClient,
): Promise<{ agentId: string; sandboxId: string; environmentId: string | null; vaultId: string | null; all: ConversationSummary[] } | null> {
  let all: ConversationSummary[];
  try {
    all = await client.listConversations();
  } catch (err) {
    throw asHttpError(err, "find this machine");
  }
  const newest = all
    .filter((c) => c.sandbox_id && c.agent_id && c.channel_id?.startsWith("paddock:") && ["pending", "idle", "running"].includes(c.status))
    .sort((a, b) => b.inserted_at.localeCompare(a.inserted_at))[0];
  return newest
    ? {
        agentId: newest.agent_id!,
        sandboxId: newest.sandbox_id!,
        environmentId: newest.environment_id ?? null,
        vaultId: newest.vault_id ?? null,
        all,
      }
    : null;
}

/**
 * The tabs this caller may see. Ops is excluded from everyone, and anybody
 * who is not the owner sees only the tabs they were invited to — `allowed`
 * comes from `paddockAccess`, which is the one place that decides it.
 */
async function visibleTabs(client: FountainClient, allowed: string[] | null): Promise<Tab[]> {
  const machine = await machineOf(client);
  if (!machine) return [];
  const conversations = machine.all as unknown as Parameters<typeof tabsOf>[0];
  // `rev` only decides staleness in the UI, which the proxy has no opinion
  // about; 0 keeps every tab in the set rather than fetching the agent for a
  // number nothing here reads.
  const tabs = tabsOf(conversations, { sandboxId: machine.sandboxId, agentId: machine.agentId, rev: 0, workRoot: WORK_ROOT });
  const ops = opsTab(tabs);
  return tabs.filter((t) => t !== ops && (allowed === null || allowed.includes(t.conversation.id)));
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

  // Whether to name the sender is a question about *this tab*: a machine with
  // somebody in Terminal 2 does not need Terminal 1 labelling its own turns.
  const alone =
    ctx.db.members(paddock.id, tab.conversation.id).length === 0 && ctx.db.guests(paddock.id, tab.conversation.id).length === 0;
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
async function newConversation(ctx: AppContext, req: Request, paddock: PaddockRow, client: FountainClient, id: Identity): Promise<Response> {
  const body = await readJson(req);
  const channel = str(body.channel_id, 200);
  if (!channel.startsWith("paddock:")) throw new HttpError(422, "bad_channel", "A tab needs a paddock channel id.");
  const machine = await machineOf(client);

  if (!machine) {
    // First run: forwarded as the client built it, so the persistent-mode and
    // environment/vault choices stay in one place (shared/spec + identity).
    return forward(client, req, "POST", "/api/conversations", JSON.stringify(body));
  }

  const res = await forward(
    client,
    req,
    "POST",
    "/api/conversations",
    JSON.stringify({
      agent_id: machine.agentId,
      sandbox_id: machine.sandboxId,
      // The whole identity, not half of it. A disk is built for
      // `(agent, environment, vault)` and an attach that names only the agent
      // is asking for a *different* identity — one with no environment and no
      // vault — which Fountain refuses as `sandbox_identity_mismatch`. Sending
      // only the agent is exactly what broke opening a second tab, and it is
      // why fountain-team's openThread bothers to pass these through.
      ...(machine.environmentId ? { environment_id: machine.environmentId } : {}),
      ...(machine.vaultId ? { vault_id: machine.vaultId } : {}),
      title: str(body.title, 200) || undefined,
      channel_id: channel,
    }),
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

  // A refusal from Fountain reaches the browser intact but left no trace here,
  // which made a 422 on "start my machine" a guessing game. Log it: the status,
  // the call, and whatever Fountain said. Never the body we sent — it can carry
  // a secret value on its way to /secrets/:key.
  if (res.status >= 400 && type?.includes("application/json") && !expected(res.status, target)) {
    void res
      .clone()
      .text()
      .then((text) => console.error(`paddock: fountain ${res.status} on ${method} ${target}: ${text.slice(0, 500)}`))
      .catch(() => undefined);
  }
  return new Response(res.body, { status: res.status, headers });
}

/**
 * Failures that are not failures, and would only teach a reader to skim.
 *
 * A machine with no receipt yet is the ordinary first state — `readReceipt`
 * treats that 404 as "the box has not said" and the panel renders it as such.
 * Logging it as a refusal would put a line in the log on every poll.
 */
function expected(status: number, target: string): boolean {
  return status === 404 && /^\/api\/sandboxes\/[^/]+\/file\?/.test(target);
}

function jsonRes(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json; charset=utf-8" } });
}
