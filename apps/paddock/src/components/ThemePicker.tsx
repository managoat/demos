import { useEffect, useRef, useState } from "react";
import { loadTheme, saveTheme, THEMES, type Theme } from "../lib/theme";

/** A compact editor-style theme menu with live previews. */
export function ThemePicker() {
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [open, setOpen] = useState(false);
  const picker = useRef<HTMLDivElement>(null);

  useEffect(() => {
    saveTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!picker.current?.contains(event.target as Node)) {
        document.documentElement.dataset.theme = theme;
        setOpen(false);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        document.documentElement.dataset.theme = theme;
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open, theme]);

  const selected = THEMES.find((entry) => entry.id === theme)!;

  return (
    <div className="theme-picker" ref={picker}>
      <button
        type="button"
        className="theme-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title="Change color theme"
      >
        <span className={`theme-swatch theme-swatch-${theme}`} />
        <span className="theme-trigger-copy">
          <span className="theme-trigger-label">Color theme</span>
          <span>{selected.name}</span>
        </span>
        <span className="theme-chevron">⌃</span>
      </button>

      {open && (
        <div className="theme-menu" role="menu" aria-label="Color theme" onMouseLeave={() => (document.documentElement.dataset.theme = theme)}>
          <div className="theme-menu-label">Select color theme</div>
          {THEMES.map((entry) => (
            <button
              type="button"
              key={entry.id}
              className={`theme-option ${entry.id === theme ? "on" : ""}`}
              role="menuitemradio"
              aria-checked={entry.id === theme}
              onMouseEnter={() => (document.documentElement.dataset.theme = entry.id)}
              onFocus={() => (document.documentElement.dataset.theme = entry.id)}
              onClick={() => {
                setTheme(entry.id);
                saveTheme(entry.id);
                setOpen(false);
              }}
            >
              <span className={`theme-swatch theme-swatch-${entry.id}`} />
              <span>{entry.name}</span>
              <span className="spacer" />
              {entry.id === theme && <span className="theme-check">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

