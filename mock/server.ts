/**
 * A tiny mock Fountain, for developing Arena without a live server: a model
 * catalog, lazy hiring (agents + teammates created on demand), and fake turns
 * that stream chunks over the team SSE so the columns fill in live. Run with
 * `bun run mock`, start the app with `FOUNTAIN_PROXY=http://localhost:8787
 * bun run dev`, and paste any string as the API key with
 * http://localhost:5175 as the URL.
 */

interface MockTurn {
  id: string;
  turn_number: number;
  prompt: string;
  status: string;
  exit_code: number | null;
  started_at: string | null;
  ended_at: string | null;
  inserted_at: string;
  usage: { input: number; output: number } | null;
}

interface MockTeammate {
  agentId: string;
  name: string;
  model: string;
  conversationId: string;
  turns: MockTurn[];
}

const CATALOG = {
  runtimes: ["claude", "codex", "opencode"],
  models: {
    claude: ["anthropic/claude-opus-5", "anthropic/claude-sonnet-5", "anthropic/claude-haiku-4-5"],
    codex: ["openai/gpt-5"],
    opencode: ["google/gemini-2.5-pro"],
  },
  model_providers: ["anthropic", "openai", "google"],
};

const teammates = new Map<string, MockTeammate>();
let seq = 0;
const nextId = () => ++seq;

// ── SSE fan-out ──────────────────────────────────────────────────────────────

const listeners = new Set<ReadableStreamDefaultController<Uint8Array>>();
const enc = new TextEncoder();

