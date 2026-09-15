import { expect, test } from "bun:test";
import { blockBodyText } from "./acp";

test("structured plan bodies render as text without losing their entries", () => {
  const plan = [{ content: "Migrate callers", status: "completed" as const }];
  expect(JSON.parse(blockBodyText(plan))).toEqual(plan);
  expect(blockBodyText("plain text")).toBe("plain text");
  expect(blockBodyText(null)).toBe("");
});
