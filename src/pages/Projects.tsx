import { useEffect, useState, type FormEvent } from "react";
import { useWorkbench } from "../store";
import { api } from "../lib/api";
import { agentFits, clearLegacyState, loadLegacyState, type LegacyState } from "../lib/workbench";
import { describeError } from "../lib/errors";
import { href } from "../router";
import { TwoStep } from "../components/Thread";
import { formatTime } from "../lib/format";
import { EnvVaultFields } from "../components/EnvVaultFields";
import { DefaultTeammateField } from "../components/DefaultTeammateField";
import type { MyResources } from "../lib/api";

export function Projects() {
  const { me, projects, projectsLoaded, activity, refreshProjects, refreshActivity, toast } = useWorkbench();
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [environmentId, setEnvironmentId] = useState("");
  const [vaultId, setVaultId] = useState("");
  const [defaultAgentId, setDefaultAgentId] = useState("");
  const [dropped, setDropped] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resources, setResources] = useState<MyResources | null>(null);
  const [legacy, setLegacy] = useState<LegacyState | null>(() => loadLegacyState());

  // The new-project form needs your own environments, vaults and agents — the
  // computer the project will be, and who does its work.
  useEffect(() => {
    api
      .myResources()
      .then((r) => {
        setResources(r);
        // One agent is almost certainly the answer, so start on it rather than
        // making the first project the slow path over a list of one. The field
        // says whose name it is and undoes it in a click.
        if (r.agents.length === 1) setDefaultAgentId(r.agents[0]!.id);
      })
      .catch((err) => toast(describeError(err), "error"));
  }, [toast]);

  /**
   * The environment or vault just changed, which can put the chosen teammate
   * outside the project it is about to make. Drop the pick and say so: a
   * default that cannot run is one every picker ignores, and creating the
   * project with it set would look like a project that starts with somebody.
   */
  function keepFit(next: { environmentId: string | null; vaultId: string | null }) {
    const agent = resources?.agents.find((a) => a.id === defaultAgentId);
    if (!agent) return;
    const fit = agentFits(agent, next);
    if (fit.ok) return;
    setDefaultAgentId("");
    setDropped(`${agent.name} ${fit.reason}, so new work here will ask every time.`);
  }

  function pickTeammate(id: string) {
    setDefaultAgentId(id);
    setDropped(null);
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await api.createProject({ name, notes, environmentId: environmentId || null, vaultId: vaultId || null, defaultAgentId: defaultAgentId || null });
      setName("");
      setNotes("");
      setDropped(null);
      await refreshProjects();
    } catch (err) {
      toast(describeError(err), "error");
    } finally {
      setBusy(false);
    }
  }

  async function importLegacy() {
    if (!legacy) return;
    try {
      const r = await api.importState(legacy);
      clearLegacyState();
      setLegacy(null);
      toast(`Imported ${r.projects} project${r.projects === 1 ? "" : "s"} and ${r.items} work item${r.items === 1 ? "" : "s"}.`);
      await refreshProjects();
      void refreshActivity();
    } catch (err) {
      toast(describeError(err), "error");
    }
  }

  async function recover() {
    try {
      const r = await api.recover();
      toast(r.projects || r.items ? `Recovered ${r.projects} project${r.projects === 1 ? "" : "s"} and ${r.items} work item${r.items === 1 ? "" : "s"} from your conversations.` : "Nothing to recover: every workbench conversation on your account is already in a project.");
      await refreshProjects();
      void refreshActivity();
    } catch (err) {
      toast(describeError(err), "error");
    }
  }

  const mine = projects.filter((p) => p.role === "owner");
  const shared = projects.filter((p) => p.role !== "owner");

  const row = (p: (typeof projects)[number]) => {
    const a = activity.projects[p.id];
    return (
      <li key={p.id}>
        <a className="conv-row" href={href.project(p.id)}>
          <div className="conv-main">
            <div className="conv-title">
              <span className="strong">{p.name}</span>
              {(a?.live ?? 0) > 0 && <span className="pill running">{a!.live} working</span>}
              {p.members.length > 0 && p.role === "owner" && <span className="pill">shared with {p.members.length}</span>}
            </div>
            <div className="conv-sub muted">
              {p.counts.open} open · {p.counts.done} done
              {p.counts.wont > 0 ? ` · ${p.counts.wont} won't do` : ""}
              {p.role === "member" ? ` · ${p.ownerEmail}'s` : ""}
              {p.notes ? ` · ${p.notes}` : ""}
            </div>
          </div>
          <div className="conv-side">
            <span className="time muted">{formatTime(a?.latest ?? p.createdAt)}</span>
          </div>
        </a>
        {p.role === "owner" ? (
          <TwoStep
            label="Delete"
            onConfirm={() =>
              api
                .deleteProject(p.id)
                .then(() => refreshProjects())
                .catch((err) => toast(describeError(err), "error"))
            }
            className="danger small self-center"
          />
        ) : (
          <TwoStep
            label="Leave"
            onConfirm={() =>
              api
                .removeMember(p.id, me.email)
                .then(() => refreshProjects())
                .catch((err) => toast(describeError(err), "error"))
            }
            className="danger small self-center"
          />
        )}
      </li>
    );
  };

  return (
    <div className="page narrow">
      <div className="page-header">
        <h1>Projects</h1>
        <div className="row">
          {/* Your bill and where it went. Only the owner pays, so only the owner's own account is here. */}
          <a className="button secondary small" href={href.cost()} title="Your Fountain bill, and the projects you own that it paid for">
            Cost
          </a>
          <button className="secondary small" onClick={recover} title="Rebuild projects from the workbench conversations on your Fountain account">
            Recover from Fountain
          </button>
        </div>
      </div>

      {legacy && (
        <div className="card stack tight notice">
          <p className="strong">This browser has {legacy.projects.length} project{legacy.projects.length === 1 ? "" : "s"} from before the workbench had accounts.</p>
          <p className="muted small">Import them to your account here — their conversations on Fountain will line up, since the ids are kept. The local copy is cleared afterwards.</p>
          <div className="row">
            <button className="small" onClick={importLegacy}>
              Import {legacy.projects.length} project{legacy.projects.length === 1 ? "" : "s"}
            </button>
            <button
              className="secondary small"
              onClick={() => {
                clearLegacyState();
                setLegacy(null);
              }}
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {!projectsLoaded ? (
        <p className="muted">Loading…</p>
      ) : projects.length === 0 ? (
        <div className="empty card">
          <p className="strong">No projects yet.</p>
          <p className="muted">A project is an environment and a vault — the computer its work gets — and holds work items, where you pull in teammates. Share it, and its conversations run on your account for everyone in it.</p>
        </div>
      ) : (
        <>
          {mine.length > 0 && <ul className="conv-list">{mine.map(row)}</ul>}
          {shared.length > 0 && (
            <>
              <h2 className="h2 section">Shared with you</h2>
              <ul className="conv-list">{shared.map(row)}</ul>
            </>
          )}
        </>
      )}

      <form className="card stack new-form" onSubmit={create}>
        <h2 className="h2">New project</h2>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Fountain" required />
        </label>
        <EnvVaultFields
          environments={resources?.environments ?? []}
          vaults={resources?.vaults ?? []}
          loaded={!!resources}
          environmentId={environmentId}
          vaultId={vaultId}
          onEnvironment={(id) => {
            setEnvironmentId(id);
            keepFit({ environmentId: id || null, vaultId: vaultId || null });
          }}
          onVault={(id) => {
            setVaultId(id);
            keepFit({ environmentId: environmentId || null, vaultId: id || null });
          }}
        />
        <DefaultTeammateField
          agents={resources?.agents ?? []}
          loaded={!!resources}
          project={{ environmentId: environmentId || null, vaultId: vaultId || null }}
          value={defaultAgentId}
          onChange={pickTeammate}
          hint="Who new work here starts with. With one set, a work item typed in the explorer starts them on it the moment you press Enter — which brings a computer up on your account. You can change it later in Settings & sharing."
        />
        {dropped && <p className="muted small">{dropped}</p>}
        <label>
          Notes <span className="hint">Where the code is, what it is. Shown to members, not sent to agents.</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="github.com/BinaryBourbon/fountain" />
        </label>
        <div className="row end">
          <button type="submit" disabled={!name.trim() || busy}>
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}
