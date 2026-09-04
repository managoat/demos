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

const OWNER = "owner@example.com";
const OTHER = "other@example.com";
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
let upstream: { method: string; path: string }[] = [];
const realFetch = globalThis.fetch;

beforeEach(async () => {
  const config = { ...loadConfig({ DATA_DIR: "/tmp", PADDOCK_SECRET: "0123456789abcdef0123" }), dbPath: ":memory:" };
  ctx = { config, db: new Db(":memory:"), cipher: await Cipher.from(config.secret) };
  route = buildRouter(ctx);
  upstream = [];
  hub.reset();
  machinePaddock = null;

  // A fake Fountain. Only the calls the proxy actually makes are answered;
  // anything else 404s, so an unexpected upstream call fails a test loudly.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    upstream.push({ method, path: url.pathname });
    if (url.pathname === "/api/auth/me") {
      // One identity per key, so a test can be somebody else. The fake used to
      // answer OWNER for every key, which quietly made every "another person"
      // scenario a test of the owner signing in as themselves.
      const auth = ((init?.headers ?? {}) as Record<string, string>).authorization ?? "";
      const key = auth.replace(/^Bearer /, "");
      return Response.json({ id: `u-${key}`, email: key === "ftn_owner" ? OWNER : `${key}@example.com` });
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
