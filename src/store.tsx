/**
 * Two stores.
 *
 * `WorkbenchProvider` is the signed-in user's: who they are, their projects
 * (owned and shared with them), and toasts. It talks to the workbench
 * server (src/lib/api.ts).
 *
 * `ProjectProvider` is one project's: the project record and its items
 * (from the server), and Fountain as seen from inside the project — an SDK
 * client whose base URL is `/f/<project>`, where the server forwards to
 * Fountain on the owner's key and admits only this project's conversations.
 * Plus the conversation list, the agent/environment/vault catalogs, and one
 * SSE stream every open thread reads from; the server mixes `workbench`
 * events into that stream when another member changes something.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Fountain } from "@agentshit/fountain-sdk";
import type { Agent, Conversation, Environment, SandboxRecord, UserEvent, Vault } from "./types";
import { computersOf } from "./lib/sidebar";
import { api, ApiError, projectFountainBase, type Activity, type ItemDto, type Me, type ProjectDto } from "./lib/api";
import { startBody, type StartInput } from "./lib/start";
import { readSse } from "./lib/sse";
import { describeError } from "./lib/errors";

export type EventHandler = (ev: UserEvent) => void;

const THREAD_STREAMS = ["acp", "stdout", "stage"];
const LAST_PROJECT = "fountain-workbench.lastProject";

/** The project this browser was in last, to land there again. */
export function loadLastProject(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT);
  } catch {
    return null;
  }
}

// ── the user's store ───────────────────────────────────────────────────────

export interface Workbench {
  me: Me;
  projects: ProjectDto[];
  projectsLoaded: boolean;
  activity: Record<string, Activity>;
  refreshProjects: () => Promise<ProjectDto[] | null>;
  refreshActivity: () => Promise<void>;
  toast: (text: string, kind?: "info" | "error") => void;
  signOut: () => void;
}

const WorkbenchCtx = createContext<Workbench | null>(null);

export function useWorkbench(): Workbench {
  const w = useContext(WorkbenchCtx);
  if (!w) throw new Error("useWorkbench outside WorkbenchProvider");
  return w;
}

interface Toast {
  id: number;
  text: string;
  kind: "info" | "error";
}

export function WorkbenchProvider({ me, onSignOut, children }: { me: Me; onSignOut: () => void; children: ReactNode }) {
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [activity, setActivity] = useState<Record<string, Activity>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((text: string, kind: Toast["kind"] = "info") => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts, { id, text, kind }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 5000);
  }, []);

  const refreshProjects = useCallback(async () => {
    try {
      const list = await api.projects();
      setProjects(list);
      setProjectsLoaded(true);
      return list;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onSignOut();
      else toast(describeError(err), "error");
      return null;
    }
  }, [onSignOut, toast]);

  const refreshActivity = useCallback(async () => {
    try {
      setActivity(await api.activity());
    } catch {
      // decoration only
    }
  }, []);

  useEffect(() => {
    void refreshProjects();
    void refreshActivity();
  }, [refreshProjects, refreshActivity]);

  const signOut = useCallback(() => {
    void api.signOut().catch(() => undefined);
    onSignOut();
  }, [onSignOut]);

  const value = useMemo<Workbench>(
    () => ({ me, projects, projectsLoaded, activity, refreshProjects, refreshActivity, toast, signOut }),
    [me, projects, projectsLoaded, activity, refreshProjects, refreshActivity, toast, signOut],
  );

  return (
    <WorkbenchCtx.Provider value={value}>
      {children}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </WorkbenchCtx.Provider>
  );
}

// ── one project's store ────────────────────────────────────────────────────

