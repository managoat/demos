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
 *      An owner with several computers makes that question sharper, not
 *      different: the list is first narrowed to the conversations whose
 *      channel names *this* paddock (`belongsTo`), so `/f/<a>/…` can never
 *      reach a tab on computer B — which matters most for the people invited
 *      to computer A, who have no business knowing B exists.
 *
 *   2. **The ops tab is excluded explicitly.** It is the tab paddock changes
 *      the machine through, so a guest who could prompt it would route around
 *      every permission below by simply asking.
 *
 *   4. **An unclaimed computer may be built and used, not changed.** A visitor
 *      who has not registered yet is the owner of a real machine on a real
 *      tenant (issue #14), and gets Terminal 1, the files and the box's own
 *      state. A second terminal, terminating one, and every write to the
 *      config surface wait for the claim — because until then the machine runs
 *      on this application's money under no account anybody can be held to.
 *
 *      The line is drawn at *build versus change* rather than at a list of
 *      paths, because first run has to write the same records the Setup panel
 *      does: the agent, the environment and the vault are all created before
 *      the machine exists. So the gate asks whether there is a machine yet,
 *      which is a question with one answer and no list to keep in step.
 *
 *   3. **Everything is an allowlist.** Unlisted method/path pairs are 404.
 *      Reading the machine's config is open to the paddock; changing it is the
 *      owner's alone. Even for the owner it is a list of shapes rather than
 *      "anything under /api" — forwarding freely would hand their whole
 *      Fountain account to anything that could script their browser, and the
 *      owner's authority here stops at their own machine.
 */
import { belongsTo, opsTab, parseChannel, tabsOf, type Tab } from "../shared/tabs";
import { WORK_ROOT } from "../shared/spec";
import { withAuthor } from "../shared/author";
import { actorLabel, ownerClient, paddockAccess, requireClaimed, type AppContext, type Identity } from "./context";
import type { PaddockRow, Role } from "./db";
import { asHttpError, type ConversationSummary, type FountainClient } from "./fountain";
import { HttpError, readJson, str } from "./http";
import { withPromptLock } from "./prompt-lock";
import { hub } from "./hub";

/** What a role may do to one tab. Anything absent is a 404. */
function tabAllowed(method: string, sub: string, role: Role, claimed: boolean): boolean {
  if (method === "GET") {
    return sub === "" || sub === "/turns" || sub === "/events" || sub === "/stream" || /^\/turns\/[^/]+\/images\/[^/]+$/.test(sub);
  }
  if (method !== "POST") return false;
  if (sub === "/prompts" || sub === "/interrupt" || sub === "/read") return true;
  // Ending a tab ends it for everybody on the machine. The owner's call — and
  // on an unclaimed computer there is exactly one tab, so ending it would be
  // ending the only thing the visitor came for.
  if (sub === "/terminate") return role === "owner" && claimed;
  return false;
}

/**
 * Reading the machine's configuration: everyone in the paddock.
 *
 * A guest sees the Details panel and no Setup, which means they see repository
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
 * the calls the Details and Setup panels and first-run make, and no others — forwarding
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
  const { paddock, role, original, tabs: allowed, claimed } = paddockAccess(ctx, id, paddockId);
  const client = await ownerClient(ctx, paddock);
  const method = req.method.toUpperCase();
  const url = new URL(req.url);
  const here = { id: paddock.id, original };

  // ── the tab strip ───────────────────────────────────────────────────────
  // Filtered, always. The owner's raw conversation list would show a guest
  // every other conversation on the account, which is nobody's business here.
  if (method === "GET" && path === "/api/conversations") {
    const tabs = await visibleTabs(client, here, allowed);
    return jsonRes({ data: tabs.map((t) => t.conversation) });
  }

  if (method === "POST" && path === "/api/conversations") {
    // Whose machine gets another terminal on it is the owner's call. An
    // invitation names one tab, so somebody holding one has no business
    // creating a second — and a guest making tabs on a stranger's box is
    // exactly the thing an anonymous link should not buy.
    if (role !== "owner") throw new HttpError(403, "owner_only", "Only the owner of this machine can open a tab on it.");
    return newConversation(ctx, req, paddock, here, client, id, claimed);
  }

  // ── one tab ─────────────────────────────────────────────────────────────
  const m = /^\/api\/conversations\/([^/]+)(\/.*)?$/.exec(path);
  if (m) {
    const conversationId = decodeURIComponent(m[1]!);
    const sub = m[2] ?? "";
    const tabs = await visibleTabs(client, here, allowed);
    const tab = tabs.find((t) => t.conversation.id === conversationId);
    if (!tab) throw new HttpError(404, "not_found", "No such tab on this machine.");
    if (!tabAllowed(method, sub, role, claimed)) throw new HttpError(404, "not_found");
    if (method === "POST" && sub === "/prompts") return prompt(ctx, req, paddock, client, tab, id);
    return forward(client, req, method, `/api/conversations/${encodeURIComponent(conversationId)}${sub}${url.search}`, method === "POST" ? "{}" : null);
  }

  // ── reading the machine ─────────────────────────────────────────────────
  // Everyone in the paddock, but only *this* paddock's box. Fountain would
  // happily serve any sandbox the owner's key can see.
  const sb = /^\/api\/sandboxes\/([^/]+)(\/(?:files|file|diff))?$/.exec(path);
  if (sb && method === "GET") {
    const boxId = decodeURIComponent(sb[1]!);
    const owner = await machineOf(client, here);
    if (!owner || boxId !== owner.sandboxId) throw new HttpError(404, "not_found", "That is not this machine.");
    return forward(client, req, method, `${path}${url.search}`, null);
  }

  // ── the config surface ──────────────────────────────────────────────────
  if (READ_PATHS.some((p) => p.method === method && p.re.test(path))) {
    return forward(client, req, method, `${path}${url.search}`, null);
  }
  if (OWNER_PATHS.some((p) => p.method === method && p.re.test(path))) {
    if (role !== "owner") throw new HttpError(404, "not_found");
    // Reading is never gated — the Details panel is honest about a machine
    // whoever is looking at it cannot yet change. Writing is, and only until
    // the machine exists: see `requireBuildable`.
    if (method !== "GET") await requireBuildable(client, here, claimed);
    const body = method === "GET" || method === "DELETE" ? null : await req.text();
    return forward(client, req, method, `${path}${url.search}`, body);
  }

  throw new HttpError(404, "not_found");
}

/**
 * Building an unclaimed computer is allowed. Changing one is not.
 *
 * First run creates the agent, the environment and the vault — the same three
 * records the Setup panel later mutates — so a gate written as a list of paths
 * would either block the machine from ever existing or leave the config
 * surface open. The question that separates them is whether there is a machine
 * yet, and `machineOf` already answers it from the conversation list, with no
 * state of its own to go stale.
 *
 * The consequence worth naming: a claimed computer never reaches this at all,
 * and an unclaimed one whose machine has ended may build another. That second
 * case is the same one the client's own restart path takes, and it has to
 * stay open or a box that stopped would strand the visitor.
 */
async function requireBuildable(client: FountainClient, here: Here, claimed: boolean): Promise<void> {
  if (claimed) return;
  if (await machineOf(client, here)) {
    throw new HttpError(403, "claim_required", "Claim this computer to change what it is made of.");
  }
}

// ── the machine, and the tabs on it ───────────────────────────────────────

/** Which computer a request is about, and whether it is the account's first. */
export interface Here {
  id: string;
  original: boolean;
}

/**
 * This computer's box and the agent behind it, from the owner's conversation
 * list alone — the newest live conversation whose channel names this paddock
 * gives both, exactly as the client's `findBox` does from the other side.
 * Nothing is stored, so nothing goes stale, and an account with four machines
 * needs no more state than an account with one.
 */
async function machineOf(
  client: FountainClient,
  here: Here,
): Promise<{ agentId: string; sandboxId: string; environmentId: string | null; vaultId: string | null; all: ConversationSummary[] } | null> {
  let all: ConversationSummary[];
  try {
    all = await client.listConversations();
  } catch (err) {
    throw asHttpError(err, "find this machine");
  }
  const newest = all
    .filter((c) => c.sandbox_id && c.agent_id && belongsTo(c.channel_id, here.id, here.original) && ["pending", "idle", "running"].includes(c.status))
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
async function visibleTabs(client: FountainClient, here: Here, allowed: string[] | null): Promise<Tab[]> {
  const machine = await machineOf(client, here);
  if (!machine) return [];
  const conversations = machine.all as unknown as Parameters<typeof tabsOf>[0];
  // `rev` only decides staleness in the UI, which the proxy has no opinion
  // about; 0 keeps every tab in the set rather than fetching the agent for a
  // number nothing here reads.
  const tabs = tabsOf(conversations, {
    paddock: { id: here.id, original: here.original },
    sandboxId: machine.sandboxId,
    agentId: machine.agentId,
    rev: 0,
    workRoot: WORK_ROOT,
  });
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
async function newConversation(
  ctx: AppContext,
  req: Request,
  paddock: PaddockRow,
  here: Here,
  client: FountainClient,
  id: Identity,
  claimed: boolean,
): Promise<Response> {
  const body = await readJson(req);
  const channel = str(body.channel_id, 200);
  // The channel is how every later request decides which computer this tab is
  // on, so a tab that named a different one would be a tab this paddock could
  // never see again — and one that computer's guests suddenly could.
  const parts = parseChannel(channel);
  if (!parts) throw new HttpError(422, "bad_channel", "A tab needs a paddock channel id.");
  if (parts.paddock !== here.id) throw new HttpError(422, "wrong_computer", "That channel names a different computer.");
  const machine = await machineOf(client, here);

  if (!machine) {
    // First run: forwarded as the client built it, so the persistent-mode and
    // environment/vault choices stay in one place (shared/spec + identity).
    return forward(client, req, "POST", "/api/conversations", JSON.stringify(body));
  }

  // Past first run this is a *second* terminal, which is the other side of the
  // same line: one machine is what an unclaimed computer is for, and every tab
  // after it is another thing running on somebody else's grant.
  requireClaimed({ claimed }, "open another terminal");

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
