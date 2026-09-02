import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./app";
import type { Config } from "./config";
import { ProjectEvents } from "./context";
import { Cipher } from "./crypto";
import { Db } from "./db";
import { resetCostCache } from "./cost";
import { resetMcpCache } from "./mcp";
import { itemDto, proposalFields } from "./projects";
import { resetProxyCache } from "./proxy";
import { resetWatch } from "./watch";

// ── a fake Fountain ──────────────────────────────────────────────────────

interface FakeConv {
  id: string;
  channel_id: string | null;
  title: string | null;
  agent_id: string | null;
  environment_id: string | null;
  vault_id: string | null;
  sandbox_id: string | null;
  status: string;
  inserted_at: string;
  turn_count?: number;
  usage_total?: { input: number; output: number };
  last_active_at?: string | null;
  /** Fountain's own: `last_active_at` is later than `last_read_at`. What the feed is built on. */
  unread?: boolean;
}

/** What `GET /api/conversations/:id/turns` answers, per conversation id. */
interface FakeTurn {
  id: string;
  turn_number: number;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  usage?: { input: number; output: number } | null;
}
const turnsOf: Record<string, FakeTurn[]> = {};
/** Every conversation the server asked turns for, in order — the fan-out, made visible. */
let turnsAsked: string[] = [];
/** A conversation id in here makes the turns endpoint fail, the way one dead row should not fail a page. */
const turnsBroken = new Set<string>();

const KEYS: Record<string, { id: string; email: string }> = {
  "key-alice": { id: "u-alice", email: "Alice@Example.com" },
  "key-bob": { id: "u-bob", email: "bob@example.com" },
  "key-carol": { id: "u-carol", email: "carol@example.com" },
  // A real Fountain account that has never signed in to the workbench.
  "key-dave": { id: "u-dave", email: "dave@example.com" },
};

interface FakeHit {
  kind: "title" | "prompt" | "reply";
  conversation_id: string;
  agent_id: string | null;
  turn_id: string | null;
  turn_number: number | null;
  snippet: string;
  ts: string;
}

const convs: Record<string, FakeConv[]> = { "key-alice": [], "key-bob": [], "key-carol": [], "key-dave": [] };
/** What `GET /api/search` has to offer, per key, before `q` and paging are applied. */
const hits: Record<string, FakeHit[]> = { "key-alice": [], "key-bob": [], "key-carol": [], "key-dave": [] };
/** Every search the fake was asked for, to see what the proxy actually sent. */
const searched: { key: string; q: string; limit: string | null; offset: string | null; conversation_id: string[] }[] = [];
const posted: { key: string; body: Record<string, unknown> }[] = [];
/** Prompt bodies this fake was sent, in order. */
const prompted: { prompt?: string; images?: unknown[] }[] = [];
/** Conversations this fake was asked to terminate; one whose id starts with `stuck` refuses. */
const terminated: string[] = [];
/** Every disk read (files, file, diff) this fake was asked for, and with what query. */
const diskAsked: { id: string; what: string; query: string }[] = [];
/** Permission answers this fake accepted. A second one for the same request is too late. */
const answers: { conversation: string; request: string; option_id: unknown }[] = [];
let streamEvents: { conversation_id: string; id: number }[] = [];
/**
 * Stage events per conversation, oldest first — what
 * `GET /api/conversations/:id/events?streams=stage` answers, and what the
 * user-wide `?streams=stage` stream replays. A held permission request lives
 * only here: it is on no conversation record, which is the whole reason
 * server/watch.ts exists.
 */
const stageEvents: Record<string, { id: number; stage: string; state: string | null; ts: string; data: Record<string, unknown> }[]> = {};
/** Every conversation whose history the server read, in order — the fan-out, made visible. */
let historyAsked: string[] = [];

function stageRow(conversationId: string, ev: { id: number; stage: string; state: string | null; ts: string; data: Record<string, unknown> }) {
  return { id: ev.id, conversation_id: conversationId, kind: "stage", stream: "", stage: ev.stage, state: ev.state, data: JSON.stringify(ev.data), ts: ev.ts, turn_id: "t1" };
}

/** A `request · started` and, optionally, the close that resolved it. */
function ask(conversationId: string, id: number, requestId: string, tool: string, at: string, closedBy?: string): void {
  const rows = (stageEvents[conversationId] ??= []);
  rows.push({ id, stage: "request", state: "started", ts: at, data: { request_id: requestId, tool, options: [{ optionId: "o-once", kind: "allow_once" }], timeout_ms: 5 * 60 * 1000 } });
  if (closedBy) rows.push({ id: id + 1, stage: "request", state: "done", ts: at, data: { request_id: requestId, outcome: closedBy } });
}
/** An instance with billing switched off answers 404 there; flip this to be one. */
let billingEnabled = true;
/**
 * Keys the egress broker is on for. Fountain's own rule: off, the bindings
 * routes answer 404 `brokerage_not_enabled` and a conversation's egress page
 * is `brokered: false` with nothing asked of the broker.
 */
const brokered = new Set<string>();
/** The broker's log per conversation, newest first, as `GET /api/conversations/:id/egress` pages it. */
const egressOf: Record<string, { id: number; host: string; path: string; method: string; service: string | null; credential_keys: string[]; status: number | null; error: string | null }[]> = {};
/** Every egress read the fake was asked for, with the paging it was sent. */
const egressAsked: { id: string; limit: string | null; before: string | null }[] = [];
/**
 * The fake's billing period, anchored to now rather than written out: the
 * per-period cost route measures against the wall clock (a turn still running
 * accrues only as far as *now*), so a hard-coded month would pass today and
 * fail next year.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
/** One instant every relative timestamp in these tests is measured from, so the arithmetic is exact. */
const NOW = Date.now();
const PERIOD_START = new Date(NOW - 10 * DAY_MS).toISOString();
const PERIOD_END = new Date(NOW + 20 * DAY_MS).toISOString();

function whose(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? "";
  const key = auth.replace(/^Bearer /, "");
  return KEYS[key] ? key : null;
}

