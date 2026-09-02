import { useState } from "react";
import type { Contact } from "../api/types";
import { formatPhone, optOutNotice } from "../lib/contact";

/**
 * A teammate's own email and phone, monospace and copyable, plus the line
 * that says whose texts reach them. Used in the thread header strip and in
 * Customize → Profile.
 */
export function ContactLine({ contact, compact = false, onChangeNumber }: { contact: Contact; compact?: boolean; onChangeNumber?: () => void }) {
  const paused = optOutNotice(contact);
  return (
    <div className={`contact-line ${compact ? "compact" : ""}`}>
      {contact.email && <Copyable value={contact.email} label="email address" icon="✉" />}
      {contact.phone && <Copyable value={contact.phone} shown={formatPhone(contact.phone)} label="phone number" icon="☎" />}
      {paused ? (
        <span className="small contact-from contact-paused" role="status">
          {paused}
        </span>
      ) : (
        contact.prompt_from_number && (
          <span className="muted small contact-from" title={`Texts from ${formatPhone(contact.prompt_from_number)} to ${contact.phone ? formatPhone(contact.phone) : "this number"} arrive in this thread as prompts; texts from anyone else are ignored`}>
            Texts from <span className="mono">{formatPhone(contact.prompt_from_number)}</span> arrive here as prompts
          </span>
        )
      )}
      {onChangeNumber && (
        <button type="button" className="secondary small" onClick={onChangeNumber} title="Replace the number whose texts reach this teammate (clears a STOP)">
          Change number…
        </button>
      )}
    </div>
  );
}

/** `value` in monospace with a Copy button (after the code block's Copy in Markdown). */
export function Copyable({ value, shown, label, icon }: { value: string; shown?: string; label: string; icon?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="copyable">
      {icon && (
        <span className="muted" aria-hidden>
          {icon}{" "}
        </span>
      )}
      <span className="mono" title={value}>
        {shown ?? value}
      </span>
      <button
        type="button"
        className="secondary small"
        aria-label={`Copy ${label}`}
        title={`Copy ${label}`}
        onClick={() => {
          navigator.clipboard
            .writeText(value)
            .then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            })
            .catch(() => undefined);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}
