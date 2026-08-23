import { useState } from "react";
import type { PermissionBlock } from "../lib/feed";
import { describeEffects, describeResolution, describeTimeout, optionTone, type PermissionResolution } from "../lib/permissions";

/**
 * A teammate asking for permission, inline in the thread (fountain#940).
 *
 * The buttons are the agent's own option list, in its order, and nothing
 * else. Synthesising an "Allow" that was not offered is the one thing this
 * card must never do — the server refuses an option id the agent did not
 * advertise, and a button that 422s is worse than a button that is absent.
 *
 * A card can also resolve without anyone here touching it: another attached
 * client may answer first, the server denies on a timeout, and the end of the
 * turn refuses whatever is still open. So "answered" is never assumed from a
 * click — the card follows the `request` stage event, and the click only puts
 * it in a waiting state until that arrives.
 */
export function PermissionCard({
  request,
  resolution,
  live,
  name,
  timeoutMs,
  onAnswer,
}: {
  request: PermissionBlock;
  /** how it ended, once the stream says; null while it is still open */
  resolution: PermissionResolution | null;
  /** the turn is still running — only then can an open request be answered */
  live: boolean;
  /** the teammate's name, for "Ada wants to…" */
  name: string;
  /** how long the server waits before denying, from the ask event */
  timeoutMs: number | null;
  onAnswer: (optionId: string) => Promise<void>;
}) {
  const [sending, setSending] = useState<string | null>(null);
  // An answer that landed but whose stage event has not arrived yet. The card
  // is not marked resolved on it — the event is the only thing that says how
  // the request actually ended — but the buttons stay shut, so a second click
  // in that window cannot race the first into a 409.
  const [sent, setSent] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const answer = async (optionId: string) => {
    setSending(optionId);
    setFailed(null);
    try {
      await onAnswer(optionId);
      setSent(optionId);
    } catch (err) {
      setFailed(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(null);
    }
  };

  const title = (
    <div className="ask-head">
      <span className="ask-glyph" aria-hidden>
        🔐
      </span>
      <span className="ask-what">
        <b>{name}</b> wants to run <span className="tool-name">{request.name}</span>
        {request.summary && <span className="tool-summary">{request.summary}</span>}
      </span>
    </div>
  );

  if (resolution) {
    const tone = resolution.outcome === "answered" ? answeredTone(request, resolution) : "reject";
    return (
      <div className={`ask resolved ${tone}`}>
        {title}
        <div className="ask-outcome muted small">{describeResolution(resolution, request.options)}</div>
      </div>
    );
  }

  // No resolution and the turn is over. The server resolves a held request
  // when the turn ends, so this is a gap in what this client saw — a missed
  // event, or a turn from before the server did that — not a live request.
  if (!live) {
    return (
      <div className="ask resolved reject">
        {title}
        <div className="ask-outcome muted small">No longer waiting — the turn has ended.</div>
      </div>
    );
  }

  const waiting = describeTimeout(timeoutMs);
  return (
    <div className="ask open">
      {title}
      {request.options.length === 0 ? (
        <div className="ask-outcome muted small">
          {name} offered no options to choose from, so this cannot be answered here. It is denied when the turn ends
          {waiting ? `, or after ${waiting}` : ""}.
        </div>
      ) : (
        <>
          <div className="ask-options">
            {request.options.map((o) => (
              <button
                key={o.optionId}
                type="button"
                className={`ask-option ${optionTone(o.kind)} ${sent === o.optionId ? "chosen" : ""}`}
                disabled={sending !== null || sent !== null}
                onClick={() => void answer(o.optionId)}
              >
                {sending === o.optionId ? "…" : o.name}
              </button>
            ))}
          </div>
          <PermissionScopes request={request} />
          <div className="ask-outcome muted small">
            {sent
              ? "Sent — waiting for the agent to pick it up."
              : waiting
                ? `Denied automatically after ${waiting} if nobody answers.`
                : "Waiting for an answer."}
          </div>
        </>
      )}
      {failed && <div className="ask-outcome error-inline small">{failed}</div>}
    </div>
  );
}

/**
 * What the buttons that reach past this one call actually do.
 *
 * Only options the agent described are listed, so most cards show nothing.
 * The one that does is "Always Allow", whose scope is much narrower than its
 * label — see `describeEffects`. This sits above the deadline line rather
 * than inside a tooltip because it is the thing someone needs *before* they
 * click, and a tooltip is not there on a phone.
 */
function PermissionScopes({ request }: { request: PermissionBlock }) {
  const scoped = request.options
    .map((o) => ({ option: o, text: describeEffects(o) }))
    .filter((s): s is { option: (typeof request.options)[number]; text: string } => s.text !== null);
  if (scoped.length === 0) return null;
  return (
    <ul className="ask-effects muted small">
      {scoped.map(({ option, text }) => (
        <li key={option.optionId}>
          <b>{option.name}</b> {text}
        </li>
      ))}
    </ul>
  );
}

/** Colour a resolved card by what was chosen, not by the fact it was answered. */
function answeredTone(request: PermissionBlock, resolution: PermissionResolution): "allow" | "reject" | "neutral" {
  const picked = request.options.find((o) => o.optionId === resolution.optionId);
  return picked ? optionTone(picked.kind) : "neutral";
}
