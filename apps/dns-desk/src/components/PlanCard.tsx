/** A dns-plan as a reviewable diff, with the decision buttons when it awaits one. */
import type { PlanCard as Card, PlanChange } from "../lib/protocol";

const STATUS_LABEL: Record<Card["status"], string> = {
  awaiting: "awaiting approval",
  approved: "approved — applying",
  applied: "applied",
  failed: "failed",
  rejected: "rejected",
  superseded: "superseded",
};

function changeRow(c: PlanChange, i: number) {
  return (
    <tr key={i} className={`op-${c.op}`}>
      <td className="op">{c.op === "create" ? "+" : c.op === "delete" ? "−" : "±"}</td>
      <td>{c.type}</td>
      <td className="name">{c.name}</td>
      <td className="content">
        {c.op === "update" && c.before ? (
          <>
            <s>{c.before.content}</s> → {c.content}
          </>
        ) : c.op === "delete" && c.before ? (
          <s>{c.before.content}</s>
        ) : (
          c.content
        )}
      </td>
      <td className="ttl">{c.ttl === 1 ? "auto" : c.ttl ?? ""}</td>
      <td>{c.proxied === undefined ? "" : c.proxied ? "proxied" : "DNS only"}</td>
    </tr>
  );
}

export function PlanCardView(props: { card: Card; busy: boolean; onDecide?: (verb: "approve" | "reject", planId: string) => void }) {
  const { card } = props;
  return (
    <div className={`plan status-${card.status}`}>
      <div className="plan-head">
        <span className="plan-zone">{card.plan.zone}</span>
        <span className="plan-id">{card.plan.id}</span>
        <span className={`chip chip-${card.status}`}>{STATUS_LABEL[card.status]}</span>
      </div>
      {card.plan.summary && <p className="plan-summary">{card.plan.summary}</p>}
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th></th>
              <th>Type</th>
              <th>Name</th>
              <th>Content</th>
              <th>TTL</th>
              <th>Proxy</th>
            </tr>
          </thead>
          <tbody>{card.plan.changes.map(changeRow)}</tbody>
        </table>
      </div>
      {card.detail && <p className="plan-detail">{card.detail}</p>}
      {card.status === "awaiting" && props.onDecide && (
        <div className="plan-actions">
          <button className="primary" disabled={props.busy} onClick={() => props.onDecide!("approve", card.plan.id)}>
            Approve
          </button>
          <button className="danger" disabled={props.busy} onClick={() => props.onDecide!("reject", card.plan.id)}>
            Reject
          </button>
        </div>
      )}
    </div>
  );
}
