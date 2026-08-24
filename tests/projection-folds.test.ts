import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  CheckpointProjectionEvent,
  GovernedMemorySourceProjectionEvent,
  MemorySourceProjectionEvent,
  ProjectBinding,
  ProjectionEvent,
  RetrievalFeedbackProjectionEvent,
  SessionLifecycleProjectionEvent,
} from "../src/orchestrator/projections/contracts.js";
import {
  emptyProjectionFoldState,
  foldProjectionEvent,
  ProjectionFoldAccumulator,
} from "../src/orchestrator/projections/folds.js";

const BINDING: ProjectBinding = Object.freeze({
  projectId: "1".repeat(64) as ProjectBinding["projectId"],
  vaultId: "2".repeat(64) as ProjectBinding["vaultId"],
  storeId: "3".repeat(64) as ProjectBinding["storeId"],
  workspaceId: "4".repeat(64) as ProjectBinding["workspaceId"],
  branchScopeId: "00000000-0000-4000-8000-000000000041" as ProjectBinding["branchScopeId"],
  branchRef: "refs/heads/projection-contracts",
  sessionId: "00000000-0000-4000-8000-000000000042",
});
const ITEM_ID = "00000000-0000-4000-8000-000000000044";
const EVENT_ID = "00000000-0000-4000-8000-000000000046";
const OCCURRED_AT = "2026-08-23T01:00:00.000Z";
const RECORDED_AT = "2026-08-23T01:00:01.000Z";
const ROOT_ID = "00000000-0000-4000-8000-000000000060";
const CHILD_ID = "00000000-0000-4000-8000-000000000061";
const GRANDCHILD_ID = "00000000-0000-4000-8000-000000000074";
const ENTITY_A = "00000000-0000-4000-8000-000000000062";
const ENTITY_B = "00000000-0000-4000-8000-000000000063";

function memoryEvent(
  position: bigint,
  overrides: Partial<MemorySourceProjectionEvent> = {},
): MemorySourceProjectionEvent {
  return Object.freeze({
    kind: "memory-source",
    sourceEventId: EVENT_ID,
    sourceEventPosition: position,
    sourceStreamVersion: position,
    sourceEventSchemaVersion: 1,
    occurredAt: OCCURRED_AT,
    recordedAt: RECORDED_AT,
    binding: BINDING,
    itemId: ITEM_ID,
    normalizedKey: "decision:projection-boundary",
    status: "provisional",
    confidence: "high",
    verificationMethod: "checkpoint",
    validFrom: OCCURRED_AT,
    validTo: null,
    summary: "Projection publication follows the authoritative event commit.",
    contentHash: "b".repeat(64),
    conflictGroupId: null,
    supersedingItemId: null,
    ...overrides,
  });
}

function feedbackEvent(
  position: bigint,
  sourceItemEventPosition: bigint,
): RetrievalFeedbackProjectionEvent {
  return Object.freeze({
    kind: "retrieval-feedback",
    sourceEventId: "00000000-0000-4000-8000-000000000047",
    sourceEventPosition: position,
    sourceStreamVersion: position,
    sourceEventSchemaVersion: 1,
    occurredAt: OCCURRED_AT,
    recordedAt: RECORDED_AT,
    binding: BINDING,
    feedbackId: "00000000-0000-4000-8000-000000000045",
    itemId: ITEM_ID,
    outcome: "accepted",
    usefulness: 10_000,
    sourceItemEventPosition,
  });
}

function nextItem(position: bigint): MemorySourceProjectionEvent {
  return memoryEvent(position, {
    sourceEventId: "00000000-0000-4000-8000-000000000048",
    itemId: "00000000-0000-4000-8000-000000000049",
    normalizedKey: "decision:another-item",
  });
}

function lifecycleEvent(
  position: bigint,
  sessionId: string,
  eventType: SessionLifecycleProjectionEvent["eventType"],
  overrides: Partial<SessionLifecycleProjectionEvent> = {},
): SessionLifecycleProjectionEvent {
  return Object.freeze({
    kind: "session-lifecycle",
    sourceEventId: `00000000-0000-4000-9000-${position.toString().padStart(12, "0")}`,
    sourceEventPosition: position,
    sourceStreamVersion: eventType === "SessionStarted" || eventType === "SessionForked" ? 1n : position,
    sourceEventSchemaVersion: 1,
    occurredAt: OCCURRED_AT,
    recordedAt: RECORDED_AT,
    binding: Object.freeze({ ...BINDING, sessionId }),
    sessionId,
    parentSessionId: null,
    eventType,
    ownerGeneration: eventType === "SessionStarted" ? 1 : null,
    previousOwnerGeneration: null,
    ...overrides,
  });
}

