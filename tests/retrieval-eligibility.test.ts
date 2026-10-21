import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  BranchScopeId,
  ProjectId,
  StoreId,
  VaultId,
  WorkspaceId,
} from "../src/orchestrator/identity/contracts.js";
import type { ProjectBinding } from "../src/orchestrator/projections/contracts.js";
import type {
  InternalRetrievalRequest,
  RetrievalItem,
} from "../src/orchestrator/retrieval/contracts.js";
import {
  branchVisible,
  freshnessVisible,
  isEligible,
  sessionVisible,
  statusVisible,
  temporalVisible,
  workspaceVisible,
} from "../src/orchestrator/retrieval/eligibility.js";

const PROJECT_ID = "1".repeat(64) as ProjectId;
const WORKSPACE_ID = "2".repeat(64) as WorkspaceId;
const BRANCH_SCOPE_ID = "00000000-0000-4000-8000-000000000501" as BranchScopeId;
const SESSION_ID = "00000000-0000-4000-8000-000000000502";

const BINDING: ProjectBinding = Object.freeze({
  projectId: PROJECT_ID,
  vaultId: "3".repeat(64) as VaultId,
  storeId: "4".repeat(64) as StoreId,
  workspaceId: WORKSPACE_ID,
  branchScopeId: BRANCH_SCOPE_ID,
  branchRef: "refs/heads/task-5",
  sessionId: null,
});

const REQUEST: InternalRetrievalRequest = Object.freeze({
  binding: BINDING,
  query: "same-task",
  limit: 10,
  tokenBudget: 1_200,
  consistency: Object.freeze({ requiredEventPosition: 12n, deadlineMs: 100 }),
  sessionId: SESSION_ID,
  visibility: "session",
  validAt: "2026-08-24T00:00:00.000Z",
  knownAt: 7n,
});

function item(overrides: Partial<RetrievalItem> = {}): RetrievalItem {
  return Object.freeze({
    id: "item-eligible",
    kind: "canonical",
    projectId: PROJECT_ID,
    workspaceId: WORKSPACE_ID,
    branchScopeId: BRANCH_SCOPE_ID,
    branchRef: "refs/heads/task-5",
    sessionId: SESSION_ID,
    visibility: "session",
    status: "verified",
    confidence: "high",
    verificationMethod: "committed-event",
    validFrom: "2026-01-01T00:00:00.000Z",
    validTo: "2027-01-01T00:00:00.000Z",
    knownFromEventPosition: 7n,
    sourceEventPosition: 7n,
    summary: "same-task",
    normalizedKey: "decision:same-task",
    anchor: null,
    freshness: "fresh",
    conflictGroupId: null,
    supersedingItemId: null,
    retrievalFeedbackScoreUnits: 0,
    ...overrides,
  });
}

describe("retrieval eligibility", () => {
  it("requires every private scope predicate before an item is eligible", () => {
    const eligible = item();
    assert.equal(workspaceVisible(eligible, BINDING, REQUEST), true);
    assert.equal(branchVisible(eligible, BINDING, REQUEST), true);
    assert.equal(sessionVisible(eligible, REQUEST), true);
    assert.equal(isEligible(eligible, REQUEST, BINDING), true);

    assert.equal(
      isEligible(item({ projectId: "9".repeat(64) as ProjectId }), REQUEST, BINDING),
      false,
    );
    assert.equal(
      isEligible(item({ workspaceId: "8".repeat(64) as WorkspaceId }), REQUEST, BINDING),
      false,
    );
    assert.equal(
      isEligible(
        item({ branchScopeId: "00000000-0000-4000-8000-000000000599" as BranchScopeId }),
        REQUEST,
        BINDING,
      ),
      false,
    );
    assert.equal(
      isEligible(item({ branchRef: "refs/heads/other" }), REQUEST, BINDING),
      false,
    );
    assert.equal(
      isEligible(item({ sessionId: "00000000-0000-4000-8000-000000000598" }), REQUEST, BINDING),
      false,
    );
    assert.equal(
      isEligible(item({ sessionId: null, visibility: "branch" }), {
        ...REQUEST,
        sessionId: undefined,
        visibility: "project",
      }, BINDING),
      false,
      "a model-visible project assertion must not widen to branch material",
    );
    assert.equal(
      isEligible(item(), { ...REQUEST, visibility: "branch" }, BINDING),
      false,
      "a branch assertion must not widen to session material",
    );
  });

  it("uses inclusive valid-from, exclusive valid-to, and known-at bounds", () => {
    const atStart = { ...REQUEST, validAt: "2026-01-01T00:00:00.000Z" };
    const atEnd = { ...REQUEST, validAt: "2027-01-01T00:00:00.000Z" };
    assert.equal(temporalVisible(item(), atStart), true);
    assert.equal(temporalVisible(item(), atEnd), false);
    assert.equal(temporalVisible(item({ knownFromEventPosition: 8n }), REQUEST), false);
    assert.equal(temporalVisible(item({ validTo: null }), atEnd), true);
    assert.equal(isEligible(item({ knownFromEventPosition: 8n }), REQUEST, BINDING), false);
  });

  it("rejects unreadable state and stale or corrupt source rows", () => {
    assert.equal(statusVisible(item({ status: "verified" })), true);
    assert.equal(statusVisible(item({ status: "superseded" })), true);
    for (const status of ["retracted", "expired", "erased-evidence"] as const) {
      assert.equal(statusVisible(item({ status })), false);
      assert.equal(isEligible(item({ status }), REQUEST, BINDING), false);
    }
    assert.equal(freshnessVisible(item({ freshness: "fresh" })), true);
    assert.equal(freshnessVisible(item({ freshness: "stale" })), false);
    assert.equal(freshnessVisible(item({ freshness: "corrupt" })), false);
  });
});
