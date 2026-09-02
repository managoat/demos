/**
 * The Mission Control protocol: how the app reads the coordinator and the
 * workers. Three fenced blocks — ```mission-plan and ```mission-report in the
 * coordinator's replies, ```task-result at the end of a worker's — plus three
 * plain user messages to the coordinator: the mission text, `APPROVE <id>`,
 * `LAUNCHED <id> t1=<conv> …`, and `RESULTS <id>` + JSON. The agent's side of
 * the contract is `spec.ts` — change one, change both.
 *
 * The coordinator conversation is the system of record: everything the UI
 * shows about a mission is folded out of its turns (plus the worker
 * conversations the LAUNCHED lines point at), never stored elsewhere.
 */
import { MAX_TASKS } from "./spec";

export interface MissionTask {
  id: string;
  title: string;
  brief: string;
  deliverable?: string;
}

export interface MissionPlan {
  id: string;
  objective: string;
  tasks: MissionTask[];
}

export interface TaskResult {
  task_id: string;
  status: "done" | "blocked";
  summary?: string;
  output?: string;
}

export interface ReportSection {
  heading: string;
  body_md: string;
}

export interface MissionReport {
  id: string;
  objective?: string;
  outcome?: string;
  sections: ReportSection[];
}

export type ProtocolBlock =
  | { kind: "plan"; plan: MissionPlan }
  | { kind: "result"; result: TaskResult }
  | { kind: "report"; report: MissionReport };

const FENCE = /```(mission-plan|task-result|mission-report)[^\S\n]*\n([\s\S]*?)```/g;

/** Every well-formed protocol block in one reply, in order. Malformed JSON is skipped. */
export function parseBlocks(text: string): ProtocolBlock[] {
  const out: ProtocolBlock[] = [];
  for (const m of text.matchAll(FENCE)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[2]!);
    } catch {
      continue;
    }
    if (!isObj(parsed)) continue;
    if (m[1] === "mission-plan") {
      const plan = asPlan(parsed);
      if (plan) out.push({ kind: "plan", plan });
    } else if (m[1] === "task-result") {
      const result = asResult(parsed);
      if (result) out.push({ kind: "result", result });
    } else {
      const report = asReport(parsed);
      if (report) out.push({ kind: "report", report });
    }
  }
  return out;
}

/** The reply with protocol blocks removed — what a chat bubble shows as prose. */
export function stripBlocks(text: string): string {
  return text.replace(FENCE, "").replace(/\n{3,}/g, "\n\n").trim();
}

// ── the app's messages to the coordinator ────────────────────────────────────

export type Command =
  | { verb: "approve"; missionId: string }
  | { verb: "launched"; missionId: string; assignments: Record<string, string> }
  | { verb: "results"; missionId: string };

