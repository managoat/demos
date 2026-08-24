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

export function App() {
  const [settings, setSettings] = useState<Settings | null>(() => loadSettings());
  const [editingSettings, setEditingSettings] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [oauthBusy, setOauthBusy] = useState(() => /[?&](code|error)=/.test(window.location.search));
  const [oauthError, setOauthError] = useState<string | null>(null);

  // Finish an in-progress "Sign in with Fountain" before rendering anything.
  useEffect(() => {
    completeLoginIfCallback()
      .then(async (result) => {
        if (!result) return;
        const s: Settings = { baseUrl: result.baseUrl, apiKey: result.apiKey, via: "oauth" };
        try {
          const me = await makeClient(s).me();
          saveSettings(s);
          setSettings(s);
          setEmail(me.email);
        } catch {
          setOauthError("Signed in, but that Fountain could not be reached.");
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
      .then((me) => setEmail(me.email))
      .catch(() => undefined);
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
