/**
 * Hash routes, so the app works from any static host with no rewrite rules:
 *
 *   #/                          all projects (import, recover, new)
 *   #/p/:project                the project's work items
 *   #/p/:project/w/:item        one work item: notes, teammates, its conversations
 *   #/p/:project/c/:conv        one conversation, open
 *   #/p/:project/w/:item/c/:conv  …the older form of the same, still honoured
 *   #/p/:project/team           the team: the owner's agents
 *   #/p/:project/people         sharing and settings
 */
import { useEffect, useState } from "react";

export type Route =
  | { page: "projects" }
  | { page: "project"; projectId: string }
  | { page: "item"; projectId: string; itemId: string }
  | { page: "conversation"; projectId: string; conversationId: string }
  | { page: "team"; projectId: string }
  | { page: "people"; projectId: string };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "").replace(/^\/+/, "").split("?")[0] ?? "";
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "p" && parts[1]) {
    const projectId = parts[1];
    if (parts[2] === "w" && parts[3]) {
      if (parts[4] === "c" && parts[5]) return { page: "conversation", projectId, conversationId: parts[5] };
      return { page: "item", projectId, itemId: parts[3] };
    }
    if (parts[2] === "c" && parts[3]) return { page: "conversation", projectId, conversationId: parts[3] };
    if (parts[2] === "team") return { page: "team", projectId };
    if (parts[2] === "people") return { page: "people", projectId };
    return { page: "project", projectId };
  }
  return { page: "projects" };
}

export const href = {
  projects: () => "#/",
  project: (projectId: string) => `#/p/${projectId}`,
  team: (projectId: string) => `#/p/${projectId}/team`,
  people: (projectId: string) => `#/p/${projectId}/people`,
  item: (projectId: string, itemId: string) => `#/p/${projectId}/w/${itemId}`,
  conversation: (projectId: string, conversationId: string) => `#/p/${projectId}/c/${conversationId}`,
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
