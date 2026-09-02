/**
 * Where a full transcript is read.
 *
 * Fountain's own UI is a console: `<base>/conversations/<id>` is a redirect
 * out to the conversations app, and it needs a *browser session* to follow —
 * which someone using this app with an API key may not have. So we ask
 * Fountain where the app is (`GET /api/catalog` → `apps.conversations`) and
 * link straight there.
 *
 * The lookup is cached for the tab and never blocks a click: until it lands,
 * and on any deployment that reports no app, links fall back to the redirect,
 * which still resolves for a signed-in reader.
 */
import type { FountainClient } from "../api/client";

let appUrl: string | null = null;
let asked = false;

/** Ask Fountain where its conversations app is. Safe to call more than once. */
export async function loadTranscriptBase(client: FountainClient): Promise<void> {
  if (asked) return;
  asked = true;
  try {
    const catalog = (await client.getCatalog()) as { apps?: { conversations?: string | null } };
    const url = catalog?.apps?.conversations;
    if (typeof url === "string" && url) appUrl = url.replace(/\/+$/, "") + "/";
  } catch {
    // An older Fountain has no `apps` in its catalog; the fallback covers it.
  }
}

/** The URL to open for a conversation's full transcript. */
export function transcriptUrl(baseUrl: string, conversationId: string): string {
  return appUrl ? `${appUrl}#/c/${conversationId}` : `${baseUrl}/conversations/${conversationId}`;
}

/** Test seam: forget what we learned. */
export function resetTranscriptBase(): void {
  appUrl = null;
  asked = false;
}
