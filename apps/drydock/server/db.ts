/**
 * What drydock remembers.
 *
 * Deliberately small, and the reason is the same one paddock gives: Fountain
 * already knows most of this, and two records of one fact drift. So the rule
 * here is that **Fountain owns the truth about machines and conversations, and
 * this database owns the truth about people**.
 *
 *   - who signed in, and their GitHub installation — Fountain has no idea
 *   - which project is which — a row, because a project's name and its repo
 *     are drydock's ideas rather than Fountain's
 *   - which thread is which — a row, because a `channel_id` can say the slug
 *     but not who made it, from what, or what it is called
 *
 * Everything else is read live: a thread's status, its turn count, whether its
 * machine is up, what is on the disk. Those are questions with a correct answer
 * somewhere else, and caching them here is how a UI ends up confidently showing
 * a machine that died an hour ago.
 *
 * The one exception is `threads.sandbox_id`, and it is worth saying why it is
 * not a violation. A thread's machine is *ephemeral*: Fountain built it for
 * that conversation and will reclaim it, and while it lives the conversation
 * names it. So this column is a cache of a fact Fountain owns — written when
 * the conversation first reports a sandbox, and only ever used to save a round
 * trip on the read-side routes. Nothing decides anything from it that it would
 * not decide the same way from Fountain, which is the test a cache has to pass.
 */
import { Database } from "bun:sqlite";
import type { ThreadOrigin } from "../shared/api";

export interface UserRow {
  id: string;
  githubId: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  /** The user's OAuth token, encrypted. Refreshed on each sign-in. */
  tokenEnc: string | null;
  createdAt: string;
  lastSeenAt: string;
}

export interface ProjectRow {
  id: string;
  userId: string;
  name: string;
  repoFullName: string | null;
  repoPrivate: number;
  defaultBranch: string | null;
  installationId: number | null;
  agentId: string;
  environmentId: string;
  vaultId: string | null;
  runtime: string;
  model: string;
  rev: number;
  instructions: string;
  createdAt: string;
  archivedAt: string | null;
}

export interface ThreadRow {
  id: string;
  projectId: string;
  conversationId: string | null;
  /** The ephemeral machine this thread's conversation was given. */
  sandboxId: string | null;
  slug: string;
  title: string;
  branch: string | null;
  workdir: string;
  originKind: string;
  originBase: string | null;
  originNumber: number | null;
  originTitle: string | null;
  originUrl: string | null;
  /** The project rev this thread opened at. A lower one means older settings. */
  rev: number;
  /** What somebody typed before the machine existed. Sent, then cleared. */
  queuedPrompt: string | null;
  openedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  createdByLogin: string;
}

export interface RunCommandRow {
  id: string;
  projectId: string;
  label: string;
  command: string;
  position: number;
}

