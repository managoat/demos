/**
 * Salon's own API (server/app.ts), same origin, session cookie. Fountain
 * itself is reached through the SDK at `/f/<chat>` — see store.tsx.
 */
import type { ChangesDto } from "../../shared/changes";
import type { CommentDto, Side } from "../../shared/comments";
import type { DirListing, FileContents } from "../../shared/files";
import type { ChatSettings } from "../../shared/settings";
import type { GameDto, GameKind } from "../../shared/games";
import type { ImageInput } from "../../shared/images";
import type { ProjectDto } from "../../shared/projects";
import type { ControlEventDto, NoteDelivery, PresenceDto, PresenceHeartbeatInput, RoomNoteDto } from "../../shared/control";
import type { CriterionResultDto, PlanApprovalDto, PlanDocument, PlanDraft, PlanEventDto, PlanExecutionDto, PlanOperation, PlanProposalDto } from "../../shared/plans";

export interface Me {
  email: string;
  fountainUrl: string;
  onboardingComplete: boolean;
  inferenceToken: { connected: boolean; updatedAt: string };
}

export interface WorkspaceMemberDto {
  email: string;
  addedAt: string;
}

export interface NotificationDto {
  id: string;
  chatId: string;
  chatTitle: string;
  actorEmail: string;
  kind: "mention";
  createdAt: string;
  readAt: string | null;
}

export interface GitHubInfo {
  configured: boolean;
  connected: boolean;
  login: string | null;
  clientId: string | null;
  installUrl: string | null;
}

export interface GitHubRepo {
  slug: string;
  private: boolean;
  archived: boolean;
  defaultBranch: string;
  description: string | null;
  pushedAt: string | null;
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
  archivedAt: string | null;
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

export interface PlanStateDto {
  document: PlanDocument;
  events: PlanEventDto[];
  approvals: PlanApprovalDto[];
  executions: PlanExecutionDto[];
  comments: CommentDto[];
  proposals: PlanProposalDto[];
}

export interface CollaborationStateDto {
  presence: PresenceDto;
  activeTurn: { id: string; author: string; status: string } | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
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
    const answeredBy = typeof (e as Record<string, unknown>).answeredBy === "string" ? (e as Record<string, unknown>).answeredBy : null;
    const message = e.message ?? `Request failed (HTTP ${res.status}).`;
    throw new ApiError(res.status, e.error ?? `http_${res.status}`, answeredBy ? `${message} ${answeredBy} answered first.` : message, parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {});
  }
  return parsed as T;
}

const data = <T,>(p: Promise<{ data: T }>): Promise<T> => p.then((r) => r.data);

