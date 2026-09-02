/**
 * One tile per watched site: current status, latency, cert countdown, and the
 * site's whole history — a latency sparkline and an up/down strip — built
 * from every watch-state block the agent ever reported. The conversation is
 * the metrics database; there is no other store.
 */
import { statusOf, type SiteSample, type TileStatus } from "../lib/protocol";
import { timeAgo } from "../lib/schedule";

const STATUS_LABEL: Record<TileStatus, string> = {
  ok: "up",
  warn: "cert expiring",
  down: "down",
  pending: "no data yet",
};

/** How much history the tile graphics show. */
const WINDOW = 48;

export function Sparkline(props: { samples: SiteSample[] }) {
  const points = props.samples.slice(-WINDOW).map((s) => (s.up ? s.latency_ms : null));
  const known = points.filter((p): p is number => p !== null);
  if (known.length < 2) return <div className="spark spark-empty">not enough history</div>;
  const max = Math.max(...known, 1);
  const w = 120;
  const h = 28;
  const step = points.length > 1 ? w / (points.length - 1) : w;
  const poly = points
    .map((p, i) => (p === null ? null : `${(i * step).toFixed(1)},${(h - 2 - (p / max) * (h - 6)).toFixed(1)}`))
    .filter((p): p is string => p !== null)
    .join(" ");
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="latency history">
      <polyline points={poly} fill="none" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function UpStrip(props: { samples: SiteSample[] }) {
  const window = props.samples.slice(-WINDOW);
  if (window.length === 0) return null;
  return (
    <div className="strip" role="img" aria-label="up/down history">
      {window.map((s, i) => (
        <span key={i} className={s.up ? "cell up" : "cell dn"} title={`${s.up ? "up" : "down"} · ${timeAgo(s.checked_at)}`} />
      ))}
    </div>
  );
}

export function Tile(props: {
  url: string;
  samples: SiteSample[];
  busy: boolean;
  onInvestigate: (url: string) => void;
  onRemove: (url: string) => void;
}) {
  const latest = props.samples[props.samples.length - 1] ?? null;
  const status = statusOf(latest);
  return (
    <div className={`tile tile-${status}`}>
      <div className="tile-head">
        <span className={`lamp lamp-${status}`} />
        <span className="tile-url" title={props.url}>
          {props.url}
        </span>
        <span className={`tile-status s-${status}`}>{STATUS_LABEL[status]}</span>
      </div>
      {latest ? (
        <>
          <div className="tile-stats">
            <span className="stat">
              <b>{latest.status ?? "—"}</b> status
            </span>
            <span className="stat">
              <b>{latest.latency_ms !== null ? `${latest.latency_ms}ms` : "—"}</b> latency
            </span>
            <span className={latest.cert_days_left !== null && latest.cert_days_left < 14 ? "stat stat-warn" : "stat"}>
              <b>{latest.cert_days_left !== null ? `${latest.cert_days_left}d` : "—"}</b> cert
            </span>
          </div>
          <Sparkline samples={props.samples} />
          <UpStrip samples={props.samples} />
          {latest.note && <p className="tile-note">{latest.note}</p>}
          <p className="fineprint">checked {timeAgo(latest.checked_at)}</p>
        </>
      ) : (
        <p className="fineprint">Waiting for the first patrol to report.</p>
      )}
      <div className="tile-actions">
        <button onClick={() => props.onInvestigate(props.url)} disabled={props.busy}>
          Investigate
        </button>
        <button className="linkish" onClick={() => props.onRemove(props.url)} disabled={props.busy}>
          stop watching
        </button>
      </div>
    </div>
  );
}