export class Db {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY,
        github_id     TEXT NOT NULL UNIQUE,
        login         TEXT NOT NULL,
        name          TEXT,
        avatar_url    TEXT,
        token_enc     TEXT,
        created_at    TEXT NOT NULL,
        last_seen_at  TEXT NOT NULL
      );

      -- Sessions are stored as hashes, never as the token itself: a copy of
      -- this file is then not a set of live sessions.
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash  TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at  TEXT NOT NULL,
        expires_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

      -- The three Fountain ids are the project. They are written once, at
      -- creation, and never updated — the sandbox is built from them, so a
      -- row that changed one would be a row pointing at a different machine.
      CREATE TABLE IF NOT EXISTS projects (
        id              TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name            TEXT NOT NULL,
        repo_full_name  TEXT,
        repo_private    INTEGER NOT NULL DEFAULT 0,
        default_branch  TEXT,
        installation_id INTEGER,
        agent_id        TEXT NOT NULL,
        environment_id  TEXT NOT NULL,
        vault_id        TEXT,
        runtime         TEXT NOT NULL,
        model           TEXT NOT NULL,
        rev             INTEGER NOT NULL DEFAULT 1,
        instructions    TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL,
        archived_at     TEXT
      );
      CREATE INDEX IF NOT EXISTS projects_user ON projects(user_id, archived_at);

      CREATE TABLE IF NOT EXISTS threads (
        id               TEXT PRIMARY KEY,
        project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        conversation_id  TEXT,
        sandbox_id       TEXT,
        slug             TEXT NOT NULL,
        title            TEXT NOT NULL,
        branch           TEXT,
        workdir          TEXT NOT NULL,
        origin_kind      TEXT NOT NULL,
        origin_base      TEXT,
        origin_number    INTEGER,
        origin_title     TEXT,
        origin_url       TEXT,
        rev              INTEGER NOT NULL DEFAULT 1,
        -- The prompt somebody typed on the New thread screen, held until the
        -- opening turn finishes. Cleared when it is sent. Without this the
        -- first thing a person says to a thread is lost to a race with the
        -- machine still being built.
        queued_prompt    TEXT,
        opened_at        TEXT,
        closed_at        TEXT,
        created_at       TEXT NOT NULL,
        created_by_login TEXT NOT NULL
      );
      -- One live thread per slug per project: the slug is the tail of a git
      -- branch, so two of them is not a naming clash, it is two machines
      -- pushing to one ref.
      CREATE UNIQUE INDEX IF NOT EXISTS threads_slug ON threads(project_id, slug) WHERE closed_at IS NULL;
      CREATE INDEX IF NOT EXISTS threads_project ON threads(project_id, closed_at);
      CREATE INDEX IF NOT EXISTS threads_conversation ON threads(conversation_id);

      -- The Run tab's saved commands. A project's, not a thread's: "how this
      -- project is built" is the same sentence on every machine it ever makes,
      -- and re-typing it per thread is the thing the tab exists to stop.
      CREATE TABLE IF NOT EXISTS run_commands (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        label       TEXT NOT NULL,
        command     TEXT NOT NULL,
        position    INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS run_commands_project ON run_commands(project_id, position);

      -- Short-lived state for the two GitHub round trips. Rows are deleted on
      -- use and swept on age, so a replayed callback finds nothing.
      CREATE TABLE IF NOT EXISTS oauth_states (
        state       TEXT PRIMARY KEY,
        kind        TEXT NOT NULL,
        redirect    TEXT,
        created_at  TEXT NOT NULL
      );
    `);
  }

  // ── users and sessions ───────────────────────────────────────────────

  upsertUser(input: { githubId: string; login: string; name: string | null; avatarUrl: string | null; tokenEnc: string }): UserRow {
    const now = new Date().toISOString();
    const existing = this.db
      .query<{ id: string }, [string]>("SELECT id FROM users WHERE github_id = ?")
      .get(input.githubId);
    if (existing) {
      this.db.run("UPDATE users SET login = ?, name = ?, avatar_url = ?, token_enc = ?, last_seen_at = ? WHERE id = ?", [
        input.login,
        input.name,
        input.avatarUrl,
        input.tokenEnc,
        now,
        existing.id,
      ]);
      return this.user(existing.id)!;
    }
    const id = crypto.randomUUID();
    this.db.run(
      "INSERT INTO users (id, github_id, login, name, avatar_url, token_enc, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [id, input.githubId, input.login, input.name, input.avatarUrl, input.tokenEnc, now, now],
    );
    return this.user(id)!;
  }

  user(id: string): UserRow | null {
    const r = this.db.query<RawUser, [string]>("SELECT * FROM users WHERE id = ?").get(id);
    return r ? toUser(r) : null;
  }

  createSession(userId: string, tokenHash: string, maxAgeMs: number): void {
    const now = Date.now();
    this.db.run("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)", [
      tokenHash,
      userId,
      new Date(now).toISOString(),
      new Date(now + maxAgeMs).toISOString(),
    ]);
  }

  sessionUser(tokenHash: string): UserRow | null {
    const row = this.db
      .query<{ user_id: string; expires_at: string }, [string]>("SELECT user_id, expires_at FROM sessions WHERE token_hash = ?")
      .get(tokenHash);
    if (!row) return null;
    if (Date.parse(row.expires_at) <= Date.now()) {
      this.db.run("DELETE FROM sessions WHERE token_hash = ?", [tokenHash]);
      return null;
    }
    return this.user(row.user_id);
  }

  endSession(tokenHash: string): void {
    this.db.run("DELETE FROM sessions WHERE token_hash = ?", [tokenHash]);
  }

  // ── the two GitHub round trips ───────────────────────────────────────

  putState(state: string, kind: string, redirect: string | null): void {
    this.db.run("DELETE FROM oauth_states WHERE created_at < ?", [new Date(Date.now() - 15 * 60_000).toISOString()]);
    this.db.run("INSERT OR REPLACE INTO oauth_states (state, kind, redirect, created_at) VALUES (?, ?, ?, ?)", [
      state,
      kind,
      redirect,
      new Date().toISOString(),
    ]);
  }

  /** Takes the state — one use only, which is what makes a replayed callback fail. */
  takeState(state: string): { kind: string; redirect: string | null } | null {
    const row = this.db
      .query<{ kind: string; redirect: string | null; created_at: string }, [string]>(
        "SELECT kind, redirect, created_at FROM oauth_states WHERE state = ?",
      )
      .get(state);
    if (!row) return null;
    this.db.run("DELETE FROM oauth_states WHERE state = ?", [state]);
    if (Date.parse(row.created_at) < Date.now() - 15 * 60_000) return null;
    return { kind: row.kind, redirect: row.redirect };
  }

  // ── projects ─────────────────────────────────────────────────────────

  createProject(p: Omit<ProjectRow, "createdAt" | "archivedAt" | "rev">): ProjectRow {
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO projects (id, user_id, name, repo_full_name, repo_private, default_branch, installation_id,
        agent_id, environment_id, vault_id, runtime, model, rev, instructions, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [
        p.id,
        p.userId,
        p.name,
        p.repoFullName,
        p.repoPrivate,
        p.defaultBranch,
        p.installationId,
        p.agentId,
        p.environmentId,
        p.vaultId,
        p.runtime,
        p.model,
        p.instructions,
        now,
      ],
    );
    return this.project(p.id)!;
  }

  project(id: string): ProjectRow | null {
    const r = this.db.query<RawProject, [string]>("SELECT * FROM projects WHERE id = ?").get(id);
    return r ? toProject(r) : null;
  }

  projectsOf(userId: string): ProjectRow[] {
    return this.db
      .query<RawProject, [string]>("SELECT * FROM projects WHERE user_id = ? AND archived_at IS NULL ORDER BY created_at")
      .all(userId)
      .map(toProject);
  }

  renameProject(id: string, name: string): void {
    this.db.run("UPDATE projects SET name = ? WHERE id = ?", [name, id]);
  }

  setInstructions(id: string, instructions: string): void {
    this.db.run("UPDATE projects SET instructions = ? WHERE id = ?", [instructions, id]);
  }

  setModel(id: string, model: string): void {
    this.db.run("UPDATE projects SET model = ? WHERE id = ?", [model, id]);
  }

  /**
   * Bump the settings revision, and return the new one.
   *
   * Called whenever something Fountain injects at session start changes — a
   * secret, an MCP server, a skill, the system prompt. Threads already open
   * carry the old number in their `channel_id` and are badged as running older
   * settings, which is true and cannot be worked out any other way.
   */
  bumpRev(id: string): number {
    this.db.run("UPDATE projects SET rev = rev + 1 WHERE id = ?", [id]);
    return this.db.query<{ rev: number }, [string]>("SELECT rev FROM projects WHERE id = ?").get(id)?.rev ?? 1;
  }

  archiveProject(id: string): void {
    this.db.run("UPDATE projects SET archived_at = ? WHERE id = ?", [new Date().toISOString(), id]);
  }

  // ── threads ───────────────────────────────────────────────────────────

  createThread(t: Omit<ThreadRow, "createdAt" | "openedAt" | "closedAt">): ThreadRow {
    this.db.run(
      `INSERT INTO threads (id, project_id, conversation_id, sandbox_id, slug, title, branch, workdir,
        origin_kind, origin_base, origin_number, origin_title, origin_url, rev, queued_prompt,
        created_at, created_by_login)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        t.id,
        t.projectId,
        t.conversationId,
        t.sandboxId,
        t.slug,
        t.title,
        t.branch,
        t.workdir,
        t.originKind,
        t.originBase,
        t.originNumber,
        t.originTitle,
        t.originUrl,
        t.rev,
        t.queuedPrompt,
        new Date().toISOString(),
        t.createdByLogin,
      ],
    );
    return this.thread(t.id)!;
  }

  thread(id: string): ThreadRow | null {
    const r = this.db.query<RawThread, [string]>("SELECT * FROM threads WHERE id = ?").get(id);
    return r ? toThread(r) : null;
  }

  threadByConversation(conversationId: string): ThreadRow | null {
    const r = this.db.query<RawThread, [string]>("SELECT * FROM threads WHERE conversation_id = ?").get(conversationId);
    return r ? toThread(r) : null;
  }

  threadsOf(projectId: string, includeClosed = false): ThreadRow[] {
    const sql = includeClosed
      ? "SELECT * FROM threads WHERE project_id = ? ORDER BY created_at"
      : "SELECT * FROM threads WHERE project_id = ? AND closed_at IS NULL ORDER BY created_at";
    return this.db.query<RawThread, [string]>(sql).all(projectId).map(toThread);
  }

  /** Whether a slug is free right now — the unique index enforces it, this explains it. */
  slugTaken(projectId: string, slug: string): boolean {
    return !!this.db
      .query<{ n: number }, [string, string]>(
        "SELECT COUNT(*) AS n FROM threads WHERE project_id = ? AND slug = ? AND closed_at IS NULL",
      )
      .get(projectId, slug)?.n;
  }

  attachConversation(threadId: string, conversationId: string): void {
    this.db.run("UPDATE threads SET conversation_id = ? WHERE id = ?", [conversationId, threadId]);
  }

  /** Remember which machine Fountain gave this conversation, the first time it says. */
  attachSandbox(threadId: string, sandboxId: string): void {
    this.db.run("UPDATE threads SET sandbox_id = ? WHERE id = ? AND (sandbox_id IS NULL OR sandbox_id <> ?)", [
      sandboxId,
      threadId,
      sandboxId,
    ]);
  }

  /** The branch the machine reported being on — which is not always the one asked for. */
  setBranch(threadId: string, branch: string): void {
    this.db.run("UPDATE threads SET branch = ? WHERE id = ?", [branch, threadId]);
  }

  markOpened(threadId: string): void {
    this.db.run("UPDATE threads SET opened_at = COALESCE(opened_at, ?) WHERE id = ?", [new Date().toISOString(), threadId]);
  }

  /**
   * Take the queued prompt, if there is one, exactly once.
   *
   * A `RETURNING` on the update rather than a read then a write: two browsers
   * watching one thread both see the opening turn finish at the same instant,
   * and the loser of that race must not send the prompt a second time.
   */
  takeQueuedPrompt(threadId: string): string | null {
    // Read then clear, inside a transaction, rather than `UPDATE … RETURNING`.
    //
    // `RETURNING` looked exactly right and is exactly wrong: on an UPDATE it
    // yields the row *after* the write, so it hands back the NULL it just
    // wrote. The column cleared, the caller saw nothing to send, and the first
    // thing somebody typed into a new thread vanished — with no error anywhere,
    // because every step succeeded. A transaction gets the atomicity that was
    // the point of the one-statement version without the trap.
    return this.db.transaction((): string | null => {
      const row = this.db
        .query<{ queued_prompt: string | null }, [string]>("SELECT queued_prompt FROM threads WHERE id = ?")
        .get(threadId);
      const prompt = row?.queued_prompt ?? null;
      if (prompt !== null) this.db.run("UPDATE threads SET queued_prompt = NULL WHERE id = ?", [threadId]);
      return prompt;
    })();
  }

  /** Put it back, when sending it failed. The next read tries again. */
  requeuePrompt(threadId: string, prompt: string): void {
    this.db.run("UPDATE threads SET queued_prompt = ? WHERE id = ? AND queued_prompt IS NULL", [prompt, threadId]);
  }

  renameThread(threadId: string, title: string): void {
    this.db.run("UPDATE threads SET title = ? WHERE id = ?", [title, threadId]);
  }

  closeThread(threadId: string): void {
    this.db.run("UPDATE threads SET closed_at = ? WHERE id = ?", [new Date().toISOString(), threadId]);
  }

  // ── the Run tab's saved commands ─────────────────────────────────────

  runCommands(projectId: string): RunCommandRow[] {
    return this.db
      .query<{ id: string; project_id: string; label: string; command: string; position: number }, [string]>(
        "SELECT id, project_id, label, command, position FROM run_commands WHERE project_id = ? ORDER BY position, created_at",
      )
      .all(projectId)
      .map((r) => ({ id: r.id, projectId: r.project_id, label: r.label, command: r.command, position: r.position }));
  }

  addRunCommand(projectId: string, label: string, command: string): RunCommandRow {
    const id = crypto.randomUUID();
    const next =
      (this.db.query<{ n: number | null }, [string]>("SELECT MAX(position) AS n FROM run_commands WHERE project_id = ?").get(projectId)
        ?.n ?? -1) + 1;
    this.db.run("INSERT INTO run_commands (id, project_id, label, command, position, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
      id,
      projectId,
      label,
      command,
      next,
      new Date().toISOString(),
    ]);
    return { id, projectId, label, command, position: next };
  }

  removeRunCommand(projectId: string, id: string): void {
    this.db.run("DELETE FROM run_commands WHERE project_id = ? AND id = ?", [projectId, id]);
  }

  close(): void {
    this.db.close();
  }
}

