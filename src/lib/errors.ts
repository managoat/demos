import { FountainError } from "@agentshit/fountain-sdk";

/** One line a person can act on, from whatever the SDK or the browser threw. */
export function describeError(err: unknown): string {
  if (err instanceof FountainError) {
    switch (err.code) {
      case "conversation_busy":
        return "That conversation is still working on its last prompt.";
      case "sandbox_busy":
        return "That computer is busy with another conversation's turn.";
      case "sandbox_quota_exceeded":
        return "You are at your concurrent-sandbox limit. Retire a conversation or wait for one to finish.";
      case "subscription_required":
        return "This account needs an active subscription to start conversations.";
      case "provisioning":
        return "The sandbox is still coming up — try again in a moment.";
      case "environment_not_allowed":
        return "That agent does not allow the chosen environment.";
      case "vault_not_allowed":
        return "That agent does not allow the chosen vault.";
      case "unauthorized":
        return "Fountain rejected the key. Sign in again.";
      case "rate_limited":
        return "Slow down — Fountain rate-limited that request.";
    }
    if (err.status === 0) return "Could not reach Fountain. Is the URL right, and is this origin in API_CORS_ORIGINS?";
    const fields = Object.entries(err.fieldErrors)
      .map(([k, v]) => `${k} ${v.join(", ")}`)
      .join("; ");
    return `${fields || err.message || "Request failed"} (HTTP ${err.status}${err.code ? `, ${err.code}` : ""})`;
  }
  if (err instanceof TypeError && /fetch/i.test(err.message)) {
    return "Could not reach Fountain. Is the URL right, and is this origin in API_CORS_ORIGINS?";
  }
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** The API's `error` code, when the failure carried one. */
export function errorCode(err: unknown): string | undefined {
  return err instanceof FountainError ? err.code : undefined;
}
