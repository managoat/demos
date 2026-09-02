import { useEffect, useState, type FormEvent } from "react";
import { api, type GitHubInfo } from "../lib/api";
import { describeError } from "../lib/errors";
import { useSession } from "../store";
import { Mark } from "./Mark";
import { NewProject } from "./SettingsMenu";
import { Avatar } from "./Avatar";

export function Onboarding() {
  const { me, setMe, projects, toast } = useSession();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [github, setGithub] = useState<GitHubInfo | null>(null);
  const [finishing, setFinishing] = useState(false);

  useEffect(() => {
    void api.github().then(setGithub).catch((err) => toast(describeError(err), "error"));
  }, [toast]);

  async function finish() {
    setFinishing(true);
    try {
      setMe(await api.completeOnboarding());
      toast("Workspace ready. Welcome to Salon.");
    } catch (err) {
      toast(describeError(err), "error");
    } finally {
      setFinishing(false);
    }
  }

  return (
    <div className="onboarding">
      <div className="onboarding-head">
        <div className="brand setup-brand"><Mark size={22} /> Salon</div>
        <span className="muted small">Signed in as {me.email}</span>
      </div>
      <div className="setup-shell">
        <div className="setup-progress" aria-label={`Step ${step} of 3`}>
          {[1, 2, 3].map((n) => <span key={n} className={n <= step ? "on" : ""} />)}
        </div>
        {step === 1 && (
          <section className="setup-card">
            <p className="eyebrow">Step 1 of 3</p>
            <h1 className="display">Connect a repository</h1>
            <p className="muted">Install the Salon GitHub App, then choose the repository you want your team to work in. Salon receives scoped, short-lived access—never your personal GitHub token.</p>
            <RepositorySettings compact />
            <div className="setup-actions">
              <button className="primary" disabled={github?.configured !== false && projects.length === 0} onClick={() => setStep(2)}>Continue</button>
            </div>
          </section>
        )}
        {step === 2 && (
          <section className="setup-card">
            <p className="eyebrow">Step 2 of 3</p>
            <h1 className="display">Add your AI token</h1>
            <p className="muted">This inference token pays for AI work in threads you start. It is encrypted on the server and never shared with teammates.</p>
            <TokenSettings />
            <div className="setup-actions split">
              <button className="ghost" onClick={() => setStep(1)}>Back</button>
              <button className="primary" disabled={!me.inferenceToken.connected} onClick={() => setStep(3)}>Continue</button>
            </div>
          </section>
        )}
        {step === 3 && (
          <section className="setup-card">
            <p className="eyebrow">Step 3 of 3</p>
            <h1 className="display">Bring in your team</h1>
            <p className="muted">Add teammates once, then type <strong>@their-name</strong> in any thread. They’ll find it under Shared with you and receive a notification.</p>
            <TeamSettings />
            <div className="setup-actions split">
              <button className="ghost" onClick={() => setStep(2)}>Back</button>
              <button className="primary" disabled={finishing} onClick={() => void finish()}>{finishing ? "Finishing…" : "Start using Salon"}</button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

export function Preferences() {
  return (
    <div className="preferences">
      <header>
        <p className="eyebrow">Account</p>
        <h1 className="display">Preferences</h1>
        <p className="muted">Manage the access Salon uses and the people you collaborate with.</p>
      </header>
      <section className="preference-section">
        <div><h2>Repositories</h2><p className="muted small">GitHub App access and repositories available to new threads.</p></div>
        <div className="preference-control"><RepositorySettings /></div>
      </section>
      <section className="preference-section">
        <div><h2>Inference token</h2><p className="muted small">The private Fountain token used for AI work you host.</p></div>
        <div className="preference-control"><TokenSettings /></div>
      </section>
      <section className="preference-section">
        <div><h2>Workspace</h2><p className="muted small">People you can mention to share a thread instantly.</p></div>
        <div className="preference-control"><TeamSettings /></div>
      </section>
    </div>
  );
}

function RepositorySettings({ compact = false }: { compact?: boolean }) {
  const { projects, refreshProjects } = useSession();
  const [adding, setAdding] = useState(projects.length === 0);

  function made() {
    void refreshProjects();
    setAdding(false);
  }

  return (
    <div className={`repository-settings${compact ? " compact" : ""}`}>
      {projects.length > 0 && (
        <div className="connected-list">
          {projects.map((p) => (
            <div className="connected-row" key={p.id}>
              <span className="status-check">✓</span>
              <span><strong>{p.name}</strong><small>{p.repoUrl.replace(/^https:\/\//, "")} · {p.base}</small></span>
              <span className="tag">{p.githubManaged ? "GitHub App" : "repository"}</span>
            </div>
          ))}
        </div>
      )}
      {adding ? (
        <div className="embedded-project"><NewProject onMade={made} /></div>
      ) : (
        <button className="small" onClick={() => setAdding(true)}>+ Add repository</button>
      )}
      {projects.length === 0 && !adding && <button className="small" onClick={() => setAdding(true)}>Connect GitHub</button>}
    </div>
  );
}

function TokenSettings() {
  const { me, setMe, toast } = useSession();
  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!token.trim()) return;
    setBusy(true);
    try {
      setMe(await api.updateToken(token.trim()));
      setToken("");
      setEditing(false);
      toast("Inference token updated.");
    } catch (err) {
      toast(describeError(err), "error");
    } finally {
      setBusy(false);
    }
  }

  if (!editing && me.inferenceToken.connected) {
    return (
      <div className="connected-row token-row">
        <span className="status-check">✓</span>
        <span><strong>Token connected</strong><small>Updated {new Date(me.inferenceToken.updatedAt).toLocaleDateString()}</small></span>
        <button className="small" onClick={() => setEditing(true)}>Replace</button>
      </div>
    );
  }
  return (
    <form className="token-form" onSubmit={save}>
      <label>Fountain inference token<input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="ftn_…" autoComplete="off" autoFocus /></label>
      <div className="row end">
        {me.inferenceToken.connected && <button type="button" className="ghost small" onClick={() => setEditing(false)}>Cancel</button>}
        <button type="submit" className="primary small" disabled={busy || !token.trim()}>{busy ? "Verifying…" : "Save token"}</button>
      </div>
    </form>
  );
}

function TeamSettings() {
  const { workspace, refreshWorkspace, toast } = useSession();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    try {
      await api.addWorkspaceMember(email.trim());
      setEmail("");
      await refreshWorkspace();
      toast("Teammate added. Mention them in any thread to share it.");
    } catch (err) {
      toast(describeError(err), "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove(email: string) {
    setBusy(true);
    try {
      await api.removeWorkspaceMember(email);
      await refreshWorkspace();
    } catch (err) {
      toast(describeError(err), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="team-settings">
      {workspace.length > 0 && <div className="team-list">{workspace.map((m) => (
        <div className="team-row" key={m.email}><Avatar email={m.email} size={28} /><span>{m.email}</span><button className="linklike tiny" disabled={busy} onClick={() => void remove(m.email)}>Remove</button></div>
      ))}</div>}
      <form className="team-add" onSubmit={add}>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@company.com" />
        <button type="submit" className="small" disabled={busy || !email.trim()}>{busy ? "Adding…" : "Add teammate"}</button>
      </form>
      <p className="muted tiny">They do not get access to repositories or tokens. A thread is shared only when you mention them or invite them directly.</p>
    </div>
  );
}
