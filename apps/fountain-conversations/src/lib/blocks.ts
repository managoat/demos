/**
 * Arranging server-parsed blocks for display. The server does the parsing
 * (`?blocks=true`); the client only pairs and groups.
 */
import type { Block, LogEvent, Turn } from "../api/types";

/** A tool_use with its tool_result tucked in, or any other block as is. */
export type ShownBlock =
  | (Block & { kind: "tool_use"; result?: { body: string; error: boolean } })
  | Block;

/** Concatenate adjacent text/thinking blocks and pair tool results onto their calls. */
export function arrange(events: LogEvent[], visibleStreams?: Set<string>): ShownBlock[] {
  const raw: Block[] = [];
  for (const ev of events) {
    if (ev.kind !== "output" || !ev.blocks) continue;
    if (visibleStreams && ev.stream && !visibleStreams.has(ev.stream)) continue;
    for (const b of ev.blocks) {
      const last = raw[raw.length - 1];
      if ((b.kind === "text" || b.kind === "thinking") && last && last.kind === b.kind) {
        last.body = (last.body ?? "") + (b.body ?? "");
      } else {
        raw.push({ ...b });
      }
    }
  }
  const results = new Map<string, Block>();
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

/** The assistant's text of a turn — chat bubbles and previews. */
export function assistantText(events: LogEvent[]): string {
  return arrange(events)
    .filter((b) => b.kind === "text")
    .map((b) => b.body ?? "")
    .join("")
    .trim();
}

export interface Section {
  kind: "section";
  key: string;
  stage: string;
  started: LogEvent | null;
  ended: LogEvent | null;
  turn: Turn | null;
  children: (Section | LogEvent)[];
}

/**
 * The timeline as the web UI groups it: a `started` stage event opens a
 * section that holds everything until its matching end, sections nest
 * (provision > packages > clone), and an output event goes to the open
 * section whose stage matches its own `stage` field — apt's stdout under
 * `packages` even while `provision` is open above it. A mismatched close
 * becomes a loose event so nothing is lost; still-open sections at the end
 * of the stream are the ones in flight.
 */
export function timeline(events: LogEvent[], turns: Turn[]): (Section | LogEvent)[] {
  const byId = new Map(turns.map((t) => [t.id, t]));
  type Frame = { section: Section | null; children: (Section | LogEvent)[] };
  const stack: Frame[] = [{ section: null, children: [] }];

  const turnOf = (ev: LogEvent): Turn | null => {
    const id = ev.turn_id ?? dataField(ev, "turn_id");
    return id ? byId.get(id) ?? null : null;
  };

  const pushEvent = (ev: LogEvent) => {
    // Route output to the frame whose stage matches; else the innermost.
    let target = stack[stack.length - 1]!;
    if (ev.kind === "output" && ev.stage) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]!.section?.stage === ev.stage) {
          target = stack[i]!;
          break;
        }
      }
    }
    target.children.push(ev);
  };

  const close = (frame: Frame, ended: LogEvent | null) => {
    const sec = frame.section!;
    sec.ended = ended;
    sec.children = frame.children;
    stack[stack.length - 1]!.children.push(sec);
  };

  for (const ev of events) {
    if (ev.kind === "stage" && ev.state === "started" && ev.stage) {
      // A repeated `started` for the stage already open on top, with nothing
      // in between, is the same stage announced twice (a retry, two writers)
      // — one section, not a nest of one inside the other.
      const top = stack[stack.length - 1]!;
      if (top.section?.stage === ev.stage && top.children.length === 0) continue;
      stack.push({
        section: { kind: "section", key: `s${ev.id}`, stage: ev.stage, started: ev, ended: null, turn: turnOf(ev), children: [] },
        children: [],
      });
    } else if (ev.kind === "stage" && ev.stage && ev.state && ev.state !== "started") {
      const top = stack[stack.length - 1]!;
      if (top.section && top.section.stage === ev.stage) {
        stack.pop();
        close(top, ev);
      } else {
        pushEvent(ev); // mismatched close: loose
      }
    } else {
      pushEvent(ev);
    }
  }
  while (stack.length > 1) {
    const top = stack.pop()!;
    close(top, null);
  }
  return stack[0]!.children;
}

function dataField(ev: LogEvent, key: string): string | null {
  if (!ev.data) return null;
  try {
    const v = (JSON.parse(ev.data) as Record<string, unknown>)[key];
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

export function sectionState(s: Section): "running" | "done" | "failed" | "interrupted" | "unknown" {
  if (s.ended?.state === "done") return "done";
  if (s.ended?.state === "failed") return "failed";
  if (s.ended?.state === "interrupted") return "interrupted";
  if (s.started && !s.ended) return "running";
  return "unknown";
}

export function isSection(x: Section | LogEvent): x is Section {
  return (x as Section).kind === "section";
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}
