/**
 * The sidebar's model: the project's work items, each with its computers —
 * one per sandbox, the active team members on that item — each with the
 * conversations on it, live ones first. A computer belongs to the work
 * item it was started for (the server enforces it on a join), so the tree
 * is item → computer → conversation. Pure functions; the component is
 * components/Sidebar.tsx.
 *
 * A computer is live while a conversation still holds it (pending, running
 * or idle); the sandbox record, when we have it, has the last word. Fountain
 * attaches a second conversation only to a `ready` or `suspended` sandbox.
 *
 * **The tree does not reorder itself.** It once sorted every level by
 * `last_active_at`, which Fountain moves on every line of runtime output —
 * so two agents talking at once swapped rows under the pointer, several
 * times a second, and the explorer was unreadable exactly when it had the
 * most to say. Every rank here is a *start* time instead: `createdAt` for a
 * work item, the first conversation for a computer, `inserted_at` for a
 * conversation. Newest first, so a thing you just started is at the top of
 * its list, and then it stays where you left it. A row moves only when you
 * move it (start something, close an item) or when its computer dies —
 * and a turn running is told by the dot beside it, not by its position.
 */
import type { Conversation, SandboxRecord } from "../types";
import { parseChannel } from "../../shared/channel";
import { computerKey } from "../../shared/computers";
import { isClosed } from "../../shared/status";

export const LIVE_STATUSES = new Set<Conversation["status"]>(["pending", "running", "idle"]);
export const ATTACHABLE = new Set<string>(["ready", "suspended"]);

export interface Computer {
  /** The sandbox id, or `conv:<id>` for a conversation that never got one (shared/computers.ts). */
  key: string;
  sandboxId: string | null;
  agentId: string | null;
  sandbox: SandboxRecord | null;
  /** Newest first, and each one keeps its place. */
  conversations: Conversation[];
  live: boolean;
  /** A turn is in flight on it. */
  busy: boolean;
  unread: boolean;
  /** ISO time of the latest activity on it — shown, never sorted on. */
  latest: string;
  /** ISO time its first conversation started: its fixed place in the item. */
  startedAt: string;
}

function activityOf(c: Conversation): string {
  return c.last_active_at ?? c.updated_at ?? c.inserted_at ?? "";
}

/**
 * When a conversation began. Unlike `last_active_at` this is written once,
 * so a row ranked by it holds still while the agent talks.
 */
function startOf(c: Conversation): string {
  return c.inserted_at ?? "";
}

/** Conversations newest first, by when they started. Ties break on id, so the order is total. */
export function byStart(convs: Conversation[]): Conversation[] {
  return [...convs].sort((a, b) => startOf(b).localeCompare(startOf(a)) || a.id.localeCompare(b.id));
}

export function computersOf(convs: Conversation[], sandboxes: ReadonlyMap<string, SandboxRecord>): Computer[] {
  const byKey = new Map<string, Computer>();
  for (const c of byStart(convs)) {
    const key = computerKey(c);
    let comp = byKey.get(key);
    if (!comp) {
      comp = {
        key,
        sandboxId: c.sandbox_id ?? null,
        agentId: c.agent_id ?? null,
        sandbox: c.sandbox_id ? sandboxes.get(c.sandbox_id) ?? null : null,
        conversations: [],
        live: false,
        busy: false,
        unread: false,
        latest: "",
        startedAt: "",
      };
      byKey.set(key, comp);
    }
    comp.conversations.push(c);
    if (!comp.agentId && c.agent_id) comp.agentId = c.agent_id;
    if (c.status === "running" || c.status === "pending") comp.busy = true;
    if (c.unread) comp.unread = true;
    const at = activityOf(c);
    if (at > comp.latest) comp.latest = at;
    // The conversations arrive newest first, so the last one seen is the
    // oldest: when the computer came into being.
    comp.startedAt = startOf(c);
  }
  for (const comp of byKey.values()) comp.live = isLive(comp);
  return [...byKey.values()].sort((a, b) => {
    if (a.live !== b.live) return a.live ? -1 : 1;
    return b.startedAt.localeCompare(a.startedAt) || a.key.localeCompare(b.key);
  });
}

