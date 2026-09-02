/**
 * Salon's durable plan domain. This module deliberately has no database, HTTP,
 * Fountain, or browser dependencies: both sides use the same wire shapes and
 * invariants, while the server remains the authority that assigns revisions.
 */

export const PLAN_STATUSES = ["draft", "approved", "running", "completed", "failed"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const PLAN_NODE_STATUSES = ["pending", "ready", "running", "completed", "failed", "blocked", "skipped"] as const;
export type PlanNodeStatus = (typeof PLAN_NODE_STATUSES)[number];

export const EXECUTION_STATUSES = ["queued", "running", "completed", "failed", "interrupted"] as const;
export type PlanExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const CRITERION_STATUSES = ["pass", "fail", "unknown"] as const;
export type CriterionStatus = (typeof CRITERION_STATUSES)[number];

export interface AcceptanceCriterionDto {
  id: string;
  text: string;
}

export interface PlanDto {
  id: string;
  chatId: string;
  title: string;
  outcome: string;
  description: string;
  revision: number;
  status: PlanStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlanNodeDto {
  id: string;
  planId: string;
  outcome: string;
  description: string;
  acceptanceCriteria: AcceptanceCriterionDto[];
  /** Repository paths or simple glob patterns the node declares it may change. */
  declaredScope: string[];
  status: PlanNodeStatus;
  order: number;
  createdAt: string;
  updatedAt: string;
}

/** `fromNodeId` must finish before `toNodeId` may run. */
export interface PlanEdgeDto {
  id: string;
  planId: string;
  fromNodeId: string;
  toNodeId: string;
}

export interface PlanDocument {
  plan: PlanDto;
  nodes: PlanNodeDto[];
  edges: PlanEdgeDto[];
}

export type PlanApprovalKind = "approve" | "support";

export interface PlanApprovalDto {
  id: string;
  planId: string;
  /** Approvals are meaningful only for this exact revision. */
  revision: number;
  kind: PlanApprovalKind;
  actor: string;
  createdAt: string;
  invalidatedAt: string | null;
  invalidatedByEventId: string | null;
}

export interface PlanProposalDto {
  id: string;
  planId: string;
  baseRevision: number;
  author: string;
  operations: PlanOperation[];
  status: "pending" | "applied" | "dismissed";
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
}

export type EvidenceKind = "branch" | "diff" | "check" | "test" | "file" | "model_claim";

export interface ConformanceEvidenceDto {
  id: string;
  kind: EvidenceKind;
  label: string;
  /** An application-relative link to the retained evidence, when one exists. */
  href: string | null;
  path: string | null;
  detail: string | null;
}

export interface CriterionResultDto {
  criterionId: string;
  status: CriterionStatus;
  explanation: string;
  evidence: ConformanceEvidenceDto[];
}

export interface PlanExecutionEvidenceDto {
  branch: string;
  head: string;
  changesSeq: number | null;
  capturedAt: string;
}

export interface PlanExecutionDto {
  id: string;
  planId: string;
  planRevision: number;
  nodeId: string;
  launchedBy: string;
  conversationId: string;
  /** Assigned before prompt submission so retries and provenance are durable. */
  submissionSequence: number;
  turnId: string | null;
  turnBinding: "inferred" | "exact" | null;
  status: PlanExecutionStatus;
  starting: PlanExecutionEvidenceDto;
  ending: PlanExecutionEvidenceDto | null;
  summary: string | null;
  error: string | null;
  criterionResults: CriterionResultDto[];
  changedFiles: string[];
  scopeDrift: string[];
  sensitiveFiles: string[];
  unexplainedFiles: string[];
  exceptionReasons: ExceptionReason[];
  modelClaims: string[];
  createdAt: string;
  completedAt: string | null;
}

export interface PlanEventDto {
  id: string;
  planId: string;
  operationId: string;
  author: string;
  beforeRevision: number;
  afterRevision: number;
  operation: PlanOperation;
  createdAt: string;
}

export interface DraftPlanNode {
  id: string;
  outcome: string;
  description: string;
  acceptanceCriteria: AcceptanceCriterionDto[];
  declaredScope: string[];
  dependencies: string[];
  order: number;
}

export interface PlanDraft {
  title: string;
  outcome: string;
  description: string;
  nodes: DraftPlanNode[];
}

interface OperationBase {
  id: string;
  expectedRevision: number;
}

export type PlanField = "title" | "outcome" | "description";
export type PlanNodeField = "outcome" | "description" | "acceptanceCriteria" | "declaredScope" | "status";

export type PlanOperation =
  | (OperationBase & { type: "set_plan_field"; field: PlanField; value: string })
  | (OperationBase & { type: "add_node"; node: Omit<PlanNodeDto, "planId" | "createdAt" | "updatedAt"> })
  | (OperationBase & { type: "set_node_field"; nodeId: string; field: "outcome" | "description"; value: string })
  | (OperationBase & { type: "set_node_field"; nodeId: string; field: "acceptanceCriteria"; value: AcceptanceCriterionDto[] })
  | (OperationBase & { type: "set_node_field"; nodeId: string; field: "declaredScope"; value: string[] })
  | (OperationBase & { type: "set_node_field"; nodeId: string; field: "status"; value: PlanNodeStatus })
  | (OperationBase & { type: "remove_node"; nodeId: string })
  | (OperationBase & { type: "add_edge"; edgeId: string; fromNodeId: string; toNodeId: string })
  | (OperationBase & { type: "remove_edge"; fromNodeId: string; toNodeId: string })
  | (OperationBase & { type: "move_node"; nodeId: string; afterNodeId: string | null });

export interface PlanConflict {
  operationId: string;
  expectedRevision: number;
  currentRevision: number;
  conflictingEventIds: string[];
  keys: string[];
  message: string;
}

export interface PlanFeedback {
  nodeId: string | null;
  field: PlanField | PlanNodeField | null;
  author: string;
  body: string;
}

export type ExceptionReason = "failed_criterion" | "unknown_criterion" | "scope_drift" | "sensitive_file" | "plan_drift" | "unexplained_change";

const ID_MAX = 200;
const TEXT_MAX = 20_000;
const DESCRIPTION_MAX = 100_000;
const LIST_MAX = 1_000;

/** A structured model draft, or a useful sentence explaining why it cannot be adopted. */
export function parsePlanDraft(value: unknown): PlanDraft | string {
  if (!record(value)) return "A plan draft is required.";
  const title = requiredText(value.title, 500);
  if (!title) return "Give the plan a title.";
  const outcome = requiredText(value.outcome, TEXT_MAX);
  if (!outcome) return "Describe the plan outcome.";
  const description = optionalText(value.description, DESCRIPTION_MAX);
  if (!Array.isArray(value.nodes) || value.nodes.length === 0) return "A plan needs at least one node.";
  if (value.nodes.length > LIST_MAX) return `A plan cannot have more than ${LIST_MAX} nodes.`;

  const nodes: DraftPlanNode[] = [];
  const nodeIds = new Set<string>();
  for (let index = 0; index < value.nodes.length; index++) {
    const raw = value.nodes[index];
    if (!record(raw)) return `Node ${index + 1} must be an object.`;
    const id = parseId(raw.id);
    if (!id) return `Node ${index + 1} needs a stable id.`;
    if (nodeIds.has(id)) return `Node id "${id}" is duplicated.`;
    nodeIds.add(id);
    const nodeOutcome = requiredText(raw.outcome, TEXT_MAX);
    if (!nodeOutcome) return `Node "${id}" needs an outcome.`;
    const criteria = parseCriteria(raw.acceptanceCriteria, id);
    if (typeof criteria === "string") return criteria;
    const dependencies = parseIdList(raw.dependencies);
    if (dependencies === null) return `Node "${id}" dependencies must be a list of ids.`;
    const declaredScope = parseStringList(raw.declaredScope, 2_000);
    if (declaredScope === null) return `Node "${id}" declaredScope must be a list of repository paths.`;
    nodes.push({
      id,
      outcome: nodeOutcome,
      description: optionalText(raw.description, DESCRIPTION_MAX),
      acceptanceCriteria: criteria,
      declaredScope,
      dependencies,
      order: index,
    });
  }

  const edges = nodes.flatMap((node) => node.dependencies.map((fromNodeId, index) => ({
    id: `${fromNodeId}->${node.id}:${index}`,
    planId: "draft",
    fromNodeId,
    toNodeId: node.id,
  })));
  const problems = validateDependencies(nodes.map((node) => node.id), edges);
  if (problems.length) return problems[0]!;
  return { title, outcome, description, nodes };
}

export interface NewPlanMetadata {
  id: string;
  chatId: string;
  createdBy: string;
  createdAt: string;
}

/** Turn a validated draft into the first durable revision. */
export function documentFromDraft(draft: PlanDraft, metadata: NewPlanMetadata): PlanDocument {
  const nodes: PlanNodeDto[] = draft.nodes.map((node) => ({
    id: node.id,
    planId: metadata.id,
    outcome: node.outcome,
    description: node.description,
    acceptanceCriteria: node.acceptanceCriteria.map((criterion) => ({ ...criterion })),
    declaredScope: [...node.declaredScope],
    status: "pending",
    order: node.order,
    createdAt: metadata.createdAt,
    updatedAt: metadata.createdAt,
  }));
  const edges = draft.nodes.flatMap((node) => node.dependencies.map((fromNodeId) => ({
    id: edgeId(fromNodeId, node.id),
    planId: metadata.id,
    fromNodeId,
    toNodeId: node.id,
  })));
  return {
    plan: {
      id: metadata.id,
      chatId: metadata.chatId,
      title: draft.title,
      outcome: draft.outcome,
      description: draft.description,
      revision: 1,
      status: "draft",
      createdBy: metadata.createdBy,
      createdAt: metadata.createdAt,
      updatedAt: metadata.createdAt,
    },
    nodes,
    edges,
  };
}

/** A client/agent operation, parsed before the server checks it against current state. */
export function parsePlanOperation(value: unknown): PlanOperation | string {
  if (!record(value)) return "A plan operation is required.";
  const id = parseId(value.id);
  if (!id) return "The operation needs an id.";
  const expectedRevision = nonNegativeInteger(value.expectedRevision);
  if (expectedRevision === null) return "expectedRevision must be a non-negative integer.";
  const base = { id, expectedRevision };

  switch (value.type) {
    case "set_plan_field": {
      if (!isOneOf(value.field, ["title", "outcome", "description"] as const)) return "That plan field cannot be edited.";
      const text = requiredText(value.value, value.field === "title" ? 500 : DESCRIPTION_MAX);
      if (!text && value.field !== "description") return `Plan ${value.field} cannot be empty.`;
      return { ...base, type: value.type, field: value.field, value: text };
    }
    case "add_node": {
      if (!record(value.node)) return "add_node needs a node.";
      const node = parseOperationNode(value.node);
      return typeof node === "string" ? node : { ...base, type: value.type, node };
    }
    case "set_node_field": {
      const nodeId = parseId(value.nodeId);
      if (!nodeId) return "set_node_field needs a nodeId.";
      if (value.field === "outcome" || value.field === "description") {
        const text = requiredText(value.value, DESCRIPTION_MAX);
        if (!text && value.field === "outcome") return "A node outcome cannot be empty.";
        return { ...base, type: value.type, nodeId, field: value.field, value: text };
      }
      if (value.field === "acceptanceCriteria") {
        const criteria = parseCriteria(value.value, nodeId);
        return typeof criteria === "string" ? criteria : { ...base, type: value.type, nodeId, field: value.field, value: criteria };
      }
      if (value.field === "declaredScope") {
        const scope = parseStringList(value.value, 2_000);
        return scope === null ? "declaredScope must be a list of repository paths." : { ...base, type: value.type, nodeId, field: value.field, value: scope };
      }
      if (value.field === "status" && isOneOf(value.value, PLAN_NODE_STATUSES)) {
        return { ...base, type: value.type, nodeId, field: value.field, value: value.value };
      }
      return "That node field cannot be edited.";
    }
    case "remove_node": {
      const nodeId = parseId(value.nodeId);
      return nodeId ? { ...base, type: value.type, nodeId } : "remove_node needs a nodeId.";
    }
    case "add_edge": {
      const edgeId = parseId(value.edgeId);
      const fromNodeId = parseId(value.fromNodeId);
      const toNodeId = parseId(value.toNodeId);
      return edgeId && fromNodeId && toNodeId ? { ...base, type: value.type, edgeId, fromNodeId, toNodeId } : "add_edge needs an edgeId, fromNodeId and toNodeId.";
    }
    case "remove_edge": {
      const fromNodeId = parseId(value.fromNodeId);
      const toNodeId = parseId(value.toNodeId);
      return fromNodeId && toNodeId ? { ...base, type: value.type, fromNodeId, toNodeId } : "remove_edge needs a fromNodeId and toNodeId.";
    }
    case "move_node": {
      const nodeId = parseId(value.nodeId);
      const afterNodeId = value.afterNodeId === null ? null : parseId(value.afterNodeId);
      if (!nodeId || (value.afterNodeId !== null && !afterNodeId)) return "move_node needs a nodeId and a valid afterNodeId or null.";
      if (nodeId === afterNodeId) return "A node cannot be moved after itself.";
      return { ...base, type: value.type, nodeId, afterNodeId };
    }
    default:
      return "Unknown plan operation.";
  }
}

export function parsePlanOperations(value: unknown): PlanOperation[] | string {
  if (!Array.isArray(value) || value.length === 0) return "At least one plan operation is required.";
  if (value.length > LIST_MAX) return `No more than ${LIST_MAX} operations may be submitted together.`;
  const out: PlanOperation[] = [];
  const ids = new Set<string>();
  for (const raw of value) {
    const operation = parsePlanOperation(raw);
    if (typeof operation === "string") return operation;
    if (ids.has(operation.id)) return `Operation id "${operation.id}" is duplicated.`;
    ids.add(operation.id);
    out.push(operation);
  }
  return out;
}

/**
 * Apply one operation after the caller has resolved optimistic concurrency.
 * The returned document is a copy and advances exactly one revision.
 */
export function applyPlanOperation(document: PlanDocument, operation: PlanOperation, at: string): PlanDocument | string {
  if (operation.expectedRevision > document.plan.revision) return `Expected revision ${operation.expectedRevision} is newer than the plan.`;
  const next: PlanDocument = {
    plan: { ...document.plan, revision: document.plan.revision + 1, updatedAt: at },
    nodes: document.nodes.map((node) => ({ ...node, acceptanceCriteria: node.acceptanceCriteria.map((criterion) => ({ ...criterion })), declaredScope: [...node.declaredScope] })),
    edges: document.edges.map((edge) => ({ ...edge })),
  };
  if (isMaterialOperation(operation)) next.plan.status = "draft";

  switch (operation.type) {
    case "set_plan_field":
      next.plan[operation.field] = operation.value;
      break;
    case "add_node":
      if (next.nodes.some((node) => node.id === operation.node.id)) return `Node "${operation.node.id}" already exists.`;
      next.nodes.push({ ...operation.node, planId: next.plan.id, acceptanceCriteria: operation.node.acceptanceCriteria.map((criterion) => ({ ...criterion })), declaredScope: [...operation.node.declaredScope], createdAt: at, updatedAt: at });
      break;
    case "set_node_field": {
      const node = next.nodes.find((candidate) => candidate.id === operation.nodeId);
      if (!node) return `Node "${operation.nodeId}" does not exist.`;
      if (operation.field === "acceptanceCriteria") node.acceptanceCriteria = operation.value.map((criterion) => ({ ...criterion }));
      else if (operation.field === "declaredScope") node.declaredScope = [...operation.value];
      else if (operation.field === "status") node.status = operation.value;
      else node[operation.field] = operation.value;
      node.updatedAt = at;
      break;
    }
    case "remove_node": {
      if (!next.nodes.some((node) => node.id === operation.nodeId)) return `Node "${operation.nodeId}" does not exist.`;
      next.nodes = next.nodes.filter((node) => node.id !== operation.nodeId);
      next.edges = next.edges.filter((edge) => edge.fromNodeId !== operation.nodeId && edge.toNodeId !== operation.nodeId);
      break;
    }
    case "add_edge":
      if (!next.nodes.some((node) => node.id === operation.fromNodeId) || !next.nodes.some((node) => node.id === operation.toNodeId)) return "Both dependency nodes must exist.";
      if (next.edges.some((edge) => edge.fromNodeId === operation.fromNodeId && edge.toNodeId === operation.toNodeId)) return "That dependency already exists.";
      next.edges.push({ id: operation.edgeId, planId: next.plan.id, fromNodeId: operation.fromNodeId, toNodeId: operation.toNodeId });
      break;
    case "remove_edge": {
      const before = next.edges.length;
      next.edges = next.edges.filter((edge) => edge.fromNodeId !== operation.fromNodeId || edge.toNodeId !== operation.toNodeId);
      if (before === next.edges.length) return "That dependency does not exist.";
      break;
    }
    case "move_node": {
      const moving = next.nodes.find((node) => node.id === operation.nodeId);
      if (!moving) return `Node "${operation.nodeId}" does not exist.`;
      if (operation.afterNodeId !== null && !next.nodes.some((node) => node.id === operation.afterNodeId)) return `Node "${operation.afterNodeId}" does not exist.`;
      const ordered = next.nodes.filter((node) => node.id !== operation.nodeId).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
      const index = operation.afterNodeId === null ? 0 : ordered.findIndex((node) => node.id === operation.afterNodeId) + 1;
      ordered.splice(index, 0, moving);
      ordered.forEach((node, order) => {
        node.order = order;
        node.updatedAt = at;
      });
      next.nodes = ordered;
      break;
    }
  }
  const problems = validatePlanDocument(next);
  return problems.length ? problems[0]! : next;
}

export function eventForOperation(before: PlanDocument, after: PlanDocument, operation: PlanOperation, event: Pick<PlanEventDto, "id" | "author" | "createdAt">): PlanEventDto {
  if (after.plan.revision !== before.plan.revision + 1) throw new Error("A plan event must advance exactly one revision.");
  return { ...event, planId: before.plan.id, operationId: operation.id, beforeRevision: before.plan.revision, afterRevision: after.plan.revision, operation };
}

/** Validate referential integrity, duplicate edges, and acyclicity. */
export function validateDependencies(nodeIds: readonly string[], edges: readonly Pick<PlanEdgeDto, "fromNodeId" | "toNodeId">[]): string[] {
  const problems: string[] = [];
  const nodes = new Set(nodeIds);
  if (nodes.size !== nodeIds.length) problems.push("Node ids must be unique.");
  const seen = new Set<string>();
  for (const edge of edges) {
    const key = `${edge.fromNodeId}\0${edge.toNodeId}`;
    if (!nodes.has(edge.fromNodeId)) problems.push(`Dependency node "${edge.fromNodeId}" does not exist.`);
    if (!nodes.has(edge.toNodeId)) problems.push(`Dependent node "${edge.toNodeId}" does not exist.`);
    if (edge.fromNodeId === edge.toNodeId) problems.push(`Node "${edge.toNodeId}" cannot depend on itself.`);
    if (seen.has(key)) problems.push(`Dependency "${edge.fromNodeId}" → "${edge.toNodeId}" is duplicated.`);
    seen.add(key);
  }
  const cycle = dependencyCycle(nodeIds, edges);
  if (cycle) problems.push(`Plan dependencies contain a cycle: ${cycle.join(" → ")}.`);
  return [...new Set(problems)];
}

/** The first deterministic cycle path, including its repeated starting node. */
export function dependencyCycle(nodeIds: readonly string[], edges: readonly Pick<PlanEdgeDto, "fromNodeId" | "toNodeId">[]): string[] | null {
  const outgoing = new Map<string, string[]>();
  for (const id of nodeIds) outgoing.set(id, []);
  for (const edge of edges) if (outgoing.has(edge.fromNodeId) && outgoing.has(edge.toNodeId)) outgoing.get(edge.fromNodeId)!.push(edge.toNodeId);
  for (const list of outgoing.values()) list.sort();
  const visited = new Set<string>();
  const active = new Set<string>();
  const path: string[] = [];
  const visit = (id: string): string[] | null => {
    if (active.has(id)) return [...path.slice(path.indexOf(id)), id];
    if (visited.has(id)) return null;
    visited.add(id);
    active.add(id);
    path.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    path.pop();
    active.delete(id);
    return null;
  };
  for (const id of [...nodeIds].sort()) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}

export function validatePlanDocument(document: PlanDocument): string[] {
  const problems = validateDependencies(document.nodes.map((node) => node.id), document.edges);
  const criterionIds = new Set<string>();
  for (const node of document.nodes) {
    if (node.planId !== document.plan.id) problems.push(`Node "${node.id}" belongs to another plan.`);
    if (!node.outcome.trim()) problems.push(`Node "${node.id}" needs an outcome.`);
    for (const criterion of node.acceptanceCriteria) {
      if (!criterion.text.trim()) problems.push(`Criterion "${criterion.id}" cannot be empty.`);
      if (criterionIds.has(criterion.id)) problems.push(`Criterion id "${criterion.id}" is duplicated.`);
      criterionIds.add(criterion.id);
    }
  }
  for (const edge of document.edges) if (edge.planId !== document.plan.id) problems.push(`Edge "${edge.id}" belongs to another plan.`);
  return [...new Set(problems)];
}

/** Conflict keys are intentionally field-granular, so independent edits commute. */
export function operationConflictKeys(operation: PlanOperation): string[] {
  switch (operation.type) {
    case "set_plan_field": return [`plan:${operation.field}`];
    case "add_node": return [`node:${operation.node.id}:exists`];
    case "set_node_field": return [`node:${operation.nodeId}:${operation.field}`];
    case "remove_node": return [`node:${operation.nodeId}:*`];
    case "add_edge": return [`edge:${operation.fromNodeId}->${operation.toNodeId}:exists`];
    case "remove_edge": return [`edge:${operation.fromNodeId}->${operation.toNodeId}:exists`];
    case "move_node": return ["node-order:*", `node:${operation.nodeId}:order`];
  }
}

export function operationsConflict(left: PlanOperation, right: PlanOperation): boolean {
  if (left.type === "move_node" && right.type === "move_node") return true;
  if (left.type === "remove_node" && touchesNode(right, left.nodeId)) return true;
  if (right.type === "remove_node" && touchesNode(left, right.nodeId)) return true;
  if (left.type === "add_node" && touchesNode(right, left.node.id)) return true;
  if (right.type === "add_node" && touchesNode(left, right.node.id)) return true;
  const a = operationConflictKeys(left);
  const b = operationConflictKeys(right);
  return a.some((key) => b.includes(key));
}

export function operationsCommute(left: PlanOperation, right: PlanOperation): boolean {
  return !operationsConflict(left, right);
}

/**
 * A stale operation may still apply if every event since its expected
 * revision commutes with it. Missing history is deliberately a conflict.
 */
export function operationConflict(operation: PlanOperation, currentRevision: number, eventsSinceExpected: readonly PlanEventDto[]): PlanConflict | null {
  if (operation.expectedRevision === currentRevision) return null;
  const relevant = eventsSinceExpected.filter((event) => event.afterRevision > operation.expectedRevision && event.afterRevision <= currentRevision);
  const historyComplete = relevant.length === currentRevision - operation.expectedRevision
    && relevant.every((event, index) => event.afterRevision === operation.expectedRevision + index + 1);
  const conflicting = relevant.filter((event) => operationsConflict(operation, event.operation));
  if (operation.expectedRevision > currentRevision || !historyComplete || conflicting.length) {
    const keys = [...new Set(conflicting.flatMap((event) => operationConflictKeys(event.operation)))];
    return {
      operationId: operation.id,
      expectedRevision: operation.expectedRevision,
      currentRevision,
      conflictingEventIds: conflicting.map((event) => event.id),
      keys,
      message: operation.expectedRevision > currentRevision
        ? `Expected revision ${operation.expectedRevision} is newer than current revision ${currentRevision}.`
        : !historyComplete
          ? `Revision ${operation.expectedRevision} is stale and the intervening history is incomplete.`
          : `Revision ${operation.expectedRevision} is stale and ${keys.join(", ") || "the same plan data"} changed.`,
    };
  }
  return null;
}

/** Material content/dependency/order changes invalidate revision-bound approval. */
export function isMaterialOperation(operation: PlanOperation): boolean {
  return !(operation.type === "set_node_field" && operation.field === "status");
}

export function approvalIsCurrent(approval: PlanApprovalDto, plan: Pick<PlanDto, "revision">): boolean {
  return approval.kind === "approve" && approval.revision === plan.revision && approval.invalidatedAt === null;
}

/** Nodes ready to dispatch now, in stable outline order. */
export function dependencyReadyNodes(document: Pick<PlanDocument, "nodes" | "edges">): PlanNodeDto[] {
  const nodes = new Map(document.nodes.map((node) => [node.id, node]));
  return document.nodes
    .filter((node) => node.status === "pending" || node.status === "ready")
    .filter((node) => document.edges
      .filter((edge) => edge.toNodeId === node.id)
      .every((edge) => nodes.get(edge.fromNodeId)?.status === "completed"))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** Pending nodes whose dependencies have terminally failed and cannot become ready. */
export function dependencyBlockedNodes(document: Pick<PlanDocument, "nodes" | "edges">): PlanNodeDto[] {
  const nodes = new Map(document.nodes.map((node) => [node.id, node]));
  return document.nodes.filter((node) => (node.status === "pending" || node.status === "ready")
    && document.edges.some((edge) => edge.toNodeId === node.id && ["failed", "blocked", "skipped"].includes(nodes.get(edge.fromNodeId)?.status ?? "")));
}

export interface PlanExport {
  schema: "salon.plan.v1";
  exportedAt: string;
  document: PlanDocument;
  approvals: readonly PlanApprovalDto[];
  executions: readonly PlanExecutionDto[];
}

export function exportPlanJson(document: PlanDocument, approvals: readonly PlanApprovalDto[] = [], executions: readonly PlanExecutionDto[] = [], exportedAt = new Date().toISOString()): string {
  return JSON.stringify({ schema: "salon.plan.v1", exportedAt, document, approvals, executions } satisfies PlanExport, null, 2);
}

export function exportPlanMarkdown(document: PlanDocument, approvals: readonly PlanApprovalDto[] = [], executions: readonly PlanExecutionDto[] = []): string {
  const { plan } = document;
  const lines = [`# ${oneLine(plan.title)}`, "", `**Outcome:** ${oneLine(plan.outcome)}`, "", plan.description.trim(), "", `Revision ${plan.revision} · ${plan.status}`, ""];
  const nodes = [...document.nodes].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const names = new Map(nodes.map((node) => [node.id, oneLine(node.outcome)]));
  for (const node of nodes) {
    lines.push(`## ${node.order + 1}. ${oneLine(node.outcome)} \`${node.id}\``, "", `Status: **${node.status}**`, "");
    if (node.description.trim()) lines.push(node.description.trim(), "");
    const dependencies = document.edges.filter((edge) => edge.toNodeId === node.id).map((edge) => `${names.get(edge.fromNodeId) ?? edge.fromNodeId} (\`${edge.fromNodeId}\`)`);
    lines.push(`Dependencies: ${dependencies.length ? dependencies.join(", ") : "None"}`, "", "Acceptance criteria:", "");
    for (const criterion of node.acceptanceCriteria) lines.push(`- [ ] ${oneLine(criterion.text)} \`${criterion.id}\``);
    if (!node.acceptanceCriteria.length) lines.push("- None declared");
    lines.push("", `Declared scope: ${node.declaredScope.length ? node.declaredScope.map((path) => `\`${path}\``).join(", ") : "Not declared"}`, "");
    const runs = executions.filter((execution) => execution.nodeId === node.id);
    for (const run of runs) lines.push(`Execution \`${run.id}\`: ${run.status}${run.ending?.head ? ` at \`${run.ending.head}\`` : ""}`, "");
  }
  if (approvals.length) {
    lines.push("## Revision decisions", "");
    for (const approval of approvals) lines.push(`- ${approval.actor}: ${approval.kind} revision ${approval.revision}${approval.invalidatedAt ? " (invalidated)" : ""}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

/** Minimal authoritative plan view embedded in prompts across every runtime. */
export function serializePlanForPrompt(document: PlanDocument): string {
  const nodes = [...document.nodes].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)).map((node) => ({
    id: node.id,
    outcome: node.outcome,
    description: node.description,
    acceptanceCriteria: node.acceptanceCriteria,
    declaredScope: node.declaredScope,
    dependencies: document.edges.filter((edge) => edge.toNodeId === node.id).map((edge) => edge.fromNodeId).sort(),
    status: node.status,
    order: node.order,
  }));
  return JSON.stringify({ schema: "salon.plan.prompt.v1", planId: document.plan.id, revision: document.plan.revision, title: document.plan.title, outcome: document.plan.outcome, description: document.plan.description, nodes }, null, 2);
}

export function draftPlanPrompt(intent: string, current: PlanDocument | null = null): string {
  const schema = { title: "string", outcome: "string", description: "string", nodes: [{ id: "stable-kebab-id", outcome: "string", description: "string", acceptanceCriteria: [{ id: "stable-criterion-id", text: "observable result" }], declaredScope: ["path/or/glob"], dependencies: ["other-node-id"] }] };
  return [
    "Draft a Salon execution plan for the intent below.",
    "Return exactly one JSON object matching this schema; do not wrap it in Markdown.",
    JSON.stringify(schema, null, 2),
    "Dependencies must reference node ids in the draft and must form a DAG. Keep nodes independently executable and acceptance criteria objectively verifiable.",
    current ? `The current authoritative plan is included only as context. Propose a complete draft; it will be validated and reviewed, never silently adopted.\n${serializePlanForPrompt(current)}` : "There is no current plan.",
    `Intent:\n${intent.trim()}`,
  ].join("\n\n");
}

export function executionPrompt(document: PlanDocument, nodeId: string, executionId: string): string {
  const node = document.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`Plan node "${nodeId}" does not exist.`);
  const ready = dependencyReadyNodes(document).some((candidate) => candidate.id === nodeId);
  if (!ready) throw new Error(`Plan node "${nodeId}" is not dependency-ready.`);
  return [
    `Execute exactly one approved Salon plan node. Execution id: ${executionId}.`,
    `Authoritative plan (revision ${document.plan.revision}):\n${serializePlanForPrompt(document)}`,
    `Node to execute: ${node.id} — ${node.outcome}`,
    "Stay within its declared scope. For every acceptance criterion, report pass, fail, or unknown and cite deterministic evidence separately from your claims.",
    "Commit the completed node where practical so its evidence has a stable boundary. Do not start another plan node.",
  ].join("\n\n");
}

