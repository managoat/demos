/**
 * A layered tree layout for the spawn graph — the web UI drew this with d3;
 * this is the same picture without the dependency. Each node gets a column
 * (x) and a depth (y); edges run parent → child. A node whose parent is not
 * in the set is a root (the tree endpoint is already depth-bounded).
 */
import type { TreeNode } from "../api/types";

export interface Placed {
  node: TreeNode;
  x: number;
  y: number;
}

export interface Layout {
  nodes: Placed[];
  edges: Array<{ from: Placed; to: Placed }>;
  width: number;
  height: number;
}

export const NODE_W = 90;
export const NODE_H = 26;
const GAP_X = 20;
const GAP_Y = 44;
const PAD = 16;

export function layoutTree(nodes: TreeNode[]): Layout {
  const ids = new Set(nodes.map((n) => n.id));
  const children = new Map<string | null, TreeNode[]>();
  for (const n of nodes) {
    const p = n.parent_id && ids.has(n.parent_id) ? n.parent_id : null;
    const arr = children.get(p) ?? [];
    arr.push(n);
    children.set(p, arr);
  }
  const placed = new Map<string, Placed>();
  let col = 0;
  let maxDepth = 0;
  const place = (n: TreeNode, depth: number): Placed => {
    maxDepth = Math.max(maxDepth, depth);
    const kids = children.get(n.id) ?? [];
    let x: number;
    if (kids.length === 0) {
      x = col++;
    } else {
      const ks = kids.map((k) => place(k, depth + 1));
      x = (ks[0]!.x + ks[ks.length - 1]!.x) / 2;
    }
    const p = { node: n, x, y: depth };
    placed.set(n.id, p);
    return p;
  };
  for (const root of children.get(null) ?? []) place(root, 0);

  const sx = (x: number) => PAD + x * (NODE_W + GAP_X);
  const sy = (y: number) => PAD + y * (NODE_H + GAP_Y);
  const out = [...placed.values()].map((p) => ({ ...p, x: sx(p.x), y: sy(p.y) }));
  const byId = new Map(out.map((p) => [p.node.id, p]));
  const edges: Layout["edges"] = [];
  for (const p of out) {
    const parent = p.node.parent_id ? byId.get(p.node.parent_id) : undefined;
    if (parent) edges.push({ from: parent, to: p });
  }
  return {
    nodes: out,
    edges,
    width: PAD * 2 + Math.max(col, 1) * (NODE_W + GAP_X) - GAP_X,
    height: PAD * 2 + (maxDepth + 1) * (NODE_H + GAP_Y) - GAP_Y,
  };
}
