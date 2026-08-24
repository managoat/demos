import { expect, test } from "bun:test";
import { fold } from "./turns";
import type { LogEvent, Turn } from "../types";

const turn = (n: number, id: string, at: string): Turn => ({ id, turn_number: n, prompt: `p${n}`, status: "completed", started_at: at });
const ev = (id: number, ts: string, extra: Partial<LogEvent> = {}): LogEvent => ({ id, ts, kind: "output", ...extra });

test("events go to the named turn, else the turn running at the time, else setup", () => {
  const turns = [turn(2, "t2", "2026-01-01T00:02:00Z"), turn(1, "t1", "2026-01-01T00:01:00Z")];
  const events = [
    ev(1, "2026-01-01T00:00:30Z", { kind: "stage", stage: "provision", state: "started" }),
    ev(2, "2026-01-01T00:01:10Z"),
    ev(3, "2026-01-01T00:02:10Z", { turn_id: "t1" }),
    ev(4, "2026-01-01T00:02:20Z", { kind: "stage", stage: "turn", state: "done", data: JSON.stringify({ turn_id: "t2" }) }),
  ];
  const f = fold(events, turns);
  expect(f.setup.map((e) => e.id)).toEqual([1]);
  expect(f.turns.map((g) => g.turn.id)).toEqual(["t1", "t2"]);
  expect(f.turns[0]!.events.map((e) => e.id)).toEqual([2, 3]);
  expect(f.turns[1]!.events.map((e) => e.id)).toEqual([4]);
});

test("no turns yet: everything is setup", () => {
  const f = fold([ev(1, "2026-01-01T00:00:00Z")], []);
  expect(f.setup).toHaveLength(1);
  expect(f.turns).toHaveLength(0);
});
