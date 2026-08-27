/**
 * The project's work as a board: a column per state an item can be in, and
 * cards you can drag between the columns that are actually fields.
 *
 * What the columns mean, and which drags are real writes, is lib/board.ts —
 * this is the drawing and the asking. Two things it is careful about:
 *
 * **A refused drag says why, before it is dropped.** Most of the columns are
 * derived from what is running on an item rather than stored on it, so most
 * drops cannot be honoured. A column that cannot take the card you are holding
 * says so in the column, while you hold it — because a refusal cannot be
 * reported after the fact: a `dragover` whose `dropEffect` is `none` is a drag
 * the browser never fires `drop` for, so there is no later to explain in. The
 * cursor and the sentence arrive together, and the only thing that happens on
 * release is nothing.
 *
 * **A drag can take a computer down, so it asks first.** Dropping a card on
 * Done, Won't do or Icebox closes the item, which retires every conversation
 * on it — the same loss the button warns about (ItemStatus.tsx), and easier to
 * do by accident with a pointer. Icebox is included on purpose: parking work
 * is the cheapest-sounding of the three and costs exactly as much. So a close
 * with something live on it stops on a confirm bar naming the item and the
 * cost, and the card does not move until it is answered.
 *
 * Dragging is the shortcut, never the only way: every card carries the same
 * `CloseControls` the list rows do, so the board works from a keyboard and on
 * a touch screen, where there is no drag at all.
 */
import { useMemo, useState, type DragEvent } from "react";
import { useProject } from "../store";
import { boardOf, cardLine, dropOn, type Card, type ColumnId } from "../lib/board";
import { isClosed, proposerName, statusLabel, type ItemStatus, type WorkItem } from "../lib/workbench";
import { href } from "../router";
import { formatTime } from "../lib/format";
import { CloseControls, ItemStatusPill } from "./ItemStatus";
import { AgentAvatar } from "./AgentAvatar";
import type { Agent } from "../types";

/**
 * A close waiting on an answer, because something is live on the item. It
 * names the item rather than holding the card: the bar can be up for a while,
 * and the count it is asking you to accept has to be the one that is true now
 * — another member may have started a conversation on it, or closed it
 * outright, since you let go.
 */
interface Pending {
  itemId: string;
  status: ItemStatus;
}

/** The column under the pointer mid-drag, and what it would do with the card. */
interface Hover {
  column: ColumnId;
  /** Set when the column cannot take this card — shown in it, while it is held. */
  reason: string | null;
}

