/**
 * The panel's copy and its links. The derivation is tested in
 * src/lib/feed.test.ts; this is here because a row has to say which project
 * it is in — that being the fact the reader is missing — and because a panel
 * that throws on an empty feed is a top bar that will not paint on any page.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FeedList } from "./Feed";
import { NO_ACTIVITY } from "../lib/feed";
import type { ActivityDto, FeedEntry, WaitingEntry } from "../lib/api";

const T0 = Date.parse("2026-08-24T10:00:00Z");
const at = (mins: number) => new Date(T0 + mins * 60_000).toISOString();

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

const entry = (over: Partial<FeedEntry> & Pick<FeedEntry, "conversationId" | "projectId" | "at">): FeedEntry => ({
  projectName: "Fountain",
  itemId: "w1",
  itemTitle: "fix foo",
  title: "Coder: fix foo",
  agentId: "a1",
  status: "idle",
  ...over,
});

const render = (a: ActivityDto, here: string | null = null) => renderToStaticMarkup(<FeedList activity={a} here={here} now={T0 + 30 * 60_000} />);

describe("FeedList", () => {
  test("nothing waiting: it says so, and says what would land here", () => {
    const html = render(NO_ACTIVITY);
    expect(html).toContain("Nothing waiting");
    expect(html).toContain("Opening the thread is what clears it");
    expect(html).not.toContain("feed-row ");
  });

  test("a row names the conversation, the item and the project, and links to the thread", () => {
    const html = render({ projects: {}, dropped: 0, waiting: [], feed: [entry({ conversationId: "c1", projectId: "p1", at: at(0) })] });
    expect(html).toContain("Coder: fix foo");
    expect(html).toContain("fix foo");
    // The project is the fact the reader is missing: they are in another one.
    expect(html).toContain("Fountain");
    expect(html).toContain('href="#/p/p1/c/c1"');
    expect(html).toContain("30m ago");
  });

  test("a failed conversation says so where the row is read, not only in its colour", () => {
    const html = render({ projects: {}, dropped: 0, waiting: [], feed: [entry({ conversationId: "c1", projectId: "p1", at: at(0), status: "failed" })] });
    expect(html).toContain("feed-row failed");
    expect(html).toContain("failed ·");
  });

  test("the project you are looking at is labelled, so a row you can already see is not mistaken for news", () => {
    const a: ActivityDto = {
      projects: {},
      dropped: 0,
      waiting: [],
      feed: [
        entry({ conversationId: "c1", projectId: "here", projectName: "Here", at: at(0) }),
        entry({ conversationId: "c2", projectId: "p2", projectName: "Elsewhere", at: at(-10) }),
      ],
    };
    const html = render(a, "here");
    expect(html).toContain("· here");
    // And it is last, under the project that is actually news.
    expect(html.indexOf("Elsewhere")).toBeLessThan(html.indexOf("Here"));
  });

  test("what the server capped off is stated, not swallowed", () => {
    const html = render({ projects: {}, dropped: 7, waiting: [], feed: [entry({ conversationId: "c1", projectId: "p1", at: at(0) })] });
    expect(html).toContain("7 more not shown");
    // The count in the head is everything waiting, including those seven.
    expect(html).toContain("8 conversations finished and unread");
  });

  test("a blocked agent is first, says what it wants to run, and counts down", () => {
    const html = render({
      projects: {},
      dropped: 0,
      waiting: [asking(27, { conversationId: "c9", projectId: "p9", projectName: "Ravioli" })],
      feed: [entry({ conversationId: "c1", projectId: "p1", at: at(0) })],
    });
    expect(html).toContain("Waiting on you");
    expect(html).toContain("wants to run Bash");
    // Two minutes to answer before Fountain answers for you, with a refusal.
    expect(html).toContain("2m left");
    expect(html).toContain('href="#/p/p9/c/c9"');
    // Above what merely finished: one of these is on a clock and the other
    // will still be there tomorrow.
    expect(html.indexOf("Waiting on you")).toBeLessThan(html.indexOf("Coder: fix foo"));
    // And the head leads with it.
    expect(html).toContain("1 agent is blocked waiting on you");
  });

  test("a request that has already run out is not offered — Fountain has answered it", () => {
    // Asked at 20, denied at 25, and it is 30: a row here would be a link to
    // a question nobody can answer any more.
    const html = render({ projects: {}, dropped: 0, waiting: [asking(20, { conversationId: "c9", projectId: "p9" })], feed: [] });
    expect(html).not.toContain("feed-group waiting");
    expect(html).toContain("Nothing waiting");
  });

  test("the desktop switch says which way it is set, and is absent where the browser has none", () => {
    // The panel is what you open when you are wondering whether anything
    // happened, so it is where you are offered the thing that stops you having
    // to wonder — including when there is nothing waiting at all.
    const on = renderToStaticMarkup(<FeedList activity={NO_ACTIVITY} here={null} now={T0} desktop="on" onDesktop={() => {}} />);
    expect(on).toContain("desktop · on");
    expect(on).toContain('aria-pressed="true"');
    const blocked = renderToStaticMarkup(<FeedList activity={NO_ACTIVITY} here={null} now={T0} desktop="blocked" onDesktop={() => {}} />);
    // Not "off": the browser refused something that was asked for, and the
    // panel is where that answer has to be readable.
    expect(blocked).toContain("desktop · blocked");
    expect(blocked).toContain("address bar");
    // A browser with no Notification API is offered nothing at all.
    expect(render(NO_ACTIVITY)).not.toContain("feed-desktop");
  });

  test("a conversation Fountain has not titled yet still renders as a row", () => {
    const html = render({ projects: {}, dropped: 0, waiting: [], feed: [entry({ conversationId: "c1", projectId: "p1", at: at(0), title: null, itemTitle: null })] });
    expect(html).toContain("Untitled conversation");
    expect(html).toContain("no longer here");
  });
});
