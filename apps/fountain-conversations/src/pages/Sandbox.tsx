/**
 * One machine: what it is and the conversation it runs. Every conversation
 * gets a sandbox of its own, reclaimed with it.
 */
import { useEffect, useState } from "react";
import { useStore } from "../store";
import { paths } from "../router";
import { describeError } from "../api/client";
import type { SandboxDetail } from "../api/types";
import { conversationLabel, formatTime, shortId } from "../lib/format";
import { StatusPill } from "../components/StatusPill";

export function SandboxPage({ id }: { id: string }) {
  const { client, agents, conversations } = useStore();
  const [sandbox, setSandbox] = useState<SandboxDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  // Re-read whenever the list changes: a conversation starting or ending on
  // this machine reaches the store first (stage events), and the machine's
  // status and mid-turn flags follow.
  useEffect(() => {
    let cancelled = false;
    client
      .getSandbox(id)
      .then((s) => {
        if (cancelled) return;
        setSandbox(s);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        if ((err as { status?: number }).status === 404) setNotFound(true);
        else setError(describeError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [client, id, conversations]);

  useEffect(() => {
    document.title = sandbox ? `${sandbox.sprite_name} · Machines` : "Machine";
  }, [sandbox]);

  if (notFound) {
    return (
      <div className="page">
        <div className="empty">
          <p>That machine does not exist (or is not yours).</p>
          <a href={paths.index}>Back to conversations</a>
        </div>
      </div>
    );
  }
  if (!sandbox) {
    return <div className="page">{error ? <div className="error">{error}</div> : <div className="muted">Loading…</div>}</div>;
  }

  const agent = sandbox.agent_id ? agents.get(sandbox.agent_id) ?? null : null;
  const busy = sandbox.conversations.filter((c) => c.mid_turn).length;

  return (
    <div className="page narrow">
      <header className="page-header">
        <div className="row">
          <a href={paths.index} className="back" aria-label="Back to conversations">
            ‹
          </a>
          <h1>
            <span className="mono">{sandbox.sprite_name}</span>
          </h1>
          <span className={`pill ${sandbox.status}`}>{sandbox.status}</span>
        </div>
      </header>

      {error && <div className="error">{error}</div>}

      <div className="card stack">
        <dl className="facts">
          <dt>Mode</dt>
          <dd>
            {sandbox.mode ?? "—"}
            <span className="hint">One conversation's machine, reclaimed with it.</span>
          </dd>
          <dt>Provider</dt>
          <dd>
            {sandbox.provider ?? "—"}
          </dd>
          <dt>Agent</dt>
          <dd>
            {sandbox.agent_id ? (
              <a href={paths.agent(sandbox.agent_id)}>{agent?.name ?? shortId(sandbox.agent_id)}</a>
            ) : (
              "—"
            )}
          </dd>
          <dt>Environment</dt>
          <dd>{sandbox.environment_id ? <a href={paths.environment(sandbox.environment_id)} className="mono">{shortId(sandbox.environment_id)}</a> : "—"}</dd>
          <dt>Vault</dt>
          <dd>{sandbox.vault_id ? <a href={paths.vault(sandbox.vault_id)} className="mono">{shortId(sandbox.vault_id)}</a> : "none"}</dd>
          <dt>Created</dt>
          <dd>{formatTime(sandbox.inserted_at)}</dd>
          <dt>Last resumed</dt>
          <dd>{sandbox.last_resumed_at ? formatTime(sandbox.last_resumed_at) : <span className="muted">never suspended</span>}</dd>
          {sandbox.url && (
            <>
              <dt>URL</dt>
              <dd>
                <a href={sandbox.url} target="_blank" rel="noreferrer" className="mono">
                  {sandbox.url}
                </a>
              </dd>
            </>
          )}
          <dt>Id</dt>
          <dd className="mono">{sandbox.id}</dd>
        </dl>
      </div>

      <h2 className="section-title">
        Conversations on this machine
        {busy > 0 && <span className="mid-turn"> · {busy} mid-turn</span>}
      </h2>
      {sandbox.conversations.length === 0 && <div className="muted">None yet.</div>}
      {sandbox.conversations.length > 0 && (
        <ul className="conv-list">
          {sandbox.conversations.map((c) => (
            <li key={c.id}>
              <a className="conv-row" href={paths.show(c.id)}>
                <div className="conv-main">
                  <div className="conv-title">
                    <span>{conversationLabel(c)}</span>
                    {c.mid_turn && <span className="tag mid-turn-tag">mid-turn</span>}
                  </div>
                  <div className="conv-sub muted">
                    {c.runtime}
                    <span className="mono"> · {shortId(c.id)}</span>
                  </div>
                </div>
                <div className="conv-side">
                  <StatusPill status={c.status} />
                  <span className="time muted">{formatTime(c.inserted_at)}</span>
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
