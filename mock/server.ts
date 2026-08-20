/**
 * A tiny mock Fountain, for developing Watchtower without a live server:
 * one teammate, one conversation, canned turns that walk the whole protocol
 * (SET WATCHLIST → watch-config → six patrols of watch-state → an incident),
 * plus the schedules endpoints. Run with `bun run mock`, start the app with
 * `FOUNTAIN_PROXY=http://localhost:8788 bun run dev`, and open
 * http://localhost:5175/dev-seed.html once to point the app at it.
 */

const chunk = (text: string) =>
  JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
  });

const SITES = ["https://ok.example", "https://slow.example", "https://dying.example", "gone.example"];

const CONFIG = `Watching ${SITES.length} sites.

\`\`\`watch-config
${JSON.stringify({ sites: SITES })}
\`\`\``;

/** Six patrols, 30 min apart: ok stays green, slow's cert runs down, dying flaps, gone never resolves. */
function patrol(i: number): string {
  const t = new Date(Date.parse("2026-08-19T09:00:00Z") + i * 30 * 60000).toISOString();
  const dyingUp = i % 3 !== 2;
  const state = {
    checked_at: t,
    sites: [
      { url: "https://ok.example", up: true, status: 200, latency_ms: 150 + Math.round(60 * Math.sin(i)), cert_days_left: 84, cert_expires_at: "2026-11-11T00:00:00Z", dns: ["203.0.113.7"], note: null },
      { url: "https://slow.example", up: true, status: 200, latency_ms: 900 + i * 120, cert_days_left: 9, cert_expires_at: "2026-08-28T00:00:00Z", dns: ["203.0.113.9"], note: null },
      { url: "https://dying.example", up: dyingUp, status: dyingUp ? 200 : 503, latency_ms: dyingUp ? 300 : null, cert_days_left: 40, cert_expires_at: "2026-09-28T00:00:00Z", dns: ["198.51.100.4"], note: dyingUp ? null : "upstream 503 on every try" },
      { url: "gone.example", up: false, status: null, latency_ms: null, cert_days_left: null, cert_expires_at: null, dns: [], note: "NXDOMAIN — the name never resolves" },
    ],
  };
  return `Patrol done.\n\n\`\`\`watch-state\n${JSON.stringify(state)}\n\`\`\``;
}

const INCIDENT = `Dug into it — the edge is fine, the origin is not.

\`\`\`watch-incident
${JSON.stringify({
  url: "https://dying.example",
  summary: "Origin answers 503 on every request; the edge and DNS are healthy.",
  suspected_cause: "a bad deploy on the origin — the 503 body names a missing upstream",
  evidence: ["curl -sSI returns 503 with Server: nginx in 80ms", "traceroute reaches the edge in 7 hops, no loss", "dig +short is stable: 198.51.100.4", "5 repeated requests: 5/5 return 503"],
  checked_at: "2026-08-19T11:35:00Z",
})}
\`\`\``;

const mkTurn = (n: number, prompt: string, reply: string, at: string) => ({
  id: `t${n}`,
  turn_number: n,
  prompt,
  status: "completed",
  exit_code: 0,
  started_at: at,
  ended_at: at,
  inserted_at: at,
  reply,
});

const turns = [
  mkTurn(1, `SET WATCHLIST\n${JSON.stringify(SITES)}`, CONFIG, "2026-08-19T08:55:00Z"),
  ...Array.from({ length: 6 }, (_, i) => mkTurn(2 + i, "Run checks and report watch-state.", patrol(i), new Date(Date.parse("2026-08-19T09:00:00Z") + i * 30 * 60000).toISOString())),
  mkTurn(8, "Investigate https://dying.example", INCIDENT, "2026-08-19T11:35:00Z"),
];

const events = turns.map((t, i) => ({
  id: i + 1,
  kind: "output",
  stream: "acp",
  data: chunk(t.reply),
  stage: null,
  state: null,
  turn_id: t.id,
  ts: t.inserted_at,
}));

const teammate = {
  agent_id: "agent-watch",
  name: "Watchtower",
  agent: { id: "agent-watch", name: "watchtower", model: "anthropic/claude-sonnet-5", runtime: "claude", environment_id: null, allowed_vault_ids: null, allowed_environment_ids: null },
  conversation: { id: "c1", title: "Watchtower", agent_id: "agent-watch", vault_id: null, environment_id: null, runtime: "claude", acp: true, status: "idle", turn_count: turns.length, last_active_at: "2026-08-19T11:35:00Z", unread: false, inserted_at: "2026-08-19T08:00:00Z", updated_at: "2026-08-19T11:35:00Z" },
  presence: { state: "online", label: "online" },
  unread: false,
  last_turn: null,
};

let schedule = {
  id: "s1",
  agent_id: "agent-watch",
  name: "patrol",
  cron: "*/30 * * * *",
  prompt: "Run checks and report watch-state.",
  one_off: false,
  enabled: true,
  next_run_at: new Date(Date.now() + 14 * 60000).toISOString(),
  last_run_at: new Date(Date.now() - 16 * 60000).toISOString(),
  last_conversation_id: "c1",
  last_error: null,
  inserted_at: "2026-08-19T08:55:00Z",
  updated_at: "2026-08-19T08:55:00Z",
};

const json = (data: unknown) => Response.json({ data });

Bun.serve({
  port: 8788,
  idleTimeout: 120,
  routes: {
    "/api/auth/me": json({ id: "u1", email: "dev@example.com", role: "user" }),
    "/api/catalog": json({ runtimes: ["claude", "codex", "opencode"], models: { claude: ["anthropic/claude-sonnet-5", "anthropic/claude-opus-5"] } }),
    "/api/team": json([teammate]),
    "/api/team/agent-watch": json(teammate),
    "/api/team/agent-watch/schedules": {
      GET: () => json([schedule]),
      POST: () => json(schedule),
    },
    "/api/team/agent-watch/schedules/s1": {
      PATCH: async (req: Request) => {
        const patch = (await req.json()) as Partial<typeof schedule>;
        schedule = { ...schedule, ...patch, updated_at: new Date().toISOString() };
        return json(schedule);
      },
    },
    "/api/team/agent-watch/schedules/s1/run": () => {
      schedule = { ...schedule, last_run_at: new Date().toISOString() };
      return Response.json({ status: "queued", conversation_id: "c1" }, { status: 202 });
    },
    "/api/conversations/c1/turns": json(turns.map(({ reply: _r, ...t }) => t)),
    "/api/conversations/c1/events": () => Response.json({ data: events, meta: { has_more: false, next_cursor: null } }),
    "/api/conversations/c1/read": new Response(null, { status: 204 }),
    "/api/team/agent-watch/messages": () => Response.json({ status: "queued", conversation_id: "c1" }),
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
