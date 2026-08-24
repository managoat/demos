import { describe, expect, test } from "bun:test";
import { arrange, assistantText, timeline, sectionState, isSection } from "./blocks";
import type { LogEvent, Turn } from "../types";

let id = 0;
const ev = (over: Partial<LogEvent>): LogEvent => ({
  id: ++id,
  kind: "output",
  stream: "acp",
  data: undefined,
  stage: undefined,
  state: null,
  turn_id: "t1",
  ts: "2026-08-18T00:00:00Z",
  ...over,
});

describe("arrange", () => {
  test("merges adjacent text and pairs tool results", () => {
    const events = [
      ev({ blocks: [{ kind: "text", body: "Hel" }] }),
      ev({ blocks: [{ kind: "text", body: "lo" }, { kind: "tool_use", id: "c1", name: "Read", summary: "a.ex", body: "{}" }] }),
      ev({ blocks: [{ kind: "tool_result", tool_id: "c1", body: "ok", error: false }, { kind: "text", body: "done" }] }),
    ];
    expect(arrange(events)).toEqual([
      { kind: "text", body: "Hello" },
      { kind: "tool_use", id: "c1", name: "Read", summary: "a.ex", body: "{}", result: { body: "ok", error: false } },
      { kind: "text", body: "done" },
    ]);
    expect(assistantText(events)).toBe("Hellodone");
  });

  test("hides streams that are toggled off; an orphan result stays visible", () => {
    const events = [
      ev({ stream: "stderr", blocks: [{ kind: "raw", body: "warn" }] }),
      ev({ blocks: [{ kind: "tool_result", tool_id: "zz", body: "late" }] }),
    ];
    expect(arrange(events, new Set(["acp"]))).toEqual([{ kind: "tool_result", tool_id: "zz", body: "late" }]);
  });
});

describe("timeline", () => {
  const turns: Turn[] = [{ id: "t1", turn_number: 1, prompt: "hi", status: "completed", exit_code: 0, started_at: null, ended_at: null, inserted_at: "", image_count: 0 }];

  test("nests sections, routes output by stage, and pairs the turn from its data", () => {
    const events = [
      ev({ kind: "stage", stream: undefined, stage: "provision", state: "started", turn_id: undefined }),
      ev({ kind: "stage", stream: undefined, stage: "packages", state: "started", turn_id: undefined, data: '{"commands":1}' }),
      ev({ kind: "output", stream: "stdout", stage: "packages", turn_id: undefined, blocks: [{ kind: "raw", body: "apt…" }] }),
      ev({ kind: "stage", stream: undefined, stage: "packages", state: "done", turn_id: undefined }),
      ev({ kind: "stage", stream: undefined, stage: "provision", state: "done", turn_id: undefined, duration_ms: 1200 }),
      ev({ kind: "stage", stream: undefined, stage: "turn", state: "started", turn_id: undefined, data: '{"turn_id":"t1"}' }),
      ev({ stage: "turn", blocks: [{ kind: "text", body: "reply" }] }),
      ev({ kind: "stage", stream: undefined, stage: "turn", state: "done", duration_ms: 3000 }),
      ev({ kind: "stage", stream: undefined, stage: "sandbox", state: "started", turn_id: undefined }),
    ];
    const items = timeline(events, turns);
    const shape = items.map((i) =>
      isSection(i)
        ? [i.stage, sectionState(i), i.turn?.prompt ?? null, i.children.map((c) => (isSection(c) ? `${c.stage}:${c.children.length}` : "ev"))]
        : "loose",
    );
    expect(shape).toEqual([
      ["provision", "done", null, ["packages:1"]],
      ["turn", "done", "hi", ["ev"]],
      ["sandbox", "running", null, []],
    ]);
  });

  test("a stage announced twice in a row is one section", () => {
    const items = timeline(
      [
        ev({ kind: "stage", stream: undefined, stage: "provision", state: "started", turn_id: undefined }),
        ev({ kind: "stage", stream: undefined, stage: "provision", state: "started", turn_id: undefined }),
        ev({ kind: "stage", stream: undefined, stage: "provision", state: "done", turn_id: undefined }),
      ],
      [],
    );
    expect(items.length).toBe(1);
    expect(isSection(items[0]!) && sectionState(items[0]!)).toBe("done");
  });

  test("a mismatched close is kept as a loose event", () => {
    const items = timeline([ev({ kind: "stage", stream: undefined, stage: "clone", state: "done", turn_id: undefined })], []);
    expect(items.length).toBe(1);
    expect(isSection(items[0]!)).toBe(false);
  });
});
