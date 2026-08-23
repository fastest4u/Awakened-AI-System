import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { JsonValue, StoredEvent } from "../src/orchestrator/contracts/event.js";
import type {
  BranchScopeId,
  ProjectId,
  StoreId,
  VaultId,
  WorkspaceId,
} from "../src/orchestrator/identity/contracts.js";
import { payloadHash as eventPayloadHash } from "../src/orchestrator/crypto/event-hash.js";
import { PROJECTION_SOURCE_AUTHORITY_V1 } from "../src/orchestrator/projections/contracts.js";
import {
  decodeProjectionEvent,
  validateProjectionEvent,
} from "../src/orchestrator/projections/source-event-codec.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";

const PROJECT_ID = "1".repeat(64) as ProjectId;
const VAULT_ID = "2".repeat(64) as VaultId;
const STORE_ID = "3".repeat(64) as StoreId;
const WORKSPACE_ID = "4".repeat(64) as WorkspaceId;
const BRANCH_SCOPE_ID = "00000000-0000-4000-8000-000000000041" as BranchScopeId;
const SESSION_ID = "00000000-0000-4000-8000-000000000042";
const CHECKPOINT_ID = "00000000-0000-4000-8000-000000000043";
const ITEM_ID = "00000000-0000-4000-8000-000000000044";
const FEEDBACK_ID = "00000000-0000-4000-8000-000000000045";
const BRANCH_REF = "refs/heads/projection-contracts";
const OCCURRED_AT = "2026-08-23T01:00:00.000Z";
const RECORDED_AT = "2026-08-23T01:00:01.000Z";

function binding(sessionId: string | null = SESSION_ID) {
  return {
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    branchScopeId: BRANCH_SCOPE_ID,
    branchRef: BRANCH_REF,
    sessionId,
  };
}

function storedEvent(
  eventType: string,
  payload: JsonValue,
  overrides: Partial<StoredEvent> = {},
): StoredEvent {
  return {
    globalPosition: 42n,
    eventId: "00000000-0000-4000-8000-000000000046",
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    branchScopeId: BRANCH_SCOPE_ID,
    branchRef: BRANCH_REF,
    streamId: `session/${SESSION_ID}`,
    streamType: "session",
    streamVersion: 2n,
    eventType,
    eventSchemaVersion: 1,
    sessionId: SESSION_ID,
    parentSessionId: null,
    actorRole: "primary",
    agentId: "projection-test-agent",
    clientInstanceId: "projection-test-client",
    correlationId: "00000000-0000-4000-8000-000000000047",
    causationId: null,
    commandId: "00000000-0000-4000-8000-000000000048",
    idempotencyKey: "projection-test/42",
    commandEventIndex: 0,
    occurredAt: OCCURRED_AT,
    recordedAt: RECORDED_AT,
    visibilityScope: "session",
    confidence: "high",
    verificationStatus: "verified",
    sourceRefs: [],
    evidenceRefs: [],
    evidenceDigests: [],
    payload,
    payloadJson: canonicalJson(payload),
    payloadHash: eventPayloadHash(payload),
    previousGlobalHash: "6".repeat(64),
    eventHash: "7".repeat(64),
    lifecycleIntentJson: null,
    ...overrides,
  };
}

function checkpointPayload(): JsonValue {
  return {
    checkpoint: {
      checkpointVersion: 1,
      checkpointId: CHECKPOINT_ID,
      sessionId: SESSION_ID,
      parentSessionId: null,
      baseEventPosition: "41",
      checkpointEventPosition: "42",
      createdAt: OCCURRED_AT,
      creatorAgentId: "projection-test-agent",
      creatorClientInstanceId: "projection-test-client",
      taskSummary: "Define deterministic projection contracts.",
      completedItems: [],
      inProgressItems: [{ summary: "Validate strict source decoding.", confidence: "high" }],
      blockers: [],
      nextActions: [{ summary: "Build an immutable generation.", confidence: "high" }],
      decisions: [],
      assumptions: [],
      unresolvedConflicts: [],
      filesTouched: [{
        path: "src/orchestrator/projections/contracts.ts",
        action: "created",
        contentHash: "8".repeat(64),
        branchRef: BRANCH_REF,
        confidence: "high",
      }],
      artifactReferences: [],
      sourceReferences: [],
      commandResults: [],
      testResults: [],
      materialClaims: [],
      sourceState: {
        sourceStateScopeVersion: 1,
        workspaceId: WORKSPACE_ID,
        branchRef: BRANCH_REF,
        headCommit: "9".repeat(40),
        dirtyWorktreeFingerprint: "a".repeat(64),
      },
      childSummaries: [],
      evidenceCoverage: {
        captureMode: "coverage-only",
        contentRetained: false,
        highestContiguousOrdinal: null,
        missingIntervals: [],
      },
    },
    baseEventPosition: "41",
    checkpointEventPosition: "42",
  };
}

