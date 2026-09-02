/**
 * A tiny mock Fountain, for developing Table Talk without a live server:
 * one analyst teammate, one dataset conversation whose canned turns walk the
 * whole protocol (hand-off → report with all three chart kinds → follow-up).
 * Run with `bun run mock`, start the app with
 * `FOUNTAIN_PROXY=http://localhost:8788 bun run dev`, and open
 * http://localhost:5175/dev-seed.html once to point the app at it.
 */

const chunk = (text: string) =>
  JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
  });

const tool = (id: string, title: string, path: string) =>
  JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: { update: { sessionUpdate: "tool_call", toolCallId: id, title, locations: [{ path }] } },
  });

const toolDone = (id: string, output: string) =>
  JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: id,
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: output } }],
      },
    },
  });

const CSV = "region,month,revenue\nwest,2026-01,120\nwest,2026-02,140\neast,2026-01,80\neast,2026-02,95\nsouth,2026-01,60\nsouth,2026-02,55";

const HANDOFF = `New dataset: sales.csv\n\nSave the CSV below to disk as sales.csv, then analyze it per your instructions and reply with a table-report block.\n\n\`\`\`csv\n${CSV}\n\`\`\``;

const REPORT = `Nice little dataset — three regions, two months. The west is carrying the team.

\`\`\`table-report
{"id":"rpt-1","title":"Sales at a glance","insights":["West brings in almost half the money — about $260 of $550 total.","Every region grew from January to February except the south, which slipped a little.","No blank cells anywhere — tidy data."],"stats":{"rows":6,"columns":[{"name":"region","type":"category","distinct":3,"top":"west"},{"name":"month","type":"date","distinct":2},{"name":"revenue","type":"number","min":55,"max":140,"mean":91.7}]},"charts":[{"type":"bar","title":"Revenue by region","x":["west","east","south"],"series":[{"name":"revenue","y":[260,175,115]}]},{"type":"line","title":"Revenue over time","x":["2026-01","2026-02"],"series":[{"name":"west","y":[120,140]},{"name":"east","y":[80,95]},{"name":"south","y":[60,55]}]},{"type":"pie","title":"Share of revenue","x":["west","east","south"],"series":[{"name":"revenue","y":[260,175,115]}]}]}
\`\`\``;

const FOLLOWUP = `February, and it wasn't close — $290 against January's $260. The west and east both stepped up.

\`\`\`table-report
{"id":"rpt-2","title":"Best month","insights":["February beat January $290 to $260 — up about 12%."],"charts":[{"type":"bar","title":"Revenue by month","x":["2026-01","2026-02"],"series":[{"name":"revenue","y":[260,290]}]}]}
\`\`\``;

const now = "2026-08-19T16:05:00.000000Z";
const turns = [
  { id: "t1", turn_number: 1, prompt: HANDOFF, status: "completed", exit_code: 0, started_at: now, ended_at: now, inserted_at: now },
  { id: "t2", turn_number: 2, prompt: "which month was the best?", status: "completed", exit_code: 0, started_at: now, ended_at: now, inserted_at: now },
];

const mkEvent = (id: number, turn_id: string, data: string) => ({
  id,
  kind: "output",
  stream: "acp",
  data,
  stage: null,
  state: null,
  turn_id,
  ts: now,
});

const events = [
  mkEvent(1, "t1", tool("c1", "Write file", "~/datasets/sales.csv")),
  mkEvent(2, "t1", toolDone("c1", "wrote 6 rows")),
  mkEvent(3, "t1", tool("c2", "Run python", "analyze.py")),
  mkEvent(4, "t1", toolDone("c2", "totals: west 260, east 175, south 115")),
  mkEvent(5, "t1", chunk(REPORT)),
  mkEvent(6, "t2", chunk(FOLLOWUP)),
];

const conversation = {
  id: "c1",
  title: "sales.csv",
  agent_id: "agent-tt",
  vault_id: null,
  environment_id: null,
  runtime: "claude",
  acp: true,
  status: "idle",
  turn_count: turns.length,
  last_active_at: now,
  unread: false,
  inserted_at: now,
  updated_at: now,
};

const teammate = {
  agent_id: "agent-tt",
  name: "table-talk",
  agent: {
    id: "agent-tt",
    name: "table-talk",
    model: "anthropic/claude-sonnet-5",
    runtime: "claude",
    environment_id: null,
    allowed_vault_ids: null,
    allowed_environment_ids: null,
  },
  conversation,
  presence: { state: "online", label: "online" },
  unread: false,
  last_turn: null,
};

const json = (data: unknown) => Response.json({ data });

Bun.serve({
  port: 8788,
  idleTimeout: 120,
  routes: {
    "/api/team": json([teammate]),
    "/api/team/agent-tt": json(teammate),
    "/api/conversations/c1": json(conversation),
    "/api/conversations/c1/turns": json(turns),
    "/api/conversations/c1/events": () => Response.json({ data: events, meta: { has_more: false, next_cursor: null } }),
    "/api/conversations/c1/read": new Response(null, { status: 204 }),
    "/api/team/agent-tt/messages": () => Response.json({ status: "queued", conversation_id: "c1" }),
    "/api/team/agent-tt/conversations": () => Response.json({ data: conversation }, { status: 201 }),
    "/api/team/stream": () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(": hello\n\n"));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  },
  fetch: () => Response.json({ error: "not_found" }, { status: 404 }),
});

console.log("mock Fountain on http://localhost:8788");