const fountain = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const key = whose(req);
    if (!key) return Response.json({ error: "unauthorized" }, { status: 401 });
    const path = url.pathname;
    if (path === "/api/auth/me") return Response.json(KEYS[key]);
    if (path === "/api/conversations" && req.method === "GET") return Response.json({ data: convs[key] });
    if (path === "/api/conversations" && req.method === "POST") {
      const body = (await req.json()) as Record<string, unknown>;
      posted.push({ key, body });
      const c: FakeConv = {
        id: `new-${posted.length}`,
        channel_id: (body.channel_id as string) ?? null,
        title: (body.title as string) ?? null,
        agent_id: (body.agent_id as string) ?? null,
        environment_id: (body.environment_id as string) ?? null,
        vault_id: (body.vault_id as string) ?? null,
        sandbox_id: (body.sandbox_id as string) ?? "sb-new",
        status: "pending",
        inserted_at: "2026-08-23T00:00:00Z",
      };
      convs[key]!.push(c);
      return Response.json({ data: c }, { status: 201 });
    }
    const one = /^\/api\/conversations\/([^/]+)(\/.*)?$/.exec(path);
    if (one) {
      const c = convs[key]!.find((x) => x.id === one[1]);
      if (!c) return Response.json({ error: "not_found" }, { status: 404 });
      if (!one[2]) return Response.json({ data: c });
      if (one[2] === "/egress") {
        egressAsked.push({ id: c.id, limit: url.searchParams.get("limit"), before: url.searchParams.get("before") });
        if (!brokered.has(key)) return Response.json({ data: [], next: null, brokered: false });
        if (c.id.startsWith("stuck")) return Response.json({ error: "broker_unavailable", message: "{:broker, :request_log, :econnrefused}" }, { status: 502 });
        const before = Number(url.searchParams.get("before") ?? Infinity);
        const limit = Number(url.searchParams.get("limit") ?? 100);
        const page = (egressOf[c.id] ?? []).filter((e) => e.id < before).slice(0, limit);
        const more = (egressOf[c.id] ?? []).some((e) => e.id < (page[page.length - 1]?.id ?? Infinity));
        return Response.json({ data: page, next: more ? page[page.length - 1]!.id : null, brokered: true });
      }
      if (one[2] === "/turns") {
        turnsAsked.push(c.id);
        if (turnsBroken.has(c.id)) return Response.json({ error: "boom" }, { status: 500 });
        const own = turnsOf[c.id];
        if (own) return Response.json({ data: own });
        return Response.json({ data: [{ id: "t1", prompt: "hi", image_count: 1 }] });
      }
      if (one[2] === "/events") {
        historyAsked.push(c.id);
        const after = Number(url.searchParams.get("after") ?? 0);
        const rows = (stageEvents[c.id] ?? []).filter((e) => e.id > after).map((e) => stageRow(c.id, e));
        return Response.json({ data: rows, meta: { next_cursor: rows[rows.length - 1]?.id ?? after } });
      }
      if (one[2] === "/prompts") {
        const body = (await req.json()) as { prompt?: string; images?: unknown[] };
        prompted.push(body);
        return Response.json({ data: { ok: true, prompt: body.prompt, images: body.images?.length ?? 0 } }, { status: 202 });
      }
      if (/^\/turns\/[^/]+\/images\/\d+$/.test(one[2])) return new Response("PNG-BYTES", { headers: { "content-type": "image/png" } });
      const ask = /^\/requests\/([^/]+)$/.exec(one[2]);
      if (ask && req.method === "POST") {
        const request = ask[1]!;
        const { option_id } = (await req.json()) as { option_id?: unknown };
        // Fountain's own rules: the first answer wins, and an option the
        // runtime did not offer is refused rather than forwarded.
        if (answers.some((a) => a.request === request)) return Response.json({ error: "permission_request_resolved" }, { status: 409 });
        if (option_id !== "o-once" && option_id !== "o-no") return Response.json({ error: "unknown_option", message: "option_id was not offered for this request" }, { status: 422 });
        answers.push({ conversation: c.id, request, option_id });
        return Response.json({ ok: true });
      }
      if (one[2] === "/terminate") {
        if (c.id.startsWith("stuck")) return Response.json({ error: "boom" }, { status: 500 });
        terminated.push(c.id);
        c.status = "terminated";
        return new Response(null, { status: 204 });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const sb = /^\/api\/sandboxes\/([^/]+)(\/(files|file|diff))?$/.exec(path);
    if (sb) {
      const on = convs[key]!.filter((c) => c.sandbox_id === sb[1]);
      if (on.length === 0) return Response.json({ error: "not_found" }, { status: 404 });
      if (sb[3]) {
        // The disk reads of ADR 0039, full scope only: what was asked is recorded, the answer is canned.
        diskAsked.push({ id: sb[1]!, what: sb[3], query: url.search });
        const p = url.searchParams.get("path") ?? "/home/sprite";
        if (!p.startsWith("/home/sprite")) return Response.json({ error: "path_outside_sandbox" }, { status: 422 });
        if (sb[3] === "diff") return Response.json({ data: { diff: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n", path: p, ref: url.searchParams.get("ref"), repo_root: p, staged: url.searchParams.get("staged") === "true", truncated: false } });
        if (sb[3] === "files") return Response.json({ data: { path: p, entries: [{ name: "thing", type: "directory", size: 0 }], truncated: false } });
        return Response.json({ data: { path: p, content: "hello\n", encoding: "utf-8", size: 6, truncated: false } });
      }
      return Response.json({ data: { id: sb[1], sprite_name: `sprite-${sb[1]}`, status: "ready", conversations: on.map((c) => ({ id: c.id, status: c.status, mid_turn: false })) } });
    }
    if (path === "/api/search") {
      const q = url.searchParams.get("q") ?? "";
      // Fountain refuses a blank query, and the whole account is the scope
      // unless `conversation_id` narrows it — the thing the proxy has to fix.
      if (!q.trim()) return Response.json({ error: "bad_query" }, { status: 400 });
      const only = url.searchParams.getAll("conversation_id");
      searched.push({ key, q, limit: url.searchParams.get("limit"), offset: url.searchParams.get("offset"), conversation_id: only });
      const limit = Number(url.searchParams.get("limit") ?? 20);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      // Repeated params: Phoenix reads the last, which is what makes forwarding the raw query wrong.
      // `q=leaky` is a Fountain that ignores the scoping it was asked for.
      const narrow = q === "leaky" || !only.length ? null : only[only.length - 1];
      const all = (hits[key] ?? []).filter((h) => h.snippet.includes(q) && (!narrow || h.conversation_id === narrow));
      return Response.json({ data: all.slice(offset, offset + limit), meta: { limit, offset, has_more: offset + limit < all.length } });
    }
    if (path === "/api/account/billing") {
      if (!billingEnabled) return Response.json({ error: "not_found", billing: "disabled" }, { status: 404 });
      return Response.json({
        data: {
          status: "active",
          period: { start: PERIOD_START, end: PERIOD_END, source: "subscription" },
          plan: { name: "Team", slug: "team", monthly_cents: 9900, included_turn_hours: 100 },
          usage: { conversations: 12, turns: 40, turn_hours: 7.5, turn_hours_included: 100, turn_hours_remaining: 92.5, sandbox_minutes: 900 },
        },
      });
    }
    if (path === "/api/agents")
      return Response.json({
        data: [
          {
            id: "a1",
            name: "Coder",
            // Fountain renders `mcp_servers` whole, credentials and all — the
            // README's own worked example puts a Fountain key in `headers`.
            mcp_servers: {
              gh: { command: "gh-mcp", args: ["--repo", "acme/thing"], env: { GITHUB_TOKEN: "ghp_supersecret", GH_HOST: "github.com" } },
              workbench: { type: "http", url: "https://fountain-workbench.demo.managoat.com/mcp", headers: { Authorization: "Bearer ftn_supersecret" } },
              acp: { command: "x", env: [{ name: "TOKEN", value: "ftn_supersecret" }] },
              odd: "not a map",
            },
            skills: [
              { name: "house-style", content: "# House style" },
              { name: "deploy", source: "acme/skills", ref: "v2" },
            ],
            system: "You are Coder. The staging password is hunter2.",
            metadata: { team: "platform" },
          },
        ],
      });
    if (path === "/api/environments") return Response.json({ data: [{ id: "e1", name: "one" }, { id: "e2", name: "two" }] });
    if (path === "/api/vaults") return Response.json({ data: [{ id: "v1", name: "v-one" }, { id: "v2", name: "v-two" }] });
    // Secrets are names only, as on Fountain itself; a parent that is not there is 404.
    if (path === "/api/environments/e1/secrets") return Response.json({ data: [{ id: "s1", key: "GITHUB_TOKEN", environment_id: "e1" }, { id: "s2", key: "STRIPE_SECRET_KEY", environment_id: "e1" }, { id: "s3", key: "BUZZ_PRIVATE_KEY", environment_id: "e1" }] });
    if (path === "/api/vaults/v1/secrets") return Response.json({ data: [{ id: "s4", key: "STRIPE_SECRET_KEY", vault_id: "v1" }, { id: "s5", key: "OPENAI_API_KEY", vault_id: "v1" }] });
    if (/^\/api\/(environments|vaults)\/[^/]+\/secrets$/.test(path)) return Response.json({ error: "not_found" }, { status: 404 });
    if (path === "/api/secret-bindings") {
      if (!brokered.has(key)) return Response.json({ error: "brokerage_not_enabled", message: "Egress credential brokerage is not enabled for this account." }, { status: 404 });
      return Response.json({
        data: [
          { id: "b1", key: "STRIPE_SECRET_KEY", host: "api.stripe.com", auth_type: "bearer", headers: {}, enabled: true, created_at: "2026-08-25T00:00:00Z", updated_at: "2026-08-25T00:00:00Z" },
          { id: "b2", key: "OPENAI_API_KEY", host: "api.openai.com", auth_type: "substitute", headers: {}, enabled: false, created_at: "2026-08-25T00:00:00Z", updated_at: "2026-08-25T00:00:00Z" },
          { id: "b3", key: "STRIPE_SECRET_KEY", host: "files.stripe.com", auth_type: "custom", headers: { "X-Api-Key": "{{ STRIPE_SECRET_KEY }}" }, enabled: true, created_at: "2026-08-25T00:00:00Z", updated_at: "2026-08-25T00:00:00Z" },
        ],
      });
    }
    if (path === "/api/events/stream") {
      // `?streams=stage` is what server/watch.ts follows: every conversation
      // of this key, its stage events only, resumable on `Last-Event-ID`.
      if (url.searchParams.get("streams") === "stage") {
        const since = Number(req.headers.get("last-event-id") ?? 0);
        const rows = (convs[key] ?? [])
          .flatMap((c) => (stageEvents[c.id] ?? []).map((e) => ({ id: e.id, chunk: stageRow(c.id, e) })))
          .filter((r) => r.id > since)
          .sort((a, b) => a.id - b.id);
        const parts = [": connected\n\n", ...rows.map((r) => `id: ${r.id}\nevent: stage\ndata: ${JSON.stringify(r.chunk)}\n\n`), ": heartbeat\n\n"];
        return new Response(parts.join(""), { headers: { "content-type": "text/event-stream" } });
      }
      const parts = [": connected\n\n"];
      for (const ev of streamEvents) parts.push(`id: ${ev.id}\nevent: output\ndata: ${JSON.stringify({ ...ev, kind: "output" })}\n\n`);
      parts.push(`event: conversations\ndata: {"reason":"changed"}\n\n`);
      parts.push(": heartbeat\n\n");
      return new Response(parts.join(""), { headers: { "content-type": "text/event-stream" } });
    }
    return Response.json({ error: "not_found", path }, { status: 404 });
  },
});

// ── the app under test ───────────────────────────────────────────────────

let db: Db;
let app: (req: Request) => Promise<Response>;
let events: ProjectEvents;

beforeAll(async () => {
  db = new Db(":memory:");
  events = new ProjectEvents();
  const config: Config = {
    fountainUrl: `http://localhost:${fountain.port}`,
    dataDir: "/nonexistent",
    dbPath: ":memory:",
    secret: "a-test-secret-long-enough",
    port: 0,
    staticDir: null,
    sessionMaxAgeMs: 1000 * 60,
  };
  app = buildApp({ db, cipher: await Cipher.from(config.secret), config, events });
});

afterAll(() => {
  resetWatch();
  fountain.stop(true);
  db.close();
});

beforeEach(() => {
  resetProxyCache();
  resetMcpCache();
  resetCostCache();
  // Every test starts with nothing folded and no stream open: what one test
  // learned off the stage stream must not be another test's answer.
  resetWatch();
  turnsAsked = [];
  historyAsked = [];
});

const cookies: Record<string, string> = {};

async function call(who: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const h: Record<string, string> = { ...headers };
  if (who) h.cookie = cookies[who]!;
  if (body !== undefined) h["content-type"] = "application/json";
  return app(new Request(`http://wb.test${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }));
}

/**
 * Ask until it is true, or give up. For the one thing here that is not
 * request/response: the stage stream is followed in the background, so a fact
 * that arrives on it arrives a moment after the survey that started it.
 */
async function until<T>(f: () => Promise<T | null | undefined>, ms = 3000): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function signIn(who: string): Promise<Response> {
  const res = await call(null, "POST", "/api/session", { apiKey: `key-${who}` });
  const sc = res.headers.get("set-cookie");
  if (sc) cookies[who] = sc.split(";")[0]!;
  return res;
}

describe("sign-in", () => {
  test("a bad key is refused", async () => {
    const res = await call(null, "POST", "/api/session", { apiKey: "nope" });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("bad_key");
  });

  test("a good key becomes a session; the email is what Fountain said, lower-cased", async () => {
    const res = await signIn("alice");
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/^wb_session=.*HttpOnly/);
    const me = await (await call("alice", "GET", "/api/me")).json();
    expect(me.email).toBe("alice@example.com");
    await signIn("bob");
    await signIn("carol");
  });

  test("no cookie, no access", async () => {
    expect((await call(null, "GET", "/api/projects")).status).toBe(401);
  });

  test("the key is stored encrypted", () => {
    const row = db.getUser("alice@example.com")!;
    expect(row.key_enc).not.toContain("key-alice");
    expect(row.key_enc.startsWith("v1.")).toBe(true);
  });

  test("signing out ends the session but keeps the key", async () => {
    await signIn("carol");
    const saved = cookies.carol!;
    expect((await call("carol", "DELETE", "/api/session")).status).toBe(200);
    expect((await app(new Request("http://wb.test/api/me", { headers: { cookie: saved } }))).status).toBe(401);
    expect(db.getUser("carol@example.com")).not.toBeNull();
    await signIn("carol");
  });
});

let projectId = "";
let itemId = "";

describe("projects and sharing", () => {
  test("alice creates a project and owns it", async () => {
    const res = await call("alice", "POST", "/api/projects", { name: "Fountain", environmentId: "e1", vaultId: "v1" });
    expect(res.status).toBe(201);
    const p = (await res.json()).data;
    projectId = p.id;
    expect(p.role).toBe("owner");
    expect(p.ownerEmail).toBe("alice@example.com");
  });

  test("bob does not see it until he is added", async () => {
    expect((await call("bob", "GET", `/api/projects/${projectId}`)).status).toBe(404);
    const add = await call("alice", "POST", `/api/projects/${projectId}/members`, { email: "Bob@example.com" });
    expect(add.status).toBe(200);
    expect((await add.json()).data.members.map((m: { email: string }) => m.email)).toEqual(["bob@example.com"]);
    const list = (await (await call("bob", "GET", "/api/projects")).json()).data;
    expect(list).toHaveLength(1);
    expect(list[0].role).toBe("member");
  });

  test("only the owner changes settings, shares, or deletes", async () => {
    expect((await call("bob", "PATCH", `/api/projects/${projectId}`, { name: "x" })).status).toBe(403);
    expect((await call("bob", "POST", `/api/projects/${projectId}/members`, { email: "carol@example.com" })).status).toBe(403);
    expect((await call("bob", "DELETE", `/api/projects/${projectId}`)).status).toBe(403);
    expect((await call("carol", "PATCH", `/api/projects/${projectId}`, { name: "x" })).status).toBe(404);
    const ok = await call("alice", "PATCH", `/api/projects/${projectId}`, { name: "Fountain!" });
    expect((await ok.json()).data.name).toBe("Fountain!");
  });

  test("the owner sets who new work starts with; a member reads it but cannot set it", async () => {
    const before = (await (await call("alice", "GET", `/api/projects/${projectId}`)).json()).data.project;
    expect(before.defaultAgentId).toBeNull();
    expect((await call("bob", "PATCH", `/api/projects/${projectId}`, { defaultAgentId: "a1" })).status).toBe(403);
    const set = await call("alice", "PATCH", `/api/projects/${projectId}`, { defaultAgentId: "a1" });
    expect((await set.json()).data.defaultAgentId).toBe("a1");
    // The member's explorer needs it: it is who their Enter starts.
    const forBob = (await (await call("bob", "GET", `/api/projects/${projectId}`)).json()).data.project;
    expect(forBob.defaultAgentId).toBe("a1");
    const cleared = await call("alice", "PATCH", `/api/projects/${projectId}`, { defaultAgentId: null });
    expect((await cleared.json()).data.defaultAgentId).toBeNull();
    // Another setting on its own leaves it alone.
    await call("alice", "PATCH", `/api/projects/${projectId}`, { defaultAgentId: "a1" });
    await call("alice", "PATCH", `/api/projects/${projectId}`, { notes: "github.com/x/y" });
    expect((await (await call("alice", "GET", `/api/projects/${projectId}`)).json()).data.project.defaultAgentId).toBe("a1");
    await call("alice", "PATCH", `/api/projects/${projectId}`, { defaultAgentId: null, notes: "" });
  });

  test("a project is created with a default teammate, so the first item is not the slow path", async () => {
    // The create-project form offers it beside the environment and vault; the
    // whole point is not having to make the project, find Settings & sharing
    // and come back. Which means POST has to take it, not just PATCH.
    const res = await call("alice", "POST", "/api/projects", { name: "With a default", environmentId: "e1", vaultId: "v1", defaultAgentId: "a1" });
    expect(res.status).toBe(201);
    const created = (await res.json()).data;
    expect(created.defaultAgentId).toBe("a1");
    // And it is stored, not just echoed.
    const shown = (await (await call("alice", "GET", `/api/projects/${created.id}`)).json()).data.project;
    expect(shown.defaultAgentId).toBe("a1");
    // Omitted is none, and so is a blank: "ask every time" stays the default default.
    const without = (await (await call("alice", "POST", "/api/projects", { name: "Without" })).json()).data;
    expect(without.defaultAgentId).toBeNull();
    const blank = (await (await call("alice", "POST", "/api/projects", { name: "Blank", defaultAgentId: "" })).json()).data;
    expect(blank.defaultAgentId).toBeNull();
    for (const id of [created.id, without.id, blank.id]) await call("alice", "DELETE", `/api/projects/${id}`);
  });

  test("your own resources include your agents, under the rules that hold for everyone", async () => {
    // The create form has no project to ask `/f/<project>/api/agents` through,
    // so the agents come out on this route — and it is the second route out of
    // Fountain's agent rendering, so it gets the same roleless rules and not a
    // subset of them.
    const res = await call("alice", "GET", "/api/me/resources");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("supersecret");
    // Nor the SKILL.md body: nothing on either route renders one, and this
    // page is a list of names that reloads on every visit.
    expect(text).not.toContain("# House style");
    type Skill = { name: string; content?: unknown; source?: string; ref?: string };
    const r = JSON.parse(text).data as {
      environments: { id: string }[];
      vaults: { id: string }[];
      agents: { id: string; mcp_servers: Record<string, { env?: unknown; headers?: unknown }>; skills: Skill[]; system?: unknown; metadata?: unknown }[];
    };
    expect(r.environments.map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(r.vaults.map((v) => v.id)).toEqual(["v1", "v2"]);
    expect(r.agents.map((a) => a.id)).toEqual(["a1"]);
    const a = r.agents[0]!;
    expect(a.mcp_servers.gh!.env).toEqual({ GITHUB_TOKEN: "[withheld by the workbench]", GH_HOST: "[withheld by the workbench]" });
    expect(a.mcp_servers.workbench!.headers).toEqual({ Authorization: "[withheld by the workbench]" });
    // The names stay, and so does what tells an inline skill from a github one.
    expect(a.skills).toEqual([
      { name: "house-style", content: "[withheld by the workbench]" },
      { name: "deploy", source: "acme/skills", ref: "v2" },
    ]);
    // The third rule is the one with a role in it, and this is the owner
    // asking about their own account: their prose is theirs.
    expect(a.system).toBe("You are Coder. The staging password is hunter2.");
    expect(a.metadata).toEqual({ team: "platform" });
  });

  test("a member creates items the owner sees", async () => {
    const res = await call("bob", "POST", `/api/projects/${projectId}/items`, { title: "fix foo", notes: "repro…" });
    expect(res.status).toBe(201);
    itemId = (await res.json()).data.id;
    const shown = (await (await call("alice", "GET", `/api/projects/${projectId}`)).json()).data;
    expect(shown.items.map((w: { id: string }) => w.id)).toEqual([itemId]);
    expect(shown.project.counts).toEqual({ open: 1, done: 0, wont: 0, icebox: 0 });
  });

  test("changes are pushed to the project's streams", async () => {
    const got: unknown[] = [];
    const off = events.subscribe(projectId, (d) => got.push(d));
    await call("bob", "PATCH", `/api/projects/${projectId}/items/${itemId}`, { status: "done" });
    off();
    expect(got).toEqual([{ kind: "items" }]);
    await call("bob", "PATCH", `/api/projects/${projectId}/items/${itemId}`, { status: "open" });
  });

  test("a member can leave; a member cannot remove another", async () => {
    await call("alice", "POST", `/api/projects/${projectId}/members`, { email: "carol@example.com" });
    expect((await call("bob", "DELETE", `/api/projects/${projectId}/members/carol%40example.com`)).status).toBe(403);
    expect((await call("carol", "DELETE", `/api/projects/${projectId}/members/carol%40example.com`)).status).toBe(200);
    expect((await call("carol", "GET", `/api/projects/${projectId}`)).status).toBe(404);
  });
});

describe("the project-scoped proxy", () => {
  beforeAll(() => {
    convs["key-alice"] = [
      { id: "c1", channel_id: `workbench:${projectId}/${itemId}`, title: "Coder: fix foo", agent_id: "a1", environment_id: "e1", vault_id: "v1", sandbox_id: "sb1", status: "running", inserted_at: "2026-08-23T00:00:00Z" },
      { id: "c2", channel_id: "fountain:team", title: "private", agent_id: "a1", environment_id: null, vault_id: null, sandbox_id: "sb2", status: "idle", inserted_at: "2026-08-23T00:00:00Z" },
      { id: "c3", channel_id: "workbench:otherproj/item9", title: "Coder: elsewhere", agent_id: "a1", environment_id: "e2", vault_id: null, sandbox_id: "sb3", status: "idle", inserted_at: "2026-08-23T00:00:00Z" },
    ];
    convs["key-bob"] = [{ id: "b1", channel_id: "fountain:team", title: "bob's own", agent_id: "a9", environment_id: null, vault_id: null, sandbox_id: null, status: "idle", inserted_at: "2026-08-23T00:00:00Z" }];
  });

  test("a member lists only the project's conversations — on the owner's key", async () => {
    const res = await call("bob", "GET", `/f/${projectId}/api/conversations?roots_only=true`);
    expect(res.status).toBe(200);
    const ids = ((await res.json()).data as { id: string }[]).map((c) => c.id);
    expect(ids).toEqual(["c1"]);
  });

  test("listing folds teammates the conversations ran into the items", async () => {
    const shown = (await (await call("bob", "GET", `/api/projects/${projectId}`)).json()).data;
    expect(shown.items[0].agentIds).toEqual(["a1"]);
  });

  test("a conversation outside the project is not there, whatever the id", async () => {
    expect((await call("bob", "GET", `/f/${projectId}/api/conversations/c1`)).status).toBe(200);
    expect((await call("bob", "GET", `/f/${projectId}/api/conversations/c2`)).status).toBe(404);
    expect((await call("bob", "GET", `/f/${projectId}/api/conversations/c3`)).status).toBe(404);
    expect((await call("bob", "GET", `/f/${projectId}/api/conversations/c1/turns`)).status).toBe(200);
    expect((await call("bob", "GET", `/f/${projectId}/api/conversations/c2/turns`)).status).toBe(404);
  });

  test("a non-member gets nothing at all", async () => {
    expect((await call("carol", "GET", `/f/${projectId}/api/conversations`)).status).toBe(404);
    expect((await call(null, "GET", `/f/${projectId}/api/conversations`)).status).toBe(401);
  });

  test("a member sees the project's environment and vault, the owner sees all", async () => {
    const forBob = (await (await call("bob", "GET", `/f/${projectId}/api/environments`)).json()).data;
    expect(forBob.map((e: { id: string }) => e.id)).toEqual(["e1"]);
    const forAlice = (await (await call("alice", "GET", `/f/${projectId}/api/environments`)).json()).data;
    expect(forAlice).toHaveLength(2);
    const vaultsForBob = (await (await call("bob", "GET", `/f/${projectId}/api/vaults`)).json()).data;
    expect(vaultsForBob.map((v: { id: string }) => v.id)).toEqual(["v1"]);
  });

  test("starting a conversation: the channel must be an item here, and the computer is the project's", async () => {
    const bad = await call("bob", "POST", `/f/${projectId}/api/conversations`, { agent_id: "a1", channel_id: "workbench:otherproj/item9" });
    expect(bad.status).toBe(422);
    const res = await call("bob", "POST", `/f/${projectId}/api/conversations`, {
      agent_id: "a2",
      channel_id: `workbench:${projectId}/${itemId}`,
      environment_id: "e2",
      vault_id: "v2",
      prompt: "go",
    });
    expect(res.status).toBe(201);
    const sent = posted[posted.length - 1]!;
    expect(sent.key).toBe("key-alice");
    // Its own channel on the item — never the item's bare channel, which a second conversation would take over.
    expect(sent.body.channel_id).toMatch(new RegExp(`^workbench:${projectId}/${itemId}/[0-9a-f]{12}$`));
    expect(sent.body.environment_id).toBe("e1");
    expect(sent.body.vault_id).toBe("v1");
    expect(sent.body.prompt).toBe("go");
    expect(sent.body.fresh).toBe(true);
    const shown = (await (await call("bob", "GET", `/api/projects/${projectId}`)).json()).data;
    expect(shown.items[0].agentIds).toEqual(["a1", "a2"]);
  });

  test("a new item can be started on in the same breath, and the teammate lands on it", async () => {
    // What the new-work-item form does in one submit: create, then start on it.
    const fresh = (await (await call("bob", "POST", `/api/projects/${projectId}/items`, { title: "ship bar", notes: "bar is slow" })).json()).data.id;
    const res = await call("bob", "POST", `/f/${projectId}/api/conversations`, {
      agent_id: "a7",
      channel_id: `workbench:${projectId}/${fresh}`,
      prompt: "Work item: ship bar\n\nbar is slow",
    });
    expect(res.status).toBe(201);
    const shown = (await (await call("bob", "GET", `/api/projects/${projectId}`)).json()).data;
    expect(shown.items.find((w: { id: string }) => w.id === fresh).agentIds).toEqual(["a7"]);
    expect(posted[posted.length - 1]!.body.prompt).toBe("Work item: ship bar\n\nbar is slow");
  });

  test("joining a computer: only one of the project's, with the same teammate, from the same work item", async () => {
    const otherItem = (await (await call("bob", "POST", `/api/projects/${projectId}/items`, { title: "elsewhere" })).json()).data.id;
    const crossItem = await call("bob", "POST", `/f/${projectId}/api/conversations`, { agent_id: "a1", channel_id: `workbench:${projectId}/${otherItem}`, sandbox_id: "sb1" });
    expect(crossItem.status).toBe(422);
    expect((await crossItem.json()).error).toBe("item_mismatch");
    const other = await call("bob", "POST", `/f/${projectId}/api/conversations`, { agent_id: "a1", channel_id: `workbench:${projectId}/${itemId}`, sandbox_id: "sb2" });
    expect(other.status).toBe(404);
    const mismatch = await call("bob", "POST", `/f/${projectId}/api/conversations`, { agent_id: "a2", channel_id: `workbench:${projectId}/${itemId}`, sandbox_id: "sb1" });
    expect(mismatch.status).toBe(422);
    const ok = await call("bob", "POST", `/f/${projectId}/api/conversations`, { agent_id: "a1", channel_id: `workbench:${projectId}/${itemId}`, sandbox_id: "sb1" });
    expect(ok.status).toBe(201);
    expect(posted[posted.length - 1]!.body.sandbox_id).toBe("sb1");
  });

  test("prompts are forwarded with their body", async () => {
    const res = await call("bob", "POST", `/f/${projectId}/api/conversations/c1/prompts`, { prompt: "more" });
    expect(res.status).toBe(202);
    expect((await res.json()).data.prompt).toBe("more");
  });

  test("a prompt carries its images through, and they must be ones Fountain would store", async () => {
    const png = { data: Buffer.alloc(64, 1).toString("base64"), media_type: "image/png" };
    const res = await call("bob", "POST", `/f/${projectId}/api/conversations/c1/prompts`, { prompt: "here is what it looks like", images: [png] });
    expect(res.status).toBe(202);
    expect((await res.json()).data.images).toBe(1);
    const sent = prompted[prompted.length - 1]!;
    expect(sent.prompt).toBe("here is what it looks like");
    expect(sent.images).toEqual([png]);

    const before = prompted.length;
    const bad = await call("bob", "POST", `/f/${projectId}/api/conversations/c1/prompts`, { prompt: "x", images: [{ ...png, media_type: "image/bmp" }] });
    expect(bad.status).toBe(422);
    expect((await bad.json()).error).toBe("bad_images");
    const huge = await call("bob", "POST", `/f/${projectId}/api/conversations/c1/prompts`, {
      prompt: "x",
      images: [{ data: "A".repeat(4 * Math.ceil((10 * 1024 * 1024 + 1) / 3)), media_type: "image/png" }],
    });
    expect(huge.status).toBe(422);
    const mangled = await call("bob", "POST", `/f/${projectId}/api/conversations/c1/prompts`, { prompt: "x", images: [{ data: "data:image/png;base64,aGk=", media_type: "image/png" }] });
    expect(mangled.status).toBe(422);
    // None of the three reached Fountain on the owner's key.
    expect(prompted).toHaveLength(before);
  });

  test("starting a conversation takes images too, under the same rules", async () => {
    const png = { data: Buffer.alloc(32, 2).toString("base64"), media_type: "image/png" };
    const res = await call("bob", "POST", `/f/${projectId}/api/conversations`, {
      agent_id: "a1",
      channel_id: `workbench:${projectId}/${itemId}`,
      prompt: "fix this layout",
      images: [png],
    });
    expect(res.status).toBe(201);
    expect(posted[posted.length - 1]!.body.images).toEqual([png]);

    const before = posted.length;
    const bad = await call("bob", "POST", `/f/${projectId}/api/conversations`, {
      agent_id: "a1",
      channel_id: `workbench:${projectId}/${itemId}`,
      prompt: "fix this layout",
      images: [{ data: "not base64", media_type: "image/png" }],
    });
    expect(bad.status).toBe(422);
    expect((await bad.json()).error).toBe("bad_images");
    expect(posted).toHaveLength(before);
  });

  test("a member can answer a permission request the agent is held on", async () => {
    answers.length = 0;
    const res = await call("bob", "POST", `/f/${projectId}/api/conversations/c1/requests/req-1`, { option_id: "o-once" });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(answers).toEqual([{ conversation: "c1", request: "req-1", option_id: "o-once" }]);

    // The first answer wins, and the loser is told so rather than retried.
    const late = await call("alice", "POST", `/f/${projectId}/api/conversations/c1/requests/req-1`, { option_id: "o-no" });
    expect(late.status).toBe(409);
    expect((await late.json()).error).toBe("permission_request_resolved");
    expect(answers).toHaveLength(1);

    // An option Fountain says the runtime never offered comes back as itself.
    const made_up = await call("bob", "POST", `/f/${projectId}/api/conversations/c1/requests/req-2`, { option_id: "allow" });
    expect(made_up.status).toBe(422);
    expect((await made_up.json()).error).toBe("unknown_option");
  });

  test("a request on a conversation outside the project is not answerable at all", async () => {
    answers.length = 0;
    expect((await call("bob", "POST", `/f/${projectId}/api/conversations/c2/requests/req-1`, { option_id: "o-once" })).status).toBe(404);
    expect((await call("bob", "POST", `/f/${projectId}/api/conversations/c3/requests/req-1`, { option_id: "o-once" })).status).toBe(404);
    expect((await call("carol", "POST", `/f/${projectId}/api/conversations/c1/requests/req-1`, { option_id: "o-once" })).status).toBe(404);
    expect((await call(null, "POST", `/f/${projectId}/api/conversations/c1/requests/req-1`, { option_id: "o-once" })).status).toBe(401);
    // Nothing reached Fountain on the owner's key.
    expect(answers).toEqual([]);
  });

  test("a turn's image bytes come back through the project, and only for the project's conversations", async () => {
    const ok = await call("bob", "GET", `/f/${projectId}/api/conversations/c1/turns/t1/images/0`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(await ok.text()).toBe("PNG-BYTES");
    // Not one of this project's conversations, and not a route we invented.
    expect((await call("bob", "GET", `/f/${projectId}/api/conversations/c9/turns/t1/images/0`)).status).toBe(404);
    expect((await call("bob", "GET", `/f/${projectId}/api/conversations/c1/turns/t1/images/all`)).status).toBe(404);
  });

  test("a computer is the project's if a conversation of the project is on it", async () => {
    // sb1 hosts c1 (ours) — and, after the join above, a second conversation of ours.
    const ok = await call("bob", "GET", `/f/${projectId}/api/sandboxes/sb1`);
    expect(ok.status).toBe(200);
    const rec = (await ok.json()).data;
    expect(rec.sprite_name).toBe("sprite-sb1");
    expect(rec.conversations.map((c: { id: string }) => c.id)).toContain("c1");
    expect((await call("bob", "GET", `/f/${projectId}/api/sandboxes/sb2`)).status).toBe(404);
    expect((await call("bob", "GET", `/f/${projectId}/api/sandboxes/sb3`)).status).toBe(404);
    expect((await call("bob", "GET", `/f/${projectId}/api/sandboxes/nope`)).status).toBe(404);
  });

  test("a bodyless answer (terminate is 204) passes through", async () => {
    const res = await call("bob", "POST", `/f/${projectId}/api/conversations/c1/terminate`);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  test("an agent's MCP credentials are withheld, and the rest of its configuration is not", async () => {
    // The details panel lists what a teammate is plugged into, off this
    // route. `env` and `headers` are where a credential lives by design, so
    // the values go and the names stay — the owner's key must not reach a
    // member's browser just because a panel wanted the server's name.
    for (const who of ["alice", "bob"]) {
      const res = await call(who, "GET", `/f/${projectId}/api/agents`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain("supersecret");
      const [a] = (JSON.parse(text) as { data: { mcp_servers: Record<string, unknown>; skills: unknown[] }[] }).data;
      const mcp = a!.mcp_servers;
      const entry = (name: string) => mcp[name] as Record<string, unknown>;
      // Names kept, values gone — in the map shape and in the list shape both.
      expect(entry("gh").env).toEqual({ GITHUB_TOKEN: "[withheld by the workbench]", GH_HOST: "[withheld by the workbench]" });
      expect(entry("workbench").headers).toEqual({ Authorization: "[withheld by the workbench]" });
      expect(entry("acp").env).toEqual([{ name: "TOKEN", value: "[withheld by the workbench]" }]);
      // What the panel needs to say what is plugged in survives untouched.
      expect(entry("gh").command).toBe("gh-mcp");
      expect(entry("gh").args).toEqual(["--repo", "acme/thing"]);
      expect(entry("workbench").url).toBe("https://fountain-workbench.demo.managoat.com/mcp");
      expect(mcp.odd).toBe("not a map");
    }
  });

  test("a skill's body is withheld from everyone, and its name and source are not", async () => {
    // Nothing renders a SKILL.md body and this list is refetched on every
    // project mount, so the kilobytes go — for the owner too, since the weight
    // is the same in her browser. What the panel lists by survives.
    for (const who of ["alice", "bob"]) {
      const res = await call(who, "GET", `/f/${projectId}/api/agents`);
      const text = await res.text();
      expect(text).not.toContain("House style");
      const [a] = (JSON.parse(text) as { data: { skills: Record<string, unknown>[] }[] }).data;
      expect(a!.skills).toEqual([
        { name: "house-style", content: "[withheld by the workbench]" },
        { name: "deploy", source: "acme/skills", ref: "v2" },
      ]);
    }
  });

  test("a member does not get the owner's system prompts, and the owner does", async () => {
    // `/api/agents` is the owner's whole account, not this project's team, so
    // a member of one project would otherwise hold the standing instructions
    // of every agent alice has — wider than what sharing a project means.
    const member = await call("bob", "GET", `/f/${projectId}/api/agents`);
    const bobText = await member.text();
    expect(bobText).not.toContain("hunter2");
    const [forBob] = (JSON.parse(bobText) as { data: Record<string, unknown>[] }).data;
    expect(forBob!.system).toBe("[withheld by the workbench]");
    expect(forBob!.metadata).toBe("[withheld by the workbench]");
    // The teammate a picker has to show is all still there.
    expect(forBob!.id).toBe("a1");
    expect(forBob!.name).toBe("Coder");

    const owner = await call("alice", "GET", `/f/${projectId}/api/agents`);
    const [forAlice] = (JSON.parse(await owner.text()) as { data: Record<string, unknown>[] }).data;
    expect(forAlice!.system).toBe("You are Coder. The staging password is hunter2.");
    expect(forAlice!.metadata).toEqual({ team: "platform" });
  });

  test("a conversation's egress log comes through for a member, paged as asked, and only for the project's", async () => {
    brokered.add("key-alice");
    egressOf.c1 = [
      { id: 30, host: "api.stripe.com:443", path: "/v1/charges", method: "POST", service: "stripe-secret-key-api-stripe-com", credential_keys: ["STRIPE_SECRET_KEY"], status: 200, error: null },
      { id: 20, host: "evil.example:443", path: "/", method: "GET", service: null, credential_keys: [], status: 403, error: "no_match" },
      { id: 10, host: "api.github.com:443", path: "/repos/acme/thing", method: "GET", service: "github-api", credential_keys: ["GITHUB_TOKEN"], status: 200, error: null },
    ];
    try {
      const res = await call("bob", "GET", `/f/${projectId}/api/conversations/c1/egress?limit=2`);
      expect(res.status).toBe(200);
      const page = await res.json();
      expect(page.brokered).toBe(true);
      expect(page.data.map((e: { id: number }) => e.id)).toEqual([30, 20]);
      expect(page.next).toBe(20);
      expect(egressAsked.at(-1)).toEqual({ id: "c1", limit: "2", before: null });
      const rest = await (await call("bob", "GET", `/f/${projectId}/api/conversations/c1/egress?limit=2&before=20`)).json();
      expect(rest.data.map((e: { id: number }) => e.id)).toEqual([10]);
      expect(rest.next).toBeNull();
      // c3 is the owner's, but not this project's: as unreachable as anything else about it.
      expect((await call("bob", "GET", `/f/${projectId}/api/conversations/c3/egress`)).status).toBe(404);
    } finally {
      brokered.delete("key-alice");
      delete egressOf.c1;
    }
  });

  test("an unbrokered account's egress page says so, and a broker that is down is a 502 the browser can name", async () => {
    const off = await (await call("bob", "GET", `/f/${projectId}/api/conversations/c1/egress`)).json();
    expect(off).toEqual({ data: [], next: null, brokered: false });
    brokered.add("key-alice");
    convs["key-alice"]!.push({ id: "stuck-e", channel_id: `workbench:${projectId}/${itemId}`, title: null, agent_id: "a1", environment_id: "e1", vault_id: "v1", sandbox_id: null, status: "idle", inserted_at: "2026-08-23T00:00:00Z" });
    try {
      const res = await call("bob", "GET", `/f/${projectId}/api/conversations/stuck-e/egress`);
      expect(res.status).toBe(502);
      expect((await res.json()).error).toBe("broker_unavailable");
    } finally {
      brokered.delete("key-alice");
      convs["key-alice"] = convs["key-alice"]!.filter((c) => c.id !== "stuck-e");
    }
  });

  test("the rest of the API is closed", async () => {
    expect((await call("alice", "GET", `/f/${projectId}/api/auth/me`)).status).toBe(404);
    expect((await call("alice", "POST", `/f/${projectId}/api/agents`, {})).status).toBe(404);
    expect((await call("bob", "DELETE", `/f/${projectId}/api/conversations/c1`)).status).toBe(404);
  });

  test("the stream carries the project's events, the list notice, heartbeats — and workbench changes", async () => {
    streamEvents = [
      { conversation_id: "c1", id: 1 },
      { conversation_id: "c2", id: 2 },
      { conversation_id: "c3", id: 3 },
    ];
    const res = await call("bob", "GET", `/f/${projectId}/api/events/stream?streams=acp`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const text = await res.text();
    expect(text).toContain(": connected");
    expect(text).toContain(": heartbeat");
    expect(text).toContain('"conversation_id":"c1"');
    expect(text).not.toContain('"conversation_id":"c2"');
    expect(text).not.toContain('"conversation_id":"c3"');
    expect(text).toContain("event: conversations");
  });
});

describe("search across the project's conversations", () => {
  /** Alice's account: one conversation in the project, one personal, one in another project of hers. */
  beforeAll(() => {
    const conv = (id: string, channel: string | null): FakeConv => ({
      id,
      channel_id: channel,
      title: null,
      agent_id: "a1",
      environment_id: "e1",
      vault_id: "v1",
      sandbox_id: "sbS",
      status: "idle",
      inserted_at: "2026-08-23T00:00:00Z",
    });
    convs["key-alice"] = [conv("s1", `workbench:${projectId}/${itemId}/aaaaaaaaaaaa`), conv("s2", "fountain:team"), conv("s3", "workbench:otherproj/item9")];
    const hit = (conversation_id: string, kind: FakeHit["kind"], snippet: string, turn: number | null = null): FakeHit => ({
      kind,
      conversation_id,
      agent_id: "a1",
      turn_id: turn === null ? null : `t-${conversation_id}-${turn}`,
      turn_number: turn,
      snippet,
      ts: "2026-08-23T01:00:00Z",
    });
    hits["key-alice"] = [
      hit("s2", "reply", "needle — the salary review thread"),
      hit("s3", "title", "needle — another project of Alice's"),
      hit("s1", "reply", "needle — in this project", 3),
      hit("s2", "prompt", "needle — Alice's own notes", 1),
      hit("s1", "title", "needle — this project's conversation", null),
    ];
  });

  test("a member sees this project's hits and nothing else of the owner's", async () => {
    const res = await call("bob", "GET", `/f/${projectId}/api/search?q=needle`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: FakeHit[]; meta: { limit: number; offset: number; has_more: boolean } };
    expect(body.data.map((h) => h.conversation_id)).toEqual(["s1", "s1"]);
    // Not one word of the owner's other conversations came back with it.
    expect(JSON.stringify(body)).not.toContain("salary");
    expect(JSON.stringify(body)).not.toContain("another project");
    expect(body.meta.has_more).toBe(false);
    // The hit carries where to jump: the conversation, and the turn when there is one.
    expect(body.data[0]).toMatchObject({ kind: "reply", turn_id: "t-s1-3", turn_number: 3 });
  });

  test("the owner gets the same narrowing — a project is a project, whoever is asking", async () => {
    const body = (await (await call("alice", "GET", `/f/${projectId}/api/search?q=needle`)).json()) as { data: FakeHit[] };
    expect(body.data.map((h) => h.conversation_id)).toEqual(["s1", "s1"]);
  });

  test("limit and offset window this project's hits, not the owner's", async () => {
    const first = (await (await call("bob", "GET", `/f/${projectId}/api/search?q=needle&limit=1`)).json()) as { data: FakeHit[]; meta: { has_more: boolean } };
    expect(first.data).toHaveLength(1);
    expect(first.data[0]!.kind).toBe("reply");
    expect(first.meta.has_more).toBe(true);
    const second = (await (await call("bob", "GET", `/f/${projectId}/api/search?q=needle&limit=1&offset=1`)).json()) as { data: FakeHit[]; meta: { has_more: boolean } };
    expect(second.data[0]!.kind).toBe("title");
    expect(second.meta.has_more).toBe(false);
  });

  test("naming a conversation scopes the query at Fountain, and only for one of this project's", async () => {
    searched.length = 0;
    const ok = await call("bob", "GET", `/f/${projectId}/api/search?q=needle&conversation_id=s1`);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { data: FakeHit[] }).data.map((h) => h.conversation_id)).toEqual(["s1", "s1"]);
    expect(searched).toHaveLength(1);
    expect(searched[0]!.conversation_id).toEqual(["s1"]);
    // The owner's own, and another project's: not this project's to search.
    expect((await call("bob", "GET", `/f/${projectId}/api/search?q=needle&conversation_id=s2`)).status).toBe(404);
    expect((await call("bob", "GET", `/f/${projectId}/api/search?q=needle&conversation_id=s3`)).status).toBe(404);
    expect((await call("bob", "GET", `/f/${projectId}/api/search?q=needle&conversation_id=nope`)).status).toBe(404);
  });

  test("a repeated conversation_id cannot smuggle one past the check", async () => {
    // We read the first and Fountain would read the last, so the query is rebuilt, never forwarded.
    searched.length = 0;
    const res = await call("bob", "GET", `/f/${projectId}/api/search?q=needle&conversation_id=s1&conversation_id=s2`);
    expect(res.status).toBe(200);
    expect(searched[0]!.conversation_id).toEqual(["s1"]);
    expect(((await res.json()) as { data: FakeHit[] }).data.every((h) => h.conversation_id === "s1")).toBe(true);
    // The other way round is refused outright.
    expect((await call("bob", "GET", `/f/${projectId}/api/search?q=needle&conversation_id=s2&conversation_id=s1`)).status).toBe(404);
  });

  test("a blank query is refused here, without asking Fountain", async () => {
    searched.length = 0;
    const res = await call("bob", "GET", `/f/${projectId}/api/search?q=%20%20`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("bad_query");
    expect(searched).toEqual([]);
  });

  test("a non-member cannot search the project at all", async () => {
    expect((await call("carol", "GET", `/f/${projectId}/api/search?q=needle`)).status).toBe(404);
    expect((await call(null, "GET", `/f/${projectId}/api/search?q=needle`)).status).toBe(401);
  });

  test("this project's hits are dug out from behind pages of the owner's, on the owner's key", async () => {
    // Fountain's limit and offset count the owner's hits, so a member's first
    // hit can sit on the owner's third page. Forwarding them would answer
    // "nothing"; the proxy pages upstream itself.
    const junk = (i: number): FakeHit => ({ kind: "reply", conversation_id: "s2", agent_id: "a1", turn_id: `t-junk-${i}`, turn_number: i, snippet: `haystack ${i} — the owner's own`, ts: "2026-08-23T01:00:00Z" });
    hits["key-alice"] = [...Array.from({ length: 250 }, (_, i) => junk(i)), { kind: "reply", conversation_id: "s1", agent_id: "a1", turn_id: "t-deep", turn_number: 9, snippet: "haystack — in this project", ts: "2026-08-23T01:00:00Z" }];
    searched.length = 0;
    const body = (await (await call("bob", "GET", `/f/${projectId}/api/search?q=haystack`)).json()) as { data: FakeHit[]; meta: { has_more: boolean } };
    expect(body.data.map((h) => h.turn_id)).toEqual(["t-deep"]);
    expect(body.meta.has_more).toBe(false);
    expect(searched.every((s) => s.key === "key-alice")).toBe(true);
    expect(searched.map((s) => s.offset)).toEqual(["0", "100", "200"]);
  });

  test("digging stops somewhere, and says so rather than claiming the end", async () => {
    // Deeper than the proxy will read: the answer is empty but honest, so the
    // palette can offer "narrow it" instead of "no results".
    hits["key-alice"] = Array.from({ length: 600 }, (_, i) => ({ kind: "reply" as const, conversation_id: "s2", agent_id: "a1", turn_id: `t-far-${i}`, turn_number: i, snippet: `farfetched ${i}`, ts: "2026-08-23T01:00:00Z" }));
    searched.length = 0;
    const body = (await (await call("bob", "GET", `/f/${projectId}/api/search?q=farfetched`)).json()) as { data: FakeHit[]; meta: { has_more: boolean } };
    expect(body.data).toEqual([]);
    expect(body.meta.has_more).toBe(true);
    expect(searched).toHaveLength(5);
  });

  test("a scoped query is checked on the way back too, so no route trusts the scoping alone", async () => {
    hits["key-alice"] = [
      { kind: "reply", conversation_id: "s2", agent_id: "a1", turn_id: "t-own", turn_number: 1, snippet: "leaky", ts: "2026-08-23T01:00:00Z" },
      { kind: "reply", conversation_id: "s1", agent_id: "a1", turn_id: "t-ours", turn_number: 1, snippet: "leaky", ts: "2026-08-23T01:00:00Z" },
    ];
    const body = (await (await call("bob", "GET", `/f/${projectId}/api/search?q=leaky&conversation_id=s1`)).json()) as { data: FakeHit[] };
    expect(body.data.map((h) => h.turn_id)).toEqual(["t-ours"]);
  });

  test("a hit is placed by its channel, not by anything the hit itself claims", async () => {
    // A conversation the list does not carry is fetched and read; one that is
    // not there at all is dropped, not passed through on the benefit of doubt.
    hits["key-alice"] = [
      { kind: "reply", conversation_id: "ghost", agent_id: "a1", turn_id: "t-ghost", turn_number: 1, snippet: "spectral", ts: "2026-08-23T01:00:00Z" },
      { kind: "reply", conversation_id: "s1", agent_id: "a1", turn_id: "t-real", turn_number: 1, snippet: "spectral", ts: "2026-08-23T01:00:00Z" },
    ];
    const body = (await (await call("bob", "GET", `/f/${projectId}/api/search?q=spectral`)).json()) as { data: FakeHit[] };
    expect(body.data.map((h) => h.turn_id)).toEqual(["t-real"]);
  });

  test("a scoped query is windowed by Fountain, and its has_more comes back — what ⌘F counts by", async () => {
    // The thread's find asks for one window of a conversation's hits and walks
    // them; "1 of 5+" is only honest if the paging is Fountain's own, and the
    // window we may ask for is the one the proxy will actually send.
    hits["key-alice"] = Array.from({ length: 12 }, (_, i) => ({
      kind: "reply" as const,
      conversation_id: "s1",
      agent_id: "a1",
      turn_id: `t-walk-${i}`,
      turn_number: i,
      snippet: `walk ${i}`,
      ts: "2026-08-23T01:00:00Z",
    }));
    searched.length = 0;
    const body = (await (await call("bob", "GET", `/f/${projectId}/api/search?q=walk&conversation_id=s1&limit=5`)).json()) as {
      data: FakeHit[];
      meta: { has_more: boolean };
    };
    expect(body.data.map((h) => h.turn_id)).toEqual(["t-walk-0", "t-walk-1", "t-walk-2", "t-walk-3", "t-walk-4"]);
    expect(body.meta.has_more).toBe(true);
    // One request, for one conversation: no paging through the owner's account here.
    expect(searched).toHaveLength(1);
    expect(searched[0]!.limit).toBe("5");
    // A window wider than Fountain's page is cut down here rather than asked for.
    await call("bob", "GET", `/f/${projectId}/api/search?q=walk&conversation_id=s1&limit=500`);
    expect(searched[1]!.limit).toBe("100");
  });
});

describe("the broker's replacement config, from the owner's side", () => {
  let projectId = "";
  beforeAll(async () => {
    const res = await call("alice", "POST", "/api/projects", { name: "Brokered", environmentId: "e1", vaultId: "v1" });
    projectId = (await res.json()).data.id;
    await call("alice", "POST", `/api/projects/${projectId}/members`, { email: "bob@example.com" });
  });
  // The MCP suite below counts alice's projects; leave her with what she had.
  afterAll(async () => {
    await call("alice", "DELETE", `/api/projects/${projectId}`);
  });

  test("off for the account: enabled false, and nothing else is asked or said", async () => {
    const res = await call("alice", "GET", `/api/projects/${projectId}/brokering`);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ enabled: false, bindings: [], secrets: [], environment: false, vault: false });
  });

  test("on: every binding, and the project's secrets joined to the hosts they go to — names, never values", async () => {
    brokered.add("key-alice");
    try {
      const dto = (await (await call("alice", "GET", `/api/projects/${projectId}/brokering`)).json()).data;
      expect(dto.enabled).toBe(true);
      expect(dto.environment).toBe(true);
      expect(dto.vault).toBe(true);
      expect(dto.bindings.map((b: { id: string }) => b.id)).toEqual(["b2", "b1", "b3"]);
      expect(dto.secrets).toEqual([
        // In the sandbox in the clear: ADR 0019 §7's unbrokerable case, labelled by having nowhere to go.
        { key: "BUZZ_PRIVATE_KEY", source: "environment", hosts: [] },
        // The catalog default: brokered to GitHub with no binding of its own.
        { key: "GITHUB_TOKEN", source: "environment", hosts: ["api.github.com", "github.com"] },
        // A disabled binding is not a binding.
        { key: "OPENAI_API_KEY", source: "vault", hosts: [] },
        { key: "STRIPE_SECRET_KEY", source: "both", hosts: ["api.stripe.com", "files.stripe.com"] },
      ]);
      expect(JSON.stringify(dto)).not.toContain("supersecret");
    } finally {
      brokered.delete("key-alice");
    }
  });

  test("a vault that is gone reads as no vault, not as a failed page", async () => {
    brokered.add("key-alice");
    await call("alice", "PATCH", `/api/projects/${projectId}`, { vaultId: "v-gone" });
    try {
      const dto = (await (await call("alice", "GET", `/api/projects/${projectId}/brokering`)).json()).data;
      expect(dto.vault).toBe(false);
      expect(dto.secrets.map((s: { key: string }) => s.key)).toEqual(["BUZZ_PRIVATE_KEY", "GITHUB_TOKEN", "STRIPE_SECRET_KEY"]);
    } finally {
      brokered.delete("key-alice");
      await call("alice", "PATCH", `/api/projects/${projectId}`, { vaultId: "v1" });
    }
  });

  test("a member is not told: it is the owner's configuration", async () => {
    expect((await call("bob", "GET", `/api/projects/${projectId}/brokering`)).status).toBe(403);
    expect((await call("carol", "GET", `/api/projects/${projectId}/brokering`)).status).toBe(404);
  });
});

