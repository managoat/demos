/** A named editor-style colour theme, persisted only in this browser. */
export const THEMES = [
  { id: "paddock", name: "Paddock Dark", mode: "dark" },
  { id: "midnight", name: "Midnight", mode: "dark" },
  { id: "nord", name: "Nord", mode: "dark" },
  { id: "solarized-light", name: "Solarized Light", mode: "light" },
] as const;

export type Theme = (typeof THEMES)[number]["id"];

const STORAGE_KEY = "paddock.theme";

export function isTheme(value: unknown): value is Theme {
  return THEMES.some((theme) => theme.id === value);
}

export function loadTheme(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return isTheme(saved) ? saved : "paddock";
  } catch {
    return "paddock";
  }
}

export function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // A storage-restricted browser still gets the theme for this page.
  }
  document.documentElement.dataset.theme = theme;
}

