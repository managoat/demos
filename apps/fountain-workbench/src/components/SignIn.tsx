import { useState, type FormEvent } from "react";
import { api, type Me } from "../lib/api";
import { beginLogin } from "../lib/oauth";
import { describeError } from "../lib/errors";

interface Props {
  fountainUrl: string;
  error?: string | null;
  onSignedIn: (me: Me) => void;
}

/** Sign in with the Fountain this workbench is configured for. The key goes to the server, verified with `GET /api/auth/me` there. */
export function SignIn({ fountainUrl, error: initialError, onSignedIn }: Props) {
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [showPaste, setShowPaste] = useState(false);
  const host = fountainUrl.replace(/^https?:\/\//, "");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await api.signIn(apiKey.trim()));
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
          Projects, the work in them, and the agents you pull in to do it — shared with the people you invite. Everyone signs in with{" "}
          <strong>{host || "Fountain"}</strong>; a project's conversations run on its owner's account.
        </p>

        <button
          type="button"
          className="oauth-btn"
          disabled={signingIn || !fountainUrl}
          onClick={async () => {
            setError(null);
            setSigningIn(true);
            try {
              await beginLogin(fountainUrl);
            } catch (err) {
              setError(describeError(err));
              setSigningIn(false);
            }
          }}
        >
          {signingIn ? "Redirecting…" : "Sign in with Fountain"}
        </button>
        <p className="muted small">Opens Fountain to approve access; you come back signed in. The key it mints is kept by this workbench for your projects, and shows under Account → API keys.</p>

        {!showPaste ? (
          <button type="button" className="linklike" onClick={() => setShowPaste(true)}>
            or paste an API key
          </button>
        ) : (
          <>
            <label>
              API key
              <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="ftn_…" autoComplete="off" autoFocus />
            </label>
            <p className="muted small">
              Make one under <em>Account → API keys</em> on {host}. It is stored (encrypted) by this workbench so conversations in your projects can run on it.
            </p>
          </>
        )}

        {error && <div className="error">{error}</div>}
        {showPaste && (
          <div className="row end">
            <button type="submit" disabled={busy || !apiKey.trim()}>
              {busy ? "Connecting…" : "Connect with key"}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}
