/** The library rail: every brief ever produced, searchable by title, newest first. */
import { useMemo, useState } from "react";
import type { BriefThread } from "../lib/protocol";

function when(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function Library(props: {
  threads: BriefThread[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  open: boolean;
}) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return props.threads;
    return props.threads.filter((t) => t.versions.some((v) => v.brief.title.toLowerCase().includes(needle)));
  }, [props.threads, q]);

  return (
    <aside className={props.open ? "rail open" : "rail"}>
      <div className="rail-tools">
        <button className="primary" onClick={() => props.onSelect(null)}>
          New brief
        </button>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search briefs…" aria-label="Search briefs" />
      </div>
      <div className="rail-list">
        {props.threads.length === 0 && <p className="fineprint" style={{ padding: "8px" }}>No briefs yet.</p>}
        {shown.map((t) => {
          const latest = t.versions[t.versions.length - 1]!.brief;
          const meta = [when(latest.written_at), t.versions.length > 1 ? `v${t.versions.length}` : null, t.notes.length > 0 ? `${t.notes.length} note${t.notes.length === 1 ? "" : "s"}` : null]
            .filter(Boolean)
            .join(" · ");
          return (
            <button key={t.id} className={t.id === props.selectedId ? "rail-item active" : "rail-item"} onClick={() => props.onSelect(t.id)}>
              <span className="t">{latest.title}</span>
              {meta && <span className="m">{meta}</span>}
            </button>
          );
        })}
      </div>
    </aside>
  );
}
