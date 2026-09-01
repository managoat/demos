/**
 * Calls to Fountain from the server, with a given key. Deliberately not the
 * SDK: the server only ever forwards or lists, and it must not stamp a
 * `User-Agent` or parent-conversation header of its own on a proxied call.
 */
import { HttpError } from "./http";

export interface FountainUser {
  id: string;
  email: string;
}

export interface AgentSummary {
  id: string;
  name: string;
  description?: string | null;
  system?: string | null;
  model: string;
  runtime: string;
  environment_id?: string | null;
  sandbox_provider?: string | null;
  sandbox_mode?: string | null;
  permission_policy?: Record<string, string> | null;
  skills?: unknown[];
  mcp_servers?: Record<string, unknown>;
  metadata?: Record<string, unknown> | null;
  allowed_vault_ids?: string[] | null;
  allowed_environment_ids?: string[] | null;
  avatar_media_type?: string | null;
  [k: string]: unknown;
}

export interface ConversationSummary {
  id: string;
  channel_id?: string | null;
  title?: string | null;
  first_prompt?: string | null;
  agent_id?: string | null;
  status?: string;
  inserted_at?: string;
  last_active_at?: string | null;
  unread?: boolean;
  turn_count?: number;
  [k: string]: unknown;
}

export interface Catalog {
  runtimes: string[];
  models: Record<string, string[]>;
  [k: string]: unknown;
}

export class FountainHttpError extends Error {
  readonly code: string | null;
  readonly detail: string | null;
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Fountain answered ${status}`);
    let code: string | null = null;
    let detail: string | null = null;
    try {
      const parsed = JSON.parse(body) as { error?: unknown; message?: unknown; errors?: unknown };
      if (typeof parsed.error === "string") code = parsed.error;
      if (typeof parsed.message === "string") detail = parsed.message;
      else if (parsed.errors !== undefined) detail = JSON.stringify(parsed.errors);
    } catch {
      // not JSON; the status is all we know
    }
    this.code = code;
    this.detail = detail;
  }

  /** The same failure, as this server reports it: Fountain's status and code, so the browser can branch on them. */
  toHttp(fallback: string): HttpError {
    if (this.status === 401 || this.status === 403) return new HttpError(502, "host_key_rejected", "Fountain no longer accepts the host's key. The host should sign in again.");
    return new HttpError(this.status, this.code ?? `fountain_${this.status}`, this.detail ?? fallback);
  }
}

export class FountainClient {
  constructor(
    readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.apiKey}`);
    if (!headers.has("accept")) headers.set("accept", "application/json");
    return fetch(`${this.baseUrl}${path}`, { ...init, headers });
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetch(path, init);
    const text = await res.text();
    if (!res.ok) throw new FountainHttpError(res.status, text);
    return JSON.parse(text) as T;
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.json<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  /** Who the key belongs to. The one endpoint that answers without the `{data}` envelope. */
  me(): Promise<FountainUser> {
    return this.json<FountainUser>("/api/auth/me");
  }

  async catalog(): Promise<Catalog> {
    return (await this.json<{ data: Catalog }>("/api/catalog")).data;
  }

  async agents(): Promise<AgentSummary[]> {
    return (await this.json<{ data: AgentSummary[] }>("/api/agents")).data ?? [];
  }

  async createAgent(body: Record<string, unknown>): Promise<AgentSummary> {
    return (await this.post<{ data: AgentSummary }>("/api/agents", body)).data;
  }

  async environments(): Promise<Record<string, unknown>[]> {
    return (await this.json<{ data: Record<string, unknown>[] }>("/api/environments")).data ?? [];
  }

  async vaults(): Promise<Record<string, unknown>[]> {
    return (await this.json<{ data: Record<string, unknown>[] }>("/api/vaults")).data ?? [];
  }

  async createConversation(body: Record<string, unknown>): Promise<ConversationSummary> {
    return (await this.post<{ data: ConversationSummary }>("/api/conversations", body)).data;
  }

  async conversations(query: Record<string, string> = {}): Promise<ConversationSummary[]> {
    const qs = new URLSearchParams(query).toString();
    return (await this.json<{ data: ConversationSummary[] }>(`/api/conversations${qs ? `?${qs}` : ""}`)).data ?? [];
  }

  async conversation(id: string): Promise<ConversationSummary | null> {
    try {
      return (await this.json<{ data: ConversationSummary }>(`/api/conversations/${encodeURIComponent(id)}`)).data ?? null;
    } catch (err) {
      if (err instanceof FountainHttpError && err.status === 404) return null;
      throw err;
    }
  }

  /** Retire a conversation. Idempotent for one that is already dead. */
  async terminate(id: string): Promise<void> {
    const res = await this.fetch(`/api/conversations/${encodeURIComponent(id)}/terminate`, { method: "POST" });
    if (!res.ok && res.status !== 404 && res.status !== 409) throw new FountainHttpError(res.status, await res.text());
  }
}
