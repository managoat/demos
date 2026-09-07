import { describe, expect, test } from "bun:test";
import { ApiError } from "../api/client";
import { Hold } from "./hold";
import type { SseMessage } from "./sse";
import { BASE_BACKOFF_MS, startTail, type TailClient } from "./tail";

/**
 * A stream the test drives by hand: `open()` answers 200, `emit()` sends a
 * frame, `close()` ends it. Each `streamConversation` call is one open attempt.
 */
function fakeClient() {
  const attempts: { lastEventId: string | null; onMessage: (m: SseMessage) => void; onOpen?: () => void; onClose: (e?: unknown) => void }[] = [];
  const client: TailClient = {
    streamConversation(opts) {
      attempts.push({ lastEventId: opts.lastEventId, onMessage: opts.onMessage, onOpen: opts.onOpen, onClose: opts.onClose });
      return new Promise(() => undefined);
    },
  };
  return { client, attempts, last: () => attempts[attempts.length - 1]! };
}

const stage = (id: number, state: string): SseMessage => ({ id: String(id), event: "stage", data: JSON.stringify({ kind: "stage", stage: "turn", state }) });

function tail(opts: Partial<Parameters<typeof startTail>[0]> = {}) {
  const f = fakeClient();
  const scheduled: number[] = [];
  const calls = { open: [] as (number | null)[], events: 0, turnsEnded: 0 };
  const lastEventIds: Record<string, string> = {};
  const t = startTail({
    conversationId: "c1",
    client: f.client,
    streams: ["events"],
    lastEventIds,
    hold: new Hold(() => 0, () => 0),
    onOpen: (after) => calls.open.push(after),
    onEvent: () => (calls.events += 1),
    onTurnEnded: () => (calls.turnsEnded += 1),
    schedule: (_fn, ms) => scheduled.push(ms),
    random: () => 0,
    ...opts,
  });
  return { ...f, t, scheduled, calls, lastEventIds };
}

describe("the live tail", () => {
  test("a turn ending on the stream does not reopen it, and is reported once", () => {
    const x = tail();
    x.last().onOpen!();
    x.last().onMessage(stage(41, "started"));
    x.last().onMessage(stage(42, "completed"));
    expect(x.attempts).toHaveLength(1);
    expect(x.t.opens).toBe(1);
    expect(x.calls.turnsEnded).toBe(1);
    expect(x.calls.events).toBe(2);
    expect(x.scheduled).toEqual([]);
    x.t.stop();
  });

  test("a closed stream is retried after the backoff, not at once", () => {
    const x = tail();
    x.last().onOpen!();
    expect(x.calls.open).toEqual([null]);
    x.last().onMessage(stage(7, "completed"));
    x.last().onClose();
    expect(x.scheduled).toEqual([BASE_BACKOFF_MS]);
    expect(x.lastEventIds.c1).toBe("7");
    x.t.stop();
  });

  test("resume: the second open carries the id the first one saw", () => {
    const fns: (() => void)[] = [];
    const x = tail({ schedule: (fn) => fns.push(fn) });
    x.last().onOpen!();
    x.last().onMessage(stage(7, "completed"));
    x.last().onClose();
    fns.shift()!();
    expect(x.attempts).toHaveLength(2);
    expect(x.last().lastEventId).toBe("7");
    x.last().onOpen!();
    expect(x.calls.open).toEqual([null, 7]);
    x.t.stop();
  });

  test("the backoff grows across failed opens and resets only on a real open", () => {
    const fns: (() => void)[] = [];
    const delays: number[] = [];
    const x = tail({
      schedule: (fn, ms) => {
        fns.push(fn);
        delays.push(ms);
      },
    });
    x.last().onClose(new Error("stream 502"));
    fns.shift()!();
    x.last().onClose(new Error("stream 502"));
    fns.shift()!();
    x.last().onClose(new Error("stream 502"));
    expect(delays).toEqual([1000, 2000, 4000]);
    fns.shift()!();
    x.last().onOpen!();
    x.last().onClose();
    expect(delays[3]).toBe(1000);
    x.t.stop();
  });

  test("a 429 waits what the server asked, not the backoff", () => {
    const fns: (() => void)[] = [];
    const delays: number[] = [];
    const x = tail({
      hold: new Hold(() => 0, () => 0),
      schedule: (fn, ms) => {
        fns.push(fn);
        delays.push(ms);
      },
    });
    x.last().onClose(new ApiError(429, "rate_limited", "slow down", 35));
    expect(delays).toEqual([35_000]);
    x.t.stop();
  });

  test("stopped means stopped: nothing is scheduled after stop", () => {
    const x = tail();
    x.t.stop();
    x.last().onClose();
    x.last().onMessage(stage(1, "completed"));
    expect(x.scheduled).toEqual([]);
    expect(x.calls.turnsEnded).toBe(0);
  });
});