export function isLive(c: Pick<Computer, "sandboxId" | "sandbox" | "conversations">): boolean {
  // No sandbox id yet: a conversation being started is a computer coming up,
  // not a dead one. Counting it live keeps it at the top of its item from the
  // moment you start it, instead of sitting under the dead computers until
  // Fountain hands back the id and then leaping. Anything else without an id
  // is a computer we have no record of, and sinks.
  if (!c.sandboxId) return c.conversations.some((x) => x.status === "pending" || x.status === "running");
  if (c.sandbox && (c.sandbox.status === "terminated" || c.sandbox.status === "failed")) return false;
  return c.conversations.some((x) => LIVE_STATUSES.has(x.status));
}

/** Whether "+ Here" can work right now: the record says ready or suspended. */
export function attachable(c: Pick<Computer, "sandbox">): boolean {
  return !!c.sandbox && ATTACHABLE.has(c.sandbox.status);
}

/** The work item a conversation belongs to, off its channel. */
export function itemIdOf(c: Pick<Conversation, "channel_id">): string | null {
  return parseChannel(c.channel_id)?.itemId ?? null;
}

/**
 * The explorer's clock. Like `relativeTime`, but it does not count seconds.
 * The list re-renders on every burst of output — three times a second while
 * an agent talks — so a seconds counter reflows the row it is in that often,
 * for no news: the dot beside it already says the turn is running. Under a
 * minute is just "now".
 */
export function coarseTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const secs = Math.floor((now - Date.parse(iso)) / 1000);
  if (Number.isNaN(secs)) return "—";
  if (secs < 60) return "now";
  return relativeTime(iso, now);
}

/** Ns / Nm / Nh / Nd ago. */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const secs = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (Number.isNaN(secs)) return "—";
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

/** The sandbox's name for a label: the sprite, or the id's head. */
export function computerLabel(c: Pick<Computer, "sandbox" | "sandboxId">): string {
  if (c.sandbox?.sprite_name) return c.sandbox.sprite_name.replace(/^fountain-[0-9a-f]{8}-/, "");
  return c.sandboxId ? c.sandboxId.slice(0, 8) : "no computer";
}

export interface ItemGroup<I extends { id: string; title: string; status: string; createdAt: string }> {
  item: I;
  computers: Computer[];
  live: boolean;
  busy: boolean;
  unread: boolean;
  latest: string;
}

/**
 * Work items with their computers: items that have a live computer first,
 * then newest item first; closed items last. An item with no conversations
 * yet is kept, so it can be started from the sidebar. Ranking on the item's
 * own creation time rather than on its activity is what keeps the list
 * still while its agents talk — see the module doc.
 */
export function groupByItem<I extends { id: string; title: string; status: string; createdAt: string }>(
  items: I[],
  convs: Conversation[],
  sandboxes: ReadonlyMap<string, SandboxRecord>,
): ItemGroup<I>[] {
  const byItem = new Map<string, Conversation[]>();
  for (const c of convs) {
    const id = itemIdOf(c);
    if (!id) continue;
    const arr = byItem.get(id);
    if (arr) arr.push(c);
    else byItem.set(id, [c]);
  }
  const groups = items.map((item) => {
    const computers = computersOf(byItem.get(item.id) ?? [], sandboxes);
    return {
      item,
      computers,
      live: computers.some((c) => c.live),
      busy: computers.some((c) => c.busy),
      unread: computers.some((c) => c.unread),
      latest: computers.reduce((m, c) => (c.latest > m ? c.latest : m), ""),
    };
  });
  return groups.sort((a, b) => {
    const da = isClosed(a.item.status) ? 1 : 0;
    const db = isClosed(b.item.status) ? 1 : 0;
    if (da !== db) return da - db;
    if (a.live !== b.live) return a.live ? -1 : 1;
    return b.item.createdAt.localeCompare(a.item.createdAt) || a.item.id.localeCompare(b.item.id);
  });
}

/**
 * A stable hue for a sandbox, off its id — so two computers on one work
 * item read as two things at a glance, and the same computer keeps its
 * colour across reloads and screens.
 */
export function hueOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}

// ── the explorer's width, dragged and remembered ──────────────────────

export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 560;
export const SIDEBAR_DEFAULT = 272;
const WIDTH_KEY = "fountain-workbench.sidebarWidth";

export function clampWidth(px: number): number {
  if (!Number.isFinite(px)) return SIDEBAR_DEFAULT;
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(px)));
}

export function loadSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    return raw ? clampWidth(Number(raw)) : SIDEBAR_DEFAULT;
  } catch {
    return SIDEBAR_DEFAULT;
  }
}

