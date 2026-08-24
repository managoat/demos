/**
 * The digest on a work item: what happened on it since you last looked.
 *
 * The derivation is src/lib/digest.ts; this reads the events it needs and
 * renders them. The `stage` stream is what a lifecycle is written on — a few
 * rows for even a long conversation — so the history behind the panel is one
 * small GET per conversation on the item, and the project's own SSE stream
 * keeps it current after that.
 *
 * **The mark moves when you open the item**, the way `markRead` moves a
 * conversation's the moment its thread is on screen. `since` is read once,
 * before the write, so this visit still shows what the last one missed; the
 * next visit starts from here. "Caught up" moves it by hand without leaving.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useProject } from "../store";
import type { Agent, Conversation, SandboxRecord, UserEvent } from "../types";
import { digestLine, digestOf, loadSeen, saveSeen, timeLeft, type Digest, type Waiting } from "../lib/digest";
import { computerLabel, relativeTime } from "../lib/sidebar";
import { href } from "../router";
import { AgentAvatar } from "./AgentAvatar";

/** How often the panel re-reads the clock: a held request expires on one. */
const TICK_MS = 15_000;

export function ItemDigest({ itemId, conversations }: { itemId: string; conversations: Conversation[] }) {
  const { project, fountain, agents, sandboxes, subscribe } = useProject();
  // Read before the effect below writes the new one.
  const [since, setSince] = useState<string | null>(() => loadSeen(itemId));
  const [events, setEvents] = useState<UserEvent[]>([]);
  const [now, setNow] = useState(() => Date.now());
  /** Per conversation, the last log-event id read out of its history. */
  const cursors = useRef(new Map<string, number>());

  // The conversation list is replaced on every line of runtime output, so both
  // of these hang off what the digest actually reads rather than off the array:
  // re-deriving three times a second while an agent talks is the churn the
  // explorer's module doc is about.
  const ids = useMemo(() => conversations.map((c) => c.id).sort().join(","), [conversations]);
  const shape = useMemo(() => conversations.map((c) => `${c.id}:${c.status}:${c.sandbox_id ?? ""}`).sort().join(","), [conversations]);
  const refs = useMemo(
    () => conversations.map((c) => ({ id: c.id, status: c.status, sandbox_id: c.sandbox_id ?? null })),
    [shape], // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    saveSeen(itemId);
  }, [itemId]);

  // The lifecycle so far, per conversation, from where we have read to. Keyed
  // on `shape` rather than `ids` because the user-wide stream only follows
  // unfinished conversations: a turn that fails fast, or a computer torn down,
  // can leave a gap the stream never fills, and the status flip that goes with
  // it is the cue to go and read it. A conversation that will not answer
  // (deleted, a Fountain hiccup) contributes nothing rather than sinking the panel.
  useEffect(() => {
    if (!shape) return;
    let cancelled = false;
    const list = shape.split(",").map((s) => s.split(":")[0]!);
    void Promise.all(
      list.map((id) =>
        fountain
          .resume(id)
          .history({ streams: ["stage"], after: cursors.current.get(id) ?? 0 })
          .then((evs) => evs.map((e): UserEvent => ({ ...e, conversation_id: id })))
          .catch((): UserEvent[] => []),
      ),
    ).then((pages) => {
      if (cancelled) return; // the cursors stay put, so the next run reads the same span
      const fresh = pages.flat();
      for (const e of fresh) cursors.current.set(e.conversation_id, Math.max(cursors.current.get(e.conversation_id) ?? 0, e.id));
      setEvents((prev) => merge(prev, fresh));
    });
    return () => {
      cancelled = true;
    };
  }, [shape, fountain]);

  // And what happens from here, off the stream the store already holds open.
  useEffect(() => {
    if (!ids) return;
    const offs = ids.split(",").map((id) =>
      subscribe(id, (ev) => {
        if (ev.kind !== "stage") return;
        setEvents((prev) => (prev.some((e) => e.id === ev.id) ? prev : [...prev, ev]));
      }),
    );
    return () => offs.forEach((off) => off());
  }, [ids, subscribe]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, []);

  const digest = useMemo(() => digestOf({ events, conversations: refs, since, now }), [events, refs, since, now]);

  const caughtUp = useCallback(() => {
    const iso = new Date().toISOString();
    saveSeen(itemId, iso);
    setSince(iso);
  }, [itemId]);

  if (conversations.length === 0) return null;

  return <DigestPanel digest={digest} projectId={project.id} conversations={conversations} agents={agents} sandboxes={sandboxes} now={now} onCaughtUp={caughtUp} />;
}

