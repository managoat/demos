import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useStore } from "../store";
import { navigate, paths } from "../router";
import { describeError, THREAD_STREAMS } from "../api/client";
import type { Conversation, ImageInput, LogEvent, SandboxDetail, TreeNode, Turn, UserEvent } from "../api/types";
import { arrange, isSection, timeline, type Section } from "../lib/blocks";
import { childMode, defaultOpen, eventVisible, formatDurationMs, hiddenInPretty, sectionDuration, stageExtra, stageIcon } from "../lib/stages";
import { loadPrefs, savePrefs, type ViewMode } from "../lib/prefs";
import { conversationLabel, formatClock, formatTime, shortId } from "../lib/format";
import { BlockView } from "../components/Blocks";
import { StatusPill } from "../components/StatusPill";
import { HomeBadge } from "../components/HomeBadge";
import { ImagePicker } from "../components/ImagePicker";
import { renderMarkdown } from "../lib/markdown";
import { TurnImages } from "../components/TurnImages";
import { AgentAvatar } from "../components/AgentAvatar";
import { SpawnGraph } from "../components/SpawnGraph";
import { RawView } from "../components/RawView";

/** The glyph an agent without an avatar gets, by runtime — as the web UI drew it. */
const GLYPH: Record<string, string> = { claude: "✦", codex: "◇", gemini: "◈", opencode: "◉" };

