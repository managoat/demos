/**
 * Opening the pull request — the half of a round that writes.
 *
 * This used to happen inside the agent: it held a token that could push, it
 * chose its own branch name, and every rule that kept it well-behaved was a
 * sentence in its prompt. That is a poor place for a rule. The agent spends
 * the round reading configuration files out of a repository it does not
 * control, and a prompt is not a boundary — anything that can talk it into
 * ignoring rule 4 gets rule 4 ignored, unattended, at 09:00 on a Monday.
 *
 * So the writing moved here, behind a signed grant:
 *
 *   - the repository comes from the grant's signature, never from the request;
 *   - the branch is derived from the cluster key, never supplied;
 *   - the marker is written by us, so it cannot be forgotten or forged;
 *   - a cluster a human closed unmerged is refused, permanently;
 *   - the open-pull-request cap is counted here, against the repo's own
 *     `.rounds.yml`.
 *
 * The write token is minted, used, and dropped inside a single request. It is
 * never returned to anybody.
 */
import {
  commitChanges,
  installationToken,
  listPullsWithPrefix,
  openPull,
  putBranch,
  readFile,
  READ_STATE,
  repoInfo,
  WRITE,
  type AppConfig,
  type Deps,
  type FileChange,
  type PullSummary,
} from "./github";
import { parsePolicy, type Policy } from "./policy";
import {
  BRANCH_PREFIX,
  branchFor,
  CATEGORIES,
  CLUSTER_KEY,
  clusterOfBranch,
  FINDING_LIMITS,
  FIX_KINDS,
  LIMITS,
  markerFor,
  PR_MARKER,
  reconsidered,
  SEVERITIES,
  TIERS,
  type Finding,
} from "./contract";
import { renderBody } from "./prbody";

/**
 * A refusal the round should report and move past, rather than retry. Every
 * one of these carries a `reason` the agent can put straight into its round
 * block, because "why did nothing happen" is the question the app exists to
 * answer.
 */
export class Refused extends Error {
  constructor(
    message: string,
    public reason: "disabled" | "already-open" | "declined" | "at-cap" | "invalid",
    public status = 409,
    public pr?: number,
  ) {
    super(message);
  }
}

export interface ProposeRequest {
  cluster: string;
  base: string;
  title: string;
  /**
   * The findings this cluster fixes. The body is rendered from these rather
   * than sent as prose, so the pull request and the round block the app shows
   * are the same data — see `prbody.ts`.
   */
  findings: Finding[];
  /** Merge-worthy counts either side of the fix, from the round's verification. */
  before?: number;
  after?: number;
  files: FileChange[];
}

// ── what the round is allowed to send ──────────────────────────────────────

const CONTROL = /[\u0000-\u001f\u007f]/;

/** A path inside the repository, and nowhere else. */
function checkPath(path: unknown): string {
  if (typeof path !== "string" || !path) throw new Refused("Every file needs a path.", "invalid", 400);
  if (path.length > LIMITS.pathLength) throw new Refused(`Path is longer than ${LIMITS.pathLength} characters.`, "invalid", 400);
  if (CONTROL.test(path) || path.includes("\\")) throw new Refused(`Path is not a repository path: ${path}`, "invalid", 400);
  if (path.startsWith("/")) throw new Refused(`Paths are relative to the repository root: ${path}`, "invalid", 400);
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) throw new Refused(`Path is not normalized: ${path}`, "invalid", 400);
  // `.git` is the repository's own machinery; a commit that rewrites it is
  // never a configuration fix.
  if (segments[0] === ".git") throw new Refused("A round may not write inside .git.", "invalid", 400);
  return path;
}

/**
 * A finding, taken only as far as it is trusted.
 *
 * The round assembled these from chant's JSON, so they are the shape we
 * asked for — but they arrive over the wire from something that has spent the
 * round reading a repository it does not control, and they end up rendered
 * into a pull request body. So the enums are checked against the contract
 * rather than passed through, the text is capped, and the authority URL has
 * to be http(s) — a `javascript:` link in a markdown bullet is a small thing
 * that would nonetheless be entirely our fault.
 */
