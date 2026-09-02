import { describe, expect, test } from "bun:test";
import { buildReportContext } from "./report";
import type { LogEvent, Teammate } from "../api/types";

const teammate = {
  agent_id: "a1",
  name: "Koda",
  agent: { id: "a1", name: "koda-agent", model: "anthropic/claude-sonnet-5", runtime: "claude", environment_id: null, allowed_vault_ids: null, allowed_environment_ids: null },
  conversation: { id: "c1", title: "Koda", status: "pending", turn_count: 0, last_active_at: null, sandbox: { id: "s1", sprite_name: "x", status: "ready", url: null, provider: "sprites", runner: null } },
  presence: { state: "starting", label: "starting computer" },
  unread: false,
  last_turn: null,
  preview: null,
} as unknown as Teammate;

const events: LogEvent[] = [
  { id: 1, kind: "output", stream: "acp", data: "SECRET agent text", stage: null, state: null, turn_id: "t", ts: "2026-08-19T00:00:00Z" },
  { id: 2, kind: "stage", stream: null, data: '{"reason":"sprite connection lost"}', stage: "turn", state: "failed", turn_id: "t", ts: "2026-08-19T00:00:01Z" },
  { id: 3, kind: "output", stream: "stderr", data: "boom", stage: null, state: null, turn_id: "t", ts: "2026-08-19T00:00:02Z" },
];

describe("report context", () => {
  test("carries the teammate, conversation, sandbox and stage events — not agent output", () => {
    const ctx = buildReportContext({ appCommit: "abc1234", fountainUrl: "https://f", connected: true, teammate, events, queued: 1 });
    expect(ctx.app).toBe("fountain-team abc1234");
    expect(ctx.conversation_id).toBe("c1");
    expect(ctx.agent_name).toBe("Koda");
    expect(ctx.presence?.state).toBe("starting");
    expect(ctx.sandbox?.status).toBe("ready");
    expect(ctx.recent_events?.map((e) => e.id)).toEqual([2, 3]);
    expect(JSON.stringify(ctx)).not.toContain("SECRET");
  });
  test("works with no teammate selected", () => {
    const ctx = buildReportContext({ appCommit: "dev", fountainUrl: "https://f", connected: false, teammate: null, events: [], queued: 0 });
    expect(ctx.conversation_id).toBeUndefined();
    expect(ctx.connected).toBe(false);
  });
});
