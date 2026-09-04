/**
 * The Fountain API, as much of it as paddock needs. Every call carries the
 * bearer key; every error is an `ApiError` with the server's `error` string
 * when there was one. Plumbing ported from apps/mission-control.
 *
 * Two groups of calls carry the whole app:
 *
 *   - `openTab` is `POST /api/conversations {agent_id, sandbox_id}` — Fountain
 *     provisions nothing and attaches the conversation to a machine you
 *     already have. That is what makes a terminal tab a tab rather than a
 *     second computer.
 *   - `readFile`/`listFiles`/`diff` are the only way to learn anything about
 *     the machine without spending a turn. They are read-only by design and
 *     do not wake a parked box, which is why the drift check in `Machine.tsx`
 *     can run on a timer without costing anything.
 *
 * There is deliberately no exec call here, because Fountain does not have
 * one. Changing the box is `sendPrompt` on the ops tab and nothing else.
 */
import type {
  Agent,
  Catalog,
  Conversation,
  Environment,
  LogEvent,
  Me,
  Repository,
  Sandbox,
  SandboxDiff,
  SandboxFile,
  SandboxListing,
  SandboxMode,
  SecretKey,
  Vault,
} from "./types";
import { readSse, type SseMessage } from "../lib/sse";

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

/** Where a secret lives. Two genuinely different things — see `lib/machine.ts`. */
export type SecretParent = "environments" | "vaults";

/**
 * Fountain, through paddock.
 *
 * `baseUrl` is `/f/<paddock>` on this same origin — never Fountain itself.
 * The browser has no key: the session cookie says who is asking and the
 * server puts the machine owner's key on the call. That is what lets a guest
 * with no Fountain account use somebody else's box.
 *
 * The method names and shapes are unchanged from phase 1 on purpose, because
 * the proxy speaks Fountain's own shapes back. Only the base URL and the
 * absence of a bearer moved.
 */
export class FountainClient {
  constructor(readonly baseUrl: string) {}

  me(): Promise<Me> {
    return this.json<Me>("GET", "/api/auth/me");
  }

  getCatalog(): Promise<Catalog> {
    return this.json<{ data: Catalog }>("GET", "/api/catalog").then((r) => r.data);
  }

  // ── the identity: one agent, one environment, one vault, mutated in place ──

  async listAgents(search?: string): Promise<Agent[]> {
    const qs = search ? `?${new URLSearchParams({ search })}` : "";
    return (await this.json<{ data: Agent[] }>("GET", `/api/agents${qs}`)).data;
  }

  getAgent(id: string): Promise<Agent> {
    return this.json<{ data: Agent }>("GET", `/api/agents/${id}`).then((r) => r.data);
  }

  createAgent(input: {
    name: string;
    model: string;
    runtime: string;
    description?: string;
    system?: string;
    environment_id?: string;
    vault_id?: string;
    sandbox_mode?: SandboxMode;
    metadata?: Record<string, unknown>;
  }): Promise<Agent> {
    return this.json<{ data: Agent }>("POST", "/api/agents", input).then((r) => r.data);
  }

  /**
   * Change the agent without changing its id — which is what keeps the box.
   * `mcp_servers`, `skills`, `system` and `metadata` (where the config
   * revision lives) all move through here.
   */
  updateAgent(id: string, input: Partial<Agent>): Promise<Agent> {
    return this.json<{ data: Agent }>("PUT", `/api/agents/${id}`, input).then((r) => r.data);
  }

  async listEnvironments(): Promise<Environment[]> {
    return (await this.json<{ data: Environment[] }>("GET", "/api/environments")).data;
  }

  getEnvironment(id: string): Promise<Environment> {
    return this.json<{ data: Environment }>("GET", `/api/environments/${id}`).then((r) => r.data);
  }

  createEnvironment(input: { name: string; repositories?: Repository[]; packages?: string[]; setup_script?: string }): Promise<Environment> {
    return this.json<{ data: Environment }>("POST", "/api/environments", input).then((r) => r.data);
  }

  /** Same id, new contents. The machine built from the old contents keeps running. */
  updateEnvironment(id: string, input: { repositories?: Repository[]; packages?: string[]; setup_script?: string }): Promise<Environment> {
    return this.json<{ data: Environment }>("PUT", `/api/environments/${id}`, input).then((r) => r.data);
  }

  async listVaults(): Promise<Vault[]> {
    return (await this.json<{ data: Vault[] }>("GET", "/api/vaults")).data;
  }

