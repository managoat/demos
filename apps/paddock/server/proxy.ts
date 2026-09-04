/**
 * The machine-scoped Fountain proxy: `/f/<paddock>/api/conversations/<id>/…`
 * is one tab on that machine, on the owner's key, for everyone in the paddock.
 *
 * A guest's browser builds an ordinary client with this as its base URL and
 * never holds a Fountain key. Salon's equivalent admits exactly one
 * conversation; paddock has to admit **the set of live tabs on one box**, and
 * that is the whole security question of this file.
 *
 * The set is derived, never stored:
 *
 *     the owner's conversations
 *       → on this paddock's box (sandbox_id)
 *       → whose channel_id parses as paddock's (shared/tabs.ts)
 *       → live
 *       → minus the ops tab
 *
 * It uses `tabsOf` from `shared/tabs.ts` — the *same* function the client
 * renders the tab strip with — on purpose. A second implementation of "is
 * this a tab on that box?" would be a hole the day the two disagreed.
 *
 * The ops tab is excluded explicitly rather than by omission. It is the tab
 * paddock changes the machine through, so a guest who could prompt it would
 * route around every permission below by simply asking.
 */
import { opsTab, tabsOf, type Tab } from "../shared/tabs";
import { WORK_ROOT } from "../src/lib/spec";
import { actorLabel, ownerClient, paddockAccess, type AppContext, type Identity } from "./context";
import type { PaddockRow, Role } from "./db";
import { asHttpError, type FountainClient } from "./fountain";
import { HttpError, readJson, str } from "./http";
import { withPromptLock } from "./prompt-lock";
import { hub } from "./hub";
import { withAuthor } from "../shared/author";

/** What a role may do to a tab. Everything absent from here is a 404. */
function allowed(method: string, sub: string, role: Role): boolean {
  const read = sub === "" || sub === "/turns" || sub === "/events" || sub === "/stream" || /^\/turns\/[^/]+\/images\/[^/]+$/.test(sub);
  if (method === "GET") return read;
  if (method === "POST") {
    if (sub === "/prompts" || sub === "/interrupt" || sub === "/read") return true;
    // Ending a tab ends it for everybody on the machine. The owner's call.
    if (sub === "/terminate") return role === "owner";
    return false;
  }
  return false;
}

export async function handleProxy(ctx: AppContext, req: Request, paddockId: string, path: string, id: Identity): Promise<Response> {
  const { paddock, role } = paddockAccess(ctx, id, paddockId);
  const client = await ownerClient(ctx, paddock);
  const method = req.method.toUpperCase();
  const url = new URL(req.url);

  // Opening a tab is the one call that is not about an existing conversation.
  if (method === "POST" && path === "/api/conversations") return openTab(ctx, req, paddock, client, id);

  const m = /^\/api\/conversations\/([^/]+)(\/.*)?$/.exec(path);
  if (!m) throw new HttpError(404, "not_found");
  const conversationId = decodeURIComponent(m[1]!);
  const sub = m[2] ?? "";

  const tabs = await visibleTabs(client);
  const tab = tabs.find((t) => t.conversation.id === conversationId);
  if (!tab) throw new HttpError(404, "not_found", "No such tab on this machine.");
  if (!allowed(method, sub, role)) throw new HttpError(404, "not_found");

  if (method === "POST" && sub === "/prompts") return prompt(ctx, req, paddock, client, tab, id, tabs);

  const target = `/api/conversations/${encodeURIComponent(conversationId)}${sub}${url.search}`;
  try {
    const res = await client.raw(method, target, {
      body: method === "POST" ? "{}" : null,
      signal: req.signal,
      accept: req.headers.get("accept") ?? undefined,
    });
    // Streamed straight through: /stream is SSE and must not be buffered.
    return new Response(res.body, { status: res.status, headers: passthroughHeaders(res) });
  } catch (err) {
    throw asHttpError(err, "reach that tab");
  }
}

/**
 * The tabs of this paddock's machine, as everyone in it may see them.
 *
 * The box is found the same way the client finds it, from the owner's
 * conversation list, so there is no stored sandbox id to go stale.
 */
async function visibleTabs(client: FountainClient): Promise<Tab[]> {
  let all;
  try {
    all = await client.listConversations();
  } catch (err) {
    throw asHttpError(err, "list this machine's tabs");
  }
  const conversations = all as unknown as Parameters<typeof tabsOf>[0];
  const owner = agentAndBoxOf(conversations);
  if (!owner) return [];
  const tabs = tabsOf(conversations, { sandboxId: owner.sandboxId, agentId: owner.agentId, rev: owner.rev, workRoot: WORK_ROOT });
  const ops = opsTab(tabs);
  return tabs.filter((t) => t !== ops);
}