// ── row shapes, and the snake_case border ──────────────────────────────

interface RawUser {
  id: string;
  github_id: string;
  login: string;
  name: string | null;
  avatar_url: string | null;
  token_enc: string | null;
  created_at: string;
  last_seen_at: string;
}

interface RawProject {
  id: string;
  user_id: string;
  name: string;
  repo_full_name: string | null;
  repo_private: number;
  default_branch: string | null;
  installation_id: number | null;
  agent_id: string;
  environment_id: string;
  vault_id: string | null;
  runtime: string;
  model: string;
  rev: number;
  instructions: string;
  created_at: string;
  archived_at: string | null;
}

interface RawThread {
  id: string;
  project_id: string;
  conversation_id: string | null;
  sandbox_id: string | null;
  slug: string;
  title: string;
  branch: string | null;
  workdir: string;
  origin_kind: string;
  origin_base: string | null;
  origin_number: number | null;
  origin_title: string | null;
  origin_url: string | null;
  rev: number;
  queued_prompt: string | null;
  opened_at: string | null;
  closed_at: string | null;
  created_at: string;
  created_by_login: string;
}

function toUser(r: RawUser): UserRow {
  return {
    id: r.id,
    githubId: r.github_id,
    login: r.login,
    name: r.name,
    avatarUrl: r.avatar_url,
    tokenEnc: r.token_enc,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
  };
}

