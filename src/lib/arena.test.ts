import { describe, expect, test } from "bun:test";
import type { LogEvent, Turn } from "../api/types";
import {
  columnStatus,
  defaultSelection,
  groupByProvider,
  keyId,
  pickerKeys,
  scoreboard,
  shuffled,
  turnMetrics,
  turnsForRound,
  type Round,
  type RoundContender,
} from "./arena";

const MODELS = [
  "anthropic/claude-opus-5",
  "anthropic/claude-sonnet-5",
  "anthropic/claude-haiku-4-5",
  "openai/gpt-5",
  "google/gemini-2.5-pro",
];

describe("defaultSelection", () => {
  test("picks the three Anthropic tiers when available", () => {
    expect(defaultSelection(MODELS)).toEqual([
      { model: "anthropic/claude-haiku-4-5", instance: 1 },
      { model: "anthropic/claude-sonnet-5", instance: 1 },
      { model: "anthropic/claude-opus-5", instance: 1 },
    ]);
  });

  test("falls back to the first distinct models without Anthropic", () => {
    expect(defaultSelection(["openai/gpt-5", "google/gemini-2.5-pro"])).toEqual([
      { model: "openai/gpt-5", instance: 1 },
      { model: "google/gemini-2.5-pro", instance: 1 },
    ]);
  });

  test("a one-model catalog fights itself as #1 and #2 — never a dead end", () => {
    expect(defaultSelection(["openai/gpt-5"])).toEqual([
      { model: "openai/gpt-5", instance: 1 },
      { model: "openai/gpt-5", instance: 2 },
    ]);
    expect(pickerKeys(["openai/gpt-5"])).toEqual([
      { model: "openai/gpt-5", instance: 1 },
      { model: "openai/gpt-5", instance: 2 },
    ]);
    expect(keyId({ model: "openai/gpt-5", instance: 2 })).toBe("openai/gpt-5 #2");
  });

  test("an empty catalog selects nothing", () => {
    expect(defaultSelection([])).toEqual([]);
  });
});

describe("groupByProvider", () => {
  test("groups chips by provider in order of first appearance", () => {
    expect(groupByProvider(MODELS)).toEqual([
      { provider: "anthropic", models: MODELS.slice(0, 3) },
      { provider: "openai", models: ["openai/gpt-5"] },
      { provider: "google", models: ["google/gemini-2.5-pro"] },
    ]);
  });
});

describe("shuffled", () => {
  test("permutes with the injected rng and keeps every element", () => {
    const keys = ["a", "b", "c", "d"];
    const out = shuffled(keys, () => 0);
    expect([...out].sort()).toEqual(keys);
    expect(out).not.toBe(keys);
    // rand()=0 swaps each position with index 0: a deterministic rotation.
    expect(out).toEqual(["b", "c", "d", "a"]);
  });
});

// ── rounds ───────────────────────────────────────────────────────────────────

function turn(over: Partial<Turn>): Turn {
  return {
    id: "t1",
    turn_number: 1,
    prompt: "p",
    status: "completed",
    exit_code: 0,
    started_at: "2026-08-19T12:00:00Z",
    ended_at: "2026-08-19T12:00:10Z",
    inserted_at: "2026-08-19T12:00:00Z",
    usage: null,
    ...over,
  };
}

function round(over: Partial<Round>): Round {
  return {
    id: "r1",
    prompts: ["p"],
    startedAt: "2026-08-19T12:00:00Z",
    blind: true,
    order: ["m1"],
    contenders: [],
    winnerKey: null,
    revealed: false,
    closedAt: null,
    ...over,
  };
}

function contender(over: Partial<RoundContender>): RoundContender {
  return { key: "m1", model: "m1", instance: 1, agentId: "a1", conversationId: "c1", turnIds: [], ...over };
}

