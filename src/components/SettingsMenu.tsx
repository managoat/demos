/**
 * The two menus on the composer: the model pill on the right, and the "+"
 * on the left — photos, skills, connectors, people. The shape is the one the
 * desktop chat apps taught. Nothing here asks for an agent or a computer;
 * the server derives those from these picks (server/agents.ts).
 */
import { useCallback, useState } from "react";
import { shortName } from "../../shared/author";
import { groupByProvider, modelBlurb, modelLabel, providerLabel } from "../../shared/models";
import { baseBranch, parseRepoUrl, type ProjectDto } from "../../shared/projects";
import type { ChatSettings } from "../../shared/settings";
import { SKILLS, skillNames } from "../../shared/skills";
import { api, type MenuDto } from "../lib/api";
import { describeError } from "../lib/errors";
import { useSession } from "../store";
import { MenuBack, MenuHeading, MenuItem, Popover } from "./Menu";

export function ModelPill({ settings, menu, onChange }: { settings: ChatSettings; menu: MenuDto | null; onChange: (s: ChatSettings) => void }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const models = menu?.models ?? [];
  const groups = groupByProvider(models.includes(settings.model) ? models : [settings.model, ...models]);

  return (
    <div className="pill-wrap">
      <button type="button" className={`pill${open ? " on" : ""}`} onClick={() => (open ? close() : setOpen(true))} aria-haspopup="menu" aria-expanded={open}>
        <span className="pill-main">{modelLabel(settings.model)}</span>
        <span className="pill-caret">⌄</span>
      </button>
      <Popover open={open} onClose={close} align="right" className="model-menu">
        {!menu && <MenuHeading>Loading…</MenuHeading>}
        {groups.map((g) => (
          <div key={g.provider}>
            <MenuHeading>{providerLabel(g.provider)}</MenuHeading>
            {g.models.map((m) => (
              <MenuItem
                key={m}
                label={modelLabel(m)}
                detail={modelBlurb(m) ?? undefined}
                checked={m === settings.model}
                onClick={() => {
                  onChange({ ...settings, model: m });
                  close();
                }}
              />
            ))}
          </div>
        ))}
      </Popover>
    </div>
  );
}

export interface Extras {
  invitees: string[];
}