export interface ProjectStore {
  project: ProjectDto;
  items: ItemDto[];
  isOwner: boolean;
  /** Fountain from inside this project: the owner's key, this project's conversations. */
  fountain: Fountain;
  conversations: Conversation[];
  /** Sandbox records for the project's live computers, by id — the list carries only `sandbox_id`. */
  sandboxes: Map<string, SandboxRecord>;
  agents: Map<string, Agent>;
  environments: Map<string, Environment>;
  vaults: Map<string, Vault>;
  resourcesLoaded: boolean;
  connected: boolean;
  error: string | null;
  refresh: () => Promise<Conversation[] | null>;
  refreshResources: () => Promise<void>;
  reload: () => Promise<void>;
  /** Events for one conversation, live. Returns the unsubscribe. */
  subscribe: (conversationId: string, handler: EventHandler) => () => void;
  toast: Workbench["toast"];
  // Mutations go to the server; the stream (or the returned record) brings the change back.
  updateProject: (patch: Partial<Pick<ProjectDto, "name" | "notes" | "environmentId" | "vaultId">>) => Promise<void>;
  addMember: (email: string) => Promise<void>;
  removeMember: (email: string) => Promise<void>;
  createItem: (title: string, notes?: string) => Promise<ItemDto | null>;
  updateItem: (id: string, patch: Partial<Pick<ItemDto, "title" | "notes" | "status" | "agentIds">>) => Promise<void>;
  removeItem: (id: string) => Promise<void>;
  addTeammate: (itemId: string, agentId: string) => Promise<void>;
  removeTeammate: (itemId: string, agentId: string) => Promise<void>;
  /**
   * Start a conversation on a work item — which is also how a teammate gets
   * onto one: the server puts them there. Throws on failure, so the caller
   * can say so where it asked.
   */
  startConversation: (input: StartInput) => Promise<Conversation>;
}

const ProjectCtx = createContext<ProjectStore | null>(null);

export function useProject(): ProjectStore {
  const s = useContext(ProjectCtx);
  if (!s) throw new Error("useProject outside ProjectProvider");
  return s;
}

/** The project store when inside one; null on the projects list. */
export function useProjectMaybe(): ProjectStore | null {
  return useContext(ProjectCtx);
}

export function makeProjectClient(projectId: string): Fountain {
  // The bearer is a placeholder: the server authenticates the session cookie and swaps in the owner's key.
  // Retiring a conversation waits for Fountain to tear the computer down, which can take longer than the SDK's 30 s default.
  return new Fountain({ baseUrl: projectFountainBase(projectId), apiKey: "session", appUrl: "", timeoutMs: 120_000 });
}

