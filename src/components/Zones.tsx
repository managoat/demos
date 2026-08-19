/** The zones as last reported by the desk — the app's "Cloud Stack" view. */
import type { DnsState } from "../lib/protocol";

export function Zones(props: { state: DnsState | null; onRefresh: () => void; refreshing: boolean }) {
  return (
    <div className="zones">
      <div className="zones-bar">
        <span className="fineprint">
          {props.state?.fetched_at ? `As the desk last read it, ${new Date(props.state.fetched_at).toLocaleString()}.` : "The desk has not reported zone state yet."}
        </span>
        <button onClick={props.onRefresh} disabled={props.refreshing}>
          {props.refreshing ? "Asking…" : "Refresh from Cloudflare"}
        </button>
      </div>
      {(props.state?.zones ?? []).map((z) => (
        <section key={z.name} className="zone">
          <h3>{z.name}</h3>
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
              </tbody>
            </table>
          </div>
        </section>
      ))}
      {props.state && props.state.zones.length === 0 && <p className="fineprint">The token sees no zones.</p>}
    </div>
  );
}
