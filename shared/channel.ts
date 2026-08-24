/**
 * A conversation's membership in the workbench tree is recorded on Fountain,
 * in its `channel_id`, as `workbench:<project>/<item>/<tag>`. Both the
 * browser and the server read and write that format, so it lives here.
 *
 * The tag is there because a Fountain channel binds one conversation: a
 * second conversation opened on the same channel (`fresh: true`) takes the
 * binding and the first loses its `channel_id`. Two conversations on one
 * work item — the whole point of "+ Here" — need two channels, so each
 * conversation gets its own; the item is read off the prefix. Channels
 * written before the tag existed (`workbench:<project>/<item>`) still parse.
 */
const CHANNEL_PREFIX = "workbench:";

/** The channel of one work item, without a tag: the prefix every conversation on it shares. */
export function channelFor(projectId: string, itemId: string): string {
  return `${CHANNEL_PREFIX}${projectId}/${itemId}`;
}

/** A fresh channel for one new conversation on the item. */
export function newConversationChannel(projectId: string, itemId: string): string {
  return `${channelFor(projectId, itemId)}/${newId()}`;
}

/** Whether a channel names this work item (any tag, or none). */
export function channelIsItem(channelId: string | null | undefined, projectId: string, itemId: string): boolean {
  const ref = parseChannel(channelId);
  return !!ref && ref.projectId === projectId && ref.itemId === itemId;
}

/** Every channel of one project starts with this. */
export function channelPrefix(projectId: string): string {
  return `${CHANNEL_PREFIX}${projectId}/`;
}

/** The (project, item) a channel id names, or null if it is not one of ours. */
export function parseChannel(channelId: string | null | undefined): { projectId: string; itemId: string; tag: string | null } | null {
  if (!channelId || !channelId.startsWith(CHANNEL_PREFIX)) return null;
  const parts = channelId.slice(CHANNEL_PREFIX.length).split("/");
  if (parts.length < 2 || parts.length > 3) return null;
  const [projectId, itemId, tag] = parts;
  if (!projectId || !itemId || !/^[\w-]+$/.test(projectId) || !/^[\w-]+$/.test(itemId)) return null;
  if (tag !== undefined && !/^[\w-]+$/.test(tag)) return null;
  return { projectId, itemId, tag: tag ?? null };
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
