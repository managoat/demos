/**
 * Calls to Fountain from the server, with a given key. Deliberately not the
 * SDK: the server only ever forwards or lists, and it must not stamp a
 * `User-Agent` or parent-conversation header of its own on a proxied call.
 */

export interface FountainUser {
  id: string;
  email: string;
}

export interface ConversationSummary {
  id: string;
  channel_id?: string | null;
  title?: string | null;
  agent_id?: string | null;
  environment_id?: string | null;
  vault_id?: string | null;
  sandbox_id?: string | null;
  status?: string;
  inserted_at?: string;
  last_active_at?: string | null;
  updated_at?: string | null;
  [k: string]: unknown;
}

export class FountainHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Fountain answered ${status}`);
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

  /** Who the key belongs to. The one endpoint that answers without the `{data}` envelope. */
  me(): Promise<FountainUser> {
    return this.json<FountainUser>("/api/auth/me");
  }

  async conversations(query: Record<string, string> = {}): Promise<ConversationSummary[]> {
    const qs = new URLSearchParams(query).toString();
    const body = await this.json<{ data: ConversationSummary[] }>(`/api/conversations${qs ? `?${qs}` : ""}`);
    return body.data ?? [];
  }

  /**
   * Retire a conversation. Fountain tears the sprite down with the last live
   * conversation on it (ADR 0023), so a computer another conversation still
   * holds stays up. Idempotent for one that is already dead.
   */
  async terminate(id: string): Promise<void> {
    const res = await this.fetch(`/api/conversations/${encodeURIComponent(id)}/terminate`, { method: "POST" });
    if (!res.ok) throw new FountainHttpError(res.status, await res.text());
  }

  async conversation(id: string): Promise<ConversationSummary | null> {
    try {
      const body = await this.json<{ data: ConversationSummary }>(`/api/conversations/${encodeURIComponent(id)}`);
      return body.data ?? null;
    } catch (err) {
      if (err instanceof FountainHttpError && err.status === 404) return null;
      throw err;
    }
  }
}
