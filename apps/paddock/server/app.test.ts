/**
 * The permission boundary, tested from the outside.
 *
 * These are not coverage tests. Each one is a way somebody could reach
 * something they should not, written down so it stays closed: the ops tab
 * (which changes the machine), terminate (which ends a tab for everybody), the
 * config surface, another owner's paddock, and a link that has been re-minted.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildRouter } from "./app";
import { loadConfig } from "./config";
import type { AppContext } from "./context";
import { Cipher, randomToken, sha256 } from "./crypto";
import { Db } from "./db";
import { hub } from "./hub";
import { channelFor, OPS_SLUG } from "../shared/tabs";
import { MAX_COMPUTERS } from "./computers";
import { sweepExpired } from "./starter";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OWNER = "owner@example.com";
const OTHER = "other@example.com";
/** This application's own Fountain credential, which opens claimable principals. */
const APP_KEY = "ftn_app";
const BOX = "sb-test-1";
const AGENT = "a1";

/**
 * The computer the fake Fountain's machine is on.
 *
 * A channel names its computer, and the id is only known once a paddock row
 * exists — so `paddockFor` fills this in for whoever asks first, which in
 * every test that has a machine is the owner. Tests about a second computer
 * set it themselves.
 */
let machinePaddock: string | null = null;

/** The conversations the fake Fountain reports for the owner's account. */
function conversations() {
  const pid = machinePaddock ?? "unclaimed";
  return [
    conv("c1", channelFor(pid, "t1", 1), "2026-09-04T10:00:00Z"),
    conv("c2", channelFor(pid, "t2", 1), "2026-09-04T11:00:00Z"),
    conv("cops", channelFor(pid, OPS_SLUG, 1), "2026-09-04T12:00:00Z"),
  ];
}

function conv(id: string, channel: string, at: string) {
  return {
    id,
    title: null,
    sandbox_id: BOX,
    sandbox: null,
    agent_id: AGENT,
    vault_id: "v1",
    environment_id: "e1",
    runtime: "claude",
    status: "idle",
    channel_id: channel,
    turn_count: 1,
    last_active_at: null,
    inserted_at: at,
  };
}

let ctx: AppContext;
let route: (req: Request) => Promise<Response>;
let upstream: { method: string; path: string; key: string }[] = [];
const realFetch = globalThis.fetch;

/**
 * The fake Fountain's claimable principals (fountain#1551).
 *
 * Modelled on the two properties paddock actually depends on, rather than on
 * the whole API. `principal_id` never changes, so a test can assert that a
 * claim did not move the machine; and both create and claim are idempotent by
 * `Idempotency-Key`, with create handing back a *new* pair of secrets each
 * time — which is what makes a replay dangerous and worth testing.
 */
interface Grant {
  id: string;
  principal_id: string;
  api_key: string;
  claim_token: string;
  status: string;
  expires_at: string | null;
  claimed_by: string | null;
}
let grants: Map<string, Grant>;
let grantByIdem: Map<string, string>;
let grantSeq = 0;

/**
 * What the next claimable-users call should do instead of working. One hook
 * rather than a flag per failure: every interesting case here is "Fountain
 * answered X once", and a test that has to reach for two flags is a test about
 * the harness.
 */
let claimableHook: ((method: string, path: string) => Response | null) | null = null;

/** How long a grant lasts in these tests, and where its clock is wound to. */
let grantExpiresAt: string | null = "2099-01-01T00:00:00.000Z";

function claimableRoutes(method: string, path: string, headers: Record<string, string>, body: Record<string, unknown>): Response | null {
  const hooked = claimableHook?.(method, path);
  if (hooked) return hooked;

  if (path === "/api/claimable-users" && method === "POST") {
    const idem = headers["idempotency-key"] ?? "";
    const known = idem ? grantByIdem.get(idem) : undefined;
    const grant: Grant = known
      ? grants.get(known)!
      : { id: `cl-${++grantSeq}`, principal_id: `pr-${++grantSeq}`, api_key: "", claim_token: "", status: "unclaimed", expires_at: grantExpiresAt, claimed_by: null };
    // New secrets on every create, replay included: Fountain kept neither, so
    // it has nothing to give back twice, and the previous pair stops working.
    grant.api_key = `ftn_principal_${++grantSeq}`;
    grant.claim_token = `clt_${++grantSeq}`;
    grants.set(grant.id, grant);
    if (idem) grantByIdem.set(idem, grant.id);
    return Response.json({ data: grant });
  }

  const m = /^\/api\/claimable-users\/([^/]+)(\/claim)?$/.exec(path);
  if (!m) return null;
  const grant = grants.get(m[1]!);
  if (!grant) return Response.json({ error: "not_found" }, { status: 404 });

  if (m[2]) {
    if (method !== "POST") return Response.json({ error: "not_found" }, { status: 404 });
    const claimer = (headers.authorization ?? "").replace(/^Bearer /, "");
    if (grant.status === "claimed") {
      // Idempotent for the account that already holds it — that is what lets a
      // lost response be finished — and a refusal for anybody else.
      if (grant.claimed_by !== claimer) return Response.json({ error: "already_claimed" }, { status: 409 });
      return Response.json({ data: { user: { id: `u-${claimer}`, email: emailFor(claimer) }, principal_id: grant.principal_id, status: "claimed", api_key: grant.api_key } });
    }
    if (grant.status !== "unclaimed") return Response.json({ error: "gone" }, { status: 410 });
    if (body.claim_token !== grant.claim_token) return Response.json({ error: "forbidden" }, { status: 403 });
    grant.status = "claimed";
    grant.claimed_by = claimer;
    grant.api_key = `ftn_claimed_${++grantSeq}`;
    return Response.json({ data: { user: { id: `u-${claimer}`, email: emailFor(claimer) }, principal_id: grant.principal_id, status: "claimed", api_key: grant.api_key } });
  }

  if (method === "DELETE") {
    if (grant.status === "claimed") return Response.json({ error: "conflict" }, { status: 409 });
    grant.status = "released";
    return new Response(null, { status: 204 });
  }
  const { api_key: _k, claim_token: _t, claimed_by: _c, ...rest } = grant;
  return Response.json({ data: rest });
}

/** The fake's one identity rule, in one place: a key names its owner. */
function emailFor(key: string): string {
  return key === "ftn_owner" ? OWNER : `${key}@example.com`;
}

