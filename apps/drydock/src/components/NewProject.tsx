/**
 * Making a project, which is choosing a repository — or deciding not to have
 * one.
 *
 * The repository list is the whole of the first tab because a project *is*
 * mostly its repository: the clone is what the environment builds, and the
 * name, the model and everything else can be changed afterwards in settings.
 * So this asks the one question that is expensive to change and gets out of
 * the way.
 *
 * Every reason this panel can be empty is a different sentence, because they
 * want different things done about them: a deployment with no GitHub App
 * needs its operator, an account with no installation needs one grant, and an
 * installation that can see nothing needs its repository list widened. A
 * single "no repositories" would send all three to the wrong place.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Capabilities, Project, RepoRef, Viewer } from "../../shared/api";
import * as api from "../api/client";
import { Modal } from "./Modal";
import "../styles/pickers.css";

export interface NewProjectProps {
  /** What this deployment can do. `github: false` and the first tab is a notice. */
  capabilities: Capabilities;
  viewer: Viewer | null;
  /** Called with the created project. This component does not close itself. */
  onCreated: (project: Project) => void;
  onClose: () => void;
}

type Tab = "repo" | "blank";
type Repos = { state: "idle" } | { state: "loading" } | { state: "ready"; rows: RepoRef[] } | { state: "error"; message: string };

