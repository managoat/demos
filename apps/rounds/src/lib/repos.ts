/**
 * Turning "every repository the App can reach" into a list somebody can get
 * through.
 *
 * Signing in with GitHub already tells us which repositories are reachable, so
 * asking somebody to type `owner/name` from memory was asking a question we
 * could answer. The rail shows both halves — what is enrolled, and what is
 * merely available — and this is the part that decides what "available" looks
 * like: what matches the search, what order it is in, and what has been waved
 * away.
 *
 * Pure functions, because the ordering is a claim ("these are the ones you
 * probably meant") and a claim in a component is a claim nobody tests.
 */

/** A repository the signed-in person could enroll, as `/gh/repos` returns it. */
export interface AccessibleRepo {
  /** `owner/name`. */
  slug: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  pushedAt: string | null;
  description: string | null;
}

/** Which half of the rail a repository belongs to, once it is grouped. */
export interface RepoOption extends AccessibleRepo {
  /** The app's canonical key, so it can be matched against what is enrolled. */
  key: string;
  /** Worth surfacing unprompted — see `isSuggested`. */
  suggested: boolean;
}

export type RepoFilter = "suggested" | "all" | "skipped";

/** GitHub slugs are the only thing `/gh/repos` returns, so the host is fixed. */
export function keyOfSlug(slug: string): string {
  return `github.com/${slug}`;
}

/**
 * A repository worth putting in front of somebody who has not asked.
 *
 * Recency is the whole signal: a repository pushed to this quarter is one
 * somebody is still living in, and its configuration is what a round would be
 * fixing. Forks and archives are excluded — a round can audit them and, for an
 * archive, could never open the pull request it wanted to.
 *
 * Deliberately not "we looked and it has findings": that would take a clone
 * per repository at sign-in, and a suggestion that costs an audit is not a
 * suggestion. This claims recency and nothing more, which is why the UI says
 * "recently active" rather than "needs work".
 */
export function isSuggested(repo: AccessibleRepo, now: number, days = 90): boolean {
  if (repo.archived || repo.fork) return false;
  if (!repo.pushedAt) return false;
  const at = Date.parse(repo.pushedAt);
  if (Number.isNaN(at)) return false;
  return now - at <= days * 86400_000;
}

/**
 * Most recently pushed first, with anything undated last.
 *
 * Ties break on the slug so the order is stable across renders — a list that
 * reshuffles while somebody is reading it is worse than one sorted badly.
 */
export function byRecency(a: AccessibleRepo, b: AccessibleRepo): number {
  const at = a.pushedAt ? Date.parse(a.pushedAt) : NaN;
  const bt = b.pushedAt ? Date.parse(b.pushedAt) : NaN;
  const av = Number.isNaN(at) ? -Infinity : at;
  const bv = Number.isNaN(bt) ? -Infinity : bt;
  if (av !== bv) return bv - av;
  return a.slug.localeCompare(b.slug);
}

/**
 * Does this repository match what was typed?
 *
 * Every whitespace-separated word has to appear somewhere in the slug or the
 * description, so `web api` finds `acme/web-api` and `owner/` narrows to an
 * owner. Case-insensitive, substring rather than fuzzy: a rail of forty
 * repositories does not need scoring, and a fuzzy match that surfaces the
 * wrong repository at the top of an enroll list is a mistake somebody makes
 * with one click.
 */
export function matchesQuery(repo: AccessibleRepo, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = `${repo.slug} ${repo.description ?? ""}`.toLowerCase();
  return terms.every((t) => haystack.includes(t));
}

export interface RailInput {
  repos: AccessibleRepo[];
  /** `host/owner/name` for everything already enrolled. */
  enrolledKeys: Set<string>;
  /** Slugs waved away, which stay out of the way until asked for. */
  skipped: Set<string>;
  query: string;
  filter: RepoFilter;
  now: number;
}

export interface RailRepos {
  /** What to offer, in order, under the current search and filter. */
  available: RepoOption[];
  /** How many the filter is holding back — the count on the "all" chip. */
  hiddenByFilter: number;
  /** How many were waved away, so there is a way back to them. */
  skippedCount: number;
  /** Reachable, not enrolled, not skipped — what "all" would show. */
  totalAvailable: number;
}

/**
 * The available half of the rail: what is reachable, minus what is already
 * enrolled, arranged by the current search and filter.
 *
 * Enrolled repositories are dropped rather than marked. They are already in
 * the rail above, and a list of things to act on that includes things already
 * acted on is the thing this replaced.
 */
export function railRepos(input: RailInput): RailRepos {
  const { repos, enrolledKeys, skipped, query, filter, now } = input;
  const options: RepoOption[] = repos
    .map((r) => ({ ...r, key: keyOfSlug(r.slug), suggested: isSuggested(r, now) }))
    .filter((r) => !enrolledKeys.has(r.key));

  const live = options.filter((r) => !skipped.has(r.slug));
  const matching = live.filter((r) => matchesQuery(r, query));

  // Searching means looking for something specific, so a search reaches past
  // the suggestion filter rather than through it. Otherwise typing the exact
  // name of an archived repository finds nothing, which reads as a bug.
  const chosen =
    filter === "skipped"
      ? options.filter((r) => skipped.has(r.slug) && matchesQuery(r, query))
      : filter === "all" || query.trim() !== ""
        ? matching
        : matching.filter((r) => r.suggested);

  return {
    available: [...chosen].sort(byRecency),
    hiddenByFilter: matching.length - chosen.length,
    skippedCount: options.filter((r) => skipped.has(r.slug)).length,
    totalAvailable: live.length,
  };
}
