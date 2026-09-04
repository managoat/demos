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
 *
 * Each `when` names the *gesture*, not the mechanism. They used to describe
 * what Fountain does — "injected when a session starts", "only by replacing
 * this one" — which is true and answers the wrong question. Somebody reading a
 * tier heading wants to know what they have to do, and there are exactly three
 * things: press Apply, open a tab, build a new machine. So the headings say
 * those, in parallel, and the mechanism moved behind the (i).
 */
export const TIER = {
  box: { title: "On the box", when: "lands when you apply" },
  session: { title: "Next tab", when: "lands when you open a tab" },
  machine: { title: "New machine", when: "lands when you rebuild" },
} as const;

export function SectionHead({
  title,
  when,
  note,
  action,
}: {
  title: string;
  when: string;
  note: string;
  /**
   * The gesture itself, where a panel can offer it. The heading says "lands
   * when you open a tab"; the button beside it is the tab. Setup has one
   * because Setup is where you change a thing and then wonder how to make it
   * count — Details answers that with the rows underneath instead.
   */
  action?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="section-head">
        <h3>
          {title} <span className="dim">— {when}</span>
        </h3>
        <InfoButton open={open} about={title} onToggle={() => setOpen(!open)} />
        <span className="spacer" />
        {action}
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

/**
 * One thing you can declare, folded shut.
 *
 * Setup is six of these plus the way out, and open at once they were a wall:
 * three add-forms, a nine-chip catalog, a search box and a textarea, all
 * competing before you had decided which one you came for. Every one of them
 * is a form you use once and then never look at again — the part worth having
 * on screen permanently is *what it currently says*, which is what `summary`
 * is. So the shut state is the declaration and the open state is the form,
 * and the page reads as a list of six answers instead of six questions.
 *
 * The summary is the contents rather than a count, where the contents fit.
 * "2 repositories" makes you open it to find out which; the names do not.
 */
export function Editor({
  title,
  info,
  summary,
  defaultOpen,
  children,
}: {
  title: string;
  /** The explanation, if this editor needs one. Folded behind the (i). */
  info?: React.ReactNode;
  /** What this currently declares, shown while shut. */
  summary?: React.ReactNode;
  /**
   * For an editor that is the only thing in its tier. Folding it shut leaves
   * the section reading as empty, which is a worse lie than a little length.
   */
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  const [why, setWhy] = useState(false);
  return (
    <div className={`editor${open ? " open" : ""}`}>
      <div className="editor-head">
        {/* The heading wraps the button rather than the other way round: a
            heading is still a heading when it is the thing you click, and the
            summary belongs inside the target so the whole line is clickable. */}
        <h4>
          <button className="editor-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
            <span className="caret" aria-hidden="true">
              {open ? "▾" : "▸"}
            </span>
            <span className="editor-title">{title}</span>
            {/* A long list of repositories is ellipsized to fit the panel, so
                the whole of it goes in the tooltip rather than nowhere. */}
            {!open && summary !== undefined && (
              <span className="editor-summary" title={typeof summary === "string" ? summary : undefined}>
                {summary}
              </span>
            )}
          </button>
        </h4>
        {info && <InfoButton open={why} about={title} onToggle={() => setWhy(!why)} />}
      </div>
      {info && why && <p className="fine info-note">{info}</p>}
      {open && children}
    </div>
  );
}
