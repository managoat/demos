/**
 * The Fountain API, as much of it as this app needs. Every call carries the
 * bearer key; every error is an `ApiError` with the server's `error` string
 * when there was one.
 */
import type {
  Agent,
  AgentInput,
  Catalog,
  Conversation,
  Environment,
  EnvironmentInput,
  ImageInput,
  LogEvent,
  Me,
  SandboxDetail,
  SandboxMode,
  Secret,
  TreeNode,
  Turn,
  Vault,
  Billing,
} from "./types";
import { readSse, type SseMessage } from "../lib/sse";
import type { Settings } from "../lib/settings";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string | null,
    message: string,
    public retryAfter: number | null = null,
  ) {
    super(message);
  }
}

export interface StartInput {
  agent_id: string;
  prompt?: string;
  images?: ImageInput[];
  environment_id?: string;
  vault_id?: string;
  parent_conversation_id?: string;
  title?: string;
  /** Attach to a machine you already have instead of provisioning one (ADR 0023). */
  sandbox_id?: string;
  /** Override the agent's default; ignored when `sandbox_id` is set. */
  sandbox_mode?: SandboxMode;
}

export const THREAD_STREAMS = ["acp", "stdout", "stderr", "stage"];

export class FountainClient {
  constructor(private settings: Settings) {}

  get baseUrl(): string {
    return this.settings.baseUrl;
  }

  me(): Promise<Me> {
    return this.json<Me>("GET", "/api/auth/me");
  }

