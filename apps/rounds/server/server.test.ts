import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { appJwt, normalizeKey } from "./github";
import { issueGrant, readGrant } from "./grant";
import { buildRoutes } from "./routes";
import { loadConfig } from "./config";

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const SECRET = "grant-signing-secret";

// ── a fake GitHub, so the whole flow is exercised without the network ───────
interface FakePull {
  number: number;
  state: string;
  merged_at: string | null;
  head: string;
  title?: string;
  labels?: string[];
}
interface FakeOpts {
  pushable?: string[];
  installedOn?: string[];
  /** Pull requests already on the repo, rounds-branched or not. */
  pulls?: FakePull[];
  /** The repo's own `.rounds.yml`, or null when it has none. */
  policyFile?: string | null;
  /** What `/user/installations/{id}/repositories` answers, in order. */
  accessible?: Array<{ full_name: string; push?: boolean; private?: boolean; fork?: boolean; archived?: boolean; pushed_at?: string | null }>;
  defaultBranch?: string;
}
function fakeGitHub(opts: FakeOpts = {}) {
  const pushable = new Set(opts.pushable ?? ["o/r"]);
  const installed = new Set(opts.installedOn ?? ["o/r"]);
  const defaultBranch = opts.defaultBranch ?? "main";
  const calls: string[] = [];
  /** Every set of permissions a token was minted with, in order. */
  const minted: Array<Record<string, string> | undefined> = [];
  /** What actually got written, so a test can assert on the commit and the PR. */
  const written = {
    blobs: [] as string[],
    tree: null as unknown,
    commitMessage: null as string | null,
    commitParents: [] as string[],
    refs: [] as Array<{ ref: string; sha: string; forced: boolean }>,
    pull: null as { title: string; body: string; head: string; base: string } | null,
  };

  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const path = new URL(url).pathname;
    const body = () => JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push(`${method} ${path}`);

    if (path === "/login/oauth/access_token") {
      const b = body() as { code?: string };
      if (b.code !== "good-code") return Response.json({ error: "bad_verification_code", error_description: "The code is incorrect." }, { status: 200 });
      return Response.json({ access_token: "gho_usertoken", expires_in: 28800 });
    }
    if (path === "/user") return Response.json({ login: "octocat" });
    if (path === "/user/installations") {
      return Response.json({ installations: [...installed].map((slug, i) => ({ id: 99 + i, account: { login: slug.split("/")[0] }, repository_selection: "selected" })) });
    }
    if (/^\/user\/installations\/\d+\/repositories$/.test(path)) {
      const page = Number(new URL(url).searchParams.get("page") ?? "1");
      const all = (opts.accessible ?? []).map((r) => ({
        full_name: r.full_name,
        private: r.private ?? false,
        fork: r.fork ?? false,
        archived: r.archived ?? false,
        pushed_at: r.pushed_at ?? "2026-08-01T00:00:00Z",
        description: null,
        permissions: { push: r.push !== false },
      }));
      return Response.json({ total_count: all.length, repositories: page === 1 ? all : [] });
    }
    if (path === "/app/installations/99/access_tokens") {
      const b = body() as { repositories?: string[]; permissions?: Record<string, string> };
      minted.push(b.permissions);
      return Response.json({ token: `ghs_for_${b.repositories?.[0]}`, expires_at: "2026-08-20T10:00:00Z" }, { status: 201 });
    }

    // ── everything under /repos/{owner}/{name}/… ────────────────────────────
    const repo = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(path);
    if (repo) {
      const slug = repo[1]!;
      const rest = repo[2] ?? "";

      if (rest === "/installation") {
        return installed.has(slug) ? Response.json({ id: 99 }) : Response.json({ message: "Not Found" }, { status: 404 });
      }
      if (rest === "/pulls" && method === "GET") {
        return Response.json(
          (opts.pulls ?? []).map((p) => ({
            number: p.number,
            state: p.state,
            merged_at: p.merged_at,
            html_url: `https://github.com/${slug}/pull/${p.number}`,
            title: p.title ?? "a pull request",
            head: { ref: p.head },
            labels: (p.labels ?? []).map((name) => ({ name })),
          })),
        );
      }
      if (rest === "/pulls" && method === "POST") {
        written.pull = body() as unknown as { title: string; body: string; head: string; base: string };
        return Response.json({ number: 77, html_url: `https://github.com/${slug}/pull/77` }, { status: 201 });
      }
      if (rest.startsWith("/contents/")) {
        const wanted = decodeURIComponent(rest.slice("/contents/".length).split("?")[0]!);
        if (wanted === ".rounds.yml" && opts.policyFile != null) {
          return Response.json({ content: Buffer.from(opts.policyFile, "utf8").toString("base64"), encoding: "base64" });
        }
        return Response.json({ message: "Not Found" }, { status: 404 });
      }
      if (rest.startsWith("/git/ref/heads/")) return Response.json({ object: { sha: "basesha0" } });
      if (rest.startsWith("/git/commits/") && method === "GET") return Response.json({ tree: { sha: "basetree" } });
      if (rest === "/git/blobs" && method === "POST") {
        written.blobs.push(Buffer.from(String(body().content), "base64").toString("utf8"));
        return Response.json({ sha: `blob${written.blobs.length}` }, { status: 201 });
      }
      if (rest === "/git/trees" && method === "POST") {
        written.tree = body().tree;
        return Response.json({ sha: "newtree" }, { status: 201 });
      }
      if (rest === "/git/commits" && method === "POST") {
        const b = body() as { message?: string; parents?: string[] };
        written.commitMessage = b.message ?? null;
        written.commitParents = b.parents ?? [];
        return Response.json({ sha: "newcommit" }, { status: 201 });
      }
      if (rest === "/git/refs" && method === "POST") {
        const b = body() as { ref?: string; sha?: string };
        if (written.refs.some((r) => r.ref === b.ref)) return Response.json({ message: "Reference already exists" }, { status: 422 });
        written.refs.push({ ref: b.ref!, sha: b.sha!, forced: false });
        return Response.json({ ref: b.ref }, { status: 201 });
      }
      if (rest.startsWith("/git/refs/heads/") && method === "PATCH") {
        const b = body() as { sha?: string; force?: boolean };
        written.refs.push({ ref: `refs${rest.slice("/git/refs".length)}`, sha: b.sha!, forced: b.force === true });
        return Response.json({});
      }
      if (rest === "") return Response.json({ permissions: { push: pushable.has(slug) }, default_branch: defaultBranch });
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  }) as unknown as typeof fetch;
  return { impl, calls, minted, written };
}

