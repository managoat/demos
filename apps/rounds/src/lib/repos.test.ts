import { describe, expect, test } from "bun:test";
import { byRecency, isSuggested, keyOfSlug, matchesQuery, railRepos, type AccessibleRepo } from "./repos";

const NOW = Date.parse("2026-08-20T00:00:00Z");
const day = (n: number) => new Date(NOW - n * 86400_000).toISOString();

const repo = (slug: string, over: Partial<AccessibleRepo> = {}): AccessibleRepo => ({
  slug,
  private: false,
  fork: false,
  archived: false,
  pushedAt: day(1),
  description: null,
  ...over,
});

const rail = (repos: AccessibleRepo[], over: Partial<Parameters<typeof railRepos>[0]> = {}) =>
  railRepos({ repos, enrolledKeys: new Set(), skipped: new Set(), query: "", filter: "suggested", now: NOW, ...over });

describe("what gets suggested", () => {
  test("a repository somebody is still pushing to", () => {
    expect(isSuggested(repo("o/live", { pushedAt: day(3) }), NOW)).toBe(true);
  });

  test("not one nobody has touched in a year — the config is not drifting if nothing moves", () => {
    expect(isSuggested(repo("o/stale", { pushedAt: day(400) }), NOW)).toBe(false);
  });

  test("not an archive: a round could audit it and never open anything", () => {
    expect(isSuggested(repo("o/old", { archived: true }), NOW)).toBe(false);
  });

  test("not a fork: its configuration is somebody else's", () => {
    expect(isSuggested(repo("o/fork", { fork: true }), NOW)).toBe(false);
  });

  test("not one with no push on record", () => {
    expect(isSuggested(repo("o/empty", { pushedAt: null }), NOW)).toBe(false);
    expect(isSuggested(repo("o/broken", { pushedAt: "not a date" }), NOW)).toBe(false);
  });

  test("private is no obstacle — private repositories are the point of the App", () => {
    expect(isSuggested(repo("o/secret", { private: true }), NOW)).toBe(true);
  });
});

describe("search", () => {
  const r = repo("acme/web-api", { description: "The public edge" });

  test("matches part of the slug, either side of the slash", () => {
    expect(matchesQuery(r, "web")).toBe(true);
    expect(matchesQuery(r, "acme/")).toBe(true);
    expect(matchesQuery(r, "API")).toBe(true);
  });

  test("every word has to land, so two words narrow rather than widen", () => {
    expect(matchesQuery(r, "acme api")).toBe(true);
    expect(matchesQuery(r, "acme worker")).toBe(false);
  });

  test("the description is searchable too", () => {
    expect(matchesQuery(r, "edge")).toBe(true);
  });

  test("an empty search matches everything", () => {
    expect(matchesQuery(r, "   ")).toBe(true);
  });
});

describe("the rail", () => {
  test("what is already enrolled is not offered again", () => {
    const out = rail([repo("o/a"), repo("o/b")], { enrolledKeys: new Set([keyOfSlug("o/a")]) });
    expect(out.available.map((r) => r.slug)).toEqual(["o/b"]);
  });

  test("most recently pushed first, because that is the only ranking claimed", () => {
    const out = rail([repo("o/old", { pushedAt: day(30) }), repo("o/new", { pushedAt: day(1) }), repo("o/mid", { pushedAt: day(10) })]);
    expect(out.available.map((r) => r.slug)).toEqual(["o/new", "o/mid", "o/old"]);
  });

  test("undated repositories sort last rather than first", () => {
    const out = rail([repo("o/undated", { pushedAt: null }), repo("o/dated")], { filter: "all" });
    expect(out.available.map((r) => r.slug)).toEqual(["o/dated", "o/undated"]);
  });

  test("the default filter holds back the stale ones, and says how many", () => {
    const out = rail([repo("o/live"), repo("o/stale", { pushedAt: day(400) }), repo("o/archived", { archived: true })]);
    expect(out.available.map((r) => r.slug)).toEqual(["o/live"]);
    expect(out.hiddenByFilter).toBe(2);
    expect(out.totalAvailable).toBe(3);
  });

  test("`all` shows them, still in order", () => {
    const out = rail([repo("o/live"), repo("o/stale", { pushedAt: day(400) })], { filter: "all" });
    expect(out.available.map((r) => r.slug)).toEqual(["o/live", "o/stale"]);
    expect(out.hiddenByFilter).toBe(0);
  });

  test("a search reaches past the filter — typing an archived repo's name finds it", () => {
    const out = rail([repo("o/live"), repo("o/ancient", { archived: true, pushedAt: day(900) })], { query: "ancient" });
    expect(out.available.map((r) => r.slug)).toEqual(["o/ancient"]);
  });

  test("something waved away leaves the list, and is counted so it can come back", () => {
    const out = rail([repo("o/a"), repo("o/b")], { skipped: new Set(["o/b"]) });
    expect(out.available.map((r) => r.slug)).toEqual(["o/a"]);
    expect(out.skippedCount).toBe(1);
    expect(out.totalAvailable).toBe(1);
  });

  test("the skipped filter is the way back to them", () => {
    const out = rail([repo("o/a"), repo("o/b")], { skipped: new Set(["o/b"]), filter: "skipped" });
    expect(out.available.map((r) => r.slug)).toEqual(["o/b"]);
  });

  test("skipping something already enrolled is not a thing that can happen", () => {
    const out = rail([repo("o/a")], { enrolledKeys: new Set([keyOfSlug("o/a")]), skipped: new Set(["o/a"]), filter: "skipped" });
    expect(out.available).toEqual([]);
    expect(out.skippedCount).toBe(0);
  });

  test("ties break on the name, so the list does not reshuffle between renders", () => {
    const same = day(5);
    expect([repo("o/b", { pushedAt: same }), repo("o/a", { pushedAt: same })].sort(byRecency).map((r) => r.slug)).toEqual(["o/a", "o/b"]);
  });
});
