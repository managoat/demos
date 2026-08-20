/** The synthesized mission report, print-friendly, with a per-task appendix. */
import type { Mission, MissionTask, TaskResult } from "../lib/protocol";
import { renderMarkdown } from "../lib/md";

export interface AppendixEntry {
  task: MissionTask;
  result: TaskResult | null;
}

/** The whole thing as one markdown document — what Download .md saves. */
export function reportMarkdown(mission: Mission, appendix: AppendixEntry[]): string {
  const report = mission.report;
  const lines: string[] = [];
  lines.push(`# ${report?.objective ?? mission.plan.objective}`);
  lines.push("", `Mission \`${mission.plan.id}\` — synthesized by Mission Control on Fountain.`, "");
  if (report?.outcome) lines.push(report.outcome, "");
  for (const s of report?.sections ?? []) lines.push(`## ${s.heading}`, "", s.body_md, "");
  lines.push("---", "", "## Appendix: task outputs", "");
  for (const { task, result } of appendix) {
    lines.push(`### ${task.id} — ${task.title}`, "");
    if (!result) {
      lines.push("_No result was reported._", "");
      continue;
    }
    lines.push(`Status: ${result.status}${result.summary ? ` — ${result.summary}` : ""}`, "");
    if (result.output) lines.push(result.output, "");
  }
  return lines.join("\n");
}

export function Report(props: { mission: Mission; appendix: AppendixEntry[]; onDownload: () => void }) {
  const { mission, appendix } = props;
  const report = mission.report;
  if (!report) return null;
  return (
    <div className="report">
      <div className="report-bar">
        <span className="mission-id">{mission.plan.id}</span>
        <button onClick={props.onDownload}>Download .md</button>
      </div>
      <article className="report-doc">
        <h1>{report.objective ?? mission.plan.objective}</h1>
        {report.outcome && <p className="report-outcome">{report.outcome}</p>}
        {report.sections.map((s, i) => (
          <section key={i}>
            <h2>{s.heading}</h2>
            <div dangerouslySetInnerHTML={{ __html: renderMarkdown(s.body_md) }} />
          </section>
        ))}
        <hr />
        <h2 className="appendix-head">Appendix: task outputs</h2>
        {appendix.map(({ task, result }) => (
          <details key={task.id} className="appendix-task">
            <summary>
              <span className="task-id">{task.id}</span> {task.title}
              <span className={`chip chip-${result ? result.status : "noresult"}`}>{result ? result.status : "no result"}</span>
            </summary>
            {result?.summary && <p className="fineprint">{result.summary}</p>}
            {result?.output ? (
              <div dangerouslySetInnerHTML={{ __html: renderMarkdown(result.output) }} />
            ) : (
              <p className="fineprint">No output was reported.</p>
            )}
          </details>
        ))}
      </article>
    </div>
  );
}