export function NewProject({ capabilities, viewer, onCreated, onClose }: NewProjectProps) {
  const [tab, setTab] = useState<Tab>(capabilities.github ? "repo" : "blank");
  const [repos, setRepos] = useState<Repos>({ state: "idle" });
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [renamed, setRenamed] = useState(false);
  const [blankName, setBlankName] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const asked = useRef(false);

  // The ref, and not `repos.state`, is what says whether this has run. Reading
  // the state here would make the effect depend on the state it sets, so the
  // move to `loading` would tear down the fetch that had just been started.
  function load() {
    asked.current = true;
    setRepos({ state: "loading" });
    api.repos().then(
      (rows) => setRepos({ state: "ready", rows }),
      (err: unknown) => setRepos({ state: "error", message: messageOf(err) }),
    );
  }

  useEffect(() => {
    if (tab === "repo" && capabilities.github && !asked.current) load();
  }, [tab, capabilities.github]);

  const rows = repos.state === "ready" ? repos.rows : [];
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.fullName.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q));
  }, [rows, query]);

  const selected = shown.find((r) => r.fullName === picked) ?? null;

  // The name field follows the selection until somebody types in it, which is
  // the behaviour that lets you pick a repository and hit create without
  // reading the field at all.
  function choose(repo: RepoRef) {
    setPicked(repo.fullName);
    if (!renamed) setName(repo.name);
  }

  function move(delta: number) {
    if (shown.length === 0) return;
    const at = shown.findIndex((r) => r.fullName === picked);
    const next = shown[Math.max(0, Math.min(shown.length - 1, at < 0 ? 0 : at + delta))];
    if (next) {
      choose(next);
      list.current?.querySelector<HTMLElement>(`[data-repo="${cssEscape(next.fullName)}"]`)?.scrollIntoView({ block: "nearest" });
    }
  }

  function onSearchKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Enter" && selected) {
      e.preventDefault();
      void create();
    }
  }

  async function create() {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const project =
        tab === "blank"
          ? await api.createProject({ name: blankName.trim() || "New project" })
          : selected
            ? await api.createProject({ repo: selected.fullName, installationId: selected.installationId, name: name.trim() || selected.name })
            : null;
      if (project) onCreated(project);
    } catch (err: unknown) {
      setFailure(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  const canCreate = tab === "blank" ? blankName.trim().length > 0 : selected !== null;

  // Rendered while the list is still arriving as well as after, so the panel
  // does not jump a row down when it lands and so there is somewhere for the
  // cursor to be in the meantime.
  const searchRow = (
    <div className="dd-repo-search">
      <SearchIcon />
      <input
        value={query}
        data-autofocus
        placeholder="Filter repositories"
        aria-label="Filter repositories"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onSearchKey}
      />
    </div>
  );

  return (
    <Modal
      title="New project"
      onClose={onClose}
      // Fixed width across both tabs: the tab bar is inside the panel, so a
      // width that depended on the tab would resize the box under the cursor
      // that clicked it.
      wide
      footer={
        <>
          {tab === "repo" && selected ? (
            <input
              className="dd-repo-name-field"
              value={name}
              aria-label="Project name"
              placeholder={selected.name}
              onChange={(e) => {
                setName(e.target.value);
                setRenamed(true);
              }}
            />
          ) : (
            <span className="dd-repo-hint">
              {tab === "repo" ? "pick a repository to continue" : "a machine with no clone on it"}
            </span>
          )}
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" disabled={!canCreate || busy} onClick={() => void create()}>
            {busy ? "Creating…" : "Create project"}
          </button>
        </>
      }
    >
      <div className="tabs dd-repo-tabs">
        <button type="button" className={tab === "repo" ? "tab on" : "tab"} onClick={() => setTab("repo")}>
          From a repository
        </button>
        <button type="button" className={tab === "blank" ? "tab on" : "tab"} onClick={() => setTab("blank")}>
          Blank machine
        </button>
      </div>

      {failure ? <div className="dd-modal-error">{failure}</div> : null}

      {tab === "blank" ? (
        <div className="dd-repo-blank">
          <label htmlFor="dd-blank-name">Name</label>
          <input
            id="dd-blank-name"
            value={blankName}
            data-autofocus
            placeholder="scratch"
            onChange={(e) => setBlankName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && blankName.trim()) {
                e.preventDefault();
                void create();
              }
            }}
          />
          <p className="fine">
            No repository, no clone. Every thread here starts in <code>/home/sprite</code> on an empty machine with the
            project's packages and setup script already run. You can still <code>git clone</code> something once you are
            in.
          </p>
        </div>
      ) : !capabilities.github ? (
        <div className="empty dd-repo-state">
          <h3>This drydock has no GitHub App</h3>
          <p>
            Repositories, pull requests, issues and checks are all off until one is configured. The server reads{" "}
            <code>GITHUB_APP_ID</code>, <code>GITHUB_APP_PRIVATE_KEY</code>, <code>GITHUB_OAUTH_CLIENT_ID</code>,{" "}
            <code>GITHUB_OAUTH_CLIENT_SECRET</code> and <code>GITHUB_WEBHOOK_SECRET</code> from its environment.
          </p>
          <p>Until then a blank machine is the project you can make.</p>
          <button type="button" onClick={() => setTab("blank")}>
            Make a blank machine
          </button>
        </div>
      ) : repos.state === "error" ? (
        <div className="empty dd-repo-state">
          <h3>GitHub would not answer</h3>
          <p>{repos.message}</p>
          <button type="button" onClick={load}>
            Try again
          </button>
        </div>
      ) : repos.state === "loading" || repos.state === "idle" ? (
        <>
          {searchRow}
          <div className="dd-repo-list" aria-busy="true">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div className="dd-repo-skel" key={i}>
                <div className="skeleton" style={{ width: `${34 + ((i * 13) % 30)}%`, height: 13 }} />
                <div className="skeleton" style={{ width: `${20 + ((i * 17) % 24)}%`, height: 10 }} />
              </div>
            ))}
          </div>
        </>
      ) : rows.length === 0 || viewer?.hasInstallation === false ? (
        <div className="empty dd-repo-state">
          <h3>Drydock cannot see any repositories</h3>
          <p>
            {viewer?.hasInstallation === false
              ? "The app is not installed on any account you belong to, so there is nothing for it to read."
              : "The installation exists but no repository is shared with it. Widen the list on GitHub and this fills in."}
          </p>
          <a className="dd-repo-install" href="/api/auth/install">
            Give drydock access to your repositories
          </a>
        </div>
      ) : (
        <>
          {searchRow}
          <div className="dd-repo-list" ref={list}>
            {shown.length === 0 ? (
              <div className="empty dd-repo-state">
                <h3>Nothing matches “{query.trim()}”</h3>
                <p>
                  {rows.length} repositories are visible to drydock. If the one you want is not among them, add it to the
                  installation on GitHub.
                </p>
              </div>
            ) : (
              shown.map((repo) => (
                <button
                  type="button"
                  key={repo.fullName}
                  data-repo={repo.fullName}
                  className={repo.fullName === picked ? "dd-repo-row on" : "dd-repo-row"}
                  aria-pressed={repo.fullName === picked}
                  onClick={() => choose(repo)}
                  onDoubleClick={() => void create()}
                >
                  <span className="dd-repo-top">
                    <RepoIcon />
                    <span className="mono dd-repo-full clip">{repo.fullName}</span>
                    <span className="chip dd-repo-vis">{repo.private ? "private" : "public"}</span>
                    <span className="spacer" />
                    {repo.language ? <span className="dd-repo-meta">{repo.language}</span> : null}
                    <span className="dd-repo-meta">pushed {ago(repo.pushedAt)}</span>
                  </span>
                  {repo.description ? <span className="dd-repo-desc clip">{repo.description}</span> : null}
                </button>
              ))
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

/** The server's own words where there are any; the browser's only when the request never landed. */
function messageOf(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "The request did not reach the server.";
}

/** Coarse on purpose: "3d ago" is what the list is sorted by, not a timestamp. */
function ago(iso: string | null): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "never";
  const minutes = Math.floor((Date.now() - then) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 365) return `${days}d ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** Repository names hold `.` and `-`, which a bare attribute selector will not carry. */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="7" cy="7" r="4.25" />
      <path d="M10.2 10.2L13.5 13.5" strokeLinecap="round" />
    </svg>
  );
}

function RepoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M3.25 2.75h7.5a1.5 1.5 0 011.5 1.5v9h-9a1.5 1.5 0 01-1.5-1.5V4.25a1.5 1.5 0 011.5-1.5z" />
      <path d="M2.25 11.25a1.5 1.5 0 011.5-1.5h8.5" />
    </svg>
  );
}
