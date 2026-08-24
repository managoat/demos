import { useEffect, useState } from "react";
import { clearSettings, loadSettings, saveSettings, type Settings } from "./lib/settings";
import { completeLoginIfCallback, revoke } from "./lib/oauth";
import { SettingsScreen } from "./components/Settings";
import { Layout } from "./components/Layout";
import { StoreProvider, makeClient } from "./store";
import { useRoute } from "./router";
import { Projects } from "./pages/Projects";
import { Project } from "./pages/Project";
import { WorkItem } from "./pages/WorkItem";
import { Team } from "./pages/Team";
import { describeError } from "./lib/errors";

export function App() {
  const [settings, setSettings] = useState<Settings | null>(() => loadSettings());
  const [editingSettings, setEditingSettings] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [oauthBusy, setOauthBusy] = useState(() => /[?&](code|error)=/.test(window.location.search));
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [startupError, setStartupError] = useState<string | null>(null);

  // Finish an in-progress "Sign in with Fountain" before rendering anything.
  useEffect(() => {
    completeLoginIfCallback()
      .then(async (result) => {
        if (!result) return;
        // The token is minted and valid whatever happens next; keep it. A
        // failing `me()` is reported in the app, not by throwing the key away
        // (each retry would leave another orphaned key in Account → API keys).
        const s: Settings = { baseUrl: result.baseUrl, apiKey: result.apiKey, via: "oauth" };
        saveSettings(s);
        setSettings(s);
        try {
          const me = await makeClient(s).me();
          setEmail(me.email);
        } catch (err) {
          console.error("workbench: /api/auth/me failed after sign-in", err);
          setStartupError(`Signed in, but /api/auth/me failed: ${describeError(err)}`);
        }
      })
      .catch((err) => setOauthError(err instanceof Error ? err.message : String(err)))
      .finally(() => setOauthBusy(false));
  }, []);

  // Learn who we are when the key was pasted or restored from storage.
  useEffect(() => {
    if (!settings || email) return;
    makeClient(settings)
      .me()
      .then((me) => {
        setEmail(me.email);
        setStartupError(null);
      })
      .catch((err) => {
        console.error("workbench: /api/auth/me failed", err);
        setStartupError(`/api/auth/me failed: ${describeError(err)}`);
      });
  }, [settings, email]);

  if (oauthBusy) {
    return (
      <div className="settings">
        <div className="settings-card">
          <h1>Signing in…</h1>
        </div>
      </div>
    );
  }

  if (!settings || editingSettings) {
    return (
      <SettingsScreen
        initial={settings}
        error={oauthError}
        onCancel={settings ? () => setEditingSettings(false) : undefined}
        onConnected={(s, who) => {
          saveSettings(s);
          setSettings(s);
          setEmail(who);
          setEditingSettings(false);
          setOauthError(null);
        }}
      />
    );
  }

  return (
    <StoreProvider key={settings.baseUrl + settings.apiKey} settings={settings}>
      <Layout
        email={email}
        startupError={startupError}
        onSettings={() => setEditingSettings(true)}
        onSignOut={() => {
          if (settings.via === "oauth") void revoke(settings.baseUrl, settings.apiKey);
          clearSettings();
          setSettings(null);
          setEmail(null);
        }}
      >
        <Router />
      </Layout>
    </StoreProvider>
  );
}

function Router() {
  const route = useRoute();
  switch (route.page) {
    case "team":
      return <Team />;
    case "project":
      return <Project projectId={route.projectId} />;
    case "item":
      return <WorkItem projectId={route.projectId} itemId={route.itemId} conversationId={route.conversationId} />;
    default:
      return <Projects />;
  }
}
