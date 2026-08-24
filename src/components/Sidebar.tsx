/**
 * The project's computers, beside every page: one collapsible per sandbox —
 * the teammate on it, the machine's name and state — with the conversations
 * on it inside. Live computers first; retired ones under a fold. "+" on a
 * live computer opens another conversation with the same teammate there.
 */
import { useEffect, useMemo, useState } from "react";
import { useProject } from "../store";
import { href, useRoute } from "../router";
import { attachable, computerLabel, computersOf, itemIdOf, relativeTime, type Computer } from "../lib/sidebar";
import { AgentAvatar, initials } from "./AgentAvatar";
import { StartDialog, type JoinTarget } from "./StartDialog";
import type { Conversation } from "../types";

export function Sidebar({ open, onNavigate }: { open: boolean; onNavigate: () => void }) {
  const { project, items, conversations, agents, sandboxes } = useProject();
  const route = useRoute();
  const [dialog, setDialog] = useState<{ join: JoinTarget | null; agentId: string | null; itemId: string | null } | null>(null);
  const [showRetired, setShowRetired] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [tick, setTick] = useState(0);

  // "3m ago" goes stale on its own; re-render once a minute so it doesn't.
  useEffect(() => {
    const timer = window.setInterval(() => setTick((t) => t + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const computers = useMemo(() => {
    void tick;
    return computersOf(conversations, sandboxes);
  }, [conversations, sandboxes, tick]);
  const live = computers.filter((c) => c.live);
  const retired = computers.filter((c) => !c.live);
  const currentId = route.page === "conversation" ? route.conversationId : null;
  const currentItem = route.page === "item" ? route.itemId : null;

  const toggle = (key: string, isOpen: boolean) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (isOpen) n.delete(key);
      else n.add(key);
      return n;
    });

  const group = (comp: Computer, forceClosed = false) => {
    const agent = comp.agentId ? agents.get(comp.agentId) ?? null : null;
    const canJoin = comp.live && !!comp.sandboxId && !!agent;
    const joinable = canJoin && attachable(comp);
    const newest = comp.conversations[0];
    return (
      <details key={comp.key} open={forceClosed ? undefined : !collapsed.has(comp.key)} onToggle={(e) => toggle(comp.key, (e.target as HTMLDetailsElement).open)}>
        <summary className={`computer-head ${comp.live ? "live" : "gone"}`}>
          {agent ? (
            <AgentAvatar agent={agent} size={24} />
          ) : (
            <span className="avatar" style={{ width: 24, height: 24, fontSize: 9 }}>
              {initials(newest?.runtime ?? "?") || "?"}
            </span>
          )}
          <span className="min0 grow">
            <span className="computer-name ellipsis">
              {comp.busy && <span className="live-dot" />}
              {agent?.name ?? newest?.runtime ?? "agent"}
            </span>
            <span className="muted small ellipsis computer-sub">
              🖥 {computerLabel(comp)}
              {comp.sandbox ? ` · ${comp.sandbox.status}` : comp.live ? " · up" : " · gone"}
              {comp.busy ? " · working" : ""}
            </span>
          </span>
          {canJoin && (
            <button
              type="button"
              className="icon small-icon"
              disabled={!joinable}
              title={joinable ? `Another conversation with ${agent!.name} on this computer` : comp.sandbox ? `The computer is ${comp.sandbox.status}; a second conversation attaches once it is ready` : "Checking the computer…"}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDialog({
                  join: { sandboxId: comp.sandboxId!, label: computerLabel(comp), agentId: agent!.id },
                  agentId: agent!.id,
                  itemId: newest ? itemIdOf(newest) : null,
                });
              }}
            >
              +
            </button>
          )}
        </summary>
        {comp.conversations.map((c) => (
          <ConvLink key={c.id} c={c} current={c.id === currentId} itemTitle={items.find((w) => w.id === itemIdOf(c))?.title ?? null} onNavigate={onNavigate} />
        ))}
      </details>
    );
  };

  return (
    <aside className={`sidebar ${open ? "open" : ""}`}>
      <div className="sidebar-top">
        <button type="button" className="small wide" onClick={() => setDialog({ join: null, agentId: null, itemId: currentItem })} disabled={agents.size === 0 || items.length === 0} title={items.length === 0 ? "Add a work item first" : agents.size === 0 ? "No agents on this Fountain" : undefined}>
          + New conversation
        </button>
        <div className="muted small">
          {live.length} computer{live.length === 1 ? "" : "s"} up
          {live.some((c) => c.busy) ? ` · ${live.filter((c) => c.busy).length} working` : ""}
        </div>
      </div>
      <div className="sidebar-list">
        {computers.length === 0 && <div className="muted small sidebar-empty">No conversations in {project.name} yet.</div>}
        {live.length > 0 && <div className="sidebar-group">Active</div>}
        {live.map((c) => group(c))}
        {retired.length > 0 && (
          <>
            <button type="button" className="sidebar-group linklike-group" onClick={() => setShowRetired((v) => !v)}>
              <span>{showRetired ? "▾" : "▸"} Retired</span>
              <span className="muted">{retired.length}</span>
            </button>
            {showRetired && retired.map((c) => group(c))}
          </>
        )}
      </div>
      {dialog && <StartDialog itemId={dialog.itemId} join={dialog.join} initialAgentId={dialog.agentId} onClose={() => setDialog(null)} />}
    </aside>
  );
}

function ConvLink({ c, current, itemTitle, onNavigate }: { c: Conversation; current: boolean; itemTitle: string | null; onNavigate: () => void }) {
  const { project } = useProject();
  const title = c.title ?? (c.first_prompt ? c.first_prompt.replace(/\s+/g, " ").slice(0, 60) : null);
  return (
    <a href={href.conversation(project.id, c.id)} className={`conv-link ${current ? "current" : ""} ${c.unread ? "unread" : ""}`} onClick={onNavigate} title={c.first_prompt ?? undefined}>
      <div className="conv-link-title">{title ?? <em className="muted">(no prompt yet)</em>}</div>
      <div className="conv-link-sub">
        {c.unread && <span className="unread-dot" />}
        <span className="muted ellipsis">
          {itemTitle ?? "—"} · {relativeTime(c.last_active_at ?? c.updated_at ?? c.inserted_at)}
        </span>
        {c.status === "running" || c.status === "pending" ? <span className="count running">{c.status}</span> : c.status === "terminated" || c.status === "failed" ? <span className="count">{c.status}</span> : null}
        {(c.turn_count ?? 0) > 0 && (
          <span className="count" title={`${c.turn_count} turns`}>
            {c.turn_count}
          </span>
        )}
      </div>
    </a>
  );
}
