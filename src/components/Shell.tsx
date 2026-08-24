/**
 * The frame around every page, laid out like an IDE: a thin top bar (project
 * picker, the project's pages, theme, sign out), the explorer tree of work
 * items → computers → conversations on the left, editor tabs over the main
 * area for whatever has been opened, and a status bar along the bottom. On
 * a narrow screen the explorer is a drawer behind ☰. ⌘K opens the palette
 * over the project — the one way to find something across its threads.
 */
import { useEffect, useState, type ReactNode } from "react";
import { useProjectMaybe, useWorkbench } from "../store";
import { href, navigate, useRoute } from "../router";
import { Sidebar } from "./Sidebar";
import { TabBar } from "./TabBar";
import { StatusBar } from "./StatusBar";
import { ThemePicker } from "./ThemePicker";
import { Palette } from "./Palette";

export function Shell({ children }: { children: ReactNode }) {
  const { me, projects, signOut } = useWorkbench();
  const store = useProjectMaybe();
  const route = useRoute();
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  const projectId = "projectId" in route ? route.projectId : "";
  const project = store?.project ?? projects.find((p) => p.id === projectId) ?? null;

  // Search is a project's, so the key only means anything inside one. It is
  // caught on the way down, ahead of the composer a thread keeps focus in.
  const inProject = !!store;
  useEffect(() => {
    if (!inProject) return;
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((v) => !v);
      }
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, [inProject]);

  // A palette left open across a move to another project would search the wrong one.
  useEffect(() => setPalette(false), [projectId]);

  return (
    <div className="app ide">
      <header className="topbar">
        {store && (
          <button type="button" className="icon menu" onClick={() => setDrawer((v) => !v)} aria-label="Toggle the explorer">
            ☰
          </button>
        )}
        <a className="brand" href={href.projects()} title="All projects">
          workbench
        </a>
        <span className="muted">/</span>
        <select
          className="compact project-pick"
          value={projectId}
          aria-label="Project"
          onChange={(e) => {
            const v = e.target.value;
            navigate(v ? href.project(v) : href.projects());
          }}
        >
          <option value="">all projects…</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.role === "member" ? ` (${p.ownerEmail.split("@")[0]})` : ""}
            </option>
          ))}
          {project && !projects.some((p) => p.id === project.id) && <option value={project.id}>{project.name}</option>}
        </select>
        {project && (
          <nav className="crumbs">
            <a className={`navlink ${route.page === "project" ? "on" : ""}`} href={href.project(project.id)}>
              work
            </a>
            <a className={`navlink ${route.page === "team" ? "on" : ""}`} href={href.team(project.id)}>
              team
            </a>
            <a className={`navlink ${route.page === "people" ? "on" : ""}`} href={href.people(project.id)}>
              people
            </a>
          </nav>
        )}
        <span className="spacer" />
        {store && (
          <button type="button" className="secondary small find" onClick={() => setPalette(true)} title="Search this project (⌘K)">
            <span aria-hidden="true">⌕</span> search <kbd>⌘K</kbd>
          </button>
        )}
        {!store && (
          <span className="muted small host" title={me.email}>
            {me.email}
          </span>
        )}
        <ThemePicker />
        <button className="secondary small" onClick={signOut}>
          sign out
        </button>
      </header>
      {store?.error && <div className="banner error">{store.error}</div>}
      <div className="shell-body">
        {store && <Sidebar open={drawer} onNavigate={() => setDrawer(false)} />}
        {store && drawer && <div className="drawer-backdrop" onClick={() => setDrawer(false)} />}
        <div className="editor">
          {store && <TabBar />}
          <main className="main">{children}</main>
        </div>
      </div>
      {store && <StatusBar />}
      {store && palette && <Palette onClose={() => setPalette(false)} />}
    </div>
  );
}
