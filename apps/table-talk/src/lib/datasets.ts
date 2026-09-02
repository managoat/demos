/**
 * The left rail's memory: which conversations hold which datasets — an index
 * of ids per Fountain URL, in this browser. The conversations themselves are
 * the system of record; this is only how the app finds them again.
 */

export interface DatasetEntry {
  conversationId: string;
  filename: string;
  rows: number;
  cols: number;
  createdAt: string;
}

const KEY = "table-talk.datasets";

type Index = Record<string, DatasetEntry[]>;

function loadIndex(): Index {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Index) : {};
  } catch {
    return {};
  }
}

export function loadDatasets(baseUrl: string): DatasetEntry[] {
  const list = loadIndex()[baseUrl];
  return Array.isArray(list) ? list.filter((d) => typeof d.conversationId === "string" && typeof d.filename === "string") : [];
}

/** Newest first; re-adding the same conversation replaces its entry. */
export function saveDataset(baseUrl: string, entry: DatasetEntry): DatasetEntry[] {
  const index = loadIndex();
  const rest = (index[baseUrl] ?? []).filter((d) => d.conversationId !== entry.conversationId);
  index[baseUrl] = [entry, ...rest];
  localStorage.setItem(KEY, JSON.stringify(index));
  return index[baseUrl];
}

/** A follow-up landed in a replacement conversation — the dataset moves with it. */
export function repointDataset(baseUrl: string, oldId: string, newId: string): DatasetEntry[] {
  const index = loadIndex();
  index[baseUrl] = (index[baseUrl] ?? []).map((d) => (d.conversationId === oldId ? { ...d, conversationId: newId } : d));
  localStorage.setItem(KEY, JSON.stringify(index));
  return index[baseUrl];
}

export function forgetDataset(baseUrl: string, conversationId: string): DatasetEntry[] {
  const index = loadIndex();
  index[baseUrl] = (index[baseUrl] ?? []).filter((d) => d.conversationId !== conversationId);
  localStorage.setItem(KEY, JSON.stringify(index));
  return index[baseUrl];
}
