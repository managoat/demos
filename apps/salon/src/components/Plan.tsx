import { useEffect, useMemo, useState, type ReactNode } from "react";
import { shortName } from "../../shared/author";
import type { CommentDto } from "../../shared/comments";
import type { PresencePersonDto, ViewingMode } from "../../shared/control";
import {
  approvalIsCurrent,
  completeConformance,
  conformanceCounts,
  dependencyReadyNodes,
  exceptionReviewReasons,
  scopeDrift,
  sensitiveChangedFiles,
  type AcceptanceCriterionDto,
  type PlanApprovalDto,
  type PlanDocument,
  type PlanEventDto,
  type PlanExecutionDto,
  type PlanNodeDto,
  type PlanNodeStatus,
  type PlanProposalDto,
} from "../../shared/plans";
import { Avatar } from "./Avatar";
import "./Plan.css";

/** The authoritative document plus its durable review and execution records. */
export interface PlanViewPlan extends PlanDocument {
  events: PlanEvent[];
  approvals: PlanApprovalDto[];
  executions: PlanExecutionDto[];
  comments: CommentDto[];
  proposals: PlanProposalDto[];
}

type PlanEvent = PlanEventDto;
type ViewNode = PlanNodeDto & { dependencies: string[] };
export type PlanNodePatch = Partial<Pick<PlanNodeDto, "outcome" | "description" | "acceptanceCriteria" | "declaredScope" | "order">> & { dependencies?: string[] };

export interface PlanViewProps {
  plan: PlanViewPlan | null;
  me: string;
  hostEmail: string;
  /** Historical revisions are read-only. */
  readOnly?: boolean;
  busy?: boolean;
  drafting?: boolean;
  running?: boolean;
  onClose?: () => void;
  onDraft?: () => Promise<void> | void;
  onPatchPlan?: (patch: { title: string; outcome: string; description: string }) => Promise<void> | void;
  onPatchNode?: (nodeId: string, patch: PlanNodePatch) => Promise<void> | void;
  onAddNode?: () => Promise<void> | void;
  onRemoveNode?: (nodeId: string) => Promise<void> | void;
  onMoveNode?: (nodeId: string, direction: -1 | 1) => Promise<void> | void;
  onComment?: (nodeId: string, field: string | null, body: string) => Promise<void> | void;
  onResolveComment?: (commentId: string, resolved: boolean) => Promise<void> | void;
  onDeleteComment?: (commentId: string) => Promise<void> | void;
  onSendFeedback?: () => Promise<void> | void;
  onApprove?: (revision: number) => Promise<void> | void;
  onSupport?: (revision: number) => Promise<void> | void;
  onRun?: () => Promise<void> | void;
  onViewRevision?: (revision: number | null) => Promise<void> | void;
  onOpenEvidence?: (execution: PlanExecutionDto) => void;
  onDecideProposal?: (proposalId: string, decision: "apply" | "dismiss") => Promise<void> | void;
  presence?: PresencePersonDto[];
  onViewing?: (nodeId: string | null, field: string | null, mode: ViewingMode) => void;
}

type View = "outline" | "graph" | "history";

