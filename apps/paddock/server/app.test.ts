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
      return Response.json({ data: conv("c3", channelFor("t3", 1), "2026-09-04T13:00:00Z") });
    }
    if (/^\/api\/conversations\/[^/]+/.test(url.pathname)) return Response.json({ status: "accepted" });
    if (url.pathname === "/api/catalog") return Response.json({ data: { runtimes: ["claude"], models: {} } });
    if (/^\/api\/agents\/[^/]+$/.test(url.pathname)) return Response.json({ data: { id: AGENT, name: "Paddock", runtime: "claude", model: "m" } });
    if (method === "DELETE" && /^\/api\/(agents|environments|vaults)\/[^/]+$/.test(url.pathname)) return new Response(null, { status: 204 });
    if (/^\/api\/environments\/[^/]+$/.test(url.pathname)) return Response.json({ data: { id: "e1", name: "Paddock" } });
    if (/^\/api\/(environments|vaults)\/[^/]+\/secrets$/.test(url.pathname)) return Response.json({ data: [] });
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
    // Opening a tab is not among them any more — see "only the owner opens tabs".
    expect((await call(guest, "POST", `/f/${owner.id}/api/conversations`, { channel_id: channelFor("t3", 1) })).status).toBe(403);
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
    const res = await call(owner.cookie, "POST", `/f/${owner.id}/api/conversations`, { title: "Terminal 3", channel_id: channelFor("t3", 1) });
    expect(res.status).toBe(200);
  });

  test("the owner's attach is built from their own machine, whatever the body asks for", async () => {
    const owner = await paddockFor(OWNER);
    const res = await call(owner.cookie, "POST", `/f/${owner.id}/api/conversations`, {
      channel_id: channelFor("t4", 1),
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
      const res = await call(cookie, "POST", `/f/${owner.id}/api/conversations`, { channel_id: channelFor("t9", 1) });
      expect(res.status).toBe(403);
    }
    expect(upstream.some((u) => u.method === "POST" && u.path === "/api/conversations")).toBe(false);

    // And the owner still can.
    expect((await call(owner.cookie, "POST", `/f/${owner.id}/api/conversations`, { channel_id: channelFor("t9", 1) })).status).toBe(200);
  });
});
