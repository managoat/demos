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

/**
 * A claimable principal: the tenant an unclaimed computer belongs to.
 *
 * `principal_id` is the value that matters and the reason this API exists. A
 * sandbox's name contains its tenant id, so moving resources between accounts
 * produces a *different* machine; a claim attaches an owner and touches no
 * resource, which is why `principal_id` — and every id under it — reads the
 * same before and after. See fountain#1551 and its ADR 0044.
 *
 * `api_key` and `claim_token` come back exactly once, on create. Fountain
 * stores only their hashes, so a replayed `Idempotency-Key` answers with the
 * same principal and a *new* pair, and the first pair stops working.
 */
export interface ClaimableGrant {
  id: string;
  principal_id: string;
  /** Only on create. The credential the machine runs on until it is claimed. */
  api_key?: string;
  /** Only on create. The capability that claims it. Never reaches a browser. */
  claim_token?: string;
  status: "unclaimed" | "claimed" | "expired" | "released" | string;
  expires_at: string | null;
}

/** What a claim answers: the new owner, the unchanged principal, a live key. */
export interface ClaimedPrincipal {
  user: { id: string; email: string };
  principal_id: string;
  status: string;
  /** Replaces the provisional key, which the claim revoked. */
  api_key: string;
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

  // ── claimable principals (fountain#1551) ────────────────────────────────
  //
  // The first three are called on this application's own full-scope key,
  // except `claim`, which is called on the *claiming account's* key — that is
  // what tells Fountain whose account is now behind the principal. All four
  // are behind `:require_full_scope`, so the key a principal itself holds
  // cannot reach any of them: it can neither open a second principal nor
  // release its own grant.

  /**
   * Open one. The idempotency key makes a retry a replay: the same principal
   * comes back with a fresh pair of secrets, rather than a second machine
   * nobody is looking at and this application is paying for.
   */
  openClaimable(body: {
    application_id: string;
    expires_in: number;
    limits: { max_live_sandboxes: number; max_cost_usd: number };
    metadata: Record<string, string>;
  }, idempotencyKey: string): Promise<ClaimableGrant> {
    return this.data<ClaimableGrant>("POST", "/api/claimable-users", body, idempotencyKey);
  }

  /** Read a grant back, to settle what a lost response actually did. */
  readClaimable(id: string): Promise<ClaimableGrant> {
    return this.data<ClaimableGrant>("GET", `/api/claimable-users/${encodeURIComponent(id)}`);
  }

  /**
   * Attach an owner. Called on the claiming account's key, and idempotent by
   * the same argument as create: a lost response must not be able to leave a
   * principal claimed upstream and unclaimed here forever.
   */
  claim(id: string, claimToken: string, idempotencyKey: string): Promise<ClaimedPrincipal> {
    return this.data<ClaimedPrincipal>("POST", `/api/claimable-users/${encodeURIComponent(id)}/claim`, { claim_token: claimToken }, idempotencyKey);
  }

  /** Give one back: credentials revoked, sandboxes destroyed, the grant refunded. */
  releaseClaimable(id: string): Promise<void> {
    return this.json<void>("DELETE", `/api/claimable-users/${encodeURIComponent(id)}`);
  }

  /**
   * One request, forwarded as-is. The proxy has already decided this call is
   * allowed; this just puts the owner's key on it and hands the response
   * back untouched, streaming body included (SSE depends on that).
   */
  raw(
    method: string,
    path: string,
    init: { body?: BodyInit | null; signal?: AbortSignal; accept?: string; idempotencyKey?: string } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.apiKey}` };
    if (init.accept) headers.accept = init.accept;
    if (init.body != null) headers["content-type"] = "application/json";
    // Never forwarded from a client request: the only calls that carry one are
    // the two below, whose keys are derived from a paddock id so a retry is a
    // replay rather than a second machine.
    if (init.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;
    return fetch(`${this.baseUrl}${path}`, { method, headers, body: init.body ?? undefined, signal: init.signal });
  }

  /** A route that answers `{ data: … }`, unwrapped. */
  private async data<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    return (await this.json<{ data: T }>(method, path, body, idempotencyKey)).data;
  }

  private async json<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const res = await this.raw(method, path, { body: body === undefined ? null : JSON.stringify(body), accept: "application/json", idempotencyKey });
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