export function PlanView(props: PlanViewProps) {
  const { plan, me, hostEmail } = props;
  const [view, setView] = useState<View>("outline");
  const [selectedExecution, setSelectedExecution] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [editingPlan, setEditingPlan] = useState(false);
  const [planTitle, setPlanTitle] = useState("");
  const [planOutcome, setPlanOutcome] = useState("");
  const [planDescription, setPlanDescription] = useState("");

  useEffect(() => {
    if (!plan || editingPlan) return;
    setPlanTitle(plan.plan.title);
    setPlanOutcome(plan.plan.outcome);
    setPlanDescription(plan.plan.description);
  }, [plan?.plan.updatedAt, editingPlan]);

  const act = async (key: string, fn: (() => Promise<void> | void) | undefined) => {
    if (!fn || acting) return;
    setActing(key);
    setProblem(null);
    try {
      await fn();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "That did not work.");
    } finally {
      setActing(null);
    }
  };

  if (!plan) {
    return (
      <aside className="plan-pane" aria-label="Plan">
        <PlanHead title="Plan" revision={null} view={view} onView={setView} onClose={props.onClose} />
        <div className="plan-empty">
          <span className="plan-empty-mark" aria-hidden="true">◇</span>
          <h3>Agree on the work before it starts.</h3>
          <p>Draft an editable plan, review it together, then approve the exact revision everyone can see.</p>
          {props.onDraft && (
            <button type="button" className="primary" disabled={props.busy || props.drafting} onClick={() => void act("draft", props.onDraft)}>
              {props.drafting || acting === "draft" ? "Drafting…" : "Draft a plan"}
            </button>
          )}
          {problem && <p className="error small">{problem}</p>}
        </div>
      </aside>
    );
  }

  const nodes: ViewNode[] = [...plan.nodes]
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((node) => ({ ...node, dependencies: plan.edges.filter((edge) => edge.toNodeId === node.id).map((edge) => edge.fromNodeId) }));
  const openComments = plan.comments.filter((comment) => !comment.resolvedAt);
  const unsentComments = openComments.filter((comment) => !comment.sentAt);
  const validApproval = plan.approvals.find((approval) => approvalIsCurrent(approval, plan.plan));
  const mySupport = plan.approvals.find((approval) => approval.kind === "support" && approval.revision === plan.plan.revision && !approval.invalidatedAt && approval.actor === me);
  const selected = plan.executions.find((execution) => execution.id === selectedExecution) ?? latestExecution(plan.executions);
  const editable = !props.readOnly && !props.running && !!props.onPatchNode;
  const ready = dependencyReadyNodes(plan);

  return (
    <aside className="plan-pane" aria-label={`Plan revision ${plan.plan.revision}`}>
      <PlanHead title={plan.plan.title || "Plan"} revision={plan.plan.revision} view={view} onView={setView} onClose={props.onClose} />

      <div className="plan-summary">
        <div className="plan-summary-copy">
          <strong>{nodes.length} node{nodes.length === 1 ? "" : "s"}</strong>
          <span>{completeCount(nodes)} complete</span>
          <span>{openComments.length} unresolved</span>
        </div>
        <div className="plan-approval-state">
          {validApproval ? (
            <span className="plan-approved">✓ Approved by {validApproval.actor === me ? "you" : shortName(validApproval.actor)}</span>
          ) : (
            <span className="plan-unapproved">Not approved for this revision</span>
          )}
          {plan.approvals.some((approval) => !!approval.invalidatedAt) && <span className="muted tiny">Earlier approval invalidated by edits</span>}
        </div>
      </div>
      {editingPlan ? (
        <div className="plan-intent plan-node-editor">
          <label>Title<input value={planTitle} onChange={(event) => setPlanTitle(event.target.value)} /></label>
          <label>Outcome<textarea rows={2} value={planOutcome} onChange={(event) => setPlanOutcome(event.target.value)} /></label>
          <label>Description<textarea rows={3} value={planDescription} onChange={(event) => setPlanDescription(event.target.value)} /></label>
          <div className="row"><button type="button" className="small ghost" onClick={() => setEditingPlan(false)}>Cancel</button><button type="button" className="small primary" disabled={!planTitle.trim() || !!acting} onClick={() => void act("plan-fields", async () => { await props.onPatchPlan?.({ title: planTitle.trim(), outcome: planOutcome.trim(), description: planDescription.trim() }); setEditingPlan(false); })}>Save plan</button></div>
        </div>
      ) : (plan.plan.outcome || plan.plan.description || editable) && (
        <div className="plan-intent">
          {plan.plan.outcome && <strong>{plan.plan.outcome}</strong>}
          {plan.plan.description && <span>{plan.plan.description}</span>}
          {editable && props.onPatchPlan && <button type="button" className="linklike tiny" onClick={() => setEditingPlan(true)}>Edit plan details</button>}
        </div>
      )}

      {problem && <div className="plan-problem">{problem}</div>}

      {plan.proposals.filter((proposal) => proposal.status === "pending").map((proposal) => (
        <div className="plan-proposal" key={proposal.id}>
          <div><strong>{proposal.author === me ? "Your" : `${shortName(proposal.author)}’s`} proposed revision</strong><span>{proposal.operations.length} operation{proposal.operations.length === 1 ? "" : "s"} against revision {proposal.baseRevision}; nothing has changed yet.</span><details><summary>Review operations</summary><ul>{proposal.operations.map((operation) => <li key={operation.id}>{operationLabel(operation)}</li>)}</ul></details></div>
          {props.onDecideProposal && <><button type="button" className="small ghost" onClick={() => void act(`dismiss-${proposal.id}`, () => props.onDecideProposal?.(proposal.id, "dismiss"))}>Dismiss</button><button type="button" className="small primary" onClick={() => void act(`apply-${proposal.id}`, () => props.onDecideProposal?.(proposal.id, "apply"))}>Apply</button></>}
        </div>
      ))}

      {view === "outline" && (
        <div className="plan-scroll">
          <div className="plan-toolbar">
            {props.onDraft && (
              <button type="button" className="small ghost" disabled={props.busy || props.drafting || props.readOnly} onClick={() => void act("draft", props.onDraft)}>
                {props.drafting || acting === "draft" ? "Drafting…" : "Draft revision"}
              </button>
            )}
            {props.onAddNode && (
              <button type="button" className="small ghost" disabled={!editable || !!acting} onClick={() => void act("add", props.onAddNode)}>
                + Add node
              </button>
            )}
            <span className="plan-toolbar-space" />
            {unsentComments.length > 0 && props.onSendFeedback && (
              <button type="button" className="small" disabled={props.busy || !!acting} onClick={() => void act("feedback", props.onSendFeedback)} title="Sends one attributed model turn.">
                {acting === "feedback" ? "Sending…" : `Send feedback (${unsentComments.length})`}
              </button>
            )}
          </div>

          <div className="plan-outline">
            {nodes.map((node, index) => (
              <NodeCard
                key={node.id}
                node={node}
                index={index}
                allNodes={nodes}
                comments={plan.comments.filter((comment) => comment.planNodeId === node.id)}
                executions={plan.executions.filter((execution) => execution.nodeId === node.id)}
                me={me}
                host={me === props.hostEmail}
                editable={editable}
                first={index === 0}
                last={index === nodes.length - 1}
                onPatch={props.onPatchNode}
                onMove={props.onMoveNode}
                onRemove={props.onRemoveNode}
                onComment={props.onComment}
                onResolveComment={props.onResolveComment}
                onDeleteComment={props.onDeleteComment}
                onSelectExecution={setSelectedExecution}
                presence={props.presence?.filter((person) => person.viewing?.nodeId === node.id) ?? []}
                onViewing={props.onViewing}
              />
            ))}
          </div>

          {selected && <ExecutionCard execution={selected} node={nodes.find((node) => node.id === selected.nodeId)} onOpenEvidence={props.onOpenEvidence} />}
        </div>
      )}

      {view === "graph" && <PlanGraph nodes={nodes} edges={plan.edges} onSelect={(id) => { setView("outline"); window.setTimeout(() => document.getElementById(`plan-node-${id}`)?.scrollIntoView({ block: "center" }), 0); }} />}
      {view === "history" && <PlanHistory plan={plan} me={me} onViewRevision={props.onViewRevision} />}

      <footer className="plan-actions">
        <div className="plan-support">
          {me === hostEmail ? (
            <button type="button" className={validApproval ? "small" : "small primary"} disabled={props.readOnly || !!validApproval || !props.onApprove || !!acting} onClick={() => void act("approve", () => props.onApprove?.(plan.plan.revision))}>
              {validApproval ? "Approved" : acting === "approve" ? "Approving…" : `Approve revision ${plan.plan.revision}`}
            </button>
          ) : (
            <button type="button" className="small" disabled={props.readOnly || !!mySupport || !props.onSupport || !!acting} onClick={() => void act("support", () => props.onSupport?.(plan.plan.revision))}>
              {mySupport ? "Supported" : acting === "support" ? "Supporting…" : "Support this revision"}
            </button>
          )}
          <Supporters approvals={plan.approvals.filter((approval) => !approval.invalidatedAt && approval.revision === plan.plan.revision)} />
        </div>
        {props.onRun && (
          <button type="button" className="primary" disabled={!validApproval || ready.length === 0 || props.running || props.busy || props.readOnly || !!acting} onClick={() => void act("run", props.onRun)} title={!validApproval ? "The host must approve this exact revision first." : ready.length === 0 ? "No dependency-ready node remains." : "Runs the next dependency-ready node as one turn."}>
            {props.running || acting === "run" ? "Running one node…" : "Run approved plan"}
          </button>
        )}
      </footer>
    </aside>
  );
}

