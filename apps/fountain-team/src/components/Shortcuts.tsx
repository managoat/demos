import { useEffect } from "react";

export const SHORTCUTS: Array<[string, string]> = [
  ["⌘K / Ctrl+K", "Jump to a teammate, or search every conversation"],
  ["Alt+↑ / Alt+↓", "Previous / next teammate"],
  ["Enter", "Send (Shift+Enter for a new line)"],
  ["Esc", "Close a dialog or menu · back to the roster on a phone"],
  ["?", "This list (when the composer isn't focused)"],
];

export function Shortcuts({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-root">
      <div className="backdrop" onClick={onClose} />
      <div className="modal" role="dialog" aria-label="Keyboard shortcuts">
        <header>
          <h2>Keyboard shortcuts</h2>
          <button type="button" className="icon" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <dl className="shortcuts">
          {SHORTCUTS.map(([k, what]) => (
            <div key={k}>
              <dt>
                <kbd>{k}</kbd>
              </dt>
              <dd>{what}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
