import { useEffect, useMemo, useState } from "react";
import type { FountainClient } from "../api/client";
import { describeError } from "../api/client";
import type { HistoryConversation, LogEvent, Teammate, Turn } from "../api/types";
import { formatUsage } from "../lib/format";
import { formatTime } from "./Roster";
import { TurnView } from "./Thread";
import { resolutions as resolutionsFrom } from "../lib/permissions";
import { transcriptUrl } from "../lib/transcript";

const THREAD_STREAMS = ["acp", "stdout", "stage"];

/**
 * A teammate's previous conversations (after OpenMausBot's task picker,
 * adapted to one-live-conversation-per-teammate): the retired threads of
 * earlier computers, newest first, each readable in place. Read-only —
 * the live one is the thread.
 */
export function History({
  client,
  teammate,
  onClose,
  onOpenCurrent,
  onRetire,
  fountainUrl,
}: {
  client: FountainClient;
  teammate: Teammate;
  onClose: () => void;
  onOpenCurrent: () => void;
  /** Start a fresh thread: on the same computer (default), or — `newComputer` — terminating this one. */
  onRetire: (newComputer: boolean) => void;
  fountainUrl: string;
}) {
  const [rows, setRows] = useState<HistoryConversation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .teammateHistory(teammate.agent_id)
      .then((r) => !cancelled && setRows(r))
      .catch((err) => !cancelled && setError(describeError(err)));
    return () => {
      cancelled = true;
    };
  }, [client, teammate.agent_id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (openId) setOpenId(null);
      else onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, openId]);

  const open = rows?.find((r) => r.id === openId) ?? null;

  return (
    <div className="modal-root">
      <div className="backdrop" onClick={onClose} />
      <div className={`modal wide history ${open ? "reading" : ""}`} role="dialog" aria-label={`History of ${teammate.name}`}>
        <header>
          <h2>
            {open ? (
              <>
                <button type="button" className="linkish" onClick={() => setOpenId(null)}>
                  ‹ History
                </button>{" "}
                · {open.title || "Untitled"}
              </>
            ) : (
              `${teammate.name} — history`
            )}
          </h2>
          <button type="button" className="icon" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        {error && <div className="error">{error}</div>}
        {!open && rows === null && !error && <div className="muted">Loading…</div>}
        {!open && rows && (
          <ul className="history-list">
            {rows.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  className={`history-row ${r.current ? "current" : ""}`}
                  onClick={() => (r.current ? onOpenCurrent() : setOpenId(r.id))}
                >
                  <div className="history-line">
                    <span className="name">
                      {r.title || "Untitled"}
                      {r.current && <span className="tag">current</span>}
                      {r.status === "terminated" && !r.current && (
                        <span className="tag">{sameComputer(r, teammate) ? "retired" : "computer shut down"}</span>
                      )}
                    </span>
                    <span className="time">{formatTime(r.last_active_at ?? r.inserted_at)}</span>
                  </div>
                  <div className="muted small">
                    {r.turn_count} turn{r.turn_count === 1 ? "" : "s"}
                    {formatUsage(r.usage_total) ? ` · ${formatUsage(r.usage_total)}` : ""}
                    {r.sandbox?.runner ? ` · on ${r.sandbox.runner.name}` : r.sandbox ? ` · ${r.sandbox.sprite_name}` : ""}
                    {" · started "}
                    {formatTime(r.inserted_at)}
                  </div>
                </button>
              </li>
            ))}
            {rows.length === 0 && <li className="muted">No conversations yet.</li>}
          </ul>
        )}
        {!open && rows && (
          <div className="row end">
            {teammate.conversation.status !== "terminated" && (
              <button
                type="button"
                className="secondary small"
                onClick={() => onRetire(true)}
                title="End the current conversation and shut down its computer; it stays here and a new computer starts now for the new thread"
              >
                Fresh thread on a new computer…
              </button>
            )}
            <button
              type="button"
              className="secondary small"
              onClick={() => onRetire(false)}
              title="Retire the current conversation and start a new one on the same computer — files and tools stay, the context is fresh; the old thread stays here"
            >
              Start a fresh thread…
            </button>
          </div>
        )}
        {open && <ReadOnlyThread client={client} conversation={open} />}
        {open && (
          <div className="row end">
            <a className="button secondary small" href={transcriptUrl(fountainUrl, open.id)} target="_blank" rel="noreferrer">
              Open in Fountain
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Whether a retired thread ran on the computer the teammate is still using — a "Start a fresh
 * thread" (same computer) retirement, as opposed to one whose computer was shut down.
 */
function sameComputer(r: HistoryConversation, teammate: Teammate): boolean {
  const cur = teammate.conversation;
  return cur.status !== "terminated" && cur.status !== "failed" && !!r.sandbox_id && r.sandbox_id === cur.sandbox_id;
}

/** The turns of a retired conversation, rendered like the thread but with nothing to send. */
function ReadOnlyThread({ client, conversation }: { client: FountainClient; conversation: HistoryConversation }) {
  const [turns, setTurns] = useState<Turn[] | null>(null);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTurns(null);
    Promise.all([client.listTurns(conversation.id), client.listAllEvents(conversation.id, THREAD_STREAMS)])
      .then(([t, e]) => {
        if (cancelled) return;
        setTurns(t);
        setEvents(e);
      })
      .catch((err) => !cancelled && setError(describeError(err)));
    return () => {
      cancelled = true;
    };
  }, [client, conversation.id]);

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

  // Every permission request in a retired conversation is over; passing the
  // resolutions is what lets each card say how, rather than only that it did.
  const askResolutions = useMemo(() => resolutionsFrom(events), [events]);

  if (error) return <div className="error">{error}</div>;
  if (turns === null) return <div className="muted">Loading…</div>;
  return (
    <div className="messages readonly">
      {turns.length === 0 && <div className="muted">Nothing was said in this conversation.</div>}
      {turns.map((t) => (
        <TurnView
          key={t.id}
          client={client}
          conversationId={conversation.id}
          turn={t}
          events={byTurn.get(t.id) ?? []}
          runtime={conversation.runtime}
          highlighted={false}
          askResolutions={askResolutions}
        />
      ))}
    </div>
  );
}
