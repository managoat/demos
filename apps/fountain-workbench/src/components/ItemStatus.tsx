/**
 * A work item's state, and the controls that change it.
 *
 * There are three ways the work stops — `done` ("we did this"), `wont` ("we
 * decided not to do this") and `icebox` ("we looked at it, and not now") —
 * and telling them apart is the point: a list where any two read the same
 * cannot be read at all. All three end the work, so all three retire every
 * conversation still live on the item and take its computers down; that is
 * the same loss as Retire, so a live item asks first, whichever way it is
 * being closed. Icebox is not the cheap one: parking an item nobody will
 * come back to this month while its machine stays up is the bill this app
 * exists to keep off the owner.
 *
 * Changing one closed state to another costs nothing — the machines went
 * when it was first closed — so those are plain buttons.
 *
 * A teammate cannot close an item — it would retire its own conversation —
 * so it proposes instead (server/mcp.ts), and the proposal is a question
 * standing on the row: "Coder says: won't do", confirm or dismiss. While one
 * stands it replaces the plain pair, because it *is* the pair, with an answer
 * already suggested; dismissing brings them back. Confirming closes the item
 * exactly as the plain button would, and asks first the same way.
 */
import { TwoStep } from "./Thread";
import { CLOSED_STATUSES, CLOSE_LABEL, isClosed, statusLabel, type ClosedStatus, type ItemStatus, type Proposal } from "../lib/workbench";

export function ItemStatusPill({ status, tiny = false }: { status: ItemStatus; tiny?: boolean }) {
  // `done` is the ordinary end of a conversation's life, so it wears the same
  // tone; the other two say a thing happened that `terminated` does not cover.
  const tone = status === "open" ? "running" : status === "done" ? "terminated" : status;
  return <span className={`pill ${tone}${tiny ? " tiny" : ""}`}>{statusLabel(status)}</span>;
}

/** Why a person would reach for each of them, on the button that does it. */
const CLOSE_TITLE: Record<ClosedStatus, string> = {
  done: "We did this.",
  wont: "We decided not to do this.",
  icebox: "Looked at, and not now — off the open list without claiming it was done or refused. Reopening it is how it ends.",
};

export function CloseControls({
  status,
  live,
  proposal = null,
  proposedBy = "",
  compact = false,
  onSet,
  onDismiss,
}: {
  status: ItemStatus;
  /** Conversations still live on the item; they go with it when it closes. */
  live: number;
  /** What a teammate says should happen to it, if one has said. */
  proposal?: Proposal | null;
  /** Who said it, as a person reads it — the teammate's name (src/lib/workbench.ts). */
  proposedBy?: string;
  /** Tighter labels and list-row alignment. */
  compact?: boolean;
  onSet: (status: ItemStatus) => void;
  /** Clear a proposal without closing anything. Leaves the item open. */
  onDismiss?: () => void;
}) {
  const cls = compact ? "small self-center" : "small";
  const close = (next: ItemStatus, label: string, className = "secondary", title?: string) =>
    live > 0 ? (
      <TwoStep label={label} className={`danger ${cls}`} title={`Retires ${live} conversation${live === 1 ? "" : "s"} — the computers go with them`} onConfirm={() => onSet(next)} />
    ) : (
      <button className={[className, cls].filter(Boolean).join(" ")} title={title} onClick={() => onSet(next)}>
        {label}
      </button>
    );

  if (isClosed(status)) {
    // The other answers, whichever this one is: a closed item is re-labelled
    // for free, so all of them stay one click away rather than a reopen apart.
    return (
      <>
        <button className={`secondary ${cls}`} onClick={() => onSet("open")}>
          Reopen
        </button>
        {CLOSED_STATUSES.filter((s) => s !== status).map((s) => (
          <button key={s} className={`secondary ${cls}`} title={`Mark it ${statusLabel(s)} instead — nothing is running to lose`} onClick={() => onSet(s)}>
            {CLOSE_LABEL[s]}
          </button>
        ))}
      </>
    );
  }

  if (proposal) {
    const said = statusLabel(proposal.status);
    return (
      <>
        <span className="pill proposed self-center" title={`${proposedBy} proposed this${proposal.at ? ` on ${new Date(proposal.at).toLocaleString()}` : ""}. Nothing has been retired — the item is still open.`}>
          {proposedBy} says: {said}
        </span>
        {close(proposal.status, compact ? "Confirm" : `Confirm ${said}`, "")}
        {onDismiss && (
          <button className={`secondary ${cls}`} title="Clear the proposal and leave the item open" onClick={onDismiss}>
            Dismiss
          </button>
        )}
      </>
    );
  }

  return (
    <>
      {close("done", compact ? CLOSE_LABEL.done : "Mark done", "secondary", CLOSE_TITLE.done)}
      {close("wont", CLOSE_LABEL.wont, "secondary", CLOSE_TITLE.wont)}
      {close("icebox", CLOSE_LABEL.icebox, "secondary", CLOSE_TITLE.icebox)}
    </>
  );
}
