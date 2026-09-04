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

const subs = new Set<(chunk: string) => void>();

function push(conversationId: string, ev: Record<string, unknown>) {
  const id = state.seq++;
  const full = { id, conversation_id: conversationId, ts: now(), stream: null, data: null, stage: null, state: null, turn_id: null, ...ev };
  const list = state.events.get(conversationId) ?? [];
  list.push(full);
  state.events.set(conversationId, list);
  const frame = `id: ${id}\nevent: message\ndata: ${JSON.stringify(full)}\n\n`;
  for (const send of subs) send(frame);
}

function bump() {
  for (const send of subs) send(`event: conversations\ndata: {}\n\n`);
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
      if (method === "PUT") Object.assign(agent, body);
      return json({ data: agent });
    }

    if (p === "/api/environments" && method === "GET") return json({ data: state.environments });
    if (p === "/api/environments" && method === "POST") {
      const env = { id: `e${state.environments.length + 1}`, repositories: [], packages: [], setup_script: "", ...body };
      state.environments.push(env);
      return json({ data: env });
    }
    const envId = /^\/api\/environments\/([^/]+)$/.exec(p)?.[1];
    if (envId) {
      const env = state.environments.find((e) => e.id === envId);
      if (!env) return json({ error: "not_found" }, 404);
      if (method === "PUT") Object.assign(env, body);
      return json({ data: env });
    }

    if (p === "/api/vaults" && method === "GET") return json({ data: state.vaults });
    if (p === "/api/vaults" && method === "POST") {
      const vault = { id: `v${state.vaults.length + 1}`, ...body };
      state.vaults.push(vault);
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
        state.files.set(`${WORK_ROOT}/.keep`, "");
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
    if (p === "/api/events/stream") {
      const enc = new TextEncoder();
      let send: (chunk: string) => void;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(enc.encode(": connected\n\n"));
            send = (chunk: string) => {
              try {
                controller.enqueue(enc.encode(chunk));
              } catch {
                /* closed */
              }
            };
            subs.add(send);
          },
          cancel() {
            subs.delete(send);
          },
        }),
        { headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*", "cache-control": "no-cache" } },
      );
    }

    return json({ error: "not_found" }, 404);
  },
});

console.log(`mock Fountain on http://localhost:${PORT}`);
