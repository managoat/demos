/**
 * The Table Talk protocol: how the app reads the analyst.
 *
 * The analyst embeds machine-readable fenced blocks in its replies —
 * ```table-report — and the app parses them out of the assistant text and
 * renders them as insight cards, a column profile, and charts. The agent's
 * side of the contract is `spec.ts` — change one side, change both.
 *
 * The dataset itself travels the other way, as a ```csv fence inside the
 * user's message; `buildDataPrompt`/`parseDataPrompt` are the two halves of
 * that hand-off.
 */

export interface ColumnStat {
  name: string;
  type: string;
  distinct?: number;
  top?: string;
  min?: number;
  max?: number;
  mean?: number;
  nulls?: number;
}

export interface ChartSeries {
  name: string;
  y: number[];
}

export type ChartType = "bar" | "line" | "pie";

export interface Chart {
  type: ChartType;
  title?: string;
  x: string[];
  series: ChartSeries[];
}

export interface TableReport {
  id: string;
  title?: string;
  insights: string[];
  rows?: number;
  columns: ColumnStat[];
  charts: Chart[];
}

const FENCE = /```table-report[^\S\n]*\n([\s\S]*?)```/g;

/** Every well-formed table-report block in one reply, in order. Malformed JSON is skipped. */
export function parseReports(text: string): TableReport[] {
  const out: TableReport[] = [];
  let n = 0;
  for (const m of text.matchAll(FENCE)) {
    n++;
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1]!);
    } catch {
      continue;
    }
    if (!isObj(parsed)) continue;
    const report = asReport(parsed, `rpt-unnamed-${n}`);
    if (report) out.push(report);
  }
  return out;
}

/** Whether the reply even attempted a report — a fence that failed to parse still counts. */
export function hasReportFence(text: string): boolean {
  return /```table-report/.test(text);
}

/** The reply with protocol blocks removed — what the chat bubble shows as prose. */
export function stripBlocks(text: string): string {
  return text.replace(FENCE, "").replace(/\n{3,}/g, "\n\n").trim();
}

// ── the dataset hand-off ─────────────────────────────────────────────────────

const DATA_HEADER = /^New dataset: (.+)$/m;

/** The one message that carries a dataset to the analyst. */
export function buildDataPrompt(filename: string, csvText: string, notice: string | null): string {
  const note = notice ? `\n(${notice})\n` : "";
  return `New dataset: ${filename}\n${note}\nSave the CSV below to disk as ${filename}, then analyze it per your instructions and reply with a table-report block.\n\n\`\`\`csv\n${csvText}\n\`\`\``;
}

/** Detect a dataset hand-off in a user prompt, so the UI shows a chip, not 400 KB of CSV. */
export function parseDataPrompt(prompt: string): { filename: string } | null {
  if (!/```csv\n/.test(prompt)) return null;
  const m = prompt.match(DATA_HEADER);
  return m ? { filename: m[1]!.trim() } : null;
}

// ── shape guards: tolerate a sloppy agent, never a crashing UI ─────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asReport(v: Record<string, unknown>, fallbackId: string): TableReport | null {
  const insights = Array.isArray(v.insights) ? v.insights.filter((s): s is string => typeof s === "string" && s.trim() !== "") : [];
  const charts = Array.isArray(v.charts) ? v.charts.map(asChart).filter((c): c is Chart => c !== null) : [];
  const stats = isObj(v.stats) ? v.stats : {};
  const columns = Array.isArray(stats.columns) ? stats.columns.map(asColumn).filter((c): c is ColumnStat => c !== null) : [];
  if (insights.length === 0 && charts.length === 0 && columns.length === 0) return null;
  const report: TableReport = { id: str(v.id) ?? fallbackId, insights, columns, charts };
  const title = str(v.title);
  if (title) report.title = title;
  const rows = num(stats.rows);
  if (rows !== null) report.rows = rows;
  return report;
}

function asColumn(v: unknown): ColumnStat | null {
  if (!isObj(v)) return null;
  const name = str(v.name);
  if (!name) return null;
  const col: ColumnStat = { name, type: str(v.type) ?? "text" };
  const distinct = num(v.distinct);
  if (distinct !== null) col.distinct = distinct;
  const top = str(v.top);
  if (top) col.top = top;
  for (const k of ["min", "max", "mean", "nulls"] as const) {
    const n = num(v[k]);
    if (n !== null) col[k] = n;
  }
  return col;
}

function asChart(v: unknown): Chart | null {
  if (!isObj(v)) return null;
  const type = str(v.type);
  if (type !== "bar" && type !== "line" && type !== "pie") return null;
  if (!Array.isArray(v.x)) return null;
  const x = v.x.map((l) => (typeof l === "string" ? l : typeof l === "number" ? String(l) : "")).filter((l) => l !== "");
  if (x.length === 0) return null;
  const rawSeries = Array.isArray(v.series) ? v.series : [];
  const series: ChartSeries[] = [];
  for (const s of rawSeries) {
    if (!isObj(s) || !Array.isArray(s.y)) continue;
    const y = s.y.filter((n): n is number => typeof n === "number" && Number.isFinite(n)).slice(0, x.length);
    if (y.length === 0) continue;
    series.push({ name: str(s.name) ?? "value", y });
  }
  if (series.length === 0) return null;
  const chart: Chart = { type, x, series: type === "pie" ? series.slice(0, 1) : series };
  const title = str(v.title);
  if (title) chart.title = title;
  return chart;
}
