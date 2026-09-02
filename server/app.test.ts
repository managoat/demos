/**
 * The server against a fake Fountain: sign-in, starting a chat (and the
 * agent it materialises), sharing, and the chat-scoped proxy. The fake's
 * responses are shaped like the real API's — `{data: …}` envelopes except
 * on /api/auth/me — because a fake that wraps what the server does not is
 * how a green suite ships a null.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { DEFAULT_SETTINGS, derivedKey } from "../shared/settings";
import { GAMES_NOTE, ROOM_PROMPT, SALON_NOTE, salonServer } from "./agents";
import { buildApp } from "./app";
import type { AppContext } from "./context";
import { Cipher } from "./crypto";
import { Db } from "./db";
import { hub } from "./hub";
import { hookSetupScript, resetSandboxCache } from "./sandbox";

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
const GITHUB_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();

/** One machine's disk as the read-only sandbox routes see it: absolute path → bytes ("base64:…" for what is not text), and what `git diff` would print. */
interface FakeSandbox {
  key: string;
  status: string;
  disk: Record<string, string>;
  /** `${ref}|${staged}` → the diff. */
  diffs: Record<string, string>;
  /** Refs git knows; any other `ref` is `ref_not_found`. */
  refs: string[];
}

const state = {
  sandboxes: new Map<string, FakeSandbox>(),
  /** What the sandbox routes were asked, in order: "diff ?path=…". */
  sandboxReads: [] as string[],
  /** A Fountain from before the routes existed answers them like any unknown path. */
  sandboxRoutes: true,
  environments: [] as { key: string; id: string; body: Record<string, unknown> }[],
  secrets: [] as { key: string; env: string; body: Record<string, unknown> }[],
  deletedEnvironments: [] as string[],
  environmentPuts: [] as string[],
  agents: new Map<string, FakeAgent[]>(),
  conversations: new Map<string, Record<string, unknown>[]>(),
  prompts: [] as { key: string; id: string; body: unknown }[],
  agentPosts: [] as { key: string; body: Record<string, unknown> }[],
  agentPatches: [] as { key: string; id: string; body: Record<string, unknown> }[],
  terminated: [] as string[],
  githubTokenBodies: [] as Record<string, unknown>[],
};

function reset(): void {
  state.sandboxes.clear();
  state.sandboxReads = [];
  state.sandboxRoutes = true;
  state.environments = [];
  state.secrets = [];
  state.deletedEnvironments = [];
  state.environmentPuts = [];
  state.agents.clear();
  state.conversations.clear();
  state.prompts = [];
  state.agentPosts = [];
  state.agentPatches = [];
  state.terminated = [];
  state.githubTokenBodies = [];
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
      const p = url.pathname;
      // The same local server stands in for GitHub when a test enables the
      // optional App. These are checked before Fountain's bearer boundary.
      if (p === "/login/oauth/access_token") return json({ access_token: "ghu_host", expires_in: 28_800, refresh_token: "ghr_host", refresh_token_expires_in: 15_897_600 });
      if (p === "/user" && key === "ghu_host") return json({ login: "octohost" });
      if (p === "/user/installations" && key === "ghu_host") return json({ installations: [{ id: 77 }] });
      if (p === "/user/installations/77/repositories" && key === "ghu_host")
        return json({ repositories: [{ full_name: "acme/widgets", private: true, archived: false, default_branch: "trunk", pushed_at: "2026-09-01T00:00:00Z", description: "Widgets", permissions: { push: true } }] });
      if (p === "/repos/acme/widgets/installation" && key.split(".").length === 3) return json({ id: 77 });
      if (p === "/app/installations/77/access_tokens" && key.split(".").length === 3) {
        state.githubTokenBodies.push((await req.json()) as Record<string, unknown>);
        return json({ token: "ghs_widgets", expires_at: "2026-09-02T20:00:00Z" }, 201);
      }
      const who = KEYS[key];
      if (!who) return json({ error: "unauthorized", message: "bad key" }, 401);
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
      // Environments, shaped from the docs' tour and one real create (2026-09-02): `{data: {id, name, repositories, packages, setup_script}}`.
      if (p === "/api/environments" && req.method === "POST") {
        const body = (await req.json()) as Record<string, unknown>;
        if (body.name === "Salon · broken") return json({ errors: { repositories: ["is invalid"] } }, 422);
        const id = `e-${state.environments.length + 1}`;
        state.environments.push({ key, id, body });
        return json({ data: { id, ...body } }, 201);
      }
      const em = /^\/api\/environments\/([^/]+)(\/secrets)?$/.exec(p);
      if (em && em[2] && req.method === "POST") {
        const body = (await req.json()) as Record<string, unknown>;
        if (!state.environments.some((e) => e.id === em[1] && e.key === key)) return json({ error: "not_found" }, 404);
        state.secrets.push({ key, env: em[1]!, body });
        return json({ data: { id: `s-${state.secrets.length}`, key: body.key } }, 201);
      }
      if (em && !em[2] && req.method === "GET") {
        const e = state.environments.find((x) => x.id === em[1] && x.key === key);
        return e ? json({ data: { id: e.id, ...e.body } }) : json({ error: "not_found" }, 404);
      }
      if (em && !em[2] && req.method === "PUT") {
        const e = state.environments.find((x) => x.id === em[1] && x.key === key);
        if (!e) return json({ error: "not_found" }, 404);
        e.body = { ...e.body, ...((await req.json()) as Record<string, unknown>) };
        state.environmentPuts.push(e.id);
        return json({ data: { id: e.id, ...e.body } });
      }
      if (em && !em[2] && req.method === "DELETE") {
        if (!state.environments.some((e) => e.id === em[1] && e.key === key)) return json({ error: "not_found" }, 404);
        state.deletedEnvironments.push(em[1]!);
        return new Response(null, { status: 204 });
      }
      if (p === "/api/agents" && req.method === "GET") return json({ data: state.agents.get(key) ?? [] });
      if (p === "/api/agents" && req.method === "POST") {
        const body = (await req.json()) as Record<string, unknown>;
        // Names are unique per account (seen live 2026-09-02: a 422 with `errors.name`).
        if ((state.agents.get(key) ?? []).some((a) => a.name === body.name)) return json({ errors: { name: ["has already been taken"] } }, 422);
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
        const id = `c-${crypto.randomUUID().slice(0, 8)}`;
        // A conversation names the machine it runs on; the fake's is ready from the start, with an empty disk until a test fills it.
        state.sandboxes.set(`sb-${id}`, { key, status: "ready", disk: {}, diffs: {}, refs: [] });
        const conv = { id, status: "pending", sandbox_id: `sb-${id}`, agent_id: body.agent_id, channel_id: body.channel_id, turn_count: 1, first_prompt: body.prompt, title: null, last_active_at: null, request: body };
        state.conversations.set(key, [...(state.conversations.get(key) ?? []), conv]);
        return json({ data: conv }, 201);
      }
      if (p === "/api/conversations" && req.method === "GET") return json({ data: state.conversations.get(key) ?? [] });
      // The read-only sandbox routes (Fountain PR #1397, ADR 0039), shaped from its controller: `{data: …}`, full scope, a ready sandbox only, paths under the home.
      const sm = /^\/api\/sandboxes\/([^/]+)\/(files|file|diff)$/.exec(p);
      if (sm && state.sandboxRoutes) {
        const sb = state.sandboxes.get(sm[1]!);
        if (!sb || sb.key !== key) return json({ error: "not_found" }, 404);
        if (sb.status !== "ready") return json({ error: "sandbox_not_ready", message: `the sandbox is ${sb.status}; files are read from a ready one only`, status: sb.status }, 409);
        const path = (url.searchParams.get("path") ?? "/home/sprite").replace(/\/$/, "");
        if (path !== "/home/sprite" && !path.startsWith("/home/sprite/")) return json({ error: "path_outside_sandbox", message: "path must be under the sandbox home or the agent's working directory" }, 422);
        state.sandboxReads.push(`${sm[2]} ${url.search}`);
        const max = Number(url.searchParams.get("max_bytes") ?? 262144);
        if (sm[2] === "files") {
          if (path in sb.disk) return json({ error: "not_a_directory", message: "path is not a directory" }, 422);
          const seen = new Map<string, { name: string; type: string; size: number | null }>();
          for (const [f, body] of Object.entries(sb.disk)) {
            if (!f.startsWith(`${path}/`)) continue;
            const rest = f.slice(path.length + 1);
            const name = rest.split("/")[0]!;
            if (rest.includes("/")) seen.set(name, { name, type: "directory", size: null });
            else seen.set(name, { name, type: "file", size: body.length });
          }
          if (seen.size === 0) return json({ error: "path_not_found" }, 404);
          const entries = [...seen.values()].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1));
          return json({ data: { path, entries, truncated: false } });
        }
        if (sm[2] === "file") {
          const body = sb.disk[path];
          if (body === undefined) return json({ error: "path_not_found" }, 404);
          if (body.startsWith("base64:")) return json({ data: { path, size: 99, truncated: false, encoding: "base64", content: body.slice(7) } });
          return json({ data: { path, size: body.length, truncated: body.length > max, encoding: "utf-8", content: body.slice(0, max) } });
        }
        const ref = url.searchParams.get("ref");
        const staged = url.searchParams.get("staged") === "true";
        if (ref && !sb.refs.includes(ref)) return json({ error: "ref_not_found", message: "no such commit, branch or tag" }, 404);
        const text = sb.diffs[`${ref ?? ""}|${staged}`] ?? "";
        return json({ data: { path, repo_root: "/home/sprite/work/widgets", staged, ref, diff: text.slice(0, max), truncated: text.length > max } });
      }
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
  resetSandboxCache();
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

