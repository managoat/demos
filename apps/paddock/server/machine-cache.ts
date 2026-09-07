/**
 * One Fountain call per burst, not one per proxied request.
 *
 * Every request through `/f/<paddock>/api/…` has to answer "which machine is
 * this, and which tabs are on it" before it can forward anything, and the
 * answer comes from the owner's conversation list. Derived-not-stored is the
 * right design (see the top of `proxy.ts`), but the first cut derived it on
 * *every* request: a browser polling the strip every four seconds while
 * holding a stream open and reading the receipt after each turn made three to
 * forty list calls a cycle, each of which returns every conversation on the
 * account and runs an aggregate server-side. Multiplied across the open
 * browsers it was ~50,000 list calls an hour against production and the
 * largest single contributor to a four-day database-pool incident (2026-09-07).
 *
 * So the derivation is memoised, briefly. Three properties matter:
 *
 *   - **Short.** `TTL_MS` is a few seconds — long enough that a burst of
 *     proxied requests from one screen costs one call, short enough that a tab
 *     opened out of band shows up before anybody wonders where it is.
 *   - **Coalesced.** Concurrent misses share one in-flight promise, so twenty
 *     browsers polling at once still make one call.
 *   - **Invalidated on the writes that change the answer.** Opening a tab,
 *     ending one, rebuilding the machine: each calls `forget`, so the next
 *     request reads fresh. Nothing else changes which conversations are live
 *     on which box, so nothing else needs to.
 *
 * The key includes a fingerprint of the API key, not just the paddock id: a
 * claim rotates the compute credential, and a cached answer from the old key
 * must not stand in for the first call on the new one.
 */

interface Entry<T> {
  value: Promise<T>;
  expiresAt: number;
}

/** How long a derived answer stands before it is re-read. */
export const TTL_MS = 5_000;

const entries = new Map<string, Entry<unknown>>();

/**
 * The value for `key`, from cache while fresh, else from `load`.
 *
 * A load that rejects is dropped immediately so the next caller retries rather
 * than being handed the same failure for the rest of the TTL.
 */
export function cached<T>(key: string, load: () => Promise<T>, nowMs = Date.now()): Promise<T> {
  const hit = entries.get(key);
  if (hit && hit.expiresAt > nowMs) return hit.value as Promise<T>;
  const value = load();
  const entry: Entry<T> = { value, expiresAt: nowMs + TTL_MS };
  entries.set(key, entry);
  value.catch(() => {
    if (entries.get(key) === entry) entries.delete(key);
  });
  return value;
}

/** Forget everything derived for one paddock, whichever key it was read on. */
export function forget(paddockId: string): void {
  for (const key of entries.keys()) if (key.startsWith(`${paddockId}:`)) entries.delete(key);
}

/**
 * Which agent each paddock's machine was last seen on.
 *
 * A hint, not a fact: it lets the next read ask Fountain for one agent's
 * conversations instead of the account's, and `proxy.ts` falls back to the
 * whole account when the narrowed list shows no live machine. Deliberately
 * not cleared by `forget` — a new tab or an ended one does not move the
 * machine to another agent, and a rebuild that does is caught by the fallback.
 */
const agents = new Map<string, string>();

export function agentHint(paddockId: string): string | undefined {
  return agents.get(paddockId);
}

export function rememberAgent(paddockId: string, agentId: string): void {
  agents.set(paddockId, agentId);
}

/** For tests: forget everything. */
export function resetMachineCache(): void {
  entries.clear();
  agents.clear();
}

/** The cache key for one paddock as read on one credential. */
export function keyFor(paddockId: string, credentialId: string): string {
  return `${paddockId}:${credentialId}`;
}