function PlanHead({ title, revision, view, onView, onClose }: { title: string; revision: number | null; view: View; onView: (view: View) => void; onClose?: () => void }) {
  return (
    <header className="plan-head">
      <div className="plan-title">
        <h3>{title}</h3>
        {revision !== null && <span className="tag">revision {revision}</span>}
      </div>
      <nav className="plan-tabs" aria-label="Plan views">
        {(["outline", "graph", "history"] as const).map((item) => (
          <button key={item} type="button" className={view === item ? "on" : ""} onClick={() => onView(item)} aria-pressed={view === item}>
            {item[0]!.toUpperCase() + item.slice(1)}
          </button>
        ))}
      </nav>
      {onClose && <button type="button" className="icon" onClick={onClose} aria-label="Close plan">×</button>}
    </header>
  );
}

function NodeCard({ node, index, allNodes, comments, executions, me, host, editable, first, last, onPatch, onMove, onRemove, onComment, onResolveComment, onDeleteComment, onSelectExecution, presence, onViewing }: {
  node: ViewNode;
  index: number;
  allNodes: ViewNode[];
  comments: CommentDto[];
  executions: PlanExecutionDto[];
  me: string;
  host: boolean;
  editable: boolean;
  first: boolean;
  last: boolean;
  onPatch?: PlanViewProps["onPatchNode"];
  onMove?: PlanViewProps["onMoveNode"];
  onRemove?: PlanViewProps["onRemoveNode"];
  onComment?: PlanViewProps["onComment"];
  onResolveComment?: PlanViewProps["onResolveComment"];
  onDeleteComment?: PlanViewProps["onDeleteComment"];
  onSelectExecution: (id: string) => void;
  presence: PresencePersonDto[];
  onViewing?: PlanViewProps["onViewing"];
}) {
  const [editing, setEditing] = useState(false);
  const [outcome, setOutcome] = useState(node.outcome);
  const [description, setDescription] = useState(node.description);
  const [criteria, setCriteria] = useState<AcceptanceCriterionDto[]>(node.acceptanceCriteria);
  const [dependencies, setDependencies] = useState(node.dependencies);
  const [scope, setScope] = useState(node.declaredScope.join("\n"));
  const [commentField, setCommentField] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const execution = latestExecution(executions);
  const open = comments.filter((comment) => !comment.resolvedAt);

  useEffect(() => {
    if (editing) return;
    setOutcome(node.outcome);
    setDescription(node.description);
    setCriteria(node.acceptanceCriteria);
    setDependencies(node.dependencies);
    setScope(node.declaredScope.join("\n"));
  }, [node.updatedAt, editing]); // stable key preserves an in-progress edit during remote updates

  const save = async () => {
    if (!onPatch || saving) return;
    setSaving(true);
    setProblem(null);
    try {
      await onPatch(node.id, {
        outcome: outcome.trim(),
        description: description.trim(),
        acceptanceCriteria: criteria.map((criterion) => ({ ...criterion, text: criterion.text.trim() })).filter((criterion) => criterion.text),
        dependencies,
        declaredScope: scope.split("\n").map((path) => path.trim()).filter(Boolean),
      });
      setEditing(false);
      onViewing?.(node.id, null, "viewing");
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "The node could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    setOutcome(node.outcome);
    setDescription(node.description);
    setCriteria(node.acceptanceCriteria);
    setDependencies(node.dependencies);
    setScope(node.declaredScope.join("\n"));
    setEditing(false);
    onViewing?.(node.id, null, "viewing");
    setProblem(null);
  };

  return (
    <article className={`plan-node status-${node.status}`} id={`plan-node-${node.id}`} onMouseEnter={() => onViewing?.(node.id, null, editing ? "editing" : "viewing")} onMouseLeave={() => onViewing?.(null, null, "viewing")} onFocusCapture={() => onViewing?.(node.id, null, editing ? "editing" : "viewing")} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) onViewing?.(null, null, "viewing"); }}>
      <div className="plan-node-rail">
        <span className="plan-node-number">{index + 1}</span>
        {!last && <span className="plan-node-line" />}
      </div>
      <div className="plan-node-card">
        <header className="plan-node-head">
          <Status status={node.status} />
          <code title={`Stable node ID: ${node.id}`}>{shortId(node.id)}</code>
          <span className="plan-node-spacer" />
          {open.length > 0 && <span className="plan-comment-count">{open.length} unresolved</span>}
          {presence.length > 0 && <span className="plan-node-presence" title={presence.map((person) => `${person.email} is ${person.viewing?.mode ?? "viewing"}`).join("\n")}>{presence.slice(0, 3).map((person) => <Avatar key={person.email} email={person.email} size={18} />)}</span>}
          {editable && !editing && (
            <button type="button" className="linklike tiny" onClick={() => { setEditing(true); onViewing?.(node.id, null, "editing"); }}>Edit</button>
          )}
        </header>

        {editing ? (
          <div className="plan-node-editor">
            <label>Outcome<input value={outcome} onChange={(event) => setOutcome(event.target.value)} /></label>
            <label>Description<textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
            <fieldset>
              <legend>Acceptance criteria</legend>
              {criteria.map((criterion, criterionIndex) => (
                <div className="plan-criterion-edit" key={criterion.id}>
                  <span>{criterionIndex + 1}</span>
                  <input value={criterion.text} onChange={(event) => setCriteria((current) => current.map((item) => item.id === criterion.id ? { ...item, text: event.target.value } : item))} />
                  <button type="button" className="icon" aria-label="Remove criterion" onClick={() => setCriteria((current) => current.filter((item) => item.id !== criterion.id))}>×</button>
                </div>
              ))}
              <button type="button" className="small ghost" onClick={() => setCriteria((current) => [...current, { id: `criterion-${crypto.randomUUID()}`, text: "" }])}>+ Criterion</button>
            </fieldset>
            <fieldset>
              <legend>Depends on</legend>
              <div className="plan-dependency-options">
                {allNodes.filter((candidate) => candidate.id !== node.id).map((candidate) => (
                  <label key={candidate.id}>
                    <input type="checkbox" checked={dependencies.includes(candidate.id)} onChange={(event) => setDependencies((current) => event.target.checked ? [...current, candidate.id] : current.filter((id) => id !== candidate.id))} />
                    <span>{candidate.outcome || shortId(candidate.id)}</span>
                  </label>
                ))}
                {allNodes.length === 1 && <span className="muted small">No other nodes.</span>}
              </div>
            </fieldset>
            <label>Declared file scope <span className="muted">(one path per line)</span><textarea rows={2} value={scope} onChange={(event) => setScope(event.target.value)} placeholder="src/components/Plan.tsx" /></label>
            {problem && <div className="error small">{problem}</div>}
            <div className="plan-editor-actions">
              {onMove && <button type="button" className="small ghost" disabled={first || saving} onClick={() => void onMove(node.id, -1)}>Move up</button>}
              {onMove && <button type="button" className="small ghost" disabled={last || saving} onClick={() => void onMove(node.id, 1)}>Move down</button>}
              {onRemove && <button type="button" className="small ghost plan-danger" disabled={saving} onClick={() => void onRemove(node.id)}>Remove</button>}
              <span className="plan-toolbar-space" />
              <button type="button" className="small ghost" disabled={saving} onClick={reset}>Cancel</button>
              <button type="button" className="small primary" disabled={saving || !outcome.trim()} onClick={() => void save()}>{saving ? "Saving…" : "Save node"}</button>
            </div>
          </div>
        ) : (
          <>
            <h4>{node.outcome}</h4>
            {node.description && <p className="plan-node-description">{node.description}</p>}
            <section className="plan-criteria">
              <h5>Done when</h5>
              {node.acceptanceCriteria.length === 0 ? <p className="muted small">No acceptance criteria yet.</p> : (
                <ul>{node.acceptanceCriteria.map((criterion) => <li key={criterion.id}>{criterion.text}</li>)}</ul>
              )}
            </section>
            <NodeMeta node={node} allNodes={allNodes} />
          </>
        )}

        {execution && <ExecutionSummary execution={execution} onClick={() => onSelectExecution(execution.id)} />}

        <div className="plan-comments">
          {comments.map((comment) => (
            <PlanComment key={comment.id} comment={comment} me={me} canDelete={host || comment.author === me} onResolve={onResolveComment} onDelete={onDeleteComment} />
          ))}
          {onComment && !editing && (
            commentField !== null ? (
              <CommentComposer nodeId={node.id} field={commentField === "node" ? null : commentField} onComment={onComment} onClose={() => setCommentField(null)} />
            ) : (
              <div className="plan-comment-buttons">
                <button type="button" className="linklike tiny" onClick={() => setCommentField("node")}>Comment on node</button>
                <button type="button" className="linklike tiny" onClick={() => setCommentField("acceptanceCriteria")}>Comment on criteria</button>
              </div>
            )
          )}
        </div>
      </div>
    </article>
  );
}

