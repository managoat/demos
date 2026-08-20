/**
 * A tiny mock Fountain, for developing Mission Control without a live server:
 * one coordinator teammate with a plan awaiting approval on one mission and a
 * second mission in flight (two workers: one working, one done). Run with
 * `bun run mock`, start the app with `FOUNTAIN_PROXY=http://localhost:8791
 * bun run dev`, and open http://localhost:5179/dev-seed.html once.
 */

const chunk = (text: string) =>
  JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
  });

const PLAN_NEW = `Split three ways — nothing launches until you approve.

\`\`\`mission-plan
{"id":"msn-7c21","objective":"Research the top static site generators and recommend one","tasks":[
  {"id":"t1","title":"Survey Hugo","brief":"Evaluate Hugo for a small docs site: build speed, theming, content model, maintenance burden. Use its docs and recent benchmarks.","deliverable":"a one-page assessment with a verdict"},
  {"id":"t2","title":"Survey Astro","brief":"Evaluate Astro the same way: build speed, theming, content model, maintenance burden.","deliverable":"a one-page assessment with a verdict"},
  {"id":"t3","title":"Compare hosting stories","brief":"Compare deploying Hugo and Astro to GitHub Pages and Cloudflare Pages: build minutes, preview deploys, gotchas.","deliverable":"a comparison table with notes"}
]}
\`\`\``;

const PLAN_FLIGHT = `\`\`\`mission-plan
{"id":"msn-4f2a","objective":"Write a launch plan for the new CLI","tasks":[
  {"id":"t1","title":"Draft the announcement","brief":"Write a launch announcement blog post for a developer CLI tool.","deliverable":"the post, markdown"},
  {"id":"t2","title":"Plan the rollout","brief":"Draft a two-week rollout timeline: beta list, docs, social, metrics to watch.","deliverable":"the timeline, markdown"}
]}
\`\`\``;

const RESULT_T1 = `Announcement drafted.

\`\`\`task-result
{"task_id":"t1","status":"done","summary":"Launch post drafted, 600 words.","output":"# Ship it\\n\\nToday we launch…"}
\`\`\``;

const now = "2026-08-19T16:05:00.000000Z";
const turn = (id: string, n: number, prompt: string, reply: string) => ({
  id,
  turn_number: n,
  prompt,
  status: "completed",
  exit_code: 0,
  started_at: now,
  ended_at: now,
  inserted_at: now,
  usage: { input: 12000, output: 900 },
  reply,
});

const coordTurns = [
  turn("ct1", 1, "Write a launch plan for the new CLI", PLAN_FLIGHT),
  turn("ct2", 2, "APPROVE msn-4f2a", "Acknowledged — the app launches the fleet."),
  turn("ct3", 3, "LAUNCHED msn-4f2a t1=w1 t2=w2", "Fleet away."),
  turn("ct4", 4, "Research the top static site generators and recommend one", PLAN_NEW),
];

const workerTurns: Record<string, ReturnType<typeof turn>[]> = {
  w1: [turn("wt1", 1, "Mission objective: … t1", RESULT_T1)],
  w2: [{ ...turn("wt2", 1, "Mission objective: … t2", "Working through the timeline…"), status: "running", ended_at: null, usage: null }],
};

const eventsOf = (turns: ReturnType<typeof turn>[], extraStages = false) => {
  let id = 1;
  const out: unknown[] = [];
  if (extraStages) {
    for (const [stage, state] of [["provision", "done"], ["packages", "done"], ["session", "done"]] as const) {
      out.push({ id: id++, kind: "stage", stream: "", data: "{}", stage, state, turn_id: null, ts: now, blocks: [] });
    }
  }
  for (const t of turns) {
    out.push({
      id: id++,
      kind: "output",
      stream: "acp",
      data: chunk(t.reply),
      stage: null,
      state: null,
      turn_id: t.id,
      ts: now,
      blocks: [{ kind: "text", body: t.reply }],
    });
  }
  return out;
};

