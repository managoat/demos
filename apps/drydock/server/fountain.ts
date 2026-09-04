/**
 * Fountain, on this server's key.
 *
 * Every other app in this suite hands the browser a Fountain key of its own
 * (dns-desk, arena) or holds one key per signed-in person (paddock, salon).
 * Drydock holds exactly one, for everybody, because sign-in is GitHub and
 * a person here has no Fountain account to spend. That makes this file the
 * whole of the app's access to Fountain — there is no proxy through which a
 * browser can reach a path this file does not name.
 *
 * So it is typed rather than forwarding. The one exception is `stream`, which
 * has to hand back a live body untouched or server-sent events stop being
 * events.
 */
import { HttpError } from "./http";
import type { Agent, Catalog, Conversation, Environment, Repository, Sandbox, SandboxDiff, SandboxFile, SandboxListing, Vault } from "../shared/fountain-types";

export class FountainHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
  }
}

export interface ConversationSummary {
  id: string;
  title: string | null;
  sandbox_id: string | null;
  agent_id: string | null;
  environment_id?: string | null;
  vault_id?: string | null;
  runtime: string;
  status: string;
  channel_id: string | null;
  turn_count: number;
  last_active_at: string | null;
  inserted_at: string;
  [k: string]: unknown;
}

export class Fountain {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  // ── what this Fountain can do ────────────────────────────────────────

  catalog(): Promise<Catalog> {
    return this.data<Catalog>("GET", "/api/catalog");
  }

  me(): Promise<{ id: string; email: string }> {
    return this.data("GET", "/api/auth/me");
  }

  // ── the three records a project is ───────────────────────────────────

  createEnvironment(body: {
    name: string;
    repositories?: Repository[];
    packages?: Record<string, string[]>;
    setup_script?: string;
  }): Promise<Environment> {
    return this.data("POST", "/api/environments", body);
  }

  getEnvironment(id: string): Promise<Environment> {
    return this.data("GET", `/api/environments/${encodeURIComponent(id)}`);
  }

  updateEnvironment(id: string, body: Partial<Environment>): Promise<Environment> {
    return this.data("PUT", `/api/environments/${encodeURIComponent(id)}`, body);
  }

  createVault(body: { name: string }): Promise<Vault> {
    return this.data("POST", "/api/vaults", body);
  }

  createAgent(body: Record<string, unknown>): Promise<Agent> {
    return this.data("POST", "/api/agents", body);
  }

  getAgent(id: string): Promise<Agent> {
    return this.data("GET", `/api/agents/${encodeURIComponent(id)}`);
  }

  updateAgent(id: string, body: Record<string, unknown>): Promise<Agent> {
    return this.data("PUT", `/api/agents/${encodeURIComponent(id)}`, body);
  }

  deleteAgent(id: string): Promise<void> {
    return this.data("DELETE", `/api/agents/${encodeURIComponent(id)}`);
  }

  deleteEnvironment(id: string): Promise<void> {
    return this.data("DELETE", `/api/environments/${encodeURIComponent(id)}`);
  }

  deleteVault(id: string): Promise<void> {
    return this.data("DELETE", `/api/vaults/${encodeURIComponent(id)}`);
  }

  /**
   * Write one secret.
   *
   * `POST …/secrets` with the key *in the body*, which upserts. Not
   * `PUT …/secrets/:key` — that route reads like it should exist and does not:
   * the router declares `only: [:index, :create, :delete]` and the controller
   * has three functions to match. Paddock calls the PUT and its tests mock the
   * route, so they pass and the call would 404 against a real Fountain. Worth
   * the paragraph, because the mistake is invisible until deployment.
   *
   * The only call in this file whose *body* must never be logged, which is why
   * `data` logs the path and the status and nothing else. `store` picks which
   * of the two places it goes: an environment secret is an ordinary env var
   * inside the box, and a vault secret never touches the box at all where a
   * broker is configured. Drydock's clone token goes in the vault for
   * exactly that reason.
   */
  putSecret(store: "environments" | "vaults", id: string, key: string, value: string): Promise<void> {
    return this.data("POST", `/api/${store}/${encodeURIComponent(id)}/secrets`, { key, value });
  }

