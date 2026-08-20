/** The zones as last reported by the desk — the app's "Cloud Stack" view. */
import { useMemo, useState } from "react";
import type { DnsState, DnsZone } from "../lib/protocol";

function ZoneSection(props: { zone: DnsZone; open: boolean }) {
  const z = props.zone;
  return (
    <details className="zone" open={props.open}>
      <summary>
        <span className="zone-name">{z.name}</span>
        <span className="zone-count">
          {z.records.length} record{z.records.length === 1 ? "" : "s"}
        </span>
      </summary>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Name</th>
              <th>Content</th>
              <th>TTL</th>
              <th>Proxy</th>
            </tr>
          </thead>
          <tbody>
            {z.records.map((r, i) => (
              <tr key={i}>
                <td>{r.type}</td>
                <td className="name">{r.name}</td>
                <td className="content">{r.content}</td>
                <td className="ttl">{r.ttl === 1 ? "auto" : r.ttl ?? ""}</td>
                <td>{r.proxied === undefined ? "" : r.proxied ? "proxied" : "DNS only"}</td>
              </tr>
            ))}
            {z.records.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">
                  no records
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export function Zones(props: { state: DnsState | null; onRefresh: () => void; refreshing: boolean }) {
  const [filter, setFilter] = useState("");
  const zones = props.state?.zones ?? [];
  const q = filter.trim().toLowerCase();
  const shown = useMemo(
    () =>
      q
        ? zones.filter(
            (z) =>
              z.name.toLowerCase().includes(q) ||
              z.records.some((r) => r.name.toLowerCase().includes(q) || r.content.toLowerCase().includes(q)),
          )
        : zones,
    [zones, q],
  );
  // A handful of zones read best open; a fleet reads best as a list.
  const openAll = q !== "" || shown.length <= 3;

  return (
    <div className="zones">
      <div className="zones-bar">
        <span className="fineprint">
          {props.state?.fetched_at
            ? `${zones.length} zone${zones.length === 1 ? "" : "s"} as the desk last read them, ${new Date(props.state.fetched_at).toLocaleString()}.`
            : "The desk has not reported zone state yet."}
        </span>
        <div className="zones-controls">
          {zones.length > 3 && (
            <input
              className="zone-filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter zones & records…"
              aria-label="Filter zones and records"
            />
          )}
          <button onClick={props.onRefresh} disabled={props.refreshing}>
            {props.refreshing ? "Asking…" : "Refresh all zones"}
          </button>
        </div>
      </div>
      {shown.map((z) => (
        <ZoneSection key={z.name} zone={z} open={openAll} />
      ))}
      {props.state && zones.length === 0 && <p className="fineprint">The token sees no zones.</p>}
      {q && shown.length === 0 && zones.length > 0 && <p className="fineprint">Nothing matches “{filter}”.</p>}
    </div>
  );
}
