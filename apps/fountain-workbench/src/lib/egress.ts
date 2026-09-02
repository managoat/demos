/**
 * The egress broker, as a conversation sees it (Fountain ADR 0019).
 *
 * On a brokered account the sandbox never holds a credential. It is handed a
 * placeholder and a proxy address; the broker puts the real value on the wire
 * for the hosts the owner's *bindings* name, passes other hosts through with
 * nothing attached, and — on a `limited` environment — refuses hosts that are
 * not on the list. Fountain keeps the broker's request log per conversation
 * for a while after it ends, and `GET /api/conversations/:id/egress` pages it
 * newest first.
 *
 * Two signals, folded here. The log is the *effect*: each request, the host,
 * whether a credential went with it and which. The `broker` stage events on
 * the conversation's own feed are the *intent*: `started` names the secrets
 * withheld from the sandbox, `done` names the vault the credentials sat in,
 * `failed` says why the conversation could not start. Neither carries a
 * value, ever, so nothing here has one to hide.
 */
import type { Fountain } from "@agentshit/fountain-sdk";
import type { LogEvent } from "../types";
import { dataOf } from "./digest";

/** One request the broker saw, as Fountain's `EgressEvent` reports it. */
export interface EgressEvent {
  id: number;
  at?: string | null;
  method: string;
  /** Host and port, as the sandbox dialed it. */
  host: string;
  path: string;
  /** The service that matched — the binding's slug — or null for a request that went through bare. */
  service?: string | null;
  credential_keys: string[];
  /** The upstream's status, or the broker's refusal. */
  status?: number | null;
  latency_ms?: number | null;
  /** The broker's refusal code, e.g. `no_match`. */
  error?: string | null;
}

export interface EgressPage {
  data: EgressEvent[];
  next?: number | null;
  brokered: boolean;
}

/** The page size. Big enough that a short conversation is one page; small enough that a busy one paints. */
export const EGRESS_PAGE = 50;

export function fetchEgress(fountain: Fountain, conversationId: string, before?: number | null): Promise<EgressPage> {
  return fountain.request<EgressPage>("GET", `/api/conversations/${encodeURIComponent(conversationId)}/egress`, {
    query: { limit: EGRESS_PAGE, before: before ?? undefined },
  });
}

/**
 * What the broker did with one request. `refused` never reached the host;
 * `brokered` went with a credential attached; `bare` went through with
 * nothing — the host matched no binding, and on an unrestricted environment
 * that is allowed.
 */
export type Outcome = "refused" | "brokered" | "bare";

export function outcomeOf(ev: Pick<EgressEvent, "service" | "credential_keys" | "error">): Outcome {
  if (ev.error) return "refused";
  if (ev.service || ev.credential_keys.length > 0) return "brokered";
  return "bare";
}

/** The refusal codes the broker uses, in words a person can act on. */
export function refusalOf(code: string): string {
  switch (code) {
    case "no_match":
      return "not on the environment's allowed hosts";
    case "vault_mismatch":
      return "another conversation's credentials — refused";
    default:
      return code;
  }
}

/** Per-host totals over the rows read so far — the shape of a conversation's traffic at a glance. */
export interface HostSummary {
  host: string;
  requests: number;
  outcome: Outcome;
  /** Every credential that went to this host, deduplicated. */
  keys: string[];
}

export function summarize(events: EgressEvent[]): HostSummary[] {
  const byHost = new Map<string, HostSummary>();
  for (const ev of events) {
    const row = byHost.get(ev.host) ?? { host: ev.host, requests: 0, outcome: outcomeOf(ev), keys: [] };
    row.requests += 1;
    // A host that was ever brokered is a brokered host; a refusal outranks a bare pass.
    const o = outcomeOf(ev);
    if (o === "brokered" || (o === "refused" && row.outcome === "bare")) row.outcome = o;
    for (const k of ev.credential_keys) if (!row.keys.includes(k)) row.keys.push(k);
    byHost.set(ev.host, row);
  }
  return [...byHost.values()].sort((a, b) => b.requests - a.requests || a.host.localeCompare(b.host));
}

/**
 * What the `broker` stage events of a conversation's feed say. `keys` is
 * what was withheld from the sandbox and handed to the broker instead;
 * `failed` is why the conversation did not start, in the broker's words.
 * Null when the feed has no broker stage at all — an unbrokered account, or
 * a conversation older than the feature.
 */
export interface BrokerStage {
  keys: string[];
  vault: string | null;
  expiresAt: string | null;
  failed: string | null;
  done: boolean;
}

export function brokerStage(events: LogEvent[]): BrokerStage | null {
  let out: BrokerStage | null = null;
  for (const ev of events) {
    if (ev.kind !== "stage" || ev.stage !== "broker") continue;
    out ??= { keys: [], vault: null, expiresAt: null, failed: null, done: false };
    const d = dataOf(ev);
    if (ev.state === "started") {
      const keys = Array.isArray(d.keys) ? d.keys.filter((k): k is string => typeof k === "string") : [];
      out.keys = keys;
      out.failed = null;
      out.done = false;
    } else if (ev.state === "done") {
      out.vault = typeof d.vault === "string" ? d.vault : out.vault;
      out.expiresAt = typeof d.expires_at === "string" ? d.expires_at : out.expiresAt;
      out.done = true;
    } else if (ev.state === "failed") {
      out.failed = typeof d.reason === "string" ? d.reason : "failed";
    }
  }
  return out;
}

/** The reasons the broker stage fails with, in words. */
export function brokerFailure(reason: string): string {
  switch (reason) {
    case "backend_lacks_network_policy":
      return "this computer's provider cannot pin egress to the broker, so a brokered conversation will not run on it";
    case "broker_unreachable":
      return "the broker did not answer, and Fountain will not start a sandbox with credentials in the clear instead";
    default:
      return reason;
  }
}

/** A detail for a stage line in the setup log: what `broker · started` was about. */
export function brokerStageDetail(ev: LogEvent): string | null {
  if (ev.kind !== "stage" || ev.stage !== "broker") return null;
  const d = dataOf(ev);
  if (ev.state === "started" && Array.isArray(d.keys) && d.keys.length) return `withheld from the sandbox: ${d.keys.join(", ")}`;
  if (ev.state === "failed" && typeof d.reason === "string") return brokerFailure(d.reason);
  return null;
}
