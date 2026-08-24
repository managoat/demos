import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { buildApp } from "./app";
import type { Config } from "./config";
import { ProjectEvents } from "./context";
import { Cipher } from "./crypto";
import { Db } from "./db";
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
}

const KEYS: Record<string, { id: string; email: string }> = {
  "key-alice": { id: "u-alice", email: "Alice@Example.com" },
  "key-bob": { id: "u-bob", email: "bob@example.com" },
  "key-carol": { id: "u-carol", email: "carol@example.com" },
};

const convs: Record<string, FakeConv[]> = { "key-alice": [], "key-bob": [], "key-carol": [] };
const posted: { key: string; body: Record<string, unknown> }[] = [];
let streamEvents: { conversation_id: string; id: number }[] = [];

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
      if (one[2] === "/turns") return Response.json({ data: [{ id: "t1", prompt: "hi" }] });
      if (one[2] === "/prompts") return Response.json({ data: { ok: true, prompt: (await req.json()).prompt } }, { status: 202 });
      if (one[2] === "/terminate") return new Response(null, { status: 204 });
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const sb = /^\/api\/sandboxes\/([^/]+)$/.exec(path);
    if (sb) {
      const on = convs[key]!.filter((c) => c.sandbox_id === sb[1]);
      if (on.length === 0) return Response.json({ error: "not_found" }, { status: 404 });
      return Response.json({ data: { id: sb[1], sprite_name: `sprite-${sb[1]}`, status: "ready", conversations: on.map((c) => ({ id: c.id, status: c.status, mid_turn: false })) } });
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

  test("a member creates items the owner sees", async () => {
    const res = await call("bob", "POST", `/api/projects/${projectId}/items`, { title: "fix foo", notes: "repro…" });
    expect(res.status).toBe(201);
    itemId = (await res.json()).data.id;
    const shown = (await (await call("alice", "GET", `/api/projects/${projectId}`)).json()).data;
    expect(shown.items.map((w: { id: string }) => w.id)).toEqual([itemId]);
    expect(shown.project.counts).toEqual({ open: 1, done: 0 });
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
