import { useEffect, useMemo, useRef, useState } from "react";
import type { LogEvent, Teammate, Turn } from "../api/types";
import { blocksForTurn } from "../lib/acp";
import { duration, groupBlocks, relativeTime, toolsLabel, type FeedItem, type ToolBlock } from "../lib/feed";
import { isNearBottom } from "../lib/scroll";
import { describeResolution, resolutions as resolutionsFrom, type PermissionResolution } from "../lib/permissions";
import { Markdown } from "./Markdown";

/**
 * The activity feed (after Buzz's agent activity panel): what the teammate
 * is doing, as it narrates it — prose between folded "Ran N tool calls"
 * rows, each expandable to the calls with their duration and output. Built
 * from the same ACP events the bubbles use; live because the events are.
 */
export interface ActivityFocus {
  turnId: string;
  /** index into the turn's grouped feed items */
  index: number;
  /** changes on every click so the same row can be re-focused */
  nonce: number;
}

export function Activity({
  teammate,
  turns,
  events,
  focus,
  onClose,
}: {
  teammate: Teammate;
  turns: Turn[];
  events: LogEvent[];
  focus: ActivityFocus | null;
  onClose: () => void;
}) {
  const conv = teammate.conversation;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const [, tick] = useState(0);

  // "Last updated just now" needs a clock
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const byTurn = useMemo(() => {
    const m = new Map<string, LogEvent[]>();
    for (const ev of events) {
      if (!ev.turn_id) continue;
      const arr = m.get(ev.turn_id);
      if (arr) arr.push(ev);
      else m.set(ev.turn_id, [ev]);
    }
    return m;
  }, [events]);

  // The `request` stage events carry no turn_id, so they are read from the
  // whole conversation and paired to the block on request_id.
  const askResolutions = useMemo(() => resolutionsFrom(events), [events]);

  const feed = useMemo(
    () =>
      turns.map((turn) => ({
        turn,
        items: groupBlocks(blocksForTurn(byTurn.get(turn.id) ?? [], conv.runtime)),
      })),
    [turns, byTurn, conv.runtime],
  );

  const lastTs = events.length ? events[events.length - 1]!.ts : conv.last_active_at;
  const toolCount = feed.reduce((n, f) => n + f.items.reduce((m, i) => m + (i.kind === "tools" ? i.tools.length : 0), 0), 0);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && following) el.scrollTop = el.scrollHeight;
  }, [events.length, turns.length, following]);

  useEffect(() => {
    setFollowing(true);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conv.id]);

  // A click on a tool line in the chat: open that run here and bring it into view.
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    if (!focus) return;
    const key = `${focus.turnId}:${focus.index}`;
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-feed="${key}"]`);
    if (!el) return;
    setFollowing(false);
    const details = el.matches("details") ? (el as HTMLDetailsElement) : el.querySelector("details");
    if (details) details.open = true;
    el.scrollIntoView({ block: "center" });
    setFlash(key);
    window.setTimeout(() => setFlash((f) => (f === key ? null : f)), 2000);
  }, [focus, feed.length]);

  return (
    <aside className="activity" aria-label="Activity">
      <header className="activity-head">
        <div>
          <div className="name">Activity</div>
          <div className="sub muted small">
            {turns.length} turn{turns.length === 1 ? "" : "s"} · {toolCount} tool call{toolCount === 1 ? "" : "s"} · last updated {relativeTime(lastTs) || "—"}
          </div>
        </div>
        <button className="icon" onClick={onClose} aria-label="Close activity" title="Close">
          ×
        </button>
      </header>
      <div
        className="activity-body"
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (el) setFollowing(isNearBottom(el));
        }}
      >
        {feed.length === 0 && <div className="muted small">Nothing yet — the feed fills in as {teammate.name} works.</div>}
        {feed.map(({ turn, items }) => (
          <section className="activity-turn" key={turn.id}>
            <div className="activity-prompt muted small" title={turn.prompt}>
              <span className="you">You</span> · {turn.prompt.length > 140 ? `${turn.prompt.slice(0, 140)}…` : turn.prompt || (turn.image_count ? `${turn.image_count} image(s)` : "")}
            </div>
            {items.map((item, i) => (
              <div key={i} data-feed={`${turn.id}:${i}`} className={flash === `${turn.id}:${i}` ? "feed-flash" : ""}>
                <FeedItemView item={item} resolution={item.kind === "permission" ? (askResolutions.get(item.request.requestId) ?? null) : null} />
              </div>
            ))}
            {(turn.status === "pending" || turn.status === "running") && items.length === 0 && <div className="muted small">working…</div>}
            {(turn.status === "failed" || turn.status === "cancelled") && <div className="muted small">turn {turn.status}</div>}
          </section>
        ))}
      </div>
    </aside>
  );
}

export function FeedItemView({ item, resolution = null }: { item: FeedItem; resolution?: PermissionResolution | null }) {
  switch (item.kind) {
    case "text":
      return (
        <div className="activity-text">
          <Markdown text={item.body} />
        </div>
      );
    case "thinking":
      return (
        <details className="activity-tools thinking">
          <summary>
            <span className="verb">Thought</span> <span className="what">for a moment</span>
          </summary>
          <div className="activity-thought">{item.body}</div>
        </details>
      );
    case "tools":
      return <ToolsRow tools={item.tools} />;
    // Read-only here on purpose: the answerable card lives in the thread, and
    // two live copies of one blocked request would race each other.
    case "permission": {
      const req = item.request;
      return (
        <div className={`activity-ask ${resolution ? "resolved" : "open"}`}>
          <span className="ask-glyph" aria-hidden>
            🔐
          </span>
          <span className="tool-name">{req.name}</span>
          {req.summary && <span className="tool-summary">{req.summary}</span>}
          <span className="muted small">{resolution ? describeResolution(resolution, req.options) : "asked — answer in the thread"}</span>
        </div>
      );
    }
    case "raw":
      return <pre className="raw">{item.body}</pre>;
  }
}

/** "Ran 5 tool calls ▾" — open to the calls with status, duration and output. */
export function ToolsRow({ tools }: { tools: ToolBlock[] }) {
  const { verb, what, running } = toolsLabel(tools);
  const single = tools.length === 1 ? tools[0]! : null;
  const dur = single ? duration(single.startedAt, single.endedAt) : null;
  return (
    <details className={`activity-tools ${running ? "running" : ""}`}>
      <summary>
        <span className="verb">{verb}</span> <span className="what">{what}</span>
        {dur && <span className="dur muted">{dur}</span>}
        {running && <span className="dots" aria-hidden />}
      </summary>
      <ul className="activity-calls">
        {tools.map((t, i) => (
          <li key={t.id ?? i} className={`call ${t.status}`}>
            <div className="call-head">
              <span className="tool-status">{t.status === "running" ? "…" : t.status === "done" ? "✓" : "✕"}</span>
              <span className="tool-name">{t.name}</span>
              {t.summary && <span className="tool-summary">{t.summary}</span>}
              {duration(t.startedAt, t.endedAt) && <span className="dur muted">{duration(t.startedAt, t.endedAt)}</span>}
            </div>
            {t.output ? <pre>{t.output}</pre> : <div className="muted small call-empty">{t.status === "running" ? "running…" : "no output"}</div>}
          </li>
        ))}
      </ul>
    </details>
  );
}
