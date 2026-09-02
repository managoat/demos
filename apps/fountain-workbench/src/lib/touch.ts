/**
 * Does this device point with a finger?
 *
 * One thing in the app turns on the answer, and it is the composer's Enter. On
 * a keyboard Enter sends and Shift+Enter writes a newline, which is the right
 * bargain for the machine this app was drawn for. A soft keyboard has no
 * Shift+Enter to offer: its Enter is the only Enter there is, so binding it to
 * send means a phone can write a prompt of exactly one line, and every
 * autocorrect-and-return sends it half-written. There, Enter writes the
 * newline and the ⏎ button — already on screen, already the thing a thumb
 * reaches for — sends.
 *
 * `pointer: coarse` describes the *primary* input, so a laptop stays fine and
 * a tablet with a keyboard case reads as touch. That tablet loses Enter-to-send
 * and keeps a send button under its thumb, which is the cheaper way to be
 * wrong.
 */
type Matcher = { matchMedia?: (query: string) => { matches: boolean } };

export function coarsePointer(w: Matcher = typeof window === "undefined" ? {} : window): boolean {
  return w.matchMedia?.("(pointer: coarse)").matches ?? false;
}

/** What the composer says Enter will do, which is not the same on both. */
export function composerHint(who: string, touch: boolean): string {
  return touch
    ? `${who} — ⏎ to send, Enter for a newline, 🖼 or paste to attach an image`
    : `${who} — Enter to send, Shift+Enter for a newline, 🖼 or paste or drop an image`;
}