beforeEach(async () => {
  const config = {
    ...loadConfig({
      DATA_DIR: "/tmp",
      PADDOCK_SECRET: "0123456789abcdef0123",
      // The feature ships behind these two, and both are needed: the flag on
      // its own leaves `anonymousStart` false, which is the point of it.
      ANONYMOUS_START: "1",
      FOUNTAIN_APP_KEY: APP_KEY,
    }),
    dbPath: ":memory:",
  };
  ctx = { config, db: new Db(":memory:"), cipher: await Cipher.from(config.secret) };
  route = buildRouter(ctx);
  upstream = [];
  hub.reset();
  machinePaddock = null;
  grants = new Map();
  grantByIdem = new Map();
  claimableHook = null;
  grantExpiresAt = "2099-01-01T00:00:00.000Z";

  // A fake Fountain. Only the calls the proxy actually makes are answered;
  // anything else 404s, so an unexpected upstream call fails a test loudly.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const key = (headers.authorization ?? "").replace(/^Bearer /, "");
    // The key is recorded, not just the path: after a claim the machine has to
    // run on the credential the claim handed back, and nothing but the key on
    // the wire can show that it does.
    upstream.push({ method, path: url.pathname, key });
    if (url.pathname === "/api/auth/me") {
      // One identity per key, so a test can be somebody else. The fake used to
      // answer OWNER for every key, which quietly made every "another person"
      // scenario a test of the owner signing in as themselves.
      return Response.json({ id: `u-${key}`, email: emailFor(key) });
    }
    if (url.pathname.startsWith("/api/claimable-users")) {
      const parsed = url.pathname === "/api/claimable-users" || method === "POST" ? JSON.parse(String(init?.body ?? "{}")) : {};
      const answer = claimableRoutes(method, url.pathname, headers, parsed as Record<string, unknown>);
      if (answer) return answer;
    }
    if (url.pathname === "/api/conversations" && method === "GET") return Response.json({ data: conversations() });
    if (url.pathname === "/api/conversations" && method === "POST") {
      // Fountain identity-checks an attach: the disk was built for one
      // (agent, environment, vault) and naming a different one — including by
      // omitting a field the box was built with — is a 422.
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, string | undefined>;
      if (body.sandbox_id) {
        const wanted = { agent_id: AGENT, environment_id: "e1", vault_id: "v1" };
        for (const key of ["agent_id", "environment_id", "vault_id"] as const) {
          if ((body[key] ?? null) !== wanted[key]) {
            return Response.json({ error: "sandbox_identity_mismatch" }, { status: 422 });
          }
        }
      }
      return Response.json({ data: conv("c3", channelFor(machinePaddock!, "t3", 1), "2026-09-04T13:00:00Z") });
    }
    if (/^\/api\/conversations\/[^/]+/.test(url.pathname)) return Response.json({ status: "accepted" });
    if (url.pathname === "/api/catalog") return Response.json({ data: { runtimes: ["claude"], models: {} } });
    if (/^\/api\/agents\/[^/]+$/.test(url.pathname)) return Response.json({ data: { id: AGENT, name: "Paddock", runtime: "claude", model: "m" } });
    if (method === "DELETE" && /^\/api\/(agents|environments|vaults)\/[^/]+$/.test(url.pathname)) return new Response(null, { status: 204 });
    if (/^\/api\/environments\/[^/]+$/.test(url.pathname)) return Response.json({ data: { id: "e1", name: "Paddock" } });
    // First run makes all three. The fake answered none of them until an
    // unclaimed computer had to build its own machine through this proxy.
    if (method === "POST" && url.pathname === "/api/environments") return Response.json({ data: { id: "e1", name: "Paddock" } });
    if (method === "POST" && url.pathname === "/api/vaults") return Response.json({ data: { id: "v1", name: "Paddock" } });
    if (method === "POST" && url.pathname === "/api/agents") return Response.json({ data: { id: AGENT, name: "Paddock", runtime: "claude", model: "m" } });
    if (/^\/api\/(environments|vaults)\/[^/]+\/secrets$/.test(url.pathname)) return Response.json({ data: [] });
    if (url.pathname === "/api/connections" || url.pathname === "/api/connections/providers") return Response.json({ data: [] });
    // Only this paddock's box exists upstream; the proxy is what refuses the
    // others, so the fake has to be willing to serve any of them.
    if (/^\/api\/sandboxes\/[^/]+/.test(url.pathname)) return Response.json({ data: { path: "/", entries: [], truncated: false } });
    return Response.json({ error: "not_found" }, { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Sign an owner in the way the real sign-in does, and give back their cookie. */
async function signIn(email: string): Promise<string> {
  ctx.db.upsertUser(email, "u1", await ctx.cipher.encrypt("ftn_test_key"));
  const token = randomToken();
  ctx.db.createUserSession(await sha256(token), email);
  return `paddock_session=${encodeURIComponent(token)}`;
}

/** A guest of one tab — the only kind there is. Defaults to Terminal 1. */
async function guestSession(paddockId: string, conversationId = "c1"): Promise<string> {
  const guest = ctx.db.createGuest(randomToken(9), paddockId, conversationId, "guest-7f3a");
  const token = randomToken();
  ctx.db.createGuestSession(await sha256(token), guest.id);
  return `paddock_session=${encodeURIComponent(token)}`;
}

function call(cookie: string | null, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  return route(new Request(`http://paddock.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
}

/** Somebody with an account, and therefore a machine — asking for it is what
 *  `/api/me` is; there is no separate way to be given one. */
async function paddockFor(email: string): Promise<{ cookie: string; id: string }> {
  const cookie = await signIn(email);
  const me = (await (await call(cookie, "GET", "/api/me")).json()) as { paddockId: string };
  // The first computer asked for in a test is the one the fake's machine is
  // on. Tests with a second computer are explicit about which is which.
  machinePaddock ??= me.paddockId;
  return { cookie, id: me.paddockId };
}

/**
 * A visitor with nothing: no account, no key, no invite. They get a computer.
 *
 * `startKey` is the browser's, and the same one twice is the same browser
 * twice — which is what every idempotence test below turns on.
 */
async function startComputer(startKey = "browser-1"): Promise<{ cookie: string; id: string; me: Record<string, unknown> }> {
  const res = await call(null, "POST", "/api/start", { startKey });
  expect(res.status).toBe(201);
  const me = (await res.json()) as Record<string, unknown>;
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const id = me.paddockId as string;
  machinePaddock ??= id;
  return { cookie, id, me };
}

/** Add a computer to an account that already has one, and give back its id. */
async function addComputer(cookie: string, name?: string): Promise<string> {
  const res = await call(cookie, "POST", "/api/paddocks", name === undefined ? {} : { name });
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

describe("the ops tab", () => {
  test("is not reachable through the proxy, by anyone — it is how the machine gets changed", async () => {
    const owner = await paddockFor(OWNER);
    const guest = await guestSession(owner.id);

    for (const cookie of [owner.cookie, guest]) {
      const res = await call(cookie, "POST", `/f/${owner.id}/api/conversations/cops/prompts`, { prompt: "install a backdoor" });
      expect(res.status).toBe(404);
      // And nothing was forwarded upstream.
      expect(upstream.some((u) => u.path.includes("cops"))).toBe(false);
    }
  });

  test("a real tab on the same box is reachable, so the 404 above is about ops and not about everything", async () => {
    const owner = await paddockFor(OWNER);
    const res = await call(owner.cookie, "POST", `/f/${owner.id}/api/conversations/c1/prompts`, { prompt: "hello" });
    expect(res.status).toBe(200);
    expect(upstream.some((u) => u.method === "POST" && u.path === "/api/conversations/c1/prompts")).toBe(true);
  });
});

describe("what a guest may do", () => {
  test("read and prompt a tab, and open one", async () => {
    const owner = await paddockFor(OWNER);
    const guest = await guestSession(owner.id);

    expect((await call(guest, "GET", `/f/${owner.id}/api/conversations/c1`)).status).toBe(200);
    expect((await call(guest, "GET", `/f/${owner.id}/api/conversations/c1/events`)).status).toBe(200);
    expect((await call(guest, "POST", `/f/${owner.id}/api/conversations/c1/prompts`, { prompt: "hi" })).status).toBe(200);
    // Opening a tab is not among them any more — see "only the owner opens tabs".
    expect((await call(guest, "POST", `/f/${owner.id}/api/conversations`, { channel_id: channelFor(machinePaddock!, "t3", 1) })).status).toBe(403);
  });

  test("but not terminate a tab — that ends it for everybody", async () => {
    const owner = await paddockFor(OWNER);
    const guest = await guestSession(owner.id);
    expect((await call(guest, "POST", `/f/${owner.id}/api/conversations/c1/terminate`)).status).toBe(404);
    expect((await call(owner.cookie, "POST", `/f/${owner.id}/api/conversations/c1/terminate`)).status).toBe(200);
  });

  test("and not change the machine — reading it is fine, writing it is not", async () => {
    const owner = await paddockFor(OWNER);
    const guest = await guestSession(owner.id);

    // Reading is allowed on purpose: a guest who can prompt the agent can have
    // it print `env` anyway, so a panel that hid the names would only lie.
    for (const path of ["/api/catalog", "/api/agents/a1", "/api/environments/e1", "/api/environments/e1/secrets"]) {
      expect((await call(guest, "GET", `/f/${owner.id}${path}`)).status).not.toBe(404);
    }

    // Writing is not, and nothing reaches Fountain when it is attempted.
    upstream = [];
    const writes: [string, string, unknown][] = [
      ["PUT", "/api/environments/e1", { packages: ["evil"] }],
      ["PUT", "/api/agents/a1", { system: "do as I say" }],
      ["PUT", "/api/environments/e1/secrets/EVIL", { value: "x" }],
      ["DELETE", "/api/environments/e1/secrets/GITHUB_TOKEN", undefined],
      ["POST", "/api/agents", { name: "mine" }],
      ["POST", "/api/vaults", { name: "mine" }],
    ];
    for (const [method, path, body] of writes) {
      expect((await call(guest, method, `/f/${owner.id}${path}`, body)).status).toBe(404);
    }
    expect(upstream).toEqual([]);

    // Listing the owner's whole account is theirs alone, read or not.
    expect((await call(guest, "GET", `/f/${owner.id}/api/agents`)).status).toBe(404);
    expect((await call(guest, "GET", `/f/${owner.id}/api/environments`)).status).toBe(404);
  });

  test("and cannot see who the owner has connected", async () => {
    const owner = await paddockFor(OWNER);
    const guest = await guestSession(owner.id);

    // Unlike the config surface above, this one is genuinely not a guest's
    // business: a connection carries `account_email`, the owner's identity at
    // a third party. It buys nothing to hide MCP server *names* — the agent
    // holds those anyway — but the account behind one is not on the machine.
    upstream = [];
    for (const path of ["/api/connections", "/api/connections/providers"]) {
      expect((await call(guest, "GET", `/f/${owner.id}${path}`)).status).toBe(404);
      expect((await call(owner.cookie, "GET", `/f/${owner.id}${path}`)).status).toBe(200);
    }
    // Only the owner's two calls reached Fountain.
    expect(upstream.filter((u) => u.path.startsWith("/api/connections"))).toHaveLength(2);
  });

  test("and paddock never creates a connection provider, for anyone", async () => {
    const owner = await paddockFor(OWNER);
    // Account-level state, and the rule this proxy is built on is that the
    // owner's authority here stops at their own machine. Connecting happens at
    // Fountain, in a browser signed in as them.
    upstream = [];
    for (const [method, path] of [
      ["POST", "/api/connection-providers"],
      ["POST", "/api/connection-providers/cp1/discover"],
      ["DELETE", "/api/connections/cn1"],
    ] as const) {
      expect((await call(owner.cookie, method, `/f/${owner.id}${path}`, {})).status).toBe(404);
    }
    expect(upstream).toEqual([]);
  });

  test("and cannot read a sandbox that is not this machine", async () => {
    const owner = await paddockFor(OWNER);
    const guest = await guestSession(owner.id);
    expect((await call(guest, "GET", `/f/${owner.id}/api/sandboxes/${BOX}/files?path=/`)).status).not.toBe(404);
    // Another box on the same owner's key is still not this paddock's.
    expect((await call(guest, "GET", `/f/${owner.id}/api/sandboxes/sb-somebody-else/files?path=/`)).status).toBe(404);
  });

  test("and cannot invite anyone or mint a link", async () => {
    const owner = await paddockFor(OWNER);
    const guest = await guestSession(owner.id);
    expect((await call(guest, "POST", `/api/paddock/${owner.id}/tabs/c1/members`, { email: "x@example.com" })).status).toBe(403);
    expect((await call(guest, "POST", `/api/paddock/${owner.id}/tabs/c1/invite`)).status).toBe(403);
  });
});

describe("a guest is not a member", () => {
  test("a guest of one paddock cannot reach another", async () => {
    const a = await paddockFor(OWNER);
    const b = await paddockFor(OTHER);
    const guestOfA = await guestSession(a.id);
    expect((await call(guestOfA, "GET", `/f/${b.id}/api/conversations/c1`)).status).toBe(404);
    expect((await call(guestOfA, "POST", `/api/paddock/${b.id}/presence`, { clientId: "x" })).status).toBe(404);
  });

  test("a guest never counts as the owner, however the paddock is addressed", async () => {
    const owner = await paddockFor(OWNER);
    const guest = await guestSession(owner.id);
    const res = await call(guest, "GET", "/api/me");
    expect(((await res.json()) as { role: string; kind: string }).role).toBe("guest");
    expect(((await call(guest, "GET", "/api/paddock")).json() as Promise<{ data: { role: string } }>).then((b) => b.data.role)).resolves.toBe("guest");
  });

  test("a member may not change the machine's people either — only the owner", async () => {
    const owner = await paddockFor(OWNER);
    const memberCookie = await signIn(OTHER);
    ctx.db.addMember(owner.id, "c1", OTHER, OWNER);
    expect((await call(memberCookie, "POST", `/api/paddock/${owner.id}/tabs/c1/members`, { email: "x@example.com" })).status).toBe(403);
    // But they can leave.
    expect((await call(memberCookie, "DELETE", `/api/paddock/${owner.id}/tabs/c1/members/${encodeURIComponent(OTHER)}`)).status).toBe(200);
  });
});

describe("invite links", () => {
  test("re-minting evicts everyone who came in on the old one", async () => {
    const owner = await paddockFor(OWNER);
    await call(owner.cookie, "POST", `/api/paddock/${owner.id}/tabs/c1/invite`);
    const token = ctx.db.inviteFor(owner.id, "c1")?.token ?? null!;

    const joined = await call(null, "POST", `/api/join/${token}`);
    expect(joined.status).toBe(200);
    const cookie = joined.headers.get("set-cookie")!.split(";")[0]!;
    expect((await call(cookie, "GET", `/f/${owner.id}/api/conversations/c1`)).status).toBe(200);

    // Re-mint. The guest's session must die with the link, not outlive it.
    const reminted = await call(owner.cookie, "POST", `/api/paddock/${owner.id}/tabs/c1/invite`);
    expect(((await reminted.json()) as { evicted: number }).evicted).toBe(1);

    const after = await call(cookie, "GET", `/f/${owner.id}/api/conversations/c1`);
    expect(after.status).toBe(401);
    expect(((await after.json()) as { error: string }).error).toBe("invite_revoked");
    expect(ctx.db.inviteFor(owner.id, "c1")?.token ?? null).not.toBe(token);
  });

  test("an old token stops naming a paddock once it is replaced", async () => {
    const owner = await paddockFor(OWNER);
    await call(owner.cookie, "POST", `/api/paddock/${owner.id}/tabs/c1/invite`);
    const first = ctx.db.inviteFor(owner.id, "c1")?.token ?? null!;
    await call(owner.cookie, "POST", `/api/paddock/${owner.id}/tabs/c1/invite`);
    expect((await call(null, "POST", `/api/join/${first}`)).status).toBe(404);
  });

  test("closing the link leaves no way in at all", async () => {
    const owner = await paddockFor(OWNER);
    await call(owner.cookie, "POST", `/api/paddock/${owner.id}/tabs/c1/invite`);
    const token = ctx.db.inviteFor(owner.id, "c1")?.token ?? null!;
    await call(owner.cookie, "DELETE", `/api/paddock/${owner.id}/tabs/c1/invite`);
    expect((await call(null, "POST", `/api/join/${token}`)).status).toBe(404);
    expect(ctx.db.inviteFor(owner.id, "c1")?.token ?? null).toBeNull();
  });

  test("following a link while signed in keeps your identity rather than demoting you", async () => {
    const owner = await paddockFor(OWNER);
    await call(owner.cookie, "POST", `/api/paddock/${owner.id}/tabs/c1/invite`);
    const token = ctx.db.inviteFor(owner.id, "c1")?.token ?? null!;

    // The owner opening their own link stays the owner.
    const asOwner = await call(owner.cookie, "POST", `/api/join/${token}`);
    expect(((await asOwner.json()) as { role: string }).role).toBe("owner");

    // Someone with an account becomes a named member, not an anonymous guest.
    const otherCookie = await signIn(OTHER);
    const asUser = await call(otherCookie, "POST", `/api/join/${token}`);
    const body = (await asUser.json()) as { role: string; kind: string; email: string };
    expect(body).toMatchObject({ role: "member", kind: "user", email: OTHER });
    expect(ctx.db.memberTabs(owner.id, OTHER).includes("c1")).toBe(true);
  });
});

describe("unauthenticated", () => {
  test("no session reaches nothing but the public routes", async () => {
    const owner = await paddockFor(OWNER);
    expect((await call(null, "GET", "/api/me")).status).toBe(401);
    expect((await call(null, "GET", "/api/paddock")).status).toBe(401);
    expect((await call(null, "GET", `/f/${owner.id}/api/conversations/c1`)).status).toBe(401);
    expect((await call(null, "GET", "/api/config")).status).toBe(200);
    expect((await call(null, "GET", "/healthz")).status).toBe(200);
    // The skills index says nothing about any paddock, but a session is still
    // required — otherwise this is an open proxy in front of skills.sh.
    expect((await call(null, "GET", "/api/skills/search?q=pdf")).status).toBe(401);
  });
});

describe("the skills index", () => {
  test("a session reaches it, and a query too short never leaves the server", async () => {
    const owner = await paddockFor(OWNER);
    upstream = [];
    const res = await call(owner.cookie, "GET", "/api/skills/search?q=p");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
    expect(upstream).toEqual([]);
  });

  test("an index that will not answer is not an error — the manual form still works", async () => {
    const owner = await paddockFor(OWNER);
    // The fake upstream 404s anything it does not know, skills.sh included.
    // A query of its own: the 60s cache is module-level and outlives a test.
    const res = await call(owner.cookie, "GET", "/api/skills/search?q=nothing-answers");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [], unavailable: true });
  });

  test("a hit that could not be installed is dropped rather than offered", async () => {
    const owner = await paddockFor(OWNER);
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith("https://skills.sh/")) {
        return Response.json({
          skills: [
            { id: "anthropics/skills/pdf", skillId: "pdf", name: "pdf", installs: 190_279, source: "anthropics/skills" },
            // Fountain interpolates the id into a `bash -lc` behind an
            // allow-list that raises on `&`. skills.sh really lists this one.
            { skillId: "pdf-merge-&-split", name: "pdf merge & split", installs: 3914, source: "claude-office-skills/skills" },
            // Not an owner/repo, so nothing can be installed from it.
            { skillId: "pdf", name: "pdf", installs: 12, source: "bare" },
          ],
        });
      }
      return inner(input, init);
    }) as typeof fetch;

    const res = await call(owner.cookie, "GET", "/api/skills/search?q=pdf-hits");
    expect(await res.json()).toEqual({
      data: [{ source: "anthropics/skills", skill: "pdf", label: "pdf", installs: 190279 }],
    });
  });
});

describe("turns carry who sent them", () => {
  test("alone, a prompt goes in unlabelled; with company it names the sender", async () => {
    const owner = await paddockFor(OWNER);
    const sent: string[] = [];
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body === "string" && String(input).includes("/prompts")) {
        sent.push((JSON.parse(init.body) as { prompt: string }).prompt);
      }
      return inner(input as string, init);
    }) as typeof fetch;

    await call(owner.cookie, "POST", `/f/${owner.id}/api/conversations/c1/prompts`, { prompt: "alone" });
    expect(sent[0]).toBe("alone");

    await guestSession(owner.id);
    await call(owner.cookie, "POST", `/f/${owner.id}/api/conversations/c1/prompts`, { prompt: "with company" });
    expect(sent[1]).toBe(`[from ${OWNER}] with company`);
  });
});

describe("more than one computer", () => {
  test("adding one makes a row and touches Fountain not at all", async () => {
    const owner = await paddockFor(OWNER);
    upstream = [];
    const second = await addComputer(owner.cookie);

    expect(second).not.toBe(owner.id);
    // No agent, no environment, no vault, no sandbox. All of that is built by
    // the browser the first time somebody opens the machine, which is what
    // makes an unvisited computer free.
    expect(upstream).toEqual([]);

    const me = (await (await call(owner.cookie, "GET", "/api/me")).json()) as {
      paddocks: { id: string; name: string; role: string; original: boolean }[];
    };
    expect(me.paddocks.map((p) => p.id)).toEqual([owner.id, second]);
    expect(me.paddocks.map((p) => p.name)).toEqual(["My computer", "Computer 2"]);
    // Only the first one is the original, and that never moves.
    expect(me.paddocks.map((p) => p.original)).toEqual([true, false]);
  });

  test("the original is the one that was there first, however fast they were made", async () => {
    // The tiebreak used to be the paddock id — a random token — so signing in
    // and adding a computer inside the same millisecond made the *new* one the
    // original about half the time, and it adopted the old machine's tabs.
    const owner = await paddockFor(OWNER);
    const added: string[] = [];
    for (let n = 0; n < 5; n++) added.push(await addComputer(owner.cookie));

    const me = (await (await call(owner.cookie, "GET", "/api/me")).json()) as { paddocks: { id: string; original: boolean }[] };
    expect(me.paddocks.map((p) => p.id)).toEqual([owner.id, ...added]);
    expect(me.paddocks.filter((p) => p.original).map((p) => p.id)).toEqual([owner.id]);
  });

  test("a new computer has no machine yet, and the one you have is not lent to it", async () => {
    const owner = await paddockFor(OWNER);
    const second = await addComputer(owner.cookie);

    // The account's box is on the first computer. Asking the second for a tab
    // strip gets an empty one rather than the first computer's terminals.
    const strip = (await (await call(owner.cookie, "GET", `/f/${second}/api/conversations`)).json()) as { data: unknown[] };
    expect(strip.data).toEqual([]);

    // And the first computer's tabs are not reachable through the second.
    for (const path of ["/api/conversations/c1", "/api/conversations/c2"]) {
      expect((await call(owner.cookie, "GET", `/f/${second}${path}`)).status).toBe(404);
    }
    // Nor is its box, which the owner's key could otherwise read.
    expect((await call(owner.cookie, "GET", `/f/${second}/api/sandboxes/${BOX}/files?path=/`)).status).toBe(404);
    // The first computer still works, so the 404s above are about scope.
    expect((await call(owner.cookie, "GET", `/f/${owner.id}/api/conversations/c1`)).status).toBe(200);
  });

  test("a tab cannot be opened onto a computer its channel does not name", async () => {
    const owner = await paddockFor(OWNER);
    const second = await addComputer(owner.cookie);

    // The channel is how every later request decides which machine a tab is
    // on. One that named the other computer would be a tab this paddock could
    // never see again — and one the other computer's guests suddenly could.
    upstream = [];
    const res = await call(owner.cookie, "POST", `/f/${second}/api/conversations`, {
      channel_id: channelFor(owner.id, "t1", 1),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("wrong_computer");
    expect(upstream).toEqual([]);
  });

  test("a guest of one computer knows nothing of the other", async () => {
    const owner = await paddockFor(OWNER);
    const second = await addComputer(owner.cookie);
    const guest = await guestSession(owner.id, "c1");

    // Not "empty" — not there. The existence of a second machine is not part
    // of what a link to Terminal 1 hands over.
    expect((await call(guest, "GET", `/f/${second}/api/conversations`)).status).toBe(404);
    expect((await call(guest, "GET", `/api/paddock/${second}`)).status).toBe(404);
    expect((await call(guest, "POST", `/api/paddock/${second}/presence`, { clientId: "x" })).status).toBe(404);
  });

  test("retiring one computer leaves the other's machine alone", async () => {
    const owner = await paddockFor(OWNER);
    const second = await addComputer(owner.cookie);

    // The fake's tabs are all on the first computer, so a rebuild of the
    // second has nothing of its own to end — and must not reach for theirs.
    upstream = [];
    const res = await call(owner.cookie, "POST", `/api/paddock/${second}/rebuild`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { terminated: number; removed: string[] } };
    expect(data.terminated).toBe(0);
    expect(data.removed).toEqual([]);
    expect(upstream.some((u) => u.path.endsWith("/terminate"))).toBe(false);
    expect(upstream.some((u) => u.method === "DELETE")).toBe(false);
  });

  test("removing a computer retires its machine and forgets the row", async () => {
    const owner = await paddockFor(OWNER);
    const second = await addComputer(owner.cookie);

    const res = await call(owner.cookie, "DELETE", `/api/paddock/${second}`);
    expect(res.status).toBe(200);
    expect(ctx.db.getPaddock(second)).toBeNull();

    const me = (await (await call(owner.cookie, "GET", "/api/me")).json()) as { paddocks: { id: string }[] };
    expect(me.paddocks.map((p) => p.id)).toEqual([owner.id]);
    // And the row is gone for good rather than reappearing under /api/me.
    expect((await call(owner.cookie, "GET", `/api/paddock/${second}`)).status).toBe(404);
  });

  test("the last computer cannot be removed — an account always has one", async () => {
    const owner = await paddockFor(OWNER);
    upstream = [];
    const res = await call(owner.cookie, "DELETE", `/api/paddock/${owner.id}`);
    // Removing it would hand back a fresh empty machine on the next /api/me,
    // which reads as the delete having silently failed. Start over is the
    // operation for emptying the one you have, and the message says so.
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("last_computer");
    expect(ctx.db.getPaddock(owner.id)).not.toBeNull();
    // Nothing was retired on the way to that refusal.
    expect(upstream).toEqual([]);
  });

  test("names are the owner's, and nobody else's to set", async () => {
    const owner = await paddockFor(OWNER);
    const second = await addComputer(owner.cookie, "  the   build   box  ");
    expect(ctx.db.getPaddock(second)!.name).toBe("the build box");

    await call(owner.cookie, "PATCH", `/api/paddock/${second}`, { name: "laptop" });
    expect(ctx.db.getPaddock(second)!.name).toBe("laptop");
    expect((await call(owner.cookie, "PATCH", `/api/paddock/${second}`, { name: "   " })).status).toBe(422);

    // A guest of the first computer cannot rename either of them.
    const guest = await guestSession(owner.id, "c1");
    expect((await call(guest, "PATCH", `/api/paddock/${owner.id}`, { name: "mine now" })).status).toBe(403);
    expect((await call(guest, "PATCH", `/api/paddock/${second}`, { name: "mine now" })).status).toBe(404);
    expect(ctx.db.getPaddock(second)!.name).toBe("laptop");
  });

  test("a member of somebody's terminal cannot add a computer to their account", async () => {
    const owner = await paddockFor(OWNER);
    const memberCookie = await signIn(OTHER);
    ctx.db.addMember(owner.id, "c1", OTHER, OWNER);

    // They can have one of their own — everybody with an account can — but it
    // is on *their* account, not on the one that invited them.
    const made = await addComputer(memberCookie);
    expect(ctx.db.getPaddock(made)!.owner_email).toBe(OTHER);
    expect(ctx.db.paddocksOf(OWNER).map((p) => p.id)).toEqual([owner.id]);

    // And neither of the other account's computers is theirs to remove.
    expect((await call(memberCookie, "DELETE", `/api/paddock/${owner.id}`)).status).toBe(403);
  });

  test("a guest has no account to hang a computer off", async () => {
    const owner = await paddockFor(OWNER);
    const guest = await guestSession(owner.id, "c1");
    const res = await call(guest, "POST", "/api/paddocks", {});
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("account_required");
  });

  test("there is a ceiling, because every computer opened is a machine somebody pays for", async () => {
    const owner = await paddockFor(OWNER);
    for (let n = 1; n < MAX_COMPUTERS; n++) await addComputer(owner.cookie);
    expect(ctx.db.paddocksOf(OWNER)).toHaveLength(MAX_COMPUTERS);

    const res = await call(owner.cookie, "POST", "/api/paddocks", {});
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("too_many");
  });
});

describe("a machine from before there could be two", () => {
  /**
   * The fake, rewired to serve channels with no computer in them — the shape
   * every tab on a live paddock has today. Losing these would take somebody's
   * box away on deploy, which is the one outcome this app exists to prevent.
   */
  function tabsFromBeforeComputers(): void {
    const inner = globalThis.fetch;
    const channels = ["paddock:t1@r1", "paddock:t2@r1", `paddock:${OPS_SLUG}@r1`];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url));
      if (url.pathname === "/api/conversations" && (init?.method ?? "GET") === "GET") {
        return Response.json({ data: channels.map((channel, i) => conv(["c1", "c2", "cops"][i]!, channel, `2026-09-04T1${i}:00:00Z`)) });
      }
      return inner(input as string, init);
    }) as typeof fetch;
  }

  test("its tabs stay with the computer it already had", async () => {
    const owner = await paddockFor(OWNER);
    tabsFromBeforeComputers();

    const strip = (await (await call(owner.cookie, "GET", `/f/${owner.id}/api/conversations`)).json()) as { data: { id: string }[] };
    expect(strip.data.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect((await call(owner.cookie, "GET", `/f/${owner.id}/api/sandboxes/${BOX}/files?path=/`)).status).toBe(200);
  });

  test("and a computer added afterwards does not inherit them", async () => {
    const owner = await paddockFor(OWNER);
    tabsFromBeforeComputers();
    const second = await addComputer(owner.cookie);

    // Only the *original* computer claims an un-named tab, so an account can
    // never end up with two machines pointing at one box.
    const theirs = (await (await call(owner.cookie, "GET", `/f/${second}/api/conversations`)).json()) as { data: unknown[] };
    expect(theirs.data).toEqual([]);
    expect((await call(owner.cookie, "GET", `/f/${second}/api/conversations/c1`)).status).toBe(404);
  });
});

describe("replacing the machine", () => {
  test("rebuild ends every tab and retires the agent, and leaves the settings alone", async () => {
    const owner = await paddockFor(OWNER);
    upstream = [];
    const res = await call(owner.cookie, "POST", `/api/paddock/${owner.id}/rebuild`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { terminated: number; removed: string[]; failed: unknown[] } };

    // Every paddock conversation, the hidden ops tab included: a machine is
    // not retired while something is still running on it.
    expect(data.terminated).toBe(3);
    expect(upstream.filter((u) => u.path.endsWith("/terminate")).map((u) => u.path)).toEqual([
      "/api/conversations/c1/terminate",
      "/api/conversations/c2/terminate",
      "/api/conversations/cops/terminate",
    ]);

    // The agent is what changes the identity, so it is what has to go.
    expect(data.removed).toEqual(["agent"]);
    expect(data.failed).toEqual([]);

    // And the settings are untouched — that is the whole difference from reset.
    expect(upstream.some((u) => u.method === "DELETE" && u.path.startsWith("/api/environments"))).toBe(false);
    expect(upstream.some((u) => u.method === "DELETE" && u.path.startsWith("/api/vaults"))).toBe(false);
  });

  test("reset takes the environment and vault too, and with them every secret", async () => {
    const owner = await paddockFor(OWNER);
    upstream = [];
    const res = await call(owner.cookie, "POST", `/api/paddock/${owner.id}/reset`);
    const { data } = (await res.json()) as { data: { removed: string[] } };
    expect(data.removed).toEqual(["agent", "environment", "vault"]);
  });

  test("reset closes the way in: the link dies and its guests with it", async () => {
    const owner = await paddockFor(OWNER);
    await call(owner.cookie, "POST", `/api/paddock/${owner.id}/tabs/c1/invite`);
    const token = ctx.db.inviteFor(owner.id, "c1")?.token ?? null!;
    const joined = await call(null, "POST", `/api/join/${token}`);
    const guestCookie = joined.headers.get("set-cookie")!.split(";")[0]!;

    await call(owner.cookie, "POST", `/api/paddock/${owner.id}/reset`);

    expect(ctx.db.inviteFor(owner.id, "c1")?.token ?? null).toBeNull();
    expect((await call(null, "POST", `/api/join/${token}`)).status).toBe(404);
    expect((await call(guestCookie, "GET", "/api/me")).status).toBe(401);
  });

  test("a rebuild leaves an invited guest in place for the machine that replaces it", async () => {
    const owner = await paddockFor(OWNER);
    await call(owner.cookie, "POST", `/api/paddock/${owner.id}/tabs/c1/invite`);
    const token = ctx.db.inviteFor(owner.id, "c1")?.token ?? null!;
    const joined = await call(null, "POST", `/api/join/${token}`);
    const guestCookie = joined.headers.get("set-cookie")!.split(";")[0]!;

    await call(owner.cookie, "POST", `/api/paddock/${owner.id}/rebuild`);

    expect(ctx.db.inviteFor(owner.id, "c1")?.token ?? null).toBe(token);
    expect((await call(guestCookie, "GET", "/api/me")).status).toBe(200);
  });

  test("neither is anybody else's to do", async () => {
    const owner = await paddockFor(OWNER);
    const guest = await guestSession(owner.id);
    const memberCookie = await signIn(OTHER);
    ctx.db.addMember(owner.id, "c1", OTHER, OWNER);

    upstream = [];
    for (const cookie of [guest, memberCookie]) {
      for (const what of ["rebuild", "reset"]) {
        expect((await call(cookie, "POST", `/api/paddock/${owner.id}/${what}`)).status).toBe(403);
      }
    }
    // And nothing was terminated or deleted on the way to those refusals.
    expect(upstream).toEqual([]);
  });

  test("an agent Fountain will not delete is retired anyway, rather than silently left in place", async () => {
    const owner = await paddockFor(OWNER);
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url));
      if ((init?.method ?? "GET") === "DELETE" && url.pathname.startsWith("/api/agents/")) {
        return Response.json({ error: "agent_in_use", message: "still referenced" }, { status: 409 });
      }
      return inner(input as string, init);
    }) as typeof fetch;

    const res = await call(owner.cookie, "POST", `/api/paddock/${owner.id}/rebuild`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { removed: string[] } };
    // Un-marked instead: ensureIdentity looks for the marker, so this is
    // genuinely retired even though the record survives.
    expect(data.removed).toEqual(["agent (retired, not deleted)"]);
  });

  test("an agent that can be neither deleted nor retired is an error, not a lie", async () => {
    const owner = await paddockFor(OWNER);
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url));
      const method = (init?.method ?? "GET").toUpperCase();
      if ((method === "DELETE" || method === "PUT") && url.pathname.startsWith("/api/agents/")) {
        return Response.json({ error: "nope", message: "refused" }, { status: 409 });
      }
      return inner(input as string, init);
    }) as typeof fetch;

    const res = await call(owner.cookie, "POST", `/api/paddock/${owner.id}/rebuild`);
    // Reporting success here would send somebody back to the same machine.
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("retire_failed");
  });
});

describe("opening a tab on an existing machine", () => {
  test("names the whole identity, not just the agent", async () => {
    // A disk is built for (agent, environment, vault). An attach that sends
    // only the agent is asking for a different identity — one with neither —
    // and Fountain refuses it. This is what broke the + button.
    const owner = await paddockFor(OWNER);
    upstream = [];
    const res = await call(owner.cookie, "POST", `/f/${owner.id}/api/conversations`, { title: "Terminal 3", channel_id: channelFor(machinePaddock!, "t3", 1) });
    expect(res.status).toBe(200);
  });

  test("the owner's attach is built from their own machine, whatever the body asks for", async () => {
    const owner = await paddockFor(OWNER);
    const res = await call(owner.cookie, "POST", `/f/${owner.id}/api/conversations`, {
      channel_id: channelFor(machinePaddock!, "t4", 1),
      agent_id: "somebody-elses-agent",
      sandbox_id: "somebody-elses-box",
      environment_id: "nope",
    });
    expect(res.status).toBe(200);
  });
});

describe("an invitation is to a tab, not to the machine", () => {
  test("a guest of Terminal 1 cannot see, read or prompt Terminal 2", async () => {
    const owner = await paddockFor(OWNER);
    const guest = await guestSession(owner.id, "c1");

    // The strip they get is one tab long.
    const strip = (await (await call(guest, "GET", `/f/${owner.id}/api/conversations`)).json()) as { data: { id: string }[] };
    expect(strip.data.map((c) => c.id)).toEqual(["c1"]);

    // Their own tab works.
    expect((await call(guest, "GET", `/f/${owner.id}/api/conversations/c1`)).status).toBe(200);
    expect((await call(guest, "POST", `/f/${owner.id}/api/conversations/c1/prompts`, { prompt: "hi" })).status).toBe(200);

    // The other one does not exist as far as they are concerned.
    upstream = [];
    for (const sub of ["", "/events", "/stream", "/turns"]) {
      expect((await call(guest, "GET", `/f/${owner.id}/api/conversations/c2${sub}`)).status).toBe(404);
    }
    expect((await call(guest, "POST", `/f/${owner.id}/api/conversations/c2/prompts`, { prompt: "hi" })).status).toBe(404);
    expect(upstream.some((u) => u.path.includes("c2"))).toBe(false);
  });

  test("nor can they learn who else is in a tab they are not in", async () => {
    const owner = await paddockFor(OWNER);
    const guest = await guestSession(owner.id, "c1");
    expect((await call(guest, "GET", `/api/paddock/${owner.id}/tabs/c1/people`)).status).toBe(200);
    expect((await call(guest, "GET", `/api/paddock/${owner.id}/tabs/c2/people`)).status).toBe(404);
  });

  test("a member invited to one tab is a member of that tab only", async () => {
    const owner = await paddockFor(OWNER);
    const memberCookie = await signIn(OTHER);
    ctx.db.addMember(owner.id, "c2", OTHER, OWNER);

    const strip = (await (await call(memberCookie, "GET", `/f/${owner.id}/api/conversations`)).json()) as { data: { id: string }[] };
    expect(strip.data.map((c) => c.id)).toEqual(["c2"]);
    expect((await call(memberCookie, "GET", `/f/${owner.id}/api/conversations/c1`)).status).toBe(404);
    expect((await call(memberCookie, "GET", `/f/${owner.id}/api/conversations/c2`)).status).toBe(200);
  });

  test("two links, two tabs: closing one leaves the other alone", async () => {
    const owner = await paddockFor(OWNER);
    await call(owner.cookie, "POST", `/api/paddock/${owner.id}/tabs/c1/invite`);
    await call(owner.cookie, "POST", `/api/paddock/${owner.id}/tabs/c2/invite`);
    const first = ctx.db.inviteFor(owner.id, "c1")!.token;
    const second = ctx.db.inviteFor(owner.id, "c2")!.token;
    expect(first).not.toBe(second);

    const inOne = await call(null, "POST", `/api/join/${first}`);
    const inTwo = await call(null, "POST", `/api/join/${second}`);
    const cookieOne = inOne.headers.get("set-cookie")!.split(";")[0]!;
    const cookieTwo = inTwo.headers.get("set-cookie")!.split(";")[0]!;

    // Re-minting Terminal 1's link evicts its guest and nobody else's.
    const reminted = await call(owner.cookie, "POST", `/api/paddock/${owner.id}/tabs/c1/invite`);
    expect(((await reminted.json()) as { evicted: number }).evicted).toBe(1);
    expect((await call(cookieOne, "GET", "/api/me")).status).toBe(401);
    expect((await call(cookieTwo, "GET", "/api/me")).status).toBe(200);
    expect(ctx.db.inviteFor(owner.id, "c2")!.token).toBe(second);
  });

  test("a link drops you into the tab it was made for", async () => {
    const owner = await paddockFor(OWNER);
    await call(owner.cookie, "POST", `/api/paddock/${owner.id}/tabs/c2/invite`);
    const token = ctx.db.inviteFor(owner.id, "c2")!.token;
    const joined = await call(null, "POST", `/api/join/${token}`);
    const cookie = joined.headers.get("set-cookie")!.split(";")[0]!;

    const strip = (await (await call(cookie, "GET", `/f/${owner.id}/api/conversations`)).json()) as { data: { id: string }[] };
    expect(strip.data.map((c) => c.id)).toEqual(["c2"]);
  });

  test("following a tab's link while signed in makes you a member of that tab", async () => {
    const owner = await paddockFor(OWNER);
    await call(owner.cookie, "POST", `/api/paddock/${owner.id}/tabs/c2/invite`);
    const token = ctx.db.inviteFor(owner.id, "c2")!.token;
    const otherCookie = await signIn(OTHER);
    await call(otherCookie, "POST", `/api/join/${token}`);
    expect(ctx.db.memberTabs(owner.id, OTHER)).toEqual(["c2"]);
  });
});

describe("only the owner opens tabs", () => {
  test("a guest and a member are both refused, and nothing reaches Fountain", async () => {
    const owner = await paddockFor(OWNER);
    const guest = await guestSession(owner.id, "c1");
    const memberCookie = await signIn(OTHER);
    ctx.db.addMember(owner.id, "c1", OTHER, OWNER);

    upstream = [];
    for (const cookie of [guest, memberCookie]) {
      const res = await call(cookie, "POST", `/f/${owner.id}/api/conversations`, { channel_id: channelFor(machinePaddock!, "t9", 1) });
      expect(res.status).toBe(403);
    }
    expect(upstream.some((u) => u.method === "POST" && u.path === "/api/conversations")).toBe(false);

    // And the owner still can.
    expect((await call(owner.cookie, "POST", `/f/${owner.id}/api/conversations`, { channel_id: channelFor(machinePaddock!, "t9", 1) })).status).toBe(200);
  });
});

describe("a guest signing in", () => {
  /** Join a tab by link and come back with the guest's cookie. */
  async function joinByLink(owner: { cookie: string; id: string }, conv: string): Promise<string> {
    await call(owner.cookie, "POST", `/api/paddock/${owner.id}/tabs/${conv}/invite`);
    const token = ctx.db.inviteFor(owner.id, conv)!.token;
    const joined = await call(null, "POST", `/api/join/${token}`);
    return joined.headers.get("set-cookie")!.split(";")[0]!;
  }

  test("keeps the seat: the guest becomes a member of the same terminal", async () => {
    const owner = await paddockFor(OWNER);
    const guestCookie = await joinByLink(owner, "c2");

    const res = await call(guestCookie, "POST", "/api/auth/session", { apiKey: "ftn_theirs" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; email: string; role: string; paddockId: string; upgradedFrom: string };

    expect(body.kind).toBe("user");
    // Whatever handle they were given — it says who they used to be.
    expect(body.upgradedFrom).toMatch(/^guest-[0-9a-f]{4}$/);
    // Landed where they were, not somewhere else.
    expect(body.paddockId).toBe(owner.id);
    expect(ctx.db.memberTabs(owner.id, body.email)).toEqual(["c2"]);
  });

  test("and stops being a guest, so they are not in the room twice", async () => {
    const owner = await paddockFor(OWNER);
    const guestCookie = await joinByLink(owner, "c2");
    expect(ctx.db.guests(owner.id, "c2")).toHaveLength(1);

    await call(guestCookie, "POST", "/api/auth/session", { apiKey: "ftn_theirs" });
    expect(ctx.db.guests(owner.id, "c2")).toHaveLength(0);
  });

  test("survives the re-mint that would have evicted them", async () => {
    const owner = await paddockFor(OWNER);
    const guestCookie = await joinByLink(owner, "c2");
    const upgraded = await call(guestCookie, "POST", "/api/auth/session", { apiKey: "ftn_theirs" });
    const cookie = upgraded.headers.get("set-cookie")!.split(";")[0]!;

    // The thing that ends a guest's visit.
    const reminted = await call(owner.cookie, "POST", `/api/paddock/${owner.id}/tabs/c2/invite`);
    expect(((await reminted.json()) as { evicted: number }).evicted).toBe(0);

    // Still in, and still only in that terminal.
    expect((await call(cookie, "GET", `/f/${owner.id}/api/conversations/c2`)).status).toBe(200);
    expect((await call(cookie, "GET", `/f/${owner.id}/api/conversations/c1`)).status).toBe(404);
  });

  test("can reach their own machine and the one they were invited to", async () => {
    const owner = await paddockFor(OWNER);
    const guestCookie = await joinByLink(owner, "c2");
    const upgraded = await call(guestCookie, "POST", "/api/auth/session", { apiKey: "ftn_theirs" });
    const cookie = upgraded.headers.get("set-cookie")!.split(";")[0]!;

    // Nobody asked for it: an account has a machine of its own because it is
    // an account. Asking used to be the browser's job, and the browser only
    // asked when it had nowhere at all to land — which somebody let in by a
    // link never is, so they were left holding only the terminal they were lent.
    const me = (await (await call(cookie, "GET", "/api/me")).json()) as { paddocks: { id: string; role: string }[] };
    expect(me.paddocks.map((p) => p.role).sort()).toEqual(["member", "owner"]);
    expect(me.paddocks.some((p) => p.id === owner.id && p.role === "member")).toBe(true);
  });

  test("and the machine of their own is theirs alone — the invite did not follow them onto it", async () => {
    const owner = await paddockFor(OWNER);
    const guestCookie = await joinByLink(owner, "c2");
    const upgraded = await call(guestCookie, "POST", "/api/auth/session", { apiKey: "ftn_theirs" });
    const cookie = upgraded.headers.get("set-cookie")!.split(";")[0]!;
    const me = (await (await call(cookie, "GET", "/api/me")).json()) as { email: string; paddocks: { id: string; role: string }[] };
    const own = me.paddocks.find((p) => p.role === "owner")!;

    expect(own.id).not.toBe(owner.id);
    expect(ctx.db.getPaddock(own.id)!.owner_email).toBe(me.email);
    // And whoever invited them has no seat on it.
    expect((await call(owner.cookie, "GET", `/api/paddock/${own.id}`)).status).toBe(404);
  });

  test("somebody already signed in who follows a link keeps a machine of their own too", async () => {
    const owner = await paddockFor(OWNER);
    // An account that was never a guest, arriving at somebody else's terminal.
    const theirs = await signIn(OTHER);
    await call(owner.cookie, "POST", `/api/paddock/${owner.id}/tabs/c2/invite`);
    const token = ctx.db.inviteFor(owner.id, "c2")!.token;
    const joined = (await (await call(theirs, "POST", `/api/join/${token}`)).json()) as {
      role: string;
      paddockId: string;
      paddocks: { id: string; role: string }[];
    };

    // Landed on the terminal they were sent, with their own still in the list.
    expect(joined.role).toBe("member");
    expect(joined.paddockId).toBe(owner.id);
    expect(joined.paddocks.map((p) => p.role).sort()).toEqual(["member", "owner"]);
  });

  test("the owner signing in on their own link is not demoted to a member of it", async () => {
    const owner = await paddockFor(OWNER);
    const guestCookie = await joinByLink(owner, "c2");
    // Same account as the machine's owner, arriving through their own link.
    const res = await call(guestCookie, "POST", "/api/auth/session", { apiKey: "ftn_owner" });
    const body = (await res.json()) as { role: string; upgradedFrom?: string };
    expect(body.role).toBe("owner");
    expect(body.upgradedFrom).toBeUndefined();
    expect(ctx.db.memberTabs(owner.id, OWNER)).toEqual([]);
  });

  test("signing in without having been a guest changes nothing about anybody's membership", async () => {
    const owner = await paddockFor(OWNER);
    const res = await call(null, "POST", "/api/auth/session", { apiKey: "ftn_someone" });
    const body = (await res.json()) as { upgradedFrom?: string; email: string };
    expect(body.upgradedFrom).toBeUndefined();
    expect(ctx.db.memberTabs(owner.id, body.email)).toEqual([]);
  });
});

/**
 * Starting a computer before there is anybody to own it, and claiming it.
 * Issue #14, on fountain#1551.
 *
 * The two things worth writing down are at the ends of the flow. At the front:
 * a visitor with nothing gets exactly one machine, however many times they ask
 * — because every one of those is a real tenant on this application's bill. At
 * the back: claiming changes who is behind the machine and nothing else, so
 * every id a person could have come to depend on reads the same afterwards.
 *
 * In between is a permission boundary that is new rather than adapted. An
 * anonymous owner is a full owner of one terminal and of nothing that spends
 * more, invites anybody, or changes what the machine is made of.
 */
describe("starting a computer without an account", () => {
  test("a visitor with no session gets one unclaimed computer, one session, and a real principal", async () => {
    const { cookie, id, me } = await startComputer();

    expect(me.kind).toBe("starter");
    expect(me.role).toBe("owner");
    expect(me.email).toBeNull();
    expect(me.claim).toEqual({ status: "unclaimed", expiresAt: "2099-01-01T00:00:00.000Z" });
    expect(me.paddocks).toHaveLength(1);

    const row = ctx.db.getPaddock(id)!;
    expect(row.claim_status).toBe("unclaimed");
    expect(row.owner_email).toBeNull();
    expect(row.fountain_principal_id).toBeTruthy();
    // The machine runs on the principal's own credential, not on any user's.
    expect(row.compute_key_enc).toBeTruthy();
    expect(ctx.db.getUser("")).toBeNull();

    // And the session is that computer's, not a guest's and not a user's.
    const me2 = (await (await call(cookie, "GET", "/api/me")).json()) as Record<string, unknown>;
    expect(me2.kind).toBe("starter");
    expect(me2.paddockId).toBe(id);
  });

  test("the grant is opened on the application's key, never on anything the browser holds", async () => {
    await startComputer();
    const opened = upstream.find((u) => u.method === "POST" && u.path === "/api/claimable-users");
    expect(opened?.key).toBe(APP_KEY);
  });

  test("a deployment without the flag does not offer it, and says so rather than 500ing", async () => {
    const plain = { ...loadConfig({ DATA_DIR: "/tmp", PADDOCK_SECRET: "0123456789abcdef0123" }), dbPath: ":memory:" };
    expect(plain.anonymousStart).toBe(false);
    const off = buildRouter({ ...ctx, config: plain });
    const res = await off(new Request("http://paddock.test/api/start", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("start_unavailable");
    // And the SPA is told, so it shows the sign-in screen instead of asking.
    const cfg = (await (await off(new Request("http://paddock.test/api/config"))).json()) as { anonymousStart: boolean };
    expect(cfg.anonymousStart).toBe(false);
  });

  test("a flag with no application key is still off — the credential is the feature", async () => {
    expect(loadConfig({ DATA_DIR: "/tmp", PADDOCK_SECRET: "0123456789abcdef0123", ANONYMOUS_START: "1" }).anonymousStart).toBe(false);
  });
});

describe("starting twice", () => {
  test("a refresh finds the same computer rather than opening a second principal", async () => {
    const first = await startComputer("same-browser");
    upstream = [];
    const second = await startComputer("same-browser");

    expect(second.id).toBe(first.id);
    expect(grants.size).toBe(1);
    expect(upstream.filter((u) => u.path === "/api/claimable-users")).toEqual([]);
  });

  test("concurrent starts from one browser are one start — a replayed create would kill the first key", async () => {
    const [a, b] = await Promise.all([call(null, "POST", "/api/start", { startKey: "racy" }), call(null, "POST", "/api/start", { startKey: "racy" })]);
    const [ja, jb] = (await Promise.all([a.json(), b.json()])) as Record<string, unknown>[];

    expect(ja!.paddockId).toBe(jb!.paddockId as string);
    expect(grants.size).toBe(1);
    expect(upstream.filter((u) => u.method === "POST" && u.path === "/api/claimable-users")).toHaveLength(1);

    // The stored credential is the one Fountain last handed out. A second
    // create would have rotated it and left this row holding a dead key.
    const row = ctx.db.getPaddock(ja!.paddockId as string)!;
    expect(await ctx.cipher.decrypt(row.compute_key_enc!)).toBe([...grants.values()][0]!.api_key);
  });

  test("a start with a live session answers with that session, not with another machine", async () => {
    const owner = await paddockFor(OWNER);
    const res = await call(owner.cookie, "POST", "/api/start", { startKey: "irrelevant" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { kind: string }).kind).toBe("user");
    expect(grants.size).toBe(0);
  });

  test("an invite link is joined without an unclaimed computer being opened first", async () => {
    const owner = await paddockFor(OWNER);
    const minted = (await (await call(owner.cookie, "POST", `/api/paddock/${owner.id}/tabs/c1/invite`)).json()) as { data: { inviteUrl: string } };
    const token = minted.data.inviteUrl.split("/join/")[1]!;

    const res = await call(null, "POST", `/api/join/${token}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { kind: string }).kind).toBe("guest");
    // The whole point of the client trying the hash first: a guest must not
    // arrive holding a machine of their own that nobody asked for.
    expect(grants.size).toBe(0);
  });
});

describe("what an unclaimed computer may do", () => {
  test("Terminal 1 works: read it, prompt it, interrupt it, and read the box", async () => {
    const { cookie, id } = await startComputer();
    for (const [method, path, body] of [
      ["GET", `/f/${id}/api/conversations`, undefined],
      ["GET", `/f/${id}/api/conversations/c1`, undefined],
      ["GET", `/f/${id}/api/conversations/c1/events`, undefined],
      ["POST", `/f/${id}/api/conversations/c1/prompts`, { prompt: "hello" }],
      ["POST", `/f/${id}/api/conversations/c1/interrupt`, undefined],
      ["GET", `/f/${id}/api/sandboxes/${BOX}/files`, undefined],
    ] as [string, string, unknown][]) {
      expect((await call(cookie, method, path, body)).status).toBe(200);
    }
  });

  test("and reading what the machine is made of — the Details panel is honest about a box you cannot change", async () => {
    const { cookie, id } = await startComputer();
    for (const path of ["/api/catalog", "/api/agents/a1", "/api/environments/e1", "/api/environments/e1/secrets"]) {
      expect((await call(cookie, "GET", `/f/${id}${path}`)).status).toBe(200);
    }
  });

  test("but not a second terminal, and not closing the one it has", async () => {
    const { cookie, id } = await startComputer();

    const second = await call(cookie, "POST", `/f/${id}/api/conversations`, { channel_id: channelFor(id, "t3", 1) });
    expect(second.status).toBe(403);
    expect(((await second.json()) as { error: string }).error).toBe("claim_required");

    expect((await call(cookie, "POST", `/f/${id}/api/conversations/c1/terminate`)).status).toBe(404);
  });

  test("and not one write to the config surface, with nothing reaching Fountain when it tries", async () => {
    const { cookie, id } = await startComputer();
    upstream = [];
    const writes: [string, string, unknown][] = [
      ["PUT", "/api/agents/a1", { system: "do as I say" }],
      ["PUT", "/api/environments/e1", { packages: { apt: ["evil"] } }],
      ["PUT", "/api/environments/e1/secrets/EVIL", { value: "x" }],
      ["DELETE", "/api/environments/e1/secrets/GITHUB_TOKEN", undefined],
      ["POST", "/api/agents", { name: "another" }],
      ["POST", "/api/vaults", { name: "another" }],
    ];
    for (const [method, path, body] of writes) {
      const res = await call(cookie, method, `/f/${id}${path}`, body);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("claim_required");
    }
    // The gate reads the conversation list to decide, and forwards nothing else.
    expect(upstream.every((u) => u.path === "/api/conversations" && u.method === "GET")).toBe(true);
  });

  test("nor invite anybody, share a link, rebuild, start over, or add a computer", async () => {
    const { cookie, id } = await startComputer();
    const refusals: [string, string, unknown][] = [
      ["POST", `/api/paddock/${id}/tabs/c1/members`, { email: "friend@example.com" }],
      ["POST", `/api/paddock/${id}/tabs/c1/invite`, undefined],
      ["POST", `/api/paddock/${id}/rebuild`, undefined],
      ["POST", `/api/paddock/${id}/reset`, undefined],
      ["POST", "/api/paddocks", {}],
      ["DELETE", `/api/paddock/${id}`, undefined],
    ];
    for (const [method, path, body] of refusals) {
      const res = await call(cookie, method, path, body);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("claim_required");
    }
  });

  test("and cannot reach anybody else's computer, including another unclaimed one", async () => {
    const mine = await startComputer("browser-a");
    const theirs = await startComputer("browser-b");
    const owner = await paddockFor(OWNER);

    expect(mine.id).not.toBe(theirs.id);
    for (const target of [theirs.id, owner.id]) {
      expect((await call(mine.cookie, "GET", `/api/paddock/${target}`)).status).toBe(404);
      expect((await call(mine.cookie, "GET", `/f/${target}/api/conversations`)).status).toBe(404);
    }
  });

  test("building the machine is allowed, because first run has to write the same records Setup does", async () => {
    // The fake's machine is on somebody else's computer, so `machineOf` finds
    // nothing on this one — which is the state first run is.
    machinePaddock = "somebody-elses";
    const { cookie, id } = await startComputer("fresh");
    expect(id).not.toBe(machinePaddock);

    expect((await call(cookie, "POST", `/f/${id}/api/environments`, { name: "Paddock" })).status).toBe(200);
    expect((await call(cookie, "POST", `/f/${id}/api/agents`, { name: "Paddock" })).status).toBe(200);
    expect((await call(cookie, "POST", `/f/${id}/api/conversations`, { channel_id: channelFor(id, "t1", 1) })).status).toBe(200);
  });
});

describe("claiming", () => {
  /** Start a computer, then sign in on it. The whole flow, in one line. */
  async function claimWith(key: string, startKey = "browser-1") {
    const started = await startComputer(startKey);
    const res = await call(started.cookie, "POST", "/api/auth/session", { apiKey: key });
    return { started, res, me: (await res.json()) as Record<string, unknown> };
  }

  test("the machine survives: same computer, same principal, same agent, environment, vault, box and tabs", async () => {
    const started = await startComputer();
    const before = ctx.db.getPaddock(started.id)!;
    const tabsBefore = (await (await call(started.cookie, "GET", `/f/${started.id}/api/conversations`)).json()) as { data: { id: string }[] };

    const res = await call(started.cookie, "POST", "/api/auth/session", { apiKey: "ftn_owner" });
    const me = (await res.json()) as Record<string, unknown>;
    expect(me.claimedFrom).toBe(started.id);
    expect(me.kind).toBe("user");
    expect(me.paddockId).toBe(started.id);

    const after = ctx.db.getPaddock(started.id)!;
    expect(after.id).toBe(before.id);
    expect(after.fountain_principal_id).toBe(before.fountain_principal_id);
    expect(after.claim_status).toBe("claimed");
    expect(after.owner_email).toBe(OWNER);

    // Nothing about the machine moved, so the tabs are the same conversations
    // on the same box — and they still are, now under an account.
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    const tabsAfter = (await (await call(cookie, "GET", `/f/${started.id}/api/conversations`)).json()) as { data: { id: string }[] };
    expect(tabsAfter.data.map((c) => c.id)).toEqual(tabsBefore.data.map((c) => c.id));
    // And no second machine was built for the account that just registered.
    expect(ctx.db.paddocksOf(OWNER)).toHaveLength(1);
  });

  test("the compute credential rotates: the machine stops running on the provisional key", async () => {
    const started = await startComputer();
    const provisional = await ctx.cipher.decrypt(ctx.db.getPaddock(started.id)!.compute_key_enc!);

    const res = await call(started.cookie, "POST", "/api/auth/session", { apiKey: "ftn_owner" });
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    const claimed = await ctx.cipher.decrypt(ctx.db.getPaddock(started.id)!.compute_key_enc!);
    expect(claimed).not.toBe(provisional);

    // The one that matters: what goes on the wire from here on. Not the
    // provisional key, and not the owner's own account key either — the claim
    // handed back the credential that selects *this* principal.
    upstream = [];
    await call(cookie, "GET", `/f/${started.id}/api/conversations`);
    expect(upstream.map((u) => u.key)).toEqual([claimed]);
    expect(upstream.some((u) => u.key === provisional || u.key === "ftn_owner")).toBe(false);
  });

  test("a brand-new account and one that already owns a computer both claim the same way", async () => {
    // Somebody who has never been here.
    const fresh = await claimWith("ftn_owner", "browser-new");
    expect(fresh.me.claimedFrom).toBe(fresh.started.id);
    expect(ctx.db.paddocksOf(OWNER)).toHaveLength(1);

    // And somebody who already has one. The claimed machine is a *second*
    // computer on that account rather than a merge into the first.
    const existing = await paddockFor(OTHER);
    // The fake reads a key as its owner's name, so this is OTHER's own key.
    const other = await claimWith("other", "browser-old");
    expect(other.me.claimedFrom).toBe(other.started.id);
    const owned = ctx.db.paddocksOf(OTHER).map((r) => r.id);
    expect(owned).toContain(existing.id);
    expect(owned).toContain(other.started.id);
    expect(owned).toHaveLength(2);
  });

  test("a claim that makes the machine an account's *second* computer keeps its tabs", async () => {
    // The subtle one. `original` marks the account's oldest computer, and it
    // is what decides whether a tab with no computer in its channel is on this
    // machine. A claimed computer that sorts second stops being original the
    // moment it is claimed — so if anything depended on that flag, the tabs
    // somebody had been using would vanish at exactly the wrong moment.
    const started = await startComputer();
    expect(ctx.db.isOriginal(ctx.db.getPaddock(started.id)!)).toBe(true);

    // An account that has been here before, whose computer is older.
    ctx.db.upsertUser(OTHER, "u-other", await ctx.cipher.encrypt("other"));
    ctx.db.createPaddock("older", OTHER, "My computer");
    ctx.db.sql.query("UPDATE paddocks SET created_at = '2020-01-01T00:00:00Z' WHERE id = 'older'").run();

    const res = await call(started.cookie, "POST", "/api/auth/session", { apiKey: "other" });
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(((await res.json()) as { claimedFrom: string }).claimedFrom).toBe(started.id);
    expect(ctx.db.isOriginal(ctx.db.getPaddock(started.id)!)).toBe(false);

    // Not original any more, and every tab still there — because a starter's
    // channels name their computer outright rather than relying on the flag.
    const tabs = (await (await call(cookie, "GET", `/f/${started.id}/api/conversations`)).json()) as { data: { id: string }[] };
    expect(tabs.data.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  test("the starter session ends with the claim, so it is not a second way in", async () => {
    const started = await startComputer();
    await call(started.cookie, "POST", "/api/auth/session", { apiKey: "ftn_owner" });
    const res = await call(started.cookie, "GET", "/api/me");
    expect(res.status).toBe(401);
  });

  test("signing out and back in returns to the claimed computer, from any browser", async () => {
    const started = await startComputer();
    const first = await call(started.cookie, "POST", "/api/auth/session", { apiKey: "ftn_owner" });
    const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0]!;
    await call(cookie, "DELETE", "/api/auth/session");

    // A different browser entirely: no cookie, no start key, just the account.
    const back = (await (await call(null, "POST", "/api/auth/session", { apiKey: "ftn_owner" })).json()) as Record<string, unknown>;
    expect(back.paddockId).toBe(started.id);
    expect(back.claimedFrom).toBeUndefined();
  });

  test("after the claim the owner may do everything a claim was blocking", async () => {
    const started = await startComputer();
    const res = await call(started.cookie, "POST", "/api/auth/session", { apiKey: "ftn_owner" });
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;

    expect((await call(cookie, "POST", `/f/${started.id}/api/conversations`, { channel_id: channelFor(started.id, "t3", 1) })).status).toBe(200);
    expect((await call(cookie, "PUT", `/f/${started.id}/api/agents/a1`, { system: "hello" })).status).toBe(200);
    expect((await call(cookie, "POST", `/api/paddock/${started.id}/tabs/c1/invite`)).status).toBe(200);
  });

  test("a start key whose computer has been claimed is told to sign in, not given another", async () => {
    const started = await startComputer("kept");
    await call(started.cookie, "POST", "/api/auth/session", { apiKey: "ftn_owner" });

    // The same browser, having lost its cookie. Starting again would abandon
    // the machine it just claimed.
    const res = await call(null, "POST", "/api/start", { startKey: "kept" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("already_claimed");
  });
});

describe("when a claim does not happen", () => {
  test("a claim somebody else already won is terminal: they are signed in, and told", async () => {
    const started = await startComputer();
    // Somebody else got there first, upstream.
    const grant = [...grants.values()][0]!;
    grant.status = "claimed";
    grant.claimed_by = "ftn_thief";

    const res = await call(started.cookie, "POST", "/api/auth/session", { apiKey: "ftn_owner" });
    const me = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(me.claimedFrom).toBeUndefined();
    expect(me.claimFailed).toContain("claimed that computer first");
    // Signed in, on a machine of their own, rather than stranded.
    expect(me.kind).toBe("user");
    expect(me.paddockId).toBeTruthy();
    expect(me.paddockId).not.toBe(started.id);
  });

  test("an expired grant is terminal the same way", async () => {
    const started = await startComputer();
    [...grants.values()][0]!.status = "expired";
    const me = (await (await call(started.cookie, "POST", "/api/auth/session", { apiKey: "ftn_owner" })).json()) as Record<string, unknown>;
    expect(me.claimFailed).toContain("ran out");
    expect(me.kind).toBe("user");
  });

  test("a lost response is not: the sign-in is refused, and the starter session survives to retry", async () => {
    const started = await startComputer();
    claimableHook = (method, path) => (path.endsWith("/claim") && method === "POST" ? Response.json({ error: "boom" }, { status: 503 }) : null);

    const failed = await call(started.cookie, "POST", "/api/auth/session", { apiKey: "ftn_owner" });
    expect(failed.status).toBeGreaterThanOrEqual(500);
    // Nothing moved: the computer is still unclaimed and still reachable from
    // the session that was about to claim it.
    expect(ctx.db.getPaddock(started.id)!.claim_status).toBe("unclaimed");
    expect(((await (await call(started.cookie, "GET", "/api/me")).json()) as { kind: string }).kind).toBe("starter");

    // And the retry finishes it, because the idempotency key is the same.
    claimableHook = null;
    const me = (await (await call(started.cookie, "POST", "/api/auth/session", { apiKey: "ftn_owner" })).json()) as Record<string, unknown>;
    expect(me.claimedFrom).toBe(started.id);
    expect(ctx.db.getPaddock(started.id)!.owner_email).toBe(OWNER);
  });

  test("a claim that landed upstream and not here is finished on the next try, not duplicated", async () => {
    const started = await startComputer();
    // Fountain claimed it and the answer never arrived. Exactly the state a
    // dropped response leaves, reproduced by claiming behind paddock's back.
    const grant = [...grants.values()][0]!;
    grant.status = "claimed";
    grant.claimed_by = "ftn_owner";
    grant.api_key = "ftn_claimed_upstream";
    expect(ctx.db.getPaddock(started.id)!.claim_status).toBe("unclaimed");

    const me = (await (await call(started.cookie, "POST", "/api/auth/session", { apiKey: "ftn_owner" })).json()) as Record<string, unknown>;
    expect(me.claimedFrom).toBe(started.id);
    const row = ctx.db.getPaddock(started.id)!;
    expect(row.owner_email).toBe(OWNER);
    expect(await ctx.cipher.decrypt(row.compute_key_enc!)).toBe("ftn_claimed_upstream");
    // One principal throughout. Nothing was rebuilt to recover.
    expect(grants.size).toBe(1);
  });
});

describe("expiry and cleanup", () => {
  test("an expired unclaimed computer is released upstream and forgotten here", async () => {
    grantExpiresAt = "2000-01-01T00:00:00.000Z";
    const started = await startComputer();

    const report = await sweepExpired(ctx);
    expect(report).toEqual({ released: 1, forgotten: 1, stranded: 0, failed: 0 });
    expect([...grants.values()][0]!.status).toBe("released");
    expect(ctx.db.getPaddock(started.id)).toBeNull();

    // And the browser that was using it is told which of the two things
    // happened, rather than the generic "your session ended".
    const res = await call(started.cookie, "GET", "/api/me");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("start_expired");
  });

  test("a sweep that loses a race to a claim destroys nothing", async () => {
    grantExpiresAt = "2000-01-01T00:00:00.000Z";
    const started = await startComputer();
    // The claim landed upstream between the row being listed and the sweep
    // reading it — which is exactly why the sweep reads it.
    const grant = [...grants.values()][0]!;
    grant.status = "claimed";
    grant.claimed_by = "ftn_owner";

    const report = await sweepExpired(ctx);
    expect(report.stranded).toBe(1);
    expect(report.released).toBe(0);
    expect(grant.status).toBe("claimed");
    expect(ctx.db.getPaddock(started.id)).not.toBeNull();
  });

  test("a claimed computer is never swept, however old its clock was", async () => {
    grantExpiresAt = "2000-01-01T00:00:00.000Z";
    const started = await startComputer();
    await call(started.cookie, "POST", "/api/auth/session", { apiKey: "ftn_owner" });

    const report = await sweepExpired(ctx);
    expect(report).toEqual({ released: 0, forgotten: 0, stranded: 0, failed: 0 });
    expect(ctx.db.getPaddock(started.id)!.owner_email).toBe(OWNER);
  });

  test("sweeping twice is the same as sweeping once", async () => {
    grantExpiresAt = "2000-01-01T00:00:00.000Z";
    await startComputer();
    await sweepExpired(ctx);
    expect(await sweepExpired(ctx)).toEqual({ released: 0, forgotten: 0, stranded: 0, failed: 0 });
  });

  test("a grant Fountain has already purged is forgotten rather than retried forever", async () => {
    grantExpiresAt = "2000-01-01T00:00:00.000Z";
    const started = await startComputer();
    grants.clear();
    const report = await sweepExpired(ctx);
    expect(report.forgotten).toBe(1);
    expect(report.failed).toBe(0);
    expect(ctx.db.getPaddock(started.id)).toBeNull();
  });

  test("a computer whose clock has not run out is left alone", async () => {
    const started = await startComputer();
    expect(await sweepExpired(ctx)).toEqual({ released: 0, forgotten: 0, stranded: 0, failed: 0 });
    expect(ctx.db.getPaddock(started.id)).not.toBeNull();
  });
});

describe("the migration to claimable computers", () => {
  /**
   * The shape of the database before issue #14, written out rather than
   * imported: a migration test that builds its input from the current schema
   * is a test of nothing. `owner_email NOT NULL` and the two-way sessions
   * CHECK are the two constraints that had to go, so they are the two things
   * this old schema declares.
   */
  const OLD_SCHEMA = `
    CREATE TABLE users (email TEXT PRIMARY KEY, fountain_user_id TEXT, key_enc TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE paddocks (id TEXT PRIMARY KEY, owner_email TEXT NOT NULL REFERENCES users(email), name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
    CREATE TABLE paddock_members (paddock_id TEXT NOT NULL REFERENCES paddocks(id) ON DELETE CASCADE, conversation_id TEXT NOT NULL, email TEXT NOT NULL, added_at TEXT NOT NULL, added_by TEXT NOT NULL, PRIMARY KEY (paddock_id, conversation_id, email));
    CREATE TABLE paddock_guests (id TEXT PRIMARY KEY, paddock_id TEXT NOT NULL REFERENCES paddocks(id) ON DELETE CASCADE, conversation_id TEXT NOT NULL, handle TEXT NOT NULL, created_at TEXT NOT NULL, seen_at TEXT NOT NULL);
    CREATE TABLE tab_invites (token TEXT PRIMARY KEY, paddock_id TEXT NOT NULL REFERENCES paddocks(id) ON DELETE CASCADE, conversation_id TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, email TEXT REFERENCES users(email), guest_id TEXT, created_at TEXT NOT NULL, CHECK ((email IS NULL) <> (guest_id IS NULL)));
    CREATE TABLE tab_openers (conversation_id TEXT PRIMARY KEY, paddock_id TEXT NOT NULL REFERENCES paddocks(id) ON DELETE CASCADE, actor TEXT NOT NULL, opened_at TEXT NOT NULL);
  `;

  test("every user, computer, membership, guest, link and session survives, as already claimed", () => {
    const file = join(tmpdir(), `paddock-migrate-${randomToken(6).replace(/[^a-z0-9]/gi, "")}.sqlite`);
    const old = new Database(file, { create: true, strict: true });
    old.exec("PRAGMA foreign_keys = ON;");
    old.exec(OLD_SCHEMA);
    old.exec(`
      INSERT INTO users VALUES ('a@example.com', 'u1', 'enc-a', '2026-01-01T00:00:00Z');
      INSERT INTO users VALUES ('b@example.com', 'u2', 'enc-b', '2026-01-02T00:00:00Z');
      INSERT INTO paddocks VALUES ('p1', 'a@example.com', 'My computer', '2026-01-01T00:00:00Z');
      INSERT INTO paddocks VALUES ('p2', 'a@example.com', 'Computer 2', '2026-01-03T00:00:00Z');
      INSERT INTO paddock_members VALUES ('p1', 'c1', 'b@example.com', '2026-01-04T00:00:00Z', 'a@example.com');
      INSERT INTO paddock_guests VALUES ('g1', 'p1', 'c1', 'guest-7f3a', '2026-01-05T00:00:00Z', '2026-01-05T00:00:00Z');
      INSERT INTO tab_invites VALUES ('tok', 'p1', 'c1', '2026-01-05T00:00:00Z');
      INSERT INTO sessions VALUES ('h1', 'a@example.com', NULL, '2026-01-06T00:00:00Z');
      INSERT INTO sessions VALUES ('h2', NULL, 'g1', '2026-01-06T00:00:00Z');
      INSERT INTO tab_openers VALUES ('c1', 'p1', 'a@example.com', '2026-01-06T00:00:00Z');
    `);
    old.close();

    const db = new Db(file);

    expect(db.getUser("a@example.com")?.key_enc).toBe("enc-a");
    expect(db.paddocksOf("a@example.com").map((p) => p.id)).toEqual(["p1", "p2"]);
    // Already claimed, owned by exactly whoever owned it, and still running on
    // its owner's own key rather than a per-computer one it never had.
    for (const id of ["p1", "p2"]) {
      const row = db.getPaddock(id)!;
      expect(row.claim_status).toBe("claimed");
      expect(row.owner_email).toBe("a@example.com");
      expect(row.compute_key_enc).toBeNull();
      expect(row.fountain_principal_id).toBeNull();
    }
    expect(db.memberTabs("p1", "b@example.com")).toEqual(["c1"]);
    expect(db.getGuest("g1")?.handle).toBe("guest-7f3a");
    expect(db.invite("tok")?.paddock_id).toBe("p1");
    expect(db.session("h1")?.email).toBe("a@example.com");
    expect(db.session("h1")?.starter_paddock_id).toBeNull();
    expect(db.session("h2")?.guest_id).toBe("g1");
    expect(db.tabOpeners("p1")).toEqual({ c1: "a@example.com" });

    // And the new shape actually works on the migrated file: an unclaimed row
    // and a starter session are what the old constraints refused.
    db.createUnclaimedPaddock({
      id: "p3",
      name: "My computer",
      principalId: "pr-1",
      claimableUserId: "cl-1",
      claimTokenEnc: "enc",
      computeKeyEnc: "enc",
      expiresAt: "2099-01-01T00:00:00Z",
    });
    db.createStarterSession("h3", "p3");
    expect(db.getPaddock("p3")!.owner_email).toBeNull();
    expect(db.session("h3")?.starter_paddock_id).toBe("p3");

    // Running it again changes nothing — the server opens the file on boot.
    db.sql.close();
    const again = new Db(file);
    expect(again.paddocksOf("a@example.com")).toHaveLength(2);
    expect(again.getPaddock("p3")!.claim_status).toBe("unclaimed");
    again.sql.close();
    rmSync(file, { force: true });
    rmSync(`${file}-wal`, { force: true });
    rmSync(`${file}-shm`, { force: true });
  });
});
