/**
 * "Not now": the pause Fountain asked for.
 *
 * A 429 carries `Retry-After`, and every caller that ignores it is a caller
 * that retries on its own cadence into a server that just said it was full.
 * The poll, the receipt read, the scrollback fetch and the stream reconnect
 * all share one of these, so one refusal quiets all of them at once — the
 * server is rate-limiting the *key*, not the call, and four loops each
 * honouring their own copy of the answer would still be four loops.
 *
 * Jitter so a room full of browsers told the same thing does not come back in
 * the same instant.
 */
import { ApiError } from "../api/client";

/** What a 429 with no `Retry-After` is taken to mean. */
export const DEFAULT_RETRY_MS = 15_000;
/** Added on top of what the server asked, so retries spread out. */
export const JITTER_MS = 2_000;

export class Hold {
  private until = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
  ) {}

  /** Take note of a failure; only a 429 changes anything. */
  note(err: unknown): void {
    if (!(err instanceof ApiError) || err.status !== 429) return;
    const asked = err.retryAfter !== null && Number.isFinite(err.retryAfter) && err.retryAfter > 0 ? err.retryAfter * 1000 : DEFAULT_RETRY_MS;
    this.until = Math.max(this.until, this.now() + asked + this.random() * JITTER_MS);
  }

  /** Whether a call should wait rather than go. */
  active(): boolean {
    return this.until > this.now();
  }

  /** How long a caller should wait, at least; 0 when it may go now. */
  remainingMs(): number {
    return Math.max(0, this.until - this.now());
  }
}
