/**
 * The project's work items as a board.
 *
 * The list answers "what is there"; the board answers "where does it stand",
 * which is the question a project with agents running in it keeps raising.
 * Pure functions; the component is components/Board.tsx.
 *
 * **The columns are derived, not a field.** An item carries one thing the
 * board could sort on — its status, and there are only three (shared/status.ts).
 * A three-column board is a list with gaps in it. So the open half is split by
 * what the app already knows about the item from the conversation list and the
 * item's own proposal:
 *
 *   To do        open, nothing live on it — nobody is working
 *   In progress  open, a conversation is still live on it
 *   Needs you    open, and a teammate has proposed a verdict nobody answered
 *   Done         we did this
 *   Won't do     we decided not to do this
 *
 * An item with a proposal *and* something running is in Needs you, because
 * that column is a queue of things that stop without a person, and the card
 * still shows its running pill. An item whose conversations have all ended
 * without anyone closing it is in To do — nothing is happening on it, which is
 * what that column means — and its card says how many conversations it had, so
 * "never started" and "stalled" read apart.
 *
 * **Only two and a half columns are writable, and the board says so.** The
 * point of deriving the columns is that they cannot lie about the state; the
 * cost is that most drags cannot be honoured, because there is no field behind
 * them. Dragging a card into In progress would have to start a conversation
 * and spend the owner's money, and dragging one out of it would have to retire
 * one. So `dropOn` returns what a drag actually is:
 *
 *   → Done / Won't do        set that status. This closes the item, which
 *                            retires every conversation on it and takes its
 *                            computers down — so the caller confirms first,
 *                            exactly as the button does (components/ItemStatus.tsx).
 *   Done/Won't do → To do    reopen. It lands where its facts put it.
 *   Needs you → To do        dismiss the proposal — the Dismiss button, dragged.
 *      or In progress        Nothing is retired; the item stays open.
 *   anything else            refused, with the reason, rather than a card that
 *                            slides back with no explanation.
 */
import { isClosed, type ItemStatus, type Proposal } from "../../shared/status";
import { channelIsItem } from "../../shared/channel";
import type { Conversation } from "../types";

export type ColumnId = "todo" | "doing" | "waiting" | "done" | "wont";

export interface Column {
  id: ColumnId;
  /** What a person reads at the top of it. */
  title: string;
  /** What being in it means — the column's tooltip, and its empty state. */
  meaning: string;
}

export const BOARD_COLUMNS: readonly Column[] = [
  { id: "todo", title: "To do", meaning: "Open, with nothing running on it." },
  { id: "doing", title: "In progress", meaning: "A conversation is still live on it." },
  { id: "waiting", title: "Needs you", meaning: "A teammate has proposed a verdict. Confirm it or dismiss it." },
  { id: "done", title: "Done", meaning: "We did this. Its computers went when it closed." },
  { id: "wont", title: "Won't do", meaning: "We decided not to do this. The same close, the other answer." },
];

/** As much of a work item as the board reads. */
export interface BoardItem {
  id: string;
  title: string;
  notes: string;
  status: ItemStatus;
  agentIds: string[];
  createdAt: string;
  proposal: Proposal | null;
}

/** A work item on the board, with what the conversation list says about it. */
export interface Card<I extends BoardItem = BoardItem> {
  item: I;
  column: ColumnId;
  /** Conversations on it that have not ended — what a close would retire. */
  live: number;
  /** Turns in flight right now. */
  working: number;
  /** Conversations ever started on it. */
  total: number;
  unread: boolean;
  /** Latest activity on it — shown, never sorted on. */
  latest: string;
}

/** Which column an item belongs in, given what is running on it. */
export function columnOf(item: BoardItem, live: number): ColumnId {
  if (isClosed(item.status)) return item.status === "wont" ? "wont" : "done";
  if (item.proposal) return "waiting";
  return live > 0 ? "doing" : "todo";
}

export function cardsOf<I extends BoardItem>(items: readonly I[], conversations: readonly Conversation[], projectId: string): Card<I>[] {
  return items.map((item) => {
    const convs = conversations.filter((c) => channelIsItem(c.channel_id, projectId, item.id));
    const live = convs.filter((c) => c.status !== "terminated").length;
    return {
      item,
      column: columnOf(item, live),
      live,
      working: convs.filter((c) => c.status === "running" || c.status === "pending").length,
      total: convs.length,
      unread: convs.some((c) => c.unread),
      latest: convs.reduce((m, c) => ((c.last_active_at ?? "") > m ? c.last_active_at ?? "" : m), ""),
    };
  });
}

