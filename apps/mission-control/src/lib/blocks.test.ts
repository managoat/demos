import { describe, expect, test } from "bun:test";
import type { LogEvent, ServerBlock } from "../api/types";
import { bootSequence, replyText, sessionReady, viewBlocks } from "./blocks";

let nextId = 1;
function ev(partial: Partial<LogEvent>): LogEvent {
  return {
    id: nextId++,
    kind: "output",
    stream: "acp",
    data: "",
    stage: null,
    state: null,
    turn_id: "t",
    ts: "2026-08-19T00:00:00Z",
    ...partial,
  };
}

const out = (blocks: ServerBlock[]) => ev({ blocks });
const stage = (name: string, state: string) => ev({ kind: "stage", stream: "", data: "{}", stage: name, state, blocks: [] });

describe("viewBlocks (server blocks)", () => {
  test("merges adjacent text across events and keeps thinking separate", () => {
    const events = [out([{ kind: "thinking", body: "hmm" }, { kind: "text", body: "Hel" }]), out([{ kind: "text", body: "lo" }])];
    expect(viewBlocks(events, "claude")).toEqual([
      { kind: "thinking", body: "hmm" },
      { kind: "text", body: "Hello" },
    ]);
    expect(replyText(events, "claude")).toBe("Hello");
  });

  test("pairs tool_use with its tool_result on id", () => {
    const events = [
      out([{ kind: "tool_use", id: "c1", name: "Bash", summary: "ls", body: '{"cmd":"ls"}' }]),
      out([{ kind: "tool_result", tool_id: "c1", body: "README.md", error: false }]),
    ];
    expect(viewBlocks(events, "claude")).toEqual([
      { kind: "tool", id: "c1", name: "Bash", summary: "ls", status: "done", output: "README.md" },
    ]);
  });

  test("a failed tool result reads as an error; raw is shown, init dropped", () => {
    const events = [
      out([
        { kind: "init", summary: "session", body: "{}" },
        { kind: "tool_use", id: "c2", name: "Bash", summary: "boom" },
        { kind: "tool_result", tool_id: "c2", body: "no such file", error: true },
        { kind: "raw", body: "??" },
      ]),
    ];
    expect(viewBlocks(events, "claude")).toEqual([
      { kind: "tool", id: "c2", name: "Bash", summary: "boom", status: "error", output: "no such file" },
      { kind: "raw", body: "??" },
    ]);
  });

  test("falls back to the client ACP parser when no event carries blocks", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "raw path" } } },
    });
    const events = [ev({ data: line })];
    expect(viewBlocks(events, "claude")).toEqual([{ kind: "text", body: "raw path" }]);
    expect(replyText(events, "claude")).toBe("raw path");
  });
});

describe("boot sequence", () => {
  test("tracks each stage's newest state in first-seen order, skipping turns", () => {
    const events = [
      stage("provision", "started"),
      stage("provision", "done"),
      stage("packages", "done"),
      stage("session", "started"),
      stage("turn", "started"),
    ];
    expect(bootSequence(events)).toEqual([
      { stage: "provision", state: "done" },
      { stage: "packages", state: "done" },
      { stage: "session", state: "started" },
    ]);
    expect(sessionReady(events)).toBe(false);
    expect(sessionReady([...events, stage("session", "done")])).toBe(true);
  });

  test("acp output alone proves the session is up (reattach after a deploy)", () => {
    expect(sessionReady([out([{ kind: "text", body: "hi" }])])).toBe(true);
  });
});
