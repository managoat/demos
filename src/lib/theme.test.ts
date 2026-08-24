import { describe, expect, test } from "bun:test";
import { isTheme, THEMES, themeGlyph, themeName, themesOf, paletteClass, type Theme } from "./theme";

const css = await Bun.file(new URL("../styles.css", import.meta.url)).text();

/** `.pal-<id> { … }` → the tokens that block sets, and their values. */
const palettes = new Map<string, Map<string, string>>();
for (const m of css.matchAll(/\.pal-([a-z0-9-]+)\s*\{([^}]*)\}/g)) {
  palettes.set(m[1]!, new Map([...m[2]!.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)].map((d) => [d[1]!, d[2]!.trim()])));
}

/** The tokens a theme ends up with: light and dark only carry their deltas. */
const tokensOf = (id: string) => new Map([...palettes.get("light")!, ...palettes.get(id)!]);

const luminance = (hex: string) => {
  const ch = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
};

const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

/** `:root[data-theme="a"], :root[data-theme="b"] { color-scheme: dark; }` → a, b → dark. */
const schemes = new Map<string, string>();
for (const m of css.matchAll(/((?::root\[data-theme="[a-z0-9-]+"\],?\s*)+)\{\s*color-scheme:\s*(light|dark);/g)) {
  for (const id of m[1]!.matchAll(/data-theme="([a-z0-9-]+)"/g)) schemes.set(id[1]!, m[2]!);
}

describe("themes", () => {
  test("ids are unique and every one has both modes represented", () => {
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
    expect(themesOf("light").length).toBeGreaterThan(0);
    expect(themesOf("dark").length).toBeGreaterThan(0);
    expect(themesOf("light").length + themesOf("dark").length).toBe(THEMES.length);
  });

  test("only known palettes and system are accepted", () => {
    expect(isTheme("system")).toBe(true);
    expect(isTheme("nord")).toBe(true);
    expect(isTheme("dark")).toBe(true);
    expect(isTheme("gruvbox")).toBe(false);
    expect(isTheme("")).toBe(false);
    expect(isTheme(null)).toBe(false);
  });

  test("names and glyphs", () => {
    expect(themeName("system")).toBe("follow the OS");
    expect(themeName("tokyo-night")).toBe("tokyo night");
    expect(themeGlyph("system")).toBe("◐");
    expect(themeGlyph("light")).toBe("☀");
    expect(themeGlyph("nord")).toBe("☾");
  });

  // the list here and the palettes in styles.css have to stay in step: a
  // theme with no CSS block would apply nothing and show a blank swatch.
  test("every theme has a palette in styles.css, and no palette is orphaned", () => {
    for (const t of THEMES) expect(palettes.has(t.id)).toBe(true);
    for (const id of palettes.keys()) expect(isTheme(id)).toBe(true);
    expect(paletteClass("nord")).toBe("pal-nord");
  });

  test("each palette sets the same tokens as the default, and declares its colour-scheme", () => {
    const base = palettes.get("light")!;
    expect(base.size).toBeGreaterThan(15);
    for (const t of THEMES) {
      const tokens = palettes.get(t.id)!;
      for (const token of tokens.keys()) expect([...base.keys()]).toContain(token); // no typo'd names
      // light and dark are the base pair — they inherit the rest from :root
      if (t.id !== "light" && t.id !== "dark") expect([...base.keys()].filter((x) => !tokens.has(x))).toEqual([]);
      expect(schemes.get(t.id)).toBe(t.mode);
    }
  });

  // the floor is what the original light and dark themes already do, so a new
  // palette can be as pretty as it likes but not less readable than those.
  test("every palette keeps text legible against what it sits on", () => {
    const floors: [string, string, number][] = [
      ["text", "bg-0", 6],
      ["text", "bg-1", 6],
      ["text-2", "bg-0", 4.5],
      ["muted", "bg-1", 3],
      ["on-brand", "brand", 4.5],
      ["code-text", "code-bg", 4.5],
      ["them-text", "them", 4.5],
      ["brand", "bg-0", 3],
    ];
    const thin: string[] = [];
    for (const t of THEMES) {
      const tokens = tokensOf(t.id);
      for (const [fg, bg, floor] of floors) {
        const ratio = contrast(tokens.get(fg)!, tokens.get(bg)!);
        if (ratio < floor) thin.push(`${t.id}: ${fg} on ${bg} is ${ratio.toFixed(1)}:1, wanted ${floor}:1`);
      }
    }
    expect(thin).toEqual([]);
  });

  test("the type covers the ids", () => {
    const t: Theme = "dracula";
    expect(isTheme(t)).toBe(true);
  });
});
