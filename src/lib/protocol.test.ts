import { describe, expect, test } from "bun:test";
import {
  approveMessage,
  foldMissions,
  launchedMessage,
  parseBlocks,
  parseCommand,
  pendingMission,
  resultsMessage,
  stripBlocks,
  taskResultOf,
  taskStatus,
  workerPrompt,
  workerTitle,
} from "./protocol";

const PLAN = `On it — split four ways.

\`\`\`mission-plan
{"id":"msn-4f2a","objective":"Pick a static site generator","tasks":[
  {"id":"t1","title":"Survey Hugo","brief":"Evaluate Hugo for a docs site: speed, theming, maintenance.","deliverable":"a one-page assessment"},
  {"id":"t2","title":"Survey Astro","brief":"Evaluate Astro the same way.","deliverable":"a one-page assessment"}
]}
\`\`\``;

const REPORT = `\`\`\`mission-report
{"id":"msn-4f2a","objective":"Pick a static site generator","outcome":"Astro wins.","sections":[{"heading":"Recommendation","body_md":"Use **Astro**."}]}
\`\`\``;

const RESULT = `Done with the survey.

\`\`\`task-result
{"task_id":"t1","status":"done","summary":"Hugo assessed.","output":"# Hugo\\nFast."}
\`\`\``;

