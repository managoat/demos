/**
 * The Rounds protocol: how the app reads the agent.
 *
 * Two block kinds per scheduled run:
 *
 *   - one ```round — the audit's findings, and what became of each cluster;
 *   - a ```round-diff <cluster-key> per cluster the round actually changed
 *     something for, holding that cluster's unified diff.
 *
 * The diffs are separate fences rather than strings inside the JSON for the
 * reason Mend found first: newline-escaping a patch into JSON is a thing
 * models get wrong, and a malformed patch would take the whole round block
 * down with it.
 *
 * Why the diffs come from the agent at all, when the server is the half that
 * commits: the server only ever sees a cluster that became a pull request. It
 * never sees the ones held back at the cap, or the ones that failed
 * verification — and those are exactly the ones where "show me what it wanted
 * to do" is worth the most. So the round reports its own work.
 *
 * The thread is the system of record — the app folds every round out of it,
 * newest first — so the history survives without the app storing anything.
 * The agent's side of the contract is `spec.ts`; change one, change both.
 */
import { CATEGORIES, FIX_KINDS, RECONSIDER_LABEL, ruleDocUrl, SEVERITIES, TIERS, type Finding, type Severity } from "../../server/contract";

export type { Authority, Category, Finding, FixKind, Severity, Tier } from "../../server/contract";
export { RECONSIDER_LABEL, ruleDocUrl };

export type ClusterStatus = "opened" | "already-open" | "declined" | "deferred" | "failed" | "clean";

export interface Cluster {
  key: string;
  file: string;
  status: ClusterStatus;
  checkIds: string[];
  title?: string;
  /** The pull request number, when there is one. */
  pr?: number;
  url?: string;
  /** Why it was deferred or failed. */
  note?: string;
  /**
   * What this cluster changed, as a unified diff — present for the clusters
   * the round did work on (opened, failed, deferred) and absent for the ones
   * it only considered. Attached from the round's `round-diff` fences.
   */
  diff?: string;
}

export interface RoundSummary {
  total: number;
  quickWin: number;
  needsReview: number;
  reportOnly: number;
}

export interface Round {
  /** When the agent says it ran. */
  at?: string;
  commit?: string;
  branch?: string;
  scanned?: number;
  summary: RoundSummary;
  /**
   * Every finding the audit produced, not only the ones that became a pull
   * request — the report-only tier is a result too, and "chant read your Helm
   * charts and they were fine" is worth showing.
   */
  findings: Finding[];
  /** Findings the agent left out of the block to keep it small. */
  omitted: number;
  clusters: Cluster[];
  /** Rounds pull requests open at the end of the round. */
  openPrs: number;
  /** Set only when the round could not run at all. */
  error: string | null;
}

/** ```round … ``` and ```round-diff <cluster-key> … ```, in one pass. */
const FENCE = /```(round-diff|round)(?:[^\S\n]+([^\n]*?))?[^\S\n]*\n([\s\S]*?)```/g;

/**
 * Every well-formed round in one reply, each with its clusters' diffs already
 * attached. Malformed JSON is skipped; a diff whose cluster key matches no
 * cluster is dropped rather than shown loose, because a diff with nothing to
 * say about which finding it answers is noise.
 */
export function parseRounds(text: string): Round[] {
  const rounds: Round[] = [];
  const diffs = new Map<string, string>();

  for (const m of text.matchAll(FENCE)) {
    const kind = m[1]!;
    if (kind === "round-diff") {
      const key = (m[2] ?? "").trim();
      const diff = m[3]!.replace(/\n$/, "");
      if (key && diff.trim()) diffs.set(key, diff);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[3]!);
    } catch {
      continue;
    }
    const round = asRound(parsed);
    if (round) rounds.push(round);
  }

  // The fences may come in either order — the agent writes the diffs as it
  // works and the round block last — so attach after the whole reply is read.
  if (diffs.size === 0) return rounds;
  return rounds.map((round) => ({
    ...round,
    clusters: round.clusters.map((c) => {
      const diff = diffs.get(c.key);
      return diff ? { ...c, diff } : c;
    }),
  }));
}

export interface RoundEntry {
  round: Round;
  /** When the turn ran, from Fountain — more trustworthy than the agent's own clock. */
  ranAt: string | null;
}

/** Fold a thread (oldest-first) into the rounds it recorded, newest first. */
export function foldRounds(turns: Array<{ reply: string; ranAt?: string | null }>): RoundEntry[] {
  const out: RoundEntry[] = [];
  for (const turn of turns) {
    for (const round of parseRounds(turn.reply)) {
      out.push({ round, ranAt: turn.ranAt ?? null });
    }
  }
  return out.reverse();
}

/** The pull requests this repo currently has open, from the newest round. */
export function openPullRequests(entries: RoundEntry[]): Cluster[] {
  const latest = entries[0];
  if (!latest) return [];
  const seen = new Set<number>();
  return latest.round.clusters.filter((c) => {
    if (c.status !== "opened" && c.status !== "already-open") return false;
    if (c.pr === undefined || seen.has(c.pr)) return false;
    seen.add(c.pr);
    return true;
  });
}

