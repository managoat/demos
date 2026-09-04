/**
 * "Create from…" — the three things a thread can start out of.
 *
 * A thread's origin is one field, and this is the only place it is chosen, so
 * the picker is keyboard-first: type to narrow, arrows to move, enter to take
 * it. Nothing here is a link out to GitHub; the point is to name a branch, a
 * pull request or an issue and get back to the composer without leaving the
 * keyboard.
 *
 * Each tab is fetched on its first visit and then kept. A person opens this,
 * looks at pull requests, glances at branches and comes back — re-fetching on
 * every tab click would spend three GitHub calls to show the same rows.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { BranchRef, IssueRef, Project, PullRef, ThreadOrigin } from "../../shared/api";
import * as api from "../api/client";
import { Modal } from "./Modal";
import "../styles/pickers.css";

export interface CreateFromProps {
  project: Project;
  /** Called with the origin and a title to put on the thread. Then `onClose`. */
  onPick: (origin: Partial<ThreadOrigin>, suggestedTitle: string) => void;
  onClose: () => void;
}

type Tab = "pulls" | "branches" | "issues";
type Cell<T> = { state: "idle" } | { state: "loading" } | { state: "ready"; rows: T[] } | { state: "error"; message: string };

/** One rendered line, whichever tab it came from. */
interface Row {
  key: string;
  glyph: ReactNode;
  /** `#1569`, or null for a branch. */
  number: string | null;
  label: string;
  chips: { text: string; tone?: "accent" | "warn" }[];
  /** Everything the search matches against: title, number, author. */
  haystack: string;
  origin: Partial<ThreadOrigin>;
  title: string;
}

const TABS: { id: Tab; label: string }[] = [
  { id: "pulls", label: "PRs" },
  { id: "branches", label: "Branches" },
  { id: "issues", label: "Issues" },
];

