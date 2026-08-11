import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import type { StoredEvent } from "../src/orchestrator/contracts/event.js";
import type {
  SqliteConnection,
  SqliteRow,
  SqliteStatement,
} from "../src/orchestrator/storage/sqlite-driver.js";
import {
  CHILD_EVENT_FOLD_CURSOR_SQL,
  WORKFLOW_GENERATION_FOLD_CURSOR_SQL,
  openChildEventFoldCursor,
  openWorkflowGenerationFoldCursor,
} from "../src/orchestrator/storage/lifecycle-projection.repository.js";
import type { LifecycleIntentWitnessV1 } from "../src/orchestrator/lifecycle/lifecycle-intent-witness.js";
import type {
  CheckpointId,
  ReportId,
  ReportItemId,
} from "../src/orchestrator/lifecycle/contracts/identifiers.js";
import {
  type ChildEventFoldProjection,
  type WorkflowFingerprintV2Input,
  advanceReportIndexFingerprint,
  childEventFoldFingerprint,
  classifyChildProjectionEvent,
  classifyWorkflowProjectionEvent,
  foldChildEventProjection,
  foldWorkflowGenerationProjection,
  reportIndexGenesisFingerprint,
  reportItemSetFingerprint,
  reportWitnessFingerprint,
  workflowGenerationFingerprint,
} from "../src/orchestrator/lifecycle/lifecycle-projection-folds.js";
import * as lifecycleProjectionFolds from "../src/orchestrator/lifecycle/lifecycle-projection-folds.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import {
  CHILD_SESSION_ID,
  PROJECT_ID,
  ROOT_SESSION_ID,
  STORE_ID,
  VAULT_ID,
  WORKFLOW_ID,
  WORKSPACE_ID,
  childDispositionFixture,
  childReportFixture,
  checkpointFixture,
  lifecycleEvent,
  lifecycleTimestamp,
  lifecycleUuid,
} from "./support/lifecycle-fixtures.js";
import {
  referenceAdvanceReportIndexFingerprint,
  referenceChildEventFoldFingerprint,
  referenceReportIndexGenesisFingerprint,
  referenceReportItemSetFingerprint,
  referenceReportWitnessFingerprint,
  referenceWorkflowGenerationFingerprint,
} from "./support/lifecycle-projection-reference.js";
import {
  referenceSessionEndEffectiveStateHashV1,
  sessionEndEffectiveStateFixture,
} from "./support/session-end-effective-state-reference.js";

function stored(
  event: ReturnType<typeof lifecycleEvent>,
  overrides: Partial<StoredEvent> = {},
): StoredEvent {
  return {
    globalPosition: BigInt(event.globalPosition),
    eventId: event.eventId,
    projectId: event.projectId,
    vaultId: event.vaultId,
    storeId: event.storeId,
    workspaceId: event.workspaceId,
    branchScopeId: null,
    branchRef: null,
    streamId: event.streamId,
    streamType: "session",
    streamVersion: BigInt(event.streamVersion),
    eventType: event.eventType,
    eventSchemaVersion: event.eventSchemaVersion,
    sessionId: event.sessionId,
    parentSessionId: event.parentSessionId,
    actorRole: "primary",
    agentId: "agent-primary",
    clientInstanceId: "client-primary",
    correlationId: event.correlationId,
    causationId: event.causationId,
    commandId: event.commandId,
    idempotencyKey: event.idempotencyKey,
    commandEventIndex: 0,
    occurredAt: event.occurredAt,
    recordedAt: event.occurredAt,
    visibilityScope: "session",
    confidence: "high",
    verificationStatus: "verified",
    sourceRefs: [],
    evidenceRefs: [],
    evidenceDigests: [],
    payload: event.payload,
    payloadJson: canonicalJson(event.payload),
    payloadHash: "a".repeat(64),
    previousGlobalHash: "b".repeat(64),
    eventHash: "c".repeat(64),
    lifecycleIntentJson: null,
    ...overrides,
  } as StoredEvent;
}

it("computes exact V2 workflow-generation fingerprint predecessor chains", () => {
  const initialFixture = Object.freeze({
    projectId: "11111111-1111-4111-8111-111111111111",
    workflowId: "22222222-2222-4222-8222-222222222222",
    workflowGeneration: 1,
    sessionId: "33333333-3333-4333-8333-333333333333",
    triggerEventPosition: 10n,
    triggerEventHash: "a".repeat(64),
    rootCommandId: "44444444-4444-4444-8444-444444444444",
    evidenceWindowState: "open" as const,
    replacementCheckpointVersion: 2 as const,
    effectiveCheckpointVersion: 2 as const,
    effectiveDraftSourceEventPosition: 10n,
    effectiveStateSourceEventPosition: 10n,
    effectiveStateVersion: 1 as const,
    effectiveStateHash: "b".repeat(64),
    previousFingerprintSchemaVersion: null,
    previousFingerprint: null,
  });
  const fromV1Fixture = Object.freeze({
    ...initialFixture,
    workflowGeneration: 2,
    triggerEventPosition: 10n,
    triggerEventHash: "c".repeat(64),
    evidenceWindowState: "sealed" as const,
    replacementCheckpointVersion: null,
    effectiveDraftSourceEventPosition: 9n,
    effectiveStateSourceEventPosition: 10n,
    effectiveStateHash: "d".repeat(64),
    previousFingerprintSchemaVersion: 1 as const,
    previousFingerprint: "f8139b1cc425178e9d4c09362948aff72f8571971d31995887f90d657cf7c99c",
  });
  const fromV2Fixture = Object.freeze({
    ...fromV1Fixture,
    workflowGeneration: 3,
    triggerEventPosition: 11n,
    triggerEventHash: "f".repeat(64),
    effectiveStateSourceEventPosition: 11n,
    effectiveStateHash: "0".repeat(64),
    previousFingerprintSchemaVersion: 2 as const,
    previousFingerprint: "0f44ff88228b42170931ea68e2c244e766e12f06de619f6784453daaa8a485a0",
  });
  const fingerprint = Reflect.get(lifecycleProjectionFolds, "workflowFingerprintV2");
  assert.equal(typeof fingerprint, "function");
  assert.equal(Reflect.apply(fingerprint as Function, undefined, [initialFixture]), "edcc178050728d5b2212a7c60ccad2749365ea6ca810cb0ce22cfac30429278a");
  assert.equal(Reflect.apply(fingerprint as Function, undefined, [fromV1Fixture]), "0f44ff88228b42170931ea68e2c244e766e12f06de619f6784453daaa8a485a0");
  assert.equal(Reflect.apply(fingerprint as Function, undefined, [fromV2Fixture]), "7ca14d8564fd48d5418d55fe43ac59f483ae312af3e760650b52e6f4386922ad");
});

it("rejects a legacy workflow event after a Version-2 predecessor", () => {
  const previous = Object.freeze({
    projectId: PROJECT_ID,
    workflowId: WORKFLOW_ID,
    workflowGeneration: 1,
    sessionId: ROOT_SESSION_ID,
    triggerEventPosition: 1n,
    rootCommandId: lifecycleUuid(91_001),
    evidenceWindowState: "sealed" as const,
    replacementCheckpointVersion: 1 as const,
    effectiveCheckpointVersion: 1 as const,
    effectiveDraftSourceEventPosition: 1n,
    fingerprintSchemaVersion: 2 as const,
    effectiveStateSourceEventPosition: 1n,
    effectiveStateVersion: 1 as const,
    effectiveStateHash: "a".repeat(64),
    previousFingerprint: null,
    fingerprint: "b".repeat(64),
  });
  const commandId = lifecycleUuid(91_002);
  const legacyCancellation = rootStored({
    position: 2n,
    streamVersion: 2n,
    eventType: "SessionEndCancelled",
    eventSchemaVersion: 1,
    commandId,
    payload: {
      workflowId: WORKFLOW_ID,
      workflowGeneration: 2,
      restoredState: "active",
      preTransitionCheckpointId: lifecycleUuid(91_003),
    },
  });
  assert.throws(() => foldWorkflowGenerationProjection(
    previous,
    legacyCancellation,
    intent({
      commandType: "cancel-session-end",
      commandId,
      idempotencyKey: "projection/no-downgrade",
      agentId: "agent-primary",
      expectedProjectId: PROJECT_ID,
      expectedVaultId: VAULT_ID,
      expectedWorkspaceId: WORKSPACE_ID,
      expectedBranchRef: null,
      sessionId: ROOT_SESSION_ID,
      workflowId: WORKFLOW_ID,
      expectedStreamVersion: "1",
      preTransitionCheckpointId: lifecycleUuid(91_003),
    }),
    "live-schema-3",
  ));
});

