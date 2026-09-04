/**
 * Reading `git diff` output, as Fountain hands it over.
 *
 * `GET /api/sandboxes/:id/diff` returns one string: every changed file in the
 * repository, concatenated, exactly as git printed it. The panel used to show
 * that string in a `<pre>` and call it a feature, which meant the question
 * people actually have — *what changed?* — was answered by scrolling.
 *
 * So it gets parsed. Splitting the blob into one entry per file is the whole
 * of the Changes list, and numbering the lines inside a hunk is the whole of
 * the diff viewer. Both are pure, both are out here rather than inside the
 * component, and both are tested against output git really produces —
 * renames, new files, deletes, binaries, and the `\ No newline` marker that
 * every naive `+`/`-` counter gets wrong.
 */

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface FileChange {
  /** The path as it stands after the change; for a delete, the path removed. Relative to the repo root, as git prints it. */
  path: string;
  /** Where a rename came from. Null for everything else. */
  from: string | null;
  status: ChangeStatus;
  /** Git refused to diff it. There are no hunks to show and no counts to give. */
  binary: boolean;
  additions: number;
  deletions: number;
  /** This file's own section of the diff, header and hunks, verbatim. */
  body: string;
}

/**
 * Split a whole `git diff` into one entry per file.
 *
 * Returns `[]` for anything that does not start a file section — an empty
 * diff, or output from something that is not git. The caller shows the raw
 * text in that case rather than claiming nothing changed.
 */
export function splitDiff(diff: string): FileChange[] {
  const lines = diff.split("\n");
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) if (lines[i]!.startsWith("diff --git ")) starts.push(i);
  if (starts.length === 0) return [];

  return starts.map((start, n) => section(lines.slice(start, starts[n + 1] ?? lines.length)));
}

function section(lines: string[]): FileChange {
  // `diff --git a/x b/y` is the fallback pair: for a binary file or a pure
  // rename there are no `---`/`+++` lines to read the paths off.
  const named = /^diff --git a\/(.+) b\/(.+)$/.exec(lines[0] ?? "");
  let oldPath: string | null = named?.[1] ?? null;
  let newPath: string | null = named?.[2] ?? null;

  let status: ChangeStatus | null = null;
  let binary = false;
  let additions = 0;
  let deletions = 0;
  let inHunk = false;

  for (const line of lines.slice(1)) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (inHunk) {
      // Inside a hunk every line is content, including one that opens with
      // `+++`. `\ No newline at end of file` is git talking, not content.
      if (line.startsWith("\\")) continue;
      if (line.startsWith("+")) additions++;
      else if (line.startsWith("-")) deletions++;
      continue;
    }
    if (line.startsWith("new file mode")) status = "added";
    else if (line.startsWith("deleted file mode")) status = "deleted";
    else if (line.startsWith("rename from ")) {
      status = "renamed";
      oldPath = line.slice("rename from ".length);
    } else if (line.startsWith("rename to ")) {
      status = "renamed";
      newPath = line.slice("rename to ".length);
    } else if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) binary = true;
    else if (line.startsWith("--- ")) oldPath = header(line.slice(4));
    else if (line.startsWith("+++ ")) newPath = header(line.slice(4));
  }

  // `/dev/null` on either side settles it whatever the mode line said.
  if (status === null) status = oldPath === null ? "added" : newPath === null ? "deleted" : "modified";

  return {
    path: newPath ?? oldPath ?? "(unknown)",
    from: status === "renamed" && oldPath !== newPath ? oldPath : null,
    status,
    binary,
    additions,
    deletions,
    body: lines.join("\n"),
  };
}

/** `a/src/index.ts` → `src/index.ts`; `/dev/null` → null, which is how git says "there was no file". */
function header(rest: string): string | null {
  const path = rest.replace(/\t.*$/, "");
  if (path === "/dev/null") return null;
  return path.replace(/^[ab]\//, "");
}

export type DiffLineKind = "add" | "del" | "context" | "hunk" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  /** Line number in the file before the change, where there is one. */
  old: number | null;
  /** Line number after. */
  new: number | null;
  text: string;
}

/**
 * Number the lines of one file's diff, the way a review tool does.
 *
 * The numbers come from the hunk headers — `@@ -12,7 +12,9 @@` — and advance
 * down each side independently: a `+` line moves only the new side, a `-` line
 * only the old, context moves both. Without them a diff of a long file tells
 * you what changed and refuses to say where.
 *
 * Safe on a whole multi-file diff as well as on one file's section, because a
 * `diff --git` line ends the hunk it follows. Without that the next file's
 * `--- a/x` header reads as a deleted line and the numbering runs away.
 */
export function diffLines(body: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;

  for (const text of body.replace(/\n$/, "").split("\n")) {
    const hunk = /^@@+ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (text.startsWith("diff --git ")) {
      inHunk = false;
      out.push({ kind: "meta", old: null, new: null, text });
    } else if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      out.push({ kind: "hunk", old: null, new: null, text });
    } else if (!inHunk || text.startsWith("\\")) {
      out.push({ kind: "meta", old: null, new: null, text });
    } else if (text.startsWith("+")) {
      out.push({ kind: "add", old: null, new: newNo++, text });
    } else if (text.startsWith("-")) {
      out.push({ kind: "del", old: oldNo++, new: null, text });
    } else {
      // A blank context line is " " in a proper diff and "" once something has
      // trimmed the trailing space. Both are context.
      out.push({ kind: "context", old: oldNo++, new: newNo++, text });
    }
  }
  return out;
}

/** `/home/sprite/work/t1` + `src/index.ts` → the absolute path the file routes want. */
export function absolutePath(repoRoot: string, relative: string): string {
  return `${repoRoot.replace(/\/+$/, "")}/${relative}`;
}

/** `A`, `M`, `D`, `R` — the letter `git status --short` uses, because everyone already reads it. */
export function statusLetter(status: ChangeStatus): string {
  return { added: "A", modified: "M", deleted: "D", renamed: "R" }[status];
}
