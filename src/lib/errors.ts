import { FountainError } from "@agentshit/fountain-sdk";
import { ApiError } from "./api";

/** One line a person can act on, from whatever the SDK, the server or the browser threw. */
export function describeError(err: unknown): string {
  const code = errorCode(err);
  switch (code) {
    case "conversation_busy":
      return "It is still answering the last message — wait for it to finish.";
    case "sandbox_busy":
    case "sandbox_at_capacity":
      return "It is busy with another message — try again in a moment.";
    case "sandbox_quota_exceeded":
      return "The host has as many chats running as their Fountain plan allows. Retire one to start another.";
    case "insufficient_credits":
    case "subscription_required":
      return "The host's Fountain balance is empty, so this chat cannot spend. They can top up on Fountain.";
    case "fleet_full":
    case "provisioning":
      return "Still getting things ready — try again in a moment.";
    case "environment_not_allowed":
    case "vault_not_allowed":
    case "permission_policy_unenforceable":
      return "Fountain would not start a chat with those settings.";
    case "host_key_rejected":
      return "Fountain no longer accepts the host's key. The host should sign in to Salon again.";
    case "unauthenticated":
    case "unauthorized":
      return "Your session has ended. Sign in again.";
    case "rate_limited":
      return "Slow down — Fountain rate-limited that request.";
    case "connector_not_found":
      return "That connection is not on your Fountain any more. Turn it off in Connectors and try again.";
    case "connector_unusable":
      return "That connection cannot be used in a Salon chat yet.";
    case "connections_not_enabled":
      return "Connectors are not switched on for this Fountain account.";
    case "bad_invite":
      return "That invite link is not valid any more.";
    case "sandbox_not_ready":
      return "The computer is parked. Send it a message to wake it, then try again.";
    case "sandbox_unreachable":
      return "Could not reach the computer just now. Try again shortly.";
    case "files_unavailable":
      return "This Fountain cannot read a computer's files yet.";
    case "no_computer":
      return "The chat has no computer right now.";
    case "no_repository":
      return "This chat was not started in a project, so there is no repository to read.";
    case "path_not_found":
      return "There is no such file in the repository now.";
    case "not_a_repository":
      return "The project's folder is not a git repository in the computer.";
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
