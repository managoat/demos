/**
 * The server against a fake Fountain: sign-in, starting a chat (and the
 * agent it materialises), sharing, and the chat-scoped proxy. The fake's
 * responses are shaped like the real API's — `{data: …}` envelopes except
 * on /api/auth/me — because a fake that wraps what the server does not is
 * how a green suite ships a null.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS, derivedKey } from "../shared/settings";
import { GAMES_NOTE, ROOM_PROMPT, SALON_NOTE, salonServer } from "./agents";
import { buildApp } from "./app";
import type { AppContext } from "./context";
import { Cipher } from "./crypto";
import { Db } from "./db";
import { hub } from "./games";
import { resetMcpCache } from "./mcp";

// ── the fake Fountain ────────────────────────────────────────────────────

interface FakeAgent {
  id: string;
  name: string;
  runtime: string;
  model: string;
  system?: string;
  environment_id?: string | null;
  skills?: unknown[];
  mcp_servers?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

const KEYS: Record<string, { id: string; email: string }> = {
  ftn_host: { id: "u-host", email: "Host@Example.com" },
  ftn_guest: { id: "u-guest", email: "guest@example.com" },
  ftn_other: { id: "u-other", email: "other@example.com" },
  /** The key Fountain mints for one of the host's conversations and hands its computer as $FOUNTAIN_TOKEN. */
  ftn_sprite: { id: "u-host", email: "host@example.com" },
};

/** Accounts the egress broker is on for: connections exist there. Shaped from one real call (server/connectors.test.ts). */
const CONNECTIONS: Record<string, Record<string, unknown>[]> = {
  ftn_host: [
    { id: "c-google", provider: "google", provider_id: null, account_email: "host@example.com", status: "active", scopes: [], env_key: "GOOGLE_ACCESS_TOKEN" },
    { id: "c-linear", provider: "mcp-linear-app", provider_id: "p-linear", account_email: "mcp-linear-app", status: "active", scopes: [], env_key: "MCP_LINEAR_APP_ACCESS_TOKEN" },
    { id: "c-slack", provider: "slack", provider_id: null, account_email: "hosty", status: "active", scopes: [], env_key: "SLACK_ACCESS_TOKEN" },
  ],
};
const PROVIDERS = [
  { id: "google", slug: "google", name: "Google (Gmail, Calendar)", kind: "oauth2", platform: true, mcp_url: null },
  { id: "slack", slug: "slack", name: "Slack", kind: "oauth2", platform: true, mcp_url: null },
  { id: "p-linear", slug: "mcp-linear-app", name: "mcp-linear-app", kind: "mcp", platform: false, mcp_url: "https://mcp.linear.app/mcp" },
];
const OLD_KEY = derivedKey({ ...DEFAULT_SETTINGS });

const state = {
  agents: new Map<string, FakeAgent[]>(),
  conversations: new Map<string, Record<string, unknown>[]>(),
  prompts: [] as { key: string; id: string; body: unknown }[],
  agentPosts: [] as { key: string; body: Record<string, unknown> }[],
  agentPatches: [] as { key: string; id: string; body: Record<string, unknown> }[],
  terminated: [] as string[],
};

function reset(): void {
  state.agents.clear();
  state.conversations.clear();
  state.prompts = [];
  state.agentPosts = [];
  state.agentPatches = [];
  state.terminated = [];
  state.agents.set("ftn_host", [
    { id: "a-coder", name: "Coder", runtime: "claude", model: "anthropic/claude-sonnet-5", system: "You write code.", environment_id: "e-1", skills: [{ name: "x", content: "SKILL" }], mcp_servers: { gh: { headers: { authorization: "Bearer secret" } } } },
    { id: "a-old", name: "Salon · leftover", runtime: "claude", model: "anthropic/claude-opus-5", metadata: { salon: { key: OLD_KEY } } },
  ]);
}

