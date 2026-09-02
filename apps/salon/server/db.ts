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
  onboarding_complete: 0 | 1;
  created_at: string;
  key_updated_at: string;
}

export interface WorkspaceMemberRow {
  owner_email: string;
  email: string;
  added_at: string;
}

export interface NotificationRow {
  id: string;
  user_email: string;
  chat_id: string;
  actor_email: string;
  kind: "mention";
  created_at: string;
  read_at: string | null;
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
  /** Set when the host archived it: the conversation was ended, the chat kept. */
  archived_at: string | null;
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
  /** `owner/name` when credentials come from the GitHub App; null for legacy/public projects. */
  github_repo: string | null;
  /** The project's own setup command, appended after Salon's. */
  setup: string;
  created_at: string;
}

export interface GitHubAccountRow {
  email: string;
  login: string;
  token_enc: string;
  refresh_token_enc: string | null;
  expires_at: string | null;
  refresh_expires_at: string | null;
  updated_at: string;
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
  ahead: number | null;
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
  /** The review surface this comment is attached to. Older rows are diff lines. */
  anchor_kind: "diff_line" | "plan_node" | "plan_field";
  plan_node_id: string | null;
  plan_field: string | null;
}

export interface PlanRow {
  id: string;
  chat_id: string;
  title: string;
  outcome: string;
  description: string;
  revision: number;
  status: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface PlanNodeRow {
  id: string;
  plan_id: string;
  outcome: string;
  description: string;
  acceptance_criteria: string;
  scope: string;
  status: string;
  position: number;
  field_revisions: string;
  created_at: string;
  updated_at: string;
}

export interface PlanEdgeRow {
  plan_id: string;
  from_node_id: string;
  to_node_id: string;
  created_at: string;
}

export interface PlanEventRow {
  id: string;
  plan_id: string;
  actor: string;
  kind: string;
  operation: string;
  before_revision: number;
  after_revision: number;
  created_at: string;
}

export interface PlanApprovalRow {
  id: string;
  plan_id: string;
  revision: number;
  actor: string;
  kind: "approve" | "support";
  valid: 0 | 1;
  invalidated_at: string | null;
  invalidated_by_event: string | null;
  created_at: string;
}

export interface PlanProposalRow {
  id: string;
  plan_id: string;
  base_revision: number;
  author: string;
  operations: string;
  status: "pending" | "applied" | "dismissed";
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

export interface PlanExecutionRow {
  id: string;
  plan_id: string;
  node_id: string;
  plan_revision: number;
  launched_by: string;
  conversation_id: string;
  submission_seq: number;
  turn_submission_seq: number;
  fountain_turn_id: string | null;
  turn_binding: "inferred";
  status: string;
  start_branch: string | null;
  start_head: string | null;
  start_changes_seq: number | null;
  end_branch: string | null;
  end_head: string | null;
  end_changes_seq: number | null;
  evidence_diff: string;
  evidence_truncated: 0 | 1;
  result_summary: string;
  error: string | null;
  exception_state: string;
  prompt: string;
  node_snapshot: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  model_claims: string;
}

export interface RoomNoteRow {
  id: string;
  chat_id: string;
  body: string;
  author: string;
  queued: 0 | 1;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  sent_at: string | null;
  sent_by: string | null;
}

export interface ControlActionRow {
  id: string;
  chat_id: string;
  actor: string;
  action: string;
  conversation_id: string;
  turn_id: string | null;
  request_id: string | null;
  option_id: string | null;
  outcome: string;
  winner: string | null;
  created_at: string;
}

export type Role = "owner" | "member";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY,
  fountain_id TEXT,
  key_enc TEXT NOT NULL,
  onboarding_complete INTEGER NOT NULL DEFAULT 0,
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
CREATE TABLE IF NOT EXISTS github_accounts (
  email TEXT PRIMARY KEY REFERENCES users(email) ON DELETE CASCADE,
  login TEXT NOT NULL,
  token_enc TEXT NOT NULL,
  refresh_token_enc TEXT,
  expires_at TEXT,
  refresh_expires_at TEXT,
  updated_at TEXT NOT NULL
);
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
  archived_at TEXT,
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
CREATE TABLE IF NOT EXISTS workspace_members (
  owner_email TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  email TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (owner_email, email)
);
CREATE INDEX IF NOT EXISTS workspace_members_email ON workspace_members(email);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_email TEXT NOT NULL,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  actor_email TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_email, created_at DESC);
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
  github_repo TEXT,
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
  sent_by TEXT,
  anchor_kind TEXT NOT NULL DEFAULT 'diff_line',
  plan_node_id TEXT,
  plan_field TEXT
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
  ahead INTEGER,
  source TEXT NOT NULL,
  reason TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (chat_id, seq)
);
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL UNIQUE REFERENCES chats(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'Plan',
  outcome TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plan_nodes (
  id TEXT NOT NULL,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  acceptance_criteria TEXT NOT NULL DEFAULT '[]',
  scope TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  position INTEGER NOT NULL,
  field_revisions TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (plan_id, id)
);
CREATE INDEX IF NOT EXISTS plan_nodes_plan ON plan_nodes(plan_id, position, id);
CREATE TABLE IF NOT EXISTS plan_edges (
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (plan_id, from_node_id, to_node_id),
  CHECK (from_node_id <> to_node_id),
  FOREIGN KEY (plan_id, from_node_id) REFERENCES plan_nodes(plan_id, id) ON DELETE CASCADE,
  FOREIGN KEY (plan_id, to_node_id) REFERENCES plan_nodes(plan_id, id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS plan_events (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  operation TEXT NOT NULL,
  before_revision INTEGER NOT NULL,
  after_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS plan_events_plan ON plan_events(plan_id, after_revision, created_at);
CREATE TABLE IF NOT EXISTS plan_approvals (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  valid INTEGER NOT NULL DEFAULT 1,
  invalidated_at TEXT,
  invalidated_by_event TEXT REFERENCES plan_events(id),
  created_at TEXT NOT NULL,
  UNIQUE(plan_id, revision, actor, kind)
);
CREATE INDEX IF NOT EXISTS plan_approvals_plan ON plan_approvals(plan_id, revision, valid);
CREATE TABLE IF NOT EXISTS plan_proposals (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  base_revision INTEGER NOT NULL,
  author TEXT NOT NULL,
  operations TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT
);
CREATE INDEX IF NOT EXISTS plan_proposals_plan ON plan_proposals(plan_id, created_at);
CREATE TABLE IF NOT EXISTS plan_executions (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  -- Deliberately not a node FK: the immutable node_snapshot and execution
  -- evidence must survive a later plan revision that removes this node id.
  node_id TEXT NOT NULL,
  plan_revision INTEGER NOT NULL,
  launched_by TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  submission_seq INTEGER NOT NULL,
  turn_submission_seq INTEGER NOT NULL,
  fountain_turn_id TEXT,
  turn_binding TEXT NOT NULL DEFAULT 'inferred',
  status TEXT NOT NULL,
  start_branch TEXT,
  start_head TEXT,
  start_changes_seq INTEGER,
  end_branch TEXT,
  end_head TEXT,
  end_changes_seq INTEGER,
  evidence_diff TEXT NOT NULL DEFAULT '',
  evidence_truncated INTEGER NOT NULL DEFAULT 0,
  result_summary TEXT NOT NULL DEFAULT '',
  error TEXT,
  exception_state TEXT NOT NULL DEFAULT 'none',
  prompt TEXT NOT NULL,
  node_snapshot TEXT NOT NULL DEFAULT '{}',
  model_claims TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(plan_id, submission_seq)
);
CREATE INDEX IF NOT EXISTS plan_executions_plan ON plan_executions(plan_id, created_at);
CREATE TABLE IF NOT EXISTS execution_criteria (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES plan_executions(id) ON DELETE CASCADE,
  criterion_index INTEGER NOT NULL,
  criterion TEXT NOT NULL,
  result TEXT NOT NULL DEFAULT 'unknown',
  deterministic_evidence TEXT NOT NULL DEFAULT '[]',
  model_claim TEXT,
  explanation TEXT NOT NULL DEFAULT '',
  UNIQUE(execution_id, criterion_index)
);
CREATE TABLE IF NOT EXISTS room_notes (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  queued INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  sent_at TEXT,
  sent_by TEXT
);
CREATE INDEX IF NOT EXISTS room_notes_chat ON room_notes(chat_id, created_at);
CREATE TABLE IF NOT EXISTS control_actions (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  turn_id TEXT,
  request_id TEXT,
  option_id TEXT,
  outcome TEXT NOT NULL,
  winner TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS control_actions_chat ON control_actions(chat_id, created_at);
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
    const users = new Set((this.sql.query("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name));
    // Existing accounts have already configured and used Salon, so do not
    // force them through a newly introduced first-run flow.
    if (!users.has("onboarding_complete")) this.sql.exec("ALTER TABLE users ADD COLUMN onboarding_complete INTEGER NOT NULL DEFAULT 1");
    const have = new Set((this.sql.query("PRAGMA table_info(chats)").all() as { name: string }[]).map((c) => c.name));
    if (!have.has("skills")) this.sql.exec("ALTER TABLE chats ADD COLUMN skills TEXT NOT NULL DEFAULT '[]'");
    if (!have.has("connectors")) this.sql.exec("ALTER TABLE chats ADD COLUMN connectors TEXT NOT NULL DEFAULT '[]'");
    if (!have.has("project_id")) this.sql.exec("ALTER TABLE chats ADD COLUMN project_id TEXT");
    if (!have.has("archived_at")) this.sql.exec("ALTER TABLE chats ADD COLUMN archived_at TEXT");
    const changes = new Set((this.sql.query("PRAGMA table_info(changes)").all() as { name: string }[]).map((c) => c.name));
    if (!changes.has("ahead")) this.sql.exec("ALTER TABLE changes ADD COLUMN ahead INTEGER");
    const projects = new Set((this.sql.query("PRAGMA table_info(projects)").all() as { name: string }[]).map((c) => c.name));
    if (!projects.has("github_repo")) this.sql.exec("ALTER TABLE projects ADD COLUMN github_repo TEXT");
    const comments = new Set((this.sql.query("PRAGMA table_info(comments)").all() as { name: string }[]).map((c) => c.name));
    if (!comments.has("anchor_kind")) this.sql.exec("ALTER TABLE comments ADD COLUMN anchor_kind TEXT NOT NULL DEFAULT 'diff_line'");
    if (!comments.has("plan_node_id")) this.sql.exec("ALTER TABLE comments ADD COLUMN plan_node_id TEXT");
    if (!comments.has("plan_field")) this.sql.exec("ALTER TABLE comments ADD COLUMN plan_field TEXT");
    const plans = new Set((this.sql.query("PRAGMA table_info(plans)").all() as { name: string }[]).map((c) => c.name));
    if (!plans.has("outcome")) this.sql.exec("ALTER TABLE plans ADD COLUMN outcome TEXT NOT NULL DEFAULT ''");
    if (!plans.has("description")) this.sql.exec("ALTER TABLE plans ADD COLUMN description TEXT NOT NULL DEFAULT ''");
    if (!plans.has("status")) this.sql.exec("ALTER TABLE plans ADD COLUMN status TEXT NOT NULL DEFAULT 'draft'");
    const executions = new Set((this.sql.query("PRAGMA table_info(plan_executions)").all() as { name: string }[]).map((c) => c.name));
    if (!executions.has("conversation_id")) this.sql.exec("ALTER TABLE plan_executions ADD COLUMN conversation_id TEXT NOT NULL DEFAULT ''");
    if (!executions.has("model_claims")) this.sql.exec("ALTER TABLE plan_executions ADD COLUMN model_claims TEXT NOT NULL DEFAULT '[]'");
    if (!executions.has("completed_at")) this.sql.exec("ALTER TABLE plan_executions ADD COLUMN completed_at TEXT");
    if (!executions.has("evidence_truncated")) this.sql.exec("ALTER TABLE plan_executions ADD COLUMN evidence_truncated INTEGER NOT NULL DEFAULT 0");
    if (!executions.has("turn_submission_seq")) this.sql.exec("ALTER TABLE plan_executions ADD COLUMN turn_submission_seq INTEGER NOT NULL DEFAULT 0");
    if (!executions.has("node_snapshot")) this.sql.exec("ALTER TABLE plan_executions ADD COLUMN node_snapshot TEXT NOT NULL DEFAULT '{}'");
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
        `INSERT INTO users (email, fountain_id, key_enc, onboarding_complete, created_at, key_updated_at) VALUES ($email, $fountain_id, $key_enc, 0, $t, $t)
         ON CONFLICT(email) DO UPDATE SET fountain_id = excluded.fountain_id, key_enc = excluded.key_enc, key_updated_at = excluded.key_updated_at`,
      )
      .run({ email, fountain_id: fountainId, key_enc: keyEnc, t });
    return this.getUser(email)!;
  }

  updateUserKey(email: string, fountainId: string | null, keyEnc: string): UserRow {
    this.sql.query("UPDATE users SET fountain_id = $fountain_id, key_enc = $key_enc, key_updated_at = $t WHERE email = $email").run({ email, fountain_id: fountainId, key_enc: keyEnc, t: now() });
    return this.getUser(email)!;
  }

  completeOnboarding(email: string): UserRow {
    this.sql.query("UPDATE users SET onboarding_complete = 1 WHERE email = $email").run({ email });
    return this.getUser(email)!;
  }

  // ── workspace ───────────────────────────────────────────────────────

  workspaceMembers(ownerEmail: string): WorkspaceMemberRow[] {
    return this.sql.query("SELECT * FROM workspace_members WHERE owner_email = $owner ORDER BY added_at, email").all({ owner: ownerEmail }) as WorkspaceMemberRow[];
  }

  addWorkspaceMember(ownerEmail: string, email: string): boolean {
    const r = this.sql.query("INSERT OR IGNORE INTO workspace_members (owner_email, email, added_at) VALUES ($owner, $email, $t)").run({ owner: ownerEmail, email, t: now() });
    return r.changes > 0;
  }

  removeWorkspaceMember(ownerEmail: string, email: string): boolean {
    const r = this.sql.query("DELETE FROM workspace_members WHERE owner_email = $owner AND email = $email").run({ owner: ownerEmail, email });
    return r.changes > 0;
  }

  // ── notifications ───────────────────────────────────────────────────

  notificationsFor(email: string): NotificationRow[] {
    return this.sql.query("SELECT * FROM notifications WHERE user_email = $email ORDER BY created_at DESC LIMIT 50").all({ email }) as NotificationRow[];
  }

  addMentionNotification(userEmail: string, chatId: string, actorEmail: string): NotificationRow {
    const row: NotificationRow = { id: crypto.randomUUID(), user_email: userEmail, chat_id: chatId, actor_email: actorEmail, kind: "mention", created_at: now(), read_at: null };
    this.sql.query(`INSERT INTO notifications (id, user_email, chat_id, actor_email, kind, created_at, read_at)
      VALUES ($id, $user_email, $chat_id, $actor_email, $kind, $created_at, $read_at)`).run(row as unknown as Record<string, string | null>);
    return row;
  }

  readNotification(id: string, email: string): boolean {
    const r = this.sql.query("UPDATE notifications SET read_at = COALESCE(read_at, $t) WHERE id = $id AND user_email = $email").run({ id, email, t: now() });
    return r.changes > 0;
  }

  githubAccount(email: string): GitHubAccountRow | null {
    return (this.sql.query("SELECT * FROM github_accounts WHERE email = $email").get({ email }) as GitHubAccountRow | null) ?? null;
  }

  putGitHubAccount(row: GitHubAccountRow): void {
    this.sql
      .query(
        `INSERT INTO github_accounts (email, login, token_enc, refresh_token_enc, expires_at, refresh_expires_at, updated_at)
         VALUES ($email, $login, $token_enc, $refresh_token_enc, $expires_at, $refresh_expires_at, $updated_at)
         ON CONFLICT(email) DO UPDATE SET login = excluded.login, token_enc = excluded.token_enc,
           refresh_token_enc = excluded.refresh_token_enc, expires_at = excluded.expires_at,
           refresh_expires_at = excluded.refresh_expires_at, updated_at = excluded.updated_at`,
      )
      .run(row as unknown as Record<string, string | null>);
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
        `INSERT INTO chats (id, owner_email, conversation_id, title, runtime, model, skills, connectors, preset_id, preset_name, environment_id, vault_id, agent_id, invite_token, project_id, archived_at, created_at)
         VALUES ($id, $owner_email, $conversation_id, $title, $runtime, $model, $skills, $connectors, $preset_id, $preset_name, $environment_id, $vault_id, $agent_id, $invite_token, $project_id, $archived_at, $created_at)`,
      )
      .run(c as unknown as Record<string, string | null>);
  }

  updateChat(id: string, patch: Partial<Pick<ChatRow, "title" | "invite_token" | "archived_at" | "conversation_id">>): void {
    const cur = this.getChat(id);
    if (!cur) return;
    const next = { ...cur, ...patch };
    this.sql
      .query("UPDATE chats SET title = $title, invite_token = $invite_token, archived_at = $archived_at, conversation_id = $conversation_id WHERE id = $id")
      .run({ id, title: next.title, invite_token: next.invite_token, archived_at: next.archived_at, conversation_id: next.conversation_id });
  }

  /** A restored chat starts a new conversation: its user turns count from one again. */
  clearSends(chatId: string): void {
    this.sql.query("DELETE FROM sends WHERE chat_id = $c").run({ c: chatId });
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
        `INSERT INTO projects (id, owner_email, name, repo_url, base, mount_path, environment_id, has_token, github_repo, setup, created_at)
         VALUES ($id, $owner_email, $name, $repo_url, $base, $mount_path, $environment_id, $has_token, $github_repo, $setup, $created_at)`,
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
        `INSERT INTO comments (id, chat_id, changes_seq, path, side, line, quote, body, author, created_at, resolved_at, resolved_by, sent_at, sent_by, anchor_kind, plan_node_id, plan_field)
         VALUES ($id, $chat_id, $changes_seq, $path, $side, $line, $quote, $body, $author, $created_at, $resolved_at, $resolved_by, $sent_at, $sent_by, $anchor_kind, $plan_node_id, $plan_field)`,
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
        `INSERT INTO changes (chat_id, seq, branch, head, base, status, files, diff, truncated, pr, ahead, source, reason, at)
         VALUES ($chat_id, $seq, $branch, $head, $base, $status, $files, $diff, $truncated, $pr, $ahead, $source, $reason, $at)`,
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
      .query("SELECT chat_id, seq, branch, head, base, status, files, '' AS diff, truncated, pr, ahead, source, reason, at FROM changes WHERE chat_id = $c ORDER BY seq DESC")
      .all({ c: chatId }) as ChangesRow[];
  }

  /** Keep the newest `keep` snapshots of a chat. */
  pruneChanges(chatId: string, keep: number): void {
    // Snapshots used as plan-execution boundaries are durable evidence and
    // survive the rolling room-history policy.
    this.sql
      .query(
        `DELETE FROM changes
         WHERE chat_id = $c
           AND seq <= (SELECT COALESCE(MAX(seq), 0) FROM changes WHERE chat_id = $c) - $keep
           AND seq NOT IN (
             SELECT start_changes_seq FROM plan_executions e JOIN plans p ON p.id = e.plan_id
             WHERE p.chat_id = $c AND start_changes_seq IS NOT NULL
             UNION
             SELECT end_changes_seq FROM plan_executions e JOIN plans p ON p.id = e.plan_id
             WHERE p.chat_id = $c AND end_changes_seq IS NOT NULL
           )`,
      )
      .run({ c: chatId, keep });
  }
}