function checkpointEvent(
  position: bigint,
  baseEventPosition: bigint,
  sourceStreamVersion = 2n,
): CheckpointProjectionEvent {
  return Object.freeze({
    kind: "checkpoint",
    sourceEventId: `00000000-0000-4000-a000-${position.toString().padStart(12, "0")}`,
    sourceEventPosition: position,
    sourceStreamVersion,
    sourceEventSchemaVersion: 1,
    occurredAt: OCCURRED_AT,
    recordedAt: RECORDED_AT,
    binding: Object.freeze({ ...BINDING, sessionId: CHILD_ID }),
    checkpointId: `00000000-0000-4000-b000-${position.toString().padStart(12, "0")}`,
    checkpointVersion: 1,
    baseEventPosition,
    taskSummary: `Checkpoint ${position}`,
    workItems: Object.freeze([]),
    files: Object.freeze([]),
    artifacts: Object.freeze([]),
  });
}

function governedEvent(
  position: bigint,
  overrides: Partial<GovernedMemorySourceProjectionEvent> = {},
): GovernedMemorySourceProjectionEvent {
  return Object.freeze({
    kind: "governed-memory-source",
    sourceEventId: `00000000-0000-4000-b000-${position.toString().padStart(12, "0")}`,
    sourceEventPosition: position,
    sourceStreamVersion: position,
    sourceEventSchemaVersion: 3,
    occurredAt: OCCURRED_AT,
    recordedAt: RECORDED_AT,
    binding: BINDING,
    item: Object.freeze({
      itemId: ITEM_ID,
      normalizedKey: "decision:projection-boundary",
      status: "verified",
      confidence: "high",
      verificationMethod: "governed-source",
      validFrom: OCCURRED_AT,
      validTo: null,
      summary: "Structured source data is explicit.",
      contentHash: "b".repeat(64),
      conflictGroupId: null,
      supersedingItemId: null,
      anchor: null,
    }),
    followUps: Object.freeze([
      Object.freeze({
        followUpId: "00000000-0000-4000-8000-000000000064",
        status: "open",
        summary: "Open",
        confidence: "high",
        anchor: "memory/follow-ups#open",
      }),
      Object.freeze({
        followUpId: "00000000-0000-4000-8000-000000000065",
        status: "blocked",
        summary: "Blocked",
        confidence: "high",
        anchor: null,
      }),
      Object.freeze({
        followUpId: "00000000-0000-4000-8000-000000000066",
        status: "completed",
        summary: "Completed",
        confidence: "high",
        anchor: null,
      }),
      Object.freeze({
        followUpId: "00000000-0000-4000-8000-000000000067",
        status: "carried-forward",
        summary: "Carried forward",
        confidence: "high",
        anchor: null,
      }),
      Object.freeze({
        followUpId: "00000000-0000-4000-8000-000000000068",
        status: "abandoned",
        summary: "Abandoned",
        confidence: "high",
        anchor: null,
      }),
    ]),
    artifacts: Object.freeze([Object.freeze({
      artifactId: "00000000-0000-4000-8000-000000000069",
      path: "src/orchestrator/projections/schema.ts",
      summary: "Schema",
      action: "modified",
      contentHash: "c".repeat(64),
      branchRef: BINDING.branchRef,
      confidence: "high",
      symbol: "PROJECTION_SCHEMA_VERSION",
      commitHash: "d".repeat(64),
      heading: "Schema V2",
      anchor: null,
    })]),
    entities: Object.freeze([
      Object.freeze({
        entityId: ENTITY_A,
        normalizedName: "projection schema",
        entityType: "contract",
        validFrom: OCCURRED_AT,
        validTo: null,
        anchor: "memory/entities#projection-schema",
      }),
      Object.freeze({
        entityId: ENTITY_B,
        normalizedName: "integrity replay",
        entityType: "verification",
        validFrom: OCCURRED_AT,
        validTo: null,
        anchor: null,
      }),
    ]),
    aliases: Object.freeze([Object.freeze({
      aliasId: "00000000-0000-4000-8000-000000000070",
      entityId: ENTITY_A,
      normalizedAlias: "schema v2",
      validFrom: OCCURRED_AT,
      validTo: null,
      anchor: null,
    })]),
    edges: Object.freeze([Object.freeze({
      edgeId: "00000000-0000-4000-8000-000000000071",
      sourceEntityId: ENTITY_A,
      targetEntityId: ENTITY_B,
      edgeType: "verified-by",
      validFrom: OCCURRED_AT,
      validTo: null,
      anchor: "memory/entities#verified-by",
    })]),
    ...overrides,
  });
}

