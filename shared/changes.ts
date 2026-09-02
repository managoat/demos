/**
 * Changes: what the chat's computer has done to the repository, as a record
 * of Salon's own — the branch, the head, `git status`, and one unified diff
 * against the base branch — shown beside the transcript to everyone in the
 * chat.
 *
 * Where a snapshot comes from is the server's business (server/changes.ts):
 * today a hook inside the computer posts one at the start of a session, after
 * each edit and at the end of every turn; a sandbox exec API would be a second
 * source of the same record. This file is the wire shape and the two parsers —
 * `git status --porcelain` and a unified diff — shared so the server can count
 * what changed and the browser can draw it without asking again.
 */

/** What the hook (or any source) hands the server. Everything but `diff` is small. */
export interface ChangesSnapshot {
  branch: string;
  /** The head commit's sha. */
  head: string;
  /** The branch the diff is against, as the project names it: "main". */
  base: string;
  /** `git status --porcelain=v1`. */
  status: string;
  /** A unified diff of the working tree against the merge base, untracked files as additions. */
  diff: string;
  /** Why the snapshot was taken: a session starting, a tool finishing, a turn ending. */
  reason: "session" | "tool" | "stop" | "manual";
  /** The pull request for the branch, when `gh` knows one. */
  pr: PullRequest | null;
}

export interface PullRequest {
  url: string;
  /** GitHub's word: OPEN, MERGED, CLOSED. */
  state: string;
  mergeable?: string | null;
}

export type FileStatus = "added" | "deleted" | "modified" | "renamed";

/** One line of the file list: enough to draw it without the diff. */
export interface FileSummary {
  path: string;
  oldPath: string | null;
  status: FileStatus;
  binary: boolean;
  additions: number;
  deletions: number;
}

/** The record the server keeps and serves. */
export interface ChangesDto {
  chatId: string;
  /** Grows with each snapshot; a browser keeps the highest it has seen. */
  seq: number;
  branch: string;
  head: string;
  base: string;
  status: string;
  files: FileSummary[];
  diff: string;
  /** True when the diff was cut to fit; `files` counts what survived. */
  truncated: boolean;
  pr: PullRequest | null;
  /** How the snapshot reached the server. */
  source: "hook" | "exec";
  reason: ChangesSnapshot["reason"];
  at: string;
}

/** A diff longer than this is cut, and the record says so. Comfortable for a review; not a place to keep a build. */
export const DIFF_MAX_CHARS = 1_000_000;

export const CHANGE_REASONS: readonly ChangesSnapshot["reason"][] = ["session", "tool", "stop", "manual"];

/** The snapshot a request carried, or the sentence that says why not. */
export function parseSnapshot(v: unknown): ChangesSnapshot | string {
  if (!v || typeof v !== "object") return "A snapshot is required.";
  const r = v as Record<string, unknown>;
  const s = (k: string, max: number) => (typeof r[k] === "string" ? (r[k] as string).slice(0, max) : "");
  const branch = s("branch", 200).trim();
  const head = s("head", 64).trim();
  const base = s("base", 200).trim();
  if (!branch && !head) return "Say which branch, or which commit.";
  if (!base) return "Say which branch the diff is against (`base`).";
  const reason = (CHANGE_REASONS as readonly string[]).includes(r.reason as string) ? (r.reason as ChangesSnapshot["reason"]) : "manual";
  let pr: PullRequest | null = null;
  if (r.pr && typeof r.pr === "object") {
    const p = r.pr as Record<string, unknown>;
    if (typeof p.url === "string" && p.url.startsWith("https://")) {
      pr = { url: p.url.slice(0, 500), state: typeof p.state === "string" ? p.state.slice(0, 20) : "OPEN", mergeable: typeof p.mergeable === "string" ? p.mergeable.slice(0, 20) : null };
    }
  }
  return { branch, head, base, status: s("status", 200_000), diff: s("diff", DIFF_MAX_CHARS + 1), reason, pr };
}

// ── git status --porcelain=v1 ────────────────────────────────────────────

export interface StatusEntry {
  /** The two-letter code as git prints it: " M", "A ", "??", "R ". */
  code: string;
  path: string;
  oldPath: string | null;
}

export function parseStatus(porcelain: string): StatusEntry[] {
  const out: StatusEntry[] = [];
  for (const raw of porcelain.split("\n")) {
    if (raw.length < 4) continue;
    const code = raw.slice(0, 2);
    const rest = raw.slice(3);
    const arrow = code.startsWith("R") || code.startsWith("C") ? rest.indexOf(" -> ") : -1;
    if (arrow >= 0) out.push({ code, path: rest.slice(arrow + 4), oldPath: rest.slice(0, arrow) });
    else out.push({ code, path: rest, oldPath: null });
  }
  return out;
}

