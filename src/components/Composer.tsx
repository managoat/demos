/**
 * The box you type into, on the home page and at the foot of a chat. Enter
 * sends, Shift+Enter is a newline; images paste, drop or come in through the
 * "+" menu's file picker.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Attachments } from "../lib/images";

export interface ComposerHandle {
  pickFiles: () => void;
  focus: () => void;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  sending: boolean;
  disabled?: boolean;
  placeholder: string;
  attachments: Attachments;
  /** What sits left of the send button: the "+" and chips, or an attach button. */
  left?: ReactNode;
  right?: ReactNode;
  autoFocus?: boolean;
  big?: boolean;
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer({ value, onChange, onSend, sending, disabled, placeholder, attachments, left, right, autoFocus, big }, ref) {
  const file = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const [dragging, setDragging] = useState(false);

  useImperativeHandle(ref, () => ({ pickFiles: () => file.current?.click(), focus: () => area.current?.focus() }), []);

  // Grow with the text, up to a point.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [value]);

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!sending && !disabled && (value.trim() || attachments.payload)) onSend();
    }
  }

  const canSend = !sending && !disabled && (!!value.trim() || !!attachments.payload);

  return (
    <div
      className={`composer${big ? " big" : ""}${dragging ? " dropping" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        setDragging(false);
        attachments.drop(e);
      }}
    >
      {attachments.items.length > 0 && (
        <div className="attachments">
          {attachments.items.map((a) => (
            <span key={a.id} className="attachment">
              <img src={a.dataUrl} alt={a.name} />
              <button type="button" className="chip-x" onClick={() => attachments.remove(a.id)} aria-label={`Remove ${a.name}`}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea ref={area} rows={1} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={onKey} onPaste={attachments.paste} placeholder={placeholder} disabled={disabled} autoFocus={autoFocus} />
      <div className="composer-foot">
        <div className="foot-left">{left}</div>
        <div className="foot-right">
          {right}
          <button type="button" className="send" disabled={!canSend} onClick={onSend} aria-label="Send" title="Send (Enter)">
            {sending ? "…" : "↑"}
          </button>
        </div>
      </div>
      <input
        ref={file}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) attachments.add(Array.from(e.target.files));
          e.target.value = "";
        }}
      />
      {dragging && <div className="drop-hint">Drop to attach</div>}
    </div>
  );
});
