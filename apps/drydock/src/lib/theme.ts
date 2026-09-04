/**
 * Which of the three palettes is on.
 *
 * Stored in `localStorage` and applied to `<html>` as `data-theme`, which is
 * the only mechanism — every colour in the app is a custom property defined
 * under one of those selectors, so switching the attribute switches
 * everything, including anything a component has not been written yet.
 *
 * Applied before React mounts (see `main.tsx`) so there is no frame of the
 * default palette before the chosen one. That flash is small and it is the
 * kind of thing that makes an app feel unfinished.
 */

export const THEMES = [
  { id: "", name: "Slate", hint: "the default: cool, near-black" },
  { id: "ember", name: "Ember", hint: "warm, softer contrast" },
  { id: "daylight", name: "Daylight", hint: "light" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

const KEY = "drydock.theme";

export function storedTheme(): ThemeId {
  try {
    const raw = localStorage.getItem(KEY) ?? "";
    return THEMES.some((t) => t.id === raw) ? (raw as ThemeId) : "";
  } catch {
    // A private window, or site data switched off. The default palette is a
    // complete answer, so this is not worth telling anybody about.
    return "";
  }
}

export function applyTheme(id: ThemeId): void {
  const root = document.documentElement;
  if (id) root.setAttribute("data-theme", id);
  else root.removeAttribute("data-theme");
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // As above: the theme still applies for this page, it just will not be
    // remembered. Failing the switch over that would be worse.
  }
}
