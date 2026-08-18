import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertAuthorityMirror,
  evolveSession,
  foldSession,
  isTerminalSession,
  type ChildAggregateState,
  type ChildReportIndexNode,
  type RootAggregateState,
  type SessionAggregateState,
  type SessionAuthorityMirror,
} from "../src/orchestrator/lifecycle/session-aggregate.js";
import {
  decodeLifecycleEventV2,
  decodeLifecycleEventV3,
  LIFECYCLE_EVENT_TYPES,
  type LifecycleEventBaseV1,
  type LifecycleEventPayloadMapV1,
  type LifecycleEventType,
  type LifecycleEvent,
  type LifecycleEventV1,
  type LifecycleEventV2,
  type LifecycleEventV3,
} from "../src/orchestrator/lifecycle/contracts/events.js";
import type { SessionEndEffectiveStateV1 } from "../src/orchestrator/lifecycle/session-end-effective-state.js";
import type {
  CheckpointId,
  ChildSessionState,
  ReportId,
  ReportItemId,
  RootSessionState,
  SessionId,
  TransferTicketId,
  WorkflowId,
} from "../src/orchestrator/lifecycle/contracts/identifiers.js";
import type { LifecycleError } from "../src/orchestrator/lifecycle/errors.js";
import type {
  ProjectId,
  StoreId,
  VaultId,
} from "../src/orchestrator/identity/contracts.js";
import {
  APPROVAL_ID,
  AUTHORITY_A,
  AUTHORITY_B,
  AUTHORITY_C,
  AUTHORITY_D,
  CHECKPOINT_ID,
  CHILD_SESSION_ID,
  DEFAULT_ASSIGNMENT,
  OTHER_SESSION_ID,
  REPORT_ID,
  REPORT_ITEM_ID,
  ROOT_SESSION_ID,
  SECOND_REPORT_ITEM_ID,
  TRANSFER_TICKET_ID,
  VALIDATION_RESULT_ID,
  WORKFLOW_ID,
  WORKSPACE_ID,
  authorityMirror,
  checkpointFixture,
  childAggregate,
  childDispositionFixture,
  childReportFixture,
  lifecycleEvent,
  lifecycleUuid,
  rootAggregate,
  validationResultFixture,
} from "./support/lifecycle-fixtures.js";
import {
  referenceSessionEndEffectiveStateHashV1,
  sessionEndEffectiveStateFixture,
} from "./support/session-end-effective-state-reference.js";

type SessionAggregateModule = typeof import("../src/orchestrator/lifecycle/session-aggregate.js");
type TransitionPolicyIsPrivate = "isSessionTransitionAllowed" extends keyof SessionAggregateModule
  ? false
  : true;
const TRANSITION_POLICY_IS_PRIVATE: TransitionPolicyIsPrivate = true;

type LifecycleCode = "INTEGRITY_FAILURE" | "SESSION_STATE_CONFLICT";

function expectLifecycleCode(code: LifecycleCode, action: () => unknown): LifecycleError {
  try {
    action();
  } catch (error) {
    const lifecycleError = error as LifecycleError;
    assert.equal(lifecycleError.code, code);
    assert.match(lifecycleError.message, new RegExp(code));
    return lifecycleError;
  }
  assert.fail(`Expected ${code}`);
}

function expectIntegrity(action: () => unknown): void {
  expectLifecycleCode("INTEGRITY_FAILURE", action);
}

function expectStateConflict(action: () => unknown): void {
  expectLifecycleCode("SESSION_STATE_CONFLICT", action);
}

function tamperEvent(
  event: LifecycleEventV1,
  overrides: Partial<LifecycleEventBaseV1>,
): LifecycleEventV1 {
  return Object.freeze({ ...event, ...overrides }) as LifecycleEventV1;
}

function tamperPayload(
  event: LifecycleEventV1,
  overrides: Readonly<Record<string, unknown>>,
): LifecycleEventV1 {
  return Object.freeze({
    ...event,
    payload: Object.freeze({ ...event.payload, ...overrides }),
  }) as LifecycleEventV1;
}

function eventAfter<T extends LifecycleEventType>(
  aggregate: SessionAggregateState,
  eventType: T,
  payload: Partial<LifecycleEventPayloadMapV1[T]> = {},
  options: Parameters<typeof lifecycleEvent>[3] = {},
): LifecycleEventBaseV1<T> {
  const payloadCommitment = (payload as { readonly authorityCommitment?: string }).authorityCommitment;
  const nextVersion = aggregate.streamVersion + 1n;
  return lifecycleEvent(nextVersion, eventType, payload, {
    sessionId: aggregate.sessionId,
    parentSessionId: aggregate.parentSessionId,
    streamId: aggregate.streamId,
    streamVersion: nextVersion,
    globalPosition: aggregate.eventPosition + 1n,
    correlationId: aggregate.correlationId,
    authorityCommitment: payloadCommitment ?? aggregate.authorityCommitment,
    ...options,
  });
}

function rootEffectiveState(profileCount = 2): SessionEndEffectiveStateV1 {
  const fixture = sessionEndEffectiveStateFixture({ requestVersion: 2, profileCount });
  const withoutHash = {
    effectiveStateVersion: fixture.effectiveStateVersion,
    effectiveStateDomain: fixture.effectiveStateDomain,
    request: { ...fixture.request, sessionId: ROOT_SESSION_ID },
    effectivePolicy: fixture.effectivePolicy,
    effectiveFinalCheckpoint: fixture.effectiveFinalCheckpoint,
  };
  return Object.freeze({
    ...withoutHash,
    effectiveStateHash: referenceSessionEndEffectiveStateHashV1(withoutHash),
  });
}

function currentSessionEndEvent(
  aggregate: RootAggregateState,
  eventType: LifecycleEventV3["eventType"],
  payload: LifecycleEventV3["payload"],
): LifecycleEventV3 {
  const envelope = eventAfter(aggregate, eventType);
  return decodeLifecycleEventV3({
    ...envelope,
    eventSchemaVersion: 3,
    payload,
  });
}

function finalMarkerEvent(
  aggregate: RootAggregateState,
  workflowId: WorkflowId,
  workflowGeneration: number,
): Extract<LifecycleEventV3, { readonly eventType: "SessionCheckpointRecorded" }> {
  const checkpointEventPosition = aggregate.eventPosition + 1n;
  return currentSessionEndEvent(aggregate, "SessionCheckpointRecorded", {
    checkpoint: checkpointFixture({
      sessionId: aggregate.sessionId,
      parentSessionId: null,
      baseEventPosition: aggregate.eventPosition,
      checkpointEventPosition,
    }),
    baseEventPosition: aggregate.eventPosition.toString(),
    checkpointEventPosition: checkpointEventPosition.toString(),
    finalCheckpointBindingVersion: 1,
    workflowId,
    workflowGeneration,
  }) as Extract<LifecycleEventV3, { readonly eventType: "SessionCheckpointRecorded" }>;
}

function internalTransferEventV2(
  aggregate: ChildAggregateState,
  suspensionCheckpointId: CheckpointId,
  checkpointId: CheckpointId,
): Extract<LifecycleEventV2, { readonly eventType: "ChildWorkTransferCreated" }> {
  const envelope = eventAfter(aggregate, "ChildWorkTransferCreated", {
    authorityCommitment: AUTHORITY_C,
  }, { authorityCommitment: AUTHORITY_C });
  return decodeLifecycleEventV2({
    ...envelope,
    eventSchemaVersion: 2,
    payload: {
      transferTicketId: TRANSFER_TICKET_ID,
      suspensionCheckpointId,
      checkpointId,
      authorityCommitment: AUTHORITY_C,
    },
  }) as Extract<LifecycleEventV2, { readonly eventType: "ChildWorkTransferCreated" }>;
}

function suspendRequestedRoot(): RootAggregateState {
  return rootAggregate([
    lifecycleEvent(1, "SessionStarted"),
    lifecycleEvent(2, "SessionCheckpointRecorded", {}, { sessionId: ROOT_SESSION_ID, parentSessionId: null }),
    lifecycleEvent(3, "SessionSuspendRequested"),
  ]);
}

function suspendedRoot(): RootAggregateState {
  return rootAggregate([
    lifecycleEvent(1, "SessionStarted"),
    lifecycleEvent(2, "SessionCheckpointRecorded", {}, { sessionId: ROOT_SESSION_ID, parentSessionId: null }),
    lifecycleEvent(3, "SessionSuspendRequested"),
    lifecycleEvent(4, "SessionSuspended", { authorityCommitment: AUTHORITY_B }, { authorityCommitment: AUTHORITY_B }),
  ]);
}

function endingRoot(previousState: "active" | "suspended" = "active"): RootAggregateState {
  const before = previousState === "active" ? rootAggregate() : suspendedRoot();
  return evolveSession(before, eventAfter(before, "SessionEndRequested", {
    previousState,
    workflowGeneration: 1,
  }));
}

function verifiedEndingRoot(previousState: "active" | "suspended" = "active"): RootAggregateState {
  const ending = endingRoot(previousState);
  return evolveSession(ending, eventAfter(ending, "SessionEndVerificationPassed", {
    workflowGeneration: 1,
  }));
}

function completionProposedChild(): ChildAggregateState {
  return childAggregate([
    lifecycleEvent(1, "SessionForked"),
    lifecycleEvent(2, "ChildWorkReported"),
    lifecycleEvent(3, "ChildCompletionProposed"),
  ]);
}

