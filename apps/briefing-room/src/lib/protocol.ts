/**
 * The Briefing Room protocol: how the app reads the researcher.
 *
 * The agent embeds one machine-readable fenced block — ```brief — in its
 * replies, and the app parses it out of the assistant text and renders it as
 * a document. Requests are plain messages in a shape the app composes
 * (`spec.ts` writes them, `parseRequest` reads them back). The conversation
 * is the system of record: everything here is derived from turns, never
 * stored anywhere else.
 */

export interface BriefSection {
  heading: string;
  body_md: string;
}

export interface BriefSource {
  title: string;
  url: string;
  note?: string;
}

export interface Brief {
  /** null when the agent forgot one — the fold substitutes a stable stand-in */
  id: string | null;
  title: string;
  asked?: string;
  tldr: string[];
  sections: BriefSection[];
  sources: BriefSource[];
  caveats: string[];
  depth?: string;
  written_at?: string;
}

export type Request =
  | { kind: "commission"; topic: string; why: string | null; depth: string | null }
  | { kind: "followup"; briefId: string; text: string };

const FENCE = /```brief[^\S\n]*\n([\s\S]*?)```/g;

/** Every well-formed brief block in one reply, in order. Malformed JSON is skipped. */
export function parseBriefs(text: string): Brief[] {
  const out: Brief[] = [];
  for (const m of text.matchAll(FENCE)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1]!);
    } catch {
      continue;
    }
    if (!isObj(parsed)) continue;
    const brief = asBrief(parsed);
    if (brief) out.push(brief);
  }
  return out;
}