// ── the report, arranged around the work ────────────────────────────────────

/**
 * One file's findings and what the round did about them.
 *
 * Mend arranges its report the way blacklight does — quick wins by file,
 * guidance clustered by authority — because there the reader is deciding what
 * to fix. Here that decision is already made: the round clustered by file,
 * proposed per file, and the question a maintainer arrives with is "what went
 * up, and why". So the file is the unit, and its cluster, its diff and its
 * pull request hang off it.
 */
export interface FileReport {
  file: string;
  /** The cluster this file's merge-worthy findings became, if it became one. */
  cluster: Cluster | null;
  findings: Finding[];
  /** Straight off the cluster, so the row can render the change inline. */
  diff?: string;
}

export interface ReportView {
  /** Files with merge-worthy findings, ordered by what happened to them. */
  files: FileReport[];
  /** The hygiene tier: worth knowing, never worth a pull request. */
  reportOnly: Finding[];
  /** Clusters the round reported that no finding was sent for. */
  orphans: Cluster[];
}

const SEVERITY_WEIGHT: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/** Errors first, then by rule, then by file — chant's own order. */
export function sortFindings(a: Finding, b: Finding): number {
  const sev = SEVERITY_WEIGHT[a.severity]! - SEVERITY_WEIGHT[b.severity]!;
  if (sev !== 0) return sev;
  if (a.checkId !== b.checkId) return a.checkId < b.checkId ? -1 : 1;
  return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
}

/** What happened first: the work, then the waiting, then the settled. */
const STATUS_ORDER: Record<ClusterStatus, number> = {
  opened: 0,
  failed: 1,
  deferred: 2,
  "already-open": 3,
  clean: 4,
  declined: 5,
};

/**
 * Join the round's findings to its clusters.
 *
 * The two are reported separately — findings come from the audit, clusters
 * from what the round decided — and the cluster key is what ties them: it is
 * derived from the file path, by the same rule on both sides.
 */
export function arrangeRound(round: Round): ReportView {
  const sorted = [...round.findings].sort(sortFindings);
  const byFile = new Map<string, Finding[]>();
  const reportOnly: Finding[] = [];
  for (const f of sorted) {
    if (f.tier === "report-only") {
      reportOnly.push(f);
      continue;
    }
    const list = byFile.get(f.file);
    if (list) list.push(f);
    else byFile.set(f.file, [f]);
  }

  // Join on the cluster's own file first and its key second. The key is
  // derived from the path, so in a well-formed round the two agree — but a
  // round that keys a cluster some other way would otherwise have every one
  // of its files rendered twice, once from the findings and once as an
  // orphan. The cluster says which file it is about; believe it.
  const byPath = new Map<string, Cluster>();
  const byKey = new Map<string, Cluster>();
  for (const c of round.clusters) {
    const path = c.file.replace(/^\.?\/+/, "");
    if (!byPath.has(path)) byPath.set(path, c);
    if (!byKey.has(c.key)) byKey.set(c.key, c);
  }

  const claimed = new Set<string>();
  const files: FileReport[] = [...byFile.entries()].map(([file, findings]) => {
    const cluster = byPath.get(file) ?? byKey.get(clusterKeyOf(file)) ?? null;
    if (cluster) claimed.add(cluster.key);
    const report: FileReport = { file, cluster, findings };
    if (cluster?.diff) report.diff = cluster.diff;
    return report;
  });

  files.sort((a, b) => {
    const rank = (r: FileReport) => (r.cluster ? STATUS_ORDER[r.cluster.status] : 6);
    const byStatus = rank(a) - rank(b);
    return byStatus !== 0 ? byStatus : a.file < b.file ? -1 : 1;
  });

  // A cluster with no finding behind it: the round trimmed its findings to
  // keep the block small, or it is reporting a file whose findings are gone.
  // Either way it still has a status worth showing, so it is not dropped.
  const orphans = round.clusters.filter((c) => !claimed.has(c.key));
  return { files, reportOnly, orphans };
}

/**
 * A file path's cluster key. The same derivation the server does in
 * `contract.ts` — it is duplicated here rather than imported because this one
 * runs against a *reported* path and must not throw on a strange one.
 */
