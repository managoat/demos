/**
 * The project's work, beside every page: each work item with its computers
 * — one collapsible per sandbox: the teammate on it, the machine's name and
 * state, the conversations on it inside. A computer belongs to the item it
 * was started for; "+" on a live one opens another conversation with the
 * same teammate there, on that item. Items with a live computer first,
 * done items folded away.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { useProject } from "../store";
import { href, useRoute } from "../router";
import { attachable, clampWidth, computerLabel, groupByItem, hueOf, loadSidebarWidth, relativeTime, saveSidebarWidth, type Computer, type ItemGroup } from "../lib/sidebar";
import type { WorkItem } from "../lib/workbench";
import { AgentAvatar, initials } from "./AgentAvatar";
import { StartDialog, type JoinTarget } from "./StartDialog";
import type { Conversation } from "../types";

export function Sidebar({ open, onNavigate }: { open: boolean; onNavigate: () => void }) {
  const { project, items, conversations, agents, sandboxes } = useProject();
  const route = useRoute();
  const [dialog, setDialog] = useState<{ join: JoinTarget | null; agentId: string | null; itemId: string | null } | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [tick, setTick] = useState(0);
  const [width, setWidth] = useState(() => loadSidebarWidth());
  const aside = useRef<HTMLElement>(null);

  // Drag the right edge: these titles are longer than any default width.
  const startResize = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const left = aside.current?.getBoundingClientRect().left ?? 0;
    const move = (ev: PointerEvent) => setWidth(clampWidth(ev.clientX - left));
    const up = (ev: PointerEvent) => {
      saveSidebarWidth(clampWidth(ev.clientX - left));
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing-col");
    };
    document.body.classList.add("resizing-col");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, []);

  // "3m ago" goes stale on its own; re-render once a minute so it doesn't.
  useEffect(() => {
    const timer = window.setInterval(() => setTick((t) => t + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const groups = useMemo(() => {
    void tick;
    return groupByItem(items, conversations, sandboxes);
  }, [items, conversations, sandboxes, tick]);
  const openGroups = groups.filter((g) => g.item.status !== "done");
  const doneGroups = groups.filter((g) => g.item.status === "done");
  const liveCount = groups.reduce((n, g) => n + g.computers.filter((c) => c.live).length, 0);
  const busyCount = groups.reduce((n, g) => n + g.computers.filter((c) => c.busy).length, 0);
  const currentId = route.page === "conversation" ? route.conversationId : null;
  const currentItem = route.page === "item" ? route.itemId : route.page === "conversation" ? (groups.find((g) => g.computers.some((c) => c.conversations.some((x) => x.id === currentId)))?.item.id ?? null) : null;

  const toggle = (key: string, isOpen: boolean) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (isOpen) n.delete(key);
      else n.add(key);
      return n;
    });

  const computer = (item: WorkItem, comp: Computer) => {
    const agent = comp.agentId ? agents.get(comp.agentId) ?? null : null;
    const canJoin = comp.live && !!comp.sandboxId && !!agent;
    const joinable = canJoin && attachable(comp);
    const newest = comp.conversations[0];
    const accent = `hsl(${hueOf(comp.sandboxId ?? comp.key)} 60% 55%)`;
    return (
      <details
        key={comp.key}
        className={`computer-card ${comp.live ? "live" : "gone"}`}
        style={{ "--accent": accent } as CSSProperties}
        open={!collapsed.has(comp.key)}
        onToggle={(e) => toggle(comp.key, (e.target as HTMLDetailsElement).open)}
      >
        <summary
          className={`computer-head ${comp.live ? "live" : "gone"}`}
          title={`${agent?.name ?? newest?.runtime ?? "agent"} on ${computerLabel(comp)}${comp.sandbox ? ` (${comp.sandbox.status})` : ""} — ${comp.conversations.length} conversation${comp.conversations.length === 1 ? "" : "s"}`}
        >
          {agent ? (
            <AgentAvatar agent={agent} size={18} />
          ) : (
            <span className="avatar" style={{ width: 18, height: 18, fontSize: 8 }}>
              {initials(newest?.runtime ?? "?") || "?"}
            </span>
          )}
          <span className="computer-name ellipsis">{agent?.name ?? newest?.runtime ?? "agent"}</span>
          <span className="computer-state">
            {comp.busy ? <span className="live-dot" /> : null}
            {comp.sandbox?.status ?? (comp.live ? "up" : "gone")}
          </span>
          {canJoin && (
            <button
              type="button"
              className="icon small-icon"
              disabled={!joinable}
              title={joinable ? `Another conversation with ${agent!.name} on this computer, on "${item.title}"` : comp.sandbox ? `The computer is ${comp.sandbox.status}; a second conversation attaches once it is ready` : "Checking the computer…"}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDialog({ join: { sandboxId: comp.sandboxId!, label: computerLabel(comp), agentId: agent!.id }, agentId: agent!.id, itemId: item.id });
              }}
            >
              +
            </button>
          )}
        </summary>
        {comp.conversations.map((c) => (
          <ConvLink key={c.id} c={c} current={c.id === currentId} onNavigate={onNavigate} />
        ))}
      </details>
    );
  };

  const group = (g: ItemGroup<WorkItem>) => (
    <section key={g.item.id} className={`sidebar-item ${g.item.id === currentItem ? "current" : ""}`}>
      <div className="sidebar-item-head tree-row">
        <a href={href.item(project.id, g.item.id)} className="sidebar-item-title ellipsis" onClick={onNavigate} title={g.item.title}>
          <span className="tree-icon">▤</span>
          {g.item.title}
          {g.unread && <span className="unread-dot" />}
        </a>
        <span className="muted small">{g.computers.filter((c) => c.live).length > 0 ? `${g.computers.filter((c) => c.live).length} up` : ""}</span>
        <button
          type="button"
          className="icon small-icon"
          title={`New conversation on "${g.item.title}" — a new computer`}
          disabled={agents.size === 0}
          onClick={() => setDialog({ join: null, agentId: null, itemId: g.item.id })}
        >
          +
        </button>
      </div>
      {g.computers.map((comp) => computer(g.item, comp))}
    </section>
  );

  return (
    <aside className={`sidebar ${open ? "open" : ""}`} ref={aside} style={{ width }}>
      <div className="sidebar-top explorer-head">
        <span className="explorer-title">explorer</span>
        <span className="muted small">
          {liveCount} up{busyCount ? ` · ${busyCount} working` : ""}
        </span>
        <button
          type="button"
          className="icon small-icon"
          title={items.length === 0 ? "Add a work item first" : agents.size === 0 ? "No agents on this Fountain" : "New conversation"}
          onClick={() => setDialog({ join: null, agentId: null, itemId: currentItem })}
          disabled={agents.size === 0 || items.length === 0}
        >
          +
        </button>
      </div>
      <div className="sidebar-list">
        {items.length === 0 && (
          <div className="muted small sidebar-empty">
            No work items in {project.name} yet. <a href={href.project(project.id)}>Add one</a>.
          </div>
        )}
        {openGroups.map(group)}
        {doneGroups.length > 0 && (
          <>
            <button type="button" className="sidebar-group linklike-group" onClick={() => setShowDone((v) => !v)}>
              <span>{showDone ? "▾" : "▸"} Done</span>
              <span className="muted">{doneGroups.length}</span>
            </button>
            {showDone && doneGroups.map(group)}
          </>
        )}
      </div>
      {dialog && <StartDialog itemId={dialog.itemId} join={dialog.join} initialAgentId={dialog.agentId} onClose={() => setDialog(null)} />}
      <div className="sidebar-resize" onPointerDown={startResize} role="separator" aria-orientation="vertical" aria-label="Resize the explorer" />
    </aside>
  );
}

function ConvLink({ c, current, onNavigate }: { c: Conversation; current: boolean; onNavigate: () => void }) {
  const { project } = useProject();
  const title = c.title ?? (c.first_prompt ? c.first_prompt.replace(/\s+/g, " ").slice(0, 60) : null);
  return (
    <a
      href={href.conversation(project.id, c.id)}
      className={`conv-link ${current ? "current" : ""} ${c.unread ? "unread" : ""} ${c.status === "terminated" ? "retired" : ""}`}
      onClick={onNavigate}
      title={`${title ?? "(no prompt yet)"}\n${c.turn_count ?? 0} turn${c.turn_count === 1 ? "" : "s"} · ${c.status}`}
    >
      <span className="conv-link-title ellipsis">{title ?? <em className="muted">(no prompt yet)</em>}</span>
      {c.status === "running" || c.status === "pending" ? (
        <span className="live-dot" title={c.status} />
      ) : c.status === "failed" ? (
        <span className="conv-flag failed" title="failed">
          ✕
        </span>
      ) : null}
      <span className="conv-link-when">{relativeTime(c.last_active_at ?? c.updated_at ?? c.inserted_at)}</span>
    </a>
  );
}