  createVault(input: { name: string }): Promise<Vault> {
    return this.json<{ data: Vault }>("POST", "/api/vaults", input).then((r) => r.data);
  }

  // ── secrets: keys come back, values never do ──────────────────────────────

  /** The key names only. Fountain does not serve values back, and paddock never holds one. */
  async listSecretKeys(parent: SecretParent, id: string): Promise<SecretKey[]> {
    return (await this.json<{ data: SecretKey[] }>("GET", `/api/${parent}/${encodeURIComponent(id)}/secrets`)).data;
  }

  putSecret(parent: SecretParent, id: string, key: string, value: string): Promise<unknown> {
    return this.json("PUT", `/api/${parent}/${encodeURIComponent(id)}/secrets/${encodeURIComponent(key)}`, { value });
  }

  deleteSecret(parent: SecretParent, id: string, key: string): Promise<void> {
    return this.json<void>("DELETE", `/api/${parent}/${encodeURIComponent(id)}/secrets/${encodeURIComponent(key)}`);
  }

  // ── the box, and the tabs on it ───────────────────────────────────────────

  /**
   * The first tab: provisions the machine. `sandbox_mode: "persistent"` is
   * what makes it the agent identity's home rather than something torn down
   * when the conversation ends.
   *
   * `prompt` is required here because every app in the suite that starts a
   * fresh conversation sends one in this same call — salon
   * (`server/chats.ts`), and fountain-conversations, which will not even
   * submit the form without one (`src/pages/New.tsx`). Whether Fountain
   * *demands* it is not something this file knows; what it knows is that no
   * app has ever left it out, and paddock sending the first turn separately
   * was the one difference when starting a machine began returning 422.
   *
   * `POST /api/team` does provision a machine with no prompt at all, and a
   * teammate sits waiting for its first turn. That is the team endpoint rather
   * than this one, and paddock does not use it on purpose: it would put
   * paddock's agent on the account's actual team, where every other app would
   * list it. Salon avoids the same thing for the same reason.
   */
  startBox(input: {
    agent_id: string;
    prompt: string;
    title?: string;
    channel_id?: string;
    environment_id?: string;
    vault_id?: string;
    /** The agent's own default, so this call knows whether it has to override. */
    agentDefaultMode?: SandboxMode | null;
  }): Promise<Conversation> {
    const { agentDefaultMode, ...rest } = input;
    return this.json<{ data: Conversation }>("POST", "/api/conversations", {
      ...rest,
      // Only an override travels; the agent's own default stays implicit, the
      // same rule fountain-conversations follows in src/pages/New.tsx.
      ...(agentDefaultMode === "persistent" ? {} : { sandbox_mode: "persistent" satisfies SandboxMode }),
    }).then((r) => r.data);
  }

  /**
   * Every tab after the first. Fountain provisions nothing and attaches to
   * `sandbox_id`, which must have been built for the same agent, environment
   * and vault (404 `sandbox_not_found`, 409 `sandbox_not_attachable`, 422
   * `sandbox_identity_mismatch`). It sits `pending` until its first prompt.
   */
  openTab(input: { agent_id: string; sandbox_id: string; title?: string; channel_id?: string }): Promise<Conversation> {
    return this.json<{ data: Conversation }>("POST", "/api/conversations", input).then((r) => r.data);
  }

  getConversation(id: string): Promise<Conversation> {
    return this.json<{ data: Conversation }>("GET", `/api/conversations/${id}`).then((r) => r.data);
  }

  async listConversations(params: { agent_id?: string; status?: string } = {}): Promise<Conversation[]> {
    const qs = new URLSearchParams();
    if (params.agent_id) qs.set("agent_id", params.agent_id);
    if (params.status) qs.set("status", params.status);
    const q = qs.toString();
    return (await this.json<{ data: Conversation[] }>("GET", `/api/conversations${q ? `?${q}` : ""}`)).data;
  }

  sendPrompt(conversationId: string, prompt: string): Promise<{ status: string }> {
    return this.json("POST", `/api/conversations/${conversationId}/prompts`, { prompt });
  }

  interrupt(conversationId: string): Promise<unknown> {
    return this.json("POST", `/api/conversations/${conversationId}/interrupt`);
  }

  terminate(conversationId: string): Promise<void> {
    return this.json<void>("POST", `/api/conversations/${conversationId}/terminate`);
  }

  markRead(conversationId: string): Promise<void> {
    return this.json<void>("POST", `/api/conversations/${conversationId}/read`);
  }

