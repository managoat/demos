/**
 * How tall the shell stands when a soft keyboard is up.
 *
 * `.app` is `height: 100dvh`, and `dvh` means the viewport *without* a
 * keyboard. index.html asks for `interactive-widget=resizes-content`, which
 * tells the browser to shorten the viewport when the keyboard opens instead of
 * covering the page with it; where that is honoured — Chrome on Android —
 * `dvh` shortens with it and there is nothing to do here.
 *
 * iOS Safari does not honour it. There the keyboard leaves the layout viewport
 * alone and shrinks only the *visual* viewport, so `100dvh` keeps its full
 * height and the composer — the last row of the flex column — ends up behind
 * the keys it was tapped to type into. `window.visualViewport` is the only
 * thing that knows, so on a touch screen we read it and publish the answer as
 * `--app-height`, which `.app` prefers over `100dvh`.
 *
 * The whole design is "shorten, or say nothing":
 *
 *   - Anything but a real shortfall returns `""`, which clears the property and
 *     hands the height back to `100dvh`. So the fallback is inert everywhere
 *     the declarative fix already worked, and the two never fight: on Android
 *     the layout viewport shortens too, the shortfall is ~0, and this stays out
 *     of it.
 *   - A pinch-zoom shrinks the visual viewport exactly the way a keyboard does.
 *     `scale` is what tells them apart, and a zoomed page that suddenly reflowed
 *     to a new height would be a worse bug than the one being fixed.
 *   - The URL bar sliding in and out moves both viewports by 40–90px. The floor
 *     is above that and below any keyboard.
 */

/** What the two viewports read, at one moment. */
export interface Reading {
  /** `visualViewport.height` — what is actually visible. */
  visual: number;
  /** `window.innerHeight` — what the layout, and so `dvh`, is sized against. */
  layout: number;
  /** `visualViewport.scale` — 1 unless the page is pinch-zoomed. */
  scale: number;
}

/**
 * Below this a shortfall is furniture — a URL bar, a toolbar — and above it
 * nothing but a keyboard is that big. No phone keyboard is under ~200px.
 */
export const KEYBOARD_FLOOR = 120;

/**
 * The height `.app` should stand at, or `""` for "no opinion, use `100dvh`".
 */
export function shellHeight(reading: Reading | null): string {
  if (!reading) return "";
  const { visual, layout, scale } = reading;
  if (!(visual > 0) || !(layout > 0)) return "";
  // a pinch-zoom shrinks the visual viewport too, and is not a keyboard
  if (scale > 1.01) return "";
  if (layout - visual < KEYBOARD_FLOOR) return "";
  return `${Math.round(visual)}px`;
}

/** What `window` has to offer for this to be worth doing at all. */
type Win = {
  innerHeight?: number;
  visualViewport?: {
    height: number;
    scale: number;
    addEventListener(type: string, fn: () => void): void;
    removeEventListener(type: string, fn: () => void): void;
  } | null;
  matchMedia?: (query: string) => { matches: boolean };
};

/** Read both viewports now, or `null` if this browser has no visual viewport. */
export function read(w: Win): Reading | null {
  const vv = w.visualViewport;
  if (!vv || typeof w.innerHeight !== "number") return null;
  return { visual: vv.height, layout: w.innerHeight, scale: vv.scale };
}

/**
 * Keep `--app-height` on `root` in step with the visual viewport, for as long
 * as the returned function is not called. A no-op — and no listeners — on a
 * mouse, where the property would only ever be a way to get the height wrong.
 */
export function watchKeyboard(w: Win, root: { style: { setProperty(k: string, v: string): void; removeProperty(k: string): void } }): () => void {
  const vv = w.visualViewport;
  if (!vv || !(w.matchMedia?.("(pointer: coarse)").matches ?? false)) return () => {};
  const apply = () => {
    const h = shellHeight(read(w));
    if (h) root.style.setProperty("--app-height", h);
    else root.style.removeProperty("--app-height");
  };
  // `scroll` as well as `resize`: iOS shifts the visual viewport without
  // resizing it when it scrolls a focused field into view.
  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
  apply();
  return () => {
    vv.removeEventListener("resize", apply);
    vv.removeEventListener("scroll", apply);
    root.style.removeProperty("--app-height");
  };
}
