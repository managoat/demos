/**
 * Fold a conversation's log feed into its turns for a chat view: every event
 * lands on the turn it belongs to, and what came before the first turn
 * (provisioning) is the setup.
 */
import type { LogEvent, Turn } from "../types";

export interface TurnGroup {
  turn: Turn;
  events: LogEvent[];
}

export interface Folded {
  setup: LogEvent[];
  turns: TurnGroup[];
  /** Events after the last turn that name no turn — rare; shown as loose. */
  loose: LogEvent[];
}

export function turnIdOf(ev: LogEvent): string | null {
  if (ev.turn_id) return ev.turn_id;
  if (!ev.data) return null;
  try {
    const v = (JSON.parse(ev.data) as Record<string, unknown>).turn_id;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

export function fold(events: LogEvent[], turns: Turn[]): Folded {
  const ordered = [...turns].sort((a, b) => a.turn_number - b.turn_number);
  const groups = new Map<string, TurnGroup>(ordered.map((t) => [t.id, { turn: t, events: [] }]));
  const starts = ordered.map((t) => ({ id: t.id, at: t.started_at ?? t.inserted_at ?? "" }));
  const setup: LogEvent[] = [];
  const loose: LogEvent[] = [];

  for (const ev of events) {
    const id = turnIdOf(ev);
    if (id && groups.has(id)) {
      groups.get(id)!.events.push(ev);
      continue;
    }
    // No turn named: the last turn that had started when this event was written.
    let owner: string | null = null;
    for (const s of starts) {
      if (s.at && s.at <= ev.ts) owner = s.id;
      else break;
    }
    if (owner) groups.get(owner)!.events.push(ev);
    else if (ordered.length === 0 || ev.ts < (starts[0]?.at ?? "")) setup.push(ev);
    else loose.push(ev);
  }
  return { setup, turns: ordered.map((t) => groups.get(t.id)!), loose };
}

/** The last stage event's one-line summary, for a status line ("provision · started"). */
export function stageLine(events: LogEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.kind === "stage" && ev.stage) return `${ev.stage} · ${ev.state ?? ""}`.trim();
  }
  return null;
}