/**
 * The machine and the agent behind it, from the conversation list alone —
 * the newest live paddock conversation names both. `rev` is irrelevant to the
 * proxy (it only decides staleness in the UI) so it is left at 0 rather than
 * fetching the agent for a number nothing here reads.
 */
function agentAndBoxOf(conversations: Parameters<typeof tabsOf>[0]): { agentId: string; sandboxId: string; rev: number } | null {
  const live = [...conversations]
    .filter((c) => c.sandbox_id && c.agent_id && c.channel_id?.startsWith("paddock:"))
    .sort((a, b) => b.inserted_at.localeCompare(a.inserted_at));
  const newest = live[0];
  return newest ? { agentId: newest.agent_id!, sandboxId: newest.sandbox_id!, rev: 0 } : null;
}

/**
 * A turn, from whoever sent it.
 *
 * Two things happen here that do not happen in phase 1. The prompt is tagged
 * with who sent it once more than one person is in the paddock, so the
 * transcript can say `[from guest-7f3a]`; and the send goes through the
 * paddock's lock, so the order Fountain sees is the order people pressed
 * Enter rather than whatever the network decided.
 */
async function prompt(
  ctx: AppContext,
  req: Request,
  paddock: PaddockRow,
  client: FountainClient,
  tab: Tab,
  id: Identity,
  tabs: Tab[],
): Promise<Response> {
  const body = await readJson(req);
  const text = str(body.prompt, 100_000);
  if (!text.trim()) throw new HttpError(422, "empty_prompt", "Say something.");

  const alone = ctx.db.members(paddock.id).length === 0 && ctx.db.guests(paddock.id).length === 0;
  const outgoing = alone ? text : withAuthor(actorLabel(id), text);

  return withPromptLock(paddock.id, async () => {
    try {
      const res = await client.raw("POST", `/api/conversations/${encodeURIComponent(tab.conversation.id)}/prompts`, {
        body: JSON.stringify({ prompt: outgoing }),
        accept: "application/json",
      });
      const payload = await res.text();
      if (res.ok) {
        hub.publish(paddock.id, "turn", { conversationId: tab.conversation.id, by: actorLabel(id), tabs: tabs.length });
      }
      return new Response(payload, { status: res.status, headers: { "content-type": "application/json; charset=utf-8" } });
    } catch (err) {
      throw asHttpError(err, "send that turn");
    }
  });
}

/**
 * A new tab, opened by anyone in the paddock, attached to the machine that is
 * already there. The agent and sandbox are the owner's — a caller cannot name
 * either, which is what stops a guest attaching a tab to somebody else's box.
 */
async function openTab(ctx: AppContext, req: Request, paddock: PaddockRow, client: FountainClient, id: Identity): Promise<Response> {
  const body = await readJson(req);
  const tabs = await visibleTabs(client);
  let all;
  try {
    all = await client.listConversations();
  } catch (err) {
    throw asHttpError(err, "open a tab");
  }
  const owner = agentAndBoxOf(all as unknown as Parameters<typeof tabsOf>[0]);
  if (!owner) throw new HttpError(409, "no_machine", "This machine is not running.");

  const channel = str(body.channel_id, 200);
  if (!channel.startsWith("paddock:")) throw new HttpError(422, "bad_channel", "A tab needs a paddock channel id.");

  try {
    const res = await client.raw("POST", "/api/conversations", {
      body: JSON.stringify({ agent_id: owner.agentId, sandbox_id: owner.sandboxId, title: str(body.title, 200) || undefined, channel_id: channel }),
      accept: "application/json",
    });
    const payload = await res.text();
    if (res.ok) {
      const created = JSON.parse(payload) as { data?: { id?: string } };
      if (created.data?.id) ctx.db.recordTabOpener(created.data.id, paddock.id, actorLabel(id));
      hub.publish(paddock.id, "tabs", { opened: created.data?.id ?? null, by: actorLabel(id), count: tabs.length + 1 });
    }
    return new Response(payload, { status: res.status, headers: { "content-type": "application/json; charset=utf-8" } });
  } catch (err) {
    throw asHttpError(err, "open a tab");
  }
}

/** Only what the browser needs. Nothing about the upstream connection leaks. */
function passthroughHeaders(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  const type = res.headers.get("content-type");
  if (type) out["content-type"] = type;
  if (type?.includes("text/event-stream")) out["cache-control"] = "no-cache";
  return out;
}
