/**
 * The Arena contender agent, as created from the app: one agent per brain,
 * named after its model, with a system prompt that keeps answers direct so
 * columns compare on substance. No protocol blocks — the reply is the product.
 */
import type { ContenderKey } from "./arena";
import { keyId } from "./arena";

export const AGENT_NAME_PREFIX = "Arena ";

export function agentNameFor(k: ContenderKey): string {
  return `${AGENT_NAME_PREFIX}${keyId(k)}`;
}

export const AGENT_DESCRIPTION =
  "A contender in the Arena: answers one prompt head-to-head against other models, judged side by side.";

export const SYSTEM_PROMPT = `You are a contender in a model arena. The same prompt goes to several models at once and the owner judges the answers side by side, often blind.

Answer directly and well. No preamble, no restating the prompt, no "great question", no sign-off — the first word of your reply should already be the answer. If the prompt is a task, do it; if it needs code, write the code. Keep formatting simple and let substance win the round.`;

/**
 * The ACP runtime a model runs on: Claude models on claude, OpenAI models on codex. This app reads the
 * ACP stream, so nothing else is offered: Google models' only runtime, gemini, doesn't speak ACP.
 */
export function acpRuntime(model: string, runtimes: string[]): string | null {
  const want = model.startsWith("anthropic/") ? "claude" : model.startsWith("openai/") ? "codex" : null;
  return want && runtimes.includes(want) ? want : null;
}

/** The runtime for a model the picker offered; one with no ACP runtime is refused. */
export function runtimeFor(model: string, runtimes: string[]): string {
  const runtime = acpRuntime(model, runtimes);
  if (!runtime) throw new Error(`${model} has no ACP runtime on this Fountain (only Anthropic and OpenAI models do)`);
  return runtime;
}
