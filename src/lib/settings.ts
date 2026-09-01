/** The last settings this browser started a chat with, so the next one starts the same way. */
import { DEFAULT_SETTINGS, type ChatSettings } from "../../shared/settings";
import { isRuntime } from "../../shared/models";

const KEY = "salon.settings";

export function loadSettings(): ChatSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const v = JSON.parse(raw) as Partial<ChatSettings>;
    return {
      runtime: isRuntime(v.runtime) ? v.runtime : DEFAULT_SETTINGS.runtime,
      model: typeof v.model === "string" && v.model ? v.model : DEFAULT_SETTINGS.model,
      presetId: typeof v.presetId === "string" ? v.presetId : null,
      environmentId: typeof v.environmentId === "string" ? v.environmentId : null,
      vaultId: typeof v.vaultId === "string" ? v.vaultId : null,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(s: ChatSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // fine
  }
}