let fake: ReturnType<typeof Bun.serve>;
let fakeUrl: string;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeAll(() => {
  fake = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const key = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      const who = KEYS[key];
      if (!who) return json({ error: "unauthorized", message: "bad key" }, 401);
      const p = url.pathname;
      if (p === "/api/auth/me") return json(who);
      if (p === "/api/catalog")
        return json({
          data: {
            runtimes: ["claude", "codex", "gemini", "opencode"],
            models: { claude: ["anthropic/claude-opus-5", "anthropic/claude-sonnet-5"], codex: ["openai/gpt-5.5"], gemini: ["google/gemini-3.7-flash"], opencode: ["anthropic/claude-opus-5", "openai/gpt-5.5"] },
            mcp_servers: [{ name: "Linear", url: "https://mcp.linear.app/mcp", slug: "linear", dcr: true, verified_on: "2026-09-01" }],
          },
        });
      // Connections exist only for a brokered account; elsewhere the routes are a 404 with this code.
      if (p === "/api/connections" || p === "/api/connection-providers") {
        if (!CONNECTIONS[key]) return json({ error: "connections_not_enabled" }, 404);
        return json({ data: p === "/api/connections" ? CONNECTIONS[key] : PROVIDERS });
      }
      if (p === "/api/agents" && req.method === "GET") return json({ data: state.agents.get(key) ?? [] });
      if (p === "/api/agents" && req.method === "POST") {
        const body = (await req.json()) as Record<string, unknown>;
        state.agentPosts.push({ key, body });
        const made = { id: `a-${state.agentPosts.length}`, ...body } as unknown as FakeAgent;
        state.agents.set(key, [...(state.agents.get(key) ?? []), made]);
        return json({ data: made }, 201);
      }
      const am = /^\/api\/agents\/([^/]+)$/.exec(p);
      if (am && req.method === "PATCH") {
        const body = (await req.json()) as Record<string, unknown>;
        const list = state.agents.get(key) ?? [];
        const cur = list.find((a) => a.id === am[1]);
        if (!cur) return json({ error: "not_found" }, 404);
        state.agentPatches.push({ key, id: cur.id, body });
        const next = { ...cur, ...body } as FakeAgent;
        state.agents.set(key, list.map((a) => (a.id === cur.id ? next : a)));
        return json({ data: next });
      }
      if (p === "/api/conversations" && req.method === "POST") {
        const body = (await req.json()) as Record<string, unknown>;
        if (body.agent_id === "a-broke") return json({ error: "insufficient_credits", message: "no credit", upgrade_url: "x" }, 402);
        const conv = { id: `c-${crypto.randomUUID().slice(0, 8)}`, status: "pending", agent_id: body.agent_id, channel_id: body.channel_id, turn_count: 1, first_prompt: body.prompt, title: null, last_active_at: null, request: body };
        state.conversations.set(key, [...(state.conversations.get(key) ?? []), conv]);
        return json({ data: conv }, 201);
      }
      if (p === "/api/conversations" && req.method === "GET") return json({ data: state.conversations.get(key) ?? [] });
      const m = /^\/api\/conversations\/([^/]+)(\/.*)?$/.exec(p);
      if (m) {
        const conv = (state.conversations.get(key) ?? []).find((c) => c.id === m[1]);
        if (!conv) return json({ error: "not_found" }, 404);
        const sub = m[2] ?? "";
        if (sub === "" && req.method === "GET") return json({ data: conv });
        if (sub === "/turns") return json({ data: [{ id: "t1", turn_number: 1, prompt: String((conv.request as { prompt?: string }).prompt ?? ""), status: "completed" }] });
        if (sub === "/events") return json({ data: [], meta: { limit: 1000, has_more: false, next_cursor: null } });
        if (sub === "/prompts" && req.method === "POST") {
          state.prompts.push({ key, id: conv.id as string, body: await req.json() });
          return json({ status: "queued" }, 202);
        }
        if (sub === "/terminate" && req.method === "POST") {
          state.terminated.push(conv.id as string);
          return json({ data: { ...conv, status: "terminated" } });
        }
        return json({ error: "not_found" }, 404);
      }
      return json({ error: "not_found", message: p }, 404);
    },
  });
  fakeUrl = `http://localhost:${fake.port}`;
});

afterAll(() => fake.stop(true));

// ── the app under test ───────────────────────────────────────────────────

let app: (req: Request) => Promise<Response>;
let ctx: AppContext;

beforeEach(async () => {
  reset();
  resetMcpCache();
  ctx = {
    db: new Db(":memory:"),
    cipher: await Cipher.from("a-test-secret-that-is-long-enough"),
    config: { fountainUrl: fakeUrl, dataDir: ".", dbPath: ":memory:", secret: "x", port: 0, staticDir: null, publicUrl: null, sessionMaxAgeMs: 60_000 },
  };
  app = buildApp(ctx);
});

/** The same server, reachable from a chat's computer — what production is. */
function withPublicUrl(url = "https://salon.test"): void {
  ctx.config.publicUrl = url;
  app = buildApp(ctx);
}

