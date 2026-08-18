import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JsonValue } from "../src/orchestrator/contracts/event.js";
import {
  decodeCarryForwardChildActionV1,
  type CarryForwardChildActionV1,
  type InternalCarryForwardChildCommandV1,
  type InternalCarryForwardChildPlanV1,
  type WorkflowClaimAssertionV1,
} from "../src/orchestrator/lifecycle/contracts/commands.js";
import type { WorkflowId } from "../src/orchestrator/lifecycle/contracts/identifiers.js";
import {
  buildLifecycleIntentWitness,
  decodeLifecycleIntentWitness,
} from "../src/orchestrator/lifecycle/lifecycle-intent-witness.js";
import {
  decodeCarryForwardChildResultV1,
  decodeLifecycleWorkerSuccessForOperation,
  lifecycleNestedContractVersion,
  type LifecycleInternalOperationWire,
  type LifecycleInternalResultFor,
} from "../src/orchestrator/runtime/lifecycle-worker-protocol.js";

const IDS = {
  project: "11111111-1111-4111-8111-111111111111",
  vault: "22222222-2222-4222-8222-222222222222",
  store: "33333333-3333-4333-8333-333333333333",
  command: "44444444-4444-4444-8444-444444444444",
  root: "55555555-5555-4555-8555-555555555555",
  child: "66666666-6666-4666-8666-666666666666",
  workflow: "77777777-7777-4777-8777-777777777777",
  ticket: "88888888-8888-4888-8888-888888888888",
} as const;
const HASH = "a".repeat(64);

const actionInput = Object.freeze({
  action: "carry-forward-child",
  actionVersion: 1,
  rootSessionId: IDS.root,
  childSessionId: IDS.child,
  expectedChildState: "active",
  expectedChildHeadEventPosition: "10",
  expectedChildStreamVersion: "6",
  expectedChildAuthorityCommitment: HASH,
  expectedChildCapabilityGeneration: "2",
  expectedSuspensionEventPosition: null,
  checkpointId: IDS.root,
  checkpointEventPosition: "9",
  checkpointFingerprint: HASH,
});

const action = decodeCarryForwardChildActionV1(actionInput);

const claim: WorkflowClaimAssertionV1 = {
  workflowId: IDS.workflow as WorkflowId,
  workflowGeneration: 3,
  claimOwnerId: IDS.command,
  claimToken: "4",
  claimExpiresAt: "2099-01-01T00:00:00.000Z",
};

function commandBase() {
  return {
    commandType: "internal-workflow-phase" as const,
    commandId: IDS.command,
    idempotencyKey: "lifecycle-phase-v1/test",
    agentId: "coordinator",
    expectedProjectId: IDS.project as never,
    expectedVaultId: IDS.vault as never,
    expectedWorkspaceId: HASH as never,
    expectedBranchRef: null,
    workflowId: IDS.workflow as WorkflowId,
    workflowGeneration: 3,
    sourcePhase: "requested" as const,
    plannedWorkId: HASH,
    claim,
  };
}

function carryForwardPlan(): InternalCarryForwardChildPlanV1 {
  return Object.freeze({
    ...commandBase(),
    plannedAction: action,
  });
}

function carryForwardCommand(): InternalCarryForwardChildCommandV1 {
  return Object.freeze({
    ...commandBase(),
    action,
  });
}

function carryForwardResult(overrides: Record<string, JsonValue> = {}): JsonValue {
  return {
    resultVersion: 1,
    action: "carry-forward-child",
    workflowId: IDS.workflow,
    workflowGeneration: 3,
    plannedWorkId: HASH,
    rootSessionId: IDS.root,
    childSessionId: IDS.child,
    previousChildState: "active",
    childState: "transferred",
    transferTicketId: IDS.ticket,
    suspensionEventPosition: "12",
    transferTicketEventPosition: "13",
    finalChildStreamVersion: "8",
    ...overrides,
  };
}

