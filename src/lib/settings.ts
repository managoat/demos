/** The last settings this browser started a chat with, so the next one starts the same way. */
import { modelProblem } from "../../shared/models";
import { DEFAULT_SETTINGS, type ChatSettings } from "../../shared/settings";
import { isSkillId } from "../../shared/skills";

const KEY = "salon.settings";

export function loadSettings(): ChatSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const v = JSON.parse(raw) as Partial<ChatSettings>;
    const model = typeof v.model === "string" && modelProblem(v.model) === null ? v.model : DEFAULT_SETTINGS.model;
    return {
      ...DEFAULT_SETTINGS,
      model,
      skills: Array.isArray(v.skills) ? v.skills.filter(isSkillId) : [],
      connectorIds: Array.isArray(v.connectorIds) ? v.connectorIds.filter((x): x is string => typeof x === "string") : [],
      projectId: typeof v.projectId === "string" && v.projectId ? v.projectId : null,
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
