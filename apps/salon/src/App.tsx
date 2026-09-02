/**
 * Boot: finish an OAuth callback if this page load is one, find out who is
 * signed in, then the shell — sidebar plus the page the hash names.
 */
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type Me } from "./lib/api";
import { describeError } from "./lib/errors";
import { completeLoginIfCallback } from "./lib/oauth";
import { completeGitHubConnectIfCallback } from "./lib/github";
import { SignIn } from "./components/SignIn";
import { Sidebar } from "./components/Sidebar";
import { Home } from "./pages/Home";
import { Chat } from "./pages/Chat";
import { Join } from "./pages/Join";
import { useRoute } from "./router";
import { SessionProvider, useSession } from "./store";
import { Onboarding, Preferences } from "./components/AccountSetup";

type Phase = { kind: "booting" } | { kind: "signin"; fountainUrl: string; error: string | null } | { kind: "in"; me: Me; error?: string | null };

export function App() {
  const [phase, setPhase] = useState<Phase>({ kind: "booting" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let fountainUrl = "";
      let error: string | null = null;
      try {
        fountainUrl = (await api.config()).fountainUrl;
      } catch (err) {
        error = describeError(err);
      }
      try {
        const github = await completeGitHubConnectIfCallback();
        if (github) {
          const me = await api.me();
          if (!cancelled) setPhase({ kind: "in", me });
          return;
        }
        const cb = await completeLoginIfCallback();
        if (cb) {
          // Keep the minted key even if the next step fails: it is stored the
          // moment the server verifies it, and a failed verify is shown, not lost.
          const me = await api.signIn(cb.apiKey);
          if (cb.hash) window.location.hash = cb.hash;
          if (!cancelled) setPhase({ kind: "in", me });
          return;
        }
      } catch (err) {
        error = describeError(err);
      }
      try {
        const me = await api.me();
        if (!cancelled) setPhase({ kind: "in", me, error });
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 401)) error = error ?? describeError(err);
        if (!cancelled) setPhase({ kind: "signin", fountainUrl, error });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const signedOut = useCallback(() => {
    void api.config().then((c) => setPhase({ kind: "signin", fountainUrl: c.fountainUrl, error: null })).catch(() => setPhase({ kind: "signin", fountainUrl: "", error: null }));
  }, []);

  if (phase.kind === "booting") return <div className="boot">Signing in…</div>;
  if (phase.kind === "signin") return <SignIn fountainUrl={phase.fountainUrl} error={phase.error} onSignedIn={(me) => setPhase({ kind: "in", me })} />;
  return (
    <SessionProvider me={phase.me} onSignOut={signedOut} initialError={phase.error}>
      <Shell />
    </SessionProvider>
  );
}

function Shell() {
  const route = useRoute();
  const { me } = useSession();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [route]);
  if (!me.onboardingComplete) return <Onboarding />;
  return (
    <div className={`shell${open ? " nav-open" : ""}`}>
      <Sidebar route={route} onClose={() => setOpen(false)} />
      <main className="page">
        <button className="icon nav-toggle" onClick={() => setOpen((o) => !o)} aria-label="Menu">
          ☰
        </button>
        {route.page === "home" && <Home />}
        {route.page === "chat" && <Chat key={route.id} id={route.id} />}
        {route.page === "join" && <Join token={route.token} />}
        {route.page === "preferences" && <Preferences />}
      </main>
      {open && <div className="scrim" onClick={() => setOpen(false)} />}
    </div>
  );
}
