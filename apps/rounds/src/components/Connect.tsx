/**
 * Signing in: where your Fountain is, and who you are.
 *
 * The pitch that used to sit above these fields is the landing page now, so
 * this is only the form. It is placed by whoever renders it rather than
 * centering itself, because it appears at the end of a long page rather than
 * alone on an empty one.
 */
import { useState, type FormEvent } from "react";
import { beginLogin } from "../lib/oauth";
import { normalizeBaseUrl, type Settings } from "../lib/settings";

export function Connect(props: { error: string | null; onPaste: (s: Settings) => void }) {
  const [baseUrl, setBaseUrl] = useState("https://fountain.inevitable.fyi");
  const [showPaste, setShowPaste] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);

  const signIn = async () => {
    setBusy(true);
    try {
      await beginLogin(baseUrl);
    } catch {
      setBusy(false);
    }
  };

  const paste = (e: FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim()) return;
    props.onPaste({ baseUrl: normalizeBaseUrl(baseUrl), apiKey: apiKey.trim(), via: "paste" });
  };

  return (
    <div className="setup-card">
      <h3>Sign in</h3>
      {props.error && <p className="error">{props.error}</p>}
      <label>
        Fountain URL
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://fountain.example.com" />
      </label>
      <button className="primary" onClick={() => void signIn()} disabled={busy || !baseUrl.trim()}>
        Sign in with Fountain
      </button>
      {showPaste ? (
        <form onSubmit={paste} className="paste">
          <label>
            API key
            <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} type="password" placeholder="ftn_…" />
          </label>
          <button type="submit" disabled={!apiKey.trim()}>
            Use this key
          </button>
        </form>
      ) : (
        <button className="linkish" onClick={() => setShowPaste(true)}>
          paste an API key instead
        </button>
      )}
      <p className="fineprint">
        Next: install the GitHub App on the repositories you want audited. Everything stays in this browser; signing
        out revokes an OAuth key.
      </p>
    </div>
  );
}