const conv = (id: string, status: string, agentId: string, title: string | null = null) => ({
  id,
  title,
  agent_id: agentId,
  vault_id: null,
  environment_id: null,
  runtime: "claude",
  acp: true,
  status,
  turn_count: 1,
  last_active_at: now,
  unread: false,
  usage_total: { input: 12000, output: 900 },
  sandbox: { id: `sb-${id}`, status: status === "running" ? "ready" : "ready" },
  inserted_at: "2026-08-19T16:00:00.000000Z",
  updated_at: now,
});

const coordinator = {
  agent_id: "agent-coord",
  name: "Mission Control",
  agent: {
    id: "agent-coord",
    name: "Mission Control",
    model: "anthropic/claude-sonnet-5",
    runtime: "claude",
    environment_id: null,
    allowed_vault_ids: null,
    allowed_environment_ids: null,
  },
  conversation: conv("c-coord", "idle", "agent-coord", "Mission Control"),
  presence: { state: "online", label: "online" },
  unread: false,
  last_turn: null,
};

const workerAgent = {
  id: "agent-worker",
  name: "Mission Worker",
  model: "anthropic/claude-sonnet-5",
  runtime: "claude",
  environment_id: null,
  allowed_vault_ids: null,
  allowed_environment_ids: null,
};

const json = (data: unknown) => Response.json({ data });
const page = (data: unknown[]) => Response.json({ data, meta: { has_more: false, next_cursor: null } });
let nextConv = 100;

Bun.serve({
  port: 8791,
  idleTimeout: 120,
  routes: {
    "/api/auth/me": json({ id: "u1", email: "dev@example.com", role: "user" }),
    "/api/catalog": json({ runtimes: ["claude", "codex", "opencode"], models: { claude: ["anthropic/claude-sonnet-5", "anthropic/claude-opus-5"] } }),
    "/api/agents": (req: Request) => {
      const q = new URL(req.url).searchParams.get("search") ?? "";
      if (req.method === "POST") return json(workerAgent);
      return json("Mission Worker".toLowerCase().includes(q.toLowerCase()) || q === "" ? [workerAgent] : []);
    },
    "/api/team": (req: Request) => (req.method === "POST" ? json(coordinator) : json([coordinator])),
    "/api/team/agent-coord": json(coordinator),
    "/api/team/agent-coord/messages": () => Response.json({ status: "queued", conversation_id: "c-coord" }),
    "/api/conversations": (req: Request) => {
      if (req.method === "POST") return json(conv(`w${nextConv++}`, "pending", "agent-worker"));
      return json([conv("w1", "idle", "agent-worker"), conv("w2", "running", "agent-worker")]);
    },
    "/api/conversations/c-coord/turns": json(coordTurns.map(({ reply: _r, ...t }) => t)),
    "/api/conversations/c-coord/events": () => page(eventsOf(coordTurns)),
    "/api/conversations/c-coord/read": new Response(null, { status: 204 }),
    "/api/conversations/w1": json(conv("w1", "idle", "agent-worker", "msn-4f2a · t1 — Draft the announcement")),
    "/api/conversations/w1/turns": json(workerTurns.w1!.map(({ reply: _r, ...t }) => t)),
    "/api/conversations/w1/events": () => page(eventsOf(workerTurns.w1!, true)),
    "/api/conversations/w2": json(conv("w2", "running", "agent-worker", "msn-4f2a · t2 — Plan the rollout")),
    "/api/conversations/w2/turns": json(workerTurns.w2!.map(({ reply: _r, ...t }) => t)),
    "/api/conversations/w2/events": () => page(eventsOf(workerTurns.w2!, true)),
    "/api/events/stream": () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(": connected\n\n"));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  },
  fetch: () => Response.json({ error: "not_found" }, { status: 404 }),
});

console.log("mock Fountain on http://localhost:8791");
