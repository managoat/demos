/**
 * Salon's own records, in SQLite (`bun:sqlite`): who has signed in (and the
 * Fountain key their chats run on), sessions, chats with their host and
 * guests, and who sent each turn.
 *
 * The conversation itself stays on Fountain, under the host's key, bound to
 * `channel_id = salon:<chat>`. Fountain has no sharing primitive and no idea
 * who typed a prompt; those two facts are what this file holds.
 */
import { Database } from "bun:sqlite";

export interface UserRow {
  email: string;
  fountain_id: string | null;
  key_enc: string;
  created_at: string;
  key_updated_at: string;
}

export interface ChatRow {
  id: string;
  owner_email: string;
  conversation_id: string;
  /** A name the host gave it; empty means "use the conversation's own title". */
  title: string;
  /** Derived from the model's provider; kept so a chat's history reads without the rule. */
  runtime: string;
  model: string;
  /** JSON: skill ids (`shared/skills.ts`). */
  skills: string;
  /** JSON: `[{id, label}]` — the connections attached, and the names the header shows. */
  connectors: string;
  preset_id: string | null;
  preset_name: string | null;
  environment_id: string | null;
  vault_id: string | null;
  agent_id: string;
  /** The join link's token; null when the host has not made one. */
  invite_token: string | null;
  created_at: string;
}

export interface MemberRow {
  chat_id: string;
  email: string;
  added_by: string;
  added_at: string;
}

/** One prompt somebody sent through Salon: the nth user turn of the chat was theirs. */
export interface SendRow {
  chat_id: string;
  seq: number;
  email: string;
  at: string;
}

export type Role = "owner" | "member";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY,
  fountain_id TEXT,
  key_enc TEXT NOT NULL,
  created_at TEXT NOT NULL,
  key_updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_email ON sessions(email);
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  runtime TEXT NOT NULL,
  model TEXT NOT NULL,
  preset_id TEXT,
  preset_name TEXT,
  environment_id TEXT,
  vault_id TEXT,
  skills TEXT NOT NULL DEFAULT '[]',
  connectors TEXT NOT NULL DEFAULT '[]',
  agent_id TEXT NOT NULL,
  invite_token TEXT UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chats_owner ON chats(owner_email);
