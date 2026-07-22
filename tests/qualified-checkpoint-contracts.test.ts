import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHECKPOINT_EVIDENCE_COVERAGE_MAX_CANONICAL_BYTES,
  CHECKPOINT_MAX_CANONICAL_BYTES,
  decodeCheckpoint,
  decodeCheckpointDraft,
  decodeCheckpointV1,
  type CheckpointEvidenceCoverageV2,
  type CheckpointV2,
} from "../src/orchestrator/lifecycle/contracts/checkpoint.js";
import {
  decodeLifecycleEvent,
  type LifecycleEventV2,
} from "../src/orchestrator/lifecycle/contracts/events.js";
import {
  decodeLifecycleSemanticCommandDraft,
  type InternalWorkflowExecutionPlan,
  type LifecycleSemanticCommandDraft,
} from "../src/orchestrator/lifecycle/contracts/commands.js";
import {
  FINAL_ENDING_SCOPE_BINDINGS_MAX_CANONICAL_BYTES,
  decodeFinalEndingScopeBindingsV1,
  decodeSessionEndAmendment,
  decodeSessionEndRequest,
  type FinalEndingScopeBindingV1,
} from "../src/orchestrator/lifecycle/contracts/session-end.js";
import {
  minimumCheckpointUpperBound,
  minimumFinalEndingScopeBindingsUpperBound,
} from "../src/orchestrator/lifecycle/checkpoint-capacity.js";
import {
  LIFECYCLE_ERROR_CODES,
  LifecycleError,
  type LifecycleErrorCode,
} from "../src/orchestrator/lifecycle/errors.js";
import {
  canonicalUtf8Bytes,
  compareCanonicalUtf8,
  referenceCheckpointFingerprint,
  unknownJsonStringUpperBound,
} from "./support/qualified-checkpoint-reference.js";

const ID = {
  project: "00000000-0000-4000-8000-000000000001",
  vault: "00000000-0000-4000-8000-000000000002",
  store: "00000000-0000-4000-8000-000000000003",
  session: "00000000-0000-4000-8000-000000000010",
  child: "00000000-0000-4000-8000-000000000011",
  checkpoint: "00000000-0000-4000-8000-000000000020",
  adapterA: "00000000-0000-4000-8000-000000000030",
  adapterB: "00000000-0000-4000-8000-000000000031",
  batch: "00000000-0000-4000-8000-000000000040",
  frame: "00000000-0000-4000-8000-000000000050",
  workflow: "00000000-0000-4000-8000-000000000060",
  transfer: "00000000-0000-4000-8000-000000000070",
  event: "00000000-0000-4000-8000-000000000080",
  correlation: "00000000-0000-4000-8000-000000000081",
  command: "00000000-0000-4000-8000-000000000082",
} as const;
const HASH = "a".repeat(64);
const COVERAGE_HASH = "b".repeat(64);
const WORKSPACE = "c".repeat(64);

