/** The project's work: its items, open then done, and a form for the next one. */
import { useState, type FormEvent } from "react";
import { useProject } from "../store";
import { channelIsItem } from "../lib/workbench";
import { href, navigate } from "../router";
import { TwoStep } from "../components/Thread";
import { AgentAvatar } from "../components/AgentAvatar";
import { formatTime } from "../lib/format";

export function Project() {
  const { project, items, isOwner, conversations, agents, environments, vaults, createItem, updateItem, removeItem } = useProject();
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [showDone, setShowDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    const w = await createItem(title, notes);
    setBusy(false);
    if (!w) return;
    setTitle("");
    setNotes("");
    navigate(href.item(project.id, w.id));
  }

  const open = items.filter((w) => w.status === "open");
  const done = items.filter((w) => w.status === "done");
  const envName = project.environmentId ? environments.get(project.environmentId)?.name ?? "?" : "each agent's own";
  const vaultName = project.vaultId ? vaults.get(project.vaultId)?.name ?? "?" : "none";

  const row = (w: (typeof items)[number]) => {
    const convs = conversations.filter((c) => channelIsItem(c.channel_id, project.id, w.id));
    const working = convs.filter((c) => c.status === "running" || c.status === "pending").length;
    const unread = convs.some((c) => c.unread);
    const latest = convs.reduce((m, c) => ((c.last_active_at ?? "") > m ? c.last_active_at ?? "" : m), "");
    const teammates = w.agentIds.map((id) => agents.get(id)).filter((a): a is NonNullable<typeof a> => !!a);
    return (
      <li key={w.id}>
        <a className="conv-row" href={href.item(project.id, w.id)}>
          {unread && <span className="unread-dot" />}
          <div className="conv-main">
            <div className="conv-title">
              <span className="strong">{w.title}</span>
              {working > 0 && <span className="pill running">{working} working</span>}
            </div>
            <div className="conv-sub muted">
              {convs.length} conversation{convs.length === 1 ? "" : "s"}
              {w.notes ? ` · ${w.notes}` : ""}
            </div>
          </div>
          <div className="stack-avatars">
            {teammates.map((a) => (
              <AgentAvatar key={a.id} agent={a} size={22} />
            ))}
          </div>
          <div className="conv-side">
            <span className="time muted">{formatTime(latest || w.createdAt)}</span>
          </div>
        </a>
        <button className="secondary small self-center" onClick={() => void updateItem(w.id, { status: w.status === "done" ? "open" : "done" })}>
          {w.status === "done" ? "Reopen" : "Done"}
        </button>
        <TwoStep label="Delete" onConfirm={() => void removeItem(w.id)} className="danger small self-center" />
      </li>
    );
  };

  return (
    <div className="page narrow">
      <div className="page-header">
        <div>
          <h1>{project.name}</h1>
          <div className="muted small">
            env {envName} · vault {vaultName}
            {isOwner ? "" : ` · ${project.ownerEmail}'s project`}
            {project.notes ? ` · ${project.notes}` : ""}
          </div>
        </div>
        <a className="button secondary small" href={href.people(project.id)}>
          {isOwner ? "Settings & sharing" : "People"}
        </a>
      </div>

      <form className="card stack new-form" onSubmit={create}>
        <h2 className="h2">New work item</h2>
        <label>
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="fix foo" required />
        </label>
        <label>
          Notes <span className="hint">Context for the work. Can be prepended to the first prompt of every conversation on it.</span>
          <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Foo 500s when… Repro: …" />
        </label>
        <div className="row end">
          <button type="submit" disabled={!title.trim() || busy}>
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </form>

      <h2 className="h2 section">Open</h2>
      {open.length === 0 ? <p className="muted">Nothing open.</p> : <ul className="conv-list">{open.map(row)}</ul>}
      {done.length > 0 && (
        <>
          <h2 className="h2 section">
            <button className="linklike" onClick={() => setShowDone((v) => !v)}>
              {showDone ? "Hide" : "Show"} {done.length} done
            </button>
          </h2>
          {showDone && <ul className="conv-list">{done.map(row)}</ul>}
        </>
      )}
    </div>
  );
}