const ENV = {
  GITHUB_APP_ID: "123",
  GITHUB_APP_PRIVATE_KEY: privateKey,
  GITHUB_OAUTH_CLIENT_ID: "Iv1.abc",
  GITHUB_OAUTH_CLIENT_SECRET: "supersecret",
  GRANT_SECRET: SECRET,
  GITHUB_APP_SLUG: "mend-bot",
};

function routesWith(fake: ReturnType<typeof fakeGitHub>, env = ENV) {
  return buildRoutes(loadConfig(env), { fetchImpl: fake.impl, api: "https://api.github.com", oauthHost: "https://github.com" });
}

const call = (routes: ReturnType<typeof buildRoutes>, path: string, init?: RequestInit) => {
  const url = new URL(`https://rounds.test${path}`);
  return routes(new Request(url, init), url);
};

describe("appJwt", () => {
  test("verifies against the app's public key and stays inside GitHub's window", () => {
    const now = 1_760_000_000;
    const [h, p, s] = appJwt("123", privateKey, now).split(".") as [string, string, string];
    expect(crypto.createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(s, "base64url"))).toBe(true);
    const claims = JSON.parse(Buffer.from(p, "base64url").toString()) as { iat: number; exp: number };
    expect(claims.iat).toBe(now - 60);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
  });
});

describe("normalizeKey", () => {
  test("repairs a key flattened into literal backslash-n", () => {
    const fixed = normalizeKey(privateKey.trim().replace(/\n/g, "\\n"));
    expect(fixed).toContain("-----BEGIN PRIVATE KEY-----\n");
    expect(() => appJwt("1", fixed!)).not.toThrow();
  });

  test("refuses anything that is not a PEM key", () => {
    expect(normalizeKey("ghp_atokennotakey")).toBeNull();
    expect(normalizeKey(undefined)).toBeNull();
  });
});