describe("projection folds", () => {
  it("binds the complete source scope and folds canonical state deterministically", () => {
    const initial = emptyProjectionFoldState();
    const folded = foldProjectionEvent(initial, memoryEvent(42n));

    assert.deepEqual(folded.binding, BINDING);
    assert.equal(folded.terminalEventPosition, 42n);
    assert.equal(folded.canonicalItems.length, 1);
    assert.equal(folded.canonicalItems[0]?.sessionId, BINDING.sessionId);
    assert.equal(folded.canonicalItems[0]?.knownFromEventPosition, 42n);
    assert.equal(folded.canonicalItems[0]?.validTo, null);
    assert.equal(initial.binding, null);
    assert.equal(initial.canonicalItems.length, 0);
    assert.equal(Object.isFrozen(folded), true);
    assert.equal(Object.isFrozen(folded.canonicalItems), true);
  });

  it("accepts allowed status evolution and keeps inclusive/exclusive temporal bounds", () => {
    const provisional = foldProjectionEvent(emptyProjectionFoldState(), memoryEvent(42n));
    const verified = foldProjectionEvent(provisional, memoryEvent(43n, {
      sourceEventId: "00000000-0000-4000-8000-000000000047",
      status: "verified",
      verificationMethod: "integrity-replay",
      validTo: "2026-08-24T01:00:00.000Z",
    }));

    assert.equal(verified.canonicalItems.length, 1);
    assert.equal(verified.canonicalItems[0]?.status, "verified");
    assert.equal(verified.canonicalItems[0]?.knownFromEventPosition, 42n);
    assert.equal(verified.canonicalItems[0]?.sourceEventPosition, 43n);
    assert.equal(verified.canonicalItems[0]?.validFrom, OCCURRED_AT);
    assert.equal(verified.canonicalItems[0]?.validTo, "2026-08-24T01:00:00.000Z");
  });

  it("folds explicit Version 2 conflict metadata without changing the normalized-key identity", () => {
    const conflictGroupId = "00000000-0000-4000-8000-000000000052";
    const folded = foldProjectionEvent(emptyProjectionFoldState(), memoryEvent(42n, {
      sourceEventSchemaVersion: 2,
      status: "conflicted",
      conflictGroupId,
    }));

    assert.equal(folded.canonicalItems[0]?.normalizedKey, "decision:projection-boundary");
    assert.equal(folded.canonicalItems[0]?.conflictGroupId, conflictGroupId);
    assert.equal(folded.canonicalItems[0]?.supersedingItemId, null);
  });

  it("rejects illegal status regression and leaves the prior fold unchanged", () => {
    const verified = foldProjectionEvent(emptyProjectionFoldState(), memoryEvent(42n, {
      status: "verified",
    }));
    assert.throws(
      () => foldProjectionEvent(verified, memoryEvent(43n, { status: "candidate" })),
      /INTEGRITY_FAILURE/u,
    );
    assert.equal(verified.canonicalItems[0]?.status, "verified");
    assert.equal(verified.terminalEventPosition, 42n);
  });

  it("rejects changing an existing canonical item's session authority", () => {
    const state = foldProjectionEvent(emptyProjectionFoldState(), memoryEvent(42n));
    assert.throws(
      () => foldProjectionEvent(state, memoryEvent(43n, {
        binding: Object.freeze({
          ...BINDING,
          sessionId: "00000000-0000-4000-8000-000000000043",
        }),
      })),
      /INTEGRITY_FAILURE/u,
    );
    assert.equal(state.canonicalItems[0]?.sessionId, BINDING.sessionId);
    assert.equal(state.terminalEventPosition, 42n);
  });

  it("rejects cross-project and non-monotonic source events without changing state", () => {
    const state = foldProjectionEvent(emptyProjectionFoldState(), memoryEvent(42n));
    const foreignBinding = Object.freeze({
      ...BINDING,
      projectId: "f".repeat(64) as ProjectBinding["projectId"],
    });
    assert.throws(
      () => foldProjectionEvent(state, memoryEvent(43n, { binding: foreignBinding })),
      /INTEGRITY_FAILURE/u,
    );
    assert.throws(
      () => foldProjectionEvent(state, memoryEvent(42n)),
      /INTEGRITY_FAILURE/u,
    );
    assert.equal(state.terminalEventPosition, 42n);
  });

  it("rejects malformed projection input without invoking accessors", () => {
    const state = emptyProjectionFoldState();
    let invoked = false;
    const malformed = { ...memoryEvent(42n) } as Record<string, unknown>;
    Object.defineProperty(malformed, "summary", {
      enumerable: true,
      get() {
        invoked = true;
        throw new Error("accessor executed");
      },
    });

    assert.throws(
      () => foldProjectionEvent(state, malformed as unknown as ProjectionEvent),
      /INTEGRITY_FAILURE/u,
    );
    assert.equal(invoked, false);
    assert.deepEqual(state, emptyProjectionFoldState());
  });

  it("rejects semantically forged prior fold rows before applying another item", () => {
    const valid = foldProjectionEvent(emptyProjectionFoldState(), memoryEvent(42n));
    const forged = Object.freeze({
      ...valid,
      canonicalItems: Object.freeze([Object.freeze({
        ...valid.canonicalItems[0],
        status: "invented",
      })]),
    });
    assert.throws(
      () => foldProjectionEvent(
        forged as unknown as typeof valid,
        memoryEvent(43n, {
          sourceEventId: "00000000-0000-4000-8000-000000000047",
          itemId: "00000000-0000-4000-8000-000000000048",
          normalizedKey: "decision:another-item",
        }),
      ),
      /INTEGRITY_FAILURE/u,
    );
  });

  it("rejects feedback claiming a source position before the item existed", () => {
    const state = foldProjectionEvent(emptyProjectionFoldState(), memoryEvent(42n));
    assert.throws(
      () => foldProjectionEvent(state, feedbackEvent(43n, 41n)),
      /INTEGRITY_FAILURE/u,
    );
    assert.equal(state.retrievalFeedback.length, 0);
    assert.equal(state.terminalEventPosition, 42n);
  });

  it("rejects oversized persisted row fields in a forged prior state", () => {
    const state = foldProjectionEvent(emptyProjectionFoldState(), memoryEvent(42n));
    const oversized = "x".repeat(300 * 1_024);
    const forgedStates = [
      { ...state, binding: { ...BINDING, branchRef: oversized } },
      { ...state, canonicalItems: [{ ...state.canonicalItems[0], summary: oversized }] },
      {
        ...state,
        sessionCheckpoints: [{
          projectId: BINDING.projectId,
          sessionId: BINDING.sessionId,
          checkpointId: "00000000-0000-4000-8000-000000000050",
          checkpointVersion: 1,
          baseEventPosition: 41n,
          sourceEventPosition: 42n,
          occurredAt: OCCURRED_AT,
          taskSummary: oversized,
          sourceEventId: EVENT_ID,
          anchor: null,
        }],
      },
      {
        ...state,
        lexicalChunks: [{ ...state.lexicalChunks[0], text: oversized }],
      },
    ];

    for (const forged of forgedStates) {
      assert.throws(
        () => foldProjectionEvent(forged as typeof state, nextItem(43n)),
        /INTEGRITY_FAILURE/u,
      );
    }
  });

  it("rejects duplicate identities in every forged prior projection collection", () => {
    const state = foldProjectionEvent(emptyProjectionFoldState(), memoryEvent(42n));
    const feedbackState = foldProjectionEvent(state, feedbackEvent(43n, 42n));
    const checkpoint = {
      projectId: BINDING.projectId,
      sessionId: BINDING.sessionId as string,
      checkpointId: "00000000-0000-4000-8000-000000000050",
      checkpointVersion: 1 as const,
      baseEventPosition: 41n,
      sourceEventPosition: 42n,
      occurredAt: OCCURRED_AT,
      taskSummary: "Projection checkpoint.",
      sourceEventId: EVENT_ID,
      anchor: null,
    };
    const followUp = {
      projectId: BINDING.projectId,
      sessionId: BINDING.sessionId as string,
      followUpId: `${EVENT_ID}/next-action/0`,
      status: "open" as const,
      summary: "Build the immutable generation.",
      confidence: "high" as const,
      sourceEventPosition: 42n,
      sourceEventId: EVENT_ID,
      anchor: null,
    };
    const artifact = {
      projectId: BINDING.projectId,
      sessionId: BINDING.sessionId as string,
      artifactId: "00000000-0000-4000-8000-000000000051",
      path: "projection-manifest.json",
      summary: "Immutable projection manifest.",
      action: "observed",
      contentHash: "c".repeat(64),
      branchRef: BINDING.branchRef,
      confidence: "high" as const,
      sourceEventPosition: 42n,
      symbol: null,
      commitHash: null,
      heading: null,
      sourceEventId: EVENT_ID,
      anchor: null,
    };
    const duplicateStates: Array<{ state: typeof state; nextPosition: bigint }> = [
      { state: { ...state, canonicalItems: [state.canonicalItems[0]!, state.canonicalItems[0]!] }, nextPosition: 43n },
      { state: { ...state, sessionCheckpoints: [checkpoint, checkpoint] }, nextPosition: 43n },
      { state: { ...state, followUps: [followUp, followUp] }, nextPosition: 43n },
      { state: { ...state, artifacts: [artifact, artifact] }, nextPosition: 43n },
      { state: { ...state, lexicalChunks: [state.lexicalChunks[0]!, state.lexicalChunks[0]!] }, nextPosition: 43n },
      {
        state: {
          ...feedbackState,
          retrievalFeedback: [feedbackState.retrievalFeedback[0]!, feedbackState.retrievalFeedback[0]!],
        },
        nextPosition: 44n,
      },
    ];

    for (const duplicate of duplicateStates) {
      assert.throws(
        () => foldProjectionEvent(duplicate.state, nextItem(duplicate.nextPosition)),
        /INTEGRITY_FAILURE/u,
      );
    }
  });

  it("builds an authenticated root/child tree and retains every checkpoint citation in order", () => {
    const root = foldProjectionEvent(
      emptyProjectionFoldState(),
      lifecycleEvent(1n, ROOT_ID, "SessionStarted"),
    );
    const child = foldProjectionEvent(root, lifecycleEvent(2n, CHILD_ID, "SessionForked", {
      binding: Object.freeze({ ...BINDING, sessionId: CHILD_ID }),
      parentSessionId: ROOT_ID,
      ownerGeneration: 1,
    }));
    const first = foldProjectionEvent(child, checkpointEvent(3n, 2n));
    const second = foldProjectionEvent(first, checkpointEvent(4n, 3n, 3n));

    assert.deepEqual(second.sessionTree.map((row) => ({
      sessionId: row.sessionId,
      rootSessionId: row.rootSessionId,
      parentSessionId: row.parentSessionId,
      sourceEventId: row.sourceEventId,
    })), [
      {
        sessionId: ROOT_ID,
        rootSessionId: ROOT_ID,
        parentSessionId: null,
        sourceEventId: "00000000-0000-4000-9000-000000000001",
      },
      {
        sessionId: CHILD_ID,
        rootSessionId: ROOT_ID,
        parentSessionId: ROOT_ID,
        sourceEventId: "00000000-0000-4000-9000-000000000002",
      },
    ]);
    assert.deepEqual(second.sessionCheckpoints.map((row) => [
      row.sourceEventPosition,
      row.sourceEventId,
    ]), [
      [3n, "00000000-0000-4000-a000-000000000003"],
      [4n, "00000000-0000-4000-a000-000000000004"],
    ]);
    assert.equal(second.sessionTree[1]?.latestCheckpointId, second.sessionCheckpoints[1]?.checkpointId);
  });

  it("keeps lifecycle stream continuity across an intervening governed material event", () => {
    const root = foldProjectionEvent(
      emptyProjectionFoldState(),
      lifecycleEvent(1n, ROOT_ID, "SessionStarted"),
    );
    const child = foldProjectionEvent(root, lifecycleEvent(2n, CHILD_ID, "SessionForked", {
      binding: Object.freeze({ ...BINDING, sessionId: CHILD_ID }),
      parentSessionId: ROOT_ID,
      ownerGeneration: 1,
    }));
    const checkpointed = foldProjectionEvent(child, checkpointEvent(3n, 2n));
    const material = foldProjectionEvent(checkpointed, governedEvent(4n, {
      binding: Object.freeze({ ...BINDING, sessionId: CHILD_ID }),
      sourceStreamVersion: 3n,
    }));
    const continued = foldProjectionEvent(material, lifecycleEvent(
      5n,
      CHILD_ID,
      "ChildAssignmentAmended",
      {
        binding: Object.freeze({ ...BINDING, sessionId: CHILD_ID }),
        parentSessionId: ROOT_ID,
        sourceStreamVersion: 4n,
      },
    ));

    assert.equal(continued.sessionTree[1]?.latestStreamVersion, 4n);
    assert.throws(() => foldProjectionEvent(checkpointed, governedEvent(4n, {
      binding: Object.freeze({ ...BINDING, sessionId: CHILD_ID }),
      sourceStreamVersion: 4n,
    })), /INTEGRITY_FAILURE/u);
  });

  it("updates root ownership, closes terminal sessions, and rejects every update after close", () => {
    const opened = foldProjectionEvent(
      emptyProjectionFoldState(),
      lifecycleEvent(1n, ROOT_ID, "SessionStarted"),
    );
    assert.throws(() => foldProjectionEvent(opened, lifecycleEvent(
      2n,
      ROOT_ID,
      "SessionOwnerTransferred",
      { ownerGeneration: 2, previousOwnerGeneration: 2 },
    )), /INTEGRITY_FAILURE/u);
    const transferred = foldProjectionEvent(opened, lifecycleEvent(
      2n,
      ROOT_ID,
      "SessionOwnerTransferred",
      { ownerGeneration: 2, previousOwnerGeneration: 1 },
    ));
    const closed = foldProjectionEvent(transferred, lifecycleEvent(3n, ROOT_ID, "SessionEnded"));

    assert.equal(closed.sessionTree[0]?.ownerGeneration, 2);
    assert.equal(closed.sessionTree[0]?.lifecycleState, "closed");
    assert.equal(closed.sessionTree[0]?.closedEventPosition, 3n);
    assert.throws(
      () => foldProjectionEvent(closed, lifecycleEvent(4n, ROOT_ID, "SessionResumed")),
      /INTEGRITY_FAILURE/u,
    );
  });

  it("rejects a stale fork owner generation in the pure fold", () => {
    const root = foldProjectionEvent(
      emptyProjectionFoldState(),
      lifecycleEvent(1n, ROOT_ID, "SessionStarted"),
    );
    const child = foldProjectionEvent(root, lifecycleEvent(2n, CHILD_ID, "SessionForked", {
      binding: Object.freeze({ ...BINDING, sessionId: CHILD_ID }),
      parentSessionId: ROOT_ID,
      ownerGeneration: 1,
    }));
    const transferred = foldProjectionEvent(child, lifecycleEvent(
      3n,
      ROOT_ID,
      "SessionOwnerTransferred",
      { ownerGeneration: 2, previousOwnerGeneration: 1, sourceStreamVersion: 2n },
    ));
    const fork = (ownerGeneration: number) => lifecycleEvent(4n, GRANDCHILD_ID, "SessionForked", {
      binding: Object.freeze({ ...BINDING, sessionId: GRANDCHILD_ID }),
      parentSessionId: CHILD_ID,
      ownerGeneration,
    });

    assert.throws(() => foldProjectionEvent(transferred, fork(1)), /INTEGRITY_FAILURE/u);
    assert.equal(foldProjectionEvent(transferred, fork(2)).sessionTree[2]?.ownerGeneration, 2);
  });

  it("rejects a stale fork owner generation in the linear accumulator", () => {
    const accumulator = new ProjectionFoldAccumulator();
    accumulator.append(lifecycleEvent(1n, ROOT_ID, "SessionStarted"));
    accumulator.append(lifecycleEvent(2n, CHILD_ID, "SessionForked", {
      binding: Object.freeze({ ...BINDING, sessionId: CHILD_ID }),
      parentSessionId: ROOT_ID,
      ownerGeneration: 1,
    }));
    accumulator.append(lifecycleEvent(3n, ROOT_ID, "SessionOwnerTransferred", {
      ownerGeneration: 2,
      previousOwnerGeneration: 1,
      sourceStreamVersion: 2n,
    }));
    const fork = (ownerGeneration: number) => lifecycleEvent(4n, GRANDCHILD_ID, "SessionForked", {
      binding: Object.freeze({ ...BINDING, sessionId: GRANDCHILD_ID }),
      parentSessionId: CHILD_ID,
      ownerGeneration,
    });

    assert.throws(() => accumulator.append(fork(1)), /INTEGRITY_FAILURE/u);
    accumulator.append(fork(2));
    assert.equal(accumulator.finish().sessionTree[2]?.ownerGeneration, 2);
  });

  it("rejects closing an ancestor with an open descendant in the pure fold", () => {
    const root = foldProjectionEvent(
      emptyProjectionFoldState(),
      lifecycleEvent(1n, ROOT_ID, "SessionStarted"),
    );
    const child = foldProjectionEvent(root, lifecycleEvent(2n, CHILD_ID, "SessionForked", {
      binding: Object.freeze({ ...BINDING, sessionId: CHILD_ID }),
      parentSessionId: ROOT_ID,
      ownerGeneration: 1,
    }));
    const closeRoot = (position: bigint) => lifecycleEvent(position, ROOT_ID, "SessionEnded", {
      sourceStreamVersion: 2n,
    });

    assert.throws(() => foldProjectionEvent(child, closeRoot(3n)), /INTEGRITY_FAILURE/u);
    const childClosed = foldProjectionEvent(child, lifecycleEvent(
      3n,
      CHILD_ID,
      "ChildSessionCompleted",
      {
        binding: Object.freeze({ ...BINDING, sessionId: CHILD_ID }),
        parentSessionId: ROOT_ID,
        sourceStreamVersion: 2n,
      },
    ));
    assert.equal(foldProjectionEvent(childClosed, closeRoot(4n)).sessionTree[0]?.lifecycleState, "closed");
  });

  it("rejects closing an ancestor with an open descendant in the linear accumulator", () => {
    const accumulator = new ProjectionFoldAccumulator();
    accumulator.append(lifecycleEvent(1n, ROOT_ID, "SessionStarted"));
    accumulator.append(lifecycleEvent(2n, CHILD_ID, "SessionForked", {
      binding: Object.freeze({ ...BINDING, sessionId: CHILD_ID }),
      parentSessionId: ROOT_ID,
      ownerGeneration: 1,
    }));
    const closeRoot = (position: bigint) => lifecycleEvent(position, ROOT_ID, "SessionEnded", {
      sourceStreamVersion: 2n,
    });

    assert.throws(() => accumulator.append(closeRoot(3n)), /INTEGRITY_FAILURE/u);
    accumulator.append(lifecycleEvent(3n, CHILD_ID, "ChildSessionCompleted", {
      binding: Object.freeze({ ...BINDING, sessionId: CHILD_ID }),
      parentSessionId: ROOT_ID,
      sourceStreamVersion: 2n,
    }));
    accumulator.append(closeRoot(4n));
    assert.equal(accumulator.finish().sessionTree[0]?.lifecycleState, "closed");
  });

  it("rejects unknown/self/cross-binding parents, second openings, and forged cycles", () => {
    const root = foldProjectionEvent(
      emptyProjectionFoldState(),
      lifecycleEvent(1n, ROOT_ID, "SessionStarted"),
    );
    const children = [
      lifecycleEvent(2n, CHILD_ID, "SessionForked", {
        binding: Object.freeze({ ...BINDING, sessionId: CHILD_ID }),
        parentSessionId: CHILD_ID,
        ownerGeneration: 1,
      }),
      lifecycleEvent(2n, CHILD_ID, "SessionForked", {
        binding: Object.freeze({ ...BINDING, sessionId: CHILD_ID }),
        parentSessionId: "00000000-0000-4000-8000-000000000099",
        ownerGeneration: 1,
      }),
      lifecycleEvent(2n, CHILD_ID, "SessionForked", {
        binding: Object.freeze({
          ...BINDING,
          workspaceId: "9".repeat(64) as ProjectBinding["workspaceId"],
          sessionId: CHILD_ID,
        }),
        parentSessionId: ROOT_ID,
        ownerGeneration: 1,
      }),
    ];
    for (const child of children) {
      assert.throws(() => foldProjectionEvent(root, child), /INTEGRITY_FAILURE/u);
    }
    assert.throws(
      () => foldProjectionEvent(root, lifecycleEvent(2n, ROOT_ID, "SessionStarted")),
      /INTEGRITY_FAILURE/u,
    );

    const forged = {
      ...root,
      sessionTree: [{
        ...root.sessionTree[0],
        parentSessionId: ROOT_ID,
      }],
    };
    assert.throws(
      () => foldProjectionEvent(forged as typeof root, nextItem(2n)),
      /INTEGRITY_FAILURE/u,
    );
  });

  it("upserts only explicit governed IDs and preserves structured provenance without summary inference", () => {
    const first = foldProjectionEvent(emptyProjectionFoldState(), governedEvent(1n));
    const second = foldProjectionEvent(first, governedEvent(2n, {
      sourceEventId: "00000000-0000-4000-b000-000000000002",
      item: Object.freeze({
        ...governedEvent(1n).item,
        summary: "symbol=Invented heading=Not structured",
        anchor: "memory/items#projection-boundary",
      }),
      followUps: Object.freeze([Object.freeze({
        ...governedEvent(1n).followUps[0]!,
        status: "completed",
        anchor: null,
      })]),
      artifacts: Object.freeze([]),
      entities: Object.freeze([]),
      aliases: Object.freeze([]),
      edges: Object.freeze([]),
    }));

    assert.equal(second.followUps.length, 5, "omitted governed rows are not deleted");
    assert.equal(second.followUps[0]?.status, "completed");
    assert.equal(second.followUps[0]?.sourceEventId, "00000000-0000-4000-b000-000000000002");
    assert.equal(second.followUps[1]?.sourceEventId, "00000000-0000-4000-b000-000000000001");
    assert.equal(second.artifacts[0]?.symbol, "PROJECTION_SCHEMA_VERSION");
    assert.equal(second.artifacts[0]?.anchor, null);
    assert.equal(second.canonicalItems[0]?.anchor, "memory/items#projection-boundary");
    assert.equal(second.lexicalChunks[0]?.anchor, "memory/items#projection-boundary");
    assert.equal(second.entityNodes.length, 2);
    assert.equal(second.entityAliases[0]?.entityId, ENTITY_A);
    assert.equal(second.entityEdges[0]?.edgeType, "verified-by");
    assert.equal("symbol" in second.canonicalItems[0]!, false);

    const referencingExisting = governedEvent(3n, {
      sourceEventId: "00000000-0000-4000-b000-000000000003",
      item: Object.freeze({
        ...governedEvent(1n).item,
        itemId: "00000000-0000-4000-8000-000000000072",
        normalizedKey: "decision:existing-entity-reference",
      }),
      followUps: Object.freeze([]),
      artifacts: Object.freeze([]),
      entities: Object.freeze([]),
      aliases: Object.freeze([Object.freeze({
        aliasId: "00000000-0000-4000-8000-000000000073",
        entityId: ENTITY_B,
        normalizedAlias: "replay",
        validFrom: OCCURRED_AT,
        validTo: null,
        anchor: null,
      })]),
      edges: Object.freeze([]),
    });
    assert.equal(foldProjectionEvent(second, referencingExisting).entityAliases.length, 2);
  });

  it("rejects checkpoints outside authenticated session ancestry", () => {
    const root = foldProjectionEvent(
      emptyProjectionFoldState(),
      lifecycleEvent(10n, ROOT_ID, "SessionStarted"),
    );
    const child = foldProjectionEvent(root, lifecycleEvent(11n, CHILD_ID, "SessionForked", {
      binding: Object.freeze({ ...BINDING, sessionId: CHILD_ID }),
      parentSessionId: ROOT_ID,
      ownerGeneration: 1,
    }));
    assert.throws(() => foldProjectionEvent(child, checkpointEvent(12n, 9n)), /INTEGRITY_FAILURE/u);
    assert.throws(() => foldProjectionEvent(child, checkpointEvent(12n, 12n)), /INTEGRITY_FAILURE/u);
  });

  it("rejects governed aliases and edges whose entity references are unresolved by replay state", () => {
    const source = governedEvent(1n);
    assert.throws(() => foldProjectionEvent(emptyProjectionFoldState(), governedEvent(1n, {
      aliases: Object.freeze([Object.freeze({
        ...source.aliases[0]!,
        entityId: "00000000-0000-4000-8000-000000000099",
      })]),
    })), /INTEGRITY_FAILURE/u);
    assert.throws(() => foldProjectionEvent(emptyProjectionFoldState(), governedEvent(1n, {
      edges: Object.freeze([Object.freeze({
        ...source.edges[0]!,
        targetEntityId: "00000000-0000-4000-8000-000000000099",
      })]),
    })), /INTEGRITY_FAILURE/u);
  });
});