export function CreateFrom({ project, onPick, onClose }: CreateFromProps) {
  const [tab, setTab] = useState<Tab>("pulls");
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const [pulls, setPulls] = useState<Cell<PullRef>>({ state: "idle" });
  const [branches, setBranches] = useState<Cell<BranchRef>>({ state: "idle" });
  const [issues, setIssues] = useState<Cell<IssueRef>>({ state: "idle" });
  const list = useRef<HTMLDivElement>(null);
  const asked = useRef<Set<Tab>>(new Set());
  const repo = project.repo;

  const cell: Cell<PullRef> | Cell<BranchRef> | Cell<IssueRef> = tab === "pulls" ? pulls : tab === "branches" ? branches : issues;

  // Which tabs have been asked for lives in a ref rather than in their cells,
  // because an effect that reads the state it sets tears down the fetch it
  // just started the moment that fetch says "loading".
  function load(which: Tab) {
    if (!repo) return;
    asked.current.add(which);
    const into = <T,>(set: (c: Cell<T>) => void, rows: Promise<T[]>) => {
      set({ state: "loading" });
      rows.then(
        (ready) => set({ state: "ready", rows: ready }),
        (err: unknown) => set({ state: "error", message: messageOf(err) }),
      );
    };
    if (which === "pulls") into(setPulls, api.pulls(repo));
    else if (which === "branches") into(setBranches, api.branches(repo));
    else into(setIssues, api.issues(repo));
  }

  useEffect(() => {
    if (repo && !asked.current.has(tab)) load(tab);
  }, [tab, repo]);

  const all = useMemo<Row[]>(() => {
    if (tab === "pulls" && pulls.state === "ready") return pulls.rows.map((p) => pullRow(p));
    if (tab === "branches" && branches.state === "ready") return branches.rows.map((b) => branchRow(b));
    if (tab === "issues" && issues.state === "ready") return issues.rows.map((i) => issueRow(i, project.defaultBranch));
    return [];
  }, [tab, pulls, branches, issues, project.defaultBranch]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? all.filter((r) => r.haystack.includes(q)) : all;
  }, [all, query]);

  // The highlight is an index into the filtered list, so anything that changes
  // that list has to put it back at the top or it points at a different row
  // than the one under it a keystroke ago.
  useEffect(() => setAt(0), [tab, query]);

  function move(delta: number) {
    if (shown.length === 0) return;
    const next = Math.max(0, Math.min(shown.length - 1, at + delta));
    setAt(next);
    list.current?.children[next]?.scrollIntoView({ block: "nearest" });
  }

  function take(row: Row | undefined) {
    if (!row) return;
    onPick(row.origin, row.title);
    onClose();
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      take(shown[at]);
    }
  }

  return (
    <Modal title="Create from…" onClose={onClose} wide>
      <div className="dd-pick" onKeyDown={onKeyDown}>
        <div className="dd-pick-search">
          <input
            className="dd-pick-input"
            value={query}
            data-autofocus
            placeholder="Search by title, number, or author"
            aria-label="Search by title, number, or author"
            // Focus stays in the field while the arrows move the list, so the
            // highlighted row has to be named here or a screen reader follows
            // the cursor and never hears about it.
            aria-controls="dd-pick-list"
            aria-activedescendant={shown[at] ? `dd-pick-${shown[at].key}` : undefined}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="tabs dd-pick-tabs">
          {TABS.map((t) => (
            <button type="button" key={t.id} className={tab === t.id ? "tab on" : "tab"} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>

        {!repo ? (
          <div className="empty dd-pick-state">
            <h3>This project has no repository</h3>
            <p>
              {project.name} is a blank machine, so there are no branches, pull requests or issues to start from. Open a
              thread without an origin and clone whatever you like once you are on it.
            </p>
          </div>
        ) : cell.state === "error" ? (
          <div className="empty dd-pick-state">
            <h3>GitHub would not answer</h3>
            <p>{cell.message}</p>
            <button type="button" onClick={() => load(tab)}>
              Try again
            </button>
          </div>
        ) : cell.state === "loading" || cell.state === "idle" ? (
          <div className="dd-pick-list" aria-busy="true">
            {[0, 1, 2, 3].map((i) => (
              <div className="dd-pick-skel" key={i}>
                <div className="skeleton" style={{ width: 46, height: 12 }} />
                <div className="skeleton" style={{ width: `${38 + ((i * 19) % 34)}%`, height: 12 }} />
              </div>
            ))}
          </div>
        ) : shown.length === 0 ? (
          <div className="empty dd-pick-state">
            <h3>{query.trim() ? `Nothing matches “${query.trim()}”` : emptyTitle(tab)}</h3>
            <p>{query.trim() ? `${all.length} ${noun(tab)} loaded from ${repo}.` : emptyBody(tab, repo)}</p>
          </div>
        ) : (
          <div className="dd-pick-list" id="dd-pick-list" ref={list} role="listbox" aria-label={`${noun(tab)} on ${repo}`}>
            {shown.map((row, i) => (
              <div
                key={row.key}
                id={`dd-pick-${row.key}`}
                role="option"
                aria-selected={i === at}
                className={i === at ? "dd-pick-row on" : "dd-pick-row"}
                onMouseMove={() => i !== at && setAt(i)}
                onClick={() => take(row)}
              >
                <span className="dd-pick-glyph">{row.glyph}</span>
                {row.number ? <span className="dd-pick-num mono">{row.number}</span> : null}
                <span className="dd-pick-title clip">{row.label}</span>
                {row.chips.map((c) => (
                  <span className={c.tone ? `chip ${c.tone}` : "chip"} key={c.text}>
                    {c.text}
                  </span>
                ))}
                <span className="spacer" />
                <span className="dd-pick-enter" aria-hidden="true">
                  Select <span className="dd-pick-key">⏎</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

/**
 * A pull request starts from its own head branch, not from the base it will
 * merge into: the thread is here to keep working on that branch.
 */
function pullRow(p: PullRef): Row {
  return {
    key: `pr-${p.number}`,
    glyph: <PullIcon />,
    number: `#${p.number}`,
    label: p.title,
    chips: p.draft ? [{ text: "draft", tone: "warn" as const }] : [],
    haystack: `${p.number} #${p.number} ${p.title} ${p.author ?? ""}`.toLowerCase(),
    origin: { kind: "pr", number: p.number, title: p.title, base: p.headRef },
    title: p.title,
  };
}

function branchRow(b: BranchRef): Row {
  return {
    key: `branch-${b.name}`,
    glyph: <BranchIcon />,
    number: null,
    label: b.name,
    chips: b.isDefault ? [{ text: "default", tone: "accent" as const }] : [],
    haystack: b.name.toLowerCase(),
    origin: { kind: "branch", base: b.name },
    title: b.name,
  };
}

/** An issue has no branch of its own, so the thread cuts one from the default. */
function issueRow(i: IssueRef, defaultBranch: string | null): Row {
  return {
    key: `issue-${i.number}`,
    glyph: <IssueIcon />,
    number: `#${i.number}`,
    label: i.title,
    chips: i.labels.slice(0, 3).map((text) => ({ text })),
    haystack: `${i.number} #${i.number} ${i.title} ${i.author ?? ""} ${i.labels.join(" ")}`.toLowerCase(),
    origin: { kind: "issue", number: i.number, title: i.title, base: defaultBranch },
    title: i.title,
  };
}

function noun(tab: Tab): string {
  return tab === "pulls" ? "pull requests" : tab === "branches" ? "branches" : "issues";
}

function emptyTitle(tab: Tab): string {
  return tab === "pulls" ? "No open pull requests" : tab === "branches" ? "No branches" : "No open issues";
}

function emptyBody(tab: Tab, repo: string): string {
  if (tab === "pulls") return `Nothing is open on ${repo} right now. Start from a branch instead, and open the pull request from the thread.`;
  if (tab === "issues") return `Nothing is open on ${repo} right now. A branch or a pull request will get you a machine just the same.`;
  return `${repo} has no branches drydock can see, which usually means the repository has never been pushed to.`;
}

/** The server's own words where there are any; the browser's only when the request never landed. */
function messageOf(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "The request did not reach the server.";
}

function PullIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="4" cy="4" r="1.75" />
      <circle cx="4" cy="12" r="1.75" />
      <circle cx="12" cy="12" r="1.75" />
      <path d="M4 5.75v4.5M12 10.25V6.5a2 2 0 00-2-2H7.5" strokeLinecap="round" />
      <path d="M9 3l-1.5 1.5L9 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="4" cy="3.75" r="1.75" />
      <circle cx="4" cy="12.25" r="1.75" />
      <circle cx="12" cy="3.75" r="1.75" />
      <path d="M4 5.5v5M12 5.5v1a2.5 2.5 0 01-2.5 2.5H6.5A2.5 2.5 0 004 11.5" strokeLinecap="round" />
    </svg>
  );
}

function IssueIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="8" cy="8" r="5.75" />
      <circle cx="8" cy="8" r="1.4" />
    </svg>
  );
}
