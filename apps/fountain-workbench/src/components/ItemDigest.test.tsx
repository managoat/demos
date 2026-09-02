/**
 * The panel's copy. The derivation is tested in src/lib/digest.test.ts; this
 * is here because the loud line — how many agents are blocked on you — has to
 * read right, and because a panel that throws on an empty digest is a work
 * item page that will not open.
 */
import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { digestOf, type ConversationRef, type ItemEvent } from "../lib/digest";
import type { Agent, Conversation, SandboxRecord } from "../types";

// The avatar reaches into the project store for the bearer key an <img> cannot
// send; nothing about it is what this file is checking.
mock.module("./AgentAvatar", () => ({ AgentAvatar: ({ agent }: { agent: Agent }) => <span className="avatar">{agent.name.slice(0, 2)}</span> }));
const { DigestPanel } = await import("./ItemDigest");

const T0 = Date.parse("2026-08-24T10:00:00Z");
const at = (mins: number) => new Date(T0 + mins * 60_000).toISOString();

let nextId = 1;
const stage = (c: string, mins: number, s: string, state: string, data: Record<string, unknown> = {}): ItemEvent => ({
  id: nextId++,
  conversation_id: c,
  ts: at(mins),
  kind: "stage",
  stage: s,
  state: state as ItemEvent["state"],
  data: JSON.stringify(data),
});

const conv = (id: string, agent_id: string | null = null): Conversation => ({
  id,
  runtime: "claude",
  status: "running",
  agent_id,
  sandbox_id: `sb-${id}`,
});

const refs = (cs: Conversation[]): ConversationRef[] => cs.map((c) => ({ id: c.id, status: c.status, sandbox_id: c.sandbox_id ?? null }));

const render = (events: ItemEvent[], cs: Conversation[], since: string | null, now: number, agents = new Map<string, Agent>()) =>
  renderToStaticMarkup(
    <DigestPanel
      digest={digestOf({ events, conversations: refs(cs), since, now })}
      projectId="p1"
      conversations={cs}
      agents={agents}
      sandboxes={new Map<string, SandboxRecord>()}
      now={now}
      onCaughtUp={() => undefined}
    />,
  );

describe("DigestPanel", () => {
  test("nothing happened: it says so, and offers nothing to catch up on", () => {
    const html = render([], [conv("a")], at(0), T0 + 60_000);
    expect(html).toContain("Nothing new.");
    expect(html).not.toContain("Caught up");
    expect(html).toContain("since 1m ago");
  });

  test("no mark yet: the panel says what it is measuring from", () => {
    expect(render([], [conv("a")], null, T0)).toContain("since this item started");
  });

  test("the loud line counts blocked agents and links to each one", () => {
    const agents = new Map<string, Agent>([["ag1", { id: "ag1", name: "porter", runtime: "claude" } as Agent]]);
    const events = [
      stage("a", 0, "request", "started", { request_id: "r1", tool: "Bash(rm -rf build)", timeout_ms: 300_000 }),
      stage("b", 1, "request", "started", { request_id: "r2", tool: "Edit", timeout_ms: 300_000 }),
    ];
    const html = render(events, [conv("a", "ag1"), conv("b")], at(10), T0 + 60_000, agents);
    expect(html).toContain("2 agents are blocked waiting on you");
    expect(html).toContain("wants to run Bash(rm -rf build)");
    expect(html).toContain('href="#/p/p1/c/a"');
    expect(html).toContain("porter");
    // 5 minutes from the ask, and a minute of it is gone.
    expect(html).toContain("4m left");
  });

  test("one blocked agent reads as one", () => {
    const events = [stage("a", 0, "request", "started", { request_id: "r1", tool: "Bash", timeout_ms: 300_000 })];
    expect(render(events, [conv("a")], null, T0 + 60_000)).toContain("1 agent is blocked waiting on you");
  });

  test("turns and computers, with what Fountain said about the computer", () => {
    const events = [
      stage("a", 20, "turn", "done", { turn_id: "t1" }),
      stage("a", 21, "turn", "done", { turn_id: "t2" }),
      stage("a", 22, "turn", "failed", { turn_id: "t3" }),
      stage("a", 30, "sandbox", "done", { event: "reclaimed", reason: "idle_bound", message: "Idle for an hour." }),
    ];
    const html = render(events, [conv("a")], at(10), T0 + 60 * 60_000);
    expect(html).toContain("2 turns finished · 1 failed");
    expect(html).toContain("was reclaimed");
    expect(html).toContain("Idle for an hour.");
    expect(html).toContain("Caught up");
  });
});
