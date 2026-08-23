import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  MemorySourceProjectionEvent,
  ProjectBinding,
  ProjectionEvent,
} from "../src/orchestrator/projections/contracts.js";
import {
  emptyProjectionFoldState,
  foldProjectionEvent,
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

function memoryEvent(
  position: bigint,
  overrides: Partial<MemorySourceProjectionEvent> = {},
): MemorySourceProjectionEvent {
  return Object.freeze({
    kind: "memory-source",
    sourceEventId: EVENT_ID,
    sourceEventPosition: position,
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
});
