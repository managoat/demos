/**
 * One conversation: its transcript so far (SDK history), live events from the
 * store's stream, and a composer. Chat layout: your prompts on the right, the
 * agent's blocks on the left.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useProject } from "../store";
import type { Stream } from "@agentshit/fountain-sdk";
import type { Conversation, LogEvent, Turn, UserEvent } from "../types";
import { arrange } from "../lib/blocks";
import { fold, stageLine } from "../lib/turns";
import { formatTime } from "../lib/format";
import { describeError } from "../lib/errors";
import { BlockView } from "./Blocks";
import { StatusPill } from "./StatusPill";
import { AgentAvatar } from "./AgentAvatar";

const HISTORY_STREAMS: Stream[] = ["acp", "stdout", "stage"];

export function Thread({ conversationId, onClose }: { conversationId: string; onClose?: () => void }) {
  const { fountain, conversations, agents, subscribe, toast, refresh } = useProject();
  const listed = conversations.find((c) => c.id === conversationId) ?? null;
  const [fetched, setFetched] = useState<Conversation | null>(null);
  // The list has the live status; the show has the sandbox (the list never embeds it).
  const conversation = listed ? { ...listed, sandbox: listed.sandbox ?? fetched?.sandbox ?? null } : fetched;
  const [turns, setTurns] = useState<Turn[]>([]);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [showStdout, setShowStdout] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const agent = conversation?.agent_id ? agents.get(conversation.agent_id) ?? null : null;
  const who = agent?.name ?? conversation?.runtime ?? "agent";

  // Load: the record if the list has not got it, the turns, and the history.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setTurns([]);
    setEvents([]);
    const handle = fountain.resume(conversationId);
    void (async () => {
      try {
        const [record, ts, history] = await Promise.all([
          handle.get(),
          handle.turns(),
          handle.history({ streams: HISTORY_STREAMS }),
        ]);
        if (cancelled) return;
        if (record) setFetched(record);
        setTurns(ts);
        // Live events may have landed while the history was in flight; keep them.
        setEvents((prev) => mergeById(history, prev));
        void handle.markRead().then(() => refresh());
      } catch (err) {
        if (!cancelled) toast(describeError(err), "error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, fountain, toast, refresh]);

  // Live: append what the user-wide stream delivers for this conversation.
  useEffect(() => {
    const seen = new Set<number>();
    return subscribe(conversationId, (ev: UserEvent) => {
      if (seen.has(ev.id)) return;
      seen.add(ev.id);
      setEvents((prev) => (prev.some((e) => e.id === ev.id) ? prev : [...prev, ev]));
      if (ev.kind === "stage" && ev.stage === "turn") {
        // A turn began or ended: re-read the turn list so the prompt and status show.
        void fountain.resume(conversationId).turns().then(setTurns).catch(() => undefined);
      }
    });
  }, [conversationId, subscribe, fountain]);

  // The conversation changed under us (a status flip, a turn sent from
  // elsewhere): re-read the turns, and the feed from where we have read to.
  // The user-wide stream only follows unfinished conversations, so one that
  // fails or finishes quickly can leave a gap the stream never fills.
  useEffect(() => {
    if (!conversation || loading) return;
    const handle = fountain.resume(conversationId);
    if ((conversation.turn_count ?? 0) > turns.length) {
      void handle.turns().then(setTurns).catch(() => undefined);
    }
    const after = events.reduce((m, e) => Math.max(m, e.id), 0);
    void handle
      .history({ streams: HISTORY_STREAMS, after })
      .then((more) => {
        if (more.length) setEvents((prev) => mergeById(prev, more));
      })
      .catch(() => undefined);
  }, [conversation?.turn_count, conversation?.status, conversation?.sandbox?.status, loading]); // eslint-disable-line react-hooks/exhaustive-deps

  const folded = useMemo(() => fold(events, turns), [events, turns]);
  const visible = useMemo(() => new Set(showStdout ? ["acp", "stdout"] : ["acp"]), [showStdout]);

  // Follow the bottom unless the reader scrolled up.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [events, turns, loading]);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }, []);

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const prompt = draft.trim();
    if (!prompt || sending) return;
    setSending(true);
    try {
      await fountain.request("POST", `/api/conversations/${conversationId}/prompts`, { body: { prompt } });
      setDraft("");
      stickToBottom.current = true;
      void refresh();
    } catch (err) {
      toast(describeError(err), "error");
    } finally {
      setSending(false);
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  const running = conversation?.status === "running" || conversation?.status === "pending";
  const lastTurn = folded.turns[folded.turns.length - 1];
  const waiting = running && (!lastTurn || lastTurn.turn.status === "running" || lastTurn.turn.status === "pending");

  return (
    <section className="thread">
      <header className="thread-head">
        {onClose && (
          <button className="icon" onClick={onClose} title="Close">
            ×
          </button>
        )}
        {agent && <AgentAvatar agent={agent} size={28} />}
        <div className="thread-title">
          <div className="name">{conversation?.title ?? who}</div>
          <div className="sub muted small">
            {who}
            {conversation?.sandbox ? ` · ${conversation.sandbox.sprite_name} (${conversation.sandbox.status})` : ""}
          </div>
        </div>
        {conversation && <StatusPill status={conversation.status} sandbox={conversation.sandbox?.status} />}
        <label className="check small">
          <input type="checkbox" checked={showStdout} onChange={(e) => setShowStdout(e.target.checked)} /> stdout
        </label>
        {running && (
          <button
            className="secondary small"
            onClick={() => fountain.resume(conversationId).interrupt().then(() => toast("Interrupted")).catch((err) => toast(describeError(err), "error"))}
          >
            Interrupt
          </button>
        )}
        {conversation && conversation.status !== "terminated" && (
          <TwoStep label="Retire" onConfirm={() => fountain.resume(conversationId).terminate().then(() => refresh()).catch((err) => toast(describeError(err), "error"))} />
        )}
      </header>

      <div className="transcript chat" ref={scroller} onScroll={onScroll}>
        {loading && <div className="muted small">Loading…</div>}
        {folded.setup.length > 0 && <SetupLine events={folded.setup} done={folded.turns.length > 0} />}
        {folded.turns.map(({ turn, events: evs }) => (
          <div className="turn" key={turn.id}>
            <div className="bubble you">
              <div className="body">{turn.prompt}</div>
              <div className="meta">
                #{turn.turn_number} · {formatTime(turn.started_at ?? turn.inserted_at)}
                {turn.status === "failed" ? " · failed" : turn.status === "interrupted" ? " · interrupted" : ""}
              </div>
            </div>
            {arrange(evs, visible).map((b, i) => (
              <BlockView key={`${turn.id}-${i}`} block={b} bubble />
            ))}
          </div>
        ))}
        {folded.loose.length > 0 && <div className="muted small">{stageLine(folded.loose)}</div>}
        {waiting && (
          <div className="bubble them typing" aria-label="working">
            <span />
            <span />
            <span />
          </div>
        )}
      </div>

      <form className="composer" onSubmit={send}>
        <div className="composer-main">
          <textarea
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            placeholder={conversation?.status === "terminated" ? "This conversation is retired." : `Message ${who}… (Enter to send, Shift+Enter for a newline)`}
            disabled={conversation?.status === "terminated"}
          />
        </div>
        <button className="send" type="submit" disabled={sending || !draft.trim() || conversation?.status === "terminated"} title="Send">
          ↑
        </button>
      </form>
    </section>
  );
}

/** `base` first, then whatever in `extra` it does not already hold, in id order. */
function mergeById(base: LogEvent[], extra: LogEvent[]): LogEvent[] {
  if (extra.length === 0) return base;
  const seen = new Set(base.map((e) => e.id));
  const out = [...base];
  for (const e of extra) if (!seen.has(e.id)) out.push(e);
  return out.sort((a, b) => a.id - b.id);
}

