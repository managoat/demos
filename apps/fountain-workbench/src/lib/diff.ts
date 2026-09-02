/**
 * Two git outputs, parsed for the Changes view (components/Changes.tsx):
 * a unified diff, as `GET /api/sandboxes/:id/diff` returns it, and
 * `git status --porcelain=v2 --branch`, as the hook in the sandbox posts it.
 * Pure functions; nothing here touches the network or the DOM.
 */

export type LineKind = "context" | "add" | "del" | "meta";

export interface DiffLine {
  kind: LineKind;
  /** The line without its leading marker. */
  text: string;
  /** Line numbers on each side; null on the side the line is not on. */
  old: number | null;
  new: number | null;
}

export interface DiffHunk {
  /** `@@ -a,b +c,d @@ context` as written. */
  header: string;
  lines: DiffLine[];
}

export type FileStatus = "modified" | "added" | "deleted" | "renamed" | "binary";

export interface DiffFile {
  /** The path to show: the new one, or the old one for a deletion. */
  path: string;
  oldPath: string | null;
  newPath: string | null;
  status: FileStatus;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

const FILE_HEADER = /^diff --git a\/(.*) b\/(.*)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** A unified diff into files, hunks and numbered lines. Tolerant: anything it does not recognise is kept as a `meta` line. */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const raw of text.split("\n")) {
    const m = FILE_HEADER.exec(raw);
    if (m) {
      file = { path: m[2]!, oldPath: m[1]!, newPath: m[2]!, status: "modified", hunks: [], additions: 0, deletions: 0 };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (!hunk || raw.startsWith("@@")) {
      // Between the file header and the first hunk: the extended headers.
      if (raw.startsWith("new file mode")) file.status = "added";
      else if (raw.startsWith("deleted file mode")) file.status = "deleted";
      else if (raw.startsWith("rename from ") || raw.startsWith("rename to ")) file.status = "renamed";
      else if (raw.startsWith("Binary files")) file.status = "binary";
      else if (raw.startsWith("--- ")) {
        const p = raw.slice(4);
        file.oldPath = p === "/dev/null" ? null : p.replace(/^a\//, "");
        if (!file.oldPath) file.status = "added";
      } else if (raw.startsWith("+++ ")) {
        const p = raw.slice(4);
        file.newPath = p === "/dev/null" ? null : p.replace(/^b\//, "");
        if (!file.newPath) file.status = "deleted";
        file.path = file.newPath ?? file.oldPath ?? file.path;
      }
      const h = HUNK_HEADER.exec(raw);
      if (h) {
        oldNo = Number(h[1]);
        newNo = Number(h[3]);
        hunk = { header: raw, lines: [] };
        file.hunks.push(hunk);
      }
      continue;
    }
    if (raw === "") {
      // A trailing newline at the end of the diff, or an empty context line
      // (git writes those as a single space; a bare empty line is the end).
      continue;
    }
    const marker = raw[0];
    const body = raw.slice(1);
    if (marker === "+") {
      hunk.lines.push({ kind: "add", text: body, old: null, new: newNo++ });
      file.additions++;
    } else if (marker === "-") {
      hunk.lines.push({ kind: "del", text: body, old: oldNo++, new: null });
      file.deletions++;
    } else if (marker === " ") {
      hunk.lines.push({ kind: "context", text: body, old: oldNo++, new: newNo++ });
    } else if (marker === "\\") {
      hunk.lines.push({ kind: "meta", text: raw, old: null, new: null });
    } else {
      hunk.lines.push({ kind: "meta", text: raw, old: null, new: null });
    }
  }
  return files;
}

export type EntryKind = "modified" | "added" | "deleted" | "renamed" | "copied" | "typechange" | "untracked" | "ignored" | "unmerged";

export interface StatusEntry {
  path: string;
  /** For a rename or copy: where it came from. */
  origPath: string | null;
  kind: EntryKind;
  /** The change is in the index. */
  staged: boolean;
  /** The change is in the working tree. */
  unstaged: boolean;
}

export interface GitStatus {
  /** HEAD's sha, or null on an unborn branch. */
  oid: string | null;
  /** The branch name, or `(detached)`. */
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  entries: StatusEntry[];
}

const KINDS: Record<string, EntryKind> = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", T: "typechange" };

function kindOf(xy: string): EntryKind {
  // X is the index, Y the working tree; `.` is unchanged. The one that moved names the kind.
  const x = xy[0] ?? ".";
  const y = xy[1] ?? ".";
  return KINDS[x !== "." ? x : y] ?? "modified";
}

/** `git status --porcelain=v2 --branch` into a header and entries. Tolerant of lines it does not know. */
export function parseStatus(text: string): GitStatus {
  const out: GitStatus = { oid: null, head: null, upstream: null, ahead: 0, behind: 0, entries: [] };
  for (const raw of text.split("\n")) {
    if (!raw) continue;
    if (raw.startsWith("# branch.oid ")) {
      const v = raw.slice(13).trim();
      out.oid = v === "(initial)" ? null : v;
    } else if (raw.startsWith("# branch.head ")) out.head = raw.slice(14).trim();
    else if (raw.startsWith("# branch.upstream ")) out.upstream = raw.slice(18).trim();
    else if (raw.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(raw);
      if (m) {
        out.ahead = Number(m[1]);
        out.behind = Number(m[2]);
      }
    } else if (raw.startsWith("? ")) out.entries.push({ path: raw.slice(2), origPath: null, kind: "untracked", staged: false, unstaged: true });
    else if (raw.startsWith("! ")) out.entries.push({ path: raw.slice(2), origPath: null, kind: "ignored", staged: false, unstaged: false });
    else if (raw.startsWith("1 ")) {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const parts = raw.split(" ");
      const xy = parts[1] ?? "..";
      const path = parts.slice(8).join(" ");
      out.entries.push({ path, origPath: null, kind: kindOf(xy), staged: xy[0] !== ".", unstaged: xy[1] !== "." });
    } else if (raw.startsWith("2 ")) {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\t<origPath>
      const [head, orig] = raw.split("\t");
      const parts = (head ?? "").split(" ");
      const xy = parts[1] ?? "..";
      const path = parts.slice(9).join(" ");
      out.entries.push({ path, origPath: orig ?? null, kind: kindOf(xy), staged: xy[0] !== ".", unstaged: xy[1] !== "." });
    } else if (raw.startsWith("u ")) {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const parts = raw.split(" ");
      out.entries.push({ path: parts.slice(10).join(" "), origPath: null, kind: "unmerged", staged: true, unstaged: true });
    }
  }
  return out;
}

/** The last segment of a path, for a heading. */
export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
}
