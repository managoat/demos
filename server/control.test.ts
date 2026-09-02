import { afterEach, describe, expect, test } from "bun:test";
import type { AppContext } from "./context";
import { answerPermission, authorizedForTurn, installControlSchema, interrupt, markQueuedNotesSent, preparePromptWithQueuedNotes } from "./control";
import { Cipher, sha256 } from "./crypto";
import { Db, now, type ChatRow } from "./db";
import { Hub } from "./hub";

const open: Db[] = [];
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const db of open.splice(0)) db.close();
});

async function context(): Promise<AppContext> {
  const db = new Db(":memory:");
  open.push(db);
  const cipher = await Cipher.from("control-test-secret-long-enough");
  return {
    db,
    cipher,
    config: { fountainUrl: "http://fountain.test", dataDir: "", dbPath: ":memory:", secret: "", port: 0, staticDir: null, publicUrl: null, sessionMaxAgeMs: 1000, githubApp: null },
  };
}

function chat(ctx: AppContext): ChatRow {
  ctx.db.upsertUser("host@example.com", "u1", "unused");
  const row: ChatRow = {
    id: "chat-1",
    owner_email: "host@example.com",
    conversation_id: "conversation-1",
    title: "",
    runtime: "claude",
    model: "claude-test",
    skills: "[]",
    connectors: "[]",
    preset_id: null,
    preset_name: null,
    environment_id: null,
    vault_id: null,
    agent_id: "agent-1",
    invite_token: null,
    project_id: null,
    archived_at: null,
    created_at: now(),
  };
  ctx.db.insertChat(row);
  return row;
}

describe("queued room notes", () => {
  test("are attached to one later prompt and marked only after acceptance", async () => {
    const ctx = await context();
    const c = chat(ctx);
    installControlSchema(ctx);
    ctx.db.sql.query(`INSERT INTO room_notes (id, chat_id, body, author, queued, created_at)
      VALUES ('note-1', $chat, 'Run the focused test.', 'member@example.com', 1, $at)`).run({ chat: c.id, at: now() });

    const prepared = preparePromptWithQueuedNotes(ctx, c.id, "Make the change.");
    expect(prepared.noteIds).toEqual(["note-1"]);
    expect(prepared.prompt).toContain("member@example.com: Run the focused test.");
    expect(preparePromptWithQueuedNotes(ctx, c.id, "Retry.").noteIds).toEqual(["note-1"]);

    expect(markQueuedNotesSent(ctx, c.id, prepared.noteIds, "host@example.com")).toHaveLength(1);
    expect(preparePromptWithQueuedNotes(ctx, c.id, "Another turn.")).toEqual({ prompt: "Another turn.", noteIds: [] });
  });

  test("keeps authority policy independent of a route", () => {
    expect(authorizedForTurn("host@example.com", "owner", "member@example.com")).toBe(true);
    expect(authorizedForTurn("member@example.com", "member", "member@example.com")).toBe(true);
    expect(authorizedForTurn("other@example.com", "member", "member@example.com")).toBe(false);
  });
});

describe("presence hub", () => {
  test("aggregates tabs and emits named ephemeral events", () => {
    const room = new Hub();
    const events: string[] = [];
    const unsubscribe = room.subscribe("chat", (event) => events.push(event.event));
    const at = Date.parse("2026-09-02T12:00:00.000Z");
    room.heartbeat("chat", "a@example.com", { clientId: "one", typing: true, viewing: { nodeId: "n1", field: null, mode: "editing" } }, at);
    room.heartbeat("chat", "a@example.com", { clientId: "two", typing: false, viewing: null }, at + 1);
    const person = room.presence("chat", at + 2).people[0]!;
    expect(person).toMatchObject({ email: "a@example.com", typing: true, viewing: { nodeId: "n1", mode: "editing" } });
    expect(events).toContain("presence");
    expect(events).toContain("typing");
    expect(events).toContain("viewing");
    room.leave("chat", "a@example.com", "one", at + 3);
    room.leave("chat", "a@example.com", "two", at + 4);
    expect(room.presence("chat", at + 5).people).toEqual([]);
    unsubscribe();
  });
});

describe("Salon-owned control handlers", () => {
  test("derive turn authority server-side and persist an interrupt", async () => {
    const ctx = await context();
    const c = chat(ctx);
    ctx.db.upsertUser("host@example.com", "u1", await ctx.cipher.encrypt("ftn-host"));
    ctx.db.upsertUser("member@example.com", "u2", await ctx.cipher.encrypt("ftn-member"));
    ctx.db.addMember(c.id, "member@example.com", "test");
    const token = "member-session";
    ctx.db.createSession(await sha256(token), "member@example.com");
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/turns")) return Response.json({ data: [{ id: "turn-1", turn_number: 1, prompt: "[from member@example.com] do it", status: "running" }] });
      if (url.pathname.endsWith("/interrupt") && init?.method === "POST") return new Response(null, { status: 204 });
      return Response.json({ error: "not_found" }, { status: 404 });
    }) as typeof fetch;

    const res = await interrupt(ctx, new Request("http://salon.test", { method: "POST", headers: { cookie: `salon_session=${token}` } }), c.id);
    expect(res.status).toBe(202);
    expect(ctx.db.sql.query("SELECT actor, action, turn_id, outcome FROM control_actions").get()).toEqual({ actor: "member@example.com", action: "interrupt", turn_id: "turn-1", outcome: "succeeded" });
  });

  test("keeps Fountain first-answer-wins and names a known winner", async () => {
    const ctx = await context();
    const c = chat(ctx);
    ctx.db.upsertUser("host@example.com", "u1", await ctx.cipher.encrypt("ftn-host"));
    ctx.db.upsertUser("member@example.com", "u2", await ctx.cipher.encrypt("ftn-member"));
    ctx.db.addMember(c.id, "member@example.com", "test");
    const hostToken = "host-session";
    const memberToken = "member-session";
    ctx.db.createSession(await sha256(hostToken), "host@example.com");
    ctx.db.createSession(await sha256(memberToken), "member@example.com");
    let answers = 0;
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/turns")) return Response.json({ data: [{ id: "turn-1", turn_number: 1, prompt: "[from member@example.com] do it", status: "running" }] });
      if (url.pathname.includes("/requests/") && init?.method === "POST") {
        answers++;
        return answers === 1 ? new Response(null, { status: 204 }) : Response.json({ error: "permission_request_resolved", message: "already answered" }, { status: 409 });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    }) as typeof fetch;
    const request = (token: string) => new Request("http://salon.test", { method: "POST", headers: { cookie: `salon_session=${token}`, "content-type": "application/json" }, body: JSON.stringify({ optionId: "allow-once" }) });

    expect((await answerPermission(ctx, request(hostToken), c.id, "request-1")).status).toBe(202);
    const lost = await answerPermission(ctx, request(memberToken), c.id, "request-1");
    expect(lost.status).toBe(409);
    expect(await lost.json()).toMatchObject({ error: "permission_request_resolved", answeredBy: "host@example.com" });
    expect(ctx.db.sql.query("SELECT actor, outcome, winner FROM control_actions ORDER BY rowid DESC LIMIT 1").get()).toEqual({ actor: "member@example.com", outcome: "first_answer_lost", winner: "host@example.com" });
  });
});