/**
 * The board: every column, in order, with its cards. Empty columns are kept —
 * a board whose columns come and go is not one you can drop onto.
 *
 * Cards rank on when the item was *created*, newest first, the way the
 * explorer ranks everything (lib/sidebar.ts): a card must not swap places
 * with its neighbour because an agent printed a line. A card moves when its
 * state changes, which is the only movement the board is claiming to show.
 */
export function boardOf<I extends BoardItem>(
  items: readonly I[],
  conversations: readonly Conversation[],
  projectId: string,
): { column: Column; cards: Card<I>[] }[] {
  const cards = cardsOf(items, conversations, projectId);
  return BOARD_COLUMNS.map((column) => ({
    column,
    cards: cards
      .filter((c) => c.column === column.id)
      .sort((a, b) => b.item.createdAt.localeCompare(a.item.createdAt) || a.item.id.localeCompare(b.item.id)),
  }));
}

// ── what a drag actually is ───────────────────────────────────────────────

export type Drop =
  /** Write this status. Closing retires the item's conversations; the caller asks first. */
  | { kind: "set"; status: ItemStatus; note?: string }
  /** Clear the teammate's proposal and leave the item open. Retires nothing. */
  | { kind: "dismiss"; note?: string }
  /** It is already there. */
  | { kind: "same" }
  /** There is no field behind this move, and here is why. */
  | { kind: "refused"; reason: string };

/**
 * Why a column cannot be dropped into. Each one names the act that *would*
 * move an item there, because the honest answer to "why won't it go" is
 * always "because something real has to happen first".
 */
const REFUSALS: Record<ColumnId, string> = {
  todo: "Nothing takes an item out of In progress but its work ending — retire its conversations on the item, or close it.",
  doing: "In progress is not a field: an item is there while a conversation is live on it. Start a teammate on it and it moves itself.",
  waiting: "Needs you is a teammate's verdict, not a state you can put an item in — it appears when one proposes done or won't do.",
  done: "",
  wont: "",
};

/** Where a card lands once it is open again, or once its proposal is gone. */
function openLanding(card: Pick<Card, "live">): ColumnId {
  return card.live > 0 ? "doing" : "todo";
}

function landingNote(card: Pick<Card, "live">, to: ColumnId, what: string): string | undefined {
  const lands = openLanding(card);
  if (lands === to) return undefined;
  const column = BOARD_COLUMNS.find((c) => c.id === lands)!;
  return `${what} Nothing is running on it, so it is in ${column.title} — starting a teammate is what moves it.`;
}

/** What dropping this card on this column does. */
export function dropOn(card: Card, to: ColumnId): Drop {
  if (card.column === to) return { kind: "same" };

  // Closing is the one move that works from anywhere, because it is the one
  // move that is a field. It is also the expensive one: the caller confirms.
  if (to === "done" || to === "wont") return { kind: "set", status: to };

  // A closed card dragged back into the open half is Reopen. It brings
  // nothing back, so it lands wherever its (absent) conversations put it.
  if (card.column === "done" || card.column === "wont") {
    if (to === "waiting") return { kind: "refused", reason: REFUSALS.waiting };
    return { kind: "set", status: "open", note: landingNote(card, to, "Reopened.") };
  }

  // A verdict dragged back into the open half is Dismiss: the question was
  // answered with "no", and the item carries on.
  if (card.column === "waiting" && (to === "todo" || to === "doing")) {
    return { kind: "dismiss", note: landingNote(card, to, "Proposal dismissed.") };
  }

  return { kind: "refused", reason: REFUSALS[to] };
}

/**
 * What the card says under its title. To do holds two different things —
 * never started, and started and stopped without anyone closing it — and the
 * column cannot tell them apart, so the card does. When a turn is in flight
 * the running pill beside it already says so, and this does not repeat it.
 */
export function cardLine(card: Pick<Card, "total" | "working">): string {
  if (card.total === 0) return "Not started";
  const convs = `${card.total} conversation${card.total === 1 ? "" : "s"}`;
  return card.working > 0 ? convs : `${convs}, none running`;
}

// ── which view of the work you were last in ───────────────────────────────

export type ProjectView = "list" | "board";

const VIEW_KEY = "fountain-workbench.projectView";

export function isProjectView(v: unknown): v is ProjectView {
  return v === "list" || v === "board";
}

/**
 * The view this browser last chose. How you like to read a project is a
 * setting, not a navigation, so it outlives the tab — the same way the theme
 * and the explorer's width do. It is per browser and never shared: a member
 * reading the board does not move anybody else's page.
 */
export function loadProjectView(): ProjectView {
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    return isProjectView(raw) ? raw : "list";
  } catch {
    return "list";
  }
}

export function saveProjectView(view: ProjectView): void {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    // no storage: the choice lives for the page
  }
}
