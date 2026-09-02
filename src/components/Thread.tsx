/**
 * One chat's transcript and its composer. The transcript is the SDK's
 * history plus the conversation's own live stream, both through `/f/<chat>`
 * on the host's key; every person in the chat reads the same feed.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { gameLabel } from "../../shared/games";
import { modelLabel } from "../../shared/models";
import type { ChatDto, SendDto } from "../lib/api";
import { api, turnImageUrl } from "../lib/api";
import { arrange, gameOf } from "../lib/blocks";
import { describeError } from "../lib/errors";
import { formatTime } from "../lib/format";
import { useAttachments } from "../lib/images";
import type { ChatLive } from "../lib/live";
import { authored, fold } from "../lib/turns";
import { useSession, makeChatClient } from "../store";
import type { Conversation, LogEvent, Turn } from "../types";
import { Avatar } from "./Avatar";
import { BlockView, type Games } from "./Blocks";
import { ChangesPanel } from "./Changes";
import { Composer, type ComposerHandle } from "./Composer";
import { GameCard } from "./Game";
import { MenuBack, MenuHeading, MenuItem, Popover } from "./Menu";
import { shortName, splitAuthor } from "../../shared/author";

/** The streams shown: the transcript and its stages. The runtime's raw stdout is not something a chat needs to see. */
const STREAMS = "acp,stage";
const VISIBLE = new Set(["acp"]);
/** How often the record is re-read while a turn is running — the stream can miss a fast finish (#1060). */
const RUNNING_POLL_MS = 15_000;
const IDLE_POLL_MS = 60_000;

