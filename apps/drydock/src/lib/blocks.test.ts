import { describe, expect, test } from "bun:test";
import { foldEvents, mergeEchoes, newestEventId, startsTurn, type Block, type TranscriptEvent } from "./blocks";

let seq = 0;

function output(blocks: Block[], over: Partial<TranscriptEvent> = {}): TranscriptEvent {
  seq += 1;
  return {
    id: seq,
    kind: "output",
    stream: "acp",
    data: null,
    stage: null,
    state: null,
    turn_id: "t1",
    ts: "2026-09-04T12:00:00Z",
    blocks,
    ...over,
  };
}

describe("foldEvents", () => {
  test("pairs a result onto its call", () => {
    const items = foldEvents([
      output([{ kind: "tool_use", id: "c1", name: "bash", summary: "git status", body: "git status --short" }]),
      output([{ kind: "tool_result", tool_id: "c1", body: " M src/App.tsx" }]),
    ]);
    expect(items).toHaveLength(1);
    const tool = items[0]!;
    expect(tool.kind).toBe("tool");
    if (tool.kind !== "tool") throw new Error("expected a tool item");
    expect(tool.name).toBe("bash");
    expect(tool.summary).toBe("git status");
    expect(tool.input).toBe("git status --short");
    expect(tool.output).toBe(" M src/App.tsx");
    expect(tool.status).toBe("done");
  });

  test("a failed result marks its call failed", () => {
    const items = foldEvents([
      output([{ kind: "tool_use", id: "c1", name: "bash" }]),
      output([{ kind: "tool_result", tool_id: "c1", body: "exit 1", error: true }]),
    ]);
    expect(items[0]).toMatchObject({ kind: "tool", status: "error", output: "exit 1" });
  });

  test("a call with no result still renders, still running", () => {
    const items = foldEvents([output([{ kind: "tool_use", id: "c9", name: "read", summary: "src/App.tsx" }])]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "tool", name: "read", status: "running", output: "" });
  });

  test("a result with no call is kept as a notice rather than crashing", () => {
    const items = foldEvents([output([{ kind: "tool_result", tool_id: "gone", body: "orphaned output" }])]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "notice", body: "orphaned output" });
  });

  test("a result with neither a call nor an id is dropped quietly", () => {
    expect(foldEvents([output([{ kind: "tool_result" }])])).toEqual([]);
  });

  test("events out of order fold the same as events in order", () => {
    const call = output([{ kind: "tool_use", id: "c1", name: "bash", summary: "ls" }]);
    const result = output([{ kind: "tool_result", tool_id: "c1", body: "README.md" }]);
    const after = output([{ kind: "text", body: "There is one file." }]);

    const shuffled = foldEvents([after, result, call]);
    const inOrder = foldEvents([call, result, after]);
    expect(shuffled).toEqual(inOrder);
    expect(shuffled).toHaveLength(2);
    expect(shuffled[0]).toMatchObject({ kind: "tool", output: "README.md", status: "done" });
    expect(shuffled[1]).toMatchObject({ kind: "text", body: "There is one file." });
  });

  test("the same event delivered twice appears once", () => {
    const ev = output([{ kind: "text", body: "hello" }]);
    expect(foldEvents([ev, { ...ev }])).toHaveLength(1);
  });

  test("adjacent text joins, but not across turns", () => {
    const items = foldEvents([
      output([{ kind: "text", body: "Half " }]),
      output([{ kind: "text", body: "a sentence." }]),
      output([{ kind: "text", body: "A new turn." }], { turn_id: "t2" }),
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: "text", body: "Half a sentence." });
    expect(items[1]).toMatchObject({ kind: "text", body: "A new turn.", turnId: "t2" });
  });

  test("thinking stays its own item", () => {
    const items = foldEvents([
      output([
        { kind: "thinking", body: "weighing it up" },
        { kind: "text", body: "Done." },
      ]),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["thinking", "text"]);
  });

  test("errors and raw blocks survive; init and result do not", () => {
    const items = foldEvents([
      output([
        { kind: "init", summary: "claude", body: "{}" },
        { kind: "error", body: "the runtime went away" },
        { kind: "raw", summary: "unknown frame", body: "{...}" },
        { kind: "result", body: "4 turns", raw: { turns: 4 } },
      ]),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["error", "notice"]);
    expect(items[0]).toMatchObject({ body: "the runtime went away" });
  });

  test("events with no blocks are provisioning noise, not transcript", () => {
    const items = foldEvents([
      { id: 1, kind: "output", stream: "stdout", data: "Reading package lists...", stage: "packages", state: null, turn_id: null, ts: "x" },
    ]);
    expect(items).toEqual([]);
  });

  test("a turn's prompt becomes a user item where the stage event carries one", () => {
    const items = foldEvents([
      {
        id: 1,
        kind: "stage",
        stream: "stage",
        data: JSON.stringify({ prompt: "run the tests" }),
        stage: "turn",
        state: "started",
        turn_id: "t1",
        ts: "x",
      },
      output([{ kind: "text", body: "Running them." }]),
    ]);
    expect(items[0]).toMatchObject({ kind: "user", text: "run the tests" });
    expect(items[1]).toMatchObject({ kind: "text" });
  });

  test("a turn stage with no prompt in it invents nothing", () => {
    const items = foldEvents([
      { id: 1, kind: "stage", stream: "stage", data: "{}", stage: "turn", state: "started", turn_id: "t1", ts: "x" },
    ]);
    expect(items).toEqual([]);
  });

  test("a failed turn is an error item", () => {
    const items = foldEvents([
      {
        id: 1,
        kind: "stage",
        stream: "stage",
        data: JSON.stringify({ error: "the machine was reclaimed" }),
        stage: "turn",
        state: "failed",
        turn_id: "t1",
        ts: "x",
      },
    ]);
    expect(items[0]).toMatchObject({ kind: "error", body: "the machine was reclaimed" });
  });

  test("unparseable stage data does not throw", () => {
    const items = foldEvents([
      { id: 1, kind: "stage", stream: "stage", data: "not json", stage: "turn", state: "failed", turn_id: "t1", ts: "x" },
    ]);
    expect(items[0]).toMatchObject({ kind: "error" });
  });
});

