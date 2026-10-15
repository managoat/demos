import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CostView } from "./Cost";
import type { Cost, PeriodCost } from "../lib/api";

const bucket = (conversations: number, turns: number, input: number, output: number, lastActiveAt: string | null) => ({ conversations, turns, input, output, lastActiveAt });
const per = (conversations: number, turns: number, seconds: number, input: number, output: number) => ({ conversations, turns, seconds, input, output });

const full: Cost = {
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

/** What `/api/me/cost/period` adds a beat later: the same projects, in turn time over the month. */
const period: PeriodCost = {
  period: { start: "2026-08-01T00:00:00Z", end: "2026-09-01T00:00:00Z" },
  measuredTo: "2026-08-24T00:00:00Z",
  projects: [
    {
      id: "p1",
      name: "Fountain",
      items: [
        { id: "w1", title: "fix foo", status: "open", ...per(2, 5, 5400, 1200, 600) },
        { id: "w2", title: "shipped it", status: "done", ...per(1, 1, 900, 40, 20) },
        { id: "w3", title: "dropped it", status: "wont", ...per(0, 0, 0, 0, 0) },
        { id: "wgone", title: null, status: null, ...per(0, 0, 0, 0, 0) },
      ],
      ...per(3, 6, 6300, 1240, 620),
    },
  ],
  measured: per(3, 6, 6300, 1240, 620),
  fanout: { candidates: 4, fetched: 3, cached: 0, skipped: 1, dropped: 0, failed: 0 },
};

describe("the cost view", () => {
  test("there is no bill to show, and the page does not invent one", () => {
    const html = renderToStaticMarkup(<CostView cost={full} email="alice@example.com" />);
    expect(html).toContain("alice@example.com");
    expect(html).not.toContain("The bill");
    expect(html).toContain("not a dollar figure");
  });

  test("a project reads as tokens, turns and a share of the account", () => {
    const html = renderToStaticMarkup(<CostView cost={full} email="alice@example.com" />);
    expect(html).toContain("Fountain");
    // 1,800,075 of 1,800,175 on the account.
    expect(html).toContain("1.8M tok");
    expect(html).toContain("100% of your account");
    expect(html).toContain("6 turns");
    expect(html).toContain("shared with 2");
    // The per-period measurement costs a request per conversation, so the page
    // says it is coming rather than waiting for it or pretending it is here.
    expect(html).toContain("measuring this month…");
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
  });

  test("once the month arrives a project reads in turn hours, as a share of what is measured", () => {
    const html = renderToStaticMarkup(<CostView cost={full} period={period} email="alice@example.com" />);
    // 6300 s of work, the only project measured.
    expect(html).toContain("1.8 h");
    expect(html).toContain("100% of what is measured here this month");
    // The lifetime figure is still there, said to be lifetime.
    expect(html).toContain("All time: 1.8M tok over 6 turns");
    // Per work item, in the same unit.
    expect(html).toContain("1.5 h");
    expect(html).toContain("15 min");
  });

  test("what the fan-out could not read is named, not quietly missing", () => {
    const holes: PeriodCost = { ...period, fanout: { candidates: 900, fetched: 400, cached: 0, skipped: 100, dropped: 400, failed: 2 } };
    const html = renderToStaticMarkup(<CostView cost={full} period={holes} email="alice@example.com" />);
    expect(html).toContain("400 conversations fell past the ceiling");
    expect(html).toContain("would not answer for 2 more");
    expect(html).toContain("Their hours are missing from the figures above");
  });

  test("a period that could not be read leaves the all-time view standing and says why", () => {
    const html = renderToStaticMarkup(<CostView cost={full} periodError="Fountain timed out." email="alice@example.com" />);
    expect(html).toContain("this month: unavailable");
    expect(html).toContain("could not be read: Fountain timed out.");
    // Still the lifetime breakdown, unchanged.
    expect(html).toContain("1.8M tok");
    expect(html).toContain("belong to no project of yours");
  });

  test("owning nothing is a sentence, not an empty page", () => {
    const none: Cost = { ...full, projects: [], elsewhere: bucket(0, 0, 0, 0, null), total: bucket(0, 0, 0, 0, null) };
    const html = renderToStaticMarkup(<CostView cost={none} email="alice@example.com" />);
    expect(html).toContain("You own no projects");
    expect(html).toContain("its cost is theirs to see, not yours");
  });
});
