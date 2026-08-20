import { describe, expect, test } from "bun:test";
import { foldConversation, parseBlocks, parseDecision, pendingPlan, stripBlocks } from "./protocol";

const STATE = '```dns-state\n{"fetched_at":"2026-08-19T00:00:00Z","zones":[{"name":"example.com","id":"z1","records":[{"type":"A","name":"www","content":"1.2.3.4","ttl":300,"proxied":true}]}]}\n```';
const PLAN = '```dns-plan\n{"id":"plan-a1","zone":"example.com","summary":"add demo","changes":[{"op":"create","type":"A","name":"demo","content":"5.6.7.8","ttl":1,"proxied":false}]}\n```';
const APPLIED = '```dns-result\n{"plan_id":"plan-a1","status":"applied","detail":"1 record created"}\n```';

describe("parseBlocks", () => {
  test("parses state, plan, result in order", () => {
    const blocks = parseBlocks(`Here you go.\n${STATE}\nAnd a plan:\n${PLAN}\n${APPLIED}`);
    expect(blocks.map((b) => b.kind)).toEqual(["state", "plan", "result"]);
  });

  test("skips malformed JSON without dropping the rest", () => {
    const blocks = parseBlocks('```dns-plan\n{nope}\n```\n' + STATE);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.kind).toBe("state");
  });

  test("skips a plan with no valid changes", () => {
    const blocks = parseBlocks('```dns-plan\n{"id":"p","zone":"z","changes":[{"op":"explode"}]}\n```');
    expect(blocks).toHaveLength(0);
  });

  test("ignores ordinary code fences", () => {
    expect(parseBlocks('```bash\necho hi\n```')).toHaveLength(0);
  });

  test("tolerates trailing spaces after the info string", () => {
    expect(parseBlocks('```dns-result  \n{"plan_id":"p","status":"failed"}\n```')).toHaveLength(1);
  });
});

describe("stripBlocks", () => {
  test("removes blocks, keeps prose", () => {
    const s = stripBlocks(`Before.\n${PLAN}\nAfter.`);
    expect(s).toContain("Before.");
    expect(s).toContain("After.");
    expect(s).not.toContain("dns-plan");
  });
});

describe("parseDecision", () => {
  test("approve and reject, case-insensitive", () => {
    expect(parseDecision("APPROVE plan-a1")).toEqual({ verb: "approve", planId: "plan-a1" });
    expect(parseDecision("reject plan-a1")).toEqual({ verb: "reject", planId: "plan-a1" });
  });
  test("ordinary prompts are not decisions", () => {
    expect(parseDecision("please approve of my life choices")).toBeNull();
    expect(parseDecision("APPROVE")).toBeNull();
  });
});

describe("foldConversation", () => {
  test("plan awaits, then approve marks it, then result settles it", () => {
    let view = foldConversation([{ prompt: "add demo", reply: PLAN }]);
    expect(view.plans[0]!.status).toBe("awaiting");
    expect(pendingPlan(view)!.plan.id).toBe("plan-a1");

    view = foldConversation([
      { prompt: "add demo", reply: PLAN },
      { prompt: "APPROVE plan-a1", reply: "on it" },
    ]);
    expect(view.plans[0]!.status).toBe("approved");
    expect(pendingPlan(view)).toBeNull();

    view = foldConversation([
      { prompt: "add demo", reply: PLAN },
      { prompt: "APPROVE plan-a1", reply: `done\n${APPLIED}\n${STATE}` },
    ]);
    expect(view.plans[0]!.status).toBe("applied");
    expect(view.plans[0]!.detail).toBe("1 record created");
    expect(view.state!.zones[0]!.name).toBe("example.com");
  });

  test("a rejected plan reads rejected even without a result block", () => {
    const view = foldConversation([
      { prompt: "add demo", reply: PLAN },
      { prompt: "REJECT plan-a1", reply: "ok, standing down" },
    ]);
    expect(view.plans[0]!.status).toBe("rejected");
  });

  test("a newer plan supersedes an older undecided one", () => {
    const plan2 = PLAN.replace("plan-a1", "plan-b2");
    const view = foldConversation([
      { prompt: "add demo", reply: PLAN },
      { prompt: "actually make it a CNAME", reply: plan2 },
    ]);
    expect(view.plans[0]!.status).toBe("superseded");
    expect(view.plans[1]!.status).toBe("awaiting");
    expect(pendingPlan(view)!.plan.id).toBe("plan-b2");
  });

  test("re-emitting the same plan id keeps one card", () => {
    const view = foldConversation([
      { prompt: "add demo", reply: PLAN },
      { prompt: "show it again", reply: PLAN },
    ]);
    expect(view.plans).toHaveLength(1);
  });

  test("newest report of a zone wins", () => {
    const state2 = STATE.replace("1.2.3.4", "9.9.9.9");
    const view = foldConversation([
      { prompt: "state", reply: STATE },
      { prompt: "state again", reply: state2 },
    ]);
    expect(view.state!.zones[0]!.records[0]!.content).toBe("9.9.9.9");
    expect(view.stateTurnIndex).toBe(1);
  });

  test("a partial state merges: other zones stay as last reported", () => {
    const other = '```dns-state\n{"fetched_at":"2026-08-19T01:00:00Z","zones":[{"name":"other.io","records":[{"type":"A","name":"other.io","content":"7.7.7.7"}]}]}\n```';
    const view = foldConversation([
      { prompt: "read all", reply: STATE },
      { prompt: "read other.io", reply: other },
    ]);
    expect(view.state!.zones.map((z) => z.name)).toEqual(["example.com", "other.io"]);
    expect(view.state!.fetched_at).toBe("2026-08-19T01:00:00Z");
  });

  test("a complete snapshot drops zones absent from it", () => {
    const other = '```dns-state\n{"zones":[{"name":"other.io","records":[]}]}\n```';
    const full = '```dns-state\n{"complete":true,"zones":[{"name":"example.com","records":[]}]}\n```';
    const view = foldConversation([
      { prompt: "read", reply: STATE },
      { prompt: "read other", reply: other },
      { prompt: "refresh everything", reply: full },
    ]);
    expect(view.state!.zones.map((z) => z.name)).toEqual(["example.com"]);
  });
});
