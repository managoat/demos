/**
 * The project's work, beside every page: each work item with its computers
 * — one collapsible per sandbox: the teammate on it, the machine's name and
 * state, the conversations on it inside. A computer belongs to the item it
 * was started for; "+" on a live one opens another conversation with the
 * same teammate there, on that item. Items with a live computer first,
 * closed items — done and won't do alike — folded away, each still saying
 * which of the two it was.
 *
 * The items sit on shelves by state — waiting on you, working, up, to do,
 * closed — each a fold with a count, so the work that needs you is at the
 * top and the backlog is one fold below it. A glyph in the gutter says the
 * same thing per row, so the list scans by its left edge. An item with no
 * computer is a checklist line, not a tree node: there is nothing under it
 * to open. A filter box at the top narrows every shelf at once.
 *
 * Nothing here reorders itself while you read it: the order comes from
 * lib/sidebar, which ranks on start times, not on activity. Work in flight
 * shows as a dot on the row it belongs to, and a row changes shelf only
 * when its state does.
 *
 * The row at the top of the tree adds a work item where you read them: type
 * what needs doing, Enter, and it is there. With a default teammate set on
 * the project, that same Enter starts them on it and opens the thread — the
 * item and the first prompt are one thought, and this is where it is typed.
 * Without one, the item is made and the composer stays open for the next.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useProject } from "../store";
import { href, navigate, useRoute } from "../router";
import { attachable, clampWidth, coarseTime, computerLabel, groupByItem, hueOf, loadFolds, loadSidebarWidth, matchesFilter, saveFolds, saveSidebarWidth, shelve, stateOf, STATE_GLYPH, STATE_LABEL, threadLabel, type Computer, type ItemGroup, type ItemState } from "../lib/sidebar";
import { defaultTeammate, isClosed, proposerName, type WorkItem } from "../lib/workbench";
import { itemAsPrompt, splitAsk, type JoinTarget } from "../lib/start";
import { describeError } from "../lib/errors";
import { ItemStatusPill } from "./ItemStatus";
import { StartDialog } from "./StartDialog";
import type { Conversation } from "../types";

export function Sidebar({ open, onNavigate }: { open: boolean; onNavigate: () => void }) {
  const { project, items, conversations, agents, sandboxes, createItem, startConversation, toast } = useProject();
  const route = useRoute();
  const [dialog, setDialog] = useState<{ join: JoinTarget | null; agentId: string | null; itemId: string | null } | null>(null);
  const [folds, setFolds] = useState<Set<ItemState>>(() => loadFolds());
  const [query, setQuery] = useState("");
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
  const shelves = useMemo(() => shelve(groups), [groups]);
  const found = query.trim() ? groups.filter((g) => matchesFilter(g.item.title, query)) : null;
  const liveCount = groups.reduce((n, g) => n + g.computers.filter((c) => c.live).length, 0);
  const busyCount = groups.reduce((n, g) => n + g.computers.filter((c) => c.busy).length, 0);
  const currentId = route.page === "conversation" ? route.conversationId : null;
  const currentItem = route.page === "item" ? route.itemId : route.page === "conversation" ? (groups.find((g) => g.computers.some((c) => c.conversations.some((x) => x.id === currentId)))?.item.id ?? null) : null;

  // One work item open at a time, and it is the one you are looking at.
  useEffect(() => {
    if (currentItem) setExpanded(currentItem);
  }, [currentItem]);

  // Who Enter starts. Null when the project has no default, or when the one
  // it names has left the team or stopped fitting — then Enter only files it.
  const boss = useMemo(() => defaultTeammate(project, agents), [project, agents]);

  // What was typed is the whole ask: its first line names the item, the rest
  // is the briefing, and the default teammate — when there is one — gets it
  // as their first prompt. Failure keeps what was typed; the store toasted.
  const addItem = async (e: FormEvent) => {
    e.preventDefault();
    const { title, notes } = splitAsk(newTitle);
    if (!title || creating) return;
    setCreating(true);
    const created = await createItem(title, notes);
    if (!created) {
      setCreating(false);
      return;
    }
    setNewTitle("");
    setExpanded(created.id);
    if (!boss) {
      setCreating(false);
      newInput.current?.focus();
      return;
    }
    try {
      const conversation = await startConversation({ item: created, agent: boss, ...itemAsPrompt(created) });
      setAdding(false);
      navigate(href.conversation(project.id, conversation.id));
      onNavigate();
    } catch (err) {
      // The item is made and in the tree; only the conversation failed.
      toast(describeError(err), "error");
      newInput.current?.focus();
    } finally {
      setCreating(false);
    }
  };

  const openComposer = () => {
    setAdding(true);
    // Already open: the click came from the empty state or a second press.
    newInput.current?.focus();
  };

  const fold = (state: ItemState) =>
    setFolds((s) => {
      const n = new Set(s);
      if (n.has(state)) n.delete(state);
      else n.add(state);
      saveFolds(n);
      return n;
    });

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
        {comp.conversations.map((c, i) => (
          <ConvLink key={c.id} c={c} ordinal={comp.conversations.length - i} item={item} agentName={agent?.name ?? null} current={c.id === currentId} onNavigate={onNavigate} />
        ))}
      </details>
    );
  };

  const group = (g: ItemGroup<WorkItem>) => {
    const state = stateOf(g);
    const hasComputers = g.computers.length > 0;
    const isOpen = hasComputers && expanded === g.item.id;
    const up = g.computers.filter((c) => c.live).length;
    const convs = g.computers.reduce((n, c) => n + c.conversations.length, 0);
    const why =
      state === "waiting" && g.item.proposal
        ? `${proposerName(g.item.proposal, agents)} proposes: ${g.item.proposal.status === "wont" ? "won't do" : "done"}`
        : state === "waiting"
          ? "new output since you looked"
          : state === "working"
            ? "a turn is running"
            : state === "up"
              ? `${up} computer${up === 1 ? "" : "s"} up, idle`
              : state === "todo"
                ? hasComputers
                  ? "no computer up"
                  : "nobody on it yet"
                : g.item.status === "wont"
                  ? "won't do"
                  : "done";
    return (
      <section key={g.item.id} className={`sidebar-item ${state} ${g.item.id === currentItem ? "current" : ""} ${isOpen ? "open" : ""} ${hasComputers ? "" : "leaf"}`}>
        <div className="sidebar-item-head tree-row">
          <span className={`item-glyph ${state}`} title={why} aria-label={why}>
            {state === "closed" && g.item.status === "wont" ? "–" : STATE_GLYPH[state]}
          </span>
          {hasComputers ? (
            <button
              type="button"
              className="tree-twisty"
              aria-expanded={isOpen}
              aria-label={isOpen ? `Collapse ${g.item.title}` : `Expand ${g.item.title}`}
              onClick={() => setExpanded(isOpen ? null : g.item.id)}
            >
              {isOpen ? "▾" : "▸"}
            </button>
          ) : (
            <span className="tree-twisty" aria-hidden="true" />
          )}
          <a href={href.item(project.id, g.item.id)} className="sidebar-item-title" onClick={onNavigate} title={g.item.title}>
            {g.item.title}
          </a>
          {isClosed(g.item.status) && <ItemStatusPill status={g.item.status} tiny />}
          {!isOpen && convs > 0 && (
            <span className="tree-count" title={`${convs} conversation${convs === 1 ? "" : "s"}${up ? `, ${up} computer${up === 1 ? "" : "s"} up` : ""}`}>
              {up ? `${up}/${convs}` : convs}
            </span>
          )}
          <button
            type="button"
            className="icon small-icon"
            title={hasComputers ? `New conversation on "${g.item.title}" — a new computer` : `Start someone on "${g.item.title}"`}
            disabled={agents.size === 0}
            onClick={() => {
              setExpanded(g.item.id);
              setDialog({ join: null, agentId: null, itemId: g.item.id });
            }}
          >
            +
          </button>
        </div>
        {isOpen && g.computers.map((comp) => computer(g.item, comp))}
      </section>
    );
  };

  const shelf = (state: ItemState, gs: ItemGroup<WorkItem>[]) => {
    const folded = folds.has(state);
    const busy = gs.filter((g) => g.busy).length;
    return (
      <div key={state} className={`sidebar-shelf ${state} ${folded ? "folded" : ""}`}>
        <button type="button" className="sidebar-group linklike-group" aria-expanded={!folded} onClick={() => fold(state)}>
          <span>
            {folded ? "▸" : "▾"} {STATE_LABEL[state]}
          </span>
          <span className="muted" title={`${gs.length} item${gs.length === 1 ? "" : "s"}${busy ? `, ${busy} with a turn running` : ""}`}>
            {gs.length}
          </span>
        </button>
        {!folded && gs.map(group)}
      </div>
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
      {items.length > 0 && (
        <div className="explorer-filter">
          <input
            type="search"
            className="explorer-filter-input"
            value={query}
            placeholder="filter work items"
            aria-label="Filter work items by title"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setQuery("");
            }}
          />
          {found && (
            <span className="muted small explorer-filter-count">
              {found.length}/{groups.length}
            </span>
          )}
        </div>
      )}
      <div className="sidebar-list">
        {adding ? (
          <form className="new-item-form" onSubmit={addItem}>
            <div className="tree-row new-item">
              <span className="tree-twisty" aria-hidden="true">
                ▸
              </span>
              <input
                ref={newInput}
                className="new-item-input"
                value={newTitle}
                autoFocus
                disabled={creating}
                placeholder={boss ? "what needs doing?" : "fix foo"}
                aria-label="New work item"
                aria-describedby="new-item-hint"
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
            </div>
            {/* Enter spends the owner's money and boots a computer: say whose name is on it before it does. */}
            <div className="new-item-hint muted" id="new-item-hint">
              {creating ? (boss ? `starting ${boss.name}…` : "adding…") : boss ? `↵ starts ${boss.name} on it` : "↵ adds it · nobody starts"}
            </div>
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
        {found ? (
          found.length > 0 ? (
            found.map(group)
          ) : (
            <div className="muted small sidebar-empty">Nothing titled like that.</div>
          )
        ) : (
          shelves.map((sh) => shelf(sh.state, sh.groups))
        )}
      </div>
      {dialog && <StartDialog itemId={dialog.itemId} join={dialog.join} initialAgentId={dialog.agentId} onClose={() => setDialog(null)} />}
      <div className="sidebar-resize" onPointerDown={startResize} role="separator" aria-orientation="vertical" aria-label="Resize the explorer" />
    </aside>
  );
}

function ConvLink({ c, ordinal, item, agentName, current, onNavigate }: { c: Conversation; ordinal: number; item: WorkItem; agentName: string | null; current: boolean; onNavigate: () => void }) {
  const { project } = useProject();
  const title = c.title ?? (c.first_prompt ? c.first_prompt.replace(/\s+/g, " ").slice(0, 60) : null);
  // The item and the teammate are the two rows above; this one says what is left.
  const label = threadLabel(title, item.title, agentName);
  const turns = c.turn_count ?? 0;
  const fallback = title ? `#${ordinal} · ${turns} turn${turns === 1 ? "" : "s"}` : null;
  return (
    <a
      href={href.conversation(project.id, c.id)}
      className={`conv-link ${current ? "current" : ""} ${c.unread ? "unread" : ""} ${c.status === "terminated" ? "retired" : ""}`}
      onClick={onNavigate}
      title={`${title ?? "(no prompt yet)"}\n${turns} turn${turns === 1 ? "" : "s"} · ${c.status}`}
    >
      <span className={`conv-link-title ellipsis${label ? "" : " conv-link-ordinal"}`}>{label ?? fallback ?? <em className="muted">(no prompt yet)</em>}</span>
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