describe("parseBlocks", () => {
  test("parses a plan with its tasks", () => {
    const blocks = parseBlocks(PLAN);
    expect(blocks).toHaveLength(1);
    const first = blocks[0]!;
    const plan = first.kind === "plan" ? first.plan : null;
    expect(plan?.id).toBe("msn-4f2a");
    expect(plan?.tasks.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(plan?.tasks[0]?.deliverable).toBe("a one-page assessment");
  });

  test("clamps a plan to five tasks even if the agent emits more", () => {
    const tasks = Array.from({ length: 7 }, (_, i) => ({ id: `t${i + 1}`, title: `T${i + 1}`, brief: "b" }));
    const text = "```mission-plan\n" + JSON.stringify({ id: "msn-big", objective: "o", tasks }) + "\n```";
    const block = parseBlocks(text)[0]!;
    if (block.kind !== "plan") throw new Error("expected plan");
    expect(block.plan.tasks).toHaveLength(5);
  });

  test("skips malformed JSON and wrong shapes; parses results and reports", () => {
    const text = "```mission-plan\nnot json\n```\n" + RESULT + "\n" + REPORT;
    const kinds = parseBlocks(text).map((b) => b.kind);
    expect(kinds).toEqual(["result", "report"]);
  });

  test("stripBlocks leaves only the prose", () => {
    expect(stripBlocks(PLAN)).toBe("On it — split four ways.");
  });
});

describe("commands", () => {
  test("APPROVE / RESULTS round-trip through their builders", () => {
    expect(parseCommand(approveMessage("msn-4f2a"))).toEqual({ verb: "approve", missionId: "msn-4f2a" });
    expect(parseCommand(resultsMessage("msn-4f2a", [{ task_id: "t1", status: "done" }]))).toEqual({
      verb: "results",
      missionId: "msn-4f2a",
    });
  });

  test("LAUNCHED round-trips its assignments", () => {
    const msg = launchedMessage("msn-4f2a", { t1: "c-111", t2: "c-222" });
    expect(msg).toBe("LAUNCHED msn-4f2a t1=c-111 t2=c-222");
    expect(parseCommand(msg)).toEqual({ verb: "launched", missionId: "msn-4f2a", assignments: { t1: "c-111", t2: "c-222" } });
  });

  test("a plain mission prompt is not a command", () => {
    expect(parseCommand("Research the top 5 static site generators")).toBeNull();
    expect(parseCommand("approve of this plan? maybe")).toBeNull();
  });
});

describe("foldMissions", () => {
  test("plan → approve → launch → results → report walks the statuses", () => {
    const planOnly = foldMissions([{ prompt: "pick a ssg", reply: PLAN }]);
    expect(planOnly[0]?.status).toBe("awaiting");
    expect(pendingMission(planOnly)?.plan.id).toBe("msn-4f2a");

    const approved = foldMissions([
      { prompt: "pick a ssg", reply: PLAN },
      { prompt: "APPROVE msn-4f2a", reply: "Acknowledged." },
    ]);
    expect(approved[0]?.status).toBe("launching");

    const launched = foldMissions([
      { prompt: "pick a ssg", reply: PLAN },
      { prompt: "APPROVE msn-4f2a", reply: "Acknowledged." },
      { prompt: "LAUNCHED msn-4f2a t1=c-111", reply: "Fleet away." },
      { prompt: "LAUNCHED msn-4f2a t2=c-222", reply: "Noted." },
    ]);
    expect(launched[0]?.status).toBe("flight");
    expect(launched[0]?.assignments).toEqual({ t1: "c-111", t2: "c-222" });

    const complete = foldMissions([
      { prompt: "pick a ssg", reply: PLAN },
      { prompt: "APPROVE msn-4f2a", reply: "Acknowledged." },
      { prompt: "LAUNCHED msn-4f2a t1=c-111 t2=c-222", reply: "Fleet away." },
      { prompt: "RESULTS msn-4f2a\n{}", reply: REPORT },
    ]);
    expect(complete[0]?.status).toBe("complete");
    expect(complete[0]?.resultsSent).toBe(true);
    expect(complete[0]?.report?.outcome).toBe("Astro wins.");
    expect(pendingMission(complete)).toBeNull();
  });

  test("a newer plan supersedes an older one still awaiting approval", () => {
    const newer = PLAN.replace(/msn-4f2a/g, "msn-9b1c");
    const missions = foldMissions([
      { prompt: "pick a ssg", reply: PLAN },
      { prompt: "only two tasks please", reply: newer },
    ]);
    expect(missions.map((m) => [m.plan.id, m.status])).toEqual([
      ["msn-4f2a", "superseded"],
      ["msn-9b1c", "awaiting"],
    ]);
  });
});

describe("worker side", () => {
  test("taskResultOf takes the last result block", () => {
    expect(taskResultOf(RESULT)?.status).toBe("done");
    expect(taskResultOf(RESULT)?.output).toBe("# Hugo\nFast.");
    expect(taskResultOf("no fences here")).toBeNull();
  });

  test("workerPrompt carries objective, brief, deliverable and the task id", () => {
    const plan = parseBlocks(PLAN)[0]!;
    if (plan.kind !== "plan") throw new Error("expected plan");
    const prompt = workerPrompt(plan.plan, plan.plan.tasks[0]!);
    expect(prompt).toContain("Pick a static site generator");
    expect(prompt).toContain("Your task (t1): Survey Hugo");
    expect(prompt).toContain("Deliverable: a one-page assessment");
    expect(prompt).toContain('task-result block for task_id "t1"');
  });

  test("workerTitle stays within 120 chars", () => {
    const long = { id: "t1", title: "x".repeat(200), brief: "b" };
    expect(workerTitle("msn-4f2a", long).length).toBeLessThanOrEqual(120);
  });
});

describe("taskStatus", () => {
  const base = { assigned: true, conversation: { status: "running" }, sessionReady: true, result: null };
  test("walks the lifecycle", () => {
    expect(taskStatus({ ...base, assigned: false })).toBe("queued");
    expect(taskStatus({ ...base, conversation: null })).toBe("provisioning");
    expect(taskStatus({ ...base, sessionReady: false })).toBe("provisioning");
    expect(taskStatus(base)).toBe("working");
    expect(taskStatus({ ...base, result: { task_id: "t1", status: "done" } })).toBe("done");
    expect(taskStatus({ ...base, result: { task_id: "t1", status: "blocked" } })).toBe("blocked");
    expect(taskStatus({ ...base, conversation: { status: "failed" } })).toBe("failed");
    expect(taskStatus({ ...base, conversation: { status: "terminated" } })).toBe("terminated");
    expect(taskStatus({ ...base, conversation: { status: "idle" } })).toBe("noresult");
  });
  test("a result wins over a dead conversation", () => {
    expect(taskStatus({ ...base, conversation: { status: "terminated" }, result: { task_id: "t1", status: "done" } })).toBe("done");
  });
});
