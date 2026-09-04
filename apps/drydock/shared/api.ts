/**
 * The contract between the browser and the drydock server.
 *
 * Every one of these shapes is served from `/api/...`. Nothing here is a
 * Fountain shape: the browser has no Fountain key, no Fountain session and no
 * idea what an environment id is. It talks to this server, and this server
 * does the Fountain work. `fountain-types.ts` is the other side of that wall
 * and is imported only by `server/`.
 *
 * That wall is the app's one structural decision. Sign-in is GitHub, so a
 * person here has no Fountain account to spend — every machine runs on the
 * server's account, and everything the browser can ask for has to be a shape
 * this file names.
 */

// ── who is here ────────────────────────────────────────────────────────

export interface Viewer {
  /** GitHub numeric id, as a string. */
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  /** Whether this account has the GitHub App installed anywhere we can see. */
  hasInstallation: boolean;
}

/** `GET /api/session` — the whole of what the shell needs before it renders. */
export interface SessionInfo {
  viewer: Viewer | null;
  /** Where to send a browser to sign in. Absolute, at GitHub. */
  signInUrl: string;
  /** Where to send a browser to install or configure the App. Absolute, at GitHub. */
  installUrl: string;
  /** What this deployment can actually do — see `Capabilities`. */
  capabilities: Capabilities;
}

/**
 * What is switched on here, decided by the server's environment rather than by
 * a build flag.
 *
 * The UI reads this instead of guessing, because the honest answer differs per
 * deployment: a drydock with no Sprites token has no terminal, and a panel
 * that pretends otherwise is worse than one that says so. Every `false` here
 * has a designed empty state behind it, not a broken button.
 */
export interface Capabilities {
  /** A Sprites token is configured, so the terminal and the run panel are live. */
  exec: boolean;
  /** A GitHub App is configured, so repositories, PRs, issues and checks work. */
  github: boolean;
  /** A Fountain key is configured, so machines can be built at all. */
  fountain: boolean;
  /** Models this Fountain suggests, for the picker on the composer. */
  models: string[];
}

// ── repositories, from GitHub ──────────────────────────────────────────

export interface RepoRef {
  /** `owner/name`. */
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
  /** ISO 8601. What the picker sorts on: what you touched last is what you want. */
  pushedAt: string | null;
  language: string | null;
  /** The installation that can see it. */
  installationId: number;
}

export interface BranchRef {
  name: string;
  sha: string;
  isDefault: boolean;
}

export interface PullRef {
  number: number;
  title: string;
  author: string | null;
  headRef: string;
  baseRef: string;
  draft: boolean;
  updatedAt: string;
}

export interface IssueRef {
  number: number;
  title: string;
  author: string | null;
  labels: string[];
  updatedAt: string;
}

