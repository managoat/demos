/**
 * Salon's own API (server/app.ts), same origin, session cookie. Fountain
 * itself is reached through the SDK at `/f/<chat>` — see store.tsx.
 */
import type { ChangesDto } from "../../shared/changes";
import type { ChatSettings } from "../../shared/settings";
import type { GameDto, GameKind } from "../../shared/games";
import type { ImageInput } from "../../shared/images";
import type { ProjectDto } from "../../shared/projects";

export interface Me {
  email: string;
  fountainUrl: string;
}

/** One of the host's Fountain connections, as the Connectors submenu shows it. */
export interface ConnectorDto {
  id: string;
  label: string;
  account: string | null;
  usable: boolean;
  why: string | null;
}

/** What the composer's menus are made of (server/menu.ts). */
export interface MenuDto {
  models: string[];
  connectors: { enabled: boolean; items: ConnectorDto[]; connectUrl: string };
}

export interface ChatDto {
  id: string;
  title: string;
  ownerEmail: string;
  role: "owner" | "member";
  members: { email: string; addedAt: string }[];
  conversationId: string;
  agentId: string;
  settings: { model: string; skills: string[]; connectors: { id: string; label: string }[] };
  project: { id: string; name: string; repoUrl: string; base: string } | null;
  createdAt: string;
  inviteToken?: string | null;
  status: string | null;
  lastActiveAt: string | null;
  turnCount: number | null;
  unavailable: boolean;
}

export interface SendDto {
  seq: number;
  email: string;
  at: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const e = (parsed ?? {}) as { error?: string; message?: string };
    throw new ApiError(res.status, e.error ?? `http_${res.status}`, e.message ?? `Request failed (HTTP ${res.status}).`);
  }
  return parsed as T;
}

const data = <T,>(p: Promise<{ data: T }>): Promise<T> => p.then((r) => r.data);

export const api = {
  config: () => call<{ fountainUrl: string }>("GET", "/api/config"),
  me: () => call<Me>("GET", "/api/me"),
  signIn: (apiKey: string) => call<Me>("POST", "/api/session", { apiKey }),
  signOut: () => call<{ ok: true }>("DELETE", "/api/session"),
  menu: () => data(call<{ data: MenuDto }>("GET", "/api/me/menu")),

  chats: () => data(call<{ data: ChatDto[] }>("GET", "/api/chats")),
  createChat: (input: { prompt: string; images?: ImageInput[] | null; settings: ChatSettings; title?: string }) => data(call<{ data: ChatDto }>("POST", "/api/chats", input)),
  chat: (id: string) => data(call<{ data: { chat: ChatDto; sends: SendDto[] } }>("GET", `/api/chats/${id}`)),
  patchChat: (id: string, patch: { title?: string }) => data(call<{ data: { chat: ChatDto; sends: SendDto[] } }>("PATCH", `/api/chats/${id}`, patch)),
  deleteChat: (id: string) => call<{ ok: true }>("DELETE", `/api/chats/${id}`),
  addMember: (id: string, email: string) => data(call<{ data: { chat: ChatDto; sends: SendDto[] } }>("POST", `/api/chats/${id}/members`, { email })),
  removeMember: (id: string, email: string) => call<{ ok?: true; left?: boolean; data?: { chat: ChatDto } }>("DELETE", `/api/chats/${id}/members/${encodeURIComponent(email)}`),
  invite: (id: string) => data(call<{ data: { token: string } }>("POST", `/api/chats/${id}/invite`)),
  join: (token: string) => data(call<{ data: ChatDto }>("POST", `/api/join/${encodeURIComponent(token)}`)),

  games: (chatId: string) => data(call<{ data: GameDto[] }>("GET", `/api/chats/${chatId}/games`)),
  startGame: (chatId: string, kind: GameKind, players: [string, string]) => data(call<{ data: GameDto }>("POST", `/api/chats/${chatId}/games`, { kind, players })),
  move: (chatId: string, gameId: string, cell: number) => data(call<{ data: GameDto }>("POST", `/api/chats/${chatId}/games/${gameId}/moves`, { cell })),

  projects: () => data(call<{ data: ProjectDto[] }>("GET", "/api/projects")),
  createProject: (input: { repoUrl: string; base?: string; name?: string; token?: string; setup?: string }) => data(call<{ data: ProjectDto }>("POST", "/api/projects", input)),
  deleteProject: (id: string) => call<{ ok: true }>("DELETE", `/api/projects/${id}`),
  addProjectMember: (id: string, email: string) => data(call<{ data: ProjectDto }>("POST", `/api/projects/${id}/members`, { email })),
  removeProjectMember: (id: string, email: string) => call<{ ok?: true; left?: boolean; data?: ProjectDto }>("DELETE", `/api/projects/${id}/members/${encodeURIComponent(email)}`),

  changes: (chatId: string) => data(call<{ data: ChangesDto | null }>("GET", `/api/chats/${chatId}/changes`)),
  changesHistory: (chatId: string) => data(call<{ data: ChangesDto[] }>("GET", `/api/chats/${chatId}/changes/history`)),
};

/** The chat's own stream (server/hub.ts): games and changes, same origin, so the session cookie goes with it. */
export function chatStreamUrl(chatId: string): string {
  return `/api/chats/${chatId}/stream`;
}

/** The SDK's base URL for one chat: Fountain as seen from inside it, on the host's key. */
export function chatFountainBase(chatId: string): string {
  return `${window.location.origin}/f/${chatId}`;
}

/** An image sent on a turn, same origin, so the session cookie goes with it. */
export function turnImageUrl(chatId: string, conversationId: string, turnId: string, position: number): string {
  return `${chatFountainBase(chatId)}/api/conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(turnId)}/images/${position}`;
}

/** The join link for a token, on this origin. */
export function joinUrl(token: string): string {
  return `${window.location.origin}${window.location.pathname}#/join/${token}`;
}

/** "Opus 5 · Gmail, PDFs" — what a chat was started with, for its header and the list. */
export function settingsLine(settings: ChatDto["settings"], modelLabel: (m: string) => string, skillNames: (ids: readonly string[]) => string[], project: ChatDto["project"] = null): string {
  const extras = [...(project ? [project.name] : []), ...settings.connectors.map((c) => c.label), ...skillNames(settings.skills)];
  return `${modelLabel(settings.model)}${extras.length ? ` · ${extras.join(", ")}` : ""}`;
}
