/**
 * The decisions in notify.ts that do not need a browser: what counts as news
 * against the previous survey, what a batch of it says, and what the switch
 * reads as. The hook — asking, remembering, and actually putting one on the
 * desktop — is in notify.hook.test.tsx.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { announce, askingNotices, desktopHint, desktopLabel, desktopState, loadNotify, noticesFor, saveNotify } from "./notify";
import type { ActivityDto, FeedEntry, WaitingEntry } from "./api";

const T0 = Date.parse("2026-08-24T10:00:00Z");
const at = (mins: number) => new Date(T0 + mins * 60_000).toISOString();

const entry = (over: Partial<FeedEntry> & Pick<FeedEntry, "conversationId" | "projectId">): FeedEntry => ({
  projectName: "Fountain",
  itemId: "w1",
  itemTitle: "fix foo",
  title: "Coder: fix foo",
  agentId: "a1",
  status: "idle",
  at: at(0),
  ...over,
});

/** Asked `mins` after T0, and denied by Fountain five minutes after that. */
const asking = (mins: number, over: Partial<WaitingEntry> & Pick<WaitingEntry, "conversationId" | "projectId">): WaitingEntry => ({
  projectName: "Fountain",
  itemId: "w1",
  itemTitle: "fix foo",
  title: "Coder: fix foo",
  agentId: "a1",
  requestId: "r1",
  tool: "Bash",
  askedAt: at(mins),
  expiresAt: at(mins + 5),
  ...over,
});

const survey = (feed: FeedEntry[], waiting: WaitingEntry[] = []): ActivityDto => ({ projects: {}, feed, waiting, dropped: 0 });

/** The mark a survey leaves — what the next one measures news against. */
const marked = (a: ActivityDto, now = T0) => announce(a, null, now).mark;

describe("what is news", () => {
  test("the first survey announces nothing: arriving is not something happening", () => {
    // Everything in a feed is unread by definition. A browser that spoke about
    // what it found on arrival would ring once per conversation you had
    // already looked at and decided to leave — every time you opened a tab.
    const a = survey([entry({ conversationId: "c1", projectId: "p1" }), entry({ conversationId: "c2", projectId: "p2" })]);
    const first = announce(a, null, T0);
    expect(first.notices).toEqual([]);
    expect(first.mark.finished).toEqual(new Set(["c1", "c2"]));
  });

  test("the second announces only what was not in the first", () => {
    const before = survey([entry({ conversationId: "c1", projectId: "p1" })]);
    const after = survey([entry({ conversationId: "c2", projectId: "p1", title: "Coder: ship it" }), ...before.feed]);
    const { notices, mark } = announce(after, marked(before), T0);
    expect(notices.map((n) => n.tag)).toEqual(["c2"]);
    expect(mark.finished).toEqual(new Set(["c1", "c2"]));
  });

  test("a survey with nothing new in it says nothing, however long the feed is", () => {
    const a = survey([entry({ conversationId: "c1", projectId: "p1" }), entry({ conversationId: "c2", projectId: "p1" })]);
    expect(announce(a, marked(a), T0).notices).toEqual([]);
  });

  test("the mark is the survey as it stands, so a conversation that wakes up again is news again", () => {
    // Read it: it leaves the feed, and leaves the mark with it — which is also
    // what stops the mark growing for as long as the tab is open.
    const woke = survey([entry({ conversationId: "c1", projectId: "p1" })]);
    const quiet = announce(survey([]), marked(woke), T0);
    expect(quiet.mark.finished.size).toBe(0);
    // Somebody answered and the agent came back. That is news: it is a
    // different finish from the one already dealt with.
    expect(announce(woke, quiet.mark, T0).notices.map((n) => n.tag)).toEqual(["c1"]);
  });
});