it("requires V3 cancellation to advance exactly one generation in every compatibility mode", () => {
  const requestCommandId = lifecycleUuid(91_100);
  const request = rootStored({
    position: 1n,
    streamVersion: 1n,
    eventType: "SessionEndRequested",
    eventSchemaVersion: 1,
    commandId: requestCommandId,
    payload: {
      workflowId: WORKFLOW_ID,
      workflowGeneration: 1,
      previousState: "active",
      childEndPolicy: "require-completed",
      qualityThreshold: 0,
      requireFullEvidence: false,
      requireMaterialization: false,
    },
  });
  const generationOne = foldWorkflowGenerationProjection(null, request, intent({
    commandType: "request-session-end",
    commandId: requestCommandId,
    idempotencyKey: "projection/cancel-version/request",
    agentId: "agent-primary",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: null,
    request: {
      requestVersion: 1,
      sessionId: ROOT_SESSION_ID,
      childEndPolicy: "require-completed",
      finalCheckpoint: checkpointDraft(1),
      validationProfileIds: [],
      requestedQualityThreshold: 0,
      requireFullEvidence: false,
      requireMaterialization: false,
    },
  }), "live-schema-3");
  const amendmentCheckpointId = lifecycleUuid(91_101);
  const amendmentCommandId = lifecycleUuid(91_102);
  const amendment = rootStored({
    position: 2n,
    streamVersion: 2n,
    eventType: "SessionEndAmended",
    eventSchemaVersion: 1,
    commandId: amendmentCommandId,
    payload: {
      workflowId: WORKFLOW_ID,
      previousWorkflowGeneration: 1,
      workflowGeneration: 2,
      preTransitionCheckpointId: amendmentCheckpointId,
    },
  });
  const previous = foldWorkflowGenerationProjection(
    generationOne,
    amendment,
    intent({
      commandType: "amend-session-end",
      commandId: amendmentCommandId,
      idempotencyKey: "projection/cancel-version/amend",
      agentId: "agent-primary",
      expectedProjectId: PROJECT_ID,
      expectedVaultId: VAULT_ID,
      expectedWorkspaceId: WORKSPACE_ID,
      expectedBranchRef: null,
      sessionId: ROOT_SESSION_ID,
      workflowId: WORKFLOW_ID,
      expectedStreamVersion: "1",
      amendment: {
        amendmentVersion: 1,
        childEndPolicy: null,
        finalCheckpoint: null,
        validationProfileIds: null,
        requestedQualityThreshold: null,
        requireFullEvidence: null,
        requireMaterialization: null,
      },
    }),
    "live-schema-3",
  );
  const checkpointId = lifecycleUuid(91_103);
  const commandId = lifecycleUuid(91_104);
  const cancellation = (
    previousWorkflowGeneration: number,
    workflowGeneration: number,
  ): StoredEvent => rootStored({
    position: 3n,
    streamVersion: 3n,
    eventType: "SessionEndCancelled",
    eventSchemaVersion: 3,
    commandId,
    payload: {
      cancellationVersion: 1,
      workflowId: WORKFLOW_ID,
      previousWorkflowGeneration,
      workflowGeneration,
      restoredState: "active",
      preTransitionCheckpointId: checkpointId,
    },
  });
  const cancellationIntent = intent({
    commandType: "cancel-session-end",
    commandId,
    idempotencyKey: "projection/cancel-version/cancel",
    agentId: "agent-primary",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: null,
    sessionId: ROOT_SESSION_ID,
    workflowId: WORKFLOW_ID,
    expectedStreamVersion: "2",
    preTransitionCheckpointId: checkpointId,
  });

  for (const mode of ["live-schema-3", "schema-2-preflight"] as const) {
    assert.equal(
      foldWorkflowGenerationProjection(
        previous,
        cancellation(2, 3),
        cancellationIntent,
        mode,
      ).workflowGeneration,
      3,
      mode,
    );
    assert.throws(() => foldWorkflowGenerationProjection(
      previous,
      cancellation(1, 2),
      cancellationIntent,
      mode,
    ), /LIFECYCLE_PROJECTION_INVALID/, mode);
  }
});

it("admits same-generation V1 cancellation only during schema-2 preflight", () => {
  const requestCommandId = lifecycleUuid(91_110);
  const request = rootStored({
    position: 1n,
    streamVersion: 1n,
    eventType: "SessionEndRequested",
    eventSchemaVersion: 1,
    commandId: requestCommandId,
    payload: {
      workflowId: WORKFLOW_ID,
      workflowGeneration: 1,
      previousState: "active",
      childEndPolicy: "require-completed",
      qualityThreshold: 0,
      requireFullEvidence: false,
      requireMaterialization: false,
    },
  });
  const previous = foldWorkflowGenerationProjection(null, request, intent({
    commandType: "request-session-end",
    commandId: requestCommandId,
    idempotencyKey: "projection/legacy-cancel/request",
    agentId: "agent-primary",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: null,
    request: {
      requestVersion: 1,
      sessionId: ROOT_SESSION_ID,
      childEndPolicy: "require-completed",
      finalCheckpoint: checkpointDraft(1),
      validationProfileIds: [],
      requestedQualityThreshold: 0,
      requireFullEvidence: false,
      requireMaterialization: false,
    },
  }), "live-schema-3");
  const checkpointId = lifecycleUuid(91_111);
  const commandId = lifecycleUuid(91_112);
  const cancellation = rootStored({
    position: 2n,
    streamVersion: 2n,
    eventType: "SessionEndCancelled",
    eventSchemaVersion: 1,
    commandId,
    payload: {
      workflowId: WORKFLOW_ID,
      workflowGeneration: 1,
      restoredState: "active",
      preTransitionCheckpointId: checkpointId,
    },
  });
  const cancellationIntent = intent({
    commandType: "cancel-session-end",
    commandId,
    idempotencyKey: "projection/legacy-cancel/cancel",
    agentId: "agent-primary",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: null,
    sessionId: ROOT_SESSION_ID,
    workflowId: WORKFLOW_ID,
    expectedStreamVersion: "1",
    preTransitionCheckpointId: checkpointId,
  });

  assert.equal(foldWorkflowGenerationProjection(
    previous,
    cancellation,
    cancellationIntent,
    "schema-2-preflight",
  ).workflowGeneration, 1);
  assert.throws(() => foldWorkflowGenerationProjection(
    previous,
    cancellation,
    cancellationIntent,
    "live-schema-3",
  ), /LIFECYCLE_PROJECTION_INVALID/);
});

