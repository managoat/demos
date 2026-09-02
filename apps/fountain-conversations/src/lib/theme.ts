/** Light / dark / follow-the-OS, remembered per browser; applied as `data-theme` on <html>. */
export type Theme = "light" | "dark" | "system";

const KEY = "fountain-conversations.theme";

export function loadTheme(): Theme {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : "system";
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
}

export function saveTheme(theme: Theme): void {
  if (theme === "system") localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, theme);
  applyTheme(theme);
}

export function nextTheme(theme: Theme): Theme {
  return theme === "system" ? "light" : theme === "light" ? "dark" : "system";
}