describe("the half that expires", () => {
  const now = (mins: number) => T0 + mins * 60_000;

  test("a blocked agent leads, whatever else came in with it", () => {
    const before = survey([]);
    const after = survey([entry({ conversationId: "c1", projectId: "p1" })], [asking(0, { conversationId: "c9", projectId: "p9" })]);
    const { notices } = announce(after, marked(before), now(1));
    // One of these is on a five-minute clock and the other will still be there
    // tomorrow. The order is the whole point of announcing them together.
    expect(notices.map((n) => n.tag)).toEqual(["c9:r1", "c1"]);
    expect(notices[0]!.title).toBe("Coder: fix foo wants to run Bash");
    expect(notices[0]!.body).toBe("Fountain · fix foo · 4m left");
    expect(notices[0]!.href).toBe("#/p/p9/c/c9");
  });

  test("said again when it is nearly out, and not a third time", () => {
    const w = asking(0, { conversationId: "c9", projectId: "p9" });
    const a = survey([], [w]);
    // Turned up at 10:00, announced. It expires at 10:05.
    let mark = announce(a, marked(survey([])), now(0)).mark;
    // Two minutes later, still blocked, still three minutes of slack: silence.
    const quiet = announce(a, mark, now(2));
    expect(quiet.notices).toEqual([]);
    mark = quiet.mark;
    // At 10:03:30 there are ninety seconds left. The first notice was exactly as
    // missable as the badge it stood in for, and this one is running out.
    const nudge = announce(a, mark, now(3.5));
    expect(nudge.notices.map((n) => n.body)).toEqual(["Fountain · fix foo · 2m left"]);
    // And that is the last of it — a third would be nagging, not news.
    expect(announce(a, nudge.mark, now(4)).notices).toEqual([]);
  });

  test("one that was already nearly out when it arrived gets one notice, not two", () => {
    // Asked at 10:00, found at 10:04 — a survey that came late, or a tab that
    // has just been switched on. There is no time for a second.
    const a = survey([], [asking(0, { conversationId: "c9", projectId: "p9" })]);
    const first = announce(a, marked(survey([])), now(4));
    expect(first.notices).toHaveLength(1);
    expect(announce(a, first.mark, now(4.5)).notices).toEqual([]);
  });

  test("one that has run out is not announced at all — Fountain has answered it", () => {
    // Asked at 10:00, denied at 10:05, and it is 10:06. Announcing it would
    // send somebody to a question nobody can answer any more.
    const a = survey([], [asking(0, { conversationId: "c9", projectId: "p9" })]);
    expect(announce(a, marked(survey([])), now(6)).notices).toEqual([]);
    expect(announce(a, marked(survey([])), now(6)).mark.asking.size).toBe(0);
  });

  test("answered, then blocked again on a new question: the request id is what makes it news", () => {
    const one = survey([], [asking(0, { conversationId: "c9", projectId: "p9", requestId: "r1" })]);
    const two = survey([], [asking(1, { conversationId: "c9", projectId: "p9", requestId: "r2" })]);
    const { notices } = announce(two, announce(one, null, now(0)).mark, now(1));
    // Same conversation, different question. The first was answered — that is
    // what made it go away — and this is a new thing to answer.
    expect(notices.map((n) => n.tag)).toEqual(["c9:r2"]);
  });

  test("four at once is one that says four, and names the deadline that is closest", () => {
    const many = [
      asking(2, { conversationId: "c1", projectId: "p1", requestId: "r1" }),
      asking(1, { conversationId: "c2", projectId: "p1", requestId: "r2" }),
      asking(2, { conversationId: "c3", projectId: "p2", projectName: "Workbench", requestId: "r3" }),
      asking(3, { conversationId: "c4", projectId: "p2", projectName: "Workbench", requestId: "r4" }),
    ];
    const [one, ...rest] = askingNotices(many, now(3));
    expect(rest).toEqual([]);
    expect(one!.title).toBe("4 agents are blocked waiting on you");
    // Asked at 10:01, so out at 10:06: three minutes from now, and the first
    // of the four to go.
    expect(one!.body).toBe("Fountain, Workbench · 3m left on the first");
    expect(one!.href).toBeNull();
  });
});

