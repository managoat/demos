/**
 * The repository's files, as the panel browses them: what Fountain's
 * read-only sandbox routes answer, passed through Salon on the host's key
 * to everyone in the chat (server/files.ts). A path is relative to the
 * repository's root in the computer; the server keeps it there.
 */

export interface DirEntry {
  name: string;
  type: "file" | "directory" | "symlink" | "other";
  /** Bytes, for a file; null otherwise. */
  size: number | null;
}

export interface DirListing {
  /** Relative to the repository root; "" is the root. */
  path: string;
  entries: DirEntry[];
  /** More than the listing could carry. */
  truncated: boolean;
}

export interface FileContents {
  path: string;
  /** The whole file, in bytes. */
  size: number;
  /** `content` stops before the end. */
  truncated: boolean;
  /** The text itself, or base64 when the bytes are not text. */
  encoding: "utf-8" | "base64";
  content: string;
}

/** How much of a file the panel asks for: plenty for source, not a build artefact. */
export const FILE_MAX_BYTES = 262_144;

/** The path's segments for a breadcrumb: "" → [], "a/b" → ["a", "b"]. */
export function segments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/** `a/b` + `c` → `a/b/c`; the root plus a name is the name. */
export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** The directory a path is in: "a/b/c" → "a/b", "a" → "". */
export function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/**
 * A path as the browser may ask for one: relative, normalised, and never
 * above the root. Null for one that tries. Kept here so the panel can
 * refuse before asking and the server can refuse regardless.
 */
export function cleanPath(input: unknown): string | null {
  if (typeof input !== "string") return null;
  if (input.includes("\0") || input.length > 4096) return null;
  const out: string[] = [];
  for (const seg of input.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join("/");
}
