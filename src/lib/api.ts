/**
 * Salon's own API (server/app.ts), same origin, session cookie. Fountain
 * itself is reached through the SDK at `/f/<chat>` — see store.tsx.
 */
import type { ChatSettings } from "../../shared/settings";
import type { ImageInput } from "../../shared/images";

export interface Me {
  email: string;
  fountainUrl: string;
}

export interface Named {
  id: string;
  name: string;
}

export interface PresetDto {
  id: string;
  name: string;
  description: string;
  runtime: string;
  model: string;
  environmentId: string | null;
  hasAvatar: boolean;
}

export interface PresetsDto {
  agents: PresetDto[];
  environments: Named[];
  vaults: Named[];
  catalog: { runtimes: string[]; models: Record<string, string[]> };
}

export interface ChatDto {
  id: string;
  title: string;
  ownerEmail: string;
  role: "owner" | "member";
  members: { email: string; addedAt: string }[];
  conversationId: string;
  agentId: string;
  settings: { runtime: string; model: string; presetId: string | null; presetName: string | null; environmentId: string | null; vaultId: string | null };
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
  presets: () => data(call<{ data: PresetsDto }>("GET", "/api/me/presets")),

  chats: () => data(call<{ data: ChatDto[] }>("GET", "/api/chats")),
  createChat: (input: { prompt: string; images?: ImageInput[] | null; settings: ChatSettings; title?: string }) => data(call<{ data: ChatDto }>("POST", "/api/chats", input)),
  chat: (id: string) => data(call<{ data: { chat: ChatDto; sends: SendDto[] } }>("GET", `/api/chats/${id}`)),
  patchChat: (id: string, patch: { title?: string }) => data(call<{ data: { chat: ChatDto; sends: SendDto[] } }>("PATCH", `/api/chats/${id}`, patch)),
  deleteChat: (id: string) => call<{ ok: true }>("DELETE", `/api/chats/${id}`),
  addMember: (id: string, email: string) => data(call<{ data: { chat: ChatDto; sends: SendDto[] } }>("POST", `/api/chats/${id}/members`, { email })),
  removeMember: (id: string, email: string) => call<{ ok?: true; left?: boolean; data?: { chat: ChatDto } }>("DELETE", `/api/chats/${id}/members/${encodeURIComponent(email)}`),
  invite: (id: string) => data(call<{ data: { token: string } }>("POST", `/api/chats/${id}/invite`)),
  join: (token: string) => data(call<{ data: ChatDto }>("POST", `/api/join/${encodeURIComponent(token)}`)),
};

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
