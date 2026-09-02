import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { CommsStatus, Conversation, Teammate } from "../api/types";
import { contactOffer } from "../lib/contact";
import type { FountainClient } from "../api/client";
import type { Prefs } from "../lib/prefs";
import type { NotifyPermission } from "../lib/notify";
import { Avatar } from "./Avatar";
import { Menu } from "./Menu";
import { markdownToText } from "../lib/markdown";

export type RowAction =
  | "pin"
  | "mute"
  | "unread"
  | "read"
  | "copy-id"
  | "open"
  | "remove"
  | "rename"
  | "history"
  | "thread"
  | "retire"
  | "retire-new"
  | "customize"
  | "computer"
  | "report"
  | "contact"
  | "change-number"
  | "release-contact";

interface Props {
  client: FountainClient;
  /** false until the first roster fetch settles — the empty state must not flash before that */
  loaded: boolean;
  teammates: Teammate[];
  selectedId: string | null;
  prefs: Prefs;
  notifyPermission: NotifyPermission;
  onSelect: (agentId: string) => void;
  onAdd: () => void;
  onAddExisting: () => void;
  adding: boolean;
  onSettings: () => void;
  onSignOut: () => void;
  onToggleNotify: () => void;
  onRowAction: (agentId: string, action: RowAction) => void;
  onRoutines: () => void;
  onPalette: () => void;
  onExport: () => void;
  onShortcuts: () => void;
  onRunners: () => void;
  onReport: () => void;
  connected: boolean;
  /** whether teammates can be given an email + phone here (null: not offered) */
  comms: CommsStatus | null;
  /** conversations blocked on a permission request — the row says so and sorts nothing else */
  waitingConvIds: ReadonlySet<string>;
  /** each teammate's side threads — more conversations on the same computer — by agent id */
  threads: ReadonlyMap<string, readonly Conversation[]>;
}

interface MenuState {
  agentId: string;
  x: number;
  y: number;
}

export function Roster({
  client,
  loaded,
  teammates,
  selectedId,
  prefs,
  notifyPermission,
  onSelect,
  onAdd,
  onAddExisting,
  adding,
  onSettings,
  onSignOut,
  onToggleNotify,
  onRowAction,
  onRoutines,
  onPalette,
  onExport,
  onShortcuts,
  onRunners,
  onReport,
  connected,
  comms,
  waitingConvIds,
  threads,
}: Props) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [teamMenu, setTeamMenu] = useState<{ x: number; y: number } | null>(null);
  const notifyOn = prefs.notify && notifyPermission === "granted";
  const notifyTitle =
    notifyPermission === "unsupported"
      ? "This browser cannot show notifications"
      : notifyPermission === "denied"
        ? "Notifications are blocked for this site in the browser"
        : notifyOn
          ? "Notifications on — click to turn off"
          : "Notify me when a teammate replies";

  const openMenu = (agentId: string, x: number, y: number) => setMenu({ agentId, x, y });

  return (
    <aside className="roster">
      <header className="roster-header">
        <h1>
          Team
          <span className={`link-dot ${connected ? "on" : "off"}`} title={connected ? "Live" : "Reconnecting…"} />
        </h1>
        <div className="row">
          <button
            className={`icon ${notifyOn ? "active" : ""}`}
            onClick={onToggleNotify}
            disabled={notifyPermission === "unsupported" || notifyPermission === "denied"}
            aria-label={notifyTitle}
            aria-pressed={notifyOn}
            title={notifyTitle}
          >
            {notifyOn ? "🔔" : "🔕"}
          </button>
          <button className="icon" onClick={onPalette} aria-label="Search (⌘K)" title="Jump to a teammate or search every conversation (⌘K)">
            ⌕
          </button>
          <button
            className="icon"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setTeamMenu({ x: r.left, y: r.bottom + 4 });
            }}
            aria-label="Team menu"
            title="Routines, export, settings"
          >
            ⋯
          </button>
          <button className={`icon primary ${adding ? "busy" : ""}`} onClick={onAdd} disabled={adding} aria-label="Add a teammate" title="Add a teammate — a name and a brain are picked for you; change anything later">
            {adding ? "…" : "+"}
          </button>
        </div>
      </header>
      <div className="roster-list">
        {loaded && teammates.length === 0 && (
          <div className="empty">
            <p>No one on the team yet.</p>
            <p className="muted">
              Add an agent and it gets its own computer and one ongoing conversation with you — like a
              coworker in your messages.
            </p>
            <button onClick={onAdd} disabled={adding}>
              {adding ? "Adding…" : "Add a teammate"}
            </button>
          </div>
        )}
        <ul>
          {teammates.map((t) => (
            <RosterRow
              key={t.agent_id}
              client={client}
              teammate={t}
              selected={t.agent_id === selectedId}
              pinned={prefs.pinned.includes(t.agent_id)}
              muted={prefs.muted.includes(t.agent_id)}
              markedUnread={prefs.unread.includes(t.agent_id)}
              waiting={waitingConvIds.has(t.conversation.id) || (threads.get(t.agent_id) ?? []).some((c) => waitingConvIds.has(c.id))}
              threads={threads.get(t.agent_id) ?? []}
              onSelect={() => onSelect(t.agent_id)}
              onMenu={(x, y) => openMenu(t.agent_id, x, y)}
            />
          ))}
        </ul>
      </div>
      {teamMenu && (
        <Menu
          x={teamMenu.x}
          y={teamMenu.y}
          label="Team menu"
          onClose={() => setTeamMenu(null)}
          items={[
            { label: "＋  Add an agent you already have…", onSelect: onAddExisting },
            { label: "⏰  Routines", onSelect: onRoutines, divider: true },
            { label: "🖥  Runners", onSelect: onRunners },
            { label: "⤓  Export team as a manifest", onSelect: onExport },
            { label: "⌨  Keyboard shortcuts", onSelect: onShortcuts },
            { label: "🚩  Report a problem…", onSelect: onReport },
            { label: "⚙  Settings", onSelect: onSettings, divider: true },
            { label: "⏻  Sign out", onSelect: onSignOut, danger: true },
          ]}
        />
      )}
      {menu && (
        <RowMenu
          teammate={teammates.find((t) => t.agent_id === menu.agentId) ?? null}
          prefs={prefs}
          comms={comms}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onAction={(action) => {
            setMenu(null);
            onRowAction(menu.agentId, action);
          }}
        />
      )}
    </aside>
  );
}

