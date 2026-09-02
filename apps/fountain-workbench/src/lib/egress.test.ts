import { describe, expect, test } from "bun:test";
import type { LogEvent } from "../types";
import { brokerStage, brokerStageDetail, outcomeOf, summarize } from "./egress";

const row = (id: number, host: string, extra: Partial<Parameters<typeof outcomeOf>[0]> = {}) => ({ id, method: "GET", host, path: "/", credential_keys: [], ...extra });

describe("what the broker did with a request", () => {
  test("a refusal, a credentialed pass, a bare pass", () => {
    expect(outcomeOf({ error: "no_match", credential_keys: [] })).toBe("refused");
    expect(outcomeOf({ service: "github-api", credential_keys: ["GITHUB_TOKEN"] })).toBe("brokered");
    expect(outcomeOf({ service: null, credential_keys: [] })).toBe("bare");
  });

  test("per host: counts, the strongest outcome, every key that went there", () => {
    const s = summarize([
      row(5, "api.github.com:443", { service: "github-api", credential_keys: ["GITHUB_TOKEN"] }),
      row(4, "api.github.com:443", { service: "github-api", credential_keys: ["GH_TOKEN"] }),
      row(3, "api.github.com:443"),
      row(2, "evil.example:443", { error: "no_match" }),
      row(1, "cdn.example:443"),
    ]);
    expect(s).toEqual([
      { host: "api.github.com:443", requests: 3, outcome: "brokered", keys: ["GITHUB_TOKEN", "GH_TOKEN"] },
      { host: "cdn.example:443", requests: 1, outcome: "bare", keys: [] },
      { host: "evil.example:443", requests: 1, outcome: "refused", keys: [] },
    ]);
  });
});

const stage = (id: number, state: string, data: Record<string, unknown>): LogEvent =>
  ({ id, conversation_id: "c", kind: "stage", stream: "", stage: "broker", state, data: JSON.stringify(data), ts: "2026-08-25T00:00:00Z" }) as unknown as LogEvent;

describe("the broker stage on the feed", () => {
  test("no broker stage, no claim", () => {
    expect(brokerStage([{ id: 1, kind: "stage", stage: "sandbox", state: "started" } as unknown as LogEvent])).toBeNull();
  });

  test("started names what was withheld; done names the vault", () => {
    const s = brokerStage([stage(1, "started", { keys: ["GITHUB_TOKEN", "STRIPE_SECRET_KEY"] }), stage(2, "done", { vault: "c-abc", expires_at: "2026-08-25T06:00:00Z" })]);
    expect(s).toEqual({ keys: ["GITHUB_TOKEN", "STRIPE_SECRET_KEY"], vault: "c-abc", expiresAt: "2026-08-25T06:00:00Z", failed: null, done: true });
  });

  test("a failure says why, and a later retry clears it", () => {
    expect(brokerStage([stage(1, "started", { keys: [] }), stage(2, "failed", { reason: "broker_unreachable" })])?.failed).toBe("broker_unreachable");
    expect(brokerStage([stage(1, "failed", { reason: "broker_unreachable" }), stage(2, "started", { keys: ["X"] })])?.failed).toBeNull();
  });

  test("the setup log's line for it", () => {
    expect(brokerStageDetail(stage(1, "started", { keys: ["GITHUB_TOKEN"] }))).toBe("withheld from the sandbox: GITHUB_TOKEN");
    expect(brokerStageDetail(stage(1, "failed", { reason: "backend_lacks_network_policy" }))).toMatch(/cannot pin egress/);
    expect(brokerStageDetail(stage(1, "done", { vault: "c-1" }))).toBeNull();
  });
});
