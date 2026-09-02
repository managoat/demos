/**
 * Where table-talk points and how it authenticates — see
 * `@managoat/fountain-app/settings`. Stored under `table-talk.settings`, in this
 * browser only.
 */
import { createSettings } from "@managoat/fountain-app/settings";

export { normalizeBaseUrl } from "@managoat/fountain-app/settings";
export type { Settings } from "@managoat/fountain-app/settings";

export const { loadSettings, saveSettings, clearSettings } = createSettings("table-talk");
