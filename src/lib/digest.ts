/**
 * What happened on a work item while you were not looking.
 *
 * Walking up to an item should tell you where it stands without opening every
 * conversation on it. Everything here is folded out of the `stage` stream the
 * project already carries (server/proxy.ts filters it per project) plus the
 * conversation list — no new route, and nothing the page did not already have
 * a way to read.
 *
 * Fountain's stage vocabulary, as this reads it:
 *
 *   turn      started · done · failed · interrupted   `turn_id`, `turn_number`
 *   request   started · done                          `request_id`, `tool`,
 *                                                     `options`, `timeout_ms`;
 *                                                     `outcome` on the close
 *   sandbox   done                                    `event`: suspended,
 *                                                     reclaimed, replaced,
 *                                                     reset, at_capacity, …
 *   terminate done                                    `sandbox: "kept"` or
 *                                                     `event: "released"` when
 *                                                     the computer stayed up
 *
 * **A held permission request is current state, not history.** Everything else
 * here is counted since the mark; a request the agent is still blocked on is
 * reported whether it was raised before your last look or after it. Glancing
 * at the page must not make "3 agents are blocked waiting on you" disappear.
 *
 * A request nobody answers is denied by Fountain after `timeout_ms` (five
 * minutes, docs/concepts/permissions.md), which arrives as `request · done`.
 * That close can be missed — a tab that was shut when it happened has no
 * event for it — so an expired request is dropped here too, on the same
 * deadline. A card that waits forever would be a card that lies.
 */
import type { Conversation, LogEvent } from "../types";

/** A stage event tagged with the conversation it came from — the stream's own shape. */
export type { UserEvent as ItemEvent } from "../types";
import type { UserEvent as ItemEvent } from "../types";

/** As much of a conversation as the digest reads. */
export type ConversationRef = Pick<Conversation, "id" | "status" | "sandbox_id">;

/**
 * What about a conversation, when it moves, means there may be lifecycle to go
 * and read: the status — a turn boundary, a fast failure — and the computer it
 * is on. The rest of a conversation moves without the lifecycle moving: a title
 * arrives, a line of output lands, `last_active_at` ticks three times a second.
 */
export function historyKey(c: ConversationRef): string {
  return `${c.status}:${c.sandbox_id ?? ""}`;
}

/**
 * Of `refs`, the ones whose history has not been read at the state they are in
 * now: new to the item, or moved since they were last read. `read` is what the
 * caller has an answer in hand for, so a conversation that did not answer stays
 * stale and is asked again rather than being written off.
 *
 * This is why an item with N conversations costs one request at a turn
 * boundary rather than N: only the conversation whose status flipped is stale.
 */
export function staleRefs(refs: readonly ConversationRef[], read: ReadonlyMap<string, string>): ConversationRef[] {
  return refs.filter((c) => read.get(c.id) !== historyKey(c));
}

/** Fountain's own default when a `request · started` carried no `timeout_ms`. */
export const ASK_TIMEOUT_MS = 5 * 60 * 1000;

/** The `sandbox · done` events that mean the machine is not coming back. */
const SANDBOX_GONE = new Set(["reclaimed", "replaced", "reset"]);

/** An agent holding a tool call, waiting to be told whether to run it. */
export interface Waiting {
  conversationId: string;
  requestId: string;
  /** The tool it is asking about, in the runtime's words. */
  tool: string | null;
  askedAt: string;
  /** When Fountain denies it on its own. */
  expiresAt: string;
}

/** A computer that went away. */
export interface Gone {
  /** The sandbox, or the conversation when we never learned its id. */
  key: string;
  /** One of the conversations that was on it. */
  conversationId: string;
  /** `reclaimed`, `replaced`, `reset`, or `retired`. */
  event: string;
  at: string;
  /** Fountain's own sentence about it, when it sent one. */
  message: string | null;
}

export interface Digest {
  /** The mark this was measured from; null means the item's whole history. */
  since: string | null;
  /** Turns that reached an end since the mark. */
  finished: number;
  failed: number;
  interrupted: number;
  /** Computers that went away since the mark, newest first. */
  gone: Gone[];
  /** Requests still held, oldest first. Not filtered by the mark — see above. */
  waiting: Waiting[];
  /** Nothing to report. */
  quiet: boolean;
}

export interface DigestInput {
  /** Stage events for the item's conversations, in any order. */
  events: ItemEvent[];
  conversations: ConversationRef[];
  since: string | null;
  /** Injected by the tests; the clock the timeout is measured against. */
  now?: number;
}

