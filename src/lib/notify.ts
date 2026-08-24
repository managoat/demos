/**
 * The feed, on your desktop, when the tab is not in front of you.
 *
 * The bell (components/Feed.tsx) already knows what finished in your other
 * projects, and who is blocked waiting on you in them. Its limit is that it is
 * on a screen: a badge is only a notification to someone who is looking at the
 * window it is in, and the whole complaint the feed answers is that you were
 * somewhere else. This is the same fact one step further out — the browser's
 * own notification, which arrives over whatever you are actually doing.
 *
 * It matters most for the half that expires. A finished conversation waits for
 * you indefinitely, so finding out a minute late costs nothing; an agent held
 * on a permission request is denied by Fountain five minutes later, and can
 * spend all five of them behind a tab you are not looking at. So blocked goes
 * first here as it does in the panel, and it is the one thing that gets said
 * twice — see `URGENT_MS`.
 *
 * Three things follow from that, and they are the shape of this file:
 *
 *   it is opt-in     A browser will not let a page announce anything until
 *                    someone has said yes, and the asking has to happen in a
 *                    click (Safari refuses it otherwise) — so the switch is
 *                    in the feed panel and `toggle` is what asks.
 *   it is per browser The preference is in localStorage, like the theme, and
 *                    the permission is the browser's. Neither travels: turning
 *                    this on at your desk says nothing about your laptop, which
 *                    is right — "notify me here" is a fact about here.
 *   it announces news `announce` only speaks about conversations that were not
 *                    in the previous survey. Everything in a feed is unread by
 *                    definition, so a browser that announced what it found on
 *                    arrival would ring once for every conversation you had
 *                    already decided to leave.
 *
 * What it cannot do is reach a browser that is closed: that needs a service
 * worker and a push subscription, which needs a server that holds them and a
 * VAPID key, and none of that exists here. This is the open tab telling you
 * about itself while you look at something else — which is the case the feed
 * was already surveying for (SURVEY_MS in store.tsx, which keeps polling while
 * hidden once this is on, because now there is somebody to tell).
 *
 * Everything above `useDesktopNotify` is pure; the hook is where the browser is.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActivityDto, FeedEntry, WaitingEntry } from "./api";
import { feedTitle, feedWaiting, feedWhere, waitingWhat, waitingWho } from "./feed";
import { timeLeft } from "./digest";
import { href } from "../router";

/** Off, announcing, or asked-for and refused by the browser. */
export type NotifyState = "off" | "on" | "blocked";

const KEY = "fountain-workbench.notify";

/**
 * More than this finishing between two surveys and it says how many instead
 * of stacking them up. A minute's poll can turn up a whole team landing at
 * once, and eight notifications in a corner is not eight times the news — it
 * is a wall somebody swipes away without reading, feed and all.
 */
const MAX_AT_ONCE = 3;

/**
 * How little is left on a blocked agent's five minutes before it is said a
 * second time. Nothing else here repeats — a repeat is the thing that turns a
 * notification into noise — but this one is running out, and the first notice
 * is exactly as missable as the badge it was standing in for. Two minutes is
 * enough left to walk back to the machine and answer it.
 */
const URGENT_MS = 120_000;

export interface Notice {
  /**
   * The browser replaces a notification carrying the same tag rather than
   * adding one. That is what keeps two open tabs — both surveying, both
   * announcing — from saying everything twice.
   */
  tag: string;
  title: string;
  body: string;
  /** Where clicking it goes; null for the summary, which names no one conversation. */
  href: string | null;
}

/** Whether this browser has notifications at all. */
export function notifySupported(): boolean {
  return typeof Notification !== "undefined";
}

export function loadNotify(): boolean {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
}

export function saveNotify(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, "on");
    else localStorage.removeItem(KEY);
  } catch {
    // a browser that blocks storage still gets it for this page
  }
}

/**
 * What the switch is showing. "blocked" is deliberately a state and not a
 * silent return to "off": the browser refused something the user asked for,
 * and a button that quietly flipped back would leave them with no answer to
 * "why is nothing arriving".
 */
export function desktopState(pref: boolean, permission: NotificationPermission): NotifyState {
  if (!pref) return "off";
  if (permission === "granted") return "on";
  if (permission === "denied") return "blocked";
  return "off";
}

