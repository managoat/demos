/**
 * Where paddock points and how it authenticates — see
 * `@managoat/fountain-app/settings`. Stored under `paddock.settings`, in this
 * browser only.
 *
 * Note what is *not* here: which box is yours, which tabs are open, what has
 * been applied to the machine. All of that is read back from Fountain and
 * from the machine itself (`lib/machine.ts`), so clearing this browser costs
 * you a sign-in and nothing else.
 */
import { createSettings } from "@managoat/fountain-app/settings";

export { normalizeBaseUrl } from "@managoat/fountain-app/settings";
export type { Settings } from "@managoat/fountain-app/settings";

export const { loadSettings, saveSettings, clearSettings } = createSettings("paddock");
