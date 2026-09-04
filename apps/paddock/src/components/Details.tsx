/**
 * The Details panel: what this machine is, what the box actually has, and the
 * one button that closes the gap.
 *
 * Every row carries its tier, because the tier is the honest answer to "when
 * does this take effect?" and there are three different answers:
 *
 *   on the box     the environment builds the disk. Changing it does nothing to
 *                  a running machine until an apply turn does the work.
 *   next tab       the agent and the secrets are injected when a session
 *                  starts. Already-open tabs kept what they started with.
 *   new machine    the runtime is baked in. This one really cannot be done to
 *                  a machine you are already using.
 *
 * This used to be one panel with the editors underneath each of those lists,
 * and it read as a settings page that happened to print some state. It is the
 * other way round: the state is the thing worth having open while you work,
 * and the forms are somewhere you go. So the editors moved to
 * [Setup](./Setup.tsx) and what is left here is a machine you can watch.
 *
 * The buttons that stayed are the three that answer something on this page —
 * apply what is pending, ask a silent box what it has, open a tab that is not
 * behind. None of them is a setting; each is a reply to a row above it.
 *
 * The explanations live behind the (i) next to each heading. There are enough
 * of them that a panel saying all of it at once buried the rows that are the
 * point of it. Nothing was deleted; it is one click away, next to the thing it
 * is about.
 *
 * The panel never says "applied" on trust. Tier-`box` rows are `applied` only
 * because the machine itself wrote the id into its receipt, read back over the
 * read-only sandbox routes; when the receipt cannot be read the panel says the
 * box has not reported rather than guessing.
 */
import { useState } from "react";
import type { Agent, Sandbox } from "../api/types";
import type { Role } from "../api/paddock";
import type { BoxDrift, DesiredItem, ItemStatus } from "../lib/machine";
import { needsApply } from "../lib/machine";
import type { Tab } from "../../shared/tabs";
import { SectionHead, TIER } from "./Panel";

export interface DetailsProps {
  /**
   * Everyone in the paddock sees this panel; only the owner can act on it.
   * The buttons are rendered *absent* for anybody else rather than disabled —
   * a greyed-out Apply invites somebody to wonder what they would have to do
   * to use it, and the answer is "own this machine".
   */
  role: Role;
  sandbox: Sandbox | null;
  /** For the runtime, which is the whole of the third tier. */
  agent: Agent;
  rev: number;
  desired: DesiredItem[];
  drift: BoxDrift;
  stale: Tab[];
  applying: boolean;
  busy: string | null;
  onApply: () => void;
  onReconcile: () => void;
  onOpenTab: () => void;
  /**
   * Where the editors went. Every tier here ends in a way to change it, so
   * that reading a row and acting on it stay one click apart. Null for anybody
   * who cannot change anything, which is the same people who see no buttons.
   */
  onSetup: (() => void) | null;
}

