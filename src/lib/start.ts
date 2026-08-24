/**
 * Starting a conversation on a work item — the one request that also assigns
 * the teammate.
 *
 * A teammate does not have to be on the item first: the server puts them
 * there when the conversation starts (`addTeammate` in server/proxy.ts), so
 * picking an agent and writing a prompt *is* assigning one. Both places that
 * start a conversation — the new-work-item form and the start dialog — build
 * the body here, and the project's store sends it (`startConversation`).
 */
import { channelFor, conversationTitle } from "../../shared/channel";
import type { ImageInput } from "../../shared/images";
import type { ItemDto as WorkItem } from "./api";

/** A computer to start on instead of a new one (ADR 0023): the same teammate's, on the same item. */
export interface JoinTarget {
  sandboxId: string;
  label: string;
  /** The agent the computer belongs to; a home is never shared across identities. */
  agentId: string;
}

export interface StartInput {
  item: WorkItem;
  agent: { id: string; name: string };
  /** The first prompt. Empty just brings the computer up. */
  prompt: string;
  /** Prepend the item's title and notes, so the teammate starts with its context. */
  includeNotes: boolean;
  /** Screenshots to attach to that first prompt. */
  images?: ImageInput[];
  join?: JoinTarget | null;
}

/** What the browser POSTs to `/f/<project>/api/conversations`; the server decides the rest. */
export function startBody(projectId: string, input: StartInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    agent_id: input.agent.id,
    channel_id: channelFor(projectId, input.item.id),
    fresh: true,
    title: conversationTitle(input.agent.name, input.item.title),
  };
  const prompt = buildPrompt(input.item, input.prompt, input.includeNotes);
  if (prompt) body.prompt = prompt;
  // Images ride on the first prompt, so they need one: with nothing said,
  // the conversation only brings the computer up and there is no turn to
  // attach them to.
  if (prompt && input.images?.length) body.images = input.images;
  if (input.join) body.sandbox_id = input.join.sandboxId;
  return body;
}

export function buildPrompt(item: WorkItem, prompt: string, includeNotes: boolean): string {
  const body = prompt.trim();
  const notes = includeNotes ? item.notes.trim() : "";
  if (!body && !notes) return "";
  if (!notes) return body;
  const head = `Work item: ${item.title}\n\n${notes}`;
  return body ? `${head}\n\n---\n\n${body}` : head;
}
