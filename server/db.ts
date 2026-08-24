/**
 * The workbench's own records, in SQLite (`bun:sqlite`): who has signed in
 * (and the Fountain key each one's projects run on), sessions, projects with
 * their owner and members, and work items.
 *
 * Fountain has no project or work-item primitive; this is the state that
 * used to live in one browser's localStorage, now in one place so a project
 * can be shared. Conversations themselves stay on Fountain — a project's
 * conversations are the ones whose `channel_id` starts with
 * `workbench:<project>/`, under the owner's key.
 */
import { Database } from "bun:sqlite";
import { emptyCounts, parseItemStatus, type ItemCounts, type ItemStatus } from "../shared/status";

export interface UserRow {
  email: string;
  fountain_id: string | null;
  key_enc: string;
  created_at: string;
  key_updated_at: string;
}

export interface ProjectRow {
  id: string;
  owner_email: string;
  name: string;
  notes: string;
  environment_id: string | null;
  vault_id: string | null;
  created_at: string;
}

export interface MemberRow {
  project_id: string;
  email: string;
  added_by: string;
  added_at: string;
}

export interface ItemRow {
  id: string;
  project_id: string;
  title: string;
  notes: string;
  status: ItemStatus;
  agent_ids: string; // JSON array
  created_at: string;
  /** A verdict an agent proposed but nobody has acted on: '' | 'done' | 'wont' (shared/status.ts). */
  proposed_status: string;
  /** Who proposed it: the agent, when it came from inside a conversation, and the account whose key it was. */
  proposed_agent_id: string;
  proposed_email: string;
  proposed_at: string;
}

/** The proposal fields of an item nobody has proposed anything on — a new item, or one just decided. */
export const NO_PROPOSAL: Pick<ItemRow, "proposed_status" | "proposed_agent_id" | "proposed_email" | "proposed_at"> = {
  proposed_status: "",
  proposed_agent_id: "",
  proposed_email: "",
  proposed_at: "",
};

export type Role = "owner" | "member";

/** What an update to a work item may set. Its id, project and creation stand. */
export type ItemPatch = Partial<Omit<ItemRow, "id" | "project_id" | "created_at">>;

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
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  name TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  environment_id TEXT,
  vault_id TEXT,
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
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  -- open | done | wont; free text, so a new state needs no migration and an
  -- old row written by an older build still reads (shared/status.ts).
  status TEXT NOT NULL DEFAULT 'open',
  agent_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  -- '' | done | wont: what an agent says should happen to this item, which is
  -- not the same as it happening. Nothing is retired for a proposal.
  proposed_status TEXT NOT NULL DEFAULT '',
  proposed_agent_id TEXT NOT NULL DEFAULT '',
  proposed_email TEXT NOT NULL DEFAULT '',
  proposed_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS items_project ON items(project_id);
