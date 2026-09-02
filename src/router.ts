/** Hash routes: `#/`, `#/c/<chat>`, `#/join/<token>`. */
import { useEffect, useState } from "react";

export type Route = { page: "home" } | { page: "chat"; id: string } | { page: "join"; token: string } | { page: "preferences" };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "").replace(/^\/+/, "");
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "c" && parts[1]) return { page: "chat", id: decodeURIComponent(parts[1]) };
  if (parts[0] === "join" && parts[1]) return { page: "join", token: decodeURIComponent(parts[1]) };
  if (parts[0] === "preferences") return { page: "preferences" };
  return { page: "home" };
}

export function hashFor(r: Route): string {
  switch (r.page) {
    case "home":
      return "#/";
    case "chat":
      return `#/c/${encodeURIComponent(r.id)}`;
    case "join":
      return `#/join/${encodeURIComponent(r.token)}`;
    case "preferences":
      return "#/preferences";
  }
}

export function navigate(r: Route): void {
  window.location.hash = hashFor(r);
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