export function feedbackPrompt(document: PlanDocument, feedback: readonly PlanFeedback[]): string {
  const byNode = new Map<string, PlanFeedback[]>();
  for (const item of feedback) {
    const key = item.nodeId ?? "__plan__";
    byNode.set(key, [...(byNode.get(key) ?? []), item]);
  }
  const lines = ["Review the attributed feedback below and propose operation-based edits to the current plan. Do not replace approved content silently.", "", `Authoritative plan:\n${serializePlanForPrompt(document)}`, "", "Feedback:"];
  for (const [nodeId, items] of byNode) {
    lines.push("", nodeId === "__plan__" ? "Plan-wide:" : `Node ${nodeId}:`);
    for (const item of items) lines.push(`- ${item.author}${item.field ? ` (${item.field})` : ""}: ${item.body.trim().replace(/\n/g, "\n  ")}`);
  }
  return lines.join("\n").trimEnd();
}

/** Fill every declared criterion exactly once; missing results become unknown. */
export function completeConformance(node: Pick<PlanNodeDto, "acceptanceCriteria">, results: readonly CriterionResultDto[]): CriterionResultDto[] {
  const byId = new Map<string, CriterionResultDto>();
  for (const result of results) if (!byId.has(result.criterionId)) byId.set(result.criterionId, result);
  return node.acceptanceCriteria.map((criterion) => byId.get(criterion.id) ?? {
    criterionId: criterion.id,
    status: "unknown",
    explanation: "No conformance result was recorded.",
    evidence: [],
  });
}