// ── a unified diff ───────────────────────────────────────────────────────

export interface DiffLine {
  type: "context" | "add" | "del";
  text: string;
  /** Line numbers in the old and new file; null on the side the line is not in. */
  oldNo: number | null;
  newNo: number | null;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** What follows the second `@@`, usually the enclosing function. */
  heading: string;
  lines: DiffLine[];
}

export interface FileDiff extends FileSummary {
  hunks: Hunk[];
}

/**
 * Split one `git diff` into files. Tolerant: a header it does not know is
 * skipped, a hunk that runs short is kept as far as it went, and a diff cut
 * mid-line still parses up to the cut.
 */
export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  let hunk: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("diff --git ")) {
      cur = { path: gitPath(line), oldPath: null, status: "modified", binary: false, additions: 0, deletions: 0, hunks: [] };
      files.push(cur);
      hunk = null;
      continue;
    }
    if (!cur) continue;
    if (hunk === null || !isHunkBody(line)) {
      if (line.startsWith("@@ ")) {
        const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line);
        if (!m) continue;
        hunk = { oldStart: Number(m[1]), oldLines: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newLines: m[4] === undefined ? 1 : Number(m[4]), heading: m[5] ?? "", lines: [] };
        cur.hunks.push(hunk);
        oldNo = hunk.oldStart;
        newNo = hunk.newStart;
        continue;
      }
      if (line.startsWith("new file mode")) cur.status = "added";
      else if (line.startsWith("deleted file mode")) cur.status = "deleted";
      else if (line.startsWith("rename from ")) {
        cur.status = "renamed";
        cur.oldPath = line.slice("rename from ".length);
      } else if (line.startsWith("rename to ")) cur.path = line.slice("rename to ".length);
      else if (line.startsWith("Binary files")) cur.binary = true;
      else if (line.startsWith("--- ")) {
        const p = stripPrefix(line.slice(4));
        if (p === "/dev/null") cur.status = "added";
        else if (cur.status !== "renamed") cur.oldPath = p === cur.path ? null : p;
      } else if (line.startsWith("+++ ")) {
        const p = stripPrefix(line.slice(4));
        if (p === "/dev/null") cur.status = "deleted";
        else cur.path = p;
      }
      continue;
    }
    // Inside a hunk.
    if (line.startsWith("+")) {
      hunk.lines.push({ type: "add", text: line.slice(1), oldNo: null, newNo: newNo++ });
      cur.additions++;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ type: "del", text: line.slice(1), oldNo: oldNo++, newNo: null });
      cur.deletions++;
    } else if (line.startsWith(" ")) {
      hunk.lines.push({ type: "context", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    } else if (line === "") {
      // A blank context line git printed without its leading space (some git versions do); count it as context if the hunk still wants lines.
      if (hunk.lines.length < hunk.oldLines + hunk.newLines) hunk.lines.push({ type: "context", text: "", oldNo: oldNo++, newNo: newNo++ });
    }
    // "\ No newline at end of file" is dropped.
  }
  return files;
}

function isHunkBody(line: string): boolean {
  return line.startsWith("+") && !line.startsWith("+++ ") ? true : line.startsWith("-") && !line.startsWith("--- ") ? true : line.startsWith(" ") || line.startsWith("\\") || line === "";
}

/** `diff --git a/x b/y` → `y`, quoting aside. */
function gitPath(header: string): string {
  const rest = header.slice("diff --git ".length);
  // Paths with spaces are ambiguous here; `+++` / `rename to` fix it up. Take the b/ side by its prefix when it is plain.
  const b = rest.indexOf(" b/");
  if (b >= 0) return rest.slice(b + 3);
  const parts = rest.split(" ");
  return stripPrefix(parts[parts.length - 1] ?? "");
}

function stripPrefix(p: string): string {
  const s = p.split("\t")[0] ?? p;
  if (s === "/dev/null") return s;
  return s.startsWith("a/") || s.startsWith("b/") ? s.slice(2) : s;
}

/** The file list for a diff: the same parse, without the hunks. */
export function summarise(diff: string): FileSummary[] {
  return parseDiff(diff).map(({ hunks: _h, ...rest }) => rest);
}

/** "+12 −3 in 4 files", for a header. */
export function changesLine(files: readonly FileSummary[]): string {
  const add = files.reduce((n, f) => n + f.additions, 0);
  const del = files.reduce((n, f) => n + f.deletions, 0);
  const n = files.length;
  if (n === 0) return "No changes";
  return `+${add} −${del} in ${n} file${n === 1 ? "" : "s"}`;
}

/** "abc1234" from a sha, or the branch alone when there is none. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
