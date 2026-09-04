/**
 * A Fountain, and a GitHub, real enough to run the whole app offline.
 *
 * Not a stub returning fixtures. It simulates the part of Fountain that
 * drydock's model depends on and that is genuinely hard to reason about from a
 * document: **a conversation provisions a machine, the machine takes time to
 * become ready, the opening turn runs on it and writes a receipt, and reading
 * that receipt back is how the app learns what happened.** Everything the UI
 * shows about a thread comes out of that loop, so a mock that skipped the
 * timing would leave every waiting state in the app untested — and the waiting
 * states are most of what a person sees in the first minute.
 *
 *   bun run mock                                       # this, on :8793
 *   FOUNTAIN_URL=http://localhost:8793 \
 *   GITHUB_API_URL=http://localhost:8793/github \
 *   bun run server                                     # the drydock server
 *   bun run dev                                        # the SPA
 *
 * The GitHub half is smaller because the app only reads from it, and because
 * the shapes are GitHub's own and stable. It exists so the repository picker,
 * the Create from… tabs and the Checks panel have something to render without
 * an App registration and a network.
 */
import { RECEIPT_PATH } from "../shared/spec";

const PORT = Number(process.env.PORT ?? 8793);

/** How long a machine takes to build. Long enough to see the state, short enough to work in. */
const BUILD_MS = Number(process.env.MOCK_BUILD_MS ?? 4000);
/** How long a turn takes. */
const TURN_MS = Number(process.env.MOCK_TURN_MS ?? 2500);

interface Row {
  id: string;
  [k: string]: unknown;
}

const environments = new Map<string, Row>();
const vaults = new Map<string, Row>();
const agents = new Map<string, Row>();
const secrets = new Map<string, Map<string, string>>();
const sandboxes = new Map<string, Sandbox>();
const conversations = new Map<string, Conversation>();

interface Sandbox {
  id: string;
  sprite_name: string;
  status: "pending" | "starting" | "ready";
  agent_id: string;
  environment_id: string | null;
  vault_id: string | null;
  mode: string;
  readyAt: number;
  /** The disk. Only the files drydock ever reads back. */
  files: Map<string, string>;
}

interface Conversation {
  id: string;
  title: string | null;
  agent_id: string;
  environment_id: string | null;
  vault_id: string | null;
  sandbox_id: string;
  channel_id: string | null;
  status: "pending" | "running" | "idle" | "failed" | "terminated";
  turn_count: number;
  last_active_at: string | null;
  unread: boolean;
  inserted_at: string;
  events: MockEvent[];
  /** Set while a turn is in flight, so the tail can finish it on time. */
  busyUntil: number;
}

interface MockEvent {
  id: number;
  kind: string;
  stream: string;
  data: string;
  stage: string | null;
  state: string | null;
  turn_id: string;
  ts: string;
  blocks: unknown[];
}

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const data = (body: unknown, status = 200) =>
  new Response(JSON.stringify({ data: body }), { status, headers: { "content-type": "application/json" } });
const fail = (status: number, error: string, message: string) =>
  new Response(JSON.stringify({ error, message }), { status, headers: { "content-type": "application/json" } });

/** Bring a sandbox up to date with the clock. Nothing here runs on a timer. */
function settle(s: Sandbox): Sandbox {
  if (s.status !== "ready" && Date.now() >= s.readyAt) s.status = "ready";
  else if (s.status === "pending" && Date.now() >= s.readyAt - BUILD_MS / 2) s.status = "starting";
  return s;
}

function settleConversation(c: Conversation): Conversation {
  const sandbox = sandboxes.get(c.sandbox_id);
  if (sandbox) settle(sandbox);
  if (c.status === "running" && Date.now() >= c.busyUntil) finishTurn(c);
  if (c.status === "pending" && sandbox?.status === "ready") c.status = "running";
  return c;
}

let eventId = 0;
function push(c: Conversation, blocks: unknown[], text: string, turn: string): void {
  c.events.push({
    id: ++eventId,
    kind: "output",
    stream: "acp",
    data: text,
    stage: null,
    state: null,
    turn_id: turn,
    ts: now(),
    blocks,
  });
}

