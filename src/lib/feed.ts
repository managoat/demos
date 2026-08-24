/**
 * The feed: what finished in your other projects while you were in this one,
 * and who is blocked waiting on you in them.
 *
 * The digest (`src/lib/digest.ts`) answers the same question one work item at
 * a time, folded out of the stage stream the page already holds. This is the
 * question one level up, and it cannot be answered that way: the stream is a
 * project's (`/f/<project>/api/events/stream`, filtered per project by
 * server/proxy.ts) and a browser holds exactly the one it is looking at. A
 * conversation finishing in another project has no wire into this tab at all
 * — which is why it was invisible, and why the server surveys instead
 * (`activity` in server/projects.ts).
 *
 * So the two are deliberately different measurements:
 *
 *   digest   counted from the mark this browser last opened the item at,
 *            kept in localStorage, per item
 *   feed     `unread` on the conversation, which is Fountain's own — it means
 *            `last_active_at` is later than `last_read_at`, and opening a
 *            thread moves it (`markRead` in components/Thread.tsx)
 *
 * The feed's mark is the better one where it applies, and it is not a matter
 * of taste: a notification that a *browser* has seen is not a notification you
 * have answered, and a per-browser mark would show you the same finished
 * conversation again on your laptop. Read state is on the conversation, shared
 * by everyone in the project the way every other thing in a project is, and it
 * clears by opening the thread — which is the act the feed exists to prompt.
 *
 * The third measurement, added later, is not a mark at all:
 *
 *   waiting  a permission request an agent is *still* held on, folded off the
 *            owner's stage stream by server/watch.ts — current state, not
 *            history, and on a five-minute clock rather than waiting for you
 *
 * It is not read state and nothing clears it by being looked at: a request
 * goes away when it is answered, or when Fountain denies it for you. Which is
 * why it is shown above the rest and counted separately — "3 finished" can
 * wait until tomorrow and "an agent is blocked, 2m left" cannot.
 *
 * Everything here is pure; the panel is components/Feed.tsx.
 */
import type { ActivityDto, FeedEntry, WaitingEntry } from "./api";

/** Nothing surveyed yet. */
export const NO_ACTIVITY: ActivityDto = { projects: {}, feed: [], dropped: 0, waiting: [] };

/**
 * Requests still worth answering. The server drops them on the same deadline,
 * but a survey is up to a minute old by the time it is read and a countdown
 * that reaches zero must take its row with it — Fountain has already answered
 * that one with a refusal, and a row that says otherwise is asking you to
 * click on nothing.
 */
export function feedWaiting(a: ActivityDto, now: number = Date.now()): WaitingEntry[] {
  return a.waiting.filter((w) => Date.parse(w.expiresAt) > now);
}

/**
 * The number on the bell: everything waiting, including what the server
 * capped off the list. A badge that counted only the rows shown would go
 * quiet while there was more, which is the failure this whole thing is for.
 */
export function feedCount(a: ActivityDto, now: number = Date.now()): number {
  return feedWaiting(a, now).length + a.feed.length + a.dropped;
}

/** What to call a conversation that has not been given a title yet. */
export function feedTitle(e: FeedEntry): string {
  return e.title || "Untitled conversation";
}

/** Where it is: the work item, or the item's id when the item is gone from here. */
export function feedWhere(e: FeedEntry): string {
  return e.itemTitle || "a work item that is no longer here";
}

export interface FeedGroup {
  projectId: string;
  projectName: string;
  /** Newest first, as they came. */
  entries: FeedEntry[];
}

/**
 * The feed by project, because "which project is this in" is the fact the
 * reader is missing — they are looking at another one. Projects rank by their
 * newest entry, entries keep the server's order, and a project the caller is
 * currently in sinks to the bottom: what is in front of you is the one thing
 * you did not need telling about.
 */
export function feedGroups(entries: readonly FeedEntry[], hereProjectId?: string | null): FeedGroup[] {
  const byProject = new Map<string, FeedGroup>();
  for (const e of entries) {
    const g = byProject.get(e.projectId);
    if (g) g.entries.push(e);
    else byProject.set(e.projectId, { projectId: e.projectId, projectName: e.projectName, entries: [e] });
  }
  return [...byProject.values()].sort((a, b) => {
    const ha = a.projectId === hereProjectId ? 1 : 0;
    const hb = b.projectId === hereProjectId ? 1 : 0;
    if (ha !== hb) return ha - hb;
    return (b.entries[0]?.at ?? "").localeCompare(a.entries[0]?.at ?? "") || a.projectId.localeCompare(b.projectId);
  });
}

/**
 * The bell's tooltip — the count in words, so the button says what it means
 * without being opened, and a screen reader gets the same sentence.
 *
 * A blocked agent leads, whatever else is in there. It is the only part of
 * this that expires, and the sentence is what somebody reads instead of
 * opening the panel.
 */
export function feedSummary(a: ActivityDto, now: number = Date.now()): string {
  const blocked = feedWaiting(a, now).length;
  const rest = a.feed.length + a.dropped;
  if (blocked === 0 && rest === 0) return "Nothing waiting: every conversation in your projects has been read.";
  const parts: string[] = [];
  if (blocked) parts.push(`${blocked} agent${blocked === 1 ? " is" : "s are"} blocked waiting on you`);
  if (rest) {
    const failed = a.feed.filter((e) => e.status === "failed").length;
    parts.push(`${rest} conversation${rest === 1 ? "" : "s"} finished and unread${failed ? ` — ${failed} failed` : ""}`);
  }
  return parts.join(" · ");
}

/**
 * What to call whoever is asking. The conversation's own title, not the
 * agent's name: the top bar is outside every project, so it holds no team for
 * the project this is in and cannot look one up without a request per row.
 */
export function waitingWho(w: WaitingEntry): string {
  return w.title || "An agent";
}

/** "wants to run Bash" — what it is asking for, in the runtime's words. */
export function waitingWhat(w: WaitingEntry): string {
  return `wants to run ${w.tool ?? "a tool"}`;
}

/**
 * Drop one conversation from a survey, for when this browser has just read it.
 *
 * The poll is a minute wide (store.tsx), and waiting a minute to watch a row
 * you have just opened disappear reads as a bug. Opening a thread calls
 * Fountain's `read`, so the next survey agrees; this is the same fact applied
 * early, not a second source of truth.
 */
export function feedRead(a: ActivityDto, conversationId: string): ActivityDto {
  const feed = a.feed.filter((e) => e.conversationId !== conversationId);
  return feed.length === a.feed.length ? a : { ...a, feed };
}
