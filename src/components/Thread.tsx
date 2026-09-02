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
import { arrange, assistantText, gameOf } from "../lib/blocks";
import { describeError, errorCode } from "../lib/errors";
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
import { PlanView, type PlanNodePatch, type PlanViewPlan } from "./Plan";
import type { PlanOperation } from "../../shared/plans";

/** The streams shown: the transcript and its stages. The runtime's raw stdout is not something a chat needs to see. */
const STREAMS = "acp,stage";
const VISIBLE = new Set(["acp"]);
/** How often the record is re-read while a turn is running — the stream can miss a fast finish (#1060). */
const RUNNING_POLL_MS = 15_000;
const IDLE_POLL_MS = 60_000;

export function Thread({ chat, sends, onSent, live, changesOpen, onCloseChanges, onOpenChanges, planOpen, onClosePlan }: { chat: ChatDto; sends: SendDto[]; onSent: () => void; live: ChatLive; changesOpen: boolean; onCloseChanges: () => void; onOpenChanges: () => void; planOpen: boolean; onClosePlan: () => void }) {
  const { games, takeGame, changes, refreshChanges } = live;
  const { me, toast, workspace, refreshChats, refreshNotifications } = useSession();
  const fountain = useMemo(() => makeChatClient(chat.id), [chat.id]);
  const convId = chat.conversationId;
  const [record, setRecord] = useState<Conversation | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [draftingPlan, setDraftingPlan] = useState(false);
  const [executionEvidence, setExecutionEvidence] = useState<typeof changes>(null);
  const [noteMode, setNoteMode] = useState(false);
  const [executionPoll, setExecutionPoll] = useState(0);
  const draftSawRunning = useRef(false);
  const draftStartCount = useRef(0);
  const attachments = useAttachments(useCallback((m: string) => toast(m, "error"), [toast]));
  const composer = useRef<ComposerHandle>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    if (!changesOpen) setExecutionEvidence(null);
  }, [changesOpen]);

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
  const toolCompletions = useMemo(() => events.reduce((count, event) => count + (event.blocks?.filter((block) => block.kind === "tool_result").length ?? 0), 0), [events]);
  const seenToolCompletions = useRef(0);
  const toolRefreshTimer = useRef<number | null>(null);
  useEffect(() => {
    const previous = seenToolCompletions.current;
    seenToolCompletions.current = toolCompletions;
    if (!running || !chat.project || toolCompletions <= previous) return;
    if (toolRefreshTimer.current !== null) window.clearTimeout(toolRefreshTimer.current);
    toolRefreshTimer.current = window.setTimeout(() => {
      toolRefreshTimer.current = null;
      void refreshChanges("manual").catch(() => undefined);
    }, 700);
    return () => {
      if (toolRefreshTimer.current !== null) window.clearTimeout(toolRefreshTimer.current);
    };
  }, [toolCompletions, running, chat.project, refreshChanges]);
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
      if (running || noteMode) {
        if (images) {
          toast("Room notes are text-only. Remove the attachment or wait to send it as a turn.", "error");
          return;
        }
        const note = await api.note(chat.id, prompt, running ? "next_turn" : "manual");
        live.takeNote(note);
        setDraft("");
        attachments.clear();
        setNoteMode(false);
        toast(running ? "Saved as a room note for the next turn." : "Room note saved without starting a turn.");
        return;
      }
      await fountain.request("POST", `/api/conversations/${convId}/prompts`, { body: images ? { prompt, images } : { prompt } });
      setDraft("");
      attachments.clear();
      stick.current = true;
      onSent();
      void refreshChats();
      void refreshNotifications();
      window.setTimeout(() => void readRecord().catch(() => undefined), 500);
    } catch (err) {
      if ((errorCode(err) === "conversation_busy" || errorCode(err) === "plan_execution_busy") && prompt && !images) {
        try {
          live.takeNote(await api.note(chat.id, prompt, "next_turn"));
          setDraft("");
          toast("The turn was already busy, so your message was saved as a next-turn room note.");
        } catch (noteError) { toast(describeError(noteError), "error"); }
      } else toast(describeError(err), "error");
    } finally {
      setSending(false);
    }
  }

  const answer = useCallback((requestId: string, optionId: string) => api.answerPermission(chat.id, requestId, optionId).then(() => undefined), [chat.id]);

  const retired = record?.status === "terminated" || !!chat.archivedAt;
  const mention = /(?:^|\s)@([^\s@]*)$/.exec(draft);
  const mentionQuery = mention?.[1]?.toLowerCase() ?? null;
  const mentionMatches = mentionQuery === null ? [] : workspace.filter((m) => {
    const handle = m.email.split("@")[0]!.toLowerCase();
    return !mentionQuery || handle.startsWith(mentionQuery) || m.email.toLowerCase().startsWith(mentionQuery);
  }).slice(0, 5);

  function chooseMention(email: string) {
    const handle = email.split("@")[0]!;
    setDraft(draft.replace(/@[^\s@]*$/, `@${handle} `));
    window.setTimeout(() => composer.current?.focus(), 0);
  }

  // A turn just ended in a project chat: read the repository through Fountain, unless the hook already reported (the server knows).
  const wasRunning = useRef(false);
  useEffect(() => {
    if (running) {
      wasRunning.current = true;
      return;
    }
    if (!wasRunning.current) return;
    wasRunning.current = false;
    if (chat.project && !retired) void refreshChanges("stop").catch(() => undefined);
  }, [running, chat.project, retired, refreshChanges]);

  useEffect(() => {
    const timer = window.setTimeout(() => live.updatePresence(!!draft.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [draft, live.updatePresence]);

  useEffect(() => {
    if (running && draftingPlan) draftSawRunning.current = true;
    if (running || !draftingPlan || arranged.length <= draftStartCount.current) return;
    const last = arranged[arranged.length - 1];
    const text = last ? assistantText(folded.turns.find((item) => item.turn.id === last.turn.id)?.events ?? []) : "";
    if (!text) {
      setDraftingPlan(false);
      toast("The plan draft turn ended without a structured draft.", "error");
      return;
    }
    draftSawRunning.current = false;
    void (async () => {
      try {
        const adopted = await api.adoptPlan(chat.id, JSON.parse(extractJson(text)));
        live.setPlan("proposed" in adopted ? adopted.plan : adopted);
        toast("Plan draft is ready for review.");
      } catch (err) {
        // The model's invalid output remains visible in the transcript and
        // the authoritative plan is untouched.
        toast(`The draft stayed in the thread: ${describeError(err)}`, "error");
      } finally {
        setDraftingPlan(false);
      }
    })();
  }, [running, draftingPlan, arranged, folded.turns, chat.id, live.setPlan, toast]);
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

  const planView: PlanViewPlan | null = live.plan ? { ...live.plan.document, events: live.plan.events, approvals: live.plan.approvals, executions: live.plan.executions, comments: live.plan.comments, proposals: live.plan.proposals } : null;
  const currentExecution = live.plan?.executions.find((execution) => execution.status === "running" || execution.status === "queued") ?? null;

  useEffect(() => {
    const launcher = currentExecution?.launchedBy === me.email;
    const hostRecovery = chat.role === "owner";
    if (running || !currentExecution || (!launcher && !hostRecovery)) return;
    const timer = window.setTimeout(() => void (async () => {
      try {
        await readRecord();
        if (chat.project && !retired) await refreshChanges("stop");
        const last = arranged[arranged.length - 1];
        const claim = last ? assistantText(folded.turns.find((item) => item.turn.id === last.turn.id)?.events ?? []) : "";
        const result = await api.finishPlanExecution(chat.id, currentExecution.id, launcher ? { summary: claim, modelClaims: claim ? [claim] : [] } : {});
        live.setPlan(result.plan);
      } catch (err) {
        if (errorCode(err) === "execution_not_finished") setExecutionPoll((value) => value + 1);
        else toast(describeError(err), "error");
      }
    })(), launcher ? 1_000 : 5_000);
    return () => window.clearTimeout(timer);
  }, [running, currentExecution?.id, executionPoll]); // eslint-disable-line react-hooks/exhaustive-deps

  const mutatePlan = useCallback(async (operations: PlanOperation[]) => {
    live.setPlan(await api.mutatePlan(chat.id, operations));
  }, [chat.id, live.setPlan]);

  const patchNode = useCallback(async (nodeId: string, patch: PlanNodePatch) => {
    if (!live.plan) return;
    const revision = live.plan.document.plan.revision;
    const node = live.plan.document.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) return;
    const operations: PlanOperation[] = [];
    for (const field of ["outcome", "description", "acceptanceCriteria", "declaredScope"] as const) {
      if (patch[field] !== undefined && JSON.stringify(patch[field]) !== JSON.stringify(node[field])) operations.push({ id: crypto.randomUUID(), expectedRevision: revision, type: "set_node_field", nodeId, field, value: patch[field] as never } as PlanOperation);
    }
    if (patch.dependencies) {
      const before = live.plan.document.edges.filter((edge) => edge.toNodeId === nodeId).map((edge) => edge.fromNodeId);
      for (const dependency of before.filter((id) => !patch.dependencies!.includes(id))) operations.push({ id: crypto.randomUUID(), expectedRevision: revision, type: "remove_edge", fromNodeId: dependency, toNodeId: nodeId });
      for (const dependency of patch.dependencies.filter((id) => !before.includes(id))) operations.push({ id: crypto.randomUUID(), expectedRevision: revision, type: "add_edge", edgeId: crypto.randomUUID(), fromNodeId: dependency, toNodeId: nodeId });
    }
    if (operations.length) await mutatePlan(operations);
  }, [live.plan, mutatePlan]);

  return (
    <div className={`thread-body${changesOpen ? " with-changes" : ""}${planOpen ? " with-plan" : ""}`}>
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
                      <BlockView key={`${turn.id}-${i}`} block={b} onAnswer={chat.role === "owner" || a.email === me.email ? answer : undefined} games={gameHandlers} />
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
        {(live.presence?.people.length || live.activeTurn || [...live.notes.values()].some((note) => !note.sentAt && !note.resolvedAt)) ? (
          <div className="room-state">
            {live.presence?.people.length ? <span>{live.presence.people.map((person) => shortName(person.email)).join(", ")} online</span> : null}
            {live.presence?.people.some((person) => person.typing && person.email !== me.email) ? <span>{live.presence.people.filter((person) => person.typing && person.email !== me.email).map((person) => shortName(person.email)).join(", ")} typing…</span> : null}
            {running && (authors.get(last?.turn.id ?? "")?.email || live.activeTurn?.author) ? <span>{shortName(authors.get(last?.turn.id ?? "")?.email ?? live.activeTurn!.author)} started this turn</span> : null}
            {live.controls.at(-1) ? <span>{shortName(live.controls.at(-1)!.actor)} {live.controls.at(-1)!.action === "interrupt" ? "interrupted" : "answered a permission"} · {live.controls.at(-1)!.outcome.replace(/_/g, " ")}{live.controls.at(-1)!.winner ? ` (${shortName(live.controls.at(-1)!.winner!)} was first)` : ""}</span> : null}
            {[...live.notes.values()].filter((note) => !note.sentAt && !note.resolvedAt).length > 0 ? <span>{[...live.notes.values()].filter((note) => !note.sentAt && !note.resolvedAt).length} room note(s)</span> : null}
          </div>
        ) : null}
        {[...live.notes.values()].some((note) => !note.sentAt && !note.resolvedAt) && (
          <div className="room-notes">
            {[...live.notes.values()].filter((note) => !note.sentAt && !note.resolvedAt).map((note) => (
              <div key={note.id}>
                <Avatar email={note.author} size={20} />
                <span><strong>{note.author === me.email ? "You" : shortName(note.author)}</strong>{note.body}</span>
                {note.delivery === "next_turn" && <em>next turn</em>}
                <button type="button" className="linklike tiny" onClick={() => void api.resolveNote(chat.id, note.id, true).then(live.takeNote).catch((err) => toast(describeError(err), "error"))}>Resolve</button>
                {(note.author === me.email || chat.role === "owner") && <button type="button" className="linklike tiny" onClick={() => void api.deleteNote(chat.id, note.id).then(() => live.takeNote({ ...note, deleted: true })).catch((err) => toast(describeError(err), "error"))}>Delete</button>}
              </div>
            ))}
            <button type="button" className="small ghost" disabled={running} onClick={() => void api.sendNotes(chat.id).then((result) => { for (const note of result.notes) live.takeNote(note); onSent(); }).catch((err) => toast(describeError(err), "error"))}>Send notes to the model</button>
          </div>
        )}
        <Composer
          ref={composer}
          value={draft}
          onChange={setDraft}
          onSend={() => void send()}
          sending={sending}
          disabled={retired}
          placeholder={chat.archivedAt ? "This chat is archived. Restore it to keep going." : retired ? "This chat has been retired." : running ? "Save a note for the next turn" : noteMode ? "Write a room note — this will not start a turn" : `Message ${who}`}
          attachments={attachments}
          suggestions={mentionMatches.length > 0 ? (
            <div className="mention-menu">
              <div className="muted tiny">Share this thread with</div>
              {mentionMatches.map((m) => <button type="button" key={m.email} onClick={() => chooseMention(m.email)}><Avatar email={m.email} size={24} /><span><strong>@{m.email.split("@")[0]}</strong><small>{m.email}</small></span></button>)}
            </div>
          ) : null}
          left={
            <>
              <PlusMenu
                disabled={retired || running || noteMode}
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
              {!running && <button type="button" className={`small ghost${noteMode ? " on" : ""}`} onClick={() => setNoteMode((value) => !value)}>Note</button>}
              {running && (chat.role === "owner" || (authors.get(last?.turn.id ?? "")?.email ?? live.activeTurn?.author) === me.email) && (
                <button type="button" className="small ghost" onClick={() => api.interrupt(chat.id).then(() => toast("Interrupted")).catch((err) => toast(describeError(err), "error"))}>
                  Stop
                </button>
              )}
            </>
          }
        />
      </div>
      </div>
      {changesOpen && <ChangesPanel changes={executionEvidence ?? changes} review={{ chatId: chat.id, comments: executionEvidence ? new Map() : live.comments, takeComment: live.takeComment, busy: !!running, sendPrompt: executionEvidence || retired ? null : sendPrompt, refresh: executionEvidence ? null : chat.project && !retired ? live.refreshChanges : null, readOnly: !!executionEvidence }} onClose={() => { setExecutionEvidence(null); onCloseChanges(); }} />}
      {planOpen && (
        <PlanView
          plan={planView}
          me={me.email}
          hostEmail={chat.ownerEmail}
          busy={running}
          drafting={draftingPlan}
          running={!!currentExecution}
          onClose={() => { live.updatePresence(!!draft.trim(), null); onClosePlan(); }}
          onDraft={retired ? undefined : async () => {
            setDraftingPlan(true); draftSawRunning.current = false; draftStartCount.current = arranged.length;
            try { await api.draftPlan(chat.id, record?.first_prompt || chat.title); onSent(); window.setTimeout(() => void readRecord().catch(() => undefined), 500); }
            catch (error) { setDraftingPlan(false); throw error; }
          }}
          onPatchNode={patchNode}
          onPatchPlan={async (patch) => {
            if (!live.plan) return;
            const current = live.plan.document.plan;
            const operations: PlanOperation[] = [];
            for (const field of ["title", "outcome", "description"] as const) if (patch[field] !== current[field]) operations.push({ id: crypto.randomUUID(), expectedRevision: current.revision + operations.length, type: "set_plan_field", field, value: patch[field] });
            if (operations.length) await mutatePlan(operations);
          }}
          onAddNode={async () => { if (!live.plan) return; const revision = live.plan.document.plan.revision; const id = `node-${crypto.randomUUID().slice(0, 8)}`; await mutatePlan([{ id: crypto.randomUUID(), expectedRevision: revision, type: "add_node", node: { id, outcome: "New outcome", description: "", acceptanceCriteria: [{ id: `${id}-criterion`, text: "Define the observable result" }], declaredScope: [], status: "pending", order: live.plan.document.nodes.length } }]); }}
          onRemoveNode={async (nodeId) => { if (live.plan) await mutatePlan([{ id: crypto.randomUUID(), expectedRevision: live.plan.document.plan.revision, type: "remove_node", nodeId }]); }}
          onMoveNode={async (nodeId, direction) => { if (!live.plan) return; const nodes = [...live.plan.document.nodes].sort((a, b) => a.order - b.order); const index = nodes.findIndex((node) => node.id === nodeId); const target = index + direction; if (target < 0 || target >= nodes.length) return; const afterNodeId = direction < 0 ? (nodes[target - 1]?.id ?? null) : nodes[target]!.id; await mutatePlan([{ id: crypto.randomUUID(), expectedRevision: live.plan.document.plan.revision, type: "move_node", nodeId, afterNodeId }]); }}
          onComment={async (nodeId, field, body) => { live.takeComment(await api.comment(chat.id, { anchorKind: field ? "plan_field" : "plan_node", planNodeId: nodeId, planField: field ?? undefined, body })); }}
          onResolveComment={async (commentId, resolved) => { live.takeComment(await api.resolveComment(chat.id, commentId, resolved)); }}
          onDeleteComment={async (commentId) => { await api.deleteComment(chat.id, commentId); }}
          onSendFeedback={retired ? undefined : async () => { const result = await api.sendPlanFeedback(chat.id); live.setPlan(result.plan); onSent(); }}
          onApprove={async (revision) => live.setPlan(await api.decidePlan(chat.id, revision, "approve"))}
          onSupport={async (revision) => live.setPlan(await api.decidePlan(chat.id, revision, "support"))}
          onRun={retired ? undefined : async () => { const result = await api.runPlan(chat.id); live.setPlan(result.plan); onSent(); window.setTimeout(() => void readRecord().catch(() => undefined), 500); }}
          onOpenEvidence={(execution) => { void api.planExecutionEvidence(chat.id, execution.id).then((evidence) => { setExecutionEvidence(evidence); onOpenChanges(); onClosePlan(); }).catch((err) => toast(describeError(err), "error")); }}
          onDecideProposal={async (proposalId, decision) => live.setPlan(await api.decidePlanProposal(chat.id, proposalId, decision))}
          presence={live.presence?.people}
          onViewing={(nodeId, field, mode) => live.updatePresence(!!draft.trim(), nodeId ? { nodeId, field, mode } : null)}
        />
      )}
    </div>
  );
}

function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return candidate.trim();
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
