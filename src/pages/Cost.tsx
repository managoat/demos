/**
 * What the work cost, for the person who pays for it.
 *
 * Every conversation in a project runs on the project owner's Fountain key,
 * members' conversations included, so the owner is charged for work they did
 * not start. This is their view of it: their own account, their own projects.
 * It hangs off `/api/me/cost`, not off `/f/<project>` — the proxy is the
 * boundary a member crosses, and a bill does not belong on the far side of it.
 *
 * Two numbers that do not add up to each other, and the page says so rather
 * than papering over it: the bill is account-wide and covers one billing
 * period; the breakdown is per work item and covers all time. Turning tokens
 * into a share of the invoice would be arithmetic on two different things.
 */
import { useEffect, useMemo, useState } from "react";
import { api, type Cost as CostDto, type CostBucket, type ItemCost, type ProjectCost } from "../lib/api";
import { describeError } from "../lib/errors";
import { formatCompact, formatDay, formatHours, formatTime, formatUsd } from "../lib/format";
import { href } from "../router";
import { useWorkbench } from "../store";

const tokens = (b: CostBucket) => b.input + b.output;

/** The page: fetch, then hand the numbers to the view. */
export function Cost() {
  const { me } = useWorkbench();
  const [cost, setCost] = useState<CostDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .cost()
      .then((c) => live && setCost(c))
      .catch((err) => live && setError(describeError(err)));
    return () => {
      live = false;
    };
  }, []);

  if (error) {
    return (
      <div className="page narrow">
        <div className="page-header">
          <h1>Cost</h1>
        </div>
        <div className="empty card">
          <p className="strong">Could not read your account.</p>
          <p className="muted">{error}</p>
        </div>
      </div>
    );
  }

  if (!cost) {
    return (
      <div className="page narrow">
        <div className="page-header">
          <h1>Cost</h1>
        </div>
        <p className="muted">Loading…</p>
      </div>
    );
  }

  return <CostView cost={cost} email={me.email} />;
}

