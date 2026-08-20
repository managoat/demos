import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { foldMissions, pendingMission } from "../lib/protocol";
import { PlanView } from "./PlanView";
import { TaskCard, type TaskView } from "./Board";
import { Report, reportMarkdown } from "./Report";

// Render smoke: a plan reads as approvable task cards; a task card shows its
// boot sequence, tool chips and status; a report renders its markdown.

const PLAN = `\`\`\`mission-plan
{"id":"msn-x7","objective":"Pick a static site generator","tasks":[{"id":"t1","title":"Survey Hugo","brief":"Evaluate Hugo.","deliverable":"an assessment"},{"id":"t2","title":"Survey Astro","brief":"Evaluate Astro."}]}
\`\`\``;

const REPORT = `\`\`\`mission-report
{"id":"msn-x7","objective":"Pick a static site generator","outcome":"Astro wins.","sections":[{"heading":"Recommendation","body_md":"Use **Astro** because:\\n\\n- fast\\n- simple"}]}
\`\`\``;

describe("PlanView", () => {
  test("awaiting: task cards, deliverables, and the approve button", () => {
    const missions = foldMissions([{ prompt: "pick a ssg", reply: PLAN }]);
    const html = renderToString(
      <PlanView mission={pendingMission(missions)!} busy={false} onApprove={() => undefined} onRevise={() => undefined} />,
    );
    expect(html).toContain("msn-x7");
    expect(html).toContain("Survey Hugo");
    expect(html).toContain("an assessment");
    expect(html).toMatch(/Approve &amp; launch (<!-- -->)?2(<!-- -->)? agents/);
    expect(html).toContain("Revise");
  });
});

describe("TaskCard", () => {
  const base: TaskView = {
    task: { id: "t1", title: "Survey Hugo", brief: "Evaluate Hugo." },
    convId: "c1",
    status: "provisioning",
    boot: [
      { stage: "provision", state: "done" },
      { stage: "session", state: "started" },
    ],
    blocks: [],
    result: null,
    usage: null,
    startedAt: "2026-08-19T00:00:00Z",
    failureStage: null,
  };

  test("provisioning: the boot sequence renders", () => {
    const html = renderToString(<TaskCard view={base} now={Date.parse("2026-08-19T00:01:05Z")} onInterrupt={() => undefined} />);
    expect(html).toContain("booting");
    expect(html).toContain("provision");
    expect(html).toContain("session");
    expect(html).toContain("01:05");
    expect(html).toContain("interrupt");
  });

  test("working: tool chips and the text tail show, protocol fences stripped", () => {
    const view: TaskView = {
      ...base,
      status: "working",
      blocks: [
        { kind: "tool", id: "x", name: "WebSearch", summary: "hugo benchmarks", status: "done", output: "…" },
        { kind: "text", body: 'Hugo builds in 12ms.\n\n```task-result\n{"task_id":"t1","status":"done"}\n```' },
      ],
    };
    const html = renderToString(<TaskCard view={view} now={Date.now()} onInterrupt={() => undefined} />);
    expect(html).toContain("WebSearch");
    expect(html).toContain("Hugo builds in 12ms.");
    expect(html).not.toContain("task-result");
  });

  test("done: chip, summary and tokens; no interrupt", () => {
    const view: TaskView = {
      ...base,
      status: "done",
      result: { task_id: "t1", status: "done", summary: "Hugo assessed." },
      usage: { input: 52000, output: 1800 },
    };
    const html = renderToString(<TaskCard view={view} now={Date.now()} onInterrupt={() => undefined} />);
    expect(html).toContain("Hugo assessed.");
    expect(html).toContain("52k in · 1800 out");
    expect(html).not.toContain("interrupt");
  });
});

describe("Report", () => {
  test("renders sections as markdown with the per-task appendix", () => {
    const missions = foldMissions([
      { prompt: "pick a ssg", reply: PLAN },
      { prompt: "RESULTS msn-x7\n{}", reply: REPORT },
    ]);
    const mission = missions[0]!;
    const appendix = [
      { task: mission.plan.tasks[0]!, result: { task_id: "t1", status: "done" as const, output: "# Hugo\nfast" } },
      { task: mission.plan.tasks[1]!, result: null },
    ];
    const html = renderToString(<Report mission={mission} appendix={appendix} onDownload={() => undefined} />);
    expect(html).toContain("Astro wins.");
    expect(html).toContain("<strong>Astro</strong>");
    expect(html).toContain("<li>fast</li>");
    expect(html).toContain("Survey Hugo");
    expect(html).toContain("No output was reported.");

    const md = reportMarkdown(mission, appendix);
    expect(md).toContain("# Pick a static site generator");
    expect(md).toContain("## Appendix: task outputs");
    expect(md).toContain("### t2 — Survey Astro");
  });
});