describe("Task 14S child workflow contracts", () => {
  it("strictly decodes the carry-forward child action and result", () => {
    assert.deepEqual(action, actionInput);
    assert.deepEqual(
      decodeCarryForwardChildResultV1(carryForwardResult(), action),
      carryForwardResult(),
    );
    assert.throws(
      () => decodeCarryForwardChildActionV1({ ...actionInput, unexpected: true }),
      /LIFECYCLE_INPUT_INVALID/,
    );
    assert.throws(
      () => decodeCarryForwardChildResultV1(
        carryForwardResult({ childSessionId: IDS.root }),
        action,
      ),
      /WORKER_PROTOCOL_ERROR/,
    );
  });

  it("maps carry-forward plans to Version 1 child results", () => {
    type Result = LifecycleInternalResultFor<InternalCarryForwardChildPlanV1>;
    const result = decodeCarryForwardChildResultV1(carryForwardResult(), action);
    const typed = result as Result;
    assert.equal(typed.resultVersion, 1);
    const wire: LifecycleInternalOperationWire = {
      kind: "internal-semantic",
      operation: "internal-workflow-phase",
      command: carryForwardPlan(),
    };
    assert.equal(lifecycleNestedContractVersion(wire), 1);
    const decoded = decodeLifecycleWorkerSuccessForOperation({
      operation: "internal-workflow-phase",
      nestedContractVersion: 1,
      result: carryForwardResult(),
    }, wire);
    assert.deepEqual(decoded.result, result);
  });

  it("routes carry-forward only to the dedicated child-target handler", () => {
    const built = buildLifecycleIntentWitness(carryForwardCommand(), {
      authorizationKind: "internal-workflow",
      authorizationSessionId: IDS.root,
      targetSessionId: IDS.child,
      projectId: IDS.project,
      vaultId: IDS.vault,
      storeId: IDS.store,
      workspaceId: HASH,
      clientNamespace: "tests",
      capabilityKind: null,
      capabilityGeneration: null,
      presentingActorRole: "maintenance",
      presentingClientInstanceId: "coordinator",
      targetActorRole: "maintenance",
      targetClientInstanceId: "coordinator",
      internalWorkflowId: IDS.workflow,
      internalWorkflowGeneration: 3,
      internalPlannedWorkId: HASH,
    });
    const decoded = decodeLifecycleIntentWitness(built.source);
    assert.equal(decoded.intent.authorization.authorizationSessionId, IDS.root);
    assert.equal(decoded.intent.authorization.targetSessionId, IDS.child);
    assert.throws(() => buildLifecycleIntentWitness(carryForwardCommand(), {
      authorizationKind: "internal-workflow",
      authorizationSessionId: IDS.child,
      targetSessionId: IDS.root,
      projectId: IDS.project,
      vaultId: IDS.vault,
      storeId: IDS.store,
      workspaceId: HASH,
      clientNamespace: "tests",
      capabilityKind: null,
      capabilityGeneration: null,
      presentingActorRole: "maintenance",
      presentingClientInstanceId: "coordinator",
      targetActorRole: "maintenance",
      targetClientInstanceId: "coordinator",
      internalWorkflowId: IDS.workflow,
      internalWorkflowGeneration: 3,
      internalPlannedWorkId: HASH,
    }), /LIFECYCLE_INTENT_WITNESS_INVALID/);
  });

  it("enforces active/proposed and suspended stream formulas", () => {
    assert.doesNotThrow(() => decodeCarryForwardChildResultV1(carryForwardResult(), action));
    const suspended = decodeCarryForwardChildActionV1({
      ...actionInput,
      expectedChildState: "suspended",
      expectedChildHeadEventPosition: "50",
      expectedChildStreamVersion: "7",
      expectedSuspensionEventPosition: "40",
    });
    assert.doesNotThrow(() => decodeCarryForwardChildResultV1(carryForwardResult({
      previousChildState: "suspended",
      suspensionEventPosition: "40",
      transferTicketEventPosition: "55",
      finalChildStreamVersion: "8",
    }), suspended));
    assert.throws(() => decodeCarryForwardChildResultV1(carryForwardResult({
      transferTicketEventPosition: "14",
    }), action), /WORKER_PROTOCOL_ERROR/);
    assert.throws(() => decodeCarryForwardChildResultV1(carryForwardResult({
      finalChildStreamVersion: "7",
    }), action), /WORKER_PROTOCOL_ERROR/);
  });

  it("carries an already suspended child with a newer governing checkpoint", () => {
    const suspended = decodeCarryForwardChildActionV1({
      ...actionInput,
      expectedChildState: "suspended",
      expectedChildHeadEventPosition: "50",
      expectedChildStreamVersion: "7",
      expectedSuspensionEventPosition: "40",
      checkpointEventPosition: "49",
    });
    const result = decodeCarryForwardChildResultV1(carryForwardResult({
      previousChildState: "suspended",
      suspensionEventPosition: "40",
      transferTicketEventPosition: "55",
      finalChildStreamVersion: "8",
    }), suspended);
    assert.equal(result.previousChildState, "suspended");
    assert.equal(suspended.expectedSuspensionEventPosition, "40");
    assert.equal(suspended.checkpointEventPosition, "49");
  });
});
