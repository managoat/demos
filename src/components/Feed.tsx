/**
 * The feed in the top bar: what finished in your projects that nobody has
 * read, grouped by project, newest first.
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
import { feedCount, feedGroups, feedSummary, feedTitle, feedWhere } from "../lib/feed";
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
  return (
    <div className="feed-menu" role="dialog" aria-label="Finished and unread">
      <div className="feed-head">
        <span className="strong">{feedSummary(activity)}</span>
      </div>
      {groups.length === 0 ? (
        <p className="feed-empty muted">
          When a teammate finishes in any of your projects it lands here, so you find out without going and looking. Opening the thread is what clears it.
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

  const count = feedCount(activity);
  const summary = feedSummary(activity);

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
        className={`icon feed-bell ${count > 0 ? "on" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
        title={summary}
        aria-label={summary}
      >
        <span aria-hidden="true">🔔</span>
        {count > 0 && (
          <span className="feed-badge" aria-hidden="true">
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>
      {open && <FeedList activity={activity} here={here} onPick={() => setOpen(false)} />}
    </div>
  );
}