/** Parse an execution/conformance report without trusting model-produced evidence links. */
export function parseCriterionResults(value: unknown, node: Pick<PlanNodeDto, "acceptanceCriteria">): CriterionResultDto[] | string {
  if (!Array.isArray(value)) return "Criterion results must be a list.";
  const wanted = new Set(node.acceptanceCriteria.map((criterion) => criterion.id));
  const seen = new Set<string>();
  const out: CriterionResultDto[] = [];
  for (const raw of value) {
    if (!record(raw)) return "Each criterion result must be an object.";
    const criterionId = parseId(raw.criterionId);
    if (!criterionId || !wanted.has(criterionId)) return `Criterion "${criterionId ?? ""}" is not part of this node.`;
    if (seen.has(criterionId)) return `Criterion "${criterionId}" was reported more than once.`;
    if (!isOneOf(raw.status, CRITERION_STATUSES)) return `Criterion "${criterionId}" needs a pass, fail, or unknown status.`;
    if (!Array.isArray(raw.evidence) || raw.evidence.length > LIST_MAX) return `Criterion "${criterionId}" evidence must be a list.`;
    const evidence: ConformanceEvidenceDto[] = [];
    for (const item of raw.evidence) {
      if (!record(item) || !isOneOf(item.kind, ["branch", "diff", "check", "test", "file", "model_claim"] as const)) return `Criterion "${criterionId}" has invalid evidence.`;
      const id = parseId(item.id);
      const label = requiredText(item.label, 2_000);
      if (!id || !label) return `Criterion "${criterionId}" evidence needs an id and label.`;
      const href = typeof item.href === "string" && item.href.startsWith("/") && !item.href.startsWith("//") ? item.href.slice(0, 2_000) : null;
      evidence.push({ id, kind: item.kind, label, href, path: optionalNullableText(item.path, 2_000), detail: optionalNullableText(item.detail, TEXT_MAX) });
    }
    seen.add(criterionId);
    out.push({ criterionId, status: raw.status, explanation: optionalText(raw.explanation, TEXT_MAX), evidence });
  }
  return out;
}

