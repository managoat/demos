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

const OWNER = "owner@example.com";
const OTHER = "other@example.com";
const BOX = "sb-test-1";
const AGENT = "a1";

/** The conversations the fake Fountain reports for the owner's account. */
function conversations() {
  return [
    conv("c1", channelFor("t1", 1), "2026-09-04T10:00:00Z"),
    conv("c2", channelFor("t2", 1), "2026-09-04T11:00:00Z"),
    conv("cops", channelFor(OPS_SLUG, 1), "2026-09-04T12:00:00Z"),
  ];
}

function conv(id: string, channel: string, at: string) {
  return {
    id,
    title: null,
    sandbox_id: BOX,
    sandbox: null,
    agent_id: AGENT,
    vault_id: null,
    environment_id: null,
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
let upstream: { method: string; path: string }[] = [];
const realFetch = globalThis.fetch;

beforeEach(async () => {
  const config = { ...loadConfig({ DATA_DIR: "/tmp", PADDOCK_SECRET: "0123456789abcdef0123" }), dbPath: ":memory:" };
  ctx = { config, db: new Db(":memory:"), cipher: await Cipher.from(config.secret) };
  route = buildRouter(ctx);
  upstream = [];
  hub.reset();

  // A fake Fountain. Only the calls the proxy actually makes are answered;
  // anything else 404s, so an unexpected upstream call fails a test loudly.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    upstream.push({ method, path: url.pathname });
    if (url.pathname === "/api/auth/me") return Response.json({ id: "u1", email: OWNER });
    if (url.pathname === "/api/conversations" && method === "GET") return Response.json({ data: conversations() });
    if (url.pathname === "/api/conversations" && method === "POST") return Response.json({ data: conv("c3", channelFor("t3", 1), "2026-09-04T13:00:00Z") });
    if (/^\/api\/conversations\/[^/]+/.test(url.pathname)) return Response.json({ status: "accepted" });
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

async function guestSession(paddockId: string): Promise<string> {
  const guest = ctx.db.createGuest(randomToken(9), paddockId, "guest-7f3a");
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

async function paddockFor(email: string): Promise<{ cookie: string; id: string }> {
  const cookie = await signIn(email);
  const res = await call(cookie, "POST", "/api/paddock");
  const { data } = (await res.json()) as { data: { id: string } };
  return { cookie, id: data.id };
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
    expect((await call(guest, "POST", `/f/${owner.id}/api/conversations`, { channel_id: channelFor("t3", 1) })).status).toBe(200);
  });

  test("but not terminate a tab — that ends it for everybody", async () => {
    const owner = await paddockFor(OWNER);
    const guest = await guestSession(owner.id);
    expect((await call(guest, "POST", `/f/${owner.id}/api/conversations/c1/terminate`)).status).toBe(404);
    expect((await call(owner.cookie, "POST", `/f/${owner.id}/api/conversations/c1/terminate`)).status).toBe(200);
  });

  test("and not touch the machine: the config surface is not on /f/ at all", async () => {
    const owner = await paddockFor(OWNER);
    const guest = await guestSession(owner.id);
    for (const path of ["/api/agents/a1", "/api/environments/e1", "/api/vaults/v1/secrets", "/api/sandboxes/sb-test-1"]) {
      expect((await call(guest, "GET", `/f/${owner.id}${path}`)).status).toBe(404);
    }
    expect(upstream.some((u) => u.path.startsWith("/api/agents") || u.path.startsWith("/api/environments") || u.path.startsWith("/api/vaults"))).toBe(false);
  });

  test("and cannot invite anyone or mint a link", async () => {
    const owner = await paddockFor(OWNER);
    const guest = await guestSession(owner.id);
    expect((await call(guest, "POST", `/api/paddock/${owner.id}/members`, { email: "x@example.com" })).status).toBe(403);
    expect((await call(guest, "POST", `/api/paddock/${owner.id}/invite`)).status).toBe(403);
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
    ctx.db.addMember(owner.id, OTHER, OWNER);
    expect((await call(memberCookie, "POST", `/api/paddock/${owner.id}/members`, { email: "x@example.com" })).status).toBe(403);
    // But they can leave.
    expect((await call(memberCookie, "DELETE", `/api/paddock/${owner.id}/members/${encodeURIComponent(OTHER)}`)).status).toBe(200);
  });
});

describe("invite links", () => {
  test("re-minting evicts everyone who came in on the old one", async () => {
    const owner = await paddockFor(OWNER);
    await call(owner.cookie, "POST", `/api/paddock/${owner.id}/invite`);
    const token = ctx.db.getPaddock(owner.id)!.invite_token!;

    const joined = await call(null, "POST", `/api/join/${token}`);
    expect(joined.status).toBe(200);
    const cookie = joined.headers.get("set-cookie")!.split(";")[0]!;
    expect((await call(cookie, "GET", `/f/${owner.id}/api/conversations/c1`)).status).toBe(200);

    // Re-mint. The guest's session must die with the link, not outlive it.
    const reminted = await call(owner.cookie, "POST", `/api/paddock/${owner.id}/invite`);
    expect(((await reminted.json()) as { evicted: number }).evicted).toBe(1);

    const after = await call(cookie, "GET", `/f/${owner.id}/api/conversations/c1`);
    expect(after.status).toBe(401);
    expect(((await after.json()) as { error: string }).error).toBe("invite_revoked");
    expect(ctx.db.getPaddock(owner.id)!.invite_token).not.toBe(token);
  });

  test("an old token stops naming a paddock once it is replaced", async () => {
    const owner = await paddockFor(OWNER);
    await call(owner.cookie, "POST", `/api/paddock/${owner.id}/invite`);
    const first = ctx.db.getPaddock(owner.id)!.invite_token!;
    await call(owner.cookie, "POST", `/api/paddock/${owner.id}/invite`);
    expect((await call(null, "POST", `/api/join/${first}`)).status).toBe(404);
  });

  test("closing the link leaves no way in at all", async () => {
    const owner = await paddockFor(OWNER);
    await call(owner.cookie, "POST", `/api/paddock/${owner.id}/invite`);
    const token = ctx.db.getPaddock(owner.id)!.invite_token!;
    await call(owner.cookie, "DELETE", `/api/paddock/${owner.id}/invite`);
    expect((await call(null, "POST", `/api/join/${token}`)).status).toBe(404);
    expect(ctx.db.getPaddock(owner.id)!.invite_token).toBeNull();
  });

  test("following a link while signed in keeps your identity rather than demoting you", async () => {
    const owner = await paddockFor(OWNER);
    await call(owner.cookie, "POST", `/api/paddock/${owner.id}/invite`);
    const token = ctx.db.getPaddock(owner.id)!.invite_token!;

    // The owner opening their own link stays the owner.
    const asOwner = await call(owner.cookie, "POST", `/api/join/${token}`);
    expect(((await asOwner.json()) as { role: string }).role).toBe("owner");

    // Someone with an account becomes a named member, not an anonymous guest.
    const otherCookie = await signIn(OTHER);
    const asUser = await call(otherCookie, "POST", `/api/join/${token}`);
    const body = (await asUser.json()) as { role: string; kind: string; email: string };
    expect(body).toMatchObject({ role: "member", kind: "user", email: OTHER });
    expect(ctx.db.isMember(owner.id, OTHER)).toBe(true);
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
