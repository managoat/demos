/**
 * The composer's text per conversation, so switching teammates or reloading
 * does not lose a half-written message (after OpenMausBot's drafts).
 */
const PREFIX = "fountain-team.draft.";

export function loadDraft(conversationId: string, storage: Pick<Storage, "getItem"> = localStorage): string {
  try {
    return storage.getItem(PREFIX + conversationId) ?? "";
  } catch {
    return "";
  }
}

export function saveDraft(
  conversationId: string,
  text: string,
  storage: Pick<Storage, "setItem" | "removeItem"> = localStorage,
): void {
  try {
    if (text) storage.setItem(PREFIX + conversationId, text);
    else storage.removeItem(PREFIX + conversationId);
  } catch {
    /* quota or private mode: drafts are a nicety */
  }
}