export function conformanceIsComplete(node: Pick<PlanNodeDto, "acceptanceCriteria">, results: readonly CriterionResultDto[]): boolean {
  const wanted = new Set(node.acceptanceCriteria.map((criterion) => criterion.id));
  return results.length === wanted.size && new Set(results.map((result) => result.criterionId)).size === wanted.size && results.every((result) => wanted.has(result.criterionId));
}

export function conformanceCounts(results: readonly CriterionResultDto[]): Record<CriterionStatus, number> {
  return results.reduce<Record<CriterionStatus, number>>((counts, result) => ({ ...counts, [result.status]: counts[result.status] + 1 }), { pass: 0, fail: 0, unknown: 0 });
}

/** Changed repository paths outside every declared path/glob. No declaration means no scope claim to contradict. */
export function scopeDrift(changedFiles: readonly string[], declaredScope: readonly string[]): string[] {
  const patterns = declaredScope.map(normalizeRepoPath).filter(Boolean);
  if (!patterns.length) return [];
  return [...new Set(changedFiles.map(normalizeRepoPath).filter(Boolean))].filter((path) => !patterns.some((pattern) => globMatches(pattern, path))).sort();
}

export const DEFAULT_SENSITIVE_PATHS = [".env", ".env.*", "**/.env", "**/.env.*", "**/*credential*", "**/*secret*", "**/*.pem", "**/*.key", ".github/workflows/**", "k8s/**"] as const;

