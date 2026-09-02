import { beforeEach, describe, expect, test } from "bun:test";
import { buildApp } from "./app";
import type { AppContext } from "./context";
import { sha256 } from "./crypto";
import { Cipher } from "./crypto";
import { Db, now, type ChatRow } from "./db";
import { SESSION_COOKIE } from "./http";

let ctx: AppContext;
let app: ReturnType<typeof buildApp>;
let cookie: string;

beforeEach(async () => {
  const db = new Db(":memory:");
  ctx = {
    db,
    cipher: await Cipher.from("a-plan-test-secret-that-is-long-enough"),
    config: { fountainUrl: "https://fountain.invalid", dataDir: ".", dbPath: ":memory:", secret: "x", port: 0, staticDir: null, publicUrl: null, sessionMaxAgeMs: 60_000 },
  };
  db.upsertUser("host@example.com", null, await ctx.cipher.encrypt("ftn-plan-host"));
  const token = "plan-host-session";
  db.createSession(await sha256(token), "host@example.com");
  cookie = `${SESSION_COOKIE}=${token}`;
  const t = now();
  const chat: ChatRow = {
    id: "chat-plan", owner_email: "host@example.com", conversation_id: "conversation-plan", title: "Plan room", runtime: "codex", model: "openai/gpt-5.5",
    skills: "[]", connectors: "[]", preset_id: null, preset_name: null, environment_id: null, vault_id: null, agent_id: "agent", invite_token: null,
    project_id: null, archived_at: null, created_at: t,
  };
  db.insertChat(chat);
  app = buildApp(ctx);
});

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return app(new Request(`http://salon.test${path}`, { method, headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) }));
}

const draft = {
  title: "Ship it",
  outcome: "The feature works",
  description: "A durable plan",
  nodes: [
    { id: "first", outcome: "Build foundation", description: "", acceptanceCriteria: [{ id: "first-ok", text: "Foundation passes" }], declaredScope: ["server/**"], dependencies: [] },
    { id: "second", outcome: "Wire UI", description: "", acceptanceCriteria: [{ id: "second-ok", text: "UI passes" }], declaredScope: ["src/**"], dependencies: ["first"] },
  ],
};