function memoryPayload(overrides: Record<string, unknown> = {}): JsonValue {
  return {
    sourceVersion: 1,
    binding: binding(),
    itemId: ITEM_ID,
    normalizedKey: "decision:projection-boundary",
    status: "provisional",
    confidence: "high",
    verificationMethod: "checkpoint",
    validFrom: OCCURRED_AT,
    validTo: null,
    summary: "Projection publication follows the authoritative event commit.",
    contentHash: "b".repeat(64),
    ...overrides,
  } as JsonValue;
}

function feedbackPayload(): JsonValue {
  return {
    feedbackVersion: 1,
    binding: binding(),
    feedbackId: FEEDBACK_ID,
    itemId: ITEM_ID,
    outcome: "accepted",
    usefulness: 10_000,
    sourceItemEventPosition: "42",
  };
}

describe("projection source event codec", () => {
  it("decodes a strict lifecycle checkpoint into only the allowed projection fields", () => {
    const decoded = decodeProjectionEvent(storedEvent("SessionCheckpointRecorded", checkpointPayload()));
    assert.equal(decoded.kind, "projected");
    if (decoded.kind !== "projected") return;
    assert.equal(decoded.event.kind, "checkpoint");
    assert.equal(decoded.event.sourceEventPosition, 42n);
    assert.deepEqual(decoded.event.binding, binding());
    assert.equal("payload" in decoded.event, false);
    assert.equal("commandResults" in decoded.event, false);
    assert.equal("evidenceCoverage" in decoded.event, false);
  });

  it("reports an unknown type as intentionally unprojected without guessing its payload", () => {
    const unknown = decodeProjectionEvent(storedEvent("UnrecognizedV99", { future: true }));
    assert.deepEqual(unknown, {
      kind: "unprojected",
      eventPosition: 42n,
      eventType: "UnrecognizedV99",
    });
  });

  it("does not inspect accessor, cyclic, or oversized payload content for an unknown type", () => {
    let invoked = false;
    const accessorPayload: Record<string, unknown> = {};
    Object.defineProperty(accessorPayload, "future", {
      enumerable: true,
      get() {
        invoked = true;
        throw new Error("unknown payload accessor executed");
      },
    });
    const cyclicPayload: Record<string, unknown> = {};
    cyclicPayload.self = cyclicPayload;
    const oversizedPayload = { future: "x".repeat(300 * 1_024) };

    for (const [payload, payloadJson] of [
      [accessorPayload, "{}"],
      [cyclicPayload, "{}"],
      [oversizedPayload, "x".repeat(300 * 1_024)],
    ] as const) {
      const unknown = storedEvent("UnrecognizedV99", {}, {
        payload: payload as JsonValue,
        payloadJson,
      });
      assert.deepEqual(decodeProjectionEvent(unknown), {
        kind: "unprojected",
        eventPosition: 42n,
        eventType: "UnrecognizedV99",
      });
    }
    assert.equal(invoked, false);
  });

  it("bounds known in-memory payload traversal before canonical comparison", () => {
    let traversedNodes = 0;
    let deepPayload: Record<string, unknown> = {};
    for (let depth = 0; depth < 2_000; depth += 1) {
      deepPayload = new Proxy({ next: deepPayload }, {
        ownKeys(target) {
          traversedNodes += 1;
          return Reflect.ownKeys(target);
        },
      });
    }
    const deep = storedEvent("MemorySourceRecorded", memoryPayload(), {
      payload: deepPayload as JsonValue,
      payloadJson: "{}",
    });
    const oversized = storedEvent("MemorySourceRecorded", memoryPayload(), {
      payload: { summary: "x".repeat(300 * 1_024) },
      payloadJson: "{}",
    });

    for (const malformed of [deep, oversized]) {
      assert.throws(
        () => decodeProjectionEvent(malformed),
        (error: unknown) => error instanceof Error && error.message === "INTEGRITY_FAILURE",
      );
    }
    assert.ok(traversedNodes <= 256, `traversed ${traversedNodes} payload nodes`);
  });

  it("does not enumerate a very-wide in-memory payload beyond the declared node ceiling", () => {
    const widePayload: Record<string, unknown> = {};
    for (let index = 0; index <= 256 * 1_024; index += 1) {
      widePayload[`key-${index}`] = index;
    }
    let ownKeysInvoked = false;
    const measuredPayload = new Proxy(widePayload, {
      ownKeys(target) {
        ownKeysInvoked = true;
        return Reflect.ownKeys(target);
      },
    });
    const malformed = storedEvent("MemorySourceRecorded", memoryPayload(), {
      payload: measuredPayload as JsonValue,
      payloadJson: "{}",
    });

    assert.throws(() => decodeProjectionEvent(malformed), /INTEGRITY_FAILURE/u);
    assert.equal(ownKeysInvoked, false);
  });

  it("uses authenticated canonical bytes instead of a mismatched or accessor-bearing payload cache", () => {
    assert.deepEqual(PROJECTION_SOURCE_AUTHORITY_V1, {
      canonicalPayloadField: "payloadJson",
      payloadHashField: "payloadHash",
      inMemoryPayloadRole: "non-authoritative-cache",
    });
    const authoritativePayload = memoryPayload();
    const authoritativeJson = canonicalJson(authoritativePayload);
    const authoritativeHash = eventPayloadHash(authoritativePayload);
    let invoked = false;
    const accessorCache: Record<string, unknown> = {};
    Object.defineProperty(accessorCache, "summary", {
      enumerable: true,
      get() {
        invoked = true;
        throw new Error("payload cache accessor executed");
      },
    });
    const caches = [
      memoryPayload({ summary: "This cache value is not authoritative." }),
      accessorCache as JsonValue,
    ];

    for (const payload of caches) {
      const decoded = decodeProjectionEvent(storedEvent("MemorySourceRecorded", authoritativePayload, {
        payload,
        payloadJson: authoritativeJson,
        payloadHash: authoritativeHash,
      }));
      assert.equal(decoded.kind, "projected");
      if (decoded.kind !== "projected" || decoded.event.kind !== "memory-source") continue;
      assert.equal(
        decoded.event.summary,
        "Projection publication follows the authoritative event commit.",
      );
    }
    assert.equal(invoked, false);
  });

  it("rejects canonical known payload bytes that do not match the stored payload hash", () => {
    assert.throws(
      () => decodeProjectionEvent(storedEvent("MemorySourceRecorded", memoryPayload(), {
        payloadHash: "f".repeat(64),
      })),
      /INTEGRITY_FAILURE/u,
    );
  });

  it("decodes governed memory and feedback sources with the complete private binding", () => {
    const source = decodeProjectionEvent(storedEvent("MemorySourceRecorded", memoryPayload()));
    assert.equal(source.kind, "projected");
    if (source.kind !== "projected") return;
    assert.equal(source.event.kind, "memory-source");
    assert.deepEqual(source.event.binding, binding());

    const feedbackEvent = storedEvent("RetrievalFeedbackRecorded", feedbackPayload(), {
      globalPosition: 43n,
      payloadJson: canonicalJson(feedbackPayload()),
    });
    const feedback = decodeProjectionEvent(feedbackEvent);
    assert.equal(feedback.kind, "projected");
    if (feedback.kind !== "projected") return;
    assert.equal(feedback.event.kind, "retrieval-feedback");
    assert.deepEqual(feedback.event.binding, binding());
  });

  it("rejects known future versions, malformed canonical payloads, and invalid positions or time", () => {
    assert.throws(
      () => decodeProjectionEvent(storedEvent("MemorySourceRecorded", memoryPayload(), {
        eventSchemaVersion: 2,
      })),
      /INTEGRITY_FAILURE/u,
    );
    assert.throws(
      () => decodeProjectionEvent(storedEvent("MemorySourceRecorded", memoryPayload(), {
        payloadJson: `${canonicalJson(memoryPayload())} `,
      })),
      /INTEGRITY_FAILURE/u,
    );
    assert.throws(
      () => decodeProjectionEvent(storedEvent("MemorySourceRecorded", memoryPayload(), {
        globalPosition: 0n,
      })),
      /INTEGRITY_FAILURE/u,
    );
    assert.throws(
      () => decodeProjectionEvent(storedEvent("MemorySourceRecorded", memoryPayload(), {
        occurredAt: "2026-08-23",
      })),
      /INTEGRITY_FAILURE/u,
    );
  });

  it("rejects non-normalized keys, invalid intervals, and a payload bound to another project", () => {
    assert.throws(
      () => decodeProjectionEvent(storedEvent(
        "MemorySourceRecorded",
        memoryPayload({ normalizedKey: " Decision:Projection-Boundary " }),
      )),
      /INTEGRITY_FAILURE/u,
    );
    assert.throws(
      () => decodeProjectionEvent(storedEvent(
        "MemorySourceRecorded",
        memoryPayload({ validTo: OCCURRED_AT }),
      )),
      /INTEGRITY_FAILURE/u,
    );
    assert.throws(
      () => decodeProjectionEvent(storedEvent("MemorySourceRecorded", memoryPayload({
        binding: { ...binding(), projectId: "f".repeat(64) },
      }))),
      /INTEGRITY_FAILURE/u,
    );
  });

  it("rejects prototype and accessor input without invoking accessors", () => {
    const pollutedPayload = Object.assign(Object.create({ inherited: true }), memoryPayload());
    const polluted = storedEvent("MemorySourceRecorded", memoryPayload(), {
      payload: pollutedPayload,
      payloadJson: canonicalJson(memoryPayload()),
    });
    assert.throws(() => decodeProjectionEvent(polluted), /INTEGRITY_FAILURE/u);

    let invoked = false;
    const accessor = storedEvent("MemorySourceRecorded", memoryPayload()) as unknown as Record<string, unknown>;
    Object.defineProperty(accessor, "eventType", {
      enumerable: true,
      get() {
        invoked = true;
        throw new Error("accessor executed");
      },
    });
    assert.throws(
      () => decodeProjectionEvent(accessor as unknown as StoredEvent),
      /INTEGRITY_FAILURE/u,
    );
    assert.equal(invoked, false);
  });

  it("requires exact ordinal sequences for each checkpoint-derived identity", () => {
    const decoded = decodeProjectionEvent(storedEvent("SessionCheckpointRecorded", checkpointPayload()));
    assert.equal(decoded.kind, "projected");
    if (decoded.kind !== "projected" || decoded.event.kind !== "checkpoint") return;
    const checkpoint = decoded.event;
    const firstWork = checkpoint.workItems[0];
    const firstFile = checkpoint.files[0];
    assert.ok(firstWork);
    assert.ok(firstFile);

    assert.throws(
      () => validateProjectionEvent({
        ...checkpoint,
        workItems: [firstWork, { ...firstWork, summary: "Duplicate derived work identity." }],
      }),
      /INTEGRITY_FAILURE/u,
    );
    assert.throws(
      () => validateProjectionEvent({
        ...checkpoint,
        files: [firstFile, { ...firstFile, path: "src/orchestrator/projections/folds.ts" }],
      }),
      /INTEGRITY_FAILURE/u,
    );
    const artifact = {
      ordinal: 0,
      artifactId: "00000000-0000-4000-8000-000000000049",
      path: "projection-manifest.json",
      summary: "Immutable projection manifest.",
      contentHash: "c".repeat(64),
      confidence: "high" as const,
    };
    assert.throws(
      () => validateProjectionEvent({
        ...checkpoint,
        artifacts: [artifact, {
          ...artifact,
          artifactId: "00000000-0000-4000-8000-000000000050",
        }],
      }),
      /INTEGRITY_FAILURE/u,
    );
  });
});