it("folds a Version-1 null-draft amendment as implicit unchanged over a Version-2 snapshot", () => {
  const fixture = sessionEndEffectiveStateFixture({ requestVersion: 2 });
  const stateWithoutHash = {
    effectiveStateVersion: fixture.effectiveStateVersion,
    effectiveStateDomain: fixture.effectiveStateDomain,
    request: { ...fixture.request, sessionId: ROOT_SESSION_ID },
    effectivePolicy: fixture.effectivePolicy,
    effectiveFinalCheckpoint: fixture.effectiveFinalCheckpoint,
  };
  const effectiveState = {
    ...stateWithoutHash,
    effectiveStateHash: referenceSessionEndEffectiveStateHashV1(stateWithoutHash),
  };
  const requestCommandId = lifecycleUuid(91_010);
  const request = rootStored({
    position: 1n,
    streamVersion: 1n,
    eventType: "SessionEndRequested",
    eventSchemaVersion: 3,
    commandId: requestCommandId,
    payload: {
      workflowId: WORKFLOW_ID,
      workflowGeneration: 1,
      previousState: "active",
      effectiveState,
    },
  });
  const generationOne = foldWorkflowGenerationProjection(null, request, intent({
    commandType: "request-session-end",
    commandId: requestCommandId,
    idempotencyKey: "projection/v1-over-v2/request",
    agentId: "agent-primary",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: null,
    request: effectiveState.request,
  }), "live-schema-3");
  assert.equal(generationOne.evidenceWindowState, "open");

  const amendmentCommandId = lifecycleUuid(91_011);
  const amendment = rootStored({
    position: 2n,
    streamVersion: 2n,
    eventType: "SessionEndAmended",
    eventSchemaVersion: 3,
    commandId: amendmentCommandId,
    payload: {
      workflowId: WORKFLOW_ID,
      previousWorkflowGeneration: 1,
      workflowGeneration: 2,
      preTransitionCheckpointId: lifecycleUuid(91_012),
      evidenceWindowAction: "unchanged",
      effectiveState,
    },
  });
  const generationTwo = foldWorkflowGenerationProjection(generationOne, amendment, intent({
    commandType: "amend-session-end",
    commandId: amendmentCommandId,
    idempotencyKey: "projection/v1-over-v2/amend",
    agentId: "agent-primary",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: null,
    sessionId: ROOT_SESSION_ID,
    workflowId: WORKFLOW_ID,
    expectedStreamVersion: "1",
    amendment: {
      amendmentVersion: 1,
      childEndPolicy: null,
      finalCheckpoint: null,
      validationProfileIds: null,
      requestedQualityThreshold: null,
      requireFullEvidence: null,
      requireMaterialization: false,
    },
  }), "live-schema-3");
  assert.equal(generationTwo.evidenceWindowState, "open");
  assert.equal(generationTwo.effectiveCheckpointVersion, 2);
  assert.equal(generationTwo.effectiveDraftSourceEventPosition, 1n);
  assert.equal(generationTwo.effectiveStateSourceEventPosition, 2n);
});

it("independently reference-hashes every exact V2 field across predecessor forms", () => {
  const referencePreimage = (input: WorkflowFingerprintV2Input): readonly unknown[] => [
      input.projectId, input.workflowId, String(input.workflowGeneration), input.sessionId,
      String(input.triggerEventPosition), input.triggerEventHash, input.rootCommandId,
      input.evidenceWindowState, input.replacementCheckpointVersion,
      input.effectiveCheckpointVersion, String(input.effectiveDraftSourceEventPosition),
      input.effectiveStateSourceEventPosition === null ? null : String(input.effectiveStateSourceEventPosition),
      input.effectiveStateVersion, input.effectiveStateHash,
      input.previousFingerprintSchemaVersion, input.previousFingerprint,
    ];
  const reference = (input: WorkflowFingerprintV2Input): string => createHash("sha256")
    .update("project-memory/lifecycle/workflow-generation/v2\n", "utf8")
    .update(JSON.stringify(referencePreimage(input)), "utf8")
    .digest("hex");
  const projectId = "11111111-1111-4111-8111-111111111111";
  const workflowId = "22222222-2222-4222-8222-222222222222";
  const sessionId = "33333333-3333-4333-8333-333333333333";
  const rootCommandId = "44444444-4444-4444-8444-444444444444";
  const v1Predecessor = createHash("sha256")
    .update("project-memory/lifecycle/workflow-generation/v1\n", "utf8")
    .update(JSON.stringify([
      projectId, workflowId, "1", sessionId, "9", rootCommandId,
      "sealed", 1, 1, "9", null,
    ]), "utf8")
    .digest("hex");
  assert.equal(
    v1Predecessor,
    "f8139b1cc425178e9d4c09362948aff72f8571971d31995887f90d657cf7c99c",
  );
  const forms: readonly { readonly name: string; readonly input: WorkflowFingerprintV2Input }[] = [
    {
      name: "initial",
      input: {
        projectId, workflowId, workflowGeneration: 1, sessionId, triggerEventPosition: 10n,
        triggerEventHash: "a".repeat(64), rootCommandId, evidenceWindowState: "open",
        replacementCheckpointVersion: 2, effectiveCheckpointVersion: 2,
        effectiveDraftSourceEventPosition: 10n, effectiveStateSourceEventPosition: 10n,
        effectiveStateVersion: 1, effectiveStateHash: "b".repeat(64),
        previousFingerprintSchemaVersion: null, previousFingerprint: null,
      },
    },
    {
      name: "V1-to-V2",
      input: {
        projectId, workflowId, workflowGeneration: 2, sessionId, triggerEventPosition: 10n,
        triggerEventHash: "c".repeat(64), rootCommandId, evidenceWindowState: "sealed",
        replacementCheckpointVersion: null, effectiveCheckpointVersion: 2,
        effectiveDraftSourceEventPosition: 9n, effectiveStateSourceEventPosition: 10n,
        effectiveStateVersion: 1, effectiveStateHash: "d".repeat(64),
        previousFingerprintSchemaVersion: 1,
        previousFingerprint: v1Predecessor,
      },
    },
    {
      name: "V2-to-V2",
      input: {
        projectId, workflowId, workflowGeneration: 3, sessionId, triggerEventPosition: 11n,
        triggerEventHash: "f".repeat(64), rootCommandId, evidenceWindowState: "sealed",
        replacementCheckpointVersion: null, effectiveCheckpointVersion: 2,
        effectiveDraftSourceEventPosition: 9n, effectiveStateSourceEventPosition: 11n,
        effectiveStateVersion: 1, effectiveStateHash: "0".repeat(64),
        previousFingerprintSchemaVersion: 2,
        previousFingerprint: "0f44ff88228b42170931ea68e2c244e766e12f06de619f6784453daaa8a485a0",
      },
    },
  ];
  const validMutations: readonly {
    readonly name: string;
    readonly prepare?: (input: WorkflowFingerprintV2Input) => WorkflowFingerprintV2Input;
    readonly mutate: (input: WorkflowFingerprintV2Input) => WorkflowFingerprintV2Input;
  }[] = [
    { name: "projectId", mutate: (input) => ({ ...input, projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }) },
    { name: "workflowId", mutate: (input) => ({ ...input, workflowId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }) },
    { name: "workflowGeneration", mutate: (input) => ({ ...input, workflowGeneration: input.workflowGeneration + 10 }) },
    { name: "sessionId", mutate: (input) => ({ ...input, sessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }) },
    {
      name: "triggerEventPosition",
      prepare: (input) => ({ ...input, replacementCheckpointVersion: null }),
      mutate: (input) => ({ ...input, triggerEventPosition: input.triggerEventPosition + 1n }),
    },
    { name: "triggerEventHash", mutate: (input) => ({ ...input, triggerEventHash: "7".repeat(64) }) },
    { name: "rootCommandId", mutate: (input) => ({ ...input, rootCommandId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }) },
    { name: "evidenceWindowState", mutate: (input) => ({ ...input, evidenceWindowState: input.evidenceWindowState === "open" ? "sealed" : "open" }) },
    {
      name: "replacementCheckpointVersion",
      prepare: (input) => ({
        ...input, replacementCheckpointVersion: 2, effectiveCheckpointVersion: 2,
        effectiveDraftSourceEventPosition: input.triggerEventPosition,
      }),
      mutate: (input) => ({ ...input, replacementCheckpointVersion: null }),
    },
    {
      name: "effectiveCheckpointVersion",
      prepare: (input) => ({ ...input, evidenceWindowState: "sealed", replacementCheckpointVersion: null }),
      mutate: (input) => ({ ...input, effectiveCheckpointVersion: 1 }),
    },
    {
      name: "effectiveDraftSourceEventPosition",
      prepare: (input) => ({ ...input, replacementCheckpointVersion: null }),
      mutate: (input) => ({
        ...input,
        effectiveDraftSourceEventPosition: input.effectiveDraftSourceEventPosition === input.triggerEventPosition
          ? input.triggerEventPosition - 1n
          : input.triggerEventPosition,
      }),
    },
    {
      name: "effectiveStateSourceEventPosition",
      mutate: (input) => ({
        ...input,
        effectiveStateSourceEventPosition: input.effectiveStateSourceEventPosition === input.triggerEventPosition
          ? input.triggerEventPosition - 1n
          : input.triggerEventPosition,
      }),
    },
    { name: "effectiveStateHash", mutate: (input) => ({ ...input, effectiveStateHash: "9".repeat(64) }) },
  ];
  const assertValidBinding = (
    formName: string,
    fieldName: string,
    baseline: WorkflowFingerprintV2Input,
    candidate: WorkflowFingerprintV2Input,
  ): void => {
    assert.equal(
      referencePreimage(baseline).filter((value, index) => (
        !Object.is(value, referencePreimage(candidate)[index])
      )).length,
      1,
      `${formName}.${fieldName}.single-field mutation`,
    );
    const baselineExpected = reference(baseline);
    const candidateExpected = reference(candidate);
    assert.equal(
      lifecycleProjectionFolds.workflowFingerprintV2(baseline),
      baselineExpected,
      `${formName}.${fieldName}.baseline`,
    );
    assert.equal(
      lifecycleProjectionFolds.workflowFingerprintV2(candidate),
      candidateExpected,
      `${formName}.${fieldName}.candidate`,
    );
    assert.notEqual(candidateExpected, baselineExpected, `${formName}.${fieldName}.binding`);
  };

  for (const form of forms) {
    assert.equal(referencePreimage(form.input).length, 16, `${form.name}.canonical field count`);
    assert.equal(
      lifecycleProjectionFolds.workflowFingerprintV2(form.input),
      reference(form.input),
      `${form.name}.golden`,
    );
    for (const mutation of validMutations) {
      const baseline = mutation.prepare?.(form.input) ?? form.input;
      assertValidBinding(form.name, mutation.name, baseline, mutation.mutate(baseline));
    }

    // Version 1 is the only non-null effective-state version. Null is legal
    // only when the source-position and hash are also null, so no valid
    // singleton alternate exists for this canonical field.
    assert.throws(
      () => lifecycleProjectionFolds.workflowFingerprintV2({
        ...form.input,
        effectiveStateVersion: null,
      }),
      `${form.name}.effectiveStateVersion.null-pair invariant`,
    );
    assert.throws(
      () => lifecycleProjectionFolds.workflowFingerprintV2({
        ...form.input,
        effectiveStateVersion: 2,
      } as never),
      `${form.name}.effectiveStateVersion.exact-version invariant`,
    );

    if (form.input.previousFingerprint === null) {
      // Initial rows require the predecessor pair to remain null/null; each
      // singleton mutation is independently rejected.
      assert.throws(
        () => lifecycleProjectionFolds.workflowFingerprintV2({
          ...form.input,
          previousFingerprint: "8".repeat(64),
        }),
        "initial.previousFingerprint",
      );
      assert.throws(
        () => lifecycleProjectionFolds.workflowFingerprintV2({
          ...form.input,
          previousFingerprintSchemaVersion: 1,
        }),
        "initial.previousFingerprintSchemaVersion",
      );
    } else {
      assertValidBinding(form.name, "previousFingerprint", form.input, {
        ...form.input,
        previousFingerprint: "8".repeat(64),
      });
      assertValidBinding(form.name, "previousFingerprintSchemaVersion", form.input, {
        ...form.input,
        previousFingerprintSchemaVersion:
          form.input.previousFingerprintSchemaVersion === 1 ? 2 : 1,
      });
    }
  }
});