describe("turnsForRound", () => {
  const turns = [
    turn({ id: "t1", turn_number: 1, prompt: "old", inserted_at: "2026-08-19T11:00:00Z" }),
    turn({ id: "t2", turn_number: 2, prompt: "p", inserted_at: "2026-08-19T12:00:01Z" }),
    turn({ id: "t3", turn_number: 3, prompt: "follow", inserted_at: "2026-08-19T12:05:00Z" }),
  ];

  test("captured turn ids are authoritative, sorted by turn number", () => {
    const r = round({ prompts: ["p", "follow"] });
    const c = contender({ turnIds: ["t3", "t2"] });
    expect(turnsForRound(turns, r, c).map((t) => t.id)).toEqual(["t2", "t3"]);
  });

  test("falls back to prompt + time window when no ids were captured", () => {
    const r = round({ prompts: ["p", "follow"] });
    expect(turnsForRound(turns, r, contender({})).map((t) => t.id)).toEqual(["t2", "t3"]);
  });

  test("the same prompt from an earlier era stays out of the window", () => {
    const r = round({ prompts: ["old"], startedAt: "2026-08-19T12:00:00Z" });
    expect(turnsForRound(turns, r, contender({}))).toEqual([]);
  });

  test("a closed round stops claiming later turns", () => {
    const r = round({ prompts: ["p", "follow"], closedAt: "2026-08-19T12:01:00Z" });
    expect(turnsForRound(turns, r, contender({})).map((t) => t.id)).toEqual(["t2"]);
  });
});

describe("scoreboard", () => {
  test("tallies wins and rounds per model over voted rounds only", () => {
    const rounds: Round[] = [
      round({
        id: "r1",
        winnerKey: "m1",
        contenders: [contender({ key: "m1", model: "m1" }), contender({ key: "m2", model: "m2" })],
      }),
      round({
        id: "r2",
        winnerKey: "m2",
        contenders: [contender({ key: "m1", model: "m1" }), contender({ key: "m2", model: "m2" })],
      }),
      round({
        id: "r3",
        winnerKey: "m1",
        contenders: [contender({ key: "m1", model: "m1" }), contender({ key: "m2", model: "m2" })],
      }),
      // unvoted — counts for nothing
      round({ id: "r4", contenders: [contender({ key: "m1", model: "m1" })] }),
    ];
    expect(scoreboard(rounds)).toEqual([
      { model: "m1", wins: 2, rounds: 3 },
      { model: "m2", wins: 1, rounds: 3 },
    ]);
  });

  test("two instances of one model share the tally", () => {
    const rounds = [
      round({
        winnerKey: "m #2",
        contenders: [
          contender({ key: "m", model: "m", instance: 1 }),
          contender({ key: "m #2", model: "m", instance: 2 }),
        ],
      }),
    ];
    expect(scoreboard(rounds)).toEqual([{ model: "m", wins: 1, rounds: 2 }]);
  });
});

describe("turnMetrics", () => {
  const ev = (id: number, ts: string, turnId = "t1"): LogEvent => ({
    id,
    kind: "output",
    stream: "acp",
    data: "{}",
    stage: null,
    state: null,
    turn_id: turnId,
    ts,
  });

  test("ttfb and duration come from server timestamps; usage from the turn", () => {
    const t = turn({ usage: { input: 100, output: 25 } });
    const m = turnMetrics(t, [ev(1, "2026-08-19T12:00:02Z"), ev(2, "2026-08-19T12:00:05Z")], 0);
    expect(m).toEqual({ ttfbMs: 2000, durationMs: 10000, usage: { input: 100, output: 25 } });
  });

  test("a running turn ticks against now and has no usage yet", () => {
    const t = turn({ status: "running", ended_at: null, usage: null });
    const now = Date.parse("2026-08-19T12:00:07Z");
    expect(turnMetrics(t, [], now)).toEqual({ ttfbMs: null, durationMs: 7000, usage: null });
  });

  test("another turn's events do not count as first output", () => {
    const m = turnMetrics(turn({}), [ev(1, "2026-08-19T12:00:01Z", "other")], 0);
    expect(m.ttfbMs).toBeNull();
  });
});

describe("columnStatus", () => {
  test("runtime phases outrank the turn", () => {
    expect(columnStatus("hiring", null, false)).toBe("hiring");
    expect(columnStatus("starting", turn({ status: "completed" }), true)).toBe("starting");
    expect(columnStatus("error", turn({ status: "completed" }), true)).toBe("error");
    expect(columnStatus("cancelled", null, false)).toBe("interrupted");
    expect(columnStatus("sending", null, false)).toBe("waiting");
  });

  test("a running turn thinks until output arrives, then answers", () => {
    const running = turn({ status: "running", ended_at: null });
    expect(columnStatus(null, running, false)).toBe("thinking");
    expect(columnStatus(null, running, true)).toBe("answering");
  });

  test("terminal turns", () => {
    expect(columnStatus(null, turn({ status: "completed" }), true)).toBe("done");
    expect(columnStatus(null, turn({ status: "failed" }), true)).toBe("error");
    expect(columnStatus(null, turn({ status: "interrupted" }), true)).toBe("interrupted");
    expect(columnStatus(null, null, false)).toBe("waiting");
  });
});
