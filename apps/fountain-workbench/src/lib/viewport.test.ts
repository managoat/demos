/**
 * The keyboard fallback, which nobody in here can see happen. Its whole job is
 * to be inert except in one situation, so most of what is worth testing is the
 * situations it stays out of.
 */
import { describe, expect, test } from "bun:test";
import { KEYBOARD_FLOOR, read, shellHeight, watchKeyboard } from "./viewport";

const css = await Bun.file(new URL("../styles.css", import.meta.url)).text();

/** A phone: 844pt tall, keyboard about 336 of it. */
const iphone = { visual: 844, layout: 844, scale: 1 };

describe("shellHeight", () => {
  test("says nothing when there is nothing to say, so 100dvh keeps the height", () => {
    expect(shellHeight(null)).toBe("");
    expect(shellHeight(iphone)).toBe("");
  });

  test("shortens to the visual viewport when a keyboard is over the page", () => {
    expect(shellHeight({ ...iphone, visual: 508 })).toBe("508px");
    // rounded: a fractional height becomes a fractional gap under the composer
    expect(shellHeight({ ...iphone, visual: 507.5 })).toBe("508px");
  });

  // Where `interactive-widget=resizes-content` is honoured the layout viewport
  // shortens too, so the shortfall is ~0 and this must stay out of the way —
  // otherwise the two fixes subtract the keyboard twice.
  test("stays out of it when the browser already shortened the viewport itself", () => {
    expect(shellHeight({ visual: 508, layout: 508, scale: 1 })).toBe("");
    expect(shellHeight({ visual: 508, layout: 512, scale: 1 })).toBe("");
  });

  // A pinch-zoom shrinks the visual viewport exactly the way a keyboard does.
  // Reflowing the app to a new height under a held zoom is worse than the bug.
  test("is not fooled by a pinch-zoom", () => {
    expect(shellHeight({ visual: 400, layout: 844, scale: 2 })).toBe("");
    expect(shellHeight({ visual: 400, layout: 844, scale: 1.005 })).toBe("400px");
  });

  test("ignores the URL bar, and nothing smaller than a keyboard", () => {
    expect(shellHeight({ ...iphone, visual: 844 - (KEYBOARD_FLOOR - 1) })).toBe("");
    expect(shellHeight({ ...iphone, visual: 844 - KEYBOARD_FLOOR })).toBe(`${844 - KEYBOARD_FLOOR}px`);
    expect(KEYBOARD_FLOOR).toBeGreaterThan(90); // taller than any URL bar
    expect(KEYBOARD_FLOOR).toBeLessThan(200); // shorter than any keyboard
  });

  test("a browser with no visual viewport, or a nonsense reading, is no opinion", () => {
    expect(read({ innerHeight: 844 })).toBe(null);
    expect(read({ innerHeight: 844, visualViewport: null })).toBe(null);
    expect(shellHeight({ visual: 0, layout: 844, scale: 1 })).toBe("");
    expect(shellHeight({ visual: 508, layout: 0, scale: 1 })).toBe("");
  });

  test("reads both viewports when there is one", () => {
    expect(read({ innerHeight: 844, visualViewport: { height: 508, scale: 1, addEventListener() {}, removeEventListener() {} } })).toEqual({
      visual: 508,
      layout: 844,
      scale: 1,
    });
  });
});

describe("watchKeyboard", () => {
  const fakeRoot = () => {
    const set = new Map<string, string>();
    return { set, style: { setProperty: (k: string, v: string) => void set.set(k, v), removeProperty: (k: string) => void set.delete(k) } };
  };
  const fakeWin = (coarse: boolean, height = 844) => {
    const listeners = new Map<string, () => void>();
    const vv = {
      height,
      scale: 1,
      addEventListener: (t: string, fn: () => void) => void listeners.set(t, fn),
      removeEventListener: (t: string) => void listeners.delete(t),
    };
    return { win: { innerHeight: 844, visualViewport: vv, matchMedia: () => ({ matches: coarse }) }, vv, listeners };
  };

  test("attaches nothing on a mouse — the property would only ever be wrong there", () => {
    const { win, listeners } = fakeWin(false);
    const root = fakeRoot();
    const stop = watchKeyboard(win, root);
    expect(listeners.size).toBe(0);
    expect(root.set.size).toBe(0);
    stop();
  });

  test("follows the visual viewport up and back down on a touch screen", () => {
    const { win, vv, listeners } = fakeWin(true);
    const root = fakeRoot();
    const stop = watchKeyboard(win, root);
    // nothing to say while the keyboard is down
    expect(root.set.has("--app-height")).toBe(false);

    vv.height = 508; // keyboard up
    listeners.get("resize")!();
    expect(root.set.get("--app-height")).toBe("508px");

    vv.height = 844; // and away again
    listeners.get("resize")!();
    expect(root.set.has("--app-height")).toBe(false);

    stop();
    expect(listeners.size).toBe(0);
  });

  // iOS shifts the visual viewport without resizing it when it scrolls a
  // focused field into view, so `scroll` has to be listened to as well.
  test("listens for the scroll iOS does instead of a resize", () => {
    const { win, listeners } = fakeWin(true);
    const stop = watchKeyboard(win, fakeRoot());
    expect([...listeners.keys()].sort()).toEqual(["resize", "scroll"]);
    stop();
  });

  test("puts the height back when it stops", () => {
    const { win, vv, listeners } = fakeWin(true);
    const root = fakeRoot();
    const stop = watchKeyboard(win, root);
    vv.height = 508;
    listeners.get("resize")!();
    expect(root.set.has("--app-height")).toBe(true);
    stop();
    expect(root.set.has("--app-height")).toBe(false);
  });

  test("a browser with no visual viewport is left alone", () => {
    const root = fakeRoot();
    const stop = watchKeyboard({ innerHeight: 844, matchMedia: () => ({ matches: true }) }, root);
    expect(root.set.size).toBe(0);
    stop();
  });
});

describe("styles.css", () => {
  test("lets --app-height win, and keeps 100dvh as what it falls back to", () => {
    expect(css).toMatch(/\.app \{[^}]*height: var\(--app-height, 100dvh\)/);
  });
});