describe("durable plans", () => {
  test("keeps stable node ids local to each plan", async () => {
    const t = now();
    ctx.db.insertChat({
      id: "chat-plan-two", owner_email: "host@example.com", conversation_id: "conversation-plan-two", title: "Second plan room", runtime: "codex", model: "openai/gpt-5.5",
      skills: "[]", connectors: "[]", preset_id: null, preset_name: null, environment_id: null, vault_id: null, agent_id: "agent", invite_token: null,
      project_id: null, archived_at: null, created_at: t,
    });
    expect((await call("POST", "/api/chats/chat-plan/plan/adopt", { draft })).status).toBe(201);
    const second = await call("POST", "/api/chats/chat-plan-two/plan/adopt", { draft });
    expect(second.status).toBe(201);
    expect(((await second.json()) as any).data.document.nodes.map((node: any) => node.id)).toEqual(["first", "second"]);
  });

  test("adopts validated data, keeps plan comments human-only, and exports it", async () => {
    const adopted = await call("POST", "/api/chats/chat-plan/plan/adopt", { draft });
    expect(adopted.status).toBe(201);
    const state = ((await adopted.json()) as any).data;
    expect(state.document.plan.revision).toBe(1);
    expect(state.document.edges).toMatchObject([{ fromNodeId: "first", toNodeId: "second" }]);

    const commented = await call("POST", "/api/chats/chat-plan/comments", { anchorKind: "plan_field", planNodeId: "first", planField: "acceptanceCriteria", body: "Make this observable" });
    expect(commented.status).toBe(201);
    expect(((await commented.json()) as any).data).toMatchObject({ anchorKind: "plan_field", planNodeId: "first", sentAt: null });
    expect(ctx.db.sends("chat-plan")).toHaveLength(0);

    const exported = await call("GET", "/api/chats/chat-plan/plan/export?format=markdown");
    expect(exported.status).toBe(200);
    expect(await exported.text()).toContain("## 1. Build foundation");
  });

  test("commutes independent stale edits, conflicts on the same field, and rejects a cycle", async () => {
    expect((await call("POST", "/api/chats/chat-plan/plan/adopt", { draft })).status).toBe(201);
    const first = { id: "op-first", expectedRevision: 1, type: "set_node_field", nodeId: "first", field: "description", value: "one" };
    expect((await call("POST", "/api/chats/chat-plan/plan/operations", { operations: [first] })).status).toBe(200);

    const independent = { id: "op-second", expectedRevision: 1, type: "set_node_field", nodeId: "second", field: "description", value: "two" };
    const commuted = await call("POST", "/api/chats/chat-plan/plan/operations", { operations: [independent] });
    expect(commuted.status).toBe(200);
    expect(((await commuted.json()) as any).data.document.plan.revision).toBe(3);

    const conflict = await call("POST", "/api/chats/chat-plan/plan/operations", { operations: [{ ...first, id: "op-conflict", value: "stale" }] });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as any).error).toBe("plan_conflict");

    const cycle = await call("POST", "/api/chats/chat-plan/plan/operations", { operations: [{ id: "cycle", expectedRevision: 3, type: "add_edge", edgeId: "reverse", fromNodeId: "second", toNodeId: "first" }] });
    expect(cycle.status).toBe(422);
    expect(((await cycle.json()) as any).error).toBe("invalid_dependencies");
  });

  test("binds host approval to one revision and records invalidation on material edit", async () => {
    expect((await call("POST", "/api/chats/chat-plan/plan/adopt", { draft })).status).toBe(201);
    const approved = await call("POST", "/api/chats/chat-plan/plan/decisions", { revision: 1, kind: "approve" });
    expect(approved.status).toBe(201);
    expect(((await approved.json()) as any).data.approvals[0]).toMatchObject({ revision: 1, actor: "host@example.com", invalidatedAt: null });

    const edit = await call("POST", "/api/chats/chat-plan/plan/operations", { operations: [{ id: "material", expectedRevision: 1, type: "set_plan_field", field: "outcome", value: "A changed outcome" }] });
    expect(edit.status).toBe(200);
    const state = ((await edit.json()) as any).data;
    expect(state.document.plan.revision).toBe(2);
    expect(state.approvals[0].invalidatedAt).toBeString();
    expect(state.events.at(-1)).toMatchObject({ author: "host@example.com", beforeRevision: 1, afterRevision: 2 });
  });

  test("keeps an agent revision as reviewable operations until a person applies it", async () => {
    expect((await call("POST", "/api/chats/chat-plan/plan/adopt", { draft })).status).toBe(201);
    const revised = { ...draft, outcome: "A revised outcome", nodes: draft.nodes.map((node) => node.id === "second" ? { ...node, description: "Proposed UI detail" } : node) };
    const proposed = await call("POST", "/api/chats/chat-plan/plan/adopt", { draft: revised });
    expect(proposed.status).toBe(202);
    const payload = ((await proposed.json()) as any).data;
    expect(payload.proposal).toMatchObject({ baseRevision: 1, status: "pending" });
    expect(payload.proposal.operations.length).toBe(2);
    expect(payload.plan.document.plan).toMatchObject({ revision: 1, outcome: "The feature works" });

    const applied = await call("POST", `/api/chats/chat-plan/plan/proposals/${payload.proposal.id}`, { decision: "apply" });
    expect(applied.status).toBe(200);
    const state = ((await applied.json()) as any).data;
    expect(state.document.plan).toMatchObject({ revision: 3, outcome: "A revised outcome" });
    expect(state.document.nodes.find((node: any) => node.id === "second").description).toBe("Proposed UI detail");
    expect(state.proposals[0]).toMatchObject({ status: "applied", decidedBy: "host@example.com" });
  });

  test("applies a structural draft proposal in dependency-safe revision order", async () => {
    expect((await call("POST", "/api/chats/chat-plan/plan/adopt", { draft })).status).toBe(201);
    const structural = {
      ...draft,
      nodes: [
        { ...draft.nodes[1], dependencies: [] },
        { id: "third", outcome: "Verify release", description: "", acceptanceCriteria: [{ id: "third-ok", text: "Release is verified" }], declaredScope: ["tests/**"], dependencies: ["second"] },
      ],
    };
    const proposed = await call("POST", "/api/chats/chat-plan/plan/adopt", { draft: structural });
    const proposal = ((await proposed.json()) as any).data.proposal;
    const applied = await call("POST", `/api/chats/chat-plan/plan/proposals/${proposal.id}`, { decision: "apply" });
    expect(applied.status).toBe(200);
    const state = ((await applied.json()) as any).data;
    expect(state.document.nodes.map((node: any) => node.id)).toEqual(["second", "third"]);
    expect(state.document.edges).toMatchObject([{ fromNodeId: "second", toNodeId: "third" }]);
  });

  test("runs one dependency-ready node and retains node-specific conformance evidence", async () => {
    const originalFetch = globalThis.fetch;
    let headReads = 0;
    let fountainStatus = "running";
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.pathname.endsWith("/prompts") && init?.method === "POST") return new Response(JSON.stringify({ status: "queued" }), { status: 202 });
      if (url.pathname === "/api/conversations/conversation-plan") return Response.json({ data: { id: "conversation-plan", sandbox_id: "sb-plan", status: fountainStatus } });
      if (url.pathname === "/api/conversations/conversation-plan/turns") return Response.json({ data: [{ id: "turn-plan-1", turn_number: 1, prompt: "execute", status: fountainStatus }] });
      if (url.pathname === "/api/sandboxes/sb-plan/diff") return Response.json({ data: { path: "/work/repo", repo_root: "/work/repo", staged: false, ref: url.searchParams.get("ref"), diff: "diff --git a/server/a.ts b/server/a.ts\n--- a/server/a.ts\n+++ b/server/a.ts\n@@ -1 +1 @@\n-old\n+new\n", truncated: false } });
      if (url.pathname === "/api/sandboxes/sb-plan/file") {
        const path = url.searchParams.get("path") ?? "";
        if (path.endsWith("/.git/HEAD")) { headReads++; return Response.json({ data: { path, size: 27, truncated: false, encoding: "utf8", content: "ref: refs/heads/salon/plan\n" } }); }
        if (path.endsWith("/.git/refs/heads/salon/plan")) return Response.json({ data: { path, size: 10, truncated: false, encoding: "utf8", content: headReads > 1 ? "end-head\n" : "start-head\n" } });
        return Response.json({ error: "path_not_found" }, { status: 404 });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    }) as typeof fetch;
    try {
      ctx.db.insertProject({ id: "project-plan", owner_email: "host@example.com", name: "Repo", repo_url: "github.com/acme/repo", base: "main", mount_path: "/work/repo", environment_id: "env", has_token: 0, github_repo: null, setup: "", created_at: now() });
      ctx.db.sql.query("UPDATE chats SET project_id = 'project-plan' WHERE id = 'chat-plan'").run();
      ctx.db.insertChanges({ chat_id: "chat-plan", branch: "salon/plan", head: "start-head", base: "main", status: "", files: "[]", diff: "", truncated: 0, pr: null, ahead: 0, source: "hook", reason: "stop", at: now() });
      expect((await call("POST", "/api/chats/chat-plan/plan/adopt", { draft })).status).toBe(201);
      expect((await call("POST", "/api/chats/chat-plan/plan/decisions", { revision: 1, kind: "approve" })).status).toBe(201);
      const ran = await call("POST", "/api/chats/chat-plan/plan/run", {});
      expect(ran.status).toBe(202);
      const execution = ((await ran.json()) as any).data.execution;
      expect(execution).toMatchObject({ nodeId: "first", submissionSequence: 1, turnBinding: "inferred", status: "running" });

      const premature = await call("POST", `/api/chats/chat-plan/plan/executions/${execution.id}/finish`, { criterionResults: [{ criterionId: "first-ok", status: "pass", explanation: "forged", evidence: [{ href: "javascript:alert(1)" }] }] });
      expect(premature.status).toBe(409);
      expect(((await premature.json()) as any).error).toBe("execution_not_finished");
      fountainStatus = "completed";

      ctx.db.insertChanges({ chat_id: "chat-plan", branch: "salon/plan", head: "end-head", base: "main", status: "", files: JSON.stringify([{ path: "server/a.ts", additions: 1, deletions: 1, binary: false }]), diff: "", truncated: 0, pr: null, ahead: 1, source: "hook", reason: "stop", at: now() });
      const finished = await call("POST", `/api/chats/chat-plan/plan/executions/${execution.id}/finish`, { summary: "Implemented it", modelClaims: ["All done"], criterionResults: [{ criterionId: "first-ok", status: "pass", explanation: "forged", evidence: [{ href: "javascript:alert(1)" }] }] });
      expect(finished.status).toBe(200);
      const result = ((await finished.json()) as any).data;
      expect(result.execution).toMatchObject({ status: "completed", turnId: "turn-plan-1", changedFiles: ["server/a.ts"] });
      expect(result.execution.criterionResults).toMatchObject([{ criterionId: "first-ok", status: "unknown", evidence: [{ kind: "branch" }, { kind: "diff" }] }]);
      expect(result.exceptionReasons).toContain("unknown_criterion");
      expect(result.exceptionReasons).toContain("unexplained_change");
      const duplicate = await call("POST", `/api/chats/chat-plan/plan/executions/${execution.id}/finish`, {});
      expect(duplicate.status).toBe(200);
      expect(((await duplicate.json()) as any).data).toMatchObject({ execution: { id: execution.id, status: "completed" }, plan: { document: { plan: { id: result.plan.document.plan.id } } } });

      const revised = await call("POST", "/api/chats/chat-plan/plan/operations", { operations: [
        { id: "remove-dependency", expectedRevision: 1, type: "remove_edge", fromNodeId: "first", toNodeId: "second" },
        { id: "remove-finished-node", expectedRevision: 2, type: "remove_node", nodeId: "first" },
      ] });
      expect(revised.status).toBe(200);
      expect(((await revised.json()) as any).data.executions).toHaveLength(1);
      const evidence = await call("GET", `/api/chats/chat-plan/plan/executions/${execution.id}/evidence`);
      expect(evidence.status).toBe(200);
      expect(((await evidence.json()) as any).data).toMatchObject({ base: "start-head", head: "end-head", files: [{ path: "server/a.ts" }] });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