  /**
   * The account's billing state, or null where the server runs with billing
   * disabled (404 `billing_disabled`) or the key lacks the scope (403) —
   * both mean "nothing is gating prompts here".
   */
  async billing(): Promise<Billing | null> {
    try {
      return (await this.json<{ data: Billing }>("GET", "/api/account/billing")).data;
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 403)) return null;
      throw err;
    }
  }

  // ── conversations ───────────────────────────────────────────────────────

  async listConversations(rootsOnly = false): Promise<Conversation[]> {
    const qs = rootsOnly ? "?roots_only=true" : "";
    return (await this.json<{ data: Conversation[] }>("GET", `/api/conversations${qs}`)).data;
  }

  async getConversation(id: string): Promise<Conversation> {
    return (await this.json<{ data: Conversation }>("GET", `/api/conversations/${id}`)).data;
  }

  async startConversation(input: StartInput): Promise<Conversation> {
    return (await this.json<{ data: Conversation }>("POST", "/api/conversations", input)).data;
  }

  deleteConversation(id: string): Promise<void> {
    return this.json<void>("DELETE", `/api/conversations/${id}`);
  }

  terminate(id: string): Promise<unknown> {
    return this.json("POST", `/api/conversations/${id}/terminate`);
  }

  interrupt(id: string): Promise<unknown> {
    return this.json("POST", `/api/conversations/${id}/interrupt`);
  }

  prompt(id: string, prompt: string, images: ImageInput[] = []): Promise<unknown> {
    return this.json("POST", `/api/conversations/${id}/prompts`, images.length ? { prompt, images } : { prompt });
  }

  markRead(id: string): Promise<void> {
    return this.json<void>("POST", `/api/conversations/${id}/read`);
  }

  async listTurns(id: string): Promise<Turn[]> {
    return (await this.json<{ data: Turn[] }>("GET", `/api/conversations/${id}/turns`)).data;
  }

  async tree(id: string): Promise<TreeNode[]> {
    return (await this.json<{ data: TreeNode[] }>("GET", `/api/conversations/${id}/tree`)).data;
  }

  /** Every event of the conversation, with server-parsed blocks, oldest first, paging until drained. */
  async listAllEvents(id: string, streams: string[] = THREAD_STREAMS): Promise<LogEvent[]> {
    const out: LogEvent[] = [];
    let after: number | null = null;
    for (;;) {
      const qs = new URLSearchParams({ limit: "1000", streams: streams.join(","), blocks: "true" });
      if (after !== null) qs.set("after", String(after));
      const page: { data: LogEvent[]; meta: { has_more: boolean; next_cursor: number | null } } =
        await this.json("GET", `/api/conversations/${id}/events?${qs}`);
      out.push(...page.data);
      if (!page.meta.has_more || page.meta.next_cursor === null) break;
      after = page.meta.next_cursor;
    }
    return out;
  }

  imageUrl(conversationId: string, turnId: string, position: number): string {
    return `/api/conversations/${conversationId}/turns/${turnId}/images/${position}`;
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

  // ── sandboxes ───────────────────────────────────────────────────────────

  /** Every machine the caller has provisioned, newest first, with the conversations on each. */
  async listSandboxes(statuses?: string[]): Promise<SandboxDetail[]> {
    const qs = statuses?.length ? `?status=${encodeURIComponent(statuses.join(","))}` : "";
    return (await this.json<{ data: SandboxDetail[] }>("GET", `/api/sandboxes${qs}`)).data;
  }

  async getSandbox(id: string): Promise<SandboxDetail> {
    return (await this.json<{ data: SandboxDetail }>("GET", `/api/sandboxes/${id}`)).data;
  }

  // ── agents / environments / vaults ──────────────────────────────────────

  async catalog(): Promise<Catalog> {
    return (await this.json<{ data: Catalog }>("GET", "/api/catalog")).data;
  }

  async getAgent(id: string): Promise<Agent> {
    return (await this.json<{ data: Agent }>("GET", `/api/agents/${id}`)).data;
  }

  async createAgent(input: AgentInput): Promise<Agent> {
    return (await this.json<{ data: Agent }>("POST", "/api/agents", input)).data;
  }

  async updateAgent(id: string, input: Partial<AgentInput>): Promise<Agent> {
    return (await this.json<{ data: Agent }>("PUT", `/api/agents/${id}`, input)).data;
  }

  deleteAgent(id: string): Promise<void> {
    return this.json<void>("DELETE", `/api/agents/${id}`);
  }

  async putAvatar(id: string, image: ImageInput): Promise<Agent> {
    return (await this.json<{ data: Agent }>("PUT", `/api/agents/${id}/avatar`, image)).data;
  }

  deleteAvatar(id: string): Promise<void> {
    return this.json<void>("DELETE", `/api/agents/${id}/avatar`);
  }

  async generateAvatar(base: string, mood: string): Promise<ImageInput> {
    return (await this.json<{ data: ImageInput }>("POST", "/api/avatars/generate", { base, mood })).data;
  }

  async getEnvironment(id: string): Promise<Environment> {
    return (await this.json<{ data: Environment }>("GET", `/api/environments/${id}`)).data;
  }

  async createEnvironment(input: EnvironmentInput): Promise<Environment> {
    return (await this.json<{ data: Environment }>("POST", "/api/environments", input)).data;
  }

  async updateEnvironment(id: string, input: Partial<EnvironmentInput>): Promise<Environment> {
    return (await this.json<{ data: Environment }>("PUT", `/api/environments/${id}`, input)).data;
  }

  deleteEnvironment(id: string): Promise<void> {
    return this.json<void>("DELETE", `/api/environments/${id}`);
  }

  async listEnvSecrets(envId: string): Promise<Secret[]> {
    return (await this.json<{ data: Secret[] }>("GET", `/api/environments/${envId}/secrets`)).data;
  }

  putEnvSecret(envId: string, key: string, value: string): Promise<unknown> {
    return this.json("POST", `/api/environments/${envId}/secrets`, { key, value });
  }

  deleteEnvSecret(envId: string, key: string): Promise<void> {
    return this.json<void>("DELETE", `/api/environments/${envId}/secrets/${encodeURIComponent(key)}`);
  }

  async getVault(id: string): Promise<Vault> {
    return (await this.json<{ data: Vault }>("GET", `/api/vaults/${id}`)).data;
  }

  async createVault(input: { name: string; description?: string }): Promise<Vault> {
    return (await this.json<{ data: Vault }>("POST", "/api/vaults", input)).data;
  }

  async updateVault(id: string, input: { name?: string; description?: string }): Promise<Vault> {
    return (await this.json<{ data: Vault }>("PUT", `/api/vaults/${id}`, input)).data;
  }

  deleteVault(id: string): Promise<void> {
    return this.json<void>("DELETE", `/api/vaults/${id}`);
  }

  async listVaultSecrets(vaultId: string): Promise<Secret[]> {
    return (await this.json<{ data: Secret[] }>("GET", `/api/vaults/${vaultId}/secrets`)).data;
  }

  putVaultSecret(vaultId: string, key: string, value: string): Promise<unknown> {
    return this.json("POST", `/api/vaults/${vaultId}/secrets`, { key, value });
  }

  deleteVaultSecret(vaultId: string, key: string): Promise<void> {
    return this.json<void>("DELETE", `/api/vaults/${vaultId}/secrets/${encodeURIComponent(key)}`);
  }

  // ── streams ─────────────────────────────────────────────────────────────

  /** Every conversation's events on one connection, with blocks. Resolves when the server closes. */
  streamAll(opts: {
    lastEventId: string | null;
    signal: AbortSignal;
    onMessage: (msg: SseMessage) => void;
    onOpen?: () => void;
    onClose: (err?: unknown) => void;
  }): Promise<void> {
    const qs = new URLSearchParams({ streams: THREAD_STREAMS.join(","), blocks: "true" });
    return readSse(`${this.baseUrl}/api/events/stream?${qs}`, {
      headers: { authorization: `Bearer ${this.settings.apiKey}` },
      lastEventId: opts.lastEventId,
      signal: opts.signal,
      onMessage: opts.onMessage,
      onOpen: opts.onOpen,
      onClose: opts.onClose,
    });
  }

  /** A raw authenticated GET, for bytes (images, avatars). */
  fetchRaw(path: string): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      headers: { authorization: `Bearer ${this.settings.apiKey}` },
    });
  }

  // ── plumbing ────────────────────────────────────────────────────────────

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.settings.apiKey}`,
      accept: "application/json",
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
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
      const obj = (parsed ?? {}) as { error?: unknown; message?: unknown; errors?: unknown };
      const code = typeof obj.error === "string" ? obj.error : null;
      const message =
        typeof obj.message === "string"
          ? obj.message
          : changesetMessage(obj.errors) ?? code ?? `${res.status} ${res.statusText}`;
      const ra = res.headers.get("retry-after");
      throw new ApiError(res.status, code, message, ra ? Number(ra) : null);
    }
    return parsed as T;
  }
}

/** Ecto changeset errors — `{errors: {field: ["msg"]}}` — as one line. */
function changesetMessage(errors: unknown): string | null {
  if (!errors || typeof errors !== "object") return null;
  const parts: string[] = [];
  for (const [field, msgs] of Object.entries(errors as Record<string, unknown>)) {
    if (Array.isArray(msgs)) parts.push(`${field} ${msgs.map(String).join(", ")}`);
    else if (typeof msgs === "string") parts.push(`${field} ${msgs}`);
  }
  return parts.length ? parts.join("; ") : null;
}

/** A human line for an API failure. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "conversation_busy":
        return "A turn is already running — wait for it, or interrupt.";
      case "provisioning":
        return "The conversation is still provisioning — try again shortly.";
      case "subscription_required":
        return "An active subscription is required to send a prompt.";
      case "sandbox_quota_exceeded":
        return err.message || "You are at your concurrent sandbox limit. Terminate a conversation before starting another.";
      case "conversation_terminated":
        return "Conversation is terminated and can't be resumed.";
      case "no_agent":
        return "Conversation has no agent — can't resume.";
      case "sandbox_probe_failed":
        return "Couldn't reach the sandbox provider to wake the conversation — try again shortly.";
      case "runner_offline":
        return "This conversation's machine is offline — it wakes when the runner reconnects.";
      case "no_runner_online":
        return "This agent runs on a self-hosted runner and none of yours is connected. Start `fountain runner` on the machine and try again.";
      case "account_suspended":
        return "This account is suspended.";
      case "parent_conversation_not_found":
        return "Parent conversation not found.";
      case "environment_not_allowed":
        return "That agent may not use that environment.";
      case "vault_not_allowed":
        return "That agent may not use that vault.";
      case "environment_not_found":
        return "Environment not found.";
      case "vault_not_found":
        return "Vault not found.";
      case "sandbox_not_found":
        return "That machine does not exist (or is not yours).";
      case "sandbox_not_attachable":
        return "That machine cannot take a conversation right now — it is still starting, or it is gone.";
      case "sandbox_identity_mismatch":
        return "That machine was built for a different agent, environment or vault.";
      case "sandbox_runtime_mismatch":
        return "The agent's runtime changed since that machine was built — start on a fresh one.";
      case "sandbox_at_capacity":
        return "That machine is busy with another conversation's turn — wait for it to finish.";
      case "not_found":
        return "Not found.";
      default:
        if (err.status === 401) return "That API key was not accepted.";
        if (err.status === 410) return "That conversation is gone — start a new one.";
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
