import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { foldConversation, pendingPlan } from "../lib/protocol";
import { PlanCardView } from "./PlanCard";
import { Zones } from "./Zones";

// Render smoke: a plan reads as a diff with the decision buttons only while
// it awaits one; the zones table renders what the desk reported.

const PLAN = '```dns-plan\n{"id":"plan-x7","zone":"example.com","summary":"point www at the new LB","changes":[{"op":"update","type":"CNAME","name":"www.example.com","content":"new-lb.example.com","before":{"type":"CNAME","name":"www.example.com","content":"old-lb.example.com"}},{"op":"delete","type":"TXT","name":"_old.example.com","before":{"type":"TXT","name":"_old.example.com","content":"v=old"}}]}\n```';
const STATE = '```dns-state\n{"fetched_at":"2026-08-19T12:00:00Z","zones":[{"name":"example.com","records":[{"type":"A","name":"www.example.com","content":"1.2.3.4","ttl":1,"proxied":true}]}]}\n```';

describe("PlanCardView", () => {
  test("awaiting: shows before→after, delete strikethrough, and both buttons", () => {
    const view = foldConversation([{ prompt: "move www", reply: PLAN }]);
    const html = renderToString(<PlanCardView card={pendingPlan(view)!} busy={false} onDecide={() => undefined} />);
    expect(html).toContain("plan-x7");
    expect(html).toContain("awaiting approval");
    expect(html).toContain("point www at the new LB");
    expect(html).toMatch(/<s>old-lb.example.com<\/s>.*new-lb.example.com/);
    expect(html).toContain("<s>v=old</s>");
    expect(html).toContain(">Approve</button>");
    expect(html).toContain(">Reject</button>");
  });

  test("applied: chip says so, no buttons even with a handler", () => {
    const view = foldConversation([
      { prompt: "move www", reply: PLAN },
      { prompt: "APPROVE plan-x7", reply: '```dns-result\n{"plan_id":"plan-x7","status":"applied","detail":"2 records changed"}\n```' },
    ]);
    const html = renderToString(<PlanCardView card={view.plans[0]!} busy={false} onDecide={() => undefined} />);
    expect(html).toContain("applied");
    expect(html).toContain("2 records changed");
    expect(html).not.toContain(">Approve</button>");
  });
});

describe("Zones", () => {
  test("renders the reported zone, records, auto TTL, proxy flag, freshness", () => {
    const view = foldConversation([{ prompt: "state", reply: STATE }]);
    const html = renderToString(<Zones state={view.state} onRefresh={() => undefined} refreshing={false} />);
    expect(html).toContain("example.com");
    expect(html).toContain("1.2.3.4");
    expect(html).toContain("auto");
    expect(html).toContain("proxied");
    expect(html).toContain("As the desk last read it");
  });

  test("no state yet: says so, refresh still offered", () => {
    const html = renderToString(<Zones state={null} onRefresh={() => undefined} refreshing={false} />);
    expect(html).toContain("has not reported zone state yet");
    expect(html).toContain("Refresh from Cloudflare");
  });
});
