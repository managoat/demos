/**
 * A project with no thread selected.
 *
 * Conductor does not really have this screen — clicking a project there
 * expands it in the sidebar and that is all. It exists here because a drydock
 * project is a *configuration* that outlives every machine built from it, so
 * there is something to look at even when nothing is running: what every
 * thread of this project will get.
 *
 * It is also where a project is deleted, which is the one destructive thing in
 * the app and therefore does not live in a menu somewhere.
 */
import { useState } from "react";
import type { Capabilities, Project, Thread } from "../../shared/api";
import * as api from "../api/client";
import { ApiError } from "../api/client";
import { hrefFor } from "../lib/route";

interface Props {
  project: Project;
  threads: Thread[];
  capabilities: Capabilities;
  onNewThread: () => void;
  onDeleted: () => void;
}

export function ProjectView({ project, threads, onNewThread, onDeleted }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteProject(project.id);
      onDeleted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not remove this project.");
      setBusy(false);
    }
  };

  return (
    <div className="dd-project">
      <div className="dd-project-inner">
        <header className="dd-project-head">
          <h1>{project.name}</h1>
          {project.repo ? (
            <p className="fine mono">
              {project.repo} · default branch <b>{project.defaultBranch}</b> · cloned to {project.repoPath}
            </p>
          ) : (
            <p className="fine">No repository. Every thread gets an empty machine.</p>
          )}
          <div className="row">
            <button className="primary" type="button" onClick={onNewThread}>
              New thread
            </button>
            <span className="chip mono">{project.model}</span>
            <span className="chip">rev {project.rev}</span>
          </div>
        </header>

        <section className="dd-project-section">
          <h4>Threads</h4>
          {threads.length === 0 ? (
            <div className="dd-project-empty">
              <p>
                Nothing open yet. A thread is one piece of work: it gets a machine of its own, a fresh clone of the
                repository, and a branch to push from. Close it and the machine goes with it.
              </p>
            </div>
          ) : (
            <ul className="dd-project-threads">
              {threads.map((t, i) => (
                <li key={t.id}>
                  <a href={hrefFor({ at: "thread", projectId: project.id, threadId: t.id })}>
                    <span className="thread-num">{i + 1}</span>
                    <span className="clip">{t.title}</span>
                    {t.branch && <code className="chip mono clip">{t.branch}</code>}
                    <span className="spacer" />
                    <span className="chip">{describe(t)}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="dd-project-section">
          <h4>What every thread gets</h4>
          <p className="fine">
            One Fountain agent, one environment and one vault, made when this project was created and never replaced. Open a
            thread and edit them from its Setup panel — changes to the setup script and packages land on the{" "}
            <b>next</b> thread, because the next thread is a new machine.
          </p>
        </section>

        <section className="dd-project-section">
          <h4>Remove this project</h4>
          <p className="fine">
            Closes every thread, ends their machines, and deletes the agent, environment and vault behind them. Anything
            pushed to GitHub stays; anything only on a machine does not.
          </p>
          {error && <p className="error fine">{error}</p>}
          {confirming ? (
            <div className="row">
              <button className="danger" type="button" onClick={remove} disabled={busy}>
                {busy ? "Removing…" : `Yes, remove ${project.name}`}
              </button>
              <button type="button" onClick={() => setConfirming(false)} disabled={busy}>
                Cancel
              </button>
            </div>
          ) : (
            // Inline rather than the full width of the column: a destructive
            // control that spans the page reads as the section's primary action,
            // and this section's primary action is reading the paragraph above it.
            <div className="row">
              <button className="danger" type="button" onClick={() => setConfirming(true)}>
                Remove project
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function describe(t: Thread): string {
  if (t.status === "building") return "building its machine";
  if (t.status === "running") return "taking a turn";
  if (t.status === "failed") return "failed";
  if (t.status === "closed") return "closed";
  return t.turnCount === 0 ? "ready" : `${t.turnCount} turns`;
}
