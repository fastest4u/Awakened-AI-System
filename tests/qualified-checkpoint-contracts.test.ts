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
  referenceMinimumCheckpointUpperBound,
  referenceMinimumFinalEndingScopeBindingsUpperBound,
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

function jsonStringWithContentBytes(contentBytes: number, maximumScalars: number): string {
  for (let escapedScalars = 0; escapedScalars <= maximumScalars; escapedScalars += 1) {
    const scalarCount = contentBytes - (5 * escapedScalars);
    if (
      scalarCount >= escapedScalars
      && scalarCount >= 1
      && scalarCount <= maximumScalars
    ) {
      return `${"\0".repeat(escapedScalars)}${"x".repeat(scalarCount - escapedScalars)}`;
    }
  }
  throw new Error(`cannot encode ${contentBytes} JSON string-content bytes`);
}

function exactCoverageBytes(targetBytes: number): Record<string, unknown> {
  const adapterSessions = Array.from({ length: 200 }, (_, index) => ({
    ...coverageEntry(`00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`),
    frameFingerprintKeyId: "k",
    coverageFingerprintKeyId: "k",
    latestBatchEventPosition: "1",
  }));
  const candidate = coverage(adapterSessions);
  let remaining = targetBytes - canonicalUtf8Bytes(candidate);
  if (remaining < 0) throw new Error("coverage target is below the canonical base");
  if (remaining % 2 === 1) {
    adapterSessions[0] = { ...adapterSessions[0], latestBatchEventPosition: "10" };
    remaining -= 1;
  }
  for (let index = 0; index < adapterSessions.length && remaining > 0; index += 1) {
    let selected = "k";
    let selectedIncrement = 0;
    for (let contentBytes = 1; contentBytes <= 768; contentBytes += 1) {
      let value: string;
      try {
        value = jsonStringWithContentBytes(contentBytes, 128);
      } catch {
        continue;
      }
      const increment = 2 * (contentBytes - 1);
      if (increment <= remaining && increment >= selectedIncrement) {
        selected = value;
        selectedIncrement = increment;
      }
    }
    adapterSessions[index] = {
      ...adapterSessions[index],
      frameFingerprintKeyId: selected,
      coverageFingerprintKeyId: selected,
    };
    remaining -= selectedIncrement;
  }
  if (remaining !== 0 || canonicalUtf8Bytes(candidate) !== targetBytes) {
    throw new Error(`unable to synthesize exact ${targetBytes}-byte coverage`);
  }
  return candidate;
}

function exactCheckpointBytes(targetBytes: number): Record<string, unknown> {
  const completedItems: Record<string, unknown>[] = [];
  const candidate = {
    ...checkpoint(2),
    baseEventPosition: "9223372036854775807",
    checkpointEventPosition: "9223372036854775807",
    completedItems,
    evidenceCoverage: coverage([]),
  };
  while (canonicalUtf8Bytes(candidate) < targetBytes) {
    const withEmpty = {
      ...candidate,
      completedItems: [...completedItems, { summary: "", confidence: "high" }],
    };
    const requiredContentBytes = targetBytes - canonicalUtf8Bytes(withEmpty);
    if (requiredContentBytes <= 24_000) {
      completedItems.push({
        summary: jsonStringWithContentBytes(requiredContentBytes, 4_000),
        confidence: "high",
      });
      break;
    }
    completedItems.push({ summary: "\0".repeat(4_000), confidence: "high" });
  }
  if (canonicalUtf8Bytes(candidate) !== targetBytes) {
    throw new Error(`unable to synthesize exact ${targetBytes}-byte checkpoint`);
  }
  return candidate;
}

function decimalWithLength(length: number): string {
  return `1${"0".repeat(length - 1)}`;
}

