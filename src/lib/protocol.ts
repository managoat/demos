/**
 * The Repo Sage protocol: how the app reads the agent.
 *
 * The agent embeds machine-readable fenced blocks in its replies —
 * ```repo-map (the dossier, once per repo after studying) and ```citations
 * (the evidence under an answer) — and the app parses them out of the
 * assistant text. The agent's side of the contract is `spec.ts` — change
 * one, change both.
 */

export interface RepoLanguage {
  name: string;
  /** share of the codebase, 0..1 */
  share: number;
}

export interface RepoComponent {
  name: string;
  /** file or directory, relative to the repo root */
  path: string;
  role?: string;
}

export interface RepoMap {
  repo: string;
  default_branch: string;
  description?: string;
  languages: RepoLanguage[];
  loc?: number;
  components: RepoComponent[];
  entry_points: string[];
  how_it_works?: string;
}

export interface Citation {
  path: string;
  /** lines may be absent: start only, or a file-level citation */
  start?: number;
  end?: number;
  why?: string;
}

export type ProtocolBlock =
  | { kind: "map"; map: RepoMap }
  | { kind: "citations"; citations: Citation[] };

const FENCE = /```(repo-map|citations)[^\S\n]*\n([\s\S]*?)```/g;

/** Every well-formed protocol block in one reply, in order. Malformed JSON is skipped. */
export function parseBlocks(text: string): ProtocolBlock[] {
  const out: ProtocolBlock[] = [];
  for (const m of text.matchAll(FENCE)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[2]!);
    } catch {
      continue;
    }
    if (m[1] === "repo-map") {
      const map = asMap(parsed);
      if (map) out.push({ kind: "map", map });
    } else {
      const citations = asCitations(parsed);
      if (citations.length > 0) out.push({ kind: "citations", citations });
    }
  }
  return out;
}

/** The reply with protocol blocks removed — what the chat bubble shows as prose. */
export function stripBlocks(text: string): string {
  return text.replace(FENCE, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** All citations of one reply, flattened (an answer normally has one block). */
export function citationsOf(text: string): Citation[] {
  return parseBlocks(text).flatMap((b) => (b.kind === "citations" ? b.citations : []));
}

export interface SageView {
  /** the newest repo-map the sage has reported, if any */
  map: RepoMap | null;
  mapTurnIndex: number | null;
}

/** Fold a thread (oldest-first prompt/reply pairs) into the dossier. Newest map wins. */
export function foldThread(turns: Array<{ reply: string }>): SageView {
  let map: RepoMap | null = null;
  let mapTurnIndex: number | null = null;
  turns.forEach((turn, i) => {
    for (const block of parseBlocks(turn.reply)) {
      if (block.kind === "map") {
        map = block.map;
        mapTurnIndex = i;
      }
    }
  });
  return { map, mapTurnIndex };
}

// ── shape guards: tolerate a sloppy agent, never a crashing UI ─────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function asMap(v: unknown): RepoMap | null {
  if (!isObj(v)) return null;
  const repo = str(v.repo);
  const branch = str(v.default_branch);
  if (!repo || !branch) return null;
  const languages: RepoLanguage[] = [];
  if (Array.isArray(v.languages)) {
    for (const l of v.languages) {
      if (!isObj(l)) continue;
      const name = str(l.name);
      const share = num(l.share);
      if (name) languages.push({ name, share: share !== undefined && share >= 0 ? share : 0 });
    }
  }
  const components: RepoComponent[] = [];
  if (Array.isArray(v.components)) {
    for (const c of v.components) {
      if (!isObj(c)) continue;
      const name = str(c.name);
      const path = str(c.path);
      if (!name || !path) continue;
      const comp: RepoComponent = { name, path };
      const role = str(c.role);
      if (role) comp.role = role;
      components.push(comp);
    }
  }
  const entryPoints = Array.isArray(v.entry_points)
    ? v.entry_points.filter((e): e is string => typeof e === "string" && e.length > 0)
    : [];
  const map: RepoMap = { repo, default_branch: branch, languages, components, entry_points: entryPoints };
  const description = str(v.description);
  if (description) map.description = description;
  const loc = num(v.loc);
  if (loc !== undefined) map.loc = loc;
  const how = str(v.how_it_works);
  if (how) map.how_it_works = how;
  return map;
}

function asCitations(v: unknown): Citation[] {
  if (!Array.isArray(v)) return [];
  const out: Citation[] = [];
  for (const c of v) {
    if (!isObj(c)) continue;
    const path = str(c.path);
    if (!path) continue;
    const cite: Citation = { path: path.replace(/^\/+/, "") };
    const start = num(c.start);
    const end = num(c.end);
    if (start !== undefined && start > 0) {
      cite.start = Math.floor(start);
      if (end !== undefined && end >= start) cite.end = Math.floor(end);
    }
    const why = str(c.why);
    if (why) cite.why = why;
    out.push(cite);
  }
  return out;
}
