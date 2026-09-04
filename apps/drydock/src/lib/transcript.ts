/**
 * One thread's transcript: everything it has said, and everything it is about
 * to.
 *
 * Two sources for one list. `GET /api/threads/:id/events` is the history, paged
 * forward from an event id; `GET /api/threads/:id/stream` is the live tail,
 * which is server-sent events read with `fetch` rather than `EventSource`
 * because this one resumes with `Last-Event-ID` and `EventSource` will not be
 * told what that is. The SSE reader itself is the suite's shared one.
 *
 * The tail is not trusted to be complete. Every time it opens — the first
 * time and after every drop — the history is re-read from the newest id we
 * hold, because the events between the drop and the reconnect are exactly the
 * ones nobody would notice were missing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readSse } from "@managoat/fountain-app";
import { ApiError, eventsUrl, transcriptUrl } from "../api/client";
import { foldEvents, newestEventId, type TranscriptEvent, type TranscriptItem } from "./blocks";

export interface TranscriptState {
  items: TranscriptItem[];
  /** True while the live tail is open. False means history only. */
  connected: boolean;
  /** The server's own words, or null. */
  error: string | null;
  reload: () => void;
}

/** How many times the tail may fail to open before we stop and say so. */
const GIVE_UP_AFTER = 5;
/** A stream that stayed open this long was healthy; ending it is a timeout, not a fault. */
const HEALTHY_MS = 5000;
/** History is paged, and a thread that somehow has more than this has other problems. */
const MAX_PAGES = 40;

export function useTranscript(threadId: string | null, enabled: boolean): TranscriptState {
  const [events, setEvents] = useState<TranscriptEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Read by the effect's closures; a ref so reconnecting never restarts them.
  const newest = useRef(0);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    newest.current = 0;
    setEvents([]);
    setConnected(false);
    setError(null);
    if (!threadId || !enabled) return;

    const ctrl = new AbortController();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let openedAt = 0;

    // A reconnect replays from `Last-Event-ID`, and a history page overlaps the
    // tail. Both are correct and both arrive twice; the fold would collapse
    // them anyway, but not holding them is cheaper than folding them away.
    const seen = new Set<number>();
    const absorb = (incoming: TranscriptEvent[]) => {
      if (stopped) return;
      const fresh = incoming.filter((ev) => !seen.has(ev.id));
      if (fresh.length === 0) return;
      for (const ev of fresh) seen.add(ev.id);
      newest.current = Math.max(newest.current, newestEventId(fresh));
      setEvents((prev) => [...prev, ...fresh]);
    };

    /** Everything since the newest event we hold. Throws with the server's message. */
    const catchUp = async () => {
      let cursor = newest.current;
      for (let page = 0; page < MAX_PAGES; page++) {
        const { data, next } = await fetchEvents(threadId, cursor, ctrl.signal);
        absorb(data);
        const advanced = Math.max(cursor, newestEventId(data), next ?? 0);
        // No more pages, or a page that did not move — either way, stop rather
        // than ask the same question forever.
        if (next === null || advanced <= cursor) return;
        cursor = advanced;
      }
    };

    const tail = () => {
      if (stopped) return;
      void readSse(transcriptUrl(threadId), {
        lastEventId: newest.current > 0 ? String(newest.current) : null,
        signal: ctrl.signal,
        onOpen: () => {
          if (stopped) return;
          openedAt = Date.now();
          setConnected(true);
          setError(null);
          // Whatever happened while nobody was listening.
          void catchUp().catch((err: unknown) => {
            if (!stopped) setError(messageOf(err));
          });
        },
        onMessage: (msg) => {
          if (stopped || !msg.data) return;
          let ev: TranscriptEvent;
          try {
            ev = JSON.parse(msg.data) as TranscriptEvent;
          } catch {
            return; // a heartbeat, or a frame from a Fountain newer than this app
          }
          const id = msg.id ? Number(msg.id) : ev.id;
          if (!Number.isFinite(id)) return;
          absorb([{ ...ev, id }]);
        },
        onClose: (err) => {
          if (stopped) return;
          setConnected(false);
          // A connection that stood up for a while and then ended is Fountain's
          // idle timeout, not a failure — that one reconnects immediately and
          // forever. Only a stream that dies on arrival counts against us.
          failures = openedAt > 0 && Date.now() - openedAt > HEALTHY_MS ? 1 : failures + 1;
          openedAt = 0;
          if (failures > GIVE_UP_AFTER) {
            void explain(threadId, ctrl.signal).then((said) => {
              if (!stopped) setError(said ?? streamMessage(err));
            });
            return;
          }
          timer = setTimeout(tail, Math.min(1000 * 2 ** (failures - 1), 15000));
        },
      });
    };

    void (async () => {
      try {
        // History before the tail, so the transcript paints even where the
        // stream cannot open at all.
        await catchUp();
      } catch (err) {
        if (!stopped) setError(messageOf(err));
        return;
      }
      tail();
    })();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      // Aborts the reader mid-body. Without this a thread switch leaves the
      // old stream draining into a component that is no longer on screen.
      ctrl.abort();
    };
  }, [threadId, enabled, attempt]);

  const items = useMemo(() => foldEvents(events), [events]);
  return { items, connected, error, reload };
}

/** One page of history, and the id to ask from next. */
async function fetchEvents(
  threadId: string,
  after: number,
  signal: AbortSignal,
): Promise<{ data: TranscriptEvent[]; next: number | null }> {
  const res = await fetch(eventsUrl(threadId, after > 0 ? after : undefined), {
    headers: { accept: "application/json" },
    signal,
  });
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!res.ok) {
    const body = (parsed ?? {}) as { error?: string; message?: string };
    throw new ApiError(res.status, body.error ?? "error", body.message ?? `The server answered ${res.status}.`);
  }
  const body = (parsed ?? {}) as { data?: TranscriptEvent[]; meta?: { has_more?: boolean; next_cursor?: unknown } };
  const data = Array.isArray(body.data) ? body.data : [];
  const cursor = Number(body.meta?.next_cursor);
  const next = body.meta?.has_more && Number.isFinite(cursor) ? cursor : null;
  return { data, next };
}

/**
 * Why the stream will not open, in the server's words.
 *
 * The SSE reader only ever learns a status code, and "stream 409" is not
 * something to put on screen. The events route fails the same way for the same
 * reasons and answers with a sentence, so it is asked instead.
 */
async function explain(threadId: string, signal: AbortSignal): Promise<string | null> {
  try {
    await fetchEvents(threadId, 0, signal);
    return null;
  } catch (err) {
    return err instanceof ApiError ? err.message : null;
  }
}

function streamMessage(err: unknown): string {
  const detail = err instanceof Error ? err.message : "";
  return detail
    ? `The live connection to this thread keeps dropping (${detail}). What is above may be out of date.`
    : "The live connection to this thread keeps dropping. What is above may be out of date.";
}

function messageOf(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "The transcript could not be read.";
}