export const api = {
  config: () => call<{ fountainUrl: string }>("GET", "/api/config"),
  me: () => call<Me>("GET", "/api/me"),
  signIn: (apiKey: string) => call<Me>("POST", "/api/session", { apiKey }),
  signOut: () => call<{ ok: true }>("DELETE", "/api/session"),
  updateToken: (apiKey: string) => data(call<{ data: Me }>("POST", "/api/me/token", { apiKey })),
  completeOnboarding: () => data(call<{ data: Me }>("POST", "/api/me/onboarding")),
  workspace: () => data(call<{ data: WorkspaceMemberDto[] }>("GET", "/api/workspace/members")),
  addWorkspaceMember: (email: string) => data(call<{ data: WorkspaceMemberDto[] }>("POST", "/api/workspace/members", { email })),
  removeWorkspaceMember: (email: string) => call<{ ok: true }>("DELETE", `/api/workspace/members/${encodeURIComponent(email)}`),
  notifications: () => data(call<{ data: NotificationDto[] }>("GET", "/api/notifications")),
  readNotification: (id: string) => call<{ ok: true }>("POST", `/api/notifications/${encodeURIComponent(id)}/read`),
  menu: () => data(call<{ data: MenuDto }>("GET", "/api/me/menu")),
  github: () => data(call<{ data: GitHubInfo }>("GET", "/api/github")),
  githubRepos: () => data(call<{ data: GitHubRepo[] }>("GET", "/api/github/repos")),

  chats: () => data(call<{ data: ChatDto[] }>("GET", "/api/chats")),
  createChat: (input: { prompt: string; images?: ImageInput[] | null; settings: ChatSettings; title?: string }) => data(call<{ data: ChatDto }>("POST", "/api/chats", input)),
  chat: (id: string) => data(call<{ data: { chat: ChatDto; sends: SendDto[] } }>("GET", `/api/chats/${id}`)),
  patchChat: (id: string, patch: { title?: string }) => data(call<{ data: { chat: ChatDto; sends: SendDto[] } }>("PATCH", `/api/chats/${id}`, patch)),
  deleteChat: (id: string) => call<{ ok: true }>("DELETE", `/api/chats/${id}`),
  addMember: (id: string, email: string) => data(call<{ data: { chat: ChatDto; sends: SendDto[] } }>("POST", `/api/chats/${id}/members`, { email })),
  removeMember: (id: string, email: string) => call<{ ok?: true; left?: boolean; data?: { chat: ChatDto } }>("DELETE", `/api/chats/${id}/members/${encodeURIComponent(email)}`),
  archiveChat: (id: string) => data(call<{ data: { chat: ChatDto; sends: SendDto[] } }>("POST", `/api/chats/${id}/archive`)),
  restoreChat: (id: string) => data(call<{ data: { chat: ChatDto; sends: SendDto[] } }>("POST", `/api/chats/${id}/restore`)),
  invite: (id: string) => data(call<{ data: { token: string } }>("POST", `/api/chats/${id}/invite`)),
  join: (token: string) => data(call<{ data: ChatDto }>("POST", `/api/join/${encodeURIComponent(token)}`)),

  collaboration: (chatId: string) => data(call<{ data: CollaborationStateDto }>("GET", `/api/chats/${chatId}/collaboration`)),
  presence: (chatId: string, input: PresenceHeartbeatInput) => data(call<{ data: PresenceDto }>("POST", `/api/chats/${chatId}/presence`, input)),
  leavePresence: (chatId: string, input: PresenceHeartbeatInput) => data(call<{ data: PresenceDto }>("POST", `/api/chats/${chatId}/presence/leave`, input)),
  notes: (chatId: string) => data(call<{ data: RoomNoteDto[] }>("GET", `/api/chats/${chatId}/notes`)),
  note: (chatId: string, body: string, delivery: NoteDelivery = "manual") => data(call<{ data: RoomNoteDto }>("POST", `/api/chats/${chatId}/notes`, { body, delivery })),
  queueNote: (chatId: string, noteId: string, delivery: NoteDelivery) => data(call<{ data: RoomNoteDto }>("POST", `/api/chats/${chatId}/notes/${noteId}/queue`, { delivery })),
  resolveNote: (chatId: string, noteId: string, resolved: boolean) => data(call<{ data: RoomNoteDto }>("POST", `/api/chats/${chatId}/notes/${noteId}/resolve`, { resolved })),
  deleteNote: (chatId: string, noteId: string) => call<{ ok: true }>("DELETE", `/api/chats/${chatId}/notes/${noteId}`),
  sendNotes: (chatId: string) => data(call<{ data: { sent: number; prompt: string; notes: RoomNoteDto[] } }>("POST", `/api/chats/${chatId}/notes/send`)),
  controlEvents: (chatId: string) => data(call<{ data: ControlEventDto[] }>("GET", `/api/chats/${chatId}/control-actions`)),
  interrupt: (chatId: string) => data(call<{ data: ControlEventDto }>("POST", `/api/chats/${chatId}/interrupt`)),
  answerPermission: (chatId: string, requestId: string, optionId: string) => data(call<{ data: ControlEventDto }>("POST", `/api/chats/${chatId}/permission-requests/${encodeURIComponent(requestId)}/answer`, { optionId })),

  plan: (chatId: string) => data(call<{ data: PlanStateDto | null }>("GET", `/api/chats/${chatId}/plan`)),
  adoptPlan: (chatId: string, draft: PlanDraft | unknown) => data(call<{ data: PlanStateDto | { proposed: true; proposal: unknown; plan: PlanStateDto } }>("POST", `/api/chats/${chatId}/plan/adopt`, { draft })),
  mutatePlan: (chatId: string, operations: PlanOperation[]) => data(call<{ data: PlanStateDto }>("POST", `/api/chats/${chatId}/plan/operations`, { operations })),
  decidePlan: (chatId: string, revision: number, kind: "approve" | "support") => data(call<{ data: PlanStateDto }>("POST", `/api/chats/${chatId}/plan/decisions`, { revision, kind })),
  decidePlanProposal: (chatId: string, proposalId: string, decision: "apply" | "dismiss") => data(call<{ data: PlanStateDto }>("POST", `/api/chats/${chatId}/plan/proposals/${proposalId}`, { decision })),
  draftPlan: (chatId: string, intent: string) => data(call<{ data: { prompt: string; currentRevision: number | null } }>("POST", `/api/chats/${chatId}/plan/draft`, { intent })),
  sendPlanFeedback: (chatId: string) => data(call<{ data: { sent: number; prompt: string; plan: PlanStateDto } }>("POST", `/api/chats/${chatId}/plan/feedback/send`)),
  runPlan: (chatId: string, nodeId?: string) => data(call<{ data: { execution: PlanExecutionDto; plan: PlanStateDto } }>("POST", `/api/chats/${chatId}/plan/run`, nodeId ? { nodeId } : {})),
  finishPlanExecution: (chatId: string, executionId: string, input: { summary?: string; error?: string; failed?: boolean; interrupted?: boolean; criterionResults?: CriterionResultDto[]; modelClaims?: string[] }) => data(call<{ data: { execution: PlanExecutionDto; plan: PlanStateDto } }>("POST", `/api/chats/${chatId}/plan/executions/${executionId}/finish`, input)),
  planExecutionEvidence: (chatId: string, executionId: string) => data(call<{ data: ChangesDto }>("GET", `/api/chats/${chatId}/plan/executions/${executionId}/evidence`)),

  games: (chatId: string) => data(call<{ data: GameDto[] }>("GET", `/api/chats/${chatId}/games`)),
  startGame: (chatId: string, kind: GameKind, players: [string, string]) => data(call<{ data: GameDto }>("POST", `/api/chats/${chatId}/games`, { kind, players })),
  move: (chatId: string, gameId: string, cell: number) => data(call<{ data: GameDto }>("POST", `/api/chats/${chatId}/games/${gameId}/moves`, { cell })),

  projects: () => data(call<{ data: ProjectDto[] }>("GET", "/api/projects")),
  createProject: (input: { repoUrl?: string; githubRepo?: string; base?: string; name?: string; token?: string; setup?: string }) => data(call<{ data: ProjectDto }>("POST", "/api/projects", input)),
  deleteProject: (id: string) => call<{ ok: true }>("DELETE", `/api/projects/${id}`),
  addProjectMember: (id: string, email: string) => data(call<{ data: ProjectDto }>("POST", `/api/projects/${id}/members`, { email })),
  removeProjectMember: (id: string, email: string) => call<{ ok?: true; left?: boolean; data?: ProjectDto }>("DELETE", `/api/projects/${id}/members/${encodeURIComponent(email)}`),

  changes: (chatId: string) => data(call<{ data: ChangesDto | null }>("GET", `/api/chats/${chatId}/changes`)),
  comments: (chatId: string) => data(call<{ data: CommentDto[] }>("GET", `/api/chats/${chatId}/comments`)),
  comment: (chatId: string, input: { path?: string; side?: Side; line?: number; anchorKind?: "diff_line" | "plan_node" | "plan_field"; planNodeId?: string; planField?: string; body: string }) => data(call<{ data: CommentDto }>("POST", `/api/chats/${chatId}/comments`, input)),
  resolveComment: (chatId: string, id: string, resolved: boolean) => data(call<{ data: CommentDto }>("POST", `/api/chats/${chatId}/comments/${id}/resolve`, { resolved })),
  deleteComment: (chatId: string, id: string) => call<{ ok: true }>("DELETE", `/api/chats/${chatId}/comments/${id}`),
  sendComments: (chatId: string) => data(call<{ data: { sent: number; prompt: string; comments: CommentDto[] } }>("POST", `/api/chats/${chatId}/comments/send`)),
  changesHistory: (chatId: string) => data(call<{ data: ChangesDto[] }>("GET", `/api/chats/${chatId}/changes/history`)),
  /** Read the repository through Fountain now, as a snapshot. Not a turn. */
  refreshChanges: (chatId: string, reason: "manual" | "stop") => data(call<{ data: ChangesDto }>("POST", `/api/chats/${chatId}/changes/refresh`, { reason })),
  files: (chatId: string, path: string) => data(call<{ data: DirListing }>("GET", `/api/chats/${chatId}/files?${new URLSearchParams({ path })}`)),
  file: (chatId: string, path: string) => data(call<{ data: FileContents }>("GET", `/api/chats/${chatId}/file?${new URLSearchParams({ path })}`)),
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
