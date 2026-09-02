/** The strip along the bottom: which project on what computer, how many are up, who you are, and the stream's state. */
import { useMemo } from "react";
import { useProject, useWorkbench } from "../store";
import { computersOf } from "../lib/sidebar";
import { href } from "../router";

export function StatusBar() {
  const { me } = useWorkbench();
  const { project, conversations, sandboxes, environments, vaults, connected, isOwner } = useProject();
  const computers = useMemo(() => computersOf(conversations, sandboxes), [conversations, sandboxes]);
  const up = computers.filter((c) => c.live).length;
  const busy = computers.filter((c) => c.busy).length;
  const env = project.environmentId ? environments.get(project.environmentId)?.name ?? project.environmentId.slice(0, 8) : "agent's own env";
  const vault = project.vaultId ? vaults.get(project.vaultId)?.name ?? project.vaultId.slice(0, 8) : "no vault";
  const host = me.fountainUrl.replace(/^https?:\/\//, "");
  return (
    <footer className="statusbar">
      <span className={`link-dot ${connected ? "" : "off"}`} title={connected ? "Live" : "Reconnecting…"} />
      <a href={href.people(project.id)} className="statusbar-item" title="Environment and vault (People → Settings)">
        {env} · {vault}
      </a>
      <span className="statusbar-item">
        {up} up{busy ? ` · ${busy} working` : ""}
      </span>
      <span className="statusbar-item muted">{isOwner ? "owner" : `${project.ownerEmail}'s`}</span>
      <span className="spacer" />
      <span className="statusbar-item muted" title={me.email}>
        {me.email} @ {host}
      </span>
    </footer>
  );
}
