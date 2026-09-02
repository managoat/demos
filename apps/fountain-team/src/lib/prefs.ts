/**
 * Per-browser preferences about teammates that Fountain has no field for
 * (after OpenMausBot's bot context menu): pinned rows sort first, muted
 * rows never notify, and "mark as unread" is a local flag that survives
 * until the row is opened. Keyed by agent id, so a fresh conversation for
 * the same teammate keeps its pin. Stored in localStorage; nothing here is
 * secret.
 */

export interface Prefs {
  pinned: string[];
  muted: string[];
  /** agent ids the user marked unread by hand */
  unread: string[];
  /** desktop notifications on for this browser */
  notify: boolean;
  /** the activity sidebar is open */
  activity: boolean;
}

const KEY = "fountain-team.prefs";
export const EMPTY_PREFS: Prefs = { pinned: [], muted: [], unread: [], notify: false, activity: false };

export function loadPrefs(storage: Pick<Storage, "getItem"> = localStorage): Prefs {
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return EMPTY_PREFS;
    return normalizePrefs(JSON.parse(raw));
  } catch {
    return EMPTY_PREFS;
  }
}

export function savePrefs(p: Prefs, storage: Pick<Storage, "setItem"> = localStorage): void {
  storage.setItem(KEY, JSON.stringify(p));
}

export function normalizePrefs(raw: unknown): Prefs {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return { pinned: ids(o.pinned), muted: ids(o.muted), unread: ids(o.unread), notify: o.notify === true, activity: o.activity === true };
}

export function toggleIn(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

export function without(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : list;
}

/** Pinned first (in pin order), then whatever order the rest already had. */
export function sortPinnedFirst<T extends { agent_id: string }>(rows: T[], pinned: string[]): T[] {
  if (!pinned.length) return rows;
  const rank = new Map(pinned.map((id, i) => [id, i]));
  return [...rows].sort((a, b) => {
    const ra = rank.get(a.agent_id);
    const rb = rank.get(b.agent_id);
    if (ra === undefined && rb === undefined) return 0;
    if (ra === undefined) return 1;
    if (rb === undefined) return -1;
    return ra - rb;
  });
}