/**
 * The opening turn, simulated including its side effect.
 *
 * The side effect is the whole point: the agent is told to run a script that
 * checks out a branch and writes a receipt, and drydock reads that receipt
 * back over the file route. So the mock writes the file. Without it every
 * thread here would sit at "setting up" forever, which is exactly the bug this
 * mock exists to catch before a deployment does.
 */
function finishTurn(c: Conversation): void {
  const sandbox = sandboxes.get(c.sandbox_id);
  const turn = uuid();
  if (c.turn_count === 1 && sandbox) {
    const parsed = /^drydock:([^:@]+):([^:@]+)@r(\d+)$/.exec(c.channel_id ?? "");
    const slug = parsed?.[2] ?? "thread";
    const repo = String((environments.get(c.environment_id ?? "") as { repositories?: { url?: string; mount_path?: string }[] })
      ?.repositories?.[0]?.url ?? "");
    const path = String(
      (environments.get(c.environment_id ?? "") as { repositories?: { mount_path?: string }[] })?.repositories?.[0]?.mount_path ??
        "/home/sprite",
    );
    const full = repo.replace(/^https:\/\/github\.com\//, "") || null;
    sandbox.files.set(
      RECEIPT_PATH,
      JSON.stringify({
        repo: full,
        path,
        branch: full ? `mock/${slug}` : null,
        base: "main",
        sha: "a1b2c3d",
        files: full ? 1480 : null,
      }),
    );
    if (full) {
      sandbox.files.set(`${path}/README.md`, `# ${full.split("/").pop()}\n\nA mock checkout.\n`);
      sandbox.files.set(`${path}/src/index.ts`, "export const hello = () => 'hi';\n");
    }
    push(c, [{ kind: "text", body: `On branch \`mock/${slug}\`.` }], "on branch", turn);
  } else {
    push(
      c,
      [
        { kind: "thinking", body: "Reading the repository to work out what is being asked." },
        { kind: "tool_use", id: "t1", name: "Bash", summary: "git status --short", body: "git status --short" },
        { kind: "tool_result", tool_id: "t1", body: " M src/index.ts", error: false },
        { kind: "text", body: "I changed `src/index.ts`. Have a look at the diff." },
      ],
      "did the thing",
      turn,
    );
  }
  c.status = "idle";
  c.last_active_at = now();
  c.unread = true;
}

const DIFF = `diff --git a/src/index.ts b/src/index.ts
index 1111111..2222222 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1 +1,3 @@
-export const hello = () => 'hi';
+export function hello(name: string): string {
+  return \`hi \${name}\`;
+}
diff --git a/NOTES.md b/NOTES.md
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/NOTES.md
@@ -0,0 +1,2 @@
+# Notes
+Written by the mock.
`;

// ── the two APIs ───────────────────────────────────────────────────────

Bun.serve({
  port: PORT,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const body = req.method === "GET" || req.method === "DELETE" ? {} : ((await req.json().catch(() => ({}))) as Record<string, unknown>);

    if (path.startsWith("/github")) return github(req, path.slice("/github".length), url);

    // ── identity and catalog ─────────────────────────────────────────
    if (path === "/api/auth/me") return data({ id: "mock-user", email: "mock@example.com" });
    if (path === "/api/catalog") {
      return data({
        runtimes: ["claude"],
        models: { claude: ["anthropic/claude-opus-5", "anthropic/claude-sonnet-5", "anthropic/claude-haiku-4-5-20251001"] },
        sandbox_providers: { enabled: ["sprites"], default: "sprites" },
        package_managers: ["apt", "npm"],
        mcp_servers: [],
      });
    }

    // ── the three records ────────────────────────────────────────────
    for (const [prefix, store] of [
      ["/api/environments", environments],
      ["/api/vaults", vaults],
      ["/api/agents", agents],
    ] as const) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);

      if (rest === "" && req.method === "POST") {
        const row: Row = { id: uuid(), ...body, inserted_at: now(), updated_at: now() };
        store.set(row.id, row);
        return data(row, 201);
      }
      if (rest === "" && req.method === "GET") return data([...store.values()]);

      const m = /^\/([^/]+)(\/.*)?$/.exec(rest);
      if (!m) continue;
      const row = store.get(m[1]!);
      const sub = m[2] ?? "";

      if (!row) return fail(404, "not_found", "No such record.");

      if (sub === "" && req.method === "GET") return data(row);
      if (sub === "" && req.method === "PUT") {
        Object.assign(row, body, { updated_at: now() });
        return data(row);
      }
      if (sub === "" && req.method === "DELETE") {
        store.delete(m[1]!);
        return new Response(null, { status: 204 });
      }

      // Secrets. Values are write-only — a list returns keys, which is what
      // makes the Setup panel's "you cannot read these back" true here too.
      if (sub === "/secrets" && req.method === "GET") {
        const bag = secrets.get(m[1]!) ?? new Map();
        return data([...bag.keys()].map((key) => ({ id: uuid(), key, inserted_at: now(), updated_at: now() })));
      }
      if (sub === "/secrets" && req.method === "POST") {
        const bag = secrets.get(m[1]!) ?? new Map<string, string>();
        bag.set(String(body.key), String(body.value));
        secrets.set(m[1]!, bag);
        return data({ ok: true }, 201);
      }
      if (sub.startsWith("/secrets/") && req.method === "DELETE") {
        secrets.get(m[1]!)?.delete(decodeURIComponent(sub.slice("/secrets/".length)));
        return new Response(null, { status: 204 });
      }
    }

    // ── conversations ────────────────────────────────────────────────
    if (path === "/api/conversations" && req.method === "POST") {
      const agentId = String(body.agent_id ?? "");
      if (!agents.has(agentId)) return fail(404, "not_found", "No such agent.");
      if (!body.prompt) return fail(422, "prompt_required", "A conversation is opened with its first turn.");

      const sandbox: Sandbox = {
        id: uuid(),
        sprite_name: `fountain-mock0001-${uuid().slice(0, 8)}`,
        status: "pending",
        agent_id: agentId,
        environment_id: (body.environment_id as string) ?? null,
        vault_id: (body.vault_id as string) ?? null,
        mode: String(body.sandbox_mode ?? "ephemeral"),
        readyAt: Date.now() + BUILD_MS,
        files: new Map(),
      };
      sandboxes.set(sandbox.id, sandbox);

      const c: Conversation = {
        id: uuid(),
        title: (body.title as string) ?? null,
        agent_id: agentId,
        environment_id: sandbox.environment_id,
        vault_id: sandbox.vault_id,
        sandbox_id: sandbox.id,
        channel_id: (body.channel_id as string) ?? null,
        status: "pending",
        turn_count: 1,
        last_active_at: null,
        unread: false,
        inserted_at: now(),
        events: [],
        busyUntil: Date.now() + BUILD_MS + TURN_MS,
      };
      conversations.set(c.id, c);
      return data(shape(c), 201);
    }

    if (path === "/api/conversations" && req.method === "GET") {
      return data([...conversations.values()].map((c) => shape(settleConversation(c))));
    }

    const conv = /^\/api\/conversations\/([^/]+)(\/.*)?$/.exec(path);
    if (conv) {
      const c = conversations.get(conv[1]!);
      if (!c) return fail(404, "not_found", "No such conversation.");
      settleConversation(c);
      const sub = conv[2] ?? "";

      if (sub === "" && req.method === "GET") return data(shape(c));
      if (sub === "/prompts" && req.method === "POST") {
        if (c.status === "running") return fail(400, "conversation_busy", "That conversation is already taking a turn.");
        c.status = "running";
        c.turn_count++;
        c.busyUntil = Date.now() + TURN_MS;
        return data({ ok: true }, 201);
      }
      if (sub === "/interrupt") {
        c.status = "idle";
        return data({ ok: true });
      }
      if (sub === "/terminate") {
        c.status = "terminated";
        sandboxes.delete(c.sandbox_id);
        return data({ ok: true });
      }
      if (sub === "/events") {
        const after = Number(url.searchParams.get("after") ?? 0);
        const events = c.events.filter((e) => e.id > after);
        return new Response(
          JSON.stringify({ data: events, meta: { limit: 500, has_more: false, next_cursor: events.at(-1)?.id ?? null } }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (sub === "/stream") return stream(c, req.signal, Number(req.headers.get("last-event-id") ?? 0));
    }

    // ── sandboxes ────────────────────────────────────────────────────
    const sb = /^\/api\/sandboxes\/([^/]+)(\/.*)?$/.exec(path);
    if (sb) {
      const s = sandboxes.get(sb[1]!);
      if (!s) return fail(404, "sandbox_not_found", "No such sandbox.");
      settle(s);
      const sub = sb[2] ?? "";
      if (sub === "" && req.method === "GET") {
        return data({ id: s.id, sprite_name: s.sprite_name, status: s.status, provider: "sprites", mode: s.mode });
      }
      // A parked machine is 409 and stays parked, which is what makes a poll
      // on a timer free. Here every sandbox is awake once ready.
      if (s.status !== "ready") return fail(409, "sandbox_not_ready", "That machine is not ready.");

      if (sub === "/files") {
        const at = (url.searchParams.get("path") || "/home/sprite").replace(/\/+$/, "");
        const names = new Set<string>();
        for (const f of s.files.keys()) {
          if (!f.startsWith(`${at}/`)) continue;
          names.add(f.slice(at.length + 1).split("/")[0]!);
        }
        const entries = [...names].map((name) => ({
          name,
          type: s.files.has(`${at}/${name}`) ? "file" : "directory",
          size: s.files.get(`${at}/${name}`)?.length ?? null,
        }));
        return data({ path: at, truncated: false, entries });
      }
      if (sub === "/file") {
        const at = url.searchParams.get("path") ?? "";
        const content = s.files.get(at);
        if (content === undefined) return fail(404, "path_not_found", "No such file.");
        return data({ path: at, size: content.length, truncated: false, encoding: "utf-8", content });
      }
      if (sub === "/diff") {
        const c = [...conversations.values()].find((x) => x.sandbox_id === s.id);
        return data({ path: url.searchParams.get("path") ?? "", diff: (c?.turn_count ?? 0) > 1 ? DIFF : "", truncated: false });
      }
    }

    return fail(404, "not_found", `The mock has no ${req.method} ${path}.`);
  },
});

function shape(c: Conversation) {
  const s = sandboxes.get(c.sandbox_id);
  return {
    id: c.id,
    title: c.title,
    sandbox_id: c.sandbox_id,
    sandbox: s ? { id: s.id, sprite_name: s.sprite_name, status: s.status, provider: "sprites", mode: s.mode } : null,
    agent_id: c.agent_id,
    environment_id: c.environment_id,
    vault_id: c.vault_id,
    runtime: "claude",
    acp: true,
    status: c.status,
    channel_id: c.channel_id,
    turn_count: c.turn_count,
    last_active_at: c.last_active_at,
    unread: c.unread,
    inserted_at: c.inserted_at,
  };
}

/** The live tail, in Fountain's own wire format so the client's parser is the real one. */
function stream(c: Conversation, signal: AbortSignal, lastId: number): Response {
  const encoder = new TextEncoder();
  let sent = lastId;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (s: string) => {
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          /* gone */
        }
      };
      write(": connected\n\n");
      const tick = setInterval(() => {
        settleConversation(c);
        for (const e of c.events) {
          if (e.id <= sent) continue;
          sent = e.id;
          write(`id: ${e.id}\nevent: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`);
        }
      }, 250);
      const beat = setInterval(() => write(": heartbeat\n\n"), 15_000);
      signal.addEventListener(
        "abort",
        () => {
          clearInterval(tick);
          clearInterval(beat);
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        },
        { once: true },
      );
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

// ── a GitHub, for the pickers ──────────────────────────────────────────

const REPOS = [
  { full_name: "BinaryBourbon/fountain", name: "fountain", private: true, default_branch: "main", language: "Elixir" },
  { full_name: "managoat/demos", name: "demos", private: false, default_branch: "main", language: "TypeScript" },
  { full_name: "jhgaylor/home-cloud", name: "home-cloud", private: true, default_branch: "main", language: "TypeScript" },
  { full_name: "jhgaylor/cantor", name: "cantor", private: true, default_branch: "main", language: "TypeScript" },
].map((r, i) => ({
  ...r,
  owner: { login: r.full_name.split("/")[0] },
  description: `A mock repository (${i + 1}).`,
  pushed_at: new Date(Date.now() - i * 86_400_000).toISOString(),
}));

function github(req: Request, path: string, url: URL): Response {
  /**
   * Sign-in, which is the half of GitHub a fixture cannot fake.
   *
   * The real flow sends a browser to GitHub, a person approves, and GitHub
   * redirects back with a code. Here the "approval" is a redirect straight
   * back, so the whole round trip — state minted, state taken, code
   * exchanged, token stored, cookie set — runs exactly as it does in
   * production. That path is where session bugs live, and a dev-only bypass
   * that skipped it would leave it untested until deployment.
   */
  if (path === "/login/oauth/authorize") {
    const back = new URL(url.searchParams.get("redirect_uri") ?? "http://localhost:8081/api/auth/callback");
    back.searchParams.set("code", "mock-code");
    back.searchParams.set("state", url.searchParams.get("state") ?? "");
    return new Response(null, { status: 302, headers: { location: back.toString() } });
  }
  if (path === "/login/oauth/access_token") return json({ access_token: "gho_mockusertoken", token_type: "bearer" });
  if (path.startsWith("/apps/")) {
    // Installing is a click somewhere else in the real thing; here it is
    // already true, so come straight back with the flag the app looks for.
    return new Response(null, { status: 302, headers: { location: "http://localhost:5183/?installed=1" } });
  }

  if (path === "/user") return json({ id: 1, login: "mock", name: "Mock Person", avatar_url: "" });
  if (path === "/user/installations") return json({ installations: [{ id: 1, account: { login: "mock", avatar_url: "" } }] });
  if (/^\/user\/installations\/\d+\/repositories$/.test(path)) {
    return json({ repositories: Number(url.searchParams.get("page") ?? 1) === 1 ? REPOS : [] });
  }
  if (/^\/app\/installations\/\d+\/access_tokens$/.test(path)) {
    return json({ token: "ghs_mocktoken", expires_at: new Date(Date.now() + 3600_000).toISOString() }, 201);
  }
  const repo = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
  if (repo) {
    const full = `${repo[1]}/${repo[2]}`;
    const found = REPOS.find((r) => r.full_name === full);
    const sub = repo[3] ?? "";
    if (!found) return json({ message: "Not Found" }, 404);
    if (sub === "") return json(found);
    if (sub.startsWith("/branches/")) return json({ message: "Branch not found" }, 404);
    if (sub === "/branches") {
      return json([
        { name: "main", commit: { sha: "a1b2c3d4" } },
        { name: "next", commit: { sha: "b2c3d4e5" } },
      ]);
    }
    if (sub === "/pulls") {
      return json([
        { number: 1569, title: "Conversations: reapply agent, environment and vault on attach", user: { login: "jhgaylor" }, head: { ref: "fix/reapply" }, base: { ref: "main" }, draft: false, updated_at: now() },
        { number: 1481, title: "feat(sandbox): add bounded capacity queue", user: { login: "mock" }, head: { ref: "feat/queue" }, base: { ref: "main" }, draft: true, updated_at: now() },
      ]);
    }
    if (sub === "/issues") {
      return json([
        { number: 412, title: "Terminal drops the last line of output", user: { login: "mock" }, labels: [{ name: "bug" }], updated_at: now() },
        { number: 388, title: "Document the receipt format", user: { login: "jhgaylor" }, labels: [], updated_at: now() },
      ]);
    }
  }
  return json({ message: "Not Found" }, 404);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

console.log(`mock fountain + github on http://localhost:${PORT} (build ${BUILD_MS}ms, turn ${TURN_MS}ms)`);
