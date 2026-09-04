// Shapes as served by the Fountain API, narrowed to what paddock reads.
// Lifted from apps/fountain-conversations/src/api/types.ts, which tracks
// docs/api.md; fields this app never touches are left off on purpose.

export type SandboxMode = "ephemeral" | "persistent";
export type SandboxStatus = "pending" | "starting" | "ready" | "suspended" | "terminated" | "failed";
export type ConversationStatus = "pending" | "running" | "idle" | "failed" | "terminated";

/** One machine, as a conversation embeds it (`conversation.sandbox`). */
export interface Sandbox {
  id: string;
  sprite_name?: string;
  status: SandboxStatus;
  provider?: string | null;
  /**
   * The identity the disk was built from (ADR 0023). A launch must match all
   * three to attach with `sandbox_id`; this is the whole reason paddock keeps
   * one agent, one environment and one vault and mutates them in place
   * instead of making new ones. See `lib/machine.ts`.
   */
  agent_id?: string | null;
  environment_id?: string | null;
  vault_id?: string | null;
  /** `persistent`: the agent identity's home, shared by its conversations and kept when one ends. */
  mode?: SandboxMode;
  url?: string | null;
}

export interface Conversation {
  id: string;
  title: string | null;
  sandbox_id: string | null;
  sandbox: Sandbox | null;
  agent_id: string | null;
  vault_id: string | null;
  environment_id: string | null;
  runtime: string;
  status: ConversationStatus;
  channel_id: string | null;
  turn_count: number;
  last_active_at: string | null;
  inserted_at: string;
  updated_at?: string;
}

/** A repository an environment clones into the box. */
export interface Repository {
  url: string;
  mount_path: string;
  ref?: string | null;
  /** Names an environment secret holding the clone credential. Never the credential. */
  secret_key?: string | null;
}

export interface Environment {
  id: string;
  name: string;
  repositories?: Repository[] | null;
  packages?: string[] | null;
  setup_script?: string | null;
}

export interface Vault {
  id: string;
  name: string;
}

/** One entry of `GET /api/{environments,vaults}/:id/secrets`. A key, never a value. */
export interface SecretKey {
  key: string;
  updated_at?: string | null;
}

export interface Agent {
  id: string;
  name: string;
  description?: string | null;
  system?: string | null;
  model: string;
  runtime: string;
  environment_id?: string | null;
  vault_id?: string | null;
  skills?: unknown[] | null;
  mcp_servers?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

/** `GET /api/catalog`: what this Fountain can run. */
export interface Catalog {
  runtimes: string[];
  models: Record<string, string[]>;
}

/** `GET /api/sandboxes/:id/files`: one directory. */
export interface SandboxListing {
  path: string;
  entries: { name: string; type: string; size: number | null }[];
  truncated: boolean;
}

/** `GET /api/sandboxes/:id/file`: one file's bytes, text or base64, redacted. */
export interface SandboxFile {
  path: string;
  size: number;
  truncated: boolean;
  encoding: string;
  content: string;
}

/** `GET /api/sandboxes/:id/diff`: `git diff` of the repository at `path`. */
export interface SandboxDiff {
  path: string;
  repo_root: string;
  staged: boolean;
  ref: string | null;
  diff: string;
  truncated: boolean;
}

/**
 * One stored log event, as `GET /api/conversations/:id/events` returns it and
 * as `GET /api/events/stream` pushes it. Structurally a superset of the shared
 * `LogEvent` in `@managoat/fountain-app`, so it passes straight to
 * `blocksForTurn` without a cast.
 */
export interface LogEvent {
  id: number;
  kind: "output" | "stage" | string;
  stream: string | null;
  data: string | null;
  stage: string | null;
  state: string | null;
  turn_id: string | null;
  ts: string;
  /** Present on the account-wide stream, which carries every tab at once. */
  conversation_id?: string;
}

export interface Me {
  id: string;
  email: string;
}