function checkpointContent(checkpointVersion: 1 | 2): Record<string, unknown> {
  return {
    checkpointVersion,
    taskSummary: "qualified checkpoint",
    completedItems: [{ summary: "contract frozen", confidence: "high" }],
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

function coverageEntry(adapterSessionId: string = ID.adapterA): Record<string, unknown> {
  return {
    adapterSessionId,
    coverageFirstOrdinal: "0",
    coverageLastOrdinal: "2",
    highestContiguousOrdinal: null,
    missingIntervals: [{ firstOrdinal: "0", lastOrdinal: "1" }],
    frameFingerprintAlgorithm: "hmac-sha256",
    frameFingerprintSchemaVersion: 1,
    frameFingerprintKeyId: "evidence-key-1",
    frameFingerprintDomain: "pm-evidence-frame-v1",
    coverageFingerprintAlgorithm: "hmac-sha256",
    coverageFingerprintSchemaVersion: 1,
    coverageFingerprintKeyId: "evidence-key-1",
    coverageFingerprintDomain: "pm-evidence-coverage-v1",
    coverageFingerprint: COVERAGE_HASH,
    latestBatchId: ID.batch,
    latestBatchEventPosition: "10",
  };
}

function coverage(adapterSessions: readonly unknown[] = [coverageEntry()]): Record<string, unknown> {
  return {
    coverageVersion: 2,
    captureMode: "coverage-only",
    contentRetained: false,
    adapterSessions,
  };
}

function checkpoint(version: 1 | 2): Record<string, unknown> {
  return {
    ...checkpointContent(version),
    checkpointId: ID.checkpoint,
    sessionId: ID.session,
    parentSessionId: null,
    baseEventPosition: "12",
    checkpointEventPosition: "13",
    createdAt: "2026-07-22T00:00:00.000Z",
    creatorAgentId: "agent-primary",
    creatorClientInstanceId: "desktop/tests",
    sourceState: {
      sourceStateScopeVersion: 1,
      workspaceId: WORKSPACE,
      branchRef: "refs/heads/test",
      headCommit: "d".repeat(40),
      dirtyWorktreeFingerprint: HASH,
    },
    childSummaries: [],
    evidenceCoverage: version === 1
      ? {
          captureMode: "coverage-only",
          contentRetained: false,
          highestContiguousOrdinal: null,
          missingIntervals: [],
        }
      : coverage(),
  };
}

export const V1_CHECKPOINT_VECTOR = checkpoint(1);
const V1_CHECKPOINT_HASH = "24a4652935b343637460b9a40d61c6b7bee824cecb9d11b3451a2122dbb52d4b";

function event(eventSchemaVersion: 1 | 2, eventType: string, payload: unknown): Record<string, unknown> {
  return {
    eventSchemaVersion,
    eventId: ID.event,
    projectId: ID.project,
    vaultId: ID.vault,
    storeId: ID.store,
    workspaceId: WORKSPACE,
    streamId: `lifecycle/session/${ID.session}`,
    streamVersion: "13",
    globalPosition: "13",
    sessionId: ID.session,
    parentSessionId: null,
    eventType,
    correlationId: ID.correlation,
    causationId: null,
    commandId: ID.command,
    idempotencyKey: "qualified-contract/test",
    occurredAt: "2026-07-22T00:00:00.000Z",
    authorityCommitment: HASH,
    payload,
  };
}

function checkpointPayload(version: 1 | 2): Record<string, unknown> {
  return {
    checkpoint: checkpoint(version),
    baseEventPosition: "12",
    checkpointEventPosition: "13",
  };
}

function requestPayload(requestVersion: 1 | 2): Record<string, unknown> {
  return {
    workflowId: ID.workflow,
    workflowGeneration: 1,
    previousState: "active",
    childEndPolicy: "require-completed",
    qualityThreshold: 9000,
    requireFullEvidence: false,
    requireMaterialization: true,
    ...(requestVersion === 2 ? { requestVersion: 2 } : {}),
  };
}

function amendmentPayload(amendmentVersion: 1 | 2): Record<string, unknown> {
  return {
    workflowId: ID.workflow,
    previousWorkflowGeneration: 1,
    workflowGeneration: 2,
    preTransitionCheckpointId: ID.checkpoint,
    ...(amendmentVersion === 2
      ? { amendmentVersion: 2, finalCheckpointVersion: 2, evidenceWindowAction: "unchanged" }
      : {}),
  };
}

function evidencePayload(): Record<string, unknown> {
  const {
    latestBatchId: _latestBatchId,
    latestBatchEventPosition: _latestBatchEventPosition,
    ...cumulative
  } = coverageEntry();
  return {
    ...cumulative,
    batchId: ID.batch,
    batchFirstOrdinal: "2",
    batchLastOrdinal: "2",
    captureMode: "coverage-only",
    contentRetained: false,
    frames: [{
      frameId: ID.frame,
      ordinal: "2",
      sourceKind: "model-turn",
      observedAt: "2026-07-22T00:00:00.000Z",
      contentFingerprint: HASH,
    }],
  };
}

function request(requestVersion: 1 | 2): Record<string, unknown> {
  return {
    requestVersion,
    sessionId: ID.session,
    childEndPolicy: "require-completed",
    finalCheckpoint: checkpointContent(requestVersion),
    validationProfileIds: [],
    requestedQualityThreshold: 9000,
    requireFullEvidence: false,
    requireMaterialization: true,
  };
}

function amendment(
  amendmentVersion: 1 | 2,
  action: "unchanged" | "open" | "seal" = "unchanged",
  includeDraft = true,
): Record<string, unknown> {
  return {
    amendmentVersion,
    childEndPolicy: null,
    finalCheckpoint: includeDraft ? checkpointContent(amendmentVersion) : null,
    validationProfileIds: null,
    requestedQualityThreshold: null,
    requireFullEvidence: null,
    requireMaterialization: null,
    ...(amendmentVersion === 2 ? { evidenceWindowAction: action } : {}),
  };
}

function binding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bindingVersion: 1,
    bindingKind: "current-child",
    childSessionId: ID.child,
    childState: "active",
    lastEventPosition: "10",
    streamVersion: "3",
    checkpointId: null,
    checkpointEventPosition: null,
    transferTicketId: null,
    transferTicketEventPosition: null,
    ...overrides,
  };
}

