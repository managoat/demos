/**
 * One report section: insight cards, the column-profile strip, the charts,
 * and — trust through transparency — a collapsed "how I got this" showing
 * the tool calls the analyst ran to produce it.
 */
import type { Block } from "../lib/acp";
import type { ColumnStat, TableReport } from "../lib/protocol";
import { fmtNum } from "../lib/format";
import { ChartView } from "./Charts";

export type ToolBlock = Extract<Block, { kind: "tool" }>;

export function ReportView({ report, tools }: { report: TableReport; tools: ToolBlock[] }) {
  return (
    <section className="report">
      <div className="report-head">
        <h3>{report.title ?? "What the data says"}</h3>
        {typeof report.rows === "number" && <span className="fineprint">{fmtNum(report.rows)} rows</span>}
      </div>
      {report.insights.length > 0 && (
        <div className="insights">
          {report.insights.map((s, i) => (
            <div key={i} className="insight">
              {s}
            </div>
          ))}
        </div>
      )}
      {report.columns.length > 0 && (
        <div className="colstrip">
          {report.columns.map((c, i) => (
            <ColumnCard key={i} col={c} />
          ))}
        </div>
      )}
      {report.charts.length > 0 && (
        <div className="charts">
          {report.charts.map((c, i) => (
            <ChartView key={i} chart={c} />
          ))}
        </div>
      )}
      {tools.length > 0 && (
        <details className="working">
          <summary>How I got this</summary>
          {tools.map((t, i) => (
            <div key={t.id ?? i} className={`tool tool-${t.status}`}>
              <div className="tool-head">
                <b>{t.name}</b>
                {t.summary && <code>{t.summary}</code>}
                {t.status === "error" && <span className="tool-err">failed</span>}
              </div>
              {t.output && <pre>{clip(t.output)}</pre>}
            </div>
          ))}
        </details>
      )}
    </section>
  );
}

function clip(s: string, max = 1500): string {
  return s.length > max ? s.slice(0, max) + "\n…" : s;
}

function ColumnCard({ col }: { col: ColumnStat }) {
  return (
    <div className="colcard">
      <div className="colname">{col.name}</div>
      <div className="coltype">{col.type}</div>
      <div className="colfacts">
        {col.type === "number" ? (
          <>
            {col.min !== undefined && col.max !== undefined && (
              <span>
                {fmtNum(col.min)} – {fmtNum(col.max)}
              </span>
            )}
            {col.mean !== undefined && <span>avg {fmtNum(col.mean)}</span>}
          </>
        ) : (
          <>
            {col.distinct !== undefined && <span>{fmtNum(col.distinct)} kinds</span>}
            {col.top && <span>mostly “{col.top}”</span>}
          </>
        )}
        {col.nulls !== undefined && col.nulls > 0 && <span className="colnulls">{fmtNum(col.nulls)} blank</span>}
      </div>
    </div>
  );
}
