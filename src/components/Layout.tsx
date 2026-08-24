import type { ReactNode } from "react";
import { useProjectMaybe, useWorkbench } from "../store";
import { href, useRoute } from "../router";

export function Layout({ children }: { children: ReactNode }) {
  const { me, signOut } = useWorkbench();
  const store = useProjectMaybe();
  const route = useRoute();
  const host = me.fountainUrl.replace(/^https?:\/\//, "");
  const project = store?.project ?? null;
  const item = store && route.page === "item" ? store.items.find((w) => w.id === route.itemId) ?? null : null;

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
        {project && (
          <a className={`navlink ${route.page === "team" ? "on" : ""}`} href={href.team(project.id)}>
            Team
          </a>
        )}
        {store && <span className={`link-dot ${store.connected ? "" : "off"}`} title={store.connected ? "Live" : "Reconnecting…"} />}
        <span className="muted small host" title={`${me.email} on ${host}`}>
          {me.email} · {host}
        </span>
        <button className="secondary small" onClick={signOut}>
          Sign out
        </button>
      </header>
      {store?.error && <div className="banner error">{store.error}</div>}
      <main className="main">{children}</main>
    </div>
  );
}
