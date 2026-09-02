/**
 * The "home" badge: this conversation runs on a persistent sandbox — the
 * agent identity's own machine, shared with its other conversations. Hover
 * (or focus) lists the others and which of them is mid-turn; click opens the
 * machine. It sits inside the list row's anchor, so it stops the click there.
 */
import { useState, type KeyboardEvent, type MouseEvent } from "react";
import type { Sandbox, SandboxConversation } from "../api/types";
import { navigate, paths } from "../router";
import { conversationLabel } from "../lib/format";
import { StatusPill } from "./StatusPill";

export function HomeBadge({
  sandbox,
  currentId,
  siblings,
}: {
  sandbox: Sandbox;
  /** The conversation the badge sits on; left out of the list. */
  currentId: string;
  /** The machine's conversations, from `GET /api/sandboxes`; null while unknown. */
  siblings: SandboxConversation[] | null;
}) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  if (sandbox.mode !== "persistent") return null;

  const others = siblings?.filter((c) => c.id !== currentId) ?? null;
  const busy = others?.filter((c) => c.mid_turn).length ?? 0;

  const open = (e: MouseEvent | KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    navigate(paths.sandbox(sandbox.id));
  };
  const show = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - 336)) });
  };

  return (
    <span
      className="home-badge"
      role="link"
      tabIndex={0}
      aria-label="Home machine, shared with this agent's other conversations"
      onClick={open}
      onKeyDown={(e) => e.key === "Enter" && open(e)}
      onMouseEnter={(e) => show(e.currentTarget)}
      onMouseLeave={() => setPos(null)}
      onFocus={(e) => show(e.currentTarget)}
      onBlur={() => setPos(null)}
    >
      ⌂ home
      {busy > 0 && <span className="home-busy" aria-label={`${busy} mid-turn`} />}
      {pos && (
        <span className="home-pop" style={{ top: pos.top, left: pos.left }} role="tooltip">
          <span className="pop-head">
            <span className="mono">{sandbox.sprite_name}</span> · {sandbox.status}
          </span>
          <span className="muted">Shared by every conversation of this agent, environment and vault.</span>
          {others === null && <span className="muted">Loading the others…</span>}
          {others && others.length === 0 && <span className="muted">No other conversation on this machine.</span>}
          {others && others.length > 0 && (
            <ul>
              {others.map((c) => (
                <li key={c.id}>
                  <span className="who">{conversationLabel(c)}</span>
                  {c.mid_turn && <span className="mid-turn">mid-turn</span>}
                  <StatusPill status={c.status} tiny />
                </li>
              ))}
            </ul>
          )}
          <span className="muted">Click to open the machine.</span>
        </span>
      )}
    </span>
  );
}
