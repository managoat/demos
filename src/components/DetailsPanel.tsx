/**
 * The right-hand panel: what the conversation you are reading is actually
 * running with. The transcript says what was said; this says what it was
 * said *by* — the teammate and model behind it, the computer under it, the
 * skills and MCP servers loaded into that computer, and the permission
 * policy in force.
 *
 * It is the answer to a question the workbench could not answer at all: an
 * agent reaches for a tool you did not know it had, or fails to reach one
 * you thought it had, and nothing on the page said which servers were
 * plugged in. All of it was already on the wire — the conversation record,
 * its sandbox, and the agent — and none of it was anywhere on screen.
 *
 * The deriving, and everything that is not simply true, is in
 * `src/lib/details.ts`: skills and MCP servers come from the *agent*, which
 * is not quite the same claim as "on this machine", and Fountain adds
 * entries to both sets that no endpoint reports. The panel renders those
 * caveats rather than hiding them, because a list of tools that is quietly
 * incomplete is worse than no list.
 *
 * It opens on a conversation and nowhere else; the toggle in the top bar is
 * there only when there is a conversation to describe. Open or shut, and how
 * wide, is per browser, so it stays as you left it while you move between
 * threads.
 */
import { useEffect, useState } from "react";
import { useProject } from "../store";
import { href } from "../router";
import type { SandboxRecord } from "../types";
import { AgentAvatar } from "./AgentAvatar";
import { StatusPill } from "./StatusPill";
import { computerLabel, itemIdOf, relativeTime } from "../lib/sidebar";
import { conversationLabel, formatCompact, formatTime, shortId } from "../lib/format";
import {
  clampPanelWidth,
  cotenants,
  describeMode,
  effectivePolicy,
  loadPanelWidth,
  mcpCaveat,
  mcpServersOf,
  policyBites,
  policyRows,
  savePanelWidth,
  skillsCaveat,
  skillsOf,
} from "../lib/details";

