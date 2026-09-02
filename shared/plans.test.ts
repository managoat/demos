import { describe, expect, test } from "bun:test";
import {
  applyPlanOperation,
  approvalIsCurrent,
  completeConformance,
  conformanceCounts,
  conformanceIsComplete,
  dependencyBlockedNodes,
  dependencyCycle,
  dependencyReadyNodes,
  documentFromDraft,
  draftPlanPrompt,
  eventForOperation,
  exceptionReviewReasons,
  executionPrompt,
  exportPlanJson,
  exportPlanMarkdown,
  feedbackPrompt,
  operationConflict,
  operationsCommute,
  operationsConflict,
  parseCriterionResults,
  parsePlanDraft,
  parsePlanOperation,
  parsePlanOperations,
  scopeDrift,
  sensitiveChangedFiles,
  serializePlanForPrompt,
  validateDependencies,
  validatePlanDocument,
  type PlanApprovalDto,
  type PlanDocument,
  type PlanEventDto,
  type PlanOperation,
} from "./plans";

const NOW = "2026-09-02T12:00:00.000Z";

function draftInput() {
  return {
    title: "Ship plan review",
    outcome: "Two people approve and execute a plan",
    description: "A durable Salon plan.",
    nodes: [
      {
        id: "domain",
        outcome: "Build plan domain",
        description: "Types and validation",
        acceptanceCriteria: [{ id: "domain-tests", text: "Domain tests pass" }],
        declaredScope: ["shared/**"],
        dependencies: [],
      },
      {
        id: "server",
        outcome: "Expose plan API",
        description: "Durable endpoints",
        acceptanceCriteria: [
          { id: "api-tests", text: "API tests pass" },
          { id: "auth-test", text: "Authority is enforced" },
        ],
        declaredScope: ["server/plans.ts", "server/db.ts"],
        dependencies: ["domain"],
      },
    ],
  };
}

function document(): PlanDocument {
  const parsed = parsePlanDraft(draftInput());
  if (typeof parsed === "string") throw new Error(parsed);
  return documentFromDraft(parsed, { id: "plan-1", chatId: "chat-1", createdBy: "host@example.test", createdAt: NOW });
}

function setNode(operation: { id: string; nodeId: string; field: "outcome" | "description"; value: string }): PlanOperation {
  return { type: "set_node_field", expectedRevision: 1, id: operation.id, nodeId: operation.nodeId, field: operation.field, value: operation.value };
}

describe("plan drafting and validation", () => {
  test("parses a structured draft and constructs revision one", () => {
    const parsed = parsePlanDraft(draftInput());
    expect(typeof parsed).not.toBe("string");
    if (typeof parsed === "string") return;
    const plan = documentFromDraft(parsed, { id: "plan-1", chatId: "chat-1", createdBy: "host", createdAt: NOW });
    expect(plan.plan).toMatchObject({ id: "plan-1", revision: 1, status: "draft" });
    expect(plan.nodes.map((node) => [node.id, node.order])).toEqual([["domain", 0], ["server", 1]]);
    expect(plan.edges).toMatchObject([{ fromNodeId: "domain", toNodeId: "server" }]);
    expect(validatePlanDocument(plan)).toEqual([]);
  });

  test("rejects missing, duplicate, self, and cyclic dependencies", () => {
    expect(validateDependencies(["a", "b"], [{ fromNodeId: "missing", toNodeId: "b" }])[0]).toContain("does not exist");
    expect(validateDependencies(["a"], [{ fromNodeId: "a", toNodeId: "a" }]).join(" ")).toContain("itself");
    const edges = [{ fromNodeId: "a", toNodeId: "b" }, { fromNodeId: "b", toNodeId: "c" }, { fromNodeId: "c", toNodeId: "a" }];
    expect(dependencyCycle(["a", "b", "c"], edges)).toEqual(["a", "b", "c", "a"]);
    const raw = draftInput();
    raw.nodes[0]!.dependencies = ["server"];
    expect(parsePlanDraft(raw)).toMatch(/cycle/i);
  });

  test("invalid structured output stays an error rather than a partial plan", () => {
    expect(parsePlanDraft(null)).toBe("A plan draft is required.");
    expect(parsePlanDraft({ ...draftInput(), nodes: [] })).toMatch(/at least one node/i);
    const missingCriterion = draftInput();
    missingCriterion.nodes[0]!.acceptanceCriteria = [];
    expect(parsePlanDraft(missingCriterion)).toMatch(/acceptance criterion/i);
  });
});

