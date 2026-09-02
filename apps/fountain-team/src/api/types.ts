// Shapes as served by the Fountain API (see docs/api.md, "Team").

export interface Runner {
  id: string;
  name: string;
  hostname: string | null;
  os?: string | null;
  arch?: string | null;
  version?: string | null;
  root?: string | null;
  online: boolean;
  connected_at?: string | null;
  last_seen_at?: string | null;
  created_at?: string;
  /** on a conversation's sandbox: the sandbox directory on that machine */
  path?: string | null;
}

export interface Sandbox {
  id: string;
  sprite_name: string;
  status: string;
  url: string | null;
  /** sprites | e2b | daytona | runner (absent on older servers) */
  provider?: string | null;
  runner?: Runner | null;
}

export interface Conversation {
  id: string;
  title: string | null;
  usage_total?: Usage | null;
  sandbox_id: string | null;
  sandbox: Sandbox | null;
  agent_id: string | null;
  vault_id: string | null;
  environment_id: string | null;
  runtime: string;
  acp: boolean;
  status: "pending" | "running" | "idle" | "failed" | "terminated";
  channel_id: string | null;
  turn_count: number;
  last_active_at: string | null;
  last_read_at: string | null;
  unread: boolean;
  inserted_at: string;
  updated_at: string;
}

export interface Agent {
  id: string;
  name: string;
  description?: string;
  model: string;
  runtime: string;
  environment_id: string | null;
  allowed_vault_ids: string[] | null;
  allowed_environment_ids: string[] | null;
  avatar_media_type?: string | null;
  /** present on GET /api/agents/:id */
  system?: string | null;
  skills?: Skill[] | null;
  mcp_servers?: Record<string, McpServer> | null;
  metadata?: Record<string, unknown> | null;
  sandbox_provider?: string | null;
  /**
   * What answers before the teammate runs a tool (fountain#939). A map of key
   * to verdict, plus a "default" key. A key is matched against the tool card's
   * title first and then ACP's kind, so `execute` covers shell commands
   * whatever the command is (fountain#958).
   */
  permission_policy?: Record<string, PermissionVerdict> | null;
}

/** auto_allow runs the tool, ask waits for a human, auto_deny refuses. */
export type PermissionVerdict = "auto_allow" | "ask" | "auto_deny";

/**
 * One of an agent's skills: installed from GitHub through the skills.sh CLI
 * (`source` = owner/repo; `name` picks one skill out of a repo that holds
 * several; `ref` pins a tag/branch/sha), or written inline — a whole SKILL.md.
 */
export type Skill = { source: string; name?: string; ref?: string; content?: undefined } | { name: string; content: string; source?: undefined };

/**
 * One of an agent's MCP servers, in Claude's own config shape: a hosted
 * server (`type` http/sse + `url`, optional `headers`) or a local one the
 * computer runs (`command` + `args`, optional `env`). `${VAR}` in any string
 * is replaced from the environment's secrets when the computer is set up.
 */
export type McpServer =
  | { type: "http" | "sse"; url: string; headers?: Record<string, string>; command?: undefined }
  | { type?: undefined; command: string; args?: string[]; env?: Record<string, string>; url?: undefined };

export interface Environment {
  id: string;
  name: string;
}

/** A row of GET /api/environments/:id/secrets — the key only; values are write-only. */
export interface EnvironmentSecret {
  id?: string;
  key: string;
  inserted_at?: string;
  updated_at?: string;
}

export interface Vault {
  id: string;
  name: string;
}

export type PresenceState =
  | "machine_offline"
  | "working"
  | "starting"
  | "online"
  | "asleep"
  | "away"
  | "failed"
  | "offline";

export interface Preview {
  kind: "you" | "them" | "typing";
  text: string | null;
}

export interface Teammate {
  agent_id: string;
  name: string;
  agent: Agent;
  conversation: Conversation;
  presence: { state: PresenceState; label: string };
  unread: boolean;
  last_turn: {
    id: string;
    turn_number: number;
    prompt: string;
    status: string;
    inserted_at: string;
  } | null;
  preview: Preview | null;
  /** summed over every conversation the agent has had on the team */
  usage_total?: Usage | null;
  /** the teammate's own email address + phone number (flag `team_comms`); null when it has none; absent on older servers */
  contact?: Contact | null;
}

/**
 * A teammate's own contact: an AgentMail inbox and an AgentPhone number bought
 * for it (POST /api/team/:agent_id/contact). `prompt_from_number` is the
 * owner's phone, E.164 — texts from it to `phone` arrive as prompts in the
 * teammate's thread; texts from anyone else are ignored.
 */
export interface Contact {
  email: string | null;
  phone: string | null;
  prompt_from_number: string | null;
  /** set when STOP was received from `prompt_from_number`: texts are paused until START, or the number is changed */
  prompt_opted_out_at?: string | null;
  inserted_at: string;
}

/** GET /api/team/comms: may this account give teammates a contact (`enabled`, the flag), and can this instance (`configured`, the keys). */
export interface CommsStatus {
  enabled: boolean;
  configured: boolean;
}

export interface Usage {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
}

export interface Turn {
  id: string;
  turn_number: number;
  prompt: string;
  status: string;
  exit_code: number | null;
  started_at: string | null;
  ended_at: string | null;
  inserted_at: string;
  image_count: number;
  /** what the runtime reported when the turn ended; null in flight or unreported */
  usage?: Usage | null;
}

export interface Schedule {
  id: string;
  agent_id: string;
  name: string | null;
  cron: string;
  prompt: string;
  one_off: boolean;
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_conversation_id: string | null;
  last_error: string | null;
  inserted_at: string;
  updated_at: string;
}

export interface ScheduleInput {
  cron: string;
  prompt: string;
  name?: string | null;
  one_off?: boolean;
  enabled?: boolean;
}

export interface SearchHit {
  kind: "title" | "prompt" | "reply";
  conversation_id: string;
  agent_id: string | null;
  turn_id: string | null;
  turn_number: number | null;
  snippet: string;
  ts: string;
}

/** A row of GET /api/team/:agent_id/conversations — a conversation plus whether it is the live one. */
export interface HistoryConversation extends Conversation {
  current: boolean;
}

export interface TreeNode {
  id: string;
  status: string;
  source: string;
  parent_id: string | null;
  title?: string | null;
  agent_id?: string | null;
}

export interface LogEvent {
  id: number;
  kind: "output" | "stage" | string;
  stream: string | null;
  data: string | null;
  stage: string | null;
  state: string | null;
  duration_ms?: number | null;
  turn_id: string | null;
  ts: string;
}

/** A team-stream event: the log event plus the ids to route it. */
export interface TeamEvent extends LogEvent {
  conversation_id: string;
  agent_id: string | null;
}

export interface Me {
  id: string;
  email: string;
  role: string;
}
