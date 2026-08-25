/**
 * The Fountain API, as much of it as the team app needs. Every call carries
 * the bearer key; every error is an `ApiError` with the server's `error`
 * string when there was one, so the UI can say "still working on the last
 * message" instead of "400".
 */
import type { Catalog } from "../lib/brain";
import type {
  Agent,
  CommsStatus,
  Conversation,
  Environment,
  EnvironmentSecret,
  HistoryConversation,
  LogEvent,
  McpServer,
  Runner,
  Me,
  Schedule,
  ScheduleInput,
  SearchHit,
  Skill,
  Teammate,
  TreeNode,
  Turn,
  PermissionVerdict,
  Vault,
} from "./types";
import { readSse, type SseMessage } from "../lib/sse";
import type { Settings } from "../lib/settings";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string | null,
    message: string,
    public retryAfter: number | null = null,
    /** the parsed error body, for callers that read more than `error`/`message` (field errors, `channel`) */
    public body: Record<string, unknown> | null = null,
  ) {
    super(message);
  }

  /** `errors: {field: [msg, …]}` as the server sends a 422 — empty when there is none. */
  get fieldErrors(): Record<string, string[]> {
    const e = this.body?.errors;
    if (!e || typeof e !== "object" || Array.isArray(e)) return {};
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(e as Record<string, unknown>)) {
      if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === "string");
      else if (typeof v === "string") out[k] = [v];
    }
    return out;
  }
}

export interface AddTeammateInput {
  agent_id: string;
  name?: string;
  environment_id?: string;
  vault_id?: string;
}

export class FountainClient {
  constructor(private settings: Settings) {}

  get baseUrl(): string {
    return this.settings.baseUrl;
  }

  // ── auth ────────────────────────────────────────────────────────────────

  me(): Promise<Me> {
    return this.json<Me>("GET", "/api/auth/me");
  }

  // ── team ────────────────────────────────────────────────────────────────

  async listTeam(): Promise<Teammate[]> {
    const r = await this.json<{ data: Teammate[] }>("GET", "/api/team");
    return r.data;
  }

  async getTeammate(agentId: string): Promise<Teammate> {
    const r = await this.json<{ data: Teammate }>("GET", `/api/team/${agentId}`);
    return r.data;
  }

  async addTeammate(input: AddTeammateInput): Promise<Teammate> {
    const r = await this.json<{ data: Teammate }>("POST", "/api/team", input);
    return r.data;
  }

  async renameTeammate(agentId: string, name: string | null): Promise<Teammate> {
    const r = await this.json<{ data: Teammate }>("PATCH", `/api/team/${agentId}`, { name });
    return r.data;
  }

  /** The teammate's conversations on the team, newest first, the live one flagged `current`. */
  async teammateHistory(agentId: string): Promise<HistoryConversation[]> {
    return (await this.json<{ data: HistoryConversation[] }>("GET", `/api/team/${agentId}/conversations`)).data;
  }

  /**
   * A fresh conversation on the teammate's current computer: the current one is retired (it
   * stays in History) and the new one takes over the sandbox — the next message starts a clean
   * runtime session on the same disk. 400 `conversation_busy` mid-turn, 503 `provisioning`
   * while the computer is starting; a gone computer is replaced by a new one.
   */
  async freshConversation(agentId: string): Promise<Teammate> {
    const r = await this.json<{ data: Teammate }>("POST", `/api/team/${agentId}/conversations`);
    return r.data;
  }

  // ── contact: a teammate's own email address + phone number ──────────────

  /** Whether this account may give teammates an email + phone (`enabled`) and whether the instance can (`configured`). */
  async commsStatus(): Promise<CommsStatus> {
    return (await this.json<{ data: CommsStatus }>("GET", "/api/team/comms")).data;
  }

  /**
   * Buy an AgentMail inbox and an AgentPhone number for this teammate (billed; all or nothing).
   * `promptFromNumber` is the owner's phone: texts from it to the new number become prompts.
   * 404 `team_comms_not_enabled`, 503 `team_comms_not_configured`, 409 `contact_already_provisioned`,
   * 422 (`fieldErrors.prompt_from_number`; nothing bought), 502 `provider_error` (`body.channel`).
   */
  async provisionContact(agentId: string, promptFromNumber: string): Promise<Teammate> {
    const r = await this.json<{ data: Teammate }>("POST", `/api/team/${agentId}/contact`, { prompt_from_number: promptFromNumber });
    return r.data;
  }

  /**
   * Change whose texts reach the teammate (PATCH): the new number replaces `prompt_from_number`
   * and clears an opt-out. 200 with the teammate; 422 (`fieldErrors.prompt_from_number`); 404 without a contact.
   */
  async changeContactNumber(agentId: string, promptFromNumber: string): Promise<Teammate> {
    const r = await this.json<{ data: Teammate }>("PATCH", `/api/team/${agentId}/contact`, { prompt_from_number: promptFromNumber });
    return r.data;
  }