function exactEndingScopeBindingBytes(targetBytes: number): readonly Record<string, unknown>[] {
  const bindings: Record<string, unknown>[] = [];
  let currentBytes = 2;
  while (true) {
    const next = binding({
      childSessionId: `00000000-0000-4000-8000-${(bindings.length + 1).toString(16).padStart(12, "0")}`,
      lastEventPosition: "1",
      streamVersion: "1",
    });
    const nextBytes = canonicalUtf8Bytes(next) + (bindings.length === 0 ? 0 : 1);
    if (currentBytes + nextBytes > targetBytes) break;
    bindings.push(next);
    currentBytes += nextBytes;
  }
  let remaining = targetBytes - currentBytes;
  for (let index = 0; index < bindings.length && remaining > 0; index += 1) {
    for (const field of ["lastEventPosition", "streamVersion"] as const) {
      const increment = Math.min(18, remaining);
      bindings[index] = {
        ...bindings[index],
        [field]: decimalWithLength(1 + increment),
      };
      remaining -= increment;
      if (remaining === 0) break;
    }
  }
  if (remaining !== 0 || canonicalUtf8Bytes(bindings) !== targetBytes) {
    throw new Error(`unable to synthesize exact ${targetBytes}-byte ending scope`);
  }
  return bindings;
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

  it("enforces the exact qualified-coverage canonical byte boundary", () => {
    assert.ok(CHECKPOINT_EVIDENCE_COVERAGE_MAX_CANONICAL_BYTES < CHECKPOINT_MAX_CANONICAL_BYTES);
    const exact = exactCoverageBytes(CHECKPOINT_EVIDENCE_COVERAGE_MAX_CANONICAL_BYTES);
    const limitPlusOne = exactCoverageBytes(CHECKPOINT_EVIDENCE_COVERAGE_MAX_CANONICAL_BYTES + 1);
    assert.equal(canonicalUtf8Bytes(exact), 196_608);
    assert.equal(canonicalUtf8Bytes(limitPlusOne), 196_609);
    assert.equal(decodeCheckpoint({
      ...checkpoint(2),
      baseEventPosition: "9223372036854775807",
      checkpointEventPosition: "9223372036854775807",
      evidenceCoverage: exact,
    }).checkpointVersion, 2);
    expectCode("EVIDENCE_COVERAGE_SNAPSHOT_TOO_LARGE", () => decodeCheckpoint({
      ...checkpoint(2),
      baseEventPosition: "9223372036854775807",
      checkpointEventPosition: "9223372036854775807",
      evidenceCoverage: limitPlusOne,
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

  it("rejects every frame-batch intersection with a missing interval while allowing adjacency", () => {
    const rangedPayload = {
      ...evidencePayload(),
      batchLastOrdinal: "4",
      coverageLastOrdinal: "6",
      frames: [2, 3, 4].map((ordinal) => ({
        frameId: `00000000-0000-4000-8000-${(ordinal + 0x50).toString(16).padStart(12, "0")}`,
        ordinal: String(ordinal),
        sourceKind: "model-turn",
        observedAt: "2026-07-22T00:00:00.000Z",
        contentFingerprint: HASH,
      })),
    };
    for (const [highestContiguousOrdinal, missingIntervals] of [
      [null, [{ firstOrdinal: "0", lastOrdinal: "2" }]],
      ["2", [{ firstOrdinal: "3", lastOrdinal: "3" }]],
      ["3", [{ firstOrdinal: "4", lastOrdinal: "6" }]],
      [null, [{ firstOrdinal: "0", lastOrdinal: "6" }]],
    ] as const) {
      expectCode("LIFECYCLE_INPUT_INVALID", () => decodeLifecycleEvent(event(
        2,
        "EvidenceCoverageRecorded",
        { ...rangedPayload, highestContiguousOrdinal, missingIntervals },
      )));
    }
    for (const [highestContiguousOrdinal, missingIntervals] of [
      [null, [{ firstOrdinal: "0", lastOrdinal: "1" }]],
      ["4", [{ firstOrdinal: "5", lastOrdinal: "6" }]],
    ] as const) {
      assert.doesNotThrow(() => decodeLifecycleEvent(event(
        2,
        "EvidenceCoverageRecorded",
        { ...rangedPayload, highestContiguousOrdinal, missingIntervals },
      )));
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

  it("rejects impossible ending-scope cardinality before proportional or indexed work", () => {
    const sparse: unknown[] = [];
    sparse.length = 1_000_000_000;
    let ownKeysCalls = 0;
    let indexedReads = 0;
    const hostile = new Proxy(sparse, {
      ownKeys(): never {
        ownKeysCalls += 1;
        throw new Error("proportional exact-array validation reached");
      },
      get(target, property, receiver) {
        if (typeof property === "string" && /^(?:0|[1-9][0-9]*)$/u.test(property)) indexedReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    expectCode("LIFECYCLE_INPUT_INVALID", () => decodeFinalEndingScopeBindingsV1(hostile));
    assert.equal(ownKeysCalls, 0);
    assert.equal(indexedReads, 0);
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
    const exactCheckpoint = exactCheckpointBytes(CHECKPOINT_MAX_CANONICAL_BYTES);
    const checkpointLimitPlusOne = exactCheckpointBytes(CHECKPOINT_MAX_CANONICAL_BYTES + 1);
    assert.equal(canonicalUtf8Bytes(exactCheckpoint), 262_144);
    assert.equal(canonicalUtf8Bytes(checkpointLimitPlusOne), 262_145);
    assert.equal(decodeCheckpoint(exactCheckpoint).checkpointVersion, 2);
    expectCode("CHECKPOINT_CAPACITY_EXCEEDED", () => decodeCheckpoint(checkpointLimitPlusOne));

    const exactBindings = exactEndingScopeBindingBytes(FINAL_ENDING_SCOPE_BINDINGS_MAX_CANONICAL_BYTES);
    const bindingLimitPlusOne = exactEndingScopeBindingBytes(
      FINAL_ENDING_SCOPE_BINDINGS_MAX_CANONICAL_BYTES + 1,
    );
    assert.equal(canonicalUtf8Bytes(exactBindings), 262_144);
    assert.equal(canonicalUtf8Bytes(bindingLimitPlusOne), 262_145);
    assert.equal(decodeFinalEndingScopeBindingsV1(exactBindings).length, exactBindings.length);
    expectCode("LIFECYCLE_INPUT_INVALID", () => decodeFinalEndingScopeBindingsV1(bindingLimitPlusOne));

    const estimatorBindings = decodeFinalEndingScopeBindingsV1(Array.from(
      { length: 220 },
      (_, index) => binding({
        childSessionId: `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
      }),
    ));
    const emptyCoverage = decodeCheckpoint({
      ...checkpoint(2),
      evidenceCoverage: coverage([]),
    }).evidenceCoverage as CheckpointEvidenceCoverageV2;
    const estimatorOverhead = referenceMinimumCheckpointUpperBound(
      emptyCoverage,
      estimatorBindings,
    ) - canonicalUtf8Bytes(emptyCoverage);
    const exactEstimatorCoverage = decodeCheckpoint({
      ...checkpoint(2),
      baseEventPosition: "9223372036854775807",
      checkpointEventPosition: "9223372036854775807",
      evidenceCoverage: exactCoverageBytes(CHECKPOINT_MAX_CANONICAL_BYTES - estimatorOverhead),
    }).evidenceCoverage as CheckpointEvidenceCoverageV2;
    const plusOneEstimatorCoverage = decodeCheckpoint({
      ...checkpoint(2),
      baseEventPosition: "9223372036854775807",
      checkpointEventPosition: "9223372036854775807",
      evidenceCoverage: exactCoverageBytes(CHECKPOINT_MAX_CANONICAL_BYTES + 1 - estimatorOverhead),
    }).evidenceCoverage as CheckpointEvidenceCoverageV2;
    const exactReferenceBytes = referenceMinimumCheckpointUpperBound(
      exactEstimatorCoverage,
      estimatorBindings,
    );
    const plusOneReferenceBytes = referenceMinimumCheckpointUpperBound(
      plusOneEstimatorCoverage,
      estimatorBindings,
    );
    assert.equal(exactReferenceBytes, CHECKPOINT_MAX_CANONICAL_BYTES);
    assert.equal(plusOneReferenceBytes, CHECKPOINT_MAX_CANONICAL_BYTES + 1);
    assert.equal(minimumCheckpointUpperBound({
      evidenceCoverage: exactEstimatorCoverage,
      endingScopeBindings: estimatorBindings,
    }), exactReferenceBytes);
    assert.equal(minimumCheckpointUpperBound({
      evidenceCoverage: plusOneEstimatorCoverage,
      endingScopeBindings: estimatorBindings,
    }), plusOneReferenceBytes);
    const decodedExactBindings = decodeFinalEndingScopeBindingsV1(exactBindings);
    const finalBindingReferenceBytes = referenceMinimumFinalEndingScopeBindingsUpperBound(
      decodedExactBindings,
    );
    assert.equal(minimumFinalEndingScopeBindingsUpperBound({
      endingScopeBindings: decodedExactBindings,
    }), finalBindingReferenceBytes);
    assert.ok(finalBindingReferenceBytes > FINAL_ENDING_SCOPE_BINDINGS_MAX_CANONICAL_BYTES);
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
