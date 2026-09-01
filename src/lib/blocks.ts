/**
 * Arranging server-parsed blocks for display. The server does the parsing
 * (`?blocks=true`); the client only pairs and groups.
 */
import type { Block, LogEvent } from "../types";

/** Fountain refuses a permission request nobody answers in five minutes. */
export const ASK_TIMEOUT_MS = 5 * 60 * 1000;

/** What became of a permission request, folded onto the block that asks it. */
export interface Permission {
  outcome: string | null;
  optionId: string | null;
  expiresAt: string;
}

export type ShownBlock =
  | (Block & { kind: "tool_use"; result?: { body: string; error: boolean } })
  | (Block & { kind: "permission_request"; permission: Permission })
  | Block;

export function dataOf(ev: LogEvent): Record<string, unknown> {
  if (!ev.data) return {};
  try {
    const v = JSON.parse(ev.data) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Concatenate adjacent text/thinking blocks and pair tool results onto their calls. */
export function arrange(events: LogEvent[], visibleStreams?: Set<string>): ShownBlock[] {
  const held = requestStates(events);
  const raw: ShownBlock[] = [];
  for (const ev of events) {
    if (ev.kind !== "output" || !ev.blocks) continue;
    if (visibleStreams && ev.stream && !visibleStreams.has(ev.stream)) continue;
    for (const b of ev.blocks) {
      const last = raw[raw.length - 1];
      if ((b.kind === "text" || b.kind === "thinking") && last && last.kind === b.kind) {
        last.body = (last.body ?? "") + (b.body ?? "");
      } else if (b.kind === "permission_request") {
        raw.push({ ...b, kind: "permission_request", permission: permissionOf(b, ev.ts, held) });
      } else {
        raw.push({ ...b });
      }
    }
  }
  const results = new Map<string, ShownBlock>();
  for (const b of raw) if (b.kind === "tool_result" && b.tool_id) results.set(b.tool_id, b);
  const consumed = new Set<string>();
  const out: ShownBlock[] = [];
  for (const b of raw) {
    if (b.kind === "tool_use" && b.id && results.has(b.id)) {
      const r = results.get(b.id)!;
      consumed.add(b.id);
      out.push({ ...b, kind: "tool_use", result: { body: r.body ?? "", error: !!r.error } });
    } else if (b.kind === "tool_result" && b.tool_id && consumed.has(b.tool_id)) {
      continue;
    } else {
      out.push(b);
    }
  }
  return out;
}

type RequestState = { outcome: string | null; optionId: string | null; expiresAt: string | null };

function requestStates(events: LogEvent[]): Map<string, RequestState> {
  const out = new Map<string, RequestState>();
  for (const ev of events) {
    if (ev.kind !== "stage" || ev.stage !== "request") continue;
    const d = dataOf(ev);
    const id = typeof d.request_id === "string" ? d.request_id : null;
    if (!id) continue;
    const state = out.get(id) ?? { outcome: null, optionId: null, expiresAt: null };
    if (ev.state === "started") {
      const ms = typeof d.timeout_ms === "number" && d.timeout_ms > 0 ? d.timeout_ms : ASK_TIMEOUT_MS;
      const asked = Date.parse(ev.ts);
      if (!Number.isNaN(asked)) state.expiresAt = new Date(asked + ms).toISOString();
    } else {
      state.outcome = typeof d.outcome === "string" ? d.outcome : (ev.state ?? "done");
      state.optionId = typeof d.option_id === "string" ? d.option_id : null;
    }
    out.set(id, state);
  }
  return out;
}

function permissionOf(block: Block, askedAt: string, held: Map<string, RequestState>): Permission {
  const state = typeof block.request_id === "string" ? held.get(block.request_id) : undefined;
  const asked = Date.parse(askedAt);
  return {
    outcome: state?.outcome ?? null,
    optionId: state?.optionId ?? null,
    expiresAt: state?.expiresAt ?? new Date((Number.isNaN(asked) ? Date.now() : asked) + ASK_TIMEOUT_MS).toISOString(),
  };
}

/** The assistant's text of a turn — previews. */
export function assistantText(events: LogEvent[]): string {
  return arrange(events)
    .filter((b) => b.kind === "text")
    .map((b) => b.body ?? "")
    .join("")
    .trim();
}

/** "4 min left" for a held request. */
export function timeLeft(expiresAt: string, now: number): string {
  const ms = Date.parse(expiresAt) - now;
  if (ms <= 0) return "expired";
  const m = Math.ceil(ms / 60_000);
  return m <= 1 ? "under a minute left" : `${m} min left`;
}
