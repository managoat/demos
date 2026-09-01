/** A popover anchored under a button, closed by a click outside or Escape. */
import { useEffect, useRef, type ReactNode } from "react";

export function Popover({ open, onClose, align = "left", children, className = "" }: { open: boolean; onClose: () => void; align?: "left" | "right"; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Deferred so the click that opened it does not close it.
    const t = setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div ref={ref} className={`popover ${align} ${className}`} role="menu">
      {children}
    </div>
  );
}

export function MenuItem({ label, detail, checked, onClick, arrow, disabled }: { label: ReactNode; detail?: ReactNode; checked?: boolean; onClick?: () => void; arrow?: boolean; disabled?: boolean }) {
  return (
    <button type="button" className={`menu-item${checked ? " checked" : ""}`} onClick={onClick} disabled={disabled} role="menuitem">
      <span className="menu-text">
        <span className="menu-label">{label}</span>
        {detail && <span className="menu-detail">{detail}</span>}
      </span>
      {checked && <span className="menu-check">✓</span>}
      {arrow && <span className="menu-arrow">›</span>}
    </button>
  );
}

export function MenuHeading({ children }: { children: ReactNode }) {
  return <div className="menu-heading">{children}</div>;
}
