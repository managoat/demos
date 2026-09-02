/**
 * The contract between a round and this server — the few strings both halves
 * have to agree on exactly.
 *
 * It lives under `server/` because the server is now the half that enforces
 * it: the branch name and the marker are written here, from a signed grant,
 * rather than assembled by the agent and taken on trust. `src/lib/spec.ts`
 * imports these so the prompt and the enforcement cannot drift apart.
 *
 * Pure strings and regexes, no imports — the browser bundle pulls this in too.
 */

/** Every branch a round may write. Nothing outside this prefix is reachable. */
export const BRANCH_PREFIX = "rounds/";

/** Written into every pull request body, so a later round knows its own work. */
export const PR_MARKER = "rounds:cluster=";

/**
 * A cluster key: a file path lowercased with every run of non-alphanumeric
 * characters collapsed to a hyphen. `.github/workflows/ci.yml` →
 * `github-workflows-ci-yml`. Stable across rounds, which is the only reason
 * a round can recognize what it already proposed.
 */
export function clusterKey(path: string): string {
  return path.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export const CLUSTER_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const branchFor = (cluster: string) => `${BRANCH_PREFIX}${cluster}`;

/** `rounds/dockerfile` → `dockerfile`; null for a branch that is not ours. */
export function clusterOfBranch(branch: string): string | null {
  return branch.startsWith(BRANCH_PREFIX) ? branch.slice(BRANCH_PREFIX.length) : null;
}

export const markerFor = (cluster: string) => `<!-- ${PR_MARKER}${cluster} -->`;

/**
 * The one way to take a "no" back.
 *
 * A rounds pull request closed unmerged declines its cluster permanently —
 * that is the promise that makes an unattended bot bearable, so it cannot be
 * undone by asking nicely. Label the closed pull request `rounds:reconsider`
 * and the next round may propose that file again.
 *
 * It lives on the pull request rather than in `.rounds.yml` for the same
 * reason the branch name and the marker do: state belongs at GitHub, where
 * the person saying no was already standing, and there is nothing to keep in
 * sync. It forgives exactly the pull request it is on, so closing the next one
 * unmerged declines the cluster again.
 */
export const RECONSIDER_LABEL = "rounds:reconsider";

/** Does this pull request's label set take its decline back? */
export function reconsidered(labels: readonly string[] | undefined): boolean {
  return (labels ?? []).some((l) => l.toLowerCase() === RECONSIDER_LABEL);
}

/**
 * What a proposal may be. Generous enough for any configuration fix, small
 * enough that a runaway round cannot post a repository at us.
 */
export const LIMITS = {
  files: 20,
  bytes: 512 * 1024,
  pathLength: 255,
  clusterLength: 120,
  title: 120,
  body: 60_000,
} as const;

// ── the findings a round reports ───────────────────────────────────────────

/**
 * One chant finding, as both halves of the app see it.
 *
 * It lives in the contract rather than in the browser's `protocol.ts` because
 * the server now renders the pull request body from these — so the thing the
 * maintainer reads on GitHub and the thing the UI shows are the same objects,
 * and cannot drift into disagreeing about what was fixed.
 *
 * Everything except `note` is chant's own output. `note` is the agent's
 * sentence about what it changed and why, which is the one part of a rounds
 * pull request that is written rather than derived.
 */
export type Severity = "error" | "warning" | "info";
export type Tier = "merge-worthy" | "report-only";
export type FixKind = "deterministic" | "guidance";
export type Category = "security" | "correctness" | "best-practice";

export interface Authority {
  name: string;
  url?: string;
}

export interface Finding {
  checkId: string;
  severity: Severity;
  message: string;
  file: string;
  entity?: string;
  tier: Tier;
  fixKind: FixKind;
  category: Category;
  title: string;
  /** chant's advice — what a person should do about it. */
  remediation?: string;
  authority?: Authority;
  /** The agent's own line: what it changed here, and why. */
  note?: string;
}

export const SEVERITIES: readonly Severity[] = ["error", "warning", "info"];
export const TIERS: readonly Tier[] = ["merge-worthy", "report-only"];
export const FIX_KINDS: readonly FixKind[] = ["deterministic", "guidance"];
export const CATEGORIES: readonly Category[] = ["security", "correctness", "best-practice"];

/** The reference entry for a rule id — the same scheme the CLI report uses. */
export function ruleDocUrl(id: string): string {
  return `https://intentius.io/chant/lint-rules/audit-rules/#${id.toLowerCase()}`;
}

/** What a proposal's findings may be. A cluster is one file, so this is roomy. */
export const FINDING_LIMITS = {
  perProposal: 50,
  checkId: 64,
  text: 2000,
} as const;
