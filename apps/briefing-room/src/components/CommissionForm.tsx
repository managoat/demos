/** "What do you need to get up to speed on?" — a form, not a chat. */
import { useState } from "react";
import { DEPTHS, type Depth } from "../lib/spec";

export interface Example {
  topic: string;
  why: string;
  depth: Depth;
}

export const EXAMPLES: Example[] = [
  { topic: "Heat pumps for an older house — how they work, costs, and what to watch for", why: "Deciding whether to replace a dying gas furnace this fall", depth: "standard" },
  { topic: "The EU AI Act — what it actually requires and when", why: "Board asked whether it affects our product", depth: "deep" },
  { topic: "What changed in the mortgage market this year", why: "Considering refinancing", depth: "quick" },
];

export function CommissionForm(props: {
  busy: boolean;
  working: boolean;
  hasBriefs: boolean;
  onCommission: (topic: string, why: string, depth: Depth) => void;
}) {
  const [topic, setTopic] = useState("");
  const [why, setWhy] = useState("");
  const [depth, setDepth] = useState<Depth>("standard");
  const disabled = props.busy || props.working;

  const submit = () => {
    if (!topic.trim() || disabled) return;
    props.onCommission(topic.trim(), why.trim(), depth);
  };

  return (
    <div className="commission">
      <h1>What do you need to get up to speed on?</h1>
      <p className="lede">The researcher reads real sources and comes back with a brief — the answer, its sections, and where every claim came from.</p>
      <label>
        Topic
        <textarea value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. Heat pumps for an older house — costs, savings, what to watch for" autoFocus />
      </label>
      <label>
        Why — what decision is this for? <span className="fineprint">(optional, sharpens the brief)</span>
        <input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="e.g. Deciding whether to replace the furnace this fall" />
      </label>
      <div className="depths">
        {DEPTHS.map((d) => (
          <button key={d.value} className={depth === d.value ? "depth active" : "depth"} onClick={() => setDepth(d.value)}>
            <b>{d.label}</b>
            <span>{d.hint}</span>
          </button>
        ))}
      </div>
      <button className="primary" onClick={submit} disabled={disabled || !topic.trim()}>
        {props.working ? "The researcher is working…" : "Commission the brief"}
      </button>
      {!props.hasBriefs && (
        <div className="examples">
          <h2>Or start with one of these</h2>
          {EXAMPLES.map((ex) => (
            <button key={ex.topic} className="example" onClick={() => !disabled && props.onCommission(ex.topic, ex.why, ex.depth)}>
              {ex.topic}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
