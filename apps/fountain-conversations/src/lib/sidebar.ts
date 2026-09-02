/**
 * The conversation sidebar, as the Fountain web UI laid it out: a title
 * cleaned out of the first prompt, a "target" line (the repo or PR the
 * prompt names, else the agent), date groups with the running ones on top,
 * and per-conversation turn and child counts. Pure functions; the component
 * is in components/Sidebar.tsx.
 */
import type { Conversation } from "../api/types";

/** A leading role sentence, a leading heading, leading key=value lines: none of them is the task. */
const STRIP: RegExp[] = [
  /^\s*you are an? [^.\n]*[.\n]/i,
  /^\s*#{1,6}\s+[^\n]*\n?/,
  /^(?:\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*[^\n]*\n)+/,
];

/** The first line worth showing from a prompt, truncated; null when nothing survives. */
export function cleanTitle(prompt: string | null | undefined, max = 55): string | null {
  if (!prompt) return null;
  let text = prompt;
  for (const re of STRIP) text = text.replace(re, "");
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) {
    // Everything was stripped: fall back to the raw first line rather than nothing.
    const raw = prompt
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    return raw ? truncate(raw, max) : null;
  }
  return truncate(line, max);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

/** What the prompt is about, if it names a GitHub PR or repo; else null. */
export function targetOf(prompt: string | null | undefined): string | null {
  if (!prompt) return null;
  let m: RegExpExecArray | null;
  if ((m = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec(prompt))) return `${m[1]}/${m[2]}#${m[3]}`;
  if ((m = /github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/\s)#?]|$)/.exec(prompt))) return `${m[1]}/${m[2]}`;
  if ((m = /repo_url\s*=\s*\S*?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\s|$)/.exec(prompt))) return `${m[1]}/${m[2]}`;
  return null;
}

/** The sidebar's one-line title for a conversation. */
export function sidebarTitle(c: Pick<Conversation, "title" | "first_prompt">): string | null {
  return c.title || cleanTitle(c.first_prompt);
}

export type GroupKey = "Active" | "Today" | "Yesterday" | "Past 7 days" | "Older";
export const GROUP_ORDER: GroupKey[] = ["Active", "Today", "Yesterday", "Past 7 days", "Older"];
const HOUR = 3_600_000;

export function groupKey(c: Pick<Conversation, "status" | "last_active_at" | "updated_at" | "inserted_at">, now: number): GroupKey {
  if (c.status === "running") return "Active";
  const at = Date.parse(c.last_active_at ?? c.updated_at ?? c.inserted_at);
  const age = now - at;
  if (Number.isNaN(age) || age < 24 * HOUR) return "Today";
  if (age < 48 * HOUR) return "Yesterday";
  if (age < 168 * HOUR) return "Past 7 days";
  return "Older";
}

/** Conversations in display order, bucketed; empty groups omitted. */
export function groupByDate<T extends Pick<Conversation, "status" | "last_active_at" | "updated_at" | "inserted_at">>(
  convs: T[],
  now = Date.now(),
): Array<{ key: GroupKey; items: T[] }> {
  const buckets = new Map<GroupKey, T[]>();
  for (const c of convs) {
    const k = groupKey(c, now);
    const arr = buckets.get(k);
    if (arr) arr.push(c);
    else buckets.set(k, [c]);
  }
  return GROUP_ORDER.filter((k) => buckets.has(k)).map((k) => ({ key: k, items: buckets.get(k)! }));
}

/** How many conversations name each id as their parent. */
export function childCounts(convs: Array<Pick<Conversation, "parent_conversation_id">>): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of convs) {
    if (!c.parent_conversation_id) continue;
    m.set(c.parent_conversation_id, (m.get(c.parent_conversation_id) ?? 0) + 1);
  }
  return m;
}

/** Ns / Nm / Nh / Nd ago — the web UI's relative clock. */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const secs = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (Number.isNaN(secs)) return "—";
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

/** Conversations sorted by activity (most recent first), the sidebar's order. */
export function byActivity<T extends Pick<Conversation, "last_active_at" | "updated_at" | "inserted_at">>(convs: T[]): T[] {
  const key = (c: T) => c.last_active_at ?? c.updated_at ?? c.inserted_at;
  return [...convs].sort((a, b) => key(b).localeCompare(key(a)));
}