export function sensitiveChangedFiles(changedFiles: readonly string[], patterns: readonly string[] = DEFAULT_SENSITIVE_PATHS): string[] {
  return [...new Set(changedFiles.map(normalizeRepoPath).filter(Boolean))].filter((path) => patterns.some((pattern) => globMatches(normalizeRepoPath(pattern), path))).sort();
}

export function exceptionReviewReasons(results: readonly CriterionResultDto[], drift: readonly string[], sensitive: readonly string[], planDrift = false, unexplained: readonly string[] = []): ExceptionReason[] {
  const reasons: ExceptionReason[] = [];
  if (results.some((result) => result.status === "fail")) reasons.push("failed_criterion");
  if (results.some((result) => result.status === "unknown")) reasons.push("unknown_criterion");
  if (drift.length) reasons.push("scope_drift");
  if (sensitive.length) reasons.push("sensitive_file");
  if (planDrift) reasons.push("plan_drift");
  if (unexplained.length) reasons.push("unexplained_change");
  return reasons;
}

function parseOperationNode(value: Record<string, unknown>): Omit<PlanNodeDto, "planId" | "createdAt" | "updatedAt"> | string {
  const id = parseId(value.id);
  if (!id) return "The new node needs a stable id.";
  const outcome = requiredText(value.outcome, TEXT_MAX);
  if (!outcome) return `Node "${id}" needs an outcome.`;
  const acceptanceCriteria = parseCriteria(value.acceptanceCriteria, id);
  if (typeof acceptanceCriteria === "string") return acceptanceCriteria;
  const declaredScope = parseStringList(value.declaredScope, 2_000);
  if (declaredScope === null) return `Node "${id}" declaredScope must be a list of repository paths.`;
  const status = isOneOf(value.status, PLAN_NODE_STATUSES) ? value.status : "pending";
  const order = nonNegativeInteger(value.order) ?? 0;
  return { id, outcome, description: optionalText(value.description, DESCRIPTION_MAX), acceptanceCriteria, declaredScope, status, order };
}

