import { useState, type FormEvent } from "react";
import { normalizeBaseUrl, type Settings } from "../lib/settings";
import { beginLogin } from "../lib/oauth";
import { describeError } from "../lib/errors";
import { makeClient } from "../store";

interface Props {
  initial: Settings | null;
  error?: string | null;
  onConnected: (settings: Settings, email: string) => void;
  onCancel?: () => void;
}

/** Where is Fountain, and which key. Verified with `GET /api/auth/me` before it is kept. */
export function SettingsScreen({ initial, error: initialError, onConnected, onCancel }: Props) {
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "https://fountain.inevitable.fyi");
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? "");
  const [busy, setBusy] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [showPaste, setShowPaste] = useState(!!initial?.apiKey && initial?.via !== "oauth");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const settings: Settings = { baseUrl: normalizeBaseUrl(baseUrl), apiKey: apiKey.trim(), via: "paste" };
    try {
      const me = await makeClient(settings).me();
      onConnected(settings, me.email);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings">
      <form className="settings-card" onSubmit={submit}>
        <h1>Workbench</h1>
        <p className="muted">
          Projects, the work in them, and the agents you pull in to do it. This app talks only to the Fountain API; the URL and
          key stay in this browser.
        </p>
        <label>
          Fountain URL
          <input type="url" required value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://fountain.example.com" autoComplete="url" />
        </label>

        <button
          type="button"
          className="oauth-btn"
          disabled={signingIn || !baseUrl.trim()}
          onClick={async () => {
            setError(null);
            setSigningIn(true);
            try {
              await beginLogin(baseUrl);
            } catch (err) {
              setError(describeError(err));
              setSigningIn(false);
            }
          }}
        >
          {signingIn ? "Redirecting…" : "Sign in with Fountain"}
        </button>
        <p className="muted small">Opens Fountain to approve access; you come back signed in. Nothing to copy.</p>

        {!showPaste ? (
          <button type="button" className="linklike" onClick={() => setShowPaste(true)}>
            or paste an API key
          </button>
        ) : (
          <>
            <label>
              API key
              <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="ftn_…" autoComplete="off" />
            </label>
            <p className="muted small">
              Make one under <em>Account → API keys</em>. The server must list this site in <code>API_CORS_ORIGINS</code>.
            </p>
          </>
        )}

        {error && <div className="error">{error}</div>}
        <div className="row end">
          {onCancel && (
            <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
          )}
          <button type="submit" disabled={busy || !showPaste || !apiKey.trim()}>
            {busy ? "Connecting…" : "Connect with key"}
          </button>
        </div>
      </form>
    </div>
  );
}