function SetupLine({ events, done }: { events: LogEvent[]; done: boolean }) {
  const line = stageLine(events);
  const failure = [...events].reverse().find((e) => e.kind === "stage" && e.state === "failed");
  const reason = failure ? failReason(failure) : null;
  return (
    <details className={`block init ${failure ? "error" : ""}`}>
      <summary>{failure ? `✕ setup failed${reason ? ` — ${reason}` : ""}` : done ? "✓ sandbox ready" : `⏳ ${line ?? "setting up"}`}</summary>
      <pre>
        {events
          .filter((e) => e.kind === "stage")
          .map((e) => `${formatTime(e.ts)}  ${e.stage ?? ""} ${e.state ?? ""}${e.duration_ms != null ? ` (${e.duration_ms} ms)` : ""}`)
          .join("\n")}
      </pre>
    </details>
  );
}

function failReason(ev: LogEvent): string | null {
  if (!ev.data) return null;
  try {
    const r = (JSON.parse(ev.data) as { reason?: unknown }).reason;
    return typeof r === "string" ? r : null;
  } catch {
    return null;
  }
}

/** A destructive button that asks once, inline — never a browser dialog. */
export function TwoStep({ label, onConfirm, className = "danger small" }: { label: string; onConfirm: () => void; className?: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return armed ? (
    <button
      className={className}
      onClick={() => {
        setArmed(false);
        onConfirm();
      }}
    >
      Sure? {label}
    </button>
  ) : (
    <button className={className.replace("danger", "secondary")} onClick={() => setArmed(true)}>
      {label}
    </button>
  );
}
