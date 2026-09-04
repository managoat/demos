/**
 * Three palettes, behind one button.
 *
 * A menu rather than a cycle button: three is enough that clicking through
 * them to find the one you wanted is annoying, and each one's name is worth
 * seeing. Paddock's picker is the same idea with more themes.
 */
import { useEffect, useRef, useState } from "react";
import { THEMES, applyTheme, storedTheme, type ThemeId } from "../lib/theme";

export function ThemePicker() {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeId>(storedTheme);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const choose = (id: ThemeId) => {
    applyTheme(id);
    setTheme(id);
    setOpen(false);
  };

  return (
    <div className="dd-theme" ref={box}>
      <button className="icon" type="button" onClick={() => setOpen((v) => !v)} title="Theme" aria-label="Theme">
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="8" cy="8" r="5.25" />
          <path d="M8 2.75v10.5" />
          <path d="M8 2.75a5.25 5.25 0 0 1 0 10.5" fill="currentColor" stroke="none" opacity=".55" />
        </svg>
      </button>
      {open && (
        <div className="dd-theme-menu" role="menu">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={`dd-theme-item${t.id === theme ? " on" : ""}`}
              type="button"
              role="menuitem"
              onClick={() => choose(t.id)}
            >
              <span className={`dd-theme-swatch dd-theme-${t.id || "slate"}`} />
              <span className="col">
                <span>{t.name}</span>
                <span className="faint dd-theme-hint">{t.hint}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
