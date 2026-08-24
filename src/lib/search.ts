/**
 * What the command palette searches.
 *
 * Two sources, because they answer different questions. The conversation list
 * is already in the store, so matching a thread by name is local and instant —
 * that is the "jump to" half. Full text over the messages is
 * `GET /api/search`, through the project proxy, which is the only reason a
 * member may run it at all: it runs on the project owner's key, and
 * `server/proxy.ts` cuts the answer down to this project's conversations
 * before it leaves the server.
 *
 * Everything here but `searchMessages` is pure, so the ranking and the labels
 * are testable without a Fountain.
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
 * Full text over this project's messages. `limit` is the workbench's own
 * window over what the proxy kept, not Fountain's over the owner's hits — the
 * two are not the same number and the server is where that is reconciled.
 */
export async function searchMessages(fountain: Fountain, q: string, opts: { limit?: number; signal?: AbortSignal } = {}): Promise<Messages> {
  const body = await fountain.request<{ data?: SearchHit[]; meta?: { has_more?: boolean } }>("GET", "/api/search", {
    query: { q, limit: opts.limit ?? 20 },
    signal: opts.signal,
  });
  return { hits: body.data ?? [], hasMore: body.meta?.has_more === true };
}
