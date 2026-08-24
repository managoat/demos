/**
 * A work item's state, read and written by both sides — the database, the
 * API, the MCP tools and the browser all carry these strings.
 *
 * There are two ways to close an item and the difference between them is the
 * whole point: `done` is "we did this", `wont` is "we decided not to do
 * this". A list where the second is spelled the same as the first cannot be
 * read — "12 done" means nothing if some of the twelve were abandoned.
 *
 * Both of them end the work, so both do the same thing to the item's
 * machines: closing one retires every conversation still live on it and its
 * computers go with them (server/projects.ts). Either can be reopened, which
 * brings nothing back.
 *
 * `wont` is the wire value; `won't do` is the only form a person sees.
 */
export const ITEM_STATUSES = ["open", "done", "wont"] as const;

export type ItemStatus = (typeof ITEM_STATUSES)[number];

/** How many items a project has in each state. */
export type ItemCounts = { [S in ItemStatus]: number };

export function emptyCounts(): ItemCounts {
  return { open: 0, done: 0, wont: 0 };
}

export function isItemStatus(v: unknown): v is ItemStatus {
  return typeof v === "string" && (ITEM_STATUSES as readonly string[]).includes(v);
}

/**
 * A status off the wire, or out of a row written before `wont` existed, or
 * out of a browser's old localStorage. Anything we do not know is open —
 * an item nobody can account for is still work.
 */
export function parseItemStatus(v: unknown): ItemStatus {
  return isItemStatus(v) ? v : "open";
}

/** Done or won't do: the work is over, and the computers do not outlive it. */
export function isClosed(status: string): boolean {
  return parseItemStatus(status) !== "open";
}

/** What a person reads. */
export function statusLabel(status: string): string {
  return parseItemStatus(status) === "wont" ? "won't do" : parseItemStatus(status);
}

/** How to say a status was set, for a notice: "Marked done", "Marked won't do". */
export function markedAs(status: string): string {
  return `Marked ${statusLabel(status)}`;
}
