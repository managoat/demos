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
  turn_count?: number;
  /** Running sums over the turns that reported one — lifetime, not per billing period. */
  usage_total?: { input?: number; output?: number };
  [k: string]: unknown;
}

/** One hit from `GET /api/search`: what matched, and where to jump. */
export interface SearchHit {
  kind: "title" | "prompt" | "reply";
  conversation_id: string;
  agent_id?: string | null;
  turn_id?: string | null;
  turn_number?: number | null;
  snippet: string;
  ts: string;
  [k: string]: unknown;
}

/**
 * `GET /api/account/billing`: the account's plan and what it has used over the
 * period Stripe invoices (or the calendar month, when there is no such
 * period — `period.source` says which). Account-wide: Fountain attributes
 * none of it to a project, an agent or a conversation.
 */
export interface Billing {
  status?: string | null;
  trial_ends_at?: string | null;
  current_period_end?: string | null;
  cancel_at_period_end?: boolean;
  period?: { start?: string; end?: string; source?: string };
  plan?: { name?: string; slug?: string; monthly_cents?: number; included_turn_hours?: number; concurrent_sandboxes?: number; sandbox_limit?: number };
  usage?: { conversations?: number; turns?: number; turn_hours?: number; turn_hours_included?: number; turn_hours_remaining?: number; sandbox_minutes?: number };
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

  /**
   * The key-holder's own bill. Null on 404, which is what an instance with
   * billing switched off answers (carrying `billing: "disabled"`), and also
   * what a Fountain too old to have the endpoint answers — either way there
   * is no bill to show, and the caller says so rather than inventing one.
   */
  async billing(): Promise<Billing | null> {
    try {
      const body = await this.json<{ data: Billing }>("/api/account/billing");
      return body.data ?? null;
    } catch (err) {
      if (err instanceof FountainHttpError && err.status === 404) return null;
      throw err;
    }
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
