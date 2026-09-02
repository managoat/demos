/** Per-browser view preferences (the server keeps its own for the web UI). */
export type ViewMode = "chat" | "timeline" | "raw";
export type SortKey = "inserted_at" | "last_active_at";

const KEY = "fountain-conversations.prefs";

export interface Prefs {
  viewMode: ViewMode;
  visibleStreams: string[];
  rootsOnly: boolean;
  sort: "activity" | "created";
  /** The index table's sort column and direction. */
  sortBy: SortKey;
  sortDir: "asc" | "desc";
  /** The raw-log page's stream toggles. */
  logStreams: string[];
  /** Sidebar groups the reader collapsed (the rest start open). */
  collapsedGroups: string[];
}

const DEFAULTS: Prefs = {
  viewMode: "chat",
  visibleStreams: ["acp", "stdout", "stderr", "stage"],
  rootsOnly: false,
  sort: "activity",
  sortBy: "inserted_at",
  sortDir: "desc",
  logStreams: ["acp", "stdout", "stderr", "stage"],
  collapsedGroups: ["Past 7 days", "Older"],
};

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePrefs(p: Partial<Prefs>): Prefs {
  const next = { ...loadPrefs(), ...p };
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}
