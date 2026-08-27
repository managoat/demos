/**
 * The phone rules, held to by reading the stylesheet — the same trick
 * theme.test.ts uses, and for the same reason: there is no browser in here to
 * look at, so the invariants have to be checked in the text that states them.
 *
 * These are regressions that are invisible on a desktop. A field dropped back
 * under 16px only misbehaves on a phone, where it zooms the page and does not
 * zoom back; a control left behind a `:hover` only vanishes where there is no
 * pointer. Neither shows up in a screenshot of a narrow window.
 */
import { describe, expect, test } from "bun:test";
import { coarsePointer, composerHint } from "./touch";

const css = await Bun.file(new URL("../styles.css", import.meta.url)).text();
const html = await Bun.file(new URL("../../index.html", import.meta.url)).text();
const shell = await Bun.file(new URL("../components/Shell.tsx", import.meta.url)).text();

/**
 * Every `@media <needle> { … }` body in the stylesheet, joined. All of them and
 * not the first: the phone rules are written as several blocks by subject, and
 * a floor that only holds in the block that happens to come first is not one.
 */
function block(needle: string): string {
  const bodies: string[] = [];
  for (let at = css.indexOf(`@media ${needle}`); at !== -1; at = css.indexOf(`@media ${needle}`, at + 1)) {
    const open = css.indexOf("{", at);
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) {
        bodies.push(css.slice(open + 1, i));
        break;
      }
    }
  }
  expect(bodies.length).toBeGreaterThan(0);
  return bodies.join("\n");
}

/** Every `font-size: <n>px` in a chunk of CSS. */
const fontSizes = (chunk: string) => [...chunk.matchAll(/font-size:\s*([\d.]+)px/g)].map((m) => Number(m[1]));

describe("a touch screen", () => {
  test("is what decides the composer's Enter, and says so in the placeholder", () => {
    expect(coarsePointer({ matchMedia: () => ({ matches: true }) })).toBe(true);
    expect(coarsePointer({ matchMedia: () => ({ matches: false }) })).toBe(false);
    // a window with no matchMedia at all is a mouse, not a crash
    expect(coarsePointer({})).toBe(false);

    expect(composerHint("ada", false)).toContain("Enter to send");
    expect(composerHint("ada", false)).toContain("Shift+Enter");
    // the one thing a soft keyboard cannot be told to press
    expect(composerHint("ada", true)).not.toContain("Shift+Enter");
    expect(composerHint("ada", true)).toContain("⏎ to send");
    expect(composerHint("ada", true)).toStartWith("ada");
  });
});

describe("styles.css on a phone", () => {
  // Safari zooms the page when a control under 16px takes focus and does not
  // zoom back out. Every field in this app is drawn at 11.5–15px, so the fix
  // is a floor under a finger — and the floor is only worth anything if
  // nothing in the block undercuts it.
  test("puts a 16px floor under every field where the pointer is coarse", () => {
    const coarse = block("(pointer: coarse)");
    const sizes = fontSizes(coarse);
    expect(sizes.length).toBeGreaterThan(0);
    for (const px of sizes) expect(px).toBeGreaterThanOrEqual(16);

    // and it has to reach the fields that set their own size, or those keep it
    for (const sel of [".palette-input", ".find-input", ".explorer-filter-input", ".new-item-input", ".composer.term textarea"]) {
      expect(coarse).toContain(sel);
    }
  });

  // The board's cards are draggable and a phone cannot drag them, which is by
  // design (Board.tsx: "dragging is the shortcut, never the only way"). That
  // makes `button.small` the only way to close a work item on a phone — and it
  // takes every computer on the item down with it. A 24px target is the wrong
  // thing to make a thumb aim at for that.
  test("gives the destructive small buttons a target a thumb can hit", () => {
    const coarse = block("(pointer: coarse)");
    expect(coarse).toMatch(/button\.small[^{]*\{[^}]*min-height:\s*3[6-9]px|button\.small[^{]*\{[^}]*min-height:\s*4\dpx/);
  });

  // These are not decorations: the "+"s are the only way to add a computer or
  // start a second conversation from the tree, and the ✕ is the only way to
  // close a tab that is not the open one.
  test("shows what a pointer would have revealed, where there is no pointer", () => {
    const noHover = block("(hover: none)");
    expect(noHover).toContain("opacity: 1");
    expect(noHover).toContain("visibility: visible");
    expect(noHover).toContain(".tab-close");
    expect(noHover).toContain(".icon.small-icon");
  });

  // `viewport-fit=cover` is an opt-in to painting under the notch and the home
  // indicator. Taking it without paying the insets is what puts the send button
  // under the home indicator.
  test("pays back the insets it opted into with viewport-fit=cover", () => {
    expect(html).toContain("viewport-fit=cover");
    // the keyboard shortens the viewport rather than covering the composer
    expect(html).toContain("interactive-widget=resizes-content");
    for (const edge of ["safe-area-inset-left", "safe-area-inset-right", "safe-area-inset-bottom"]) {
      expect(css).toContain(`env(${edge})`);
    }
    // the bottom edge, specifically, on the two things that sit on it
    expect(css).toMatch(/\.composer\.term \{ padding-bottom: max\(10px, env\(safe-area-inset-bottom\)\)/);
    expect(css).toMatch(/\.toasts \{ bottom: max\(16px, env\(safe-area-inset-bottom\)\)/);
  });

  // The explorer sets its dragged width inline, which beats any `width` a
  // media query offers: without a clamp, a sidebar pulled wide on a desktop
  // comes back as a drawer wider than the phone.
  test("clamps the drawer the explorer's remembered width would otherwise set", () => {
    const narrow = block("(max-width: 900px)");
    expect(narrow).toMatch(/\.sidebar \{[^}]*max-width:/);
    expect(narrow).not.toMatch(/\.sidebar \{[^}]*[^-]width:\s*\d/);
  });

  // The top bar holds eleven things. A phone fits about seven, so it wraps —
  // and the words on the buttons go while their glyphs stay.
  test("wraps the top bar rather than squashing it", () => {
    const phone = block("(max-width: 700px)");
    expect(phone).toContain("flex-wrap: wrap");
    expect(phone).toContain(".btn-label { display: none; }");
    expect(phone).toContain(".brand, .topbar-sep { display: none; }");
    // the pages of the project take the second row rather than disappearing
    expect(phone).toMatch(/\.crumbs \{[^}]*order:/);
  });
});

describe("the shell's top bar", () => {
  // Hiding the word off a button is only safe if the button still says what it
  // is to a screen reader and to a hover.
  test("every button whose word is hidden on a phone keeps a name", () => {
    const labels = [...shell.matchAll(/<button[^>]*?>[\s\S]*?<\/button>/g)].filter((m) => m[0].includes("btn-label"));
    expect(labels.length).toBe(3);
    for (const m of labels) {
      expect(m[0]).toContain("aria-label=");
      expect(m[0]).toContain("title=");
    }
  });
});