export function ShowPage({ id }: { id: string }) {
  const { client, conversations, agents, subscribe, refresh, toast, canPrompt } = useStore();
  const [conv, setConv] = useState<Conversation | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [prefs, setPrefs] = useState(() => loadPrefs());
  const [showTree, setShowTree] = useState(false);
  const [tree, setTree] = useState<TreeNode[] | null>(null);
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<ImageInput[]>([]);
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const listed = conversations.find((c) => c.id === id) ?? null;
  const current = listed ?? conv;
  const agent = current?.agent_id ? agents.get(current.agent_id) ?? null : null;

  const setPref = (p: Partial<typeof prefs>) => setPrefs(savePrefs(p));

  // Initial load: the conversation, its turns, and every event with blocks.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setNotFound(false);
    setTurns([]);
    setEvents([]);
    Promise.all([client.getConversation(id), client.listTurns(id), client.listAllEvents(id)])
      .then(([c, t, e]) => {
        if (cancelled) return;
        setConv(c);
        setTurns(t);
        setEvents(e);
      })
      .catch((err) => {
        if (cancelled) return;
        if ((err as { status?: number }).status === 404) setNotFound(true);
        else toast(describeError(err), "error");
      })
      .finally(() => !cancelled && setLoading(false));
    client.markRead(id).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, id, toast]);

  // Live: append events, refetch turns at turn boundaries, mark read at the end.
  useEffect(() => {
    return subscribe(id, (ev: UserEvent) => {
      setEvents((es) => (es.some((e) => e.id === ev.id) ? es : [...es, ev]));
      if (ev.kind === "stage" && ev.stage === "turn") {
        client.listTurns(id).then(setTurns).catch(() => undefined);
        if (ev.state !== "started") client.markRead(id).catch(() => undefined);
      }
      if (ev.kind === "stage") client.getConversation(id).then(setConv).catch(() => undefined);
    });
  }, [subscribe, client, id]);

  // The home badge's hover list: the machine's other conversations. Only a
  // persistent sandbox has any; re-read when the list changes.
  const homeId = current?.sandbox?.mode === "persistent" ? current.sandbox.id : null;
  const [home, setHome] = useState<SandboxDetail | null>(null);
  useEffect(() => {
    if (!homeId) {
      setHome(null);
      return;
    }
    let cancelled = false;
    client
      .getSandbox(homeId)
      .then((s) => !cancelled && setHome(s))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, homeId, conversations]);

  useEffect(() => {
    if (!showTree) return;
    client.tree(id).then(setTree).catch(() => setTree([]));
  }, [showTree, client, id, conversations]);

  // Stick to the bottom while the reply streams unless the user scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events.length, turns.length, prefs.viewMode]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  useEffect(() => {
    document.title = current ? `${conversationLabel(current, turns[0]?.prompt)} · Conversations` : "Conversations";
  }, [current, turns]);

  const eventsByTurn = useMemo(() => {
    const m = new Map<string, LogEvent[]>();
    for (const ev of events) {
      if (!ev.turn_id) continue;
      const arr = m.get(ev.turn_id);
      if (arr) arr.push(ev);
      else m.set(ev.turn_id, [ev]);
    }
    return m;
  }, [events]);

  const visible = useMemo(() => new Set(prefs.visibleStreams), [prefs.visibleStreams]);
  // The `reattach` pairs are bookkeeping: dropping them keeps post-crash
  // output under the turn section that is still open above it.
  const items = useMemo(
    () => (prefs.viewMode === "timeline" ? timeline(events.filter((e) => !hiddenInPretty(e)), turns) : []),
    [events, turns, prefs.viewMode],
  );
  const rawEvents = useMemo(() => (prefs.viewMode === "raw" ? events.filter((e) => eventVisible(e, visible)) : []), [events, visible, prefs.viewMode]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending || !current) return;
    setSending(true);
    try {
      await client.prompt(id, text, images);
      setDraft("");
      setImages([]);
      stick.current = true;
      // A prompt to a cold conversation wakes it: the status and sandbox change.
      client.getConversation(id).then(setConv).catch(() => undefined);
      toast("Queued");
    } catch (err) {
      toast(describeError(err), "error");
    } finally {
      setSending(false);
    }
  }, [draft, images, sending, current, client, id, toast]);

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  const act = (label: string, fn: () => Promise<unknown>, confirm?: string) => async () => {
    if (confirm && !window.confirm(confirm)) return;
    try {
      await fn();
      toast(label);
      void refresh();
      client.getConversation(id).then(setConv).catch(() => undefined);
    } catch (err) {
      toast(describeError(err), "error");
    }
  };

  if (notFound) {
    return (
      <div className="page">
        <div className="empty">
          <p>That conversation does not exist (or is not yours).</p>
          <a href={paths.index}>Back to conversations</a>
        </div>
      </div>
    );
  }

  const live = !!current && current.status !== "terminated" && current.status !== "failed";
  const toggleStream = (s: string) => {
    const set = new Set(prefs.visibleStreams);
    if (set.has(s)) set.delete(s);
    else set.add(s);
    setPref({ visibleStreams: [...set] });
  };
  const usage = current?.usage_total;
  const runner = current?.sandbox?.runner;

  return (
    <div className="show">
      <header className="show-header">
        <a href={paths.index} className="back" aria-label="Back to conversations">
          ‹
        </a>
        <div className="show-title">
          <div className="name">{current ? conversationLabel(current, turns[0]?.prompt) : "…"}</div>
          <div className="sub muted">
            {agent?.name ?? (current?.agent_id ? "(deleted agent)" : "(no agent)")} · {current?.runtime}
            {agent && ` · ${agent.model}`}
            {current?.sandbox && (
              <span className="mono">
                {" · "}
                <a href={paths.sandbox(current.sandbox.id)} title="The machine this conversation runs on">
                  {current.sandbox.sprite_name}
                </a>
                {current.sandbox.provider ? ` (${current.sandbox.provider})` : ""} · {current.sandbox.status}
              </span>
            )}
            {current?.sandbox?.mode === "persistent" && (
              <HomeBadge sandbox={current.sandbox} currentId={current.id} siblings={home?.conversations ?? null} />
            )}
            {runner && (
              <span title={runner.path ?? undefined}>
                {" · "}
                <span className={runner.online ? "ok" : "warn"}>●</span> {runner.name ?? runner.hostname ?? "runner"}
              </span>
            )}
            {current && <span className="mono"> · {shortId(current.id)}</span>}
            {current?.vault_id && (
              <>
                {" · "}
                <a href={paths.vault(current.vault_id)}>vault</a>
              </>
            )}
            {current?.parent_conversation_id && (
              <>
                {" · "}
                <a href={paths.show(current.parent_conversation_id)}>parent</a>
              </>
            )}
            {current && <span className={`badge src-${current.source}`}>{current.source === "ui" ? "UI" : current.source === "agent" ? "Agent" : "API"}</span>}
            {usage && (usage.input > 0 || usage.output > 0) && (
              <span title="Tokens in / out across every turn">
                {" · "}
                {usage.input.toLocaleString()} in / {usage.output.toLocaleString()} out
              </span>
            )}
          </div>
        </div>
        {current?.sandbox?.url && (
          <a className="button secondary small" href={current.sandbox.url} target="_blank" rel="noreferrer noopener" title="The sandbox's own HTTP endpoint">
            Preview ↗
          </a>
        )}
        {current && <StatusPill status={current.status} sandbox={current.sandbox?.status} />}
        <div className="row actions">
          <div className="seg">
            {(["chat", "timeline", "raw"] as ViewMode[]).map((m) => (
              <button key={m} className={prefs.viewMode === m ? "on" : ""} onClick={() => setPref({ viewMode: m })}>
                {m === "chat" ? "Chat" : m === "timeline" ? "Timeline" : "Raw"}
              </button>
            ))}
          </div>
          <button className={`secondary small ${showTree ? "on" : ""}`} onClick={() => setShowTree((v) => !v)} title="Spawn tree">
            Tree
          </button>
          <a className="button secondary small" href={paths.logs(id)} title="Raw log events">
            Logs
          </a>
          {current?.status === "running" && (
            <button className="secondary small" onClick={act("Interrupted", () => client.interrupt(id))}>
              Interrupt
            </button>
          )}
          {live && (
            <button
              className="danger small"
              onClick={act("Terminated", () => client.terminate(id), "Terminate this conversation? Its sandbox is destroyed; the transcript stays.")}
            >
              Terminate
            </button>
          )}
          <button
            className="danger small"
            onClick={act(
              "Deleted",
              async () => {
                await client.deleteConversation(id);
                navigate(paths.index);
              },
              "Delete this conversation and all its turns? This cannot be undone.",
            )}
          >
            Delete
          </button>
        </div>
      </header>

      {prefs.viewMode !== "chat" && (
        <div className="stream-toggles">
          {THREAD_STREAMS.map((s) => (
            <label key={s} className="check small">
              <input type="checkbox" checked={visible.has(s)} onChange={() => toggleStream(s)} />
              {s}
            </label>
          ))}
        </div>
      )}

      {showTree && tree && tree.length > 1 && (
        <div className="graph-strip">
          <SpawnGraph nodes={tree} currentId={id} />
        </div>
      )}

      <div className="show-body">
        <div className={`transcript ${prefs.viewMode}`} ref={scrollRef} onScroll={onScroll}>
          {loading && <div className="centered muted">Loading…</div>}
          {!loading && turns.length === 0 && events.length === 0 && (
            <div className="centered muted empty-thread">{current?.status === "pending" ? "Starting the sandbox…" : "No turns yet."}</div>
          )}
          {prefs.viewMode === "chat" &&
            turns.map((turn) => (
              <ChatTurn
                key={turn.id}
                turn={turn}
                events={eventsByTurn.get(turn.id) ?? []}
                conversationId={id}
                agentName={agent?.name ?? current?.runtime ?? "agent"}
                glyph={GLYPH[current?.runtime ?? ""] ?? "🤖"}
                avatar={agent && agent.avatar_media_type ? <AgentAvatar agent={agent} size={26} /> : null}
              />
            ))}
          {prefs.viewMode === "timeline" &&
            items.map((item, i) =>
              isSection(item) ? (
                <SectionView key={item.key} section={item} visible={visible} conversationId={id} />
              ) : (
                <LooseEvent key={item.id ?? i} ev={item} visible={visible} />
              ),
            )}
          {prefs.viewMode === "raw" && !loading && <RawView events={rawEvents} />}
        </div>
        {showTree && (
          <aside className="tree">
            <div className="tree-head">Spawn tree</div>
            {tree === null && <div className="muted small">Loading…</div>}
            {tree && tree.length <= 1 && <div className="muted small">No sub-conversations.</div>}
            {tree && tree.length > 1 && <TreeList nodes={tree} currentId={id} />}
            <a className="button secondary small" href={paths.new({ parent: id })}>
              New sub-conversation
            </a>
          </aside>
        )}
      </div>

      {!canPrompt ? (
        <div className="readonly-banner">
          Read-only: your subscription is inactive, so you can view this conversation and stop running work but not send prompts.{" "}
          <a href={`${client.baseUrl}/account/billing`} target="_blank" rel="noreferrer noopener">
            Update billing ↗
          </a>
        </div>
      ) : (
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <div className="composer-main">
            <textarea
              rows={1}
              value={draft}
              placeholder={live ? "Follow-up prompt… (Enter to send, Shift+Enter for a new line)" : "This conversation is finished — a prompt starts nothing here."}
              disabled={!live}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKey}
            />
            <ImagePicker images={images} onChange={setImages} />
          </div>
          <button type="submit" className="send" disabled={!live || sending || !draft.trim()} aria-label="Send">
            ↑
          </button>
        </form>
      )}
    </div>
  );
}