/** The reply with brief blocks removed — what an analyst's note shows as prose. */
export function stripBriefs(text: string): string {
  return text.replace(FENCE, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** Read back a prompt the app composed; null for anything else. */
export function parseRequest(prompt: string): Request | null {
  const followup = prompt.match(/^Follow-up on brief (\S+):\s*([\s\S]*)$/);
  if (followup) return { kind: "followup", briefId: followup[1]!, text: followup[2]!.trim() };
  if (!/^Commission a brief\.\s*\n/.test(prompt)) return null;
  const field = (name: string): string | null => {
    const m = prompt.match(new RegExp(`^${name}: (.*)$`, "m"));
    return m ? m[1]!.trim() || null : null;
  };
  const topic = field("Topic");
  if (!topic) return null;
  return { kind: "commission", topic, why: field("Why"), depth: field("Depth") };
}

// ── folding the conversation into the room ──────────────────────────────────

export interface BriefVersion {
  brief: Brief;
  turnIndex: number;
}

export interface AnalystNote {
  /** the follow-up question this answers, when there was one */
  question: string | null;
  text: string;
  turnIndex: number;
}

/** One brief and its life: versions (v1, v2, …) and analyst's notes. */
export interface BriefThread {
  id: string;
  versions: BriefVersion[];
  notes: AnalystNote[];
  /** the last turn that touched this thread, for ordering */
  lastTurnIndex: number;
}

/** A commission whose reply produced no brief block — prose plus a re-ask. */
export interface Orphan {
  topic: string | null;
  text: string;
  turnIndex: number;
}

export interface RoomView {
  /** every brief ever produced, newest activity first */
  threads: BriefThread[];
  orphans: Orphan[];
}

/**
 * Fold a conversation into the library. `turns` is oldest-first; `done` is
 * whether the turn has ended (a running turn's partial reply is neither a
 * note nor an orphan yet).
 *
 * A brief block starts a thread keyed on its id; a later block with the same
 * id is the next version (a revision). A follow-up answered in prose becomes
 * an analyst's note on its thread. A commission answered with no block at
 * all becomes an orphan — the UI renders the prose and offers to re-ask.
 */
export function foldConversation(turns: Array<{ prompt: string; reply: string; done: boolean }>): RoomView {
  const threads = new Map<string, BriefThread>();
  const orphans: Orphan[] = [];

  turns.forEach((turn, i) => {
    const req = parseRequest(turn.prompt);
    const briefs = parseBriefs(turn.reply);

    if (briefs.length > 0) {
      for (const brief of briefs) {
        const id = brief.id ?? `brf-turn-${i}`;
        const thread = threads.get(id);
        if (thread) {
          thread.versions.push({ brief, turnIndex: i });
          thread.lastTurnIndex = i;
        } else {
          threads.set(id, { id, versions: [{ brief, turnIndex: i }], notes: [], lastTurnIndex: i });
        }
      }
      return;
    }

    if (!turn.done) return;
    const prose = stripBriefs(turn.reply);
    if (req?.kind === "followup") {
      const thread = threads.get(req.briefId);
      if (thread && prose) {
        thread.notes.push({ question: req.text || null, text: prose, turnIndex: i });
        thread.lastTurnIndex = i;
      }
      return;
    }
    // A commission (or a re-ask) that came back without a block.
    if (prose || req?.kind === "commission") {
      orphans.push({ topic: req?.kind === "commission" ? req.topic : null, text: prose, turnIndex: i });
    }
  });

  return {
    threads: [...threads.values()].sort((a, b) => b.lastTurnIndex - a.lastTurnIndex),
    orphans,
  };
}

/** The orphan the re-ask banner should point at: only one after all briefs. */
export function latestOrphan(view: RoomView): Orphan | null {
  const last = view.orphans[view.orphans.length - 1];
  if (!last) return null;
  const newestBrief = view.threads[0]?.lastTurnIndex ?? -1;
  return last.turnIndex > newestBrief ? last : null;
}

// ── the progress pane: what the researcher is reading ───────────────────────

const URL_RE = /https?:\/\/[^\s"'<>\\)\]}]+/g;

/**
 * The URLs a turn's tool calls have touched, in order, deduped — derived from
 * the ACP tool chips so the pane shows "reading X", never raw commands.
 * `tools` is the tool blocks' summary+output text (see acp.ts).
 */
export function fetchedUrls(toolTexts: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const text of toolTexts) {
    for (const m of text.matchAll(URL_RE)) {
      const url = m[0]!.replace(/[.,;:]+$/, "");
      if (seen.has(url)) continue;
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

/** A URL as the progress pane shows it: host and path, no scheme, no query. */
export function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname;
    const s = u.host + decodeURIComponent(path);
    return s.length > 72 ? s.slice(0, 71) + "…" : s;
  } catch {
    return url;
  }
}

// ── shape guards: tolerate a sloppy agent, never a crashing UI ─────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.length > 0) : [];
}

function asBrief(v: Record<string, unknown>): Brief | null {
  const title = str(v.title);
  if (!title) return null;
  const sections: BriefSection[] = [];
  if (Array.isArray(v.sections)) {
    for (const s of v.sections) {
      if (!isObj(s)) continue;
      const body = str(s.body_md) ?? str(s.body);
      if (!body) continue;
      sections.push({ heading: str(s.heading) ?? "", body_md: body });
    }
  }
  const sources: BriefSource[] = [];
  if (Array.isArray(v.sources)) {
    for (const s of v.sources) {
      if (!isObj(s)) continue;
      const url = str(s.url);
      if (!url || !/^https?:\/\//.test(url)) continue;
      const source: BriefSource = { title: str(s.title) ?? url, url };
      const note = str(s.note);
      if (note) source.note = note;
      sources.push(source);
    }
  }
  const brief: Brief = {
    id: str(v.id),
    title,
    tldr: strings(v.tldr),
    sections,
    sources,
    caveats: strings(v.caveats),
  };
  const asked = str(v.asked);
  if (asked) brief.asked = asked;
  const depth = str(v.depth);
  if (depth) brief.depth = depth;
  const written = str(v.written_at);
  if (written) brief.written_at = written;
  return brief;
}
