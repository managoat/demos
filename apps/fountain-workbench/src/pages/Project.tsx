/**
 * The project's work: its items, open then closed, and a form for the next one
 * — which can put a teammate on it and prompt them in the same submit, since
 * starting a conversation is what assigns one. The project's default teammate
 * is already picked, so the form asks for the work, not for who does it.
 *
 * The same items read two ways, and the toggle in the header picks: the
 * **list**, which answers "what is there", and the **board**
 * (components/Board.tsx), a column per state, which answers "where does it
 * stand" — the question a project with agents running in it keeps raising.
 * The choice is remembered per browser, so every link back to the project
 * lands in it; the form above them belongs to both.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useProject } from "../store";
import { agentFits, channelIsItem, CLOSED_STATUSES, defaultTeammate, isClosed, proposerName, statusLabel } from "../lib/workbench";
import { loadProjectView, saveProjectView, type ProjectView } from "../lib/board";
import { itemAsPrompt } from "../lib/start";
import { describeError } from "../lib/errors";
import { href, navigate } from "../router";
import { TwoStep } from "../components/Thread";
import { CloseControls, ItemStatusPill } from "../components/ItemStatus";
import { AgentAvatar } from "../components/AgentAvatar";
import { Board } from "../components/Board";
import { AttachmentStrip, useAttachments } from "../components/Attachments";
import { formatTime } from "../lib/format";

export function Project({ view: named }: { view: ProjectView | null }) {
  const { project, items, isOwner, conversations, agents, environments, vaults, createItem, updateItem, removeItem, startConversation, updateProject, toast } = useProject();
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [agentId, setAgentId] = useState("");
  const [picking, setPicking] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [showClosed, setShowClosed] = useState(false);
  const [busy, setBusy] = useState(false);
  const attachments = useAttachments((message) => toast(message, "error"));

  // A URL that names a view wins and becomes the preference; a bare project
  // URL is answered with whatever this browser last chose.
  const [remembered, setRemembered] = useState<ProjectView>(() => loadProjectView());
  const view = named ?? remembered;
  useEffect(() => {
    if (!named || named === remembered) return;
    setRemembered(named);
    saveProjectView(named);
  }, [named, remembered]);

  const team = useMemo(() => [...agents.values()].sort((a, b) => a.name.localeCompare(b.name)), [agents]);
  const boss = useMemo(() => defaultTeammate(project, agents), [project, agents]);
  const picked = agentId ? agents.get(agentId) ?? null : null;

  // The default fills the box until someone picks for themselves — and the
  // team arrives from Fountain after the first render, so it fills it late.
  useEffect(() => {
    if (!picking && boss) setAgentId(boss.id);
  }, [picking, boss]);

  // The images ride on the first prompt, and there is always one to ride when
  // a teammate is picked — the item is the ask when the box is empty. So all
  // they need is somebody to go to.
  const orphanImages = !!attachments.payload && !picked;

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!title.trim() || busy || orphanImages) return;
    setBusy(true);
    const w = await createItem(title, notes);
    if (!w) {
      setBusy(false);
      return;
    }
    setTitle("");
    setNotes("");
    if (!picked) {
      setBusy(false);
      navigate(href.item(project.id, w.id));
      return;
    }
    try {
      // Nothing written in the prompt box: the item is the ask, so they get
      // it rather than a computer that comes up with nothing to do.
      const said = prompt.trim() ? { prompt, includeNotes: true } : itemAsPrompt(w);
      const conversation = await startConversation({ item: w, agent: picked, ...said, images: attachments.payload });
      setPrompt("");
      setPicking(false);
      attachments.clear();
      navigate(href.conversation(project.id, conversation.id));
    } catch (err) {
      // The item is made; only the conversation failed. Land on it and say why.
      toast(describeError(err), "error");
      navigate(href.item(project.id, w.id));
    } finally {
      setBusy(false);
    }
  }

  // Every way the work stops folds away together, but which way is still on
  // the row, and the fold counts them apart: "we did this", "we decided not
  // to" and "not now" are three different answers, and a single number over
  // the fold would be the one thing this list must never say.
  const open = items.filter((w) => !isClosed(w.status));
  const closed = items.filter((w) => isClosed(w.status));
  const closedLabel = CLOSED_STATUSES.map((s) => [closed.filter((w) => w.status === s).length, statusLabel(s)] as const)
    .filter(([n]) => n > 0)
    .map(([n, what]) => `${n} ${what}`)
    .join(" · ");
  const envName = project.environmentId ? environments.get(project.environmentId)?.name ?? "?" : "each agent's own";
  const vaultName = project.vaultId ? vaults.get(project.vaultId)?.name ?? "?" : "none";

  const row = (w: (typeof items)[number]) => {
    const convs = conversations.filter((c) => channelIsItem(c.channel_id, project.id, w.id));
    const working = convs.filter((c) => c.status === "running" || c.status === "pending").length;
    const live = convs.filter((c) => c.status !== "terminated").length;
    const unread = convs.some((c) => c.unread);
    const latest = convs.reduce((m, c) => ((c.last_active_at ?? "") > m ? c.last_active_at ?? "" : m), "");
    const teammates = w.agentIds.map((id) => agents.get(id)).filter((a): a is NonNullable<typeof a> => !!a);
    return (
      <li key={w.id}>
        <a className="conv-row" href={href.item(project.id, w.id)}>
          {unread && <span className="unread-dot" />}
          <div className="conv-main">
            <div className="conv-title">
              <span className="strong">{w.title}</span>
              {working > 0 && <span className="pill running">{working} working</span>}
              {isClosed(w.status) && <ItemStatusPill status={w.status} />}
            </div>
            <div className="conv-sub muted">
              {convs.length} conversation{convs.length === 1 ? "" : "s"}
              {w.notes ? ` · ${w.notes}` : ""}
            </div>
          </div>
          <div className="stack-avatars">
            {teammates.map((a) => (
              <AgentAvatar key={a.id} agent={a} size={22} />
            ))}
          </div>
          <div className="conv-side">
            <span className="time muted">{formatTime(latest || w.createdAt)}</span>
          </div>
        </a>
        <CloseControls
          status={w.status}
          live={live}
          proposal={w.proposal}
          proposedBy={w.proposal ? proposerName(w.proposal, agents) : ""}
          compact
          onSet={(status) => void updateItem(w.id, { status })}
          onDismiss={() => void updateItem(w.id, { proposal: null })}
        />
        <TwoStep label="Delete" onConfirm={() => void removeItem(w.id)} className="danger small self-center" />
      </li>
    );
  };

  return (
    <div className={`page${view === "list" ? " narrow" : " wide"}`}>
      <div className="page-header">
        <div>
          <h1>{project.name}</h1>
          <div className="muted small">
            env {envName} · vault {vaultName}
            {isOwner ? "" : ` · ${project.ownerEmail}'s project`}
            {project.notes ? ` · ${project.notes}` : ""}
          </div>
        </div>
        <div className="row">
          {/* The same items, read two ways. Naming the view in the URL is also what remembers it. */}
          <div className="seg" role="group" aria-label="How to read the work">
            {(["list", "board"] as const).map((v) => (
              <a
                key={v}
                className={`button ${view === v ? "on" : ""}`}
                href={href.projectView(project.id, v)}
                aria-current={view === v ? "true" : undefined}
                title={v === "list" ? "Every item, open then closed" : "A column per state: to do, in progress, needs you, done, won't do, icebox"}
              >
                {v === "list" ? "List" : "Board"}
              </a>
            ))}
          </div>
          {/* The owner pays for everyone's conversations here, so the owner is the one shown what they came to. */}
          {isOwner && (
            <a className="button secondary small" href={href.cost()} title="What the work on your account came to, this project included">
              Cost
            </a>
          )}
          <a className="button secondary small" href={href.people(project.id)}>
            {isOwner ? "Settings & sharing" : "People"}
          </a>
        </div>
      </div>

      <form className={`card stack new-form${attachments.dragging ? " dropping" : ""}`} onSubmit={create} {...attachments.dropzone}>
        <h2 className="h2">New work item</h2>
        <label>
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="fix foo" required />
        </label>
        <label>
          Notes <span className="hint">Context for the work. Prepended to the first prompt of every conversation you start on it.</span>
          <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Foo 500s when… Repro: …" />
        </label>
        <label>
          Teammate{" "}
          <span className="hint">
            {boss ? `${boss.name} is this project's default and is already picked. ` : "Optional. "}
            Picking one puts them on the item and starts them off — that is all assigning is.
          </span>
          <select
            value={agentId}
            onChange={(e) => {
              setPicking(true);
              setAgentId(e.target.value);
            }}
            disabled={team.length === 0}
          >
            <option value="">{team.length === 0 ? `No agents on ${project.ownerEmail}'s Fountain` : "Nobody yet"}</option>
            {team.map((a) => {
              const fit = agentFits(a, project);
              return (
                <option key={a.id} value={a.id} disabled={!fit.ok}>
                  {a.name} ({a.runtime})
                  {a.id === project.defaultAgentId ? " — default" : ""}
                  {fit.ok ? "" : ` — ${fit.reason}`}
                </option>
              );
            })}
          </select>
        </label>
        {/* Set the default where you notice you want one: the third time you pick the same name. */}
        {isOwner && picked && picked.id !== project.defaultAgentId && (
          <button type="button" className="linklike self-start" onClick={() => void updateProject({ defaultAgentId: picked.id })}>
            Always start with {picked.name} here
          </button>
        )}
        {picked && (
          <label>
            First prompt{" "}
            <span className="hint">
              What {picked.name} should do on it. Left empty, the work item itself is what they get. Attach, paste or drop a screenshot to send with it.
            </span>
            <textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} onPaste={attachments.paste} placeholder="Start with the repro, then…" />
          </label>
        )}
        {/* The button sits with the prompt it goes on; a drop still lands before a teammate is picked, and says so below. */}
        <AttachmentStrip items={attachments.items} onRemove={attachments.remove} add={picked ? attachments.add : undefined} />
        {orphanImages && <div className="error">Pick a teammate for the images to go to.</div>}
        <div className="row end">
          <button type="submit" disabled={!title.trim() || busy || orphanImages}>
            {busy ? (picked ? "Starting…" : "Creating…") : picked ? `Create & talk to ${picked.name}` : "Create"}
          </button>
        </div>
      </form>

      {view === "board" ? (
        <Board />
      ) : (
        <>
          <h2 className="h2 section">Open</h2>
          {open.length === 0 ? <p className="muted">Nothing open.</p> : <ul className="conv-list">{open.map(row)}</ul>}
          {closed.length > 0 && (
            <>
              <h2 className="h2 section">
                <button className="linklike" onClick={() => setShowClosed((v) => !v)}>
                  {showClosed ? "Hide" : "Show"} {closedLabel}
                </button>
              </h2>
              {showClosed && <ul className="conv-list">{closed.map(row)}</ul>}
            </>
          )}
        </>
      )}
    </div>
  );
}