async function call(method: string, path: string, opts: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.cookie) headers.cookie = opts.cookie;
  return app(new Request(`http://salon.test${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }));
}

async function signIn(key: string): Promise<string> {
  const res = await call("POST", "/api/session", { body: { apiKey: key } });
  expect(res.status).toBe(200);
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  return cookie;
}

const SETTINGS = { model: "anthropic/claude-opus-5", skills: [], connectorIds: [] };

async function startChat(cookie: string, settings: Record<string, unknown> = SETTINGS, prompt = "hello room"): Promise<Record<string, any>> {
  const res = await call("POST", "/api/chats", { cookie, body: { prompt, settings } });
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: Record<string, any> }).data;
}

describe("sign-in", () => {
  test("a bad key is 401, a good one is a cookie and a lowercased email", async () => {
    expect((await call("POST", "/api/session", { body: { apiKey: "ftn_nope" } })).status).toBe(401);
    const cookie = await signIn("ftn_host");
    const me = (await (await call("GET", "/api/me", { cookie })).json()) as { email: string };
    expect(me.email).toBe("host@example.com");
    expect((await call("GET", "/api/me")).status).toBe(401);
  });
});

describe("menu", () => {
  test("a brokered host sees every provider's models and their connections, never their agents", async () => {
    const cookie = await signIn("ftn_host");
    const res = await call("GET", "/api/me/menu", { cookie });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, any> };
    expect(data.models).toEqual(["anthropic/claude-opus-5", "anthropic/claude-sonnet-5", "openai/gpt-5.5", "google/gemini-3.7-flash"]);
    expect(data.connectors.enabled).toBe(true);
    expect(data.connectors.connectUrl).toBe(`${fakeUrl}/account/connections`);
    expect(data.connectors.items).toEqual([
      { id: "c-google", label: "Gmail", account: "host@example.com", usable: true, why: null },
      { id: "c-linear", label: "Linear", account: null, usable: true, why: null },
      { id: "c-slack", label: "Slack", account: "hosty", usable: false, why: "Not usable in a Salon chat yet" },
    ]);
    expect(data).not.toHaveProperty("agents");
    expect(JSON.stringify(data)).not.toContain("secret");
  });
  test("an account without the broker gets an empty, disabled connectors list", async () => {
    const cookie = await signIn("ftn_guest");
    const { data } = (await (await call("GET", "/api/me/menu", { cookie })).json()) as { data: Record<string, any> };
    expect(data.connectors).toMatchObject({ enabled: false, items: [] });
    expect(data.models.length).toBeGreaterThan(0);
  });
});

describe("starting a chat", () => {
  test("the default pick reuses the derived agent that already exists", async () => {
    const cookie = await signIn("ftn_host");
    const chat = await startChat(cookie);
    expect(state.agentPosts).toHaveLength(0);
    expect(chat.agentId).toBe("a-old");
    expect(chat.role).toBe("owner");
    expect(chat.settings).toEqual({ model: "anthropic/claude-opus-5", skills: [], connectors: [] });
    const conv = state.conversations.get("ftn_host")![0]!;
    expect(conv.request).toMatchObject({ agent_id: "a-old", prompt: "hello room", channel_id: `salon:${chat.id}`, fresh: true });
    expect((conv.request as Record<string, unknown>).environment_id).toBeUndefined();
  });

  test("a new model derives a plain room agent on the runtime the provider implies, and finds it again", async () => {
    const cookie = await signIn("ftn_host");
    const chat = await startChat(cookie, { ...SETTINGS, model: "openai/gpt-5.5" });
    expect(state.agentPosts).toHaveLength(1);
    const made = state.agentPosts[0]!.body;
    expect(made).toEqual({
      name: "Salon · GPT-5.5",
      runtime: "codex",
      model: "openai/gpt-5.5",
      system: `${ROOM_PROMPT}\n\n${SALON_NOTE}`,
      metadata: { salon: { key: derivedKey({ ...DEFAULT_SETTINGS, model: "openai/gpt-5.5" }), tuple: { runtime: "codex", model: "openai/gpt-5.5", skills: [], connectors: [], preset: null, environment: null, vault: null } } },
    });
    expect(made).not.toHaveProperty("environment_id");
    expect(chat.agentId).toBe("a-1");
    // The same pick again finds it rather than making another.
    await startChat(cookie, { ...SETTINGS, model: "openai/gpt-5.5" });
    expect(state.agentPosts).toHaveLength(1);
  });

  test("skills and connectors go on the agent — skills.sh installs and mcp_servers on the connection — and into its name and key", async () => {
    const cookie = await signIn("ftn_host");
    const chat = await startChat(cookie, { ...SETTINGS, skills: ["xlsx", "pdf"], connectorIds: ["c-linear", "c-google"] });
    expect(state.agentPosts).toHaveLength(1);
    const made = state.agentPosts[0]!.body;
    expect(made.name).toBe("Salon · Opus 5 · gmail, linear, pdf, xlsx");
    expect(made.runtime).toBe("claude");
    expect(made.skills).toEqual([
      { source: "anthropics/skills", name: "pdf", ref: "53048666b05b4799081517d00e09e0a2dd688678" },
      { source: "anthropics/skills", name: "xlsx", ref: "53048666b05b4799081517d00e09e0a2dd688678" },
    ]);
    expect(made.mcp_servers).toEqual({
      gmail: { connection: "c-google" },
      linear: { type: "http", url: "https://mcp.linear.app/mcp", connection: "c-linear" },
    });
    const key = derivedKey({ ...DEFAULT_SETTINGS, skills: ["pdf", "xlsx"], connectorIds: ["c-google", "c-linear"] });
    expect((made.metadata as { salon: { key: string } }).salon.key).toBe(key);
    expect(chat.settings).toEqual({
      model: "anthropic/claude-opus-5",
      skills: ["pdf", "xlsx"],
      connectors: [
        { id: "c-google", label: "Gmail" },
        { id: "c-linear", label: "Linear" },
      ],
    });
    // The same choices in another order are the same agent.
    await startChat(cookie, { ...SETTINGS, skills: ["pdf", "xlsx"], connectorIds: ["c-google", "c-linear"] });
    expect(state.agentPosts).toHaveLength(1);
    // One skill fewer is another agent.
    await startChat(cookie, { ...SETTINGS, skills: ["pdf"], connectorIds: ["c-google", "c-linear"] });
    expect(state.agentPosts).toHaveLength(2);
  });

  test("bad settings, a stale or unusable connector and an empty prompt are refused before Fountain is asked", async () => {
    const cookie = await signIn("ftn_host");
    expect((await call("POST", "/api/chats", { cookie, body: { prompt: "x", settings: { model: "mistral/large" } } })).status).toBe(422);
    expect((await call("POST", "/api/chats", { cookie, body: { prompt: "x", settings: { ...SETTINGS, skills: ["cooking"] } } })).status).toBe(422);
    expect((await call("POST", "/api/chats", { cookie, body: { prompt: "", settings: SETTINGS } })).status).toBe(422);
    const gone = await call("POST", "/api/chats", { cookie, body: { prompt: "x", settings: { ...SETTINGS, connectorIds: ["c-nope"] } } });
    expect(gone.status).toBe(404);
    expect(((await gone.json()) as { error: string }).error).toBe("connector_not_found");
    const slack = await call("POST", "/api/chats", { cookie, body: { prompt: "x", settings: { ...SETTINGS, connectorIds: ["c-slack"] } } });
    expect(slack.status).toBe(422);
    expect(((await slack.json()) as { error: string }).error).toBe("connector_unusable");
    // A guest's account has no connections at all.
    const guest = await signIn("ftn_guest");
    expect((await call("POST", "/api/chats", { cookie: guest, body: { prompt: "x", settings: { ...SETTINGS, connectorIds: ["c-google"] } } })).status).toBe(404);
    expect(state.conversations.size).toBe(0);
    expect(state.agentPosts).toHaveLength(0);
  });

  test("Fountain's refusal comes through with its status and code", async () => {
    const cookie = await signIn("ftn_host");
    state.agents.set("ftn_host", [{ id: "a-broke", name: "Broke", runtime: "claude", model: "anthropic/claude-opus-5", metadata: { salon: { key: OLD_KEY } } }]);
    const res = await call("POST", "/api/chats", { cookie, body: { prompt: "x", settings: SETTINGS } });
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: string }).error).toBe("insufficient_credits");
  });
});

describe("sharing", () => {
  test("a guest sees the chat, reads it through the proxy, and sends a tagged turn; a stranger sees nothing", async () => {
    const host = await signIn("ftn_host");
    const guest = await signIn("ftn_guest");
    const other = await signIn("ftn_other");
    const chat = await startChat(host);

    // Not yet a member.
    expect((await call("GET", `/api/chats/${chat.id}`, { cookie: guest })).status).toBe(404);
    expect((await call("GET", `/f/${chat.id}/api/conversations/${chat.conversationId}`, { cookie: guest })).status).toBe(404);

    // The guest cannot add themselves; the host can.
    expect((await call("POST", `/api/chats/${chat.id}/members`, { cookie: guest, body: { email: "guest@example.com" } })).status).toBe(404);
    const added = await call("POST", `/api/chats/${chat.id}/members`, { cookie: host, body: { email: "guest@example.com" } });
    expect(added.status).toBe(200);

    const list = (await (await call("GET", "/api/chats", { cookie: guest })).json()) as { data: { id: string; role: string; ownerEmail: string; status: string }[] };
    expect(list.data).toHaveLength(1);
    expect(list.data[0]).toMatchObject({ id: chat.id, role: "member", ownerEmail: "host@example.com", status: "pending" });
    expect(list.data[0]).not.toHaveProperty("inviteToken");

    // The proxy answers for the chat's conversation on the host's key…
    const rec = await call("GET", `/f/${chat.id}/api/conversations/${chat.conversationId}`, { cookie: guest });
    expect(rec.status).toBe(200);
    expect(((await rec.json()) as { data: { id: string } }).data.id).toBe(chat.conversationId);
    // …and for nothing else.
    expect((await call("GET", `/f/${chat.id}/api/conversations/c-nope`, { cookie: guest })).status).toBe(404);
    expect((await call("GET", `/f/${chat.id}/api/agents`, { cookie: guest })).status).toBe(404);
    expect((await call("POST", `/f/${chat.id}/api/conversations/${chat.conversationId}/terminate`, { cookie: guest })).status).toBe(404);
    expect((await call("GET", `/f/${chat.id}/api/conversations/${chat.conversationId}`, { cookie: other })).status).toBe(404);

    // A turn from the guest goes in tagged, on the host's key, and is recorded.
    const sent = await call("POST", `/f/${chat.id}/api/conversations/${chat.conversationId}/prompts`, { cookie: guest, body: { prompt: "and me" } });
    expect(sent.status).toBe(202);
    expect(state.prompts).toHaveLength(1);
    expect(state.prompts[0]).toMatchObject({ key: "ftn_host", body: { prompt: "[from guest@example.com] and me" } });
    const shown = (await (await call("GET", `/api/chats/${chat.id}`, { cookie: guest })).json()) as { data: { sends: { seq: number; email: string }[] } };
    expect(shown.data.sends.map((s) => [s.seq, s.email])).toEqual([
      [1, "host@example.com"],
      [2, "guest@example.com"],
    ]);

    // The host alone is untagged.
    const solo = await startChat(host);
    await call("POST", `/f/${solo.id}/api/conversations/${solo.conversationId}/prompts`, { cookie: host, body: { prompt: "just me" } });
    expect(state.prompts[1]!.body).toEqual({ prompt: "just me" });

    // Leaving.
    const left = await call("DELETE", `/api/chats/${chat.id}/members/guest%40example.com`, { cookie: guest });
    expect(((await left.json()) as { left?: boolean }).left).toBe(true);
    expect((await call("GET", `/api/chats/${chat.id}`, { cookie: guest })).status).toBe(404);
  });

  test("a join link admits whoever opens it, and the host can retire the chat", async () => {
    const host = await signIn("ftn_host");
    const other = await signIn("ftn_other");
    const chat = await startChat(host);
    expect((await call("POST", `/api/chats/${chat.id}/invite`, { cookie: other })).status).toBe(404);
    const { data } = (await (await call("POST", `/api/chats/${chat.id}/invite`, { cookie: host })).json()) as { data: { token: string } };
    expect((await call("POST", `/api/join/nope`, { cookie: other })).status).toBe(404);
    const joined = await call("POST", `/api/join/${data.token}`, { cookie: other });
    expect(joined.status).toBe(200);
    expect(((await joined.json()) as { data: { role: string } }).data.role).toBe("member");
    const mine = (await (await call("GET", `/api/chats/${chat.id}`, { cookie: host })).json()) as { data: { chat: { members: { email: string }[]; inviteToken: string } } };
    expect(mine.data.chat.members.map((m) => m.email)).toEqual(["other@example.com"]);
    expect(mine.data.chat.inviteToken).toBe(data.token);

    expect((await call("DELETE", `/api/chats/${chat.id}`, { cookie: other })).status).toBe(403);
    expect((await call("DELETE", `/api/chats/${chat.id}`, { cookie: host })).status).toBe(200);
    expect(state.terminated).toEqual([chat.conversationId]);
    expect((await call("GET", `/api/chats/${chat.id}`, { cookie: other })).status).toBe(404);
  });
});

// ── games ────────────────────────────────────────────────────────────────

describe("games on the agent", () => {
  const SALON = salonServer("https://salon.test");

  test("with a public address, a claude agent gets Salon as an MCP server on the conversation's own key, and the note", async () => {
    withPublicUrl();
    const cookie = await signIn("ftn_host");
    await startChat(cookie, { ...SETTINGS, model: "anthropic/claude-sonnet-5" });
    expect(state.agentPosts).toHaveLength(1);
    const made = state.agentPosts[0]!.body;
    expect(made.mcp_servers).toEqual({ salon: SALON });
    expect(made.system).toBe(`${ROOM_PROMPT}\n\n${SALON_NOTE}\n\n${GAMES_NOTE}`);
    // The header refs are escaped for Fountain, so the runtime — not Fountain — expands them.
    expect(SALON).toEqual({
      type: "http",
      url: "https://salon.test/mcp",
      headers: { Authorization: "Bearer $${FOUNTAIN_TOKEN}", "X-Fountain-Conversation-Id": "$${FOUNTAIN_CONVERSATION_ID}" },
    });
    // The key is unchanged by it: the same pick finds the agent.
    await startChat(cookie, { ...SETTINGS, model: "anthropic/claude-sonnet-5" });
    expect(state.agentPosts).toHaveLength(1);
  });

  test("an agent from before games is given the server in place rather than replaced", async () => {
    withPublicUrl();
    const cookie = await signIn("ftn_host");
    const chat = await startChat(cookie);
    expect(chat.agentId).toBe("a-old");
    expect(state.agentPosts).toHaveLength(0);
    expect(state.agentPatches).toHaveLength(1);
    expect(state.agentPatches[0]).toMatchObject({ id: "a-old", body: { mcp_servers: { salon: SALON } } });
    expect((state.agentPatches[0]!.body.system as string).endsWith(GAMES_NOTE)).toBe(true);
    // Once — unless this server has moved.
    await startChat(cookie);
    expect(state.agentPatches).toHaveLength(1);
    withPublicUrl("https://salon.example");
    await startChat(cookie);
    expect(state.agentPatches).toHaveLength(2);
    expect(state.agentPatches[1]!.body.mcp_servers).toEqual({ salon: salonServer("https://salon.example") });
  });

  test("another runtime, or no public address, gets no server and no note", async () => {
    withPublicUrl();
    const cookie = await signIn("ftn_host");
    await startChat(cookie, { ...SETTINGS, model: "openai/gpt-5.5" });
    expect(state.agentPosts[0]!.body.mcp_servers).toBeUndefined();
    expect(state.agentPosts[0]!.body.system).toBe(`${ROOM_PROMPT}\n\n${SALON_NOTE}`);
    ctx.config.publicUrl = null;
    await startChat(cookie, { ...SETTINGS, model: "anthropic/claude-sonnet-5" });
    expect(state.agentPosts[1]!.body.mcp_servers).toBeUndefined();
    expect(state.agentPatches).toHaveLength(0);
  });
});

describe("playing", () => {
  async function room(): Promise<{ host: string; guest: string; other: string; chat: Record<string, any> }> {
    const host = await signIn("ftn_host");
    const guest = await signIn("ftn_guest");
    const other = await signIn("ftn_other");
    const chat = await startChat(host);
    await call("POST", `/api/chats/${chat.id}/members`, { cookie: host, body: { email: "guest@example.com" } });
    return { host, guest, other, chat };
  }

  test("two people in the chat play; the server keeps the rules and everyone else watches", async () => {
    const { host, guest, other, chat } = await room();
    // Only people in the chat, and two different ones.
    expect((await call("POST", `/api/chats/${chat.id}/games`, { cookie: host, body: { kind: "tictactoe", players: ["host@example.com", "other@example.com"] } })).status).toBe(422);
    expect((await call("POST", `/api/chats/${chat.id}/games`, { cookie: host, body: { kind: "tictactoe", players: ["host@example.com", "host@example.com"] } })).status).toBe(422);
    expect((await call("POST", `/api/chats/${chat.id}/games`, { cookie: host, body: { kind: "chess", players: ["host@example.com", "guest@example.com"] } })).status).toBe(422);
    expect((await call("POST", `/api/chats/${chat.id}/games`, { cookie: other, body: { kind: "tictactoe", players: ["host@example.com", "guest@example.com"] } })).status).toBe(404);

    // The guest can start one, and put the host first.
    const started = await call("POST", `/api/chats/${chat.id}/games`, { cookie: guest, body: { kind: "tictactoe", players: ["Host@Example.com", "guest@example.com"] } });
    expect(started.status).toBe(201);
    const game = ((await started.json()) as { data: Record<string, any> }).data;
    expect(game).toMatchObject({ chatId: chat.id, kind: "tictactoe", players: ["host@example.com", "guest@example.com"], status: "playing", winnerEmail: null, seq: 1, createdBy: "guest@example.com" });
    expect(game.state).toEqual({ board: [null, null, null, null, null, null, null, null, null], next: "X", winner: null, line: null });

    const moves = `/api/chats/${chat.id}/games/${game.id}/moves`;
    // Not the guest's move, not a square, not a stranger.
    expect((await call("POST", moves, { cookie: guest, body: { cell: 4 } })).status).toBe(409);
    expect((await call("POST", moves, { cookie: host, body: { cell: 9 } })).status).toBe(409);
    expect((await call("POST", moves, { cookie: other, body: { cell: 4 } })).status).toBe(404);

    // X takes the centre; O may not take it too.
    const first = await call("POST", moves, { cookie: host, body: { cell: 4 } });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { data: Record<string, any> }).data).toMatchObject({ seq: 2, state: { next: "O" } });
    expect((await call("POST", moves, { cookie: guest, body: { cell: 4 } })).status).toBe(409);

    // X wins down the middle column.
    for (const [cookie, cell] of [
      [guest, 0],
      [host, 1],
      [guest, 2],
    ] as const) {
      expect((await call("POST", moves, { cookie, body: { cell } })).status).toBe(200);
    }
    const won = await call("POST", moves, { cookie: host, body: { cell: 7 } });
    const final = ((await won.json()) as { data: Record<string, any> }).data;
    expect(final).toMatchObject({ status: "done", winnerEmail: "host@example.com", seq: 6, state: { winner: "X", line: [1, 4, 7] } });
    expect((await call("POST", moves, { cookie: guest, body: { cell: 8 } })).status).toBe(409);

    // Everyone in the chat reads it; a stranger does not.
    const list = (await (await call("GET", `/api/chats/${chat.id}/games`, { cookie: guest })).json()) as { data: { id: string }[] };
    expect(list.data.map((g) => g.id)).toEqual([game.id]);
    expect((await call("GET", `/api/chats/${chat.id}/games/${game.id}`, { cookie: host })).status).toBe(200);
    expect((await call("GET", `/api/chats/${chat.id}/games`, { cookie: other })).status).toBe(404);
  });

  test("the game stream carries every change to whoever is in the chat", async () => {
    const { host, guest, other, chat } = await room();
    expect((await call("GET", `/api/chats/${chat.id}/games/stream`, { cookie: other })).status).toBe(404);
    const ctrl = new AbortController();
    const res = await app(new Request(`http://salon.test/api/chats/${chat.id}/games/stream`, { headers: { cookie: guest }, signal: ctrl.signal }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(hub.listening(chat.id)).toBe(1);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let got = "";
    const until = async (needle: string) => {
      while (!got.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) break;
        got += decoder.decode(value);
      }
    };
    await until(": hello");
    const started = ((await (await call("POST", `/api/chats/${chat.id}/games`, { cookie: host, body: { kind: "tictactoe", players: ["host@example.com", "guest@example.com"] } })).json()) as { data: { id: string } }).data;
    await until("event: game");
    await call("POST", `/api/chats/${chat.id}/games/${started.id}/moves`, { cookie: host, body: { cell: 0 } });
    await until('"seq":2');
    const events = got.split("\n\n").filter((e) => e.startsWith("event: game")).map((e) => JSON.parse(e.split("\ndata: ")[1]!) as { id: string; seq: number });
    expect(events.map((e) => [e.id, e.seq])).toEqual([
      [started.id, 1],
      [started.id, 2],
    ]);
    ctrl.abort();
    await new Promise((r) => setTimeout(r, 10));
    expect(hub.listening(chat.id)).toBe(0);
  });
});

