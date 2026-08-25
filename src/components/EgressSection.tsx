/**
 * The "egress" section of the details panel: what this conversation's
 * computer reached on the internet, and what the broker did about it.
 *
 * It answers a question the transcript cannot: an agent said it pushed to
 * GitHub, but did a credential actually go with the request — and to where
 * else did it send one? On a brokered account (ADR 0019) the broker sees
 * every request the sandbox makes, and Fountain keeps that log for a while
 * after the conversation ends. On an unbrokered account there is nothing to
 * see, and the section says that instead of showing an empty list that looks
 * like "nothing happened".
 *
 * Two parts. Up top, the *intent*: the `broker` stage on the feed names the
 * secrets withheld from the sandbox. Below, the *effect*: the log, newest
 * first, summarised per host and then row by row, paged as you ask for more.
 * The log is read when the section opens and again when the conversation
 * moves, not streamed — the broker's log is not on the SSE feed, and one
 * request per turn is the right price for something read on demand.
 *
 * `EgressList` is the pure half, rendered from a page; `EgressSection` owns
 * the fetching. Names of secrets appear here, never values: the broker's log
 * carries `credential_keys`, not what was in them.
 */
import { useCallback, useEffect, useState } from "react";
import { useProject } from "../store";
import type { LogEvent } from "../types";
import { describeError, errorCode } from "../lib/errors";
import { formatClock } from "../lib/format";
import { brokerFailure, brokerStage, fetchEgress, outcomeOf, refusalOf, summarize, type BrokerStage, type EgressEvent } from "../lib/egress";

export function EgressSection({ conversationId, lastActiveAt, feed }: { conversationId: string; lastActiveAt: string | null | undefined; feed: LogEvent[] }) {
  const { fountain } = useProject();
  const [rows, setRows] = useState<EgressEvent[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [brokered, setBrokered] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (before: number | null) => {
      setBusy(true);
      try {
        const page = await fetchEgress(fountain, conversationId, before);
        setBrokered(page.brokered);
        setNext(page.next ?? null);
        setRows((have) => (before === null ? page.data : [...have, ...page.data.filter((e) => !have.some((h) => h.id === e.id))]));
        setError(null);
      } catch (err) {
        // The proxy has already checked the conversation is the project's,
        // so a 404 here is a Fountain without the endpoint, not a missing
        // conversation. Say that; the panel shows it on every thread otherwise.
        setError(errorCode(err) === "not_found" ? "This Fountain has no egress log to read — it predates the feature." : describeError(err));
      } finally {
        setBusy(false);
      }
    },
    [fountain, conversationId],
  );

  // First page on open, and again whenever the conversation moves: a turn
  // that just ran is exactly the one whose requests you came to see.
  useEffect(() => {
    setRows([]);
    setNext(null);
    setBrokered(null);
    void load(null);
  }, [load, lastActiveAt]);

  return <EgressList rows={rows} next={next} brokered={brokered} error={error} busy={busy} stage={brokerStage(feed)} onMore={() => void load(next)} onRetry={() => void load(null)} />;
}

export function EgressList({
  rows,
  next,
  brokered,
  error,
  busy,
  stage,
  onMore,
  onRetry,
}: {
  rows: EgressEvent[];
  next: number | null;
  brokered: boolean | null;
  error: string | null;
  busy: boolean;
  stage: BrokerStage | null;
  onMore: () => void;
  onRetry: () => void;
}) {
  const hosts = summarize(rows);
  return (
    <section className="details-section">
      <h3>
        egress
        {brokered && <span className="details-count">{rows.length}{next !== null ? "+" : ""}</span>}
      </h3>

      {stage && (
        <div className="egress-stage">
          {stage.failed ? (
            <p className="details-note error">Broker setup failed: {brokerFailure(stage.failed)}.</p>
          ) : stage.keys.length > 0 ? (
            <div className="details-keys">
              withheld from the sandbox <span>{stage.keys.join(" · ")}</span>
            </div>
          ) : (
            <p className="muted small">Brokered, with no secrets to withhold.</p>
          )}
        </div>
      )}

      {error ? (
        <p className="details-note error">
          {error}{" "}
          <button type="button" className="secondary small" onClick={onRetry}>
            Try again
          </button>
        </p>
      ) : brokered === null ? (
        <p className="muted small">{busy ? "Reading the broker's log…" : ""}</p>
      ) : !brokered ? (
        <p className="muted small">Not brokered: this account's sandboxes hold their credentials and reach the internet directly, so there is no record of where they went.</p>
      ) : rows.length === 0 ? (
        <p className="muted small">The broker saw no requests from this conversation{next === null ? "" : " on this page"}. The log is kept for a while after a conversation ends, then goes.</p>
      ) : (
        <>
          <ul className="details-list egress-hosts">
            {hosts.map((h) => (
              <li key={h.host}>
                <span className={`egress-dot ${h.outcome}`} title={h.outcome} />
                <code className="grow min0 ellipsis">{h.host}</code>
                <span className="muted">{h.requests}</span>
                {h.keys.length > 0 && <span className="egress-keys">{h.keys.join(" · ")}</span>}
              </li>
            ))}
          </ul>
          <ul className="details-list egress-rows">
            {rows.map((ev) => {
              const outcome = outcomeOf(ev);
              return (
                <li key={ev.id} className={`egress-row ${outcome}`}>
                  <span className="muted egress-at">{formatClock(ev.at)}</span>
                  <span className="egress-req">
                    <code>{ev.method}</code> <span className="ellipsis">{ev.host}{ev.path}</span>
                  </span>
                  <span className="egress-what">
                    {outcome === "refused" ? (
                      <span className="egress-refused" title={ev.error ?? undefined}>
                        {ev.status ?? "—"} · {refusalOf(ev.error ?? "")}
                      </span>
                    ) : (
                      <>
                        <span>{ev.status ?? "—"}</span>
                        {ev.latency_ms != null && <span className="muted"> · {ev.latency_ms} ms</span>}
                        {outcome === "brokered" ? <span className="egress-keys"> · {ev.credential_keys.length ? ev.credential_keys.join(", ") : ev.service}</span> : <span className="muted"> · no credential</span>}
                      </>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
          {next !== null && (
            <button type="button" className="secondary small" disabled={busy} onClick={onMore}>
              {busy ? "Reading…" : "Earlier requests"}
            </button>
          )}
          <p className="details-note">Every request the sandbox made, as the broker saw it. A credential named here went on the wire at the broker; the sandbox never held it.</p>
        </>
      )}
    </section>
  );
}
