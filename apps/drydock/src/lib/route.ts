/**
 * Where you are, in the URL.
 *
 * The hash rather than the path, and rather than a router library. Three
 * reasons, in order of how much they matter:
 *
 *   - **A thread deserves a link.** Somebody working in two threads at once
 *     wants two tabs, and somebody reporting a problem wants to paste where
 *     they were. State in React alone gives neither.
 *   - **The hash needs no server.** A path-based route means every unknown
 *     path has to fall through to `index.html`, which the server does do —
 *     but it also means the dev proxy and the static handler have to agree
 *     about which paths are the app's and which are the API's, forever.
 *   - **It is twelve lines.** A router library would be the app's largest
 *     dependency, for one nested route.
 */

export type Route = { at: "home" } | { at: "project"; projectId: string } | { at: "thread"; projectId: string; threadId: string };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "p" && parts[1]) {
    if (parts[2] === "t" && parts[3]) return { at: "thread", projectId: parts[1], threadId: parts[3] };
    return { at: "project", projectId: parts[1] };
  }
  return { at: "home" };
}

export function hrefFor(route: Route): string {
  if (route.at === "thread") return `#/p/${route.projectId}/t/${route.threadId}`;
  if (route.at === "project") return `#/p/${route.projectId}`;
  return "#/";
}

export function go(route: Route): void {
  location.hash = hrefFor(route);
}
