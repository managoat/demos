/**
 * Hand-rolled SVG charts — bar, line (multi-series), pie. No chart library:
 * a viewBox, a linear scale, and the app's palette. Each chart is a card with
 * its title and an HTML legend when there is more than one series.
 */
import type { Chart } from "../lib/protocol";
import { fmtNum, truncateLabel } from "../lib/format";

export const PALETTE = ["#eda03f", "#dd7a55", "#93b478", "#6ea6c8", "#b18bad", "#d3b458"];

const W = 520;
const H = 250;
const PAD = { l: 54, r: 14, t: 14, b: 34 };
const IW = W - PAD.l - PAD.r;
const IH = H - PAD.t - PAD.b;

export function ChartView({ chart }: { chart: Chart }) {
  return (
    <figure className="chart">
      {chart.title && <figcaption>{chart.title}</figcaption>}
      {chart.type === "pie" ? <Pie chart={chart} /> : chart.type === "line" ? <Line chart={chart} /> : <Bars chart={chart} />}
      {chart.type !== "pie" && chart.series.length > 1 && (
        <div className="legend">
          {chart.series.map((s, i) => (
            <span key={i} className="legend-item">
              <i style={{ background: PALETTE[i % PALETTE.length] }} /> {s.name}
            </span>
          ))}
        </div>
      )}
    </figure>
  );
}

// ── shared scale bits ────────────────────────────────────────────────────────

function extent(chart: Chart): { lo: number; hi: number } {
  let lo = 0;
  let hi = 0;
  for (const s of chart.series) {
    for (const v of s.y) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (lo === hi) hi = lo + 1;
  return { lo, hi };
}

/** Round tick values covering [lo, hi]: a 1/2/5 step, ~4 lines. */
function niceTicks(lo: number, hi: number): number[] {
  const span = hi - lo;
  const raw = span / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => span / s <= 5) ?? raw;
  const start = Math.ceil(lo / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= hi + step / 1e6; v += step) ticks.push(Math.abs(v) < step / 1e6 ? 0 : v);
  return ticks;
}

function yScale(lo: number, hi: number): (v: number) => number {
  return (v) => PAD.t + (IH * (hi - v)) / (hi - lo);
}

/** Show at most ~8 x labels; the rest thin out evenly. */
function labelStep(n: number): number {
  return Math.max(1, Math.ceil(n / 8));
}

function Axes({ lo, hi }: { lo: number; hi: number }) {
  const y = yScale(lo, hi);
  return (
    <g className="axes">
      {niceTicks(lo, hi).map((t) => (
        <g key={t}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} className={t === 0 ? "grid zero" : "grid"} />
          <text x={PAD.l - 6} y={y(t)} className="tick" textAnchor="end" dominantBaseline="middle">
            {fmtNum(t)}
          </text>
        </g>
      ))}
    </g>
  );
}

function XLabels({ labels, xc }: { labels: string[]; xc: (i: number) => number }) {
  const step = labelStep(labels.length);
  return (
    <g>
      {labels.map((l, i) =>
        i % step === 0 ? (
          <text key={i} x={xc(i)} y={H - PAD.b + 16} className="tick" textAnchor="middle">
            {truncateLabel(l)}
          </text>
        ) : null,
      )}
    </g>
  );
}

// ── bar ──────────────────────────────────────────────────────────────────────

function Bars({ chart }: { chart: Chart }) {
  const { lo, hi } = extent(chart);
  const y = yScale(lo, hi);
  const n = chart.x.length;
  const band = IW / n;
  const group = band * 0.72;
  const bw = group / chart.series.length;
  const xc = (i: number) => PAD.l + band * i + band / 2;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img">
      <Axes lo={lo} hi={hi} />
      {chart.series.map((s, si) =>
        s.y.map((v, i) => {
          const x = xc(i) - group / 2 + si * bw;
          const top = Math.min(y(v), y(0));
          const h = Math.abs(y(v) - y(0));
          return <rect key={`${si}-${i}`} x={x} y={top} width={Math.max(bw - 2, 1)} height={Math.max(h, 0.5)} fill={PALETTE[si % PALETTE.length]} rx={1.5}>
            <title>{`${chart.x[i] ?? ""} · ${s.name}: ${fmtNum(v)}`}</title>
          </rect>;
        }),
      )}
      <XLabels labels={chart.x} xc={xc} />
    </svg>
  );
}

// ── line ─────────────────────────────────────────────────────────────────────

function Line({ chart }: { chart: Chart }) {
  const { lo, hi } = extent(chart);
  const y = yScale(lo, hi);
  const n = chart.x.length;
  const xc = (i: number) => (n === 1 ? PAD.l + IW / 2 : PAD.l + (IW * i) / (n - 1));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img">
      <Axes lo={lo} hi={hi} />
      {chart.series.map((s, si) => (
        <g key={si}>
          <polyline
            points={s.y.map((v, i) => `${xc(i)},${y(v)}`).join(" ")}
            fill="none"
            stroke={PALETTE[si % PALETTE.length]}
            strokeWidth={2}
            strokeLinejoin="round"
          />
          {n <= 24 &&
            s.y.map((v, i) => (
              <circle key={i} cx={xc(i)} cy={y(v)} r={2.6} fill={PALETTE[si % PALETTE.length]}>
                <title>{`${chart.x[i] ?? ""} · ${s.name}: ${fmtNum(v)}`}</title>
              </circle>
            ))}
        </g>
      ))}
      <XLabels labels={chart.x} xc={xc} />
    </svg>
  );
}

// ── pie ──────────────────────────────────────────────────────────────────────

function Pie({ chart }: { chart: Chart }) {
  const values = (chart.series[0]?.y ?? []).map((v, i) => ({ label: chart.x[i] ?? "", v })).filter((d) => d.v > 0);
  const total = values.reduce((a, d) => a + d.v, 0);
  const cx = 105;
  const cy = 105;
  const r = 88;
  if (total <= 0) return <p className="fineprint">Nothing above zero to chart.</p>;
  let angle = -Math.PI / 2;
  const slices = values.map((d, i) => {
    const sweep = (d.v / total) * Math.PI * 2;
    const path = arcPath(cx, cy, r, angle, angle + sweep);
    angle += sweep;
    return { ...d, path, color: PALETTE[i % PALETTE.length]!, pct: (d.v / total) * 100 };
  });
  return (
    <div className="pie">
      <svg viewBox="0 0 210 210" role="img">
        {slices.length === 1 ? (
          <circle cx={cx} cy={cy} r={r} fill={slices[0]!.color} />
        ) : (
          slices.map((s, i) => (
            <path key={i} d={s.path} fill={s.color} stroke="var(--bg-1)" strokeWidth={1.5}>
              <title>{`${s.label}: ${fmtNum(s.v)} (${s.pct.toFixed(1)}%)`}</title>
            </path>
          ))
        )}
      </svg>
      <div className="legend column">
        {slices.map((s, i) => (
          <span key={i} className="legend-item">
            <i style={{ background: s.color }} /> {truncateLabel(s.label, 18)} · {s.pct.toFixed(s.pct < 10 ? 1 : 0)}%
          </span>
        ))}
      </div>
    </div>
  );
}

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const x0 = cx + r * Math.cos(a0);
  const y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1);
  const y1 = cy + r * Math.sin(a1);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} Z`;
}
