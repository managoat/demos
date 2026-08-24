/**
 * The half of notify.ts that touches the browser: asking permission, keeping
 * the answer, and putting a notification on the desktop when a survey turns up
 * something the last one did not. What counts as news is settled in
 * notify.test.ts against nothing but a pair of feeds; these are the rules that
 * need a render to show.
 *
 * `Notification` is stood in for, because Bun has no notifications and
 * happy-dom's document does not come with any either — and because the whole
 * point of the assertions is what the app hands the browser, which a fake is
 * the only way to read.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { renderHook, step } from "../../test/render";
import { useDesktopNotify } from "./notify";
import { NO_ACTIVITY } from "./feed";
import type { ActivityDto, FeedEntry, WaitingEntry } from "./api";

class FakeNotification {
  static permission: NotificationPermission = "default";
  /** What the browser will say when asked. */
  static answer: NotificationPermission = "granted";
  static asked = 0;
  static shown: FakeNotification[] = [];
  onclick: (() => void) | null = null;
  closed = false;
  constructor(
    readonly title: string,
    readonly options: NotificationOptions = {},
  ) {
    FakeNotification.shown.push(this);
  }
  close() {
    this.closed = true;
  }
  static requestPermission(): Promise<NotificationPermission> {
    FakeNotification.asked++;
    FakeNotification.permission = FakeNotification.answer;
    return Promise.resolve(FakeNotification.permission);
  }
}

const globals = globalThis as unknown as Record<string, unknown>;
const real = globals.Notification;
afterAll(() => {
  if (real === undefined) delete globals.Notification;
  else globals.Notification = real;
});

const entry = (over: Partial<FeedEntry> & Pick<FeedEntry, "conversationId" | "projectId">): FeedEntry => ({
  projectName: "Fountain",
  itemId: "w1",
  itemTitle: "fix foo",
  title: "Coder: fix foo",
  agentId: "a1",
  status: "idle",
  at: "2026-08-24T10:00:00Z",
  ...over,
});

const survey = (feed: FeedEntry[], waiting: WaitingEntry[] = []): ActivityDto => ({ projects: {}, feed, waiting, dropped: 0 });

/** Blocked now, and denied by Fountain five minutes from now. */
const asking = (over: Partial<WaitingEntry> & Pick<WaitingEntry, "conversationId" | "projectId">): WaitingEntry => ({
  projectName: "Fountain",
  itemId: "w1",
  itemTitle: "fix foo",
  title: "Coder: fix foo",
  agentId: "a1",
  requestId: "r1",
  tool: "Bash",
  askedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  ...over,
});

const notifier = (activity: ActivityDto = NO_ACTIVITY) => renderHook((a: ActivityDto) => useDesktopNotify(a), activity);

/**
 * Click the switch. The body is async so that React settles the state the
 * browser's answer sets — `requestPermission` resolves a microtask after the
 * click, which a synchronous `act` has already returned from.
 */
const click = async (h: { current: { toggle: () => void } }) => {
  await step(async () => {
    h.current.toggle();
    await Promise.resolve();
  });
};

const titles = () => FakeNotification.shown.map((n) => n.title);

beforeEach(() => {
  globals.Notification = FakeNotification;
  FakeNotification.permission = "default";
  FakeNotification.answer = "granted";
  FakeNotification.asked = 0;
  FakeNotification.shown = [];
  localStorage.removeItem("fountain-workbench.notify");
});