describe("the MCP server", () => {
  async function rpc(body: unknown, headers: Record<string, string>): Promise<Response> {
    return app(new Request("http://salon.test/mcp", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
  }
  function forChat(conversationId: string, key = "ftn_sprite"): Record<string, string> {
    return { authorization: `Bearer ${key}`, "x-fountain-conversation-id": conversationId };
  }
  async function toolCall(conversationId: string, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, forChat(conversationId));
    expect(res.status).toBe(200);
    const r = ((await res.json()) as { result: { content: { text: string }[]; isError: boolean } }).result;
    return { text: r.content[0]!.text, isError: r.isError };
  }

  test("the conversation's key and id name the chat; anything else is refused before a tool runs", async () => {
    const host = await signIn("ftn_host");
    const chat = await startChat(host);
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
    expect((await rpc(init, {})).status).toBe(401);
    expect((await rpc(init, { authorization: "Bearer ftn_sprite" })).status).toBe(400);
    expect((await rpc(init, forChat(chat.conversationId, "ftn_nope"))).status).toBe(401);
    // A key of someone who does not host the chat — a guest's own key, say — finds no chat.
    expect((await rpc(init, forChat(chat.conversationId, "ftn_guest"))).status).toBe(404);
    expect((await rpc(init, forChat("c-nope"))).status).toBe(404);
    expect((await app(new Request("http://salon.test/mcp", { headers: forChat(chat.conversationId) }))).status).toBe(405);

    const ok = await rpc(init, forChat(chat.conversationId));
    expect(ok.status).toBe(200);
    // As the runtime sends them today: the session copy of the config leaves a `$` in front of each expanded value.
    const stray = await rpc(init, { authorization: "Bearer $ftn_sprite", "x-fountain-conversation-id": `$${chat.conversationId}` });
    expect(stray.status).toBe(200);
    expect(((await ok.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe("salon");
    const tools = ((await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, forChat(chat.conversationId))).json()) as { result: { tools: { name: string }[] } }).result.tools;
    expect(tools.map((t) => t.name)).toEqual(["start_game", "game_state"]);
    expect((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, forChat(chat.conversationId))).status).toBe(202);
  });

  test("start_game takes names as people say them, refuses what is not in the room, and puts the board on the stream", async () => {
    const host = await signIn("ftn_host");
    const chat = await startChat(host);
    await call("POST", `/api/chats/${chat.id}/members`, { cookie: host, body: { email: "guest@example.com" } });
    const conv = chat.conversationId as string;

    let r = await toolCall(conv, "start_game", { game: "chess", players: ["host", "guest"] });
    expect(r).toMatchObject({ isError: true });
    expect(r.text).toContain("Tic-tac-toe");
    r = await toolCall(conv, "start_game", { game: "tictactoe", players: ["host", "bob"] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("host@example.com, guest@example.com");
    r = await toolCall(conv, "start_game", { game: "tictactoe", players: ["host"] });
    expect(r.isError).toBe(true);
    r = await toolCall(conv, "start_game", { game: "tictactoe", players: ["st", "host"] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("could be");

    const seen: unknown[] = [];
    const off = hub.subscribe(chat.id, (g) => seen.push(g));
    r = await toolCall(conv, "start_game", { game: "tictactoe", players: ["Guest", "host@example.com"] });
    off();
    expect(r.isError).toBe(false);
    const out = JSON.parse(r.text) as { started: boolean; game: Record<string, any>; hint: string };
    expect(out.started).toBe(true);
    expect(out.game).toMatchObject({ chatId: chat.id, players: ["guest@example.com", "host@example.com"], createdBy: "host@example.com" });
    expect(out.hint).toContain("guest@example.com moves first");
    expect(seen).toHaveLength(1);

    // The game is the chat's: the browser routes show it, and game_state reads it.
    const list = (await (await call("GET", `/api/chats/${chat.id}/games`, { cookie: host })).json()) as { data: { id: string }[] };
    expect(list.data.map((g) => g.id)).toEqual([out.game.id]);
    await call("POST", `/api/chats/${chat.id}/games/${out.game.id}/moves`, { cookie: await signIn("ftn_guest"), body: { cell: 4 } });
    const s = JSON.parse((await toolCall(conv, "game_state", {})).text) as { summary: string; board: string[] };
    expect(s.summary).toContain("host@example.com to move");
    expect(s.board).toEqual([". . .", ". X .", ". . ."]);
    expect((await toolCall(conv, "game_state", { game_id: "nope" })).isError).toBe(true);
    expect((await toolCall(conv, "nothing", {})).isError).toBe(true);
  });

  test("a chat with no games says so", async () => {
    const host = await signIn("ftn_host");
    const chat = await startChat(host);
    const r = await toolCall(chat.conversationId as string, "game_state", {});
    expect(r.isError).toBe(true);
    expect(r.text).toContain("No game");
  });
});