function withGitHubApp(): void {
  ctx.config.githubApp = {
    appId: "123",
    privateKey: GITHUB_PRIVATE_KEY,
    clientId: "Iv1.salon",
    clientSecret: "github-client-secret",
    slug: "salon-test",
    api: fakeUrl,
    oauthHost: fakeUrl,
  };
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
    // Its prompt was written before this one: brought up to date in place, and left alone the next time.
    expect(state.agentPatches).toEqual([{ key: "ftn_host", id: "a-old", body: { system: `${ROOM_PROMPT}\n\n${SALON_NOTE}` } }]);
    await startChat(cookie);
    expect(state.agentPatches).toHaveLength(1);
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

/** A host, a guest in the host's chat, and a stranger. */
async function room(): Promise<{ host: string; guest: string; other: string; chat: Record<string, any> }> {
  const host = await signIn("ftn_host");
  const guest = await signIn("ftn_guest");
  const other = await signIn("ftn_other");
  const chat = await startChat(host);
  await call("POST", `/api/chats/${chat.id}/members`, { cookie: host, body: { email: "guest@example.com" } });
  return { host, guest, other, chat };
}

describe("playing", () => {
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
    expect((await call("GET", `/api/chats/${chat.id}/stream`, { cookie: other })).status).toBe(404);
    const ctrl = new AbortController();
    const res = await app(new Request(`http://salon.test/api/chats/${chat.id}/stream`, { headers: { cookie: guest }, signal: ctrl.signal }));
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

describe("changes from the computer", () => {
  const DIFF = [
    "diff --git a/README.md b/README.md",
    "index 1111111..2222222 100644",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1,2 +1,3 @@ # Hi",
    " # Hi",
    "-old",
    "+new",
    "+more",
    "diff --git a/new.txt b/new.txt",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/new.txt",
    "@@ -0,0 +1 @@",
    "+hello",
    "",
  ].join("\n");
  const snapshot = (over: Record<string, unknown> = {}) => ({ branch: "salon/abcd1234", head: "deadbeefcafe", base: "main", status: " M README.md\n?? new.txt\n", diff: DIFF, reason: "stop", pr: null, ...over });
  const forChat = (conversationId: string, key = "ftn_sprite") => ({ authorization: `Bearer ${key}`, "x-fountain-conversation-id": conversationId });

  test("the hook posts on the conversation's key; the room reads it, sees it on the stream, and a stranger sees nothing", async () => {
    const { host, guest, other, chat } = await room();
    const conv = chat.conversationId as string;
    expect((await call("POST", "/hooks/changes", { body: snapshot() })).status).toBe(401);
    expect((await call("POST", "/hooks/changes", { body: snapshot(), headers: { authorization: "Bearer ftn_sprite" } })).status).toBe(400);
    expect((await call("POST", "/hooks/changes", { body: snapshot(), headers: forChat("c-nope") })).status).toBe(404);
    expect((await call("POST", "/hooks/changes", { body: snapshot(), headers: forChat(conv, "ftn_guest") })).status).toBe(404);
    expect((await call("POST", "/hooks/changes", { body: { diff: DIFF }, headers: forChat(conv) })).status).toBe(422);
    expect((await call("GET", "/hooks/changes", { headers: forChat(conv) })).status).toBe(405);

    // A browser on the stream first, so the post is seen arriving.
    const ctrl = new AbortController();
    const res = await app(new Request(`http://salon.test/api/chats/${chat.id}/stream`, { headers: { cookie: guest }, signal: ctrl.signal }));
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

    const posted = await call("POST", "/hooks/changes", { body: snapshot(), headers: forChat(conv) });
    expect(posted.status).toBe(201);
    expect(((await posted.json()) as { data: unknown }).data).toEqual({ seq: 1, files: 2, truncated: false });
    await until("event: changes");
    const onStream = JSON.parse(got.split("\n\n").find((e) => e.startsWith("event: changes"))!.split("\ndata: ")[1]!) as Record<string, unknown>;
    expect(onStream).toMatchObject({ chatId: chat.id, seq: 1, branch: "salon/abcd1234", diff: "" });
    ctrl.abort();

    const latest = ((await (await call("GET", `/api/chats/${chat.id}/changes`, { cookie: guest })).json()) as { data: Record<string, any> }).data;
    expect(latest).toMatchObject({ seq: 1, branch: "salon/abcd1234", head: "deadbeefcafe", base: "main", source: "hook", reason: "stop", truncated: false, pr: null, diff: DIFF });
    expect(latest.files).toEqual([
      { path: "README.md", oldPath: null, status: "modified", binary: false, additions: 2, deletions: 1 },
      { path: "new.txt", oldPath: null, status: "added", binary: false, additions: 1, deletions: 0 },
    ]);
    expect((await call("GET", `/api/chats/${chat.id}/changes`, { cookie: other })).status).toBe(404);

    // A second snapshot is newer; the history lists both, newest first, without their diffs.
    await call("POST", "/hooks/changes", { body: snapshot({ reason: "tool", pr: { url: "https://github.com/x/y/pull/1", state: "OPEN", mergeable: "MERGEABLE" } }), headers: forChat(conv) });
    const history = ((await (await call("GET", `/api/chats/${chat.id}/changes/history`, { cookie: host })).json()) as { data: Record<string, any>[] }).data;
    expect(history.map((h) => [h.seq, h.reason, h.diff])).toEqual([
      [2, "tool", ""],
      [1, "stop", ""],
    ]);
    expect(history[0]!.pr).toEqual({ url: "https://github.com/x/y/pull/1", state: "OPEN", mergeable: "MERGEABLE" });

    // Only the last twenty are kept.
    for (let i = 0; i < 25; i++) await call("POST", "/hooks/changes", { body: snapshot(), headers: forChat(conv) });
    const kept = ((await (await call("GET", `/api/chats/${chat.id}/changes/history`, { cookie: host })).json()) as { data: { seq: number }[] }).data;
    expect(kept).toHaveLength(20);
    expect(kept[0]!.seq).toBe(27);
    expect(kept[19]!.seq).toBe(8);
  });

  test("an empty tree is a record too, and a diff over the cap is cut and says so", async () => {
    const { host, chat } = await room();
    const conv = chat.conversationId as string;
    const empty = await call("POST", "/hooks/changes", { body: snapshot({ status: "", diff: "", reason: "session" }), headers: forChat(conv) });
    expect(((await empty.json()) as { data: unknown }).data).toEqual({ seq: 1, files: 0, truncated: false });
    const big = DIFF + "+".repeat(1_000_001);
    const cut = await call("POST", "/hooks/changes", { body: snapshot({ diff: big }), headers: forChat(conv) });
    expect(((await cut.json()) as { data: { truncated: boolean } }).data.truncated).toBe(true);
    const latest = ((await (await call("GET", `/api/chats/${chat.id}/changes`, { cookie: host })).json()) as { data: { diff: string; truncated: boolean } }).data;
    expect(latest.truncated).toBe(true);
    expect(latest.diff.length).toBe(1_000_000);
  });

  test("the setup script installs a hook bash accepts, and settings Claude Code reads", async () => {
    const script = hookSetupScript({ publicUrl: "https://salon.test", repoPath: "/home/sprite/work/app", base: "main" });
    expect(script).toContain("/home/sprite/.claude/settings.local.json");
    const settings = JSON.parse(script.split("<<'SALON_SETTINGS'\n")[1]!.split("\nSALON_SETTINGS")[0]!) as { hooks: Record<string, unknown[]> };
    expect(Object.keys(settings.hooks).sort()).toEqual(["PostToolUse", "SessionStart", "Stop"]);
    const hook = script.split("<<'SALON_HOOK'\n")[1]!.split("\nSALON_HOOK")[0]!;
    expect(hook).toContain("URL='https://salon.test/hooks/changes'");
    expect(hook).toContain("REPO='/home/sprite/work/app'");
    for (const text of [script, hook]) {
      const check = Bun.spawnSync(["bash", "-n"], { stdin: new TextEncoder().encode(text) });
      expect(new TextDecoder().decode(check.stderr)).toBe("");
      expect(check.exitCode).toBe(0);
    }
    // A path with a quote in it stays one word.
    expect(hookSetupScript({ publicUrl: "https://s", repoPath: "/it's", base: "main" })).toContain(`REPO='/it'\\''s'`);
  });
});

describe("a chat on an environment", () => {
  test("names the environment on its agent — Fountain keeps names unique — and starts the conversation on it", async () => {
    const host = await signIn("ftn_host");
    const plain = await startChat(host);
    const onEnv = await startChat(host, { ...SETTINGS, environmentId: "e-1" });
    const onOther = await startChat(host, { ...SETTINGS, environmentId: "e-2" });
    const names = state.agentPosts.map((a) => a.body.name);
    expect(names).toEqual(["Salon · Opus 5 · on e-1", "Salon · Opus 5 · on e-2"]);
    expect(new Set([plain.agentId, onEnv.agentId, onOther.agentId]).size).toBe(3);
    const convs = state.conversations.get("ftn_host")!;
    expect((convs.find((c) => c.id === onEnv.conversationId)!.request as Record<string, unknown>).environment_id).toBe("e-1");
    expect((convs.find((c) => c.id === plain.conversationId)!.request as Record<string, unknown>).environment_id).toBeUndefined();
  });
});

describe("projects", () => {
  async function makeProject(cookie: string, over: Record<string, unknown> = {}): Promise<Record<string, any>> {
    const res = await call("POST", "/api/projects", { cookie, body: { repoUrl: "github.com/acme/widgets", token: "ghp_secret_token", setup: "npm install", ...over } });
    expect(res.status).toBe(201);
    return ((await res.json()) as { data: Record<string, any> }).data;
  }

  test("a repository becomes an environment on the owner's Fountain: the clone, the hook, the setup, the token as a secret Salon never keeps", async () => {
    withPublicUrl();
    const host = await signIn("ftn_host");
    expect((await call("POST", "/api/projects", { cookie: host, body: { repoUrl: "not a repo" } })).status).toBe(422);
    expect((await call("POST", "/api/projects", { cookie: host, body: { repoUrl: "github.com/acme/widgets", base: "bad branch" } })).status).toBe(422);
    const project = await makeProject(host);
    expect(project).toMatchObject({ name: "widgets", ownerEmail: "host@example.com", role: "owner", repoUrl: "https://github.com/acme/widgets", base: "main", hasToken: true, members: [] });

    expect(state.environments).toHaveLength(1);
    const env = state.environments[0]!;
    expect(env.key).toBe("ftn_host");
    expect(env.body).toMatchObject({ name: "Salon · widgets", repositories: [{ url: "https://github.com/acme/widgets", mount_path: "/home/sprite/work/widgets", ref: "main", secret_key: "GITHUB_TOKEN" }], packages: { apt: ["jq"] } });
    const script = env.body.setup_script as string;
    expect(script).toContain("/home/sprite/.salon/changes.sh");
    expect(script).toContain("URL='https://salon.test/hooks/changes'");
    expect(script).toContain("REPO='/home/sprite/work/widgets'");
    expect(script).toContain("git config --global user.name 'Host'");
    expect(script).toContain("cd '/home/sprite/work/widgets' && (\nnpm install\n)");
    expect(state.secrets.map((x) => [x.env, x.body.key, x.body.value])).toEqual([
      ["e-1", "GITHUB_TOKEN", "ghp_secret_token"],
      ["e-1", "GH_TOKEN", "ghp_secret_token"],
    ]);
    // Nothing of the token in Salon's own records.
    const rows = ctx.db.sql.query("SELECT * FROM projects").all() as Record<string, unknown>[];
    expect(JSON.stringify(rows)).not.toContain("ghp_");

    // Without a token: a public repository, no secret_key, no secrets.
    const open = await makeProject(host, { repoUrl: "https://github.com/acme/site.git", token: "", base: "develop", name: "The site" });
    expect(open).toMatchObject({ name: "The site", base: "develop", hasToken: false });
    expect((state.environments[1]!.body.repositories as Record<string, unknown>[])[0]!.secret_key).toBeUndefined();
    expect(state.secrets).toHaveLength(2);

    // Fountain's refusal comes through, and nothing is kept.
    const broke = await call("POST", "/api/projects", { cookie: host, body: { repoUrl: "github.com/acme/x", name: "broken" } });
    expect(broke.status).toBe(422);
    expect(((await (await call("GET", "/api/projects", { cookie: host })).json()) as { data: unknown[] }).data).toHaveLength(2);
  });

  test("a chat in a project runs on the project owner's key whoever starts it, and the project's people are in it", async () => {
    withPublicUrl();
    const host = await signIn("ftn_host");
    const guest = await signIn("ftn_guest");
    const other = await signIn("ftn_other");
    const project = await makeProject(host, { token: "" });
    expect((await call("GET", `/api/projects/${project.id}`, { cookie: guest })).status).toBe(404);
    expect((await call("POST", `/api/projects/${project.id}/members`, { cookie: guest, body: { email: "other@example.com" } })).status).toBe(404);
    await call("POST", `/api/projects/${project.id}/members`, { cookie: host, body: { email: "guest@example.com" } });
    expect(((await (await call("GET", "/api/projects", { cookie: guest })).json()) as { data: Record<string, any>[] }).data[0]).toMatchObject({ id: project.id, role: "member" });

    // The guest starts a chat in it.
    const res = await call("POST", "/api/chats", { cookie: guest, body: { prompt: "fix the widget", settings: { ...SETTINGS, projectId: project.id } } });
    expect(res.status).toBe(201);
    const chat = ((await res.json()) as { data: Record<string, any> }).data;
    expect(chat).toMatchObject({ ownerEmail: "host@example.com", role: "member", project: { id: project.id, name: "widgets", repoUrl: "https://github.com/acme/widgets", base: "main" } });
    expect(chat.members.map((m: { email: string }) => m.email)).toEqual(["guest@example.com"]);
    // On the host's key, with the host's environment, the guest's words tagged, the agent named for the project and told about the repository.
    const conv = state.conversations.get("ftn_host")!.find((c) => c.id === chat.conversationId)!;
    expect((conv.request as Record<string, unknown>).environment_id).toBe("e-1");
    expect((conv.request as Record<string, unknown>).prompt).toBe("[from guest@example.com] fix the widget");
    expect(state.conversations.get("ftn_guest") ?? []).toHaveLength(0);
    const agent = state.agentPosts.find((a) => a.key === "ftn_host" && String(a.body.name).includes("widgets"))!;
    expect(agent.body.name).toBe("Salon · Opus 5 · on widgets");
    expect(String(agent.body.system)).toContain("checked out at /home/sprite/work/widgets");
    expect(String(agent.body.system)).toContain("Co-authored-by");
    // The guest reads it through the proxy; a stranger does not.
    expect((await call("GET", `/f/${chat.id}/api/conversations/${chat.conversationId}`, { cookie: guest })).status).toBe(200);
    expect((await call("GET", `/api/chats/${chat.id}`, { cookie: other })).status).toBe(404);
    // The host sees it as theirs, in the project.
    const mine = ((await (await call("GET", "/api/chats", { cookie: host })).json()) as { data: Record<string, any>[] }).data;
    expect(mine.find((c) => c.id === chat.id)).toMatchObject({ role: "owner", project: { id: project.id } });

    // Someone added to the project later is in its chats too; removed, they are out of the ones the project put them in.
    await call("POST", `/api/projects/${project.id}/members`, { cookie: host, body: { email: "other@example.com" } });
    expect((await call("GET", `/api/chats/${chat.id}`, { cookie: other })).status).toBe(200);
    await call("DELETE", `/api/projects/${project.id}/members/other%40example.com`, { cookie: host });
    expect((await call("GET", `/api/chats/${chat.id}`, { cookie: other })).status).toBe(404);
    expect((await call("GET", `/api/projects/${project.id}`, { cookie: other })).status).toBe(404);

    // The host starts one too: no tag needed? The room has the guest, so the host's words are tagged as well.
    const res2 = await call("POST", "/api/chats", { cookie: host, body: { prompt: "and the gadget", settings: { ...SETTINGS, projectId: project.id } } });
    const chat2 = ((await res2.json()) as { data: Record<string, any> }).data;
    expect(chat2.role).toBe("owner");
    expect(chat2.members.map((m: { email: string }) => m.email)).toEqual(["guest@example.com"]);
    const conv2 = state.conversations.get("ftn_host")!.find((c) => c.id === chat2.conversationId)!;
    expect((conv2.request as Record<string, unknown>).prompt).toBe("[from host@example.com] and the gadget");
    // The second chat found the same derived agent.
    expect(state.agentPosts.filter((a) => String(a.body.name).includes("widgets"))).toHaveLength(1);

    // Removing the project removes the environment; the chats stay, unattached.
    expect((await call("DELETE", `/api/projects/${project.id}`, { cookie: guest })).status).toBe(403);
    expect((await call("DELETE", `/api/projects/${project.id}`, { cookie: host })).status).toBe(200);
    expect(state.deletedEnvironments).toEqual(["e-1"]);
    expect(((await (await call("GET", `/api/chats/${chat.id}`, { cookie: host })).json()) as { data: { chat: { project: unknown } } }).data.chat.project).toBeNull();
    expect((await call("POST", "/api/chats", { cookie: host, body: { prompt: "x", settings: { ...SETTINGS, projectId: project.id } } })).status).toBe(404);
  });
});

describe("the GitHub App", () => {
  test("connects an existing Salon user, lists only installed pushable repositories, and starts with a fresh single-repo token", async () => {
    withPublicUrl();
    withGitHubApp();
    const host = await signIn("ftn_host");
    const before = await call("GET", "/api/github", { cookie: host });
    expect((await before.json()) as Record<string, unknown>).toMatchObject({ data: { configured: true, connected: false, clientId: "Iv1.salon" } });
    expect((await call("POST", "/api/github/callback", { cookie: host, body: { code: "good-code", redirectUri: "https://elsewhere.example/" } })).status).toBe(400);

    // The public redirect is HTTPS while this in-process request is HTTP —
    // exactly what Bun sees behind the production reverse proxy.
    const linked = await call("POST", "/api/github/callback", { cookie: host, body: { code: "good-code", redirectUri: "https://salon.test/" } });
    expect(linked.status).toBe(200);
    expect(((await linked.json()) as { data: { login: string } }).data.login).toBe("octohost");
    const account = ctx.db.githubAccount("host@example.com")!;
    expect(account.login).toBe("octohost");
    expect(JSON.stringify(account)).not.toContain("ghu_host");

    const repos = (await (await call("GET", "/api/github/repos", { cookie: host })).json()) as { data: Record<string, unknown>[] };
    expect(repos.data).toEqual([{ slug: "acme/widgets", private: true, archived: false, defaultBranch: "trunk", description: "Widgets", pushedAt: "2026-09-01T00:00:00Z" }]);

    const made = await call("POST", "/api/projects", { cookie: host, body: { githubRepo: "acme/widgets" } });
    expect(made.status).toBe(201);
    const project = ((await made.json()) as { data: Record<string, unknown> }).data;
    expect(project).toMatchObject({ repoUrl: "https://github.com/acme/widgets", base: "trunk", hasToken: true, githubManaged: true });
    expect(state.secrets.slice(-2).map((s) => [s.body.key, s.body.value])).toEqual([
      ["GITHUB_TOKEN", "ghs_widgets"],
      ["GH_TOKEN", "ghs_widgets"],
    ]);
    expect(state.githubTokenBodies[0]).toEqual({ repositories: ["widgets"], owner: "acme", permissions: { contents: "write", metadata: "read", pull_requests: "write", workflows: "write" } });
    expect(JSON.stringify(ctx.db.getProject(project.id as string))).not.toContain("ghs_widgets");

    await startChat(host, { ...SETTINGS, projectId: project.id });
    expect(state.secrets.slice(-2).map((s) => s.body.value)).toEqual(["ghs_widgets", "ghs_widgets"]);
    const script = state.environments.at(-1)!.body.setup_script as string;
    expect(script).toContain("/hooks/github-token");
    expect(script).toContain("credential.helper");
  });

  test("does not reveal App or repository credentials to a browser", async () => {
    withGitHubApp();
    const host = await signIn("ftn_host");
    const info = await (await call("GET", "/api/github", { cookie: host })).text();
    expect(info).not.toContain("github-client-secret");
    expect(info).not.toContain("PRIVATE KEY");
    expect((await call("GET", "/api/github/repos", { cookie: host })).status).toBe(409);
    expect((await call("POST", "/hooks/github-token")).status).toBe(401);
  });
});

describe("review comments", () => {
  const DIFF = ["diff --git a/README.md b/README.md", "--- a/README.md", "+++ b/README.md", "@@ -1,2 +1,3 @@", " # Hi", "-old", "+new", "+more", ""].join("\n");
  const forChat = (conversationId: string) => ({ authorization: "Bearer ftn_sprite", "x-fountain-conversation-id": conversationId });

  test("people comment on lines, resolve them, and send the open ones to the model as one tagged prompt", async () => {
    const { host, guest, other, chat } = await room();
    const conv = chat.conversationId as string;
    // Nothing to comment on until the computer has reported.
    expect((await call("POST", `/api/chats/${chat.id}/comments`, { cookie: host, body: { path: "README.md", line: 2, body: "hm" } })).status).toBe(409);
    await call("POST", "/hooks/changes", { body: { branch: "salon/abcd1234", head: "deadbeefcafe", base: "main", status: " M README.md\n", diff: DIFF, reason: "stop" }, headers: forChat(conv) });

    expect((await call("POST", `/api/chats/${chat.id}/comments`, { cookie: host, body: { path: "README.md", line: 2 } })).status).toBe(422);
    expect((await call("POST", `/api/chats/${chat.id}/comments`, { cookie: other, body: { path: "README.md", line: 2, body: "x" } })).status).toBe(404);
    const c1 = ((await (await call("POST", `/api/chats/${chat.id}/comments`, { cookie: guest, body: { path: "README.md", line: 2, body: "Say hello, not new" } })).json()) as { data: Record<string, any> }).data;
    expect(c1).toMatchObject({ chatId: chat.id, changesSeq: 1, path: "README.md", side: "new", line: 2, quote: "new", author: "guest@example.com", resolvedAt: null, sentAt: null });
    const c2 = ((await (await call("POST", `/api/chats/${chat.id}/comments`, { cookie: host, body: { path: "README.md", line: 2, side: "old", body: "why was this removed?" } })).json()) as { data: Record<string, any> }).data;
    expect(c2).toMatchObject({ side: "old", quote: "old", author: "host@example.com" });
    const c3 = ((await (await call("POST", `/api/chats/${chat.id}/comments`, { cookie: host, body: { path: "README.md", line: 3, body: "drop this" } })).json()) as { data: Record<string, any> }).data;

    // Resolved ones are not sent; the guest can resolve the host's.
    const resolved = ((await (await call("POST", `/api/chats/${chat.id}/comments/${c3.id}/resolve`, { cookie: guest, body: {} })).json()) as { data: Record<string, any> }).data;
    expect(resolved.resolvedBy).toBe("guest@example.com");
    // Only the author or the host removes one.
    expect((await call("DELETE", `/api/chats/${chat.id}/comments/${c2.id}`, { cookie: guest })).status).toBe(403);

    const seen: unknown[] = [];
    const off = hub.subscribe(chat.id, (e) => seen.push(e.event));
    const sent = await call("POST", `/api/chats/${chat.id}/comments/send`, { cookie: guest });
    off();
    expect(sent.status).toBe(202);
    const out = ((await sent.json()) as { data: { sent: number; prompt: string } }).data;
    expect(out.sent).toBe(2);
    expect(seen).toEqual(["comment", "comment"]);
    const prompt = state.prompts.find((p) => p.id === conv)!.body as { prompt: string };
    expect(prompt.prompt).toBe(`[from guest@example.com] ${out.prompt}`);
    expect(out.prompt).toContain("Review comments on salon/abcd1234 at deadbee");
    expect(out.prompt).toContain("README.md:");
    expect(out.prompt).toContain("- line 2 — `new`\n  guest@example.com: Say hello, not new");
    expect(out.prompt).toContain("- line 2 (removed) — `old`\n  host@example.com: why was this removed?");
    expect(out.prompt).not.toContain("drop this");
    // Marked sent, by whom; the send is the guest's turn in the record; nothing left to send.
    const all = ((await (await call("GET", `/api/chats/${chat.id}/comments`, { cookie: host })).json()) as { data: Record<string, any>[] }).data;
    expect(all.map((c) => [c.id, c.sentBy, !!c.resolvedAt])).toEqual([
      [c1.id, "guest@example.com", false],
      [c2.id, "guest@example.com", false],
      [c3.id, null, true],
    ]);
    const shown = ((await (await call("GET", `/api/chats/${chat.id}`, { cookie: host })).json()) as { data: { sends: { email: string }[] } }).data;
    expect(shown.sends.map((s) => s.email)).toEqual(["host@example.com", "guest@example.com"]);
    expect((await call("POST", `/api/chats/${chat.id}/comments/send`, { cookie: host })).status).toBe(422);
    // The host removes one; it goes out as deleted.
    expect((await call("DELETE", `/api/chats/${chat.id}/comments/${c1.id}`, { cookie: host })).status).toBe(200);
    expect(((await (await call("GET", `/api/chats/${chat.id}/comments`, { cookie: host })).json()) as { data: unknown[] }).data).toHaveLength(2);
  });
});

describe("archive and restore", () => {
  const forChat = (conversationId: string) => ({ authorization: "Bearer ftn_sprite", "x-fountain-conversation-id": conversationId });

  test("archive ends the conversation and keeps the chat; restore starts a new one on the branch, and the sends start over", async () => {
    const { host, guest, chat } = await room();
    const conv = chat.conversationId as string;
    await call("POST", "/hooks/changes", { body: { branch: "salon/abcd1234", head: "deadbeefcafe", base: "main", status: "", diff: "", reason: "stop", ahead: 0 }, headers: forChat(conv) });
    expect((await call("POST", `/api/chats/${chat.id}/archive`, { cookie: guest })).status).toBe(403);
    const archived = ((await (await call("POST", `/api/chats/${chat.id}/archive`, { cookie: host })).json()) as { data: { chat: Record<string, any> } }).data.chat;
    expect(archived.archivedAt).toBeTruthy();
    expect(state.terminated).toEqual([conv]);
    // Twice is fine; the guest still sees it; its changes are still there.
    expect((await call("POST", `/api/chats/${chat.id}/archive`, { cookie: host })).status).toBe(200);
    expect((await call("GET", `/api/chats/${chat.id}`, { cookie: guest })).status).toBe(200);
    expect(((await (await call("GET", `/api/chats/${chat.id}/changes`, { cookie: guest })).json()) as { data: { branch: string } }).data.branch).toBe("salon/abcd1234");

    const restored = ((await (await call("POST", `/api/chats/${chat.id}/restore`, { cookie: host })).json()) as { data: { chat: Record<string, any>; sends: { email: string }[] } }).data;
    expect(restored.chat.archivedAt).toBeNull();
    expect(restored.chat.conversationId).not.toBe(conv);
    expect(restored.sends.map((s) => s.email)).toEqual(["host@example.com"]);
    const fresh = state.conversations.get("ftn_host")!.find((c) => c.id === restored.chat.conversationId)!;
    expect(fresh.channel_id).toBe(`salon:${chat.id}`);
    expect(String((fresh.request as Record<string, unknown>).prompt)).toContain("check out the branch salon/abcd1234");
    expect((fresh.request as Record<string, unknown>).agent_id).toBe(chat.agentId);
    // The new conversation is the chat's now: the hook on the new computer, and the proxy, both find it.
    expect((await call("POST", "/hooks/changes", { body: { branch: "salon/abcd1234", head: "1234567", base: "main", status: "", diff: "", reason: "session", ahead: 2 }, headers: forChat(restored.chat.conversationId) })).status).toBe(201);
    expect((await call("GET", `/f/${chat.id}/api/conversations/${restored.chat.conversationId}`, { cookie: guest })).status).toBe(200);
    expect((await call("GET", `/f/${chat.id}/api/conversations/${conv}`, { cookie: guest })).status).toBe(404);
    const latest = ((await (await call("GET", `/api/chats/${chat.id}/changes`, { cookie: host })).json()) as { data: { ahead: number; seq: number } }).data;
    expect([latest.seq, latest.ahead]).toEqual([2, 2]);
  });
});

describe("a project's hook stays current", () => {
  test("a chat start puts the environment back the way Salon writes it today, only when it differs", async () => {
    withPublicUrl();
    const host = await signIn("ftn_host");
    const project = ((await (await call("POST", "/api/projects", { cookie: host, body: { repoUrl: "github.com/acme/widgets" } })).json()) as { data: { id: string } }).data;
    await startChat(host, { ...SETTINGS, projectId: project.id });
    expect(state.environmentPuts).toEqual([]);
    // The environment drifted — an older hook, say.
    state.environments[0]!.body.setup_script = "# old hook\n";
    await startChat(host, { ...SETTINGS, projectId: project.id });
    expect(state.environmentPuts).toEqual(["e-1"]);
    expect(String(state.environments[0]!.body.setup_script)).toContain("/home/sprite/.salon/changes.sh");
    await startChat(host, { ...SETTINGS, projectId: project.id });
    expect(state.environmentPuts).toEqual(["e-1"]);
  });
});

describe("the repository, read through Fountain", () => {
  const REPO = "/home/sprite/work/widgets";
  const AGAINST_MAIN = ["diff --git a/README.md b/README.md", "--- a/README.md", "+++ b/README.md", "@@ -1,2 +1,3 @@", " # Hi", "-old", "+new", "+more", "diff --git a/new.txt b/new.txt", "new file mode 100644", "--- /dev/null", "+++ b/new.txt", "@@ -0,0 +1 @@", "+hello", ""].join("\n");
  const UNSTAGED = ["diff --git a/README.md b/README.md", "--- a/README.md", "+++ b/README.md", "@@ -1 +1 @@", "-x", "+y", ""].join("\n");
  const STAGED = ["diff --git a/new.txt b/new.txt", "new file mode 100644", "--- /dev/null", "+++ b/new.txt", "@@ -0,0 +1 @@", "+hello", ""].join("\n");

  /** A project chat with the guest in it, and its computer's disk as a fresh session leaves it: on the chat's branch, nothing pushed. */
  async function projectChat(): Promise<{ host: string; guest: string; chat: Record<string, any>; sb: FakeSandbox }> {
    withPublicUrl();
    const host = await signIn("ftn_host");
    const guest = await signIn("ftn_guest");
    const project = ((await (await call("POST", "/api/projects", { cookie: host, body: { repoUrl: "github.com/acme/widgets" } })).json()) as { data: Record<string, any> }).data;
    expect((await call("POST", `/api/projects/${project.id}/members`, { cookie: host, body: { email: "guest@example.com" } })).status).toBe(200);
    const chat = await startChat(host, { ...SETTINGS, projectId: project.id });
    const sb = state.sandboxes.get(`sb-${chat.conversationId}`)!;
    sb.disk = {
      [`${REPO}/.git/HEAD`]: "ref: refs/heads/salon/abcd1234\n",
      [`${REPO}/.git/refs/heads/salon/abcd1234`]: "deadbeefcafe\n",
      [`${REPO}/README.md`]: "# Hi\nnew\nmore\n",
      [`${REPO}/src/app.ts`]: "export {};\n",
      [`${REPO}/logo.png`]: "base64:iVBORw0KGgo=",
    };
    sb.refs = ["main"];
    sb.diffs = { "main|false": AGAINST_MAIN, "|false": UNSTAGED, "|true": STAGED };
    return { host, guest, chat, sb };
  }

  test("refresh reads the diff, the status and the refs on the host's key, records the snapshot, and the room sees it", async () => {
    const { host, guest, chat } = await projectChat();
    const seen: unknown[] = [];
    const off = hub.subscribe(chat.id, (e) => seen.push(e));
    const res = await call("POST", `/api/chats/${chat.id}/changes/refresh`, { cookie: guest, body: {} });
    expect(res.status).toBe(201);
    const snap = ((await res.json()) as { data: Record<string, any> }).data;
    expect(snap).toMatchObject({ source: "fountain", reason: "manual", branch: "salon/abcd1234", head: "deadbeefcafe", base: "main", ahead: null, pr: null, truncated: false, seq: 1 });
    expect(snap.files.map((f: { path: string; status: string }) => [f.path, f.status])).toEqual([
      ["README.md", "modified"],
      ["new.txt", "added"],
    ]);
    expect(snap.diff).toBe(AGAINST_MAIN);
    // `git status` as two diffs tell it: the index has new.txt, the tree has README.md.
    expect(snap.status).toBe("A  new.txt\n M README.md\n");
    expect(seen).toEqual([{ event: "changes", data: expect.objectContaining({ seq: 1, source: "fountain", diff: "" }) }]);
    off();
    expect(state.sandboxReads).toContain(`diff ?path=${encodeURIComponent(REPO)}&ref=main&max_bytes=1000001`);
    expect(state.sandboxReads).toContain(`diff ?path=${encodeURIComponent(REPO)}&staged=true&max_bytes=1000001`);
    expect(state.sandboxReads).toContain(`file ?path=${encodeURIComponent(`${REPO}/.git/HEAD`)}`);
    const latest = ((await (await call("GET", `/api/chats/${chat.id}/changes`, { cookie: host })).json()) as { data: Record<string, any> }).data;
    expect(latest.seq).toBe(1);
    expect(latest.source).toBe("fountain");

    // A stranger is told the chat does not exist; a chat outside a project has nothing to read.
    const other = await signIn("ftn_other");
    expect((await call("POST", `/api/chats/${chat.id}/changes/refresh`, { cookie: other })).status).toBe(404);
    const plain = await startChat(host);
    const none = await call("POST", `/api/chats/${plain.id}/changes/refresh`, { cookie: host });
    expect(none.status).toBe(422);
    expect(((await none.json()) as { error: string }).error).toBe("no_repository");
  });

  test("whether the branch is pushed comes from the remote ref; packed refs and a detached head are read too", async () => {
    const { host, chat, sb } = await projectChat();
    const refresh = async () => ((await (await call("POST", `/api/chats/${chat.id}/changes/refresh`, { cookie: host })).json()) as { data: Record<string, any> }).data;
    sb.disk[`${REPO}/.git/refs/remotes/origin/salon/abcd1234`] = "deadbeefcafe\n";
    expect((await refresh()).ahead).toBe(0);
    sb.disk[`${REPO}/.git/refs/remotes/origin/salon/abcd1234`] = "0000000older\n";
    expect((await refresh()).ahead).toBe(-1);
    // After a `git gc` the refs are lines in packed-refs.
    delete sb.disk[`${REPO}/.git/refs/heads/salon/abcd1234`];
    delete sb.disk[`${REPO}/.git/refs/remotes/origin/salon/abcd1234`];
    sb.disk[`${REPO}/.git/packed-refs`] = "# pack-refs with: peeled fully-peeled sorted \nfeedfacefeed refs/heads/salon/abcd1234\nfeedfacefeed refs/remotes/origin/salon/abcd1234\n^tagpeel\n";
    expect(await refresh()).toMatchObject({ branch: "salon/abcd1234", head: "feedfacefeed", ahead: 0 });
    sb.disk[`${REPO}/.git/HEAD`] = "cafebabe0000\n";
    expect(await refresh()).toMatchObject({ branch: "", head: "cafebabe0000", ahead: null });
  });

  test("the diff is against the base as cloned, else the remote's, else HEAD; a cut diff says so; the pull request carries over on the same branch", async () => {
    const { host, chat, sb } = await projectChat();
    const refresh = async () => ((await (await call("POST", `/api/chats/${chat.id}/changes/refresh`, { cookie: host })).json()) as { data: Record<string, any> }).data;
    sb.refs = ["origin/main"];
    sb.diffs["origin/main|false"] = STAGED;
    expect((await refresh()).diff).toBe(STAGED);
    sb.refs = [];
    expect((await refresh()).diff).toBe(UNSTAGED);
    // On the base branch itself, the remote's ref is what the work is measured against.
    sb.refs = ["main", "origin/main"];
    sb.disk[`${REPO}/.git/HEAD`] = "ref: refs/heads/main\n";
    sb.disk[`${REPO}/.git/refs/heads/main`] = "deadbeefcafe\n";
    expect((await refresh()).diff).toBe(STAGED);
    sb.disk[`${REPO}/.git/HEAD`] = "ref: refs/heads/salon/abcd1234\n";
    sb.refs = ["main"];
    sb.diffs["main|false"] = `${AGAINST_MAIN}${"+".repeat(1_000_100)}`;
    const cut = await refresh();
    expect(cut.truncated).toBe(true);
    expect(cut.diff.length).toBe(1_000_000);
    // The hook knew of a pull request; a read through Fountain cannot ask gh, so it keeps what the branch's last snapshot said.
    sb.diffs["main|false"] = AGAINST_MAIN;
    const hooked = await call("POST", "/hooks/changes", { body: { branch: "salon/abcd1234", head: "deadbeefcafe", base: "main", status: "", diff: "", reason: "stop", pr: { url: "https://github.com/acme/widgets/pull/7", state: "OPEN" } }, headers: { authorization: "Bearer ftn_sprite", "x-fountain-conversation-id": chat.conversationId } });
    expect(hooked.status).toBe(201);
    expect((await refresh()).pr).toEqual({ url: "https://github.com/acme/widgets/pull/7", state: "OPEN", mergeable: null });
    sb.disk[`${REPO}/.git/HEAD`] = "ref: refs/heads/other\n";
    sb.disk[`${REPO}/.git/refs/heads/other`] = "1234567abcde\n";
    expect((await refresh()).pr).toBeNull();
  });

  test("a turn-end refresh defers to a snapshot the hook just posted, and browsers asking together share one read", async () => {
    const { host, guest, chat } = await projectChat();
    const hooked = await call("POST", "/hooks/changes", { body: { branch: "salon/abcd1234", head: "deadbeefcafe", base: "main", status: "", diff: "", reason: "stop" }, headers: { authorization: "Bearer ftn_sprite", "x-fountain-conversation-id": chat.conversationId } });
    expect(hooked.status).toBe(201);
    const deferred = await call("POST", `/api/chats/${chat.id}/changes/refresh`, { cookie: guest, body: { reason: "stop" } });
    expect(deferred.status).toBe(200);
    expect(((await deferred.json()) as { data: { seq: number; source: string } }).data).toMatchObject({ seq: 1, source: "hook" });
    expect(state.sandboxReads).toEqual([]);
    // Two people press Refresh at once: one read, one record, both get it.
    const [a, b] = await Promise.all([call("POST", `/api/chats/${chat.id}/changes/refresh`, { cookie: host }), call("POST", `/api/chats/${chat.id}/changes/refresh`, { cookie: guest })]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(((await a.json()) as { data: { seq: number } }).data.seq).toBe(2);
    expect(((await b.json()) as { data: { seq: number } }).data.seq).toBe(2);
    expect(state.sandboxReads.filter((r) => r.startsWith("diff ") && r.includes("ref=main"))).toHaveLength(1);
  });

  test("Fountain's refusals pass through with their code: a parked computer, a Fountain without the routes, an archived chat", async () => {
    const { host, chat, sb } = await projectChat();
    sb.status = "suspended";
    const parked = await call("POST", `/api/chats/${chat.id}/changes/refresh`, { cookie: host });
    expect(parked.status).toBe(409);
    expect(((await parked.json()) as { error: string }).error).toBe("sandbox_not_ready");
    sb.status = "ready";
    state.sandboxRoutes = false;
    const old = await call("GET", `/api/chats/${chat.id}/files?path=`, { cookie: host });
    expect(old.status).toBe(501);
    expect(((await old.json()) as { error: string }).error).toBe("files_unavailable");
    state.sandboxRoutes = true;
    expect((await call("POST", `/api/chats/${chat.id}/archive`, { cookie: host })).status).toBe(200);
    const gone = await call("POST", `/api/chats/${chat.id}/changes/refresh`, { cookie: host });
    expect(gone.status).toBe(409);
    expect(((await gone.json()) as { error: string }).error).toBe("no_computer");
  });

  test("anyone in the chat browses the repository as it is now, and never outside it", async () => {
    const { guest, chat } = await projectChat();
    const root = ((await (await call("GET", `/api/chats/${chat.id}/files?path=`, { cookie: guest })).json()) as { data: Record<string, any> }).data;
    expect(root.path).toBe("");
    expect(root.entries).toEqual([
      { name: ".git", type: "directory", size: null },
      { name: "src", type: "directory", size: null },
      { name: "logo.png", type: "file", size: 19 },
      { name: "README.md", type: "file", size: 14 },
    ]);
    const src = ((await (await call("GET", `/api/chats/${chat.id}/files?path=src/`, { cookie: guest })).json()) as { data: Record<string, any> }).data;
    expect(src).toEqual({ path: "src", entries: [{ name: "app.ts", type: "file", size: 11 }], truncated: false });
    const file = ((await (await call("GET", `/api/chats/${chat.id}/file?path=src/app.ts`, { cookie: guest })).json()) as { data: Record<string, any> }).data;
    expect(file).toEqual({ path: "src/app.ts", size: 11, truncated: false, encoding: "utf-8", content: "export {};\n" });
    expect(state.sandboxReads.at(-1)).toBe(`file ?path=${encodeURIComponent(`${REPO}/src/app.ts`)}&max_bytes=262144`);
    const png = ((await (await call("GET", `/api/chats/${chat.id}/file?path=logo.png`, { cookie: guest })).json()) as { data: Record<string, any> }).data;
    expect(png).toMatchObject({ encoding: "base64", content: "iVBORw0KGgo=" });
    // Above the repository is refused here, before Fountain would confine it to the home.
    expect((await call("GET", `/api/chats/${chat.id}/files?path=../`, { cookie: guest })).status).toBe(422);
    expect((await call("GET", `/api/chats/${chat.id}/file?path=/etc/passwd`, { cookie: guest })).status).toBe(404);
    expect((await call("GET", `/api/chats/${chat.id}/file?path=`, { cookie: guest })).status).toBe(422);
    const missing = await call("GET", `/api/chats/${chat.id}/file?path=nope.txt`, { cookie: guest });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toBe("path_not_found");
    const other = await signIn("ftn_other");
    expect((await call("GET", `/api/chats/${chat.id}/files?path=`, { cookie: other })).status).toBe(404);
    // Every read went under the repository: a leading slash is not an absolute path here.
    expect(state.sandboxReads.every((r) => r.includes(`?path=${encodeURIComponent(REPO)}`))).toBe(true);
    expect(state.sandboxReads).toContain(`file ?path=${encodeURIComponent(`${REPO}/etc/passwd`)}&max_bytes=262144`);
  });
});
