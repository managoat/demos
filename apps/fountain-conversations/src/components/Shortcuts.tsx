import { useEffect, useState } from "react";
import { navigate, paths } from "../router";

/**
 * The web UI's keyboard: `?` opens this sheet, `g` then a letter jumps
 * (1.5 s chord window, never while typing in a field), Esc closes.
 */
export const SHORTCUTS: Array<[string, string]> = [
  ["g c", "New conversation"],
  ["g l", "Conversation list"],
  ["g a", "Agents"],
  ["g e", "Environments"],
  ["g v", "Vaults"],
  ["Enter", "Send a prompt (Shift+Enter for a new line)"],
  ["⌘/Ctrl+Enter", "Start the conversation on the New page"],
  ["?", "This sheet"],
  ["Esc", "Close it"],
];

const CHORDS: Record<string, string> = {
  c: paths.new(),
  l: paths.index,
  a: paths.agents,
  e: paths.environments,
  v: paths.vaults,
};

function editing(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

export function useShortcuts(): { sheetOpen: boolean; closeSheet: () => void } {
  const [sheetOpen, setSheetOpen] = useState(false);
  useEffect(() => {
    let chordUntil = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        setSheetOpen(false);
        return;
      }
      if (e.key === "?" && (!editing() || sheetOpen)) {
        e.preventDefault();
        setSheetOpen((v) => !v);
        return;
      }
      if (editing()) return;
      const now = Date.now();
      if (now < chordUntil && CHORDS[e.key]) {
        chordUntil = 0;
        e.preventDefault();
        navigate(CHORDS[e.key]!);
        return;
      }
      chordUntil = e.key === "g" ? now + 1500 : 0;
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sheetOpen]);
  return { sheetOpen, closeSheet: () => setSheetOpen(false) };
}

export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-root">
      <div className="backdrop" onClick={onClose} />
      <div className="modal" role="dialog" aria-label="Keyboard shortcuts">
        <header className="row">
          <h2 className="h2 grow">Keyboard shortcuts</h2>
          <button type="button" className="icon" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <dl className="shortcuts">
          {SHORTCUTS.map(([k, what]) => (
            <div key={k}>
              <dt>
                {k.split(" ").map((part, i) => (
                  <kbd key={i}>{part}</kbd>
                ))}
              </dt>
              <dd>{what}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
