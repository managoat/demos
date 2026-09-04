/**
 * Reading a directory listing, as Fountain actually sends one.
 *
 * Pure, and out here rather than inside the tree component, because the one
 * thing that went wrong was a *value* — this app decided a directory was
 * `"dir"` and Fountain has always said `"directory"`. On a real machine every
 * folder rendered as a file, and clicking one asked Fountain to read a
 * directory as bytes, which it refused with "path is a directory; list it with
 * /files". The mock said `"dir"` too, so nothing local ever disagreed.
 *
 * The vocabulary is `file | directory | symlink | other`; the same union has
 * been in `apps/salon/shared/files.ts` since salon shipped.
 */
import type { SandboxEntry } from "../api/types";

export function isDir(entry: Pick<SandboxEntry, "type">): boolean {
  return entry.type === "directory";
}

/**
 * Whether clicking it should try to read bytes. A symlink is offered because
 * it usually points at a file; when it does not, Fountain says so and the
 * panel shows that rather than pretending. `other` — a socket, a device — is
 * not offered at all.
 */
export function isOpenable(entry: Pick<SandboxEntry, "type">): boolean {
  return entry.type === "file" || entry.type === "symlink";
}

/** Directories first, then everything else, each alphabetical: the order every editor uses. */
export function sortEntries(entries: readonly SandboxEntry[]): SandboxEntry[] {
  return [...entries].sort((a, b) => {
    if (isDir(a) !== isDir(b)) return isDir(a) ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** `/home/sprite/work/t1` + `src` → `/home/sprite/work/t1/src`, without doubling the slash. */
export function childPath(parent: string, name: string): string {
  return `${parent.replace(/\/+$/, "")}/${name}`;
}