  deleteSecret(store: "environments" | "vaults", id: string, key: string): Promise<void> {
    return this.data("DELETE", `/api/${store}/${encodeURIComponent(id)}/secrets/${encodeURIComponent(key)}`);
  }

  secretKeys(store: "environments" | "vaults", id: string): Promise<{ key: string; updated_at?: string | null }[]> {
    return this.data("GET", `/api/${store}/${encodeURIComponent(id)}/secrets`);
  }

  // ── conversations ────────────────────────────────────────────────────

  async listConversations(agentId?: string): Promise<ConversationSummary[]> {
    const qs = agentId ? `?${new URLSearchParams({ agent_id: agentId })}` : "";
    return this.data<ConversationSummary[]>("GET", `/api/conversations${qs}`);
  }

  getConversation(id: string): Promise<Conversation> {
    return this.data("GET", `/api/conversations/${encodeURIComponent(id)}`);
  }

  /**
   * Open a thread: one conversation, and one machine of its own.
   *
   * Three things on this body are load-bearing and none of them is obvious.
   *
   * **The whole identity, not half of it.** A disk is built for
   * `(agent, environment, vault)`, so naming only the agent asks for a
   * *different* identity — one with no environment and no vault — and gets a
   * different machine. It does not fail loudly; it quietly hands you a second
   * box with no repository on it.
   *
   * **`sandbox_mode: "ephemeral"`.** This is drydock's whole isolation
   * story in one field: Fountain provisions a machine for this conversation
   * alone and reclaims it when the conversation ends. Omit it and the agent's
   * own mode decides, which is the same value today and would be a silent
   * change of model the day somebody edits the agent.
   *
   * **A `prompt` in this same call.** Every app in the suite that starts a
   * conversation sends the first turn here rather than separately, and
   * paddock's habit of splitting the two is exactly what started returning
   * 422. So the opening turn — the one that cuts the branch — travels with the
   * create.
   *
   * `fresh: true` because `channel_id` otherwise *resumes*: Fountain answers
   * 200 with the channel's existing conversation instead of 201 with a new
   * one. A thread's channel names its own slug, so a collision means a slug
   * was reused, and resuming would silently drop the new thread onto an old
   * machine.
   */
  createConversation(body: {
    agent_id: string;
    environment_id?: string | null;
    vault_id?: string | null;
    title?: string;
    channel_id: string;
    prompt: string;
  }): Promise<Conversation> {
    return this.data("POST", "/api/conversations", {
      agent_id: body.agent_id,
      ...(body.environment_id ? { environment_id: body.environment_id } : {}),
      ...(body.vault_id ? { vault_id: body.vault_id } : {}),
      ...(body.title ? { title: body.title } : {}),
      channel_id: body.channel_id,
      sandbox_mode: "ephemeral",
      fresh: true,
      prompt: body.prompt,
    });
  }

  prompt(conversationId: string, text: string): Promise<unknown> {
    return this.data("POST", `/api/conversations/${encodeURIComponent(conversationId)}/prompts`, { prompt: text });
  }

  interrupt(conversationId: string): Promise<unknown> {
    return this.data("POST", `/api/conversations/${encodeURIComponent(conversationId)}/interrupt`, {});
  }

  terminate(conversationId: string): Promise<unknown> {
    return this.data("POST", `/api/conversations/${encodeURIComponent(conversationId)}/terminate`, {});
  }

  turns(conversationId: string): Promise<unknown> {
    return this.data("GET", `/api/conversations/${encodeURIComponent(conversationId)}/turns`);
  }

  events(conversationId: string): Promise<unknown> {
    return this.data("GET", `/api/conversations/${encodeURIComponent(conversationId)}/events`);
  }

