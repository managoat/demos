/**
 * What the work cost, for the person who pays for it.
 *
 * Every conversation in a project runs on the project owner's Fountain key,
 * members' conversations included, so the owner is charged for work they did
 * not start. This is their view of it: their own account, their own projects.
 * It hangs off `/api/me/cost`, not off `/f/<project>` — the proxy is the
 * boundary a member crosses, and a bill does not belong on the far side of it.
 *
 * Two requests, because they cost very different amounts. `/api/me/cost` is
 * one call upstream and paints immediately: the bill, and where the work went
 * over all time. `/api/me/cost/period` is a call per conversation and arrives
 * behind it: the same projects measured in turn hours over the bill's own
 * window, which is the same unit and the same window as the bill, and so is a
 * division of it rather than a second number next to it.
 */
import { useEffect, useMemo, useState } from "react";
import { api, type Cost as CostDto, type ItemCost, type ItemPeriodCost, type PeriodCost, type ProjectCost, type ProjectPeriodCost } from "../lib/api";
import { describeError } from "../lib/errors";
import { formatCompact, formatDay, formatHours, formatTime, formatTurnTime, formatUsd } from "../lib/format";
import { href } from "../router";
import { isClosed } from "../lib/workbench";
import { ItemStatusPill } from "../components/ItemStatus";
import { useWorkbench } from "../store";

const tokens = (b: { input: number; output: number }) => b.input + b.output;