export function ProjectProvider({ projectId, children, fallback }: { projectId: string; children: ReactNode; fallback: (state: "loading" | "missing") => ReactNode }) {
  const { toast, refreshProjects, signOut } = useWorkbench();
  const fountain = useMemo(() => makeProjectClient(projectId), [projectId]);
  const [project, setProject] = useState<ProjectDto | null>(null);
  const [items, setItems] = useState<ItemDto[]>([]);
  const [missing, setMissing] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [sandboxes, setSandboxes] = useState<Map<string, SandboxRecord>>(new Map());
  const [agents, setAgents] = useState<Map<string, Agent>>(new Map());
  const [environments, setEnvironments] = useState<Map<string, Environment>>(new Map());
  const [vaults, setVaults] = useState<Map<string, Vault>>(new Map());
  const [resourcesLoaded, setResourcesLoaded] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handlers = useRef(new Map<string, Set<EventHandler>>());

  const reload = useCallback(async () => {
    try {
      const { project, items } = await api.project(projectId);
      setProject(project);
      setItems(items);
      setMissing(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setMissing(true);
      else if (err instanceof ApiError && err.status === 401) signOut();
      else toast(describeError(err), "error");
    }
  }, [projectId, toast, signOut]);

  const refresh = useCallback(async () => {
    try {
      const list = await fountain.conversations();
      setConversations(list);
      setError(null);
      return list;
    } catch (err) {
      setError(describeError(err));
      return null;
    }
  }, [fountain]);

  const refreshResources = useCallback(async () => {
    try {
      const [a, e, v] = await Promise.all([fountain.agents.list(), fountain.environments.list(), fountain.vaults.list()]);
      setAgents(new Map(a.map((x) => [x.id, x])));
      setEnvironments(new Map(e.map((x) => [x.id, x])));
      setVaults(new Map(v.map((x) => [x.id, x])));
      setResourcesLoaded(true);
    } catch (err) {
      setError(describeError(err));
    }
  }, [fountain]);

  useEffect(() => {
    void reload();
    void refresh();
    void refreshResources();
    try {
      localStorage.setItem(LAST_PROJECT, projectId);
    } catch {
      // fine
    }
  }, [reload, refresh, refreshResources, projectId]);

  // The list does not say what a computer is called or how it is doing; its
  // record does. Read it for every live computer, and again whenever a
  // conversation on one changes state — that is when starting becomes ready.
  const liveKey = computersOf(conversations, sandboxes)
    .filter((c) => c.sandboxId && c.live)
    .map((c) => `${c.key}:${c.conversations.map((x) => x.status).join("")}`)
    .join(",");
  useEffect(() => {
    if (!liveKey) return;
    let cancelled = false;
    for (const part of liveKey.split(",")) {
      const id = part.split(":")[0]!;
      fountain
        .sandbox(id)
        .then((rec) => {
          if (cancelled) return;
          setSandboxes((m) => new Map(m).set(rec.id, rec));
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [liveKey, fountain]);

  // Debounced refreshes: stage events arrive in bursts, and so do workbench notices.
  const timers = useRef<{ list: number | null; tree: number | null }>({ list: null, tree: null });
  const scheduleRefresh = useCallback(() => {
    if (timers.current.list !== null) return;
    timers.current.list = window.setTimeout(() => {
      timers.current.list = null;
      void refresh();
    }, 300);
  }, [refresh]);
  const scheduleReload = useCallback(() => {
    if (timers.current.tree !== null) return;
    timers.current.tree = window.setTimeout(() => {
      timers.current.tree = null;
      void reload();
      void refreshProjects();
    }, 300);
  }, [reload, refreshProjects]);

  const subscribe = useCallback((conversationId: string, handler: EventHandler) => {
    let set = handlers.current.get(conversationId);
    if (!set) {
      set = new Set();
      handlers.current.set(conversationId, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    let lastEventId: string | null = null;
    let backoff = 1000;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      const qs = new URLSearchParams({ streams: THREAD_STREAMS.join(","), blocks: "true" });
      void readSse(`${projectFountainBase(projectId)}/api/events/stream?${qs}`, {
        lastEventId,
        signal: ctrl.signal,
        onOpen: () => {
          setConnected(true);
          backoff = 1000;
          void refresh();
        },
        onMessage: (msg) => {
          if (msg.id) lastEventId = msg.id;
          if (msg.event === "conversations") {
            scheduleRefresh();
            return;
          }
          if (msg.event === "workbench") {
            scheduleReload();
            return;
          }
          let ev: UserEvent;
          try {
            ev = JSON.parse(msg.data) as UserEvent;
          } catch {
            return;
          }
          if (msg.id) ev.id = Number(msg.id);
          if (!ev.kind && (msg.event === "output" || msg.event === "stage")) ev.kind = msg.event;
          handlers.current.get(ev.conversation_id)?.forEach((h) => h(ev));
          if (ev.kind === "stage") {
            scheduleRefresh();
          } else if (ev.kind === "output") {
            setConversations((cs) =>
              cs.map((c) =>
                c.id === ev.conversation_id ? { ...c, last_active_at: ev.ts, unread: c.unread || !openConversation(c.id) } : c,
              ),
            );
          }
        },
        onClose: () => {
          setConnected(false);
          if (stopped) return;
          window.setTimeout(connect, backoff);
          backoff = Math.min(backoff * 2, 15000);
        },
      });
    };
    connect();
    return () => {
      stopped = true;
      ctrl.abort();
    };
  }, [projectId, refresh, scheduleRefresh, scheduleReload]);

  // ── mutations ──────────────────────────────────────────────────────────

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        await reload();
      } catch (err) {
        toast(describeError(err), "error");
      }
    },
    [reload, toast],
  );

  const updateProject = useCallback<ProjectStore["updateProject"]>(
    async (patch) => {
      // Edit-as-you-type: show it now, save it, let the reload settle it.
      setProject((p) => (p ? { ...p, ...patch } : p));
      await run(() => api.patchProject(projectId, patch));
      void refreshProjects();
    },
    [projectId, run, refreshProjects],
  );
  const addMember = useCallback<ProjectStore["addMember"]>((email) => run(() => api.addMember(projectId, email)), [projectId, run]);
  const removeMember = useCallback<ProjectStore["removeMember"]>((email) => run(() => api.removeMember(projectId, email)), [projectId, run]);
  const createItem = useCallback<ProjectStore["createItem"]>(
    async (title, notes = "") => {
      try {
        const w = await api.createItem(projectId, { title, notes });
        setItems((ws) => (ws.some((x) => x.id === w.id) ? ws : [...ws, w]));
        void refreshProjects();
        return w;
      } catch (err) {
        toast(describeError(err), "error");
        return null;
      }
    },
    [projectId, toast, refreshProjects],
  );
  const updateItem = useCallback<ProjectStore["updateItem"]>(
    async (id, patch) => {
      setItems((ws) => ws.map((w) => (w.id === id ? { ...w, ...patch } : w)));
      await run(() => api.patchItem(projectId, id, patch));
      void refreshProjects();
    },
    [projectId, run, refreshProjects],
  );
  const removeItem = useCallback<ProjectStore["removeItem"]>(
    async (id) => {
      setItems((ws) => ws.filter((w) => w.id !== id));
      await run(() => api.deleteItem(projectId, id));
      void refreshProjects();
    },
    [projectId, run, refreshProjects],
  );
  const addTeammate = useCallback<ProjectStore["addTeammate"]>(
    async (itemId, agentId) => {
      const w = items.find((x) => x.id === itemId);
      if (!w || w.agentIds.includes(agentId)) return;
      await updateItem(itemId, { agentIds: [...w.agentIds, agentId] });
    },
    [items, updateItem],
  );
  const removeTeammate = useCallback<ProjectStore["removeTeammate"]>(
    async (itemId, agentId) => {
      const w = items.find((x) => x.id === itemId);
      if (!w) return;
      await updateItem(itemId, { agentIds: w.agentIds.filter((x) => x !== agentId) });
    },
    [items, updateItem],
  );
  const startConversation = useCallback<ProjectStore["startConversation"]>(
    async (input) => {
      const conversation = await fountain.api.data<Conversation>("POST", "/api/conversations", { body: startBody(projectId, input) });
      if (input.join && conversation.sandbox_id !== input.join.sandboxId) {
        toast("This Fountain does not share a computer between conversations yet — started on a new one.", "error");
      }
      void refresh();
      void reload(); // the server put the teammate on the item
      return conversation;
    },
    [fountain, projectId, toast, refresh, reload],
  );

  const value = useMemo<ProjectStore | null>(
    () =>
      project
        ? {
            project,
            items,
            isOwner: project.role === "owner",
            fountain,
            conversations,
            sandboxes,
            agents,
            environments,
            vaults,
            resourcesLoaded,
            connected,
            error,
            refresh,
            refreshResources,
            reload,
            subscribe,
            toast,
            updateProject,
            addMember,
            removeMember,
            createItem,
            updateItem,
            removeItem,
            addTeammate,
            removeTeammate,
            startConversation,
          }
        : null,
    [
      project,
      items,
      fountain,
      conversations,
      sandboxes,
      agents,
      environments,
      vaults,
      resourcesLoaded,
      connected,
      error,
      refresh,
      refreshResources,
      reload,
      subscribe,
      toast,
      updateProject,
      addMember,
      removeMember,
      createItem,
      updateItem,
      removeItem,
      addTeammate,
      removeTeammate,
      startConversation,
    ],
  );

  if (missing) return <>{fallback("missing")}</>;
  if (!value) return <>{fallback("loading")}</>;
  return <ProjectCtx.Provider value={value}>{children}</ProjectCtx.Provider>;
}

/** Whether the conversation is the one open on screen (its unread state is being cleared). */
function openConversation(id: string): boolean {
  return window.location.hash.endsWith(`/c/${id}`);
}
