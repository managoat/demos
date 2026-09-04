/**
 * The screen with nothing on it yet.
 *
 * Conductor's is a wall of block letters and three cards, and the three cards
 * are the whole product surface: open something local, open something from
 * GitHub, or start from nothing. Two of those three transfer.
 *
 * The one that does not is **Open project** — a folder on your Mac. There is
 * no folder here and there is not going to be one, so it is not a disabled
 * button or a "soon" badge on a card that looks like the others. It gets its
 * own smaller row underneath, and it says what the answer actually is: push
 * the repository and open it from GitHub. A card that looks live and is not is
 * worse than an honest sentence.
 */
import type { Capabilities, Project, Viewer } from "../../shared/api";
import { hrefFor } from "../lib/route";
import { Wordmark } from "./Wordmark";

interface Props {
  viewer: Viewer;
  capabilities: Capabilities;
  projects: Project[];
  onNewProject: () => void;
}

export function Home({ viewer, capabilities, projects, onNewProject }: Props) {
  return (
    <div className="dd-home">
      <div className="dd-home-inner">
        <Wordmark />

        <div className="dd-cards">
          <button className="dd-card" type="button" onClick={onNewProject} disabled={!capabilities.github}>
            <GlobeIcon />
            <span className="dd-card-name">Open GitHub project</span>
            <span className="dd-card-note">
              {capabilities.github
                ? "Pick a repository. Every thread gets a fresh clone of it on a machine of its own."
                : "This deployment has no GitHub App configured."}
            </span>
          </button>

          <button className="dd-card" type="button" onClick={onNewProject} disabled={!capabilities.fountain}>
            <SparkIcon />
            <span className="dd-card-name">Quick start</span>
            <span className="dd-card-note">
              {capabilities.fountain
                ? "A machine with no repository on it. Good for trying something out."
                : "This deployment has no Fountain account configured, so it cannot build machines."}
            </span>
          </button>
        </div>

        <p className="dd-home-aside">
          Conductor's third card opens a folder on your Mac. There is no folder here — a drydock project lives on a machine in
          the cloud, so push the repository and open it from GitHub instead.
        </p>

        {projects.length > 0 && (
          <div className="dd-recents">
            <h4>Recents</h4>
            {projects.slice(0, 8).map((p) => (
              <a key={p.id} className="dd-recent" href={hrefFor({ at: "project", projectId: p.id })}>
                <FolderIcon />
                <span className="clip mono">{p.repo ?? p.name}</span>
                {p.openThreads > 0 && <span className="chip">{p.openThreads} open</span>}
              </a>
            ))}
          </div>
        )}

        {!viewer.hasInstallation && capabilities.github && (
          <p className="dd-home-aside">
            Drydock cannot see any repositories yet. <a href="/api/auth/install">Install the GitHub App</a> and choose which
            ones it may reach.
          </p>
        )}
      </div>
    </div>
  );
}

export function SignIn({ signInUrl, capabilities }: { signInUrl: string; capabilities: Capabilities }) {
  return (
    <div className="dd-home dd-standalone">
      <div className="dd-home-inner dd-signin">
        <Wordmark />
        <p className="dd-lede">
          Conductor, for machines in the cloud. A project is a repository and the agent that works on it; every thread you
          open gets a fresh clone on a machine of its own, with a real terminal on it.
        </p>
        {capabilities.github ? (
          <a className="dd-signin-button" href={signInUrl}>
            <GitHubIcon />
            Sign in with GitHub
          </a>
        ) : (
          <p className="fine">
            This deployment has no GitHub App configured, so there is no way to sign in. It needs <code>GITHUB_APP_ID</code>,{" "}
            <code>GITHUB_OAUTH_CLIENT_ID</code>, <code>GITHUB_OAUTH_CLIENT_SECRET</code> and{" "}
            <code>GITHUB_APP_PRIVATE_KEY</code>.
          </p>
        )}
      </div>
    </div>
  );
}

// ── icons ──────────────────────────────────────────────────────────────

function GlobeIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4">
      <circle cx="10" cy="10" r="7.25" />
      <path d="M2.75 10h14.5M10 2.75c1.9 2 2.85 4.4 2.85 7.25S11.9 15.25 10 17.25c-1.9-2-2.85-4.4-2.85-7.25S8.1 4.75 10 2.75Z" />
    </svg>
  );
}

function SparkIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
      <path d="M3.25 4.25h9.5v11.5h-9.5z" />
      <path d="M13.5 7.5h3.25M15.25 5.75 17 7.5l-1.75 1.75" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <path d="M2 4.5h4l1.2 1.5H14v7.5H2z" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}
