/**
 * The skills.sh index, forwarded.
 *
 * ## Why this is a server route and not a `fetch` in the SPA
 *
 * skills.sh sends no `access-control-allow-origin`, so a browser on
 * paddock's origin cannot read it. It answers curl perfectly well, which is
 * exactly the trap: the endpoint looks reachable from anywhere until you try it
 * from a page. Do not "simplify" this back into the browser.
 *
 * ## Why paddock has an index at all
 *
 * Fountain has a verified catalog of MCP servers and none of skills — "Any
 * GitHub repo that ships a SKILL.md works, and Fountain curates no list."
 * skills.sh is the registry the ecosystem actually uses, and it is the CLI
 * Fountain shells out to on the box, so it is the honest place to look things
 * up. It is not Fountain's list and the panel says so.
 *
 * ## What is dropped, and why
 *
 * A `source` or skill id outside `[A-Za-z0-9._/-]` is discarded here rather
 * than shown. Fountain interpolates both into a `bash -lc` command behind
 * `safe_token!`, which *raises* on anything else — so a hit like
 * `pdf-merge-&-split` is not a skill somebody can install, it is a failed
 * provision waiting to happen. Offering it would be offering a broken button.
 *
 * Search failing is not an error. A slow or missing index must never stop
 * somebody typing an `owner/repo` they already know, so every failure answers
 * `{data: [], unavailable: true}` and the panel falls back to the manual form.
 */
import { HttpError, json } from "./http";

/**
 * The index, and where to point it instead.
 *
 * `SKILLS_URL` exists because the mock is supposed to run the whole app
 * offline and this was the one thing that could not: skills.sh is a real
 * host on the internet, and a demo on a plane had a search box that only ever
 * said "did not answer". The mock Fountain serves the same shape at
 * `/api/skills/search`, so pointing this there makes the last piece work with
 * no network at all. It is not a test seam — nothing in the tests uses it.
 */
const UPSTREAM = process.env.SKILLS_URL?.trim() || "https://skills.sh/api/search";
/** skills.sh itself refuses anything shorter. Answer it here rather than asking. */
const MIN_QUERY = 2;

/**
 * Twelve seconds, and the number is measured rather than chosen.
 *
 * skills.sh is slow and not reliably up: six identical requests for `pdf`, a
 * second and a half apart, answered in 2.7s, 4.9s and 7.4s and timed out three
 * times at fifteen. A 5s ceiling — the obvious first guess, and what this had —
 * failed more often than the index actually did, which is the worst way to be
 * wrong: it reports somebody else's search as broken while it is working.
 *
 * So the ceiling is above the slow answers and the panel says plainly when
 * nothing came back. A person waiting twelve seconds for a search box is bad;
 * being told "did not answer" after five while it was about to answer is worse,
 * because the second one is a lie.
 */
const TIMEOUT_MS = 12_000;

/**
 * Ten minutes, for the same reason.
 *
 * The index moves on the order of days, and a call to it costs seconds. A
 * one-minute cache was sized as if the upstream were fast; against this one it
 * expires while somebody is still deciding what to type next.
 */
const CACHE_MS = 10 * 60_000;
const MAX_HITS = 12;

/** Mirrors Fountain's `safe_token!` allow-list. See `src/lib/skills.ts`. */
const SAFE_TOKEN = /^[A-Za-z0-9._/-]+$/;

export interface SkillHit {
  source: string;
  skill: string;
  label: string;
  installs: number;
}

interface Entry {
  at: number;
  hits: SkillHit[];
}

/**
 * A minute of memory, per query.
 *
 * The index changes on the order of days and a person types the same prefix
 * several times while they think. Bounded so a scripted browser cannot grow it
 * without limit — the cap evicts wholesale rather than by age, because an
 * approximate LRU is not worth the code for a cache this size.
 */
const cache = new Map<string, Entry>();
const CACHE_MAX = 200;

/**
 * One upstream call per query at a time.
 *
 * With a call costing seconds, two people searching `pdf` at once — or one
 * person clicking twice — otherwise queue two ten-second waits for the same
 * answer. They share the first one instead.
 *
 * The signal is deliberately *not* shared: a caller who navigates away must not
 * abort the request the other one is still waiting on. See `fetchHits`.
 */
const inFlight = new Map<string, Promise<SkillHit[]>>();

export async function search(req: Request): Promise<Response> {
  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < MIN_QUERY) return json({ data: [] });

  const cached = cache.get(q);
  if (cached && Date.now() - cached.at < CACHE_MS) return json({ data: cached.hits });

  let hits: SkillHit[];
  try {
    let pending = inFlight.get(q);
    if (!pending) {
      pending = fetchHits(q).finally(() => inFlight.delete(q));
      inFlight.set(q, pending);
    }
    hits = await pending;
  } catch (err) {
    // Logged, not raised: the panel has a manual form and the person has an
    // `owner/repo` in their head. A 502 here would take that away from them.
    console.warn(`paddock: skills.sh search failed for ${JSON.stringify(q)}: ${err instanceof Error ? err.message : String(err)}`);
    return json({ data: [], unavailable: true });
  }

  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(q, { at: Date.now(), hits });
  return json({ data: hits });
}

/**
 * The timeout alone, and not the caller's signal.
 *
 * This result is shared by everyone asking the same question, so one browser
 * closing its tab must not cancel the call the others are waiting on. The
 * upstream is slow enough that sharing is the whole point.
 */
async function fetchHits(q: string): Promise<SkillHit[]> {
  const res = await fetch(`${UPSTREAM}?${new URLSearchParams({ q })}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new HttpError(res.status, "skills_upstream", `skills.sh answered ${res.status}`);

  const body = (await res.json()) as { skills?: unknown };
  if (!Array.isArray(body.skills)) return [];

  const out: SkillHit[] = [];
  const seen = new Set<string>();
  for (const raw of body.skills) {
    const hit = readHit(raw);
    if (!hit) continue;
    const key = `${hit.source}#${hit.skill}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
    if (out.length >= MAX_HITS) break;
  }
  return out;
}

/**
 * One upstream row, narrowed.
 *
 * `skillId` and not `name`: `name` is a display string ("pdf merge & split")
 * while `skillId` is the identifier the CLI takes ("pdf-merge-&-split"). Both
 * are third-party text, so both are checked before either is kept.
 */
function readHit(raw: unknown): SkillHit | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as { source?: unknown; skillId?: unknown; name?: unknown; installs?: unknown };

  const source = typeof row.source === "string" ? row.source.trim() : "";
  const skill = typeof row.skillId === "string" ? row.skillId.trim() : "";
  if (!source || !skill) return null;
  if (!SAFE_TOKEN.test(source) || !SAFE_TOKEN.test(skill)) return null;
  if (!source.includes("/")) return null;

  const label = typeof row.name === "string" && row.name.trim() ? row.name.trim() : skill;
  const installs = typeof row.installs === "number" && Number.isFinite(row.installs) ? Math.max(0, Math.floor(row.installs)) : 0;

  return { source, skill, label: label.slice(0, 120), installs };
}
