import type { Reachable } from "../api/paddock";
import { ThemePicker } from "./ThemePicker";

export function Workspaces({
  workspaces,
  activeId,
  activeStatus,
  me,
  guest,
  onSelect,
  onSignOut,
}: {
  workspaces: Reachable[];
  activeId: string | null;
  activeStatus: string | null;
  me: string;
  guest: boolean;
  onSelect: (id: string) => void;
  onSignOut: () => void;
}) {
  const own = workspaces.filter((workspace) => workspace.role === "owner");
  const shared = workspaces.filter((workspace) => workspace.role !== "owner");

  return (
    <aside className="workspaces" aria-label="Computers">
      <div className="workspace-brand">
        <span className="brand-mark glyph">🐐</span>
        <span>
          <strong>Paddock</strong>
          <small>Cloud computers</small>
        </span>
      </div>

      <div className="workspace-scroll">
        <WorkspaceGroup
          label="My computer"
          workspaces={own}
          activeId={activeId}
          activeStatus={activeStatus}
          onSelect={onSelect}
        />
        <WorkspaceGroup
          label="Shared with me"
          workspaces={shared}
          activeId={activeId}
          activeStatus={activeStatus}
          onSelect={onSelect}
        />
        {workspaces.length === 0 && <p className="workspace-empty">Your first computer is being prepared.</p>}
      </div>

      <div className="workspace-footer">
        <ThemePicker />
        <div className="account-row">
          <span className="account-avatar">{initials(me)}</span>
          <span className="account-copy">
            <span title={me}>{me}</span>
            <small>{guest ? "Guest session" : "Signed in"}</small>
          </span>
          <button type="button" className="account-action" onClick={onSignOut} title={guest ? "Leave" : "Sign out"}>
            ↗
          </button>
        </div>
      </div>
    </aside>
  );
}

function WorkspaceGroup({
  label,
  workspaces,
  activeId,
  activeStatus,
  onSelect,
}: {
  label: string;
  workspaces: Reachable[];
  activeId: string | null;
  activeStatus: string | null;
  onSelect: (id: string) => void;
}) {
  if (workspaces.length === 0) return null;
  return (
    <section className="workspace-group">
      <div className="workspace-label">
        <span>{label}</span>
        <span>{workspaces.length}</span>
      </div>
      {workspaces.map((workspace) => {
        const active = workspace.id === activeId;
        const name = workspace.role === "owner" ? "My Paddock" : ownerName(workspace.ownerEmail);
        return (
          <button
            type="button"
            key={workspace.id}
            className={`workspace ${active ? "active" : ""}`}
            aria-current={active ? "page" : undefined}
            onClick={() => onSelect(workspace.id)}
          >
            <span className="computer-icon" aria-hidden="true"><span /></span>
            <span className="workspace-copy">
              <strong>{name}</strong>
              <small>{workspace.role === "owner" ? "Your computer" : workspace.ownerEmail}</small>
            </span>
            {active && <span className={`status-dot ${activeStatus === "ready" ? "ready" : ""}`} title={activeStatus ?? "Loading"} />}
          </button>
        );
      })}
    </section>
  );
}

function ownerName(email: string): string {
  const name = email.split("@")[0]?.replace(/[._-]+/g, " ").trim();
  return name ? `${name.replace(/\b\w/g, (letter) => letter.toUpperCase())}'s Paddock` : "Shared Paddock";
}

function initials(label: string): string {
  const name = label.split("@")[0] ?? label;
  return name
    .split(/[._\-\s]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "P";
}
