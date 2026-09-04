/**
 * The browser's whole API surface, which is drydock's server and nothing
 * else.
 *
 * Every other app in this suite has a client that talks to Fountain — some
 * directly, some through a proxy. This one cannot: the browser holds no
 * Fountain credential of any kind, so there is no Fountain URL in this file
 * and no way for a component to reach one. Everything is `/api/...` on the
 * same origin, authenticated by a session cookie the browser never reads.
 *
 * Which makes this file boring on purpose. One `call`, one error shape, and a
 * named function per route so a component never assembles a URL.
 */
import type {
  BranchRef,
  ChecksReport,
  DiffReport,
  ExecResult,
  FileContent,
  FileListing,
  IssueRef,
  Project,
  ProjectSettings,
  PullRef,
  RepoRef,
  RunCommand,
  SessionInfo,
  Thread,
  ThreadHeader,
  ThreadOrigin,
} from "../../shared/api";

/**
 * A failure with the server's own words in it.
 *
 * `code` is the machine-readable half and is what a component switches on;
 * `message` is written to be shown to a person as-is, because the server is
 * the only place that knows *why* — whether a missing terminal is a missing
 * token or a machine still being built is not something the browser can work
 * out, and a generic "something went wrong" throws that away.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    method,
    ...init,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...init.headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!res.ok) {
    const obj = (parsed ?? {}) as { error?: string; message?: string };
    throw new ApiError(res.status, obj.error ?? "error", obj.message ?? `The server answered ${res.status}.`);
  }
  return ((parsed as { data?: T } | null)?.data ?? (parsed as T)) as T;
}

const get = <T>(path: string) => call<T>("GET", path);

// ── the session ────────────────────────────────────────────────────────

export const session = () => get<SessionInfo>("/api/session");
export const signOut = () => call<{ ok: boolean }>("DELETE", "/api/auth/session");

// ── GitHub ─────────────────────────────────────────────────────────────

export const installations = () => get<{ id: number; account: string; avatarUrl: string | null }[]>("/api/github/installations");
export const repos = (installationId?: number) =>
  get<RepoRef[]>(`/api/github/repos${installationId ? `?installation_id=${installationId}` : ""}`);
export const branches = (repo: string) => get<BranchRef[]>(`/api/github/repo/${repo}/branches`);
export const pulls = (repo: string) => get<PullRef[]>(`/api/github/repo/${repo}/pulls`);
export const issues = (repo: string) => get<IssueRef[]>(`/api/github/repo/${repo}/issues`);

// ── projects ───────────────────────────────────────────────────────────

export const listProjects = () => get<Project[]>("/api/projects");
export const getProject = (id: string) => get<Project>(`/api/projects/${id}`);
export const createProject = (body: { name?: string; repo?: string | null; installationId?: number; model?: string }) =>
  call<Project>("POST", "/api/projects", body);
export const patchProject = (id: string, body: Partial<ProjectSettings>) => call<Project>("PATCH", `/api/projects/${id}`, body);
export const deleteProject = (id: string) => call<{ ok: boolean }>("DELETE", `/api/projects/${id}`);
export const getSettings = (id: string) => get<ProjectSettings>(`/api/projects/${id}/settings`);
export const putSecret = (id: string, body: { store: "environment" | "vault"; key: string; value: string }) =>
  call<{ ok: boolean }>("POST", `/api/projects/${id}/secrets`, body);
export const deleteSecret = (id: string, store: "environment" | "vault", key: string) =>
  call<{ ok: boolean }>("DELETE", `/api/projects/${id}/secrets/${store}/${encodeURIComponent(key)}`);

export const runCommands = (id: string) => get<RunCommand[]>(`/api/projects/${id}/commands`);
export const addRunCommand = (id: string, body: { label: string; command: string }) =>
  call<RunCommand>("POST", `/api/projects/${id}/commands`, body);
export const removeRunCommand = (id: string, cmd: string) => call<{ ok: boolean }>("DELETE", `/api/projects/${id}/commands/${cmd}`);

// ── threads ────────────────────────────────────────────────────────────

export const listThreads = (projectId: string) => get<Thread[]>(`/api/projects/${projectId}/threads`);
export const openThread = (projectId: string, body: { title?: string; prompt?: string; origin?: Partial<ThreadOrigin> }) =>
  call<Thread>("POST", `/api/projects/${projectId}/threads`, body);
export const getThread = (id: string) => get<Thread>(`/api/threads/${id}`);
export const threadHeader = (id: string) => get<ThreadHeader>(`/api/threads/${id}/header`);
export const renameThread = (id: string, title: string) => call<{ ok: boolean }>("PATCH", `/api/threads/${id}`, { title });
export const closeThread = (id: string) => call<{ ok: boolean }>("DELETE", `/api/threads/${id}`);
export const sendPrompt = (id: string, prompt: string) => call<{ ok: boolean }>("POST", `/api/threads/${id}/prompt`, { prompt });
export const interrupt = (id: string) => call<{ ok: boolean }>("POST", `/api/threads/${id}/interrupt`);

// ── what is on the machine ─────────────────────────────────────────────

export const listFiles = (id: string, path?: string) =>
  get<FileListing>(`/api/threads/${id}/files${path ? `?path=${encodeURIComponent(path)}` : ""}`);
export const readFile = (id: string, path: string) => get<FileContent>(`/api/threads/${id}/file?path=${encodeURIComponent(path)}`);
export const readDiff = (id: string) => get<DiffReport>(`/api/threads/${id}/diff`);
export const checks = (id: string) => get<ChecksReport>(`/api/threads/${id}/checks`);
export const openPull = (id: string, body: { title?: string; body?: string; draft?: boolean }) =>
  call<PullRef & { url: string }>("POST", `/api/threads/${id}/pull`, body);
export const exec = (id: string, body: { command: string; cwd?: string; timeoutSec?: number }) =>
  call<ExecResult>("POST", `/api/threads/${id}/exec`, body);

/**
 * The terminal's socket.
 *
 * `ws:`/`wss:` chosen from the page's own protocol rather than hardcoded, so
 * this works behind Traefik in production and against Vite's proxy in
 * development without a build flag.
 */
export function terminalSocket(id: string, rows: number, cols: number): WebSocket {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(`${proto}//${location.host}/api/threads/${id}/terminal?rows=${rows}&cols=${cols}`);
}

// ── streams ────────────────────────────────────────────────────────────

/**
 * Drydock's own event stream for a project.
 *
 * `EventSource` rather than a hand-rolled reader, which is a difference from
 * every other app in this suite and is worth a sentence: those read Fountain
 * directly and cannot use `EventSource` because it will not send an
 * `Authorization` header. This stream is same-origin and authenticated by a
 * cookie, which `EventSource` sends — so the browser's own implementation,
 * with its own reconnection, is simply better than anything written here.
 */
export function projectStream(projectId: string, on: (event: string) => void): () => void {
  const source = new EventSource(`/api/projects/${projectId}/stream`);
  for (const name of ["threads", "thread", "settings"]) source.addEventListener(name, () => on(name));
  return () => source.close();
}

/** The transcript. Not `EventSource` — this one needs `Last-Event-ID` handling of its own. */
export const transcriptUrl = (id: string) => `/api/threads/${id}/stream`;
export const eventsUrl = (id: string, after?: number) =>
  `/api/threads/${id}/events${after ? `?after=${after}` : ""}`;