/** `GET /api/threads/:id/checks` — GitHub's view of this thread's branch. */
export interface CheckRun {
  name: string;
  status: "queued" | "in_progress" | "completed" | string;
  conclusion: "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required" | string | null;
  url: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ChecksReport {
  ref: string;
  sha: string | null;
  /** False when the branch has never been pushed — which is not a failure. */
  pushed: boolean;
  runs: CheckRun[];
  /** An open pull request for this branch, if there is one. */
  pull: (PullRef & { url?: string }) | null;
}

// ── projects ───────────────────────────────────────────────────────────

/**
 * A project is a configuration, not a machine.
 *
 * Three Fountain records — one agent, one environment, one vault — written
 * once when the project is made and never replaced. Every thread in the
 * project runs on those same three, so every thread gets the same repository,
 * the same packages, the same setup script and the same secrets. What each
 * thread does *not* share is the disk: see `Thread`.
 *
 * The ids never moving is the whole of the promise. Change one and every
 * machine built from it is a different machine.
 */
export interface Project {
  id: string;
  name: string;
  /** `owner/name`, or null for a project with no repository. */
  repo: string | null;
  repoPrivate: boolean;
  defaultBranch: string | null;
  /** Where the clone lands on every machine: `/workspace/<name>`. */
  repoPath: string | null;
  runtime: string;
  model: string;
  /** Bumped whenever settings change; carried in each thread's `channel_id`. */
  rev: number;
  createdAt: string;
  /** The GitHub login of whoever made it. */
  ownerLogin: string;
  /** How many threads are open on it. The sidebar's badge. */
  openThreads: number;
}

/** What a project's settings panel edits. Every field is a mutation in place. */
export interface ProjectSettings {
  name: string;
  setupScript: string;
  /** `{"apt": ["ripgrep"], "npm": ["typescript"]}` — keyed by manager, never a flat list. */
  packages: Record<string, string[]>;
  /** Environment secrets: keys only. Values are write-only, at Fountain. */
  envKeys: string[];
  vaultKeys: string[];
  model: string;
  /** Appended to the agent's system prompt. */
  instructions: string;
}

// ── threads ────────────────────────────────────────────────────────────

/**
 * A thread is a conversation and the machine it is the only occupant of.
 *
 * `sandbox_mode: "ephemeral"`, so Fountain builds one machine for this
 * conversation out of the project's environment and reclaims it when the
 * conversation ends. Two threads in a project therefore agree about every
 * setting and about nothing else: separate disks, separate branches, separate
 * installs, separate mess. That is the strongest isolation Fountain offers,
 * and it is what makes running four of them at once reasonable.
 *
 * It is also the trade, and the UI says so where it costs something: a thread
 * is a fresh clone, so the first minute is spent building one, and anything
 * you leave on the disk goes when the thread does. What survives is what you
 * pushed.
 */
export interface Thread {
  id: string;
  projectId: string;
  /** The conversation on Fountain. Null only in the instant between the two. */
  conversationId: string | null;
  slug: string;
  title: string;
  branch: string | null;
  /** The machine's working directory — the clone, or `/home/sprite` without one. */
  workdir: string;
  origin: ThreadOrigin;
  status: ThreadStatus;
  /** True when the thread opened before the project's current settings revision. */
  stale: boolean;
  machine: MachineState;
  /** Set once the opening turn reports back; null while it is still cutting. */
  openedAt: string | null;
  lastActiveAt: string | null;
  turnCount: number;
  unread: boolean;
  createdAt: string;
  createdByLogin: string;
}

/**
 * The five states a thread is legibly in.
 *
 * `building` is separate from `running` on purpose: both are "wait", but only
 * one of them is the agent's fault if it takes four minutes, and a person
 * watching a fresh clone of a large repository deserves to be told which one
 * they are looking at.
 */
export type ThreadStatus = "building" | "ready" | "running" | "failed" | "closed";

export interface ThreadOrigin {
  kind: "branch" | "pr" | "issue" | "blank";
  base: string | null;
  number: number | null;
  title: string | null;
  /** GitHub URL for a PR or issue origin. */
  url: string | null;
}

export interface MachineState {
  sandboxId: string | null;
  status: "none" | "pending" | "starting" | "ready" | "suspended" | "terminated" | "failed";
  /** Only when the server holds a Sprites token and the sandbox named one. */
  spriteName: string | null;
}

/**
 * The card above a new thread's transcript — the four lines Conductor prints
 * when it makes you a copy of a repository.
 *
 * Every field is null until the machine has actually said so. Nothing here is
 * predicted from what was asked for, because the entire value of the card is
 * that it reports rather than reassures.
 */
export interface ThreadHeader {
  /** "You're in a new copy of fountain called kyoto". */
  copyOf: string | null;
  /** "Branched jhgaylor/kyoto from origin/main". */
  branchedFrom: { branch: string; base: string; sha: string | null } | null;
  /** "Created /workspace/fountain and copied 1480 files". */
  created: { dir: string; files: number | null } | null;
  /** Whether this project has a setup script yet — the "Optional:" line. */
  hasSetupScript: boolean;
  /** The chips under an empty transcript. */
  starters: { label: string; prompt: string }[];
}

// ── the machine's own surfaces ─────────────────────────────────────────

export interface FileEntry {
  name: string;
  type: "file" | "directory" | "symlink" | "other" | string;
  size: number | null;
  /** `M`, `A`, `D`, `R`, `?` where git has an opinion about this path. */
  change: string | null;
}

export interface FileListing {
  path: string;
  entries: FileEntry[];
  truncated: boolean;
}

export interface FileContent {
  path: string;
  size: number;
  truncated: boolean;
  encoding: string;
  content: string;
}

export interface DiffReport {
  path: string;
  diff: string;
  truncated: boolean;
  /** Parsed once, on the server, so the panel does not re-parse on every render. */
  files: DiffFile[];
}

export interface DiffFile {
  path: string;
  added: number;
  removed: number;
  status: "added" | "modified" | "deleted" | "renamed" | "binary";
}

// ── running things out of band ─────────────────────────────────────────

/**
 * One command on the machine, over Sprites rather than over Fountain.
 *
 * These are not turns. They do not appear in the transcript, they do not wait
 * for the agent's lock, and they cost nothing — which is the point: you can
 * look around while the agent is working. The cost is that the machine has no
 * record of them either.
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  /** Where the shell ended up, so the next command starts there. */
  cwd: string;
  timedOut: boolean;
  durationMs: number;
}

/** A saved command on the Run tab. Project-level, because a build command is. */
export interface RunCommand {
  id: string;
  label: string;
  command: string;
}

// ── streams ────────────────────────────────────────────────────────────

/** What `GET /api/projects/:id/stream` pushes beside the transcript's own events. */
export type ProjectEvent =
  | { event: "threads"; data: { projectId: string } }
  | { event: "thread"; data: Thread }
  | { event: "settings"; data: { rev: number } };

// ── errors ─────────────────────────────────────────────────────────────

export interface ApiErrorBody {
  error: string;
  message: string;
  [k: string]: unknown;
}