`;

/**
 * Columns added to `items` after the table existed. `CREATE TABLE IF NOT
 * EXISTS` leaves a table that is already there alone, so a database written
 * by an older build needs them added; the defaults make an old row a row
 * nobody has proposed anything on.
 */
const ADDED_ITEM_COLUMNS: [string, string][] = [
  ["proposed_status", "TEXT NOT NULL DEFAULT ''"],
  ["proposed_agent_id", "TEXT NOT NULL DEFAULT ''"],
  ["proposed_email", "TEXT NOT NULL DEFAULT ''"],
  ["proposed_at", "TEXT NOT NULL DEFAULT ''"],
];

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

  /** Bring a database written by an older build up to the schema above. */
  private migrate(): void {
    const have = new Set((this.sql.query("PRAGMA table_info(items)").all() as { name: string }[]).map((c) => c.name));
    for (const [name, decl] of ADDED_ITEM_COLUMNS) {
      if (!have.has(name)) this.sql.exec(`ALTER TABLE items ADD COLUMN ${name} ${decl}`);
    }
  }

  close(): void {
    this.sql.close();
  }

  // ── users ────────────────────────────────────────────────────────────

  getUser(email: string): UserRow | null {
    return (this.sql.query("SELECT * FROM users WHERE email = $email").get({ email }) as UserRow | null) ?? null;
  }

  /** Create or refresh a user: every sign-in replaces the key their projects run on. */
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

  /** The user a session belongs to, touching `last_seen_at`. */
  sessionUser(tokenHash: string): UserRow | null {
    const row = this.sql.query("SELECT email FROM sessions WHERE token_hash = $h").get({ h: tokenHash }) as { email: string } | null;
    if (!row) return null;
    this.sql.query("UPDATE sessions SET last_seen_at = $t WHERE token_hash = $h").run({ t: now(), h: tokenHash });
    return this.getUser(row.email);
  }

  deleteSession(tokenHash: string): void {
    this.sql.query("DELETE FROM sessions WHERE token_hash = $h").run({ h: tokenHash });
  }

  /** Sessions older than `maxAgeMs` are gone. */
  expireSessions(maxAgeMs: number): void {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    this.sql.query("DELETE FROM sessions WHERE last_seen_at < $cutoff").run({ cutoff });
  }

  // ── projects ─────────────────────────────────────────────────────────

  getProject(id: string): ProjectRow | null {
    return (this.sql.query("SELECT * FROM projects WHERE id = $id").get({ id }) as ProjectRow | null) ?? null;
  }

  /** Projects the user owns or is a member of, oldest first. */
  projectsFor(email: string): ProjectRow[] {
    return this.sql
      .query(
        `SELECT p.* FROM projects p
         WHERE p.owner_email = $email OR p.id IN (SELECT project_id FROM project_members WHERE email = $email)
         ORDER BY p.created_at, p.id`,
      )
      .all({ email }) as ProjectRow[];
  }

  /** Owner or member, or null when the user has no business with the project. */
  roleIn(projectId: string, email: string): Role | null {
    const p = this.getProject(projectId);
    if (!p) return null;
    if (p.owner_email === email) return "owner";
    const m = this.sql.query("SELECT 1 FROM project_members WHERE project_id = $p AND email = $e").get({ p: projectId, e: email });
    return m ? "member" : null;
  }

  insertProject(p: ProjectRow): boolean {
    const r = this.sql
      .query(
        `INSERT OR IGNORE INTO projects (id, owner_email, name, notes, environment_id, vault_id, created_at)
         VALUES ($id, $owner_email, $name, $notes, $environment_id, $vault_id, $created_at)`,
      )
      .run(p as unknown as Record<string, string | null>);
    return r.changes > 0;
  }

  updateProject(id: string, patch: Partial<Pick<ProjectRow, "name" | "notes" | "environment_id" | "vault_id">>): void {
    const cur = this.getProject(id);
    if (!cur) return;
    const next = { ...cur, ...patch };
    this.sql
      .query("UPDATE projects SET name = $name, notes = $notes, environment_id = $environment_id, vault_id = $vault_id WHERE id = $id")
      .run({ id, name: next.name, notes: next.notes, environment_id: next.environment_id, vault_id: next.vault_id });
  }

  deleteProject(id: string): void {
    this.sql.query("DELETE FROM projects WHERE id = $id").run({ id });
  }

  // ── members ──────────────────────────────────────────────────────────

  members(projectId: string): MemberRow[] {
    return this.sql.query("SELECT * FROM project_members WHERE project_id = $p ORDER BY added_at, email").all({ p: projectId }) as MemberRow[];
  }

  addMember(projectId: string, email: string, addedBy: string): boolean {
    const r = this.sql
      .query("INSERT OR IGNORE INTO project_members (project_id, email, added_by, added_at) VALUES ($p, $e, $by, $t)")
      .run({ p: projectId, e: email, by: addedBy, t: now() });
    return r.changes > 0;
  }

  removeMember(projectId: string, email: string): boolean {
    const r = this.sql.query("DELETE FROM project_members WHERE project_id = $p AND email = $e").run({ p: projectId, e: email });
    return r.changes > 0;
  }

  // ── items ────────────────────────────────────────────────────────────

  items(projectId: string): ItemRow[] {
    return this.sql.query("SELECT * FROM items WHERE project_id = $p ORDER BY created_at, id").all({ p: projectId }) as ItemRow[];
  }

  getItem(id: string): ItemRow | null {
    return (this.sql.query("SELECT * FROM items WHERE id = $id").get({ id }) as ItemRow | null) ?? null;
  }

  insertItem(w: ItemRow): boolean {
    const r = this.sql
      .query(
        `INSERT OR IGNORE INTO items (id, project_id, title, notes, status, agent_ids, created_at, proposed_status, proposed_agent_id, proposed_email, proposed_at)
         VALUES ($id, $project_id, $title, $notes, $status, $agent_ids, $created_at, $proposed_status, $proposed_agent_id, $proposed_email, $proposed_at)`,
      )
      .run(w as unknown as Record<string, string>);
    return r.changes > 0;
  }

  updateItem(id: string, patch: ItemPatch): void {
    const cur = this.getItem(id);
    if (!cur) return;
    const next = { ...cur, ...patch };
    this.sql
      .query(
        `UPDATE items SET title = $title, notes = $notes, status = $status, agent_ids = $agent_ids,
           proposed_status = $proposed_status, proposed_agent_id = $proposed_agent_id, proposed_email = $proposed_email, proposed_at = $proposed_at
         WHERE id = $id`,
      )
      .run({
        id,
        title: next.title,
        notes: next.notes,
        status: next.status,
        agent_ids: next.agent_ids,
        proposed_status: next.proposed_status,
        proposed_agent_id: next.proposed_agent_id,
        proposed_email: next.proposed_email,
        proposed_at: next.proposed_at,
      });
  }

  deleteItem(id: string): void {
    this.sql.query("DELETE FROM items WHERE id = $id").run({ id });
  }

  /** Item counts per project for a user's list, in one query. */
  itemCounts(projectIds: string[]): Map<string, ItemCounts> {
    const out = new Map<string, ItemCounts>();
    if (projectIds.length === 0) return out;
    const rows = this.sql
      .query(`SELECT project_id, status, COUNT(*) AS n FROM items WHERE project_id IN (${projectIds.map(() => "?").join(",")}) GROUP BY project_id, status`)
      .all(...projectIds) as { project_id: string; status: string; n: number }[];
    for (const r of rows) {
      const c = out.get(r.project_id) ?? emptyCounts();
      c[parseItemStatus(r.status)] += r.n;
      out.set(r.project_id, c);
    }
    return out;
  }
}

export function parseAgentIds(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