function NodeMeta({ node, allNodes }: { node: ViewNode; allNodes: ViewNode[] }) {
  const names = new Map(allNodes.map((candidate) => [candidate.id, candidate.outcome]));
  return (
    <div className="plan-node-meta">
      <div><span>Depends on</span>{node.dependencies.length ? node.dependencies.map((id) => <a key={id} href={`#plan-node-${id}`}>{names.get(id) ?? shortId(id)}</a>) : <em>Nothing</em>}</div>
      <div><span>Scope</span>{node.declaredScope.length ? node.declaredScope.map((path) => <code key={path}>{path}</code>) : <em>Not declared</em>}</div>
    </div>
  );
}

function Status({ status }: { status: PlanNodeStatus }) {
  const label = status === "ready" ? "Ready" : status[0]!.toUpperCase() + status.slice(1);
  return <span className={`plan-status plan-status-${status}`}><i />{label}</span>;
}

function PlanComment({ comment, me, canDelete, onResolve, onDelete }: { comment: CommentDto; me: string; canDelete: boolean; onResolve?: PlanViewProps["onResolveComment"]; onDelete?: PlanViewProps["onDeleteComment"] }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const perform = async (fn: (() => Promise<void> | void) | undefined) => {
    if (!fn || busy) return;
    setBusy(true);
    try { setProblem(null); await fn(); }
    catch (error) { setProblem(error instanceof Error ? error.message : "The comment could not be changed."); }
    finally { setBusy(false); }
  };
  return (
    <div className={`plan-comment${comment.resolvedAt ? " resolved" : ""}`}>
      <Avatar email={comment.author} size={21} />
      <div>
        <div className="plan-comment-meta"><strong>{comment.author === me ? "You" : shortName(comment.author)}</strong><span>{dateWord(comment.createdAt)}</span>{comment.planField && <span className="tag">{fieldLabel(comment.planField)}</span>}</div>
        <p>{comment.body}</p>
        <div className="plan-comment-actions">
          {onResolve && <button type="button" className="linklike tiny" disabled={busy} onClick={() => void perform(() => onResolve(comment.id, !comment.resolvedAt))}>{comment.resolvedAt ? "Reopen" : "Resolve"}</button>}
          {onDelete && canDelete && !comment.sentAt && <button type="button" className="linklike tiny" disabled={busy} onClick={() => void perform(() => onDelete(comment.id))}>Remove</button>}
          {comment.sentAt && <span className="muted tiny">sent</span>}
        </div>
        {problem && <span className="error-text tiny">{problem}</span>}
      </div>
    </div>
  );
}

