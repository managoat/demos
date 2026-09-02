/**
 * The other half of a permission request (fountain#940).
 *
 * The request itself is a block in the transcript (`acp.ts`), and log events
 * are immutable — so a block can never become "answered". The resolution
 * arrives as its own `request` stage event and is paired here on
 * `request_id`, the same pass that pairs a tool result to its tool call.
 *
 * ```
 * stage=request state=started  {request_id, tool, options, timeout_ms}
 * stage=request state=done     {request_id, outcome, option_id}
 * ```
 *
 * `state` is `done` for every ending, including a deny: the stage and its
 * status are a Prometheus counter's only tags server-side, so the outcome
 * lives in the data rather than in the state. Read `outcome`, not `state`.
 *
 * A card can resolve **without this client answering it**: another attached
 * client may answer first, the server denies on a timeout, and the turn's end
 * refuses whatever is still open. All three land here the same way.
 */
import type { LogEvent } from "../api/types";
import type { PermissionOption } from "./acp";

/** How a request ended. Unknown strings are possible — a newer server may add one. */
export type Outcome = "answered" | "timeout" | "turn_ended" | (string & {});

/** A request the agent is blocked on, as the `started` stage event announced it. */
export interface PermissionAsk {
  requestId: string;
  /** the tool being asked about, as the transcript labels it */
  tool: string | null;
  /** how long the server waits before denying it, ms */
  timeoutMs: number | null;
  ts: string;
}

export interface PermissionResolution {
  requestId: string;
  outcome: Outcome;
  /** the option that was selected — only ever set when `outcome` is "answered" */
  optionId: string | null;
  ts: string;
}

function dataOf(ev: LogEvent): Record<string, unknown> | null {
  if (ev.kind !== "stage" || ev.stage !== "request" || typeof ev.data !== "string") return null;
  try {
    const v: unknown = JSON.parse(ev.data);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function requestId(d: Record<string, unknown>): string | null {
  const id = d.request_id;
  return typeof id === "string" ? id : typeof id === "number" ? String(id) : null;
}

/** The ask, if this event is one. */
export function askFrom(ev: LogEvent): PermissionAsk | null {
  if (ev.state !== "started") return null;
  const d = dataOf(ev);
  if (!d) return null;
  const id = requestId(d);
  if (!id) return null;
  return {
    requestId: id,
    tool: typeof d.tool === "string" ? d.tool : null,
    timeoutMs: typeof d.timeout_ms === "number" ? d.timeout_ms : null,
    ts: ev.ts,
  };
}

/** The resolution, if this event is one. */
export function resolutionFrom(ev: LogEvent): PermissionResolution | null {
  if (ev.state !== "done") return null;
  const d = dataOf(ev);
  if (!d) return null;
  const id = requestId(d);
  if (!id) return null;
  return {
    requestId: id,
    outcome: typeof d.outcome === "string" ? d.outcome : "turn_ended",
    optionId: typeof d.option_id === "string" ? d.option_id : null,
    ts: ev.ts,
  };
}

/** request_id → how it ended, for every request these events resolved. */
export function resolutions(events: LogEvent[]): Map<string, PermissionResolution> {
  const out = new Map<string, PermissionResolution>();
  for (const ev of events) {
    const r = resolutionFrom(ev);
    // First answer wins server-side, so a first resolution wins here too.
    if (r && !out.has(r.requestId)) out.set(r.requestId, r);
  }
  return out;
}

/** request_id → the ask that opened it, for the tool name and the timeout. */
export function asks(events: LogEvent[]): Map<string, PermissionAsk> {
  const out = new Map<string, PermissionAsk>();
  for (const ev of events) {
    const a = askFrom(ev);
    if (a) out.set(a.requestId, a);
  }
  return out;
}

/**
 * The request still waiting in these events, if any.
 *
 * One at a time: the agent cannot proceed until it is answered, so a second
 * ask cannot overlap the first.
 */
export function openAsk(events: LogEvent[]): PermissionAsk | null {
  let open: PermissionAsk | null = null;
  for (const ev of events) {
    const ask = askFrom(ev);
    if (ask) {
      open = ask;
      continue;
    }
    const done = resolutionFrom(ev);
    if (done && open?.requestId === done.requestId) open = null;
  }
  return open;
}

/** Which way an option goes, for colouring only — never for deciding what is sent. */
export function optionTone(kind: string): "allow" | "reject" | "neutral" {
  if (kind.startsWith("allow")) return "allow";
  if (kind.startsWith("reject")) return "reject";
  return "neutral";
}

/**
 * What happened to a request, in one line.
 *
 * `options` is the list the request carried, so an answer can be named the
 * way the agent named it rather than by a raw id.
 */
export function describeResolution(r: PermissionResolution, options: { optionId: string; name: string; kind: string }[]): string {
  switch (r.outcome) {
    case "answered": {
      const picked = options.find((o) => o.optionId === r.optionId);
      if (!picked) return "Answered";
      return optionTone(picked.kind) === "reject" ? `Denied — ${picked.name}` : `Allowed — ${picked.name}`;
    }
    case "timeout":
      return "Denied — nobody answered in time";
    case "turn_ended":
      return "Denied — the turn ended first";
    default:
      return "Resolved";
  }
}

/**
 * What an option changes beyond this one call, in one line.
 *
 * The scope half is the point. "Always Allow" is the agent's label, not its
 * behaviour: claude writes a rule matching the exact command line into the
 * teammate's sandbox, so the same tool with a different argument asks again
 * and the rule is gone once the sandbox is. Someone who answers "always" and
 * is asked again a minute later has been told the truth by the agent and had
 * it withheld by us — the metadata was in the request all along.
 *
 * Only the agent's own wording is shown. Where it says nothing, we say
 * nothing: no scope suffix is guessed from a `kind`.
 */
export function describeEffects(option: PermissionOption): string | null {
  const lines = option.effects.map((e) => {
    const scope = describeScope(e.scope);
    return scope ? `${e.description} — ${scope}` : e.description;
  });
  return lines.length > 0 ? lines.join("; ") : null;
}

/**
 * ACP's lifetime scope, in words.
 *
 * `persistent` is deliberately not called "forever": the rule is written to
 * a file inside the teammate's sandbox, which outlives the turn and does not
 * outlive the sandbox. `session` is left as the protocol's own word rather
 * than translated into a number of turns — how long an agent's session lasts
 * is the agent's business, and guessing it here would be the same
 * over-promise one level down.
 */
function describeScope(scope: string | null): string | null {
  switch (scope) {
    case "persistent":
      return "saved in the sandbox";
    case "session":
      return "this session only";
    default:
      return null;
  }
}

/**
 * "5 minutes" / "30 seconds", for saying how long an unanswered ask has.
 *
 * Minutes are rounded *down*, never up: this is a deadline, and telling
 * someone they have more time than they do is the one error that costs them
 * the request.
 */
export function describeTimeout(ms: number | null): string | null {
  if (!ms || ms <= 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} seconds`;
  const m = Math.max(1, Math.floor(s / 60));
  return `${m} minute${m === 1 ? "" : "s"}`;
}
