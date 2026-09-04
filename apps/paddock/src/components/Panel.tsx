/**
 * The vocabulary the Details and Setup panels are both written in.
 *
 * Those two are one subject cut in half — what the machine is, and what it is
 * made of — so they have to agree about the three tiers and to look like each
 * other while doing it. `TIER` is that agreement made unforgeable: the name of
 * a tier and the sentence saying when it lands are declared once, and a panel
 * passes only its own `note`, which is the part that genuinely differs
 * depending on whether you are reading a row or editing one.
 *
 * `Editor` and `InfoButton` come with it because the two panels are the same
 * design, not because Setup happens to be the file that uses them today.
 */
import { useState } from "react";

/**
 * The three answers to "when does this take effect?".
 *
 * Details lists rows under these headings; Setup puts the editors that produce
 * those rows under the same ones, in the same order. Moving between the panels
 * is then reading one thing from two sides rather than learning a second
 * layout.
 */
export const TIER = {
  box: { title: "On the box", when: "applied by a turn on this machine" },
  session: { title: "Next tab", when: "injected when a session starts" },
  machine: { title: "New machine", when: "only by replacing this one" },
} as const;

export function SectionHead({ title, when, note }: { title: string; when: string; note: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="section-head">
        <h3>
          {title} <span className="dim">— {when}</span>
        </h3>
        <InfoButton open={open} about={title} onToggle={() => setOpen(!open)} />
      </div>
      {open && <p className="fine info-note">{note}</p>}
    </>
  );
}

/**
 * The (i). It is a toggle rather than a tooltip because the thing it opens is
 * a sentence or three that somebody may want to read twice, and a hover
 * bubble is not readable on a touchscreen or by a keyboard at all.
 */
export function InfoButton({ open, about, onToggle }: { open: boolean; about: string; onToggle: () => void }) {
  return (
    <button
      className={`info${open ? " on" : ""}`}
      onClick={onToggle}
      aria-expanded={open}
      aria-label={`${open ? "Hide" : "What"} ${about.toLowerCase()} means`}
      title={open ? "hide" : `about ${about.toLowerCase()}`}
    >
      i
    </button>
  );
}

export function Editor({
  title,
  info,
  right,
  children,
}: {
  title: string;
  /** The explanation, if this editor needs one. Folded behind the (i). */
  info?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="editor">
      <div className="editor-head">
        <h4>{title}</h4>
        {info && <InfoButton open={open} about={title} onToggle={() => setOpen(!open)} />}
        <span className="spacer" />
        {right}
      </div>
      {info && open && <p className="fine info-note">{info}</p>}
      {children}
    </div>
  );
}