CREATE TABLE IF NOT EXISTS chat_members (
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (chat_id, email)
);
CREATE INDEX IF NOT EXISTS chat_members_email ON chat_members(email);
CREATE TABLE IF NOT EXISTS sends (
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  email TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (chat_id, seq)
);
`;

export function now(): string {
  return new Date().toISOString();
}

export class Db {
  readonly sql: Database;

  constructor(path = ":memory:") {
    this.sql = new Database(path, { create: true, strict: true });
    this.sql.exec("PRAGMA journal_mode = WAL");
    this.sql.exec("PRAGMA foreign_keys = ON");
    this.sql.exec(SCHEMA);
    this.migrate();
  }

  /** Columns added since the first release, for a database that predates them. */
  private migrate(): void {
    const have = new Set((this.sql.query("PRAGMA table_info(chats)").all() as { name: string }[]).map((c) => c.name));
    if (!have.has("skills")) this.sql.exec("ALTER TABLE chats ADD COLUMN skills TEXT NOT NULL DEFAULT '[]'");
    if (!have.has("connectors")) this.sql.exec("ALTER TABLE chats ADD COLUMN connectors TEXT NOT NULL DEFAULT '[]'");
  }

  close(): void {
    this.sql.close();
  }

  // ── users ────────────────────────────────────────────────────────────

  getUser(email: string): UserRow | null {
    return (this.sql.query("SELECT * FROM users WHERE email = $email").get({ email }) as UserRow | null) ?? null;
  }

  /** Create or refresh a user: every sign-in replaces the key their chats run on. */
  upsertUser(email: string, fountainId: string | null, keyEnc: string): UserRow {
    const t = now();
    this.sql
      .query(
        `INSERT INTO users (email, fountain_id, key_enc, created_at, key_updated_at) VALUES ($email, $fountain_id, $key_enc, $t, $t)
         ON CONFLICT(email) DO UPDATE SET fountain_id = excluded.fountain_id, key_enc = excluded.key_enc, key_updated_at = excluded.key_updated_at`,
      )
      .run({ email, fountain_id: fountainId, key_enc: keyEnc, t });
    return this.getUser(email)!;
  }

  // ── sessions ─────────────────────────────────────────────────────────

  createSession(tokenHash: string, email: string): void {
    const t = now();
    this.sql.query("INSERT INTO sessions (token_hash, email, created_at, last_seen_at) VALUES ($h, $email, $t, $t)").run({ h: tokenHash, email, t });
  }

  sessionUser(tokenHash: string): UserRow | null {
    const row = this.sql.query("SELECT email FROM sessions WHERE token_hash = $h").get({ h: tokenHash }) as { email: string } | null;
    if (!row) return null;
    this.sql.query("UPDATE sessions SET last_seen_at = $t WHERE token_hash = $h").run({ t: now(), h: tokenHash });
    return this.getUser(row.email);
  }

  deleteSession(tokenHash: string): void {
    this.sql.query("DELETE FROM sessions WHERE token_hash = $h").run({ h: tokenHash });
  }

  expireSessions(maxAgeMs: number): void {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    this.sql.query("DELETE FROM sessions WHERE last_seen_at < $cutoff").run({ cutoff });
  }

  // ── chats ────────────────────────────────────────────────────────────

  getChat(id: string): ChatRow | null {
    return (this.sql.query("SELECT * FROM chats WHERE id = $id").get({ id }) as ChatRow | null) ?? null;
  }

  /** Chats the user hosts or was invited to, newest first. */
  chatsFor(email: string): ChatRow[] {
    return this.sql
      .query(
        `SELECT c.* FROM chats c
         WHERE c.owner_email = $email OR c.id IN (SELECT chat_id FROM chat_members WHERE email = $email)
         ORDER BY c.created_at DESC, c.id`,
      )
      .all({ email }) as ChatRow[];
  }

  /** Owner or member, or null when the user has no business with the chat. */
  roleIn(chatId: string, email: string): Role | null {
    const c = this.getChat(chatId);
    if (!c) return null;
    if (c.owner_email === email) return "owner";
    const m = this.sql.query("SELECT 1 FROM chat_members WHERE chat_id = $c AND email = $e").get({ c: chatId, e: email });
    return m ? "member" : null;
  }

  insertChat(c: ChatRow): void {
    this.sql
      .query(
        `INSERT INTO chats (id, owner_email, conversation_id, title, runtime, model, skills, connectors, preset_id, preset_name, environment_id, vault_id, agent_id, invite_token, created_at)
         VALUES ($id, $owner_email, $conversation_id, $title, $runtime, $model, $skills, $connectors, $preset_id, $preset_name, $environment_id, $vault_id, $agent_id, $invite_token, $created_at)`,
      )
      .run(c as unknown as Record<string, string | null>);
  }

  updateChat(id: string, patch: Partial<Pick<ChatRow, "title" | "invite_token">>): void {
    const cur = this.getChat(id);
    if (!cur) return;
    const next = { ...cur, ...patch };
    this.sql.query("UPDATE chats SET title = $title, invite_token = $invite_token WHERE id = $id").run({ id, title: next.title, invite_token: next.invite_token });
  }

  deleteChat(id: string): void {
    this.sql.query("DELETE FROM chats WHERE id = $id").run({ id });
  }

  chatByInvite(token: string): ChatRow | null {
    return (this.sql.query("SELECT * FROM chats WHERE invite_token = $t").get({ t: token }) as ChatRow | null) ?? null;
  }

  // ── members ──────────────────────────────────────────────────────────

  members(chatId: string): MemberRow[] {
    return this.sql.query("SELECT * FROM chat_members WHERE chat_id = $c ORDER BY added_at, email").all({ c: chatId }) as MemberRow[];
  }

  addMember(chatId: string, email: string, addedBy: string): boolean {
    const r = this.sql
      .query("INSERT OR IGNORE INTO chat_members (chat_id, email, added_by, added_at) VALUES ($c, $e, $by, $t)")
      .run({ c: chatId, e: email, by: addedBy, t: now() });
    return r.changes > 0;
  }

  removeMember(chatId: string, email: string): boolean {
    const r = this.sql.query("DELETE FROM chat_members WHERE chat_id = $c AND email = $e").run({ c: chatId, e: email });
    return r.changes > 0;
  }

  /** Everyone in the chat: the host first, then guests in the order they joined. */
  participants(chat: ChatRow): string[] {
    return [chat.owner_email, ...this.members(chat.id).map((m) => m.email)];
  }

  // ── sends ────────────────────────────────────────────────────────────

  sends(chatId: string): SendRow[] {
    return this.sql.query("SELECT * FROM sends WHERE chat_id = $c ORDER BY seq").all({ c: chatId }) as SendRow[];
  }

  /** Record that `email` sent the next user turn of the chat; returns its seq. */
  addSend(chatId: string, email: string): number {
    const row = this.sql.query("SELECT COALESCE(MAX(seq), 0) AS n FROM sends WHERE chat_id = $c").get({ c: chatId }) as { n: number };
    const seq = row.n + 1;
    this.sql.query("INSERT INTO sends (chat_id, seq, email, at) VALUES ($c, $seq, $e, $t)").run({ c: chatId, seq, e: email, t: now() });
    return seq;
  }
}
