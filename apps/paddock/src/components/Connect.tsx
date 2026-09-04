/**
 * Sign in. Either "Sign in with Fountain" (OAuth code + PKCE) or paste a key.
 *
 * What changed in phase 2: the key does not stay here. It is handed to the
 * Paddock server, which verifies it with Fountain, keeps it encrypted so the
 * machine's tabs can run on it, and gives the browser a session cookie back.
 * That is what lets somebody else use your machine without ever holding your
 * key — and it is why the server has one at all.
 *
 * Which Fountain to sign in with is the server's answer, not a field: there is
 * one per deployment, and asking the visitor to type it invited them to point
 * a shared server at something it cannot use.
 */
import { useEffect, useState } from "react";
import { beginLogin, redirectUri } from "../lib/oauth";
import { paddock } from "../api/paddock";

export function Connect({ onConnect, error }: { onConnect: (apiKey: string) => void; error?: string | null }) {
  const [fountainUrl, setFountainUrl] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    void paddock
      .config()
      .then((c) => setFountainUrl(c.fountainUrl))
      .catch(() => setFailed("Could not reach the Paddock server."));
  }, []);

  async function signIn() {
    if (!fountainUrl) return;
    setBusy(true);
    setFailed(null);
    try {
      await beginLogin(fountainUrl);
    } catch (err) {
      setFailed(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="connect">
      <div className="connect-card">
        <h1>
          <span className="glyph">🐐</span> Paddock
        </h1>
        <p className="lede">
          A computer in the cloud that stays yours. Terminal tabs are threads on one box, and changing the machine is a turn
          rather than a rebuild.
        </p>

        <button className="primary" onClick={signIn} disabled={busy || !fountainUrl}>
          {busy ? "Redirecting…" : fountainUrl ? "Sign in with Fountain" : "…"}
        </button>

        <details>
          <summary>or paste an API key</summary>
          <label>
            API key
            <input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              type="password"
              placeholder="ftn_…"
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <button onClick={() => onConnect(apiKey.trim())} disabled={!apiKey.trim()}>
            Use this key
          </button>
          <p className="fine">
            It goes to the Paddock server, which keeps it encrypted so your machine's tabs can run on it. Revoke it in Fountain
            under Account → API keys.
          </p>
        </details>

        {(failed || error) && <p className="error">{failed ?? error}</p>}

        <p className="fine">
          Signing in needs this app's client id and <code>{redirectUri()}</code> registered in <code>OAUTH_CLIENTS</code> on{" "}
          {fountainUrl ? <code>{fountainUrl}</code> : "the Fountain server"}. Handed an invite link instead? Just open it — no
          account needed.
        </p>
      </div>
    </div>
  );
}
