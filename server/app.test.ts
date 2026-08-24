import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { buildApp } from "./app";
import type { Config } from "./config";
import { ProjectEvents } from "./context";
import { Cipher } from "./crypto";
import { Db } from "./db";
import { resetMcpCache } from "./mcp";
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
  // A real Fountain account that has never signed in to the workbench.
  "key-dave": { id: "u-dave", email: "dave@example.com" },
};

const convs: Record<string, FakeConv[]> = { "key-alice": [], "key-bob": [], "key-carol": [], "key-dave": [] };
const posted: { key: string; body: Record<string, unknown> }[] = [];
/** Conversations this fake was asked to terminate; one whose id starts with `stuck` refuses. */
const terminated: string[] = [];
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

describe("done retires the item's computers", () => {
  let doneItem = "";
  let otherItem = "";

  beforeAll(async () => {
    const make = async (title: string) => (await (await call("bob", "POST", `/api/projects/${projectId}/items`, { title })).json()).data.id as string;
    doneItem = await make("ship it");
    otherItem = await make("still going");
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

  test("update rewrites the title and the notes; marking done is not on offer", async () => {
    const res = (await tool("key-bob", "update_work_item", { item: itemId, title: "fix foo properly", notes: "found it" })).value as { updated: boolean };
    expect(res.updated).toBe(true);
    expect(db.getItem(itemId)!.title).toBe("fix foo properly");
    expect(db.getItem(itemId)!.notes).toBe("found it");
    // Done retires the item's computers, so it stays a person's call in the workbench.
    const done = await tool("key-bob", "update_work_item", { item: itemId, status: "done" });
    expect(done.failed).toBe(true);
    expect(done.text).toContain("nothing to change");
    expect(db.getItem(itemId)!.status).toBe("open");
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

  test("a conversation that is not on a work item has no project, and one that is not the key's is not found", async () => {
    const notOurs = await rpc("key-alice", "tools/list", undefined, { "x-fountain-conversation-id": "m2" });
    expect(notOurs.status).toBe(404);
    expect(((await notOurs.json()) as { error: string }).error).toBe("not_a_workbench_conversation");
    const missing = await rpc("key-bob", "tools/list", undefined, { "x-fountain-conversation-id": "m1" });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toBe("no_conversation");
  });
});
