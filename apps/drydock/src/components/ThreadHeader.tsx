/**
 * The card above a thread's transcript: what machine you are on, and what was
 * done to it before you got here.
 *
 * Every line is read back from the machine's own receipt (`GET
 * /api/threads/:id/header`), so until the opening turn has finished there is
 * nothing here to say and the card says that instead. Rendering the branch it
 * was *asked* to cut would be right almost every time, and the one time it was
 * wrong — a deleted base, a clone that came up on the default branch — is
 * exactly the time somebody needs to know.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, threadHeader } from "../api/client";
import type { Thread, ThreadHeader as HeaderData } from "../../shared/api";

export interface ThreadHeaderProps {
  thread: Thread;
  /** Opens the project's setup script. Only reachable from the "Optional:" line. */
  onOpenSetup: () => void;
  /** Handed the card whenever it is re-read, so the column can use its starters. */
  onHeader?: (header: HeaderData) => void;
}

export function ThreadHeader({ thread, onOpenSetup, onHeader }: ThreadHeaderProps) {
  const [header, setHeader] = useState<HeaderData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  // A ref, so a parent that re-creates the callback does not re-fetch the card.
  const notify = useRef(onHeader);
  notify.current = onHeader;

  // Re-read on every change of status: the receipt does not exist until the
  // opening turn lands, and that landing *is* a status change.
  useEffect(() => {
    let live = true;
    setError(null);
    threadHeader(thread.id)
      .then((data) => {
        if (!live) return;
        setHeader(data);
        notify.current?.(data);
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof ApiError ? err.message : "This thread's machine could not be read.");
      });
    return () => {
      live = false;
    };
  }, [thread.id, thread.status, thread.openedAt, attempt]);

  if (error && !header) {
    return (
      <div className="dd-th-head">
        <div className="dd-th-card dd-th-card-bad">
          <p className="error">{error}</p>
          <button className="ghost" onClick={retry}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (!header) {
    return (
      <div className="dd-th-head" aria-busy="true">
        <div className="skeleton dd-th-card-skeleton" />
        <div className="dd-th-lines">
          <div className="skeleton dd-th-line-skeleton" />
          <div className="skeleton dd-th-line-skeleton dd-th-line-skeleton-short" />
        </div>
      </div>
    );
  }

  const building = thread.status === "building" || (!header.branchedFrom && !header.created);

  return (
    <div className="dd-th-head">
      <div className="dd-th-card">
        {header.copyOf ? (
          <>
            You&rsquo;re in a new copy of <code>{header.copyOf}</code> called <code>{thread.slug}</code>
          </>
        ) : (
          <>
            You&rsquo;re on a machine of your own called <code>{thread.slug}</code>
          </>
        )}
      </div>

      <div className="dd-th-lines">
        {building && thread.status !== "failed" && (
          <div className="dd-th-line dd-th-line-wait">
            <span className="dot run" />
            <span>
              Setting up. The first turn is cutting the branch and counting the files &mdash; this card fills in when the
              machine says so.
            </span>
          </div>
        )}

        {thread.status === "failed" && !header.created && (
          <div className="dd-th-line">
            <span className="dd-th-glyph error">
              <AlertIcon />
            </span>
            <span className="error">This thread&rsquo;s machine did not finish being built.</span>
          </div>
        )}

        {header.branchedFrom && (
          <div className="dd-th-line">
            <span className="dd-th-glyph">
              <BranchIcon />
            </span>
            <span>
              Branched <code>{header.branchedFrom.branch}</code> from <code>{header.branchedFrom.base}</code>
              {header.branchedFrom.sha && <span className="faint mono dd-th-sha">{header.branchedFrom.sha}</span>}
            </span>
          </div>
        )}

        {header.created && (
          <div className="dd-th-line">
            <span className="dd-th-glyph">
              <FolderIcon />
            </span>
            <span>
              Created <code>{header.created.dir}</code>
              {header.created.files !== null && ` and copied ${header.created.files.toLocaleString()} files`}
            </span>
          </div>
        )}

        {!header.hasSetupScript && (
          <div className="dd-th-line">
            <span className="dd-th-glyph">
              <InfoIcon />
            </span>
            <button className="dd-th-link" onClick={onOpenSetup}>
              Optional: add a setup script
              <ArrowIcon />
            </button>
          </div>
        )}

        {error && header && <p className="fine error">{error}</p>}
      </div>
    </div>
  );
}

/* Icons: 16px, stroked, no fill — the thin line style the rest of the app is
   drawn in. Local to this file because they are drawn for these four lines. */

function BranchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="4" cy="3.5" r="1.6" />
      <circle cx="4" cy="12.5" r="1.6" />
      <circle cx="12" cy="6" r="1.6" />
      <path d="M4 5.1v5.8M5.6 3.9h3.6a2.8 2.8 0 0 1 2.8 2.8v.6" strokeLinecap="round" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M2 4.2a1.2 1.2 0 0 1 1.2-1.2h2.6l1.4 1.8h4.6A1.2 1.2 0 0 1 13 6v5.8a1.2 1.2 0 0 1-1.2 1.2H3.2A1.2 1.2 0 0 1 2 11.8z" strokeLinejoin="round" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="8" cy="8" r="5.8" />
      <path d="M8 7.2v3.6M8 5.2v.2" strokeLinecap="round" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M8 2.6 14 13H2z" strokeLinejoin="round" />
      <path d="M8 6.6v3M8 11.2v.2" strokeLinecap="round" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M5.5 10.5 10.5 5.5M6.4 5.5h4.1v4.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
