/**
 * Fountain runs an *agent*; Salon offers *settings*. This is the seam.
 *
 * A chat starts from a runtime, a model and optionally a preset — one of the
 * host's own agents, which brings its prompt, skills and servers. The rules:
 *
 *   - A preset whose runtime and model are exactly what was picked is used
 *     as it is. "I picked my Coder agent" means Coder, not a copy of Coder.
 *   - Otherwise an agent is derived: a copy of the preset with the model
 *     swapped (or, with no preset, a plain agent on that model), found again
 *     on the next chat by `metadata.salon.key` so the host's agent list does
 *     not grow by one per chat. They are named `Salon · …` and the presets
 *     menu leaves them out.
 *
 * Derived agents also carry a note in the system prompt about the room: a
 * message tagged `[from someone]` was sent by that person (shared/author.ts).
 * A preset used as it is gets only the tag, because its prompt is the host's
 * to write.
 */
import { modelLabel } from "../shared/models";
import { derivedKey, type ChatSettings } from "../shared/settings";
import type { AgentSummary, FountainClient } from "./fountain";
import { HttpError } from "./http";

export const SALON_NOTE =
  "You are chatting in Salon, a shared chat room. Several people may take part. " +
  'A message that begins with "[from someone@example.com]" was sent by that person; ' +
  "address people by name when it helps, and treat everyone in the room as a collaborator. " +
  "Keep replies conversational unless asked for something else.";

/** Agent fields copied onto a derived agent, as Fountain's create request takes them. */
const COPIED: (keyof AgentSummary)[] = [
  "description",
  "environment_id",
  "sandbox_provider",
  "sandbox_mode",
  "permission_policy",
  "skills",
  "mcp_servers",
  "allowed_vault_ids",
  "allowed_environment_ids",
];

export interface Materialised {
  agentId: string;
  presetName: string | null;
  /** True when an agent was created for this pick (rather than found or used as is). */
  created: boolean;
}

export async function agentFor(client: FountainClient, settings: ChatSettings): Promise<Materialised> {
  const agents = await client.agents();
  const preset = settings.presetId ? agents.find((a) => a.id === settings.presetId) ?? null : null;
  if (settings.presetId && !preset) throw new HttpError(404, "preset_not_found", "That preset is not one of your agents any more.");

  if (preset && preset.runtime === settings.runtime && preset.model === settings.model) {
    return { agentId: preset.id, presetName: preset.name, created: false };
  }

  const key = derivedKey(settings);
  const existing = agents.find((a) => salonKey(a) === key);
  if (existing) return { agentId: existing.id, presetName: preset?.name ?? null, created: false };

  const body: Record<string, unknown> = {
    name: (preset ? `Salon · ${preset.name} · ${modelLabel(settings.model)}` : `Salon · ${modelLabel(settings.model)}`).slice(0, 200),
    runtime: settings.runtime,
    model: settings.model,
    system: preset && typeof preset.system === "string" && preset.system.trim() ? `${preset.system.trim()}\n\n${SALON_NOTE}` : SALON_NOTE,
    metadata: { ...(preset?.metadata ?? {}), salon: { key, preset: preset?.id ?? null } },
  };
  if (preset) {
    for (const field of COPIED) {
      const v = preset[field];
      if (v !== undefined && v !== null) body[field] = v;
    }
  }
  const made = await client.createAgent(body);
  return { agentId: made.id, presetName: preset?.name ?? null, created: true };
}

function salonKey(a: AgentSummary): string | null {
  const meta = a.metadata;
  if (!meta || typeof meta !== "object") return null;
  const salon = (meta as { salon?: unknown }).salon;
  if (!salon || typeof salon !== "object") return null;
  const key = (salon as { key?: unknown }).key;
  return typeof key === "string" ? key : null;
}