/** The numbers, given. Split out from the fetching so it can be rendered in a test. */
export function CostView({ cost, email }: { cost: CostDto; email: string }) {
  // The biggest spender is what you came to see, so it starts open.
  const [open, setOpen] = useState<Set<string>>(() => new Set(cost.projects.length ? [cost.projects[0]!.id] : []));
  const periodStart = cost.billing?.period?.start ?? null;
  // The largest project sets the scale for every bar, so the rows compare to each other.
  const top = useMemo(() => Math.max(1, ...cost.projects.map(tokens)), [cost]);

  const projectRow = (p: ProjectCost) => {
    const isOpen = open.has(p.id);
    const share = cost.total.input + cost.total.output > 0 ? Math.round((tokens(p) / (cost.total.input + cost.total.output)) * 100) : 0;
    return (
      <li key={p.id} className="cost-row">
        <div className="cost-head">
          <button className="linklike cost-toggle" onClick={() => toggle(setOpen, p.id)} aria-expanded={isOpen} title={isOpen ? "Hide its work items" : "Break it down by work item"}>
            <span className="tree-twisty">{isOpen ? "▾" : "▸"}</span>
            <span className="strong">{p.name}</span>
          </button>
          <a className="muted small" href={href.project(p.id)} title={`Open ${p.name}`} aria-label={`Open ${p.name}`}>
            ↗
          </a>
          <span className="spacer" />
          <span className="mono small">{formatCompact(tokens(p))} tok</span>
        </div>
        <div className="meter" title={`${share}% of the tokens on your account`}>
          <span style={{ width: `${Math.round((tokens(p) / top) * 100)}%` }} />
        </div>
        <div className="cost-sub muted small">
          {share}% of your account · {p.turns} turn{p.turns === 1 ? "" : "s"} · {p.conversations} conversation{p.conversations === 1 ? "" : "s"}
          {p.memberCount > 0 ? ` · shared with ${p.memberCount}` : ""}
          {p.lastActiveAt ? ` · last ${formatTime(p.lastActiveAt)}` : " · nothing has run"}
          {periodStart && p.lastActiveAt && p.lastActiveAt >= periodStart ? " · active this period" : ""}
        </div>
        {isOpen && (p.items.length === 0 ? <p className="muted small indent">No work items.</p> : <ul className="cost-items">{p.items.map((w) => itemRow(p, w))}</ul>)}
      </li>
    );
  };

  const itemRow = (p: ProjectCost, w: ItemCost) => (
    <li key={w.id}>
      <a className="cost-item" href={w.status === null ? href.project(p.id) : href.item(p.id, w.id)}>
        <span className="cost-item-title ellipsis">
          {w.title ?? <span className="muted">Deleted item {w.id.slice(0, 6)}</span>}
          {w.status === "done" && <span className="pill tiny">done</span>}
        </span>
        <span className="spacer" />
        <span className="muted small">
          {w.turns} turn{w.turns === 1 ? "" : "s"}
        </span>
        <span className="mono small cost-item-tokens">{formatCompact(tokens(w))} tok</span>
      </a>
    </li>
  );

  const b = cost.billing;
  const usage = b?.usage;

  return (
    <div className="page narrow">
      <div className="page-header">
        <div>
          <h1>Cost</h1>
          <div className="muted small">{email} · every conversation in a project you own runs on your key, so this covers your members' work as well as your own.</div>
        </div>
        <a className="button secondary small" href={href.projects()}>
          Projects
        </a>
      </div>

      <div className="card stack">
        <div className="row">
          <h2 className="h2">The bill</h2>
          <span className="spacer" />
          {b?.status && <span className={`pill ${b.status === "past_due" ? "failed" : b.status === "active" || b.status === "comped" ? "running" : ""}`}>{b.status}</span>}
        </div>

        {!b ? (
          <p className="muted">
            {cost.billingUnavailable === "disabled"
              ? "This Fountain has billing switched off, so there is no bill to show. What follows is still where the work went."
              : "Fountain would not report your billing just now. What follows is still where the work went."}
          </p>
        ) : (
          <>
            <div className="cost-stats">
              <Stat label="Plan" value={b.plan?.name ?? "—"} sub={b.plan?.monthly_cents === undefined ? undefined : `${formatUsd(b.plan.monthly_cents)}/mo, flat`} />
              <Stat label="Turn hours" value={formatHours(usage?.turn_hours)} sub={usage?.turn_hours_included ? `of ${usage.turn_hours_included} included` : undefined} />
              <Stat label="Sandbox minutes" value={usage?.sandbox_minutes === undefined ? "—" : formatCompact(usage.sandbox_minutes)} sub="active time, parked excluded" />
              <Stat label="Turns" value={usage?.turns === undefined ? "—" : formatCompact(usage.turns)} sub={usage?.conversations === undefined ? undefined : `over ${usage.conversations} conversation${usage.conversations === 1 ? "" : "s"}`} />
            </div>
            <p className="muted small">
              {b.period?.start && b.period?.end ? `${formatDay(b.period.start)} → ${formatDay(b.period.end)}. ` : ""}
              {b.period?.source === "calendar_month" ? "No invoice period reported, so this is the calendar month — these numbers do not line up with an invoice." : "The period Stripe is invoicing."}
              {b.cancel_at_period_end && b.current_period_end ? ` Cancels at the end of it, ${formatDay(b.current_period_end)}.` : ""}
              {b.status === "trialing" && b.trial_ends_at ? ` Trial ends ${formatDay(b.trial_ends_at)}.` : ""}
            </p>
          </>
        )}
      </div>

      <h2 className="h2 section">Where the work went</h2>
      {cost.projects.length === 0 ? (
        <div className="empty card">
          <p className="strong">You own no projects.</p>
          <p className="muted">Nothing runs on your key here. A project shared with you runs on its owner's — and its cost is theirs to see, not yours.</p>
        </div>
      ) : (
        <ul className="cost-list">{cost.projects.map(projectRow)}</ul>
      )}

      {cost.elsewhere.conversations > 0 && (
        <p className="muted small elsewhere">
          Plus {cost.elsewhere.conversations} conversation{cost.elsewhere.conversations === 1 ? "" : "s"} on your Fountain account that belong to no project of yours — {formatCompact(tokens(cost.elsewhere))} tokens over {cost.elsewhere.turns} turn
          {cost.elsewhere.turns === 1 ? "" : "s"}. Your team page, your own threads, work in someone else's workbench project. They are on the same bill.
        </p>
      )}

      <div className="card stack tight cost-note">
        <p className="strong small">Why these are two numbers and not one</p>
        <p className="muted small">
          The bill is what Fountain charges over the period it invoices, measured in turn hours and sandbox minutes. Fountain does not attribute it to a project, so neither does this page.
          {b?.plan?.monthly_cents === undefined ? "" : ` Your plan is a flat ${formatUsd(b.plan.monthly_cents)} a month however the work splits.`}
        </p>
        <p className="muted small">
          The breakdown is tokens and turns, summed per conversation and grouped by the work item each one belongs to. It is a lifetime total, not this period's — a conversation reports a running sum — and it counts only conversations still on your
          account. So it tells you where the work went and what burned a day of it; multiplying it into a share of the invoice would be a number nobody measured.
        </p>
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="cost-stat">
      <div className="muted small">{label}</div>
      <div className="cost-stat-value">{value}</div>
      {sub && <div className="muted small">{sub}</div>}
    </div>
  );
}

function toggle(set: (fn: (prev: Set<string>) => Set<string>) => void, id: string): void {
  set((prev) => {
    const next = new Set(prev);
    if (!next.delete(id)) next.add(id);
    return next;
  });
}
