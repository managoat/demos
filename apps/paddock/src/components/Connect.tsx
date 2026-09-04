/**
 * Sign in. Either "Sign in with Fountain" (OAuth code + PKCE — the token that
 * comes back is an API key) or paste one. Same shape as every other app in
 * the suite; see `apps/dns-desk` for the original.
 */
import { useState } from "react";
import { beginLogin, redirectUri } from "../lib/oauth";
import { normalizeBaseUrl, type Settings } from "../lib/settings";

const DEFAULT_URL = "https://managoat.com";

export function Connect({ onConnect, error }: { onConnect: (s: Settings) => void; error?: string | null }) {
  const [baseUrl, setBaseUrl] = useState(DEFAULT_URL);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  async function signIn() {
    setBusy(true);
    setFailed(null);
    try {
      await beginLogin(normalizeBaseUrl(baseUrl));
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

        <label>
          Fountain URL
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} spellCheck={false} autoComplete="off" />
        </label>

        <button className="primary" onClick={signIn} disabled={busy || !baseUrl.trim()}>
          {busy ? "Redirecting…" : "Sign in with Fountain"}
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
          <button
            onClick={() => onConnect({ baseUrl: normalizeBaseUrl(baseUrl), apiKey: apiKey.trim(), via: "paste" })}
            disabled={!apiKey.trim() || !baseUrl.trim()}
          >
            Use this key
          </button>
        </details>

        {(failed || error) && <p className="error">{failed ?? error}</p>}

        <p className="fine">
          Sign-in needs this app's client id and <code>{redirectUri()}</code> registered in <code>OAUTH_CLIENTS</code>, and this
          origin in <code>API_CORS_ORIGINS</code>, on the Fountain server. A pasted key needs only the second.
        </p>
      </div>
    </div>
  );
}