function toProject(r: RawProject): ProjectRow {
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    repoFullName: r.repo_full_name,
    repoPrivate: r.repo_private,
    defaultBranch: r.default_branch,
    installationId: r.installation_id,
    agentId: r.agent_id,
    environmentId: r.environment_id,
    vaultId: r.vault_id,
    runtime: r.runtime,
    model: r.model,
    rev: r.rev,
    instructions: r.instructions,
    createdAt: r.created_at,
    archivedAt: r.archived_at,
  };
}

function toThread(r: RawThread): ThreadRow {
  return {
    id: r.id,
    projectId: r.project_id,
    conversationId: r.conversation_id,
    sandboxId: r.sandbox_id,
    slug: r.slug,
    title: r.title,
    branch: r.branch,
    workdir: r.workdir,
    originKind: r.origin_kind,
    originBase: r.origin_base,
    originNumber: r.origin_number,
    originTitle: r.origin_title,
    originUrl: r.origin_url,
    rev: r.rev,
    queuedPrompt: r.queued_prompt,
    openedAt: r.opened_at,
    closedAt: r.closed_at,
    createdAt: r.created_at,
    createdByLogin: r.created_by_login,
  };
}

/** The origin as the API serves it, from the four columns it lives in. */
export function originOf(t: ThreadRow): ThreadOrigin {
  return {
    kind: (t.originKind as ThreadOrigin["kind"]) ?? "blank",
    base: t.originBase,
    number: t.originNumber,
    title: t.originTitle,
    url: t.originUrl,
  };
}
