/**
 * A tiny mock Fountain for developing paddock without a live server.
 *
 * It is more than a fixture on purpose: it simulates the *box*. A prompt that
 * looks like paddock's apply contract is parsed for its `id:` lines, and the
 * ids are written into an in-memory `~/.paddock/applied.json` exactly as a
 * real agent would write them — so the whole loop the app exists to
 * demonstrate (declare → pending → apply → applied) actually runs here.
 *
 *   bun run mock                                  # this, on :8792
 *   FOUNTAIN_PROXY=http://localhost:8792 bun run dev
 *
 * Then open http://localhost:5182, enter http://localhost:5182 as the Fountain
 * URL and paste any non-empty key.
 */
import { RECEIPT_PATH, WORK_ROOT } from "../shared/spec";

const PORT = 8792;
const now = () => new Date().toISOString();

interface Conv {
  id: string;
  title: string | null;
  sandbox_id: string | null;
  agent_id: string;
  vault_id: string | null;
  environment_id: string | null;
  runtime: string;
  status: string;
  channel_id: string | null;
  turn_count: number;
  last_active_at: string | null;
  inserted_at: string;
}

const state = {
  seq: 1,
  agents: [] as Record<string, unknown>[],
  environments: [] as Record<string, unknown>[],
  vaults: [] as Record<string, unknown>[],
  secrets: new Map<string, Map<string, string>>(), // `${parent}:${id}` → key → value
  conversations: [] as Conv[],
  sandbox: null as null | Record<string, unknown>,
  /** The box's disk, as far as anything here is concerned. */
  files: new Map<string, string>(),
  events: new Map<string, unknown[]>(),
};

/**
 * A subscriber is scoped: `conversationId: null` is the account-wide stream,
 * anything else is one conversation's own tail. Paddock uses the second —
 * the account-wide one carries every conversation the key can see, which is
 * not shareable with a guest.
 */
interface Sub {
  conversationId: string | null;
  send: (chunk: string) => void;
}
const subs = new Set<Sub>();

function push(conversationId: string, ev: Record<string, unknown>) {
  const id = state.seq++;
  const full = { id, conversation_id: conversationId, ts: now(), stream: null, data: null, stage: null, state: null, turn_id: null, ...ev };
  const list = state.events.get(conversationId) ?? [];
  list.push(full);
  state.events.set(conversationId, list);
  const frame = `id: ${id}\nevent: message\ndata: ${JSON.stringify(full)}\n\n`;
  for (const sub of subs) {
    if (sub.conversationId === null || sub.conversationId === conversationId) sub.send(frame);
  }
}

function bump() {
  for (const sub of subs) {
    if (sub.conversationId === null) sub.send(`event: conversations\ndata: {}\n\n`);
  }
}

const acp = (update: Record<string, unknown>) =>
  JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update } });