function suspendedChild(): ChildAggregateState {
  return childAggregate([
    lifecycleEvent(1, "SessionForked"),
    lifecycleEvent(2, "SessionCheckpointRecorded"),
    lifecycleEvent(3, "ChildSessionSuspended", { authorityCommitment: AUTHORITY_B }, { authorityCommitment: AUTHORITY_B }),
  ]);
}

function transferDerivedChild(): ChildAggregateState {
  return childAggregate([
    lifecycleEvent(1, "SessionForked", {
      sourceTransferTicketId: TRANSFER_TICKET_ID,
    }, { globalPosition: 10 }),
  ]);
}

describe("SessionAggregate", () => {
  it("folds the exact Version 2 event subset through the shared event union", () => {
    const invalidV2Start = Object.freeze({
      ...lifecycleEvent(1, "SessionStarted"),
      eventSchemaVersion: 2 as const,
    }) as unknown as LifecycleEvent;
    expectIntegrity(() => foldSession([invalidV2Start]));

    const root = rootAggregate();
    const evidenceV1 = eventAfter(root, "EvidenceCoverageRecorded");
    const evidenceV2 = Object.freeze({
      ...evidenceV1,
      eventSchemaVersion: 2 as const,
    }) as unknown as LifecycleEvent;
    const afterEvidence = evolveSession(root, evidenceV2);
    assert.equal(afterEvidence.streamVersion, root.streamVersion + 1n);

    const requestedV1 = eventAfter(afterEvidence, "SessionEndRequested", {
      workflowId: WORKFLOW_ID,
      workflowGeneration: 1,
      previousState: "active",
    });
    const requestedV2 = Object.freeze({
      ...requestedV1,
      eventSchemaVersion: 2 as const,
      payload: Object.freeze({ ...requestedV1.payload, requestVersion: 2 as const }),
    }) as unknown as LifecycleEvent;
    const ending = evolveSession(afterEvidence, requestedV2);
    assert.equal(ending.kind, "root");
    assert.equal(ending.state, "ending");
  });

  it("binds a Version 3 final marker to the current ending workflow", () => {
    const ending = endingRoot();
    assert.doesNotThrow(() => evolveSession(ending, finalMarkerEvent(ending, WORKFLOW_ID, 1)));
    expectLifecycleCode(
      "INTEGRITY_FAILURE",
      () => evolveSession(ending, finalMarkerEvent(ending, WORKFLOW_ID, 2)),
    );
  });

  describe("first-event and stream identity rules", () => {
    it("folds only SessionStarted or SessionForked as stream version one", () => {
      const root = foldSession([lifecycleEvent(1, "SessionStarted")]);
      assert.equal(root.kind, "root");
      assert.equal(root.state, "active");
      assert.equal(root.ownerGeneration, 1);
      assert.equal(root.parentSessionId, null);

      const child = foldSession([lifecycleEvent(1, "SessionForked")]);
      assert.equal(child.kind, "child");
      assert.equal(child.state, "active");
      assert.equal(child.parentSessionId, ROOT_SESSION_ID);
      assert.equal(child.childCapabilityGeneration, 1);
      assert.equal(child.childCapabilityRevoked, false);
    });

    it("rejects an empty stream and every invalid first-event shape as integrity failures", () => {
      expectIntegrity(() => foldSession([]));
      expectIntegrity(() => foldSession([lifecycleEvent(1, "SessionSuspendRequested")]));
      expectIntegrity(() => foldSession([lifecycleEvent(1, "ChildWorkReported")]));
      expectIntegrity(() => foldSession([
        lifecycleEvent(1, "SessionStarted", {}, { streamVersion: 2 }),
      ]));
      expectIntegrity(() => foldSession([
        lifecycleEvent(1, "SessionForked", {}, { streamVersion: 2 }),
      ]));
      expectIntegrity(() => foldSession([
        lifecycleEvent(1, "SessionStarted", {}, { streamId: "session/not-the-session" }),
      ]));
      expectIntegrity(() => foldSession([
        lifecycleEvent(1, "SessionStarted", {}, { parentSessionId: ROOT_SESSION_ID }),
      ]));
      expectIntegrity(() => foldSession([
        lifecycleEvent(1, "SessionForked", {}, { parentSessionId: null }),
      ]));
    });

    it("rejects a child stream that names itself as its parent", () => {
      expectIntegrity(() => foldSession([
        lifecycleEvent(1, "SessionForked", {}, {
          sessionId: CHILD_SESSION_ID,
          parentSessionId: CHILD_SESSION_ID,
        }),
      ]));
    });

    it("requires immutable project, store, workspace, stream, session, parent, and correlation identity", () => {
      const root = rootAggregate();
      const next = eventAfter(root, "SessionCheckpointRecorded");
      const mismatches: readonly Partial<LifecycleEventBaseV1>[] = [
        { projectId: lifecycleUuid<ProjectId>(301) },
        { vaultId: lifecycleUuid<VaultId>(302) },
        { storeId: lifecycleUuid<StoreId>(303) },
        { workspaceId: "f".repeat(64) as typeof WORKSPACE_ID },
        { streamId: "session/different" },
        { sessionId: OTHER_SESSION_ID },
        { parentSessionId: ROOT_SESSION_ID },
        { correlationId: lifecycleUuid(304) },
      ];
      for (const mismatch of mismatches) {
        expectIntegrity(() => evolveSession(root, tamperEvent(next, mismatch)));
      }

      const child = childAggregate();
      expectIntegrity(() => evolveSession(child, tamperEvent(
        eventAfter(child, "ChildAssignmentAmended"),
        { parentSessionId: OTHER_SESSION_ID },
      )));
    });

    it("requires contiguous stream versions and strictly increasing bigint global positions", () => {
      const root = rootAggregate([
        lifecycleEvent(1, "SessionStarted", {}, { globalPosition: "9223372036854775805" }),
      ]);
      const next = eventAfter(root, "EvidenceCoverageRecorded", {}, {
        globalPosition: "9223372036854775807",
      });
      const advanced = evolveSession(root, next);
      assert.equal(advanced.streamVersion, 2n);
      assert.equal(advanced.eventPosition, 9_223_372_036_854_775_807n);
      assert.equal(typeof advanced.eventPosition, "bigint");

      expectIntegrity(() => evolveSession(root, tamperEvent(next, { streamVersion: "3" })));
      expectIntegrity(() => evolveSession(root, tamperEvent(next, { streamVersion: "1" })));
      expectIntegrity(() => evolveSession(root, tamperEvent(next, { globalPosition: root.eventPosition.toString() })));
      expectIntegrity(() => evolveSession(root, tamperEvent(next, { globalPosition: "0" })));
      expectIntegrity(() => evolveSession(root, tamperEvent(next, { globalPosition: "9223372036854775808" })));
      expectIntegrity(() => evolveSession(root, tamperEvent(next, { globalPosition: "01" })));
    });
  });

  describe("root transitions", () => {
    it("folds one root through suspend, transfer, resume, verified end", () => {
      const aggregate = foldSession([
        lifecycleEvent(1, "SessionStarted", { ownerGeneration: 1, authorityCommitment: AUTHORITY_A }),
        lifecycleEvent(2, "SessionCheckpointRecorded", {}, { sessionId: ROOT_SESSION_ID, parentSessionId: null }),
        lifecycleEvent(3, "SessionSuspendRequested", { checkpointId: CHECKPOINT_ID }),
        lifecycleEvent(4, "SessionSuspended", { authorityCommitment: AUTHORITY_B }, { authorityCommitment: AUTHORITY_B }),
        lifecycleEvent(5, "SessionOwnerTransferred", {
          previousOwnerGeneration: 1,
          ownerGeneration: 2,
          authorityCommitment: AUTHORITY_C,
        }, { authorityCommitment: AUTHORITY_C }),
        lifecycleEvent(6, "SessionResumed", { ownerGeneration: 2 }, { authorityCommitment: AUTHORITY_C }),
        lifecycleEvent(7, "SessionEndRequested", {
          previousState: "active",
          workflowGeneration: 1,
        }, { authorityCommitment: AUTHORITY_C }),
        lifecycleEvent(8, "SessionEndVerificationPassed", {
          workflowGeneration: 1,
        }, { authorityCommitment: AUTHORITY_C }),
        lifecycleEvent(9, "SessionEnded", {
          workflowGeneration: 1,
          verificationEventPosition: "8",
          authorityCommitment: AUTHORITY_D,
        }, { authorityCommitment: AUTHORITY_D }),
      ]);
      assert.equal(aggregate.kind, "root");
      assert.equal(aggregate.state, "ended");
      assert.equal(aggregate.ownerGeneration, 2);
      assert.equal(aggregate.terminalEventPosition, 9n);
      assert.equal(aggregate.terminalEventType, "SessionEnded");
      assert.equal(aggregate.authorityCommitment, AUTHORITY_D);
    });

    it("requires suspend request before suspension and preserves generation across resume", () => {
      const active = rootAggregate();
      expectIntegrity(() => evolveSession(active, eventAfter(active, "SessionSuspended", {
        authorityCommitment: AUTHORITY_B,
      })));

      expectIntegrity(() => evolveSession(active, eventAfter(active, "SessionSuspendRequested")));
      const checkpointed = evolveSession(active, eventAfter(active, "SessionCheckpointRecorded"));
      const requested = evolveSession(checkpointed, eventAfter(checkpointed, "SessionSuspendRequested"));
      assert.equal(requested.state, "active");
      expectIntegrity(() => evolveSession(requested, eventAfter(requested, "SessionSuspendRequested")));

      const newerCheckpointId = lifecycleUuid<CheckpointId>(615);
      const newerCheckpointPosition = requested.eventPosition + 1n;
      const withNewerCheckpoint = evolveSession(requested, eventAfter(requested, "SessionCheckpointRecorded", {
        checkpoint: checkpointFixture({
          checkpointId: newerCheckpointId,
          baseEventPosition: requested.eventPosition,
          checkpointEventPosition: newerCheckpointPosition,
        }),
        baseEventPosition: requested.eventPosition.toString(),
        checkpointEventPosition: newerCheckpointPosition.toString(),
      }));
      assert.equal(withNewerCheckpoint.suspendRequestedCheckpointId, null);
      expectIntegrity(() => evolveSession(withNewerCheckpoint, eventAfter(withNewerCheckpoint, "SessionSuspended", {
        authorityCommitment: AUTHORITY_B,
      })));
      const replacementRequested = evolveSession(
        withNewerCheckpoint,
        eventAfter(withNewerCheckpoint, "SessionSuspendRequested", {
          checkpointId: newerCheckpointId,
        }),
      );
      const replacementSuspended = evolveSession(
        replacementRequested,
        eventAfter(replacementRequested, "SessionSuspended", {
          authorityCommitment: AUTHORITY_B,
        }),
      );
      assert.equal(replacementSuspended.state, "suspended");

      const suspended = evolveSession(requested, eventAfter(requested, "SessionSuspended", {
        authorityCommitment: AUTHORITY_B,
      }));
      assert.equal(suspended.state, "suspended");
      assert.equal(suspended.ownerGeneration, 1);
      const resumed = evolveSession(suspended, eventAfter(suspended, "SessionResumed", { ownerGeneration: 1 }));
      assert.equal(resumed.state, "active");
      assert.equal(resumed.ownerGeneration, 1);

      expectStateConflict(() => evolveSession(active, eventAfter(active, "SessionResumed")));
      expectStateConflict(() => evolveSession(suspended, eventAfter(suspended, "SessionSuspendRequested")));
    });

    it("increments root generation exactly once on transfer or recovery and never otherwise", () => {
      for (const initial of [rootAggregate(), suspendedRoot()] as const) {
        const transferred = evolveSession(initial, eventAfter(initial, "SessionOwnerTransferred", {
          previousOwnerGeneration: 1,
          ownerGeneration: 2,
          authorityCommitment: AUTHORITY_C,
        }));
        assert.equal(transferred.ownerGeneration, 2);
        assert.equal(transferred.state, initial.state);
      }

      for (const initial of [rootAggregate(), suspendedRoot(), endingRoot()] as const) {
        const recovered = evolveSession(initial, eventAfter(initial, "SessionOwnershipRecovered", {
          previousOwnerGeneration: 1,
          ownerGeneration: 2,
          approvalId: APPROVAL_ID,
          authorityCommitment: initial.authorityCommitment === AUTHORITY_A ? AUTHORITY_B : AUTHORITY_C,
        }));
        assert.equal(recovered.ownerGeneration, 2);
        assert.equal(recovered.state, initial.state);
      }

      const active = rootAggregate();
      for (const payload of [
        { previousOwnerGeneration: 0, ownerGeneration: 1 },
        { previousOwnerGeneration: 2, ownerGeneration: 3 },
        { previousOwnerGeneration: 1, ownerGeneration: 3 },
        { previousOwnerGeneration: 1, ownerGeneration: 1 },
      ]) {
        expectIntegrity(() => evolveSession(active, eventAfter(active, "SessionOwnerTransferred", {
          ...payload,
          authorityCommitment: AUTHORITY_B,
        })));
      }
      const suspended = suspendedRoot();
      expectIntegrity(() => evolveSession(suspended, eventAfter(suspended, "SessionResumed", { ownerGeneration: 2 })));
      expectIntegrity(() => foldSession([
        lifecycleEvent(1, "SessionStarted", { ownerGeneration: 2 }),
      ]));
    });

    it("uses closed root transition tables for every state-changing event", () => {
      const active = rootAggregate();
      const suspended = suspendedRoot();
      const ending = endingRoot();

      expectStateConflict(() => evolveSession(ending, eventAfter(ending, "SessionOwnerTransferred", {
        previousOwnerGeneration: 1,
        ownerGeneration: 2,
        authorityCommitment: AUTHORITY_B,
      })));
      expectStateConflict(() => evolveSession(suspended, eventAfter(suspended, "SessionSuspendRequested")));
      expectStateConflict(() => evolveSession(ending, eventAfter(ending, "SessionSuspendRequested")));
      expectStateConflict(() => evolveSession(suspended, eventAfter(suspended, "SessionSuspended", {
        authorityCommitment: AUTHORITY_C,
      })));
      expectStateConflict(() => evolveSession(active, eventAfter(active, "SessionResumed")));
      expectStateConflict(() => evolveSession(ending, eventAfter(ending, "SessionEndRequested")));
      expectStateConflict(() => evolveSession(active, eventAfter(active, "SessionEndAmended")));
      expectStateConflict(() => evolveSession(active, eventAfter(active, "SessionValidationResultRecorded")));
      expectStateConflict(() => evolveSession(active, eventAfter(active, "SessionEndVerificationPassed")));
      expectStateConflict(() => evolveSession(active, eventAfter(active, "SessionEndVerificationFailed")));
      expectStateConflict(() => evolveSession(active, eventAfter(active, "SessionEndVerificationInvalidated")));
      expectStateConflict(() => evolveSession(active, eventAfter(active, "SessionEndCancelled")));
      expectStateConflict(() => evolveSession(active, eventAfter(active, "SessionEnded", {
        authorityCommitment: AUTHORITY_B,
      })));
    });

    it("binds end workflow identity/generation and restores only the captured state", () => {
      const active = rootAggregate();
      expectIntegrity(() => evolveSession(active, eventAfter(active, "SessionEndRequested", {
        previousState: "suspended",
      })));
      expectIntegrity(() => evolveSession(active, eventAfter(active, "SessionEndRequested", {
        workflowGeneration: 2,
      })));

      const ending = endingRoot("active");
      const amended = evolveSession(ending, eventAfter(ending, "SessionEndAmended", {
        workflowId: WORKFLOW_ID,
        previousWorkflowGeneration: 1,
        workflowGeneration: 2,
      }));
      assert.equal(amended.state, "ending");
      assert.equal(amended.endWorkflowGeneration, 2);
      expectIntegrity(() => evolveSession(amended, eventAfter(amended, "SessionEndAmended", {
        previousWorkflowGeneration: 1,
        workflowGeneration: 2,
      })));

      expectIntegrity(() => evolveSession(ending, eventAfter(ending, "SessionEndCancelled", {
        restoredState: "suspended",
      })));
      const cancelled = evolveSession(ending, eventAfter(ending, "SessionEndCancelled", {
        restoredState: "active",
      }));
      assert.equal(cancelled.state, "active");

      const reopened = evolveSession(cancelled, eventAfter(cancelled, "SessionEndRequested", {
        workflowId: WORKFLOW_ID,
        workflowGeneration: 2,
        previousState: "active",
      }));
      assert.equal(reopened.state, "ending");
      assert.equal(reopened.endWorkflowGeneration, 2);
      expectIntegrity(() => evolveSession(cancelled, eventAfter(cancelled, "SessionEndRequested", {
        workflowId: lifecycleUuid<WorkflowId>(401),
        workflowGeneration: 2,
      })));
      expectIntegrity(() => evolveSession(cancelled, eventAfter(cancelled, "SessionEndRequested", {
        workflowGeneration: 1,
      })));
    });

    it("folds current effective state through strict G1 request G2 cancel G3 reopen", () => {
      type EffectiveRoot = RootAggregateState & {
        readonly endEffectiveState: SessionEndEffectiveStateV1 | null;
        readonly endEffectiveStateHash: string | null;
      };
      const initial = rootAggregate();
      const requestedState = rootEffectiveState(2);
      const requested = evolveSession(initial, currentSessionEndEvent(initial, "SessionEndRequested", {
        workflowId: WORKFLOW_ID,
        workflowGeneration: 1,
        previousState: "active",
        effectiveState: requestedState,
      })) as EffectiveRoot;
      assert.equal(requested.endWorkflowGeneration, 1);
      assert.deepEqual(requested.endEffectiveState, requestedState);
      assert.equal(requested.endEffectiveStateHash, requestedState.effectiveStateHash);

      const amendedState = rootEffectiveState(3);
      const amended = evolveSession(requested, currentSessionEndEvent(requested, "SessionEndAmended", {
        workflowId: WORKFLOW_ID,
        previousWorkflowGeneration: 1,
        workflowGeneration: 2,
        preTransitionCheckpointId: CHECKPOINT_ID,
        evidenceWindowAction: "seal",
        effectiveState: amendedState,
      })) as EffectiveRoot;
      assert.equal(amended.endWorkflowGeneration, 2);
      assert.deepEqual(amended.endEffectiveState, amendedState);
      assert.equal(amended.endEffectiveStateHash, amendedState.effectiveStateHash);

      expectIntegrity(() => evolveSession(requested, currentSessionEndEvent(requested, "SessionEndCancelled", {
        cancellationVersion: 1,
        workflowId: WORKFLOW_ID,
        previousWorkflowGeneration: 2,
        workflowGeneration: 3,
        restoredState: "active",
        preTransitionCheckpointId: CHECKPOINT_ID,
      })));

      const cancelled = evolveSession(requested, currentSessionEndEvent(requested, "SessionEndCancelled", {
        cancellationVersion: 1,
        workflowId: WORKFLOW_ID,
        previousWorkflowGeneration: 1,
        workflowGeneration: 2,
        restoredState: "active",
        preTransitionCheckpointId: CHECKPOINT_ID,
      })) as EffectiveRoot;
      assert.equal(cancelled.state, "active");
      assert.equal(cancelled.endWorkflowGeneration, 2);
      assert.equal(cancelled.endEffectiveState, requested.endEffectiveState);
      assert.equal(cancelled.endEffectiveStateHash, requested.endEffectiveStateHash);

      const reopenedState = rootEffectiveState(4);
      const reopened = evolveSession(cancelled, currentSessionEndEvent(cancelled, "SessionEndRequested", {
        workflowId: WORKFLOW_ID,
        workflowGeneration: 3,
        previousState: "active",
        effectiveState: reopenedState,
      })) as EffectiveRoot;
      assert.equal(reopened.state, "ending");
      assert.equal(reopened.endWorkflowGeneration, 3);
      assert.deepEqual(reopened.endEffectiveState, reopenedState);
      assert.equal(reopened.endEffectiveStateHash, reopenedState.effectiveStateHash);
    });

    it("accepts current or exactly-next identified terminal generations", () => {
      const ending = endingRoot();
      const currentCancel = evolveSession(ending, eventAfter(ending, "SessionEndCancelled", {
        workflowGeneration: 1,
        restoredState: "active",
      }));
      assert.equal(currentCancel.endWorkflowGeneration, 1);

      const nextCancel = evolveSession(ending, eventAfter(ending, "SessionEndCancelled", {
        workflowGeneration: 2,
        restoredState: "active",
      }));
      assert.equal(nextCancel.endWorkflowGeneration, 2);

      const currentAbandon = evolveSession(ending, eventAfter(ending, "SessionAbandoned", {
        workflowId: WORKFLOW_ID,
        workflowGeneration: 1,
        authorityCommitment: AUTHORITY_B,
      }));
      assert.equal(currentAbandon.endWorkflowGeneration, 1);

      const nextAbandon = evolveSession(ending, eventAfter(ending, "SessionAbandoned", {
        workflowId: WORKFLOW_ID,
        workflowGeneration: 2,
        authorityCommitment: AUTHORITY_B,
      }));
      assert.equal(nextAbandon.endWorkflowGeneration, 2);
    });

    it("uses an accepted next terminal generation as the reopen fence", () => {
      const ending = endingRoot();
      const cancelled = evolveSession(ending, eventAfter(ending, "SessionEndCancelled", {
        workflowGeneration: 2,
        restoredState: "active",
      }));
      expectIntegrity(() => evolveSession(cancelled, eventAfter(cancelled, "SessionEndRequested", {
        workflowGeneration: 2,
        previousState: "active",
      })));
      const reopened = evolveSession(cancelled, eventAfter(cancelled, "SessionEndRequested", {
        workflowGeneration: 3,
        previousState: "active",
      }));
      assert.equal(reopened.state, "ending");
      assert.equal(reopened.endWorkflowGeneration, 3);
    });

    it("rejects invalid identified terminal identities without changing null abandonment", () => {
      const ending = endingRoot();
      const otherWorkflowId = lifecycleUuid<WorkflowId>(499);
      for (const payload of [
        { workflowGeneration: 0 },
        { workflowGeneration: 3 },
        { workflowGeneration: Number.MAX_SAFE_INTEGER + 1 },
        { workflowId: otherWorkflowId },
        { workflowId: null },
      ] as const) {
        expectIntegrity(() => evolveSession(ending, tamperPayload(
          eventAfter(ending, "SessionEndCancelled", { restoredState: "active" }),
          payload,
        )));
      }
      for (const payload of [
        { workflowGeneration: 0 },
        { workflowGeneration: 3 },
        { workflowGeneration: Number.MAX_SAFE_INTEGER + 1 },
        { workflowId: otherWorkflowId },
        { workflowId: null, workflowGeneration: 1 },
        { workflowId: WORKFLOW_ID, workflowGeneration: null },
      ] as const) {
        expectIntegrity(() => evolveSession(ending, tamperPayload(
          eventAfter(ending, "SessionAbandoned", { authorityCommitment: AUTHORITY_B }),
          payload,
        )));
      }

      const generationTwo = evolveSession(ending, eventAfter(ending, "SessionEndAmended", {
        workflowId: WORKFLOW_ID,
        previousWorkflowGeneration: 1,
        workflowGeneration: 2,
      }));
      assert.equal(generationTwo.endWorkflowGeneration, 2);
      expectIntegrity(() => evolveSession(generationTwo, eventAfter(
        generationTwo,
        "SessionEndCancelled",
        { workflowId: WORKFLOW_ID, workflowGeneration: 1, restoredState: "active" },
      )));
      expectIntegrity(() => evolveSession(generationTwo, eventAfter(
        generationTwo,
        "SessionAbandoned",
        {
          workflowId: WORKFLOW_ID,
          workflowGeneration: 1,
          authorityCommitment: AUTHORITY_B,
        },
      )));

      for (const state of [rootAggregate(), suspendedRoot()] as const) {
        const abandoned = evolveSession(state, eventAfter(state, "SessionAbandoned", {
          workflowId: null,
          workflowGeneration: null,
          authorityCommitment: state.authorityCommitment === AUTHORITY_A
            ? AUTHORITY_B
            : AUTHORITY_C,
        }));
        assert.equal(abandoned.state, "abandoned");
        assert.equal(abandoned.endWorkflowGeneration, null);
      }
    });

    it("binds validation, verification, invalidation, and terminal end to one workflow generation", () => {
      const ending = endingRoot();
      const recorded = evolveSession(ending, eventAfter(ending, "SessionValidationResultRecorded", {
        workflowId: WORKFLOW_ID,
        workflowGeneration: 1,
        validationResult: validationResultFixture(),
      }));
      assert.equal(recorded.state, "ending");

      expectIntegrity(() => evolveSession(ending, eventAfter(ending, "SessionValidationResultRecorded", {
        workflowGeneration: 2,
        validationResult: validationResultFixture({ workflowGeneration: 2 }),
      })));
      expectIntegrity(() => evolveSession(ending, eventAfter(ending, "SessionEndVerificationPassed", {
        workflowId: lifecycleUuid<WorkflowId>(402),
      })));
      expectIntegrity(() => evolveSession(ending, eventAfter(ending, "SessionEndVerificationInvalidated", {
        previousVerificationEventPosition: ending.eventPosition.toString(),
      })));

      const passed = evolveSession(recorded, eventAfter(recorded, "SessionEndVerificationPassed"));
      assert.equal(passed.verificationPassedEventPosition, passed.eventPosition);
      const invalidated = evolveSession(passed, eventAfter(passed, "SessionEndVerificationInvalidated", {
        previousVerificationEventPosition: passed.eventPosition.toString(),
      }));
      assert.equal(invalidated.state, "ending");
      assert.equal(invalidated.verificationPassedEventPosition, null);

      expectIntegrity(() => evolveSession(passed, eventAfter(passed, "SessionEndVerificationInvalidated", {
        previousVerificationEventPosition: (passed.eventPosition - 1n).toString(),
      })));
      expectIntegrity(() => evolveSession(invalidated, eventAfter(invalidated, "SessionEnded", {
        verificationEventPosition: passed.eventPosition.toString(),
        authorityCommitment: AUTHORITY_B,
      })));

      const failed = evolveSession(recorded, eventAfter(recorded, "SessionEndVerificationFailed"));
      assert.equal(failed.verificationPassedEventPosition, null);
      expectIntegrity(() => evolveSession(failed, eventAfter(failed, "SessionEnded", {
        verificationEventPosition: passed.eventPosition.toString(),
        authorityCommitment: AUTHORITY_B,
      })));
    });

    it("locks a failed or invalidated workflow generation until amendment advances it", () => {
      const ending = endingRoot();
      const failed = evolveSession(ending, eventAfter(ending, "SessionEndVerificationFailed"));
      expectIntegrity(() => evolveSession(failed, eventAfter(failed, "SessionEndVerificationPassed")));
      expectIntegrity(() => evolveSession(failed, eventAfter(failed, "SessionEnded", {
        verificationEventPosition: failed.eventPosition.toString(),
        authorityCommitment: AUTHORITY_B,
      })));

      const passed = evolveSession(ending, eventAfter(ending, "SessionEndVerificationPassed"));
      expectIntegrity(() => evolveSession(passed, eventAfter(passed, "SessionEndVerificationPassed")));
      expectIntegrity(() => evolveSession(passed, eventAfter(passed, "SessionEndVerificationFailed")));

      const invalidated = evolveSession(passed, eventAfter(passed, "SessionEndVerificationInvalidated", {
        previousVerificationEventPosition: passed.eventPosition.toString(),
      }));
      expectIntegrity(() => evolveSession(invalidated, eventAfter(invalidated, "SessionEndVerificationPassed")));
      expectIntegrity(() => evolveSession(invalidated, eventAfter(invalidated, "SessionEnded", {
        verificationEventPosition: passed.eventPosition.toString(),
        authorityCommitment: AUTHORITY_B,
      })));

      const amended = evolveSession(failed, eventAfter(failed, "SessionEndAmended", {
        previousWorkflowGeneration: 1,
        workflowGeneration: 2,
      }));
      const nextGenerationPassed = evolveSession(amended, eventAfter(amended, "SessionEndVerificationPassed", {
        workflowGeneration: 2,
      }));
      const ended = evolveSession(nextGenerationPassed, eventAfter(nextGenerationPassed, "SessionEnded", {
        workflowGeneration: 2,
        verificationEventPosition: nextGenerationPassed.eventPosition.toString(),
        authorityCommitment: AUTHORITY_B,
      }));
      assert.equal(ended.state, "ended");
    });

    it("requires terminal abandonment workflow assertions to match the current semantic state", () => {
      for (const state of [rootAggregate(), suspendedRoot()] as const) {
        const abandoned = evolveSession(state, eventAfter(state, "SessionAbandoned", {
          workflowId: null,
          workflowGeneration: null,
          authorityCommitment: state.authorityCommitment === AUTHORITY_A ? AUTHORITY_B : AUTHORITY_C,
        }));
        assert.equal(abandoned.state, "abandoned");
      }

      const active = rootAggregate();
      expectIntegrity(() => evolveSession(active, eventAfter(active, "SessionAbandoned", {
        workflowId: WORKFLOW_ID,
        workflowGeneration: 1,
        authorityCommitment: AUTHORITY_B,
      })));

      const ending = endingRoot();
      const abandoned = evolveSession(ending, eventAfter(ending, "SessionAbandoned", {
        workflowId: WORKFLOW_ID,
        workflowGeneration: 1,
        approvalId: APPROVAL_ID,
        authorityCommitment: AUTHORITY_B,
      }));
      assert.equal(abandoned.state, "abandoned");
      assert.equal(abandoned.terminalEventPosition, abandoned.eventPosition);
      expectIntegrity(() => evolveSession(ending, eventAfter(ending, "SessionAbandoned", {
        workflowId: null,
        workflowGeneration: null,
        authorityCommitment: AUTHORITY_B,
      })));
    });
  });

  describe("checkpoint, commitment, and terminal invariants", () => {
    it("accepts project-watermark checkpoint bases, tracks strict checkpoint monotonicity, and stores bigint positions", () => {
      const root = rootAggregate([
        lifecycleEvent(1, "SessionStarted", {}, { globalPosition: 10 }),
      ]);
      const firstEvent = eventAfter(root, "SessionCheckpointRecorded", {
        checkpoint: checkpointFixture({ baseEventPosition: 99, checkpointEventPosition: 100 }),
        baseEventPosition: "99",
        checkpointEventPosition: "100",
      }, { globalPosition: 100 });
      const first = evolveSession(root, firstEvent);
      assert.equal(first.latestCheckpointBaseEventPosition, 99n);
      assert.equal(first.latestCheckpointEventPosition, 100n);
      assert.equal(typeof first.latestCheckpointEventPosition, "bigint");

      const secondEvent = eventAfter(first, "SessionCheckpointRecorded", {
        checkpoint: checkpointFixture({
          checkpointId: lifecycleUuid<CheckpointId>(501),
          baseEventPosition: 150,
          checkpointEventPosition: 151,
        }),
        baseEventPosition: "150",
        checkpointEventPosition: "151",
      }, { globalPosition: 151 });
      const second = evolveSession(first, secondEvent);
      assert.equal(second.latestCheckpointBaseEventPosition, 150n);
      assert.equal(second.latestCheckpointEventPosition, 151n);

      expectIntegrity(() => evolveSession(first, tamperPayload(secondEvent, {
        baseEventPosition: "99",
        checkpoint: checkpointFixture({
          checkpointId: lifecycleUuid<CheckpointId>(501),
          baseEventPosition: 99,
          checkpointEventPosition: 151,
        }),
      })));
    });

    it("rejects future, self-based, mismatched, or cross-session checkpoints", () => {
      const root = rootAggregate();
      const event = eventAfter(root, "SessionCheckpointRecorded");
      expectIntegrity(() => evolveSession(root, tamperPayload(event, {
        baseEventPosition: event.globalPosition,
        checkpoint: checkpointFixture({
          baseEventPosition: event.globalPosition,
          checkpointEventPosition: event.globalPosition,
        }),
      })));
      expectIntegrity(() => evolveSession(root, tamperPayload(event, {
        baseEventPosition: (BigInt(event.globalPosition) + 1n).toString(),
        checkpoint: checkpointFixture({
          baseEventPosition: BigInt(event.globalPosition) + 1n,
          checkpointEventPosition: event.globalPosition,
        }),
      })));
      expectIntegrity(() => evolveSession(root, tamperPayload(event, { checkpointEventPosition: "1" })));
      expectIntegrity(() => evolveSession(root, tamperPayload(event, {
        checkpoint: checkpointFixture({
          sessionId: OTHER_SESSION_ID,
          baseEventPosition: 1,
          checkpointEventPosition: 2,
        }),
      })));
    });

    it("rejects a checkpoint base that does not cover the already-folded session stream", () => {
      const root = rootAggregate([
        lifecycleEvent(1, "SessionStarted", {}, { globalPosition: 100 }),
      ]);
      const staleCheckpoint = eventAfter(root, "SessionCheckpointRecorded", {
        checkpoint: checkpointFixture({
          baseEventPosition: 50,
          checkpointEventPosition: 200,
        }),
        baseEventPosition: "50",
        checkpointEventPosition: "200",
      }, { globalPosition: 200 });
      expectIntegrity(() => evolveSession(root, staleCheckpoint));

      const currentCheckpoint = eventAfter(root, "SessionCheckpointRecorded", {
        checkpoint: checkpointFixture({
          baseEventPosition: 100,
          checkpointEventPosition: 200,
        }),
        baseEventPosition: "100",
        checkpointEventPosition: "200",
      }, { globalPosition: 200 });
      assert.equal(evolveSession(root, currentCheckpoint).latestCheckpointBaseEventPosition, 100n);
    });

    it("requires authority-mutating events to carry a changed matching commitment and all others to retain it", () => {
      const root = rootAggregate();
      expectIntegrity(() => evolveSession(root, eventAfter(root, "SessionOwnerTransferred", {
        previousOwnerGeneration: 1,
        ownerGeneration: 2,
        authorityCommitment: AUTHORITY_A,
      })));

      const transfer = eventAfter(root, "SessionOwnerTransferred", {
        previousOwnerGeneration: 1,
        ownerGeneration: 2,
        authorityCommitment: AUTHORITY_B,
      });
      expectIntegrity(() => evolveSession(root, tamperEvent(transfer, { authorityCommitment: AUTHORITY_C })));
      const transferred = evolveSession(root, transfer);
      assert.equal(transferred.authorityCommitment, AUTHORITY_B);

      const checkpoint = eventAfter(transferred, "EvidenceCoverageRecorded", {}, {
        authorityCommitment: AUTHORITY_C,
      });
      expectIntegrity(() => evolveSession(transferred, checkpoint));
      expectIntegrity(() => foldSession([
        lifecycleEvent(1, "SessionStarted", { authorityCommitment: AUTHORITY_B }, { authorityCommitment: AUTHORITY_A }),
      ]));
    });

    it("rejects every post-terminal event and never mutates the prior aggregate", () => {
      const ended = evolveSession(verifiedEndingRoot(), eventAfter(verifiedEndingRoot(), "SessionEnded", {
        verificationEventPosition: verifiedEndingRoot().eventPosition.toString(),
        authorityCommitment: AUTHORITY_B,
      }));
      const endedSnapshot = structuredClone(ended);
      expectStateConflict(() => evolveSession(ended, eventAfter(ended, "SessionCheckpointRecorded")));
      expectStateConflict(() => evolveSession(ended, eventAfter(ended, "SessionEnded", {
        authorityCommitment: AUTHORITY_C,
      })));
      assert.deepEqual(ended, endedSnapshot);

      const abandoned = evolveSession(rootAggregate(), eventAfter(rootAggregate(), "SessionAbandoned", {
        authorityCommitment: AUTHORITY_B,
      }));
      expectStateConflict(() => evolveSession(abandoned, eventAfter(abandoned, "SessionAbandoned", {
        authorityCommitment: AUTHORITY_C,
      })));
    });
  });

  describe("child transitions", () => {
    it("keeps child generation independent and folds report, proposal, rejection, suspension, and transfer", () => {
      let child = childAggregate();
      assert.equal(child.childCapabilityGeneration, 1);
      assert.equal(child.ownerGeneration, null);

      child = evolveSession(child, eventAfter(child, "ChildWorkReported"));
      assert.equal(child.state, "active");
      child = evolveSession(child, eventAfter(child, "ChildCompletionProposed"));
      assert.equal(child.state, "completion-proposed");
      child = evolveSession(child, eventAfter(child, "ChildWorkDispositioned", {
        disposition: childDispositionFixture("rejected"),
      }));
      assert.equal(child.state, "active");
      child = evolveSession(child, eventAfter(child, "SessionCheckpointRecorded"));
      child = evolveSession(child, eventAfter(child, "ChildSessionSuspended", {
        authorityCommitment: AUTHORITY_B,
      }));
      assert.equal(child.state, "suspended");
      assert.equal(child.childCapabilityGeneration, 1);
      assert.equal(child.childCapabilityRevoked, true);
      assert.equal((child as ChildAggregateState & { readonly suspensionCheckpointId?: CheckpointId }).suspensionCheckpointId, CHECKPOINT_ID);
      child = evolveSession(child, eventAfter(child, "ChildWorkTransferCreated", {
        authorityCommitment: AUTHORITY_C,
      }));
      assert.equal(child.state, "transferred");
      assert.equal(child.terminalEventPosition, child.eventPosition);
      assert.equal(child.terminalEventType, "ChildWorkTransferCreated");
    });

    it("requires child suspension and transfer to cite one recorded checkpoint", () => {
      const active = childAggregate();
      expectIntegrity(() => evolveSession(active, eventAfter(active, "ChildSessionSuspended", {
        authorityCommitment: AUTHORITY_B,
      })));

      const checkpointed = evolveSession(active, eventAfter(active, "SessionCheckpointRecorded"));
      const otherCheckpointId = lifecycleUuid<CheckpointId>(616);
      expectIntegrity(() => evolveSession(checkpointed, eventAfter(checkpointed, "ChildSessionSuspended", {
        checkpointId: otherCheckpointId,
        authorityCommitment: AUTHORITY_B,
      })));

      const suspended = evolveSession(checkpointed, eventAfter(checkpointed, "ChildSessionSuspended", {
        checkpointId: CHECKPOINT_ID,
        authorityCommitment: AUTHORITY_B,
      }));
      assert.equal(
        (suspended as ChildAggregateState & { readonly suspensionCheckpointId?: CheckpointId }).suspensionCheckpointId,
        CHECKPOINT_ID,
      );
      expectIntegrity(() => evolveSession(suspended, eventAfter(suspended, "ChildWorkTransferCreated", {
        checkpointId: otherCheckpointId,
        authorityCommitment: AUTHORITY_C,
      })));

      const transferred = evolveSession(suspended, eventAfter(suspended, "ChildWorkTransferCreated", {
        checkpointId: CHECKPOINT_ID,
        authorityCommitment: AUTHORITY_C,
      }));
      assert.equal(transferred.state, "transferred");
    });

    it("keeps the frozen V1 suspension checkpoint authoritative after recheckpointing", () => {
      const suspended = suspendedChild();
      const newerCheckpointId = lifecycleUuid<CheckpointId>(617);
      const newerCheckpointPosition = suspended.eventPosition + 1n;
      const recheckpointed = evolveSession(suspended, eventAfter(suspended, "SessionCheckpointRecorded", {
        checkpoint: checkpointFixture({
          sessionId: suspended.sessionId,
          parentSessionId: suspended.parentSessionId,
          checkpointId: newerCheckpointId,
          baseEventPosition: suspended.eventPosition,
          checkpointEventPosition: newerCheckpointPosition,
        }),
        baseEventPosition: suspended.eventPosition.toString(),
        checkpointEventPosition: newerCheckpointPosition.toString(),
      }));

      expectIntegrity(() => evolveSession(recheckpointed, eventAfter(recheckpointed, "ChildWorkTransferCreated", {
        checkpointId: newerCheckpointId,
        authorityCommitment: AUTHORITY_C,
      })));
      const transferred = evolveSession(recheckpointed, eventAfter(recheckpointed, "ChildWorkTransferCreated", {
        checkpointId: CHECKPOINT_ID,
        authorityCommitment: AUTHORITY_C,
      }));
      assert.equal(transferred.state, "transferred");
    });

    it("accepts internal transfer V2 with a newer governing checkpoint", () => {
      const suspended = suspendedChild();
      const newerCheckpointId = lifecycleUuid<CheckpointId>(618);
      const newerCheckpointPosition = suspended.eventPosition + 1n;
      const recheckpointed = evolveSession(suspended, eventAfter(suspended, "SessionCheckpointRecorded", {
        checkpoint: checkpointFixture({
          sessionId: suspended.sessionId,
          parentSessionId: suspended.parentSessionId,
          checkpointId: newerCheckpointId,
          baseEventPosition: suspended.eventPosition,
          checkpointEventPosition: newerCheckpointPosition,
        }),
        baseEventPosition: suspended.eventPosition.toString(),
        checkpointEventPosition: newerCheckpointPosition.toString(),
      }));

      const transferred = evolveSession(recheckpointed, internalTransferEventV2(
        recheckpointed,
        CHECKPOINT_ID,
        newerCheckpointId,
      ));
      assert.equal(transferred.state, "transferred");
    });

    it("enforces assignment revisions and immutable assignment identity in every allowed nonterminal state", () => {
      for (const child of [childAggregate(), completionProposedChild(), suspendedChild()] as const) {
        const amended = evolveSession(child, eventAfter(child, "ChildAssignmentAmended", {
          previousAssignmentRevision: 1,
          assignmentRevision: 2,
          assignment: DEFAULT_ASSIGNMENT,
        }));
        assert.equal(amended.state, child.state);
        assert.equal(amended.assignmentRevision, 2);
      }

      const child = childAggregate();
      expectIntegrity(() => evolveSession(child, eventAfter(child, "ChildAssignmentAmended", {
        previousAssignmentRevision: 2,
        assignmentRevision: 3,
      })));
      expectIntegrity(() => evolveSession(child, eventAfter(child, "ChildAssignmentAmended", {
        previousAssignmentRevision: 1,
        assignmentRevision: 3,
      })));
      expectIntegrity(() => evolveSession(child, eventAfter(child, "ChildAssignmentAmended", {
        assignment: { ...DEFAULT_ASSIGNMENT, assignmentId: lifecycleUuid(601) },
      })));
    });

    it("binds reports to child lineage and the current assignment", () => {
      const child = childAggregate();
      const reported = evolveSession(child, eventAfter(child, "ChildWorkReported"));
      assert.equal(reported.state, "active");
      assert.equal(reported.latestReportId, REPORT_ID);

      const badReports = [
        childReportFixture({ childSessionId: OTHER_SESSION_ID }),
        childReportFixture({ parentSessionId: OTHER_SESSION_ID }),
        childReportFixture({ assignmentId: lifecycleUuid(602) }),
      ];
      for (const report of badReports) {
        expectIntegrity(() => evolveSession(child, eventAfter(child, "ChildWorkReported", { report })));
      }
    });

    it("stores report lineage as a canonical frozen structurally shared index", () => {
      const child = childAggregate();
      const mutableItemIds = [REPORT_ITEM_ID, SECOND_REPORT_ITEM_ID];
      const report = {
        ...childReportFixture(),
        allReportItemIds: mutableItemIds,
      };
      const reported = evolveSession(child, eventAfter(child, "ChildWorkReported", { report }));
      assert.equal(reported.reportCount, 1);
      assert.equal("reportLineage" in reported, false);
      const firstHead = reported.reportIndexHead;
      assert.ok(firstHead);
      assert.equal(Object.isFrozen(firstHead), true);
      assert.equal(firstHead.reportId, REPORT_ID);
      assert.equal(firstHead.previous, null);
      assert.deepEqual(Object.keys(firstHead).sort(), ["itemSignature", "previous", "reportId"]);
      assert.equal(Object.values(firstHead).some(Array.isArray), false);
      const firstSignature = firstHead.itemSignature;
      mutableItemIds[0] = lifecycleUuid<ReportItemId>(610);
      assert.equal(firstHead.itemSignature, firstSignature);

      const reversedChild = childAggregate();
      const reversed = evolveSession(reversedChild, eventAfter(reversedChild, "ChildWorkReported", {
        report: childReportFixture({
          itemIds: [SECOND_REPORT_ITEM_ID, REPORT_ITEM_ID],
        }),
      }));
      assert.equal(reversed.reportIndexHead?.itemSignature, firstSignature);

      const secondReportId = lifecycleUuid<ReportId>(618);
      const secondItemIds = [
        lifecycleUuid<ReportItemId>(619),
        lifecycleUuid<ReportItemId>(620),
      ] as const;
      const withSecond = evolveSession(reported, eventAfter(reported, "ChildWorkReported", {
        report: childReportFixture({ reportId: secondReportId, itemIds: secondItemIds }),
      }));
      assert.equal(withSecond.reportCount, 2);
      assert.equal(Object.isFrozen(withSecond.reportIndexHead), true);
      assert.equal(withSecond.reportIndexHead?.reportId, secondReportId);
      assert.equal(withSecond.reportIndexHead?.previous, firstHead);

      expectIntegrity(() => evolveSession(reported, eventAfter(reported, "ChildWorkReported", {
        report: childReportFixture({ reportId: REPORT_ID }),
      })));
      expectIntegrity(() => evolveSession(reported, eventAfter(reported, "ChildWorkReported", {
        report: childReportFixture({
          reportId: lifecycleUuid<ReportId>(621),
          itemIds: [REPORT_ITEM_ID, REPORT_ITEM_ID],
        }),
      })));
    });

    it("accepts exactly 200 reports and rejects report 201 with bounded frozen state", () => {
      let child = childAggregate();
      let previousHead: ChildReportIndexNode | null = null;

      for (let index = 0; index < 200; index += 1) {
        const reportId = lifecycleUuid<ReportId>(10_000 + index);
        const itemIds = [
          lifecycleUuid<ReportItemId>(20_000 + index * 2),
          lifecycleUuid<ReportItemId>(20_001 + index * 2),
        ] as const;
        child = evolveSession(child, eventAfter(child, "ChildWorkReported", {
          report: childReportFixture({ reportId, itemIds }),
        }));
        assert.equal(child.reportIndexHead?.previous, previousHead);
        previousHead = child.reportIndexHead;
      }

      assert.equal(child.reportCount, 200);
      assert.equal(Object.isFrozen(child), true);
      let node = child.reportIndexHead;
      let depth = 0;
      while (node !== null) {
        assert.equal(Object.isFrozen(node), true);
        assert.deepEqual(Object.keys(node).sort(), ["itemSignature", "previous", "reportId"]);
        assert.equal(Object.values(node).some(Array.isArray), false);
        node = node.previous;
        depth += 1;
      }
      assert.equal(depth, 200);

      const overflowReportId = lifecycleUuid<ReportId>(10_200);
      expectIntegrity(() => evolveSession(child, eventAfter(child, "ChildWorkReported", {
        report: childReportFixture({
          reportId: overflowReportId,
          itemIds: [
            lifecycleUuid<ReportItemId>(20_400),
            lifecycleUuid<ReportItemId>(20_401),
          ],
        }),
      })));
    });

    it("rejects a self-consistent disposition partition containing items absent from its report", () => {
      const child = evolveSession(childAggregate(), eventAfter(childAggregate(), "ChildWorkReported"));
      const falseItemId = lifecycleUuid<ReportItemId>(611);
      const falseDisposition = {
        ...childDispositionFixture("accepted"),
        acceptedItemIds: Object.freeze([falseItemId]),
        allReportItemIds: Object.freeze([falseItemId]),
      };
      expectIntegrity(() => evolveSession(child, eventAfter(child, "ChildWorkDispositioned", {
        disposition: falseDisposition,
      })));
    });

    it("keeps a proposed report actionable after a newer report is recorded", () => {
      const firstReported = evolveSession(childAggregate(), eventAfter(childAggregate(), "ChildWorkReported"));
      const proposed = evolveSession(firstReported, eventAfter(firstReported, "ChildCompletionProposed", {
        reportId: REPORT_ID,
      }));
      const newerReportId = lifecycleUuid<ReportId>(612);
      const newerItemIds = [
        lifecycleUuid<ReportItemId>(613),
        lifecycleUuid<ReportItemId>(614),
      ] as const;
      const withNewerReport = evolveSession(proposed, eventAfter(proposed, "ChildWorkReported", {
        report: childReportFixture({ reportId: newerReportId, itemIds: newerItemIds }),
      }));

      const rejected = evolveSession(withNewerReport, eventAfter(withNewerReport, "ChildWorkDispositioned", {
        disposition: childDispositionFixture("rejected", REPORT_ID),
      }));
      assert.equal(rejected.state, "active");
      assert.equal(rejected.completionReportId, null);

      const completedProposal = evolveSession(withNewerReport, eventAfter(withNewerReport, "ChildSessionCompleted", {
        reportId: REPORT_ID,
        authorityCommitment: AUTHORITY_B,
      }));
      assert.equal(completedProposal.state, "completed");

      const activeWithNewerReport = evolveSession(firstReported, eventAfter(firstReported, "ChildWorkReported", {
        report: childReportFixture({ reportId: newerReportId, itemIds: newerItemIds }),
      }));
      const completedOlderReport = evolveSession(activeWithNewerReport, eventAfter(activeWithNewerReport, "ChildSessionCompleted", {
        reportId: REPORT_ID,
        authorityCommitment: AUTHORITY_B,
      }));
      assert.equal(completedOlderReport.state, "completed");
    });

    it("allows proposal only from active and lets only a rejected proposal disposition restore active", () => {
      const child = evolveSession(childAggregate(), eventAfter(childAggregate(), "ChildWorkReported"));
      const proposed = evolveSession(child, eventAfter(child, "ChildCompletionProposed", { reportId: REPORT_ID }));
      assert.equal(proposed.state, "completion-proposed");
      expectStateConflict(() => evolveSession(proposed, eventAfter(proposed, "ChildCompletionProposed")));
      expectStateConflict(() => evolveSession(suspendedChild(), eventAfter(suspendedChild(), "ChildCompletionProposed")));

      const accepted = evolveSession(proposed, eventAfter(proposed, "ChildWorkDispositioned", {
        disposition: childDispositionFixture("accepted"),
      }));
      assert.equal(accepted.state, "completion-proposed");
      const rejected = evolveSession(proposed, eventAfter(proposed, "ChildWorkDispositioned", {
        disposition: childDispositionFixture("rejected"),
      }));
      assert.equal(rejected.state, "active");
      assert.equal(rejected.completionReportId, null);
    });

    it("completes or suspends only active/proposed children and transfers only suspended children", () => {
      for (const child of [
        evolveSession(childAggregate(), eventAfter(childAggregate(), "ChildWorkReported")),
        completionProposedChild(),
      ] as const) {
        const completed = evolveSession(child, eventAfter(child, "ChildSessionCompleted", {
          reportId: REPORT_ID,
          authorityCommitment: AUTHORITY_B,
        }));
        assert.equal(completed.state, "completed");
        assert.equal(completed.terminalEventType, "ChildSessionCompleted");
        assert.equal(completed.childCapabilityRevoked, true);
      }

      const active = childAggregate();
      expectStateConflict(() => evolveSession(active, eventAfter(active, "ChildWorkTransferCreated", {
        authorityCommitment: AUTHORITY_B,
      })));
      const suspended = suspendedChild();
      expectStateConflict(() => evolveSession(suspended, eventAfter(suspended, "ChildSessionCompleted", {
        authorityCommitment: AUTHORITY_C,
      })));
      expectStateConflict(() => evolveSession(suspended, eventAfter(suspended, "ChildSessionSuspended", {
        authorityCommitment: AUTHORITY_C,
      })));
    });

    it("claims a transfer only as the second event of a transfer-derived new child stream", () => {
      const derived = transferDerivedChild();
      const claimed = evolveSession(derived, eventAfter(derived, "ChildWorkTransferClaimed", {
        transferTicketId: TRANSFER_TICKET_ID,
        previousChildSessionId: OTHER_SESSION_ID,
        previousTransferEventPosition: "8",
      }, { globalPosition: 11 }));
      assert.equal(claimed.state, "active");
      assert.equal(claimed.claimedTransferTicketId, TRANSFER_TICKET_ID);

      const ordinary = childAggregate();
      expectIntegrity(() => evolveSession(ordinary, eventAfter(ordinary, "ChildWorkTransferClaimed")));
      expectIntegrity(() => evolveSession(derived, eventAfter(derived, "ChildWorkTransferClaimed", {
        transferTicketId: lifecycleUuid<TransferTicketId>(603),
      }, { globalPosition: 11 })));
      const withReport = evolveSession(derived, eventAfter(derived, "ChildWorkReported", {}, { globalPosition: 11 }));
      expectIntegrity(() => evolveSession(withReport, eventAfter(withReport, "ChildWorkTransferClaimed", {
        previousTransferEventPosition: "8",
      }, { globalPosition: 12 })));
      expectIntegrity(() => evolveSession(derived, eventAfter(derived, "ChildWorkTransferClaimed", {
        previousChildSessionId: derived.sessionId,
        previousTransferEventPosition: "8",
      }, { globalPosition: 11 })));
      expectIntegrity(() => evolveSession(derived, eventAfter(derived, "ChildWorkTransferClaimed", {
        previousTransferEventPosition: "11",
      }, { globalPosition: 11 })));
      expectIntegrity(() => evolveSession(derived, eventAfter(derived, "ChildWorkTransferClaimed", {
        previousTransferEventPosition: "11",
      }, { globalPosition: 12 })));
    });

    it("uses closed child transition tables and rejects every post-terminal mutation", () => {
      const active = childAggregate();
      const proposed = completionProposedChild();
      const suspended = suspendedChild();

      expectStateConflict(() => evolveSession(suspended, eventAfter(suspended, "ChildWorkDispositioned")));
      expectStateConflict(() => evolveSession(proposed, eventAfter(proposed, "ChildWorkTransferCreated", {
        authorityCommitment: AUTHORITY_B,
      })));
      expectStateConflict(() => evolveSession(active, eventAfter(active, "SessionEndRequested")));

      const reported = evolveSession(active, eventAfter(active, "ChildWorkReported"));
      const completed = evolveSession(reported, eventAfter(reported, "ChildSessionCompleted", {
        authorityCommitment: AUTHORITY_B,
      }));
      const completedSnapshot = structuredClone(completed);
      expectStateConflict(() => evolveSession(completed, eventAfter(completed, "ChildAssignmentAmended")));
      expectStateConflict(() => evolveSession(completed, eventAfter(completed, "ChildSessionCompleted", {
        authorityCommitment: AUTHORITY_C,
      })));
      assert.deepEqual(completed, completedSnapshot);

      const transferred = evolveSession(suspended, eventAfter(suspended, "ChildWorkTransferCreated", {
        authorityCommitment: AUTHORITY_C,
      }));
      expectStateConflict(() => evolveSession(transferred, eventAfter(transferred, "SessionCheckpointRecorded")));
    });
  });

  describe("complete transition matrix", () => {
    it("checks all 260 kind, state, and event-type combinations", () => {
      assert.equal(TRANSITION_POLICY_IS_PRIVATE, true);
      const rootAllowed = {
        active: [
          "SessionOwnerTransferred",
          "SessionOwnershipRecovered",
          "SessionSuspendRequested",
          "SessionSuspended",
          "SessionCheckpointRecorded",
          "EvidenceCoverageRecorded",
          "SessionEndRequested",
          "SessionAbandoned",
        ],
        suspended: [
          "SessionOwnerTransferred",
          "SessionOwnershipRecovered",
          "SessionResumed",
          "SessionCheckpointRecorded",
          "EvidenceCoverageRecorded",
          "SessionEndRequested",
          "SessionAbandoned",
        ],
        ending: [
          "SessionOwnershipRecovered",
          "SessionCheckpointRecorded",
          "EvidenceCoverageRecorded",
          "SessionEndAmended",
          "SessionValidationResultRecorded",
          "SessionEndVerificationPassed",
          "SessionEndVerificationFailed",
          "SessionEndVerificationInvalidated",
          "SessionEndCancelled",
          "SessionAbandoned",
          "SessionEnded",
        ],
        ended: [],
        abandoned: [],
      } as const satisfies Readonly<Record<RootSessionState, readonly LifecycleEventType[]>>;
      const childAllowed = {
        active: [
          "SessionCheckpointRecorded",
          "EvidenceCoverageRecorded",
          "ChildAssignmentAmended",
          "ChildWorkReported",
          "ChildWorkDispositioned",
          "ChildCompletionProposed",
          "ChildSessionCompleted",
          "ChildSessionSuspended",
          "ChildWorkTransferClaimed",
        ],
        "completion-proposed": [
          "SessionCheckpointRecorded",
          "EvidenceCoverageRecorded",
          "ChildAssignmentAmended",
          "ChildWorkReported",
          "ChildWorkDispositioned",
          "ChildSessionCompleted",
          "ChildSessionSuspended",
        ],
        completed: [],
        suspended: [
          "SessionCheckpointRecorded",
          "EvidenceCoverageRecorded",
          "ChildAssignmentAmended",
          "ChildWorkReported",
          "ChildWorkTransferCreated",
        ],
        transferred: [],
      } as const satisfies Readonly<Record<ChildSessionState, readonly LifecycleEventType[]>>;

      const verified = verifiedEndingRoot();
      const reported = evolveSession(childAggregate(), eventAfter(childAggregate(), "ChildWorkReported"));
      const rootCases: readonly (readonly [RootSessionState, RootAggregateState])[] = [
        ["active", rootAggregate()],
        ["suspended", suspendedRoot()],
        ["ending", endingRoot()],
        ["ended", evolveSession(verified, eventAfter(verified, "SessionEnded", {
          authorityCommitment: AUTHORITY_B,
        }))],
        ["abandoned", evolveSession(rootAggregate(), eventAfter(rootAggregate(), "SessionAbandoned", {
          authorityCommitment: AUTHORITY_B,
        }))],
      ];
      const childCases: readonly (readonly [ChildSessionState, ChildAggregateState])[] = [
        ["active", childAggregate()],
        ["completion-proposed", completionProposedChild()],
        ["completed", evolveSession(reported, eventAfter(reported, "ChildSessionCompleted", {
          authorityCommitment: AUTHORITY_B,
        }))],
        ["suspended", suspendedChild()],
        ["transferred", evolveSession(suspendedChild(), eventAfter(suspendedChild(), "ChildWorkTransferCreated", {
          authorityCommitment: AUTHORITY_C,
        }))],
      ];

      let combinations = 0;
      for (const eventType of LIFECYCLE_EVENT_TYPES) {
        for (const [state, aggregate] of rootCases) {
          const expected = (rootAllowed[state] as readonly LifecycleEventType[]).includes(eventType);
          const error = (() => {
            try {
              evolveSession(aggregate, eventAfter(aggregate, eventType) as LifecycleEventV1);
              return null;
            } catch (candidate) {
              return candidate as LifecycleError;
            }
          })();
          if (expected) {
            assert.ok(
              error === null || error.code === "INTEGRITY_FAILURE",
              `root ${state} + ${eventType} must route past the transition table`,
            );
          } else {
            assert.equal(error?.code, "SESSION_STATE_CONFLICT", `root ${state} + ${eventType}`);
          }
          combinations += 1;
        }
        for (const [state, aggregate] of childCases) {
          const expected = (childAllowed[state] as readonly LifecycleEventType[]).includes(eventType);
          const error = (() => {
            try {
              evolveSession(aggregate, eventAfter(aggregate, eventType) as LifecycleEventV1);
              return null;
            } catch (candidate) {
              return candidate as LifecycleError;
            }
          })();
          if (expected) {
            assert.ok(
              error === null || error.code === "INTEGRITY_FAILURE",
              `child ${state} + ${eventType} must route past the transition table`,
            );
          } else {
            assert.equal(error?.code, "SESSION_STATE_CONFLICT", `child ${state} + ${eventType}`);
          }
          combinations += 1;
        }
      }
      assert.equal(LIFECYCLE_EVENT_TYPES.length, 26);
      assert.equal(combinations, 260);
    });
  });

  describe("kind isolation and authority mirror", () => {
    it("never lets child activity change a root aggregate", () => {
      const root = rootAggregate();
      const snapshot = structuredClone(root);
      const forgedChildEvent = tamperEvent(lifecycleEvent(2, "ChildWorkReported"), {
        sessionId: root.sessionId,
        parentSessionId: root.parentSessionId,
        streamId: root.streamId,
        correlationId: root.correlationId,
        authorityCommitment: root.authorityCommitment,
      });
      expectStateConflict(() => evolveSession(root, forgedChildEvent));
      assert.deepEqual(root, snapshot);
    });

    it("accepts only an exact authority mirror, including direct bigint equality", () => {
      const root = evolveSession(rootAggregate(), eventAfter(rootAggregate(), "SessionCheckpointRecorded"));
      assert.doesNotThrow(() => assertAuthorityMirror(root, authorityMirror(root)));

      const mismatches: readonly Partial<SessionAuthorityMirror>[] = [
        { sessionKind: "child" },
        { parentSessionId: OTHER_SESSION_ID },
        { semanticState: "suspended" },
        { ownerGeneration: 2n },
        { childCapabilityGeneration: 1n },
        { authorityCommitment: AUTHORITY_B },
        { latestCheckpointEventPosition: root.latestCheckpointEventPosition! + 1n },
        { terminalEventPosition: 99n },
      ];
      for (const mismatch of mismatches) {
        expectIntegrity(() => assertAuthorityMirror(root, authorityMirror(root, mismatch)));
      }
      expectIntegrity(() => assertAuthorityMirror(root, {
        ...authorityMirror(root),
        latestCheckpointEventPosition: root.latestCheckpointEventPosition!.toString() as unknown as bigint,
      }));

      const child = childAggregate();
      assert.doesNotThrow(() => assertAuthorityMirror(child, authorityMirror(child)));
      expectIntegrity(() => assertAuthorityMirror(child, authorityMirror(child, { childCapabilityGeneration: 2n })));
    });

    it("classifies only ended, abandoned, completed, and transferred states as terminal", () => {
      assert.equal(isTerminalSession(rootAggregate()), false);
      assert.equal(isTerminalSession(suspendedRoot()), false);
      assert.equal(isTerminalSession(endingRoot()), false);
      assert.equal(isTerminalSession(childAggregate()), false);
      assert.equal(isTerminalSession(completionProposedChild()), false);
      assert.equal(isTerminalSession(suspendedChild()), false);

      const endedBase = verifiedEndingRoot();
      const ended = evolveSession(endedBase, eventAfter(endedBase, "SessionEnded", {
        verificationEventPosition: endedBase.eventPosition.toString(),
        authorityCommitment: AUTHORITY_B,
      }));
      assert.equal(isTerminalSession(ended), true);
      const abandonedBase = rootAggregate();
      assert.equal(isTerminalSession(evolveSession(abandonedBase, eventAfter(abandonedBase, "SessionAbandoned", {
        authorityCommitment: AUTHORITY_B,
      }))), true);
      const completedBase = evolveSession(childAggregate(), eventAfter(childAggregate(), "ChildWorkReported"));
      assert.equal(isTerminalSession(evolveSession(completedBase, eventAfter(completedBase, "ChildSessionCompleted", {
        authorityCommitment: AUTHORITY_B,
      }))), true);
      const transferredBase = suspendedChild();
      assert.equal(isTerminalSession(evolveSession(transferredBase, eventAfter(transferredBase, "ChildWorkTransferCreated", {
        authorityCommitment: AUTHORITY_C,
      }))), true);
    });

    it("classifies unsupported kind/state combinations separately from invariant corruption", () => {
      const root = rootAggregate();
      expectStateConflict(() => evolveSession(root, eventAfter(root, "ChildAssignmentAmended") as LifecycleEventV1));
      const next = eventAfter(root, "SessionCheckpointRecorded") as LifecycleEventV1;
      expectIntegrity(() => evolveSession(root, tamperEvent(next, { streamVersion: "9" })));
      expectIntegrity(() => evolveSession(root, tamperEvent(next, { sessionId: OTHER_SESSION_ID })));
      expectIntegrity(() => evolveSession(root, tamperEvent(next, { authorityCommitment: AUTHORITY_B })));
    });
  });
});
