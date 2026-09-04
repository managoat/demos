/**
 * The sidebar: every computer this person can open.
 *
 * Two groups, and the split is about authority rather than tidiness. The ones
 * you own are machines you can change, invite people to, and take apart; the
 * ones shared with you are a terminal somebody lent you, and the app is
 * careful everywhere else not to let those look alike.
 *
 * **New computer** makes a row and nothing else — no agent, no box, no bill —
 * until you open it, which selecting it immediately does. Renaming is here
 * rather than in the Machine panel because the name is not a property of the
 * machine: it is what *you* call it, it never reaches Fountain, and somebody
 * you invited never sees it.
 */
import { useEffect, useRef, useState } from "react";
import type { Reachable } from "../api/paddock";
import { ThemePicker } from "./ThemePicker";

export function Workspaces({
  workspaces,
  activeId,
  activeStatus,
  me,
  guest,
  onSelect,
  onAdd,
  onRename,
  onSignOut,
}: {
  workspaces: Reachable[];
  activeId: string | null;
  activeStatus: string | null;
  me: string;
  guest: boolean;
  onSelect: (id: string) => void;
  onAdd: () => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
  onSignOut: () => void;
}) {
  const own = workspaces.filter((workspace) => workspace.role === "owner");
  const shared = workspaces.filter((workspace) => workspace.role !== "owner");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    setAdding(true);
    setError(null);
    try {
      await onAdd();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add a computer.");
    } finally {
      setAdding(false);
    }
  }

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
          label={own.length === 1 ? "My computer" : "My computers"}
          workspaces={own}
          activeId={activeId}
          activeStatus={activeStatus}
          onSelect={onSelect}
          onRename={onRename}
          /* A guest has no account to hang a machine off; the Sign in panel is
             the offer that makes sense for them, and it is already on screen. */
          onAdd={guest ? undefined : add}
          adding={adding}
        />
        <WorkspaceGroup
          label="Shared with me"
          workspaces={shared}
          activeId={activeId}
          activeStatus={activeStatus}
          onSelect={onSelect}
        />
        {error && <p className="workspace-empty error">{error}</p>}
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
  onRename,
  onAdd,
  adding,
}: {
  label: string;
  workspaces: Reachable[];
  activeId: string | null;
  activeStatus: string | null;
  onSelect: (id: string) => void;
  onRename?: (id: string, name: string) => Promise<void>;
  onAdd?: () => void;
  adding?: boolean;
}) {
  // The add button belongs to the "mine" group, which is never empty for
  // somebody signed in — but the group is still rendered when it is, because
  // hiding the only way to make one is how you get stuck.
  if (workspaces.length === 0 && !onAdd) return null;
  return (
    <section className="workspace-group">
      <div className="workspace-label">
        <span>{label}</span>
        {onAdd ? (
          <button type="button" className="workspace-add" onClick={onAdd} disabled={adding} title="Add a computer">
            {adding ? "…" : "+"}
          </button>
        ) : (
          <span>{workspaces.length}</span>
        )}
      </div>
      {workspaces.map((workspace) => (
        <WorkspaceRow
          key={workspace.id}
          workspace={workspace}
          active={workspace.id === activeId}
          activeStatus={activeStatus}
          onSelect={onSelect}
          onRename={onRename}
        />
      ))}
    </section>
  );
}

function WorkspaceRow({
  workspace,
  active,
  activeStatus,
  onSelect,
  onRename,
}: {
  workspace: Reachable;
  active: boolean;
  activeStatus: string | null;
  onSelect: (id: string) => void;
  onRename?: (id: string, name: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const owned = workspace.role === "owner";
  const name = owned ? workspace.name || "My computer" : ownerName(workspace.ownerEmail);

  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  async function commit(next: string) {
    setEditing(false);
    const clean = next.trim();
    if (!onRename || !clean || clean === workspace.name) return;
    await onRename(workspace.id, clean).catch(() => undefined);
  }

  if (editing) {
    return (
      <div className="workspace editing">
        <span className="computer-icon" aria-hidden="true">
          <span />
        </span>
        <input
          ref={input}
          className="workspace-rename"
          defaultValue={workspace.name}
          maxLength={60}
          aria-label="Name this computer"
          onBlur={(e) => void commit(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commit(e.currentTarget.value);
            if (e.key === "Escape") setEditing(false);
          }}
        />
      </div>
    );
  }

  return (
    <div className={`workspace ${active ? "active" : ""}`}>
      <button
        type="button"
        className="workspace-open"
        aria-current={active ? "page" : undefined}
        onClick={() => onSelect(workspace.id)}
      >
        <span className="computer-icon" aria-hidden="true">
          <span />
        </span>
        <span className="workspace-copy">
          <strong>{name}</strong>
          <small>{owned ? "Your computer" : workspace.ownerEmail}</small>
        </span>
      </button>
      {active && <span className={`status-dot ${activeStatus === "ready" ? "ready" : ""}`} title={activeStatus ?? "Loading"} />}
      {owned && onRename && (
        <button type="button" className="workspace-edit" onClick={() => setEditing(true)} title={`Rename ${name}`}>
          ✎
        </button>
      )}
    </div>
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
