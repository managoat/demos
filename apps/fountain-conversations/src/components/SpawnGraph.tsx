import { useEffect, useMemo, useRef } from "react";
import { layoutTree, NODE_H, NODE_W } from "../lib/graph";
import { navigate, paths } from "../router";
import { shortId } from "../lib/format";
import type { TreeNode } from "../api/types";

const FILL: Record<string, string> = { ui: "#172554", agent: "#451a03" };
const STROKE: Record<string, string> = { ui: "#3b82f6", agent: "#d97706" };

/** The spawn tree the web UI drew with d3 — nodes by source, the open one glowing, click to jump. */
export function SpawnGraph({ nodes, currentId }: { nodes: TreeNode[]; currentId: string }) {
  const layout = useMemo(() => layoutTree(nodes), [nodes]);
  const ref = useRef<SVGSVGElement>(null);

  // A wide fan-out opens scrolled to the left, with the conversation you are
  // reading somewhere off-screen. Bring it into view.
  useEffect(() => {
    const svg = ref.current;
    const box = svg?.parentElement;
    const me = layout.nodes.find((n) => n.node.id === currentId);
    if (!svg || !box || !me) return;
    box.scrollLeft = Math.max(0, me.x + NODE_W / 2 - box.clientWidth / 2);
    box.scrollTop = Math.max(0, me.y - 20);
  }, [layout, currentId]);

  return (
    <svg ref={ref} className="spawn-graph" viewBox={`0 0 ${layout.width} ${layout.height}`} width={layout.width} height={layout.height} role="img" aria-label="Spawn graph">
      <defs>
        <filter id="cg-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {layout.edges.map((e) => {
        const x1 = e.from.x + NODE_W / 2;
        const y1 = e.from.y + NODE_H;
        const x2 = e.to.x + NODE_W / 2;
        const y2 = e.to.y;
        const my = (y1 + y2) / 2;
        return <path key={`${e.from.node.id}-${e.to.node.id}`} d={`M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`} fill="none" stroke="#334155" strokeWidth={1.5} />;
      })}
      {layout.nodes.map((p) => {
        const current = p.node.id === currentId;
        return (
          <g
            key={p.node.id}
            transform={`translate(${p.x},${p.y})`}
            className="spawn-node"
            onClick={() => !current && navigate(paths.show(p.node.id))}
            style={{ cursor: current ? "default" : "pointer" }}
          >
            <title>
              {p.node.source} · {p.node.status}
            </title>
            <rect
              width={NODE_W}
              height={NODE_H}
              rx={6}
              fill={FILL[p.node.source] ?? "#1c1917"}
              stroke={current ? "#38bdf8" : STROKE[p.node.source] ?? "#52525b"}
              strokeWidth={current ? 2 : 1}
              filter={current ? "url(#cg-glow)" : undefined}
            />
            <text x={NODE_W / 2} y={NODE_H / 2 + 3.5} textAnchor="middle" fontSize={10} fontFamily="ui-monospace, Menlo, monospace" fill="#e4e4e7">
              {shortId(p.node.id)}
            </text>
            {p.node.status === "running" && <circle cx={NODE_W - 6} cy={6} r={3} fill="#10b981" />}
          </g>
        );
      })}
    </svg>
  );
}