describe("useDesktopNotify", () => {
  test("off until asked for: a browser does not announce anything nobody asked it to", async () => {
    // Not merely un-permitted — un-asked-for. Even with the permission already
    // granted from some earlier session, the preference is what turns it on.
    FakeNotification.permission = "granted";
    const h = await notifier();
    await h.set(survey([entry({ conversationId: "c1", projectId: "p1" })]));
    expect(h.current.state).toBe("off");
    expect(titles()).toEqual([]);
    await h.unmount();
  });

  test("the click is what asks, and only the first one has to", async () => {
    const h = await notifier();
    await click(h);
    expect(FakeNotification.asked).toBe(1);
    expect(h.current.state).toBe("on");
    // Remembered per browser, like the theme.
    expect(localStorage.getItem("fountain-workbench.notify")).toBe("on");

    // Off and on again does not re-ask: the browser has already answered.
    await click(h);
    expect(h.current.state).toBe("off");
    await click(h);
    expect(h.current.state).toBe("on");
    expect(FakeNotification.asked).toBe(1);
    await h.unmount();
  });

  test("a browser that says no leaves the switch saying so, not saying off", async () => {
    FakeNotification.answer = "denied";
    const h = await notifier();
    await click(h);
    expect(h.current.state).toBe("blocked");
    // And nothing is announced, because nothing can be.
    await h.set(survey([entry({ conversationId: "c1", projectId: "p1" })]));
    expect(titles()).toEqual([]);
    // Clicking a blocked switch is how you stop asking.
    await click(h);
    expect(h.current.state).toBe("off");
    await h.unmount();
  });

  test("turning it on takes the feed as it stands, and announces what lands after", async () => {
    const waiting = [entry({ conversationId: "c1", projectId: "p1" })];
    const h = await notifier(survey(waiting));
    await click(h);
    // What was already waiting when you asked is not news: you have been
    // looking at its count on the bell all morning.
    expect(titles()).toEqual([]);

    await h.set(survey([entry({ conversationId: "c2", projectId: "p2", projectName: "Workbench", title: "Coder: ship it" }), ...waiting]));
    expect(titles()).toEqual(["Coder: ship it — finished"]);
    expect(FakeNotification.shown[0]!.options.body).toBe("Workbench · fix foo");
    // One tag per conversation, so a second tab announcing the same finish
    // replaces this rather than repeating it.
    expect(FakeNotification.shown[0]!.options.tag).toBe("c2");

    // The same survey again is not the same news again.
    await h.set(survey([entry({ conversationId: "c2", projectId: "p2" }), ...waiting]));
    expect(titles()).toHaveLength(1);
    await h.unmount();
  });

  test("switching it off and on again re-reads the baseline rather than reciting the backlog", async () => {
    const h = await notifier(survey([]));
    await click(h);
    await h.set(survey([entry({ conversationId: "c1", projectId: "p1" })]));
    expect(titles()).toHaveLength(1);

    await click(h); // off
    await h.set(survey([entry({ conversationId: "c2", projectId: "p1" }), entry({ conversationId: "c1", projectId: "p1" })]));
    expect(titles()).toHaveLength(1);

    await click(h); // on again — c2 arrived while it was off, and is not news now
    await h.set(survey([entry({ conversationId: "c2", projectId: "p1" }), entry({ conversationId: "c1", projectId: "p1" })]));
    expect(titles()).toHaveLength(1);
    await h.unmount();
  });

  test("a blocked agent reaches the desktop too, and leads what it arrives with", async () => {
    const h = await notifier(survey([]));
    await click(h);
    await h.set(survey([entry({ conversationId: "c1", projectId: "p1" })], [asking({ conversationId: "c9", projectId: "p9" })]));
    // The blocked one first: it is the only half of this with a deadline, and
    // behind a tab you are not looking at it can spend the whole of it there.
    expect(titles()).toEqual(["Coder: fix foo wants to run Bash", "Coder: fix foo — finished"]);
    expect(FakeNotification.shown[0]!.options.tag).toBe("c9:r1");
    await h.unmount();
  });

  test("clicking one brings the window forward and opens the thread", async () => {
    window.location.hash = "#/";
    const h = await notifier(survey([]));
    await click(h);
    await h.set(survey([entry({ conversationId: "c1", projectId: "p1" })]));
    const note = FakeNotification.shown[0]!;
    note.onclick!();
    expect(window.location.hash).toBe("#/p/p1/c/c1");
    // It has been acted on; it should not stay on the desktop.
    expect(note.closed).toBe(true);
    window.location.hash = "#/";
    await h.unmount();
  });

  test("a browser with no notifications is offered none: the switch is not there", async () => {
    delete globals.Notification;
    const h = await notifier();
    expect(h.current.state).toBeNull();
    // And a click on something that is not rendered still cannot throw.
    await click(h);
    expect(h.current.state).toBeNull();
    await h.unmount();
  });
});