function CommentComposer({ nodeId, field, onComment, onClose }: { nodeId: string; field: string | null; onComment: NonNullable<PlanViewProps["onComment"]>; onClose: () => void }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async () => {
    if (!body.trim() || busy) return;
    setBusy(true);
    try {
      setProblem(null);
      await onComment(nodeId, field, body.trim());
      onClose();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The comment could not be added.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="plan-comment-compose">
      <textarea rows={2} autoFocus value={body} onChange={(event) => setBody(event.target.value)} placeholder={field ? `Feedback on ${fieldLabel(field)}` : "Feedback on this node"} />
      {problem && <span className="error-text tiny">{problem}</span>}
      <div><button type="button" className="small ghost" onClick={onClose}>Cancel</button><button type="button" className="small primary" disabled={!body.trim() || busy} onClick={() => void submit()}>{busy ? "Adding…" : "Add comment"}</button></div>
    </div>
  );
}

function ExecutionSummary({ execution, onClick }: { execution: PlanExecutionDto; onClick: () => void }) {
  const counts = conformanceCounts(execution.criterionResults);
  return (
    <button type="button" className={`plan-execution-summary execution-${execution.status}`} onClick={onClick}>
      <span className="plan-execution-icon">{execution.status === "completed" ? "✓" : execution.status === "running" ? "◌" : execution.status === "queued" ? "○" : "!"}</span>
      <span><strong>{execution.status === "running" ? "Running now" : `Execution ${execution.status}`}</strong><small>{counts.pass} pass · {counts.fail} fail · {counts.unknown} unknown</small></span>
      <span aria-hidden="true">›</span>
    </button>
  );
}

function ExecutionCard({ execution, node, onOpenEvidence }: { execution: PlanExecutionDto; node?: ViewNode; onOpenEvidence?: PlanViewProps["onOpenEvidence"] }) {
  const startHead = execution.starting.head;
  const endHead = execution.ending?.head;
  const files = execution.changedFiles;
  const criteria = node ? completeConformance(node, execution.criterionResults) : execution.criterionResults;
  const drift = execution.scopeDrift ?? (node ? scopeDrift(files, node.declaredScope) : []);
  const sensitive = execution.sensitiveFiles ?? sensitiveChangedFiles(files);
  const exceptions = execution.exceptionReasons ?? exceptionReviewReasons(criteria, drift, sensitive);
  return (
    <section className="plan-execution">
      <header>
        <div><span className="tag">one-node execution</span><h4>{node?.outcome ?? shortId(execution.nodeId)}</h4></div>
        <Status status={execution.status === "queued" ? "pending" : execution.status === "interrupted" ? "failed" : execution.status as PlanNodeStatus} />
      </header>
      <dl>
        <div><dt>Launched by</dt><dd>{shortName(execution.launchedBy)}</dd></div>
        <div><dt>Plan</dt><dd>Revision {execution.planRevision}</dd></div>
        <div><dt>Binding</dt><dd>Turn {execution.turnId ? shortId(execution.turnId) : `after submission ${execution.submissionSequence}`} {execution.turnBinding && <span className="muted">({execution.turnBinding})</span>}</dd></div>
        <div><dt>Boundary</dt><dd><code>{startHead ? shortId(startHead) : "unknown"}</code> → <code>{endHead ? shortId(endHead) : execution.status === "running" ? "running" : "unknown"}</code></dd></div>
        <div><dt>Branch</dt><dd>{execution.ending?.branch || execution.starting.branch || "unknown"}</dd></div>
        <div><dt>Snapshots</dt><dd>{execution.starting.changesSeq ?? "—"} → {execution.ending?.changesSeq ?? "—"}</dd></div>
      </dl>
      {execution.summary && <p className="plan-result-summary">{execution.summary}</p>}
      {execution.error && <div className="plan-exception"><strong>Execution error</strong>{execution.error}</div>}
      {exceptions.length > 0 && <div className="plan-exception"><strong>Needs exception review</strong>{exceptions.map(fieldLabel).join(" · ")}</div>}
      {drift.length > 0 && <div className="plan-exception"><strong>Outside declared scope</strong>{drift.join(", ")}</div>}
      {execution.unexplainedFiles?.length > 0 && <div className="plan-exception"><strong>Unexplained changes</strong>{execution.unexplainedFiles.join(", ")}</div>}
      {files.length > 0 && <div className="plan-evidence-files"><span>Changed files</span>{files.map((file) => <code key={file}>{file}</code>)}</div>}
      {execution.modelClaims.length > 0 && (
        <details className="plan-model-claims">
          <summary>Model’s claims <span className="tag">not deterministic evidence</span></summary>
          <ul>{execution.modelClaims.map((claim, index) => <li key={`${index}-${claim}`}>{claim}</li>)}</ul>
        </details>
      )}
      <div className="plan-conformance">
        <h5>Acceptance criteria</h5>
        {criteria.length === 0 ? <p className="muted small">Conformance has not been evaluated yet.</p> : criteria.map((criterion) => {
          const criterionText = node?.acceptanceCriteria.find((candidate) => candidate.id === criterion.criterionId)?.text ?? criterion.criterionId;
          return (
          <div className={`plan-conformance-row result-${criterion.status}`} key={criterion.criterionId}>
            <span className="plan-result-mark">{criterion.status === "pass" ? "✓" : criterion.status === "fail" ? "×" : "?"}</span>
            <div>
              <strong>{criterionText}</strong>
              {criterion.explanation && <p>{criterion.explanation}</p>}
              {criterion.evidence.length > 0 && <ul>{criterion.evidence.map((evidence) => <li key={evidence.id}>{safeEvidenceHref(evidence.href) ? <a href={safeEvidenceHref(evidence.href)!}>{evidence.label}</a> : evidence.label}{evidence.detail ? ` — ${evidence.detail}` : ""}</li>)}</ul>}
            </div>
            <span className="tag">{criterion.status}</span>
          </div>
        );})}
      </div>
      {onOpenEvidence && <button type="button" className="small" onClick={() => onOpenEvidence(execution)}>Open node changes</button>}
    </section>
  );
}

function PlanGraph({ nodes, edges, onSelect }: { nodes: ViewNode[]; edges: PlanDocument["edges"]; onSelect: (id: string) => void }) {
  const graph = useMemo(() => graphLayout(nodes, edges), [nodes, edges]);
  if (nodes.length === 0) return <div className="plan-empty"><p>No nodes to graph yet.</p></div>;
  return (
    <div className="plan-graph-wrap">
      <p className="muted small">Dependencies are secondary to the editable outline. Select a node to jump back to it.</p>
      <svg className="plan-graph" viewBox={`0 0 ${graph.width} ${graph.height}`} role="img" aria-label="Plan dependency graph">
        <defs><marker id="plan-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 8 4 L 0 8 z" /></marker></defs>
        {graph.edges.map((edge) => <path key={`${edge.from}-${edge.to}`} className="plan-graph-edge" d={`M ${edge.x1} ${edge.y1} C ${edge.x1 + 34} ${edge.y1}, ${edge.x2 - 34} ${edge.y2}, ${edge.x2} ${edge.y2}`} markerEnd="url(#plan-arrow)" />)}
        {graph.nodes.map(({ node, x, y }) => (
          <a key={node.id} href={`#plan-node-${node.id}`} onClick={(event) => { event.preventDefault(); onSelect(node.id); }}>
            <rect className={`plan-graph-node status-${node.status}`} x={x} y={y} width="190" height="58" rx="12" />
            <circle className={`plan-graph-dot plan-status-${node.status}`} cx={x + 17} cy={y + 18} r="5" />
            <text x={x + 29} y={y + 22}>{truncate(node.outcome, 23)}</text>
            <text className="plan-graph-sub" x={x + 17} y={y + 43}>{node.status} · {shortId(node.id)}</text>
          </a>
        ))}
      </svg>
    </div>
  );
}

function PlanHistory({ plan, me, onViewRevision }: { plan: PlanViewPlan; me: string; onViewRevision?: PlanViewProps["onViewRevision"] }) {
  const events = [...plan.events].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const approvals = [...plan.approvals].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <div className="plan-history">
      <section>
        <h4>Revision history</h4>
        {events.length === 0 ? <p className="muted small">No edits recorded yet.</p> : (
          <ol>{events.map((event) => (
            <li key={event.id}>
              <span className="plan-history-line" />
              <Avatar email={event.author} size={22} />
              <div><strong>{event.author === me ? "You" : shortName(event.author)} {eventLabel(event.operation.type)}</strong><span>revision {event.beforeRevision} → {event.afterRevision} · {dateWord(event.createdAt)}</span></div>
              {onViewRevision && <button type="button" className="linklike tiny" onClick={() => void onViewRevision(event.afterRevision)}>View</button>}
            </li>
          ))}</ol>
        )}
      </section>
      <section>
        <h4>Approvals & support</h4>
        {approvals.length === 0 ? <p className="muted small">Nobody has approved or supported a revision yet.</p> : approvals.map((approval) => (
          <div className={`plan-approval-record${approval.invalidatedAt ? " invalid" : ""}`} key={approval.id}>
            <Avatar email={approval.actor} size={22} />
            <div><strong>{approval.actor === me ? "You" : shortName(approval.actor)} {approval.kind === "approve" ? "approved" : "supported"} revision {approval.revision}</strong><span>{dateWord(approval.createdAt)}</span>{approval.invalidatedAt && <span className="error-text">Invalidated by a material edit · {dateWord(approval.invalidatedAt)}</span>}</div>
          </div>
        ))}
      </section>
      {onViewRevision && <button type="button" className="small ghost" onClick={() => void onViewRevision(null)}>Return to current revision</button>}
    </div>
  );
}