export function saveSidebarWidth(px: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(clampWidth(px)));
  } catch {
    // no storage: the width lives for the page
  }
}

// ── the explorer's shelves ────────────────────────────────────────────
//
// Every open item once rendered as the same row — same weight, same
// truncation, a `1/1` in the corner — and thirty of them read as a
// paragraph. What tells the work you care about from the rest is its
// *state*, and the tree already knows it: whether a turn is running, whether
// something is waiting on you, whether a computer is up at all. So the list
// is shelved by that state, each shelf a fold with a count, and inside a
// shelf the rows keep the still order of `groupByItem`. A row moves shelf
// only when its state changes, which is news worth a move.

export type ItemState = "waiting" | "working" | "up" | "todo" | "closed";

export const ITEM_STATES: readonly ItemState[] = ["waiting", "working", "up", "todo", "closed"];

export const STATE_LABEL: Record<ItemState, string> = {
  waiting: "waiting on you",
  working: "working",
  up: "up",
  todo: "to do",
  closed: "closed",
};

/** One character in the gutter, so a resting list scans by its left edge. */
export const STATE_GLYPH: Record<ItemState, string> = {
  waiting: "!",
  working: "●",
  up: "◐",
  todo: "○",
  closed: "✓",
};

/**
 * Which shelf an item sits on. A proposal outranks everything: a person has
 * to decide it, and nothing else on the row can happen until they do. New
 * output you have not seen is waiting too — unless the agent is still
 * talking, in which case it is working and the dot says so.
 */
export function stateOf(g: ItemGroup<{ id: string; title: string; status: string; createdAt: string; proposal?: unknown }>): ItemState {
  if (isClosed(g.item.status)) return "closed";
  if (g.item.proposal) return "waiting";
  if (g.busy) return "working";
  if (g.unread) return "waiting";
  if (g.live) return "up";
  return "todo";
}

export interface Shelf<I extends { id: string; title: string; status: string; createdAt: string }> {
  state: ItemState;
  groups: ItemGroup<I>[];
}

/** The groups shelved, in shelf order; empty shelves are left out. */
export function shelve<I extends { id: string; title: string; status: string; createdAt: string; proposal?: unknown }>(groups: ItemGroup<I>[]): Shelf<I>[] {
  const by = new Map<ItemState, ItemGroup<I>[]>();
  for (const g of groups) {
    const s = stateOf(g);
    const arr = by.get(s);
    if (arr) arr.push(g);
    else by.set(s, [g]);
  }
  return ITEM_STATES.filter((s) => by.has(s)).map((state) => ({ state, groups: by.get(state)! }));
}

/** Case- and whitespace-insensitive: every word typed is somewhere in the title. */
export function matchesFilter(title: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const t = title.toLowerCase();
  return words.every((w) => t.includes(w));
}

/**
 * What a conversation row says, given that the rows above it already say
 * the item and the teammate. A started conversation is titled
 * `<teammate>: <item title>` (shared/channel), so under that item and that
 * teammate the title is pure repetition: null, and the row falls back to
 * something distinct. A renamed or foreign title shows, minus the
 * teammate's prefix when it carries one.
 */
export function threadLabel(title: string | null | undefined, itemTitle: string, agentName: string | null | undefined): string | null {
  if (!title) return null;
  const prefix = agentName ? `${agentName}: ` : null;
  const body = prefix && title.startsWith(prefix) ? title.slice(prefix.length) : title;
  if (body === itemTitle) return null;
  // conversationTitle cuts at 119 and appends an ellipsis: a cut copy is still a copy.
  if (body.endsWith("…") && body.length > 1 && itemTitle.startsWith(body.slice(0, -1))) return null;
  return body;
}

// ── which shelves are folded, remembered ──────────────────────────────

const FOLDS_KEY = "fountain-workbench.explorerFolds";

/** Closed starts folded: it is the shelf you look at least. */
export function loadFolds(): Set<ItemState> {
  try {
    const raw = localStorage.getItem(FOLDS_KEY);
    if (raw === null) return new Set(["closed"]);
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter((s): s is ItemState => (ITEM_STATES as readonly string[]).includes(s)) : ["closed"]);
  } catch {
    return new Set(["closed"]);
  }
}

export function saveFolds(folds: ReadonlySet<ItemState>): void {
  try {
    localStorage.setItem(FOLDS_KEY, JSON.stringify([...folds]));
  } catch {
    // no storage: the folds live for the page
  }
}