describe("grants", () => {
  test("round-trip", () => {
    const g = { login: "octocat", repo: "o/r", issuedAt: 1000 };
    expect(readGrant(issueGrant(g, SECRET), SECRET)).toEqual(g);
  });

  test("a grant edited to name another repo is rejected", () => {
    const token = issueGrant({ login: "octocat", repo: "o/r", issuedAt: 1000 }, SECRET);
    const [prefix, , signature] = token.split(".") as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ login: "octocat", repo: "victim/secrets", issuedAt: 1000 })).toString("base64url");
    expect(readGrant(`${prefix}.${forged}.${signature}`, SECRET)).toBeNull();
  });

  test("a grant signed with another secret is rejected", () => {
    expect(readGrant(issueGrant({ login: "a", repo: "o/r", issuedAt: 1 }, "other"), SECRET)).toBeNull();
  });

  test("junk and truncation are rejected without throwing", () => {
    for (const bad of ["", "nope", "roundsg1.only-two", "x.y.z", undefined]) {
      expect(readGrant(bad, SECRET)).toBeNull();
    }
  });

  test("age can be enforced when a caller wants it", () => {
    const old = issueGrant({ login: "a", repo: "o/r", issuedAt: Math.floor(Date.now() / 1000) - 7200 }, SECRET);
    expect(readGrant(old, SECRET, 3600)).toBeNull();
    expect(readGrant(old, SECRET)).not.toBeNull();
  });
});

describe("loadConfig", () => {
  test("trims whitespace off every secret — a trailing newline is the classic", () => {
    const cfg = loadConfig({ ...ENV, GITHUB_OAUTH_CLIENT_SECRET: "supersecret\n", GITHUB_APP_ID: "123\n" });
    expect(cfg.app).toMatchObject({ appId: "123", clientSecret: "supersecret" });
  });

  test("a value that is only whitespace counts as absent", () => {
    expect(loadConfig({ ...ENV, GITHUB_OAUTH_CLIENT_SECRET: "   " }).app).toBeNull();
  });
});

describe("GET /gh/app", () => {
  test("advertises the app without leaking a secret", async () => {
    const res = await call(routesWith(fakeGitHub()), "/gh/app");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      configured: true,
      slug: "mend-bot",
      clientId: "Iv1.abc",
      installUrl: "https://github.com/apps/mend-bot/installations/new",
    });
    expect(JSON.stringify(body)).not.toContain("supersecret");
    expect(JSON.stringify(body)).not.toContain("PRIVATE KEY");
  });

  test("an unconfigured deployment says so, and every other route 503s", async () => {
    const routes = routesWith(fakeGitHub(), { ...ENV, GITHUB_APP_ID: undefined } as unknown as typeof ENV);
    expect(((await (await call(routes, "/gh/app")).json()) as { configured: boolean }).configured).toBe(false);
    expect((await call(routes, "/gh/token", { method: "POST", body: "{}" })).status).toBe(503);
  });
});

describe("GET /gh/callback", () => {
  test("exchanges the code and returns the user's own token", async () => {
    const fake = fakeGitHub();
    const res = await call(routesWith(fake), "/gh/callback?code=good-code&redirect_uri=https%3A%2F%2Frounds.test%2F");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: "gho_usertoken", login: "octocat", expiresIn: 28800 });
    expect(fake.calls).toContain("POST /login/oauth/access_token");
  });

  test("a bad code is reported as the caller's problem, without exposing the client secret", async () => {
    const res = await call(routesWith(fakeGitHub()), "/gh/callback?code=nope");
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("The code is incorrect.");
    expect(text).not.toContain("supersecret");
  });

  test("a missing code is a 400", async () => {
    expect((await call(routesWith(fakeGitHub()), "/gh/callback")).status).toBe(400);
  });
});

