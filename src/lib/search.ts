/**
 * What the two searches search.
 *
 * ⌘K is "where in this project did anyone say X", and has two sources because
 * they answer different questions. The conversation list is already in the
 * store, so matching a thread by name is local and instant — that is the
 * "jump to" half. Full text over the messages is `GET /api/search`, through
 * the project proxy, which is the only reason a member may run it at all: it
 * runs on the project owner's key, and `server/proxy.ts` cuts the answer down
 * to this project's conversations before it leaves the server.
 *
 * ⌘F is the other half — "where in THIS thread did they say it" — and is the
 * same call with `conversation_id` on it. That is the tight path: the proxy
 * checks the id is this project's and then lets Fountain scope the query, so
 * nothing outside the conversation is fetched at all. What comes back is
 * ranked, which is right for a list of results and wrong for walking a
 * transcript, so `threadHits` puts it back into reading order.
 *
 * Everything here but `searchMessages` is pure, so the ranking, the ordering
 * and the labels are testable without a Fountain.
 */
import type { Fountain } from "@agentshit/fountain-sdk";
import type { Agent, Conversation, SearchHit } from "../types";
import type { ItemDto } from "./api";
import { conversationLabel } from "./format";
import { itemIdOf } from "./sidebar";
import { href } from "../router";

/** One row of the palette, whichever source it came from. */
export interface Match {
  key: string;
  href: string;
  /** `conversation` jumps to a thread; the rest are what matched inside one. */
  kind: "conversation" | "title" | "prompt" | "reply";
  primary: string;
  secondary: string;
  when: string | null;
}

export interface Messages {
  hits: SearchHit[];
  /** Fountain had more, or the proxy stopped digging through the owner's hits before the end. */
  hasMore: boolean;
}

/** Where a conversation lives, for the second line of a row. */
export interface Context {
  conversations: Conversation[];
  items: ItemDto[];
  agents: Map<string, Agent>;
  projectId: string;
}

/**
 * The project's conversations whose name matches, best first: a word the
 * typing starts beats one it lands in the middle of ("gate" is looking for
 * the gate, not for mitigation), a retired conversation sinks below the live
 * ones, and the most recently active wins a tie.
 */
export function matchConversations(q: string, ctx: Context, limit = 5): Match[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const scored: { c: Conversation; score: number }[] = [];
  for (const c of ctx.conversations) {
    const label = conversationLabel(c).toLowerCase();
    const at = label.indexOf(needle);
    if (at === -1) continue;
    const startsWord = at === 0 || !/[\w]/.test(label[at - 1] ?? "");
    scored.push({ c, score: (startsWord ? 0 : 1) + (c.status === "terminated" ? 2 : 0) });
  }
  scored.sort((a, b) => a.score - b.score || (b.c.last_active_at ?? "").localeCompare(a.c.last_active_at ?? ""));
  return scored.slice(0, limit).map(({ c }) => ({
    key: `c:${c.id}`,
    href: href.conversation(ctx.projectId, c.id),
    kind: "conversation" as const,
    primary: conversationLabel(c),
    secondary: where(c.id, ctx),
    when: c.last_active_at ?? null,
  }));
}

/** The server's hits as palette rows, each pointing at the turn it matched. */
export function describeHits(hits: SearchHit[], ctx: Context): Match[] {
  return hits.map((h, i) => ({
    key: `h:${h.conversation_id}:${h.turn_id ?? "title"}:${i}`,
    href: href.conversation(ctx.projectId, h.conversation_id, h.turn_id),
    kind: h.kind,
    primary: h.snippet,
    secondary: [where(h.conversation_id, ctx), h.turn_number ? `turn ${h.turn_number}` : null].filter(Boolean).join(" · "),
    when: h.ts,
  }));
}

/** "work item · teammate" for the conversation a row belongs to — as much of it as we know. */
function where(conversationId: string, ctx: Context): string {
  const c = ctx.conversations.find((x) => x.id === conversationId);
  if (!c) return "this project";
  const itemId = itemIdOf(c);
  const item = itemId ? ctx.items.find((w) => w.id === itemId) : null;
  const agent = c.agent_id ? ctx.agents.get(c.agent_id) : null;
  return [item?.title, agent?.name ?? c.runtime].filter(Boolean).join(" · ") || conversationLabel(c);
}

/**
 * Full text over this project's messages, or over one conversation of it when
 * `conversationId` is given. `limit` is the workbench's own window over what
 * the proxy kept, not Fountain's over the owner's hits — the two are not the
 * same number and the server is where that is reconciled.
 */
export async function searchMessages(
  fountain: Fountain,
  q: string,
  opts: { limit?: number; conversationId?: string; signal?: AbortSignal } = {},
): Promise<Messages> {
  const query: Record<string, string | number> = { q, limit: opts.limit ?? 20 };
  if (opts.conversationId) query.conversation_id = opts.conversationId;
  const body = await fountain.request<{ data?: SearchHit[]; meta?: { has_more?: boolean } }>("GET", "/api/search", {
    query,
    signal: opts.signal,
  });
  return { hits: body.data ?? [], hasMore: body.meta?.has_more === true };
}

/** One match inside the open thread, at the turn the transcript can jump to. */
export interface ThreadHit {
  key: string;
  turnId: string;
  turnNumber: number | null;
  kind: "prompt" | "reply";
  snippet: string;
}

/** Where in a turn a match sits: what was asked comes before what came back. */
const READING_ORDER = { prompt: 0, reply: 1 } as const;

/**
 * A one-conversation search as a walk down the transcript: by turn, and within
 * a turn the prompt before the reply it got. Fountain ranks its hits, and rank
 * is the wrong order for ⌘F — next and previous mean down and up the thread,
 * not "less relevant" and "more".
 *
 * A title hit is dropped rather than counted: it matched the conversation's
 * name, and there is no turn in the transcript to land on.
 */
export function threadHits(hits: SearchHit[]): ThreadHit[] {
  const anchored: ThreadHit[] = [];
  for (const [i, h] of hits.entries()) {
    if (h.kind === "title") continue;
    if (typeof h.turn_id !== "string" || !h.turn_id) continue;
    anchored.push({ key: `${h.turn_id}:${h.kind}:${i}`, turnId: h.turn_id, turnNumber: h.turn_number ?? null, kind: h.kind, snippet: h.snippet });
  }
  // Stable, so hits Fountain gave us on a turn it did not number keep their order.
  return anchored.sort((a, b) => (a.turnNumber ?? Infinity) - (b.turnNumber ?? Infinity) || READING_ORDER[a.kind] - READING_ORDER[b.kind]);
}

/**
 * Whether a ⌘F is the thread's or the browser's.
 *
 * Taking ⌘F away from the browser is a big enough theft to be strict about.
 * The thread claims it only when the reader is in the thread — focus inside
 * it, or nowhere at all, which is where clicking the transcript leaves you.
 * Focus on anything else (a sidebar link, another field) means the reader is
 * not reading this thread, so the browser's own find is the one they meant.
 *
 * A modal takes it back outright: the palette is a box over the whole app with
 * its own list, and ⌘F while it is up is someone looking for text on screen.
 */
export function findIsOurs({ inThread, focusedElsewhere, modal }: { inThread: boolean; focusedElsewhere: boolean; modal: boolean }): boolean {
  if (modal) return false;
  return inThread || !focusedElsewhere;
}
