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
  /** The project the chat was started in (shared/projects.ts), or null. */
  project_id: string | null;
  created_at: string;
}

/** A repository a chat's computer starts with: an Environment on the owner's Fountain. */
export interface ProjectRow {
  id: string;
  owner_email: string;
  name: string;
  repo_url: string;
  base: string;
  mount_path: string;
  environment_id: string;
  has_token: 0 | 1;
  /** The project's own setup command, appended after Salon's. */
  setup: string;
  created_at: string;
}

export interface ProjectMemberRow {
  project_id: string;
  email: string;
  added_by: string;
  added_at: string;
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

/** A game two people in the chat are playing, or have played (shared/games.ts). */
export interface GameRow {
  id: string;
  chat_id: string;
  kind: string;
  /** JSON: emails in mark order. */
  players: string;
  /** JSON: the board and whose move it is. */
  state: string;
  status: "playing" | "done";
  winner_email: string | null;
  seq: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** One snapshot of the repository in a chat's computer (shared/changes.ts). */
export interface ChangesRow {
  chat_id: string;
  seq: number;
  branch: string;
  head: string;
  base: string;
  status: string;
  /** JSON: `FileSummary[]`. */
  files: string;
  diff: string;
  truncated: 0 | 1;
  /** JSON: `PullRequest`, or null. */
  pr: string | null;
  source: string;
  reason: string;
  at: string;
}

/** A review comment on a line of the chat's changes (shared/comments.ts). */
export interface CommentRow {
  id: string;
  chat_id: string;
  changes_seq: number;
  path: string;
  side: string;
  line: number;
  quote: string;
  body: string;
  author: string;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  sent_at: string | null;
  sent_by: string | null;
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
  project_id TEXT,
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
CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  players TEXT NOT NULL,
  state TEXT NOT NULL,
  status TEXT NOT NULL,
  winner_email TEXT,
  seq INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS games_chat ON games(chat_id, created_at);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  name TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  base TEXT NOT NULL,
  mount_path TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  has_token INTEGER NOT NULL DEFAULT 0,
  setup TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS projects_owner ON projects(owner_email);
CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (project_id, email)
);
CREATE INDEX IF NOT EXISTS project_members_email ON project_members(email);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  changes_seq INTEGER NOT NULL,
  path TEXT NOT NULL,
  side TEXT NOT NULL,
  line INTEGER NOT NULL,
  quote TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  sent_at TEXT,
  sent_by TEXT
);
CREATE INDEX IF NOT EXISTS comments_chat ON comments(chat_id, created_at);
CREATE TABLE IF NOT EXISTS changes (
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  branch TEXT NOT NULL,
  head TEXT NOT NULL,
  base TEXT NOT NULL,
  status TEXT NOT NULL,
  files TEXT NOT NULL,
  diff TEXT NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  pr TEXT,
  source TEXT NOT NULL,
  reason TEXT NOT NULL,
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
    if (!have.has("project_id")) this.sql.exec("ALTER TABLE chats ADD COLUMN project_id TEXT");
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
        `INSERT INTO chats (id, owner_email, conversation_id, title, runtime, model, skills, connectors, preset_id, preset_name, environment_id, vault_id, agent_id, invite_token, project_id, created_at)
         VALUES ($id, $owner_email, $conversation_id, $title, $runtime, $model, $skills, $connectors, $preset_id, $preset_name, $environment_id, $vault_id, $agent_id, $invite_token, $project_id, $created_at)`,
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

  /** The chat a conversation is bound to — how the model's MCP calls find their room. */
  chatByConversation(conversationId: string): ChatRow | null {
    return (this.sql.query("SELECT * FROM chats WHERE conversation_id = $c").get({ c: conversationId }) as ChatRow | null) ?? null;
  }

  chatByInvite(token: string): ChatRow | null {
    return (this.sql.query("SELECT * FROM chats WHERE invite_token = $t").get({ t: token }) as ChatRow | null) ?? null;
  }

  /** The chats started in a project, oldest first. */
  chatsInProject(projectId: string): ChatRow[] {
    return this.sql.query("SELECT * FROM chats WHERE project_id = $p ORDER BY created_at, id").all({ p: projectId }) as ChatRow[];
  }

  /** Forget which project chats were in, when the project goes; the chats stay. */
  detachChatsFromProject(projectId: string): void {
    this.sql.query("UPDATE chats SET project_id = NULL WHERE project_id = $p").run({ p: projectId });
  }

  // ── projects ─────────────────────────────────────────────────────────

  getProject(id: string): ProjectRow | null {
    return (this.sql.query("SELECT * FROM projects WHERE id = $id").get({ id }) as ProjectRow | null) ?? null;
  }

  /** Projects the user owns or is in, newest first. */
  projectsFor(email: string): ProjectRow[] {
    return this.sql
      .query(
        `SELECT p.* FROM projects p
         WHERE p.owner_email = $email OR p.id IN (SELECT project_id FROM project_members WHERE email = $email)
         ORDER BY p.created_at DESC, p.id`,
      )
      .all({ email }) as ProjectRow[];
  }

  projectRoleIn(projectId: string, email: string): Role | null {
    const p = this.getProject(projectId);
    if (!p) return null;
    if (p.owner_email === email) return "owner";
    const m = this.sql.query("SELECT 1 FROM project_members WHERE project_id = $p AND email = $e").get({ p: projectId, e: email });
    return m ? "member" : null;
  }

  insertProject(p: ProjectRow): void {
    this.sql
      .query(
        `INSERT INTO projects (id, owner_email, name, repo_url, base, mount_path, environment_id, has_token, setup, created_at)
         VALUES ($id, $owner_email, $name, $repo_url, $base, $mount_path, $environment_id, $has_token, $setup, $created_at)`,
      )
      .run(p as unknown as Record<string, string | number>);
  }

  deleteProject(id: string): void {
    this.sql.query("DELETE FROM projects WHERE id = $id").run({ id });
  }

  projectMembers(projectId: string): ProjectMemberRow[] {
    return this.sql.query("SELECT * FROM project_members WHERE project_id = $p ORDER BY added_at, email").all({ p: projectId }) as ProjectMemberRow[];
  }

  addProjectMember(projectId: string, email: string, addedBy: string): boolean {
    const r = this.sql
      .query("INSERT OR IGNORE INTO project_members (project_id, email, added_by, added_at) VALUES ($p, $e, $by, $t)")
      .run({ p: projectId, e: email, by: addedBy, t: now() });
    return r.changes > 0;
  }

  removeProjectMember(projectId: string, email: string): boolean {
    const r = this.sql.query("DELETE FROM project_members WHERE project_id = $p AND email = $e").run({ p: projectId, e: email });
    return r.changes > 0;
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

  // ── games ────────────────────────────────────────────────────────────

  games(chatId: string): GameRow[] {
    return this.sql.query("SELECT * FROM games WHERE chat_id = $c ORDER BY created_at, id").all({ c: chatId }) as GameRow[];
  }

  getGame(id: string): GameRow | null {
    return (this.sql.query("SELECT * FROM games WHERE id = $id").get({ id }) as GameRow | null) ?? null;
  }

  insertGame(g: GameRow): void {
    this.sql
      .query(
        `INSERT INTO games (id, chat_id, kind, players, state, status, winner_email, seq, created_by, created_at, updated_at)
         VALUES ($id, $chat_id, $kind, $players, $state, $status, $winner_email, $seq, $created_by, $created_at, $updated_at)`,
      )
      .run(g as unknown as Record<string, string | number | null>);
  }

  /** A move: the new state, and the seq bumped so a browser can tell newer from older. */
  updateGame(id: string, patch: Pick<GameRow, "state" | "status" | "winner_email">): GameRow | null {
    this.sql
      .query("UPDATE games SET state = $state, status = $status, winner_email = $winner_email, seq = seq + 1, updated_at = $t WHERE id = $id")
      .run({ id, state: patch.state, status: patch.status, winner_email: patch.winner_email, t: now() });
    return this.getGame(id);
  }

  // ── comments ─────────────────────────────────────────────────────────

  comments(chatId: string): CommentRow[] {
    return this.sql.query("SELECT * FROM comments WHERE chat_id = $c ORDER BY rowid").all({ c: chatId }) as CommentRow[];
  }

  getComment(id: string): CommentRow | null {
    return (this.sql.query("SELECT * FROM comments WHERE id = $id").get({ id }) as CommentRow | null) ?? null;
  }

  insertComment(c: CommentRow): void {
    this.sql
      .query(
        `INSERT INTO comments (id, chat_id, changes_seq, path, side, line, quote, body, author, created_at, resolved_at, resolved_by, sent_at, sent_by)
         VALUES ($id, $chat_id, $changes_seq, $path, $side, $line, $quote, $body, $author, $created_at, $resolved_at, $resolved_by, $sent_at, $sent_by)`,
      )
      .run(c as unknown as Record<string, string | number | null>);
  }

  updateComment(id: string, patch: Partial<Pick<CommentRow, "resolved_at" | "resolved_by" | "sent_at" | "sent_by">>): CommentRow | null {
    const cur = this.getComment(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    this.sql
      .query("UPDATE comments SET resolved_at = $resolved_at, resolved_by = $resolved_by, sent_at = $sent_at, sent_by = $sent_by WHERE id = $id")
      .run({ id, resolved_at: next.resolved_at, resolved_by: next.resolved_by, sent_at: next.sent_at, sent_by: next.sent_by });
    return this.getComment(id);
  }

  deleteComment(id: string): void {
    this.sql.query("DELETE FROM comments WHERE id = $id").run({ id });
  }

  // ── changes ──────────────────────────────────────────────────────────

  /** The next snapshot of the chat's repository; returns it with its seq. */
  insertChanges(c: Omit<ChangesRow, "seq">): ChangesRow {
    const row = this.sql.query("SELECT COALESCE(MAX(seq), 0) AS n FROM changes WHERE chat_id = $c").get({ c: c.chat_id }) as { n: number };
    const seq = row.n + 1;
    this.sql
      .query(
        `INSERT INTO changes (chat_id, seq, branch, head, base, status, files, diff, truncated, pr, source, reason, at)
         VALUES ($chat_id, $seq, $branch, $head, $base, $status, $files, $diff, $truncated, $pr, $source, $reason, $at)`,
      )
      .run({ ...c, seq } as unknown as Record<string, string | number | null>);
    return { ...c, seq };
  }

  latestChanges(chatId: string): ChangesRow | null {
    return (this.sql.query("SELECT * FROM changes WHERE chat_id = $c ORDER BY seq DESC LIMIT 1").get({ c: chatId }) as ChangesRow | null) ?? null;
  }

  getChanges(chatId: string, seq: number): ChangesRow | null {
    return (this.sql.query("SELECT * FROM changes WHERE chat_id = $c AND seq = $s").get({ c: chatId, s: seq }) as ChangesRow | null) ?? null;
  }

  /** Every snapshot kept, newest first, without the diffs. */
  changesHistory(chatId: string): ChangesRow[] {
    return this.sql
      .query("SELECT chat_id, seq, branch, head, base, status, files, '' AS diff, truncated, pr, source, reason, at FROM changes WHERE chat_id = $c ORDER BY seq DESC")
      .all({ c: chatId }) as ChangesRow[];
  }

  /** Keep the newest `keep` snapshots of a chat. */
  pruneChanges(chatId: string, keep: number): void {
    this.sql.query("DELETE FROM changes WHERE chat_id = $c AND seq <= (SELECT COALESCE(MAX(seq), 0) FROM changes WHERE chat_id = $c) - $keep").run({ c: chatId, keep });
  }
}
