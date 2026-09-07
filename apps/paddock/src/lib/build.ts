/**
 * Which build this tab is running, and what to do when the server is not.
 *
 * A browser tab left open across a deploy keeps running the bundle it loaded,
 * and a bug fixed in the new one goes on running in the old — which is how a
 * client fix to the stream loop (paddock #67) left an already-open tab
 * spinning, faster than before, against production. Nobody finds those tabs.
 *
 * So the server stamps every response with its build id (`x-paddock-build`)
 * and writes the same id into the HTML it serves (`<meta name="paddock-build">`).
 * The bundle reads its own from the meta tag; every API answer is compared;
 * the first mismatch reloads the page. The meta tag rather than the first API
 * answer, because a deploy between the HTML and that first call would
 * otherwise teach an old bundle the new id and it would never reload.
 *
 * `null` means "not stamped" — the vite dev server serves no meta tag and the
 * mock server sends no header — and a tab that does not know its build never
 * reloads over it.
 */

export const BUILD_HEADER = "x-paddock-build";

let mine: string | null | undefined;
let reloading = false;

/** The build id the HTML was served with, or null when it carries none. */
export function myBuild(): string | null {
  if (mine === undefined) {
    mine = typeof document === "undefined" ? null : (document.querySelector('meta[name="paddock-build"]')?.getAttribute("content") ?? null);
  }
  return mine;
}

/**
 * The server said which build it is. Reload if it is not ours.
 *
 * Idempotent: the first mismatch schedules exactly one reload, and everything
 * after it — the answers still landing from calls already in flight — is
 * ignored.
 */
export function noteServerBuild(theirs: string | null, reload: () => void = () => window.location.reload()): boolean {
  const ours = myBuild();
  if (!ours || !theirs || theirs === ours || reloading) return false;
  reloading = true;
  reload();
  return true;
}

/** Headers to send so the server knows which build is asking. */
export function buildHeaders(): Record<string, string> {
  const ours = myBuild();
  return ours ? { [BUILD_HEADER]: ours } : {};
}

/** For tests. */
export function resetBuild(): void {
  mine = undefined;
  reloading = false;
}
