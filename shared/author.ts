/**
 * Who said what, in a chat several people write into.
 *
 * Fountain's turn carries a prompt and nothing about who typed it — every
 * turn in a chat goes in on the host's key. Two things fix that, both here
 * because the server writes and the browser reads:
 *
 *   1. The server records who sent each turn (`sends` in server/db.ts), and
 *      the browser labels the bubble from that.
 *   2. Once a chat has more than one person in it, the prompt the agent sees
 *      is prefixed `[from alice@example.com] …`, so the model knows who is
 *      talking. The transcript strips the prefix back off for display.
 */

const PREFIX = /^\[from ([^\]\s]+)\]\s?/;

export function withAuthor(email: string, prompt: string): string {
  return `[from ${email}] ${prompt}`;
}

/** The author a prompt names, and the prompt without the label. */
export function splitAuthor(prompt: string): { email: string | null; text: string } {
  const m = PREFIX.exec(prompt);
  if (!m) return { email: null, text: prompt };
  return { email: m[1]!, text: prompt.slice(m[0].length) };
}

/** A short name for an email: the part before the @, tidied. */
export function shortName(email: string): string {
  const local = email.split("@")[0] ?? email;
  return local.replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) || email;
}

export function initials(email: string): string {
  const name = shortName(email);
  const parts = name.split(" ").filter(Boolean);
  const first = parts[0]?.[0] ?? "?";
  const second = parts.length > 1 ? parts[parts.length - 1]![0] ?? "" : "";
  return (first + second).toUpperCase();
}
