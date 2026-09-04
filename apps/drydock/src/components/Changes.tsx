/**
 * The Changes tab: what this thread's machine has done to its clone.
 *
 * The diff is parsed on the server — `DiffReport.files` arrives already
 * counted — so this file renders a list and nothing else. The fetch lives in
 * `useDiff` rather than in the component because the *tab strip* needs the
 * file count whether or not this tab is the one showing, and two fetches for
 * one number would be one fetch too many.
 */
import { useCallback, useEffect, useState } from "react";
import type { DiffFile, DiffReport } from "../../shared/api";
import { ApiError } from "../api/client";
import * as api from "../api/client";

export interface DiffState {
  report: DiffReport | null;
  loading: boolean;
  error: ApiError | null;
  /** True while the machine is still being built — a wait, not a failure. */
  building: boolean;
  reload: () => void;
}

/**
 * One thread's whole diff, fetched once and shared by the tab strip, the
 * Changes list and the file viewer.
 *
 * `nonce` is the refresh button: bumping it re-runs the fetch without the
 * caller having to know how.
 */
export function useDiff(threadId: string | null, nonce: number): DiffState {
  const [report, setReport] = useState<DiffReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [building, setBuilding] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!threadId) {
      setReport(null);
      setError(null);
      setBuilding(false);
      return;
    }
    let live = true;
    setLoading(true);
    api
      .readDiff(threadId)
      .then((next) => {
        if (!live) return;
        setReport(next);
        setError(null);
        setBuilding(false);
      })
      .catch((err: unknown) => {
        if (!live) return;
        const failure = asApiError(err);
        setReport(null);
        setBuilding(isStillBuilding(failure));
        setError(isStillBuilding(failure) ? null : failure);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [threadId, nonce, tick]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { report, loading, error, building, reload };
}

export interface ChangesProps {
  state: DiffState;
  /** Opens the file viewer on this path's diff. */
  onOpen: (path: string) => void;
}

export function Changes({ state, onOpen }: ChangesProps) {
  const { report, loading, error, building, reload } = state;

  if (building) {
    return (
      <div className="dd-in-wait">
        <span className="dd-in-spin" />
        <span>This thread's machine is still being built.</span>
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
  if (!report && loading) {
    return (
      <div className="dd-in-sk">
        {[62, 78, 45, 70, 55].map((w, i) => (
          <div key={i} className="skeleton" style={{ width: `${w}%` }} />
        ))}
      </div>
    );
  }
  if (!report) return null;

  if (report.files.length === 0) {
    return (
      <div className="empty dd-in-empty">
        <span className="dd-in-empty-icon">
          <GitIcon />
        </span>
        <h3>No changes</h3>
        <p>Nothing has changed on this machine yet. Anything the agent writes to the clone shows up here.</p>
      </div>
    );
  }

  return (
    <div className="dd-in-chg">
      {report.files.map((file) => (
        <button key={file.path} className="dd-in-chg-row" onClick={() => onOpen(file.path)} title={file.path}>
          <span className={`dd-in-chg-status ${statusClass(file)}`}>{statusLetter(file)}</span>
          <Path path={file.path} />
          <Counts file={file} />
        </button>
      ))}
      {report.truncated ? (
        <p className="dd-in-chg-foot">This diff was cut short by the machine — the largest changes are listed, not all of them.</p>
      ) : null}
    </div>
  );
}

/** A path that gives up its directory before it gives up its filename. */
export function Path({ path }: { path: string }) {
  const cut = path.lastIndexOf("/");
  const dir = cut === -1 ? "" : path.slice(0, cut + 1);
  const name = cut === -1 ? path : path.slice(cut + 1);
  return (
    <span className="dd-in-path">
      {dir ? <span className="dd-in-path-dir">{dir}</span> : null}
      <span className="dd-in-path-name">{name}</span>
    </span>
  );
}

function Counts({ file }: { file: DiffFile }) {
  if (file.status === "binary") return <span className="dd-in-chg-counts">binary</span>;
  return (
    <span className="dd-in-chg-counts">
      {file.added > 0 ? <span className="add">+{file.added}</span> : null}
      {file.removed > 0 ? <span className="del">−{file.removed}</span> : null}
      {file.added === 0 && file.removed === 0 ? <span>—</span> : null}
    </span>
  );
}

function statusLetter(file: DiffFile): string {
  switch (file.status) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "binary":
      return "B";
    default:
      return "M";
  }
}

function statusClass(file: DiffFile): string {
  switch (file.status) {
    case "added":
      return "a";
    case "deleted":
      return "d";
    case "renamed":
      return "r";
    default:
      return "";
  }
}

/**
 * The two failures that are really one wait.
 *
 * A thread's machine is built after the thread exists, so every read of the
 * machine can arrive early. The server says so precisely; a panel that showed
 * that in red would be lying about whose fault it is.
 */
export function isStillBuilding(err: ApiError | null): boolean {
  return !!err && (err.code === "no_machine" || err.code === "machine_not_ready");
}

export function asApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  return new ApiError(0, "network", err instanceof Error ? err.message : "The request did not finish.");
}

function GitIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="4" cy="4" r="2" />
      <circle cx="4" cy="12" r="2" />
      <circle cx="12" cy="8" r="2" />
      <path d="M4 6v4M6 4h2a2 2 0 0 1 2 2v.5" strokeLinecap="round" />
    </svg>
  );
}