describe("what it says", () => {
  test("a row names the conversation, its end, its project and its item, and links to the thread", () => {
    const [n] = noticesFor([entry({ conversationId: "c1", projectId: "p1" })]);
    expect(n!.title).toBe("Coder: fix foo — finished");
    // The project first: this is read with none of the app on screen, so
    // "which project is this" is the fact the reader is missing.
    expect(n!.body).toBe("Fountain · fix foo");
    expect(n!.href).toBe("#/p/p1/c/c1");
    // The tag is the conversation, so two open tabs announcing the same
    // finish replace each other instead of saying it twice.
    expect(n!.tag).toBe("c1");
  });

  test("a failure says so in the title, where a notification is actually read", () => {
    const [n] = noticesFor([entry({ conversationId: "c1", projectId: "p1", status: "failed" })]);
    expect(n!.title).toBe("Coder: fix foo — failed");
  });

  test("a conversation Fountain has not titled, on an item that is gone, still says something", () => {
    const [n] = noticesFor([entry({ conversationId: "c1", projectId: "p1", title: null, itemTitle: null })]);
    expect(n!.title).toBe("Untitled conversation — finished");
    expect(n!.body).toContain("no longer here");
  });

  test("three at once is three; four is one that says four", () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => entry({ conversationId: `c${i}`, projectId: "p1" }));
    expect(noticesFor(many(3))).toHaveLength(3);
    const [one] = noticesFor(many(4));
    // Four notifications in a corner is not four times the news — it is a wall
    // somebody swipes away without reading, and the feed goes with it.
    expect(noticesFor(many(4))).toHaveLength(1);
    expect(one!.title).toBe("4 conversations finished");
    expect(one!.body).toBe("Fountain");
    // Nowhere in particular to send them: the bell is on every page.
    expect(one!.href).toBeNull();
  });

  test("the summary names the projects it is about, and how much of it failed", () => {
    const [one] = noticesFor([
      entry({ conversationId: "c1", projectId: "p1", projectName: "Fountain" }),
      entry({ conversationId: "c2", projectId: "p1", projectName: "Fountain" }),
      entry({ conversationId: "c3", projectId: "p2", projectName: "Workbench", status: "failed" }),
      entry({ conversationId: "c4", projectId: "p2", projectName: "Workbench" }),
    ]);
    expect(one!.body).toBe("Fountain, Workbench — 1 failed");
  });

  test("nothing new, nothing said", () => {
    expect(noticesFor([])).toEqual([]);
  });
});

describe("the switch", () => {
  beforeEach(() => localStorage.removeItem("fountain-workbench.notify"));

  test("what the browser said and what the user asked for, together", () => {
    expect(desktopState(false, "granted")).toBe("off");
    expect(desktopState(true, "granted")).toBe("on");
    // Asked for and refused is its own state, not a silent return to off: the
    // answer to "why is nothing arriving" is the browser's, and swallowing it
    // leaves a button that does nothing and says nothing about why.
    expect(desktopState(true, "denied")).toBe("blocked");
    // Asked for, never answered — the prompt was dismissed. Nothing arrives,
    // so it says off, and clicking asks again.
    expect(desktopState(true, "default")).toBe("off");
  });

  test("every state says what it is, and the two that are on say how to stop", () => {
    for (const s of ["off", "on", "blocked"] as const) expect(desktopLabel(s)).toContain("desktop");
    // Off is an offer, so it says what turning it on gets you and warns that
    // the browser will ask; the other two are already running, so they say how
    // to stop — and blocked says where the refusal it is reporting lives.
    expect(desktopHint("off")).toContain("Your browser will ask first");
    expect(desktopHint("on")).toContain("Click to stop");
    expect(desktopHint("blocked")).toContain("Click to stop");
    expect(desktopHint("blocked")).toContain("address bar");
  });

  test("the preference is this browser's, and off is the absence of it", () => {
    expect(loadNotify()).toBe(false);
    saveNotify(true);
    expect(loadNotify()).toBe(true);
    saveNotify(false);
    // Removed rather than written as "off": nothing to migrate, and a browser
    // that has never been asked and one that said no read the same to the app.
    expect(localStorage.getItem("fountain-workbench.notify")).toBeNull();
    expect(loadNotify()).toBe(false);
  });
});