export function Thread({ chat, sends, onSent, live, changesOpen, onCloseChanges }: { chat: ChatDto; sends: SendDto[]; onSent: () => void; live: ChatLive; changesOpen: boolean; onCloseChanges: () => void }) {
  const { games, takeGame, changes } = live;
  const { me, toast } = useSession();
  const fountain = useMemo(() => makeChatClient(chat.id), [chat.id]);
  const convId = chat.conversationId;
  const [record, setRecord] = useState<Conversation | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const attachments = useAttachments(useCallback((m: string) => toast(m, "error"), [toast]));
  const composer = useRef<ComposerHandle>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const who = modelLabel(chat.settings.model);

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

  const onMove = useCallback(
    async (gameId: string, cell: number) => {
      try {
        takeGame(await api.move(chat.id, gameId, cell));
      } catch (err) {
        toast(describeError(err), "error");
      }
    },
    [chat.id, takeGame, toast],
  );
  const gameHandlers = useMemo<Games>(() => ({ byId: games, me: me.email, onMove }), [games, me.email, onMove]);

  const folded = useMemo(() => fold(events, turns), [events, turns]);
  const authors = useMemo(() => authored(turns, sends, chat.ownerEmail), [turns, sends, chat.ownerEmail]);

  // A game the transcript shows at the tool call that started it is not shown again;
  // one started from the "+" has no such place and goes after the last turn.
  const arranged = useMemo(() => folded.turns.map(({ turn, events: evs }) => ({ turn, blocks: arrange(evs, VISIBLE) })), [folded]);
  const looseGames = useMemo(() => {
    const placed = new Set<string>();
    for (const { blocks } of arranged) for (const b of blocks) if (b.kind === "tool_use") placed.add(gameOf(b as Parameters<typeof gameOf>[0])?.id ?? "");
    return [...games.values()].filter((g) => !placed.has(g.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [arranged, games]);

  useEffect(() => {
    const el = scroller.current;
    if (!el || !stick.current) return;
    el.scrollTop = el.scrollHeight;
  }, [events, turns, loading, games]);

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

  const retired = record?.status === "terminated" || !!chat.archivedAt;
  const sendPrompt = useCallback(
    async (text: string) => {
      await fountain.request("POST", `/api/conversations/${convId}/prompts`, { body: { prompt: text } });
      onSent();
      window.setTimeout(() => void readRecord().catch(() => undefined), 500);
    },
    [fountain, convId, onSent, readRecord],
  );
  const last = folded.turns[folded.turns.length - 1];
  const waiting = running && (!last || last.turn.status === "running" || last.turn.status === "pending");
  const setupFailed = folded.setup.some((e) => e.kind === "stage" && e.state === "failed") && folded.turns.length === 0;

  return (
    <div className={`thread-body${changesOpen ? " with-changes" : ""}`}>
      <div className="thread-main">
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
          <div className={`setup ${setupFailed ? "error" : ""}`}>{setupFailed ? "Something went wrong getting things ready. Try sending again in a moment." : "Getting things ready…"}</div>
        )}
        {arranged.map(({ turn, blocks }) => {
          const a = authors.get(turn.id) ?? { email: chat.ownerEmail, text: turn.prompt };
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
                <span className="reply-mark" aria-hidden="true">
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
                      <BlockView key={`${turn.id}-${i}`} block={b} onAnswer={answer} games={gameHandlers} />
                    ))}
                    {turnRunning && blocks.length === 0 && <span className="thinking-dots" aria-label="working" />}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        {waiting && folded.turns.length === 0 && !loading && folded.setup.length === 0 && <div className="muted small center">Working…</div>}
        {looseGames.length > 0 && (
          <div className="loose-games">
            {looseGames.map((g) => (
              <GameCard key={g.id} game={g} me={me.email} onMove={onMove} />
            ))}
          </div>
        )}
      </div>
      <div className="thread-foot">
        <Composer
          ref={composer}
          value={draft}
          onChange={setDraft}
          onSend={() => void send()}
          sending={sending}
          disabled={retired}
          placeholder={chat.archivedAt ? "This chat is archived. Restore it to keep going." : retired ? "This chat has been retired." : `Message ${who}`}
          attachments={attachments}
          left={
            <>
              <PlusMenu
                disabled={retired}
                participants={[chat.ownerEmail, ...chat.members.map((m) => m.email)]}
                me={me.email}
                onAttach={() => composer.current?.pickFiles()}
                onGame={async (opponent) => {
                  try {
                    takeGame(await api.startGame(chat.id, "tictactoe", [me.email, opponent]));
                    stick.current = true;
                  } catch (err) {
                    toast(describeError(err), "error");
                  }
                }}
              />
              {running && (
                <button type="button" className="small ghost" onClick={() => fountain.resume(convId).interrupt().then(() => toast("Interrupted")).catch((err) => toast(describeError(err), "error"))}>
                  Stop
                </button>
              )}
            </>
          }
        />
      </div>
      </div>
      {changesOpen && <ChangesPanel changes={changes} review={{ chatId: chat.id, comments: live.comments, takeComment: live.takeComment, busy: !!running, sendPrompt: retired ? null : sendPrompt }} onClose={onCloseChanges} />}
    </div>
  );
}

/**
 * The "+" at the foot of a chat: photos, and a game against someone here.
 * Starting one this way costs nobody a turn; saying "let's play" costs the
 * host one and is the same board.
 */
function PlusMenu({ disabled, participants, me, onAttach, onGame }: { disabled: boolean; participants: string[]; me: string; onAttach: () => void; onGame: (opponent: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"root" | "games">("root");
  const close = useCallback(() => {
    setOpen(false);
    setView("root");
  }, []);
  const others = participants.filter((p) => p !== me);
  return (
    <div className="pill-wrap">
      <button type="button" className={`icon plus${open ? " on" : ""}`} onClick={() => (open ? close() : setOpen(true))} aria-label="Add" aria-haspopup="menu" aria-expanded={open} disabled={disabled}>
        +
      </button>
      <Popover open={open} onClose={close} className="add-menu">
        {view === "root" && (
          <>
            <MenuItem
              icon="📎"
              label="Add photos"
              detail="Or paste or drop them in"
              onClick={() => {
                close();
                onAttach();
              }}
            />
            <div className="menu-sep" />
            <MenuItem icon="✕" label="Games" detail={others.length ? `${gameLabel("tictactoe")} with someone here` : "Invite someone first"} arrow onClick={() => setView("games")} />
          </>
        )}
        {view === "games" && (
          <>
            <MenuBack onClick={() => setView("root")} />
            <MenuHeading>{gameLabel("tictactoe")} — you play X against…</MenuHeading>
            {others.length === 0 && <MenuHeading>Nobody else is in this chat yet. Invite someone, or just say "let's play" once they are here.</MenuHeading>}
            {others.map((email) => (
              <MenuItem
                key={email}
                icon={<Avatar email={email} size={18} />}
                label={shortName(email)}
                detail={email}
                onClick={() => {
                  close();
                  void onGame(email);
                }}
              />
            ))}
          </>
        )}
      </Popover>
    </div>
  );
}

function mergeById(base: LogEvent[], extra: LogEvent[]): LogEvent[] {
  if (extra.length === 0) return base;
  const seen = new Set(base.map((e) => e.id));
  const out = [...base];
  for (const e of extra) if (!seen.has(e.id)) out.push(e);
  return out.sort((a, b) => a.id - b.id);
}
