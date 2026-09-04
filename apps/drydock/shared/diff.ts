/**
 * Reading `git diff` output.
 *
 * Fountain's diff route returns **one string** — every changed file
 * concatenated, exactly as git printed it — so somebody has to split it back
 * up and count the lines. This is that somebody, and it is pure, out of any
 * component, and tested against literal git output rather than against a diff
 * written to suit the parser.
 *
 * That last part matters because the awkward cases are all real and all
 * quiet:
 *
 *   - a **rename** with no hunks at all, which a naive parser drops entirely
 *   - a **binary** file, which has no hunks either but is not a rename
 *   - `/dev/null` standing in for the side that does not exist, which is how
 *     an add and a delete are told apart
 *   - `\ No newline at end of file`, whose leading `\` is not a `+` or a `-`
 *     but sits inside a hunk where a naive counter is counting them
 *   - a hunk header (`@@`) and a `+++`/`---` header, which both start with a
 *     character the line counter cares about and must not be counted
 *
 * Ported from paddock's `src/lib/diff.ts`, where the same five cases were
 * found the hard way. Living in `shared/` rather than `src/` because the
 * server parses the diff once and serves the file list with it, so the browser
 * never re-parses on a render — but the types have to agree, and one
 * implementation is how they do.
 */
import type { DiffFile } from "./api";

/**
 * The per-file summary the Changes tab renders.
 *
 * Nothing here is the diff text itself. The panel lists files, and opening one
 * asks for its hunks — a repository-wide diff can be megabytes, and putting it
 * in a list response makes every poll of the badge count expensive.
 */
export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  if (!diff.trim()) return files;

  let current: DiffFile | null = null;
  let inHunk = false;

  const flush = () => {
    if (current) files.push(current);
    current = null;
    inHunk = false;
  };

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      current = { path: pathFromHeader(line), added: 0, removed: 0, status: "modified" };
      continue;
    }
    if (!current) continue;

    // The metadata block, before any hunk. `status` is decided here and never
    // by counting, because a rename with no content change has nothing to count.
    if (!inHunk) {
      if (line.startsWith("new file mode")) current.status = "added";
      else if (line.startsWith("deleted file mode")) current.status = "deleted";
      else if (line.startsWith("rename to ")) {
        current.status = "renamed";
        current.path = line.slice("rename to ".length).trim();
      } else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
        current.status = "binary";
      } else if (line.startsWith("+++ ")) {
        const to = line.slice(4).trim();
        if (to === "/dev/null") current.status = "deleted";
        else if (to.startsWith("b/")) current.path = to.slice(2);
      } else if (line.startsWith("--- ")) {
        if (line.slice(4).trim() === "/dev/null") current.status = "added";
      }
    }

    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;

    // Inside a hunk. `\ No newline at end of file` is the trap: it is not a
    // context line and it is not a change, and counting it makes a one-line
    // file look like a two-line one.
    if (line.startsWith("\\")) continue;
    if (line.startsWith("+")) current.added++;
    else if (line.startsWith("-")) current.removed++;
  }
  flush();
  return files;
}

/**
 * Split one file's hunks out of the whole diff.
 *
 * Used when somebody opens a file in the Changes list. Matching on the header
 * line rather than re-parsing means the text handed to the viewer is byte for
 * byte what git produced for that file, which is what makes a line number in
 * the viewer agree with a line number in the repository.
 */
export function diffFor(diff: string, path: string): string {
  const chunks = diff.split(/^(?=diff --git )/m);
  for (const chunk of chunks) {
    if (!chunk.startsWith("diff --git ")) continue;
    const header = chunk.slice(0, chunk.indexOf("\n"));
    if (pathFromHeader(header) === path) return chunk.trimEnd();
    // A rename names its destination further down, not in the header.
    const renamed = /^rename to (.+)$/m.exec(chunk);
    if (renamed && renamed[1]!.trim() === path) return chunk.trimEnd();
  }
  return "";
}

/** The letter `git status --short` would use, for a row in the file tree. */
export function changeLetter(status: DiffFile["status"]): string {
  return status === "added" ? "A" : status === "deleted" ? "D" : status === "renamed" ? "R" : "M";
}

/**
 * `diff --git a/x/y b/x/y` → `x/y`.
 *
 * Taken from the `b/` side because it is the destination, which is the name
 * the file has now. A path containing a space makes the two halves ambiguous
 * to split on whitespace, so this anchors on the ` b/` that separates them and
 * falls back to the last token when git quoted the name instead.
 */
function pathFromHeader(header: string): string {
  const rest = header.slice("diff --git ".length);
  const at = rest.lastIndexOf(" b/");
  if (at !== -1) return rest.slice(at + 3).trim();
  const token = rest.split(" ").pop() ?? "";
  return token.startsWith("b/") ? token.slice(2) : token;
}
