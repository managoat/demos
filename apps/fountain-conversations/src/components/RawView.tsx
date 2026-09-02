import type { LogEvent } from "../api/types";

/**
 * The bytes as stored — the web UI's `raw` mode. No grouping, no blocks,
 * no prompt overlay; the `reattach` pairs the pretty views hide are here.
 */
export function RawView({ events }: { events: LogEvent[] }) {
  if (events.length === 0) return <div className="muted raw-empty">Waiting for output…</div>;
  return (
    <div className="raw">
      {events.map((ev) => (
        <RawLine key={ev.id} ev={ev} />
      ))}
    </div>
  );
}

function RawLine({ ev }: { ev: LogEvent }) {
  if (ev.kind === "stage") {
    return (
      <div className="raw-line">
        <span className="raw-id">#{ev.id}</span>
        <span className="raw-tag amber">stage</span>
        <span className="raw-text">
          {ev.stage} {ev.state} {ev.data}
        </span>
      </div>
    );
  }
  const stderr = ev.stream === "stderr";
  // Output under a framework stage shows the stage's name; turn output its stream.
  const tag = ev.stage && ev.stage !== "turn" ? ev.stage : stderr ? "stderr" : ev.stream ?? "stdout";
  const tagClass = stderr ? "rose" : ev.stage && ev.stage !== "turn" ? "amber" : "emerald";
  return (
    <div className="raw-line">
      <span className="raw-id">#{ev.id}</span>
      <span className={`raw-tag ${tagClass}`}>{tag}</span>
      <pre className={`raw-text ${stderr ? "rose" : ""}`}>{ev.data}</pre>
    </div>
  );
}