  /** Every event of one tab on the given streams, oldest first, paging until drained. */
  async listAllEvents(conversationId: string, streams: string[]): Promise<LogEvent[]> {
    const out: LogEvent[] = [];
    let after: number | null = null;
    for (;;) {
      const qs = new URLSearchParams({ limit: "1000", streams: streams.join(","), blocks: "true" });
      if (after !== null) qs.set("after", String(after));
      const page: { data: LogEvent[]; meta: { has_more: boolean; next_cursor: number | null } } = await this.json(
        "GET",
        `/api/conversations/${conversationId}/events?${qs}`,
      );
      out.push(...page.data);
      if (!page.meta.has_more || page.meta.next_cursor === null) break;
      after = page.meta.next_cursor;
    }
    return out;
  }

  // ── reading the machine: free, and it never wakes a parked box ─────────────

  getSandbox(id: string): Promise<Sandbox> {
    return this.json<{ data: Sandbox }>("GET", `/api/sandboxes/${encodeURIComponent(id)}`).then((r) => r.data);
  }

  listFiles(sandboxId: string, path: string): Promise<SandboxListing> {
    const qs = new URLSearchParams({ path });
    return this.json<{ data: SandboxListing }>("GET", `/api/sandboxes/${encodeURIComponent(sandboxId)}/files?${qs}`).then((r) => r.data);
  }

  readFile(sandboxId: string, path: string): Promise<SandboxFile> {
    const qs = new URLSearchParams({ path });
    return this.json<{ data: SandboxFile }>("GET", `/api/sandboxes/${encodeURIComponent(sandboxId)}/file?${qs}`).then((r) => r.data);
  }

  diff(sandboxId: string, path: string): Promise<SandboxDiff> {
    const qs = new URLSearchParams({ path });
    return this.json<{ data: SandboxDiff }>("GET", `/api/sandboxes/${encodeURIComponent(sandboxId)}/diff?${qs}`).then((r) => r.data);
  }

  // ── stream ────────────────────────────────────────────────────────────────

  /**
   * One tab's live tail.
   *
   * Phase 1 used Fountain's account-wide `/api/events/stream`, which carries
   * every conversation the key can see. That is not proxyable: a guest would
   * be handed the owner's other work, and filtering a live stream server-side
   * means parsing it. One connection per tab, scoped by the proxy to a tab
   * that is genuinely on this machine, is the honest version.
   */
  streamConversation(opts: {
    conversationId: string;
    lastEventId: string | null;
    streams: string[];
    signal: AbortSignal;
    onMessage: (msg: SseMessage) => void;
    onOpen?: () => void;
    onClose: (err?: unknown) => void;
  }): Promise<void> {
    const qs = new URLSearchParams({ streams: opts.streams.join(","), blocks: "true" });
    return readSse(`${this.baseUrl}/api/conversations/${encodeURIComponent(opts.conversationId)}/stream?${qs}`, {
      lastEventId: opts.lastEventId,
      signal: opts.signal,
      onMessage: opts.onMessage,
      onOpen: opts.onOpen,
      onClose: opts.onClose,
    });
  }

  // ── plumbing ──────────────────────────────────────────────────────────────

  private async json<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
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
      const message = typeof obj.message === "string" ? obj.message : (code ?? `${res.status} ${res.statusText}`);
      const ra = res.headers.get("retry-after");
      throw new ApiError(res.status, code, message, ra ? Number(ra) : null, parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null);
    }
    return parsed as T;
  }
}

/**
 * A human line for an API failure, in the app's voice.
 *
 * `sandbox_at_capacity` is the one that matters most here and is not really an
 * error: turns on one box serialise, so a tab prompting while another tab holds
 * the machine is ordinary. `Terminal.tsx` catches it before this and queues.
 */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "sandbox_at_capacity":
        return "Another tab is mid-turn on this box. One turn at a time.";
      case "sandbox_identity_mismatch":
        return "That machine was built for a different agent, environment or vault.";
      case "sandbox_runtime_mismatch":
        return "The runtime changed since this box was built — that needs a new machine.";
      case "sandbox_not_attachable":
        return "The box cannot take a tab right now — it is still starting, or it is gone.";
      case "sandbox_not_found":
        return "That machine does not exist (or is not yours).";
      case "conversation_busy":
        return "This tab is still working on the last thing you said.";
      case "provisioning":
        return "The box is still starting — try again shortly.";
      default:
        if (err.status === 401) return "That API key was not accepted.";
        if (err.status === 410) return "That tab is gone — open a new one.";
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
