import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { paths } from "../router";
import { loadPrefs, savePrefs } from "../lib/prefs";
import { byActivity, childCounts, groupByDate, relativeTime, sidebarTitle, targetOf, type GroupKey } from "../lib/sidebar";
import { AgentAvatar, initials } from "./AgentAvatar";
import type { Conversation } from "../api/types";

/**
 * The conversation list that sits beside every page, the way the web UI's
 * sidebar did: grouped by recency with the running ones on top, unread
 * dots, the agent's avatar, turn and sub-conversation counts, a roots-only
 * toggle and an agent filter.
 */
export function Sidebar({ currentId, open, onNavigate }: { currentId: string | null; open: boolean; onNavigate: () => void }) {
  const { conversations, agents } = useStore();
  const [prefs, setPrefs] = useState(() => loadPrefs());
  const [agentFilter, setAgentFilter] = useState("");
  const [tick, setTick] = useState(0);
  const setPref = (p: Partial<typeof prefs>) => setPrefs(savePrefs(p));

  // "3m ago" goes stale on its own; re-render once a minute so it doesn't.
  useEffect(() => {
    const timer = window.setInterval(() => setTick((t) => t + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const counts = useMemo(() => childCounts(conversations), [conversations]);
  const agentIds = useMemo(() => [...new Set(conversations.map((c) => c.agent_id).filter((x): x is string => !!x))], [conversations]);
  const groups = useMemo(() => {
    let list = byActivity(conversations);
    if (prefs.rootsOnly) list = list.filter((c) => !c.parent_conversation_id);
    if (agentFilter) list = list.filter((c) => c.agent_id === agentFilter);
    // `tick` is a deliberate dependency: it re-buckets as conversations age.
    void tick;
    return groupByDate(list);
  }, [conversations, prefs.rootsOnly, agentFilter, tick]);

  const collapsed = new Set(prefs.collapsedGroups);
  const toggleGroup = (k: GroupKey, isOpen: boolean) => {
    const next = new Set(prefs.collapsedGroups);
    if (isOpen) next.delete(k);
    else next.add(k);
    setPref({ collapsedGroups: [...next] });
  };

  return (
    <aside className={`sidebar ${open ? "open" : ""}`}>
      <div className="sidebar-top">
        <a href={paths.new()} className="button small wide" onClick={onNavigate}>
          + New conversation
        </a>
        <div className="row sidebar-filters">
          <button
            type="button"
            className={`secondary small ${prefs.rootsOnly ? "on" : ""}`}
            onClick={() => setPref({ rootsOnly: !prefs.rootsOnly })}
            title={prefs.rootsOnly ? "Showing top-level conversations only" : "Showing every conversation, sub-conversations included"}
          >
            {prefs.rootsOnly ? "roots only" : "all"}
          </button>
          {agentIds.length > 1 && (
            <select className="compact grow" value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)} aria-label="Filter by agent">
              <option value="">every agent</option>
              {agentIds.map((id) => (
                <option key={id} value={id}>
                  {agents.get(id)?.name ?? id.slice(0, 8)}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
      <div className="sidebar-list">
        {groups.length === 0 && <div className="muted small sidebar-empty">No conversations yet.</div>}
        {groups.map((g) => (
          <details key={g.key} open={!collapsed.has(g.key)} onToggle={(e) => toggleGroup(g.key, (e.target as HTMLDetailsElement).open)}>
            <summary className="sidebar-group">
              {g.key === "Active" && <span className="live-dot" />}
              <span>{g.key}</span>
              <span className="muted">{g.items.length}</span>
            </summary>
            {g.items.map((c) => (
              <ConvLink key={c.id} c={c} current={c.id === currentId} childCount={counts.get(c.id) ?? 0} onNavigate={onNavigate} />
            ))}
          </details>
        ))}
      </div>
    </aside>
  );
}

function ConvLink({ c, current, childCount, onNavigate }: { c: Conversation; current: boolean; childCount: number; onNavigate: () => void }) {
  const { agents } = useStore();
  const agent = c.agent_id ? agents.get(c.agent_id) : undefined;
  const title = sidebarTitle(c);
  const target = targetOf(c.first_prompt) ?? agent?.name ?? c.runtime;
  return (
    <a href={paths.show(c.id)} className={`conv-link ${current ? "current" : ""} ${c.unread ? "unread" : ""}`} onClick={onNavigate} title={c.first_prompt ?? undefined}>
      <div className="conv-link-title">{title ?? <em className="muted">(no task yet)</em>}</div>
      <div className="conv-link-sub">
        <span className="conv-link-avatar">
          {agent ? <AgentAvatar agent={agent} size={18} /> : <span className="avatar" style={{ width: 18, height: 18, fontSize: 8 }}>{initials(c.runtime) || "?"}</span>}
          {c.unread && <span className="unread-dot overlay" />}
        </span>
        <span className="muted ellipsis">
          {target} · {relativeTime(c.last_active_at ?? c.updated_at)}
        </span>
        {c.turn_count > 0 && (
          <span className="count" title={`${c.turn_count} turns`}>
            {c.turn_count}
          </span>
        )}
        {childCount > 0 && (
          <span className="count branch" title={`${childCount} sub-conversations`}>
            ⑂{childCount}
          </span>
        )}
      </div>
    </a>
  );
}
