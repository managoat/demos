/**
 * The shell: session, projects, threads, and which of them you are looking at.
 *
 * All of the app's shared state is here and there is not much of it, which is
 * on purpose. The rule the whole client follows is the one the server follows:
 * **Fountain owns the truth, so ask rather than cache.** A thread's status, its
 * turn count and whether its machine is up are re-read whenever something says
 * they might have moved — they are never patched in place from an event,
 * because a patch is a second implementation of a shape the server already
 * builds, and the two will disagree on the day it matters.
 *
 * So the project stream carries no data. It says *something changed* and this
 * component re-lists. That is one request per change instead of zero, and it
 * is worth it: there is exactly one place a `Thread` is constructed and it is
 * on the server.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Capabilities, Project, SessionInfo, Thread } from "../shared/api";
import * as api from "./api/client";
import { ApiError } from "./api/client";
import { parseRoute, go, type Route } from "./lib/route";
import { Rail } from "./components/Rail";
import { Home, SignIn } from "./components/Home";
import { ThreadView } from "./components/ThreadView";
import { Inspector } from "./components/Inspector";
import { NewProject } from "./components/NewProject";
import { CreateFrom } from "./components/CreateFrom";
import { ProjectView } from "./components/ProjectView";

export function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  const [projects, setProjects] = useState<Project[]>([]);
  const [threads, setThreads] = useState<Record<string, Thread[]>>({});
  const [newProject, setNewProject] = useState(false);
  const [newThreadIn, setNewThreadIn] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  useEffect(() => {
    const onHash = () => setRoute(parseRoute(location.hash));
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    api.session().then(setSession).catch(() => setSession(null));
  }, []);

  const viewer = session?.viewer ?? null;
  const capabilities: Capabilities = session?.capabilities ?? { exec: false, github: false, fountain: false, models: [] };

  const loadProjects = useCallback(async () => {
    if (!viewer) return;
    try {
      setProjects(await api.listProjects());
    } catch (err) {
      setBanner(err instanceof ApiError ? err.message : "Could not list your projects.");
    }
  }, [viewer]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const projectId = route.at === "home" ? null : route.projectId;
  const threadId = route.at === "thread" ? route.threadId : null;

  const loadThreads = useCallback(
    async (id: string) => {
      try {
        const list = await api.listThreads(id);
        setThreads((prev) => ({ ...prev, [id]: list }));
      } catch (err) {
        // A project whose threads cannot be listed is still a project you can
        // open the settings of, so this is a banner rather than a screen.
        setBanner(err instanceof ApiError ? err.message : "Could not list this project's threads.");
      }
    },
    [],
  );

  useEffect(() => {
    if (projectId) void loadThreads(projectId);
  }, [projectId, loadThreads]);

  /**
   * Every project's threads, once, so the rail is complete.
   *
   * The rail nests threads under projects and a rail that only fills in the
   * project you happen to have open is a rail you cannot navigate *from* — you
   * would have to click a project to find out whether it has anything in it.
   * One request per project, on sign-in and whenever the project list changes;
   * the fast poll below stays scoped to the project actually on screen, because
   * that is the only one anybody is watching.
   */
  useEffect(() => {
    for (const p of projects) if (!threads[p.id]) void loadThreads(p.id);
    // `threads` is deliberately not a dependency: this fills gaps, and
    // depending on the thing it writes would run it again on every fill.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, loadThreads]);

  /**
   * The live connection, and the poll behind it.
   *
   * The stream tells us when *this server* changed something — a thread
   * opened, settings saved. It cannot tell us when *Fountain* did, and the
   * things Fountain changes are exactly the ones somebody is watching: a
   * machine finishing its build, a turn ending. So there is also a slow poll,
   * and it is slow because a thread that is not doing anything does not need
   * one at all. When something is building or running, it speeds up.
   */
  useEffect(() => {
    if (!projectId) return;
    const stop = api.projectStream(projectId, () => {
      void loadThreads(projectId);
      void loadProjects();
    });
    return stop;
  }, [projectId, loadThreads, loadProjects]);

  const busy = useMemo(
    () => (projectId ? (threads[projectId] ?? []).some((t) => t.status === "building" || t.status === "running") : false),
    [projectId, threads],
  );

  useEffect(() => {
    if (!projectId) return;
    const period = busy ? 3000 : 20_000;
    const timer = setInterval(() => void loadThreads(projectId), period);
    return () => clearInterval(timer);
  }, [projectId, busy, loadThreads]);

  const project = projects.find((p) => p.id === projectId) ?? null;
  const thread = (projectId ? threads[projectId] ?? [] : []).find((t) => t.id === threadId) ?? null;

  // The URL can name a thread that has been closed, or a project on another
  // account. Falling back is better than an error screen for something that
  // happens whenever somebody follows an old link.
  useEffect(() => {
    if (route.at === "thread" && threads[route.projectId] && !thread) go({ at: "project", projectId: route.projectId });
    if (route.at !== "home" && projects.length > 0 && !projects.some((p) => p.id === route.projectId)) go({ at: "home" });
  }, [route, threads, thread, projects]);

  const openThread = useCallback(
    async (id: string, body: { title?: string; prompt?: string; origin?: Partial<Thread["origin"]> }) => {
      try {
        const created = await api.openThread(id, body);
        await loadThreads(id);
        go({ at: "thread", projectId: id, threadId: created.id });
      } catch (err) {
        setBanner(err instanceof ApiError ? err.message : "Could not open that thread.");
      }
    },
    [loadThreads],
  );

  const [inspectorTab, setInspectorTab] = useState<string | undefined>(undefined);
  const openSetup = useCallback(() => setInspectorTab("setup"), []);

  // The picker needs the project, not its id — and a project that has just been
  // removed in another tab would otherwise render a modal about nothing.
  const newThreadProject = newThreadIn ? (projects.find((p) => p.id === newThreadIn) ?? null) : null;

  if (!session) return <Booting />;
  if (!viewer) return <SignIn signInUrl={session.signInUrl} capabilities={capabilities} />;

  return (
    <div className="app">
      <Rail
        viewer={viewer}
        projects={projects}
        threadsByProject={threads}
        projectId={projectId}
        threadId={threadId}
        onNewProject={() => setNewProject(true)}
        onNewThread={(id) => setNewThreadIn(id)}
        onSignOut={async () => {
          await api.signOut().catch(() => undefined);
          location.href = "/";
        }}
      />

      <main className="main">
        {banner && (
          <div className="dd-banner">
            <span className="clip">{banner}</span>
            <button className="icon" type="button" onClick={() => setBanner(null)} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}

        {project && (
          <div className="crumbs">
            <a href="#/">Home</a>
            <span className="sep">›</span>
            <a href={`#/p/${project.id}`} className={thread ? "" : "here"}>
              {project.name}
            </a>
            {thread && (
              <>
                <span className="sep">›</span>
                <span className="here">{thread.title}</span>
                {thread.branch && <code className="chip mono">{thread.branch}</code>}
                {thread.stale && (
                  <span className="chip warn" title="This thread opened before the project's settings changed.">
                    older settings
                  </span>
                )}
              </>
            )}
            <span className="spacer" />
            {project.repo && (
              <a className="chip" href={`https://github.com/${project.repo}`} target="_blank" rel="noreferrer">
                {project.repo} ↗
              </a>
            )}
          </div>
        )}

        {!project && (
          <Home viewer={viewer} capabilities={capabilities} projects={projects} onNewProject={() => setNewProject(true)} />
        )}

        {project && !thread && (
          <ProjectView
            project={project}
            threads={threads[project.id] ?? []}
            capabilities={capabilities}
            onNewThread={() => setNewThreadIn(project.id)}
            onDeleted={async () => {
              await loadProjects();
              go({ at: "home" });
            }}
          />
        )}

        {project && thread && (
          <div className="work">
            <ThreadView thread={thread} project={project} onOpenSetup={openSetup} />
            <Inspector
              thread={thread}
              project={project}
              capabilities={capabilities}
              openTab={inspectorTab}
              onTabHandled={() => setInspectorTab(undefined)}
            />
          </div>
        )}
      </main>

      {newProject && (
        <NewProject
          capabilities={capabilities}
          viewer={viewer}
          onClose={() => setNewProject(false)}
          onCreated={async (created) => {
            setNewProject(false);
            await loadProjects();
            go({ at: "project", projectId: created.id });
          }}
        />
      )}

      {newThreadProject && (
        <CreateFrom
          project={newThreadProject}
          onClose={() => setNewThreadIn(null)}
          onPick={(origin, title) => {
            setNewThreadIn(null);
            void openThread(newThreadProject.id, { title, origin });
          }}
        />
      )}
    </div>
  );
}

/**
 * The first paint, before `/api/session` answers.
 *
 * A wordless dark screen rather than a spinner: this resolves in a few
 * milliseconds on any normal request, and a spinner that flashes for one frame
 * is more noticeable than nothing at all.
 */
function Booting() {
  const shown = useRef(false);
  const [late, setLate] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      shown.current = true;
      setLate(true);
    }, 600);
    return () => clearTimeout(timer);
  }, []);
  return <div className="dd-booting">{late && <span className="dim">Starting…</span>}</div>;
}
