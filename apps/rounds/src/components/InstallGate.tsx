/**
 * The one thing this product cannot do without: the GitHub App, installed.
 *
 * There used to be a way around it — paste a personal access token and rounds
 * would push with that instead. That path is gone, and its absence is the
 * reason this component has to be loud. With no App there is no credential
 * anywhere that can open a pull request, so "not installed yet" is a hard stop
 * and needs to look like one rather than being discovered halfway through an
 * enrollment.
 *
 * Three states, in the order a person meets them: sign in, install, ready.
 */
import type { GhAuth } from "../lib/ghauth";
import type { AppInfo } from "../lib/ghoauth";

export function InstallGate(props: {
  appInfo: AppInfo | null;
  auth: GhAuth | null;
  /** null while unknown, true/false once GitHub has been asked. */
  installed: boolean | null;
  checking: boolean;
  onSignIn: () => void;
  onSignOut: () => void;
  onRecheck: () => void;
}) {
  // Nothing is configured server-side. Not the person's problem to fix, but
  // saying so beats an enroll button that fails for no visible reason.
  if (props.appInfo && !props.appInfo.configured) {
    return (
      <div className="tokenrow warn">
        <span className="dot warnDot" />
        <span className="fineprint">
          This deployment has no GitHub App configured, so it cannot open pull requests for anything. Set{" "}
          <code>GITHUB_APP_ID</code>, <code>GITHUB_APP_PRIVATE_KEY</code>, the OAuth client pair and{" "}
          <code>GRANT_SECRET</code> on the server.
        </span>
      </div>
    );
  }
  if (!props.appInfo?.clientId) return null;

  if (!props.auth) {
    return (
      <div className="tokenrow warn">
        <span className="dot warnDot" />
        <span className="fineprint">
          Sign in with GitHub to enroll a repository. Rounds never stores a GitHub token: each repository holds a
          signed authorization instead, trades it for a read-only token each round, and the pull requests are opened
          by this server.
        </span>
        <button className="primary" onClick={props.onSignIn}>
          Sign in with GitHub
        </button>
      </div>
    );
  }

  if (props.installed === false) {
    return (
      <div className="tokenrow warn">
        <span className="dot warnDot" />
        <span className="fineprint">
          Signed in as <b>{props.auth.login}</b>, but the{" "}
          <a href={props.appInfo.installUrl ?? "#"} target="_blank" rel="noreferrer">
            {props.appInfo.slug}
          </a>{" "}
          App is not installed anywhere yet. Install it on the account that owns the repositories you want audited, and
          grant it only those repositories.
        </span>
        <a className="buttonish" href={props.appInfo.installUrl ?? "#"} target="_blank" rel="noreferrer">
          Install the App
        </a>
        <button className="linkish" onClick={props.onRecheck} disabled={props.checking}>
          {props.checking ? "checking…" : "I've installed it"}
        </button>
      </div>
    );
  }

  if (props.installed === null) {
    return (
      <div className="tokenrow">
        <span className="dot" />
        <span className="fineprint">
          Signed in as <b>{props.auth.login}</b>. Checking where the App is installed…
        </span>
      </div>
    );
  }

  return (
    <div className="tokenrow ok">
      <span className="dot on" />
      <span className="fineprint">
        Signed in as <b>{props.auth.login}</b>, with the App installed. A repository you enroll gets its own signed
        authorization — no GitHub token is stored, and what audits it cannot write anywhere.{" "}
        <a href={props.appInfo.installUrl ?? "#"} target="_blank" rel="noreferrer">
          add or remove repositories
        </a>
      </span>
      <button className="linkish" onClick={props.onSignOut}>
        sign out
      </button>
    </div>
  );
}
