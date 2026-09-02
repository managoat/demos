import { describe, expect, test } from "bun:test";
import { childMode, defaultOpen, eventVisible, formatDurationMs, hiddenInPretty, sectionDuration, stageExtra, stageIcon } from "./stages";
import type { Section } from "./blocks";
import type { LogEvent } from "../api/types";

const ev = (over: Partial<LogEvent>): LogEvent => ({ id: 1, kind: "output", stream: "stdout", data: "", stage: null, state: null, turn_id: null, ts: "", ...over });

describe("stages", () => {
  test("icons", () => {
    expect(stageIcon("turn")).toBe("💬");
    expect(stageIcon("nope")).toBe("•");
  });
  test("stageExtra decodes k=v and truncates", () => {
    expect(stageExtra('{"exit_code":0,"count":3}')).toBe("exit_code=0 count=3");
    expect(stageExtra('{"message":"hi","x":null,"y":""}')).toBe("hi");
    expect(stageExtra("not json")).toBe("not json");
    expect(stageExtra(`{"v":"${"a".repeat(100)}"}`).length).toBeLessThanOrEqual(42);
  });
  test("durations", () => {
    expect(formatDurationMs(450)).toBe("450ms");
    expect(formatDurationMs(1234)).toBe("1.2s");
    expect(formatDurationMs(3_946_000)).toBe("1h 6m");
    expect(formatDurationMs(412_000)).toBe("6m 52s");
    expect(formatDurationMs(null)).toBe("…");
  });
  test("sectionDuration pairs the timestamps the server leaves unfilled", () => {
    const sec = (over: Partial<Section>): Section => ({ kind: "section", key: "k", stage: "turn", started: null, ended: null, turn: null, children: [], ...over });
    const started = ev({ kind: "stage", state: "started", ts: "2026-08-20T03:47:13.000000Z" });
    const ended = ev({ kind: "stage", state: "done", ts: "2026-08-20T03:47:20.000000Z" });
    expect(sectionDuration(sec({ started, ended }))).toBe(7000);
    expect(sectionDuration(sec({ started, ended: { ...ended, duration_ms: 42 } }))).toBe(42);
    expect(sectionDuration(sec({ started }))).toBeNull();
  });
  test("child mode and default open", () => {
    const leaf: Section = { kind: "section", key: "a", stage: "packages", started: ev({ kind: "stage" }), ended: ev({ kind: "stage", state: "done" }), turn: null, children: [ev({})] };
    const turn: Section = { ...leaf, stage: "turn" };
    const container: Section = { ...leaf, stage: "provision", children: [leaf] };
    const open: Section = { ...leaf, ended: null };
    expect(childMode(leaf)).toBe("text");
    expect(childMode(turn)).toBe("cards");
    expect(childMode(container)).toBe("recursive");
    expect(defaultOpen(leaf)).toBe(false);
    expect(defaultOpen(turn)).toBe(true);
    expect(defaultOpen(container)).toBe(true);
    expect(defaultOpen(open)).toBe(true);
  });
  test("reattach hidden; visibility rule", () => {
    expect(hiddenInPretty(ev({ kind: "stage", stage: "reattach", state: "started" }))).toBe(true);
    expect(hiddenInPretty(ev({ kind: "stage", stage: "turn", state: "started" }))).toBe(false);
    const v = new Set(["stdout", "stage"]);
    expect(eventVisible(ev({ stream: "acp" }), v)).toBe(true);
    expect(eventVisible(ev({ stream: "stderr" }), v)).toBe(false);
    expect(eventVisible(ev({ stream: "stdout", stage: "packages" }), new Set(["stdout"]))).toBe(false);
    expect(eventVisible(ev({ stream: "stdout", stage: "turn" }), new Set(["stdout"]))).toBe(true);
  });
});
