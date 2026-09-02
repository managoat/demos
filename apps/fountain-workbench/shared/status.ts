/**
 * A work item's state, read and written by both sides — the database, the
 * API, the MCP tools and the browser all carry these strings.
 *
 * There are three ways the work on an item stops, and telling them apart is
 * the whole point: `done` is "we did this", `wont` is "we decided not to do
 * this", `icebox` is "we looked at it, and not now". A list where any of the
 * three is spelled like another cannot be read — "12 done" means nothing if
 * some of the twelve were abandoned, and an item nobody intends to pick up
 * this quarter is not a to-do.
 *
 * `icebox` is the answer to the item that keeps being read and keeps being
 * left: it is real work, so `done` is a lie and `wont` is a verdict nobody
 * reached. Left `open` it sits in the list forever and the list stops meaning
 * anything. Unlike the other two it is expected to come back — reopening one
 * is the normal end of it, not an admission that closing it was wrong.
 *
 * All three end the work, so all three do the same thing to the item's
 * machines: entering one retires every conversation still live on it and its
 * computers go with them (server/projects.ts). A parked item holding a
 * computer up is the thing this app exists not to do. Any of them can be
 * reopened, which brings nothing back.
 *
 * `wont` and `icebox` are wire values; `won't do` and `on ice` are the only
 * forms a person sees.
 */
export const CLOSED_STATUSES = ["done", "wont", "icebox"] as const;

/** A state that is not `open`: the work has stopped, whichever way. */
export type ClosedStatus = (typeof CLOSED_STATUSES)[number];

export const ITEM_STATUSES = ["open", ...CLOSED_STATUSES] as const;

export type ItemStatus = (typeof ITEM_STATUSES)[number];

/** How many items a project has in each state. */
export type ItemCounts = { [S in ItemStatus]: number };

export function emptyCounts(): ItemCounts {
  return { open: 0, done: 0, wont: 0, icebox: 0 };
}

export function isItemStatus(v: unknown): v is ItemStatus {
  return typeof v === "string" && (ITEM_STATUSES as readonly string[]).includes(v);
}

/**
 * A status off the wire, or out of a row written before `wont` or `icebox`
 * existed, or out of a browser's old localStorage. Anything we do not know is
 * open — an item nobody can account for is still work.
 */
export function parseItemStatus(v: unknown): ItemStatus {
  return isItemStatus(v) ? v : "open";
}

/**
 * Done, won't do or on ice: the work has stopped, and the computers do not
 * outlive it. The three differ in what they say about the item, never in what
 * they do to its machines.
 */
export function isClosed(status: string): status is ClosedStatus {
  return parseItemStatus(status) !== "open";
}

/** What a person reads. */
export function statusLabel(status: string): string {
  const s = parseItemStatus(status);
  return s === "wont" ? "won't do" : s === "icebox" ? "on ice" : s;
}

/**
 * The button that puts an item in this state. It names the act, or the place
 * a thing is put — "Icebox" is where an item goes; "on ice" is where it then
 * is, which is what `statusLabel` says on the row.
 */
export const CLOSE_LABEL: Record<ClosedStatus, string> = { done: "Done", wont: "Won't do", icebox: "Icebox" };

/** How to say a status was set, for a notice: "Marked done", "Marked on ice". */
export function markedAs(status: string): string {
  return `Marked ${statusLabel(status)}`;
}

// ── a verdict nobody has acted on yet ────────────────────────────────────

/**
 * The states an agent can *propose* an item is in, without putting it there.
 *
 * Closing an item retires every conversation on it and takes its computers
 * down — quite possibly the caller's own — so closing stays a person's call
 * and no MCP tool does it (server/mcp.ts). But the agent is usually the one
 * that finds out an item should not be done: it reads the code, the premise
 * is wrong, and the verdict is real work already done. Left in prose in the
 * notes, nothing counts it and nothing sorts it — which is the problem the
 * `wont` status exists to fix, one level up.
 *
 * So a proposal is a state the item carries: "Coder says: won't do", on the
 * row, until a person confirms it or dismisses it. Recording one retires
 * nothing and takes nothing down; that is the whole point of it being a
 * separate field rather than the status.
 *
 * Every way the work stops can be proposed, `icebox` included — an agent that
 * reads an item and concludes "this is real, but not now" has reached the
 * same kind of finding as "this should not be done", and the only place to
 * put it used to be prose in the notes.
 */
export const PROPOSABLE_STATUSES = CLOSED_STATUSES;

export type ProposedStatus = ClosedStatus;

export function isProposedStatus(v: unknown): v is ProposedStatus {
  return typeof v === "string" && (PROPOSABLE_STATUSES as readonly string[]).includes(v);
}

/** What an agent recommends be done with an item, and who said so. */
export interface Proposal {
  status: ProposedStatus;
  /** The agent that said it, when the proposal came from inside a conversation; a key alone names nobody. */
  agentId: string | null;
  /** The account whose Fountain key proposed it. */
  email: string;
  at: string;
}
