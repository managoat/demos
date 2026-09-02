import { expect, test } from "bun:test";
import { layoutTree } from "./graph";

test("layoutTree centres a parent over its children and links them", () => {
  const l = layoutTree([
    { id: "r", source: "ui", status: "idle", parent_id: null },
    { id: "a", source: "agent", status: "idle", parent_id: "r" },
    { id: "b", source: "agent", status: "running", parent_id: "r" },
    { id: "c", source: "agent", status: "idle", parent_id: "b" },
  ]);
  const at = (id: string) => l.nodes.find((n) => n.node.id === id)!;
  expect(at("r").y).toBeLessThan(at("a").y);
  expect(at("a").y).toBe(at("b").y);
  expect(at("c").y).toBeGreaterThan(at("b").y);
  expect(at("r").x).toBe((at("a").x + at("b").x) / 2);
  expect(l.edges.map((e) => `${e.from.node.id}>${e.to.node.id}`).sort()).toEqual(["b>c", "r>a", "r>b"]);
  expect(l.width).toBeGreaterThan(0);
  expect(l.height).toBeGreaterThan(0);
});

test("a node whose parent is outside the set is a root", () => {
  const l = layoutTree([{ id: "x", source: "ui", status: "idle", parent_id: "gone" }]);
  expect(l.nodes).toHaveLength(1);
  expect(l.edges).toHaveLength(0);
});