function Supporters({ approvals }: { approvals: PlanApprovalDto[] }) {
  const people = [...new Set(approvals.map((approval) => approval.actor))];
  if (people.length === 0) return null;
  return <span className="plan-supporters" title={people.join(", ")}>{people.slice(0, 4).map((email) => <Avatar key={email} email={email} size={22} />)}<span className="tiny muted">{people.length} agreed</span></span>;
}

function graphLayout(nodes: ViewNode[], explicit: PlanDocument["edges"]) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const edges = explicit.length
    ? explicit.filter((edge) => nodeById.has(edge.fromNodeId) && nodeById.has(edge.toNodeId)).map((edge) => ({ from: edge.fromNodeId, to: edge.toNodeId }))
    : nodes.flatMap((node) => node.dependencies.filter((id) => nodeById.has(id)).map((id) => ({ from: id, to: node.id })));
  const levels = new Map<string, number>();
  const levelOf = (id: string, trail = new Set<string>()): number => {
    if (levels.has(id)) return levels.get(id)!;
    if (trail.has(id)) return 0;
    trail.add(id);
    const incoming = edges.filter((edge) => edge.to === id);
    const level = incoming.length ? 1 + Math.max(...incoming.map((edge) => levelOf(edge.from, new Set(trail)))) : 0;
    levels.set(id, level);
    return level;
  };
  for (const node of nodes) levelOf(node.id);
  const columns = new Map<number, ViewNode[]>();
  for (const node of nodes) columns.set(levels.get(node.id) ?? 0, [...(columns.get(levels.get(node.id) ?? 0) ?? []), node]);
  const placed = nodes.map((node) => {
    const level = levels.get(node.id) ?? 0;
    const row = columns.get(level)!.findIndex((candidate) => candidate.id === node.id);
    return { node, x: 24 + level * 236, y: 28 + row * 82 };
  });
  const positions = new Map(placed.map((item) => [item.node.id, item]));
  return {
    nodes: placed,
    edges: edges.map((edge) => ({ ...edge, x1: positions.get(edge.from)!.x + 190, y1: positions.get(edge.from)!.y + 29, x2: positions.get(edge.to)!.x, y2: positions.get(edge.to)!.y + 29 })),
    width: Math.max(260, 30 + (Math.max(...[...levels.values(), 0]) + 1) * 236),
    height: Math.max(150, 50 + Math.max(...[...columns.values()].map((column) => column.length), 1) * 82),
  };
}