  /** Release the teammate's inbox and number upstream and forget them. 404 without one, 502 `provider_error`. */
  releaseContact(agentId: string): Promise<void> {
    return this.json<void>("DELETE", `/api/team/${agentId}/contact`);
  }

  // ── runners ─────────────────────────────────────────────────────────────

  async listRunners(): Promise<Runner[]> {
    return (await this.json<{ data: Runner[] }>("GET", "/api/runners")).data;
  }

  deleteRunner(id: string): Promise<void> {
    return this.json<void>("DELETE", `/api/runners/${id}`);
  }

  removeTeammate(agentId: string): Promise<void> {
    return this.json<void>("DELETE", `/api/team/${agentId}`);
  }

  sendMessage(
    agentId: string,
    prompt: string,
    images: Array<{ data: string; media_type: string }> = [],
  ): Promise<{ status: string; conversation_id: string }> {
    const body: Record<string, unknown> = { prompt };
    if (images.length) body.images = images.map((i) => ({ data: i.data, media_type: i.media_type }));
    return this.json("POST", `/api/team/${agentId}/messages`, body);
  }

  // ── schedules (routines) ────────────────────────────────────────────────

  async listSchedules(): Promise<Schedule[]> {
    return (await this.json<{ data: Schedule[] }>("GET", "/api/team/schedules")).data;
  }

  async createSchedule(agentId: string, input: ScheduleInput): Promise<Schedule> {
    return (await this.json<{ data: Schedule }>("POST", `/api/team/${agentId}/schedules`, input)).data;
  }

  async updateSchedule(agentId: string, id: string, input: Partial<ScheduleInput>): Promise<Schedule> {
    return (await this.json<{ data: Schedule }>("PATCH", `/api/team/${agentId}/schedules/${id}`, input)).data;
  }

  deleteSchedule(agentId: string, id: string): Promise<void> {
    return this.json<void>("DELETE", `/api/team/${agentId}/schedules/${id}`);
  }

  runSchedule(agentId: string, id: string): Promise<{ status: string; conversation_id: string }> {
    return this.json("POST", `/api/team/${agentId}/schedules/${id}/run`);
  }

  // ── search ──────────────────────────────────────────────────────────────

  async search(q: string, opts: { limit?: number; signal?: AbortSignal } = {}): Promise<SearchHit[]> {
    const qs = new URLSearchParams({ q, limit: String(opts.limit ?? 20) });
    return (await this.json<{ data: SearchHit[] }>("GET", `/api/search?${qs}`, undefined, opts.signal)).data;
  }

  // ── threads: more conversations on one teammate's computer ──────────────

  /**
   * The caller's conversations, filtered. `status` is a comma-joined subset of
   * pending/running/idle/failed/terminated (an unknown one is a 400).
   */
  async listConversations(filter: { agentId?: string; status?: string[] } = {}): Promise<Conversation[]> {
    const qs = new URLSearchParams();
    if (filter.agentId) qs.set("agent_id", filter.agentId);
    if (filter.status?.length) qs.set("status", filter.status.join(","));
    const q = qs.toString();
    return (await this.json<{ data: Conversation[] }>("GET", `/api/conversations${q ? `?${q}` : ""}`)).data;
  }

  /**
   * A second conversation on a computer the teammate already has: Fountain
   * provisions nothing and attaches it to `sandbox_id`, which must have been
   * built for the same agent, environment and vault (404 `sandbox_not_found`,
   * 409 `sandbox_not_attachable`, 422 `sandbox_identity_mismatch` otherwise).
   * It sits `pending` until its first prompt.
   */
  async openThread(input: {
    agent_id: string;
    sandbox_id: string;
    environment_id?: string | null;
    vault_id?: string | null;
    title?: string | null;
  }): Promise<Conversation> {
    const body: Record<string, unknown> = { agent_id: input.agent_id, sandbox_id: input.sandbox_id };
    if (input.environment_id) body.environment_id = input.environment_id;
    if (input.vault_id) body.vault_id = input.vault_id;
    if (input.title) body.title = input.title;
    return (await this.json<{ data: Conversation }>("POST", "/api/conversations", body)).data;
  }

  /** A turn on a conversation directly (a side thread; the main thread goes through `sendMessage`). */
  prompt(conversationId: string, prompt: string, images: Array<{ data: string; media_type: string }> = []): Promise<{ status: string }> {
    const body: Record<string, unknown> = { prompt };
    if (images.length) body.images = images.map((i) => ({ data: i.data, media_type: i.media_type }));
    return this.json("POST", `/api/conversations/${conversationId}/prompts`, body);
  }

