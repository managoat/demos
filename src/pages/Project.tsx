import { useState, type FormEvent } from "react";
import { useStore } from "../store";
import { addItem, channelFor, removeItem, updateItem, updateProject } from "../lib/workbench";
import { href, navigate } from "../router";
import { TwoStep } from "../components/Thread";
import { AgentAvatar } from "../components/AgentAvatar";
import { formatTime } from "../lib/format";

export function Project({ projectId }: { projectId: string }) {
  const { state, update, conversations, agents } = useStore();
  const project = state.projects.find((p) => p.id === projectId);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [showDone, setShowDone] = useState(false);
  const [editing, setEditing] = useState(false);

  if (!project) {
    return (
      <div className="page narrow">
        <div className="empty card">
          <p className="strong">No such project.</p>
          <a className="button secondary" href={href.projects()}>
            Back to projects
          </a>
        </div>
      </div>
    );
  }

  function create(e: FormEvent) {
    e.preventDefault();
    if (!title.trim() || !project) return;
    let created = "";
    update((s) => {
      const [next, w] = addItem(s, project.id, title, notes);
      created = w.id;
      return next;
    });
    setTitle("");
    setNotes("");
    if (created) navigate(href.item(project.id, created));
  }

  const items = state.items.filter((w) => w.projectId === project.id);
  const open = items.filter((w) => w.status === "open");
  const done = items.filter((w) => w.status === "done");

  const row = (w: (typeof items)[number]) => {
    const convs = conversations.filter((c) => c.channel_id === channelFor(project.id, w.id));
    const working = convs.filter((c) => c.status === "running" || c.status === "pending").length;
    const unread = convs.some((c) => c.unread);
    const latest = convs.reduce((m, c) => ((c.last_active_at ?? "") > m ? c.last_active_at ?? "" : m), "");
    const members = w.memberIds.map((id) => state.members.find((m) => m.id === id)).filter((m): m is NonNullable<typeof m> => !!m);
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
            {members.map((m) => {
              const a = agents.get(m.agentId);
              return a ? <AgentAvatar key={m.id} agent={a} size={22} /> : null;
            })}
          </div>
          <div className="conv-side">
            <span className="time muted">{formatTime(latest || w.createdAt)}</span>
          </div>
        </a>
        <button className="secondary small self-center" onClick={() => update((s) => updateItem(s, w.id, { status: w.status === "done" ? "open" : "done" }))}>
          {w.status === "done" ? "Reopen" : "Done"}
        </button>
        <TwoStep label="Delete" onConfirm={() => update((s) => removeItem(s, w.id))} className="danger small self-center" />
      </li>
    );
  };

  return (
    <div className="page narrow">
      <div className="page-header">
        {editing ? (
          <form
            className="row grow"
            onSubmit={(e) => {
              e.preventDefault();
              setEditing(false);
            }}
          >
            <input value={project.name} onChange={(e) => update((s) => updateProject(s, project.id, { name: e.target.value }))} />
            <input value={project.notes} onChange={(e) => update((s) => updateProject(s, project.id, { notes: e.target.value }))} placeholder="Notes" />
            <button type="submit" className="secondary small">
              Done
            </button>
          </form>
        ) : (
          <>
            <div>
              <h1>{project.name}</h1>
              {project.notes && <div className="muted small">{project.notes}</div>}
            </div>
            <button className="secondary small" onClick={() => setEditing(true)}>
              Edit
            </button>
          </>
        )}
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
          <button type="submit" disabled={!title.trim()}>
            Create
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
