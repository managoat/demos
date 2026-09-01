/**
 * One chat's transcript and its composer. The transcript is the SDK's
 * history plus the conversation's own live stream, both through `/f/<chat>`
 * on the host's key; every person in the chat reads the same feed.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { modelLabel } from "../../shared/models";
import type { ChatDto, SendDto } from "../lib/api";
import { turnImageUrl } from "../lib/api";
import { arrange } from "../lib/blocks";
import { describeError } from "../lib/errors";
import { formatTime } from "../lib/format";
import { useAttachments } from "../lib/images";
import { authored, fold, stageLine } from "../lib/turns";
import { useSession, makeChatClient } from "../store";
import type { Conversation, LogEvent, Turn } from "../types";
import { Avatar } from "./Avatar";
import { BlockView } from "./Blocks";
import { Composer, type ComposerHandle } from "./Composer";
import { shortName, splitAuthor } from "../../shared/author";

const STREAMS = "acp,stdout,stage";
/** How often the record is re-read while a turn is running — the stream can miss a fast finish (#1060). */
const RUNNING_POLL_MS = 15_000;
const IDLE_POLL_MS = 60_000;

export function Thread({ chat, sends, onSent }: { chat: ChatDto; sends: SendDto[]; onSent: () => void }) {
  const { me, toast } = useSession();
  const fountain = useMemo(() => makeChatClient(chat.id), [chat.id]);
  const convId = chat.conversationId;
  const [record, setRecord] = useState<Conversation | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [showStdout, setShowStdout] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const attachments = useAttachments(useCallback((m: string) => toast(m, "error"), [toast]));
  const composer = useRef<ComposerHandle>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const who = chat.settings.presetName ?? modelLabel(chat.settings.model);

  const readRecord = useCallback(async () => {
    const h = fountain.resume(convId);
    const [r, t] = await Promise.all([h.get(), h.turns()]);
    setRecord(r);
    setTurns(t);
    return r;
  }, [fountain, convId]);

  // Load: record, turns, history.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const h = fountain.resume(convId);
        const [r, t, history] = await Promise.all([h.get(), h.turns(), h.history({ streams: STREAMS })]);
        if (cancelled) return;
        setRecord(r);
        setTurns(t);
        setEvents((prev) => mergeById(history, prev));
        void h.markRead().catch(() => undefined);
      } catch (err) {
        if (!cancelled) toast(describeError(err), "error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fountain, convId, toast]);

  // Live: the conversation's own stream, from where the history ended.
  useEffect(() => {
    if (loading) return;
    const ctrl = new AbortController();
    let after = events.reduce((m, e) => Math.max(m, e.id), 0);
    let stopped = false;
    let refetch: number | null = null;
    const scheduleRefetch = () => {
      if (refetch !== null) return;
      refetch = window.setTimeout(() => {
        refetch = null;
        void readRecord().catch(() => undefined);
      }, 400);
    };
    const run = async () => {
      while (!stopped) {
        try {
          for await (const ev of fountain.resume(convId).events({ after, streams: STREAMS, blocks: true, signal: ctrl.signal })) {
            if (ev.id > after) after = ev.id;
            setEvents((prev) => (prev.some((e) => e.id === ev.id) ? prev : [...prev, ev]));
            if (ev.kind === "stage" && (ev.stage === "turn" || ev.stage === "terminate" || ev.stage === "sandbox" || ev.state === "failed")) scheduleRefetch();
          }
        } catch {
          // fall through to the retry
        }
        if (stopped || ctrl.signal.aborted) return;
        await new Promise((r) => setTimeout(r, 2000));
      }
    };
    void run();
    return () => {
      stopped = true;
      ctrl.abort();
      if (refetch !== null) window.clearTimeout(refetch);
    };
    // `events` is read once, for the cursor; the stream owns it after that.
  }, [loading, fountain, convId, readRecord]); // eslint-disable-line react-hooks/exhaustive-deps

  // The gap the stream can leave: poll the record, and fill history from the last id when it moved.
  const running = record?.status === "running" || record?.status === "pending";
  useEffect(() => {
    if (loading) return;
    const t = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void readRecord().catch(() => undefined);
    }, running ? RUNNING_POLL_MS : IDLE_POLL_MS);
    return () => window.clearInterval(t);
  }, [loading, running, readRecord]);

  useEffect(() => {
    if (!record || loading) return;
    const after = events.reduce((m, e) => Math.max(m, e.id), 0);
    void fountain
      .resume(convId)
      .history({ streams: STREAMS, after })
      .then((more) => {
        if (more.length) setEvents((prev) => mergeById(prev, more));
      })
      .catch(() => undefined);
  }, [record?.status, record?.turn_count, record?.sandbox?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const folded = useMemo(() => fold(events, turns), [events, turns]);
  const authors = useMemo(() => authored(turns, sends, chat.ownerEmail), [turns, sends, chat.ownerEmail]);
  const visible = useMemo(() => new Set(showStdout ? ["acp", "stdout"] : ["acp"]), [showStdout]);

  useEffect(() => {
    const el = scroller.current;
    if (!el || !stick.current) return;
    el.scrollTop = el.scrollHeight;
  }, [events, turns, loading]);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }, []);

  async function send() {
    const prompt = draft.trim();
    const images = attachments.payload;
    if ((!prompt && !images) || sending) return;
    setSending(true);
    try {
      await fountain.request("POST", `/api/conversations/${convId}/prompts`, { body: images ? { prompt, images } : { prompt } });
      setDraft("");
      attachments.clear();
      stick.current = true;
      onSent();
      window.setTimeout(() => void readRecord().catch(() => undefined), 500);
    } catch (err) {
      toast(describeError(err), "error");
    } finally {
      setSending(false);
    }
  }

  const answer = useCallback((requestId: string, optionId: string) => fountain.resume(convId).answer(requestId, optionId), [fountain, convId]);

  const retired = record?.status === "terminated";
  const last = folded.turns[folded.turns.length - 1];
  const waiting = running && (!last || last.turn.status === "running" || last.turn.status === "pending");
  const setupFailed = folded.setup.some((e) => e.kind === "stage" && e.state === "failed") && folded.turns.length === 0;

  return (
    <>
      <div className="transcript" ref={scroller} onScroll={onScroll}>
        {loading && <div className="muted small center">Loading…</div>}
        {!loading && folded.turns.length === 0 && record?.first_prompt && (
          <div className="turn">
            <div className={`msg me${chat.ownerEmail === me.email ? " mine" : ""}`}>
              <Avatar email={chat.ownerEmail} size={26} />
              <div className="msg-body">
                <div className="msg-meta">
                  <span className="name">{chat.ownerEmail === me.email ? "You" : shortName(chat.ownerEmail)}</span>
                </div>
                <div className="bubble">{splitAuthor(record.first_prompt).text}</div>
              </div>
            </div>
          </div>
        )}
        {!loading && folded.setup.length > 0 && folded.turns.length === 0 && (
          <div className={`setup ${setupFailed ? "error" : ""}`}>{setupFailed ? "The computer could not start." : `Starting a computer for ${who}… (${stageLine(folded.setup) ?? "provisioning"})`}</div>
        )}
        {folded.turns.map(({ turn, events: evs }) => {
          const a = authors.get(turn.id) ?? { email: chat.ownerEmail, text: turn.prompt };
          const blocks = arrange(evs, visible);
          const turnRunning = turn.status === "running" || turn.status === "pending";
          return (
            <div className="turn" key={turn.id} data-turn={turn.id}>
              {turn.origin !== "autonomous" && (
                <div className={`msg me${a.email === me.email ? " mine" : ""}`}>
                  <Avatar email={a.email} size={26} />
                  <div className="msg-body">
                    <div className="msg-meta">
                      <span className="name">{a.email === me.email ? "You" : shortName(a.email)}</span>
                      <span className="muted tiny">{formatTime(turn.started_at ?? turn.inserted_at)}</span>
                    </div>
                    <div className="bubble">{a.text}</div>
                    {(turn.image_count ?? 0) > 0 && (
                      <div className="turn-images">
                        {Array.from({ length: turn.image_count ?? 0 }, (_, i) => (
                          <a key={i} href={turnImageUrl(chat.id, convId, turn.id, i)} target="_blank" rel="noreferrer">
                            <img src={turnImageUrl(chat.id, convId, turn.id, i)} alt={`attachment ${i + 1}`} loading="lazy" />
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
              <div className="msg them">
                <span className="agent-mark" aria-hidden="true">
                  ✳
                </span>
                <div className="msg-body">
                  <div className="msg-meta">
                    <span className="name">{who}</span>
                    {turn.status === "failed" && <span className="tiny error-text">failed</span>}
                    {turn.status === "interrupted" && <span className="tiny muted">interrupted</span>}
                  </div>
                  <div className="reply">
                    {blocks.map((b, i) => (
                      <BlockView key={`${turn.id}-${i}`} block={b} onAnswer={answer} />
                    ))}
                    {turnRunning && blocks.length === 0 && <span className="thinking-dots" aria-label="working" />}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        {waiting && folded.turns.length === 0 && !loading && folded.setup.length === 0 && <div className="muted small center">Working…</div>}
      </div>
      <div className="thread-foot">
        <Composer
          ref={composer}
          value={draft}
          onChange={setDraft}
          onSend={() => void send()}
          sending={sending}
          disabled={retired}
          placeholder={retired ? "This chat has been retired." : `Message ${who}`}
          attachments={attachments}
          left={
            <>
              <button type="button" className="icon plus" onClick={() => composer.current?.pickFiles()} aria-label="Attach an image" disabled={retired}>
                +
              </button>
              {running && (
                <button type="button" className="small ghost" onClick={() => fountain.resume(convId).interrupt().then(() => toast("Interrupted")).catch((err) => toast(describeError(err), "error"))}>
                  Stop
                </button>
              )}
            </>
          }
          right={
            <label className="check tiny muted">
              <input type="checkbox" checked={showStdout} onChange={(e) => setShowStdout(e.target.checked)} /> stdout
            </label>
          }
        />
      </div>
    </>
  );
}

function mergeById(base: LogEvent[], extra: LogEvent[]): LogEvent[] {
  if (extra.length === 0) return base;
  const seen = new Set(base.map((e) => e.id));
  const out = [...base];
  for (const e of extra) if (!seen.has(e.id)) out.push(e);
  return out.sort((a, b) => a.id - b.id);
}
