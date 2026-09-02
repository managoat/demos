/**
 * What a computer is called, on both sides of the wire.
 *
 * Fountain has no handle for "the machine this work went on". A sandbox id
 * appears on a conversation once one is up; a conversation that never got
 * that far — one still starting, or one that failed before Fountain had a
 * sprite for it — has none at all, and is still a row in the tree. So the
 * browser groups a work item's conversations by this key (src/lib/sidebar.ts)
 * and the server records removals against it (server/db.ts), and they agree
 * because both read it from here.
 */
export function computerKey(c: { id: string; sandbox_id?: string | null }): string {
  return c.sandbox_id ?? `conv:${c.id}`;
}

/**
 * How a removed computer is looked up. Two shapes, because two questions get
 * asked: one project's removals are keyed by item alone (server/proxy.ts),
 * and the cross-project feed has to say which project as well
 * (server/projects.ts). Both live here so the set that is built and the key
 * that is looked up in it cannot drift apart.
 */
export function removedKey(itemId: string, key: string): string {
  return `${itemId}\n${key}`;
}

export function projectRemovedKey(projectId: string, itemId: string, key: string): string {
  return `${projectId}\n${removedKey(itemId, key)}`;
}
