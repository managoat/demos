import { describe, expect, test } from "bun:test";
import { assistantText, blocksForTurn, type Block } from "./acp";
import type { LogEvent } from "../api/types";

function acp(update: unknown, id = 1): LogEvent {
  return {
    id,
    kind: "output",
    stream: "acp",
    data: JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s", update },
    }),
    stage: null,
    state: null,
    turn_id: "t",
    ts: "2026-08-18T00:00:00Z",
  };
}

const chunk = (text: string, id = 1) =>
  acp({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }, id);

describe("blocksForTurn", () => {
  test("concatenates message chunks into one text block", () => {
    const blocks = blocksForTurn([chunk("Hel", 1), chunk("lo", 2)], "claude");
    expect(blocks).toEqual([{ kind: "text", body: "Hello", startedAt: "2026-08-18T00:00:00Z", endedAt: "2026-08-18T00:00:00Z" }]);
    expect(assistantText([chunk("Hel", 1), chunk("lo", 2)], "claude")).toBe("Hello");
  });
  test("a text block is stamped with its first and last chunk's arrival", () => {
    const events = [
      { ...chunk("Hel", 1), ts: "2026-08-18T00:00:00Z" },
      { ...chunk("lo", 2), ts: "2026-08-18T00:00:03Z" },
      { ...chunk(" there", 3), ts: "2026-08-18T00:00:05Z" },
    ];
    expect(blocksForTurn(events, "claude")).toEqual([
      { kind: "text", body: "Hello there", startedAt: "2026-08-18T00:00:00Z", endedAt: "2026-08-18T00:00:05Z" },
    ]);
  });

  test("pairs a tool call with its terminal update and ignores in-flight ones", () => {
    const events = [
      acp(
        {
          sessionUpdate: "tool_call",
          toolCallId: "c1",
          title: "Read file",
          locations: [{ path: "lib/a.ex" }],
        },
        1,
      ),
      acp({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "in_progress" }, 2),
      acp(
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "c1",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "defmodule A" } }],
        },
        3,
      ),
    ];
    expect(blocksForTurn(events, "claude")).toEqual([
      {
        kind: "tool",
        id: "c1",
        name: "Read file",
        summary: "lib/a.ex",
        status: "done",
        output: "defmodule A",
        startedAt: "2026-08-18T00:00:00Z",
        endedAt: "2026-08-18T00:00:00Z",
      },
    ]);
  });

  test("a failed tool is an error; thoughts are separate from text", () => {
    const events = [
      acp({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } }, 1),
      acp({ sessionUpdate: "tool_call", toolCallId: "c2", kind: "execute", rawInput: { cmd: "ls" } }, 2),
      acp({ sessionUpdate: "tool_call_update", toolCallId: "c2", status: "failed", rawOutput: "no" }, 3),
      chunk("done", 4),
    ];
    expect(blocksForTurn(events, "claude")).toEqual([
      { kind: "thinking", body: "hmm", startedAt: "2026-08-18T00:00:00Z", endedAt: "2026-08-18T00:00:00Z" },
      {
        kind: "tool",
        id: "c2",
        name: "execute",
        summary: "cmd=ls",
        status: "error",
        output: "no",
        startedAt: "2026-08-18T00:00:00Z",
        endedAt: "2026-08-18T00:00:00Z",
      },
      { kind: "text", body: "done", startedAt: "2026-08-18T00:00:00Z", endedAt: "2026-08-18T00:00:00Z" },
    ]);
  });

  test("drops user echoes, plans and other JSON-RPC traffic; keeps garbage as raw", () => {
    const events = [
      acp({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "me" } }, 1),
      acp({ sessionUpdate: "plan", entries: [] }, 2),
      { ...chunk("x", 3), data: '{"jsonrpc":"2.0","id":1,"result":{}}' },
      { ...chunk("x", 4), data: "not json at all" },
    ];
    expect(blocksForTurn(events, "claude")).toEqual([{ kind: "raw", body: "not json at all" }]);
  });

  test("a permission request renders as a card block, with the agent's options in its order", () => {
    const ask: LogEvent = {
      id: 9,
      kind: "output",
      stream: "acp",
      data: JSON.stringify({
        jsonrpc: "2.0",
        id: 41,
        method: "session/request_permission",
        params: {
          sessionId: "s",
          toolCall: { toolCallId: "c9", title: "Bash", kind: "execute", rawInput: { command: "rm -rf build" } },
          options: [
            { optionId: "allow", name: "Allow once", kind: "allow_once" },
            { optionId: "always", name: "Always allow Bash", kind: "allow_always" },
            { optionId: "no", name: "Reject", kind: "reject_once" },
          ],
        },
      }),
      stage: null,
      state: null,
      turn_id: "t",
      ts: "2026-08-22T00:00:00Z",
    };
    expect(blocksForTurn([ask], "claude")).toEqual([
      {
        kind: "permission",
        // the JSON-RPC id, stringified as the server stringifies it
        requestId: "41",
        name: "Bash",
        summary: "command=rm -rf build",
        options: [
          { optionId: "allow", name: "Allow once", kind: "allow_once", effects: [] },
          { optionId: "always", name: "Always allow Bash", kind: "allow_always", effects: [] },
          { optionId: "no", name: "Reject", kind: "reject_once", effects: [] },
        ],
        startedAt: "2026-08-22T00:00:00Z",
      },
    ]);
  });

  test("an option with no optionId is dropped — it could not be answered with", () => {
    const ask: LogEvent = {
      id: 10,
      kind: "output",
      stream: "acp",
      data: JSON.stringify({
        jsonrpc: "2.0",
        id: "req-1",
        method: "session/request_permission",
        params: { options: [{ name: "Allow" }, { optionId: "no", kind: "reject_once" }, "nonsense"] },
      }),
      stage: null,
      state: null,
      turn_id: "t",
      ts: "2026-08-22T00:00:00Z",
    };
    const blocks = blocksForTurn([ask], "claude");
    expect(blocks).toEqual([
      {
        kind: "permission",
        requestId: "req-1",
        // no toolCall at all: named rather than blank
        name: "tool",
        summary: "",
        // `name` falls back to the id so a button is never unlabelled
        options: [{ optionId: "no", name: "no", kind: "reject_once", effects: [] }],
        startedAt: "2026-08-22T00:00:00Z",
      },
    ]);
  });


  // The payload below is verbatim from production (claude-agent-acp 0.66,
  // 2026-08-22): the scope of "Always Allow" is the exact command line, and
  // the rule is written into the sandbox. Dropping this metadata is what made
  // the card promise more than the agent delivers.
  test("an option's scope metadata is carried through, not dropped", () => {
    const ask: LogEvent = {
      id: 12,
      kind: "output",
      stream: "acp",
      data: JSON.stringify({
        jsonrpc: "2.0",
        id: "0.6eaa186850a999ba",
        method: "session/request_permission",
        params: {
          toolCall: { title: "curl https://example.com", kind: "execute" },
          options: [
            { optionId: "reject", name: "Deny", kind: "reject_once" },
            { optionId: "allow", name: "Allow Once", kind: "allow_once" },
            {
              optionId: "allow_always",
              name: "Always Allow",
              kind: "allow_always",
              _meta: {
                permission: {
                  version: 1,
                  changes: [
                    {
                      type: "policy_rule",
                      operation: "add",
                      ruleBehavior: "allow",
                      description: 'Allow Bash calls matching curl -sS https://example.com',
                      lifetime: { scope: "persistent", storage: "project_local" },
                    },
                  ],
                },
              },
            },
          ],
        },
      }),
      stage: null,
      state: null,
      turn_id: "t",
      ts: "2026-08-22T00:00:00Z",
    };
    const block = blocksForTurn([ask], "claude")[0] as Extract<Block, { kind: "permission" }>;
    expect(block.options.map((o) => o.effects)).toEqual([
      [],
      [],
      [{ description: "Allow Bash calls matching curl -sS https://example.com", scope: "persistent" }],
    ]);
  });

  test("a change the agent did not describe is skipped rather than described for it", () => {
    const ask: LogEvent = {
      id: 13,
      kind: "output",
      stream: "acp",
      data: JSON.stringify({
        jsonrpc: "2.0",
        id: "7",
        method: "session/request_permission",
        params: {
          options: [
            // codex's session grant: `_meta`, but nothing under `permission`
            { optionId: "a", name: "Allow for Session", kind: "allow_always", _meta: { codex: { decision: "acceptForSession" } } },
            // a change with no wording of its own, and one with no lifetime
            {
              optionId: "b",
              name: "Amend policy",
              kind: "allow_always",
              _meta: { permission: { changes: [{ type: "policy_rule" }, { description: "Allow commands starting with curl" }] } },
            },
          ],
        },
      }),
      stage: null,
      state: null,
      turn_id: "t",
      ts: "2026-08-22T00:00:00Z",
    };
    const block = blocksForTurn([ask], "claude")[0] as Extract<Block, { kind: "permission" }>;
    expect(block.options.map((o) => o.effects)).toEqual([
      [],
      [{ description: "Allow commands starting with curl", scope: null }],
    ]);
  });

  test("a request the agent should never send is still dropped, not shown as raw", () => {
    const other: LogEvent = {
      id: 11,
      kind: "output",
      stream: "acp",
      data: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "fs/read_text_file", params: {} }),
      stage: null,
      state: null,
      turn_id: "t",
      ts: "2026-08-22T00:00:00Z",
    };
    expect(blocksForTurn([other], "claude")).toEqual([]);
  });

  test("legacy stdout of a non-ACP runtime shows as text; stage events are ignored", () => {
    const events: LogEvent[] = [
      { ...chunk("", 1), stream: "stdout", data: "plain gemini line" },
      { ...chunk("", 2), kind: "stage", stream: null, data: null, stage: "turn", state: "done" },
    ];
    expect(blocksForTurn(events, "gemini")).toEqual([{ kind: "text", body: "plain gemini line", startedAt: "2026-08-18T00:00:00Z", endedAt: "2026-08-18T00:00:00Z" }]);
    expect(blocksForTurn(events, "claude")).toEqual([]);
  });
});
