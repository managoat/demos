import { useEffect, useRef, type ReactNode } from "react";

export interface MenuItem {
  label: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  /** a separator above this item */
  divider?: boolean;
}

/** A small positioned menu that closes on outside click, Escape, or blur. */
export function Menu({ x, y, items, onClose, label }: { x: number; y: number; items: MenuItem[]; onClose: () => void; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  const left = Math.min(x, window.innerWidth - 240);
  const top = Math.min(y, window.innerHeight - 40 * items.length - 20);
  return (
    <div className="menu" ref={ref} style={{ left, top }} role="menu" aria-label={label}>
      {items.map((it, i) => (
        <span key={i} className="menu-item-wrap">
          {it.divider && <hr />}
          <button
            role="menuitem"
            className={it.danger ? "danger-text" : ""}
            onClick={() => {
              onClose();
              it.onSelect();
            }}
          >
            {it.label}
          </button>
        </span>
      ))}
    </div>
  );
}