/** The page: fetch the cheap view, paint, then fetch the expensive one. */
export function Cost() {
  const { me } = useWorkbench();
  const [cost, setCost] = useState<CostDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<PeriodCost | null>(null);
  const [periodError, setPeriodError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .cost()
      .then((c) => live && setCost(c))
      .catch((err) => live && setError(describeError(err)));
    // Not chained behind the first: they are independent reads of the same
    // account, and the slow one must not delay the fast one.
    api
      .costPeriod()
      .then((p) => live && setPeriod(p))
      .catch((err) => live && setPeriodError(describeError(err)));
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

  return <CostView cost={cost} period={period} periodError={periodError} email={me.email} />;
}

/** The numbers, given. Split out from the fetching so it can be rendered in a test. */
export function CostView({ cost, period, periodError, email }: { cost: CostDto; period?: PeriodCost | null; periodError?: string | null; email: string }) {
  // The biggest spender is what you came to see, so it starts open.
  const [open, setOpen] = useState<Set<string>>(() => new Set(cost.projects.length ? [cost.projects[0]!.id] : []));

  const perProject = useMemo(() => new Map((period?.projects ?? []).map((p) => [p.id, p])), [period]);
  // Once the period is in, it is what orders the list: the question is which
  // project is costing you *now*, not which one has cost the most ever.
  const rows = useMemo(() => {
    const list = cost.projects.map((p) => ({ project: p, per: perProject.get(p.id) ?? null }));
    if (period) list.sort((a, b) => (b.per?.seconds ?? 0) - (a.per?.seconds ?? 0) || tokens(b.project) - tokens(a.project));
    return list;
  }, [cost, perProject, period]);

  // The scale every bar is drawn against, and the whole each share is of.
  const top = useMemo(() => (period ? Math.max(1, ...rows.map((r) => r.per?.seconds ?? 0)) : Math.max(1, ...cost.projects.map(tokens))), [rows, cost, period]);
  const accountSeconds = period?.accountTurnHours != null ? period.accountTurnHours * 3600 : null;
  // Fountain's figure when there is one; ours otherwise, which at least sums the same way.
  const whole = period ? (accountSeconds && accountSeconds > 0 ? accountSeconds : period.measured.seconds) : tokens(cost.total);

  const projectRow = ({ project: p, per }: { project: ProjectCost; per: ProjectPeriodCost | null }) => {
    const isOpen = open.has(p.id);
    const size = period ? (per?.seconds ?? 0) : tokens(p);
    const share = whole > 0 ? Math.round((size / whole) * 100) : 0;
    const perItems = new Map((per?.items ?? []).map((w) => [w.id, w]));
    const items = period ? [...p.items].sort((a, b) => (perItems.get(b.id)?.seconds ?? 0) - (perItems.get(a.id)?.seconds ?? 0) || tokens(b) - tokens(a)) : p.items;
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
          {per ? <span className="mono small">{formatTurnTime(per.seconds)}</span> : <span className="mono small">{formatCompact(tokens(p))} tok</span>}
        </div>
        <div className="meter" title={period ? `${share}% of the turn hours on your account this period` : `${share}% of the tokens on your account`}>
          <span style={{ width: `${Math.round((size / top) * 100)}%` }} />
        </div>
        <div className="cost-sub muted small">
          {per ? (
            <>
              {share}% of {accountSeconds != null ? `your ${formatHours(accountSeconds / 3600)}` : "what is measured here"} this period · {per.turns} turn{per.turns === 1 ? "" : "s"} · {formatCompact(tokens(per))} tok
            </>
          ) : (
            <>
              {share}% of your account · {p.turns} turn{p.turns === 1 ? "" : "s"} · {p.conversations} conversation{p.conversations === 1 ? "" : "s"}
            </>
          )}
          {p.memberCount > 0 ? ` · shared with ${p.memberCount}` : ""}
          {p.lastActiveAt ? ` · last ${formatTime(p.lastActiveAt)}` : " · nothing has run"}
        </div>
        {per && (
          <div className="cost-sub muted small">
            All time: {formatCompact(tokens(p))} tok over {p.turns} turn{p.turns === 1 ? "" : "s"} and {p.conversations} conversation{p.conversations === 1 ? "" : "s"}.
          </div>
        )}
        {isOpen && (items.length === 0 ? <p className="muted small indent">No work items.</p> : <ul className="cost-items">{items.map((w) => itemRow(p, w, perItems.get(w.id) ?? null))}</ul>)}
      </li>
    );
  };

  const itemRow = (p: ProjectCost, w: ItemCost, per: ItemPeriodCost | null) => (
    <li key={w.id}>
      <a className="cost-item" href={w.status === null ? href.project(p.id) : href.item(p.id, w.id)}>
        <span className="cost-item-title ellipsis">
          {w.title ?? <span className="muted">Deleted item {w.id.slice(0, 6)}</span>}
          {w.status && isClosed(w.status) && <ItemStatusPill status={w.status} tiny />}
        </span>
        <span className="spacer" />
        <span className="muted small">
          {period ? `${formatCompact(tokens(w))} tok all time` : `${w.turns} turn${w.turns === 1 ? "" : "s"}`}
        </span>
        <span className="mono small cost-item-tokens">{period ? formatTurnTime(per?.seconds ?? 0) : `${formatCompact(tokens(w))} tok`}</span>
      </a>
    </li>
  );

  const b = cost.billing;
  const usage = b?.usage;
  // What the bill covers that no project of the caller's accounts for. The
  // difference of two figures over the same window, not a third measurement.
  const unattributed = accountSeconds != null ? Math.max(0, accountSeconds - (period?.measured.seconds ?? 0)) : null;
  const missing = period ? period.fanout.dropped + period.fanout.failed : 0;

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

      <div className="row section">
        <h2 className="h2">Where the turn hours went</h2>
        <span className="spacer" />
        {period ? (
          <span className="muted small">
            {formatDay(period.period.start)} → {formatDay(period.period.end)}
          </span>
        ) : periodError ? (
          <span className="muted small">this period: unavailable</span>
        ) : (
          <span className="muted small">measuring this period…</span>
        )}
      </div>

      {cost.projects.length === 0 ? (
        <div className="empty card">
          <p className="strong">You own no projects.</p>
          <p className="muted">Nothing runs on your key here. A project shared with you runs on its owner's — and its cost is theirs to see, not yours.</p>
        </div>
      ) : (
        <ul className="cost-list">{rows.map(projectRow)}</ul>
      )}

      {unattributed !== null && (
        <p className="muted small elsewhere">
          Plus {formatTurnTime(unattributed)} on your account that no project of yours accounts for — your team page, your own threads, work in someone else's workbench project. That is Fountain's {formatHours(accountSeconds! / 3600)} for the
          period less the {formatTurnTime(period!.measured.seconds)} measured above, not a third reading.
        </p>
      )}

      {cost.elsewhere.conversations > 0 && unattributed === null && (
        <p className="muted small elsewhere">
          Plus {cost.elsewhere.conversations} conversation{cost.elsewhere.conversations === 1 ? "" : "s"} on your Fountain account that belong to no project of yours — {formatCompact(tokens(cost.elsewhere))} tokens over {cost.elsewhere.turns} turn
          {cost.elsewhere.turns === 1 ? "" : "s"}. Your team page, your own threads, work in someone else's workbench project. They are on the same bill.
        </p>
      )}

      <div className="card stack tight cost-note">
        <p className="strong small">What is measured, and over what</p>
        <p className="muted small">
          The hours above are measured from each turn's own start and end, clipped to the billing period and summed the way Fountain's own meter sums them — so a project's hours really are a share of the account's, in the same unit over the same
          window.{b?.plan?.monthly_cents === undefined ? "" : ` The plan itself is a flat ${formatUsd(b.plan.monthly_cents)} a month however the work splits, so this is where the work went, not a dollar figure per project.`}
        </p>
        <p className="muted small">
          Token counts are a second unit and are not what the plan charges for: per project they are lifetime running totals, and per period they count the turns that finished inside it. Sandbox minutes are the other half of the bill and
          Fountain attributes them to nothing, so neither does this page.
          {period?.period.source === "calendar_month" ? " There is no invoiced period on this account, so the window is the calendar month and there is no account figure to be a share of." : ""}
        </p>
        {missing > 0 && (
          <p className="muted small">
            {period!.fanout.dropped > 0 ? `${period!.fanout.dropped} conversation${period!.fanout.dropped === 1 ? "" : "s"} fell past the ceiling on how many one page load will measure. ` : ""}
            {period!.fanout.failed > 0 ? `Fountain would not answer for ${period!.fanout.failed} more. ` : ""}
            Their hours are missing from the figures above.
          </p>
        )}
        {periodError && <p className="muted small">The per-period breakdown could not be read: {periodError} The all-time token totals above still stand.</p>}
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