function broadcast(event: string, id: number | null, data: unknown): void {
  const frame = `${id !== null ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of listeners) {
    try {
      c.enqueue(enc.encode(frame));
    } catch {
      listeners.delete(c);
    }
  }
}

const eventLog: Array<{ conv: string; event: Record<string, unknown> }> = [];

function emit(tm: MockTeammate, kind: string, over: Record<string, unknown>): void {
  const id = nextId();
  const event = {
    id,
    conversation_id: tm.conversationId,
    agent_id: tm.agentId,
    kind,
    stream: "",
    data: "",
    stage: null,
    state: null,
    turn_id: null,
    ts: new Date().toISOString(),
    ...over,
  };
  eventLog.push({ conv: tm.conversationId, event });
  broadcast(kind, id, event);
}

const chunkLine = (text: string) =>
  JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
  });

function replyFor(model: string, prompt: string): string[] {
  const flavor = model.includes("haiku")
    ? "Short and sharp"
    : model.includes("opus")
      ? "Measured and thorough — here is the full picture"
      : model.includes("gpt")
        ? "Direct take"
        : "Balanced answer";
  return [
    `${flavor}: `,
    `to "${prompt}" I say — `,
    "the mock arena has no real brains, ",
    "but the columns, timings and votes all work. ",
    `(signed, ${model})`,
  ];
}

function runTurn(tm: MockTeammate, prompt: string): void {
  const turn: MockTurn = {
    id: `t-${nextId()}`,
    turn_number: tm.turns.length + 1,
    prompt,
    status: "running",
    exit_code: null,
    started_at: null,
    ended_at: null,
    inserted_at: new Date().toISOString(),
    usage: null,
  };
  tm.turns.push(turn);
  const startDelay = 200 + Math.random() * 600;
  setTimeout(() => {
    turn.started_at = new Date().toISOString();
    emit(tm, "stage", {
      stage: "turn",
      state: "started",
      turn_id: turn.id,
      data: JSON.stringify({ turn_id: turn.id, turn_number: turn.turn_number, mode: "acp" }),
    });
    const chunks = replyFor(tm.model, prompt);
    chunks.forEach((text, i) => {
      setTimeout(() => {
        emit(tm, "output", { stream: "acp", data: chunkLine(text), turn_id: turn.id });
        if (i === chunks.length - 1) {
          setTimeout(() => {
            turn.status = "completed";
            turn.exit_code = 0;
            turn.ended_at = new Date().toISOString();
            turn.usage = { input: 400 + Math.floor(Math.random() * 800), output: 40 + Math.floor(Math.random() * 200) };
            emit(tm, "stage", {
              stage: "turn",
              state: "done",
              turn_id: turn.id,
              data: JSON.stringify({ turn_id: turn.id, turn_number: turn.turn_number, exit_code: 0 }),
            });
          }, 300);
        }
      }, 400 * (i + 1) + Math.random() * 500);
    });
  }, startDelay);
}

// ── HTTP surface ─────────────────────────────────────────────────────────────

const json = (data: unknown, status = 200) => Response.json({ data }, { status });

function teammateJson(tm: MockTeammate) {
  return {
    agent_id: tm.agentId,
    name: tm.name,
    agent: {
      id: tm.agentId,
      name: tm.name,
      model: tm.model,
      runtime: "claude",
      environment_id: null,
      allowed_vault_ids: null,
      allowed_environment_ids: null,
    },
    conversation: {
      id: tm.conversationId,
      title: tm.name,
      agent_id: tm.agentId,
      vault_id: null,
      environment_id: null,
      runtime: "claude",
      acp: true,
      status: "idle",
      turn_count: tm.turns.length,
      last_active_at: null,
      unread: false,
      inserted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    presence: { state: "online", label: "online" },
    unread: false,
    last_turn: null,
  };
}

Bun.serve({
  port: 8787,
  idleTimeout: 120,
  fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === "/api/catalog") return json(CATALOG);
    if (p === "/api/auth/me") return json({ id: "u1", email: "dev@example.com", role: "user" });

    if (p === "/api/agents" && req.method === "POST") {
      return req.json().then((body: { name: string; model: string }) => {
        const agentId = `agent-${nextId()}`;
        teammates.set(agentId, {
          agentId,
          name: body.name,
          model: body.model,
          conversationId: `conv-${nextId()}`,
          turns: [],
        });
        return json({ id: agentId, name: body.name, model: body.model, runtime: "claude" }, 201);
      });
    }

    if (p === "/api/team" && req.method === "GET") return json([...teammates.values()].map(teammateJson));
    if (p === "/api/team" && req.method === "POST") {
      return req.json().then((body: { agent_id: string }) => {
        const tm = teammates.get(body.agent_id);
        if (!tm) return Response.json({ error: "not_found" }, { status: 404 });
        broadcast("team", null, { reason: "changed" });
        return json(teammateJson(tm), 201);
      });
    }

    if (p === "/api/team/stream") {
      let ctrl: ReadableStreamDefaultController<Uint8Array>;
      return new Response(
        new ReadableStream({
          start(c) {
            ctrl = c;
            listeners.add(c);
            c.enqueue(enc.encode(": connected\n\n"));
          },
          cancel() {
            listeners.delete(ctrl);
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }

    let m = p.match(/^\/api\/team\/([^/]+)\/messages$/);
    if (m && req.method === "POST") {
      const tm = teammates.get(m[1]!);
      if (!tm) return Response.json({ error: "not_found" }, { status: 404 });
      const last = tm.turns[tm.turns.length - 1];
      if (last && last.status === "running") return Response.json({ error: "conversation_busy" }, { status: 400 });
      return req.json().then((body: { prompt: string }) => {
        runTurn(tm, body.prompt);
        return Response.json({ status: "queued", conversation_id: tm.conversationId });
      });
    }

    m = p.match(/^\/api\/team\/([^/]+)$/);
    if (m && req.method === "GET") {
      const tm = teammates.get(m[1]!);
      return tm ? json(teammateJson(tm)) : Response.json({ error: "not_found" }, { status: 404 });
    }

    m = p.match(/^\/api\/conversations\/([^/]+)\/turns$/);
    if (m) {
      const tm = [...teammates.values()].find((t) => t.conversationId === m![1]);
      return json(tm?.turns ?? []);
    }

    m = p.match(/^\/api\/conversations\/([^/]+)\/events$/);
    if (m) {
      const events = eventLog.filter((e) => e.conv === m![1]).map((e) => e.event);
      return Response.json({ data: events, meta: { has_more: false, next_cursor: null } });
    }

    m = p.match(/^\/api\/conversations\/([^/]+)\/(read|interrupt)$/);
    if (m && req.method === "POST") return new Response(null, { status: 204 });

    return Response.json({ error: "not_found" }, { status: 404 });
  },
});

console.log("mock Fountain on http://localhost:8787");
