/**
 * The colour theme: a named palette out of a list, the way a terminal or an
 * editor lets you pick one, remembered per browser and applied as
 * `data-theme` on <html>. "system" means no attribute at all, so the CSS
 * follows the OS between the default light and dark.
 *
 * The palettes themselves live in src/styles.css — one block of tokens per
 * id here, plus a matching `.pal-<id>` the theme menu uses for its swatches.
 */
export type ThemeMode = "light" | "dark";
export type ThemeDef = { id: string; name: string; mode: ThemeMode };

export const THEMES = [
  { id: "light", name: "workbench light", mode: "light" },
  { id: "solarized-light", name: "solarized light", mode: "light" },
  { id: "catppuccin-latte", name: "catppuccin latte", mode: "light" },
  { id: "dark", name: "workbench dark", mode: "dark" },
  { id: "solarized-dark", name: "solarized dark", mode: "dark" },
  { id: "nord", name: "nord", mode: "dark" },
  { id: "dracula", name: "dracula", mode: "dark" },
  { id: "gruvbox-dark", name: "gruvbox dark", mode: "dark" },
  { id: "tokyo-night", name: "tokyo night", mode: "dark" },
  { id: "one-dark", name: "one dark", mode: "dark" },
] as const satisfies readonly ThemeDef[];

export type ThemeEntry = (typeof THEMES)[number];
export type ThemeId = ThemeEntry["id"];
/** A palette by name, or "system" to follow the OS. */
export type Theme = ThemeId | "system";

const KEY = "fountain-workbench.theme";

export function isTheme(v: unknown): v is Theme {
  return v === "system" || THEMES.some((t) => t.id === v);
}

export function themesOf(mode: ThemeMode): ThemeEntry[] {
  return THEMES.filter((t) => t.mode === mode);
}

export function themeName(theme: Theme): string {
  return theme === "system" ? "follow the OS" : (THEMES.find((t) => t.id === theme)?.name ?? theme);
}

/** ☀/☾ for a palette, ◐ for "whatever the OS says" — the top bar's button. */
export function themeGlyph(theme: Theme): string {
  if (theme === "system") return "◐";
  return THEMES.find((t) => t.id === theme)?.mode === "dark" ? "☾" : "☀";
}

/** The class that puts one theme's tokens on one element, for a preview. */
export function paletteClass(id: ThemeId): string {
  return `pal-${id}`;
}

export function loadTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return isTheme(v) ? v : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
}

export function saveTheme(theme: Theme): void {
  try {
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // a browser that blocks storage still gets the theme for this page
  }
  applyTheme(theme);
}
