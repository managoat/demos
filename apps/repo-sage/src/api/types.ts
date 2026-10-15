// Shapes as served by the Fountain API — the subset Repo Sage uses.
// Ported from jhgaylor/dns-desk.

export interface Conversation {
  id: string;
  title: string | null;
  agent_id: string | null;
  vault_id: string | null;
  environment_id: string | null;
  runtime: string;
  acp: boolean;
  status: "pending" | "running" | "idle" | "failed" | "terminated";
  turn_count: number;
  last_active_at: string | null;
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
  system?: string | null;
  metadata?: Record<string, unknown> | null;
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
}

export interface LogEvent {
  id: number;
  kind: "output" | "stage" | string;
  stream: string | null;
  data: string | null;
  stage: string | null;
  state: string | null;
  turn_id: string | null;
  ts: string;
}

/** An `/api/events/stream` event: the log event plus the conversation it belongs to. */
export interface StreamEvent extends LogEvent {
  conversation_id: string;
}

export interface Me {
  id: string;
  email: string;
  role: string;
}

export interface Catalog {
  runtimes: string[];
  models: Record<string, string[]>;
}
