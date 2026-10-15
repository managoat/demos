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
 * one call upstream and paints immediately: where the work went over all
 * time, in tokens. `/api/me/cost/period` is a call per conversation and
 * arrives behind it: the same projects measured in turn hours over the
 * calendar month. Fountain is self-hosted and keeps no bill, so neither is a
 * dollar figure.
 */
import { useEffect, useMemo, useState } from "react";
import { api, type Cost as CostDto, type ItemCost, type ItemPeriodCost, type PeriodCost, type ProjectCost, type ProjectPeriodCost } from "../lib/api";
import { describeError } from "../lib/errors";
import { formatCompact, formatDay, formatTime, formatTurnTime } from "../lib/format";
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
  const whole = period ? period.measured.seconds : tokens(cost.total);

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
        <div className="meter" title={period ? `${share}% of the turn hours measured across your projects this month` : `${share}% of the tokens on your account`}>
          <span style={{ width: `${Math.round((size / top) * 100)}%` }} />
        </div>
        <div className="cost-sub muted small">
          {per ? (
            <>
              {share}% of what is measured here this month · {per.turns} turn{per.turns === 1 ? "" : "s"} · {formatCompact(tokens(per))} tok
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

      <div className="row section">
        <h2 className="h2">Where the turn hours went</h2>
        <span className="spacer" />
        {period ? (
          <span className="muted small">
            {formatDay(period.period.start)} → {formatDay(period.period.end)}
          </span>
        ) : periodError ? (
          <span className="muted small">this month: unavailable</span>
        ) : (
          <span className="muted small">measuring this month…</span>
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

      {cost.elsewhere.conversations > 0 && (
        <p className="muted small elsewhere">
          Plus {cost.elsewhere.conversations} conversation{cost.elsewhere.conversations === 1 ? "" : "s"} on your Managoat account that belong to no project of yours — {formatCompact(tokens(cost.elsewhere))} tokens over {cost.elsewhere.turns} turn
          {cost.elsewhere.turns === 1 ? "" : "s"}. Your own threads, work in someone else's workbench project, other apps on the same key.
        </p>
      )}

      <div className="card stack tight cost-note">
        <p className="strong small">What is measured, and over what</p>
        <p className="muted small">
          The hours above are measured from each turn's own start and end, clipped to the calendar month (UTC) and summed, so two conversations each running an hour are two hours. Managoat keeps no bill, so this is where the
          work went, not a dollar figure per project.
        </p>
        <p className="muted small">
          Token counts are a second unit: per project they are lifetime running totals, and per month they count the turns that finished inside it.
        </p>
        {missing > 0 && (
          <p className="muted small">
            {period!.fanout.dropped > 0 ? `${period!.fanout.dropped} conversation${period!.fanout.dropped === 1 ? "" : "s"} fell past the ceiling on how many one page load will measure. ` : ""}
            {period!.fanout.failed > 0 ? `Managoat would not answer for ${period!.fanout.failed} more. ` : ""}
            Their hours are missing from the figures above.
          </p>
        )}
        {periodError && <p className="muted small">The per-period breakdown could not be read: {periodError} The all-time token totals above still stand.</p>}
      </div>
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
