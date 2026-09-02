import { describe, expect, test } from "bun:test";
import type { LogEvent } from "../api/types";
import { blocksForTurn } from "./acp";
import { groupBlocks } from "./feed";
import { asks, describeResolution, openAsk, resolutions } from "./permissions";

/**
 * One held permission request, end to end, in the bytes the server actually
 * writes (fountain#940):
 *
 *  - the request line is `Protocol.request/3` on the `acp` stream, carrying a
 *    turn_id like any other output;
 *  - the `request` stage events carry no turn_id, so they are read from the
 *    conversation and paired on request_id.
 *
 * The two halves have to meet, or a card waits forever on a request that was
 * answered.
 */

const TURN = "turn-1";
const TS = "2026-08-22T04:10:00Z";

function acpLine(obj: unknown, id: number, ts = TS): LogEvent {
  // `Protocol.line/1` appends a newline; the parser must not trip on it.
  return { id, kind: "output", stream: "acp", data: `${JSON.stringify(obj)}\n`, stage: null, state: null, turn_id: TURN, ts };
}

function stageEvent(state: string, data: unknown, id: number, ts = TS): LogEvent {
  // publish_stage/4 writes no turn_id — this is the trap the pairing exists for.
  return { id, kind: "stage", stream: null, data: JSON.stringify(data), stage: "request", state, turn_id: null, ts };
}

const toolCall = {
  toolCallId: "call_1",
  title: "Bash",
  kind: "execute",
  rawInput: { command: "git push --force" },
};

const options = [
  { optionId: "proceed_once", name: "Yes", kind: "allow_once" },
  { optionId: "proceed_always", name: "Yes, and don't ask again", kind: "allow_always" },
  { optionId: "cancel", name: "No", kind: "reject_once" },
];

const askLine = acpLine(
  { jsonrpc: "2.0", id: 7, method: "session/request_permission", params: { sessionId: "sess", toolCall, options } },
  2,
);

const turnEvents = [
  acpLine({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess", update: { sessionUpdate: "tool_call", ...toolCall } } }, 1),
  askLine,
];

describe("a held permission request, end to end", () => {
  test("renders as a card beside the tool call it is about", () => {
    const items = groupBlocks(blocksForTurn(turnEvents, "claude"));
    expect(items.map((i) => i.kind)).toEqual(["tools", "permission"]);
    const card = items[1]!;
    if (card.kind !== "permission") throw new Error("expected a permission item");
    expect(card.request.requestId).toBe("7");
    expect(card.request.name).toBe("Bash");
    expect(card.request.summary).toBe("command=git push --force");
    expect(card.request.options.map((o) => o.optionId)).toEqual(["proceed_once", "proceed_always", "cancel"]);
  });

  test("the request id in the block is the one the answer route takes", () => {
    const [card] = blocksForTurn([askLine], "claude");
    if (card?.kind !== "permission") throw new Error("expected a permission block");
    // POST /api/conversations/:id/requests/:request_id — the server stringifies
    // the JSON-RPC id, so "7" and not 7.
    expect(card.requestId).toBe("7");
    expect(typeof card.requestId).toBe("string");
  });

  test("an answer on the stream closes the card, and names the option the agent named", () => {
    const conversation = [
      ...turnEvents,
      stageEvent("started", { request_id: "7", tool: "Bash", options, timeout_ms: 300000 }, 3),
      stageEvent("done", { request_id: "7", outcome: "answered", option_id: "proceed_once" }, 4),
    ];
    expect(openAsk(conversation)).toBeNull();
    const r = resolutions(conversation).get("7");
    expect(r).toMatchObject({ outcome: "answered", optionId: "proceed_once" });
    expect(describeResolution(r!, options)).toBe("Allowed — Yes");
    expect(asks(conversation).get("7")?.timeoutMs).toBe(300000);
  });

  test("a card resolves without this client answering — the timeout denies it", () => {
    const conversation = [
      ...turnEvents,
      stageEvent("started", { request_id: "7", tool: "Bash", options, timeout_ms: 300000 }, 3),
      stageEvent("done", { request_id: "7", outcome: "timeout", option_id: null }, 4),
    ];
    expect(describeResolution(resolutions(conversation).get("7")!, options)).toBe("Denied — nobody answered in time");
  });

  test("while it is unanswered the request is open, and the block is unresolved", () => {
    const conversation = [...turnEvents, stageEvent("started", { request_id: "7", tool: "Bash", options, timeout_ms: 300000 }, 3)];
    expect(openAsk(conversation)).toMatchObject({ requestId: "7", tool: "Bash" });
    expect(resolutions(conversation).get("7")).toBeUndefined();
  });

  test("the stage events are not mistaken for transcript content", () => {
    // They carry no turn_id, so a turn's own blocks never see them — and even
    // fed one, the ACP parse ignores anything that is not output on `acp`.
    const stray = stageEvent("done", { request_id: "7", outcome: "answered", option_id: "cancel" }, 9);
    expect(blocksForTurn([stray], "claude")).toEqual([]);
  });
});