export function AddMenu({
  settings,
  menu,
  menuError,
  onChange,
  extras,
  onExtras,
  onAttach,
  projects,
  onProjectsChanged,
}: {
  settings: ChatSettings;
  menu: MenuDto | null;
  menuError: string | null;
  onChange: (s: ChatSettings) => void;
  extras: Extras;
  onExtras: (e: Extras) => void;
  onAttach: () => void;
  projects: ProjectDto[];
  onProjectsChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"root" | "skills" | "connectors" | "people" | "projects" | "new-project">("root");
  const [email, setEmail] = useState("");
  const close = useCallback(() => {
    setOpen(false);
    setView("root");
  }, []);
  const project = settings.projectId ? (projects.find((p) => p.id === settings.projectId) ?? null) : null;

  const toggleSkill = (id: string) => {
    const skills = settings.skills.includes(id) ? settings.skills.filter((s) => s !== id) : [...settings.skills, id].sort();
    onChange({ ...settings, skills });
  };
  const toggleConnector = (id: string) => {
    const connectorIds = settings.connectorIds.includes(id) ? settings.connectorIds.filter((c) => c !== id) : [...settings.connectorIds, id].sort();
    onChange({ ...settings, connectorIds });
  };
  const chosenSkills = skillNames(settings.skills);
  const chosenConnectors = connectorLabels(settings.connectorIds, menu);

  const addEmail = () => {
    const e = email.trim().toLowerCase();
    if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return;
    if (!extras.invitees.includes(e)) onExtras({ invitees: [...extras.invitees, e] });
    setEmail("");
  };

  const connectors = menu?.connectors ?? null;

  return (
    <div className="pill-wrap">
      <button type="button" className={`icon plus${open ? " on" : ""}`} onClick={() => (open ? close() : setOpen(true))} aria-label="Add" aria-haspopup="menu" aria-expanded={open}>
        +
      </button>
      <Popover open={open} onClose={close} className="add-menu">
        {view === "root" && (
          <>
            <MenuItem
              icon="📎"
              label="Add photos"
              detail="Or paste or drop them in"
              onClick={() => {
                close();
                onAttach();
              }}
            />
            <div className="menu-sep" />
            <MenuItem label="Projects" detail={project ? project.name : "A repository the chat works in"} arrow onClick={() => setView("projects")} />
            <MenuItem label="Skills" detail={chosenSkills.length ? chosenSkills.join(", ") : "PDFs, spreadsheets, slides and more"} arrow onClick={() => setView("skills")} />
            <MenuItem
              label="Connectors"
              detail={chosenConnectors.length ? chosenConnectors.join(", ") : connectors && !connectors.enabled ? "Not available on your account yet" : "Gmail and other accounts you have linked"}
              arrow
              onClick={() => setView("connectors")}
            />
            <div className="menu-sep" />
            <MenuItem label="People" detail={extras.invitees.length ? `${extras.invitees.length} invited` : "Invite by email; they see it when they sign in"} arrow onClick={() => setView("people")} />
            {menuError && <div className="menu-problem">{menuError}</div>}
          </>
        )}
        {view === "projects" && (
          <>
            <MenuBack onClick={() => setView("root")} />
            {projects.length === 0 && <MenuHeading>No projects yet. Add a repository and the chat's computer starts with a checkout of it.</MenuHeading>}
            {projects.map((p) => (
              <MenuItem
                key={p.id}
                label={p.name}
                detail={`${p.repoUrl.replace(/^https:\/\//, "")} · ${p.base}${p.role === "member" ? ` · ${shortName(p.ownerEmail)}'s` : ""}`}
                checked={settings.projectId === p.id}
                onClick={() => onChange({ ...settings, projectId: settings.projectId === p.id ? null : p.id })}
              />
            ))}
            <div className="menu-sep" />
            <MenuItem label="Add a repository…" detail="GitHub, or any https git address" arrow onClick={() => setView("new-project")} />
            {projects.length > 0 && <MenuHeading>Everyone in a project is in every chat started in it, and the project's owner pays for them.</MenuHeading>}
          </>
        )}
        {view === "new-project" && (
          <>
            <MenuBack onClick={() => setView("projects")} />
            <NewProject
              onMade={(p) => {
                onProjectsChanged();
                onChange({ ...settings, projectId: p.id });
                setView("projects");
              }}
            />
          </>
        )}
        {view === "skills" && (
          <>
            <MenuBack onClick={() => setView("root")} />
            {SKILLS.map((s) => (
              <MenuItem key={s.id} toggle label={s.name} detail={s.blurb} checked={settings.skills.includes(s.id)} onClick={() => toggleSkill(s.id)} />
            ))}
            <MenuHeading>Each one teaches the chat how to work with that kind of file.</MenuHeading>
          </>
        )}
        {view === "connectors" && (
          <>
            <MenuBack onClick={() => setView("root")} />
            {!connectors && <MenuHeading>{menuError ?? "Loading…"}</MenuHeading>}
            {connectors && !connectors.enabled && (
              <MenuHeading>
                Connectors let a chat read and send from accounts you have linked on Fountain, such as Gmail. They are not switched on for your Fountain account yet — it is a limited-access feature, so ask Fountain to enable it for you.
              </MenuHeading>
            )}
            {connectors?.enabled && (
              <>
                {connectors.items.length === 0 && <MenuHeading>Nothing linked yet.</MenuHeading>}
                {connectors.items.map((c) => (
                  <MenuItem
                    key={c.id}
                    toggle
                    label={c.account ? `${c.label} · ${c.account}` : c.label}
                    detail={c.why ?? undefined}
                    checked={settings.connectorIds.includes(c.id)}
                    disabled={!c.usable}
                    onClick={() => toggleConnector(c.id)}
                  />
                ))}
                <div className="menu-sep" />
                <MenuItem label="Connect another…" detail="Opens the Connections page on your Fountain" onClick={() => window.open(connectors.connectUrl, "_blank", "noopener")} />
                {connectors.items.some((c) => c.usable) && <MenuHeading>Anyone in the chat can ask it to use what you turn on here.</MenuHeading>}
              </>
            )}
          </>
        )}
        {view === "people" && (
          <>
            <MenuBack onClick={() => setView("root")} />
            <form
              className="menu-form"
              onSubmit={(e) => {
                e.preventDefault();
                addEmail();
              }}
            >
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="someone@example.com" autoFocus />
              <button type="submit" className="small" disabled={!email.trim()}>
                Invite
              </button>
            </form>
            {extras.invitees.map((e) => (
              <MenuItem key={e} label={e} detail="Remove" onClick={() => onExtras({ invitees: extras.invitees.filter((x) => x !== e) })} />
            ))}
            <MenuHeading>They sign in with Fountain and find the chat waiting. You can also share a link once it starts.</MenuHeading>
          </>
        )}
      </Popover>
    </div>
  );
}

/**
 * The form behind "Add a repository…": the address, the branch to start from,
 * a token for a private repository (and for opening pull requests), and a
 * setup command. The token goes to the server once and on to Fountain as a
 * write-only secret; this browser forgets it on submit.
 */
function NewProject({ onMade }: { onMade: (p: ProjectDto) => void }) {
  const { toast } = useSession();
  const [repoUrl, setRepoUrl] = useState("");
  const [base, setBase] = useState("main");
  const [token, setToken] = useState("");
  const [setup, setSetup] = useState("");
  const [busy, setBusy] = useState(false);
  const repo = parseRepoUrl(repoUrl);
  const branch = baseBranch(base);
  const problem = repoUrl.trim() && !repo ? "That is not a repository address." : base.trim() && !branch ? "That is not a branch name." : null;

  const submit = async () => {
    if (!repo || !branch || busy) return;
    setBusy(true);
    try {
      const made = await api.createProject({ repoUrl: repo.url, base: branch, token: token.trim() || undefined, setup: setup.trim() || undefined });
      setToken("");
      toast(`${made.name} is ready. Chats started in it work in a checkout of it.`);
      onMade(made);
    } catch (err) {
      toast(describeError(err), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="menu-form project-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label>
        <span>Repository</span>
        <input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/owner/repo" autoFocus spellCheck={false} />
      </label>
      <label>
        <span>Branch to start from</span>
        <input value={base} onChange={(e) => setBase(e.target.value)} placeholder="main" spellCheck={false} />
      </label>
      <label>
        <span>GitHub token</span>
        <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Needed for a private repository, and to open pull requests" autoComplete="off" />
      </label>
      <label>
        <span>Setup command</span>
        <input value={setup} onChange={(e) => setSetup(e.target.value)} placeholder="npm install (optional, runs in the checkout)" spellCheck={false} />
      </label>
      {problem && <div className="menu-problem">{problem}</div>}
      <button type="submit" className="small" disabled={!repo || !branch || busy}>
        {busy ? "Setting up…" : "Add project"}
      </button>
      <MenuHeading>The token is kept on your Fountain, write-only; Salon never stores it.</MenuHeading>
    </form>
  );
}

/** "Gmail", "Linear" for the chosen connector ids; an id the menu no longer lists is left out. */
function connectorLabels(ids: readonly string[], menu: MenuDto | null): string[] {
  const items = menu?.connectors.items ?? [];
  return ids.flatMap((id) => {
    const c = items.find((x) => x.id === id);
    return c ? [c.label] : [];
  });
}

/** What the "+" has added, as chips on the composer. */
export function Chips({ settings, menu, extras, onChange, onExtras, projects }: { settings: ChatSettings; menu: MenuDto | null; extras: Extras; onChange: (s: ChatSettings) => void; onExtras: (e: Extras) => void; projects: ProjectDto[] }) {
  const chips: { key: string; label: string; clear: () => void }[] = [];
  const project = settings.projectId ? projects.find((p) => p.id === settings.projectId) : null;
  if (project) chips.push({ key: `proj:${project.id}`, label: `⌥ ${project.name}`, clear: () => onChange({ ...settings, projectId: null }) });
  for (const s of SKILLS) if (settings.skills.includes(s.id)) chips.push({ key: `s:${s.id}`, label: s.name, clear: () => onChange({ ...settings, skills: settings.skills.filter((x) => x !== s.id) }) });
  for (const id of settings.connectorIds) {
    const c = menu?.connectors.items.find((x) => x.id === id);
    chips.push({ key: `c:${id}`, label: c ? c.label : "Connector", clear: () => onChange({ ...settings, connectorIds: settings.connectorIds.filter((x) => x !== id) }) });
  }
  for (const e of extras.invitees) chips.push({ key: `p:${e}`, label: `@ ${e}`, clear: () => onExtras({ invitees: extras.invitees.filter((x) => x !== e) }) });
  if (chips.length === 0) return null;
  return (
    <div className="chips">
      {chips.map((c) => (
        <span key={c.key} className="chip">
          {c.label}
          <button type="button" className="chip-x" onClick={c.clear} aria-label={`Remove ${c.label}`}>
            ×
          </button>
        </span>
      ))}
    </div>
  );
}
