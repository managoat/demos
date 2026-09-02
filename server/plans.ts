/** Durable, revisioned plans and their sequential execution through a chat's root conversation. */
import { withAuthor } from "../shared/author";
import { summarise } from "../shared/changes";
import {
  approvalIsCurrent,
  completeConformance,
  dependencyReadyNodes,
  draftPlanPrompt,
  exceptionReviewReasons,
  executionPrompt,
  exportPlanJson,
  exportPlanMarkdown,
  feedbackPrompt,
  isMaterialOperation,
  operationConflict,
  parsePlanDraft,
  parsePlanOperations,
  scopeDrift,
  sensitiveChangedFiles,
  validatePlanDocument,
  type ConformanceEvidenceDto,
  type CriterionResultDto,
  type PlanApprovalDto,
  type PlanDocument,
  type PlanDto,
  type PlanEventDto,
  type PlanExecutionDto,
  type PlanNodeDto,
  type PlanOperation,
  type PlanProposalDto,
} from "../shared/plans";
import { authenticate, chatAccess, ownerClient, requireOwner, type AppContext } from "./context";
import { now, type ChatRow, type PlanApprovalRow, type PlanEventRow, type PlanExecutionRow, type PlanNodeRow, type PlanProposalRow, type PlanRow } from "./db";
import { captureExecutionBoundary, diffFromHead } from "./files";
import { FountainHttpError } from "./fountain";
import { HttpError, json, readJson } from "./http";
import { hub } from "./hub";
import { toDto as commentDto } from "./comments";
import { withPromptLock } from "./prompt-lock";
import { markQueuedNotesSent, preparePromptWithQueuedNotes } from "./control";

export interface PlanState {
  document: PlanDocument;
  events: PlanEventDto[];
  approvals: PlanApprovalDto[];
  executions: PlanExecutionDto[];
  comments: ReturnType<typeof commentDto>[];
  proposals: PlanProposalDto[];
}

type CriterionRow = {
  id: string;
  execution_id: string;
  criterion_index: number;
  criterion: string;
  result: "pass" | "fail" | "unknown";
  deterministic_evidence: string;
  model_claim: string | null;
  explanation: string;
};

function planRow(ctx: AppContext, chatId: string): PlanRow | null {
  return (ctx.db.sql.query("SELECT * FROM plans WHERE chat_id = $chat").get({ chat: chatId }) as PlanRow | null) ?? null;
}

function document(ctx: AppContext, row: PlanRow): PlanDocument {
  const nodes = ctx.db.sql.query("SELECT * FROM plan_nodes WHERE plan_id = $plan ORDER BY position, id").all({ plan: row.id }) as PlanNodeRow[];
  const edges = ctx.db.sql.query("SELECT * FROM plan_edges WHERE plan_id = $plan ORDER BY from_node_id, to_node_id").all({ plan: row.id }) as { plan_id: string; from_node_id: string; to_node_id: string }[];
  return {
    plan: toPlan(row),
    nodes: nodes.map(toNode),
    edges: edges.map((edge) => ({ id: `${edge.from_node_id}->${edge.to_node_id}`, planId: edge.plan_id, fromNodeId: edge.from_node_id, toNodeId: edge.to_node_id })),
  };
}

function toPlan(row: PlanRow): PlanDto {
  return { id: row.id, chatId: row.chat_id, title: row.title, outcome: row.outcome, description: row.description, revision: row.revision, status: row.status as PlanDto["status"], createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at };
}

function toNode(row: PlanNodeRow): PlanNodeDto {
  return { id: row.id, planId: row.plan_id, outcome: row.outcome, description: row.description, acceptanceCriteria: JSON.parse(row.acceptance_criteria), declaredScope: JSON.parse(row.scope), status: row.status as PlanNodeDto["status"], order: row.position, createdAt: row.created_at, updatedAt: row.updated_at };
}

function toEvent(row: PlanEventRow): PlanEventDto {
  const operation = JSON.parse(row.operation) as PlanOperation;
  return { id: row.id, planId: row.plan_id, operationId: operation.id ?? row.id, author: row.actor, beforeRevision: row.before_revision, afterRevision: row.after_revision, operation, createdAt: row.created_at };
}

function toApproval(row: PlanApprovalRow): PlanApprovalDto {
  return { id: row.id, planId: row.plan_id, revision: row.revision, actor: row.actor, kind: row.kind, createdAt: row.created_at, invalidatedAt: row.invalidated_at, invalidatedByEventId: row.invalidated_by_event };
}

function toProposal(row: PlanProposalRow): PlanProposalDto {
  return { id: row.id, planId: row.plan_id, baseRevision: row.base_revision, author: row.author, operations: JSON.parse(row.operations) as PlanOperation[], status: row.status, createdAt: row.created_at, decidedAt: row.decided_at, decidedBy: row.decided_by };
}

function criteria(ctx: AppContext, executionId: string): CriterionResultDto[] {
  const rows = ctx.db.sql.query("SELECT * FROM execution_criteria WHERE execution_id = $id ORDER BY criterion_index").all({ id: executionId }) as CriterionRow[];
  return rows.map((row) => ({ criterionId: row.criterion, status: row.result, explanation: row.explanation, evidence: JSON.parse(row.deterministic_evidence) as ConformanceEvidenceDto[] }));
}

function changedFiles(row: PlanExecutionRow): string[] {
  return summarise(row.evidence_diff).map((file) => file.path);
}

