/**
 * Salon-owned collaboration and control records. Room notes are durable and
 * never become a model turn until somebody explicitly sends them or attaches
 * queued notes to a later prompt. Presence is deliberately ephemeral.
 */

export const ROOM_NOTE_MAX = 4_000;
export const PRESENCE_CLIENT_MAX = 128;
export const CONTROL_ID_MAX = 200;

export type NoteDelivery = "manual" | "next_turn";

export interface RoomNoteDto {
  id: string;
  chatId: string;
  body: string;
  author: string;
  delivery: NoteDelivery;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  sentAt: string | null;
  sentBy: string | null;
}

export interface NoteInput {
  body: string;
  delivery: NoteDelivery;
}

export function parseNoteInput(value: unknown): NoteInput | string {
  if (!record(value)) return "A note is required.";
  const body = typeof value.body === "string" ? value.body.trim().slice(0, ROOM_NOTE_MAX) : "";
  if (!body) return "Write something in the note.";
  const delivery = value.delivery === "next_turn" || value.queueForNextTurn === true ? "next_turn" : "manual";
  return { body, delivery };
}

export function parseNoteQueue(value: unknown): NoteDelivery | string {
  if (!record(value)) return "A queue choice is required.";
  if (value.delivery === "manual" || value.delivery === "next_turn") return value.delivery;
  if (typeof value.queued === "boolean") return value.queued ? "next_turn" : "manual";
  return "Choose whether this note is for the next turn.";
}

/** A single attributed prompt assembled from notes without changing them. */
export function notesPrompt(notes: readonly Pick<RoomNoteDto, "author" | "body">[]): string {
  const out = ["Room notes. Please take these into account, then say briefly how you addressed them.", ""];
  for (const note of notes) out.push(`${note.author}: ${note.body}`);
  return out.join("\n");
}

/** Queue notes supplement a participant's next prompt; they never replace it. */
export function promptWithQueuedNotes(prompt: string, notes: readonly Pick<RoomNoteDto, "author" | "body">[]): string {
  if (notes.length === 0) return prompt;
  const out = [prompt.trim(), "", "Room notes saved for this turn:"];
  for (const note of notes) out.push(`- ${note.author}: ${note.body}`);
  return out.join("\n").trim();
}

export type ViewingMode = "viewing" | "editing";

export interface ViewingTarget {
  nodeId: string;
  field: string | null;
  mode: ViewingMode;
}

export interface PresenceHeartbeatInput {
  clientId: string;
  typing: boolean;
  viewing: ViewingTarget | null;
}

export function parsePresenceHeartbeat(value: unknown): PresenceHeartbeatInput | string {
  if (!record(value)) return "A presence heartbeat is required.";
  const clientId = safeId(value.clientId, PRESENCE_CLIENT_MAX);
  if (!clientId) return "A client id is required.";
  if (value.typing !== undefined && typeof value.typing !== "boolean") return "Typing must be true or false.";
  let viewing: ViewingTarget | null = null;
  if (value.viewing !== undefined && value.viewing !== null) {
    if (!record(value.viewing)) return "Viewing must name a plan node.";
    const nodeId = safeId(value.viewing.nodeId, CONTROL_ID_MAX);
    if (!nodeId) return "Viewing must name a plan node.";
    const mode = value.viewing.mode === "editing" ? "editing" : value.viewing.mode === undefined || value.viewing.mode === "viewing" ? "viewing" : null;
    if (!mode) return "Viewing mode must be viewing or editing.";
    const field = value.viewing.field === undefined || value.viewing.field === null ? null : safeId(value.viewing.field, CONTROL_ID_MAX);
    if (value.viewing.field !== undefined && value.viewing.field !== null && !field) return "The viewed field is not valid.";
    viewing = { nodeId, field, mode };
  }
  return { clientId, typing: value.typing === true, viewing };
}

export interface PresencePersonDto {
  email: string;
  lastSeenAt: string;
  expiresAt: string;
  typing: boolean;
  viewing: ViewingTarget | null;
}

export interface PresenceDto {
  chatId: string;
  at: string;
  people: PresencePersonDto[];
}

export interface TypingDto {
  chatId: string;
  email: string;
  typing: boolean;
  expiresAt: string;
}

export interface ViewingDto {
  chatId: string;
  email: string;
  viewing: ViewingTarget | null;
  expiresAt: string;
}

export type ControlAction = "interrupt" | "permission_answer";
export type ControlOutcome = "succeeded" | "failed" | "denied" | "first_answer_lost";

export interface ControlEventDto {
  id: string;
  chatId: string;
  actor: string;
  action: ControlAction;
  outcome: ControlOutcome;
  conversationId: string;
  turnId: string | null;
  turnAuthor: string | null;
  requestId: string | null;
  optionId: string | null;
  winner: string | null;
  errorCode: string | null;
  createdAt: string;
}

export interface PermissionAnswerInput {
  requestId: string;
  optionId: string;
}

export function parsePermissionAnswer(value: unknown, pathRequestId?: string): PermissionAnswerInput | string {
  if (!record(value)) return "An answer is required.";
  const requestId = safeId(pathRequestId ?? value.requestId, CONTROL_ID_MAX);
  const optionId = safeId(value.optionId ?? value.option_id, CONTROL_ID_MAX);
  if (!requestId) return "A permission request id is required.";
  if (!optionId) return "Choose one of the permission options offered.";
  return { requestId, optionId };
}

/** Kept here as the replaceable seam for a future project-specific policy. */
export function canControl(actor: string, role: "owner" | "member", turnAuthor: string | null): boolean {
  return role === "owner" || (turnAuthor !== null && actor === turnAuthor);
}

function safeId(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const id = value.trim().slice(0, max);
  return id && !/[\u0000-\u001f\u007f/]/.test(id) ? id : "";
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
