/**
 * Editor tabs over the main area: every work item and conversation you
 * navigate to opens as a tab and stays until closed; the set is remembered
 * per project. The active tab is whatever the route shows.
 */
import { useEffect, useMemo, useState } from "react";
import { useProject } from "../store";
import { href, navigate, useRoute } from "../router";
import { closeTab, loadTabs, openTab, pruneTabs, sameTab, saveTabs, tabKey, type Tab } from "../lib/tabs";
import { itemIdOf } from "../lib/sidebar";

export function TabBar() {
  const { project, items, conversations, agents, resourcesLoaded } = useProject();
  const route = useRoute();
  const [tabs, setTabs] = useState<Tab[]>(() => loadTabs(project.id));

  const active: Tab | null = route.page === "item" ? { kind: "item", id: route.itemId } : route.page === "conversation" ? { kind: "conversation", id: route.conversationId } : null;

  // Navigating to something opens it.
  useEffect(() => {
    if (!active) return;
    setTabs((ts) => openTab(ts, active));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.kind, active?.id]);

  // Tabs whose subject vanished (deleted item, retired-and-gone conversation) close themselves.
  const itemIds = useMemo(() => new Set(items.map((w) => w.id)), [items]);
  const convIds = useMemo(() => new Set(conversations.map((c) => c.id)), [conversations]);
  useEffect(() => {
    setTabs((ts) => {
      const next = pruneTabs(ts, itemIds, convIds, resourcesLoaded && conversations.length > 0);
      return next.length === ts.length ? ts : next;
    });
  }, [itemIds, convIds, resourcesLoaded, conversations.length]);

  useEffect(() => saveTabs(project.id, tabs), [project.id, tabs]);

  const label = (t: Tab): { text: string; sub: string | null; icon: string } => {
    if (t.kind === "item") {
      const w = items.find((x) => x.id === t.id);
      return { text: w?.title ?? t.id.slice(0, 8), sub: null, icon: "▤" };
    }
    const c = conversations.find((x) => x.id === t.id);
    const agent = c?.agent_id ? agents.get(c.agent_id) : null;
    const item = c ? items.find((w) => w.id === itemIdOf(c)) : null;
    const raw = c?.title ?? c?.first_prompt?.replace(/\s+/g, " ") ?? t.id.slice(0, 8);
    // Titles are written "<agent>: <item>"; the tab shows the agent and the item, which is what the thread is.
    const text = agent && item ? `${agent.name} · ${item.title}` : raw;
    return { text, sub: c?.status === "running" || c?.status === "pending" ? "●" : null, icon: "❯" };
  };

  const close = (t: Tab) => {
    const { tabs: rest, next } = closeTab(tabs, t, active);
    setTabs(rest);
    if (active && sameTab(active, t)) navigate(next ? (next.kind === "item" ? href.item(project.id, next.id) : href.conversation(project.id, next.id)) : href.project(project.id));
  };

  if (tabs.length === 0) return null;
  return (
    <div className="tabbar" role="tablist">
      {tabs.map((t) => {
        const l = label(t);
        const isActive = !!active && sameTab(active, t);
        const conv = t.kind === "conversation" ? conversations.find((x) => x.id === t.id) : null;
        return (
          <a
            key={tabKey(t)}
            role="tab"
            aria-selected={isActive}
            className={`tab ${isActive ? "active" : ""} ${conv?.unread ? "unread" : ""}`}
            href={t.kind === "item" ? href.item(project.id, t.id) : href.conversation(project.id, t.id)}
            title={l.text}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                close(t);
              }
            }}
          >
            <span className={`tab-icon ${t.kind}`}>{l.icon}</span>
            <span className="tab-text ellipsis">{l.text}</span>
            {l.sub && <span className="tab-live">{l.sub}</span>}
            <button
              type="button"
              className="tab-close"
              aria-label={`Close ${l.text}`}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                close(t);
              }}
            >
              ×
            </button>
          </a>
        );
      })}
    </div>
  );
}
