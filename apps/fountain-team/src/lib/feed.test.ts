import { describe, expect, test } from "bun:test";
import type { Block } from "./acp";
import { duration, groupBlocks, relativeTime, toolsLabel } from "./feed";

const text = (body: string): Block => ({ kind: "text", body, startedAt: null, endedAt: null });
const thinking = (body: string): Block => ({ kind: "thinking", body, startedAt: null, endedAt: null });

const tool = (name: string, status: "running" | "done" | "error" = "done", summary = ""): Block => ({
  kind: "tool",
  id: name,
  name,
  summary,
  status,
  output: "",
  startedAt: "2026-08-19T10:00:00.000Z",
  endedAt: status === "running" ? null : "2026-08-19T10:00:00.400Z",
});

describe("feed grouping", () => {
  test("folds consecutive tool calls between narration into one row", () => {
    const items = groupBlocks([
      text("Let me look."),
      tool("Read"),
      tool("Grep"),
      tool("Edit", "done", "lib/x.ex"),
      text("Now the tests."),
      tool("Bash", "running", "mix test"),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["text", "tools", "text", "tools"]);
    expect((items[1] as any).tools).toHaveLength(3);
    expect(toolsLabel((items[1] as any).tools)).toEqual({ verb: "Ran", what: "3 tool calls", running: false });
    expect(toolsLabel((items[3] as any).tools)).toEqual({ verb: "Running", what: "Bash mix test", running: true });
  });

  test("drops empty text, keeps thinking as its own item", () => {
    const items = groupBlocks([text("  \n"), thinking("hm"), tool("Read")]);
    expect(items.map((i) => i.kind)).toEqual(["thinking", "tools"]);
  });

  test("durations and relative times", () => {
    expect(duration("2026-08-19T10:00:00.000Z", "2026-08-19T10:00:00.400Z")).toBe("0.4s");
    expect(duration("2026-08-19T10:00:00Z", "2026-08-19T10:00:42Z")).toBe("42s");
    expect(duration("2026-08-19T10:00:00Z", "2026-08-19T10:02:05Z")).toBe("2m 05s");
    expect(duration(null, "2026-08-19T10:00:00Z")).toBeNull();
    const now = new Date("2026-08-19T10:10:00Z");
    expect(relativeTime("2026-08-19T10:09:50Z", now)).toBe("just now");
    expect(relativeTime("2026-08-19T10:05:00Z", now)).toBe("5m ago");
    expect(relativeTime("2026-08-19T07:10:00Z", now)).toBe("3h ago");
  });
});
