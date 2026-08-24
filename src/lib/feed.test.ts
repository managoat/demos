import { describe, expect, test } from "bun:test";
import { feedCount, feedGroups, feedRead, feedSummary, feedTitle, feedWhere, NO_ACTIVITY } from "./feed";
import type { ActivityDto, FeedEntry } from "./api";

function entry(over: Partial<FeedEntry> & Pick<FeedEntry, "conversationId" | "projectId" | "at">): FeedEntry {
  return {
    projectName: "Project",
    itemId: "w1",
    itemTitle: "fix foo",
    title: "Coder: fix foo",
    agentId: "a1",
    status: "idle",
    ...over,
  };
}

function survey(feed: FeedEntry[], dropped = 0): ActivityDto {
  return { projects: {}, feed, dropped };
}

describe("the feed", () => {
  test("the badge counts what the server capped off the list too", () => {
    expect(feedCount(NO_ACTIVITY)).toBe(0);
    const a = survey([entry({ conversationId: "c1", projectId: "p1", at: "2026-08-24T10:00:00Z" })], 12);
    // 1 shown + 12 held back: a badge that said "1" would go quiet while
    // there was more, which is the failure the feed exists to fix.
    expect(feedCount(a)).toBe(13);
  });

  test("projects rank by their newest entry, and the one you are looking at sinks", () => {
    const feed = [
      entry({ conversationId: "c1", projectId: "here", projectName: "Here", at: "2026-08-24T12:00:00Z" }),
      entry({ conversationId: "c2", projectId: "p2", projectName: "Two", at: "2026-08-24T11:00:00Z" }),
      entry({ conversationId: "c3", projectId: "p3", projectName: "Three", at: "2026-08-24T09:00:00Z" }),
      entry({ conversationId: "c4", projectId: "p3", projectName: "Three", at: "2026-08-24T08:00:00Z" }),
    ];
    // Nowhere in particular: newest project first, "here" included.
    expect(feedGroups(feed, null).map((g) => g.projectId)).toEqual(["here", "p2", "p3"]);
    // Inside a project, what is in front of you is the one thing you did not
    // need telling about, however recent it is.
    const inHere = feedGroups(feed, "here");
    expect(inHere.map((g) => g.projectId)).toEqual(["p2", "p3", "here"]);
    expect(inHere.find((g) => g.projectId === "p3")!.entries.map((e) => e.conversationId)).toEqual(["c3", "c4"]);
  });

  test("two projects with no entries between them do not shuffle: the order is total", () => {
    const same = "2026-08-24T10:00:00Z";
    const feed = [
      entry({ conversationId: "cb", projectId: "b", projectName: "B", at: same }),
      entry({ conversationId: "ca", projectId: "a", projectName: "A", at: same }),
    ];
    expect(feedGroups(feed, null).map((g) => g.projectId)).toEqual(["a", "b"]);
  });

  test("reading one takes it out now, and reading one that is not there changes nothing", () => {
    const a = survey([
      entry({ conversationId: "c1", projectId: "p1", at: "2026-08-24T10:00:00Z" }),
      entry({ conversationId: "c2", projectId: "p1", at: "2026-08-24T09:00:00Z" }),
    ]);
    expect(feedRead(a, "c1").feed.map((e) => e.conversationId)).toEqual(["c2"]);
    // Same object back, so nothing re-renders for a conversation the feed
    // never had — every thread you open calls this.
    expect(feedRead(a, "nope")).toBe(a);
    // The cap is untouched: reading a row does not tell us what was behind it.
    expect(feedRead(survey([entry({ conversationId: "c1", projectId: "p1", at: "x" })], 5), "c1").dropped).toBe(5);
  });

  test("the tooltip says the count, and says when some of it failed", () => {
    expect(feedSummary(NO_ACTIVITY)).toContain("Nothing waiting");
    const one = survey([entry({ conversationId: "c1", projectId: "p1", at: "x" })]);
    expect(feedSummary(one)).toBe("1 conversation finished and unread");
    const mixed = survey([
      entry({ conversationId: "c1", projectId: "p1", at: "x" }),
      entry({ conversationId: "c2", projectId: "p1", at: "x", status: "failed" }),
    ]);
    expect(feedSummary(mixed)).toBe("2 conversations finished and unread — 1 failed");
  });

  test("a conversation Fountain has not titled yet, and an item that is gone, still read as something", () => {
    const e = entry({ conversationId: "c1", projectId: "p1", at: "x", title: null, itemTitle: null });
    expect(feedTitle(e)).toBe("Untitled conversation");
    expect(feedWhere(e)).toContain("no longer here");
  });
});
