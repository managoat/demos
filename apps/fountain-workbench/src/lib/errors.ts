import { FountainError } from "@managoat/fountain-sdk";

/** One line a person can act on, from whatever the SDK or the browser threw. */
export function describeError(err: unknown): string {
  if (err instanceof FountainError) {
    switch (err.code) {
      case "conversation_busy":
        return "That conversation is still working on its last prompt.";
      case "sandbox_busy":
        return "That computer is busy with another conversation's turn.";
      case "provisioning":
        return "The sandbox is still coming up — try again in a moment.";
      case "sandbox_not_found":
        return "That computer is gone.";
      case "environment_not_allowed":
        return "That agent does not allow the chosen environment.";
      case "vault_not_allowed":
        return "That agent does not allow the chosen vault.";
      case "unauthorized":
        return "Your session has ended, or the project owner's Managoat key no longer works. Sign in again.";
      case "rate_limited":
        return "Slow down — Managoat rate-limited that request.";
      case "broker_unavailable":
        return "The egress broker did not answer, so its log cannot be read right now.";
      case "brokerage_not_enabled":
        return "Egress credential brokerage is not on for this account.";
    }
    if (err.status === 0) return "Could not reach the workbench server.";
    const fields = Object.entries(err.fieldErrors)
      .map(([k, v]) => `${k} ${v.join(", ")}`)
      .join("; ");
    return `${fields || err.message || "Request failed"} (HTTP ${err.status}${err.code ? `, ${err.code}` : ""})`;
  }
  if (err instanceof TypeError && /fetch/i.test(err.message)) {
    return "Could not reach the workbench server.";
  }
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** The API's `error` code, when the failure carried one. */
export function errorCode(err: unknown): string | undefined {
  return err instanceof FountainError ? err.code : undefined;
}