const text = (t: string) => acp({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } });
const tool = (id: string, title: string) => acp({ sessionUpdate: "tool_call", toolCallId: id, title, kind: "execute" });
const toolDone = (id: string, out: string) =>
  acp({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", content: [{ type: "content", content: { type: "text", text: out } }] });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The box taking a turn. Reads the prompt the way a real agent would: the
 * bootstrap prompt makes a directory, the apply and reconcile prompts collect
 * their `id:` lines and write the receipt.
 */
async function runTurn(conv: Conv, prompt: string) {
  conv.status = "running";
  conv.last_active_at = now();
  conv.turn_count += 1;
  bump();
  push(conv.id, { kind: "stage", stage: "turn", state: "started" });

  const ids = [...prompt.matchAll(/^\s*id:\s*(\S.*)$/gm)].map((m) => m[1]!.trim());
  const isApply = prompt.includes("[paddock] Apply these changes");
  const isReconcile = prompt.includes("[paddock] This machine has no readable receipt");
  const isBootstrap = prompt.includes("[paddock] New terminal tab");

  await sleep(400);

  if (isBootstrap) {
    const dir = /cd ([^\s`,]+)/.exec(prompt)?.[1] ?? WORK_ROOT;
    push(conv.id, { kind: "output", stream: "acp", data: tool("t1", `mkdir -p ${dir}`) });
    await sleep(300);
    push(conv.id, { kind: "output", stream: "acp", data: toolDone("t1", "") });
    push(conv.id, { kind: "output", stream: "acp", data: text(`${dir}`) });
    // The welcome turn asks for an introduction after the setup; a real agent
    // would write one, so the fake gestures at it rather than stopping short
    // and making the first-run screen look broken.
    if (prompt.includes("introduce it")) {
      await sleep(300);
      push(conv.id, {
        kind: "output",
        stream: "acp",
        data: text(
          "\n(mock) This machine is yours and it stays up between visits. A new tab is another session on this same box with its own directory, and only one tab takes a turn at a time. The Machine panel is where repositories, packages and secrets go — nothing there reaches the box until you apply it, and you watch that happen here. People is how you let somebody else in.\n\nTry: ask me what is installed.",
        ),
      });
    }
  } else if (isApply || isReconcile) {
    // "keep" ids are the bullet-less lines under the keep list; the numbered
    // work is what carries `id:`. Both end up in the receipt, which is what a
    // real agent is asked to do.
    const keep = [...prompt.matchAll(/^ {2}((?:pkg|repo|setup|skill):\S.*)$/gm)].map((m) => m[1]!.trim());
    const done = isReconcile ? [] : ids;
    for (const id of done) {
      push(conv.id, { kind: "output", stream: "acp", data: tool(id, id) });
      await sleep(250);
      push(conv.id, { kind: "output", stream: "acp", data: toolDone(id, "ok") });
    }
    const items = [...new Set([...keep, ...done])];
    state.files.set(
      RECEIPT_PATH,
      JSON.stringify({ rev: Number(/"rev":\s*(\d+)/.exec(prompt)?.[1] ?? 1), runtime: conv.runtime, applied_at: now(), items, failed: [] }, null, 2),
    );
    push(conv.id, { kind: "output", stream: "acp", data: text(items.map((i) => `${i} ok`).join("\n") || "nothing to do") });
  } else {
    push(conv.id, { kind: "output", stream: "acp", data: tool("x", "bash -lc 'echo hello'") });
    await sleep(400);
    push(conv.id, { kind: "output", stream: "acp", data: toolDone("x", "hello") });
    push(conv.id, { kind: "output", stream: "acp", data: text(`(mock) you said: ${prompt.slice(0, 120)}`) });
  }

  await sleep(200);
  conv.status = "idle";
  push(conv.id, { kind: "stage", stage: "turn", state: "completed" });
  bump();
}

/**
 * The validation Fountain actually applies, as far as paddock has met it.
 *
 * A mock that accepts anything is a mock that lets a wrong shape reach
 * production, which is exactly what happened: `packages` is keyed by package
 * manager (`{"apt": ["ripgrep"]}`) and paddock sent an array for a week,
 * because nothing here objected. Every rule below is one Fountain enforced on
 * us; add to it whenever it teaches us another.
 */
function badEnvironment(body: Record<string, unknown>): { error: string; errors: Record<string, string[]> } | null {
  const errors: Record<string, string[]> = {};
  const packages = body.packages;
  if (packages !== undefined && packages !== null) {
    if (typeof packages !== "object" || Array.isArray(packages)) {
      errors.packages = [`Invalid object. Got: ${Array.isArray(packages) ? "array" : typeof packages}`];
    } else {
      for (const [manager, names] of Object.entries(packages as Record<string, unknown>)) {
        if (!Array.isArray(names) || names.some((n) => typeof n !== "string")) {
          errors.packages = [`${manager}: expected a list of strings`];
        }
      }
    }
  }
  const repos = body.repositories;
  if (repos !== undefined && repos !== null && !Array.isArray(repos)) errors.repositories = ["Invalid array."];
  const setup = body.setup_script;
  if (setup !== undefined && setup !== null && typeof setup !== "string") errors.setup_script = ["Invalid string."];
  return Object.keys(errors).length ? { error: "validation_failed", errors } : null;
}

/** One server-sent stream, either for a conversation or for the account. */
function sse(conversationId: string | null): Response {
  const enc = new TextEncoder();
  let sub: Sub;
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode(": connected\n\n"));
        sub = {
          conversationId,
          send: (chunk: string) => {
            try {
              controller.enqueue(enc.encode(chunk));
            } catch {
              /* closed */
            }
          },
        };
        subs.add(sub);
      },
      cancel() {
        subs.delete(sub);
      },
    }),
    { headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*", "cache-control": "no-cache" } },
  );
}

function secretsFor(parent: string, id: string): Map<string, string> {
  const key = `${parent}:${id}`;
  if (!state.secrets.has(key)) state.secrets.set(key, new Map());
  return state.secrets.get(key)!;
}

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "access-control-allow-origin": "*" } });
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    const method = req.method;
    if (method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
          "access-control-allow-headers": "authorization,content-type",
        },
      });
    }
    const body = method === "POST" || method === "PUT" ? await req.json().catch(() => ({})) : {};

    // ── identity ──────────────────────────────────────────────────────────
    if (p === "/api/auth/me") return json({ id: "u1", email: "you@example.com" });
    if (p === "/api/catalog")
      return json({ data: { runtimes: ["claude", "codex"], models: { claude: ["claude-opus-5", "claude-sonnet-5"], codex: ["gpt-5"] } } });

    if (p === "/api/agents" && method === "GET") return json({ data: state.agents });
    if (p === "/api/agents" && method === "POST") {
      const agent = { id: `a${state.agents.length + 1}`, ...body };
      state.agents.push(agent);
      return json({ data: agent });
    }
    const agentId = /^\/api\/agents\/([^/]+)$/.exec(p)?.[1];
    if (agentId) {
      const agent = state.agents.find((a) => a.id === agentId);
      if (!agent) return json({ error: "not_found" }, 404);
      if (method === "DELETE") {
        state.agents = state.agents.filter((a) => a.id !== agentId);
        return new Response(null, { status: 204 });
      }
      if (method === "PUT") Object.assign(agent, body);
      return json({ data: agent });
    }

    if (p === "/api/environments" && method === "GET") return json({ data: state.environments });
    if (p === "/api/environments" && method === "POST") {
      const bad = badEnvironment(body);
      if (bad) return json(bad, 422);
      const env = { id: `e${state.environments.length + 1}`, repositories: [], packages: {}, setup_script: "", ...body };
      state.environments.push(env);
      return json({ data: env });
    }
    const envId = /^\/api\/environments\/([^/]+)$/.exec(p)?.[1];
    if (envId) {
      const env = state.environments.find((e) => e.id === envId);
      if (!env) return json({ error: "not_found" }, 404);
      if (method === "DELETE") {
        state.environments = state.environments.filter((e) => e.id !== envId);
        state.secrets.delete(`environments:${envId}`);
        return new Response(null, { status: 204 });
      }
      if (method === "PUT") {
        const bad = badEnvironment(body);
        if (bad) return json(bad, 422);
        Object.assign(env, body);
      }
      return json({ data: env });
    }

    if (p === "/api/vaults" && method === "GET") return json({ data: state.vaults });
    if (p === "/api/vaults" && method === "POST") {
      const vault = { id: `v${state.vaults.length + 1}`, ...body };
      state.vaults.push(vault);
      return json({ data: vault });
    }

    const vaultId = /^\/api\/vaults\/([^/]+)$/.exec(p)?.[1];
    if (vaultId) {
      const vault = state.vaults.find((v) => v.id === vaultId);
      if (!vault) return json({ error: "not_found" }, 404);
      if (method === "DELETE") {
        state.vaults = state.vaults.filter((v) => v.id !== vaultId);
        state.secrets.delete(`vaults:${vaultId}`);
        return new Response(null, { status: 204 });
      }
      return json({ data: vault });
    }

    const secretList = /^\/api\/(environments|vaults)\/([^/]+)\/secrets$/.exec(p);
    if (secretList) {
      const keys = [...secretsFor(secretList[1]!, secretList[2]!).keys()].map((key) => ({ key, updated_at: now() }));
      return json({ data: keys });
    }
    const secretOne = /^\/api\/(environments|vaults)\/([^/]+)\/secrets\/([^/]+)$/.exec(p);
    if (secretOne) {
      const bag = secretsFor(secretOne[1]!, secretOne[2]!);
      const key = decodeURIComponent(secretOne[3]!);
      if (method === "PUT") bag.set(key, String((body as { value?: unknown }).value ?? ""));
      if (method === "DELETE") bag.delete(key);
      return json({ data: { key } });
    }

    // ── conversations ─────────────────────────────────────────────────────
    if (p === "/api/conversations" && method === "GET") {
      const withSandbox = state.conversations.map((c) => ({ ...c, sandbox: c.sandbox_id ? state.sandbox : null }));
      return json({ data: withSandbox });
    }
    if (p === "/api/conversations" && method === "POST") {
      const b = body as Record<string, string | undefined>;
      if (!state.sandbox) {
        state.sandbox = { id: "sb-mock-1", sprite_name: "paddock-mock", status: "ready", provider: "mock", mode: "persistent", agent_id: b.agent_id, environment_id: b.environment_id ?? null, vault_id: b.vault_id ?? null, url: null };
        // A small tree, so the file browser has something to be a file browser
        // about. A real box has a checkout here; an empty mock made the
        // explorer look broken when it was merely accurate.
        for (const [path, body] of [
          [`${WORK_ROOT}/t1/README.md`, "# Your machine\n\nThis is a mock checkout.\n"],
          [`${WORK_ROOT}/t1/package.json`, '{\n  "name": "example",\n  "version": "0.1.0"\n}\n'],
          [`${WORK_ROOT}/t1/src/index.ts`, 'export function hello(): string {\n  return "hello";\n}\n'],
          [`${WORK_ROOT}/t1/src/lib/util.ts`, "export const answer = 42;\n"],
          [`${WORK_ROOT}/t1/test/index.test.ts`, 'import { hello } from "../src/index";\n'],
        ] as [string, string][]) {
          state.files.set(path, body);
        }
      }
      // Attaching is identity-checked, the way Fountain checks it. The disk was
      // built for one (agent, environment, vault) and a launch that names a
      // different one — including by *omitting* a field the box was built with
      // — is 422 sandbox_identity_mismatch. Paddock shipped an attach that sent
      // only the agent and the sandbox, and this is the rule that caught it.
      if (b.sandbox_id) {
        const box = state.sandbox as Record<string, string | null> | null;
        if (!box || box.id !== b.sandbox_id) return json({ error: "sandbox_not_found" }, 404);
        const wanted = { agent_id: b.agent_id ?? null, environment_id: b.environment_id ?? null, vault_id: b.vault_id ?? null };
        for (const key of ["agent_id", "environment_id", "vault_id"] as const) {
          if ((box[key] ?? null) !== wanted[key]) {
            return json({ error: "sandbox_identity_mismatch", message: "That machine was built for a different agent, environment or vault." }, 422);
          }
        }
      }
      const agent = state.agents.find((a) => a.id === b.agent_id) as { runtime?: string } | undefined;
      const conv: Conv = {
        id: `c${state.conversations.length + 1}`,
        title: b.title ?? null,
        sandbox_id: (state.sandbox as { id: string }).id,
        agent_id: b.agent_id!,
        vault_id: b.vault_id ?? null,
        environment_id: b.environment_id ?? null,
        runtime: agent?.runtime ?? "claude",
        status: "pending",
        channel_id: b.channel_id ?? null,
        turn_count: 0,
        last_active_at: null,
        inserted_at: now(),
      };
      state.conversations.push(conv);
      bump();
      // A prompt sent with the create call is the first turn — that is how
      // every app in the suite starts a conversation, so the fake has to run
      // it. Ignoring it made a started machine look like a dead one.
      const first = typeof b.prompt === "string" ? b.prompt : "";
      if (first.trim()) void runTurn(conv, first);
      return json({ data: { ...conv, sandbox: state.sandbox } });
    }

    const convPrompt = /^\/api\/conversations\/([^/]+)\/prompts$/.exec(p);
    if (convPrompt) {
      const conv = state.conversations.find((c) => c.id === convPrompt[1]);
      if (!conv) return json({ error: "not_found" }, 404);
      // The real thing serialises turns per box; so does this.
      if (state.conversations.some((c) => c.sandbox_id === conv.sandbox_id && c.status === "running")) {
        return json({ error: "sandbox_at_capacity" }, 409);
      }
      void runTurn(conv, String((body as { prompt?: unknown }).prompt ?? ""));
      return json({ status: "accepted" });
    }

    const convStream = /^\/api\/conversations\/([^/]+)\/stream$/.exec(p);
    if (convStream) return sse(convStream[1]!);

    const convEvents = /^\/api\/conversations\/([^/]+)\/events$/.exec(p);
    if (convEvents) return json({ data: state.events.get(convEvents[1]!) ?? [], meta: { has_more: false, next_cursor: null } });

    const convAction = /^\/api\/conversations\/([^/]+)\/(interrupt|terminate|read)$/.exec(p);
    if (convAction) {
      const conv = state.conversations.find((c) => c.id === convAction[1]);
      if (conv && convAction[2] === "terminate") conv.status = "terminated";
      if (conv && convAction[2] === "interrupt") conv.status = "idle";
      bump();
      return json({ status: "ok" });
    }

    const convOne = /^\/api\/conversations\/([^/]+)$/.exec(p);
    if (convOne) {
      const conv = state.conversations.find((c) => c.id === convOne[1]);
      return conv ? json({ data: { ...conv, sandbox: state.sandbox } }) : json({ error: "not_found" }, 404);
    }

    // ── the box, read-only ────────────────────────────────────────────────
    const sbFile = /^\/api\/sandboxes\/([^/]+)\/file$/.exec(p);
    if (sbFile) {
      const path = url.searchParams.get("path") ?? "";
      const content = state.files.get(path);
      if (content === undefined) return json({ error: "not_found" }, 404);
      return json({ data: { path, size: content.length, truncated: false, encoding: "utf8", content } });
    }
    const sbFiles = /^\/api\/sandboxes\/([^/]+)\/files$/.exec(p);
    if (sbFiles) {
      const dir = (url.searchParams.get("path") ?? "/").replace(/\/+$/, "");
      const seen = new Map<string, { name: string; type: string; size: number | null }>();
      for (const [path, content] of state.files) {
        if (!path.startsWith(`${dir}/`)) continue;
        const rest = path.slice(dir.length + 1);
        const slash = rest.indexOf("/");
        const name = slash === -1 ? rest : rest.slice(0, slash);
        seen.set(name, slash === -1 ? { name, type: "file", size: content.length } : { name, type: "dir", size: null });
      }
      return json({ data: { path: dir || "/", entries: [...seen.values()], truncated: false } });
    }
    const sbDiff = /^\/api\/sandboxes\/([^/]+)\/diff$/.exec(p);
    if (sbDiff) return json({ data: { path: url.searchParams.get("path") ?? "", repo_root: "/home/sprite/api", staged: false, ref: "main", diff: "", truncated: false } });
    const sbOne = /^\/api\/sandboxes\/([^/]+)$/.exec(p);
    if (sbOne) return state.sandbox ? json({ data: state.sandbox }) : json({ error: "not_found" }, 404);

    // ── stream ────────────────────────────────────────────────────────────
    if (p === "/api/events/stream") return sse(null);

    // Loud on purpose. Three real bugs hid behind a quiet 404 here — the
    // client swallowed it and the app just looked empty. A route the app calls
    // and the fake does not serve is a gap in the fake, and it should say so.
    console.warn(`mock: no route for ${method} ${p}`);
    return json({ error: "not_found" }, 404);
  },
});

console.log(`mock Fountain on http://localhost:${PORT}`);