describe("POST /gh/repos", () => {
  test("answers with what this person could enroll, so the UI can offer it", async () => {
    const fake = fakeGitHub({
      accessible: [
        { full_name: "o/web", private: true, pushed_at: "2026-08-19T00:00:00Z" },
        { full_name: "o/archived", archived: true },
      ],
    });
    const res = await postJson(routesWith(fake), "/gh/repos", { token: "gho_usertoken" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.repos).toEqual([
      { slug: "o/web", private: true, fork: false, archived: false, pushedAt: "2026-08-19T00:00:00Z", description: null },
      { slug: "o/archived", private: false, fork: false, archived: true, pushedAt: "2026-08-01T00:00:00Z", description: null },
    ]);
  });

  test("leaves out anything they cannot push to — a grant for one would be refused anyway", async () => {
    const fake = fakeGitHub({ accessible: [{ full_name: "o/theirs", push: false }, { full_name: "o/mine" }] });
    const body = await (await postJson(routesWith(fake), "/gh/repos", { token: "gho_usertoken" })).json();
    expect(body.repos.map((r: { slug: string }) => r.slug)).toEqual(["o/mine"]);
  });

  test("is asked with the person's own token, never the App's", async () => {
    const fake = fakeGitHub({ accessible: [{ full_name: "o/mine" }] });
    await postJson(routesWith(fake), "/gh/repos", { token: "gho_usertoken" });
    // Listing what somebody can see mints nothing: it is their access, asked
    // with their credential.
    expect(fake.minted).toEqual([]);
  });

  test("without a token it is a bad request, not an empty list", async () => {
    expect((await postJson(routesWith(fakeGitHub()), "/gh/repos", {})).status).toBe(400);
  });
});

describe("POST /gh/grant", () => {
  const post = (routes: ReturnType<typeof buildRoutes>, body: unknown) =>
    call(routes, "/gh/grant", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

  test("issues a grant for a repo the caller can push to", async () => {
    const res = await post(routesWith(fakeGitHub()), { token: "gho_usertoken", repo: "o/r" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { grant: string; login: string };
    expect(body.login).toBe("octocat");
    expect(readGrant(body.grant, SECRET)).toMatchObject({ login: "octocat", repo: "o/r" });
  });

  test("refuses a repo the caller cannot push to — the whole point of the check", async () => {
    const res = await post(routesWith(fakeGitHub({ pushable: [] })), { token: "gho_usertoken", repo: "victim/secrets" });
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toContain("cannot push");
  });

  test("refuses when the App is not installed, rather than issuing a grant that fails later unattended", async () => {
    const res = await post(routesWith(fakeGitHub({ pushable: ["o/r"], installedOn: [] })), { token: "gho_usertoken", repo: "o/r" });
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toContain("not installed");
  });

  test("rejects a malformed repo before calling GitHub at all", async () => {
    const fake = fakeGitHub();
    const res = await post(routesWith(fake), { token: "t", repo: "../../etc/passwd" });
    expect(res.status).toBe(400);
    expect(fake.calls).toEqual([]);
  });
});

describe("POST /gh/token", () => {
  const post = (routes: ReturnType<typeof buildRoutes>, body: unknown) =>
    call(routes, "/gh/token", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

  test("trades a grant for a token scoped to that repo only", async () => {
    const grant = issueGrant({ login: "octocat", repo: "o/r", issuedAt: Math.floor(Date.now() / 1000) }, SECRET);
    const res = await post(routesWith(fakeGitHub()), { grant });
    expect(res.status).toBe(200);
    // the fake echoes the repositories it was asked to scope to
    expect(await res.json()).toEqual({ token: "ghs_for_r", expiresAt: "2026-08-20T10:00:00Z", repo: "o/r", permissions: "contents:read" });
  });

  test("an invalid or forged grant gets nothing", async () => {
    expect((await post(routesWith(fakeGitHub()), { grant: "roundsg1.aaa.bbb" })).status).toBe(401);
    expect((await post(routesWith(fakeGitHub()), {})).status).toBe(401);
  });

  test("the repo comes from the signed grant, never from the request", async () => {
    const fake = fakeGitHub();
    const grant = issueGrant({ login: "octocat", repo: "o/r", issuedAt: 1 }, SECRET);
    await post(routesWith(fake), { grant, repo: "victim/secrets" });
    expect(fake.calls).toContain("GET /repos/o/r/installation");
    expect(fake.calls.join(" ")).not.toContain("victim");
  });

  test("an uninstalled App reports 404 so a round can say why it did nothing", async () => {
    const grant = issueGrant({ login: "octocat", repo: "o/r", issuedAt: 1 }, SECRET);
    const res = await post(routesWith(fakeGitHub({ installedOn: [] })), { grant });
    expect(res.status).toBe(404);
  });
});

describe("CORS", () => {
  test("an allowed origin is echoed; an unknown one gets no header", async () => {
    const routes = buildRoutes(loadConfig({ ...ENV, ALLOWED_ORIGINS: "https://rounds.demo.managoat.com" }), { fetchImpl: fakeGitHub().impl });
    const url = new URL("https://rounds.test/gh/app");
    const ok = await routes(new Request(url, { headers: { origin: "https://rounds.demo.managoat.com" } }), url);
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://rounds.demo.managoat.com");
    const no = await routes(new Request(url, { headers: { origin: "https://evil.test" } }), url);
    expect(no.headers.get("access-control-allow-origin")).toBeNull();
  });
});

// ── the round-facing half: read-only tokens, and a server that does the writing ──

const grantFor = (repo = "o/r") => issueGrant({ login: "octocat", repo, issuedAt: Math.floor(Date.now() / 1000) }, SECRET);

const postJson = (routes: ReturnType<typeof buildRoutes>, path: string, body: unknown) =>
  call(routes, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** A complete, valid proposal — tests vary one field at a time from here. */
const finding = (over: Record<string, unknown> = {}) => ({
  checkId: "GHA033",
  severity: "error",
  message: "No permissions block; the job gets the default write token.",
  file: ".github/workflows/ci.yml",
  tier: "merge-worthy",
  fixKind: "deterministic",
  category: "security",
  title: "Workflow permissions are not restricted",
  note: "Added an explicit permissions block to the build job.",
  ...over,
});

const proposal = (over: Record<string, unknown> = {}) => ({
  grant: grantFor(),
  cluster: "github-workflows-ci-yml",
  base: "abc1234",
  title: "ci: harden workflow permissions",
  findings: [finding()],
  before: 9,
  after: 6,
  files: [{ path: ".github/workflows/ci.yml", content: "on: push\n" }],
  ...over,
});

describe("the agent's token", () => {
  test("is read-only — the one property the whole design rests on", async () => {
    const fake = fakeGitHub();
    await postJson(routesWith(fake), "/gh/token", { grant: grantFor() });
    expect(fake.minted).toEqual([{ contents: "read", metadata: "read" }]);
  });

  test("is scoped to the repo in the signature, never one the caller names", async () => {
    const fake = fakeGitHub({ installedOn: ["o/r", "o/other"] });
    const res = await postJson(routesWith(fake), "/gh/token", { grant: grantFor("o/r"), repo: "o/other" });
    expect((await res.json()).repo).toBe("o/r");
  });
});

describe("POST /gh/state", () => {
  test("tells a round where HEAD is, what the policy says, and what it already proposed", async () => {
    const fake = fakeGitHub({
      pulls: [
        { number: 41, state: "open", merged_at: null, head: "rounds/dockerfile" },
        { number: 12, state: "open", merged_at: null, head: "feature/unrelated" },
      ],
    });
    const res = await postJson(routesWith(fake), "/gh/state", { grant: grantFor() });
    const state = await res.json();
    expect(state.defaultBranch).toBe("main");
    expect(state.head).toBe("basesha0");
    expect(state.openPrs).toBe(1); // the feature branch is not ours and does not count
    expect(state.pulls).toEqual([
      {
        number: 41,
        state: "open",
        merged: false,
        head: "rounds/dockerfile",
        url: "https://github.com/o/r/pull/41",
        title: "a pull request",
        labels: [],
        cluster: "dockerfile",
        reconsider: false,
      },
    ]);
    expect(state.capacity).toBe(2);
  });

  test("reads the repository's own .rounds.yml, so one parser decides the policy", async () => {
    const fake = fakeGitHub({ policyFile: "max_open_prs: 5\ntiers: [quick-win, needs-review]\nignore:\n  - GHA021\n" });
    const state = await (await postJson(routesWith(fake), "/gh/state", { grant: grantFor() })).json();
    expect(state.policy).toEqual({ enabled: true, tiers: ["quick-win", "needs-review"], ignore: ["GHA021"], pathsIgnore: [], maxOpenPrs: 5 });
    // A repo with no file has not asked for anything, so what it was enrolled
    // with stands.
    const bare = await (await postJson(routesWith(fakeGitHub({ policyFile: null })), "/gh/state", { grant: grantFor() })).json();
    expect(bare.policy.tiers).toBeNull();
    expect(state.capacity).toBe(5);
  });

  test("reads it with a read-only token — one that may also list pull requests", async () => {
    const fake = fakeGitHub();
    await postJson(routesWith(fake), "/gh/state", { grant: grantFor() });
    // Without pull_requests a private repository answers "Resource not
    // accessible by integration" instead of a list, and the round stops
    // before it clones. It is not in what /gh/token hands the agent.
    expect(fake.minted).toEqual([{ contents: "read", metadata: "read", pull_requests: "read" }]);
  });
});

describe("POST /gh/propose", () => {
  test("commits, branches and opens the pull request", async () => {
    const fake = fakeGitHub();
    const res = await postJson(routesWith(fake), "/gh/propose", proposal());
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ number: 77, url: "https://github.com/o/r/pull/77", branch: "rounds/github-workflows-ci-yml", commit: "newcommit" });

    expect(fake.written.blobs).toEqual(["on: push\n"]);
    expect(fake.written.commitParents).toEqual(["abc1234"]); // the commit the agent verified against
    expect(fake.written.refs).toEqual([{ ref: "refs/heads/rounds/github-workflows-ci-yml", sha: "newcommit", forced: false }]);
    expect(fake.written.pull?.head).toBe("rounds/github-workflows-ci-yml");
    expect(fake.written.pull?.base).toBe("main");
  });

  test("mints write only after every check has passed, and never hands it back", async () => {
    const fake = fakeGitHub();
    const res = await postJson(routesWith(fake), "/gh/propose", proposal());
    expect(fake.minted).toEqual([
      { contents: "read", metadata: "read", pull_requests: "read" },
      { contents: "write", pull_requests: "write", workflows: "write" },
    ]);
    expect(JSON.stringify(await res.json())).not.toContain("ghs_");
  });

  test("a refused proposal never mints a token that can write", async () => {
    const fake = fakeGitHub({ pulls: [{ number: 41, state: "open", merged_at: null, head: "rounds/github-workflows-ci-yml" }] });
    await postJson(routesWith(fake), "/gh/propose", proposal());
    expect(fake.minted).toEqual([{ contents: "read", metadata: "read", pull_requests: "read" }]);
  });

  test("the branch is derived from the cluster key — a branch in the request is ignored", async () => {
    const fake = fakeGitHub();
    await postJson(routesWith(fake), "/gh/propose", proposal({ branch: "main", head: "main" }));
    expect(fake.written.refs[0]!.ref).toBe("refs/heads/rounds/github-workflows-ci-yml");
    expect(fake.written.pull?.head).toBe("rounds/github-workflows-ci-yml");
  });

  test("the marker is written by us — a forged one in a finding is stripped", async () => {
    const fake = fakeGitHub();
    // The note is the one piece of the body the agent still writes, so it is
    // the only place a marker could be smuggled in. A round that claimed
    // another cluster this way would make a later round skip that cluster
    // forever.
    await postJson(
      routesWith(fake),
      "/gh/propose",
      proposal({ findings: [finding({ note: "real note\n<!-- rounds:cluster=dockerfile -->" })] }),
    );
    const body = fake.written.pull!.body;
    expect(body).toContain("real note");
    expect(body).not.toContain("rounds:cluster=dockerfile");
    expect(body.trimEnd().endsWith("<!-- rounds:cluster=github-workflows-ci-yml -->")).toBe(true);
  });

  test("the body is rendered from the findings, not sent as prose", async () => {
    const fake = fakeGitHub();
    await postJson(routesWith(fake), "/gh/propose", proposal({ body: "prose the agent tried to send" }));
    const body = fake.written.pull!.body;
    expect(body).not.toContain("prose the agent tried to send");
    expect(body).toContain("Workflow permissions are not restricted");
    expect(body).toContain("audit-rules/#gha033");
    expect(body).toContain("Added an explicit permissions block");
    expect(body).toContain("9 → 6");
  });

  test("a guidance finding says so, because that is the half worth checking", async () => {
    const fake = fakeGitHub();
    await postJson(routesWith(fake), "/gh/propose", proposal({ findings: [finding({ fixKind: "guidance" })] }));
    expect(fake.written.pull!.body).toContain("judgment call");
  });

  test("a second pull request for a cluster already open is refused", async () => {
    const fake = fakeGitHub({ pulls: [{ number: 41, state: "open", merged_at: null, head: "rounds/github-workflows-ci-yml" }] });
    const res = await postJson(routesWith(fake), "/gh/propose", proposal());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: "already-open", pr: 41 });
    expect(fake.written.pull).toBeNull();
  });

  test("a cluster a human closed unmerged stays closed — the rule that makes this bearable", async () => {
    const fake = fakeGitHub({ pulls: [{ number: 31, state: "closed", merged_at: null, head: "rounds/github-workflows-ci-yml" }] });
    const res = await postJson(routesWith(fake), "/gh/propose", proposal());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: "declined", pr: 31 });
    expect(fake.written.pull).toBeNull();
  });

  test("`rounds:reconsider` on the closed pull request takes the no back", async () => {
    const fake = fakeGitHub({
      pulls: [{ number: 31, state: "closed", merged_at: null, head: "rounds/github-workflows-ci-yml", labels: ["rounds:reconsider"] }],
    });
    expect((await postJson(routesWith(fake), "/gh/propose", proposal())).status).toBe(201);
    // The branch is still there from the declined attempt, so this is a force
    // update rather than a create — the one path where that is expected.
    expect(fake.written.pull).toMatchObject({ head: "rounds/github-workflows-ci-yml" });
  });

  test("the label forgives the pull request it is on, not the cluster forever", async () => {
    const fake = fakeGitHub({
      pulls: [
        { number: 45, state: "closed", merged_at: null, head: "rounds/github-workflows-ci-yml" },
        { number: 31, state: "closed", merged_at: null, head: "rounds/github-workflows-ci-yml", labels: ["rounds:reconsider"] },
      ],
    });
    const res = await postJson(routesWith(fake), "/gh/propose", proposal());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: "declined", pr: 45 });
  });

  test("a label on somebody else's pull request forgives nothing", async () => {
    const fake = fakeGitHub({
      pulls: [
        { number: 31, state: "closed", merged_at: null, head: "rounds/github-workflows-ci-yml" },
        { number: 12, state: "closed", merged_at: null, head: "rounds/dockerfile", labels: ["rounds:reconsider"] },
      ],
    });
    expect((await postJson(routesWith(fake), "/gh/propose", proposal())).status).toBe(409);
  });

  test("a cluster that was merged and regressed may be proposed again", async () => {
    const fake = fakeGitHub({ pulls: [{ number: 31, state: "closed", merged_at: "2026-07-01T00:00:00Z", head: "rounds/github-workflows-ci-yml" }] });
    expect((await postJson(routesWith(fake), "/gh/propose", proposal())).status).toBe(201);
  });

  test("the cap is counted here, not asked for politely", async () => {
    const fake = fakeGitHub({
      pulls: [
        { number: 1, state: "open", merged_at: null, head: "rounds/a" },
        { number: 2, state: "open", merged_at: null, head: "rounds/b" },
        { number: 3, state: "open", merged_at: null, head: "rounds/c" },
      ],
    });
    const res = await postJson(routesWith(fake), "/gh/propose", proposal());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: "at-cap" });
  });

  test("the repository's own cap wins over ours", async () => {
    const pulls = [
      { number: 1, state: "open", merged_at: null, head: "rounds/a" },
      { number: 2, state: "open", merged_at: null, head: "rounds/b" },
      { number: 3, state: "open", merged_at: null, head: "rounds/c" },
    ];
    expect((await postJson(routesWith(fakeGitHub({ pulls, policyFile: "max_open_prs: 5\n" })), "/gh/propose", proposal())).status).toBe(201);
    expect((await postJson(routesWith(fakeGitHub({ pulls: [], policyFile: "max_open_prs: 0\n" })), "/gh/propose", proposal())).status).toBe(409);
  });

  test("enabled: false in .rounds.yml stops everything, and now actually stops it", async () => {
    const fake = fakeGitHub({ policyFile: "enabled: false\n" });
    const res = await postJson(routesWith(fake), "/gh/propose", proposal());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: "disabled" });
    expect(fake.written.pull).toBeNull();
  });

  test("an abandoned rounds branch with no pull request is reused rather than wedging the cluster", async () => {
    const fake = fakeGitHub();
    const routes = routesWith(fake);
    await postJson(routes, "/gh/propose", proposal());
    await postJson(routes, "/gh/propose", proposal());
    expect(fake.written.refs).toEqual([
      { ref: "refs/heads/rounds/github-workflows-ci-yml", sha: "newcommit", forced: false },
      { ref: "refs/heads/rounds/github-workflows-ci-yml", sha: "newcommit", forced: true },
    ]);
  });

  test("a forged or missing grant gets nothing, and GitHub is never called", async () => {
    for (const grant of [undefined, "not-a-grant", issueGrant({ login: "mallory", repo: "o/r", issuedAt: 0 }, "another-secret")]) {
      const fake = fakeGitHub();
      const res = await postJson(routesWith(fake), "/gh/propose", proposal({ grant }));
      expect(res.status).toBe(401);
      expect(fake.calls).toEqual([]);
    }
  });
});

