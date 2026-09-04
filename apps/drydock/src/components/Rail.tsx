/**
 * The rail: who you are, where you can go, and every project with its threads
 * nested under it.
 *
 * The nesting is the app's whole information architecture in one column, so it
 * is worth being exact about what each level means. A **project** is a
 * configuration — a repository, an agent, a set of packages — and clicking one
 * does not start anything. A **thread** under it is a machine, and clicking
 * one goes to a live conversation. That is why threads are numbered and
 * projects are not: the number is the thread's place in the project's history
 * and it is what people say to each other about them.
 */
import type { Project, Thread, Viewer } from "../../shared/api";
import { hrefFor } from "../lib/route";
import { ThemePicker } from "./ThemePicker";

interface Props {
  viewer: Viewer | null;
  projects: Project[];
  threadsByProject: Record<string, Thread[]>;
  projectId: string | null;
  threadId: string | null;
  onNewProject: () => void;
  onNewThread: (projectId: string) => void;
  onSignOut: () => void;
}

export function Rail(props: Props) {
  const { viewer, projects, threadsByProject, projectId, threadId } = props;

  return (
    <nav className="rail">
      <div className="rail-head">
        <button className="account" type="button" onClick={props.onSignOut} title="Sign out">
          {viewer?.avatarUrl ? <img src={viewer.avatarUrl} alt="" /> : <span className="dd-avatar-fallback" />}
          <span className="account-name clip">{viewer?.name || viewer?.login || "Not signed in"}</span>
          <Chevron />
        </button>
      </div>

      <div className="rail-nav">
        <a className={`rail-link${projectId ? "" : " on"}`} href="#/">
          <HomeIcon />
          Home
        </a>
        <button className="rail-link" type="button" onClick={props.onNewProject}>
          <PlusIcon />
          New project
        </button>
      </div>

      <div className="rail-section">
        <h4>Projects</h4>
        <button className="icon" type="button" onClick={props.onNewProject} title="New project" aria-label="New project">
          <PlusIcon />
        </button>
      </div>

      <div className="rail-body">
        {projects.length === 0 && <p className="rail-empty">Add a project to get started.</p>}

        {projects.map((project) => {
          const threads = threadsByProject[project.id] ?? [];
          return (
            <div key={project.id}>
              <a className="proj" href={hrefFor({ at: "project", projectId: project.id })}>
                <span className="proj-glyph">
                  <RepoIcon />
                </span>
                <span className="clip">{project.name}</span>
                <span className="spacer" />
                <button
                  className="icon proj-add"
                  type="button"
                  title="New thread"
                  aria-label={`New thread in ${project.name}`}
                  onClick={(e) => {
                    // The row is a link; the button inside it is not part of
                    // navigating to the project.
                    e.preventDefault();
                    e.stopPropagation();
                    props.onNewThread(project.id);
                  }}
                >
                  <PlusIcon />
                </button>
              </a>

              {threads.map((thread, i) => (
                <a
                  key={thread.id}
                  className={`thread-row${thread.id === threadId ? " on" : ""}`}
                  href={hrefFor({ at: "thread", projectId: project.id, threadId: thread.id })}
                >
                  <span className="thread-num">{i + 1}</span>
                  <span className="clip">{thread.title}</span>
                  <ThreadDot status={thread.status} unread={thread.unread} />
                </a>
              ))}
            </div>
          );
        })}
      </div>

      <div className="rail-foot">
        <span className="chip">{projects.length === 1 ? "1 project" : `${projects.length} projects`}</span>
        <span className="spacer" />
        <ThemePicker />
      </div>
    </nav>
  );
}

/**
 * The one-glyph summary of a thread.
 *
 * Deliberately silent in the common case: a thread that is idle and read shows
 * nothing at all, because a rail where every row carries a marker is a rail
 * where no marker means anything. Only the three states somebody would act on
 * get a dot.
 */
function ThreadDot({ status, unread }: { status: Thread["status"]; unread: boolean }) {
  if (status === "building") return <span className="dot run" title="building this thread's machine" />;
  if (status === "running") return <span className="dot run" title="taking a turn" />;
  if (status === "failed") return <span className="dot bad" title="this thread failed" />;
  if (unread) return <span className="dot ok" title="unread" />;
  return null;
}

// ── icons ──────────────────────────────────────────────────────────────
// Inline rather than a dependency: there are five of them, they are all one
// path, and an icon package is a build-time cost paid for the whole set.

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  );
}

function HomeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <path d="M2.5 7 8 2.5 13.5 7v6a.5.5 0 0 1-.5.5h-3v-4H6v4H3a.5.5 0 0 1-.5-.5V7Z" />
    </svg>
  );
}

function RepoIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <path d="M3.5 2.5h9v11h-9a1 1 0 0 1 0-2h9" />
    </svg>
  );
}

function Chevron() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="m5 6.5 3 3 3-3" />
    </svg>
  );
}
