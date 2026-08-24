import { describe, expect, test } from "bun:test";
import { ASK_TIMEOUT_MS, digestLine, digestOf, timeLeft, type ConversationRef, type ItemEvent } from "./digest";

const T0 = Date.parse("2026-08-24T10:00:00Z");
const at = (mins: number) => new Date(T0 + mins * 60_000).toISOString();

let nextId = 1;
/** One stage event, on conversation `c`. `data` is the JSON Fountain rides along. */
const stage = (c: string, mins: number, s: string, state: string, data: Record<string, unknown> = {}): ItemEvent => ({
  id: nextId++,
  conversation_id: c,
  ts: at(mins),
  kind: "stage",
  stage: s,
  state: state as ItemEvent["state"],
  data: JSON.stringify(data),
});

const conv = (id: string, sandbox_id: string | null = `sb-${id}`, status: ConversationRef["status"] = "idle"): ConversationRef => ({
  id,
  status,
  sandbox_id,
});

describe("digest", () => {
  test("counts turns that ended after the mark, and ignores the ones before it", () => {
    const events = [
      stage("a", 0, "turn", "started", { turn_id: "t1" }),
      stage("a", 1, "turn", "done", { turn_id: "t1" }),
      stage("a", 20, "turn", "done", { turn_id: "t2" }),
      stage("a", 25, "turn", "failed", { turn_id: "t3", reason: "sprite connection lost" }),
      stage("b", 30, "turn", "interrupted", { turn_id: "t4" }),
    ];
    const d = digestOf({ events, conversations: [conv("a"), conv("b")], since: at(10), now: T0 + 60 * 60_000 });
    expect(d.finished).toBe(1);
    expect(d.failed).toBe(1);
    expect(d.interrupted).toBe(1);
    expect(d.quiet).toBe(false);
    expect(digestLine(d)).toBe("1 turn finished · 1 failed · 1 interrupted");
  });

  test("no mark yet: the whole history counts", () => {
    const events = [stage("a", 1, "turn", "done", { turn_id: "t1" }), stage("a", 2, "turn", "done", { turn_id: "t2" })];
    const d = digestOf({ events, conversations: [conv("a")], since: null, now: T0 + 60 * 60_000 });
    expect(d.finished).toBe(2);
    expect(digestLine(d)).toBe("2 turns finished");
  });

  test("a turn is counted once however many times it reports", () => {
    const events = [
      stage("a", 5, "turn", "done", { turn_id: "t1" }),
      stage("a", 5, "turn", "done", { turn_id: "t1" }),
      stage("a", 6, "turn", "done", { turn_id: "t1", turn_number: 1 }),
    ];
    const d = digestOf({ events, conversations: [conv("a")], since: null, now: T0 + 60 * 60_000 });
    expect(d.finished).toBe(1);
  });

  test("a held request is reported whoever raised it and whenever — the mark does not hide it", () => {
    const events = [
      // Raised well before the last look, and still nobody has answered.
      stage("a", 0, "request", "started", { request_id: "r1", tool: "Bash(rm -rf build)", timeout_ms: ASK_TIMEOUT_MS }),
    ];
    const d = digestOf({ events, conversations: [conv("a")], since: at(10), now: T0 + 60_000 });
    expect(d.waiting).toHaveLength(1);
    expect(d.waiting[0]).toMatchObject({ conversationId: "a", requestId: "r1", tool: "Bash(rm -rf build)" });
    expect(d.waiting[0]!.expiresAt).toBe(new Date(T0 + ASK_TIMEOUT_MS).toISOString());
  });

  test("an answered request stops waiting", () => {
    const events = [
      stage("a", 0, "request", "started", { request_id: "r1", tool: "Edit", timeout_ms: ASK_TIMEOUT_MS }),
      stage("a", 1, "request", "done", { request_id: "r1", outcome: "answered", option_id: "allow_once" }),
      stage("a", 2, "request", "started", { request_id: "r2", tool: "WebFetch", timeout_ms: ASK_TIMEOUT_MS }),
    ];
    const d = digestOf({ events, conversations: [conv("a")], since: null, now: T0 + 3 * 60_000 });
    expect(d.waiting.map((w) => w.requestId)).toEqual(["r2"]);
  });

  test("a request past its timeout is dropped, even with no close event for it", () => {
    // The tab that would have seen `request · done` was shut. Fountain denied
    // it five minutes in regardless, so the card must not still be waiting.
    const events = [stage("a", 0, "request", "started", { request_id: "r1", tool: "Bash", timeout_ms: ASK_TIMEOUT_MS })];
    expect(digestOf({ events, conversations: [conv("a")], since: null, now: T0 + 4 * 60_000 }).waiting).toHaveLength(1);
    expect(digestOf({ events, conversations: [conv("a")], since: null, now: T0 + 6 * 60_000 }).waiting).toHaveLength(0);
  });

  test("a retired conversation is not waiting on anybody", () => {
    const events = [stage("a", 0, "request", "started", { request_id: "r1", tool: "Bash", timeout_ms: ASK_TIMEOUT_MS })];
    const d = digestOf({ events, conversations: [conv("a", "sb-a", "terminated")], since: null, now: T0 + 60_000 });
    expect(d.waiting).toHaveLength(0);
  });

  test("requests come oldest first — the one closest to being denied is on top", () => {
    const events = [
      stage("b", 3, "request", "started", { request_id: "r2", tool: "Edit" }),
      stage("a", 1, "request", "started", { request_id: "r1", tool: "Bash" }),
    ];
    const d = digestOf({ events, conversations: [conv("a"), conv("b")], since: null, now: T0 + 4 * 60_000 });
    expect(d.waiting.map((w) => w.conversationId)).toEqual(["a", "b"]);
  });

  test("a computer that goes away is one line, not one per conversation on it", () => {
    // A reclaim is announced on every co-tenant of the sandbox.
    const events = [
      stage("a", 20, "sandbox", "done", { event: "reclaimed", reason: "idle_bound", message: "The computer was idle for an hour." }),
      stage("b", 20, "sandbox", "done", { event: "reclaimed", reason: "idle_bound", message: "The computer was idle for an hour." }),
    ];
    const d = digestOf({ events, conversations: [conv("a", "sb-1"), conv("b", "sb-1")], since: at(10), now: T0 + 60 * 60_000 });
    expect(d.gone).toHaveLength(1);
    expect(d.gone[0]).toMatchObject({ key: "sb-1", event: "reclaimed", message: "The computer was idle for an hour." });
    expect(digestLine(d)).toBe("1 computer gone");
  });

  test("parked, refused and adapter notices are not a computer going away", () => {
    const events = [
      stage("a", 20, "sandbox", "done", { event: "suspended", reason: "idle" }),
      stage("a", 21, "sandbox", "done", { event: "at_capacity", reason: "sandbox_at_capacity" }),
      stage("a", 22, "sandbox", "done", { event: "connection_lost", reason: "adapter exited" }),
      // The conversation ended but another one still holds the computer.
      stage("a", 23, "terminate", "done", { sandbox: "kept", reason: "held_by_another_conversation" }),
      stage("a", 24, "terminate", "done", { event: "released" }),
    ];
    const d = digestOf({ events, conversations: [conv("a")], since: at(10), now: T0 + 60 * 60_000 });
    expect(d.gone).toEqual([]);
    expect(d.quiet).toBe(true);
  });

  test("a bare terminate took the computer with it", () => {
    const events = [stage("a", 20, "terminate", "done")];
    const d = digestOf({ events, conversations: [conv("a")], since: at(10), now: T0 + 60 * 60_000 });
    expect(d.gone.map((g) => g.event)).toEqual(["retired"]);
  });

  test("computers that went away come newest first", () => {
    const events = [
      stage("a", 20, "terminate", "done"),
      stage("b", 40, "sandbox", "done", { event: "replaced", reason: "sprite_gone" }),
    ];
    const d = digestOf({ events, conversations: [conv("a", "sb-a"), conv("b", "sb-b")], since: at(10), now: T0 + 60 * 60_000 });
    expect(d.gone.map((g) => g.key)).toEqual(["sb-b", "sb-a"]);
  });

  test("nothing happened: quiet, and no line to show", () => {
    const events = [stage("a", 1, "turn", "done", { turn_id: "t1" })];
    const d = digestOf({ events, conversations: [conv("a")], since: at(10), now: T0 + 60 * 60_000 });
    expect(d.quiet).toBe(true);
    expect(digestLine(d)).toBe("");
  });

  test("output events and unparseable data are ignored, not counted", () => {
    const events: ItemEvent[] = [
      { id: 900, conversation_id: "a", ts: at(20), kind: "output", stream: "stdout", data: "not json" },
      { ...stage("a", 21, "turn", "done"), data: "{ broken" },
      stage("a", 22, "turn", "started", { turn_id: "t9" }),
    ];
    const d = digestOf({ events, conversations: [conv("a")], since: at(10), now: T0 + 60 * 60_000 });
    // The broken-data turn still ended, so it counts — on its event id, since
    // it named no turn. The output event and the turn that only started do not.
    expect(d.finished).toBe(1);
  });

  test("the mark is compared as an instant, not as text", () => {
    // The mark is a `toISOString`, which always writes a fraction; Fountain
    // writes none when there is none. As text "…:00Z" sorts *after*
    // "…:00.500Z", so a turn half a second before the last look would be
    // reported as news.
    const events: ItemEvent[] = [
      { id: 1, conversation_id: "a", ts: "2026-08-24T10:00:00Z", kind: "stage", stage: "turn", state: "done", data: JSON.stringify({ turn_id: "t1" }) },
    ];
    expect("2026-08-24T10:00:00Z" > "2026-08-24T10:00:00.500Z").toBe(true);
    const d = digestOf({ events, conversations: [conv("a")], since: "2026-08-24T10:00:00.500Z", now: T0 + 60_000 });
    expect(d.finished).toBe(0);
  });
});

describe("timeLeft", () => {
  test("counts down to the refusal", () => {
    expect(timeLeft(new Date(T0 + 240_000).toISOString(), T0)).toBe("4m left");
    expect(timeLeft(new Date(T0 + 40_000).toISOString(), T0)).toBe("40s left");
    expect(timeLeft(new Date(T0).toISOString(), T0)).toBe("expiring");
    expect(timeLeft("not a time", T0)).toBe("expiring");
  });
});
