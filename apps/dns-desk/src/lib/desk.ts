/**
 * Which desk this browser runs — the agent and the vault it was hired with —
 * remembered per Fountain URL, and how the desk's one conversation is found.
 *
 * The desk is not a Fountain object. It is an agent plus a conversation bound
 * to the `dns-desk` channel: `POST /api/conversations` with that `channel_id`
 * resumes the latest live conversation for the same agent and vault, or opens
 * one when there is none (the machine was retired, or this is the first
 * request). So the app keeps no conversation id of its own; it asks.
 */
import type { Conversation } from "../api/types";

const KEY = "dns-desk.desk";

/** The channel every desk conversation is bound to. */
export const CHANNEL = "dns-desk";

export interface DeskRef {
  agentId: string;
  vaultId: string | null;
}

function readMap(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(KEY);
    const map = raw ? (JSON.parse(raw) as unknown) : {};
    return map && typeof map === "object" && !Array.isArray(map) ? (map as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function loadDesk(baseUrl: string): DeskRef | null {
  const v = readMap()[baseUrl];
  // A bare string is the agent id an older build stored, with no vault;
  // it is dropped so the desk is chosen again with one.
  if (!v || typeof v !== "object") return null;
  const { agentId, vaultId } = v as Partial<DeskRef>;
  if (typeof agentId !== "string" || !agentId) return null;
  return { agentId, vaultId: typeof vaultId === "string" && vaultId ? vaultId : null };
}

export function saveDesk(baseUrl: string, desk: DeskRef): void {
  const map = readMap();
  map[baseUrl] = desk;
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // storage unavailable: the desk is just not remembered
  }
}

export function clearDesk(baseUrl: string): void {
  const map = readMap();
  delete map[baseUrl];
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // nothing to clear
  }
}

/** A one-word status for the header, from the desk's conversation. */
export function presenceLabel(conv: Conversation | null): string {
  if (!conv) return "ready";
  switch (conv.status) {
    case "pending":
      return "starting";
    case "running":
      return "working";
    case "idle":
      return "online";
    default:
      return conv.status;
  }
}