function parseCriteria(value: unknown, nodeId: string): AcceptanceCriterionDto[] | string {
  if (!Array.isArray(value) || value.length === 0) return `Node "${nodeId}" needs at least one acceptance criterion.`;
  if (value.length > LIST_MAX) return `Node "${nodeId}" has too many acceptance criteria.`;
  const out: AcceptanceCriterionDto[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const raw = value[index];
    const id = record(raw) ? parseId(raw.id) : null;
    const text = record(raw) ? requiredText(raw.text, TEXT_MAX) : "";
    if (!id || !text) return `Criterion ${index + 1} on node "${nodeId}" needs an id and text.`;
    if (ids.has(id)) return `Criterion id "${id}" is duplicated on node "${nodeId}".`;
    ids.add(id);
    out.push({ id, text });
  }
  return out;
}

function touchesNode(operation: PlanOperation, nodeId: string): boolean {
  switch (operation.type) {
    case "set_plan_field": return false;
    case "add_node": return operation.node.id === nodeId;
    case "set_node_field":
    case "remove_node":
    case "move_node": return operation.nodeId === nodeId || (operation.type === "move_node" && operation.afterNodeId === nodeId);
    case "add_edge":
    case "remove_edge": return operation.fromNodeId === nodeId || operation.toNodeId === nodeId;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseId(value: unknown): string | null {
  const id = typeof value === "string" ? value.trim() : "";
  return id && id.length <= ID_MAX && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(id) ? id : null;
}

function parseIdList(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > LIST_MAX) return null;
  const ids = value.map(parseId);
  return ids.some((id) => id === null) ? null : [...new Set(ids as string[])];
}

function parseStringList(value: unknown, maxLength: number): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > LIST_MAX || value.some((item) => typeof item !== "string")) return null;
  return [...new Set((value as string[]).map((item) => item.trim().slice(0, maxLength)).filter(Boolean))];
}

function requiredText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function optionalText(value: unknown, maxLength: number): string {
  return requiredText(value, maxLength);
}

function optionalNullableText(value: unknown, maxLength: number): string | null {
  const text = optionalText(value, maxLength);
  return text || null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isOneOf<const T extends readonly string[]>(value: unknown, choices: T): value is T[number] {
  return typeof value === "string" && (choices as readonly string[]).includes(value);
}

function oneLine(value: string): string {
  return value.trim().replace(/\s+/g, " ").replace(/[<>]/g, "");
}

function edgeId(fromNodeId: string, toNodeId: string): string {
  return `edge:${fromNodeId.length}:${fromNodeId}:${toNodeId.length}:${toNodeId}`;
}

function normalizeRepoPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/").replace(/^\//, "").replace(/\/$/, "");
}

/** Small, deterministic glob implementation: `*` stays within a segment; `**` crosses `/`. */
function globMatches(pattern: string, path: string): boolean {
  if (!pattern) return false;
  if (!pattern.includes("*")) return path === pattern || path.startsWith(`${pattern}/`);
  let source = "^";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    if (char === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (char === "*") source += "[^/]*";
    else source += /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`${source}$`).test(path);
}