/** APPROVE / LAUNCHED / RESULTS in a user message; null for a plain mission prompt. */
export function parseCommand(prompt: string): Command | null {
  const firstLine = prompt.trim().split("\n", 1)[0]!.trim();
  let m = firstLine.match(/^APPROVE\s+(\S+)$/i);
  if (m) return { verb: "approve", missionId: m[1]! };
  m = firstLine.match(/^LAUNCHED\s+(\S+)((?:\s+\S+=\S+)*)$/i);
  if (m) {
    const assignments: Record<string, string> = {};
    for (const pair of m[2]!.trim().split(/\s+/)) {
      if (!pair) continue;
      const eq = pair.indexOf("=");
      if (eq > 0) assignments[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    return { verb: "launched", missionId: m[1]!, assignments };
  }
  m = firstLine.match(/^RESULTS\s+(\S+)$/i);
  if (m) return { verb: "results", missionId: m[1]! };
  return null;
}

export function approveMessage(missionId: string): string {
  return `APPROVE ${missionId}`;
}

/** `LAUNCHED msn-x t1=<conv> t2=<conv>` — the line that makes a mission recoverable. */
export function launchedMessage(missionId: string, assignments: Record<string, string>): string {
  const pairs = Object.entries(assignments)
    .map(([taskId, convId]) => `${taskId}=${convId}`)
    .join(" ");
  return `LAUNCHED ${missionId} ${pairs}`;
}

export function resultsMessage(missionId: string, results: TaskResult[]): string {
  return `RESULTS ${missionId}\n${JSON.stringify({ mission_id: missionId, results }, null, 2)}`;
}

/** The prompt a worker conversation is launched with: objective + brief + task id. */
export function workerPrompt(plan: MissionPlan, task: MissionTask): string {
  const deliverable = task.deliverable ? `\nDeliverable: ${task.deliverable}` : "";
  return `Mission objective: ${plan.objective}

Your task (${task.id}): ${task.title}
${task.brief}${deliverable}

End your reply with the task-result block for task_id "${task.id}".`;
}

/** The worker conversation's title: `msn-x · t1 — <title>`, within Fountain's 120. */
export function workerTitle(missionId: string, task: MissionTask): string {
  const title = `${missionId} · ${task.id} — ${task.title}`;
  return title.length > 120 ? title.slice(0, 119) + "…" : title;
}

// ── folding the coordinator conversation into missions ───────────────────────

export type MissionStatus = "awaiting" | "superseded" | "launching" | "flight" | "complete";

export interface Mission {
  plan: MissionPlan;
  status: MissionStatus;
  /** task id → worker conversation id, merged over every LAUNCHED line */
  assignments: Record<string, string>;
  approved: boolean;
  resultsSent: boolean;
  report: MissionReport | null;
  /** index of the turn the plan appeared in, for ordering */
  turnIndex: number;
}

/**
 * Fold the coordinator conversation into missions. `turns` is oldest-first:
 * each entry is the user's prompt plus the coordinator's full reply text.
 *
 * Status is derived, never stored: a mission-report completes a mission; any
 * LAUNCHED assignment puts it in flight; APPROVE marks it launching; a newer
 * plan supersedes an older one still awaiting approval.
 */
export function foldMissions(turns: Array<{ prompt: string; reply: string }>): Mission[] {
  const missions = new Map<string, Mission>();

  turns.forEach((turn, i) => {
    const cmd = parseCommand(turn.prompt);
    if (cmd) {
      const mission = missions.get(cmd.missionId);
      if (mission) {
        if (cmd.verb === "approve") mission.approved = true;
        else if (cmd.verb === "launched") Object.assign(mission.assignments, cmd.assignments);
        else mission.resultsSent = true;
      }
    }
    for (const block of parseBlocks(turn.reply)) {
      if (block.kind === "plan") {
        const existing = missions.get(block.plan.id);
        if (existing) {
          existing.plan = block.plan;
          existing.turnIndex = i;
        } else {
          missions.set(block.plan.id, {
            plan: block.plan,
            status: "awaiting",
            assignments: {},
            approved: false,
            resultsSent: false,
            report: null,
            turnIndex: i,
          });
        }
      } else if (block.kind === "report") {
        const mission = missions.get(block.report.id);
        if (mission) mission.report = block.report;
      }
    }
  });

  const out = [...missions.values()].sort((a, b) => a.turnIndex - b.turnIndex);
  for (const m of out) {
    m.status = m.report
      ? "complete"
      : Object.keys(m.assignments).length > 0
        ? "flight"
        : m.approved
          ? "launching"
          : "awaiting";
  }
  // A newer plan supersedes older ones still awaiting a decision.
  const lastAwaiting = out.map((m) => m.status).lastIndexOf("awaiting");
  out.forEach((m, i) => {
    if (m.status === "awaiting" && i < lastAwaiting) m.status = "superseded";
  });
  return out;
}

/** The one plan an Approve button should point at, if any. */
export function pendingMission(missions: Mission[]): Mission | null {
  for (let i = missions.length - 1; i >= 0; i--) {
    if (missions[i]!.status === "awaiting") return missions[i]!;
  }
  return null;
}

/** The newest task-result in a worker's reply text, if any. */
export function taskResultOf(reply: string): TaskResult | null {
  let last: TaskResult | null = null;
  for (const block of parseBlocks(reply)) {
    if (block.kind === "result") last = block.result;
  }
  return last;
}

// ── per-task status, derived from the worker conversation ────────────────────

export type TaskStatus =
  | "queued"
  | "provisioning"
  | "working"
  | "done"
  | "blocked"
  | "failed"
  | "terminated"
  | "noresult";

export function taskStatus(input: {
  assigned: boolean;
  /** null until the worker conversation has been fetched */
  conversation: { status: string } | null;
  /** the sandbox's session stage finished — the boot sequence is over */
  sessionReady: boolean;
  result: TaskResult | null;
}): TaskStatus {
  if (!input.assigned) return "queued";
  if (input.result) return input.result.status === "done" ? "done" : "blocked";
  const conv = input.conversation;
  if (!conv) return "provisioning";
  if (conv.status === "failed") return "failed";
  if (conv.status === "terminated") return "terminated";
  if (conv.status === "idle") return "noresult";
  return input.sessionReady ? "working" : "provisioning";
}

// ── shape guards: tolerate a sloppy agent, never a crashing UI ───────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asPlan(v: Record<string, unknown>): MissionPlan | null {
  const id = str(v.id);
  const objective = str(v.objective);
  if (!id || !objective || !Array.isArray(v.tasks)) return null;
  const tasks: MissionTask[] = [];
  for (const t of v.tasks) {
    if (!isObj(t)) continue;
    const taskId = str(t.id);
    const title = str(t.title);
    const brief = str(t.brief);
    if (!taskId || !title || !brief) continue;
    const task: MissionTask = { id: taskId, title, brief };
    const deliverable = str(t.deliverable);
    if (deliverable) task.deliverable = deliverable;
    tasks.push(task);
    if (tasks.length >= MAX_TASKS) break; // clamp client-side, whatever the agent said
  }
  if (tasks.length === 0) return null;
  return { id, objective, tasks };
}

function asResult(v: Record<string, unknown>): TaskResult | null {
  const taskId = str(v.task_id);
  const status = str(v.status);
  if (!taskId || (status !== "done" && status !== "blocked")) return null;
  const result: TaskResult = { task_id: taskId, status };
  const summary = str(v.summary);
  if (summary) result.summary = summary;
  if (typeof v.output === "string") result.output = v.output;
  return result;
}

function asReport(v: Record<string, unknown>): MissionReport | null {
  const id = str(v.id);
  if (!id || !Array.isArray(v.sections)) return null;
  const sections: ReportSection[] = [];
  for (const s of v.sections) {
    if (!isObj(s)) continue;
    const heading = str(s.heading);
    const body = typeof s.body_md === "string" ? s.body_md : null;
    if (!heading || body === null) continue;
    sections.push({ heading, body_md: body });
  }
  const report: MissionReport = { id, sections };
  const objective = str(v.objective);
  if (objective) report.objective = objective;
  const outcome = str(v.outcome);
  if (outcome) report.outcome = outcome;
  return report;
}
