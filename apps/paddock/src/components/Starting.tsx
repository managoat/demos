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
 */
import { useEffect, useState } from "react";
import type { BootStep } from "../lib/identity";

const STEPS: { key: BootStep; label: string; note: string }[] = [
  { key: "environment", label: "Fencing the paddock", note: "the environment your disk gets built from" },
  { key: "vault", label: "Hanging the key safe", note: "secrets that never touch the box" },
  { key: "agent", label: "Hiring the goat", note: "the agent that lives here" },
  { key: "machine", label: "Turning it out", note: "the machine itself, and it stays yours" },
  { key: "waking", label: "Waiting for it to settle", note: "the first turn is already running" },
];

const ASIDES = [
  "Goats are not fussy eaters. They are, however, extremely curious eaters.",
  "A paddock is fenced so the things inside it stay inside it.",
  "This is the slowest paddock will ever be. It is only built once.",
  "The machine persists. Close the tab, come back next week, it is here.",
  "Nothing you add later will take this box away from you.",
];

export function Starting({ step, error, onRetry }: { step: BootStep; error: string | null; onRetry: () => void }) {
  const [aside, setAside] = useState(0);

  useEffect(() => {
    if (error) return;
    const t = window.setInterval(() => setAside((n) => (n + 1) % ASIDES.length), 4000);
    return () => window.clearInterval(t);
  }, [error]);

  const at = STEPS.findIndex((s) => s.key === step);

  return (
    <div className="connect">
      <div className="connect-card">
        <h1>
          <span className="glyph">🐐</span> Building your machine
        </h1>
        <p className="lede">One computer, yours, that stays up between visits. This happens once.</p>

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
          <p className="fine aside">{ASIDES[aside]}</p>
        )}
      </div>
    </div>
  );
}
