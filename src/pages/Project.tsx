import { useState, type FormEvent } from "react";
import { useProject, useWorkbench } from "../store";
import { channelFor } from "../lib/workbench";
import { href, navigate } from "../router";
import { TwoStep } from "../components/Thread";
import { AgentAvatar } from "../components/AgentAvatar";
import { formatTime } from "../lib/format";
import { EnvVaultFields } from "../components/EnvVaultFields";

export function Project() {
  const { me } = useWorkbench();
  const { project, items, isOwner, conversations, agents, environments, vaults, resourcesLoaded, updateProject, addMember, removeMember, createItem, updateItem, removeItem } = useProject();
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [showDone, setShowDone] = useState(false);
  const [editing, setEditing] = useState(false);
  const [invite, setInvite] = useState("");
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

  async function share(e: FormEvent) {
    e.preventDefault();
    const email = invite.trim();
    if (!email) return;
    await addMember(email);
    setInvite("");
  }

  const open = items.filter((w) => w.status === "open");
  const done = items.filter((w) => w.status === "done");
  const envName = project.environmentId ? environments.get(project.environmentId)?.name ?? "?" : "each agent's own";
  const vaultName = project.vaultId ? vaults.get(project.vaultId)?.name ?? "?" : "none";

  const row = (w: (typeof items)[number]) => {
    const convs = conversations.filter((c) => c.channel_id === channelFor(project.id, w.id));
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
        {editing ? (
          <form
            className="stack tight grow"
            onSubmit={(e) => {
              e.preventDefault();
              setEditing(false);
            }}
          >
            <input value={project.name} onChange={(e) => void updateProject({ name: e.target.value })} />
            <input value={project.notes} onChange={(e) => void updateProject({ notes: e.target.value })} placeholder="Notes" />
            <EnvVaultFields
              environments={environments.values()}
              vaults={vaults.values()}
              loaded={resourcesLoaded}
              environmentId={project.environmentId ?? ""}
              vaultId={project.vaultId ?? ""}
              onEnvironment={(id) => void updateProject({ environmentId: id || null })}
              onVault={(id) => void updateProject({ vaultId: id || null })}
            />
            <p className="muted small">Changing these affects conversations started from now on; running ones keep their computer.</p>
            <div className="row end">
              <button type="submit" className="secondary small">
                Done
              </button>
            </div>
          </form>
        ) : (
          <>
            <div>
              <h1>{project.name}</h1>
              <div className="muted small">
                env {envName} · vault {vaultName}
                {isOwner ? "" : ` · ${project.ownerEmail}'s project`}
                {project.notes ? ` · ${project.notes}` : ""}
              </div>
            </div>
            {isOwner && (
              <button className="secondary small" onClick={() => setEditing(true)}>
                Edit
              </button>
            )}
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

      <h2 className="h2 section">People</h2>
      <div className="card stack tight">
        <p className="muted small">
          Everyone here sees the same work items and conversations. Conversations run on <strong>{isOwner ? "your" : `${project.ownerEmail}'s`}</strong> Fountain account — its agents, its computers, its bill.
        </p>
        <ul className="member-list">
          <li className="member-row">
            <span className="avatar" style={{ width: 28, height: 28, fontSize: 11 }}>
              {initial(project.ownerEmail)}
            </span>
            <div className="min0 grow">
              <div className="strong ellipsis">{project.ownerEmail}</div>
              <div className="muted small">owner{project.ownerEmail === me.email ? " · you" : ""}</div>
            </div>
          </li>
          {project.members.map((m) => (
            <li key={m.email} className="member-row">
              <span className="avatar" style={{ width: 28, height: 28, fontSize: 11 }}>
                {initial(m.email)}
              </span>
              <div className="min0 grow">
                <div className="strong ellipsis">{m.email}</div>
                <div className="muted small">member{m.email === me.email ? " · you" : ""}</div>
              </div>
              {(isOwner || m.email === me.email) && (
                <TwoStep
                  label={m.email === me.email ? "Leave" : "Remove"}
                  className="danger small"
                  onConfirm={() => {
                    void removeMember(m.email);
                    if (m.email === me.email) navigate(href.projects());
                  }}
                />
              )}
            </li>
          ))}
        </ul>
        {isOwner && (
          <form className="row" onSubmit={share}>
            <input type="email" value={invite} onChange={(e) => setInvite(e.target.value)} placeholder="someone@example.com" className="grow" />
            <button type="submit" className="small" disabled={!invite.trim()}>
              Share
            </button>
          </form>
        )}
        {isOwner && <p className="muted small">They sign in with Fountain using that email, and the project is there.</p>}
      </div>
    </div>
  );
}

function initial(email: string): string {
  return (email[0] ?? "?").toUpperCase();
}
