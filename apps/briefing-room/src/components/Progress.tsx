/**
 * The calm progress pane: "Reading…" with the pages the researcher has
 * fetched surfacing as it works — derived from the ACP tool chips, raw
 * commands hidden. Seeing the sources appear is the trust beat.
 */
import { displayUrl } from "../lib/protocol";

export function Progress(props: { topic: string | null; urls: string[] }) {
  const recent = props.urls.slice(-8);
  return (
    <div className="progress">
      <div className="headline">
        <span className="pulse" />
        <span>{props.urls.length === 0 ? "Researching…" : `Reading — ${props.urls.length} page${props.urls.length === 1 ? "" : "s"} so far`}</span>
      </div>
      {props.topic && <p className="fineprint" style={{ margin: "6px 0 0" }}>{props.topic}</p>}
      {recent.length > 0 && (
        <ul>
          {recent.map((u) => (
            <li key={u} title={u}>
              {displayUrl(u)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
