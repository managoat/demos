/** Light / dark / follow-the-OS, remembered per browser; applied as `data-theme` on <html>. */
export type Theme = "light" | "dark" | "system";

const KEY = "fountain-workbench.theme";

export function loadTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
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

export function nextTheme(theme: Theme): Theme {
  return theme === "system" ? "light" : theme === "light" ? "dark" : "system";
}

export const THEME_GLYPH: Record<Theme, string> = { system: "◐", light: "☀", dark: "☾" };
