/**
 * The API's types come from the SDK, which generates them from Fountain's
 * OpenAPI document. Nothing here is hand-described.
 */
export type {
  Agent,
  Block,
  ConversationRecord as Conversation,
  ConversationStatus,
  Environment,
  LogEvent,
  Turn,
  Vault,
} from "@agentshit/fountain-sdk";

import type { LogEvent } from "@agentshit/fountain-sdk";

/** A log event off `GET /api/events/stream`, labelled with the conversation it belongs to. */
export interface UserEvent extends LogEvent {
  conversation_id: string;
}
