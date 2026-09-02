/**
 * `.rounds.yml` — the audited repository's own policy, parsed here.
 *
 * It used to be the agent's job to read this file and honor it, which made
 * the repo's policy advisory: a round that misread the file, or was talked out
 * of it by something else in the repository, simply did the wrong thing and
 * nobody was watching. Now the server reads it, enforces the two keys that are
 * about *writing* (`enabled`, `max_open_prs`), and hands the rest back to the
 * agent — so there is one parser and one answer instead of two.
 *
 * Deliberately a small hand-rolled subset rather than a YAML dependency: the
 * file is five flat keys, and anything it does not understand it ignores,
 * which is the documented behavior.
 */

export interface Policy {
  /** false → the repository has switched rounds off entirely. */
  enabled: boolean;
  /**
   * Which tiers this repository will accept pull requests for, or null when
   * the file does not say.
   *
   * Null is not the same as a default. A repository that has never heard of
   * `.rounds.yml` has not asked for anything, so the choice made at enrollment
   * stands; a repository that lists tiers has overridden it. Answering with a
   * default here instead would mean every repo without the file silently
   * refusing whatever the person who enrolled it had ticked.
   *
   * `quick-win` (deterministic fixes), `needs-review` (guidance fixes), and
   * `report-only` — the hygiene tier, which is never proposed unless a
   * repository asks for it here.
   */
  tiers: string[] | null;
  /** Rule ids never to propose. */
  ignore: string[];
  /** Globs whose findings are skipped. */
  pathsIgnore: string[];
  /** Never more than this many rounds pull requests open at once. */
  maxOpenPrs: number;
}

export const DEFAULT_POLICY: Policy = {
  enabled: true,
  tiers: null,
  ignore: [],
  pathsIgnore: [],
  maxOpenPrs: 3,
};

/** Strip a trailing comment, but not a `#` inside quotes. */
function uncomment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]!))) {
      return line.slice(0, i);
    }
  }
  return line;
}

const unquote = (s: string) => s.replace(/^['"]|['"]$/g, "").trim();

function items(value: string): string[] {
  const inline = value.trim();
  if (!inline.startsWith("[")) return [];
  return inline
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map(unquote)
    .filter(Boolean);
}

/**
 * Parse what we understand and ignore the rest. A file that is unreadable, or
 * absent, is not an error — it means "no policy", which is the default.
 */
export function parsePolicy(raw: string | null): Policy {
  const policy: Policy = { ...DEFAULT_POLICY, ignore: [], pathsIgnore: [] };
  if (!raw) return policy;

  const lines = raw.split(/\r?\n/).map(uncomment);
  let list: string[] | null = null;

  for (const line of lines) {
    const bullet = /^\s*-\s+(.*)$/.exec(line);
    if (bullet && list) {
      const v = unquote(bullet[1]!);
      if (v) list.push(v);
      continue;
    }
    const pair = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (!pair) continue;
    const [, key, rest] = pair as unknown as [string, string, string];
    const value = rest.trim();
    list = null;

    switch (key) {
      case "enabled":
        policy.enabled = unquote(value).toLowerCase() !== "false";
        break;
      case "max_open_prs": {
        const n = Number(unquote(value));
        // A repo asking for zero means "do not open anything", which is
        // legitimate; a negative or absurd number is a typo, not a policy.
        if (Number.isInteger(n) && n >= 0 && n <= 50) policy.maxOpenPrs = n;
        break;
      }
      case "tiers":
      case "ignore":
      case "paths_ignore": {
        const target = key === "tiers" ? "tiers" : key === "ignore" ? "ignore" : "pathsIgnore";
        const inline = items(value);
        if (inline.length > 0 || value.startsWith("[")) {
          policy[target] = inline;
        } else if (value === "") {
          // A block list follows on the next lines.
          policy[target] = [];
          list = policy[target];
        }
        break;
      }
      default:
        break;
    }
  }
  return policy;
}