/**
 * One stage section. `turn` sections render their output as block cards,
 * container sections recurse, and a finished leaf (packages, setup) starts
 * collapsed — the web UI's open policy.
 */
function SectionView({ section, visible, conversationId }: { section: Section; visible: Set<string>; conversationId: string }) {
  const mode = childMode(section);
  const state = section.ended?.state ?? (section.started ? "started" : "unknown");
  const hiddenStage = !visible.has("stage");
  const shown = section.children.filter((c) => isSection(c) || eventVisible(c, visible));

  // Adjacent output events render as one arranged run; nested sections in place.
  const runs: Array<{ kind: "run"; events: LogEvent[] } | { kind: "section"; section: Section }> = [];
  for (const child of shown) {
    if (isSection(child)) runs.push({ kind: "section", section: child });
    else {
      const last = runs[runs.length - 1];
      if (last && last.kind === "run") last.events.push(child);
      else runs.push({ kind: "run", events: [child] });
    }
  }

  const body = (
    <>
      {section.turn && (
        <div className="stage-prompt">
          <div className="label">👤 prompt</div>
          <div className="md">{renderMarkdown(section.turn.prompt)}</div>
          {section.turn.image_count > 0 && <TurnImages conversationId={conversationId} turn={section.turn} />}
        </div>
      )}
      <div className="stage-blocks">
        {runs.map((r, i) =>
          r.kind === "section" ? (
            <SectionView key={r.section.key} section={r.section} visible={visible} conversationId={conversationId} />
          ) : mode === "text" ? (
            <pre key={i} className="stage-text">
              {r.events.map((e, j) => (
                <span key={j} className={e.stream === "stderr" ? "rose" : ""}>
                  {e.data}
                </span>
              ))}
            </pre>
          ) : (
            <div key={i} className="stage-run">
              {arrange(r.events.filter((e) => e.kind === "output")).map((b, j) => (
                <BlockView key={j} block={b} />
              ))}
              {r.events
                .filter((e) => e.kind === "stage")
                .map((e) => (
                  <LooseEvent key={e.id} ev={e} visible={visible} />
                ))}
            </div>
          ),
        )}
      </div>
    </>
  );

  if (hiddenStage) return <div className={`stage ${state} no-stage`}>{body}</div>;

  return (
    <details className={`stage ${state}`} open={defaultOpen(section)}>
      <summary className="stage-head">
        <span className="stage-dot" />
        <span className="stage-icon">{stageIcon(section.stage)}</span>
        <span className="stage-name">{section.stage}</span>
        {section.turn && <span className="stage-turn">turn {section.turn.turn_number}</span>}
        <span className={`stage-state ${state}`}>{state}</span>
        <span className="stage-dur muted">{formatDurationMs(sectionDuration(section))}</span>
        <span className="stage-extra mono muted ellipsis">{stageExtra(section.started?.data ?? section.ended?.data)}</span>
        <span className="stage-time muted">{formatClock(section.started?.ts ?? section.ended?.ts)}</span>
      </summary>
      {body}
    </details>
  );
}

