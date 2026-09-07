/**
 * One tab's live tail, as a state machine rather than an effect.
 *
 * This used to be the body of a `useEffect` in `App.tsx`, and two of its
 * variables — the newest event id and the reconnect backoff — were locals of
 * that effect. The effect was keyed on the active `Tab` *object*, which the
 * strip poll rebuilt every four seconds, so every poll re-ran it: the stream
 * was reopened with no `Last-Event-ID` (the whole history replayed, and every
 * replayed turn boundary re-read the receipt and the strip) and the backoff
 * went back to a second, so a 429 from Fountain never slowed anything down.
 * At its worst one tab was opening the stream nine times a second.
 *
 * Kept out of React so the rules are plain and testable:
 *
 *   - **Resume, do not replay.** `Last-Event-ID` is whatever this tail last
 *     saw for the conversation, and the catch-up read on open asks for events
 *     *after* it — a reconnect costs the gap, not the history.
 *   - **Back off only forward.** The backoff resets when a stream actually
 *     opens (`onOpen` fires only after a 200), never when one is retried.
 *   - **A 429 is the schedule.** `Retry-After` (plus jitter, via the shared
 *     `Hold`) is how long to wait, however short the backoff was.
 *   - **One tail per conversation id.** `start` is called once per id and
 *     `stop` once; nothing about state changes in between reaches here.
 */
import { ApiError } from "../api/client";
import type { SseMessage } from "./sse";
import type { LogEvent } from "../api/types";
import { Hold } from "./hold";

export interface TailClient {
  streamConversation(opts: {
    conversationId: string;
    lastEventId: string | null;
    streams: string[];
    signal: AbortSignal;
    onMessage: (msg: SseMessage) => void;
    onOpen?: () => void;
    onClose: (err?: unknown) => void;
  }): Promise<void>;
}

export interface TailOptions {
  conversationId: string;
  client: TailClient;
  streams: string[];
  /** Newest event id seen per conversation — shared across tails so a re-open resumes. */
  lastEventIds: Record<string, string>;
  /** The shared 429 pause. */
  hold: Hold;
  /** A stream is open; `after` is the newest id already held, for the catch-up read. */
  onOpen: (after: number | null) => void;
  onEvent: (ev: LogEvent) => void;
  /** A turn on this tab ended — the box is awake, the strip has moved. */
  onTurnEnded: () => void;
  /** Injectable for tests. */
  schedule?: (fn: () => void, ms: number) => unknown;
  random?: () => number;
}

/** The first retry, after a stream closes; doubles up to `MAX_BACKOFF_MS`. */
export const BASE_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 15_000;

export interface Tail {
  stop(): void;
  /** For tests and the panel: how many times a stream was opened (attempted). */
  readonly opens: number;
}

export function startTail(opts: TailOptions): Tail {
  const ctrl = new AbortController();
  const schedule = opts.schedule ?? ((fn, ms) => window.setTimeout(fn, ms));
  const random = opts.random ?? Math.random;
  const { conversationId } = opts;
  let stopped = false;
  let backoff = BASE_BACKOFF_MS;
  let opens = 0;

  const run = () => {
    if (stopped) return;
    opens += 1;
    const last = opts.lastEventIds[conversationId] ?? null;
    void opts.client.streamConversation({
      conversationId,
      lastEventId: last,
      streams: opts.streams,
      signal: ctrl.signal,
      onOpen: () => {
        if (stopped) return;
        // A real open — the reader fires this only after a 200 — is the one
        // thing that earns a reset.
        backoff = BASE_BACKOFF_MS;
        const after = last !== null ? Number(last) : null;
        opts.onOpen(Number.isFinite(after) ? after : null);
      },
      onMessage: (msg) => {
        if (stopped) return;
        if (msg.id) opts.lastEventIds[conversationId] = msg.id;
        let ev: LogEvent;
        try {
          ev = JSON.parse(msg.data) as LogEvent;
        } catch {
          return;
        }
        if (msg.id) ev.id = Number(msg.id);
        opts.onEvent(ev);
        if (ev.kind === "stage" && ev.stage === "turn" && ev.state !== "started") opts.onTurnEnded();
      },
      onClose: (err) => {
        if (stopped) return;
        opts.hold.note(err);
        // Whatever the server asked for wins over our own cadence; otherwise
        // wait the backoff, and grow it for next time. Jitter either way.
        const own = err instanceof ApiError && err.status === 429 ? 0 : backoff;
        const wait = Math.max(opts.hold.remainingMs(), own) + random() * 500;
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        schedule(run, wait);
      },
    });
  };
  run();

  return {
    stop() {
      stopped = true;
      ctrl.abort();
    },
    get opens() {
      return opens;
    },
  };
}
