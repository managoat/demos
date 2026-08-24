/**
 * The sign-in gate. Every user authenticates with Fountain: "Sign in with
 * Fountain" (OAuth + PKCE) or a pasted key yields a Fountain API key, which
 * goes to the workbench server once (`POST /api/session`); the server
 * checks it with Fountain, keeps it for the user's projects, and answers
 * with a session cookie. The browser never holds the key after that.
 */
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type Me } from "./lib/api";
import { completeLoginIfCallback } from "./lib/oauth";
import { SignIn } from "./components/SignIn";
import { Layout } from "./components/Layout";
import { ProjectProvider, WorkbenchProvider } from "./store";
import { useRoute } from "./router";
import { Projects } from "./pages/Projects";
import { Project } from "./pages/Project";
import { WorkItem } from "./pages/WorkItem";
import { Team } from "./pages/Team";
import { describeError } from "./lib/errors";

/** The key an earlier build kept in this browser, if any — signed in with once, then forgotten. */
const LEGACY_SETTINGS = "fountain-workbench.settings";

export function App() {
  const [fountainUrl, setFountainUrl] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const cfg = await api.config();
        setFountainUrl(cfg.fountainUrl);

        // Back from Fountain's consent page: exchange the code, hand the key to the server.
        const cb = await completeLoginIfCallback().catch((err) => {
          setError(err instanceof Error ? err.message : String(err));
          return null;
        });
        if (cb) {
          setMe(await api.signIn(cb.apiKey));
          return;
        }

        try {
          setMe(await api.me());
          return;
        } catch (err) {
          if (!(err instanceof ApiError && err.status === 401)) throw err;
        }

        // Not signed in here, but an older build may have left a key in this browser.
        const legacy = readLegacyKey(cfg.fountainUrl);
        if (legacy) {
          try {
            setMe(await api.signIn(legacy));
          } catch {
            // it may have been revoked; sign in properly
          }
          localStorage.removeItem(LEGACY_SETTINGS);
        }
      } catch (err) {
        setError(describeError(err));
      } finally {
        setBooting(false);
      }
    })();
  }, []);

  const onSignOut = useCallback(() => setMe(null), []);

  if (booting || (!fountainUrl && !error)) {
    return (
      <div className="settings">
        <div className="settings-card">
          <h1>{/[?&]code=/.test(window.location.search) ? "Signing in…" : "Workbench"}</h1>
        </div>
      </div>
    );
  }

  if (!me) {
    return (
      <SignIn
        fountainUrl={fountainUrl ?? ""}
        error={error}
        onSignedIn={(who) => {
          setError(null);
          setMe(who);
        }}
      />
    );
  }

  return (
    <WorkbenchProvider key={me.email} me={me} onSignOut={onSignOut}>
      <Router />
    </WorkbenchProvider>
  );
}

function Router() {
  const route = useRoute();
  if (route.page === "projects") {
    return (
      <Layout>
        <Projects />
      </Layout>
    );
  }
  return (
    <ProjectProvider
      key={route.projectId}
      projectId={route.projectId}
      fallback={(state) => (
        <Layout>
          <div className="page narrow">
            {state === "loading" ? (
              <p className="muted">Loading…</p>
            ) : (
              <div className="empty card">
                <p className="strong">No such project.</p>
                <p className="muted">It may have been deleted, or you are not a member of it.</p>
                <a className="button secondary" href="#/">
                  Back to projects
                </a>
              </div>
            )}
          </div>
        </Layout>
      )}
    >
      <Layout>
        {route.page === "team" ? <Team /> : route.page === "item" ? <WorkItem itemId={route.itemId} conversationId={route.conversationId} /> : <Project />}
      </Layout>
    </ProjectProvider>
  );
}

function readLegacyKey(fountainUrl: string): string | null {
  try {
    const raw = localStorage.getItem(LEGACY_SETTINGS);
    if (!raw) return null;
    const s = JSON.parse(raw) as { baseUrl?: string; apiKey?: string };
    if (typeof s.apiKey !== "string" || !s.apiKey) return null;
    if (typeof s.baseUrl === "string" && s.baseUrl.replace(/\/+$/, "") !== fountainUrl) return null;
    return s.apiKey;
  } catch {
    return null;
  }
}