export function Board() {
  const { project, items, conversations, agents, updateItem, toast } = useProject();
  const [dragging, setDragging] = useState<string | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  const board = useMemo(() => boardOf(items, conversations, project.id), [items, conversations, project.id]);
  const cards = useMemo(() => board.flatMap((c) => c.cards), [board]);
  const held = cards.find((c) => c.item.id === dragging) ?? null;

  // The item the confirm bar is asking about, as it stands now. Gone from the
  // project, or already closed by somebody else, and there is nothing to ask.
  const asking = pending ? cards.find((c) => c.item.id === pending.itemId) ?? null : null;
  const ask = asking && !isClosed(asking.item.status) && asking.live > 0 ? asking : null;

  function endDrag() {
    setDragging(null);
    setHover(null);
  }

  /** Close the item, once there is nothing left to ask about. */
  function close(card: Card<WorkItem>, status: ItemStatus) {
    setPending(null);
    void updateItem(card.item.id, { status });
  }

  function handleDrop(to: ColumnId) {
    const card = held;
    endDrag();
    if (!card) return;
    const drop = dropOn(card, to);
    // "same" and "refused" cannot reach here — `dragOver` withholds the drop
    // for both — but a browser that fires it anyway must not be misread as an
    // instruction to close something.
    if (drop.kind === "same") return;
    if (drop.kind === "refused") {
      toast(drop.reason, "error");
      return;
    }
    if (drop.note) toast(drop.note);
    if (drop.kind === "dismiss") {
      void updateItem(card.item.id, { proposal: null });
      return;
    }
    // The one drag that costs something: ask before the computers go.
    if (isClosed(drop.status) && card.live > 0) {
      setPending({ itemId: card.item.id, status: drop.status });
      return;
    }
    close(card, drop.status);
  }

  function dragOver(e: DragEvent<HTMLElement>, to: ColumnId) {
    if (!held) return;
    const drop = dropOn(held, to);
    const takes = drop.kind === "set" || drop.kind === "dismiss";
    // Cancelling the event is what allows a drop at all; `dropEffect` is what
    // decides whether one happens. A column that cannot take the card leaves
    // both off, and says why in itself instead — there is no `drop` event
    // coming to say it in.
    if (takes) e.preventDefault();
    e.dataTransfer.dropEffect = takes ? "move" : "none";
    // A card held over the column it is already in is not a move; nothing lights up.
    setHover(drop.kind === "same" ? null : { column: to, reason: drop.kind === "refused" ? drop.reason : null });
  }

  /** Leaving for a child of the same column is not leaving it. */
  function dragLeave(e: DragEvent<HTMLElement>, to: ColumnId) {
    const next = e.relatedTarget;
    if (next instanceof Node && e.currentTarget.contains(next)) return;
    setHover((h) => (h?.column === to ? null : h));
  }

  return (
    <div className="board-wrap">
      {ask && pending && (
        <div className="board-confirm">
          <span>
            Mark <span className="strong">{ask.item.title}</span> {statusLabel(pending.status)}? It retires {count(ask.live, "conversation")} — the computers go with
            them.
          </span>
          <button className="danger small" onClick={() => close(ask, pending.status)}>
            {statusLabel(pending.status)}, retire {ask.live === 1 ? "it" : "them"}
          </button>
          <button className="secondary small" onClick={() => setPending(null)}>
            Cancel
          </button>
        </div>
      )}
      <div className={`board${dragging ? " dragging" : ""}`}>
        {board.map(({ column, cards }) => (
          <section
            key={column.id}
            className={`board-col${hover?.column === column.id ? (hover.reason ? " refusing" : " over") : ""}`}
            onDragOver={(e) => dragOver(e, column.id)}
            onDragLeave={(e) => dragLeave(e, column.id)}
            onDrop={() => handleDrop(column.id)}
          >
            <header className="board-col-head" title={column.meaning}>
              <span className="strong">{column.title}</span>
              <span className="muted small">{cards.length}</span>
            </header>
            <div className="board-col-body">
              {hover?.column === column.id && hover.reason && <p className="board-refusal small">{hover.reason}</p>}
              {cards.length === 0 ? (
                <p className="board-empty muted small">{column.meaning}</p>
              ) : (
                cards.map((card) => (
                  <BoardCard
                    key={card.item.id}
                    card={card}
                    projectId={project.id}
                    agents={agents}
                    dragging={dragging === card.item.id}
                    onDragStart={() => setDragging(card.item.id)}
                    onDragEnd={endDrag}
                    /* The buttons do their own asking (TwoStep in ItemStatus.tsx); the confirm bar is the drag's. */
                    onSet={(status) => close(card, status)}
                    onDismiss={() => void updateItem(card.item.id, { proposal: null })}
                  />
                ))
              )}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

/** Exported for the test: a card has to work without a drag. */
export function BoardCard({
  card,
  projectId,
  agents,
  dragging,
  onDragStart,
  onDragEnd,
  onSet,
  onDismiss,
}: {
  card: Card<WorkItem>;
  projectId: string;
  agents: Map<string, Agent>;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onSet: (status: ItemStatus) => void;
  onDismiss: () => void;
}) {
  const w = card.item;
  const teammates = w.agentIds.map((id) => agents.get(id)).filter((a): a is NonNullable<typeof a> => !!a);
  return (
    <article
      className={`board-card${dragging ? " held" : ""}`}
      draggable
      onDragStart={(e) => {
        // Some browsers refuse a drag with nothing on the transfer.
        e.dataTransfer.setData("text/plain", w.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
    >
      {/* A link drags its own URL by default; the card is what is being dragged. */}
      <a className="board-card-main" draggable={false} href={href.item(projectId, w.id)}>
        <div className="board-card-title">
          {card.unread && <span className="unread-dot" />}
          <span className="strong">{w.title}</span>
        </div>
        <div className="board-card-pills">
          {card.working > 0 && <span className="pill running tiny">{card.working} working</span>}
          {isClosed(w.status) && <ItemStatusPill status={w.status} tiny />}
          <span className="muted small">{cardLine(card)}</span>
        </div>
        {w.notes && <div className="board-card-notes muted small">{w.notes}</div>}
      </a>
      <div className="board-card-foot">
        <div className="stack-avatars">
          {teammates.map((a) => (
            <AgentAvatar key={a.id} agent={a} size={20} />
          ))}
        </div>
        <span className="time muted">{formatTime(card.latest || w.createdAt)}</span>
      </div>
      <div className="board-card-actions">
        <CloseControls
          status={w.status}
          live={card.live}
          proposal={w.proposal}
          proposedBy={w.proposal ? proposerName(w.proposal, agents) : ""}
          compact
          onSet={onSet}
          onDismiss={onDismiss}
        />
      </div>
    </article>
  );
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
