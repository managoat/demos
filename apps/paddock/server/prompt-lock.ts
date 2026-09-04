/**
 * Serialize turn submission per machine so paddock's send order matches
 * Fountain's turn order. A verbatim port of
 * `apps/salon/server/prompt-lock.ts`, keyed by paddock rather than chat.
 *
 * This matters more here than it did there. A box runs one turn at a time, so
 * two people pressing Enter together would otherwise race for
 * `sandbox_at_capacity` and whoever lost would look like they were ignored.
 */
const tails = new Map<string, Promise<void>>();

export async function withPromptLock<T>(paddockId: string, task: () => Promise<T>): Promise<T> {
  const prior = tails.get(paddockId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prior.catch(() => undefined).then(() => mine);
  tails.set(paddockId, tail);
  await prior.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (tails.get(paddockId) === tail) tails.delete(paddockId);
  }
}
