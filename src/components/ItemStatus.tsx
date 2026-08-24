/**
 * A work item's state, and the controls that change it.
 *
 * There are two ways to close an item — `done` ("we did this") and `wont`
 * ("we decided not to do this") — and telling them apart is the point: a
 * list where the two read the same cannot be read at all. Both end the
 * work, so both retire every conversation still live on the item and take
 * its computers down; that is the same loss as Retire, so a live item asks
 * first, whichever way it is being closed.
 *
 * Changing one closed state to the other costs nothing — the machines went
 * when it was first closed — so that one is a plain button.
 *
 * A teammate cannot close an item — it would retire its own conversation —
 * so it proposes instead (server/mcp.ts), and the proposal is a question
 * standing on the row: "Coder says: won't do", confirm or dismiss. While one
 * stands it replaces the plain pair, because it *is* the pair, with an answer
 * already suggested; dismissing brings them back. Confirming closes the item
 * exactly as the plain button would, and asks first the same way.
 */
import { TwoStep } from "./Thread";
import { isClosed, statusLabel, type ItemStatus, type Proposal } from "../lib/workbench";

export function ItemStatusPill({ status, tiny = false }: { status: ItemStatus; tiny?: boolean }) {
  const tone = status === "open" ? "running" : status === "wont" ? "wont" : "terminated";
  return <span className={`pill ${tone}${tiny ? " tiny" : ""}`}>{statusLabel(status)}</span>;
}

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
  const close = (next: ItemStatus, label: string, className = "secondary") =>
    live > 0 ? (
      <TwoStep label={label} className={`danger ${cls}`} title={`Retires ${live} conversation${live === 1 ? "" : "s"} — the computers go with them`} onConfirm={() => onSet(next)} />
    ) : (
      <button className={[className, cls].filter(Boolean).join(" ")} onClick={() => onSet(next)}>
        {label}
      </button>
    );

  if (isClosed(status)) {
    const other: ItemStatus = status === "done" ? "wont" : "done";
    return (
      <>
        <button className={`secondary ${cls}`} onClick={() => onSet("open")}>
          Reopen
        </button>
        <button className={`secondary ${cls}`} title={`Close it as ${statusLabel(other)} instead — nothing is running to lose`} onClick={() => onSet(other)}>
          {other === "wont" ? "Won't do" : "Done"}
        </button>
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
      {close("done", compact ? "Done" : "Mark done")}
      {close("wont", "Won't do")}
    </>
  );
}
