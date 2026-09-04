/**
 * Making an unclaimed computer yours.
 *
 * The sibling of `Upgrade.tsx`, and the difference between them is the whole
 * feature. A guest is being offered *somebody else's* terminal on better
 * terms. Somebody here is already the owner of a whole machine — this one,
 * with their files and their history on it — and is being offered the thing
 * that stops it going away.
 *
 * So the promise has to be exact, because it is unusually strong and people
 * will not believe it: signing in does not build a second computer and copy
 * anything across. The machine is a Fountain principal, the claim attaches an
 * account to that principal, and no resource is touched. Same box, same disk,
 * same agent, same conversations, same ids — and the sentence below says so
 * because it is true, not because it sells.
 *
 * It is an offer and not a wall. Nothing here interrupts somebody who just
 * wants to keep typing in Terminal 1.
 */
import { useEffect, useState } from "react";
import { beginLogin } from "../lib/oauth";
import { paddock, type ClaimState } from "../api/paddock";

export function Claim({ claim, onKey, error }: { claim: ClaimState | null | undefined; onKey: (apiKey: string) => void; error: string | null }) {
  const [fountainUrl, setFountainUrl] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [pasting, setPasting] = useState(false);

  useEffect(() => {
    void paddock
      .config()
      .then((c) => setFountainUrl(c.fountainUrl))
      .catch(() => undefined);
  }, []);

  const left = remaining(claim?.expiresAt ?? null);

  return (
    <div className="panel upgrade">
      <header className="panel-head">
        <div>
          <h2>This computer is not claimed</h2>
          <p className="dim">{left ? `it stops in ${left}` : "nobody owns it yet"}</p>
        </div>
      </header>

      <section>
        <p className="fine">
          You started this machine without an account, so it is running on this demo's introductory credit and on a clock.
          When the clock runs out the box goes, and everything on it goes with it.
        </p>

        <div className="section-head">
          <h3>Claim it and it is yours</h3>
        </div>
        <ul className="rows">
          {[
            ["the same machine, not a copy", "same disk, same agent, same terminal history — nothing is rebuilt or moved"],
            ["it stops expiring", "the clock above is only there while nobody owns it"],
            ["open it from any browser", "sign in somewhere else and this box is what you land on"],
            ["and you can change it", "more terminals, repositories, packages, secrets, and people you invite"],
          ].map(([what, why]) => (
            <li className="row" key={what}>
              <span className="mark">✓</span>
              <span className="row-label">{what}</span>
              <span className="dim">{why}</span>
            </li>
          ))}
        </ul>

        <button
          className="primary"
          onClick={() => {
            setBusy(true);
            void beginLogin(fountainUrl!).catch(() => setBusy(false));
          }}
          disabled={busy || !fountainUrl}
        >
          {busy ? "Redirecting…" : "Claim this computer"}
        </button>

        {!pasting ? (
          <p className="fine">
            <button className="linkish" onClick={() => setPasting(true)}>
              or paste an API key
            </button>
          </p>
        ) : (
          <div className="editor-row">
            <input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              type="password"
              placeholder="ftn_…"
              spellCheck={false}
              autoComplete="off"
            />
            <button onClick={() => onKey(apiKey.trim())} disabled={!apiKey.trim()}>
              Use this key
            </button>
          </div>
        )}

        {error && <p className="error">{error}</p>}
        <p className="fine">
          A brand-new Fountain account works, and so does one you already use — claiming does not merge this machine into
          anything you have there, it just puts your account behind it. Future usage moves to your account from that moment.
        </p>
      </section>
    </div>
  );
}

/**
 * How long is left, in the coarsest unit that is still honest.
 *
 * Deliberately not a ticking countdown. This is an offer sitting beside a
 * working terminal, and a second-by-second clock on it would turn a machine
 * somebody is using into a machine somebody is watching run out.
 */
export function remaining(expiresAt: string | null): string | null {
  if (!expiresAt) return null;
  const ms = Date.parse(expiresAt) - Date.now();
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return "no time";
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${Math.round(hours / 24)} days`;
}
