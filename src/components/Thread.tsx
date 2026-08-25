import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import type { CommsStatus, Conversation, LogEvent, Teammate, TreeNode, Turn } from "../api/types";
import { describeError, type FountainClient } from "../api/client";
import { blocksForTurn, type Block } from "../lib/acp";
import { loadDraft, saveDraft } from "../lib/drafts";
import { formatUsage } from "../lib/format";
import { imageFilesFrom, readImage, releaseImages, type OutgoingImage } from "../lib/images";
import type { QueuedMessage } from "../lib/queue";
import { isNearBottom, TURN_WINDOW, windowTail } from "../lib/scroll";
import { formatTime } from "./Roster";
import { Markdown } from "./Markdown";
import { Profile } from "./Profile";
import { ContactLine } from "./ContactLine";
import { contactOffer } from "../lib/contact";
import { Activity, type ActivityFocus } from "./Activity";
import { groupBlocks, toolsLabel, duration, type FeedItem } from "../lib/feed";
import { asks as asksFrom, resolutions as resolutionsFrom, type PermissionAsk, type PermissionResolution } from "../lib/permissions";
import { PermissionCard } from "./PermissionCard";
import { transcriptUrl } from "../lib/transcript";
import { threadPresence, threadTitle, viewThrough } from "../lib/threads";

interface Props {
  client: FountainClient;
  teammate: Teammate;
  /** the side thread being shown, or null for the teammate's main thread */
  thread: Conversation | null;
  /** the teammate's side threads: more conversations on the same computer */
  threads: readonly Conversation[];
  onSelectThread: (conversationId: string | null) => void;
  onNewThread: () => void;
  onCloseThread: (conversationId: string) => void;
  turns: Turn[];
  events: LogEvent[];
  queued: readonly QueuedMessage[];
  loading: boolean;
  /** Resolves "sent" or "queued" (the teammate was busy: it waits for the turn to end). */
  onSend: (text: string, images: OutgoingImage[]) => Promise<"sent" | "queued">;
  onCancelQueued: (id: string) => void;
  onInterrupt: () => void;
  onRemove: () => void;
  onBack: () => void;
  onError: (text: string) => void;
  onRoutines: () => void;
  onHistory: () => void;
  /** End the current computer so the next message starts a fresh one (skills/apps land then). */
  onRetire: () => void;
  /** Open the Runners page (how to start `fountain runner`). */
  onRunners: () => void;
  /** Something outside (the row menu) asked for the customize panel; cleared with onCustomizeOpened. */
  customizeRequested: boolean;
  onCustomizeOpened: () => void;
  onRename: (name: string | null) => Promise<void>;
  /** start in the rename editor (from the row menu) */
  renaming: boolean;
  onRenamingChange: (on: boolean) => void;
  /** a turn to scroll to and highlight (from search); cleared by the parent once consumed */
  focusTurnId: string | null;
  onFocused: () => void;
  activityOpen: boolean;
  onActivityChange: (open: boolean) => void;
  /** the agent behind this teammate changed (brain, persona): re-list */
  onAgentChanged: () => void;
  /** this is the only teammate on the team (the /create-team tip shows) */
  onlyTeammate: boolean;
  /** whether teammates can be given an email + phone here (null: not offered) */
  comms: CommsStatus | null;
  onGiveContact: () => void;
  onReleaseContact: () => void;
  onChangeContactNumber: () => void;
  fountainUrl: string;
}

