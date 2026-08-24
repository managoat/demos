/**
 * The feed in the top bar: who is blocked waiting on you, and what finished in
 * your projects that nobody has read — grouped by project, newest first.
 *
 * The blocked half is first and stays first. A finished conversation waits
 * indefinitely; a held permission request is denied by Fountain five minutes
 * after it was raised, so the row carries a countdown and sorts oldest first —
 * the one about to run out is the one to answer.
 *
 * It is a link, not a pair of buttons, and that is deliberate: the same
 * argument the item digest already had and lost. Answering "Bash — rm -rf
 * build/" from a summary row, in a project you are not even in, off a title
 * and a tool name, is a worse decision than answering it in the thread with
 * the transcript above it — and a countdown makes that pressure worse, not
 * better. This says who is waiting and takes you there; the card in the thread
 * (`PermissionCard` in Blocks.tsx) is where you say yes.
 *
 * It is in the top bar rather than on a page because the whole complaint it
 * answers is that you were *somewhere else*: a screen you have to navigate to
 * in order to find out you should navigate somewhere is not a notification.
 * The bell is on every page, in and out of a project, and carries the count
 * whether or not it is open.
 *
 * A row is an ordinary link to the conversation, and opening the thread is
 * what clears the row: it marks the conversation read on Fountain (`markRead`
 * in Thread.tsx), which is the same fact the server surveys. Nothing here
 * dismisses without reading — a "clear all" would let the one screen that
 * says an agent finished be silenced without anyone going and looking, which
 * is how you end up back where this started. See src/lib/feed.ts for why read
 * state and not a per-browser mark.
 *
 * `FeedList` is the render and takes everything it shows, so it can be tested
 * without a DOM; `Feed` is the button, the store and the open/closed state.
 */
import { useEffect, useRef, useState } from "react";
import { useWorkbench } from "../store";
import { href, useRoute } from "../router";
import { feedCount, feedGroups, feedSummary, feedTitle, feedWaiting, feedWhere, waitingWhat, waitingWho } from "../lib/feed";
import { timeLeft } from "../lib/digest";
import { relativeTime } from "../lib/sidebar";
import type { ActivityDto } from "../lib/api";

export function FeedList({
  activity,
  here,
  now = Date.now(),
  onPick,
}: {
  activity: ActivityDto;
  /** The project being looked at, whose rows sink to the bottom. */
  here: string | null;
  now?: number;
  onPick?: () => void;
}) {
  const groups = feedGroups(activity.feed, here);
  const waiting = feedWaiting(activity, now);
  return (
    <div className="feed-menu" role="dialog" aria-label="Waiting on you, and finished and unread">
      <div className="feed-head">
        <span className="strong">{feedSummary(activity, now)}</span>
      </div>
      {waiting.length > 0 && (
        <div className="feed-group waiting">
          <div className="feed-group-label">Waiting on you</div>
          {waiting.map((w) => (
            <a key={`${w.conversationId}:${w.requestId}`} className="feed-row asking" href={href.conversation(w.projectId, w.conversationId)} onClick={onPick}>
              <span className="feed-dot" aria-hidden="true" />
              <span className="feed-row-main">
                <span className="feed-row-title">
                  {waitingWho(w)} <span className="muted">{waitingWhat(w)}</span>
                </span>
                <span className="feed-row-sub muted">
                  {w.projectName}
                  {w.projectId === here ? " · here" : ""} · {w.itemTitle ?? "a work item that is no longer here"}
                </span>
              </span>
              <span className="pill pending tiny">{timeLeft(w.expiresAt, now)}</span>
            </a>
          ))}
        </div>
      )}
      {groups.length === 0 && waiting.length === 0 ? (
        <p className="feed-empty muted">
          When a teammate finishes in any of your projects, or gets blocked waiting on you in one, it lands here — so you find out without going and looking. Opening
          the thread is what clears it; a blocked one goes when you answer it.
        </p>
      ) : (
        groups.map((g) => (
          <div className="feed-group" key={g.projectId}>
            <div className="feed-group-label">
              {g.projectName}
              {g.projectId === here ? " · here" : ""}
            </div>
            {g.entries.map((e) => (
              <a
                key={e.conversationId}
                className={`feed-row ${e.status === "failed" ? "failed" : ""}`}
                href={href.conversation(e.projectId, e.conversationId)}
                onClick={onPick}
              >
                <span className="feed-dot" aria-hidden="true" />
                <span className="feed-row-main">
                  <span className="feed-row-title">{feedTitle(e)}</span>
                  <span className="feed-row-sub muted">
                    {e.status === "failed" ? "failed · " : ""}
                    {feedWhere(e)}
                  </span>
                </span>
                <span className="feed-row-time muted">{relativeTime(e.at, now)}</span>
              </a>
            ))}
          </div>
        ))
      )}
      {activity.dropped > 0 && (
        <p className="feed-foot muted small">{activity.dropped} more not shown. Read some of these and they will come up.</p>
      )}
    </div>
  );
}

export function Feed() {
  const { activity, refreshActivity } = useWorkbench();
  const route = useRoute();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const here = "projectId" in route ? route.projectId : null;

  // A countdown has to move, and a request that has run out has to stop being
  // offered — both of which are this clock rather than another survey. It only
  // runs while there is a countdown on screen, or one behind the bell.
  const [now, setNow] = useState(() => Date.now());
  const ticking = open || activity.waiting.length > 0;
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);

  const count = feedCount(activity, now);
  const summary = feedSummary(activity, now);
  const blocked = feedWaiting(activity, now).length > 0;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Opening it is someone asking the question, so ask the server rather than
  // answering out of a survey that may be most of a minute old (SURVEY_MS).
  const toggle = () => {
    setOpen((v) => {
      if (!v) void refreshActivity();
      return !v;
    });
  };

  return (
    <div className="feed" ref={box}>
      <button
        type="button"
        className={`icon feed-bell ${count > 0 ? "on" : ""} ${blocked ? "blocked" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
        title={summary}
        aria-label={summary}
      >
        <span aria-hidden="true">🔔</span>
        {count > 0 && (
          <span className={`feed-badge ${blocked ? "blocked" : ""}`} aria-hidden="true">
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>
      {open && <FeedList activity={activity} here={here} now={now} onPick={() => setOpen(false)} />}
    </div>
  );
}
