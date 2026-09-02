/**
 * The Fountain API, as much of it as Briefing Room needs. Every call carries
 * the bearer key; every error is an `ApiError` with the server's `error`
 * string when there was one. Ported (slimmed) from jhgaylor/dns-desk.
 */
import type { Agent, Catalog, LogEvent, Me, Teammate, Turn } from "./types";
import { readSse, type SseMessage } from "../lib/sse";
import type { Settings } from "../lib/settings";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string | null,
    message: string,
    public retryAfter: number | null = null,
    public body: Record<string, unknown> | null = null,
  ) {
    super(message);
  }
}

export class FountainClient {
  constructor(private settings: Settings) {}

  get baseUrl(): string {
    return this.settings.baseUrl;
  }

  me(): Promise<Me> {
    return this.json<Me>("GET", "/api/auth/me");
  }

  // ── the researcher teammate ───────────────────────────────────────────────

  async listTeam(): Promise<Teammate[]> {
    return (await this.json<{ data: Teammate[] }>("GET", "/api/team")).data;
  }

  async getTeammate(agentId: string): Promise<Teammate> {
    return (await this.json<{ data: Teammate }>("GET", `/api/team/${agentId}`)).data;
  }

  async addTeammate(input: { agent_id: string; name?: string }): Promise<Teammate> {
    return (await this.json<{ data: Teammate }>("POST", "/api/team", input)).data;
  }

  sendMessage(agentId: string, prompt: string): Promise<{ status: string; conversation_id: string }> {
    return this.json("POST", `/api/team/${agentId}/messages`, { prompt });
  }

  // ── the conversation the researcher runs on ───────────────────────────────

  async listTurns(conversationId: string): Promise<Turn[]> {
    return (await this.json<{ data: Turn[] }>("GET", `/api/conversations/${conversationId}/turns`)).data;
  }

  /** Every event of the conversation on the given streams, oldest first, paging until drained. */
  async listAllEvents(conversationId: string, streams: string[]): Promise<LogEvent[]> {
    const out: LogEvent[] = [];
    let after: number | null = null;
    for (;;) {
      const qs = new URLSearchParams({ limit: "1000", streams: streams.join(",") });
      if (after !== null) qs.set("after", String(after));
      const page: { data: LogEvent[]; meta: { has_more: boolean; next_cursor: number | null } } =
        await this.json("GET", `/api/conversations/${conversationId}/events?${qs}`);
      out.push(...page.data);
      if (!page.meta.has_more || page.meta.next_cursor === null) break;
      after = page.meta.next_cursor;
    }
    return out;
  }

  markRead(conversationId: string): Promise<void> {
    return this.json<void>("POST", `/api/conversations/${conversationId}/read`);
  }

  interrupt(conversationId: string): Promise<unknown> {
    return this.json("POST", `/api/conversations/${conversationId}/interrupt`);
  }

  // ── set-up: creating the researcher agent ─────────────────────────────────

  async listAgents(): Promise<Agent[]> {
    return (await this.json<{ data: Agent[] }>("GET", "/api/agents")).data;
  }

  createAgent(input: { name: string; model: string; runtime: string; description?: string; system?: string }): Promise<Agent> {
    return this.json<{ data: Agent }>("POST", "/api/agents", input).then((r) => r.data);
  }

  getCatalog(): Promise<Catalog> {
    return this.json<{ data: Catalog }>("GET", "/api/catalog").then((r) => r.data);
  }

  // ── stream ────────────────────────────────────────────────────────────────

  /**
   * The whole team's events on one connection. Resolves when the server
   * closes (idle timeout, deploy); the caller reconnects with the last id.
   */
  streamTeam(opts: {
    lastEventId: string | null;
    streams: string[];
    signal: AbortSignal;
    onMessage: (msg: SseMessage) => void;
    onOpen?: () => void;
    onClose: (err?: unknown) => void;
  }): Promise<void> {
    const qs = new URLSearchParams({ streams: opts.streams.join(",") });
    return readSse(`${this.baseUrl}/api/team/stream?${qs}`, {
      headers: { authorization: `Bearer ${this.settings.apiKey}` },
      lastEventId: opts.lastEventId,
      signal: opts.signal,
      onMessage: opts.onMessage,
      onOpen: opts.onOpen,
      onClose: opts.onClose,
    });
  }

  // ── plumbing ──────────────────────────────────────────────────────────────

  private async json<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.settings.apiKey}`,
      accept: "application/json",
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
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
      const message = typeof obj.message === "string" ? obj.message : code ?? `${res.status} ${res.statusText}`;
      const ra = res.headers.get("retry-after");
      throw new ApiError(res.status, code, message, ra ? Number(ra) : null, parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null);
    }
    return parsed as T;
  }
}

/** A human line for an API failure, in the app's voice. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "conversation_busy":
        return "The researcher is still working on the last request.";
      case "provisioning":
        return "The researcher's computer is still starting — try again shortly.";
      case "subscription_required":
        return "An active Fountain subscription is required.";
      case "not_found":
        return "Not found.";
      default:
        if (err.status === 401) return "That API key was not accepted.";
        if (err.status === 429) return "Too many requests — slow down a little.";
        if (err.status === 503) return "Fountain could not reach the sandbox provider — try again shortly.";
        return err.message;
    }
  }
  if (err instanceof TypeError) {
    return "Could not reach Fountain. Check the URL, and that API_CORS_ORIGINS on the server includes this site.";
  }
  return err instanceof Error ? err.message : String(err);
}
