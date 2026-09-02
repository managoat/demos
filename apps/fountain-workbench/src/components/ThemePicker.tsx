/**
 * The theme menu in the top bar: one line per palette, grouped light and
 * dark, each with a swatch painted in that theme's own colours. Hovering a
 * line puts the theme on the whole app so you can see it before you commit;
 * leaving the menu or closing it puts back the one you have.
 */
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import {
  applyTheme,
  loadTheme,
  paletteClass,
  saveTheme,
  themeGlyph,
  themeName,
  themesOf,
  type Theme,
  type ThemeMode,
} from "../lib/theme";

const MODES: ThemeMode[] = ["light", "dark"];

export function ThemePicker() {
  const [theme, setTheme] = useState(loadTheme);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const close = () => {
    applyTheme(theme); // drop any preview from hovering
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, theme]);

  const pick = (t: Theme) => {
    saveTheme(t);
    setTheme(t);
    setOpen(false);
  };

  const option = (t: Theme, label: string, swatch: ReactNode) => (
    <button
      key={t}
      type="button"
      role="menuitemradio"
      aria-checked={theme === t}
      className={`theme-option ${theme === t ? "on" : ""}`}
      onClick={() => pick(t)}
      onMouseEnter={() => applyTheme(t)}
      onFocus={() => applyTheme(t)}
    >
      {swatch}
      <span className="theme-option-name">{label}</span>
      {theme === t && <span className="theme-check">✓</span>}
    </button>
  );

  return (
    <div className="theme-picker" ref={box}>
      <button
        type="button"
        className="icon"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        title={`Theme: ${themeName(theme)}`}
        aria-label={`Theme: ${themeName(theme)}`}
      >
        {themeGlyph(theme)}
      </button>
      {open && (
        <div className="theme-menu" role="menu" aria-label="Theme" onMouseLeave={() => applyTheme(theme)}>
          {option("system", themeName("system"), <span className="theme-swatch system" />)}
          {MODES.map((mode) => (
            <Fragment key={mode}>
              <div className="theme-menu-label">{mode}</div>
              {themesOf(mode).map((t) =>
                option(
                  t.id,
                  t.name,
                  <span className={`theme-swatch ${paletteClass(t.id)}`}>
                    <i className="s-bg" />
                    <i className="s-surface" />
                    <i className="s-brand" />
                    <i className="s-ok" />
                  </span>,
                ),
              )}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
