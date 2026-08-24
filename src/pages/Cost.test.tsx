import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CostView } from "./Cost";
import type { Cost } from "../lib/api";

const bucket = (conversations: number, turns: number, input: number, output: number, lastActiveAt: string | null) => ({ conversations, turns, input, output, lastActiveAt });

const full: Cost = {
  billing: {
    status: "active",
    period: { start: "2026-08-01T00:00:00Z", end: "2026-09-01T00:00:00Z", source: "subscription" },
    plan: { name: "Team", slug: "team", monthly_cents: 9900, included_turn_hours: 100 },
    usage: { conversations: 12, turns: 40, turn_hours: 7.5, turn_hours_included: 100, sandbox_minutes: 900 },
  },
  billingUnavailable: null,
  projects: [
    {
      id: "p1",
      name: "Fountain",
      memberCount: 2,
      items: [
        { id: "w1", title: "fix foo", status: "open", ...bucket(2, 5, 1_200_000, 600_000, "2026-08-12T00:00:00Z") },
        { id: "w2", title: "shipped it", status: "done", ...bucket(1, 2, 400, 200, "2026-08-10T00:00:00Z") },
        { id: "w3", title: "dropped it", status: "wont", ...bucket(1, 2, 400, 200, "2026-08-09T00:00:00Z") },
        { id: "wgone", title: null, status: null, ...bucket(1, 1, 50, 25, "2026-08-11T00:00:00Z") },
      ],
      ...bucket(3, 6, 1_200_050, 600_025, "2026-08-12T00:00:00Z"),
    },
  ],
  elsewhere: bucket(2, 4, 70, 30, "2026-08-13T00:00:00Z"),
  total: bucket(5, 10, 1_200_120, 600_055, "2026-08-13T00:00:00Z"),
};

describe("the cost view", () => {
  test("the bill is the account's, in the units Fountain charges in", () => {
    const html = renderToStaticMarkup(<CostView cost={full} email="alice@example.com" />);
    expect(html).toContain("alice@example.com");
    expect(html).toContain("Team");
    expect(html).toContain("$99/mo, flat");
    expect(html).toContain("7.5 h");
    expect(html).toContain("of 100 included");
  });

  test("a project reads as tokens, turns and a share of the account", () => {
    const html = renderToStaticMarkup(<CostView cost={full} email="alice@example.com" />);
    expect(html).toContain("Fountain");
    // 1,800,075 of 1,800,175 on the account.
    expect(html).toContain("1.8M tok");
    expect(html).toContain("100% of your account");
    expect(html).toContain("6 turns");
    expect(html).toContain("shared with 2");
    // The bill's period is stated, and the project is marked as live inside it.
    expect(html).toContain("active this period");
  });

  test("the biggest project is already broken down, deleted items included", () => {
    const html = renderToStaticMarkup(<CostView cost={full} email="alice@example.com" />);
    expect(html).toContain("fix foo");
    expect(html).toContain("5 turns");
    // An item deleted here still carries its spend, named for what it was.
    expect(html).toContain("Deleted item wgone");
    expect(html).toContain("75 tok");
  });

  test("a closed item says which way it closed — money was spent either way", () => {
    const html = renderToStaticMarkup(<CostView cost={full} email="alice@example.com" />);
    // "we did this" and "we decided not to" cost the same and must not read the same.
    expect(html).toContain("shipped it");
    expect(html).toContain("dropped it");
    expect(html).toContain("won&#x27;t do");
    // Not just different words: different marks, so they read apart at a glance.
    expect(html).toContain('class="pill terminated tiny"');
    expect(html).toContain('class="pill wont tiny"');
    // An open item carries no pill at all, so those two are the only marks.
    expect(html.match(/class="pill [a-z]+ tiny"/g) ?? []).toHaveLength(2);
  });

  test("what is not attributable is counted, not dropped", () => {
    const html = renderToStaticMarkup(<CostView cost={full} email="alice@example.com" />);
    expect(html).toContain("belong to no project of yours");
    // And the page never claims the breakdown divides the invoice.
    expect(html).toContain("Fountain does not attribute it to a project, so neither does this page");
    expect(html).toContain("flat $99 a month");
  });

  test("billing switched off says so, and the breakdown still stands", () => {
    const off: Cost = { ...full, billing: null, billingUnavailable: "disabled" };
    const html = renderToStaticMarkup(<CostView cost={off} email="alice@example.com" />);
    expect(html).toContain("billing switched off");
    expect(html).toContain("Fountain");
    expect(html).toContain("1.8M tok");
    // No plan means no claim about a plan.
    expect(html).not.toContain("a month however the work splits");
  });

  test("owning nothing is a sentence, not an empty page", () => {
    const none: Cost = { ...full, projects: [], elsewhere: bucket(0, 0, 0, 0, null), total: bucket(0, 0, 0, 0, null) };
    const html = renderToStaticMarkup(<CostView cost={none} email="alice@example.com" />);
    expect(html).toContain("You own no projects");
    expect(html).toContain("its cost is theirs to see, not yours");
  });
});
