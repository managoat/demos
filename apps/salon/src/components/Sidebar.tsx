import { shortName } from "../../shared/author";
import { modelLabel } from "../../shared/models";
import type { ChatDto } from "../lib/api";
import { relTime } from "../lib/format";
import { hashFor, type Route } from "../router";
import { useSession } from "../store";
import { Avatar } from "./Avatar";
import { Mark } from "./Mark";
import { Notifications } from "./Notifications";

export function Sidebar({ route, onClose }: { route: Route; onClose: () => void }) {
  const { me, chats, chatsLoaded, signOut } = useSession();
  // A chat in a project sits under the project; the rest under who hosts them.
  const byProject = new Map<string, { name: string; items: ChatDto[] }>();
  for (const c of chats) {
    if (!c.project || c.archivedAt) continue;
    const g = byProject.get(c.project.id) ?? { name: c.project.name, items: [] };
    g.items.push(c);
    byProject.set(c.project.id, g);
  }
  const archived = chats.filter((c) => c.archivedAt);
  const loose = chats.filter((c) => !c.project && !c.archivedAt);
  const hosting = loose.filter((c) => c.role === "owner");
  const invited = loose.filter((c) => c.role !== "owner");
  const current = route.page === "chat" ? route.id : null;

  return (
    <nav className="sidebar">
      <div className="side-head">
        <a href="#/" className="brand" onClick={onClose}>
          <Mark size={18} /> Salon
        </a>
        <a href="#/" className="button small" onClick={onClose}>
          + New
        </a>
      </div>
      <div className="side-list">
        {!chatsLoaded && <div className="muted small pad">Loading…</div>}
        {chatsLoaded && chats.length === 0 && <div className="muted small pad">No chats yet. Say something on the right.</div>}
        {[...byProject.entries()].map(([id, g]) => (
          <Group key={id} label={g.name} items={g.items} current={current} />
        ))}
        {hosting.length > 0 && <Group label="Your chats" items={hosting} current={current} />}
        {invited.length > 0 && <Group label="Shared with you" items={invited} current={current} />}
        {archived.length > 0 && <Group label="Archived" items={archived} current={current} />}
      </div>
      <div className="side-foot">
        <Avatar email={me.email} />
        <span className="who" title={me.email}>
          {shortName(me.email)}
        </span>
        <Notifications />
        <a className="icon side-settings" href={hashFor({ page: "preferences" })} aria-label="Preferences" title="Preferences">⚙</a>
        <button className="linklike tiny" onClick={signOut}>Sign out</button>
      </div>
    </nav>
  );
}

function Group({ label, items, current }: { label: string; items: ChatDto[]; current: string | null }) {
  return (
    <div className="side-group">
      <div className="side-label">{label}</div>
      {items.map((c) => (
        <a key={c.id} href={hashFor({ page: "chat", id: c.id })} className={`side-item${c.id === current ? " on" : ""}`}>
          <span className={`dot ${c.status ?? "unknown"}`} aria-hidden="true" />
          <span className="side-title">{c.title}</span>
          <span className="side-sub muted">
            {c.role === "member" ? `${shortName(c.ownerEmail)} · ` : ""}
            {modelLabel(c.settings.model)}
            {c.members.length ? ` · ${c.members.length + 1} people` : ""}
          </span>
          <span className="side-when muted">{relTime(c.lastActiveAt ?? c.createdAt)}</span>
        </a>
      ))}
    </div>
  );
}
