/**
 * The Fountain API, as much of it as Repo Sage needs. Every call carries the
 * bearer key; every error is an `ApiError` with the server's `error` string
 * when there was one. Ported (slimmed) from jhgaylor/dns-desk.
 */
import type { Agent, Catalog, Conversation, LogEvent, Me, Turn } from "./types";
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

  // ── the sages' conversations: one per agent, held by a channel ───────────

  /** Every live conversation bound to `channel`, most recently updated first. */
  async listChannelConversations(channel: string): Promise<Conversation[]> {
    const qs = new URLSearchParams({ channel_id: channel, status: "pending,running,idle", limit: "200" });
    return (await this.json<{ data: Conversation[] }>("GET", `/api/conversations?${qs}`)).data;
  }

  /**
   * Send `prompt` on the agent's conversation on `channel`. `POST
   * /api/conversations` with a `channel_id` resumes the live one (and then
   * ignores `prompt`, so it is sent as a prompt) or opens a new one with
   * `prompt` as turn 1.
   */
  async sendOnChannel(input: { agent_id: string; channel_id: string; prompt: string }): Promise<Conversation> {
    const res = await this.json<{ data: Conversation; meta?: { resumed?: boolean } }>("POST", "/api/conversations", input);
    if (res.meta?.resumed) await this.json("POST", `/api/conversations/${res.data.id}/prompts`, { prompt: input.prompt });
    return res.data;
  }

  /** Ends a conversation: its computer and clone go; the transcript stays in Fountain. */
  terminate(conversationId: string): Promise<unknown> {
    return this.json("POST", `/api/conversations/${conversationId}/terminate`);
  }

  // ── the conversation a sage runs on ───────────────────────────────────────

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

  // ── set-up: creating a sage agent ─────────────────────────────────────────

  async listAgents(search?: string): Promise<Agent[]> {
    const qs = search ? `?${new URLSearchParams({ search })}` : "";
    return (await this.json<{ data: Agent[] }>("GET", `/api/agents${qs}`)).data;
  }

  createAgent(input: { name: string; model: string; runtime: string; description?: string; system?: string }): Promise<Agent> {
    return this.json<{ data: Agent }>("POST", "/api/agents", input).then((r) => r.data);
  }

  deleteAgent(agentId: string): Promise<void> {
    return this.json<void>("DELETE", `/api/agents/${agentId}`);
  }

  getCatalog(): Promise<Catalog> {
    return this.json<{ data: Catalog }>("GET", "/api/catalog").then((r) => r.data);
  }

  // ── stream ────────────────────────────────────────────────────────────────

  /**
   * Every conversation's events on one connection (`/api/events/stream`);
   * the caller keeps the open sage's. Resolves when the server closes (idle
   * timeout, deploy); the caller reconnects with the last id.
   */
  streamEvents(opts: {
    lastEventId: string | null;
    streams: string[];
    signal: AbortSignal;
    onMessage: (msg: SseMessage) => void;
    onOpen?: () => void;
    onClose: (err?: unknown) => void;
  }): Promise<void> {
    const qs = new URLSearchParams({ streams: opts.streams.join(",") });
    return readSse(`${this.baseUrl}/api/events/stream?${qs}`, {
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
        return "The sage is still working on the last question — wait for it to finish.";
      case "provisioning":
        return "The sage's computer is still starting — try again shortly.";
      case "subscription_required":
        return "An active Fountain subscription is required.";
      case "sandbox_quota_exceeded":
        return "You are at your Fountain sandbox limit — retire a sage (or end another conversation) first.";
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
