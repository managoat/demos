/**
 * First run, while the machine is being built.
 *
 * The steps are the real ones — an environment, a vault, an agent, then the
 * box — ticked off as they actually finish, not a bar that fills on a timer.
 * It is the first thing paddock ever shows a person, and a made-up progress
 * bar would be the first thing it ever lied about.
 *
 * The aside underneath rotates and is only there to make the wait pleasant.
 * It says nothing load-bearing, which is why it is allowed to be silly.
 *
 * It is also the first thing a visitor with no account sees, which is what the
 * `unclaimed` variant is for. The old copy promised a machine that "stays
 * yours" and that it "is only built once", and neither is true yet for
 * somebody who has not claimed it: the honest version says the machine is real
 * and the ownership is the part still outstanding. Overpromising here would
 * make the claim offer read as an upsell rather than as the thing that makes
 * the promise true.
 */
import { useEffect, useState } from "react";
import type { BootStep } from "../lib/identity";

const STEPS: { key: BootStep; label: string; note: string }[] = [
  { key: "environment", label: "Fencing the paddock", note: "the environment your disk gets built from" },
  { key: "vault", label: "Hanging the key safe", note: "secrets that never touch the box" },
  { key: "agent", label: "Hiring the goat", note: "the agent that lives here" },
  { key: "machine", label: "Turning it out", note: "the machine itself" },
  { key: "waking", label: "Waiting for it to settle", note: "the first turn is already running" },
];

const ASIDES = [
  "Goats are not fussy eaters. They are, however, extremely curious eaters.",
  "A paddock is fenced so the things inside it stay inside it.",
  "This is the slowest paddock will ever be. It is only built once.",
  "The machine persists. Close the tab, come back next week, it is here.",
  "Nothing you add later will take this box away from you.",
];

/** The same wait, for somebody who does not own the thing being built yet. */
const UNCLAIMED_ASIDES = [
  "Goats are not fussy eaters. They are, however, extremely curious eaters.",
  "A paddock is fenced so the things inside it stay inside it.",
  "No form, no key, no account. The box is real and it is starting now.",
  "Claim it whenever you like and this exact machine stays — same disk, same history.",
  "Everything you do from here is on the box, not in this browser.",
];

export function Starting({
  step,
  name,
  another,
  unclaimed,
  error,
  onRetry,
}: {
  step: BootStep;
  /** What the owner calls the computer being built. */
  name: string;
  /** Not the account's first. The steps are the same; the sentence is not. */
  another: boolean;
  /** Nobody owns this one yet. The steps are the same; the promise is not. */
  unclaimed: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const [aside, setAside] = useState(0);
  const asides = unclaimed ? UNCLAIMED_ASIDES : ASIDES;

  useEffect(() => {
    if (error) return;
    const t = window.setInterval(() => setAside((n) => (n + 1) % asides.length), 4000);
    return () => window.clearInterval(t);
  }, [error, asides.length]);

  const at = STEPS.findIndex((s) => s.key === step);

  return (
    <div className="connect">
      <div className="connect-card">
        <h1>
          <span className="glyph">🐐</span> {unclaimed ? "Starting a computer" : `Building ${another && name ? name : "your machine"}`}
        </h1>
        <p className="lede">
          {unclaimed
            ? "A real machine, starting now, with no account and no key. It is yours to use straight away — and yours to keep, from the moment you claim it."
            : another
              ? "A machine of its own: its own disk, its own packages, its own secrets. Your other computers are untouched, and this happens once per machine."
              : "One computer, yours, that stays up between visits. This happens once."}
        </p>

        <ul className="rows steps">
          {STEPS.map((s, i) => {
            const state = error && i === at ? "failed" : i < at ? "done" : i === at ? "doing" : "todo";
            return (
              <li className={`row step ${state}`} key={s.key}>
                <span className="mark">{state === "done" ? "✓" : state === "failed" ? "⨯" : state === "doing" ? "◐" : "·"}</span>
                <span className="row-label">{s.label}</span>
                <span className="dim">{s.note}</span>
              </li>
            );
          })}
        </ul>

        {error ? (
          <>
            <p className="error">{error}</p>
            <button className="primary" onClick={onRetry}>
              Try again
            </button>
            <p className="fine">Nothing was half-made: whatever already exists is found again rather than duplicated.</p>
          </>
        ) : (
          <p className="fine aside">{asides[aside % asides.length]}</p>
        )}
      </div>
    </div>
  );
}