/** The switch in the feed panel. */
export function desktopLabel(state: NotifyState): string {
  return state === "on" ? "desktop · on" : state === "blocked" ? "desktop · blocked" : "desktop · off";
}

/** What it says when asked — the title, and the same sentence for a screen reader. */
export function desktopHint(state: NotifyState): string {
  switch (state) {
    case "on":
      return "Finished conversations are announced on this desktop while this browser has the workbench open, tab in front of you or not. Click to stop.";
    case "blocked":
      return "This browser is refusing notifications for the workbench. Allow them in the padlock beside the address bar, then turn this on again. Click to stop asking.";
    case "off":
      return "Announce finished conversations on this desktop, so you find out without the tab in front of you. Your browser will ask first.";
  }
}

/** One conversation's notification: what it is, where it is, and where it goes. */
function noticeOf(e: FeedEntry): Notice {
  return {
    tag: e.conversationId,
    title: `${feedTitle(e)} — ${e.status === "failed" ? "failed" : "finished"}`,
    // The project first, because a notification is read with none of this app
    // on screen: "which project is this" is the fact the reader is missing.
    body: `${e.projectName} · ${feedWhere(e)}`,
    href: href.conversation(e.projectId, e.conversationId),
  };
}

/** What to say about the conversations that turned up in this survey and not the last. */
export function noticesFor(fresh: readonly FeedEntry[]): Notice[] {
  if (fresh.length === 0) return [];
  if (fresh.length <= MAX_AT_ONCE) return fresh.map(noticeOf);
  const projects = [...new Set(fresh.map((e) => e.projectName))];
  const failed = fresh.filter((e) => e.status === "failed").length;
  return [
    {
      // One tag for the summary too, so the next batch replaces this one
      // rather than queueing behind it.
      tag: "feed",
      title: `${fresh.length} conversations finished`,
      body: failed ? `${projects.join(", ")} — ${failed} failed` : projects.join(", "),
      // No one thread to open: the bell is what this sends you to, and it is
      // on every page, so clicking only needs to bring the window forward.
      href: null,
    },
  ];
}

/** A held request is one question on one conversation; two of them are two rows. */
function waitingKey(w: WaitingEntry): string {
  return `${w.conversationId}:${w.requestId}`;
}

/** One blocked agent: who, what they want to run, and how long you have. */
function askingNotice(w: WaitingEntry, now: number): Notice {
  return {
    tag: waitingKey(w),
    title: `${waitingWho(w)} ${waitingWhat(w)}`,
    body: `${w.projectName} · ${w.itemTitle ?? "a work item that is no longer here"} · ${timeLeft(w.expiresAt, now)}`,
    href: href.conversation(w.projectId, w.conversationId),
  };
}

/** What to say about agents blocked since the last survey, or nearly out of time. */
export function askingNotices(fresh: readonly WaitingEntry[], now: number): Notice[] {
  if (fresh.length === 0) return [];
  if (fresh.length <= MAX_AT_ONCE) return fresh.map((w) => askingNotice(w, now));
  // The soonest deadline is the one worth naming a time for.
  const soonest = fresh.reduce((a, b) => (Date.parse(a.expiresAt) <= Date.parse(b.expiresAt) ? a : b));
  return [
    {
      tag: "waiting",
      title: `${fresh.length} agents are blocked waiting on you`,
      body: `${[...new Set(fresh.map((w) => w.projectName))].join(", ")} · ${timeLeft(soonest.expiresAt, now)} on the first`,
      href: null,
    },
  ];
}

/**
 * What the last survey had been told about, so this one can work out what is
 * new. Two halves because the two are measured differently: a finish is a
 * conversation that was or was not there, a blocked agent is a question that
 * is also getting closer to being answered for you.
 */
export interface Mark {
  /** Conversations that were in the previous survey's feed. */
  finished: ReadonlySet<string>;
  /** Blocked requests already announced, and whether that was the second, final time. */
  asking: ReadonlyMap<string, "asked" | "urgent">;
}

export const NOTHING_MARKED: Mark = { finished: new Set(), asking: new Map() };

/**
 * What a survey should announce, and the mark to carry into the next one.
 *
 * `mark: null` means there is no previous survey to be news against — the
 * first one after notifications come on. It announces nothing and takes the
 * survey as its baseline; see the header for why arriving is not news.
 *
 * The mark is the survey as it now stands rather than everything ever seen, so
 * it cannot grow without bound, and so a conversation that was read and then
 * woke up again is news a second time — which it is: somebody answered it and
 * the agent has come back. A blocked agent leads whatever else is in there,
 * for the reason in the header.
 */