function latestExecution(executions: PlanExecutionDto[]): PlanExecutionDto | undefined {
  return [...executions].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

function completeCount(nodes: ViewNode[]): number { return nodes.filter((node) => node.status === "completed" || node.status === "skipped").length; }
function shortId(id: string): string { return id.length > 9 ? id.slice(0, 8) : id; }
function truncate(text: string, length: number): string { return text.length > length ? `${text.slice(0, length - 1)}…` : text; }
function dateWord(iso: string): string { const date = new Date(iso); return Number.isNaN(date.valueOf()) ? iso : date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
function fieldLabel(field: string): string { return field.replace(/([A-Z])/g, " $1").replace(/^./, (character) => character.toUpperCase()); }
function safeEvidenceHref(href: string | null): string | null { return href && (/^https?:\/\//i.test(href) || href.startsWith("#/")) ? href : null; }
function eventLabel(kind: string): string { return kind.replace(/_/g, " "); }
function operationLabel(operation: PlanEventDto["operation"]): string {
  if (operation.type === "set_plan_field") return `Change plan ${operation.field}`;
  if (operation.type === "add_node") return `Add node “${operation.node.outcome}”`;
  if (operation.type === "set_node_field") return `Change ${operation.nodeId} ${operation.field}`;
  if (operation.type === "remove_node") return `Remove node ${operation.nodeId}`;
  if (operation.type === "add_edge") return `Add dependency ${operation.fromNodeId} → ${operation.toNodeId}`;
  if (operation.type === "remove_edge") return `Remove dependency ${operation.fromNodeId} → ${operation.toNodeId}`;
  return `Move node ${operation.nodeId}`;
}
export function PlanSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="plan-section"><h5>{title}</h5>{children}</section>;
}
