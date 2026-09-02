/**
 * Two small pieces of chat-scroll behaviour (after OpenMausBot's
 * bottom-follow and transcript-window):
 *
 * - follow the bottom while the reader is at the bottom; the moment they
 *   scroll up to read, new content must not yank them back down — a
 *   "new messages ↓" pill offers the way back instead;
 * - render only the tail of a long thread, with "show earlier" on demand,
 *   so a months-old teammate does not cost thousands of DOM nodes.
 */

/** Within `slack` px of the bottom counts as "at the bottom". */
export function isNearBottom(el: { scrollTop: number; scrollHeight: number; clientHeight: number }, slack = 80): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
}

export const TURN_WINDOW = 40;

/** The tail of `items` to render, and how many were hidden. */
export function windowTail<T>(items: T[], visible: number): { shown: T[]; hidden: number } {
  if (items.length <= visible) return { shown: items, hidden: 0 };
  return { shown: items.slice(items.length - visible), hidden: items.length - visible };
}