describe("operation parsing, revisions, and commutativity", () => {
  test("parses field-granular operations and rejects malformed batches", () => {
    const parsed = parsePlanOperation({ id: "op-1", expectedRevision: 1, type: "set_node_field", nodeId: "domain", field: "outcome", value: "Better domain" });
    expect(parsed).toMatchObject({ id: "op-1", nodeId: "domain", value: "Better domain" });
    expect(parsePlanOperation({ id: "op-2", expectedRevision: -1, type: "remove_node", nodeId: "domain" })).toMatch(/non-negative/);
    expect(parsePlanOperations([{ id: "same", expectedRevision: 1, type: "remove_node", nodeId: "a" }, { id: "same", expectedRevision: 1, type: "remove_node", nodeId: "b" }])).toMatch(/duplicated/);
  });

  test("independent node or field edits commute while same-field and destructive edits conflict", () => {
    const outcome = setNode({ id: "o1", nodeId: "domain", field: "outcome", value: "A" });
    const description = setNode({ id: "o2", nodeId: "domain", field: "description", value: "B" });
    const other = setNode({ id: "o3", nodeId: "server", field: "outcome", value: "C" });
    const same = setNode({ id: "o4", nodeId: "domain", field: "outcome", value: "D" });
    const remove: PlanOperation = { id: "o5", expectedRevision: 1, type: "remove_node", nodeId: "domain" };
    expect(operationsCommute(outcome, description)).toBe(true);
    expect(operationsCommute(outcome, other)).toBe(true);
    expect(operationsConflict(outcome, same)).toBe(true);
    expect(operationsConflict(remove, description)).toBe(true);
  });

  test("accepts a stale commuting edit only with complete intervening history", () => {
    const incoming = setNode({ id: "incoming", nodeId: "server", field: "description", value: "new" });
    const prior = setNode({ id: "prior", nodeId: "domain", field: "outcome", value: "changed" });
    const event: PlanEventDto = { id: "event-1", planId: "plan-1", operationId: prior.id, author: "a", beforeRevision: 1, afterRevision: 2, operation: prior, createdAt: NOW };
    expect(operationConflict(incoming, 2, [event])).toBeNull();
    expect(operationConflict(setNode({ id: "same", nodeId: "domain", field: "outcome", value: "again" }), 2, [event])).toMatchObject({ conflictingEventIds: ["event-1"] });
    expect(operationConflict(incoming, 3, [event])?.message).toMatch(/history is incomplete/);
  });

  test("applies operations immutably, advances revisions, and refuses a cycle", () => {
    const before = document();
    const operation = setNode({ id: "op", nodeId: "domain", field: "description", value: "Updated" });
    const after = applyPlanOperation(before, operation, "2026-09-02T13:00:00.000Z");
    expect(typeof after).not.toBe("string");
    if (typeof after === "string") return;
    expect(before.nodes[0]!.description).toBe("Types and validation");
    expect(after.nodes[0]!.description).toBe("Updated");
    expect(after.plan).toMatchObject({ revision: 2, status: "draft" });
    expect(eventForOperation(before, after, operation, { id: "event", author: "Jake", createdAt: NOW })).toMatchObject({ beforeRevision: 1, afterRevision: 2, operationId: "op" });

    const cycle: PlanOperation = { id: "cycle", expectedRevision: 1, type: "add_edge", edgeId: "edge-cycle", fromNodeId: "server", toNodeId: "domain" };
    expect(applyPlanOperation(before, cycle, NOW)).toMatch(/cycle/i);
    expect(before.edges).toHaveLength(1);
  });

  test("moves nodes and removes incident dependencies", () => {
    const before = document();
    const moved = applyPlanOperation(before, { id: "move", expectedRevision: 1, type: "move_node", nodeId: "server", afterNodeId: null }, NOW);
    expect(typeof moved).not.toBe("string");
    if (typeof moved === "string") expect.unreachable();
    else expect(moved.nodes.map((node) => node.id)).toEqual(["server", "domain"]);
    const removed = applyPlanOperation(before, { id: "remove", expectedRevision: 1, type: "remove_node", nodeId: "domain" }, NOW);
    expect(typeof removed).not.toBe("string");
    if (typeof removed !== "string") expect(removed.edges).toEqual([]);
  });
});

describe("approval and sequential readiness", () => {
  test("binds approval to an exact non-invalidated revision", () => {
    const approval: PlanApprovalDto = { id: "approval", planId: "plan-1", revision: 1, kind: "approve", actor: "host", createdAt: NOW, invalidatedAt: null, invalidatedByEventId: null };
    expect(approvalIsCurrent(approval, { revision: 1 })).toBe(true);
    expect(approvalIsCurrent({ ...approval, kind: "support" }, { revision: 1 })).toBe(false);
    expect(approvalIsCurrent(approval, { revision: 2 })).toBe(false);
    expect(approvalIsCurrent({ ...approval, invalidatedAt: NOW }, { revision: 1 })).toBe(false);
  });

  test("returns only dependency-ready nodes in outline order", () => {
    const plan = document();
    expect(dependencyReadyNodes(plan).map((node) => node.id)).toEqual(["domain"]);
    plan.nodes[0]!.status = "completed";
    expect(dependencyReadyNodes(plan).map((node) => node.id)).toEqual(["server"]);
    plan.nodes[0]!.status = "failed";
    expect(dependencyReadyNodes(plan)).toEqual([]);
    expect(dependencyBlockedNodes(plan).map((node) => node.id)).toEqual(["server"]);
  });
});

