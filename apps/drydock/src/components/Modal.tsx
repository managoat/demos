/**
 * The box the two pickers open inside.
 *
 * The visible part of this is nine lines of CSS. The part worth having is the
 * keyboard: a dialog that does not trap focus is one a keyboard can tab out
 * of and behind, into a page it cannot see, and both pickers here are meant to
 * be driven without a mouse. So the trap, the restore of focus on close and
 * the `role` are the component; the panel around them is styling.
 */
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import "../styles/pickers.css";

export interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** The footer bar. Leave it out and there is no bar. */
  footer?: ReactNode;
  /** Wider, for the panes that list things rather than ask one question. */
  wide?: boolean;
}

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export function Modal({ title, onClose, children, footer, wide }: ModalProps) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Escape is read on the document rather than on the panel: a person hitting
  // escape means the dialog, not whatever happens to hold focus inside it.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // `[data-autofocus]` first, because the first focusable thing in the panel
  // is the close button in the head and landing there means a picker opens
  // with the search field one tab away — which is the whole of the difference
  // between a keyboard picker and a mouse one.
  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const body = el.querySelector<HTMLElement>(".dd-modal-body");
    (el.querySelector<HTMLElement>("[data-autofocus]") ?? body?.querySelector<HTMLElement>(FOCUSABLE) ?? el).focus();
    return () => returnTo?.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const el = panel.current;
    if (!el) return;
    const stops = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null);
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="dd-modal-backdrop"
      // mousedown rather than click, so a selection dragged out of the panel
      // and released on the backdrop does not count as clicking away.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={wide ? "dd-modal dd-modal-wide" : "dd-modal"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={panel}
        onKeyDown={onKeyDown}
      >
        <div className="dd-modal-head">
          <h2 id={titleId} className="dd-modal-title">
            {title}
          </h2>
          <button type="button" className="icon dd-modal-close" onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="dd-modal-body">{children}</div>
        {footer ? <div className="dd-modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}
