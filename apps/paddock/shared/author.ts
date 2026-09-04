/**
 * Who said what, in a machine several people type into.
 *
 * Fountain's turn carries a prompt and nothing about who typed it — every
 * turn on a paddock goes in on the owner's key. So once more than one person
 * is in the machine, the prompt the agent sees is prefixed
 * `[from guest-7f3a] …`, and the terminal strips the label back off for
 * display. The server writes it, the browser reads it, hence `shared/`.
 *
 * Adapted from `apps/salon/shared/author.ts`. The one difference is that an
 * author here is not always an email: an anonymous guest is `guest-7f3a`, so
 * this file talks about labels rather than addresses, and `shortName` has to
 * cope with both.
 */

const PREFIX = /^\[from ([^\]\s]+)\]\s?/;

export function withAuthor(label: string, prompt: string): string {
  return `[from ${label}] ${prompt}`;
}

/** The author a prompt names, and the prompt without the label. */
export function splitAuthor(prompt: string): { label: string | null; text: string } {
  const m = PREFIX.exec(prompt);
  if (!m) return { label: null, text: prompt };
  return { label: m[1]!, text: prompt.slice(m[0].length) };
}

/** A short name for a label: an email's local part, or a guest handle as-is. */
export function shortName(label: string): string {
  if (!label.includes("@")) return label;
  const local = label.split("@")[0] ?? label;
  return local.replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) || label;
}