function executionNode(ctx: AppContext, row: PlanExecutionRow): PlanNodeDto | null {
  try {
    const parsed = JSON.parse(row.node_snapshot) as PlanNodeDto;
    if (parsed && parsed.id === row.node_id && Array.isArray(parsed.acceptanceCriteria) && Array.isArray(parsed.declaredScope)) return parsed;
  } catch { /* old rows fall back to the live node */ }
  const live = ctx.db.sql.query("SELECT * FROM plan_nodes WHERE id = $id AND plan_id = $plan").get({ id: row.node_id, plan: row.plan_id }) as PlanNodeRow | null;
  return live ? toNode(live) : null;
}

function toExecution(ctx: AppContext, row: PlanExecutionRow): PlanExecutionDto {
  const files = changedFiles(row);
  const node = executionNode(ctx, row);
  const drift = node ? scopeDrift(files, node.declaredScope) : files;
  const sensitive = sensitiveChangedFiles(files);
  // A repository diff proves what changed, not why. Until a deterministic
  // check maps a file to a criterion, changed paths remain explicitly unexplained.
  const unexplained = [...files];
  const results = criteria(ctx, row.id);
  const currentPlan = ctx.db.sql.query("SELECT revision FROM plans WHERE id = $id").get({ id: row.plan_id }) as { revision: number } | null;
  const exceptions = exceptionReviewReasons(results, drift, sensitive, !!currentPlan && currentPlan.revision !== row.plan_revision, unexplained);
  return {
    id: row.id,
    planId: row.plan_id,
    planRevision: row.plan_revision,
    nodeId: row.node_id,
    launchedBy: row.launched_by,
    conversationId: row.conversation_id,
    submissionSequence: row.submission_seq,
    turnId: row.fountain_turn_id,
    turnBinding: row.turn_binding,
    status: row.status as PlanExecutionDto["status"],
    starting: { branch: row.start_branch ?? "", head: row.start_head ?? "", changesSeq: row.start_changes_seq, capturedAt: row.created_at },
    ending: row.completed_at ? { branch: row.end_branch ?? "", head: row.end_head ?? "", changesSeq: row.end_changes_seq, capturedAt: row.completed_at } : null,
    summary: row.result_summary || null,
    error: row.error,
    criterionResults: results,
    changedFiles: files,
    scopeDrift: drift,
    sensitiveFiles: sensitive,
    unexplainedFiles: unexplained,
    exceptionReasons: exceptions,
    modelClaims: JSON.parse(row.model_claims) as string[],
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function state(ctx: AppContext, row: PlanRow): PlanState {
  const events = ctx.db.sql.query("SELECT * FROM plan_events WHERE plan_id = $plan ORDER BY after_revision, created_at").all({ plan: row.id }) as PlanEventRow[];
  const approvals = ctx.db.sql.query("SELECT * FROM plan_approvals WHERE plan_id = $plan ORDER BY created_at").all({ plan: row.id }) as PlanApprovalRow[];
  const executions = ctx.db.sql.query("SELECT * FROM plan_executions WHERE plan_id = $plan ORDER BY submission_seq").all({ plan: row.id }) as PlanExecutionRow[];
  const proposals = ctx.db.sql.query("SELECT * FROM plan_proposals WHERE plan_id = $plan ORDER BY created_at").all({ plan: row.id }) as PlanProposalRow[];
  return {
    document: document(ctx, row),
    events: events.map(toEvent),
    approvals: approvals.map(toApproval),
    executions: executions.map((execution) => toExecution(ctx, execution)),
    comments: ctx.db.comments(row.chat_id).filter((comment) => comment.anchor_kind !== "diff_line").map(commentDto),
    proposals: proposals.map(toProposal),
  };
}

function publish(ctx: AppContext, row: PlanRow): PlanState {
  const fresh = ctx.db.sql.query("SELECT * FROM plans WHERE id = $id").get({ id: row.id }) as PlanRow;
  const value = state(ctx, fresh);
  hub.publish(fresh.chat_id, "plan", value);
  return value;
}

function recordActivity(ctx: AppContext, plan: PlanRow, actor: string, kind: string, details: Record<string, unknown>): void {
  const id = crypto.randomUUID();
  ctx.db.sql.query(`INSERT INTO plan_events (id, plan_id, actor, kind, operation, before_revision, after_revision, created_at)
    VALUES ($id, $plan, $actor, $kind, $operation, $revision, $revision, $t)`).run({ id, plan: plan.id, actor, kind, operation: JSON.stringify({ id, type: kind, expectedRevision: plan.revision, ...details }), revision: plan.revision, t: now() });
}

export async function show(ctx: AppContext, req: Request, chatId: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { chat } = chatAccess(ctx, user, chatId);
  const row = planRow(ctx, chat.id);
  return json({ data: row ? state(ctx, row) : null });
}

/** Validate and adopt a structured draft. An existing plan receives proposed operations instead of replacement. */
export async function adopt(ctx: AppContext, req: Request, chatId: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { chat } = chatAccess(ctx, user, chatId);
  const parsed = parsePlanDraft((await readJson(req)).draft);
  if (typeof parsed === "string") throw new HttpError(422, "invalid_plan_draft", parsed);
  const existing = planRow(ctx, chat.id);
  if (existing) {
    const proposedOperations = operationsFromDraft(document(ctx, existing), parsed);
    const proposal: PlanProposalRow = { id: crypto.randomUUID(), plan_id: existing.id, base_revision: existing.revision, author: user.email, operations: JSON.stringify(proposedOperations), status: "pending", created_at: now(), decided_at: null, decided_by: null };
    ctx.db.sql.query(`INSERT INTO plan_proposals (id, plan_id, base_revision, author, operations, status, created_at, decided_at, decided_by)
      VALUES ($id, $plan_id, $base_revision, $author, $operations, $status, $created_at, $decided_at, $decided_by)`).run(proposal as unknown as Record<string, string | number | null>);
    hub.publish(chat.id, "plan", state(ctx, existing));
    return json({ data: { proposed: true, proposal: toProposal(proposal), plan: state(ctx, existing) } }, 202);
  }
  const t = now();
  const row: PlanRow = { id: crypto.randomUUID(), chat_id: chat.id, title: parsed.title, outcome: parsed.outcome, description: parsed.description, revision: 1, status: "draft", created_by: user.email, created_at: t, updated_at: t };
  const eventId = crypto.randomUUID();
  const tx = ctx.db.sql.transaction(() => {
    ctx.db.sql.query(`INSERT INTO plans (id, chat_id, title, outcome, description, revision, status, created_by, created_at, updated_at)
      VALUES ($id, $chat_id, $title, $outcome, $description, $revision, $status, $created_by, $created_at, $updated_at)`).run(row as unknown as Record<string, string | number>);
    for (const node of parsed.nodes) {
      ctx.db.sql.query(`INSERT INTO plan_nodes (id, plan_id, outcome, description, acceptance_criteria, scope, status, position, field_revisions, created_at, updated_at)
        VALUES ($id, $plan, $outcome, $description, $criteria, $scope, 'pending', $position, '{}', $t, $t)`).run({ id: node.id, plan: row.id, outcome: node.outcome, description: node.description, criteria: JSON.stringify(node.acceptanceCriteria), scope: JSON.stringify(node.declaredScope), position: node.order, t });
    }
    for (const node of parsed.nodes) for (const dependency of node.dependencies) {
      ctx.db.sql.query("INSERT INTO plan_edges (plan_id, from_node_id, to_node_id, created_at) VALUES ($plan, $from, $to, $t)").run({ plan: row.id, from: dependency, to: node.id, t });
    }
    ctx.db.sql.query(`INSERT INTO plan_events (id, plan_id, actor, kind, operation, before_revision, after_revision, created_at)
      VALUES ($id, $plan, $actor, 'adopt', $operation, 0, 1, $t)`).run({ id: eventId, plan: row.id, actor: user.email, operation: JSON.stringify({ id: eventId, type: "adopt_draft", expectedRevision: 0, draft: parsed }), t });
  });
  tx();
  return json({ data: publish(ctx, row) }, 201);
}

function operationsFromDraft(current: PlanDocument, draft: Exclude<ReturnType<typeof parsePlanDraft>, string>): PlanOperation[] {
  const expectedRevision = current.plan.revision;
  const operations: PlanOperation[] = [];
  const add = (operation: Record<string, unknown>) => operations.push({ id: crypto.randomUUID(), expectedRevision, ...operation } as PlanOperation);
  for (const field of ["title", "outcome", "description"] as const) if (current.plan[field] !== draft[field]) add({ type: "set_plan_field", field, value: draft[field] });
  const incoming = new Map(draft.nodes.map((node) => [node.id, node]));
  for (const node of current.nodes) if (!incoming.has(node.id)) add({ type: "remove_node", nodeId: node.id });
  for (const node of draft.nodes) {
    const have = current.nodes.find((candidate) => candidate.id === node.id);
    if (!have) add({ type: "add_node", node: { id: node.id, outcome: node.outcome, description: node.description, acceptanceCriteria: node.acceptanceCriteria, declaredScope: node.declaredScope, status: "pending", order: node.order } });
    else {
      for (const field of ["outcome", "description", "acceptanceCriteria", "declaredScope"] as const) if (JSON.stringify(have[field]) !== JSON.stringify(node[field])) add({ type: "set_node_field", nodeId: node.id, field, value: node[field] });
      if (have.order !== node.order) add({ type: "move_node", nodeId: node.id, afterNodeId: node.order > 0 ? draft.nodes[node.order - 1]?.id ?? null : null });
    }
  }
  const wanted = new Set(draft.nodes.flatMap((node) => node.dependencies.map((dependency) => `${dependency}\0${node.id}`)));
  const held = new Set(current.edges.map((edge) => `${edge.fromNodeId}\0${edge.toNodeId}`));
  for (const edge of current.edges) if (!wanted.has(`${edge.fromNodeId}\0${edge.toNodeId}`)) add({ type: "remove_edge", fromNodeId: edge.fromNodeId, toNodeId: edge.toNodeId });
  for (const node of draft.nodes) for (const dependency of node.dependencies) if (!held.has(`${dependency}\0${node.id}`)) add({ type: "add_edge", edgeId: crypto.randomUUID(), fromNodeId: dependency, toNodeId: node.id });
  return operations;
}

export async function mutate(ctx: AppContext, req: Request, chatId: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { chat } = chatAccess(ctx, user, chatId);
  const row = planRow(ctx, chat.id);
  if (!row) throw new HttpError(404, "plan_not_found", "This chat has no plan yet.");
  const parsed = parsePlanOperations((await readJson(req)).operations);
  if (typeof parsed === "string") throw new HttpError(422, "bad_plan_operations", parsed);
  applyOperations(ctx, chat.id, user.email, parsed);
  return json({ data: publish(ctx, planRow(ctx, chat.id)!) });
}

function applyOperations(ctx: AppContext, chatId: string, actor: string, operations: PlanOperation[]): void {
  const tx = ctx.db.sql.transaction(() => {
    let current = planRow(ctx, chatId)!;
    const active = ctx.db.sql.query("SELECT 1 FROM plan_executions WHERE plan_id = $plan AND status IN ('queued','running') LIMIT 1").get({ plan: current.id });
    if (active && operations.some(isMaterialOperation)) throw new HttpError(409, "plan_execution_busy", "Wait for the running plan node before changing the plan.");
    for (const operation of operations) {
      const since = ctx.db.sql.query("SELECT * FROM plan_events WHERE plan_id = $plan AND after_revision > $revision ORDER BY after_revision").all({ plan: current.id, revision: operation.expectedRevision }) as PlanEventRow[];
      const conflict = operationConflict(operation, current.revision, since.filter((event) => event.after_revision > event.before_revision).map(toEvent));
      if (conflict) throw new HttpError(409, "plan_conflict", conflict.message, { conflict });
      const before = current.revision;
      applyOperation(ctx, current, operation);
      const candidate = document(ctx, { ...current, revision: before + 1 });
      const problems = validatePlanDocument(candidate);
      if (problems.length) throw new HttpError(422, "invalid_dependencies", problems.join(" "));
      const eventId = crypto.randomUUID();
      const t = now();
      ctx.db.sql.query("UPDATE plans SET revision = $revision, status = CASE WHEN status = 'approved' THEN 'draft' ELSE status END, updated_at = $t WHERE id = $plan").run({ revision: before + 1, t, plan: current.id });
      ctx.db.sql.query(`INSERT INTO plan_events (id, plan_id, actor, kind, operation, before_revision, after_revision, created_at)
        VALUES ($id, $plan, $actor, $kind, $operation, $before, $after, $t)`).run({ id: eventId, plan: current.id, actor, kind: operation.type, operation: JSON.stringify(operation), before, after: before + 1, t });
      if (isMaterialOperation(operation)) ctx.db.sql.query("UPDATE plan_approvals SET valid = 0, invalidated_at = $t, invalidated_by_event = $event WHERE plan_id = $plan AND valid = 1").run({ t, event: eventId, plan: current.id });
      current = planRow(ctx, chatId)!;
    }
  });
  tx();
}

export async function decideProposal(ctx: AppContext, req: Request, chatId: string, proposalId: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { chat } = chatAccess(ctx, user, chatId);
  const plan = planRow(ctx, chat.id);
  if (!plan) throw new HttpError(404, "plan_not_found", "This chat has no plan yet.");
  const body = await readJson(req);
  const proposal = ctx.db.sql.query("SELECT * FROM plan_proposals WHERE id = $id AND plan_id = $plan").get({ id: proposalId, plan: plan.id }) as PlanProposalRow | null;
  if (!proposal) throw new HttpError(404, "proposal_not_found", "No such proposed plan edit.");
  if (proposal.status !== "pending") throw new HttpError(409, "proposal_decided", "That proposal has already been decided.");
  const decision = body.decision === "dismiss" ? "dismiss" : "apply";
  const t = now();
  if (decision === "apply") {
    const proposed = JSON.parse(proposal.operations) as PlanOperation[];
    const current = planRow(ctx, chat.id)!;
    const history = ctx.db.sql.query("SELECT * FROM plan_events WHERE plan_id = $plan AND after_revision > $revision ORDER BY after_revision").all({ plan: current.id, revision: proposal.base_revision }) as PlanEventRow[];
    for (const operation of proposed) {
      const conflict = operationConflict(operation, current.revision, history.filter((event) => event.after_revision > event.before_revision).map(toEvent));
      if (conflict) throw new HttpError(409, "plan_conflict", conflict.message, { conflict });
    }
    const rank = (operation: PlanOperation) => operation.type === "remove_edge" ? 0 : operation.type === "remove_node" ? 1 : operation.type === "add_node" ? 2 : operation.type === "add_edge" ? 4 : 3;
    const ordered = proposed.map((operation, index) => ({ operation, index })).sort((a, b) => rank(a.operation) - rank(b.operation) || a.index - b.index).map(({ operation }, index) => ({ ...operation, expectedRevision: current.revision + index }));
    applyOperations(ctx, chat.id, user.email, ordered);
  }
  ctx.db.sql.query("UPDATE plan_proposals SET status = $status, decided_at = $t, decided_by = $actor WHERE id = $id").run({ status: decision === "apply" ? "applied" : "dismissed", t, actor: user.email, id: proposal.id });
  recordActivity(ctx, planRow(ctx, chat.id)!, user.email, decision === "apply" ? "proposal_applied" : "proposal_dismissed", { proposalId: proposal.id });
  return json({ data: publish(ctx, planRow(ctx, chat.id)!) });
}

function applyOperation(ctx: AppContext, plan: PlanRow, operation: PlanOperation): void {
  const t = now();
  if (operation.type === "set_plan_field") {
    const column = operation.field;
    ctx.db.sql.query(`UPDATE plans SET ${column} = $value, updated_at = $t WHERE id = $plan`).run({ value: operation.value, t, plan: plan.id });
    return;
  }
  if (operation.type === "add_node") {
    const node = operation.node;
    ctx.db.sql.query(`INSERT INTO plan_nodes (id, plan_id, outcome, description, acceptance_criteria, scope, status, position, field_revisions, created_at, updated_at)
      VALUES ($id, $plan, $outcome, $description, $criteria, $scope, $status, $position, '{}', $t, $t)`).run({ id: node.id, plan: plan.id, outcome: node.outcome, description: node.description, criteria: JSON.stringify(node.acceptanceCriteria), scope: JSON.stringify(node.declaredScope), status: node.status, position: node.order, t });
    return;
  }
  if (operation.type === "remove_node") {
    const result = ctx.db.sql.query("DELETE FROM plan_nodes WHERE id = $id AND plan_id = $plan").run({ id: operation.nodeId, plan: plan.id });
    if (!result.changes) throw new HttpError(404, "plan_node_not_found", "No such plan node.");
    return;
  }
  if (operation.type === "set_node_field") {
    const column = { outcome: "outcome", description: "description", acceptanceCriteria: "acceptance_criteria", declaredScope: "scope", status: "status" }[operation.field];
    const value = typeof operation.value === "string" ? operation.value : JSON.stringify(operation.value);
    const result = ctx.db.sql.query(`UPDATE plan_nodes SET ${column} = $value, updated_at = $t WHERE id = $id AND plan_id = $plan`).run({ value, t, id: operation.nodeId, plan: plan.id });
    if (!result.changes) throw new HttpError(404, "plan_node_not_found", "No such plan node.");
    return;
  }
  if (operation.type === "add_edge") {
    ctx.db.sql.query("INSERT INTO plan_edges (plan_id, from_node_id, to_node_id, created_at) VALUES ($plan, $from, $to, $t)").run({ plan: plan.id, from: operation.fromNodeId, to: operation.toNodeId, t });
    return;
  }
  if (operation.type === "remove_edge") {
    const result = ctx.db.sql.query("DELETE FROM plan_edges WHERE plan_id = $plan AND from_node_id = $from AND to_node_id = $to").run({ plan: plan.id, from: operation.fromNodeId, to: operation.toNodeId });
    if (!result.changes) throw new HttpError(404, "plan_edge_not_found", "No such dependency.");
    return;
  }
  const nodes = ctx.db.sql.query("SELECT id FROM plan_nodes WHERE plan_id = $plan ORDER BY position, id").all({ plan: plan.id }) as { id: string }[];
  const ids = nodes.map((node) => node.id).filter((id) => id !== operation.nodeId);
  if (ids.length === nodes.length) throw new HttpError(404, "plan_node_not_found", "No such plan node.");
  const index = operation.afterNodeId === null ? 0 : ids.indexOf(operation.afterNodeId) + 1;
  if (operation.afterNodeId !== null && index === 0) throw new HttpError(404, "plan_node_not_found", "The destination node no longer exists.");
  ids.splice(index, 0, operation.nodeId);
  ids.forEach((id, position) => ctx.db.sql.query("UPDATE plan_nodes SET position = $position, updated_at = $t WHERE id = $id AND plan_id = $plan").run({ position, t, id, plan: plan.id }));
}

export async function decide(ctx: AppContext, req: Request, chatId: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { chat, role } = chatAccess(ctx, user, chatId);
  const row = planRow(ctx, chat.id);
  if (!row) throw new HttpError(404, "plan_not_found", "This chat has no plan yet.");
  const body = await readJson(req);
  const kind = body.kind === "support" ? "support" : "approve";
  if (kind === "approve") requireOwner(role);
  const revision = typeof body.revision === "number" ? body.revision : -1;
  ctx.db.sql.transaction(() => {
    const current = planRow(ctx, chat.id)!;
    if (revision !== current.revision) throw new HttpError(409, "approval_revision_mismatch", `Revision ${current.revision} is current; review it before deciding.`);
    const t = now();
    const approval: PlanApprovalRow = { id: crypto.randomUUID(), plan_id: current.id, revision, actor: user.email, kind, valid: 1, invalidated_at: null, invalidated_by_event: null, created_at: t };
    ctx.db.sql.query(`INSERT INTO plan_approvals (id, plan_id, revision, actor, kind, valid, invalidated_at, invalidated_by_event, created_at)
      VALUES ($id, $plan_id, $revision, $actor, $kind, $valid, $invalidated_at, $invalidated_by_event, $created_at)
      ON CONFLICT(plan_id, revision, actor, kind) DO UPDATE SET valid = 1, invalidated_at = NULL, invalidated_by_event = NULL`).run(approval as unknown as Record<string, string | number | null>);
    if (kind === "approve") ctx.db.sql.query("UPDATE plans SET status = 'approved', updated_at = $t WHERE id = $id AND revision = $revision").run({ t, id: current.id, revision });
    recordActivity(ctx, current, user.email, kind === "approve" ? "revision_approved" : "revision_supported", { approvalId: approval.id, revision });
  })();
  return json({ data: publish(ctx, planRow(ctx, chat.id)!) }, 201);
}

export async function draft(ctx: AppContext, req: Request, chatId: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { chat } = chatAccess(ctx, user, chatId);
  const body = await readJson(req);
  const intent = typeof body.intent === "string" ? body.intent.trim().slice(0, 100_000) : "";
  if (!intent) throw new HttpError(422, "missing_intent", "Describe what the plan should accomplish.");
  const current = planRow(ctx, chat.id);
  const prompt = draftPlanPrompt(intent, current ? document(ctx, current) : null);
  await sendPrompt(ctx, chat, user.email, prompt);
  return json({ data: { prompt, currentRevision: current?.revision ?? null } }, 202);
}

export async function sendFeedback(ctx: AppContext, req: Request, chatId: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { chat } = chatAccess(ctx, user, chatId);
  const row = planRow(ctx, chat.id);
  if (!row) throw new HttpError(404, "plan_not_found", "This chat has no plan yet.");
  const comments = ctx.db.comments(chat.id).filter((comment) => comment.anchor_kind !== "diff_line" && !comment.resolved_at && !comment.sent_at);
  if (!comments.length) throw new HttpError(422, "nothing_to_send", "There is no open plan feedback to send.");
  const prompt = feedbackPrompt(document(ctx, row), comments.map((comment) => ({ nodeId: comment.plan_node_id, field: (comment.plan_field as never) ?? null, author: comment.author, body: comment.body })));
  await sendPrompt(ctx, chat, user.email, prompt);
  const t = now();
  for (const comment of comments) {
    const updated = ctx.db.updateComment(comment.id, { sent_at: t, sent_by: user.email });
    if (updated) hub.publish(chat.id, "comment", commentDto(updated));
  }
  return json({ data: { sent: comments.length, prompt, plan: state(ctx, row) } }, 202);
}

async function sendPrompt(ctx: AppContext, chat: ChatRow, actor: string, prompt: string, recordSend = true, locked = false, executionId: string | null = null): Promise<void> {
  if (!locked) return withPromptLock(chat.id, () => sendPrompt(ctx, chat, actor, prompt, recordSend, true, executionId));
  const executing = ctx.db.sql.query("SELECT id FROM plan_executions WHERE plan_id IN (SELECT id FROM plans WHERE chat_id = $chat) AND status IN ('queued', 'running') LIMIT 1").get({ chat: chat.id }) as { id: string } | null;
  if (executing && executing.id !== executionId) throw new HttpError(409, "plan_execution_busy", "Wait for the approved plan node to be finalized before starting another turn.");
  const client = await ownerClient(ctx, chat);
  const queued = preparePromptWithQueuedNotes(ctx, chat.id, prompt);
  const tagged = ctx.db.participants(chat).length > 1 ? withAuthor(actor, queued.prompt) : queued.prompt;
  const res = await client.fetch(`/api/conversations/${encodeURIComponent(chat.conversation_id)}/prompts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: tagged }) });
  if (!res.ok) throw new FountainHttpError(res.status, await res.text()).toHttp("Fountain would not take the plan prompt.");
  markQueuedNotesSent(ctx, chat.id, queued.noteIds, actor);
  if (recordSend) {
    const seq = ctx.db.addSend(chat.id, actor);
    hub.publish(chat.id, "turn", { id: `pending:${seq}`, author: actor, status: "pending" });
  }
}

export async function run(ctx: AppContext, req: Request, chatId: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { chat } = chatAccess(ctx, user, chatId);
  if (!chat.project_id) throw new HttpError(422, "project_plan_only", "Run a plan from a project chat so its changes can be verified.");
  const body = await readJson(req);
  return withPromptLock(chat.id, async () => {
    const boundary = await captureExecutionBoundary(ctx, chat);
    const made = ctx.db.sql.transaction(() => {
      const row = planRow(ctx, chat.id);
      if (!row) throw new HttpError(404, "plan_not_found", "This chat has no plan yet.");
      const value = state(ctx, row);
      const approved = value.approvals.some((approval) => approval.actor === chat.owner_email && approvalIsCurrent(approval, value.document.plan));
      if (!approved) throw new HttpError(409, "plan_not_approved", "The host must approve this exact revision first.");
      if (value.executions.some((execution) => execution.status === "queued" || execution.status === "running")) throw new HttpError(409, "plan_execution_busy", "One plan node is already running.");
      const ready = dependencyReadyNodes(value.document);
      const node = typeof body.nodeId === "string" ? ready.find((candidate) => candidate.id === body.nodeId) : ready[0];
      if (!node) throw new HttpError(409, "no_ready_node", "No dependency-ready node can run now.");
      const executionId = crypto.randomUUID();
      const prompt = executionPrompt(value.document, node.id, executionId);
      const seqRow = ctx.db.sql.query("SELECT COALESCE(MAX(submission_seq), 0) + 1 AS n FROM plan_executions WHERE plan_id = $plan").get({ plan: row.id }) as { n: number };
      const turnSubmissionSequence = ctx.db.addSend(chat.id, user.email);
      const t = now();
      const execution: PlanExecutionRow = {
        id: executionId, plan_id: row.id, node_id: node.id, plan_revision: row.revision, launched_by: user.email, conversation_id: chat.conversation_id,
        submission_seq: seqRow.n, turn_submission_seq: turnSubmissionSequence, fountain_turn_id: null, turn_binding: "inferred", status: "queued",
        start_branch: boundary.branch, start_head: boundary.head, start_changes_seq: boundary.seq,
        end_branch: null, end_head: null, end_changes_seq: null, evidence_diff: "", evidence_truncated: 0, result_summary: "", error: null, exception_state: "none", prompt,
        model_claims: "[]", node_snapshot: JSON.stringify(node), created_at: t, updated_at: t, completed_at: null,
      };
      ctx.db.sql.query(`INSERT INTO plan_executions (id, plan_id, node_id, plan_revision, launched_by, conversation_id, submission_seq, turn_submission_seq, fountain_turn_id, turn_binding, status, start_branch, start_head, start_changes_seq, end_branch, end_head, end_changes_seq, evidence_diff, evidence_truncated, result_summary, error, exception_state, prompt, model_claims, node_snapshot, created_at, updated_at, completed_at)
        VALUES ($id, $plan_id, $node_id, $plan_revision, $launched_by, $conversation_id, $submission_seq, $turn_submission_seq, $fountain_turn_id, $turn_binding, $status, $start_branch, $start_head, $start_changes_seq, $end_branch, $end_head, $end_changes_seq, $evidence_diff, $evidence_truncated, $result_summary, $error, $exception_state, $prompt, $model_claims, $node_snapshot, $created_at, $updated_at, $completed_at)`).run(execution as unknown as Record<string, string | number | null>);
      ctx.db.sql.query("UPDATE plan_nodes SET status = 'running', updated_at = $t WHERE id = $id AND plan_id = $plan").run({ t, id: node.id, plan: row.id });
      ctx.db.sql.query("UPDATE plans SET status = 'running', updated_at = $t WHERE id = $id").run({ t, id: row.id });
      recordActivity(ctx, row, user.email, "execution_started", { executionId, nodeId: node.id });
      return execution;
    })();
    try {
      await sendPrompt(ctx, chat, user.email, made.prompt, false, true, made.id);
      ctx.db.sql.query("UPDATE plan_executions SET status = 'running', updated_at = $t WHERE id = $id").run({ t: now(), id: made.id });
      hub.publish(chat.id, "turn", { id: `pending:${made.turn_submission_seq}`, author: user.email, status: "pending" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The plan node could not be submitted.";
      const t = now();
      ctx.db.sql.transaction(() => {
        ctx.db.sql.query("DELETE FROM sends WHERE chat_id = $chat AND seq = $seq").run({ chat: chat.id, seq: made.turn_submission_seq });
        ctx.db.sql.query("UPDATE plan_executions SET status = 'failed', error = $error, exception_state = 'review', updated_at = $t, completed_at = $t WHERE id = $id").run({ error: message, t, id: made.id });
        ctx.db.sql.query("UPDATE plan_nodes SET status = 'failed', updated_at = $t WHERE id = $id AND plan_id = $plan").run({ t, id: made.node_id, plan: made.plan_id });
        ctx.db.sql.query("UPDATE plans SET status = 'failed', updated_at = $t WHERE id = $id").run({ t, id: made.plan_id });
        recordActivity(ctx, planRow(ctx, chat.id)!, user.email, "execution_submit_failed", { executionId: made.id, nodeId: made.node_id });
      })();
      publish(ctx, planRow(ctx, chat.id)!);
      throw error;
    }
    return json({ data: { execution: toExecution(ctx, ctx.db.sql.query("SELECT * FROM plan_executions WHERE id = $id").get({ id: made.id }) as PlanExecutionRow), plan: publish(ctx, planRow(ctx, chat.id)!) } }, 202);
  });
}

export async function finish(ctx: AppContext, req: Request, chatId: string, executionId: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { chat, role } = chatAccess(ctx, user, chatId);
  const execution = ctx.db.sql.query("SELECT * FROM plan_executions WHERE id = $id").get({ id: executionId }) as PlanExecutionRow | null;
  if (!execution || planRow(ctx, chat.id)?.id !== execution.plan_id) throw new HttpError(404, "execution_not_found", "No such plan execution.");
  if (role !== "owner" && execution.launched_by !== user.email) throw new HttpError(403, "execution_not_yours", "Only the launcher or host can finalize this execution.");
  const response = (row: PlanExecutionRow, publishPlan = false) => {
    const dto = toExecution(ctx, row);
    return { execution: dto, drift: dto.scopeDrift, sensitive: dto.sensitiveFiles, exceptionReasons: dto.exceptionReasons, plan: publishPlan ? publish(ctx, planRow(ctx, chat.id)!) : state(ctx, planRow(ctx, chat.id)!) };
  };
  if (!["queued", "running"].includes(execution.status)) return json({ data: response(execution) });
  const body = await readJson(req);
  const node = executionNode(ctx, execution);
  if (!node) throw new HttpError(409, "execution_snapshot_missing", "This execution has no recoverable node snapshot.");

  const client = await ownerClient(ctx, chat);
  const [conversation, allTurns] = await Promise.all([client.conversation(execution.conversation_id), client.conversationTurns(execution.conversation_id)]);
  const turns = allTurns.filter((turn) => turn.origin !== "autonomous");
  const turn = turns[(execution.turn_submission_seq || execution.submission_seq) - 1];
  const active = new Set(["queued", "pending", "running"]);
  if (!turn || active.has(turn.status ?? "") || active.has(conversation?.status ?? "")) {
    throw new HttpError(409, "execution_not_finished", "The bound Fountain turn has not finished yet.", { turnSequence: execution.turn_submission_seq || execution.submission_seq });
  }
  const status = turn.status === "interrupted" ? "interrupted" : turn.status === "failed" ? "failed" : "completed";

  // Browser/model claims are retained only as claims. Conformance statuses and
  // evidence are server-owned and conservative unless a deterministic checker supplies them.
  let results = completeConformance(node, []);
  let evidenceDiff = "";
  let evidenceTruncated = false;
  const durableBoundary = ctx.db.latestChanges(chat.id);
  let latest = durableBoundary ? { branch: durableBoundary.branch, head: durableBoundary.head, seq: durableBoundary.seq } : null;
  try {
    const captured = await captureExecutionBoundary(ctx, chat);
    latest = { branch: captured.branch, head: captured.head, seq: captured.seq };
  } catch { /* retain the last durable boundary */ }
  if (execution.start_head) {
    try { const evidence = await diffFromHead(ctx, chat, execution.start_head); evidenceDiff = evidence.diff; evidenceTruncated = evidence.truncated; } catch { evidenceDiff = ""; }
  }
  const files = summarise(evidenceDiff).map((file) => file.path);
  const drift = scopeDrift(files, node.declaredScope);
  const sensitive = sensitiveChangedFiles(files);
  const plan = planRow(ctx, chat.id)!;
  const planDrift = plan.revision !== execution.plan_revision;
  const unexplained = [...files];
  const exceptions = exceptionReviewReasons(results, drift, sensitive, planDrift, unexplained);
  const boundaryEvidence: ConformanceEvidenceDto[] = [
    { id: `${execution.id}:branch`, kind: "branch", label: latest?.branch || "Recorded repository boundary", href: `#/chat/${chat.id}`, path: null, detail: `${execution.start_head || "unknown"} → ${latest?.head || "unknown"}` },
    { id: `${execution.id}:diff`, kind: "diff", label: "Node-specific changes", href: `#/chat/${chat.id}`, path: null, detail: evidenceDiff ? `${files.length} changed file${files.length === 1 ? "" : "s"}` : "No node-specific diff was available" },
  ];
  results = results.map((result) => ({ ...result, evidence: result.evidence.length ? result.evidence : boundaryEvidence }));
  const t = now();
  const claims = Array.isArray(body.modelClaims) ? body.modelClaims.filter((claim: unknown): claim is string => typeof claim === "string").map((claim: string) => claim.slice(0, 20_000)).slice(0, 100) : [];
  const won = ctx.db.sql.transaction(() => {
    const updated = ctx.db.sql.query(`UPDATE plan_executions SET status = $status, fountain_turn_id = $turn, end_branch = $branch, end_head = $head,
      end_changes_seq = $seq, evidence_diff = $diff, evidence_truncated = $truncated, result_summary = $summary, error = $error, exception_state = $exception,
      model_claims = $claims, updated_at = $t, completed_at = $t WHERE id = $id AND status IN ('queued', 'running')`).run({ status, turn: turn.id, branch: latest?.branch ?? null, head: latest?.head ?? null, seq: latest?.seq ?? null, diff: evidenceDiff, truncated: evidenceTruncated ? 1 : 0, summary: typeof body.summary === "string" ? body.summary.slice(0, 20_000) : "", error: status === "failed" ? "The bound Fountain turn failed." : status === "interrupted" ? "The bound Fountain turn was interrupted." : null, exception: exceptions.length ? "review" : "none", claims: JSON.stringify(claims), t, id: execution.id });
    if (!updated.changes) return false;
    ctx.db.sql.query("DELETE FROM execution_criteria WHERE execution_id = $id").run({ id: execution.id });
    results.forEach((result, index) => ctx.db.sql.query(`INSERT INTO execution_criteria (id, execution_id, criterion_index, criterion, result, deterministic_evidence, model_claim, explanation)
      VALUES ($id, $execution, $index, $criterion, $result, $evidence, $claim, $explanation)`).run({ id: `${execution.id}:${result.criterionId}`, execution: execution.id, index, criterion: result.criterionId, result: result.status, evidence: JSON.stringify(result.evidence.filter((item) => item.kind !== "model_claim")), claim: result.evidence.find((item) => item.kind === "model_claim")?.detail ?? null, explanation: result.explanation }));
    ctx.db.sql.query("UPDATE plan_nodes SET status = $status, updated_at = $t WHERE id = $id AND plan_id = $plan").run({ status: status === "completed" ? "completed" : "failed", t, id: execution.node_id, plan: execution.plan_id });
    const remaining = ctx.db.sql.query("SELECT COUNT(*) AS n FROM plan_nodes WHERE plan_id = $plan AND status NOT IN ('completed','skipped')").get({ plan: execution.plan_id }) as { n: number };
    ctx.db.sql.query("UPDATE plans SET status = $status, updated_at = $t WHERE id = $id").run({ status: remaining.n === 0 ? "completed" : status === "completed" ? "approved" : "failed", t, id: execution.plan_id });
    recordActivity(ctx, plan, user.email, "execution_finished", { executionId: execution.id, nodeId: execution.node_id, status, turnId: turn.id });
    return true;
  })();
  const fresh = ctx.db.sql.query("SELECT * FROM plan_executions WHERE id = $id").get({ id: execution.id }) as PlanExecutionRow;
  if (won) hub.publish(chat.id, "turn", null);
  return json({ data: response(fresh, won) });
}

export async function evidence(ctx: AppContext, req: Request, chatId: string, executionId: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { chat } = chatAccess(ctx, user, chatId);
  const execution = ctx.db.sql.query("SELECT * FROM plan_executions WHERE id = $id").get({ id: executionId }) as PlanExecutionRow | null;
  if (!execution || planRow(ctx, chat.id)?.id !== execution.plan_id) throw new HttpError(404, "execution_not_found", "No such plan execution.");
  return json({ data: {
    chatId: chat.id,
    seq: execution.end_changes_seq ?? execution.start_changes_seq ?? 0,
    branch: execution.end_branch ?? execution.start_branch ?? "",
    head: execution.end_head ?? execution.start_head ?? "",
    base: execution.start_head ?? "execution start",
    status: "",
    files: summarise(execution.evidence_diff),
    diff: execution.evidence_diff,
    truncated: execution.evidence_truncated === 1,
    pr: null,
    ahead: null,
    source: "fountain",
    reason: "manual",
    at: execution.completed_at ?? execution.updated_at,
  } });
}

export async function exportPortable(ctx: AppContext, req: Request, chatId: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { chat } = chatAccess(ctx, user, chatId);
  const row = planRow(ctx, chat.id);
  if (!row) throw new HttpError(404, "plan_not_found", "This chat has no plan yet.");
  const value = state(ctx, row);
  const format = new URL(req.url).searchParams.get("format") === "markdown" ? "markdown" : "json";
  const body = format === "markdown" ? exportPlanMarkdown(value.document, value.approvals, value.executions) : exportPlanJson(value.document, value.approvals, value.executions);
  return new Response(body, { headers: { "content-type": format === "markdown" ? "text/markdown; charset=utf-8" : "application/json; charset=utf-8", "content-disposition": `attachment; filename=plan-r${row.revision}.${format === "markdown" ? "md" : "json"}` } });
}
