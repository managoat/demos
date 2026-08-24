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
 */
import { TwoStep } from "./Thread";
import { isClosed, statusLabel, type ItemStatus } from "../lib/workbench";

export function ItemStatusPill({ status, tiny = false }: { status: ItemStatus; tiny?: boolean }) {
  const tone = status === "open" ? "running" : status === "wont" ? "wont" : "terminated";
  return <span className={`pill ${tone}${tiny ? " tiny" : ""}`}>{statusLabel(status)}</span>;
}

export function CloseControls({
  status,
  live,
  compact = false,
  onSet,
}: {
  status: ItemStatus;
  /** Conversations still live on the item; they go with it when it closes. */
  live: number;
  /** Tighter labels and list-row alignment. */
  compact?: boolean;
  onSet: (status: ItemStatus) => void;
}) {
  const cls = compact ? "small self-center" : "small";
  const close = (next: ItemStatus, label: string) =>
    live > 0 ? (
      <TwoStep label={label} className={`danger ${cls}`} title={`Retires ${live} conversation${live === 1 ? "" : "s"} — the computers go with them`} onConfirm={() => onSet(next)} />
    ) : (
      <button className={`secondary ${cls}`} onClick={() => onSet(next)}>
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
  return (
    <>
      {close("done", compact ? "Done" : "Mark done")}
      {close("wont", "Won't do")}
    </>
  );
}