describe("mergeEchoes", () => {
  const items = foldEvents([
    output([{ kind: "text", body: "first reply" }], { id: 10, turn_id: "t1" }),
    output([{ kind: "text", body: "second reply" }], { id: 20, turn_id: "t2" }),
  ]);

  test("puts a sent prompt where it was sent", () => {
    const merged = mergeEchoes(items, [{ key: "e1", text: "and again", afterEventId: 10, at: "x" }]);
    expect(merged.map((i) => i.kind)).toEqual(["text", "user", "text"]);
    expect(merged[1]).toMatchObject({ text: "and again" });
  });

  test("a prompt sent after everything lands last", () => {
    const merged = mergeEchoes(items, [{ key: "e1", text: "one more", afterEventId: 20, at: "x" }]);
    expect(merged[merged.length - 1]).toMatchObject({ kind: "user", text: "one more" });
  });

  test("drops an echo the real events have caught up with", () => {
    const withUser = foldEvents([
      output([{ kind: "text", body: "first reply" }], { id: 10, turn_id: "t1" }),
      { id: 15, kind: "stage", stream: "stage", data: JSON.stringify({ prompt: "and again" }), stage: "turn", state: "started", turn_id: "t2", ts: "x" },
    ]);
    const merged = mergeEchoes(withUser, [{ key: "e1", text: "and again", afterEventId: 10, at: "x" }]);
    expect(merged.filter((i) => i.kind === "user")).toHaveLength(1);
  });

  test("no echoes is the same list", () => {
    expect(mergeEchoes(items, [])).toEqual(items);
  });
});

describe("newestEventId", () => {
  test("is the highest id, or zero", () => {
    expect(newestEventId([])).toBe(0);
    expect(newestEventId([output([], { id: 7 }), output([], { id: 3 })])).toBe(7);
  });
});

describe("startsTurn", () => {
  test("the first item never starts a turn", () => {
    const items = foldEvents([output([{ kind: "text", body: "hi" }])]);
    expect(startsTurn(items[0]!, undefined)).toBe(false);
  });

  test("a change of turn id does", () => {
    const items = foldEvents([
      output([{ kind: "text", body: "one" }], { turn_id: "t1" }),
      output([{ kind: "text", body: "two" }], { turn_id: "t2" }),
    ]);
    expect(startsTurn(items[1]!, items[0])).toBe(true);
  });
});