  // ── conversations (the thread) ──────────────────────────────────────────

  async tree(conversationId: string): Promise<TreeNode[]> {
    return (await this.json<{ data: TreeNode[] }>("GET", `/api/conversations/${conversationId}/tree`)).data;
  }

  getAgent(agentId: string): Promise<Agent> {
    return this.json<{ data: Agent }>("GET", `/api/agents/${agentId}`).then((r) => r.data);
  }

  async listTurns(conversationId: string): Promise<Turn[]> {
    const r = await this.json<{ data: Turn[] }>("GET", `/api/conversations/${conversationId}/turns`);
    return r.data;
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

  /** The bytes of one image attached to a turn, as an object URL (revoke it when done). */
  async turnImageUrl(conversationId: string, turnId: string, position: number): Promise<string> {
    const res = await this.fetchRaw(`/api/conversations/${conversationId}/turns/${turnId}/images/${position}`);
    if (!res.ok) throw new ApiError(res.status, null, `image ${res.status}`);
    return URL.createObjectURL(await res.blob());
  }

  /**
   * Answer a permission request the agent is blocked on (fountain#940).
   *
   * `optionId` must be one of the `optionId` values that request's own block
   * carried — an id the agent did not offer is refused with 422
   * `unknown_option` rather than forwarded.
   *
   * First answer wins: another attached client, the server's timeout, or the
   * turn ending may have resolved it already, and all of those are one 409
   * `permission_request_resolved`. That is not an error to apologise for — the
   * stream says how it actually ended.
   */
  answerRequest(conversationId: string, requestId: string, optionId: string): Promise<{ ok: boolean }> {
    return this.json("POST", `/api/conversations/${conversationId}/requests/${encodeURIComponent(requestId)}`, {
      option_id: optionId,
    });
  }

  markRead(conversationId: string): Promise<void> {
    return this.json<void>("POST", `/api/conversations/${conversationId}/read`);
  }

  /** End the conversation and its computer; the teammate's next message opens a fresh one on a new computer and this one joins its history. (`freshConversation` keeps the computer.) */
  terminate(conversationId: string): Promise<unknown> {
    return this.json("POST", `/api/conversations/${conversationId}/terminate`);
  }

  interrupt(conversationId: string): Promise<unknown> {
    return this.json("POST", `/api/conversations/${conversationId}/interrupt`);
  }

  getConversation(conversationId: string): Promise<Conversation> {
    return this.json<{ data: Conversation }>("GET", `/api/conversations/${conversationId}`).then((r) => r.data);
  }

  // ── support ─────────────────────────────────────────────────────────────

  createSupportReport(input: {
    category: string;
    message: string;
    context?: Record<string, unknown>;
    client?: string;
    screenshot?: { data: string; media_type: string } | null;
  }): Promise<{ id: string; status: string }> {
    return this.json<{ data: { id: string; status: string } }>("POST", "/api/support/reports", input).then((r) => r.data);
  }

  // ── creating a teammate from scratch ────────────────────────────────────

  getCatalog(): Promise<Catalog> {
    return this.json<{ data: Catalog }>("GET", "/api/catalog").then((r) => r.data);
  }

  /** per-provider set/not-set, e.g. {anthropic_api_key: true} */
  async inferenceCredentials(): Promise<Record<string, boolean>> {
    const r = await this.json<{ data: unknown }>("GET", "/api/account/inference-credentials");
    const d = r.data as Record<string, unknown> | Array<Record<string, unknown>>;
    const out: Record<string, boolean> = {};
    if (Array.isArray(d)) {
      for (const row of d) {
        const k = typeof row.provider === "string" ? row.provider : typeof row.name === "string" ? row.name : null;
        if (k) out[k] = row.set === true || row.configured === true || row.present === true;
      }
    } else if (d && typeof d === "object") {
      for (const [k, v] of Object.entries(d)) {
        out[k] = v === true || (typeof v === "object" && v !== null && ((v as Record<string, unknown>).set === true || (v as Record<string, unknown>).configured === true));
      }
    }
    return out;
  }

  /** Save (and validate against the provider) one inference credential for the account. */
  putInferenceCredential(provider: string, value: string): Promise<unknown> {
    return this.json("PUT", `/api/account/inference-credentials/${provider}`, { value, validate: true });
  }

  createAgent(input: {
    name: string;
    model: string;
    runtime: string;
    description?: string;
    system?: string;
    environment_id?: string | null;
  }): Promise<Agent> {
    return this.json<{ data: Agent }>("POST", "/api/agents", input).then((r) => r.data);
  }

  updateAgent(
    agentId: string,
    input: Partial<{
      name: string;
      model: string;
      runtime: string;
      description: string;
      system: string;
      skills: Skill[];
      mcp_servers: Record<string, McpServer>;
      environment_id: string | null;
      sandbox_provider: string | null;
      permission_policy: Record<string, PermissionVerdict>;
    }>,
  ): Promise<Agent> {
    return this.json<{ data: Agent }>("PUT", `/api/agents/${agentId}`, input).then((r) => r.data);
  }

  // ── environments: where a connector's token lives ───────────────────────

  createEnvironment(name: string): Promise<Environment> {
    return this.json<{ data: Environment }>("POST", "/api/environments", { name }).then((r) => r.data);
  }

  /** Keys only — values are write-only on the API. */
  async listEnvironmentSecrets(envId: string): Promise<EnvironmentSecret[]> {
    return (await this.json<{ data: EnvironmentSecret[] }>("GET", `/api/environments/${envId}/secrets`)).data;
  }

  putEnvironmentSecret(envId: string, key: string, value: string): Promise<unknown> {
    return this.json("POST", `/api/environments/${envId}/secrets`, { key, value });
  }

  generateAvatar(base: string, mood: string): Promise<{ data: string; media_type: string }> {
    return this.json<{ data: { data: string; media_type: string } }>("POST", "/api/avatars/generate", { base, mood }).then((r) => r.data);
  }

  putAvatar(agentId: string, data: string, media_type: string): Promise<unknown> {
    return this.json("PUT", `/api/agents/${agentId}/avatar`, { data, media_type });
  }

  // ── picker options ──────────────────────────────────────────────────────

  async listAgents(): Promise<Agent[]> {
    return (await this.json<{ data: Agent[] }>("GET", "/api/agents")).data;
  }

  async listEnvironments(): Promise<Environment[]> {
    return (await this.json<{ data: Environment[] }>("GET", "/api/environments")).data;
  }

  async listVaults(): Promise<Vault[]> {
    return (await this.json<{ data: Vault[] }>("GET", "/api/vaults")).data;
  }

  // ── stream ──────────────────────────────────────────────────────────────

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

  /**
   * One conversation's events, for a thread the team stream does not follow
   * (a side thread on a teammate's computer). Same payload as the team
   * stream's, minus `conversation_id`/`agent_id` — the caller adds them.
   */
  streamConversation(
    conversationId: string,
    opts: {
      lastEventId: string | null;
      streams: string[];
      signal: AbortSignal;
      onMessage: (msg: SseMessage) => void;
      onOpen?: () => void;
      onClose: (err?: unknown) => void;
    },
  ): Promise<void> {
    const qs = new URLSearchParams({ streams: opts.streams.join(",") });
    return readSse(`${this.baseUrl}/api/conversations/${conversationId}/stream?${qs}`, {
      headers: { authorization: `Bearer ${this.settings.apiKey}` },
      lastEventId: opts.lastEventId,
      signal: opts.signal,
      onMessage: opts.onMessage,
      onOpen: opts.onOpen,
      onClose: opts.onClose,
    });
  }

  /** A raw authenticated GET, for bytes (avatars, images) rather than JSON. */
  fetchRaw(path: string): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      headers: { authorization: `Bearer ${this.settings.apiKey}` },
    });
  }

  // ── plumbing ────────────────────────────────────────────────────────────

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
      const message =
        typeof obj.message === "string" ? obj.message : code ?? `${res.status} ${res.statusText}`;
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
        return "They're still working on the last message.";
      case "provisioning":
        return "Their computer is still starting — try again shortly.";
      case "runner_offline":
        return "Their machine is offline — the message waits until the runner reconnects.";
      case "no_runner_online":
        return "None of your runners is online — start `fountain runner` on the machine first.";
      case "subscription_required":
        return "An active Fountain subscription is required.";
      case "environment_not_allowed":
        return "That agent may not use that environment.";
      case "vault_not_allowed":
        return "That agent may not use that vault.";
      case "environment_not_found":
        return "Environment not found.";
      case "vault_not_found":
        return "Vault not found.";
      case "not_found":
        return "Not found.";
      case "permission_request_resolved":
        return "That request was already resolved — the thread shows how.";
      case "unknown_option":
        return "That option is not one the agent offered.";
      case "option_id_required":
        return "Pick one of the options the agent offered.";
      case "sprite_may_not_answer":
        return "A teammate may not answer its own permission request.";
      case "team_comms_not_enabled":
        return "Giving teammates an email and phone is not enabled for this account.";
      case "team_comms_not_configured":
        return "This instance has no AgentMail/AgentPhone keys configured.";
      case "contact_already_provisioned":
        return "They already have an email and phone.";
      case "provider_error": {
        const ch = err.body?.channel;
        const who = ch === "email" ? "AgentMail" : ch === "phone" ? "AgentPhone" : "AgentMail/AgentPhone";
        return `${who} refused: ${err.message}`;
      }
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
