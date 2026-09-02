/** First run: where is Fountain, and who are you. */
import { useState, type FormEvent } from "react";
import { beginLogin } from "../lib/oauth";
import { normalizeBaseUrl, type Settings } from "../lib/settings";

export function Setup(props: { error: string | null; onPaste: (s: Settings) => void }) {
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
    <div className="setup">
      <div className="setup-card">
        <div className="wordmark">
          Briefing <span>Room</span>
        </div>
        <p className="setup-tag">
          Tell it what you need to understand and why; a researcher with its own computer goes and reads, and comes
          back with a clean, sourced brief. Runs on your{" "}
          <a href="https://github.com/BinaryBourbon/fountain">Fountain</a>.
        </p>
        {props.error && <p className="error">{props.error}</p>}
        <label>
          Fountain URL
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://fountain.example.com" autoFocus />
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
            <button type="submit" className="ghost" disabled={!apiKey.trim()}>
              Use this key
            </button>
          </form>
        ) : (
          <button className="linkish" onClick={() => setShowPaste(true)}>
            paste an API key instead
          </button>
        )}
        <p className="fineprint">Everything stays in this browser. Signing out revokes an OAuth key.</p>
      </div>
    </div>
  );
}
