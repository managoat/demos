/** Who is in the project, and — for the owner — its settings: name, notes, the computer it runs on. */
import { useMemo, useState, type FormEvent } from "react";
import { useProject, useWorkbench } from "../store";
import { api } from "../lib/api";
import { describeError } from "../lib/errors";
import { useDraft } from "../lib/draft";
import { href, navigate } from "../router";
import { TwoStep } from "../components/Thread";
import { EnvVaultFields } from "../components/EnvVaultFields";

export function People() {
  const { me, refreshProjects, toast } = useWorkbench();
  const { project, isOwner, environments, vaults, resourcesLoaded, updateProject, addMember, removeMember } = useProject();
  const [invite, setInvite] = useState("");

  // What is saved, against what the fields show: one PATCH per pause in the
  // typing and not one per keystroke, and another member's rename still lands
  // on a field nobody is in. The selects below stay direct — a pick is one
  // write already.
  const settings = useMemo(() => ({ name: project.name, notes: project.notes }), [project.name, project.notes]);
  const { draft, edit, flush, cancel } = useDraft(settings, (v) => void updateProject(v));

  async function share(e: FormEvent) {
    e.preventDefault();
    const email = invite.trim();
    if (!email) return;
    await addMember(email);
    setInvite("");
  }

  return (
    <div className="page narrow">
      <div className="page-header">
        <div>
          {/* The draft, so the heading still keeps up with the field below it. */}
          <h1>{draft.name}</h1>
          <div className="muted small">{isOwner ? "Your project" : `${project.ownerEmail}'s project`}</div>
        </div>
      </div>

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

      {isOwner && (
        <>
          <h2 className="h2 section">Settings</h2>
          <form
            className="card stack"
            onSubmit={(e) => {
              e.preventDefault();
              flush();
            }}
          >
            <label>
              Name
              <input value={draft.name} onChange={(e) => edit({ ...draft, name: e.target.value })} />
            </label>
            <label>
              Notes <span className="hint">Where the code is, what it is. Shown to members, not sent to agents.</span>
              <input value={draft.notes} onChange={(e) => edit({ ...draft, notes: e.target.value })} placeholder="github.com/…" />
            </label>
            <EnvVaultFields
              environments={environments.values()}
              vaults={vaults.values()}
              loaded={resourcesLoaded}
              environmentId={project.environmentId ?? ""}
              vaultId={project.vaultId ?? ""}
              onEnvironment={(id) => void updateProject({ environmentId: id || null })}
              onVault={(id) => void updateProject({ vaultId: id || null })}
            />
            <p className="muted small">Changing the environment or vault affects conversations started from now on; running ones keep their computer.</p>
            <div className="row end">
              <TwoStep
                label="Delete project"
                className="danger small"
                onConfirm={() => {
                  // Drop the half-typed name first: leaving the page would
                  // otherwise flush it onto a project that is no longer there.
                  cancel();
                  void api
                    .deleteProject(project.id)
                    .then(() => refreshProjects())
                    .then(() => navigate(href.projects()))
                    .catch((err) => toast(describeError(err), "error"));
                }}
              />
            </div>
          </form>
        </>
      )}
    </div>
  );
}

function initial(email: string): string {
  return (email[0] ?? "?").toUpperCase();
}