describe("closing an item retires its computers", () => {
  let doneItem = "";
  let otherItem = "";
  let wontItem = "";
  let iceItem = "";

  beforeAll(async () => {
    const make = async (title: string) => (await (await call("bob", "POST", `/api/projects/${projectId}/items`, { title })).json()).data.id as string;
    doneItem = await make("ship it");
    otherItem = await make("still going");
    wontItem = await make("not worth it");
    iceItem = await make("worth doing, but not this quarter");
    const conv = (id: string, channel: string | null, sandbox: string | null, status: string): FakeConv => ({
      id,
      channel_id: channel,
      title: null,
      agent_id: "a1",
      environment_id: "e1",
      vault_id: "v1",
      sandbox_id: sandbox,
      status,
      inserted_at: "2026-08-23T00:00:00Z",
    });
    convs["key-alice"] = [
      conv("d1", `workbench:${projectId}/${doneItem}/aaaaaaaaaaaa`, "sbA", "running"),
      conv("d2", `workbench:${projectId}/${doneItem}/bbbbbbbbbbbb`, "sbA", "idle"), // the same computer as d1
      conv("d3", `workbench:${projectId}/${doneItem}/cccccccccccc`, "sbB", "terminated"), // already gone
      conv("o1", `workbench:${projectId}/${otherItem}/dddddddddddd`, "sbC", "running"), // another item
      conv("x1", "workbench:otherproj/item9", "sbD", "running"), // another project
      conv("p1", "fountain:team", "sbE", "running"), // not the workbench's at all
      conv("w1", `workbench:${projectId}/${wontItem}/ffffffffffff`, "sbG", "running"), // the one we will decide against
      conv("i1", `workbench:${projectId}/${iceItem}/gggggggggggg`, "sbH", "running"), // the one we will park
    ];
    terminated.length = 0;
  });

  test("marking it done retires every live conversation on that item, and nothing else", async () => {
    const res = await call("bob", "PATCH", `/api/projects/${projectId}/items/${doneItem}`, { status: "done" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string }; retired: unknown };
    expect(body.data.status).toBe("done");
    // d1 and d2 share sbA, so two conversations retire one computer.
    expect(body.retired).toEqual({ conversations: 2, computers: 1, failed: 0 });
    expect([...terminated].sort()).toEqual(["d1", "d2"]);
  });

  test("a title edit, a reopen, or a second done retires nothing", async () => {
    terminated.length = 0;
    for (const patch of [{ title: "ship it!" }, { status: "done" }, { status: "open" }]) {
      const res = await call("bob", "PATCH", `/api/projects/${projectId}/items/${doneItem}`, patch);
      expect((await res.json()).retired).toBeUndefined();
    }
    expect(terminated).toEqual([]);
    // The other item's conversation was never touched.
    expect(convs["key-alice"]!.find((c) => c.id === "o1")!.status).toBe("running");
  });

  test("won't do closes the same way done does: the work is over, so the computers go", async () => {
    terminated.length = 0;
    const res = await call("bob", "PATCH", `/api/projects/${projectId}/items/${wontItem}`, { status: "wont" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string }; retired: unknown };
    expect(body.data.status).toBe("wont");
    expect(body.retired).toEqual({ conversations: 1, computers: 1, failed: 0 });
    expect(terminated).toEqual(["w1"]);
  });

  test("on ice ends the work like the other two: a parked item does not keep a computer up", async () => {
    terminated.length = 0;
    const res = await call("bob", "PATCH", `/api/projects/${projectId}/items/${iceItem}`, { status: "icebox" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string }; retired: unknown };
    expect(body.data.status).toBe("icebox");
    expect(body.retired).toEqual({ conversations: 1, computers: 1, failed: 0 });
    expect(terminated).toEqual(["i1"]);
  });

  test("swapping one closed state for another retires nothing — the computers already went", async () => {
    terminated.length = 0;
    // Ends on wont, which is where the counts below expect to find it.
    for (const status of ["done", "icebox", "wont"]) {
      const res = await call("bob", "PATCH", `/api/projects/${projectId}/items/${wontItem}`, { status });
      const body = (await res.json()) as { data: { status: string }; retired?: unknown };
      expect(body.data.status).toBe(status);
      expect(body.retired).toBeUndefined();
    }
    expect(terminated).toEqual([]);
  });

  test("a status that is not one of ours changes nothing", async () => {
    const res = await call("bob", "PATCH", `/api/projects/${projectId}/items/${wontItem}`, { status: "abandoned" });
    expect((await res.json()).data.status).toBe("wont");
  });

  test("what Fountain would not retire is reported; the item is done either way", async () => {
    convs["key-alice"]!.push({
      id: "stuck1",
      channel_id: `workbench:${projectId}/${otherItem}/eeeeeeeeeeee`,
      title: null,
      agent_id: "a1",
      environment_id: "e1",
      vault_id: "v1",
      sandbox_id: "sbF",
      status: "idle",
      inserted_at: "2026-08-23T00:00:00Z",
    });
    terminated.length = 0;
    const res = await call("bob", "PATCH", `/api/projects/${projectId}/items/${otherItem}`, { status: "done" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string }; retired: { conversations: number; computers: number; failed: number; error?: string } };
    expect(body.data.status).toBe("done");
    expect(terminated).toEqual(["o1"]);
    expect(body.retired.conversations).toBe(1);
    expect(body.retired.computers).toBe(1);
    expect(body.retired.failed).toBe(1);
    expect(body.retired.error).toContain("500");
  });

  test("the counts tell the three apart", async () => {
    // By now: doneItem was reopened, otherItem is done, wontItem is won't do,
    // iceItem is on ice. One number over all of them would say none of it.
    const { counts } = (await (await call("bob", "GET", `/api/projects/${projectId}`)).json()).data.project;
    expect(counts.done).toBe(1);
    expect(counts.wont).toBe(1);
    expect(counts.icebox).toBe(1);
    expect(counts.open).toBeGreaterThan(0);
  });
});

