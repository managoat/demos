import { useState, type FormEvent } from "react";
import { useStore } from "../store";
import { addProject, parseChannel, removeProject } from "../lib/workbench";
import { href } from "../router";
import { TwoStep } from "../components/Thread";
import { formatTime } from "../lib/format";

export function Projects() {
  const { state, update, conversations } = useStore();
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");

  function create(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    update((s) => addProject(s, name, notes)[0]);
    setName("");
    setNotes("");
  }

  const live = new Map<string, number>();
  const latest = new Map<string, string>();
  for (const c of conversations) {
    const ref = parseChannel(c.channel_id);
    if (!ref) continue;
    if (c.status === "running" || c.status === "pending") live.set(ref.projectId, (live.get(ref.projectId) ?? 0) + 1);
    const at = c.last_active_at ?? c.updated_at ?? "";
    if (at > (latest.get(ref.projectId) ?? "")) latest.set(ref.projectId, at);
  }

  return (
    <div className="page narrow">
      <div className="page-header">
        <h1>Projects</h1>
      </div>
      {state.projects.length === 0 ? (
        <div className="empty card">
          <p className="strong">No projects yet.</p>
          <p className="muted">A project holds work items; a work item is where you pull in members and talk to them.</p>
        </div>
      ) : (
        <ul className="conv-list">
          {state.projects.map((p) => {
            const items = state.items.filter((w) => w.projectId === p.id);
            const open = items.filter((w) => w.status === "open").length;
            return (
              <li key={p.id}>
                <a className="conv-row" href={href.project(p.id)}>
                  <div className="conv-main">
                    <div className="conv-title">
                      <span className="strong">{p.name}</span>
                      {(live.get(p.id) ?? 0) > 0 && <span className="pill running">{live.get(p.id)} working</span>}
                    </div>
                    <div className="conv-sub muted">
                      {open} open · {items.length - open} done
                      {p.notes ? ` · ${p.notes}` : ""}
                    </div>
                  </div>
                  <div className="conv-side">
                    <span className="time muted">{formatTime(latest.get(p.id))}</span>
                  </div>
                </a>
                <TwoStep label="Delete" onConfirm={() => update((s) => removeProject(s, p.id))} className="danger small self-center" />
              </li>
            );
          })}
        </ul>
      )}

      <form className="card stack new-form" onSubmit={create}>
        <h2 className="h2">New project</h2>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Fountain" required />
        </label>
        <label>
          Notes <span className="hint">Where the code is, what it is. Shown to you, not sent to agents.</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="github.com/BinaryBourbon/fountain" />
        </label>
        <div className="row end">
          <button type="submit" disabled={!name.trim()}>
            Create
          </button>
        </div>
      </form>
    </div>
  );
}