export function Details(props: DetailsProps) {
  const { drift, desired, sandbox, stale } = props;
  const isOwner = props.role === "owner";
  const pending = drift.statuses.filter((s) => s.state !== "applied");
  const session = desired.filter((i) => i.tier === "session");

  return (
    <div className="panel machine">
      <header className="panel-head">
        <div>
          <h2>The machine</h2>
          <p className="dim">
            {sandbox ? (
              <>
                {sandbox.status}
                {sandbox.mode ? ` · ${sandbox.mode}` : ""}
                {sandbox.provider ? ` · ${sandbox.provider}` : ""} <CopyId id={sandbox.id} />
              </>
            ) : (
              "no machine yet"
            )}
          </p>
        </div>
        {isOwner && needsApply(drift) && drift.known && (
          <button className="primary" onClick={props.onApply} disabled={props.applying || !!props.busy}>
            {props.applying ? "applying…" : `Apply ${pending.length} to the box`}
          </button>
        )}
      </header>

      {props.busy && !props.applying && <p className="note">{props.busy} is mid-turn — an apply has to wait for the box.</p>}

      {/* ── tier: box ─────────────────────────────────────────────────── */}
      <section>
        <SectionHead
          {...TIER.box}
          note="The environment builds the disk, so a change to it does nothing to the machine you are running until it is applied."
        />

        {!drift.known && isOwner && (
          <p className="note warn">
            The box has not reported what is on it — there is no readable receipt at <code>~/.paddock/applied.json</code>.
            <button className="ghost" onClick={props.onReconcile} disabled={props.applying || !!props.busy}>
              Ask the box what it has
            </button>
          </p>
        )}

        <Rows statuses={drift.statuses} known={drift.known} />

        {drift.extra.length > 0 && (
          <p className="fine">
            Also on the box, no longer declared: {drift.extra.join(", ")}. Nothing removes them.
          </p>
        )}

        <Change to="repositories, packages and the setup script" onSetup={props.onSetup} />
      </section>

      {/* ── tier: session ─────────────────────────────────────────────── */}
      <section>
        <SectionHead
          {...TIER.session}
          note="Fountain writes these into the machine as a tab opens. Tabs already running kept what they started with."
        />

        {isOwner && stale.length > 0 && (
          <p className="note warn">
            {stale.length === 1 ? `${stale[0]!.title} started` : `${stale.map((t) => t.title).join(", ")} started`} before the
            current settings (revision {props.rev}).
            <button className="ghost" onClick={props.onOpenTab}>
              Open a fresh tab
            </button>
          </p>
        )}

        {session.length === 0 ? (
          <p className="fine">Nothing yet — no skills, MCP servers or secrets.</p>
        ) : (
          <ul className="rows">
            {session.map((item) => (
              <li key={item.id} className="row">
                <span className="state next" title="Active in tabs opened from now on">
                  next tab
                </span>
                <span className="row-label">{item.label}</span>
                <span className="dim">{item.detail}</span>
              </li>
            ))}
          </ul>
        )}

        <Change to="secrets, MCP servers and skills" onSetup={props.onSetup} />
      </section>

      {/* ── tier: machine ─────────────────────────────────────────────── */}
      <section>
        <SectionHead {...TIER.machine} note="The runtime is baked into the disk when the box is built." />
        <ul className="rows">
          <li className="row">
            <span className="state locked">baked in</span>
            <span className="row-label">{props.agent.runtime}</span>
          </li>
        </ul>
        <Change to="this machine — rebuild it, or start over" onSetup={props.onSetup} />
      </section>
    </div>
  );
}

/**
 * The sandbox id, out of the way.
 *
 * It led this line for a year — a twenty-odd character identifier, first, in
 * front of the two words somebody actually opens this panel to read. Nobody
 * types a sandbox id; they paste it into a support message or a Fountain URL,
 * and about once a month. So the status leads and the id is a chip at the end
 * that hands over the whole thing on a click.
 *
 * Truncated in the middle rather than the end: the tail is the part that
 * distinguishes two ids from the same account, and a `sb-…-1` that could be
 * any of four machines is worse than no id at all.
 */
function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const short = id.length > 14 ? `${id.slice(0, 7)}…${id.slice(-4)}` : id;

  async function copy() {
    // No clipboard on an insecure origin, and no error worth showing for it —
    // the full id is in the title, which is where somebody who cannot copy
    // will read it from anyway.
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* ignore */
    }
  }

  return (
    <button className="copy-id" onClick={() => void copy()} title={`Copy ${id}`} aria-label={`Copy machine id ${id}`}>
      <code>{copied ? "copied" : short}</code>
      <span aria-hidden="true">⧉</span>
    </button>
  );
}

function Rows({ statuses, known }: { statuses: ItemStatus[]; known: boolean }) {
  if (statuses.length === 0) return <p className="fine">Nothing declared — this is a bare machine.</p>;
  return (
    <ul className="rows">
      {statuses.map((s) => (
        <li key={s.item.id} className="row">
          <span className={`state ${known ? s.state : "unknown"}`}>{known ? s.state : "unknown"}</span>
          <span className="row-label">{s.item.label}</span>
          <span className="dim">{s.item.detail}</span>
          {s.why && <span className="why">{s.why}</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * The way out of a tier and into the form that fills it.
 *
 * It names what is over there rather than saying "Setup", because the useful
 * question at the bottom of a list of rows is "how do I change one of these?"
 * and the answer is a noun, not a destination.
 */
function Change({ to, onSetup }: { to: string; onSetup: (() => void) | null }) {
  if (!onSetup) return null;
  return (
    <p className="fine change-link">
      <button className="linkish" onClick={onSetup}>
        Change {to} →
      </button>
    </p>
  );
}