function clusterKeyOf(path: string): string {
  return path
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The clusters whose work this round can show a diff for. */
export function changedClusters(round: Round): Cluster[] {
  return round.clusters.filter((c) => typeof c.diff === "string" && c.diff.trim() !== "");
}

/**
 * How many clusters ended in each status.
 *
 * The round used to be summarized by whatever sentence came back with it. This
 * is the same summary taken from the record instead: it cannot flatter the
 * round, cannot contradict the rows underneath it, and reads the same every
 * week.
 */
export function clusterCounts(round: Round): Record<ClusterStatus, number> {
  const counts: Record<ClusterStatus, number> = {
    opened: 0,
    "already-open": 0,
    declined: 0,
    deferred: 0,
    failed: 0,
    clean: 0,
  };
  for (const c of round.clusters) counts[c.status] += 1;
  return counts;
}

/** How a round reads in one line, for the repo list. */
export function describeRound(round: Round): string {
  if (round.error) return round.error;
  const opened = round.clusters.filter((c) => c.status === "opened").length;
  const failed = round.clusters.filter((c) => c.status === "failed").length;
  const parts: string[] = [];
  if (opened > 0) parts.push(`opened ${opened} pull request${opened === 1 ? "" : "s"}`);
  if (round.openPrs > 0 && opened !== round.openPrs) parts.push(`${round.openPrs} open`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (parts.length === 0) parts.push(round.summary.total === 0 ? "clean — nothing to fix" : "nothing new to propose");
  return parts.join(" · ");
}

// ── shape guards ────────────────────────────────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/**
 * A finding, read defensively.
 *
 * The server validates these strictly, because it renders them into a pull
 * request. Here the job is the opposite: never crash the page over an agent
 * that sent `severity: "critical"`. A finding missing its rule id or its file
 * is not a finding; everything else falls back.
 */
function asFinding(v: unknown): Finding | null {
  if (!isObj(v)) return null;
  const checkId = str(v.checkId);
  const file = str(v.file);
  if (!checkId || !file) return null;
  const f: Finding = {
    checkId,
    file: file.replace(/^\.?\/+/, ""),
    severity: oneOf(v.severity, SEVERITIES, "warning"),
    message: str(v.message) ?? "",
    tier: oneOf(v.tier, TIERS, "report-only"),
    fixKind: oneOf(v.fixKind, FIX_KINDS, "guidance"),
    category: oneOf(v.category, CATEGORIES, "best-practice"),
    title: str(v.title) ?? checkId,
  };
  const entity = str(v.entity);
  if (entity) f.entity = entity;
  const remediation = str(v.remediation);
  if (remediation) f.remediation = remediation;
  const note = str(v.note);
  if (note) f.note = note;
  if (isObj(v.authority)) {
    const name = str(v.authority.name);
    if (name) {
      f.authority = { name };
      const url = str(v.authority.url);
      if (url && /^https?:\/\//.test(url)) f.authority.url = url;
    }
  }
  return f;
}

const STATUSES: ClusterStatus[] = ["opened", "already-open", "declined", "deferred", "failed", "clean"];

function asCluster(v: unknown): Cluster | null {
  if (!isObj(v)) return null;
  const key = str(v.key);
  const file = str(v.file);
  if (!key && !file) return null;
  const status = typeof v.status === "string" && (STATUSES as string[]).includes(v.status) ? (v.status as ClusterStatus) : "clean";
  const c: Cluster = {
    key: key ?? file!,
    file: file ?? key!,
    status,
    checkIds: Array.isArray(v.checkIds) ? v.checkIds.filter((x): x is string => typeof x === "string") : [],
  };
  const title = str(v.title);
  if (title) c.title = title;
  const pr = num(v.pr);
  if (pr !== undefined && pr > 0) c.pr = Math.floor(pr);
  const url = str(v.url);
  if (url && /^https?:\/\//.test(url)) c.url = url;
  const note = str(v.note);
  if (note) c.note = note;
  return c;
}

function asRound(v: unknown): Round | null {
  if (!isObj(v)) return null;
  const clusters = Array.isArray(v.clusters) ? v.clusters.map(asCluster).filter((c): c is Cluster => c !== null) : [];
  const findings = Array.isArray(v.findings) ? v.findings.map(asFinding).filter((f): f is Finding => f !== null) : [];
  const s = isObj(v.summary) ? v.summary : {};
  // A summary the agent forgot is recomputed from the findings it did send —
  // the tiles are the first thing on the page and a zero there reads as
  // "clean", which is the one thing it must never say by accident.
  const summary: RoundSummary = isObj(v.summary)
    ? {
        total: num(s.total) ?? 0,
        quickWin: num(s.quickWin) ?? 0,
        needsReview: num(s.needsReview) ?? 0,
        reportOnly: num(s.reportOnly) ?? 0,
      }
    : {
        total: findings.length,
        quickWin: findings.filter((f) => f.tier === "merge-worthy" && f.fixKind === "deterministic").length,
        needsReview: findings.filter((f) => f.tier === "merge-worthy" && f.fixKind === "guidance").length,
        reportOnly: findings.filter((f) => f.tier === "report-only").length,
      };
  // A round with neither a summary nor clusters nor an error is not a round.
  const error = str(v.error);
  if (!isObj(v.summary) && clusters.length === 0 && findings.length === 0 && !error) return null;
  const round: Round = {
    summary,
    findings,
    omitted: Math.max(0, Math.floor(num(v.omitted) ?? 0)),
    clusters,
    openPrs: num(v.openPrs) ?? clusters.filter((c) => c.status === "opened" || c.status === "already-open").length,
    error,
  };
  const at = str(v.at);
  if (at) round.at = at;
  const commit = str(v.commit);
  if (commit) round.commit = commit;
  const branch = str(v.branch);
  if (branch) round.branch = branch;
  const scanned = num(v.scanned);
  if (scanned !== undefined) round.scanned = Math.floor(scanned);
  return round;
}
