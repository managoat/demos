/**
 * What a task card's live tail (and the coordinator bubble) shows, from
 * stored/streamed log events.
 *
 * Mission Control asks Fountain for server-parsed blocks (`?blocks=true` on
 * both the events endpoint and the global stream) — the exact parse the
 * Fountain web UI uses. Events that arrive without a `blocks` field (older
 * events, the dev mock) fall back to the client-side ACP parser in `acp.ts`.
 */
import type { LogEvent } from "../api/types";
import { blocksForTurn, type Block as AcpBlock } from "./acp";

export type ViewBlock =
  | { kind: "text"; body: string }
  | { kind: "thinking"; body: string }
  | { kind: "tool"; id: string | null; name: string; summary: string; status: "running" | "done" | "error"; output: string }
  | { kind: "raw"; body: string };

/** Blocks for a set of events, adjacent text merged, tools paired on id. */
export function viewBlocks(events: LogEvent[], runtime: string): ViewBlock[] {
  if (!events.some((e) => Array.isArray(e.blocks))) {
    return blocksForTurn(events, runtime).map(fromAcp);
  }
  const out: ViewBlock[] = [];
  const tools = new Map<string, Extract<ViewBlock, { kind: "tool" }>>();
  const pushText = (kind: "text" | "thinking", body: string) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.body += body;
    else out.push({ kind, body });
  };
  for (const ev of events) {
    if (ev.kind !== "output" || !Array.isArray(ev.blocks)) continue;
    for (const b of ev.blocks) {
      switch (b.kind) {
        case "text":
        case "thinking":
          if (b.body) pushText(b.kind, b.body);
          break;
        case "tool_use": {
          const block: Extract<ViewBlock, { kind: "tool" }> = {
            kind: "tool",
            id: b.id ?? null,
            name: b.name ?? "tool",
            summary: b.summary ?? "",
            status: "running",
            output: "",
          };
          out.push(block);
          if (b.id) tools.set(b.id, block);
          break;
        }
        case "tool_result": {
          const block = b.tool_id ? tools.get(b.tool_id) : undefined;
          if (block) {
            block.status = b.error ? "error" : "done";
            block.output = b.body ?? "";
          }
          break;
        }
        case "error":
        case "raw":
          if (b.body) out.push({ kind: "raw", body: b.body });
          break;
        default:
          break; // init/result are session chrome, not content
      }
    }
  }
  return out;
}

/** The concatenated assistant text — what the protocol parser reads. */
export function replyText(events: LogEvent[], runtime: string): string {
  return viewBlocks(events, runtime)
    .filter((b): b is Extract<ViewBlock, { kind: "text" }> => b.kind === "text")
    .map((b) => b.body)
    .join("")
    .trim();
}

/** Group events by turn and return oldest-first `{turn_id, events}` buckets. */
export function eventsByTurn(events: LogEvent[]): Map<string, LogEvent[]> {
  const byTurn = new Map<string, LogEvent[]>();
  for (const ev of events) {
    if (!ev.turn_id) continue;
    const list = byTurn.get(ev.turn_id);
    if (list) list.push(ev);
    else byTurn.set(ev.turn_id, [ev]);
  }
  return byTurn;
}

/** The provisioning boot sequence: each stage's newest state, in first-seen order. */
export function bootSequence(events: LogEvent[]): Array<{ stage: string; state: string }> {
  const order: string[] = [];
  const states = new Map<string, string>();
  for (const ev of events) {
    if (ev.kind !== "stage" || !ev.stage || ev.stage === "turn") continue;
    if (!states.has(ev.stage)) order.push(ev.stage);
    states.set(ev.stage, ev.state ?? "started");
  }
  return order.map((stage) => ({ stage, state: states.get(stage)! }));
}

/** True once the runtime session is up — the boot sequence is over. */
export function sessionReady(events: LogEvent[]): boolean {
  return events.some(
    (e) => (e.kind === "stage" && e.stage === "session" && e.state === "done") || (e.kind === "output" && e.stream === "acp"),
  );
}

function fromAcp(b: AcpBlock): ViewBlock {
  switch (b.kind) {
    case "text":
      return { kind: "text", body: b.body };
    case "thinking":
      return { kind: "thinking", body: b.body };
    case "tool":
      return { kind: "tool", id: b.id, name: b.name, summary: b.summary, status: b.status, output: b.output };
    default:
      return { kind: "raw", body: b.body };
  }
}