describe("portable exports and runtime prompts", () => {
  test("exports portable JSON and readable Markdown", () => {
    const plan = document();
    const json = JSON.parse(exportPlanJson(plan, [], [], NOW));
    expect(json).toMatchObject({ schema: "salon.plan.v1", exportedAt: NOW, document: { plan: { revision: 1 } } });
    const markdown = exportPlanMarkdown(plan);
    expect(markdown).toContain("# Ship plan review");
    expect(markdown).toContain("Dependencies: Build plan domain (`domain`)");
    expect(markdown).toContain("- [ ] API tests pass `api-tests`");
  });

  test("serializes the same plan and revision into draft, execution, and feedback prompts", () => {
    const plan = document();
    const serialized = serializePlanForPrompt(plan);
    expect(serialized).toContain('"revision": 1');
    expect(JSON.parse(serialized).nodes[1]).toMatchObject({ id: "server", dependencies: ["domain"] });
    expect(draftPlanPrompt("Please ship it", plan)).toContain(serialized);
    expect(executionPrompt(plan, "domain", "execution-1")).toContain(serialized);
    expect(() => executionPrompt(plan, "server", "execution-2")).toThrow(/not dependency-ready/);
    const feedback = feedbackPrompt(plan, [
      { nodeId: "server", field: "outcome", author: "Alice", body: "Clarify the API." },
      { nodeId: "server", field: null, author: "Bob", body: "Add a race test." },
    ]);
    expect(feedback).toContain(serialized);
    expect(feedback).toContain("Node server:");
    expect(feedback).toContain("Alice (outcome): Clarify the API.");
  });
});

describe("conformance and exception review", () => {
  test("fills missing criteria as unknown and detects completeness", () => {
    const node = document().nodes[1]!;
    const results = [{ criterionId: "api-tests", status: "pass" as const, explanation: "bun test passed", evidence: [] }];
    expect(conformanceIsComplete(node, results)).toBe(false);
    const complete = completeConformance(node, results);
    expect(complete).toMatchObject([
      { criterionId: "api-tests", status: "pass" },
      { criterionId: "auth-test", status: "unknown" },
    ]);
    expect(conformanceIsComplete(node, complete)).toBe(true);
    expect(conformanceCounts(complete)).toEqual({ pass: 1, fail: 0, unknown: 1 });
  });

  test("parses only results for declared criteria and safe application-relative evidence links", () => {
    const node = document().nodes[0]!;
    const parsed = parseCriterionResults([{ criterionId: "domain-tests", status: "pass", explanation: "Passed", evidence: [{ id: "test-1", kind: "test", label: "bun test", href: "/evidence/1", path: null, detail: "1 pass" }] }], node);
    expect(parsed).toMatchObject([{ criterionId: "domain-tests", evidence: [{ href: "/evidence/1" }] }]);
    expect(parseCriterionResults([{ criterionId: "made-up", status: "pass", evidence: [] }], node)).toMatch(/not part/);
    const external = parseCriterionResults([{ criterionId: "domain-tests", status: "unknown", evidence: [{ id: "claim", kind: "model_claim", label: "claim", href: "https://bad.test" }] }], node);
    expect(external).toMatchObject([{ evidence: [{ href: null }] }]);
  });

  test("finds path/glob drift and sensitive changes", () => {
    expect(scopeDrift(["shared/plans.ts", "shared/deep/a.ts", "server/app.ts"], ["shared/**"])).toEqual(["server/app.ts"]);
    expect(scopeDrift(["anything.ts"], [])).toEqual([]);
    expect(sensitiveChangedFiles(["src/App.tsx", ".env.local", "k8s/deployment.yaml", "certs/server.pem"])).toEqual([".env.local", "certs/server.pem", "k8s/deployment.yaml"]);
  });

  test("requires exception review for failures, unknowns, drift, sensitive files, or plan drift", () => {
    expect(exceptionReviewReasons([
      { criterionId: "a", status: "fail", explanation: "", evidence: [] },
      { criterionId: "b", status: "unknown", explanation: "", evidence: [] },
    ], ["outside.ts"], [".env"], true)).toEqual(["failed_criterion", "unknown_criterion", "scope_drift", "sensitive_file", "plan_drift"]);
  });
});
