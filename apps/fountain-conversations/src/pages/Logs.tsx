import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { paths } from "../router";
import { THREAD_STREAMS, describeError } from "../api/client";
import type { LogEvent } from "../api/types";
import { formatClock } from "../lib/format";
import { loadPrefs, savePrefs } from "../lib/prefs";

/** The raw event log: every row as stored, tailing live. What `/conversations/:id/logs` shows. */
export function LogsPage({ id }: { id: string }) {
  const { client, subscribe, toast } = useStore();
  const [events, setEvents] = useState<LogEvent[]>([]);
  // Remembered per browser, like the transcript's own toggles.
  const [visible, setVisible] = useState<Set<string>>(() => new Set(loadPrefs().logStreams));
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .listAllEvents(id)
      .then((e) => !cancelled && setEvents(e))
      .catch((err) => !cancelled && toast(describeError(err), "error"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [client, id, toast]);

  useEffect(() => subscribe(id, (ev) => setEvents((es) => (es.some((e) => e.id === ev.id) ? es : [...es, ev]))), [subscribe, id]);

  const stick = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events.length]);
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return events.filter((e) => {
      const stream = e.stream || (e.kind === "stage" ? "stage" : "");
      if (stream && !visible.has(stream)) return false;
      if (!q) return true;
      return `${e.kind} ${e.stream ?? ""} ${e.stage ?? ""} ${e.state ?? ""} ${e.data ?? ""}`.toLowerCase().includes(q);
    });
  }, [events, visible, filter]);

  const toggle = (s: string) =>
    setVisible((v) => {
      const n = new Set(v);
      if (n.has(s)) n.delete(s);
      else n.add(s);
      savePrefs({ logStreams: [...n] });
      return n;
    });

  return (
    <div className="logs">
      <header className="show-header">
        <a href={paths.show(id)} className="back" aria-label="Back to the conversation">
          ‹
        </a>
        <div className="show-title">
          <div className="name">Log events</div>
          <div className="sub muted mono">{id}</div>
        </div>
        <div className="row">
          {THREAD_STREAMS.map((s) => (
            <label key={s} className="check small">
              <input type="checkbox" checked={visible.has(s)} onChange={() => toggle(s)} />
              {s}
            </label>
          ))}
          <input className="compact" type="search" placeholder="filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <span className="muted small">{rows.length}/{events.length}</span>
        </div>
      </header>
      <div className="log-body" ref={scrollRef} onScroll={onScroll}>
        {loading && <div className="muted">Loading…</div>}
        <table className="log-table">
          <tbody>
            {rows.map((e) => (
              <tr key={e.id} className={`log-row ${e.kind} ${e.stream ?? ""}`}>
                <td className="mono muted">{e.id}</td>
                <td className="mono muted">{formatClock(e.ts)}</td>
                <td className="mono">{e.kind === "stage" ? `${e.stage}/${e.state}` : e.stream}</td>
                <td className="mono data">
                  {e.data}
                  {e.duration_ms != null && <span className="muted"> ({e.duration_ms} ms)</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
