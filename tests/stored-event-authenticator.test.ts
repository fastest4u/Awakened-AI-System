import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { StoredEvent } from "../src/orchestrator/contracts/event.js";
import { eventHash, payloadHash } from "../src/orchestrator/crypto/event-hash.js";
import {
  authenticateStoredEvent,
  type StoredEventChainCursor,
} from "../src/orchestrator/integrity/stored-event-authenticator.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { GENESIS_GLOBAL_HASH } from "../src/orchestrator/storage/event-store.js";

const NOW = "2026-01-01T00:00:00.000Z";

function genesisCursor(): StoredEventChainCursor {
  return {
    expectedPosition: 1n,
    previousEventHash: GENESIS_GLOBAL_HASH,
  };
}

function validStoredEvent(
  globalPosition = 1n,
  previousGlobalHash = GENESIS_GLOBAL_HASH,
): StoredEvent {
  const payload = Object.freeze({ ordinal: Number(globalPosition), summary: "stored event" });
  const payloadJson = canonicalJson(payload);
  const eventWithoutHash = {
    globalPosition,
    eventId: `00000000-0000-4000-8000-${globalPosition.toString().padStart(12, "0")}`,
    projectId: "a".repeat(64) as StoredEvent["projectId"],
    vaultId: "b".repeat(64) as StoredEvent["vaultId"],
    storeId: "c".repeat(64) as StoredEvent["storeId"],
    workspaceId: "d".repeat(64) as StoredEvent["workspaceId"],
    branchScopeId: null,
    branchRef: null,
    streamId: "session/11111111-1111-4111-8111-111111111111",
    streamType: "session",
    streamVersion: globalPosition,
    eventType: "FixtureRecorded",
    eventSchemaVersion: 1,
    sessionId: "11111111-1111-4111-8111-111111111111",
    parentSessionId: null,
    actorRole: "primary" as const,
    agentId: "fixture-agent",
    clientInstanceId: "22222222-2222-4222-8222-222222222222",
    correlationId: "33333333-3333-4333-8333-333333333333",
    causationId: null,
    commandId: "44444444-4444-4444-8444-444444444444",
    idempotencyKey: `fixture:${globalPosition.toString()}`,
    commandEventIndex: Number(globalPosition - 1n),
    occurredAt: NOW,
    recordedAt: NOW,
    visibilityScope: "session" as const,
    confidence: "high" as const,
    verificationStatus: "verified" as const,
    sourceRefs: Object.freeze([]) as readonly string[],
    evidenceRefs: Object.freeze([]) as readonly [],
    evidenceDigests: Object.freeze([]) as readonly [],
    payload,
    payloadJson,
    payloadHash: payloadHash(payload),
    previousGlobalHash,
    lifecycleIntentJson: null,
  };
  const hashMaterial: Record<string, unknown> = {
    ...eventWithoutHash,
    globalPosition: eventWithoutHash.globalPosition.toString(),
    streamVersion: eventWithoutHash.streamVersion.toString(),
  };
  delete hashMaterial.payload;
  delete hashMaterial.payloadJson;
  delete hashMaterial.lifecycleIntentJson;
  return Object.freeze({
    ...eventWithoutHash,
    eventHash: eventHash(hashMaterial),
  });
}

describe("authenticateStoredEvent", () => {
  it("rejects forged metadata and predecessor hashes before projection", () => {
    const event = validStoredEvent();
    assert.throws(
      () => authenticateStoredEvent({
        ...event,
        occurredAt: "2026-01-01T00:00:01.000Z",
      }, genesisCursor()),
      /INTEGRITY_FAILURE/u,
    );
    assert.throws(
      () => authenticateStoredEvent({
        ...event,
        previousGlobalHash: "f".repeat(64),
      }, genesisCursor()),
      /INTEGRITY_FAILURE/u,
    );
  });

  it("rejects noncanonical payloads and payload-hash mismatches", () => {
    const event = validStoredEvent();
    assert.throws(
      () => authenticateStoredEvent({
        ...event,
        payloadJson: '{"summary":"stored event", "ordinal":1}',
      }, genesisCursor()),
      /INTEGRITY_FAILURE/u,
    );
    assert.throws(
      () => authenticateStoredEvent({ ...event, payloadHash: "e".repeat(64) }, genesisCursor()),
      /INTEGRITY_FAILURE/u,
    );
  });

  it("rejects position gaps, forged event hashes, and terminal cursor mismatches", () => {
    const first = validStoredEvent();
    const firstAuthentication = authenticateStoredEvent(first, genesisCursor());
    const terminal = validStoredEvent(2n, first.eventHash);

    assert.throws(
      () => authenticateStoredEvent(terminal, genesisCursor()),
      /INTEGRITY_FAILURE/u,
    );
    assert.throws(
      () => authenticateStoredEvent({ ...terminal, eventHash: "f".repeat(64) }, firstAuthentication.nextCursor),
      /INTEGRITY_FAILURE/u,
    );
    assert.throws(
      () => authenticateStoredEvent(terminal, {
        expectedPosition: 3n,
        previousEventHash: terminal.eventHash,
      }),
      /INTEGRITY_FAILURE/u,
    );
  });

  it("authenticates a valid multi-event chain and advances the cursor exactly once per event", () => {
    const first = validStoredEvent();
    const firstAuthentication = authenticateStoredEvent(first, genesisCursor());
    assert.equal(firstAuthentication.event, first);
    assert.equal(firstAuthentication.canonicalPayloadJson, first.payloadJson);
    assert.equal(firstAuthentication.byteLength, Buffer.byteLength(first.payloadJson, "utf8"));
    assert.deepEqual(firstAuthentication.nextCursor, {
      expectedPosition: 2n,
      previousEventHash: first.eventHash,
    });

    const second = validStoredEvent(2n, first.eventHash);
    const secondAuthentication = authenticateStoredEvent(
      second,
      firstAuthentication.nextCursor,
    );
    assert.deepEqual(secondAuthentication.nextCursor, {
      expectedPosition: 3n,
      previousEventHash: second.eventHash,
    });
  });
});
