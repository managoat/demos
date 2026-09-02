/**
 * Queue-and-steer for a busy teammate (after OpenMausBot's steer-queue).
 *
 * A message sent while the teammate is mid-turn does not bounce with
 * "they're still working": it lands in the thread as a queued bubble and
 * waits here. When the turn ends, everything queued for that conversation
 * drains into ONE follow-up turn — the texts joined with blank lines, the
 * images concatenated — so a burst of steering notes costs one turn.
 *
 * Memory-only on purpose: a reload loses the "auto-send when they're done"
 * intent, and the words are still in the composer's draft if they were never
 * sent. Pure data; the sending happens in App.
 */
import type { OutgoingImage } from "./images";

export interface QueuedMessage {
  id: string;
  text: string;
  images: OutgoingImage[];
  at: string;
}

export interface Drained {
  prompt: string;
  images: OutgoingImage[];
  items: QueuedMessage[];
}

export type Queues = ReadonlyMap<string, readonly QueuedMessage[]>;

let seq = 0;
export function newQueuedId(): string {
  seq += 1;
  return `q-${Date.now().toString(36)}-${seq.toString(36)}`;
}

export function enqueue(queues: Queues, conversationId: string, message: QueuedMessage): Map<string, QueuedMessage[]> {
  const next = new Map(queues as Map<string, QueuedMessage[]>);
  next.set(conversationId, [...(queues.get(conversationId) ?? []), message]);
  return next;
}

export function removeQueued(queues: Queues, conversationId: string, id: string): Map<string, QueuedMessage[]> {
  const next = new Map(queues as Map<string, QueuedMessage[]>);
  const rest = (queues.get(conversationId) ?? []).filter((m) => m.id !== id);
  if (rest.length) next.set(conversationId, rest);
  else next.delete(conversationId);
  return next;
}

/** Everything queued for a conversation as one turn, or null when nothing is. */
export function drain(queues: Queues, conversationId: string): Drained | null {
  const items = queues.get(conversationId) ?? [];
  if (!items.length) return null;
  const texts = items.map((m) => m.text.trim()).filter(Boolean);
  return {
    prompt: texts.join("\n\n"),
    images: items.flatMap((m) => m.images),
    items: [...items],
  };
}

export function withoutConversation(queues: Queues, conversationId: string): Map<string, QueuedMessage[]> {
  const next = new Map(queues as Map<string, QueuedMessage[]>);
  next.delete(conversationId);
  return next;
}