function RosterRow({
  client,
  teammate: t,
  selected,
  pinned,
  muted,
  markedUnread,
  waiting,
  threads,
  onSelect,
  onMenu,
}: {
  client: FountainClient;
  teammate: Teammate;
  selected: boolean;
  pinned: boolean;
  muted: boolean;
  markedUnread: boolean;
  /** blocked on a permission request: it needs an answer, not just a read */
  waiting: boolean;
  threads: readonly Conversation[];
  onSelect: () => void;
  onMenu: (x: number, y: number) => void;
}) {
  // A side thread's news counts even while the teammate is open on another thread.
  const sideUnread = threads.some((c) => c.unread);
  const sideWorking = threads.some((c) => c.status === "running");
  const unread = (!selected && (t.unread || markedUnread)) || sideUnread;
  const onContext = (e: MouseEvent) => {
    e.preventDefault();
    onMenu(e.clientX, e.clientY);
  };
  return (
    <li className={`roster-item ${waiting ? "waiting" : ""}`} onContextMenu={onContext}>
      <button className={`roster-row ${selected ? "selected" : ""}`} onClick={onSelect}>
        <div className="avatar-wrap">
          <Avatar agent={t.agent} name={t.name} client={client} />
          <span
            className={`presence ${waiting ? "waiting" : t.presence.state === "starting" && t.conversation.sandbox?.status === "ready" ? "online" : t.presence.state}`}
            title={waiting ? "Waiting on you" : t.presence.state === "starting" && t.conversation.sandbox?.status === "ready" ? "ready" : t.presence.label}
          />
        </div>
        <div className="roster-text">
          <div className="roster-line">
            <span className="name">
              {pinned && (
                <span className="pin" title="Pinned">
                  📌{" "}
                </span>
              )}
              {t.name}
            </span>
            <span className="time">
              {muted && (
                <span className="muted-mark" title="Muted">
                  🔕{" "}
                </span>
              )}
              {threads.length > 0 && (
                <span className={`threads-mark ${sideWorking ? "working" : ""}`} title={`${threads.length + 1} threads on the same computer${sideWorking ? " — one is working" : ""}`}>
                  ⧉{threads.length + 1}{" "}
                </span>
              )}
              {formatTime(t.conversation.last_active_at)}
            </span>
          </div>
          <div className="roster-line">
            <span className={`preview ${unread || waiting ? "unread" : ""} ${waiting ? "waiting" : ""}`}>
              {waiting ? "🔐 Waiting on you" : <PreviewText t={t} />}
            </span>
            {(unread || waiting) && <span className={`unread-dot ${waiting ? "waiting" : ""}`} title={waiting ? "Waiting on you" : "Unread"} />}
          </div>
        </div>
      </button>
      <button
        className="icon more"
        aria-label={`More for ${t.name}`}
        title="More"
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          onMenu(r.left, r.bottom);
        }}
      >
        ⋯
      </button>
    </li>
  );
}