export function announce(activity: ActivityDto, mark: Mark | null, now: number = Date.now()): { notices: Notice[]; mark: Mark } {
  // Expired requests are dropped here as they are in the panel: Fountain has
  // already answered that one with a refusal, and announcing it would send
  // somebody to a question nobody can answer any more.
  const waiting = feedWaiting(activity, now);
  const asking = new Map<string, "asked" | "urgent">();
  const fresh: WaitingEntry[] = [];
  for (const w of waiting) {
    const was = mark?.asking.get(waitingKey(w));
    const urgent = Date.parse(w.expiresAt) - now <= URGENT_MS;
    // Said once when it turns up, and once more when it is nearly out — but a
    // request that was already inside its last two minutes when it arrived has
    // had its one notice, and there is no time left for another.
    if (!was || (urgent && was === "asked")) fresh.push(w);
    asking.set(waitingKey(w), urgent ? "urgent" : (was ?? "asked"));
  }

  const finished = new Set(activity.feed.map((e) => e.conversationId));
  if (!mark) return { notices: [], mark: { finished, asking } };
  return {
    notices: [...askingNotices(fresh, now), ...noticesFor(activity.feed.filter((e) => !mark.finished.has(e.conversationId)))],
    mark: { finished, asking },
  };
}

/** Put one on the desktop. Does nothing anywhere it is not allowed to. */
export function show(n: Notice): void {
  if (!notifySupported() || Notification.permission !== "granted") return;
  try {
    const note = new Notification(n.title, { body: n.body, tag: n.tag });
    note.onclick = () => {
      // Bring the tab forward first: setting the hash on a window nobody can
      // see is a navigation that happens where it cannot be read.
      window.focus();
      if (n.href) window.location.hash = n.href;
      note.close();
    };
  } catch {
    // Chrome on Android only allows these through a service worker, which
    // this app does not have. The bell is still the bell.
  }
}

export interface DesktopNotify {
  /** What the switch shows, or null where the browser has no notifications to offer. */
  state: NotifyState | null;
  /** Turn it on — asking the browser the first time — or off. Must be called from a click. */
  toggle: () => void;
}

/**
 * Announce what each survey turns up that the last one did not, once the user
 * has asked for it. Lives in the workbench store, which is where `activity` is
 * and the only place that sees every project.
 */
export function useDesktopNotify(activity: ActivityDto): DesktopNotify {
  const supported = notifySupported();
  const [pref, setPref] = useState(loadNotify);
  const [permission, setPermission] = useState<NotificationPermission>(() => (notifySupported() ? Notification.permission : "default"));
  const state = supported ? desktopState(pref, permission) : null;

  // Permission is changed in browser chrome we get no event for, so re-read it
  // on the way back to the tab: "blocked" should clear itself once they have
  // gone and allowed it, without a reload.
  useEffect(() => {
    if (!supported) return;
    const on = () => setPermission(Notification.permission);
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, [supported]);

  const toggle = useCallback(() => {
    if (!notifySupported()) return;
    if (pref) {
      setPref(false);
      saveNotify(false);
      return;
    }
    if (Notification.permission === "granted") {
      setPermission("granted");
      setPref(true);
      saveNotify(true);
      return;
    }
    // In the click, because that is the only place some browsers will ask.
    try {
      void Notification.requestPermission().then((p) => {
        setPermission(p);
        // On even when the browser said no: that is what makes the switch read
        // "blocked" rather than snapping back and explaining nothing.
        setPref(true);
        saveNotify(true);
      });
    } catch {
      // A browser with the callback-only form, which is old enough that not
      // asking is the whole of the handling.
    }
  }, [pref]);

  const mark = useRef<Mark | null>(null);
  useEffect(() => {
    // Not announcing: drop the mark, so switching back on takes the survey as
    // it stands then rather than reciting everything that piled up while it
    // was off.
    if (state !== "on") {
      mark.current = null;
      return;
    }
    const result = announce(activity, mark.current);
    mark.current = result.mark;
    for (const n of result.notices) show(n);
  }, [activity, state]);

  return useMemo(() => ({ state, toggle }), [state, toggle]);
}