function rootStored(input: {
  readonly position: bigint;
  readonly streamVersion: bigint;
  readonly eventType:
    | "SessionEndRequested"
    | "SessionEndAmended"
    | "SessionEndCancelled"
    | "SessionAbandoned";
  readonly eventSchemaVersion: 1 | 2 | 3;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly commandId?: string;
  readonly commandEventIndex?: number;
}): StoredEvent {
  const commandId = input.commandId ?? lifecycleUuid(8_000 + Number(input.position));
  return {
    ...stored(lifecycleEvent(Number(input.position), "SessionEndRequested"), {
      globalPosition: input.position,
      streamVersion: input.streamVersion,
      eventType: input.eventType,
      eventSchemaVersion: input.eventSchemaVersion,
      sessionId: ROOT_SESSION_ID,
      parentSessionId: null,
      streamId: `session/${ROOT_SESSION_ID}`,
      commandId,
      commandEventIndex: input.commandEventIndex ?? 0,
      payload: input.payload as never,
      payloadJson: canonicalJson(input.payload),
    }),
  };
}

function intent(command: Readonly<Record<string, unknown>>): LifecycleIntentWitnessV1 {
  return {
    lifecycleIntentWitnessVersion: 1,
    intent: {
      lifecycleIntentVersion: 1,
      command,
      binding: {
        projectId: PROJECT_ID,
        vaultId: VAULT_ID,
        storeId: STORE_ID,
        workspaceId: WORKSPACE_ID,
        clientNamespace: "tests",
      },
      authorization: {
        authorizationKind: "protected",
        authorizationSessionId: ROOT_SESSION_ID,
        targetSessionId: ROOT_SESSION_ID,
        capabilityKind: "root-session-handle",
        capabilityGeneration: "1",
        presentingActorRole: "primary",
        presentingClientInstanceId: "client-primary",
        targetActorRole: "primary",
        targetClientInstanceId: "client-primary",
        internalWorkflowId: null,
        internalWorkflowGeneration: null,
        internalPlannedWorkId: null,
      },
    },
    persistedAssertions: {
      authorizationKind: "protected",
      authorizationSessionId: ROOT_SESSION_ID,
      targetSessionId: ROOT_SESSION_ID,
      projectId: PROJECT_ID,
      vaultId: VAULT_ID,
      storeId: STORE_ID,
      workspaceId: WORKSPACE_ID,
      clientNamespace: "tests",
      capabilityKind: "root-session-handle",
      capabilityGeneration: "1",
      presentingActorRole: "primary",
      presentingClientInstanceId: "client-primary",
      targetActorRole: "primary",
      targetClientInstanceId: "client-primary",
      internalWorkflowId: null,
      internalWorkflowGeneration: null,
      internalPlannedWorkId: null,
    },
  } as LifecycleIntentWitnessV1;
}

function checkpointDraft(version: 1 | 2): Readonly<Record<string, unknown>> {
  return {
    checkpointVersion: version,
    taskSummary: "projection fold",
    completedItems: [],
    inProgressItems: [],
    blockers: [],
    nextActions: [],
    decisions: [],
    assumptions: [],
    unresolvedConflicts: [],
    filesTouched: [],
    artifactReferences: [],
    sourceReferences: [],
    commandResults: [],
    testResults: [],
    materialClaims: [],
  };
}