function readFinding(raw: unknown, i: number): Finding {
  const bad = (m: string): never => {
    throw new Refused(`findings[${i}]: ${m}`, "invalid", 400);
  };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad("must be an object.");
  const v = raw as Record<string, unknown>;

  const text = (x: unknown, name: string, required: boolean): string => {
    if (typeof x !== "string" || x === "") {
      if (required) return bad(`${name} is required.`);
      return "";
    }
    if (x.length > FINDING_LIMITS.text) return bad(`${name} is longer than ${FINDING_LIMITS.text} characters.`);
    return x;
  };
  const pick = <T extends string>(x: unknown, allowed: readonly T[], name: string): T => {
    if (typeof x !== "string" || !(allowed as readonly string[]).includes(x)) {
      return bad(`${name} must be one of ${allowed.join(", ")}.`);
    }
    return x as T;
  };

  const checkId = text(v.checkId, "checkId", true);
  if (checkId.length > FINDING_LIMITS.checkId || !/^[A-Za-z0-9_.-]+$/.test(checkId)) {
    return bad("checkId must be a rule id like `GHA033`.");
  }

  const finding: Finding = {
    checkId,
    file: checkPath(v.file),
    severity: pick(v.severity, SEVERITIES, "severity"),
    tier: pick(v.tier, TIERS, "tier"),
    fixKind: pick(v.fixKind, FIX_KINDS, "fixKind"),
    category: pick(v.category, CATEGORIES, "category"),
    title: text(v.title, "title", true),
    message: text(v.message, "message", false),
  };
  const entity = text(v.entity, "entity", false);
  if (entity) finding.entity = entity;
  const remediation = text(v.remediation, "remediation", false);
  if (remediation) finding.remediation = remediation;
  const note = text(v.note, "note", false);
  if (note) finding.note = note;
  if (typeof v.authority === "object" && v.authority !== null && !Array.isArray(v.authority)) {
    const a = v.authority as Record<string, unknown>;
    const name = text(a.name, "authority.name", false);
    if (name) {
      finding.authority = { name };
      const url = text(a.url, "authority.url", false);
      if (url && /^https?:\/\//.test(url)) finding.authority.url = url;
    }
  }
  return finding;
}

/**
 * Validate and normalize. Everything here is a 400 — a malformed proposal is
 * the round's bug, not the repository's state, and telling it apart from a
 * refusal matters when the only reader is a JSON block in a reply.
 */
export function readProposal(raw: unknown): ProposeRequest {
  const bad = (m: string): never => {
    throw new Refused(m, "invalid", 400);
  };
  if (typeof raw !== "object" || raw === null) return bad("Send a JSON object.");
  const { cluster, base, title, findings, before, after, files } = raw as Record<string, unknown>;

  if (typeof cluster !== "string" || cluster.length > LIMITS.clusterLength || !CLUSTER_KEY.test(cluster)) {
    return bad("cluster must be a key like `github-workflows-ci-yml` — lowercase, digits and single hyphens.");
  }
  if (typeof base !== "string" || !/^[0-9a-f]{7,40}$/.test(base)) return bad("base must be the commit sha the fix was made on.");
  if (typeof title !== "string" || !title.trim() || title.length > LIMITS.title || title.includes("\n")) {
    return bad(`title must be one line of at most ${LIMITS.title} characters.`);
  }
  // The body is rendered from these, so an empty list would open a pull
  // request that never says why it exists.
  if (!Array.isArray(findings) || findings.length === 0) return bad("findings must list what this cluster fixes.");
  if (findings.length > FINDING_LIMITS.perProposal) {
    return bad(`A proposal may carry at most ${FINDING_LIMITS.perProposal} findings; this one carries ${findings.length}.`);
  }
  const counts = (x: unknown, name: string): number | undefined => {
    if (x === undefined || x === null) return undefined;
    if (typeof x !== "number" || !Number.isInteger(x) || x < 0) return bad(`${name} must be a whole number of findings.`);
    return x;
  };
  if (!Array.isArray(files) || files.length === 0) return bad("files must list at least one change.");
  if (files.length > LIMITS.files) return bad(`A proposal may touch at most ${LIMITS.files} files; this one touches ${files.length}.`);

  let bytes = 0;
  const seen = new Set<string>();
  const parsed: FileChange[] = files.map((f) => {
    if (typeof f !== "object" || f === null) return bad("Each file must be {path, content} or {path, deleted: true}.");
    const entry = f as Record<string, unknown>;
    const path = checkPath(entry.path);
    if (seen.has(path)) return bad(`${path} appears twice in the same proposal.`);
    seen.add(path);
    if (entry.deleted === true) return { path, deleted: true } as FileChange;
    if (typeof entry.content !== "string") return bad(`${path} needs either a string content or deleted: true.`);
    bytes += Buffer.byteLength(entry.content, "utf8");
    return { path, content: entry.content } as FileChange;
  });
  if (bytes > LIMITS.bytes) return bad(`A proposal may carry at most ${Math.floor(LIMITS.bytes / 1024)}KB of file content.`);

  const request: ProposeRequest = {
    cluster,
    base,
    title: title.trim(),
    findings: findings.map(readFinding),
    files: parsed,
  };
  const b = counts(before, "before");
  if (b !== undefined) request.before = b;
  const a = counts(after, "after");
  if (a !== undefined) request.after = a;
  return request;
}

// ── what the round is allowed to do ────────────────────────────────────────

export interface RoundState {
  repo: string;
  defaultBranch: string;
  /** The head of the default branch right now — what a fix should be based on. */
  head: string;
  policy: Policy;
  /**
   * Every rounds pull request this repository has ever had, with the cluster
   * it belongs to and whether a `rounds:reconsider` label takes its decline
   * back — so the round reconciles against the same answer the server will
   * enforce, rather than working it out from labels itself.
   */
  pulls: Array<PullSummary & { cluster: string | null; reconsider: boolean }>;
  openPrs: number;
  /** How many more this repository will accept before the cap bites. */
  capacity: number;
}

/**
 * Everything a round needs to know before it decides anything: where HEAD is,
 * what the repository's policy says, and what it has already proposed here.
 *
 * Read with a read-only token, deliberately — nothing on this path needs more,
 * and the agent calls it far more often than it proposes. Read, but not the
 * same read the agent gets: listing pull requests needs `pull_requests: read`
 * on top of what a clone takes, and this token stays here.
 */
export async function roundState(app: AppConfig, repo: string, deps: Deps = {}): Promise<RoundState> {
  const { token } = await installationToken(app, repo, deps, READ_STATE);
  const [info, pulls] = await Promise.all([repoInfo(token, repo, deps), listPullsWithPrefix(token, repo, BRANCH_PREFIX, deps)]);
  const [head, policyFile] = await Promise.all([
    readRef(token, repo, info.defaultBranch, deps),
    readFile(token, repo, ".rounds.yml", info.defaultBranch, deps),
  ]);
  const policy = parsePolicy(policyFile);
  const openPrs = pulls.filter((p) => p.state === "open").length;
  return {
    repo,
    defaultBranch: info.defaultBranch,
    head,
    policy,
    pulls: pulls.map((p) => ({ ...p, cluster: clusterOfBranch(p.head), reconsider: reconsidered(p.labels) })),
    openPrs,
    capacity: Math.max(0, policy.maxOpenPrs - openPrs),
  };
}

async function readRef(token: string, repo: string, branch: string, deps: Deps): Promise<string> {
  const api = deps.api ?? "https://api.github.com";
  const res = await (deps.fetchImpl ?? fetch)(`${api}/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "rounds-doorman" },
  });
  const body = (await res.json()) as { object?: { sha?: string } };
  return body.object?.sha ?? "";
}

export interface Proposed {
  number: number;
  url: string;
  branch: string;
  commit: string;
}

/**
 * Check the proposal against the repository's own history and policy, then —
 * and only then — mint a write token and open the pull request.
 */
export async function propose(app: AppConfig, repo: string, request: ProposeRequest, deps: Deps = {}): Promise<Proposed> {
  const state = await roundState(app, repo, deps);
  if (!state.policy.enabled) {
    throw new Refused(`${repo} has rounds switched off in .rounds.yml.`, "disabled");
  }

  const branch = branchFor(request.cluster);
  const mine = state.pulls.filter((p) => p.head === branch);
  const open = mine.find((p) => p.state === "open");
  if (open) {
    throw new Refused(`A rounds pull request for ${request.cluster} is already open: #${open.number}.`, "already-open", 409, open.number);
  }
  // A closed-unmerged rounds pull request is a person saying no. It stays a no
  // — this is the check that makes the promise in the README true rather than
  // merely intended.
  //
  // Unless that same person labeled it `rounds:reconsider`, which is the one
  // way back. It forgives the pull request it is on and nothing else: a later
  // one closed unmerged carries no label, so it declines the cluster again.
  const declined = mine.find((p) => p.state === "closed" && !p.merged && !reconsidered(p.labels));
  if (declined) {
    throw new Refused(
      `#${declined.number} for ${request.cluster} was closed without merging — that cluster is declined.`,
      "declined",
      409,
      declined.number,
    );
  }
  if (state.capacity <= 0) {
    throw new Refused(`${repo} is at its cap of ${state.policy.maxOpenPrs} open rounds pull requests.`, "at-cap");
  }

  // Only now is a token that can write worth existing.
  const { token } = await installationToken(app, repo, deps, WRITE);
  const commit = await commitChanges(token, repo, { base: request.base, message: request.title, files: request.files }, deps);
  await putBranch(token, repo, branch, commit, deps);
  // The body is ours to render, from what the round reported it was fixing.
  const body = renderBody({
    file: request.findings[0]?.file ?? request.files[0]!.path,
    findings: request.findings,
    before: request.before,
    after: request.after,
  });
  const pr = await openPull(
    token,
    repo,
    { title: request.title, body: bodyWithMarker(body, request.cluster), head: branch, base: state.defaultBranch },
    deps,
  );
  return { ...pr, branch, commit };
}

/**
 * The marker is ours to write. A round that forgot it would be invisible to
 * every future round, which is how a bot ends up proposing the same fix every
 * Monday forever; one that wrote its own could claim a cluster it never
 * touched. So strip whatever came in and append the real one.
 */
export function bodyWithMarker(body: string, cluster: string): string {
  const cleaned = body
    .split("\n")
    .filter((line) => !line.includes(PR_MARKER))
    .join("\n")
    .trimEnd();
  return `${cleaned}\n\n${markerFor(cluster)}\n`;
}
