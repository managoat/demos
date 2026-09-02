/**
 * The signed-in person's store: who they are, their chats (hosted and
 * invited to), what the composer's menus are made of, and toasts. It talks to the
 * Salon server (src/lib/api.ts). Fountain itself is reached per chat through
 * the SDK at `/f/<chat>` (`makeChatClient`).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Fountain } from "@agentshit/fountain-sdk";
import type { ProjectDto } from "../shared/projects";
import { api, ApiError, chatFountainBase, type ChatDto, type Me, type MenuDto, type NotificationDto, type WorkspaceMemberDto } from "./lib/api";
import { describeError } from "./lib/errors";

/** How often the chat list is re-read while the tab is on screen. */
const SURVEY_MS = 30_000;

export interface Session {
  me: Me;
  setMe: (me: Me) => void;
  chats: ChatDto[];
  chatsLoaded: boolean;
  refreshChats: () => Promise<ChatDto[] | null>;
  menu: MenuDto | null;
  menuError: string | null;
  loadMenu: () => Promise<MenuDto | null>;
  projects: ProjectDto[];
  refreshProjects: () => Promise<ProjectDto[] | null>;
  workspace: WorkspaceMemberDto[];
  refreshWorkspace: () => Promise<WorkspaceMemberDto[] | null>;
  notifications: NotificationDto[];
  refreshNotifications: () => Promise<NotificationDto[] | null>;
  readNotification: (id: string) => Promise<void>;
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

export function SessionProvider({ me, onSignOut, initialError, children }: { me: Me; onSignOut: () => void; initialError?: string | null; children: ReactNode }) {
  const [currentMe, setMe] = useState(me);
  const [chats, setChats] = useState<ChatDto[]>([]);
  const [chatsLoaded, setChatsLoaded] = useState(false);
  const [menu, setMenu] = useState<MenuDto | null>(null);
  const [menuError, setMenuError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceMemberDto[]>([]);
  const [notifications, setNotifications] = useState<NotificationDto[]>([]);
  const [toasts, setToasts] = useState<Toast[]>(() => (initialError ? [{ id: Date.now(), text: initialError, kind: "error" }] : []));

  useEffect(() => {
    if (!initialError) return;
    const timer = window.setTimeout(() => setToasts([]), 6000);
    return () => window.clearTimeout(timer);
  }, []); // the callback error belongs to this one boot

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

  const refreshWorkspace = useCallback(async () => {
    try {
      const list = await api.workspace();
      setWorkspace(list);
      return list;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onSignOut();
      return null;
    }
  }, [onSignOut]);

  const refreshNotifications = useCallback(async () => {
    try {
      const list = await api.notifications();
      setNotifications(list);
      return list;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onSignOut();
      return null;
    }
  }, [onSignOut]);

  const readNotification = useCallback(async (id: string) => {
    setNotifications((items) => items.map((n) => (n.id === id ? { ...n, readAt: n.readAt ?? new Date().toISOString() } : n)));
    try {
      await api.readNotification(id);
    } catch (err) {
      toast(describeError(err), "error");
      void refreshNotifications();
    }
  }, [refreshNotifications, toast]);

  useEffect(() => {
    void refreshChats();
    void loadMenu();
    void refreshProjects();
    void refreshWorkspace();
    void refreshNotifications();
  }, [refreshChats, loadMenu, refreshProjects, refreshWorkspace, refreshNotifications]);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") void refreshChats();
      if (document.visibilityState === "visible") void refreshNotifications();
    };
    const timer = window.setInterval(tick, SURVEY_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refreshChats, refreshNotifications]);

  const signOut = useCallback(() => {
    void api.signOut().catch(() => undefined);
    onSignOut();
  }, [onSignOut]);

  const value = useMemo<Session>(
    () => ({ me: currentMe, setMe, chats, chatsLoaded, refreshChats, menu, menuError, loadMenu, projects, refreshProjects, workspace, refreshWorkspace, notifications, refreshNotifications, readNotification, toast, signOut }),
    [currentMe, chats, chatsLoaded, refreshChats, menu, menuError, loadMenu, projects, refreshProjects, workspace, refreshWorkspace, notifications, refreshNotifications, readNotification, toast, signOut],
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