function singleReusableRowConnection(initial: SqliteRow | readonly SqliteRow[]): {
  readonly connection: SqliteConnection;
  readonly raw: SqliteRow;
  readonly prepared: string[];
  readonly iterated: () => number;
  readonly returned: () => number;
} {
  const rows = Array.isArray(initial) ? initial : [initial];
  const raw = { ...rows[0]! };
  const prepared: string[] = [];
  let iterated = 0;
  let returned = 0;
  let nextIndex = 0;
  const iterator: IterableIterator<SqliteRow> = {
    next() {
      const source = rows[nextIndex];
      if (source === undefined) return { done: true, value: undefined };
      nextIndex += 1;
      for (const key of Object.keys(raw)) delete raw[key];
      Object.assign(raw, source);
      return { done: false, value: raw };
    },
    return() {
      returned += 1;
      return { done: true, value: undefined };
    },
    [Symbol.iterator]() { return this; },
  };
  const connection: SqliteConnection = {
    exec(): never { throw new Error("unexpected exec"); },
    prepare(sql): SqliteStatement {
      prepared.push(sql);
      return {
        run(): never { throw new Error("unexpected run"); },
        get(): never { throw new Error("unexpected get"); },
        all(): never { throw new Error("unexpected all"); },
        iterate(params) {
          assert.deepEqual(params, { $projectId: PROJECT_ID });
          iterated += 1;
          return iterator;
        },
      };
    },
    close(): void {},
  };
  return {
    connection,
    raw,
    prepared,
    iterated: () => iterated,
    returned: () => returned,
  };
}