  /**
   * The live transcript, handed back with its body still open.
   *
   * Not `data()`: reading this to completion is what a server-sent stream
   * never does. The caller pipes it straight to the browser.
   */
  stream(conversationId: string, signal: AbortSignal): Promise<Response> {
    return this.raw("GET", `/api/conversations/${encodeURIComponent(conversationId)}/stream`, {
      accept: "text/event-stream",
      signal,
    });
  }

  /**
   * End a thread, and the machine with it.
   *
   * On an ephemeral sandbox this is the whole cleanup: Fountain destroys the
   * box because nothing else is attached to it. That is the half of the
   * ephemeral trade that pays — a thread costs nothing once it is closed.
   */
  terminateConversation(id: string): Promise<unknown> {
    return this.data("POST", `/api/conversations/${encodeURIComponent(id)}/terminate`, {});
  }

  // ── reading the machine, for free ────────────────────────────────────

  sandbox(id: string): Promise<Sandbox> {
    return this.data("GET", `/api/sandboxes/${encodeURIComponent(id)}`);
  }

  listing(sandboxId: string, path: string): Promise<SandboxListing> {
    return this.data("GET", `/api/sandboxes/${encodeURIComponent(sandboxId)}/files?${new URLSearchParams({ path })}`);
  }

  file(sandboxId: string, path: string): Promise<SandboxFile> {
    return this.data("GET", `/api/sandboxes/${encodeURIComponent(sandboxId)}/file?${new URLSearchParams({ path })}`);
  }

  diff(sandboxId: string, path: string): Promise<SandboxDiff> {
    return this.data("GET", `/api/sandboxes/${encodeURIComponent(sandboxId)}/diff?${new URLSearchParams({ path })}`);
  }

  // ── plumbing ─────────────────────────────────────────────────────────

  raw(
    method: string,
    path: string,
    init: { body?: BodyInit | null; signal?: AbortSignal; accept?: string; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.apiKey}`, ...init.headers };
    if (init.accept) headers.accept = init.accept;
    if (init.body != null) headers["content-type"] = "application/json";
    return fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: init.body ?? undefined,
      // A stream has no deadline; everything else gets a minute. Passing an
      // already-aborted request signal through is how a browser closing a tab
      // closes the upstream stream too, rather than leaving it running.
      signal: init.signal ?? AbortSignal.timeout(60_000),
    });
  }

  /** A call whose body is `{data: …}`, unwrapped — which is every one of them. */
  private async data<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, path, {
      body: body === undefined ? null : JSON.stringify(body),
      accept: "application/json",
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
      // The path and the status, never the body we sent — it may be a secret
      // value on its way to /secrets/:key.
      if (res.status >= 400) console.error(`drydock: fountain ${res.status} on ${method} ${path.split("?")[0]}: ${message}`);
      throw new FountainHttpError(res.status, code, message);
    }
    const wrapped = parsed as { data?: T } | null;
    return (wrapped && typeof wrapped === "object" && "data" in wrapped ? wrapped.data : parsed) as T;
  }
}

/** A Fountain failure as one of ours, preserving what the caller needs. */
export function asHttpError(err: unknown, whatFor: string): HttpError {
  if (err instanceof FountainHttpError) {
    if (err.status === 401 || err.status === 403) {
      return new HttpError(502, "fountain_rejected", "Fountain rejected this deployment's key. Drydock cannot build machines until that is fixed.");
    }
    if (err.code === "sandbox_at_capacity") {
      return new HttpError(409, "machine_busy", "This machine is already taking a turn. One track at a time — yours is queued.");
    }
    if (err.code === "sandbox_identity_mismatch") {
      return new HttpError(409, "identity_mismatch", "This project's machine no longer matches its identity. Rebuild it from the project menu.");
    }
    return new HttpError(err.status >= 500 ? 502 : err.status, err.code ?? "fountain_error", err.message);
  }
  return new HttpError(502, "fountain_unreachable", `Could not reach Fountain to ${whatFor}.`);
}
