import { describe, expect, test } from "bun:test";
import { loadPrefs, normalizePrefs, savePrefs, sortPinnedFirst, toggleIn } from "./prefs";

describe("prefs", () => {
  test("round-trips through a storage and survives garbage", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    savePrefs({ pinned: ["a"], muted: [], unread: ["b"], notify: true, activity: true }, storage);
    expect(loadPrefs(storage)).toEqual({ pinned: ["a"], muted: [], unread: ["b"], notify: true, activity: true });
    store.set("fountain-team.prefs", "{not json");
    expect(loadPrefs(storage)).toEqual({ pinned: [], muted: [], unread: [], notify: false, activity: false });
    expect(normalizePrefs({ pinned: ["a", 3, null], notify: "yes" })).toEqual({ pinned: ["a"], muted: [], unread: [], notify: false, activity: false });
  });

  test("toggle adds then removes", () => {
    expect(toggleIn([], "a")).toEqual(["a"]);
    expect(toggleIn(["a", "b"], "a")).toEqual(["b"]);
  });

  test("pinned rows sort first in pin order, the rest keep their order", () => {
    const rows = [{ agent_id: "x" }, { agent_id: "b" }, { agent_id: "y" }, { agent_id: "a" }];
    expect(sortPinnedFirst(rows, ["a", "b"]).map((r) => r.agent_id)).toEqual(["a", "b", "x", "y"]);
    expect(sortPinnedFirst(rows, []).map((r) => r.agent_id)).toEqual(["x", "b", "y", "a"]);
  });
});
