/**
 * The Checks tab: GitHub's opinion of this thread's branch, if GitHub has one
 * yet.
 *
 * The three states here are the whole point of the tab. A branch that has
 * never been pushed has no checks and is not failing — it exists on one
 * ephemeral machine and nowhere else, and the disk goes when the thread does.
 * A branch that has been pushed but has no runs is a repository with no
 * workflows, or one that has not started them. Only the third state is a list.
 * Collapsing the first two into "no checks" is the mistake this file exists to
 * not make.
 */
import { useCallback, useEffect, useState } from "react";
import type { Capabilities, CheckRun, ChecksReport, Thread } from "../../shared/api";
import type { ApiError } from "../api/client";
import * as api from "../api/client";
import { asApiError } from "./Changes";

export interface ChecksProps {
  thread: Thread;
  capabilities: Capabilities;
  refreshKey: number;
}

export function Checks({ thread, capabilities, refreshKey }: ChecksProps) {
  const [report, setReport] = useState<ChecksReport | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  const github = capabilities.github;

  useEffect(() => {
    if (!github) return;
    let live = true;
    setLoading(true);
    api
      .checks(thread.id)
      .then((next) => {
        if (!live) return;
        setReport(next);
        setError(null);
      })
      .catch((err: unknown) => live && setError(asApiError(err)))
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [github, thread.id, refreshKey, tick]);

  if (!github) {
    return (
      <div className="empty dd-in-empty">
        <span className="dd-in-empty-icon">
          <ChecksIcon />
        </span>
        <h3>No GitHub App on this drydock</h3>
        <p>
          Checks read a branch's workflow runs and open its pull request. Both need a GitHub App installed on the repository, and this
          deployment has none configured.
        </p>
        <p className="dd-in-empty-what">GITHUB_APP_ID, GITHUB_PRIVATE_KEY</p>
      </div>
    );
  }
  if (loading && !report) {
    return (
      <div className="dd-in-sk">
        {[54, 72, 62].map((w, i) => (
          <div key={i} className="skeleton" style={{ width: `${w}%`, height: 28 }} />
        ))}
      </div>
    );
  }
  if (error) {
    return (
      <div className="dd-in-msg error">
        {error.message}
        <div style={{ marginTop: 10 }}>
          <button onClick={reload}>Try again</button>
        </div>
      </div>
    );
  }
  if (!report) return null;

  return (
    <div className="dd-in-checks">
      {report.ref ? (
        <div className="dd-in-branch">
          <BranchIcon />
          <code className="clip">{report.ref}</code>
          {report.sha ? <span className="faint mono">{report.sha.slice(0, 7)}</span> : null}
          <span className="spacer" />
          <button className="icon" onClick={reload} title="Read the branch again">
            <RefreshIcon />
          </button>
        </div>
      ) : null}

      {report.pull ? <PullCard pull={report.pull} /> : report.pushed ? <OpenPull thread={thread} onOpened={reload} /> : null}

      {!report.pushed ? (
        <div className="empty dd-in-empty">
          <span className="dd-in-empty-icon">
            <BranchIcon />
          </span>
          <h3>Nothing pushed yet</h3>
          <p>This branch only exists on the machine. GitHub has never seen it, so there is nothing for it to check.</p>
          <p>The machine is ephemeral: what survives the thread is what gets pushed. Ask the agent to push, or push it from the terminal.</p>
        </div>
      ) : report.runs.length === 0 ? (
        <div className="empty dd-in-empty">
          <span className="dd-in-empty-icon">
            <ChecksIcon />
          </span>
          <h3>Pushed, no checks</h3>
          <p>GitHub has this branch but has not reported any check runs on it — either the repository has no workflows for it, or none have started.</p>
        </div>
      ) : (
        <div className="col" style={{ gap: 5 }}>
          {report.runs.map((run, i) => (
            <CheckRow key={`${run.name}-${i}`} run={run} />
          ))}
        </div>
      )}
    </div>
  );
}

function PullCard({ pull }: { pull: NonNullable<ChecksReport["pull"]> }) {
  return (
    <div className="dd-in-pr">
      <span className="dd-in-pr-num">#{pull.number}</span>
      <div className="col" style={{ minWidth: 0, gap: 2 }}>
        <span className="dd-in-pr-title">{pull.title}</span>
        <span className="row" style={{ gap: 7 }}>
          {pull.draft ? <span className="chip">draft</span> : null}
          <span className="faint mono">
            {pull.headRef} → {pull.baseRef}
          </span>
          {pull.url ? (
            <a href={pull.url} target="_blank" rel="noreferrer">
              open on GitHub
            </a>
          ) : null}
        </span>
      </div>
    </div>
  );
}

function CheckRow({ run }: { run: CheckRun }) {
  const body = (
    <>
      <span className={`dot ${dotClass(run)}`} />
      <span className="dd-in-check-name clip">{run.name}</span>
      <span className="dd-in-check-when">{describe(run)}</span>
      {run.url ? <ExternalIcon /> : null}
    </>
  );
  if (!run.url) return <div className="dd-in-check-row">{body}</div>;
  return (
    <a className="dd-in-check-row" href={run.url} target="_blank" rel="noreferrer" style={{ color: "inherit", textDecoration: "none" }}>
      {body}
    </a>
  );
}

function dotClass(run: CheckRun): string {
  if (run.status !== "completed") return "run";
  if (run.conclusion === "success") return "ok";
  if (run.conclusion === "failure" || run.conclusion === "timed_out" || run.conclusion === "action_required") return "bad";
  return "";
}

function describe(run: CheckRun): string {
  if (run.status !== "completed") return run.status.replace("_", " ");
  return run.conclusion ? run.conclusion.replace("_", " ") : "done";
}

/**
 * The form behind the button.
 *
 * Deliberately not a modal: the panel already has a branch at the top of it,
 * and a pull request is a title and a body, not a page.
 */
function OpenPull({ thread, onOpened }: { thread: Thread; onOpened: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(thread.title);
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  if (!open) {
    return (
      <div className="row">
        <button className="primary" onClick={() => setOpen(true)}>
          Open pull request
        </button>
      </div>
    );
  }

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.openPull(thread.id, { title: title.trim() || thread.title, body, draft });
      setOpen(false);
      setBody("");
      onOpened();
    } catch (err) {
      setError(asApiError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dd-in-form">
      <div>
        <label htmlFor="dd-in-pr-title">Title</label>
        <input id="dd-in-pr-title" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div>
        <label htmlFor="dd-in-pr-body">Description</label>
        <textarea id="dd-in-pr-body" rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder="What this branch does." />
      </div>
      <div className="dd-in-form-row">
        <label className="dd-in-check">
          <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
          Draft
        </label>
        <span className="spacer" />
        <button onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
        <button className="primary" onClick={() => void submit()} disabled={busy}>
          {busy ? "Opening…" : "Open"}
        </button>
      </div>
      {error ? <p className="fine error">{error.message}</p> : null}
    </div>
  );
}

function ChecksIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="6" />
      <path d="m5.5 8 1.8 1.8L10.8 6.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="4.5" cy="3.5" r="1.75" />
      <circle cx="4.5" cy="12.5" r="1.75" />
      <circle cx="11.5" cy="5.5" r="1.75" />
      <path d="M4.5 5.25v5.5M11.5 7.25c0 2.2-1.6 3.2-3.5 3.4" strokeLinecap="round" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M13.5 8a5.5 5.5 0 1 1-1.7-4" strokeLinecap="round" />
      <path d="M13 2v3h-3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ flex: "none", color: "var(--faint)" }}>
      <path d="M9.5 3H13v3.5M12.5 3.5 7 9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
