/**
 * A conversation's membership in the workbench tree is recorded on Fountain,
 * in its `channel_id`, as `workbench:<project>/<item>`. Both the browser and
 * the server read and write that format, so it lives here, shared.
 */
const CHANNEL_PREFIX = "workbench:";

export function channelFor(projectId: string, itemId: string): string {
  return `${CHANNEL_PREFIX}${projectId}/${itemId}`;
}

/** Every channel of one project starts with this. */
export function channelPrefix(projectId: string): string {
  return `${CHANNEL_PREFIX}${projectId}/`;
}

/** The (project, item) a channel id names, or null if it is not one of ours. */
export function parseChannel(channelId: string | null | undefined): { projectId: string; itemId: string } | null {
  if (!channelId || !channelId.startsWith(CHANNEL_PREFIX)) return null;
  const rest = channelId.slice(CHANNEL_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return null;
  const projectId = rest.slice(0, slash);
  const itemId = rest.slice(slash + 1);
  if (!/^[\w-]+$/.test(projectId) || !/^[\w-]+$/.test(itemId)) return null;
  return { projectId, itemId };
}

/** A short, URL-safe, channel-safe id. Not a UUID on purpose: it appears in `channel_id` and the hash. */
export function newId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Conversation titles are written as `<agent>: <item title>`; get the item title back. */
export function conversationTitle(agentName: string, itemTitle: string): string {
  const t = `${agentName}: ${itemTitle}`;
  return t.length > 120 ? t.slice(0, 119) + "…" : t;
}

export function recoveredTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  const colon = title.indexOf(": ");
  return colon > 0 ? title.slice(colon + 2) : title;
}