function RowMenu({
  teammate,
  prefs,
  comms,
  x,
  y,
  onClose,
  onAction,
}: {
  teammate: Teammate | null;
  prefs: Prefs;
  comms: CommsStatus | null;
  x: number;
  y: number;
  onClose: () => void;
  onAction: (action: RowAction) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  if (!teammate) return null;
  const pinned = prefs.pinned.includes(teammate.agent_id);
  const muted = prefs.muted.includes(teammate.agent_id);
  const unread = teammate.unread || prefs.unread.includes(teammate.agent_id);
  const offer = contactOffer(comms, teammate);
  // keep the menu on screen
  const left = Math.min(x, window.innerWidth - 240);
  const top = Math.min(y, window.innerHeight - 300);
  return (
    <div className="menu" ref={ref} style={{ left, top }} role="menu" aria-label={`Actions for ${teammate.name}`}>
      <button role="menuitem" onClick={() => onAction("pin")}>
        {pinned ? "Unpin" : "Pin to top"}
      </button>
      <button role="menuitem" onClick={() => onAction("mute")}>
        {muted ? "Unmute notifications" : "Mute notifications"}
      </button>
      <button role="menuitem" onClick={() => onAction(unread ? "read" : "unread")}>
        {unread ? "Mark as read" : "Mark as unread"}
      </button>
      <hr />
      <button role="menuitem" onClick={() => onAction("rename")}>
        Rename…
      </button>
      <button role="menuitem" onClick={() => onAction("customize")} title="Brain, what they do, skills, apps, computer">
        Customize…
      </button>
      {teammate.agent.sandbox_provider === "runner" ? (
        <button role="menuitem" onClick={() => onAction("computer")} title="This teammate runs on a machine of yours; move them back to a computer in Fountain's cloud">
          Run in the cloud…
        </button>
      ) : (
        <button role="menuitem" onClick={() => onAction("computer")} title="Run this teammate on a machine of yours (a Mac, a GPU box, a home server) with `fountain runner`">
          Run on your own machine…
        </button>
      )}
      <button role="menuitem" onClick={() => onAction("history")}>
        History…
      </button>
      {offer.kind !== "absent" && (
        <button
          role="menuitem"
          onClick={() => onAction("contact")}
          className={offer.kind === "disabled" ? "is-disabled" : ""}
          aria-disabled={offer.kind === "disabled"}
          title={offer.kind === "disabled" ? offer.reason : "Buy this teammate an AgentMail inbox and an AgentPhone number (billed); texts from your number become prompts"}
        >
          Give email &amp; phone…
        </button>
      )}
      {teammate.contact && (
        <button role="menuitem" onClick={() => onAction("change-number")} title="Replace the number whose texts reach this teammate (clears a STOP)">
          Change the number that texts them…
        </button>
      )}
      {teammate.contact && (
        <button role="menuitem" onClick={() => onAction("release-contact")} title="Release the inbox and number upstream; mail and texts to them stop">
          Release email &amp; phone…
        </button>
      )}
      <button role="menuitem" onClick={() => onAction("thread")} title="Another conversation with this teammate on the same computer, alongside the main one — same files, its own context">
        New thread…
      </button>
      <button role="menuitem" onClick={() => onAction("retire")} title="Retire this conversation and start a new one on the same computer — files and tools stay, the context is fresh. The thread stays in History.">
        Start a fresh thread…
      </button>
      <button role="menuitem" onClick={() => onAction("retire-new")} title="End this conversation and shut down its computer; a new computer starts now for the new thread. The old one stays in History.">
        Fresh thread on a new computer…
      </button>
      <button role="menuitem" onClick={() => onAction("open")}>
        Open in Fountain
      </button>
      <button role="menuitem" onClick={() => onAction("copy-id")}>
        Copy conversation id
      </button>
      <button role="menuitem" onClick={() => onAction("report")} title="Tell the people who run this Fountain — with this thread's context attached">
        Report a problem with this teammate…
      </button>
      <hr />
      <button role="menuitem" className="danger-text" onClick={() => onAction("remove")}>
        Remove from team…
      </button>
    </div>
  );
}

function PreviewText({ t }: { t: Teammate }) {
  const p = t.preview;
  if (!p) return <em>No messages yet</em>;
  if (p.kind === "typing") return <em>typing…</em>;
  return (
    <>
      {p.kind === "you" && "You: "}
      {p.text ? markdownToText(p.text) : ""}
    </>
  );
}

export function formatTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