export function DetailsPanel({ conversationId, onClose }: { conversationId: string; onClose: () => void }) {
  const { project, items, conversations, agents, environments, vaults, sandboxes, fountain } = useProject();
  const [width, setWidth] = useState(() => loadPanelWidth());

  const conversation = conversations.find((c) => c.id === conversationId) ?? null;
  const agent = conversation?.agent_id ? agents.get(conversation.agent_id) ?? null : null;
  const item = conversation ? items.find((w) => w.id === itemIdOf(conversation)) ?? null : null;

  // The store keeps a record for every *live* computer, which is most of the
  // time and costs nothing here. A computer that has gone is exactly the one
  // whose provider and mode are worth reading, so fetch that one ourselves.
  const sandboxId = conversation?.sandbox_id ?? null;
  const held = sandboxId ? sandboxes.get(sandboxId) ?? null : null;
  const [fetched, setFetched] = useState<SandboxRecord | null>(null);
  useEffect(() => {
    if (!sandboxId || held) return;
    let cancelled = false;
    fountain
      .sandbox(sandboxId)
      .then((rec) => {
        if (!cancelled) setFetched(rec);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [sandboxId, held, fountain]);
  const sandbox = held ?? (fetched?.id === sandboxId ? fetched : null);

  // Drag the left edge. The panel is on the right, so the width grows as the
  // pointer moves left — the mirror of the explorer's.
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const right = window.innerWidth;
    document.body.classList.add("resizing-col");
    const move = (ev: PointerEvent) => setWidth(clampPanelWidth(right - ev.clientX));
    const up = (ev: PointerEvent) => {
      savePanelWidth(clampPanelWidth(right - ev.clientX));
      document.body.classList.remove("resizing-col");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const skills = skillsOf(agent);
  const servers = mcpServersOf(agent);
  const policy = effectivePolicy(agent?.permission_policy, conversation?.permission_policy);
  const mode = describeMode(sandbox?.mode);
  const others = conversation ? cotenants(conversation.id, conversations, sandboxId) : [];
  const environment = environments.get(conversation?.environment_id ?? project.environmentId ?? "") ?? null;
  const vault = vaults.get(conversation?.vault_id ?? project.vaultId ?? "") ?? null;
  const skillNote = skillsCaveat(sandbox?.status);

  return (
    <aside className="details-panel" style={{ width }} aria-label="Conversation details">
      <div className="details-resize" onPointerDown={startResize} role="separator" aria-orientation="vertical" aria-label="Resize the details panel" />
      <header className="details-head">
        <span className="details-title">details</span>
        <button type="button" className="icon" onClick={onClose} aria-label="Close the details panel" title="Close">
          ×
        </button>
      </header>

      {!conversation ? (
        <div className="details-body">
          {/* An empty list is a project still loading, not a missing thread:
              saying "retired" over the second of blank the page opens with
              would be a lie the reader sees more often than the truth. */}
          <p className="muted small">{conversations.length === 0 ? "Loading…" : "This conversation is not in the project's list — it may have been retired."}</p>
        </div>
      ) : (
        <div className="details-body">
          <Section title="conversation">
            <Row label="teammate">
              {agent ? (
                <span className="details-who">
                  <AgentAvatar agent={agent} size={18} />
                  {agent.name}
                </span>
              ) : (
                <span className="muted">unknown</span>
              )}
            </Row>
            <Row label="model">{agent?.model ? <code>{agent.model}</code> : <span className="muted">—</span>}</Row>
            <Row label="runtime">
              <code>{conversation.runtime}</code> {conversation.acp && <span className="tag" title="Its output is ACP session/update notifications, which is what a transcript can replay">ACP</span>}
            </Row>
            <Row label="status">
              <StatusPill status={conversation.status} sandbox={sandbox?.status} />
            </Row>
            <Row label="turns">
              {conversation.turn_count ?? 0}
              {conversation.usage_total && (conversation.usage_total.input || conversation.usage_total.output) ? (
                <span className="muted"> · {formatCompact((conversation.usage_total.input ?? 0) + (conversation.usage_total.output ?? 0))} tokens</span>
              ) : null}
            </Row>
            <Row label="started">{formatTime(conversation.inserted_at)}</Row>
            <Row label="last active">{relativeTime(conversation.last_active_at ?? conversation.updated_at)}</Row>
            <Row label="work item">
              {item ? (
                <a href={href.item(project.id, item.id)}>{item.title}</a>
              ) : (
                <span className="muted">—</span>
              )}
            </Row>
            <Row label="id">
              <code className="details-id">{conversation.id}</code>
            </Row>
          </Section>

          <Section title="computer">
            {!sandboxId ? (
              <p className="muted small">No computer yet — one is built when the first turn runs.</p>
            ) : (
              <>
                <Row label="sprite">
                  <code>{computerLabel({ sandbox, sandboxId })}</code>
                </Row>
                <Row label="status">{sandbox ? <span className={`pill ${sandbox.status}`}>{sandbox.status}</span> : <span className="muted">unknown</span>}</Row>
                <Row label="provider">{sandbox?.provider ? <code>{sandbox.provider}</code> : <span className="muted">—</span>}</Row>
                <Row label="sharing">
                  <span title={mode.note ?? undefined}>{mode.label}</span>
                </Row>
                {mode.note && <p className="details-note">{mode.note}</p>}
                {sandbox?.url && (
                  <Row label="url">
                    <a href={sandbox.url} target="_blank" rel="noreferrer">
                      {sandbox.url}
                    </a>
                  </Row>
                )}
                {sandbox?.runner && (
                  <>
                    <Row label="runner">
                      {sandbox.runner.name ?? sandbox.runner.hostname ?? "—"} <span className="muted">{sandbox.runner.online ? "online" : "offline"}</span>
                    </Row>
                    {sandbox.runner.path && (
                      <Row label="path">
                        <code className="details-id">{sandbox.runner.path}</code>
                      </Row>
                    )}
                  </>
                )}
                <Row label="environment">{environment ? environment.name : <span className="muted">—</span>}</Row>
                <Row label="vault">{vault ? vault.name : <span className="muted">—</span>}</Row>
                <Row label="id">
                  <code className="details-id">{sandboxId}</code>
                </Row>
                {others.length > 0 && (
                  <div className="details-sub">
                    <span className="details-sub-title">also on it</span>
                    <ul className="details-list">
                      {others.map((c) => (
                        <li key={c.id}>
                          <a href={href.conversation(project.id, c.id)}>{conversationLabel(c, c.first_prompt)}</a>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </Section>

          <Section title="skills" count={skills.length}>
            <ul className="details-list">
              {skills.map((s, i) => (
                <li key={`${s.name}-${i}`}>
                  <code>{s.name}</code>{" "}
                  {s.bundled ? (
                    <span className="tag" title="Fountain writes this onto every sprite; it is in no teammate's definition">bundled</span>
                  ) : s.source === "github" ? (
                    <span className="muted">
                      {s.repo}
                      {s.ref ? `@${s.ref}` : ""}
                    </span>
                  ) : (
                    <span className="muted">inline</span>
                  )}
                </li>
              ))}
            </ul>
            {skillNote && <p className="details-note">{skillNote}</p>}
          </Section>

          <Section title="mcp servers" count={servers.length}>
            {servers.length === 0 ? (
              <p className="muted small">None on this teammate.</p>
            ) : (
              <ul className="details-list details-servers">
                {servers.map((s) => (
                  <li key={s.name}>
                    <div>
                      <code>{s.name}</code> <span className="tag">{s.transport}</span>
                    </div>
                    {s.url && <div className="details-wire">{s.url}</div>}
                    {s.command && <div className="details-wire">{[s.command, ...s.args].join(" ")}</div>}
                    {s.envKeys.length > 0 && (
                      <div className="details-keys">
                        env <span>{s.envKeys.join(" · ")}</span>
                      </div>
                    )}
                    {s.headerKeys.length > 0 && (
                      <div className="details-keys">
                        headers <span>{s.headerKeys.join(" · ")}</span>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {servers.some((s) => s.envKeys.length || s.headerKeys.length) && (
              <p className="details-note">Names only: the values are credentials, and the proxy withholds them rather than putting the owner's keys in a member's browser.</p>
            )}
            <p className="details-note">{mcpCaveat}</p>
          </Section>

          <Section title="permissions">
            {!policyBites(policy) ? (
              <p className="muted small">Every tool runs without asking.</p>
            ) : (
              <>
                <ul className="details-list details-policy">
                  {policyRows(policy).map((r) => (
                    <li key={r.tool}>
                      <code>{r.tool}</code>
                      <span className={`verdict ${r.verdict}`}>{r.verdict.replace("auto_", "")}</span>
                    </li>
                  ))}
                </ul>
                <p className="details-note">
                  The teammate's policy and this conversation's, merged tool by tool, taking whichever withholds more — so a launch can tighten it and never loosen it.
                </p>
              </>
            )}
          </Section>

          <p className="details-foot muted small">
            {shortId(conversation.id)} · <a href={href.team(project.id)}>the team</a>
          </p>
        </div>
      )}
    </aside>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="details-section">
      <h3>
        {title}
        {count !== undefined && <span className="details-count">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="details-row">
      <span className="details-label">{label}</span>
      <span className="details-value">{children}</span>
    </div>
  );
}
