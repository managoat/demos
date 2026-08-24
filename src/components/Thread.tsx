/**
 * One conversation: its transcript so far (SDK history), live events from the
 * store's stream, and a composer. Chat layout: your prompts on the right, the
 * agent's blocks on the left.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
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
import { AttachButton, AttachmentStrip, useAttachments } from "./Attachments";
import { turnImageUrl } from "../lib/api";

const HISTORY_STREAMS: Stream[] = ["acp", "stdout", "stage"];

export function Thread({ conversationId, onClose, context, focusTurnId }: { conversationId: string; onClose?: () => void; context?: ReactNode; focusTurnId?: string | null }) {
  const { project, fountain, conversations, agents, sandboxes, subscribe, toast, refresh } = useProject();
  const listed = conversations.find((c) => c.id === conversationId) ?? null;
  const [fetched, setFetched] = useState<Conversation | null>(null);
  // The list has the live status; the show has the sandbox (the list never embeds it).
  const conversation = listed ? { ...listed, sandbox: listed.sandbox ?? fetched?.sandbox ?? null } : fetched;
  const sandbox = conversation?.sandbox ?? (conversation?.sandbox_id ? sandboxes.get(conversation.sandbox_id) ?? null : null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [showStdout, setShowStdout] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const attachments = useAttachments(useCallback((message: string) => toast(message, "error"), [toast]));
  const scroller = useRef<HTMLDivElement>(null);
  // Arriving on a turn (a search hit) means reading there, not at the bottom.
  const stickToBottom = useRef(!focusTurnId);
  const landed = useRef<string | null>(null);

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

  // A search hit names a turn: scroll to it once it is on screen — once, so
  // that output arriving afterwards does not keep yanking the view back.
  useEffect(() => {
    if (!focusTurnId || landed.current === focusTurnId) return;
    const el = scroller.current?.querySelector<HTMLElement>(`[data-turn="${CSS.escape(focusTurnId)}"]`);
    if (!el) return;
    landed.current = focusTurnId;
    el.scrollIntoView({ block: "center" });
  }, [focusTurnId, turns, events]);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }, []);

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const prompt = draft.trim();
    const images = attachments.payload;
    // A screenshot on its own is a prompt: "here is what it looks like".
    if ((!prompt && !images) || sending) return;
    setSending(true);
    try {
      await fountain.request("POST", `/api/conversations/${conversationId}/prompts`, { body: images ? { prompt, images } : { prompt } });
      setDraft("");
      attachments.clear();
      stickToBottom.current = true;
      void refresh();
    } catch (err) {
      toast(describeError(err), "error");
    } finally {
      setSending(false);
    }
  }

  // Answering an `ask` permission the agent is held on. The card owns what to
  // say about a refusal or a lost race (a 409 — the first answer wins), and
  // the resolution arrives on the stream as `request · done` for every client
  // watching, this one included, so nothing here has to re-read anything.
  const answer = useCallback(
    async (requestId: string, optionId: string) => {
      await fountain.request("POST", `/api/conversations/${conversationId}/requests/${encodeURIComponent(requestId)}`, { body: { option_id: optionId } });
    },
    [fountain, conversationId],
  );

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  const running = conversation?.status === "running" || conversation?.status === "pending";
  const lastTurn = folded.turns[folded.turns.length - 1];
  const waiting = running && (!lastTurn || lastTurn.turn.status === "running" || lastTurn.turn.status === "pending");

  const retired = conversation?.status === "terminated";

  return (
    <section className={`thread${attachments.dragging && !retired ? " dropping" : ""}`} {...(retired ? {} : attachments.dropzone)}>
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
            {context ? <>{context} · </> : null}
            {who}
            {sandbox ? ` · 🖥 ${sandbox.sprite_name.replace(/^fountain-[0-9a-f]{8}-/, "")} (${sandbox.status})` : ""}
          </div>
        </div>
        {conversation && <StatusPill status={conversation.status} sandbox={sandbox?.status} />}
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

      <div className="transcript term" ref={scroller} onScroll={onScroll}>
        {loading && <div className="term-line muted"># loading…</div>}
        {folded.setup.length > 0 && <SetupLine events={folded.setup} done={folded.turns.length > 0} />}
        {folded.turns.map(({ turn, events: evs }) => (
          <div className={`turn ${turn.status} ${turn.id === focusTurnId ? "found" : ""}`} key={turn.id} data-turn={turn.id}>
            <div className="term-prompt">
              <span className="ps1" aria-hidden="true">
                ❯
              </span>
              <span className="cmd">{turn.prompt}</span>
              <span className="term-meta">
                #{turn.turn_number} {formatTime(turn.started_at ?? turn.inserted_at)}
                {turn.status === "failed" ? " ✕ failed" : turn.status === "interrupted" ? " ⏹ interrupted" : ""}
              </span>
            </div>
            {(turn.image_count ?? 0) > 0 && (
              <div className="turn-images">
                {Array.from({ length: turn.image_count ?? 0 }, (_, i) => (
                  <a key={i} href={turnImageUrl(project.id, conversationId, turn.id, i)} target="_blank" rel="noreferrer">
                    <img src={turnImageUrl(project.id, conversationId, turn.id, i)} alt={`attachment ${i + 1}`} loading="lazy" />
                  </a>
                ))}
              </div>
            )}
            <div className="term-out">
              {arrange(evs, visible).map((b, i) => (
                <BlockView key={`${turn.id}-${i}`} block={b} onAnswer={answer} />
              ))}
            </div>
          </div>
        ))}
        {folded.loose.length > 0 && <div className="term-line muted"># {stageLine(folded.loose)}</div>}
        {waiting && (
          <div className="term-line working" aria-label="working">
            <span className="cursor">▍</span>
          </div>
        )}
      </div>

      <form className="composer term" onSubmit={send}>
        <span className="ps1" aria-hidden="true">
          ❯
        </span>
        <div className="composer-main">
          <AttachmentStrip items={attachments.items} onRemove={attachments.remove} />
          <textarea
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            onPaste={attachments.paste}
            placeholder={retired ? "retired" : `${who} — Enter to send, Shift+Enter for a newline, 🖼 or paste or drop an image`}
            disabled={retired}
            spellCheck={false}
          />
        </div>
        <AttachButton add={attachments.add} disabled={retired} label="Attach an image to this prompt" />
        <button className="send" type="submit" disabled={sending || (!draft.trim() && !attachments.payload) || retired} title="Send (Enter)">
          ⏎
        </button>
      </form>
      {attachments.dragging && !retired && <div className="drop-hint">Drop to attach</div>}
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
export function TwoStep({ label, onConfirm, className = "danger small", title }: { label: string; onConfirm: () => void; className?: string; title?: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return armed ? (
    <button
      className={className}
      title={title}
      onClick={() => {
        setArmed(false);
        onConfirm();
      }}
    >
      Sure? {label}
    </button>
  ) : (
    <button className={className.replace("danger", "secondary")} title={title} onClick={() => setArmed(true)}>
      {label}
    </button>
  );
}
