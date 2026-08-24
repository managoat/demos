/**
 * The project's work: its items, open then done, and a form for the next one
 * — which can put a teammate on it and prompt them in the same submit, since
 * starting a conversation is what assigns one.
 */
import { useMemo, useState, type FormEvent } from "react";
import { useProject } from "../store";
import { agentFits, channelIsItem } from "../lib/workbench";
import { describeError } from "../lib/errors";
import { href, navigate } from "../router";
import { TwoStep } from "../components/Thread";
import { AgentAvatar } from "../components/AgentAvatar";
import { AttachmentStrip, useAttachments } from "../components/Attachments";
import { formatTime } from "../lib/format";

export function Project() {
  const { project, items, isOwner, conversations, agents, environments, vaults, createItem, updateItem, removeItem, startConversation, toast } = useProject();
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [agentId, setAgentId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [showDone, setShowDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const attachments = useAttachments((message) => toast(message, "error"));

  const team = useMemo(() => [...agents.values()].sort((a, b) => a.name.localeCompare(b.name)), [agents]);
  const picked = agentId ? agents.get(agentId) ?? null : null;

  // The images ride on the first prompt — the notes and the words together —
  // so they need one, and a teammate to send it to.
  const orphanImages = !!attachments.payload && (!picked || (!prompt.trim() && !notes.trim()));

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
      const conversation = await startConversation({ item: w, agent: picked, prompt, includeNotes: true, images: attachments.payload });
      setPrompt("");
      setAgentId("");
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

  const open = items.filter((w) => w.status === "open");
  const done = items.filter((w) => w.status === "done");
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
        {w.status === "done" ? (
          <button className="secondary small self-center" onClick={() => void updateItem(w.id, { status: "open" })}>
            Reopen
          </button>
        ) : live > 0 ? (
          // Done retires what is still up on the item — the same loss as Retire, so the same ask.
          <TwoStep
            label="Done"
            className="danger small self-center"
            title={`Retires ${live} conversation${live === 1 ? "" : "s"} — the computers go with them`}
            onConfirm={() => void updateItem(w.id, { status: "done" })}
          />
        ) : (
          <button className="secondary small self-center" onClick={() => void updateItem(w.id, { status: "done" })}>
            Done
          </button>
        )}
        <TwoStep label="Delete" onConfirm={() => void removeItem(w.id)} className="danger small self-center" />
      </li>
    );
  };

  return (
    <div className="page narrow">
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
          Teammate <span className="hint">Optional. Picking one puts them on the item and starts them off — that is all assigning is.</span>
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)} disabled={team.length === 0}>
            <option value="">{team.length === 0 ? `No agents on ${project.ownerEmail}'s Fountain` : "Nobody yet"}</option>
            {team.map((a) => {
              const fit = agentFits(a, project);
              return (
                <option key={a.id} value={a.id} disabled={!fit.ok}>
                  {a.name} ({a.runtime})
                  {fit.ok ? "" : ` — ${fit.reason}`}
                </option>
              );
            })}
          </select>
        </label>
        {picked && (
          <label>
            First prompt <span className="hint">What {picked.name} should do on it. Leave it empty to just bring their computer up. Paste or drop a screenshot to send with it.</span>
            <textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} onPaste={attachments.paste} placeholder="Start with the repro, then…" />
          </label>
        )}
        <AttachmentStrip items={attachments.items} onRemove={attachments.remove} />
        {orphanImages && (
          <div className="error">
            {picked ? "Write the prompt the images go with — on their own there is no turn to attach them to." : "Pick a teammate for the images to go to."}
          </div>
        )}
        <div className="row end">
          <button type="submit" disabled={!title.trim() || busy || orphanImages}>
            {busy ? (picked ? "Starting…" : "Creating…") : picked ? `Create & talk to ${picked.name}` : "Create"}
          </button>
        </div>
      </form>

      <h2 className="h2 section">Open</h2>
      {open.length === 0 ? <p className="muted">Nothing open.</p> : <ul className="conv-list">{open.map(row)}</ul>}
      {done.length > 0 && (
        <>
          <h2 className="h2 section">
            <button className="linklike" onClick={() => setShowDone((v) => !v)}>
              {showDone ? "Hide" : "Show"} {done.length} done
            </button>
          </h2>
          {showDone && <ul className="conv-list">{done.map(row)}</ul>}
        </>
      )}
    </div>
  );
}
