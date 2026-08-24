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
/** Permission answers this fake accepted. A second one for the same request is too late. */
const answers: { conversation: string; request: string; option_id: unknown }[] = [];
let streamEvents: { conversation_id: string; id: number }[] = [];
/** An instance with billing switched off answers 404 there; flip this to be one. */
let billingEnabled = true;
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
      if (one[2] === "/turns") {
        turnsAsked.push(c.id);
        if (turnsBroken.has(c.id)) return Response.json({ error: "boom" }, { status: 500 });
        const own = turnsOf[c.id];
        if (own) return Response.json({ data: own });
        return Response.json({ data: [{ id: "t1", prompt: "hi", image_count: 1 }] });
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
    const sb = /^\/api\/sandboxes\/([^/]+)$/.exec(path);
    if (sb) {
      const on = convs[key]!.filter((c) => c.sandbox_id === sb[1]);
      if (on.length === 0) return Response.json({ error: "not_found" }, { status: 404 });
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
    if (path === "/api/agents") return Response.json({ data: [{ id: "a1", name: "Coder" }] });
    if (path === "/api/environments") return Response.json({ data: [{ id: "e1", name: "one" }, { id: "e2", name: "two" }] });
    if (path === "/api/vaults") return Response.json({ data: [{ id: "v1", name: "v-one" }, { id: "v2", name: "v-two" }] });
    if (path === "/api/events/stream") {
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
  fountain.stop(true);
  db.close();
});

beforeEach(() => {
  resetProxyCache();
  resetMcpCache();
  resetCostCache();
  turnsAsked = [];
});

const cookies: Record<string, string> = {};

async function call(who: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const h: Record<string, string> = { ...headers };
  if (who) h.cookie = cookies[who]!;
  if (body !== undefined) h["content-type"] = "application/json";
  return app(new Request(`http://wb.test${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }));
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

  test("a member creates items the owner sees", async () => {
    const res = await call("bob", "POST", `/api/projects/${projectId}/items`, { title: "fix foo", notes: "repro…" });
    expect(res.status).toBe(201);
    itemId = (await res.json()).data.id;
    const shown = (await (await call("alice", "GET", `/api/projects/${projectId}`)).json()).data;
    expect(shown.items.map((w: { id: string }) => w.id)).toEqual([itemId]);
    expect(shown.project.counts).toEqual({ open: 1, done: 0, wont: 0 });
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

describe("closing an item retires its computers", () => {
  let doneItem = "";
  let otherItem = "";
  let wontItem = "";

  beforeAll(async () => {
    const make = async (title: string) => (await (await call("bob", "POST", `/api/projects/${projectId}/items`, { title })).json()).data.id as string;
    doneItem = await make("ship it");
    otherItem = await make("still going");
    wontItem = await make("not worth it");
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

  test("swapping one closed state for the other retires nothing — the computers already went", async () => {
    terminated.length = 0;
    for (const status of ["done", "wont"]) {
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

  test("the counts tell the two apart", async () => {
    // By now: doneItem was reopened, otherItem is done, wontItem is won't do.
    const { counts } = (await (await call("bob", "GET", `/api/projects/${projectId}`)).json()).data.project;
    expect(counts.done).toBe(1);
    expect(counts.wont).toBe(1);
    expect(counts.open).toBeGreaterThan(0);
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
    // workbench — an agent that concludes "we should not do this" proposes it.
    for (const status of ["done", "wont"]) {
      const closed = await tool("key-bob", "update_work_item", { item: itemId, status });
      expect(closed.failed).toBe(true);
      expect(closed.text).toContain("`propose:");
    }
    expect(db.getItem(itemId)!.status).toBe("open");
    expect(db.getItem(itemId)!.proposed_status).toBe("");
  });

  test("work items can be listed by any of the three states", async () => {
    const listed = async (status?: string) =>
      ((await tool("key-bob", "list_work_items", { project: projectId, ...(status ? { status } : {}) })).value as { items: { id: string; status: string }[] }).items;
    expect((await listed("wont")).map((w) => w.status)).toEqual(["wont"]);
    expect((await listed("done")).map((w) => w.status)).toEqual(["done"]);
    expect((await listed("open")).every((w) => w.status === "open")).toBe(true);
    // Unfiltered is all of them, and a status nobody has is not a filter.
    const all = await listed();
    expect(all.length).toBe((await listed("open")).length + 2);
    expect((await listed("abandoned")).length).toBe(all.length);
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

    test("propose takes the two ways an item closes and nothing else", async () => {
      const bad = await tool("key-alice", "update_work_item", { item: itemId, propose: "maybe" }, pin);
      expect(bad.failed).toBe(true);
      expect(bad.text).toContain("propose takes");
      // Refused whole: the standing proposal is not clobbered by a bad argument.
      expect(db.getItem(itemId)!.proposed_status).toBe("wont");
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
