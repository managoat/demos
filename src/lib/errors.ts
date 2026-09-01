import { FountainError } from "@agentshit/fountain-sdk";
import { ApiError } from "./api";

/** One line a person can act on, from whatever the SDK, the server or the browser threw. */
export function describeError(err: unknown): string {
  const code = errorCode(err);
  switch (code) {
    case "conversation_busy":
      return "The agent is still on the last message — wait for it to finish.";
    case "sandbox_busy":
    case "sandbox_at_capacity":
      return "The computer is busy with another turn — try again in a moment.";
    case "sandbox_quota_exceeded":
      return "The host is at their concurrent-computer limit on Fountain.";
    case "insufficient_credits":
    case "subscription_required":
      return "The host's Fountain balance is empty, so this chat cannot spend. They can top up on Fountain.";
    case "fleet_full":
    case "provisioning":
      return "The computer is still coming up — try again in a moment.";
    case "environment_not_allowed":
      return "That preset does not allow the chosen computer.";
    case "vault_not_allowed":
      return "That preset does not allow the chosen vault.";
    case "permission_policy_unenforceable":
      return "That runtime cannot enforce the preset's permission policy.";
    case "host_key_rejected":
      return "Fountain no longer accepts the host's key. The host should sign in to Salon again.";
    case "unauthenticated":
    case "unauthorized":
      return "Your session has ended. Sign in again.";
    case "rate_limited":
      return "Slow down — Fountain rate-limited that request.";
    case "preset_not_found":
      return "That preset is not one of your agents any more.";
    case "bad_invite":
      return "That invite link is not valid any more.";
  }
  if (err instanceof ApiError) return err.message;
  if (err instanceof FountainError) {
    if (err.status === 0) return "Could not reach the Salon server.";
    const fields = Object.entries(err.fieldErrors)
      .map(([k, v]) => `${k} ${v.join(", ")}`)
      .join("; ");
    return `${fields || err.message || "Request failed"} (HTTP ${err.status}${err.code ? `, ${err.code}` : ""})`;
  }
  if (err instanceof TypeError && /fetch/i.test(err.message)) return "Could not reach the Salon server.";
  return err instanceof Error ? err.message : String(err);
}

/** The API's `error` code, when the failure carried one. */
export function errorCode(err: unknown): string | undefined {
  if (err instanceof FountainError) return err.code;
  if (err instanceof ApiError) return err.code;
  return undefined;
}
