import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { StoredEvent } from "../src/orchestrator/contracts/event.js";
import type { LifecycleIntentWitnessV1 } from "../src/orchestrator/lifecycle/lifecycle-intent-witness.js";
import type {
  ReportId,
  ReportItemId,
} from "../src/orchestrator/lifecycle/contracts/identifiers.js";
import {
  type ChildEventFoldProjection,
  advanceReportIndexFingerprint,
  childEventFoldFingerprint,
  foldChildEventProjection,
  foldWorkflowGenerationProjection,
  reportIndexGenesisFingerprint,
  reportItemSetFingerprint,
  reportWitnessFingerprint,
  workflowGenerationFingerprint,
} from "../src/orchestrator/lifecycle/lifecycle-projection-folds.js";
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

function rootStored(input: {
  readonly position: bigint;
  readonly streamVersion: bigint;
  readonly eventType:
    | "SessionEndRequested"
    | "SessionEndAmended"
    | "SessionEndCancelled"
    | "SessionAbandoned";
  readonly eventSchemaVersion: 1 | 2;
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

describe("authenticated lifecycle projection folds", () => {
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