describe("what a proposal may contain", () => {
  const rejects = async (over: Record<string, unknown>, fragment: string) => {
    const fake = fakeGitHub();
    const res = await postJson(routesWith(fake), "/gh/propose", proposal(over));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(fragment);
    expect(fake.written.pull).toBeNull();
  };

  test("a path that climbs out of the repository is refused", () => rejects({ files: [{ path: "../../etc/passwd", content: "x" }] }, "not normalized"));
  test("an absolute path is refused", () => rejects({ files: [{ path: "/etc/passwd", content: "x" }] }, "relative to the repository root"));
  test("writing inside .git is refused", () => rejects({ files: [{ path: ".git/config", content: "x" }] }, "may not write inside .git"));
  test("a cluster key that is not a cluster key is refused", () => rejects({ cluster: "../main" }, "cluster must be a key"));
  test("a cluster key cannot smuggle a slash into the branch", () => rejects({ cluster: "a/b" }, "cluster must be a key"));
  test("no files is refused", () => rejects({ files: [] }, "at least one change"));
  test("the same path twice is refused", () =>
    rejects({ files: [{ path: "Dockerfile", content: "a" }, { path: "Dockerfile", content: "b" }] }, "appears twice"));
  test("a base that is not a sha is refused", () => rejects({ base: "HEAD" }, "commit sha"));
  test("a multi-line title is refused", () => rejects({ title: "one\ntwo" }, "one line"));
  test("more files than the limit is refused", () =>
    rejects({ files: Array.from({ length: 21 }, (_, i) => ({ path: `f${i}.yml`, content: "x" })) }, "at most 20 files"));

  test("no findings is refused — a pull request has to say why it exists", () =>
    rejects({ findings: [] }, "findings must list what this cluster fixes"));
  test("a finding with no rule id is refused", () => rejects({ findings: [finding({ checkId: "" })] }, "checkId is required"));
  test("a rule id that is not one is refused", () => rejects({ findings: [finding({ checkId: "../../etc" })] }, "must be a rule id"));
  test("an unknown severity is refused rather than rendered", () =>
    rejects({ findings: [finding({ severity: "critical" })] }, "severity must be one of"));
  test("an unknown fixKind is refused", () => rejects({ findings: [finding({ fixKind: "magic" })] }, "fixKind must be one of"));
  test("a finding whose file climbs out of the repository is refused", () =>
    rejects({ findings: [finding({ file: "../../etc/passwd" })] }, "not normalized"));
  test("more findings than the limit is refused", () =>
    rejects({ findings: Array.from({ length: 51 }, () => finding()) }, "at most 50 findings"));

  test("a javascript: authority link never reaches the pull request body", async () => {
    const fake = fakeGitHub();
    const res = await postJson(
      routesWith(fake),
      "/gh/propose",
      proposal({ findings: [finding({ authority: { name: "Somebody", url: "javascript:alert(1)" } })] }),
    );
    expect(res.status).toBe(201);
    expect(fake.written.pull!.body).not.toContain("javascript:");
  });

  test("a deletion is a legitimate change", async () => {
    const fake = fakeGitHub();
    const res = await postJson(routesWith(fake), "/gh/propose", proposal({ files: [{ path: "Dockerfile", deleted: true }] }));
    expect(res.status).toBe(201);
    expect(fake.written.blobs).toEqual([]);
    expect(fake.written.tree).toEqual([{ path: "Dockerfile", mode: "100644", type: "blob", sha: null }]);
  });
});
