/**
 * A tiny mock Fountain, for developing Repo Sage without a live server: one
 * sage teammate whose canned turns walk the whole protocol (study → repo-map,
 * then a question answered with tool chips and citations). Run with
 * `bun run mock`, start the app with `FOUNTAIN_PROXY=http://localhost:8788
 * bun run dev`, and paste any string as the API key with
 * http://localhost:5175 as the URL.
 */

const chunk = (text: string) =>
  JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
  });

const tool = (id: string, title: string, path?: string) =>
  JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: { update: { sessionUpdate: "tool_call", toolCallId: id, title, ...(path ? { locations: [{ path }] } : {}) } },
  });

const toolDone = (id: string, text: string) =>
  JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: id,
        status: "completed",
        content: [{ type: "content", content: { type: "text", text } }],
      },
    },
  });

const STUDY_REPLY = `Cloned and read it. This is a small Phoenix umbrella with the API under one router.

\`\`\`repo-map
{"repo":"BinaryBourbon/fountain","default_branch":"main","description":"Run AI coding agents on their own computers, over one API","languages":[{"name":"Elixir","share":0.82},{"name":"Go","share":0.12},{"name":"TypeScript","share":0.06}],"loc":98000,"components":[{"name":"router","path":"apps/fountain/lib/fountain_web/router.ex","role":"every /api route"},{"name":"contexts","path":"apps/fountain/lib/fountain","role":"Agents, Environments, Vaults, Conversations"},{"name":"team","path":"apps/fountain/lib/fountain/team.ex","role":"teammates = conversations on the team channel"},{"name":"CLI","path":"cli","role":"the fountain command"}],"entry_points":["apps/fountain/lib/fountain/application.ex"],"how_it_works":"A Phoenix app exposes the API; conversations run agents in sandboxes and stream their output back as log events."}
\`\`\``;

const ANSWER_REPLY = `Auth is a bearer API key on every request: the plug at apps/fountain/lib/fountain_web/plugs/tenant_api_auth.ex:1 hashes the key and loads the user. OAuth sign-in mints the same kind of key.

\`\`\`citations
[{"path":"apps/fountain/lib/fountain_web/plugs/tenant_api_auth.ex","start":1,"end":40,"why":"the bearer-key plug"},{"path":"apps/fountain/lib/fountain/oauth.ex","why":"OAuth codes become API keys"}]
\`\`\``;

const now = "2026-08-19T16:05:00.000000Z";
const STUDY_PROMPT = "Study the repository now: clone it, survey it, and report the repo-map block.";

const turns = [
  { id: "t1", turn_number: 1, prompt: STUDY_PROMPT, status: "completed", exit_code: 0, started_at: now, ended_at: now, inserted_at: now },
  { id: "t2", turn_number: 2, prompt: "How does auth work?", status: "completed", exit_code: 0, started_at: now, ended_at: now, inserted_at: now },
];

const eventData = [
  { turn: "t1", data: tool("c1", "Clone", "~/repo") },
  { turn: "t1", data: toolDone("c1", "Cloning into '/root/repo'... done.") },
  { turn: "t1", data: tool("c2", "Read", "README.md") },
  { turn: "t1", data: toolDone("c2", "# Fountain") },
  { turn: "t1", data: chunk(STUDY_REPLY) },
  { turn: "t2", data: tool("c3", "Grep", "apps/fountain/lib/fountain_web/plugs") },
  { turn: "t2", data: toolDone("c3", "tenant_api_auth.ex: def call(conn, _opts)") },
  { turn: "t2", data: chunk(ANSWER_REPLY) },
];

const events = eventData.map((e, i) => ({
  id: i + 1,
  kind: "output",
  stream: "acp",
  data: e.data,
  stage: null,
  state: null,
  turn_id: e.turn,
  ts: now,
}));

const teammate = {
  agent_id: "agent-sage",
  name: "Sage: BinaryBourbon/fountain",
  agent: {
    id: "agent-sage",
    name: "Sage: BinaryBourbon/fountain",
    model: "anthropic/claude-sonnet-5",
    runtime: "claude",
    environment_id: null,
    allowed_vault_ids: null,
    allowed_environment_ids: null,
  },
  conversation: {
    id: "c1",
    title: "Sage: BinaryBourbon/fountain",
    agent_id: "agent-sage",
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
  },
  presence: { state: "online", label: "online" },
  unread: false,
  last_turn: null,
};

const json = (data: unknown) => Response.json({ data });

Bun.serve({
  port: 8788,
  idleTimeout: 120,
  routes: {
    "/api/auth/me": json({ id: "u1", email: "dev@example.com", role: "user" }),
    "/api/catalog": json({ runtimes: ["claude"], models: { claude: ["anthropic/claude-sonnet-5"] } }),
    "/api/team": json([teammate]),
    "/api/team/agent-sage": json(teammate),
    "/api/conversations/c1/turns": json(turns),
    "/api/conversations/c1/events": () => Response.json({ data: events, meta: { has_more: false, next_cursor: null } }),
    "/api/conversations/c1/read": new Response(null, { status: 204 }),
    "/api/team/agent-sage/messages": () => Response.json({ status: "queued", conversation_id: "c1" }),
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
