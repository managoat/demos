/**
 * Calls to Fountain from the server, with a given key.
 *
 * Deliberately not the SDK and deliberately not a copy of the browser's
 * `src/api/client.ts`: the server mostly *forwards*, and a forwarding client
 * must not stamp headers of its own on a proxied call. `raw` is the one the
 * proxy uses; the typed helpers are for paddock's own routes.
 *
 * Same reasoning as `apps/salon/server/fountain.ts`.
 */
import { HttpError } from "./http";

export interface FountainUser {
  id: string;
  email: string;
}

export interface ConversationSummary {
  id: string;
  title: string | null;
  sandbox_id: string | null;
  agent_id: string | null;
  runtime: string;
  status: string;
  channel_id: string | null;
  turn_count: number;
  last_active_at: string | null;
  inserted_at: string;
  [k: string]: unknown;
}

export class FountainHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
  }
}

export class FountainClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  me(): Promise<FountainUser> {
    return this.json<FountainUser>("GET", "/api/auth/me");
  }

  async listConversations(agentId?: string): Promise<ConversationSummary[]> {
    const qs = agentId ? `?${new URLSearchParams({ agent_id: agentId })}` : "";
    return (await this.json<{ data: ConversationSummary[] }>("GET", `/api/conversations${qs}`)).data;
  }

  /**
   * One request, forwarded as-is. The proxy has already decided this call is
   * allowed; this just puts the owner's key on it and hands the response
   * back untouched, streaming body included (SSE depends on that).
   */
  raw(method: string, path: string, init: { body?: BodyInit | null; signal?: AbortSignal; accept?: string } = {}): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.apiKey}` };
    if (init.accept) headers.accept = init.accept;
    if (init.body != null) headers["content-type"] = "application/json";
    return fetch(`${this.baseUrl}${path}`, { method, headers, body: init.body ?? undefined, signal: init.signal });
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, path, { body: body === undefined ? null : JSON.stringify(body), accept: "application/json" });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (!res.ok) {
      const obj = (parsed ?? {}) as { error?: unknown; message?: unknown };
      const code = typeof obj.error === "string" ? obj.error : null;
      const message = typeof obj.message === "string" ? obj.message : (code ?? `${res.status} ${res.statusText}`);
      throw new FountainHttpError(res.status, code, message);
    }
    return parsed as T;
  }
}

/** Turn a Fountain failure into one of ours, preserving what the caller needs. */
export function asHttpError(err: unknown, whatFor: string): HttpError {
  if (err instanceof FountainHttpError) {
    if (err.status === 401 || err.status === 403) return new HttpError(502, "fountain_rejected", "Fountain rejected this machine's key.");
    return new HttpError(err.status >= 500 ? 502 : err.status, err.code ?? "fountain_error", err.message);
  }
  return new HttpError(502, "fountain_unreachable", `Could not reach Fountain to ${whatFor}.`);
}
