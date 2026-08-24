/**
 * The frame around every page: the top bar (project picker, the project's
 * pages, who you are, theme, sign out) and, inside a project, the sidebar of
 * computers. On a narrow screen the sidebar is a drawer behind ☰.
 */
import { useState, type ReactNode } from "react";
import { useProjectMaybe, useWorkbench } from "../store";
import { href, navigate, useRoute } from "../router";
import { Sidebar } from "./Sidebar";
import { loadTheme, nextTheme, saveTheme, THEME_GLYPH } from "../lib/theme";

export function Shell({ children }: { children: ReactNode }) {
  const { me, projects, signOut } = useWorkbench();
  const store = useProjectMaybe();
  const route = useRoute();
  const [theme, setTheme] = useState(() => loadTheme());
  const [drawer, setDrawer] = useState(false);
  const host = me.fountainUrl.replace(/^https?:\/\//, "");
  const projectId = "projectId" in route ? route.projectId : "";
  const project = store?.project ?? projects.find((p) => p.id === projectId) ?? null;

  const cycleTheme = () => {
    const t = nextTheme(theme);
    saveTheme(t);
    setTheme(t);
  };

  return (
    <div className="app">
      <header className="topbar">
        {store && (
          <button type="button" className="icon menu" onClick={() => setDrawer((v) => !v)} aria-label="Toggle the computer list">
            ☰
          </button>
        )}
        <a className="brand" href={href.projects()}>
          🛠️ Workbench
        </a>
        <select
          className="compact project-pick"
          value={projectId}
          aria-label="Project"
          onChange={(e) => {
            const v = e.target.value;
            navigate(v ? href.project(v) : href.projects());
          }}
        >
          <option value="">All projects…</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.role === "member" ? ` (${p.ownerEmail.split("@")[0]}'s)` : ""}
            </option>
          ))}
          {project && !projects.some((p) => p.id === project.id) && <option value={project.id}>{project.name}</option>}
        </select>
        {project && (
          <nav className="crumbs">
            <a className={`navlink ${route.page === "project" || route.page === "item" || route.page === "conversation" ? "on" : ""}`} href={href.project(project.id)}>
              Work
            </a>
            <a className={`navlink ${route.page === "team" ? "on" : ""}`} href={href.team(project.id)}>
              Team
            </a>
            <a className={`navlink ${route.page === "people" ? "on" : ""}`} href={href.people(project.id)}>
              People
            </a>
          </nav>
        )}
        <span className="spacer" />
        {store && <span className={`link-dot ${store.connected ? "" : "off"}`} title={store.connected ? "Live" : "Reconnecting…"} />}
        <span className="muted small host" title={`${me.email} on ${host}`}>
          {me.email} · {host}
        </span>
        <button type="button" className="icon" onClick={cycleTheme} title={`Theme: ${theme} (click to change)`} aria-label={`Theme: ${theme}`}>
          {THEME_GLYPH[theme]}
        </button>
        <button className="secondary small" onClick={signOut}>
          Sign out
        </button>
      </header>
      {store?.error && <div className="banner error">{store.error}</div>}
      <div className="shell-body">
        {store && <Sidebar open={drawer} onNavigate={() => setDrawer(false)} />}
        {store && drawer && <div className="drawer-backdrop" onClick={() => setDrawer(false)} />}
        <main className="main">{children}</main>
      </div>
    </div>
  );
}
