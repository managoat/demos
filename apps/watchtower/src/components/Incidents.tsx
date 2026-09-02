/** The incident feed: what the agent found when asked to go dig, newest first. */
import type { IncidentCard } from "../lib/protocol";
import { timeAgo } from "../lib/schedule";

export function IncidentView(props: { card: IncidentCard }) {
  const inc = props.card.incident;
  return (
    <div className="incident">
      <div className="incident-head">
        <span className="incident-url">{inc.url}</span>
        {inc.checked_at && <span className="fineprint">{timeAgo(inc.checked_at)}</span>}
      </div>
      <p className="incident-summary">{inc.summary}</p>
      {inc.suspected_cause && (
        <p className="incident-cause">
          suspected: <b>{inc.suspected_cause}</b>
        </p>
      )}
      {inc.evidence.length > 0 && (
        <ul className="incident-evidence">
          {inc.evidence.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Incidents(props: { cards: IncidentCard[] }) {
  if (props.cards.length === 0)
    return <p className="fineprint">No incidents yet. When a tile goes red, hit Investigate and the agent digs with curl, dig, traceroute and whois.</p>;
  return (
    <>
      {props.cards.map((c, i) => (
        <IncidentView key={`${c.turnIndex}-${i}`} card={c} />
      ))}
    </>
  );
}
