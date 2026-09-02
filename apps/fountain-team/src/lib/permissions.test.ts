import { describe, expect, test } from "bun:test";
import type { LogEvent } from "../api/types";
import { asks, askFrom, describeResolution, describeTimeout, openAsk, optionTone, resolutionFrom, resolutions } from "./permissions";

function stage(state: string, data: unknown, id = 1, ts = "2026-08-22T00:00:00Z"): LogEvent {
  return { id, kind: "stage", stream: null, data: JSON.stringify(data), stage: "request", state, turn_id: null, ts };
}

const OPTIONS = [
  { optionId: "allow", name: "Allow once", kind: "allow_once" },
  { optionId: "no", name: "Reject", kind: "reject_once" },
];

describe("askFrom / resolutionFrom", () => {
  test("reads the ask, its tool and its timeout", () => {
    expect(askFrom(stage("started", { request_id: "41", tool: "Bash", timeout_ms: 300000 }))).toEqual({
      requestId: "41",
      tool: "Bash",
      timeoutMs: 300000,
      ts: "2026-08-22T00:00:00Z",
    });
  });

  test("a numeric request_id is read as the string the answer route takes", () => {
    expect(askFrom(stage("started", { request_id: 41 }))?.requestId).toBe("41");
  });

  test("only `request` stage events count", () => {
    const turnEvent: LogEvent = { ...stage("started", { request_id: "1" }), stage: "turn" };
    expect(askFrom(turnEvent)).toBeNull();
    const output: LogEvent = { ...stage("started", { request_id: "1" }), kind: "output" };
    expect(askFrom(output)).toBeNull();
  });

  test("a deny is state `done` too — the outcome is in the data, not the state", () => {
    expect(resolutionFrom(stage("done", { request_id: "41", outcome: "timeout", option_id: null }))).toEqual({
      requestId: "41",
      outcome: "timeout",
      optionId: null,
      ts: "2026-08-22T00:00:00Z",
    });
  });

  test("unparseable data resolves nothing rather than throwing", () => {
    const bad: LogEvent = { ...stage("done", {}), data: "not json" };
    expect(resolutionFrom(bad)).toBeNull();
    expect(resolutionFrom(stage("done", { outcome: "answered" }))).toBeNull();
  });
});

describe("resolutions", () => {
  test("pairs each request to how it ended", () => {
    const events = [
      stage("started", { request_id: "1", tool: "Bash" }, 1),
      stage("done", { request_id: "1", outcome: "answered", option_id: "allow" }, 2),
      stage("started", { request_id: "2", tool: "Edit" }, 3),
      stage("done", { request_id: "2", outcome: "timeout", option_id: null }, 4),
    ];
    const m = resolutions(events);
    expect(m.get("1")).toMatchObject({ outcome: "answered", optionId: "allow" });
    expect(m.get("2")).toMatchObject({ outcome: "timeout", optionId: null });
  });

  test("first answer wins, as it does server-side", () => {
    const events = [
      stage("done", { request_id: "1", outcome: "answered", option_id: "allow" }, 1),
      stage("done", { request_id: "1", outcome: "timeout", option_id: null }, 2),
    ];
    expect(resolutions(events).get("1")).toMatchObject({ outcome: "answered", optionId: "allow" });
  });
});

describe("openAsk", () => {
  test("nothing open once the request is resolved", () => {
    const events = [stage("started", { request_id: "1" }, 1), stage("done", { request_id: "1", outcome: "answered", option_id: "allow" }, 2)];
    expect(openAsk(events)).toBeNull();
  });

  test("an unresolved ask stays open", () => {
    const events = [stage("started", { request_id: "1", tool: "Bash", timeout_ms: 1000 }, 1)];
    expect(openAsk(events)).toMatchObject({ requestId: "1", tool: "Bash", timeoutMs: 1000 });
  });

  test("a later ask is what is open, even if an earlier one never resolved", () => {
    const events = [stage("started", { request_id: "1" }, 1), stage("started", { request_id: "2" }, 2)];
    expect(openAsk(events)?.requestId).toBe("2");
  });

  test("asks() keeps every ask, for its tool and timeout, resolved or not", () => {
    const events = [stage("started", { request_id: "1", timeout_ms: 300000 }, 1), stage("done", { request_id: "1", outcome: "answered", option_id: "allow" }, 2)];
    expect(asks(events).get("1")?.timeoutMs).toBe(300000);
  });
});

describe("describeResolution", () => {
  test("names the option the way the agent named it", () => {
    expect(describeResolution({ requestId: "1", outcome: "answered", optionId: "allow", ts: "" }, OPTIONS)).toBe("Allowed — Allow once");
    expect(describeResolution({ requestId: "1", outcome: "answered", optionId: "no", ts: "" }, OPTIONS)).toBe("Denied — Reject");
  });

  test("every not-answered ending reads as a deny, because it is one", () => {
    expect(describeResolution({ requestId: "1", outcome: "timeout", optionId: null, ts: "" }, OPTIONS)).toBe("Denied — nobody answered in time");
    expect(describeResolution({ requestId: "1", outcome: "turn_ended", optionId: null, ts: "" }, OPTIONS)).toBe("Denied — the turn ended first");
  });

  test("an option id that is not on the list is not guessed at", () => {
    expect(describeResolution({ requestId: "1", outcome: "answered", optionId: "mystery", ts: "" }, OPTIONS)).toBe("Answered");
    expect(describeResolution({ requestId: "1", outcome: "something_new", optionId: null, ts: "" }, OPTIONS)).toBe("Resolved");
  });
});

describe("optionTone / describeTimeout", () => {
  test("kind colours the button and nothing else", () => {
    expect(optionTone("allow_once")).toBe("allow");
    expect(optionTone("allow_always")).toBe("allow");
    expect(optionTone("reject_once")).toBe("reject");
    expect(optionTone("reject_always")).toBe("reject");
    expect(optionTone("")).toBe("neutral");
    expect(optionTone("something_new")).toBe("neutral");
  });

  test("the timeout is said in whole units", () => {
    expect(describeTimeout(300000)).toBe("5 minutes");
    expect(describeTimeout(60000)).toBe("1 minute");
    expect(describeTimeout(90000)).toBe("1 minute"); // rounded down: a deadline is never overstated
    expect(describeTimeout(30000)).toBe("30 seconds");
    expect(describeTimeout(null)).toBeNull();
    expect(describeTimeout(0)).toBeNull();
  });
});