export function Thread({
  client,
  teammate,
  thread,
  threads,
  onSelectThread,
  onNewThread,
  onCloseThread,
  turns,
  events,
  queued,
  loading,
  onSend,
  onCancelQueued,
  onInterrupt,
  onRemove,
  onBack,
  onError,
  onRoutines,
  onHistory,
  onRetire,
  onRunners,
  customizeRequested,
  onCustomizeOpened,
  onRename,
  renaming,
  onRenamingChange,
  focusTurnId,
  onFocused,
  activityOpen,
  onActivityChange,
  onAgentChanged,
  onlyTeammate,
  comms,
  onGiveContact,
  onReleaseContact,
  onChangeContactNumber,
  fountainUrl,
}: Props) {
  // On a side thread, the conversation and its presence are the thread's; the
  // person (name, agent, contact, usage) stays the teammate's.
  const view = thread ? viewThrough(teammate, thread) : teammate;
  const conv = view.conversation;
  const machineOffline = view.presence.state === "machine_offline";
  // "starting" is deliberately not busy: the send is attempted and the server
  // decides (503 → queued). A stale "starting" must not lock the composer.
  const busy = machineOffline || view.presence.state === "working" || conv.status === "running";
  const runner = conv.sandbox?.runner ?? null;
  // A conversation opened without a prompt stays "pending" until its first
  // turn, and the server reads that as "starting computer" even once the
  // sandbox is ready (fountain#839). Read the sandbox too.
  const sandboxReady = view.presence.state === "starting" && conv.sandbox?.status === "ready";
  const presenceState = sandboxReady ? "online" : view.presence.state;
  const presenceLabel = sandboxReady ? "ready" : view.presence.label;
  const [draft, setDraft] = useState(() => loadDraft(conv.id));
  const [images, setImages] = useState<OutgoingImage[]>([]);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [visible, setVisible] = useState(TURN_WINDOW);
  const [following, setFollowing] = useState(true);
  const [pendingBelow, setPendingBelow] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const growRef = useRef<{ from: number; top: number } | null>(null);

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

  // A permission request's two halves arrive on different events. The block is
  // on the `acp` stream and carries a turn_id, so it lands in the map above;
  // the `request` stage events do not carry one, so they are read from the
  // whole conversation and paired to the block on request_id.
  const askResolutions = useMemo(() => resolutionsFrom(events), [events]);
  const askDetails = useMemo(() => asksFrom(events), [events]);

  const answerRequest = useCallback(
    async (requestId: string, optionId: string) => {
      try {
        await client.answerRequest(conv.id, requestId, optionId);
      } catch (err) {
        // Thrown on, not toasted: this is the answer to a question that is on
        // screen, so it belongs on that card — and the card has to know the
        // answer did not land, or it locks itself waiting for a stage event
        // that is never coming. A 409 is "something else got there first",
        // which the stream is about to say anyway.
        throw new Error(describeError(err));
      }
    },
    [client, conv.id],
  );

  const { shown, hidden } = useMemo(() => windowTail(turns, visible), [turns, visible]);

  // ── scrolling: follow the bottom until the reader scrolls up ─────────────

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setFollowing(true);
    setPendingBelow(false);
  }, []);

  // A new conversation: fresh window, jump to the bottom.
  useLayoutEffect(() => {
    setVisible(TURN_WINDOW);
    setFollowing(true);
    setPendingBelow(false);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conv.id]);

  // New content: stick to the bottom only if we were there.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (growRef.current) {
      // "Show earlier" grew the top: keep what the reader was looking at in place.
      el.scrollTop = el.scrollHeight - growRef.current.from + growRef.current.top;
      growRef.current = null;
      return;
    }
    if (following) el.scrollTop = el.scrollHeight;
    else setPendingBelow(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events.length, turns.length, queued.length, loading]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const near = isNearBottom(el);
    setFollowing(near);
    if (near) setPendingBelow(false);
  };

  // Jump to a turn (from search): widen the window until it renders, then
  // scroll it into view and highlight it for a moment.
  const [highlight, setHighlight] = useState<string | null>(null);
  useEffect(() => {
    if (!focusTurnId) return;
    const idx = turns.findIndex((t) => t.id === focusTurnId);
    if (idx === -1) return; // not (yet) in this conversation's turns
    const needed = turns.length - idx;
    if (needed > visible) {
      setVisible(Math.ceil(needed / TURN_WINDOW) * TURN_WINDOW);
      return; // re-run once the window grew
    }
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-turn-id="${focusTurnId}"]`);
    if (!el) return;
    setFollowing(false);
    el.scrollIntoView({ block: "center" });
    setHighlight(focusTurnId);
    // not cleaned up on purpose: onFocused() clears focusTurnId, which would
    // cancel the timeout before it ran and leave the highlight on
    window.setTimeout(() => setHighlight((h) => (h === focusTurnId ? null : h)), 2500);
    onFocused();
  }, [focusTurnId, turns, visible, onFocused]);

  // The spawn tree: what this teammate started (sub-conversations over the API).
  const [profileOpen, setProfileOpen] = useState(false);
  useEffect(() => {
    if (!customizeRequested) return;
    setProfileOpen(true);
    onCustomizeOpened();
  }, [customizeRequested, onCustomizeOpened]);
  // "Loading…" only after a beat: a fast load should paint the thread, not a blink of text
  const [slowLoad, setSlowLoad] = useState(false);
  useEffect(() => {
    if (!loading) {
      setSlowLoad(false);
      return;
    }
    const t = window.setTimeout(() => setSlowLoad(true), 350);
    return () => window.clearTimeout(t);
  }, [loading, conv.id]);
  const [activityFocus, setActivityFocus] = useState<ActivityFocus | null>(null);
  const openActivityAt = useCallback(
    (turnId: string, index: number) => {
      onActivityChange(true);
      setActivityFocus({ turnId, index, nonce: Date.now() });
    },
    [onActivityChange],
  );
  const [nameDraft, setNameDraft] = useState(teammate.name);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renaming) {
      setNameDraft(teammate.name);
      window.setTimeout(() => nameRef.current?.select(), 0);
    }
  }, [renaming, teammate.name]);
  const commitRename = async () => {
    const next = nameDraft.trim();
    onRenamingChange(false);
    if (next === teammate.name) return;
    await onRename(next || null);
  };
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [treeOpen, setTreeOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    client
      .tree(conv.id)
      .then((nodes) => !cancelled && setTree(nodes))
      .catch(() => !cancelled && setTree([]));
    return () => {
      cancelled = true;
    };
    // re-read whenever a turn ends (turns.length changes on start; status on end)
  }, [client, conv.id, turns.length, conv.status]);
  const spawned = tree.filter((n) => n.id !== conv.id);

  const showEarlier = () => {
    const el = scrollRef.current;
    if (el) growRef.current = { from: el.scrollHeight, top: el.scrollTop };
    setVisible((v) => v + TURN_WINDOW);
  };

  // ── drafts ───────────────────────────────────────────────────────────────

  useEffect(() => {
    setDraft(loadDraft(conv.id));
    setImages((imgs) => {
      releaseImages(imgs);
      return [];
    });
    textRef.current?.focus();
  }, [conv.id]);

  const onPrefill = (text: string) => {
    changeDraft(text);
    textRef.current?.focus();
  };

  const changeDraft = (text: string) => {
    setDraft(text);
    saveDraft(conv.id, text);
  };

  // ── attachments ──────────────────────────────────────────────────────────

  const attach = useCallback(
    async (files: File[]) => {
      for (const f of files) {
        try {
          const img = await readImage(f);
          setImages((imgs) => [...imgs, img]);
        } catch (err) {
          onError(err instanceof Error ? err.message : String(err));
        }
      }
    },
    [onError],
  );

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = imageFilesFrom(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    void attach(files);
  };

  const onDrop = (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    setDragging(false);
    void attach(imageFilesFrom(e.dataTransfer));
  };

  const removeImage = (i: number) => {
    setImages((imgs) => {
      releaseImages([imgs[i]!]);
      return imgs.filter((_, j) => j !== i);
    });
  };

  // ── sending ──────────────────────────────────────────────────────────────

  async function send() {
    const text = draft.trim();
    if ((!text && images.length === 0) || sending) return;
    setSending(true);
    try {
      await onSend(text, images);
      changeDraft("");
      setImages([]); // previews live on in the queued bubble or are released by App
    } catch {
      /* App already showed the error; keep the draft */
    } finally {
      setSending(false);
      textRef.current?.focus();
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  const canSend = !sending && (draft.trim().length > 0 || images.length > 0);

  return (
    <section
      className={`thread ${dragging ? "dragging" : ""}`}
      onDragOver={(e) => {
        if (imageFilesFrom(e.dataTransfer).length || e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <header className="thread-header">
        <button className="back" onClick={onBack} aria-label="Back to the team">
          ‹ Team
        </button>
        {renaming ? (
          <form
            className="thread-title rename"
            onSubmit={(e) => {
              e.preventDefault();
              void commitRename();
            }}
          >
            <input
              ref={nameRef}
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => void commitRename()}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setNameDraft(teammate.name);
                  onRenamingChange(false);
                }
              }}
              placeholder={teammate.agent.name}
              aria-label="Teammate name"
              maxLength={120}
            />
            <span className="hint">Enter to save · Esc to cancel · empty resets to the agent's name</span>
          </form>
        ) : (
        <button className="thread-title as-button" onClick={() => setProfileOpen(true)} title="Profile: brain, what they do, computer, skills…">
          <div className="name">
            {teammate.name}
            <span className="caret" aria-hidden>
              ▾
            </span>
            <span
              className="rename-pencil"
              role="button"
              tabIndex={0}
              title="Rename"
              aria-label="Rename teammate"
              onClick={(e) => {
                e.stopPropagation();
                onRenamingChange(true);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  onRenamingChange(true);
                }
              }}
            >
              ✎
            </span>
          </div>
          <div className="sub">
            {teammate.name !== teammate.agent.name && <span>{teammate.agent.name} · </span>}
            <span className={`presence inline ${presenceState}`} />
            <span>{presenceLabel}</span>
            {runner ? (
              <span className="muted" title={runner.path ?? undefined}>
                {" "}
                · on <b>{runner.name}</b>
                {runner.path ? <span className="mono"> · {shortPath(runner.path, runner.root ?? null)}</span> : null}
              </span>
            ) : (
              conv.sandbox && <span className="mono muted"> · {conv.sandbox.sprite_name}</span>
            )}
            {formatUsage(teammate.usage_total) && (
              <span className="muted" title="Tokens over every conversation this teammate has had on the team">
                {" "}
                · {formatUsage(teammate.usage_total)}
              </span>
            )}
          </div>
        </button>
        )}
        <div className="row">
          {spawned.length > 0 && (
            <button className="secondary small" onClick={() => setTreeOpen((o) => !o)} title="Conversations this teammate started" aria-expanded={treeOpen}>
              Spawned · {spawned.length}
            </button>
          )}
          <button
            className={`secondary small ${activityOpen ? "active" : ""}`}
            onClick={() => onActivityChange(!activityOpen)}
            title="What they're doing, as they narrate it — tool calls folded"
            aria-pressed={activityOpen}
          >
            Activity
          </button>
          <button className="secondary small" onClick={onRoutines} title="Schedules that run this teammate">
            Routines
          </button>
          <button className="secondary small" onClick={onHistory} title="This teammate's previous conversations">
            History
          </button>
          {conv.status === "running" && (
            <button className="secondary small" onClick={onInterrupt}>
              Interrupt
            </button>
          )}
          <a
            className="button secondary small"
            href={transcriptUrl(fountainUrl, conv.id)}
            target="_blank"
            rel="noreferrer"
            title="The full conversation view in Fountain: stages, tool calls, raw output"
          >
            Details
          </a>
          <button className="danger small" onClick={onRemove}>
            Remove
          </button>
        </div>
      </header>

      {(threads.length > 0 || thread) && (
        <nav className="thread-strip" aria-label={`Threads with ${teammate.name}`}>
          <button className={`thread-tab ${thread ? "" : "active"}`} onClick={() => onSelectThread(null)} aria-current={thread ? undefined : "page"} title="The main thread — the one the team knows">
            <span className={`presence inline ${teammate.presence.state === "starting" && teammate.conversation.sandbox?.status === "ready" ? "online" : teammate.presence.state}`} />
            Main
            {teammate.unread && thread && <span className="unread-dot" title="Unread" />}
          </button>
          {threads.map((c, i) => {
            const active = thread?.id === c.id;
            const p = threadPresence(c, teammate);
            return (
              <span key={c.id} className={`thread-tab-wrap ${active ? "active" : ""}`}>
                <button className={`thread-tab ${active ? "active" : ""}`} onClick={() => onSelectThread(c.id)} aria-current={active ? "page" : undefined} title={`${threadTitle(c, i)} · ${p.label}`}>
                  <span className={`presence inline ${p.state}`} />
                  {threadTitle(c, i)}
                  {c.unread && !active && <span className="unread-dot" title="Unread" />}
                </button>
                {active && (
                  <button className="thread-close" onClick={() => onCloseThread(c.id)} aria-label={`Close ${threadTitle(c, i)}`} title="Close this thread — the computer and the main thread stay">
                    ×
                  </button>
                )}
              </span>
            );
          })}
          <button className="thread-tab new" onClick={onNewThread} title="Another conversation with this teammate on the same computer — same files, its own context">
            + New thread
          </button>
        </nav>
      )}
      {teammate.contact && (
        <div className="contact-bar" role="region" aria-label={`${teammate.name}'s email and phone`}>
          <ContactLine contact={teammate.contact} compact onChangeNumber={onChangeContactNumber} />
          <button type="button" className="secondary small" onClick={onReleaseContact} title="Release the inbox and number upstream; mail and texts to them stop">
            Release…
          </button>
        </div>
      )}
      {profileOpen && (
        <Profile
          client={client}
          teammate={teammate}
          onClose={() => setProfileOpen(false)}
          onAgentChanged={onAgentChanged}
          onRetire={() => {
            setProfileOpen(false);
            onRetire();
          }}
          onRunners={() => {
            setProfileOpen(false);
            onRunners();
          }}
          contactOffer={contactOffer(comms, teammate)}
          onGiveContact={() => {
            setProfileOpen(false);
            onGiveContact();
          }}
          onReleaseContact={() => {
            setProfileOpen(false);
            onReleaseContact();
          }}
          onChangeContactNumber={() => {
            setProfileOpen(false);
            onChangeContactNumber();
          }}
        />
      )}
      {treeOpen && spawned.length > 0 && (
        <div className="spawned">
          <div className="spawned-head small muted">Started by {teammate.name} — sub-conversations in this thread's spawn tree</div>
          <ul>
            {spawned.map((n) => (
              <li key={n.id}>
                <span className={`presence inline ${n.status === "running" ? "working" : n.status === "failed" ? "failed" : "online"}`} />
                <a href={transcriptUrl(fountainUrl, n.id)} target="_blank" rel="noreferrer">
                  {n.title || n.id.slice(0, 8)}
                </a>
                <span className="muted small">
                  {" "}
                  · {n.status}
                  {n.parent_id && n.parent_id !== conv.id ? " · nested" : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="thread-columns">
      <div className="thread-main">
      <div className="messages-wrap">
        <div className="messages" ref={scrollRef} onScroll={onScroll}>
          {loading && slowLoad && <div className="centered muted">Loading…</div>}
          {!loading && hidden > 0 && (
            <button className="secondary small show-earlier" onClick={showEarlier}>
              Show earlier messages ({hidden} more)
            </button>
          )}
          {!loading && turns.length === 0 && queued.length === 0 && (
            <div className="centered muted empty-thread">
              {view.presence.state === "starting" && conv.sandbox?.status !== "ready" ? (
                <>
                  <div className="glyph pulse">🖥️</div>
                  <div>
                    Starting <b>{teammate.name}</b>'s computer…
                  </div>
                  <div className="small">You can type now — it's sent the moment the computer is up.</div>
                </>
              ) : conv.status === "failed" ? (
                <div>
                  <b>{teammate.name}</b>'s computer failed to start — a message tries a new one.
                </div>
              ) : conv.status === "terminated" ? (
                <div>
                  This thread is retired — a message starts <b>{teammate.name}</b> on a fresh computer. The old thread is under History.
                </div>
              ) : (
                <>
                  <div className="glyph">✅</div>
                  <div>
                    <b>{teammate.name}</b>'s computer is ready.
                  </div>
                  <div className="small">
                    Say hello below — or{" "}
                    <button type="button" className="linkish" onClick={() => setProfileOpen(true)}>
                      customize {teammate.name}
                    </button>{" "}
                    first: what they do, which brain, skills, the apps they can use.
                  </div>
                  {onlyTeammate && (
                    <div className="small tip">
                      Tip: your first teammate can set up the rest of the team. Send{" "}
                      <button type="button" className="linkish mono" onClick={() => onPrefill("/create-team")}>
                        /create-team
                      </button>{" "}
                      and it will ask what you want done and propose a roster.
                    </div>
                  )}
                </>
              )}
              <div className="small muted">
                {teammate.agent.runtime} · {teammate.agent.model}
              </div>
            </div>
          )}
          {shown.map((turn) => (
            <TurnView
              key={turn.id}
              client={client}
              conversationId={conv.id}
              turn={turn}
              events={eventsByTurn.get(turn.id) ?? []}
              runtime={conv.runtime}
              highlighted={highlight === turn.id}
              onOpenActivity={(index) => openActivityAt(turn.id, index)}
              teammateName={teammate.name}
              askResolutions={askResolutions}
              askDetails={askDetails}
              onAnswerRequest={answerRequest}
            />
          ))}
          {queued.map((q) => (
            <QueuedView key={q.id} message={q} onCancel={() => onCancelQueued(q.id)} />
          ))}
        </div>
        {pendingBelow && !following && (
          <button className="jump-down" onClick={scrollToBottom}>
            New messages ↓
          </button>
        )}
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {images.length > 0 && (
          <div className="attachments">
            {images.map((img, i) => (
              <div className="attachment" key={img.previewUrl}>
                <img src={img.previewUrl} alt={img.name} title={img.name} />
                <button type="button" className="remove" onClick={() => removeImage(i)} aria-label={`Remove ${img.name}`}>
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="composer-row">
          <button
            type="button"
            className="icon attach"
            onClick={() => fileRef.current?.click()}
            aria-label="Attach an image"
            title="Attach an image (or paste / drop one)"
          >
            +
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            hidden
            onChange={(e) => {
              void attach(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          <textarea
            ref={textRef}
            rows={1}
            value={draft}
            placeholder={
              machineOffline
                ? `Message ${teammate.name}… (queued until ${runner?.name ?? "their machine"} is back online)`
                : busy
                  ? `Message ${teammate.name}… (queued until they're done)`
                  : `Message ${teammate.name}…`
            }
            onChange={(e) => changeDraft(e.target.value)}
            onKeyDown={onKey}
            onPaste={onPaste}
          />
          <button
            type="submit"
            className={`send ${busy ? "queue" : ""}`}
            disabled={!canSend}
            aria-label={busy ? "Queue" : "Send"}
            title={
              machineOffline
                ? "Their machine is offline — this is sent when the runner reconnects (Enter)"
                : busy
                  ? "They're busy — this is sent when the turn ends (Enter)"
                  : "Send (Enter · Shift+Enter for a new line)"
            }
          >
            {busy ? "⏱" : "↑"}
          </button>
        </div>
      </form>
      </div>
      {activityOpen && (
        <Activity teammate={teammate} turns={turns} events={events} focus={activityFocus} onClose={() => onActivityChange(false)} />
      )}
      </div>
    </section>
  );
}

function QueuedView({ message, onCancel }: { message: QueuedMessage; onCancel: () => void }) {
  return (
    <div className="turn">
      <div className="bubble you queued">
        {message.images.length > 0 && (
          <div className="bubble-images">
            {message.images.map((img) => (
              <img key={img.previewUrl} src={img.previewUrl} alt={img.name} />
            ))}
          </div>
        )}
        {message.text && <div className="body">{message.text}</div>}
        <div className="meta">
          queued · sent when they're done ·{" "}
          <button type="button" className="link" onClick={onCancel}>
            cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** "~/…" inside a runner's root, so the header does not carry a 70-character path. */
export function shortPath(path: string, root: string | null): string {
  if (root && path.startsWith(root)) return `…${path.slice(root.length)}`;
  return path.replace(/^\/Users\/[^/]+|^\/home\/[^/]+/, "~");
}

export function TurnView({
  client,
  conversationId,
  turn,
  events,
  runtime,
  highlighted,
  onOpenActivity,
  teammateName = "They",
  askResolutions,
  askDetails,
  onAnswerRequest,
}: {
  client: FountainClient;
  conversationId: string;
  turn: Turn;
  events: LogEvent[];
  runtime: string;
  highlighted: boolean;
  /** the chat shows a tool run as a status line; clicking it opens the feed at that run */
  onOpenActivity?: (itemIndex: number) => void;
  /** who is asking, for the permission card's "<name> wants to run …" */
  teammateName?: string;
  /** request_id → how it ended; from the conversation's `request` stage events */
  askResolutions?: ReadonlyMap<string, PermissionResolution>;
  /** request_id → the ask, for its timeout */
  askDetails?: ReadonlyMap<string, PermissionAsk>;
  /** absent in a read-only view (History): the card renders without buttons */
  onAnswerRequest?: (requestId: string, optionId: string) => Promise<void>;
}) {
  const blocks = useMemo(() => blocksForTurn(events, runtime), [events, runtime]);
  const items = useMemo(() => groupBlocks(blocks), [blocks]);
  const inFlight = turn.status === "pending" || turn.status === "running";
  const failed = turn.status === "failed" || turn.status === "cancelled";
  const usage = formatUsage(turn.usage);
  // The reply's last text bubble wears the time its last chunk landed, like
  // the user's bubble does; earlier bubbles keep theirs on hover so a long
  // text → tool → text turn isn't a column of clocks.
  const lastText = !inFlight ? items.map((it) => it.kind).lastIndexOf("text") : -1;
  return (
    <div className={`turn ${highlighted ? "highlight" : ""}`} data-turn-id={turn.id}>
      <div className="bubble you">
        {turn.image_count > 0 && <TurnImages client={client} conversationId={conversationId} turn={turn} />}
        {turn.prompt && <div className="body">{turn.prompt}</div>}
        <div className="meta">{formatTime(turn.inserted_at)}</div>
      </div>
      {items.map((item, i) => {
        if (item.kind === "permission") {
          const req = item.request;
          return (
            <PermissionCard
              key={i}
              request={req}
              name={teammateName}
              resolution={askResolutions?.get(req.requestId) ?? null}
              timeoutMs={askDetails?.get(req.requestId)?.timeoutMs ?? null}
              live={inFlight && onAnswerRequest !== undefined}
              onAnswer={(optionId) => onAnswerRequest?.(req.requestId, optionId) ?? Promise.resolve()}
            />
          );
        }
        if (item.kind !== "tools") return <BlockView key={i} block={item} stamp={i === lastText ? "show" : "hover"} />;
        const { verb, what, running } = toolsLabel(item.tools);
        const single = item.tools.length === 1 ? item.tools[0]! : null;
        const dur = single ? duration(single.startedAt, single.endedAt) : null;
        const failed = item.tools.some((t) => t.status === "error");
        return (
          <button
            key={i}
            type="button"
            className={`tools-hint ${running ? "running" : ""} ${failed ? "failed" : ""}`}
            onClick={onOpenActivity ? () => onOpenActivity(i) : undefined}
            disabled={!onOpenActivity}
            title={onOpenActivity ? "Open in Activity" : undefined}
          >
            <span className="verb">{verb}</span> <span className="what">{what}</span>
            {dur && <span className="dur">{dur}</span>}
            {running && <span className="dots" aria-hidden />}
            {failed && <span className="tool-status">✕</span>}
            {onOpenActivity && <span className="chev">›</span>}
          </button>
        );
      })}
      {inFlight && blocks.length === 0 && (
        <div className="bubble them typing">
          <span />
          <span />
          <span />
        </div>
      )}
      {inFlight && blocks.length > 0 && <div className="muted small typing-note">typing…</div>}
      {failed && <div className="muted small typing-note">turn {turn.status}</div>}
      {!inFlight && usage && (
        <div className="muted small typing-note usage" title="Tokens the runtime reported for this turn">
          {usage}
        </div>
      )}
    </div>
  );
}

/** The images the API stored with a turn, fetched with the bearer key. */
function TurnImages({ client, conversationId, turn }: { client: FountainClient; conversationId: string; turn: Turn }) {
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    const made: string[] = [];
    Promise.all(
      Array.from({ length: turn.image_count }, (_, i) =>
        client
          .turnImageUrl(conversationId, turn.id, i)
          .then((u) => {
            made.push(u);
            return u;
          })
          .catch(() => null),
      ),
    ).then((us) => {
      if (!cancelled) setUrls(us.filter((u): u is string => u !== null));
    });
    return () => {
      cancelled = true;
      for (const u of made) URL.revokeObjectURL(u);
    };
  }, [client, conversationId, turn.id, turn.image_count]);
  if (!urls.length) return <div className="meta">{turn.image_count} image{turn.image_count === 1 ? "" : "s"}</div>;
  return (
    <div className="bubble-images">
      {urls.map((u) => (
        <a key={u} href={u} target="_blank" rel="noreferrer">
          <img src={u} alt="" />
        </a>
      ))}
    </div>
  );
}

function BlockView({ block, stamp = "hover" }: { block: Exclude<FeedItem, { kind: "tools" }> | Block; stamp?: "show" | "hover" }) {
  switch (block.kind) {
    case "text": {
      const at = block.endedAt;
      const title = at ? `Received ${new Date(at).toLocaleString()}` : undefined;
      return (
        <div className="bubble them" title={stamp === "hover" ? title : undefined}>
          <div className="body">
            <Markdown text={block.body} />
          </div>
          {stamp === "show" && at && (
            <div className="meta" title={title}>
              {formatTime(at)}
            </div>
          )}
        </div>
      );
    }
    case "thinking":
      return (
        <details className="thinking">
          <summary>thinking</summary>
          <div className="body">{block.body}</div>
        </details>
      );
    case "tool":
      return (
        <details className={`tool ${block.status}`}>
          <summary>
            <span className="tool-name">{block.name}</span>
            {block.summary && <span className="tool-summary">{block.summary}</span>}
            <span className="tool-status">{block.status === "running" ? "…" : block.status === "done" ? "✓" : "✕"}</span>
          </summary>
          {block.output && <pre>{block.output}</pre>}
        </details>
      );
    case "raw":
      return <pre className="raw">{block.body}</pre>;
    // A permission request is not a bubble — TurnView renders it as a card
    // before it reaches here, because it needs the conversation's stage
    // events to know how it ended.
    case "permission":
      return null;
  }
}
