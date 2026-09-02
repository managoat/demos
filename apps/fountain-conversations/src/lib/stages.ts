/**
 * Stage-section presentation, ported from the web UI's timeline: the icon
 * per stage, the `k=v` extras decoded from a stage event's data, the
 * open-by-default policy, and the `reattach` pairs that only the raw view
 * shows.
 */
import type { LogEvent } from "../api/types";
import type { Section } from "./blocks";
import { isSection } from "./blocks";

const ICONS: Record<string, string> = {
  provision: "✨",
  checkpoint_restore: "📦",
  setup: "🛠",
  packages: "🔩",
  network: "🌐",
  clone: "🤗",
  turn: "💬",
  reattach: "🔌",
  session: "🔄",
  sandbox: "💤",
  terminate: "🛑",
};

export function stageIcon(stage: string | null | undefined): string {
  return (stage && ICONS[stage]) || "•";
}

/**
 * `k=v k=v …` from a stage event's JSON data — each value cut at 40 chars,
 * the whole line at 120. A non-JSON payload is shown as is; `message`
 * leads when present.
 */
export function stageExtra(data: string | null | undefined): string {
  if (!data) return "";
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(data) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return cut(data, 120);
    obj = parsed as Record<string, unknown>;
  } catch {
    return cut(data, 120);
  }
  const parts: string[] = [];
  if (typeof obj.message === "string" && obj.message) parts.push(cut(obj.message, 40));
  for (const [k, v] of Object.entries(obj)) {
    if (k === "message" || v == null || v === "") continue;
    const s = typeof v === "string" ? v : JSON.stringify(v);
    parts.push(`${k}=${cut(s, 40)}`);
  }
  return cut(parts.join(" "), 120);
}

function cut(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * How long a section took. `duration_ms` is a column the server serves but
 * never fills — the web UI paired the timestamps at read time, and so do we;
 * the column wins where a future writer does populate it.
 */
export function sectionDuration(section: Section): number | null {
  if (section.ended?.duration_ms != null) return section.ended.duration_ms;
  if (!section.started?.ts || !section.ended?.ts) return null;
  const ms = Date.parse(section.ended.ts) - Date.parse(section.started.ts);
  return Number.isNaN(ms) || ms < 0 ? null : ms;
}

/**
 * `ms` under a second, then seconds to one decimal; minutes and hours get
 * their own units rather than the web UI's four-digit "3946.0s".
 * "…" while the section is still open.
 */
export function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null) return "…";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.round((ms % 3_600_000) / 60_000)}m`;
}

export type ChildMode = "cards" | "recursive" | "text";

/** How a section's children render: turn output as cards, containers recurse, leaf output as one text run. */
export function childMode(section: Section): ChildMode {
  if (section.stage === "turn") return "cards";
  if (section.children.some(isSection)) return "recursive";
  return "text";
}

/** Open unless finished and a leaf (a finished `packages` collapses; a turn or a container stays open). */
export function defaultOpen(section: Section): boolean {
  const finished = section.ended != null;
  const mode = childMode(section);
  return !finished || mode === "cards" || mode === "recursive";
}

/** `reattach` stage pairs are bookkeeping — the pretty views drop them so post-crash output stays under its turn. */
export function hiddenInPretty(ev: LogEvent): boolean {
  return ev.kind === "stage" && ev.stage === "reattach";
}

/** The web UI's stream-pill rule: stage-tagged output follows `stage`; `acp` follows `stdout`. */
export function eventVisible(ev: LogEvent, visible: Set<string>): boolean {
  if (ev.kind === "stage") return visible.has("stage");
  if (ev.kind !== "output") return false;
  if (ev.stage && ev.stage !== "turn") return visible.has("stage");
  if (ev.stream === "acp") return visible.has("stdout");
  return !!ev.stream && visible.has(ev.stream);
}