export function digestOf({ events, conversations, since, now = Date.now() }: DigestInput): Digest {
  const convs = new Map(conversations.map((c) => [c.id, c]));
  // Log-event ids are global and monotonic, so this orders across conversations.
  const ordered = [...events].sort((a, b) => a.id - b.id);

  // Keyed by turn, so a turn that somehow reports twice is still one turn.
  const outcomes = new Map<string, "done" | "failed" | "interrupted">();
  const held = new Map<string, Waiting>();
  const gone = new Map<string, Gone>();

  for (const ev of ordered) {
    if (ev.kind !== "stage" || !ev.stage) continue;
    const d = dataOf(ev);

    if (ev.stage === "turn") {
      if (ev.state !== "done" && ev.state !== "failed" && ev.state !== "interrupted") continue;
      if (!after(ev.ts, since)) continue;
      outcomes.set(str(d.turn_id) ?? `${ev.conversation_id}:${ev.id}`, ev.state);
      continue;
    }

    if (ev.stage === "request") {
      const requestId = str(d.request_id);
      if (!requestId) continue;
      const key = `${ev.conversation_id}:${requestId}`;
      if (ev.state !== "started") {
        held.delete(key); // answered, denied, timed out, or the turn ended under it
        continue;
      }
      const ms = typeof d.timeout_ms === "number" && d.timeout_ms > 0 ? d.timeout_ms : ASK_TIMEOUT_MS;
      const asked = Date.parse(ev.ts);
      held.set(key, {
        conversationId: ev.conversation_id,
        requestId,
        tool: str(d.tool),
        askedAt: ev.ts,
        expiresAt: new Date((Number.isNaN(asked) ? now : asked) + ms).toISOString(),
      });
      continue;
    }

    const event = wentAway(ev, d);
    if (!event || !after(ev.ts, since)) continue;
    // A machine going away is announced on every conversation that was on it.
    // The computer went away once, so the digest says so once.
    const key = convs.get(ev.conversation_id)?.sandbox_id ?? `conv:${ev.conversation_id}`;
    if (!gone.has(key)) gone.set(key, { key, conversationId: ev.conversation_id, event, at: ev.ts, message: str(d.message) });
  }

  const counts = [...outcomes.values()];
  const waiting = [...held.values()]
    .filter((w) => Date.parse(w.expiresAt) > now)
    // A conversation that has ended is not waiting on anybody, whatever the
    // last event we hold for it says.
    .filter((w) => {
      const status = convs.get(w.conversationId)?.status;
      return status !== "terminated" && status !== "failed";
    })
    .sort((a, b) => a.askedAt.localeCompare(b.askedAt));

  const digest: Digest = {
    since,
    finished: counts.filter((s) => s === "done").length,
    failed: counts.filter((s) => s === "failed").length,
    interrupted: counts.filter((s) => s === "interrupted").length,
    gone: [...gone.values()].sort((a, b) => b.at.localeCompare(a.at)),
    waiting,
    quiet: false,
  };
  digest.quiet = digest.finished + digest.failed + digest.interrupted + digest.gone.length + digest.waiting.length === 0;
  return digest;
}

/** The counted half of a digest as one line. Empty when there is nothing to count. */
export function digestLine(d: Digest): string {
  const parts: string[] = [];
  if (d.finished) parts.push(`${d.finished} turn${d.finished === 1 ? "" : "s"} finished`);
  if (d.failed) parts.push(`${d.failed} failed`);
  if (d.interrupted) parts.push(`${d.interrupted} interrupted`);
  if (d.gone.length) parts.push(`${d.gone.length} computer${d.gone.length === 1 ? "" : "s"} gone`);
  return parts.join(" · ");
}

/** "4m left" — how long before Fountain answers a held request with a refusal. */
export function timeLeft(iso: string, now = Date.now()): string {
  const secs = Math.round((Date.parse(iso) - now) / 1000);
  if (Number.isNaN(secs) || secs <= 0) return "expiring";
  if (secs < 60) return `${secs}s left`;
  return `${Math.round(secs / 60)}m left`;
}

/**
 * Whether a machine notice means the computer is gone. Suspended is a parked
 * disk that the next prompt wakes, `at_capacity` is a refused turn, and
 * `connection_lost` is the adapter rather than the machine — none of those is
 * a computer that went away.
 */
function wentAway(ev: LogEvent, d: Record<string, unknown>): string | null {
  if (ev.state !== "done") return null;
  if (ev.stage === "terminate") {
    if (str(d.sandbox) === "kept" || str(d.event) === "released") return null;
    return "retired";
  }
  if (ev.stage === "sandbox") {
    const event = str(d.event);
    return event && SANDBOX_GONE.has(event) ? event : null;
  }
  return null;
}

/**
 * Timestamps are compared as instants, not as text: Fountain writes more
 * decimal places than `toISOString` does, and `"…:00.123456Z" < "…:00.123Z"`
 * as a string.
 */
function after(ts: string, since: string | null): boolean {
  if (!since) return true;
  const a = Date.parse(ts);
  const b = Date.parse(since);
  return Number.isNaN(a) || Number.isNaN(b) ? true : a > b;
}

/** A stage event's metadata, which rides along as JSON in `data`. */
export function dataOf(ev: LogEvent): Record<string, unknown> {
  if (!ev.data) return {};
  try {
    const v = JSON.parse(ev.data) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

// ── the mark: when you last looked at an item ────────────────────────────

const SEEN_PREFIX = "fountain-workbench.itemSeen.";

/** When this browser last looked at the item, or null if it never has. */
export function loadSeen(itemId: string): string | null {
  try {
    return localStorage.getItem(SEEN_PREFIX + itemId);
  } catch {
    return null;
  }
}

export function saveSeen(itemId: string, iso: string = new Date().toISOString()): void {
  try {
    localStorage.setItem(SEEN_PREFIX + itemId, iso);
  } catch {
    // No storage: every visit is a first visit, and the digest covers the
    // item's whole history. Noisy, never wrong.
  }
}