function baseCommand(commandType: string): Record<string, unknown> {
  return {
    commandType,
    commandId: ID.command,
    idempotencyKey: `qualified-contract/${commandType}`,
    agentId: "agent-primary",
    expectedProjectId: ID.project,
    expectedVaultId: ID.vault,
    expectedWorkspaceId: WORKSPACE,
    expectedBranchRef: "refs/heads/test",
  };
}

function expectCode(code: string, action: () => unknown): void {
  assert.throws(action, (error: unknown) => error instanceof LifecycleError && error.code === code);
}

describe("qualified checkpoint contracts", () => {
  it("keeps every Version 1 checkpoint vector byte-for-byte unchanged", () => {
    assert.deepEqual(decodeCheckpointV1(V1_CHECKPOINT_VECTOR), V1_CHECKPOINT_VECTOR);
    assert.deepEqual(decodeCheckpoint(V1_CHECKPOINT_VECTOR), V1_CHECKPOINT_VECTOR);
    assert.equal(referenceCheckpointFingerprint(1, V1_CHECKPOINT_VECTOR), V1_CHECKPOINT_HASH);
  });

  it("strictly decodes qualified Version 2 drafts and checkpoints", () => {
    assert.equal(decodeCheckpointDraft(checkpointContent(2)).checkpointVersion, 2);
    const decoded = decodeCheckpoint(checkpoint(2));
    assert.equal(decoded.checkpointVersion, 2);
    assert.ok(Object.isFrozen(decoded));
    assert.ok(Object.isFrozen(decoded.evidenceCoverage));
    assert.ok(Object.isFrozen(decoded.evidenceCoverage.adapterSessions));
    assert.ok(Object.isFrozen(decoded.evidenceCoverage.adapterSessions[0]?.missingIntervals));
    assert.notEqual(
      referenceCheckpointFingerprint(1, decoded),
      referenceCheckpointFingerprint(2, decoded),
    );
    for (const version of [undefined, null, 0, 3, "2"]) {
      expectCode("LIFECYCLE_INPUT_INVALID", () => decodeCheckpoint({ ...checkpoint(2), checkpointVersion: version }));
    }
  });

  it("requires ordered unique qualified adapters and independent zero-based gaps", () => {
    const ordered = coverage([
      coverageEntry(ID.adapterA),
      { ...coverageEntry(ID.adapterB), coverageLastOrdinal: "1", highestContiguousOrdinal: "1", missingIntervals: [] },
    ]);
    assert.equal((decodeCheckpoint({ ...checkpoint(2), evidenceCoverage: ordered }) as CheckpointV2)
      .evidenceCoverage.adapterSessions.length, 2);
    for (const adapterSessions of [
      [coverageEntry(ID.adapterB), coverageEntry(ID.adapterA)],
      [coverageEntry(ID.adapterA), coverageEntry(ID.adapterA)],
    ]) {
      expectCode("LIFECYCLE_INPUT_INVALID", () => decodeCheckpoint({
        ...checkpoint(2),
        evidenceCoverage: coverage(adapterSessions),
      }));
    }
    expectCode("LIFECYCLE_INPUT_INVALID", () => decodeCheckpoint({
      ...checkpoint(2),
      evidenceCoverage: coverage([{ ...coverageEntry(), coverageFirstOrdinal: "2" }]),
    }));
    assert.equal((decodeCheckpoint({ ...checkpoint(2), evidenceCoverage: coverage([]) }) as CheckpointV2)
      .evidenceCoverage.adapterSessions.length, 0);
  });

  it("requires canonical child-summary ordering in Version 2 checkpoints", () => {
    const first = {
      childSessionId: ID.child,
      state: "active",
      lastEventPosition: "10",
      streamVersion: "3",
      latestCheckpointId: null,
    };
    const second = {
      ...first,
      childSessionId: "00000000-0000-4000-8000-000000000012",
    };
    assert.equal(decodeCheckpoint({ ...checkpoint(2), childSummaries: [first, second] }).childSummaries.length, 2);
    for (const childSummaries of [[second, first], [first, first]]) {
      expectCode("LIFECYCLE_INPUT_INVALID", () => decodeCheckpoint({
        ...checkpoint(2),
        childSummaries,
      }));
    }
    expectCode("LIFECYCLE_INPUT_INVALID", () => decodeCheckpoint({
      ...checkpoint(2),
      evidenceCoverage: coverage([{ ...coverageEntry(), latestBatchEventPosition: "0" }]),
    }));
  });

  it("enforces complete Version 2 coverage and checkpoint byte caps", () => {
    assert.ok(CHECKPOINT_EVIDENCE_COVERAGE_MAX_CANONICAL_BYTES < CHECKPOINT_MAX_CANONICAL_BYTES);
    const unicodeKey = "😀".repeat(128);
    const adapterSessions = Array.from({ length: 200 }, (_, index) => ({
      ...coverageEntry(`00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`),
      frameFingerprintKeyId: unicodeKey,
      coverageFingerprintKeyId: unicodeKey,
    }));
    assert.ok(canonicalUtf8Bytes(coverage(adapterSessions)) > CHECKPOINT_EVIDENCE_COVERAGE_MAX_CANONICAL_BYTES);
    expectCode("EVIDENCE_COVERAGE_SNAPSHOT_TOO_LARGE", () => decodeCheckpoint({
      ...checkpoint(2),
      evidenceCoverage: coverage(adapterSessions),
    }));
  });

  it("accepts exactly the four Version 2 lifecycle event forms", () => {
    const candidates = [
      event(2, "EvidenceCoverageRecorded", evidencePayload()),
      event(2, "SessionCheckpointRecorded", checkpointPayload(2)),
      event(2, "SessionEndRequested", requestPayload(2)),
      event(2, "SessionEndAmended", amendmentPayload(2)),
    ];
    for (const candidate of candidates) {
      assert.doesNotThrow(() => {
        const decoded: LifecycleEventV2 = decodeLifecycleEvent(candidate) as LifecycleEventV2;
        assert.equal(decoded.eventSchemaVersion, 2);
      }, String(candidate.eventType));
    }
  });

  it("rejects every mixed outer and nested lifecycle event version", () => {
    for (const candidate of [
      event(2, "SessionStarted", {}),
      event(2, "SessionCheckpointRecorded", checkpointPayload(1)),
      event(1, "SessionCheckpointRecorded", checkpointPayload(2)),
      event(2, "SessionEndRequested", requestPayload(1)),
      event(1, "SessionEndRequested", requestPayload(2)),
      event(2, "SessionEndAmended", amendmentPayload(1)),
      event(1, "SessionEndAmended", amendmentPayload(2)),
      { ...event(2, "EvidenceCoverageRecorded", evidencePayload()), eventSchemaVersion: 3 },
    ]) expectCode("LIFECYCLE_INPUT_INVALID", () => decodeLifecycleEvent(candidate));
  });

  it("strictly decodes Version 2 end DTOs and Version 3 command variants", () => {
    assert.equal(decodeSessionEndRequest(request(2)).requestVersion, 2);
    const decodedAmendment = decodeSessionEndAmendment(amendment(2, "open"));
    assert.equal(decodedAmendment.amendmentVersion, 2);
    if (decodedAmendment.amendmentVersion !== 2) assert.fail("expected Version 2 amendment");
    assert.equal(decodedAmendment.evidenceWindowAction, "open");
    expectCode("LIFECYCLE_INPUT_INVALID", () => decodeSessionEndAmendment(amendment(2, "open", false)));
    const commands = [
      { ...baseCommand("root-suspend"), sessionId: ID.session, expectedStreamVersion: "3", checkpoint: checkpointContent(2) },
      { ...baseCommand("record-checkpoint"), sessionId: ID.session, expectedStreamVersion: "3", expectedBaseEventPosition: null, draft: checkpointContent(2) },
      { ...baseCommand("request-session-end"), request: request(2) },
      { ...baseCommand("amend-session-end"), sessionId: ID.session, workflowId: ID.workflow, expectedStreamVersion: "3", amendment: amendment(2) },
    ];
    for (const candidate of commands) {
      const decoded: LifecycleSemanticCommandDraft = decodeLifecycleSemanticCommandDraft(candidate);
      assert.equal(decoded.commandType, (candidate as Record<string, unknown>).commandType);
    }
    const compileSurface = null as unknown as InternalWorkflowExecutionPlan;
    assert.equal(compileSurface, null);
  });

  it("strictly decodes deeply frozen canonical final ending-scope bindings", () => {
    const current = binding();
    const carried = binding({
      bindingKind: "carry-forward-ticket",
      childSessionId: "00000000-0000-4000-8000-000000000012",
      childState: "transferred",
      lastEventPosition: "20",
      checkpointId: ID.checkpoint,
      checkpointEventPosition: "18",
      transferTicketId: ID.transfer,
      transferTicketEventPosition: "20",
    });
    const decoded = decodeFinalEndingScopeBindingsV1([current, carried]);
    assert.ok(Object.isFrozen(decoded));
    assert.ok(Object.isFrozen(decoded[0]));
    assert.equal(compareCanonicalUtf8(decoded[0]!.childSessionId, decoded[1]!.childSessionId), -1);
    for (const candidate of [
      [binding({ checkpointId: ID.checkpoint })],
      [binding({ checkpointEventPosition: "10" })],
      [binding({
        lastEventPosition: "10",
        checkpointId: ID.checkpoint,
        checkpointEventPosition: "11",
      })],
      [binding({ transferTicketId: ID.transfer })],
      [carried, current],
      [current, current],
    ]) expectCode("LIFECYCLE_INPUT_INVALID", () => decodeFinalEndingScopeBindingsV1(candidate));
    assert.ok(canonicalUtf8Bytes(decoded) <= FINAL_ENDING_SCOPE_BINDINGS_MAX_CANONICAL_BYTES);
  });

  it("reserves maximum-width unknown strings and nullable future checkpoint pairs", () => {
    assert.equal(unknownJsonStringUpperBound(0), 2);
    assert.equal(unknownJsonStringUpperBound(128), 770);
    const noCheckpoint = [binding()] as unknown as readonly FinalEndingScopeBindingV1[];
    const withCheckpoint: readonly FinalEndingScopeBindingV1[] = [
      binding({ checkpointId: ID.checkpoint, checkpointEventPosition: "1" }) as unknown as FinalEndingScopeBindingV1,
    ];
    assert.equal(
      minimumFinalEndingScopeBindingsUpperBound({ endingScopeBindings: noCheckpoint }),
      minimumFinalEndingScopeBindingsUpperBound({ endingScopeBindings: withCheckpoint }),
    );
  });

  it("rejects limit-plus-one checkpoint and ending-scope capacity", () => {
    const evidenceCoverage = decodeCheckpoint(checkpoint(2)).evidenceCoverage as CheckpointEvidenceCoverageV2;
    const endingScopeBindings = decodeFinalEndingScopeBindingsV1(Array.from(
      { length: 200 },
      (_, index) => binding({
        childSessionId: `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
      }),
    ));
    const checkpointBytes = minimumCheckpointUpperBound({ evidenceCoverage, endingScopeBindings });
    const bindingBytes = minimumFinalEndingScopeBindingsUpperBound({ endingScopeBindings });
    assert.ok(checkpointBytes > canonicalUtf8Bytes(evidenceCoverage));
    assert.ok(bindingBytes >= canonicalUtf8Bytes(endingScopeBindings));
    assert.ok(checkpointBytes <= CHECKPOINT_MAX_CANONICAL_BYTES);
    assert.ok(bindingBytes <= FINAL_ENDING_SCOPE_BINDINGS_MAX_CANONICAL_BYTES);

    const oversizedCoverage = decodeCheckpoint({
      ...checkpoint(2),
      evidenceCoverage: coverage(Array.from({ length: 200 }, (_, index) => ({
        ...coverageEntry(`00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`),
        frameFingerprintKeyId: "😀".repeat(35),
        coverageFingerprintKeyId: "😀".repeat(35),
      }))),
    }).evidenceCoverage as CheckpointEvidenceCoverageV2;
    assert.ok(minimumCheckpointUpperBound({
      evidenceCoverage: oversizedCoverage,
      endingScopeBindings,
    }) > CHECKPOINT_MAX_CANONICAL_BYTES);
  });

  it("exposes all qualified-coverage failures as stable nonretryable actions", () => {
    const expected: Readonly<Record<string, readonly string[]>> = {
      CHECKPOINT_EVIDENCE_VERSION_REQUIRED: ["record-version-2-checkpoint", "amend-or-cancel-session-end"],
      EVIDENCE_ADAPTER_SESSION_LIMIT: ["start-new-lifecycle-session"],
      EVIDENCE_COVERAGE_SNAPSHOT_TOO_LARGE: ["start-new-lifecycle-session"],
      EVIDENCE_HISTORICAL_KEY_UNAVAILABLE: ["restore-evidence-fingerprint-key"],
      CHECKPOINT_CAPACITY_EXCEEDED: ["reduce-checkpoint-draft", "resolve-active-children", "start-new-lifecycle-session"],
      SESSION_END_EVIDENCE_FROZEN: ["amend-or-cancel-session-end"],
      SESSION_END_EVIDENCE_WINDOW_OPEN: ["seal-session-end-evidence"],
      SESSION_END_COVERAGE_CHANGED: ["record-version-2-checkpoint", "amend-or-cancel-session-end"],
    };
    for (const [code, actions] of Object.entries(expected)) {
      assert.ok(LIFECYCLE_ERROR_CODES.includes(code as LifecycleErrorCode));
      const error = new LifecycleError(code as LifecycleErrorCode);
      assert.equal(error.retryable, false);
      assert.deepEqual(error.recoveryActions, actions);
    }
  });
});