function LooseEvent({ ev, visible }: { ev: LogEvent; visible: Set<string> }) {
  if (!eventVisible(ev, visible)) return null;
  if (ev.kind === "stage") {
    return (
      <div className="stage-loose mono muted">
        {stageIcon(ev.stage)} {ev.stage}/{ev.state} {formatClock(ev.ts)}
        {ev.duration_ms != null && ` · ${formatDurationMs(ev.duration_ms)}`} {stageExtra(ev.data)}
      </div>
    );
  }
  return (
    <>
      {arrange([ev]).map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </>
  );
}

function ChatTurn({
  turn,
  events,
  conversationId,
  agentName,
  glyph,
  avatar,
}: {
  turn: Turn;
  events: LogEvent[];
  conversationId: string;
  agentName: string;
  glyph: string;
  avatar: ReactNode;
}) {
  const blocks = useMemo(() => arrange(events, new Set(["acp", "stdout"])), [events]);
  const inFlight = turn.status === "pending" || turn.status === "running";
  const failed = turn.status === "failed" || turn.status === "cancelled" || turn.status === "interrupted";
  return (
    <div className="turn">
      <div className="bubble you">
        <div className="body">{turn.prompt}</div>
        {turn.image_count > 0 && <TurnImages conversationId={conversationId} turn={turn} />}
        <div className="meta">{formatTime(turn.started_at ?? turn.inserted_at)}</div>
      </div>
      <div className="them-label muted small">
        <span className="them-avatar">{avatar ?? <span className="glyph">{glyph}</span>}</span>
        {agentName}
      </div>
      {blocks
        .filter((b) => b.kind !== "init" && b.kind !== "result")
        .map((b, i) => (
          <BlockView key={i} block={b} bubble />
        ))}
      {inFlight && blocks.length === 0 && (
        <div className="bubble them typing">
          <span />
          <span />
          <span />
        </div>
      )}
      {inFlight && blocks.length > 0 && <div className="muted small typing-note">working…</div>}
      {failed && <div className="muted small typing-note">turn {turn.status}</div>}
    </div>
  );
}

function TreeList({ nodes, currentId }: { nodes: TreeNode[]; currentId: string }) {
  const children = new Map<string | null, TreeNode[]>();
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    const p = n.parent_id && ids.has(n.parent_id) ? n.parent_id : null;
    const arr = children.get(p) ?? [];
    arr.push(n);
    children.set(p, arr);
  }
  const render = (n: TreeNode, depth: number): ReactNode => (
    <div key={n.id}>
      <a href={paths.show(n.id)} className={`tree-node ${n.id === currentId ? "current" : ""}`} style={{ paddingLeft: 8 + depth * 14 }}>
        <span className={`pill tiny ${n.status}`}>{n.status}</span>
        <span className="mono">{shortId(n.id)}</span>
        <span className="muted">{n.source}</span>
      </a>
      {(children.get(n.id) ?? []).map((c) => render(c, depth + 1))}
    </div>
  );
  return <div>{(children.get(null) ?? []).map((r) => render(r, 0))}</div>;
}
