import { describe, expect, test } from "bun:test";
import { isTheme, THEMES } from "./theme";

const css = await Bun.file(new URL("../styles.css", import.meta.url)).text();

describe("themes", () => {
  test("theme ids are unique and validated", () => {
    expect(new Set(THEMES.map((theme) => theme.id)).size).toBe(THEMES.length);
    for (const theme of THEMES) expect(isTheme(theme.id)).toBe(true);
    expect(isTheme("unknown-theme")).toBe(false);
    expect(isTheme(null)).toBe(false);
  });

  test("every non-default theme has a complete CSS palette", () => {
    const required = [
      "bg", "panel", "sidebar", "surface", "surface-hover", "surface-active", "input", "code-bg",
      "line", "line-strong", "ink", "dim", "accent", "accent-ink", "accent-soft", "accent-line",
      "notice", "ok", "warn", "warn-line", "bad", "danger-bg", "danger-line", "shadow",
    ];

    for (const theme of THEMES.filter((entry) => entry.id !== "paddock")) {
      const block = new RegExp(`:root\\[data-theme="${theme.id}"\\]\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
      for (const token of required) expect(block).toContain(`--${token}:`);
      expect(block).toContain(`color-scheme: ${theme.mode}`);
    }
  });
});