describe("authenticated lifecycle projection folds", () => {
  it("ordered projection cursors detach lookahead count visits and close exactly once", () => {
    const childWithoutFingerprint = {
      projectId: PROJECT_ID,
      childSessionId: CHILD_SESSION_ID,
      eventPosition: 1n,
      streamVersion: 1n,
      rootSessionId: ROOT_SESSION_ID,
      childState: "active" as const,
      latestCheckpointId: null,
      latestCheckpointEventPosition: null,
      authorityCommitment: "a".repeat(64),
      terminalEventType: null,
      terminalEventPosition: null,
      reportCount: 0,
      latestReportId: null,
      reportIndexFingerprint: referenceReportIndexGenesisFingerprint(
        PROJECT_ID,
        CHILD_SESSION_ID,
      ),
      completionReportId: null,
      reportedReportId: null,
      reportedItemCount: null,
      reportedItemSetFingerprint: null,
      previousFingerprint: null,
    };
    const child = singleReusableRowConnection({
      project_id: PROJECT_ID,
      child_session_id: CHILD_SESSION_ID,
      event_position: 1n,
      stream_version: 1n,
      root_session_id: ROOT_SESSION_ID,
      child_state: "active",
      latest_checkpoint_id: null,
      latest_checkpoint_event_position: null,
      authority_commitment: childWithoutFingerprint.authorityCommitment,
      terminal_event_type: null,
      terminal_event_position: null,
      report_count: 0n,
      latest_report_id: null,
      report_index_fingerprint: childWithoutFingerprint.reportIndexFingerprint,
      completion_report_id: null,
      reported_report_id: null,
      reported_item_count: null,
      reported_item_set_fingerprint: null,
      previous_fingerprint: null,
      fingerprint: referenceChildEventFoldFingerprint(childWithoutFingerprint),
    });
    const childCursor = openChildEventFoldCursor(child.connection, PROJECT_ID);
    child.raw.child_session_id = "mutated-after-next";
    assert.equal(childCursor.visits, 0);
    assert.equal(childCursor.peek()?.childSessionId, CHILD_SESSION_ID);
    assert.equal(childCursor.peek()?.childSessionId, CHILD_SESSION_ID);
    assert.equal(childCursor.visits, 0);
    assert.equal(childCursor.advance().childSessionId, CHILD_SESSION_ID);
    assert.equal(childCursor.visits, 1);
    assert.equal(childCursor.peek(), null);
    assert.throws(() => childCursor.advance(), /INTEGRITY_FAILURE/);
    childCursor.close();
    childCursor.close();
    assert.deepEqual(child.prepared, [CHILD_EVENT_FOLD_CURSOR_SQL]);
    assert.equal(child.iterated(), 1);
    assert.equal(child.returned(), 1);

    const workflowWithoutFingerprint = {
      projectId: PROJECT_ID,
      workflowId: WORKFLOW_ID,
      workflowGeneration: 1,
      sessionId: ROOT_SESSION_ID,
      triggerEventPosition: 2n,
      rootCommandId: lifecycleUuid(82_001),
      evidenceWindowState: "open" as const,
      replacementCheckpointVersion: 2 as const,
      effectiveCheckpointVersion: 2 as const,
      effectiveDraftSourceEventPosition: 2n,
      previousFingerprint: null,
    };
    const workflow = singleReusableRowConnection({
      project_id: PROJECT_ID,
      workflow_id: WORKFLOW_ID,
      workflow_generation: 1n,
      session_id: ROOT_SESSION_ID,
      trigger_event_position: 2n,
      root_command_id: workflowWithoutFingerprint.rootCommandId,
      evidence_window_state: "open",
      replacement_checkpoint_version: 2n,
      effective_checkpoint_version: 2n,
      effective_draft_source_event_position: 2n,
      previous_fingerprint: null,
      fingerprint: referenceWorkflowGenerationFingerprint(workflowWithoutFingerprint),
    });
    const workflowCursor = openWorkflowGenerationFoldCursor(
      workflow.connection,
      PROJECT_ID,
    );
    workflow.raw.workflow_id = "mutated-after-next";
    assert.equal(workflowCursor.peek()?.workflowId, WORKFLOW_ID);
    assert.equal(workflowCursor.advance().workflowId, WORKFLOW_ID);
    assert.equal(workflowCursor.visits, 1);
    assert.equal(workflowCursor.peek(), null);
    workflowCursor.close();
    workflowCursor.close();
    assert.deepEqual(workflow.prepared, [WORKFLOW_GENERATION_FOLD_CURSOR_SQL]);
    assert.equal(workflow.iterated(), 1);
    assert.equal(workflow.returned(), 1);

    const malformed = singleReusableRowConnection({
      ...child.raw,
      child_session_id: CHILD_SESSION_ID,
      fingerprint: "not-a-hash",
    });
    assert.throws(
      () => openChildEventFoldCursor(malformed.connection, PROJECT_ID),
      /INTEGRITY_FAILURE/,
    );
    assert.equal(malformed.returned(), 1);
  });

  it("projection cursor counts only advances that return after priming valid lookahead", () => {
    const withoutFingerprint = {
      projectId: PROJECT_ID,
      childSessionId: CHILD_SESSION_ID,
      eventPosition: 1n,
      streamVersion: 1n,
      rootSessionId: ROOT_SESSION_ID,
      childState: "active" as const,
      latestCheckpointId: null,
      latestCheckpointEventPosition: null,
      authorityCommitment: "a".repeat(64),
      terminalEventType: null,
      terminalEventPosition: null,
      reportCount: 0,
      latestReportId: null,
      reportIndexFingerprint: referenceReportIndexGenesisFingerprint(
        PROJECT_ID,
        CHILD_SESSION_ID,
      ),
      completionReportId: null,
      reportedReportId: null,
      reportedItemCount: null,
      reportedItemSetFingerprint: null,
      previousFingerprint: null,
    };
    const fingerprint = referenceChildEventFoldFingerprint(withoutFingerprint);
    const valid: SqliteRow = {
      project_id: PROJECT_ID,
      child_session_id: CHILD_SESSION_ID,
      event_position: 1n,
      stream_version: 1n,
      root_session_id: ROOT_SESSION_ID,
      child_state: "active",
      latest_checkpoint_id: null,
      latest_checkpoint_event_position: null,
      authority_commitment: withoutFingerprint.authorityCommitment,
      terminal_event_type: null,
      terminal_event_position: null,
      report_count: 0n,
      latest_report_id: null,
      report_index_fingerprint: withoutFingerprint.reportIndexFingerprint,
      completion_report_id: null,
      reported_report_id: null,
      reported_item_count: null,
      reported_item_set_fingerprint: null,
      previous_fingerprint: null,
      fingerprint,
    };
    const rows = singleReusableRowConnection([
      valid,
      {
        ...valid,
        event_position: 2n,
        stream_version: 2n,
        previous_fingerprint: fingerprint,
        fingerprint: "malformed-next-row",
      },
    ]);
    const cursor = openChildEventFoldCursor(rows.connection, PROJECT_ID);
    assert.throws(() => cursor.advance(), /INTEGRITY_FAILURE/);
    assert.equal(cursor.visits, 0);
    cursor.close();
    assert.equal(rows.returned(), 1);
  });

  it("hydrates schema-4 Version-2 workflow fold metadata without falling back to Version 1", () => {
    const connection = singleReusableRowConnection({
      project_id: PROJECT_ID,
      workflow_id: WORKFLOW_ID,
      workflow_generation: 2n,
      session_id: ROOT_SESSION_ID,
      trigger_event_position: 8n,
      root_command_id: lifecycleUuid(82_100),
      evidence_window_state: "sealed",
      replacement_checkpoint_version: null,
      effective_checkpoint_version: 2n,
      effective_draft_source_event_position: 7n,
      fingerprint_schema_version: 2n,
      effective_state_source_event_position: 7n,
      effective_state_version: 1n,
      effective_state_hash: "a".repeat(64),
      previous_fingerprint: "b".repeat(64),
      fingerprint: "c".repeat(64),
    });
    const cursor = openWorkflowGenerationFoldCursor(connection.connection, PROJECT_ID);
    const row = cursor.advance();
    assert.equal(row.fingerprintSchemaVersion, 2);
    assert.equal(row.effectiveStateSourceEventPosition, 7n);
    assert.equal(row.effectiveStateVersion, 1);
    assert.equal(row.effectiveStateHash, "a".repeat(64));
  });

  it("shares the asymmetric child projection classifier with the writer and replay", () => {
    const childOnly = [
      "SessionForked",
      "ChildAssignmentAmended",
      "ChildWorkReported",
      "ChildWorkDispositioned",
      "ChildCompletionProposed",
      "ChildSessionCompleted",
      "ChildSessionSuspended",
      "ChildWorkTransferCreated",
      "ChildWorkTransferClaimed",
    ] as const;
    for (const eventType of childOnly) {
      assert.equal(
        classifyChildProjectionEvent({ eventType, parentSessionId: null }),
        "child-only",
        eventType,
      );
      assert.equal(
        classifyChildProjectionEvent({ eventType, parentSessionId: ROOT_SESSION_ID }),
        "child-only",
        eventType,
      );
    }
    for (const eventType of ["SessionCheckpointRecorded", "EvidenceCoverageRecorded"] as const) {
      assert.equal(
        classifyChildProjectionEvent({ eventType, parentSessionId: ROOT_SESSION_ID }),
        "dual-scope-child",
        eventType,
      );
      assert.equal(
        classifyChildProjectionEvent({ eventType, parentSessionId: null }),
        "none",
        eventType,
      );
    }
    assert.equal(
      classifyChildProjectionEvent({ eventType: "SessionStarted", parentSessionId: null }),
      "none",
    );
  });

  it("shares strict per-event workflow projection identity classification", () => {
    for (const eventType of [
      "SessionEndRequested",
      "SessionEndAmended",
      "SessionEndCancelled",
      "SessionAbandoned",
    ] as const) {
      assert.deepEqual(classifyWorkflowProjectionEvent({
        eventType,
        payload: { workflowId: WORKFLOW_ID, workflowGeneration: 3 },
      }), {
        kind: "identified",
        workflowId: WORKFLOW_ID,
        workflowGeneration: 3,
      }, eventType);
    }
    assert.deepEqual(classifyWorkflowProjectionEvent({
      eventType: "SessionAbandoned",
      payload: { workflowId: null, workflowGeneration: null },
    }), { kind: "null-identity-abandon" });
    assert.deepEqual(classifyWorkflowProjectionEvent({
      eventType: "SessionStarted",
      payload: {},
    }), { kind: "none" });
    for (const payload of [
      { workflowId: null, workflowGeneration: 1 },
      { workflowId: WORKFLOW_ID, workflowGeneration: null },
      { workflowId: "", workflowGeneration: 1 },
      { workflowId: "   ", workflowGeneration: 1 },
      { workflowId: WORKFLOW_ID, workflowGeneration: 0 },
      { workflowId: WORKFLOW_ID, workflowGeneration: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      assert.throws(
        () => classifyWorkflowProjectionEvent({
          eventType: "SessionAbandoned",
          payload,
        }),
        /LIFECYCLE_PROJECTION_INVALID/,
      );
    }
  });

  it("projection folds match independent canonical vectors and null-carry semantics", () => {
    const fork = foldChildEventProjection(
      null,
      stored(lifecycleEvent(1, "SessionForked")),
      null,
    );
    assert.equal(
      fork.reportIndexFingerprint,
      referenceReportIndexGenesisFingerprint(PROJECT_ID, CHILD_SESSION_ID),
    );
    assert.equal(
      reportIndexGenesisFingerprint(PROJECT_ID, CHILD_SESSION_ID),
      referenceReportIndexGenesisFingerprint(PROJECT_ID, CHILD_SESSION_ID),
    );
    assert.equal(fork.fingerprint, referenceChildEventFoldFingerprint(fork));

    const itemA = lifecycleUuid<ReportItemId>(51_001);
    const itemB = lifecycleUuid<ReportItemId>(51_002);
    const report = childReportFixture({
      reportId: lifecycleUuid<ReportId>(52_001),
      itemIds: [itemB, itemA],
    });
    const { allReportItemIds: _derivedItemIds, ...reportPayload } = report;
    const reported = foldChildEventProjection(
      fork,
      stored(lifecycleEvent(2, "ChildWorkReported", {
        report: reportPayload as never,
      }), {
        occurredAt: lifecycleTimestamp(3),
        recordedAt: lifecycleTimestamp(3),
      }),
      null,
    );
    const expectedSet = referenceReportItemSetFingerprint({
      projectId: PROJECT_ID,
      childSessionId: CHILD_SESSION_ID,
      reportId: report.reportId,
      allReportItemIds: report.allReportItemIds,
    });
    assert.equal(reported.reportedItemSetFingerprint, expectedSet);
    assert.equal(
      reportItemSetFingerprint({
        projectId: PROJECT_ID,
        childSessionId: CHILD_SESSION_ID,
        reportId: report.reportId,
        allReportItemIds: report.allReportItemIds,
      }),
      expectedSet,
    );
    assert.equal(
      reportWitnessFingerprint(reported),
      referenceReportWitnessFingerprint(reported),
    );
    assert.equal(
      reported.reportIndexFingerprint,
      referenceAdvanceReportIndexFingerprint({
        projectId: PROJECT_ID,
        childSessionId: CHILD_SESSION_ID,
        reportCount: 1,
        latestReportId: report.reportId,
        previousReportIndexFingerprint: fork.reportIndexFingerprint,
        reportWitnessFingerprint: referenceReportWitnessFingerprint(reported),
      }),
    );
    assert.equal(
      advanceReportIndexFingerprint({
        projectId: PROJECT_ID,
        childSessionId: CHILD_SESSION_ID,
        reportCount: 1,
        latestReportId: report.reportId,
        previousReportIndexFingerprint: fork.reportIndexFingerprint,
        reportWitnessFingerprint: referenceReportWitnessFingerprint(reported),
      }),
      reported.reportIndexFingerprint,
    );
    assert.equal(
      childEventFoldFingerprint({ ...reported, fingerprint: undefined } as never),
      referenceChildEventFoldFingerprint(reported),
    );

    const checkpoint = checkpointFixture({
      sessionId: CHILD_SESSION_ID,
      parentSessionId: ROOT_SESSION_ID,
      baseEventPosition: 2,
      checkpointEventPosition: 3,
    });
    const carried = foldChildEventProjection(
      reported,
      stored(lifecycleEvent(3, "SessionCheckpointRecorded", {
        checkpoint,
        baseEventPosition: "2",
        checkpointEventPosition: "3",
      }), { commandEventIndex: 1 }),
      null,
    );
    assert.equal(carried.reportIndexFingerprint, reported.reportIndexFingerprint);
    assert.equal(carried.reportedReportId, null);
    assert.equal(carried.reportedItemCount, null);
    assert.equal(carried.reportedItemSetFingerprint, null);
    assert.equal(carried.latestCheckpointId, checkpoint.checkpointId);
    assert.equal(carried.fingerprint, referenceChildEventFoldFingerprint(carried));
    assert.throws(() => reportItemSetFingerprint({
      projectId: PROJECT_ID,
      childSessionId: CHILD_SESSION_ID,
      reportId: report.reportId,
      allReportItemIds: [itemA, itemA],
    }));

    const requestCommandId = lifecycleUuid(53_001);
    const request = rootStored({
      position: 10n,
      streamVersion: 2n,
      eventType: "SessionEndRequested",
      eventSchemaVersion: 2,
      commandId: requestCommandId,
      commandEventIndex: 1,
      payload: {
        workflowId: WORKFLOW_ID,
        workflowGeneration: 1,
        previousState: "active",
        childEndPolicy: "require-completed",
        qualityThreshold: 0,
        requireFullEvidence: false,
        requireMaterialization: false,
        requestVersion: 2,
      },
    });
    const requestIntent = intent({
        commandType: "request-session-end",
        commandId: requestCommandId,
        idempotencyKey: "projection/request",
        agentId: "agent-primary",
        expectedProjectId: PROJECT_ID,
        expectedVaultId: VAULT_ID,
        expectedWorkspaceId: WORKSPACE_ID,
        expectedBranchRef: null,
        request: {
          requestVersion: 2,
          sessionId: ROOT_SESSION_ID,
          childEndPolicy: "require-completed",
          finalCheckpoint: checkpointDraft(2),
          validationProfileIds: [],
          requestedQualityThreshold: 0,
          requireFullEvidence: false,
          requireMaterialization: false,
        },
      });
    assert.throws(() => foldWorkflowGenerationProjection(
      null,
      {
        ...request,
        streamId: `session/${CHILD_SESSION_ID}`,
      },
      requestIntent,
      "live-schema-3",
    ));
    const generationOne = foldWorkflowGenerationProjection(
      null,
      request,
      requestIntent,
      "live-schema-3",
    );
    assert.equal(generationOne.replacementCheckpointVersion, 2);
    assert.equal(generationOne.effectiveCheckpointVersion, 2);
    assert.equal(generationOne.effectiveDraftSourceEventPosition, 10n);
    assert.equal(
      generationOne.fingerprint,
      referenceWorkflowGenerationFingerprint(generationOne),
    );

    const amendmentCommandId = lifecycleUuid(53_002);
    const amendment = rootStored({
      position: 11n,
      streamVersion: 3n,
      eventType: "SessionEndAmended",
      eventSchemaVersion: 2,
      commandId: amendmentCommandId,
      payload: {
        workflowId: WORKFLOW_ID,
        previousWorkflowGeneration: 1,
        workflowGeneration: 2,
        preTransitionCheckpointId: lifecycleUuid(53_003),
        amendmentVersion: 2,
        finalCheckpointVersion: null,
        evidenceWindowAction: "unchanged",
      },
    });
    const generationTwo = foldWorkflowGenerationProjection(
      generationOne,
      amendment,
      intent({
        commandType: "amend-session-end",
        commandId: amendmentCommandId,
        idempotencyKey: "projection/amend",
        agentId: "agent-primary",
        expectedProjectId: PROJECT_ID,
        expectedVaultId: VAULT_ID,
        expectedWorkspaceId: WORKSPACE_ID,
        expectedBranchRef: null,
        sessionId: ROOT_SESSION_ID,
        workflowId: WORKFLOW_ID,
        expectedStreamVersion: "2",
        amendment: {
          amendmentVersion: 2,
          childEndPolicy: null,
          finalCheckpoint: null,
          validationProfileIds: null,
          requestedQualityThreshold: null,
          requireFullEvidence: null,
          requireMaterialization: true,
          evidenceWindowAction: "unchanged",
        },
      }),
      "live-schema-3",
    );
    const crossProjectPrevious = {
      ...generationOne,
      projectId: VAULT_ID,
      fingerprint: workflowGenerationFingerprint({
        ...generationOne,
        projectId: VAULT_ID,
        fingerprint: undefined,
      } as never),
    };
    assert.throws(() => foldWorkflowGenerationProjection(
      crossProjectPrevious,
      amendment,
      intent({
        commandType: "amend-session-end",
        commandId: amendmentCommandId,
        idempotencyKey: "projection/amend",
        agentId: "agent-primary",
        expectedProjectId: PROJECT_ID,
        expectedVaultId: VAULT_ID,
        expectedWorkspaceId: WORKSPACE_ID,
        expectedBranchRef: null,
        sessionId: ROOT_SESSION_ID,
        workflowId: WORKFLOW_ID,
        expectedStreamVersion: "2",
        amendment: {
          amendmentVersion: 2,
          childEndPolicy: null,
          finalCheckpoint: null,
          validationProfileIds: null,
          requestedQualityThreshold: null,
          requireFullEvidence: null,
          requireMaterialization: true,
          evidenceWindowAction: "unchanged",
        },
      }),
      "live-schema-3",
    ));
    assert.equal(generationTwo.replacementCheckpointVersion, null);
    assert.equal(generationTwo.effectiveCheckpointVersion, 2);
    assert.equal(generationTwo.effectiveDraftSourceEventPosition, 10n);
    assert.equal(generationTwo.evidenceWindowState, generationOne.evidenceWindowState);
    assert.equal(generationTwo.previousFingerprint, generationOne.fingerprint);
    assert.equal(
      workflowGenerationFingerprint({
        ...generationTwo,
        fingerprint: undefined,
      } as never),
      referenceWorkflowGenerationFingerprint(generationTwo),
    );
  });

  it("defers internal transfer V2 child projection folding to Task 14S", () => {
    const fork = foldChildEventProjection(
      null,
      stored(lifecycleEvent(1, "SessionForked")),
      null,
    );
    const suspensionCheckpoint = checkpointFixture({
      sessionId: CHILD_SESSION_ID,
      parentSessionId: ROOT_SESSION_ID,
      baseEventPosition: 1,
      checkpointEventPosition: 2,
    });
    const checkpointed = foldChildEventProjection(
      fork,
      stored(lifecycleEvent(2, "SessionCheckpointRecorded", {
        checkpoint: suspensionCheckpoint,
        baseEventPosition: "1",
        checkpointEventPosition: "2",
      })),
      null,
    );
    const suspended = foldChildEventProjection(
      checkpointed,
      stored(lifecycleEvent(3, "ChildSessionSuspended", {
        checkpointId: suspensionCheckpoint.checkpointId,
      })),
      null,
    );
    const latestCheckpoint = checkpointFixture({
      sessionId: CHILD_SESSION_ID,
      parentSessionId: ROOT_SESSION_ID,
      checkpointId: lifecycleUuid<CheckpointId>(52_099),
      baseEventPosition: 3,
      checkpointEventPosition: 4,
    });
    const recheckpointed = foldChildEventProjection(
      suspended,
      stored(lifecycleEvent(4, "SessionCheckpointRecorded", {
        checkpoint: latestCheckpoint,
        baseEventPosition: "3",
        checkpointEventPosition: "4",
      })),
      null,
    );
    const payload = {
      transferTicketId: lifecycleUuid(52_100),
      suspensionCheckpointId: suspensionCheckpoint.checkpointId,
      checkpointId: latestCheckpoint.checkpointId,
      authorityCommitment: "a".repeat(64),
    };
    assert.throws(() => foldChildEventProjection(
      recheckpointed,
      stored(lifecycleEvent(5, "ChildWorkTransferCreated"), {
        eventSchemaVersion: 2,
        payload,
        payloadJson: canonicalJson(payload),
      }),
      null,
    ), /LIFECYCLE_PROJECTION_INVALID/);
  });

  it("workflow projection fold rejects cancel and abandon event-intent parity mismatches", () => {
    const requestCommandId = lifecycleUuid(54_001);
    const request = rootStored({
      position: 20n,
      streamVersion: 2n,
      eventType: "SessionEndRequested",
      eventSchemaVersion: 1,
      commandId: requestCommandId,
      payload: {
        workflowId: WORKFLOW_ID,
        workflowGeneration: 1,
        previousState: "active",
        childEndPolicy: "require-completed",
        qualityThreshold: 0,
        requireFullEvidence: false,
        requireMaterialization: false,
      },
    });
    const previous = foldWorkflowGenerationProjection(
      null,
      request,
      intent({
        commandType: "request-session-end",
        commandId: requestCommandId,
        idempotencyKey: "projection/parity/request",
        agentId: "agent-primary",
        expectedProjectId: PROJECT_ID,
        expectedVaultId: VAULT_ID,
        expectedWorkspaceId: WORKSPACE_ID,
        expectedBranchRef: null,
        request: {
          requestVersion: 1,
          sessionId: ROOT_SESSION_ID,
          childEndPolicy: "require-completed",
          finalCheckpoint: checkpointDraft(1),
          validationProfileIds: [],
          requestedQualityThreshold: 0,
          requireFullEvidence: false,
          requireMaterialization: false,
        },
      }),
      "live-schema-3",
    );

    const eventCheckpointId = lifecycleUuid(54_002);
    const otherCheckpointId = lifecycleUuid(54_003);
    const cancelCommandId = lifecycleUuid(54_004);
    const cancel = rootStored({
      position: 21n,
      streamVersion: 3n,
      eventType: "SessionEndCancelled",
      eventSchemaVersion: 1,
      commandId: cancelCommandId,
      payload: {
        workflowId: WORKFLOW_ID,
        workflowGeneration: 2,
        restoredState: "active",
        preTransitionCheckpointId: eventCheckpointId,
      },
    });
    assert.throws(() => foldWorkflowGenerationProjection(
      previous,
      cancel,
      intent({
        commandType: "cancel-session-end",
        commandId: cancelCommandId,
        idempotencyKey: "projection/parity/cancel",
        agentId: "agent-primary",
        expectedProjectId: PROJECT_ID,
        expectedVaultId: VAULT_ID,
        expectedWorkspaceId: WORKSPACE_ID,
        expectedBranchRef: null,
        sessionId: ROOT_SESSION_ID,
        workflowId: WORKFLOW_ID,
        expectedStreamVersion: "2",
        preTransitionCheckpointId: otherCheckpointId,
      }),
      "live-schema-3",
    ));

    const abandonCommandId = lifecycleUuid(54_005);
    const abandon = rootStored({
      position: 22n,
      streamVersion: 3n,
      eventType: "SessionAbandoned",
      eventSchemaVersion: 1,
      commandId: abandonCommandId,
      payload: {
        workflowId: WORKFLOW_ID,
        workflowGeneration: 2,
        approvalId: lifecycleUuid(54_006),
        preTransitionCheckpointId: eventCheckpointId,
        reasonCode: "explicit-user-approval",
        authorityCommitment: "a".repeat(64),
      },
    });
    for (const mismatch of [
      { preTransitionCheckpointId: otherCheckpointId, reasonCode: "explicit-user-approval" },
      { preTransitionCheckpointId: eventCheckpointId, reasonCode: "operator-emergency" },
    ]) {
      assert.throws(() => foldWorkflowGenerationProjection(
        previous,
        abandon,
        intent({
          commandType: "abandon-session",
          commandId: abandonCommandId,
          idempotencyKey: "projection/parity/abandon",
          agentId: "agent-primary",
          expectedProjectId: PROJECT_ID,
          expectedVaultId: VAULT_ID,
          expectedWorkspaceId: WORKSPACE_ID,
          expectedBranchRef: null,
          sessionId: ROOT_SESSION_ID,
          expectedStreamVersion: "2",
          ...mismatch,
        }),
        "live-schema-3",
      ));
    }
  });

  it("child projection fold resolves a consumer bound to a non-latest report witness", () => {
    let current = foldChildEventProjection(
      null,
      stored(lifecycleEvent(1, "SessionForked")),
      null,
    );
    const reports = [0, 1, 2].map((offset) => childReportFixture({
      reportId: lifecycleUuid<ReportId>(60_000 + offset),
      itemIds: [
        lifecycleUuid<ReportItemId>(61_000 + offset * 2),
        lifecycleUuid<ReportItemId>(61_001 + offset * 2),
      ],
    }));
    const witnesses: ChildEventFoldProjection[] = [];
    for (let index = 0; index < reports.length; index += 1) {
      const {
        allReportItemIds: _derivedItemIds,
        ...reportPayload
      } = reports[index]!;
      current = foldChildEventProjection(
        current,
        stored(lifecycleEvent(index + 2, "ChildWorkReported", {
          report: reportPayload as never,
        }), index === 0 ? {
          occurredAt: lifecycleTimestamp(3),
          recordedAt: lifecycleTimestamp(3),
        } : {}),
        null,
      );
      witnesses.push(current);
    }
    const first = witnesses[0]!;
    const latest = witnesses[2]!;
    assert.equal(current.latestReportId, reports[2]!.reportId);

    current = foldChildEventProjection(
      current,
      stored(lifecycleEvent(5, "ChildCompletionProposed", {
        reportId: reports[0]!.reportId,
      })),
      first,
    );
    assert.equal(current.completionReportId, reports[0]!.reportId);
    assert.throws(() => foldChildEventProjection(
      witnesses[2]!,
      stored(lifecycleEvent(5, "ChildCompletionProposed", {
        reportId: reports[0]!.reportId,
      })),
      latest,
    ));

    const rejected = {
      ...childDispositionFixture("rejected", reports[0]!.reportId),
      allReportItemIds: reports[0]!.allReportItemIds,
      rejectedItemIds: reports[0]!.allReportItemIds,
    };
    current = foldChildEventProjection(
      current,
      stored(lifecycleEvent(6, "ChildWorkDispositioned", {
        disposition: rejected,
      })),
      first,
    );
    assert.equal(current.childState, "active");
    assert.equal(current.completionReportId, null);

    current = foldChildEventProjection(
      current,
      stored(lifecycleEvent(7, "ChildCompletionProposed", {
        reportId: reports[0]!.reportId,
      })),
      first,
    );
    current = foldChildEventProjection(
      current,
      stored(lifecycleEvent(8, "ChildSessionCompleted", {
        reportId: reports[0]!.reportId,
      })),
      first,
    );
    assert.equal(current.childState, "completed");
    assert.equal(current.latestReportId, reports[2]!.reportId);
    assert.equal(current.completionReportId, reports[0]!.reportId);
    assert.equal(current.reportIndexFingerprint, witnesses[2]!.reportIndexFingerprint);
    assert.equal(current.fingerprint, referenceChildEventFoldFingerprint(current));
  });
});
