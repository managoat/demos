/**
 * A tiny mock Fountain, for developing DNS Desk without a live server:
 * one teammate, one conversation, canned turns that walk the whole protocol
 * (state → plan → approve → result → fresh state). Run with `bun run mock`,
 * start the app with `FOUNTAIN_PROXY=http://localhost:8787 bun run dev`,
 * and paste any string as the API key with http://localhost:5174 as the URL.
 */

const chunk = (text: string) =>
  JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
  });

const STATE_V1 = `Here is everything the token can see.

\`\`\`dns-state
{"fetched_at":"2026-08-19T16:00:00Z","complete":true,"zones":[{"name":"example.com","id":"z1","records":[{"type":"A","name":"www.example.com","content":"203.0.113.10","ttl":1,"proxied":true},{"type":"MX","name":"example.com","content":"mail.example.com","ttl":300,"priority":10},{"type":"TXT","name":"_dmarc.example.com","content":"v=DMARC1; p=quarantine","ttl":300}]}]}
\`\`\``;

const PLAN = `That's one new record. Plan below — nothing applied.

\`\`\`dns-plan
{"id":"plan-k4x9","zone":"example.com","summary":"Create demo.example.com → 203.0.113.7 (A, DNS only)","changes":[{"op":"create","type":"A","name":"demo.example.com","content":"203.0.113.7","ttl":1,"proxied":false}]}
\`\`\``;

const now = "2026-08-19T16:05:00.000000Z";
const turns = [
  { id: "t1", turn_number: 1, prompt: "what zones do you see?", status: "completed", exit_code: 0, started_at: now, ended_at: now, inserted_at: now, reply: STATE_V1 },
  { id: "t2", turn_number: 2, prompt: "add an A record demo → 203.0.113.7, no proxy", status: "completed", exit_code: 0, started_at: now, ended_at: now, inserted_at: now, reply: PLAN },
];

const events = turns.map((t, i) => ({
  id: i + 1,
  kind: "output",
  stream: "acp",
  data: chunk(t.reply),
  stage: null,
  state: null,
  turn_id: t.id,
  ts: now,
}));

const teammate = {
  agent_id: "agent-dns",
  name: "dns-desk",
  agent: { id: "agent-dns", name: "dns-desk", model: "anthropic/claude-sonnet-5", runtime: "claude", environment_id: null, allowed_vault_ids: null, allowed_environment_ids: null },
  conversation: { id: "c1", title: null, agent_id: "agent-dns", vault_id: "v1", environment_id: null, runtime: "claude", acp: true, status: "idle", turn_count: turns.length, last_active_at: now, unread: false, inserted_at: now, updated_at: now },
  presence: { state: "online", label: "online" },
  unread: false,
  last_turn: null,
};

const json = (data: unknown) => Response.json({ data });

Bun.serve({
  port: 8787,
  idleTimeout: 120,
  routes: {
    "/api/auth/me": json({ id: "u1", email: "dev@example.com", role: "user" }),
    "/api/team": json([teammate]),
    "/api/team/agent-dns": json(teammate),
    "/api/conversations/c1/turns": json(turns.map(({ reply: _r, ...t }) => t)),
    "/api/conversations/c1/events": () =>
      Response.json({ data: events, meta: { has_more: false, next_cursor: null } }),
    "/api/conversations/c1/read": new Response(null, { status: 204 }),
    "/api/team/agent-dns/messages": () => Response.json({ status: "queued", conversation_id: "c1" }),
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

console.log("mock Fountain on http://localhost:8787");
