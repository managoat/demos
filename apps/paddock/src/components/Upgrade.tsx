/**
 * The way out of being a guest.
 *
 * A guest is a good way in and a bad place to stay: anonymous, tied to one
 * terminal, on somebody else's money, and gone the moment that link is
 * re-minted. Signing in fixes all four at once — the seat becomes a real
 * membership under their own name, and they get a machine of their own — so
 * the offer belongs in front of them rather than behind a menu.
 *
 * It is an offer and not a wall. Nothing here interrupts a guest who just
 * wants to use the terminal they were sent; they can dismiss it and it stays
 * dismissed for the session.
 */
import { useEffect, useState } from "react";
import { beginLogin } from "../lib/oauth";
import { paddock } from "../api/paddock";

export function Upgrade({ handle, onKey, error }: { handle: string; onKey: (apiKey: string) => void; error: string | null }) {
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

  return (
    <div className="panel upgrade">
      <header className="panel-head">
        <div>
          <h2>You are {handle}</h2>
          <p className="dim">a guest in this terminal</p>
        </div>
      </header>

      <section>
        <p className="fine">
          Guests are anonymous and temporary. You are in this one terminal, you are spending its owner's Fountain credit, and
          when they make a new link for it you are out.
        </p>

        <div className="section-head">
          <h3>Sign in and you keep it</h3>
        </div>
        <ul className="rows">
          {[
            ["this terminal stays yours", "your seat becomes a real membership, under your own name, on any device"],
            ["a new link no longer evicts you", "re-minting removes guests; members stay"],
            ["your turns say who sent them", `instead of ${handle}`],
            ["and you get a machine of your own", "built the moment you sign in, on your account"],
          ].map(([what, why]) => (
            <li className="row" key={what}>
              <span className="mark">✓</span>
              <span className="row-label">{what}</span>
              <span className="dim">{why}</span>
            </li>
          ))}
        </ul>

        <button className="primary" onClick={() => { setBusy(true); void beginLogin(fountainUrl!).catch(() => setBusy(false)); }} disabled={busy || !fountainUrl}>
          {busy ? "Redirecting…" : "Sign in with Fountain"}
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
          Nothing you are doing here is interrupted, and the terminal keeps running on its owner's account either way — signing
          in does not move this conversation onto your bill.
        </p>
      </section>
    </div>
  );
}
