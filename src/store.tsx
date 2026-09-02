/**
 * The signed-in person's store: who they are, their chats (hosted and
 * invited to), what the composer's menus are made of, and toasts. It talks to the
 * Salon server (src/lib/api.ts). Fountain itself is reached per chat through
 * the SDK at `/f/<chat>` (`makeChatClient`).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Fountain } from "@agentshit/fountain-sdk";
import type { ProjectDto } from "../shared/projects";
import { api, ApiError, chatFountainBase, type ChatDto, type Me, type MenuDto } from "./lib/api";
import { describeError } from "./lib/errors";

/** How often the chat list is re-read while the tab is on screen. */
const SURVEY_MS = 30_000;

export interface Session {
  me: Me;
  chats: ChatDto[];
  chatsLoaded: boolean;
  refreshChats: () => Promise<ChatDto[] | null>;
  menu: MenuDto | null;
  menuError: string | null;
  loadMenu: () => Promise<MenuDto | null>;
  projects: ProjectDto[];
  refreshProjects: () => Promise<ProjectDto[] | null>;
  toast: (text: string, kind?: "info" | "error") => void;
  signOut: () => void;
}

const Ctx = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSession outside SessionProvider");
  return s;
}

interface Toast {
  id: number;
  text: string;
  kind: "info" | "error";
}

export function SessionProvider({ me, onSignOut, children }: { me: Me; onSignOut: () => void; children: ReactNode }) {
  const [chats, setChats] = useState<ChatDto[]>([]);
  const [chatsLoaded, setChatsLoaded] = useState(false);
  const [menu, setMenu] = useState<MenuDto | null>(null);
  const [menuError, setMenuError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((text: string, kind: Toast["kind"] = "info") => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts, { id, text, kind }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 6000);
  }, []);

  const refreshChats = useCallback(async () => {
    try {
      const list = await api.chats();
      setChats(list);
      setChatsLoaded(true);
      return list;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onSignOut();
      else toast(describeError(err), "error");
      return null;
    }
  }, [onSignOut, toast]);

  const loadMenu = useCallback(async () => {
    try {
      const m = await api.menu();
      setMenu(m);
      setMenuError(null);
      return m;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onSignOut();
      setMenuError(describeError(err));
      return null;
    }
  }, [onSignOut]);

  const refreshProjects = useCallback(async () => {
    try {
      const list = await api.projects();
      setProjects(list);
      return list;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onSignOut();
      return null;
    }
  }, [onSignOut]);

  useEffect(() => {
    void refreshChats();
    void loadMenu();
    void refreshProjects();
  }, [refreshChats, loadMenu, refreshProjects]);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") void refreshChats();
    };
    const timer = window.setInterval(tick, SURVEY_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refreshChats]);

  const signOut = useCallback(() => {
    void api.signOut().catch(() => undefined);
    onSignOut();
  }, [onSignOut]);

  const value = useMemo<Session>(
    () => ({ me, chats, chatsLoaded, refreshChats, menu, menuError, loadMenu, projects, refreshProjects, toast, signOut }),
    [me, chats, chatsLoaded, refreshChats, menu, menuError, loadMenu, projects, refreshProjects, toast, signOut],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

/** An SDK client for one chat. The bearer is a placeholder: the server authenticates the cookie and swaps in the host's key. */
export function makeChatClient(chatId: string): Fountain {
  return new Fountain({ baseUrl: chatFountainBase(chatId), apiKey: "session", appUrl: "", timeoutMs: 120_000 });
}
