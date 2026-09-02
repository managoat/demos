import { describe, expect, test } from "bun:test";
import { byActivity, childCounts, cleanTitle, groupByDate, relativeTime, targetOf } from "./sidebar";

describe("cleanTitle", () => {
  test("strips a role sentence, a heading and key=value preamble", () => {
    expect(cleanTitle("You are a senior engineer. Fix the flaky test in CI")).toBe("Fix the flaky test in CI");
    expect(cleanTitle("# Task\nRefactor the parser")).toBe("Refactor the parser");
    expect(cleanTitle("repo_url=https://github.com/a/b\nbranch=main\nAdd a README")).toBe("Add a README");
  });
  test("falls back to the raw first line when everything was stripped", () => {
    expect(cleanTitle("You are a bot.")).toBe("You are a bot.");
  });
  test("truncates long lines and returns null for nothing", () => {
    expect(cleanTitle("x".repeat(80))!.length).toBe(55);
    expect(cleanTitle("")).toBeNull();
    expect(cleanTitle(null)).toBeNull();
  });
});

describe("targetOf", () => {
  test("PR, repo, repo_url, nothing", () => {
    expect(targetOf("Review https://github.com/acme/widgets/pull/42 please")).toBe("acme/widgets#42");
    expect(targetOf("Clone https://github.com/acme/widgets.git and build")).toBe("acme/widgets");
    expect(targetOf("Look at https://github.com/acme/widgets")).toBe("acme/widgets");
    expect(targetOf("repo_url=git@github.com:acme/widgets.git\nfix it")).toBe("acme/widgets");
    expect(targetOf("no links here")).toBeNull();
  });
});

describe("groupByDate", () => {
  const now = Date.parse("2026-08-20T12:00:00Z");
  const at = (h: number) => new Date(now - h * 3_600_000).toISOString();
  const c = (status: string, hoursAgo: number) => ({ status: status as "idle", last_active_at: at(hoursAgo), updated_at: at(hoursAgo), inserted_at: at(hoursAgo) });
  test("running on top, then by age; empty groups omitted", () => {
    const groups = groupByDate([c("idle", 1), c("running", 100), c("idle", 30), c("idle", 100), c("idle", 500)], now);
    expect(groups.map((g) => [g.key, g.items.length])).toEqual([
      ["Active", 1],
      ["Today", 1],
      ["Yesterday", 1],
      ["Past 7 days", 1],
      ["Older", 1],
    ]);
  });
});

test("childCounts and byActivity", () => {
  expect([...childCounts([{ parent_conversation_id: "a" }, { parent_conversation_id: "a" }, { parent_conversation_id: null }])]).toEqual([["a", 2]]);
  const sorted = byActivity([
    { last_active_at: "2026-01-01T00:00:00Z", updated_at: "", inserted_at: "" },
    { last_active_at: null, updated_at: "2026-02-01T00:00:00Z", inserted_at: "" },
  ]);
  expect(sorted[0]!.updated_at).toBe("2026-02-01T00:00:00Z");
});

test("relativeTime", () => {
  const now = Date.parse("2026-08-20T12:00:00Z");
  expect(relativeTime("2026-08-20T11:59:30Z", now)).toBe("30s ago");
  expect(relativeTime("2026-08-20T11:30:00Z", now)).toBe("30m ago");
  expect(relativeTime("2026-08-20T09:00:00Z", now)).toBe("3h ago");
  expect(relativeTime("2026-08-10T12:00:00Z", now)).toBe("10d ago");
  expect(relativeTime(null, now)).toBe("—");
});
