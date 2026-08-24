import type { ReactNode } from "react";
import { useStore } from "../store";
import { href, useRoute } from "../router";

export function Layout({ email, onSettings, onSignOut, children }: { email: string | null; onSettings: () => void; onSignOut: () => void; children: ReactNode }) {
  const { settings, connected, error, state } = useStore();
  const route = useRoute();
  const host = settings.baseUrl.replace(/^https?:\/\//, "");
  const project = route.page === "project" || route.page === "item" ? state.projects.find((p) => p.id === route.projectId) : null;
  const item = route.page === "item" ? state.items.find((w) => w.id === route.itemId) : null;

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href={href.projects()}>
          Workbench
        </a>
        <nav className="crumbs">
          <a className={`navlink ${route.page === "projects" ? "on" : ""}`} href={href.projects()}>
            Projects
          </a>
          {project && (
            <>
              <span className="muted">/</span>
              <a className={`navlink ${route.page === "project" ? "on" : ""}`} href={href.project(project.id)}>
                {project.name}
              </a>
            </>
          )}
          {project && item && (
            <>
              <span className="muted">/</span>
              <a className="navlink on ellipsis" href={href.item(project.id, item.id)}>
                {item.title}
              </a>
            </>
          )}
        </nav>
        <span className="spacer" />
        <a className={`navlink ${route.page === "team" ? "on" : ""}`} href={href.team()}>
          Team
        </a>
        <span className={`link-dot ${connected ? "" : "off"}`} title={connected ? "Live" : "Reconnecting…"} />
        <span className="muted small host" title={email ?? undefined}>
          {email ? `${email} · ` : ""}
          {host}
        </span>
        <button className="secondary small" onClick={onSettings}>
          Settings
        </button>
        <button className="secondary small" onClick={onSignOut}>
          Sign out
        </button>
      </header>
      {error && <div className="banner error">{error}</div>}
      <main className="main">{children}</main>
    </div>
  );
}