/**
 * Terminating a computer and being finished with it are two different things,
 * and only the first of them existed. These are the second.
 */
describe("removing a computer from a work item", () => {
  let itemA = "";
  let itemB = "";
  const conv = (id: string, channel: string | null, sandbox: string | null, status: string, unread = false): FakeConv => ({
    id,
    channel_id: channel,
    title: null,
    agent_id: "a1",
    environment_id: "e1",
    vault_id: "v1",
    sandbox_id: sandbox,
    status,
    inserted_at: "2026-08-23T00:00:00Z",
    last_active_at: "2026-08-23T02:00:00Z",
    unread,
  });

  beforeAll(async () => {
    const make = async (title: string) => (await (await call("bob", "POST", `/api/projects/${projectId}/items`, { title })).json()).data.id as string;
    itemA = await make("the week-long one");
    itemB = await make("next door");
    convs["key-alice"] = [
      // Two conversations on one computer, both still live.
      conv("r1", `workbench:${projectId}/${itemA}/aaaaaaaaaaaa`, "sbR", "idle"),
      conv("r2", `workbench:${projectId}/${itemA}/bbbbbbbbbbbb`, "sbR", "running"),
      // Another computer on the same item, already dead.
      conv("r3", `workbench:${projectId}/${itemA}/cccccccccccc`, "sbS", "terminated"),
      // One that never got a computer at all.
      conv("r4", `workbench:${projectId}/${itemA}/dddddddddddd`, null, "failed"),
      // Another item's computer, with something unread on it.
      conv("r5", `workbench:${projectId}/${itemB}/eeeeeeeeeeee`, "sbT", "idle", true),
    ];
    hits["key-alice"] = [
      { kind: "reply", conversation_id: "r1", agent_id: "a1", turn_id: "t-r1-1", turn_number: 1, snippet: "haystack — on the computer we will remove", ts: "2026-08-23T01:00:00Z" },
      { kind: "reply", conversation_id: "r3", agent_id: "a1", turn_id: "t-r3-1", turn_number: 1, snippet: "haystack — on the one that stays", ts: "2026-08-23T01:00:00Z" },
    ];
    terminated.length = 0;
  });

  const listed = async (who = "bob") => ((await (await call(who, "GET", `/f/${projectId}/api/conversations`)).json()).data as { id: string }[]).map((c) => c.id);

  test("a computer nobody can see must not still be running: removing retires it first", async () => {
    const res = await call("bob", "POST", `/api/projects/${projectId}/items/${itemA}/computers`, { key: "sbR" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { removedComputers: { key: string; by: string; at: string }[] }; retired: unknown };
    // r1 and r2 share sbR, and both were live: two conversations, one computer.
    expect(body.retired).toEqual({ conversations: 2, computers: 1, failed: 0 });
    expect([...terminated].sort()).toEqual(["r1", "r2"]);
    expect(body.data.removedComputers).toHaveLength(1);
    expect(body.data.removedComputers[0]).toMatchObject({ key: "sbR", by: "bob@example.com" });
    expect(body.data.removedComputers[0]!.at).not.toBe("");
  });

  test("its conversations leave the project's listing, and nothing else does", async () => {
    expect(await listed()).toEqual(["r3", "r4", "r5"]);
    // The owner sees what the member sees: it is the project's tree, not one reader's filter.
    expect(await listed("alice")).toEqual(["r3", "r4", "r5"]);
  });

  test("removed is not deleted: the conversation's own routes still answer, so its link still opens", async () => {
    expect((await call("bob", "GET", `/f/${projectId}/api/conversations/r1`)).status).toBe(200);
    expect((await call("bob", "GET", `/f/${projectId}/api/conversations/r1/turns`)).status).toBe(200);
  });

  test("the palette stops offering it; find-in-page inside it still works", async () => {
    const body = (await (await call("bob", "GET", `/f/${projectId}/api/search?q=haystack`)).json()) as { data: FakeHit[] };
    expect(body.data.map((h) => h.conversation_id)).toEqual(["r3"]);
    // Named outright is find-in-page in an open thread: a link that still
    // opens has to still be searchable from inside.
    const inside = (await (await call("bob", "GET", `/f/${projectId}/api/search?q=haystack&conversation_id=r1`)).json()) as { data: FakeHit[] };
    expect(inside.data.map((h) => h.conversation_id)).toEqual(["r1"]);
  });

  test("a removed computer cannot be joined, whatever the browser sends", async () => {
    const res = await call("bob", "POST", `/f/${projectId}/api/conversations`, { agent_id: "a1", channel_id: `workbench:${projectId}/${itemA}`, sandbox_id: "sbR" });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("computer_removed");
  });

  test("a computer that never got a sandbox goes by the key the tree gave it", async () => {
    terminated.length = 0;
    const res = await call("bob", "POST", `/api/projects/${projectId}/items/${itemA}/computers`, { key: "conv:r4" });
    expect(res.status).toBe(200);
    // Failed is not retired: Fountain is asked to end it like any other, which
    // is what closing an item does too. There is no computer to count, though.
    expect((await res.json()).retired).toEqual({ conversations: 1, computers: 0, failed: 0 });
    expect(terminated).toEqual(["r4"]);
    expect(await listed()).toEqual(["r3", "r5"]);
  });

  test("a removal belongs to the item, not to the key", async () => {
    const shown = (await (await call("bob", "GET", `/api/projects/${projectId}`)).json()).data.items as { id: string; removedComputers: { key: string }[] }[];
    expect(shown.find((w) => w.id === itemA)!.removedComputers.map((r) => r.key).sort()).toEqual(["conv:r4", "sbR"]);
    expect(shown.find((w) => w.id === itemB)!.removedComputers).toEqual([]);
    // So the same key under another item removes nothing of that item's.
    expect((await call("bob", "POST", `/api/projects/${projectId}/items/${itemB}/computers`, { key: "sbR" })).status).toBe(200);
    expect(await listed()).toEqual(["r3", "r5"]);
    await call("bob", "DELETE", `/api/projects/${projectId}/items/${itemB}/computers/sbR`);
  });

  test("a computer taken out of an item cannot ring the bell from outside it", async () => {
    const feed = async () => ((await (await call("bob", "GET", "/api/projects/activity")).json()).data.feed as { conversationId: string }[]).map((f) => f.conversationId);
    expect(await feed()).toContain("r5");
    await call("bob", "POST", `/api/projects/${projectId}/items/${itemB}/computers`, { key: "sbT" });
    expect(await feed()).not.toContain("r5");
    await call("bob", "DELETE", `/api/projects/${projectId}/items/${itemB}/computers/sbT`);
  });

  test("putting one back is the whole of the undo: nothing was destroyed", async () => {
    const res = await call("bob", "DELETE", `/api/projects/${projectId}/items/${itemA}/computers/sbR`);
    expect(res.status).toBe(200);
    expect(((await res.json()).data.removedComputers as { key: string }[]).map((r) => r.key)).toEqual(["conv:r4"]);
    // Back in the tree — as what they now are, which is retired.
    expect(await listed()).toEqual(["r1", "r2", "r3", "r5"]);
    const body = (await (await call("bob", "GET", `/f/${projectId}/api/search?q=haystack`)).json()) as { data: FakeHit[] };
    expect(body.data.map((h) => h.conversation_id).sort()).toEqual(["r1", "r3"]);
  });

  test("a key must be named, the item must be this project's, and a stranger gets nothing", async () => {
    expect((await call("bob", "POST", `/api/projects/${projectId}/items/${itemA}/computers`, {})).status).toBe(422);
    expect((await call("bob", "POST", `/api/projects/${projectId}/items/${itemA}/computers`, { key: "   " })).status).toBe(422);
    expect((await call("bob", "POST", `/api/projects/${projectId}/items/nope/computers`, { key: "sbR" })).status).toBe(404);
    expect((await call("carol", "POST", `/api/projects/${projectId}/items/${itemA}/computers`, { key: "sbR" })).status).toBe(404);
    expect((await call("carol", "DELETE", `/api/projects/${projectId}/items/${itemA}/computers/sbR`)).status).toBe(404);
    expect((await call(null, "POST", `/api/projects/${projectId}/items/${itemA}/computers`, { key: "sbR" })).status).toBe(401);
  });

  test("a sweep takes many out in one request, over one listing", async () => {
    // The chore this exists to end is clearing a week of dead machines one at
    // a time, so `keys` is the point of the route, not a convenience on it.
    const item = (await (await call("bob", "POST", `/api/projects/${projectId}/items`, { title: "a week of them" })).json()).data.id as string;
    convs["key-alice"]!.push(
      conv("s1", `workbench:${projectId}/${item}/111111111111`, "sbW", "terminated"),
      conv("s2", `workbench:${projectId}/${item}/222222222222`, "sbX", "terminated"),
      conv("s3", `workbench:${projectId}/${item}/333333333333`, "sbY", "idle"),
    );
    terminated.length = 0;
    const res = await call("bob", "POST", `/api/projects/${projectId}/items/${item}/computers`, { keys: ["sbW", "sbX", "sbW"] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { removedComputers: { key: string }[] }; retired: unknown; removed: number };
    // Both were already down, so nothing was retired — and the repeat counted once.
    expect(body.removed).toBe(2);
    expect(body.retired).toEqual({ conversations: 0, computers: 0, failed: 0 });
    expect(terminated).toEqual([]);
    expect(body.data.removedComputers.map((r) => r.key).sort()).toEqual(["sbW", "sbX"]);
    // The one that was still up was not named, so it is untouched.
    const ids = ((await (await call("bob", "GET", `/f/${projectId}/api/conversations`)).json()).data as { id: string }[]).map((c) => c.id);
    expect(ids).toContain("s3");
    expect(ids).not.toContain("s1");
    expect(ids).not.toContain("s2");
  });

  test("a sweep that names something live retires it, in the same single pass", async () => {
    const item = (await (await call("bob", "POST", `/api/projects/${projectId}/items`, { title: "one of each" })).json()).data.id as string;
    convs["key-alice"]!.push(
      conv("t1", `workbench:${projectId}/${item}/444444444444`, "sbP", "terminated"),
      conv("t2", `workbench:${projectId}/${item}/555555555555`, "sbQ", "running"),
    );
    terminated.length = 0;
    const res = await call("bob", "POST", `/api/projects/${projectId}/items/${item}/computers`, { keys: ["sbP", "sbQ"] });
    const body = (await res.json()) as { retired: unknown; removed: number };
    expect(body.removed).toBe(2);
    expect(body.retired).toEqual({ conversations: 1, computers: 1, failed: 0 });
    expect(terminated).toEqual(["t2"]);
  });

  test("an empty or unusable list of keys is refused, not treated as \"all of them\"", async () => {
    for (const body of [{ keys: [] }, { keys: ["", "   "] }, { keys: [1, null] }, {}]) {
      expect((await call("bob", "POST", `/api/projects/${projectId}/items/${itemA}/computers`, body)).status).toBe(422);
    }
  });

  test("deleting the work item takes its removals with it", async () => {
    await call("bob", "POST", `/api/projects/${projectId}/items/${itemA}/computers`, { key: "sbR" });
    expect(db.removedComputers(itemA)).toHaveLength(2);
    await call("bob", "DELETE", `/api/projects/${projectId}/items/${itemA}`);
    expect(db.removedComputers(itemA)).toEqual([]);
  });
});

describe("recovery", () => {
  test("recover rebuilds projects from the caller's own conversations", async () => {
    convs["key-bob"] = [
      { id: "b2", channel_id: "workbench:bobproj/bobitem", title: "Coder: Bob's thing", agent_id: "a1", environment_id: "e9", vault_id: null, sandbox_id: null, status: "idle", inserted_at: "2026-08-20T00:00:00Z" },
      { id: "b3", channel_id: `workbench:${projectId}/sneaky`, title: "not mine", agent_id: "a1", environment_id: null, vault_id: null, sandbox_id: null, status: "idle", inserted_at: "2026-08-20T00:00:00Z" },
    ];
    const res = await call("bob", "POST", "/api/projects/recover");
    expect((await res.json()).data).toEqual({ projects: 1, items: 1 });
    const p = db.getProject("bobproj")!;
    expect(p.owner_email).toBe("bob@example.com");
    expect(p.environment_id).toBe("e9");
    expect(db.items("bobproj")[0]!.title).toBe("Bob's thing");
    // Alice's project did not get an item from Bob's key.
    expect(db.getItem("sneaky")).toBeNull();
  });

  test("import keeps ids and skips what exists", async () => {
    const res = await call("carol", "POST", "/api/import", {
      projects: [
        { id: "oldproj", name: "Old", environmentId: "e1", createdAt: "2026-01-01T00:00:00Z" },
        { id: projectId, name: "steal" },
      ],
      items: [
        { id: "olditem", projectId: "oldproj", title: "old item", agentIds: ["a1"], status: "done" },
        { id: "x", projectId, title: "into alice's" },
      ],
    });
    expect((await res.json()).data).toEqual({ projects: 1, items: 1 });
    expect(db.getProject(projectId)!.owner_email).toBe("alice@example.com");
    expect(db.getItem("olditem")!.status).toBe("done");
    expect(db.getItem("x")).toBeNull();
  });
});

describe("the survey: what is live per project, and what stopped unread across all of them", () => {
  // The complaint this answers: a conversation finishing in another project
  // is invisible, because the event stream is one project's and the browser
  // holds only the one it is looking at. So the server sweeps every project
  // the caller is in, on each owner's key, and both facts fall out of the one
  // listing. Bob is a member of alice's project and the owner of his own,
  // which is the case that needs two keys.
  const before = { alice: convs["key-alice"]!, bob: convs["key-bob"]! };
  let goneItem = "";

  const conv = (id: string, channel: string | null, status: string, unread: boolean, at: string): FakeConv => ({
    id,
    channel_id: channel,
    title: `Coder: ${id}`,
    agent_id: "a1",
    environment_id: "e1",
    vault_id: "v1",
    sandbox_id: "sbS",
    status,
    inserted_at: "2026-08-20T00:00:00Z",
    last_active_at: at,
    unread,
  });

  beforeAll(async () => {
    const on = (item: string) => `workbench:${projectId}/${item}/${item.slice(0, 8)}`;
    goneItem = (await (await call("bob", "POST", `/api/projects/${projectId}/items`, { title: "will be deleted" })).json()).data.id;
    await call("bob", "DELETE", `/api/projects/${projectId}/items/${goneItem}`);
    convs["key-alice"] = [
      conv("s-idle", on(itemId), "idle", true, "2026-08-24T10:00:00Z"),
      conv("s-failed", on(itemId), "failed", true, "2026-08-24T11:00:00Z"),
      // Read: somebody has been and looked, so it is not news.
      conv("s-read", on(itemId), "idle", false, "2026-08-24T12:00:00Z"),
      // Still working. It is live, and a turn in flight is not a finished one.
      conv("s-running", on(itemId), "running", true, "2026-08-24T12:30:00Z"),
      conv("s-pending", on(itemId), "pending", true, "2026-08-24T12:31:00Z"),
      // Retired. Closing a work item retires every conversation on it, so
      // counting these would turn "done" into a screenful of notifications.
      conv("s-terminated", on(itemId), "terminated", true, "2026-08-24T09:00:00Z"),
      // The item is gone from here; its conversation still names it.
      conv("s-orphan", on(goneItem), "idle", true, "2026-08-24T08:00:00Z"),
      // Not the workbench's, and a workbench project nobody here is in.
      conv("s-team", "fountain:team", "idle", true, "2026-08-24T13:00:00Z"),
      conv("s-elsewhere", "workbench:otherproj/item9/aaaaaaaa", "idle", true, "2026-08-24T13:00:00Z"),
    ];
    convs["key-bob"] = [
      conv("s-bob", "workbench:bobproj/bobitem/bbbbbbbb", "idle", true, "2026-08-24T07:00:00Z"),
      // A second account with a turn in flight, so there is somewhere for a
      // request of Bob's own to be held.
      conv("s-bob-running", "workbench:bobproj/bobitem/bbbbbbbb", "running", true, "2026-08-24T07:30:00Z"),
    ];
  });

  afterAll(() => {
    convs["key-alice"] = before.alice;
    convs["key-bob"] = before.bob;
  });

  const surveyOf = async (who: string) => (await (await call(who, "GET", "/api/projects/activity")).json()).data as import("./projects").ActivityDto;

  test("no session, no survey", async () => {
    expect((await call(null, "GET", "/api/projects/activity")).status).toBe(401);
  });

  test("only a conversation that has stopped with something unread is in the feed", async () => {
    const s = await surveyOf("alice");
    // Newest first. Everything else is excluded for its own reason, above.
    expect(s.feed.map((e) => e.conversationId)).toEqual(["s-failed", "s-idle", "s-orphan"]);
    expect(s.feed[0]!.status).toBe("failed");
    expect(s.feed[1]!.status).toBe("idle");
    expect(s.dropped).toBe(0);
  });

  test("an entry says where it is, because whoever reads it is somewhere else", async () => {
    const s = await surveyOf("alice");
    const e = s.feed.find((x) => x.conversationId === "s-idle")!;
    expect(e.projectId).toBe(projectId);
    expect(e.projectName).toBe(db.getProject(projectId)!.name);
    expect(e.itemId).toBe(itemId);
    expect(e.itemTitle).toBe(db.getItem(itemId)!.title);
    expect(e.title).toBe("Coder: s-idle");
    expect(e.agentId).toBe("a1");
    // An item deleted here still places its conversation; there is just no
    // title to give it, and the panel says so rather than showing a raw id.
    expect(s.feed.find((x) => x.conversationId === "s-orphan")!.itemTitle).toBeNull();
  });

  test("a member sees the owner's project and their own — two owners, both keys", async () => {
    const s = await surveyOf("bob");
    expect(s.feed.map((e) => e.conversationId)).toEqual(["s-failed", "s-idle", "s-orphan", "s-bob"]);
    expect(s.feed.find((e) => e.conversationId === "s-bob")!.projectId).toBe("bobproj");
    // And the owner of one of them is not in the other.
    const alice = await surveyOf("alice");
    expect(alice.feed.map((e) => e.projectId)).not.toContain("bobproj");
  });

  test("the live counts come out of the same pass, and count only what is working", async () => {
    const s = await surveyOf("alice");
    // `s-running` and `s-pending`; and the latest is theirs (12:31), not the
    // 13:00 of the team conversation and the one in a project she is not in —
    // neither of those is this project's to report, in either figure.
    expect(s.projects[projectId]).toEqual({ live: 2, latest: "2026-08-24T12:31:00Z" });
    expect(s.projects.otherproj).toBeUndefined();
  });

  test("the feed is a list, not an archive: it caps, and says how much it is not showing", async () => {
    const on = `workbench:${projectId}/${itemId}/${itemId.slice(0, 8)}`;
    const many = Array.from({ length: 55 }, (_, i) =>
      // Ascending time, so the newest are the highest-numbered.
      conv(`bulk-${String(i).padStart(2, "0")}`, on, "idle", true, `2026-08-25T${String(i % 24).padStart(2, "0")}:${String(i).padStart(2, "0")}:00Z`),
    );
    const kept = convs["key-alice"]!;
    convs["key-alice"] = [...kept, ...many];
    try {
      const s = await surveyOf("alice");
      expect(s.feed).toHaveLength(50);
      expect(s.dropped).toBe(58 - 50);
      // Newest first, and what fell off the end is the oldest — not an
      // arbitrary 50 with the number quietly swallowed.
      const times = s.feed.map((e) => e.at);
      expect([...times].sort().reverse()).toEqual(times);
    } finally {
      convs["key-alice"] = kept;
    }
  });

  // ── who is blocked (server/watch.ts) ───────────────────────────────────
  //
  // The other half of a notification, and the louder one: a held permission
  // request is on no conversation record, and the conversation holding one is
  // `running` — which the feed above counts as live and deliberately excludes
  // as "still working, not news". It is read off the stage stream instead.

  const REQUEST_AT = new Date(NOW - 60_000).toISOString();

  test("an agent blocked on a permission request is in the survey, with where it is and when it runs out", async () => {
    ask("s-running", 10, "req-1", "Bash", REQUEST_AT);
    try {
      const s = await surveyOf("alice");
      expect(s.waiting).toHaveLength(1);
      const w = s.waiting[0]!;
      expect(w.conversationId).toBe("s-running");
      expect(w.requestId).toBe("req-1");
      expect(w.tool).toBe("Bash");
      // Where it is: whoever reads this is in another project and has no
      // store for this one.
      expect(w.projectId).toBe(projectId);
      expect(w.projectName).toBe(db.getProject(projectId)!.name);
      expect(w.itemId).toBe(itemId);
      expect(w.itemTitle).toBe(db.getItem(itemId)!.title);
      expect(w.title).toBe("Coder: s-running");
      expect(w.agentId).toBe("a1");
      // Five minutes from when it was asked, which is what the countdown counts.
      expect(Date.parse(w.expiresAt) - Date.parse(w.askedAt)).toBe(5 * 60 * 1000);
      // And it is still live and still not news in the other half: the feed
      // is what finished, this is what is waiting.
      expect(s.feed.map((e) => e.conversationId)).not.toContain("s-running");
      expect(s.projects[projectId]!.live).toBe(2);
    } finally {
      delete stageEvents["s-running"];
    }
  });

  test("one that has been answered, and one that has run out, are not", async () => {
    // Answered — `request · done` closes it, whatever the outcome was.
    ask("s-running", 20, "req-2", "Bash", REQUEST_AT, "allow_once");
    // Raised an hour ago: Fountain denied this one 55 minutes ago. A row that
    // said otherwise would be asking you to click on nothing.
    ask("s-pending", 30, "req-3", "Edit", new Date(NOW - 60 * 60_000).toISOString());
    try {
      expect((await surveyOf("alice")).waiting).toEqual([]);
    } finally {
      delete stageEvents["s-running"];
      delete stageEvents["s-pending"];
    }
  });

  test("a running conversation's history is read once, not once a minute", async () => {
    ask("s-running", 40, "req-4", "Bash", REQUEST_AT);
    try {
      expect((await surveyOf("alice")).waiting.map((w) => w.requestId)).toEqual(["req-4"]);
      // `s-running` is the only one running; `s-pending` has not started, and
      // a conversation that has stopped cannot be holding a request.
      expect(historyAsked).toEqual(["s-running"]);
      // The second survey is a join against what the stream has been saying
      // since, not a re-read: the request-per-live-conversation-per-tick this
      // was built to avoid is spent exactly once.
      expect((await surveyOf("alice")).waiting.map((w) => w.requestId)).toEqual(["req-4"]);
      expect(historyAsked).toEqual(["s-running"]);
    } finally {
      delete stageEvents["s-running"];
    }
  });

  test("a conversation that has stopped is not holding anything, whatever the last event said", async () => {
    // The backstop for a `request · done` that never arrived: a permission
    // request lives on a turn in flight, so a conversation the listing calls
    // finished cannot still be blocked on one.
    ask("s-running", 50, "req-5", "Bash", REQUEST_AT);
    const c = convs["key-alice"]!.find((x) => x.id === "s-running")!;
    try {
      expect((await surveyOf("alice")).waiting.map((w) => w.requestId)).toEqual(["req-5"]);
      c.status = "idle";
      expect((await surveyOf("alice")).waiting).toEqual([]);
    } finally {
      c.status = "running";
      delete stageEvents["s-running"];
    }
  });

  test("a request raised after the history was read arrives on the owner's stream", async () => {
    // Nothing to backfill: this one is raised while the workbench is already
    // following the account, which is the case the stream is for.
    expect((await surveyOf("alice")).waiting).toEqual([]);
    ask("s-running", 60, "req-6", "Write", REQUEST_AT);
    try {
      const found = await until(async () => (await surveyOf("alice")).waiting.find((w) => w.requestId === "req-6") ?? null);
      expect(found?.tool).toBe("Write");
      expect(found?.conversationId).toBe("s-running");
      // And it came down the stream, not off a second read of the history:
      // that conversation was read once, before the request existed.
      expect(historyAsked).toEqual(["s-running"]);
    } finally {
      delete stageEvents["s-running"];
    }
  });

  test("each owner's stream keeps its own cursor: one account's event ids are not the other's", async () => {
    // The trap this design exists to avoid, and the reason these are folded
    // per owner in the server rather than merged into one SSE for the browser.
    // Fountain's event ids are per account and monotonic, so a single cursor
    // across two owners silently skips the account whose ids run lower. Alice's
    // is far ahead of Bob's here; Bob is in both, and must be told about both.
    expect((await surveyOf("bob")).waiting).toEqual([]);
    ask("s-running", 9000, "req-alice", "Bash", REQUEST_AT);
    ask("s-bob-running", 5, "req-bob", "Edit", REQUEST_AT);
    try {
      const both = await until(async () => {
        const ids = (await surveyOf("bob")).waiting.map((w) => w.requestId).sort();
        return ids.length === 2 ? ids : null;
      });
      expect(both).toEqual(["req-alice", "req-bob"]);
      const s = await surveyOf("bob");
      expect(s.waiting.find((w) => w.requestId === "req-bob")!.projectId).toBe("bobproj");
      expect(s.waiting.find((w) => w.requestId === "req-alice")!.projectId).toBe(projectId);
      // Alice is not in Bob's project, and is told about her own only.
      expect((await surveyOf("alice")).waiting.map((w) => w.requestId)).toEqual(["req-alice"]);
    } finally {
      delete stageEvents["s-running"];
      delete stageEvents["s-bob-running"];
    }
  });

  test("an owner whose key Fountain refuses reports nothing, rather than failing the survey", async () => {
    const kept = KEYS["key-bob"]!;
    delete KEYS["key-bob"];
    try {
      const s = await surveyOf("bob");
      // Alice's key still answered, so her project's half of his survey is
      // there. His own project is simply quiet — one dead key is a hole in
      // the sweep, not a screen that fails to load.
      expect(s.feed.map((e) => e.conversationId)).toEqual(["s-failed", "s-idle", "s-orphan"]);
      expect(s.projects.bobproj).toEqual({ live: 0, latest: null });
    } finally {
      KEYS["key-bob"] = kept;
    }
  });
});

describe("a database written before proposals existed", () => {
  // The deployed workbench is one SQLite file on a volume, and `CREATE TABLE
  // IF NOT EXISTS` leaves a table that is already there alone — so the columns
  // have to be added to it, and its rows have to keep reading.
  test("gains the columns, and its items read as nobody having proposed anything", () => {
    const dir = mkdtempSync(join(tmpdir(), "workbench-migrate-"));
    const path = join(dir, "old.sqlite");
    try {
      const old = new Database(path, { create: true, strict: true });
      old.exec(`CREATE TABLE items (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open', agent_ids TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL)`);
      old.query("INSERT INTO items (id, project_id, title, created_at) VALUES ('w-old', 'p-old', 'from before', '2026-01-01T00:00:00Z')").run();
      old.close();

      const migrated = new Db(path);
      try {
        const row = migrated.getItem("w-old")!;
        expect(row.title).toBe("from before");
        expect(itemDto(row).proposal).toBeNull();
        // And it takes one now, without losing what it already held.
        migrated.updateItem("w-old", proposalFields("wont", "a1", "alice@example.com"));
        expect(itemDto(migrated.getItem("w-old")!).proposal).toMatchObject({ status: "wont", agentId: "a1" });
        expect(migrated.getItem("w-old")!.title).toBe("from before");
      } finally {
        migrated.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the MCP server", () => {
  /** One JSON-RPC message, as an agent's client would send it. */
  async function rpc(key: string | null, method: string, params?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const h: Record<string, string> = { "content-type": "application/json", ...headers };
    if (key) h.authorization = `Bearer ${key}`;
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) });
    return app(new Request("http://wb.test/mcp", { method: "POST", headers: h, body }));
  }

  /** A tool call, unwrapped: its text, and the JSON in it when it is not an error. */
  async function tool(key: string, name: string, args: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
    const res = await rpc(key, "tools/call", { name, arguments: args }, headers);
    const { result } = (await res.json()) as { result: { content: { text: string }[]; isError: boolean } };
    const text = result.content[0]!.text;
    const value: unknown = result.isError ? null : JSON.parse(text);
    return { failed: result.isError, text, value };
  }

  /** Alice's conversations: one on her project's first item, one that is not the workbench's at all. */
  beforeAll(() => {
    const conv = (id: string, channel: string | null): FakeConv => ({
      id,
      channel_id: channel,
      title: null,
      agent_id: "a1",
      environment_id: "e1",
      vault_id: "v1",
      sandbox_id: "sbM",
      status: "running",
      inserted_at: "2026-08-23T00:00:00Z",
    });
    convs["key-alice"] = [conv("m1", `workbench:${projectId}/${itemId}/ffffffffffff`), conv("m2", "fountain:team")];
  });

  test("a Fountain key is the credential; nothing else gets in", async () => {
    expect((await rpc(null, "initialize")).status).toBe(401);
    expect((await rpc("nope", "initialize")).status).toBe(401);
    // A real Fountain account is not yet a workbench one: the header does not create people.
    const dave = await rpc("key-dave", "initialize");
    expect(dave.status).toBe(401);
    expect(((await dave.json()) as { error: string }).error).toBe("unknown_user");
    expect((await app(new Request("http://wb.test/mcp", { headers: { authorization: "Bearer key-alice" } }))).status).toBe(405);
  });

  test("initialize and tools/list", async () => {
    const init = (await (await rpc("key-alice", "initialize")).json()) as { result: { protocolVersion: string; serverInfo: { name: string } } };
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect(init.result.serverInfo.name).toBe("fountain-workbench");
    const list = (await (await rpc("key-alice", "tools/list")).json()) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(["list_projects", "list_work_items", "create_work_item", "update_work_item"]);
    expect((await (await rpc("key-alice", "nonsense/method")).json()).error.code).toBe(-32601);
  });

  test("a notification is not answered", async () => {
    const res = await app(
      new Request("http://wb.test/mcp", {
        method: "POST",
        headers: { authorization: "Bearer key-alice", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      }),
    );
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  test("the projects are the ones that key's person can reach", async () => {
    const alice = (await tool("key-alice", "list_projects")).value as { id: string; role: string }[];
    expect(alice.map((p) => p.id)).toEqual([projectId]);
    expect(alice[0]!.role).toBe("owner");
    // Bob is a member of Alice's and owns the one recovery rebuilt for him.
    const bob = (await tool("key-bob", "list_projects")).value as { id: string; role: string }[];
    expect(bob.map((p) => p.id).sort()).toEqual(["bobproj", projectId].sort());
    expect(bob.find((p) => p.id === projectId)!.role).toBe("member");
  });

  test("a member creates a work item by naming the project, and every open screen hears about it", async () => {
    const got: unknown[] = [];
    const off = events.subscribe(projectId, (d) => got.push(d));
    const made = (await tool("key-bob", "create_work_item", { project: "Fountain!", title: "from an agent", notes: "it said so" })).value as {
      created: boolean;
      item: { id: string; title: string; status: string };
    };
    off();
    expect(made.created).toBe(true);
    expect(got).toEqual([{ kind: "items" }]);
    const shown = (await (await call("alice", "GET", `/api/projects/${projectId}`)).json()).data;
    const item = shown.items.find((w: { id: string }) => w.id === made.item.id);
    expect(item.title).toBe("from an agent");
    expect(item.notes).toBe("it said so");
    expect(item.status).toBe("open");
    expect(item.agentIds).toEqual([]);
  });

  test("with more than one project, one has to be named", async () => {
    const vague = await tool("key-bob", "create_work_item", { title: "where?" });
    expect(vague.failed).toBe(true);
    expect(vague.text).toContain("name a project");
    // Carol is in neither, so Alice's project is not a project as far as she is concerned.
    const nope = await tool("key-carol", "create_work_item", { project: projectId, title: "sneak" });
    expect(nope.failed).toBe(true);
    expect(nope.text).toContain("no project called");
  });

  test("a title is required, and a work item nobody can reach is not there", async () => {
    expect((await tool("key-bob", "create_work_item", { project: projectId, title: "  " })).text).toContain("needs a title");
    expect((await tool("key-carol", "update_work_item", { item: itemId, title: "mine now" })).text).toContain(`no work item ${itemId}`);
    expect(db.getItem(itemId)!.title).toBe("fix foo");
  });

  test("update rewrites the title and the notes; closing an item is not on offer, either way", async () => {
    const res = (await tool("key-bob", "update_work_item", { item: itemId, title: "fix foo properly", notes: "found it" })).value as { updated: boolean };
    expect(res.updated).toBe(true);
    expect(db.getItem(itemId)!.title).toBe("fix foo properly");
    expect(db.getItem(itemId)!.notes).toBe("found it");
    // Closing retires the item's computers, so it stays a person's call in the
    // workbench — an agent that concludes "we should not do this", or "not
    // now", proposes it. On ice is no cheaper: it takes the machines too.
    for (const status of ["done", "wont", "icebox"]) {
      const closed = await tool("key-bob", "update_work_item", { item: itemId, status });
      expect(closed.failed).toBe(true);
      expect(closed.text).toContain("`propose:");
    }
    expect(db.getItem(itemId)!.status).toBe("open");
    expect(db.getItem(itemId)!.proposed_status).toBe("");
  });

  test("work items can be listed by any of the four states", async () => {
    const listed = async (status?: string) =>
      ((await tool("key-bob", "list_work_items", { project: projectId, ...(status ? { status } : {}) })).value as { items: { id: string; status: string }[] }).items;
    expect((await listed("wont")).map((w) => w.status)).toEqual(["wont"]);
    expect((await listed("done")).map((w) => w.status)).toEqual(["done"]);
    // Parked work an agent must be able to find on purpose: it is the answer
    // to "is this already known about", and it is not in the open list.
    expect((await listed("icebox")).map((w) => w.status)).toEqual(["icebox"]);
    expect((await listed("open")).every((w) => w.status === "open")).toBe(true);
    // Unfiltered is all of them, and a status nobody has is not a filter.
    const all = await listed();
    expect(all.length).toBe((await listed("open")).length + 3);
    expect((await listed("abandoned")).length).toBe(all.length);
  });

  test("which computers a person removed is not the agent's business", async () => {
    // The tree is the workbench's view of the work, not the work. An
    // always-empty list would be a claim; there is no list at all.
    const item = (await (await call("bob", "POST", `/api/projects/${projectId}/items`, { title: "for the agent" })).json()).data.id as string;
    await call("bob", "POST", `/api/projects/${projectId}/items/${item}/computers`, { key: "sbGone" });
    expect(db.removedComputers(item)).toHaveLength(1);
    const listing = await tool("key-alice", "list_work_items", { project: projectId });
    expect(listing.text).not.toContain("removedComputers");
    expect(listing.text).not.toContain("sbGone");
    const made = await tool("key-alice", "create_work_item", { project: projectId, title: "one more" });
    expect(made.text).not.toContain("removedComputers");
    const changed = await tool("key-alice", "update_work_item", { item, notes: "x" });
    expect(changed.text).not.toContain("removedComputers");
  });

  test("the conversation a sandbox names pins it to that project", async () => {
    const pin = { "x-fountain-conversation-id": "m1" };
    const seen = (await tool("key-alice", "list_projects", {}, pin)).value as { id: string; current: boolean }[];
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ id: projectId, current: true });

    const items = (await tool("key-alice", "list_work_items", {}, pin)).value as { items: { id: string; current?: boolean }[] };
    expect(items.items.find((w) => w.id === itemId)!.current).toBe(true);
    expect(items.items.filter((w) => w.current)).toHaveLength(1);

    // No project has to be named, and no other project can be.
    const made = (await tool("key-alice", "create_work_item", { title: "from inside the thread" }, pin)).value as { item: { id: string } };
    expect(db.getItem(made.item.id)!.project_id).toBe(projectId);
    const elsewhere = await tool("key-alice", "create_work_item", { project: "bobproj", title: "reach out" }, pin);
    expect(elsewhere.failed).toBe(true);
    expect(elsewhere.text).toContain("cannot reach another project");
    expect(db.items("bobproj").map((w) => w.title)).toEqual(["Bob's thing"]);
  });

  // The agent is usually the one that finds out an item should not be done —
  // it read the code and the premise was wrong. It cannot close the item: that
  // would retire every conversation on it, this one included. So it proposes,
  // and the proposal is a state the list can count, not prose in the notes.
  describe("proposing a verdict without closing the item under yourself", () => {
    const pin = { "x-fountain-conversation-id": "m1" };

    test("a proposal is recorded, and retires nothing — the agent's own conversation included", async () => {
      terminated.length = 0;
      const got: unknown[] = [];
      const off = events.subscribe(projectId, (d) => got.push(d));
      const res = (await tool("key-alice", "update_work_item", { item: itemId, notes: "foo is never called; the premise is wrong", propose: "wont" }, pin)).value as {
        item: { status: string; proposal: { status: string; agentId: string | null; email: string; at: string } | null };
        hint: string;
      };
      off();
      expect(got).toEqual([{ kind: "items" }]);
      // The verdict is on the item; the item itself has not moved.
      expect(res.item.proposal).toMatchObject({ status: "wont", agentId: "a1", email: "alice@example.com" });
      expect(res.item.proposal!.at).not.toBe("");
      expect(res.item.status).toBe("open");
      expect(res.hint).toContain("nothing was retired");
      expect(db.getItem(itemId)!.status).toBe("open");
      // Nothing was retired: not the item's conversations, not the proposer's own.
      expect(terminated).toEqual([]);
      expect(convs["key-alice"]!.find((c) => c.id === "m1")!.status).toBe("running");
    });

    test("it shows wherever the item shows — the project a person opens, and the list an agent reads", async () => {
      const shown = (await (await call("alice", "GET", `/api/projects/${projectId}`)).json()).data;
      const item = shown.items.find((w: { id: string }) => w.id === itemId);
      expect(item.proposal).toMatchObject({ status: "wont", agentId: "a1" });
      // Still open, so it is still counted as work to do.
      expect(item.status).toBe("open");
      const listed = ((await tool("key-bob", "list_work_items", { project: projectId })).value as { items: { id: string; proposal: { status: string } | null }[] }).items;
      expect(listed.find((w) => w.id === itemId)!.proposal!.status).toBe("wont");
    });

    test("propose takes every way an item closes and nothing else", async () => {
      for (const bad of ["maybe", "open", "on ice"]) {
        const res = await tool("key-alice", "update_work_item", { item: itemId, propose: bad }, pin);
        expect(res.failed).toBe(true);
        expect(res.text).toContain("propose takes");
        // Refused whole: the standing proposal is not clobbered by a bad argument.
        expect(db.getItem(itemId)!.proposed_status).toBe("wont");
      }
      // The list the message offers is the list the tool takes.
      const listed = (await tool("key-alice", "update_work_item", { item: itemId, propose: "maybe" }, pin)).text;
      for (const s of ["done", "wont", "icebox"]) expect(listed).toContain(`"${s}"`);
    });

    // "This is real work, and not now" is a finding an agent reaches by
    // reading, exactly like "the premise is wrong" — and until there was a
    // state for it, it was prose in the notes that nothing counted.
    test("an agent can propose the icebox, and it is still open work until a person agrees", async () => {
      terminated.length = 0;
      const parked = (await tool("key-alice", "update_work_item", { item: itemId, notes: "worth doing after the migration lands", propose: "icebox" }, pin)).value as {
        item: { status: string; proposal: { status: string; agentId: string } | null };
      };
      expect(parked.item.proposal).toMatchObject({ status: "icebox", agentId: "a1" });
      // Proposing parks nothing: the item is still open work, and the agent's
      // own conversation — the one that reached the finding — is still up.
      expect(parked.item.status).toBe("open");
      expect(terminated).toEqual([]);
      expect(convs["key-alice"]!.find((c) => c.id === "m1")!.status).toBe("running");
      // Leave the fixture's verdict as the rest of this block expects it.
      await tool("key-alice", "update_work_item", { item: itemId, propose: "wont" }, pin);
    });

    test("a person confirming the icebox settles the question, and a parked item has nothing left to propose", async () => {
      const fresh = (await (await call("bob", "POST", `/api/projects/${projectId}/items`, { title: "rewrite the importer" })).json()).data.id as string;
      await tool("key-bob", "update_work_item", { item: fresh, propose: "icebox" });

      const confirmed = (await (await call("bob", "PATCH", `/api/projects/${projectId}/items/${fresh}`, { status: "icebox" })).json()) as {
        data: { status: string; proposal: unknown };
      };
      expect(confirmed.data.status).toBe("icebox");
      expect(confirmed.data.proposal).toBeNull();

      // On ice is closed, whatever else it is: the question has been answered.
      const again = await tool("key-bob", "update_work_item", { item: fresh, propose: "done" });
      expect(again.failed).toBe(true);
      expect(again.text).toContain("already closed (on ice)");
    });

    test("without a conversation the proposal names the account; a closed item has nothing left to propose", async () => {
      const fresh = (await (await call("bob", "POST", `/api/projects/${projectId}/items`, { title: "check whether bar is still used" })).json()).data.id as string;
      const made = (await tool("key-bob", "update_work_item", { item: fresh, propose: "done" })).value as { item: { proposal: { status: string; agentId: string | null; email: string } } };
      // A bare key is not an agent, so nobody's name goes on it — the account's does.
      expect(made.item.proposal).toMatchObject({ status: "done", agentId: null, email: "bob@example.com" });

      // A person agrees, which is what actually closes it; the question is then answered.
      const closed = (await (await call("bob", "PATCH", `/api/projects/${projectId}/items/${fresh}`, { status: "done" })).json()) as { data: { status: string; proposal: unknown } };
      expect(closed.data.status).toBe("done");
      expect(closed.data.proposal).toBeNull();

      const again = await tool("key-bob", "update_work_item", { item: fresh, propose: "wont" });
      expect(again.failed).toBe(true);
      expect(again.text).toContain("already closed");
    });

    test("either side can take it back: the agent withdraws, or a person dismisses it", async () => {
      terminated.length = 0;
      const withdrawn = (await tool("key-alice", "update_work_item", { item: itemId, propose: "none" }, pin)).value as { item: { proposal: unknown }; hint: string };
      expect(withdrawn.item.proposal).toBeNull();
      expect(withdrawn.hint).toContain("Withdrawn");

      await tool("key-alice", "update_work_item", { item: itemId, propose: "wont" }, pin);
      const dismissed = (await (await call("bob", "PATCH", `/api/projects/${projectId}/items/${itemId}`, { proposal: null })).json()) as { data: { status: string; proposal: unknown }; retired?: unknown };
      expect(dismissed.data.proposal).toBeNull();
      expect(dismissed.data.status).toBe("open");
      // Dismissing decides nothing, so nothing goes down.
      expect(dismissed.retired).toBeUndefined();
      expect(terminated).toEqual([]);
      expect(convs["key-alice"]!.find((c) => c.id === "m1")!.status).toBe("running");
    });

    test("confirming one is the ordinary close: the item shuts and its computers go", async () => {
      terminated.length = 0;
      await tool("key-alice", "update_work_item", { item: itemId, propose: "wont" }, pin);
      const res = (await (await call("bob", "PATCH", `/api/projects/${projectId}/items/${itemId}`, { status: "wont" })).json()) as {
        data: { status: string; proposal: unknown };
        retired: unknown;
      };
      expect(res.data.status).toBe("wont");
      expect(res.data.proposal).toBeNull();
      expect(res.retired).toEqual({ conversations: 1, computers: 1, failed: 0 });
      expect(terminated).toEqual(["m1"]);
    });
  });

  test("a conversation that is not on a work item has no project, and one that is not the key's is not found", async () => {
    const notOurs = await rpc("key-alice", "tools/list", undefined, { "x-fountain-conversation-id": "m2" });
    expect(notOurs.status).toBe(404);
    expect(((await notOurs.json()) as { error: string }).error).toBe("not_a_workbench_conversation");
    const missing = await rpc("key-bob", "tools/list", undefined, { "x-fountain-conversation-id": "m1" });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toBe("no_conversation");
  });
});

// ── the owner's cost view ────────────────────────────────────────────────

describe("what a project cost, for the owner who paid for it", () => {
  const goneItem = "deleteditem";

  beforeAll(() => {
    billingEnabled = true;
    const conv = (id: string, channel: string | null, turns: number, input: number, output: number, at: string): FakeConv => ({
      id,
      channel_id: channel,
      title: null,
      agent_id: "a1",
      environment_id: "e1",
      vault_id: "v1",
      sandbox_id: "sbX",
      status: "idle",
      inserted_at: at,
      turn_count: turns,
      usage_total: { input, output },
    });
    convs["key-alice"] = [
      conv("k1", `workbench:${projectId}/${itemId}/aaaaaaaaaaaa`, 3, 1000, 500, "2026-08-10T00:00:00Z"),
      conv("k2", `workbench:${projectId}/${itemId}/bbbbbbbbbbbb`, 2, 200, 100, "2026-08-12T00:00:00Z"),
      // The work item is long deleted here; its conversations still name it, and its spend still happened.
      conv("k3", `workbench:${projectId}/${goneItem}/cccccccccccc`, 1, 50, 25, "2026-08-11T00:00:00Z"),
      conv("k4", "fountain:team", 4, 70, 30, "2026-08-13T00:00:00Z"),
      // A workbench channel naming a project that is not hers is not hers to attribute.
      conv("k5", "workbench:bobproj/bobitem", 1, 10, 5, "2026-08-09T00:00:00Z"),
    ];
    convs["key-bob"] = [conv("kb1", "workbench:bobproj/bobitem", 6, 900, 400, "2026-08-14T00:00:00Z")];
  });

  afterAll(() => {
    billingEnabled = true;
  });

  const costOf = async (who: string) => (await (await call(who, "GET", "/api/me/cost")).json()).data as import("./cost").CostDto;

  test("no session, no bill", async () => {
    expect((await call(null, "GET", "/api/me/cost")).status).toBe(401);
  });

  test("the bill is the account's, as Fountain reports it — never per project, because Fountain does not attribute it", async () => {
    const cost = await costOf("alice");
    expect(cost.billingUnavailable).toBeNull();
    expect(cost.billing!.plan!.name).toBe("Team");
    expect(cost.billing!.usage!.turn_hours).toBe(7.5);
    expect(cost.billing!.period!.source).toBe("subscription");
  });

  test("the breakdown sums the conversations by the work item their channel names", async () => {
    const cost = await costOf("alice");
    const p = cost.projects.find((x) => x.id === projectId)!;
    expect(p.conversations).toBe(3);
    expect(p.turns).toBe(6);
    expect(p.input).toBe(1250);
    expect(p.output).toBe(625);
    expect(p.lastActiveAt).toBe("2026-08-12T00:00:00Z");

    const w = p.items.find((x) => x.id === itemId)!;
    expect([w.conversations, w.turns, w.input, w.output]).toEqual([2, 5, 1200, 600]);
    // Biggest first: what burned the day is at the top, not wherever it was filed.
    expect(p.items[0]!.id).toBe(itemId);

    // An item deleted here is still a line, so the project's own total adds up.
    const gone = p.items.find((x) => x.id === goneItem)!;
    expect(gone.title).toBeNull();
    expect(gone.status).toBeNull();
    expect(gone.input + gone.output).toBe(75);

    // Items nothing ran on are listed at zero rather than left out.
    expect(p.items.every((x) => typeof x.conversations === "number")).toBe(true);
  });

  test("what is not a project of yours is not silently folded into one", async () => {
    const cost = await costOf("alice");
    // `fountain:team` and a channel naming Bob's project: hers to see on her bill, not hers to attribute.
    expect(cost.elsewhere.conversations).toBe(2);
    expect(cost.elsewhere.input + cost.elsewhere.output).toBe(115);
    expect(cost.total.conversations).toBe(5);
    expect(cost.total.input).toBe(1330);
    expect(cost.total.output).toBe(660);
    // The parts do add up to the whole.
    const attributed = cost.projects.reduce((n, p) => n + p.conversations, 0);
    expect(attributed + cost.elsewhere.conversations).toBe(cost.total.conversations);
  });

  test("a member sees their own account, never the owner's — the bill is not behind the project boundary", async () => {
    const cost = await costOf("bob");
    // Bob is a member of Alice's project and owns bobproj. Only what he owns is here.
    expect(cost.projects.map((p) => p.id)).toEqual(["bobproj"]);
    expect(cost.projects[0]!.input).toBe(900);
    // And nothing of Alice's spend reached him.
    expect(cost.total.conversations).toBe(1);
    const alice = await costOf("alice");
    expect(alice.projects.map((p) => p.id)).not.toContain("bobproj");
  });

  test("billing switched off is said, not faked; the breakdown still stands", async () => {
    billingEnabled = false;
    const cost = await costOf("alice");
    expect(cost.billing).toBeNull();
    expect(cost.billingUnavailable).toBe("disabled");
    expect(cost.projects.find((p) => p.id === projectId)!.turns).toBe(6);
    billingEnabled = true;
  });
});

// ── the same work, in the unit the bill is in, over the window it covers ──
//
// `/api/me/cost` answers in lifetime tokens; the bill is turn hours over one
// period. This route closes both gaps by measuring each turn's own interval,
// so what it reports is a division of the account figure rather than a second
// number beside it. The clock matters here: the window is real, and a turn
// still running accrues only as far as now.

describe("what a project cost this billing period, measured in turn hours", () => {
  let cp = "";
  let thisMonth = "";
  let mixed = "";
  const HOUR_MS = 60 * 60 * 1000;
  const ago = (ms: number) => new Date(NOW - ms).toISOString();
  /** Carol owns more than this describe's project, so never index the list. */
  const mine = (p: import("./cost").PeriodCostDto) => p.projects.find((x) => x.id === cp)!;

  const conv = (id: string, channel: string | null, lastActive: string): FakeConv => ({
    id,
    channel_id: channel,
    title: null,
    agent_id: "a1",
    environment_id: "e1",
    vault_id: "v1",
    sandbox_id: "sbC",
    status: "idle",
    inserted_at: ago(30 * DAY_MS),
    last_active_at: lastActive,
    turn_count: 1,
    usage_total: { input: 1, output: 1 },
  });

  const turn = (n: number, startedAgo: number, endedAgo: number | null, input = 0, output = 0): FakeTurn => ({
    id: `t${n}`,
    turn_number: n,
    status: endedAgo === null ? "running" : "completed",
    started_at: ago(startedAgo),
    ended_at: endedAgo === null ? null : ago(endedAgo),
    usage: input || output ? { input, output } : null,
  });

  beforeAll(async () => {
    billingEnabled = true;
    await signIn("carol");
    cp = (await (await call("carol", "POST", "/api/projects", { name: "Carol's", environmentId: "e1", vaultId: "v1" })).json()).data.id;
    thisMonth = (await (await call("carol", "POST", `/api/projects/${cp}/items`, { title: "this month" })).json()).data.id;
    mixed = (await (await call("carol", "POST", `/api/projects/${cp}/items`, { title: "still going" })).json()).data.id;

    const on = (item: string) => `workbench:${cp}/${item}/${item.slice(0, 8)}`;
    convs["key-carol"] = [
      // Two ordinary turns wholly inside the window: 1 h and 30 min.
      conv("c1", on(thisMonth), ago(3 * DAY_MS)),
      // One turn that began before the period and ended inside it: only the
      // day inside counts, and its tokens land here because it ended here.
      conv("c2", on(thisMonth), ago(9 * DAY_MS)),
      // Last touched before the period opened: it cannot hold a turn inside
      // it, so this one is never asked about at all.
      conv("c3", on(mixed), ago(19 * DAY_MS)),
      // A turn still running: it accrues to now and no further.
      conv("c4", on(mixed), ago(0)),
      // A turn that never started bills nothing, and Fountain reports no start.
      conv("c5", on(mixed), ago(2 * DAY_MS)),
      // Recent, but with one turn wholly before the window: that one is not a
      // turn "this period" and its tokens were spent in the last one.
      conv("c6", on(thisMonth), ago(1 * DAY_MS)),
      // Fountain will not answer for this one; it is a hole, not a failed page.
      conv("cbroken", on(mixed), ago(2 * DAY_MS)),
      // Not a project of hers, so not a candidate and never a request.
      conv("cteam", "fountain:team", ago(1 * DAY_MS)),
    ];
    turnsOf.c1 = [turn(1, 3 * DAY_MS, 3 * DAY_MS - HOUR_MS, 100, 50), turn(2, 2 * DAY_MS, 2 * DAY_MS - HOUR_MS / 2, 20, 10)];
    turnsOf.c2 = [turn(1, 11 * DAY_MS, 9 * DAY_MS, 900, 900)];
    turnsOf.c3 = [turn(1, 20 * DAY_MS, 19 * DAY_MS, 7, 7)];
    turnsOf.c4 = [turn(1, HOUR_MS, null)];
    turnsOf.c5 = [{ id: "t1", turn_number: 1, status: "pending", started_at: null, ended_at: null, usage: null }];
    turnsOf.c6 = [turn(1, 12 * DAY_MS, 11 * DAY_MS, 500, 500), turn(2, 1 * DAY_MS, 1 * DAY_MS - 2 * HOUR_MS, 5, 5)];
    turnsBroken.add("cbroken");
  });

  afterAll(() => {
    billingEnabled = true;
    turnsBroken.delete("cbroken");
    convs["key-carol"] = [];
  });

  const periodOf = async (who: string) => (await (await call(who, "GET", "/api/me/cost/period")).json()).data as import("./cost").PeriodCostDto;

  test("no session, no breakdown", async () => {
    expect((await call(null, "GET", "/api/me/cost/period")).status).toBe(401);
  });

  test("the window is the bill's own, and measuring stops at now rather than at a period end that has not happened", async () => {
    const p = await periodOf("carol");
    expect(p.period).toEqual({ start: PERIOD_START, end: PERIOD_END, source: "subscription" });
    // The period runs 20 days into the future; the measurement does not.
    expect(Date.parse(p.measuredTo)).toBeLessThanOrEqual(Date.now() + 1000);
    expect(Date.parse(p.measuredTo)).toBeGreaterThan(Date.now() - 60_000);
    // The account figure is Fountain's, carried, not computed from our sum.
    expect(p.accountTurnHours).toBe(7.5);
  });

  test("a turn's own start and end are the measure, and a turn straddling the period start counts only the part inside", async () => {
    const p = await periodOf("carol");
    const item = mine(p).items.find((w) => w.id === thisMonth)!;
    // c1: 3600 + 1800. c2: began 11 days back, ended 9 days back, period opened
    // 10 days back, so one day of it — 86400 — not two. c6's second turn: 7200.
    expect(item.seconds).toBe(3600 + 1800 + 86_400 + 7200);
    expect(item.turns).toBe(4);
    expect(item.conversations).toBe(3);
    expect(item.title).toBe("this month");
  });

  test("tokens follow the turn that ended, so a turn spent in the last period is not spent again in this one", async () => {
    const p = await periodOf("carol");
    const item = mine(p).items.find((w) => w.id === thisMonth)!;
    // c1 120/60, c2 900/900 (it ended inside), c6's second turn 5/5. c6's
    // first turn ended before the window opened and its 500/500 stays there.
    expect(item.input).toBe(1025);
    expect(item.output).toBe(965);
  });

  test("a turn still running accrues as far as now and no further; one that never started bills nothing", async () => {
    const p = await periodOf("carol");
    const item = mine(p).items.find((w) => w.id === mixed)!;
    // c4's turn began an hour ago and has not ended: an hour, plus however
    // long this test took. c5 has a turn with no start, which is not a turn.
    expect(item.seconds).toBeGreaterThanOrEqual(3600);
    expect(item.seconds).toBeLessThan(3660);
    expect(item.turns).toBe(1);
    expect(item.conversations).toBe(1);
  });

  test("a conversation that cannot have run inside the window is not asked about", async () => {
    await periodOf("carol");
    // c3 was last touched before the period opened; cteam is not hers to attribute.
    expect(turnsAsked).not.toContain("c3");
    expect(turnsAsked).not.toContain("cteam");
    expect(turnsAsked.sort()).toEqual(["c1", "c2", "c4", "c5", "c6", "cbroken"]);
  });

  test("one conversation Fountain will not answer for is a hole it names, not a failed page", async () => {
    const p = await periodOf("carol");
    expect(p.fanout).toEqual({ candidates: 7, fetched: 5, cached: 0, skipped: 1, dropped: 0, failed: 1 });
    // And everything it could read still adds up.
    expect(p.measured.seconds).toBe(p.projects.reduce((n, x) => n + x.seconds, 0));
    expect(mine(p).seconds).toBe(mine(p).items.reduce((n, w) => n + w.seconds, 0));
  });

  test("a reload asks Fountain again only for what could have moved", async () => {
    await periodOf("carol");
    turnsAsked = [];
    const again = await periodOf("carol");
    // The finished conversations are cached against their turn count and last
    // activity. The one with a turn in flight is not — its figure grows with
    // the clock — and the one that errored was never cached.
    expect(turnsAsked.sort()).toEqual(["c4", "cbroken"]);
    expect(again.fanout.cached).toBe(4);
    expect(again.fanout.fetched).toBe(1);
    expect(again.fanout.failed).toBe(1);
  });

  test("a new turn invalidates the cache, because the stamp it was read at moved", async () => {
    await periodOf("carol");
    const c1 = convs["key-carol"]!.find((c) => c.id === "c1")!;
    const wasCount = c1.turn_count;
    const wasActive = c1.last_active_at;
    c1.turn_count = 9;
    c1.last_active_at = ago(0);
    turnsOf.c1 = [...turnsOf.c1!, turn(3, HOUR_MS, HOUR_MS / 2, 1, 1)];
    turnsAsked = [];
    const p = await periodOf("carol");
    expect(turnsAsked).toContain("c1");
    expect(mine(p).items.find((w) => w.id === thisMonth)!.turns).toBe(5);
    turnsOf.c1 = turnsOf.c1.slice(0, 2);
    c1.turn_count = wasCount;
    c1.last_active_at = wasActive;
  });

  test("a member sees their own account, never the owner's — the period breakdown is not behind the project boundary either", async () => {
    const carol = await periodOf("carol");
    expect(carol.projects.map((x) => x.id)).toContain(cp);
    // Alice owns the project carol is not in; nothing of hers is here, and
    // carol's project is nothing alice can see the cost of.
    const alice = await periodOf("alice");
    expect(alice.projects.map((x) => x.id)).not.toContain(cp);
    expect(alice.projects.map((x) => x.id)).toContain(projectId);
  });

  test("billing switched off falls back to the calendar month and offers no account figure to be a share of", async () => {
    billingEnabled = false;
    const p = await periodOf("carol");
    expect(p.period.source).toBe("calendar_month");
    expect(p.accountTurnHours).toBeNull();
    // The window changed, so the numbers did; that it still measured has not.
    expect(p.fanout.candidates).toBe(7);
    expect(p.projects.map((x) => x.id)).toContain(cp);
    billingEnabled = true;
  });
});

// ── snapshots, posted from inside the sandbox ────────────────────────────

describe("snapshots from inside the sandbox, and the disk reads beside them", () => {
  let projectId = "";
  let itemId = "";
  const seen: unknown[] = [];

  beforeAll(async () => {
    await signIn("alice");
    await signIn("bob");
    await signIn("carol");
    const p = (await (await call("alice", "POST", "/api/projects", { name: "Snapshots" })).json()) as { data: { id: string } };
    projectId = p.data.id;
    await call("alice", "POST", `/api/projects/${projectId}/members`, { email: "bob@example.com" });
    const w = (await (await call("alice", "POST", `/api/projects/${projectId}/items`, { title: "fix foo" })).json()) as { data: { id: string } };
    itemId = w.data.id;
    // The conversation the hook runs inside: alice's, on this item, on a computer.
    convs["key-alice"]!.push({
      id: "snap-c1",
      channel_id: `workbench:${projectId}/${itemId}/t1`,
      title: "Coder: fix foo",
      agent_id: "a1",
      environment_id: null,
      vault_id: null,
      sandbox_id: "sb-snap",
      status: "running",
      inserted_at: "2026-09-01T00:00:00Z",
    });
    events.subscribe(projectId, (data) => seen.push(data));
  });

  /** What the hook sends: the sandbox's key and its conversation, no cookie. */
  function post(headers: Record<string, string>, body: unknown): Promise<Response> {
    return app(new Request("http://wb.test/api/snapshots", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
  }
  const asSandbox = { authorization: "Bearer key-alice", "x-fountain-conversation-id": "snap-c1" };
  const git = {
    repo: "/home/sprite/work/thing",
    source: "stop",
    branch: "wb/fix-foo",
    head: "abc123",
    upstream: "origin/main",
    ahead: 2,
    behind: 1,
    status: "# branch.head wb/fix-foo\n1 .M N... 100644 100644 100644 x y README.md\n? SMOKE.md",
  };

  test("needs the conversation header: without it there is no item to record against", async () => {
    const res = await post({ authorization: "Bearer key-alice" }, git);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("conversation_required");
  });

  test("a key that never signed in here is refused, as at the MCP endpoint", async () => {
    expect((await post({ authorization: "Bearer key-dave", "x-fountain-conversation-id": "snap-c1" }, git)).status).toBe(401);
    expect((await post({ "x-fountain-conversation-id": "snap-c1" }, git)).status).toBe(401);
  });

  test("records the checkout's state against the item and the computer, tells the project, and members read it", async () => {
    const res = await post(asSandbox, { ...git, meta: { event: "Stop", tool: "" } });
    expect(res.status).toBe(201);
    const receipt = ((await res.json()) as { data: Record<string, unknown> }).data;
    expect(receipt.itemId).toBe(itemId);
    expect(receipt.computer).toBe("sb-snap");
    expect(seen).toContainEqual({ kind: "snapshot", itemId, computer: "sb-snap", repo: "/home/sprite/work/thing", source: "stop" });

    const listed = (await (await call("bob", "GET", `/api/projects/${projectId}/items/${itemId}/snapshots`)).json()) as { data: Record<string, unknown>[] };
    expect(listed.data).toHaveLength(1);
    const s = listed.data[0]!;
    expect(s).toMatchObject({ computer: "sb-snap", repo: "/home/sprite/work/thing", conversationId: "snap-c1", agentId: "a1", branch: "wb/fix-foo", head: "abc123", ahead: 2, behind: 1, source: "stop" });
    expect(s.status).toBe(git.status);
    expect(s.meta).toEqual({ event: "Stop", tool: "" });
    // No diff rides this way: bytes come from Fountain's read, redacted.
    expect("diff" in s).toBe(false);
    // Not in the project: the item does not exist for her.
    expect((await call("carol", "GET", `/api/projects/${projectId}/items/${itemId}/snapshots`)).status).toBe(404);
    expect((await call(null, "GET", `/api/projects/${projectId}/items/${itemId}/snapshots`)).status).toBe(401);
  });

  test("the latest state of a checkout replaces the one before it; a second checkout is a second row", async () => {
    expect((await post(asSandbox, { ...git, source: "post-commit", head: "def456" })).status).toBe(201);
    expect((await post(asSandbox, { ...git, repo: "/home/sprite/work/other", source: "post-tool" })).status).toBe(201);
    const listed = (await (await call("alice", "GET", `/api/projects/${projectId}/items/${itemId}/snapshots`)).json()) as { data: { repo: string; head: string; source: string }[] };
    expect(listed.data.map((s) => [s.repo, s.head, s.source]).sort()).toEqual([
      ["/home/sprite/work/other", "abc123", "post-tool"],
      ["/home/sprite/work/thing", "def456", "post-commit"],
    ]);
  });

  test("an unknown source reads as manual; a repo must be an absolute path", async () => {
    const res = await post(asSandbox, { ...git, repo: "/home/sprite/work/big", source: "whatever" });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: { source: string } }).data.source).toBe("manual");
    expect((await post(asSandbox, { ...git, repo: "relative/path" })).status).toBe(422);
  });

  test("a conversation on another project's item, or none of ours, records nothing here", async () => {
    convs["key-alice"]!.push({ id: "snap-plain", channel_id: null, title: null, agent_id: null, environment_id: null, vault_id: null, sandbox_id: null, status: "idle", inserted_at: "2026-09-01T00:00:00Z" });
    expect((await post({ authorization: "Bearer key-alice", "x-fountain-conversation-id": "snap-plain" }, git)).status).toBe(404);
    expect((await post({ authorization: "Bearer key-alice", "x-fountain-conversation-id": "snap-nope" }, git)).status).toBe(404);
    // bob's key cannot see alice's conversation, so bob's sandbox cannot post as it.
    expect((await post({ authorization: "Bearer key-bob", "x-fountain-conversation-id": "snap-c1" }, git)).status).toBe(404);
  });

  test("the disk of the project's computer is read through the proxy, query and all; another computer is not there", async () => {
    diskAsked.length = 0;
    const diff = await call("bob", "GET", `/f/${projectId}/api/sandboxes/sb-snap/diff?path=%2Fhome%2Fsprite%2Fwork%2Fthing&staged=true`);
    expect(diff.status).toBe(200);
    const body = ((await diff.json()) as { data: { diff: string; staged: boolean; repo_root: string } }).data;
    expect(body.diff).toContain("+b");
    expect(body.staged).toBe(true);
    expect(body.repo_root).toBe("/home/sprite/work/thing");
    expect((await call("bob", "GET", `/f/${projectId}/api/sandboxes/sb-snap/files?path=%2Fhome%2Fsprite%2Fwork`)).status).toBe(200);
    const file = (await (await call("alice", "GET", `/f/${projectId}/api/sandboxes/sb-snap/file?path=%2Fhome%2Fsprite%2Fwork%2Fthing%2FREADME.md`)).json()) as { data: { content: string } };
    expect(file.data.content).toBe("hello\n");
    expect(diskAsked.map((d) => [d.id, d.what])).toEqual([
      ["sb-snap", "diff"],
      ["sb-snap", "files"],
      ["sb-snap", "file"],
    ]);
    expect(diskAsked[0]!.query).toContain("staged=true");
    // Fountain's own refusals pass through as they are.
    const outside = await call("bob", "GET", `/f/${projectId}/api/sandboxes/sb-snap/diff?path=%2Fworkspace%2Fthing`);
    expect(outside.status).toBe(422);
    expect(((await outside.json()) as { error: string }).error).toBe("path_outside_sandbox");
    // sb2 hosts alice's private conversation, sb3 another project's: neither is this project's computer.
    expect((await call("bob", "GET", `/f/${projectId}/api/sandboxes/sb2/diff`)).status).toBe(404);
    expect((await call("bob", "GET", `/f/${projectId}/api/sandboxes/sb3/files`)).status).toBe(404);
    expect((await call("carol", "GET", `/f/${projectId}/api/sandboxes/sb-snap/diff`)).status).toBe(404);
    // Read-only upstream, read-only here.
    expect((await call("alice", "POST", `/f/${projectId}/api/sandboxes/sb-snap/diff`)).status).toBe(404);
  });
});

describe("the hook's installer", () => {
  test("is public, and posts back to the origin it was fetched from", async () => {
    const res = await app(new Request("http://wb.test/hook/install.sh", { headers: { "x-forwarded-proto": "https", "x-forwarded-host": "workbench.example" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/x-shellscript");
    const body = await res.text();
    expect(body).toContain('URL="${WORKBENCH_URL:-https://workbench.example}"');
    expect(body).toContain("/home/sprite/.claude/settings.local.json");
    expect(body).toContain("core.hooksPath");
    expect(body).not.toContain("__WORKBENCH_URL__");
    // No diff leaves the sandbox this way.
    expect(body).not.toContain("git diff");
    const plain = await app(new Request("http://wb.test/hook/install.sh"));
    expect(await plain.text()).toContain('URL="${WORKBENCH_URL:-http://wb.test}"');
  });
});
