/**
 * Hash routes, so the app works from any static host with no rewrite rules:
 *
 *   #/                     projects
 *   #/team                 members (agent + environment + vault presets)
 *   #/p/:project           one project's work items
 *   #/p/:project/w/:item   one work item: members, conversations
 *   #/p/:project/w/:item/c/:conversation   …with a conversation open
 */
import { useEffect, useState } from "react";

export type Route =
  | { page: "projects" }
  | { page: "team" }
  | { page: "project"; projectId: string }
  | { page: "item"; projectId: string; itemId: string; conversationId: string | null };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "").replace(/^\/+/, "").split("?")[0] ?? "";
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "team") return { page: "team" };
  if (parts[0] === "p" && parts[1]) {
    if (parts[2] === "w" && parts[3]) {
      return { page: "item", projectId: parts[1], itemId: parts[3], conversationId: parts[4] === "c" && parts[5] ? parts[5] : null };
    }
    return { page: "project", projectId: parts[1] };
  }
  return { page: "projects" };
}

export const href = {
  projects: () => "#/",
  team: () => "#/team",
  project: (projectId: string) => `#/p/${projectId}`,
  item: (projectId: string, itemId: string) => `#/p/${projectId}/w/${itemId}`,
  conversation: (projectId: string, itemId: string, conversationId: string) => `#/p/${projectId}/w/${itemId}/c/${conversationId}`,
};

export function navigate(to: string): void {
  window.location.hash = to;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}