export interface DigestPanelProps {
  digest: Digest;
  projectId: string;
  conversations: Conversation[];
  agents: ReadonlyMap<string, Agent>;
  sandboxes: ReadonlyMap<string, SandboxRecord>;
  now: number;
  onCaughtUp: () => void;
}

/** The panel itself, as a function of a digest — everything above is what fills it. */
export function DigestPanel({ digest, projectId, conversations, agents, sandboxes, now, onCaughtUp }: DigestPanelProps) {
  const counts = digestLine(digest);
  const blocked = digest.waiting.length;

  return (
    <section className={`card digest ${blocked ? "blocked" : ""}`}>
      <div className="row">
        <h2 className="h2">While you were away</h2>
        <span className="muted small">{digest.since ? `since ${relativeTime(digest.since, now)}` : "since this item started"}</span>
        <span className="spacer" />
        {!digest.quiet && (
          <button className="linklike" onClick={onCaughtUp} title="Start the digest from now">
            Caught up
          </button>
        )}
      </div>

      {blocked > 0 && (
        <div className="digest-blocked">
          <div className="strong">
            {blocked} agent{blocked === 1 ? " is" : "s are"} blocked waiting on you
          </div>
          <ul className="digest-asks">
            {digest.waiting.map((w) => (
              <WaitingRow key={`${w.conversationId}:${w.requestId}`} waiting={w} projectId={projectId} conversations={conversations} agents={agents} now={now} />
            ))}
          </ul>
        </div>
      )}

      {counts && <p className="digest-counts">{counts}</p>}

      {digest.gone.length > 0 && (
        <ul className="digest-gone muted small">
          {digest.gone.map((g) => (
            <li key={g.key}>
              🖥 {g.key.startsWith("conv:") ? "a computer" : computerLabel({ sandbox: sandboxes.get(g.key) ?? null, sandboxId: g.key })}{" "}
              {g.event === "retired" ? "was retired" : `was ${g.event}`} · {relativeTime(g.at, now)}
              {g.message ? ` — ${g.message}` : ""}
            </li>
          ))}
        </ul>
      )}

      {digest.quiet && <p className="muted small">Nothing new.</p>}
    </section>
  );
}

function WaitingRow({
  waiting,
  projectId,
  conversations,
  agents,
  now,
}: {
  waiting: Waiting;
  projectId: string;
  conversations: Conversation[];
  agents: ReadonlyMap<string, Agent>;
  now: number;
}) {
  const conv = conversations.find((c) => c.id === waiting.conversationId) ?? null;
  const agent = conv?.agent_id ? agents.get(conv.agent_id) ?? null : null;
  return (
    <li>
      <a className="digest-ask" href={href.conversation(projectId, waiting.conversationId)}>
        {agent && <AgentAvatar agent={agent} size={22} />}
        <span className="min0 grow">
          <span className="strong">{agent?.name ?? conv?.title ?? conv?.runtime ?? "an agent"}</span>
          <span className="muted small ellipsis"> wants to run {waiting.tool ?? "a tool"}</span>
        </span>
        <span className="pill pending tiny">{timeLeft(waiting.expiresAt, now)}</span>
      </a>
    </li>
  );
}

/** `base` plus whatever in `extra` it does not already hold, in id order. */
function merge(base: UserEvent[], extra: UserEvent[]): UserEvent[] {
  if (extra.length === 0) return base;
  const seen = new Set(base.map((e) => e.id));
  const out = [...base];
  for (const e of extra) if (!seen.has(e.id)) out.push(e);
  return out.sort((a, b) => a.id - b.id);
}
