import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertAuthorityMirror,
  evolveSession,
  foldSession,
  isTerminalSession,
  type ChildAggregateState,
  type RootAggregateState,
  type SessionAggregateState,
  type SessionAuthorityMirror,
} from "../src/orchestrator/lifecycle/session-aggregate.js";
import type {
  LifecycleEventBaseV1,
  LifecycleEventPayloadMapV1,
  LifecycleEventType,
  LifecycleEventV1,
} from "../src/orchestrator/lifecycle/contracts/events.js";
import type { LifecycleError } from "../src/orchestrator/lifecycle/errors.js";
import type {
  CheckpointId,
  SessionId,
  TransferTicketId,
  WorkflowId,
} from "../src/orchestrator/lifecycle/contracts/identifiers.js";
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
  ROOT_SESSION_ID,
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

function suspendRequestedRoot(): RootAggregateState {
  return rootAggregate([
    lifecycleEvent(1, "SessionStarted"),
    lifecycleEvent(2, "SessionSuspendRequested"),
  ]);
}

function suspendedRoot(): RootAggregateState {
  return rootAggregate([
    lifecycleEvent(1, "SessionStarted"),
    lifecycleEvent(2, "SessionSuspendRequested"),
    lifecycleEvent(3, "SessionSuspended", { authorityCommitment: AUTHORITY_B }, { authorityCommitment: AUTHORITY_B }),
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
    lifecycleEvent(2, "ChildSessionSuspended", { authorityCommitment: AUTHORITY_B }, { authorityCommitment: AUTHORITY_B }),
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
        lifecycleEvent(2, "SessionSuspendRequested", { checkpointId: CHECKPOINT_ID }),
        lifecycleEvent(3, "SessionSuspended", { authorityCommitment: AUTHORITY_B }, { authorityCommitment: AUTHORITY_B }),
        lifecycleEvent(4, "SessionOwnerTransferred", {
          previousOwnerGeneration: 1,
          ownerGeneration: 2,
          authorityCommitment: AUTHORITY_C,
        }, { authorityCommitment: AUTHORITY_C }),
        lifecycleEvent(5, "SessionResumed", { ownerGeneration: 2 }, { authorityCommitment: AUTHORITY_C }),
        lifecycleEvent(6, "SessionEndRequested", {
          previousState: "active",
          workflowGeneration: 1,
        }, { authorityCommitment: AUTHORITY_C }),
        lifecycleEvent(7, "SessionEndVerificationPassed", {
          workflowGeneration: 1,
        }, { authorityCommitment: AUTHORITY_C }),
        lifecycleEvent(8, "SessionEnded", {
          workflowGeneration: 1,
          verificationEventPosition: "7",
          authorityCommitment: AUTHORITY_D,
        }, { authorityCommitment: AUTHORITY_D }),
      ]);
      assert.equal(aggregate.kind, "root");
      assert.equal(aggregate.state, "ended");
      assert.equal(aggregate.ownerGeneration, 2);
      assert.equal(aggregate.terminalEventPosition, 8n);
      assert.equal(aggregate.terminalEventType, "SessionEnded");
      assert.equal(aggregate.authorityCommitment, AUTHORITY_D);
    });

    it("requires suspend request before suspension and preserves generation across resume", () => {
      const active = rootAggregate();
      expectIntegrity(() => evolveSession(active, eventAfter(active, "SessionSuspended", {
        authorityCommitment: AUTHORITY_B,
      })));

      const requested = evolveSession(active, eventAfter(active, "SessionSuspendRequested"));
      assert.equal(requested.state, "active");
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

      const failed = evolveSession(passed, eventAfter(passed, "SessionEndVerificationFailed"));
      assert.equal(failed.verificationPassedEventPosition, null);
      expectIntegrity(() => evolveSession(failed, eventAfter(failed, "SessionEnded", {
        verificationEventPosition: passed.eventPosition.toString(),
        authorityCommitment: AUTHORITY_B,
      })));
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
      child = evolveSession(child, eventAfter(child, "ChildSessionSuspended", {
        authorityCommitment: AUTHORITY_B,
      }));
      assert.equal(child.state, "suspended");
      assert.equal(child.childCapabilityGeneration, 1);
      assert.equal(child.childCapabilityRevoked, true);
      child = evolveSession(child, eventAfter(child, "ChildWorkTransferCreated", {
        authorityCommitment: AUTHORITY_C,
      }));
      assert.equal(child.state, "transferred");
      assert.equal(child.terminalEventPosition, child.eventPosition);
      assert.equal(child.terminalEventType, "ChildWorkTransferCreated");
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
        { ownerGeneration: 2 },
        { childCapabilityGeneration: 1 },
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
      expectIntegrity(() => assertAuthorityMirror(child, authorityMirror(child, { childCapabilityGeneration: 2 })));
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
