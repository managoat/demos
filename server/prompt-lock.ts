/** Serialize prompt submission per chat so Salon send order matches Fountain turn order. */
const tails = new Map<string, Promise<void>>();

export async function withPromptLock<T>(chatId: string, task: () => Promise<T>): Promise<T> {
  const prior = tails.get(chatId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  const tail = prior.catch(() => undefined).then(() => mine);
  tails.set(chatId, tail);
  await prior.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (tails.get(chatId) === tail) tails.delete(chatId);
  }
}
