/**
 * Editor-style tabs over the main area: a work item or a conversation opens
 * as a tab when navigated to, stays open until closed, and the set is
 * remembered per project in this browser. Pure functions; the component is
 * components/TabBar.tsx.
 */
export type Tab = { kind: "item"; id: string } | { kind: "conversation"; id: string };

export function tabKey(t: Tab): string {
  return `${t.kind}:${t.id}`;
}

export function sameTab(a: Tab, b: Tab): boolean {
  return a.kind === b.kind && a.id === b.id;
}

/** Add the tab at the end if it is not open already. */
export function openTab(tabs: Tab[], t: Tab): Tab[] {
  return tabs.some((x) => sameTab(x, t)) ? tabs : [...tabs, t];
}

/**
 * Close a tab. Returns the remaining tabs and, when the closed one was
 * active, the neighbour to show next (the one to its left, else right),
 * or null when nothing is left.
 */
export function closeTab(tabs: Tab[], t: Tab, active: Tab | null): { tabs: Tab[]; next: Tab | null } {
  const i = tabs.findIndex((x) => sameTab(x, t));
  if (i === -1) return { tabs, next: active };
  const rest = tabs.filter((_, j) => j !== i);
  if (!active || !sameTab(active, t)) return { tabs: rest, next: active };
  return { tabs: rest, next: rest[i - 1] ?? rest[i] ?? null };
}

/** Drop tabs whose subject no longer exists (a deleted item, a conversation gone from the list). */
export function pruneTabs(tabs: Tab[], itemIds: ReadonlySet<string>, conversationIds: ReadonlySet<string>, loaded: boolean): Tab[] {
  if (!loaded) return tabs;
  return tabs.filter((t) => (t.kind === "item" ? itemIds.has(t.id) : conversationIds.has(t.id)));
}

const KEY = (projectId: string) => `fountain-workbench.tabs.${projectId}`;

export function loadTabs(projectId: string): Tab[] {
  try {
    const raw = localStorage.getItem(KEY(projectId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is Tab => !!t && typeof t === "object" && ((t as Tab).kind === "item" || (t as Tab).kind === "conversation") && typeof (t as Tab).id === "string");
  } catch {
    return [];
  }
}

export function saveTabs(projectId: string, tabs: Tab[]): void {
  try {
    localStorage.setItem(KEY(projectId), JSON.stringify(tabs));
  } catch {
    // no storage: tabs live for the page
  }
}
