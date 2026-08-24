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

/** As long as a work item's title gets before it stops being a title. */
const TITLE_MAX = 72;

/**
 * Typed text as a work item: the first line names it, the rest is its notes.
 * What you type in the explorer is the whole ask, and none of it is thrown
 * away — the title is what the tree shows, the notes are the briefing every
 * conversation on the item starts with.
 */
export function splitAsk(text: string): { title: string; notes: string } {
  const trimmed = text.trim();
  const br = trimmed.indexOf("\n");
  const first = (br === -1 ? trimmed : trimmed.slice(0, br)).trim();
  const rest = br === -1 ? "" : trimmed.slice(br + 1).trim();
  if (first.length <= TITLE_MAX) return { title: first, notes: rest };
  // A paragraph typed as one line: the title is cut at a word, and the whole
  // of it goes to the notes, so the cut costs nothing.
  const space = first.lastIndexOf(" ", TITLE_MAX);
  const head = first.slice(0, space > TITLE_MAX / 3 ? space : TITLE_MAX).trimEnd();
  return { title: `${head}…`, notes: rest ? `${first}\n\n${rest}` : first };
}

/**
 * What to send when nobody wrote a first prompt of their own: the item is the
 * ask. With notes that is the briefing; with only a title, the title is the
 * words — so "fix foo" on its own still says something to whoever gets it.
 */
export function itemAsPrompt(item: WorkItem): { prompt: string; includeNotes: boolean } {
  return item.notes.trim() ? { prompt: "", includeNotes: true } : { prompt: item.title, includeNotes: false };
}

export function buildPrompt(item: WorkItem, prompt: string, includeNotes: boolean): string {
  const body = prompt.trim();
  const notes = includeNotes ? item.notes.trim() : "";
  if (!body && !notes) return "";
  if (!notes) return body;
  const head = `Work item: ${item.title}\n\n${notes}`;
  return body ? `${head}\n\n---\n\n${body}` : head;
}
