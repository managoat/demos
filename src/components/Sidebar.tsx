/**
 * The project's work, beside every page: each work item with its computers
 * — one collapsible per sandbox: the teammate on it, the machine's name and
 * state, the conversations on it inside. A computer belongs to the item it
 * was started for; "+" on a live one opens another conversation with the
 * same teammate there, on that item. Items with a live computer first,
 * closed items — done and won't do alike — folded away, each still saying
 * which of the two it was.
 *
 * Nothing here reorders itself while you read it: the order comes from
 * lib/sidebar, which ranks on start times, not on activity. Work in flight
 * shows as a dot on the row it belongs to.
 *
 * The row at the top of the tree adds a work item where you read them:
 * type a title, Enter, and it is there — the composer stays open for the
 * next one, and the page you are on does not move.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useProject } from "../store";
import { href, useRoute } from "../router";
import { attachable, clampWidth, coarseTime, computerLabel, groupByItem, hueOf, loadSidebarWidth, saveSidebarWidth, type Computer, type ItemGroup } from "../lib/sidebar";
import { isClosed, type WorkItem } from "../lib/workbench";
import type { JoinTarget } from "../lib/start";
import { ItemStatusPill } from "./ItemStatus";
import { StartDialog } from "./StartDialog";
import type { Conversation } from "../types";

export function Sidebar({ open, onNavigate }: { open: boolean; onNavigate: () => void }) {
  const { project, items, conversations, agents, sandboxes, createItem } = useProject();
  const route = useRoute();
  const [dialog, setDialog] = useState<{ join: JoinTarget | null; agentId: string | null; itemId: string | null } | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [tick, setTick] = useState(0);
  const [width, setWidth] = useState(() => loadSidebarWidth());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const aside = useRef<HTMLElement>(null);
  const newInput = useRef<HTMLInputElement>(null);

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
  const openGroups = groups.filter((g) => !isClosed(g.item.status));
  const closedGroups = groups.filter((g) => isClosed(g.item.status));
  const liveCount = groups.reduce((n, g) => n + g.computers.filter((c) => c.live).length, 0);
  const busyCount = groups.reduce((n, g) => n + g.computers.filter((c) => c.busy).length, 0);
  const currentId = route.page === "conversation" ? route.conversationId : null;
  const currentItem = route.page === "item" ? route.itemId : route.page === "conversation" ? (groups.find((g) => g.computers.some((c) => c.conversations.some((x) => x.id === currentId)))?.item.id ?? null) : null;

  // One work item open at a time, and it is the one you are looking at.
  useEffect(() => {
    if (currentItem) setExpanded(currentItem);
  }, [currentItem]);

  // A title is the whole of a new item here; notes and teammates come after,
  // on the item itself. Failure keeps what was typed — the store has toasted.
  const addItem = async (e: FormEvent) => {
    e.preventDefault();
    const title = newTitle.trim();
    if (!title || creating) return;
    setCreating(true);
    const created = await createItem(title);
    setCreating(false);
    if (!created) return;
    setNewTitle("");
    setExpanded(created.id);
    newInput.current?.focus();
  };

  const openComposer = () => {
    setAdding(true);
    // Already open: the click came from the empty state or a second press.
    newInput.current?.focus();
  };

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
    // Collapse hides the conversation you are in; the row it is under says so.
    const hasCurrent = comp.conversations.some((c) => c.id === currentId);
    return (
      <details
        key={comp.key}
        className={`computer-card ${comp.live ? "live" : "gone"}${hasCurrent ? " has-current" : ""}`}
        style={{ "--accent": accent } as CSSProperties}
        open={!collapsed.has(comp.key)}
        onToggle={(e) => toggle(comp.key, (e.target as HTMLDetailsElement).open)}
      >
        <summary
          className={`computer-head ${comp.live ? "live" : "gone"}`}
          title={`${agent?.name ?? newest?.runtime ?? "agent"} on ${computerLabel(comp)}${comp.sandbox ? ` (${comp.sandbox.status})` : ""} — ${comp.conversations.length} conversation${comp.conversations.length === 1 ? "" : "s"}`}
        >
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

  const group = (g: ItemGroup<WorkItem>) => {
    const isOpen = expanded === g.item.id;
    const up = g.computers.filter((c) => c.live).length;
    const convs = g.computers.reduce((n, c) => n + c.conversations.length, 0);
    return (
      <section key={g.item.id} className={`sidebar-item ${g.item.id === currentItem ? "current" : ""} ${isOpen ? "open" : ""}`}>
        <div className="sidebar-item-head tree-row">
          <button
            type="button"
            className="tree-twisty"
            aria-expanded={isOpen}
            aria-label={isOpen ? `Collapse ${g.item.title}` : `Expand ${g.item.title}`}
            onClick={() => setExpanded(isOpen ? null : g.item.id)}
          >
            {isOpen ? "▾" : "▸"}
          </button>
          <a href={href.item(project.id, g.item.id)} className="sidebar-item-title ellipsis" onClick={onNavigate} title={g.item.title}>
            {g.item.title}
          </a>
          {isClosed(g.item.status) && <ItemStatusPill status={g.item.status} tiny />}
          {g.unread && <span className="unread-dot" />}
          {g.busy && <span className="live-dot" title="a turn is running" />}
          {!isOpen && convs > 0 && (
            <span className="tree-count" title={`${convs} conversation${convs === 1 ? "" : "s"}${up ? `, ${up} computer${up === 1 ? "" : "s"} up` : ""}`}>
              {up ? `${up}/${convs}` : convs}
            </span>
          )}
          <button
            type="button"
            className="icon small-icon"
            title={`New conversation on "${g.item.title}" — a new computer`}
            disabled={agents.size === 0}
            onClick={() => {
              setExpanded(g.item.id);
              setDialog({ join: null, agentId: null, itemId: g.item.id });
            }}
          >
            +
          </button>
        </div>
        {isOpen && (g.computers.length > 0 ? g.computers.map((comp) => computer(g.item, comp)) : <div className="tree-empty muted">no computer yet</div>)}
      </section>
    );
  };

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
        {adding ? (
          <form className="tree-row new-item" onSubmit={addItem}>
            <span className="tree-twisty" aria-hidden="true">
              ▸
            </span>
            <input
              ref={newInput}
              className="new-item-input"
              value={newTitle}
              autoFocus
              disabled={creating}
              placeholder="fix foo"
              aria-label="New work item title"
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                setAdding(false);
                setNewTitle("");
              }}
              onBlur={() => {
                if (!newTitle.trim() && !creating) setAdding(false);
              }}
            />
          </form>
        ) : (
          <button type="button" className="tree-row new-item-button" onClick={openComposer} title={`New work item in ${project.name}`}>
            <span className="tree-twisty" aria-hidden="true">
              +
            </span>
            <span className="ellipsis">new work item</span>
          </button>
        )}
        {items.length === 0 && (
          <div className="muted small sidebar-empty">
            No work items in {project.name} yet.{" "}
            <button type="button" className="linklike" onClick={openComposer}>
              Add one
            </button>
            , or open <a href={href.project(project.id)}>the project</a>.
          </div>
        )}
        {openGroups.map(group)}
        {closedGroups.length > 0 && (
          <>
            <button type="button" className="sidebar-group linklike-group" onClick={() => setShowClosed((v) => !v)}>
              <span>{showClosed ? "▾" : "▸"} Closed</span>
              <span className="muted">{closedGroups.length}</span>
            </button>
            {showClosed && closedGroups.map(group)}
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
      <span className="conv-link-when">{coarseTime(c.last_active_at ?? c.updated_at ?? c.inserted_at)}</span>
    </a>
  );
}
