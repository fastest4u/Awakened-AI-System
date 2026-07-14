import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  commandHash,
  eventHash,
  outboxHash,
  payloadHash,
  responseHash,
} from "../src/orchestrator/crypto/event-hash.js";
import type {
  AppendCommand,
  AppendResult,
  JsonValue,
  PendingEvent,
  StoredEvent,
} from "../src/orchestrator/contracts/event.js";

type EventContractSurface = [JsonValue, PendingEvent, AppendCommand<JsonValue>, AppendResult<JsonValue>, StoredEvent];
void (null as unknown as EventContractSurface);

const payload = { z: -0, a: ["ไทย", 3, true, null], nested: { b: 2, a: 1 } };

describe("event hash golden vectors", () => {
  it("locks the payload hash", () => {
    assert.equal(payloadHash(payload), "392e7a273f8bf98f2d6aed8b485f468dc1fc649056ee8b648a628011f7cad2d9");
  });

  it("locks the command hash", () => {
    assert.equal(commandHash({
      commandId: "33333333-3333-4333-8333-333333333333",
      commandType: "AppendTest",
      projectId: "11111111-1111-4111-8111-111111111111",
      storeId: "22222222-2222-4222-8222-222222222222",
      workspaceId: "workspace-a",
      git: {
        headCommit: "0123456789abcdef0123456789abcdef01234567",
        branchRef: "refs/heads/main",
        detached: false,
      },
      streamId: "stream-1",
      streamType: "test",
      expectedStreamVersion: "0",
      correlationId: "corr-1",
      agentId: "agent-a",
      events: [{
        eventType: "TestRecorded",
        eventSchemaVersion: 1,
        occurredAt: "2026-07-11T00:00:00.000Z",
        visibilityScope: "project",
        confidence: "high",
        verificationStatus: "verified",
        payload,
        sourceRefs: [],
        evidenceRefs: [],
        evidenceDigests: [],
      }],
      outbox: [],
    }), "5af04ec6906046ac558dd4ae3390722906f6dbc276f85915fa0f08a24fc02d58");
  });

  it("locks the response hash", () => {
    assert.equal(responseHash({
      eventIds: ["44444444-4444-4444-8444-444444444444"],
      firstGlobalPosition: "1",
      lastGlobalPosition: "1",
      finalStreamVersion: "1",
      response: { accepted: true },
    }), "1d0c59cbfde32fbb1d9b2cb927276f9d92979d1dad90d13c076223cf118f9f34");
  });

  it("locks the outbox hash", () => {
    assert.equal(
      outboxHash({ kind: "projection", position: "1" }),
      "e03329f03392fdfed8f0e8c4b020bbd18ed8152abdc1ba5f6f680d64c10092d1",
    );
  });

  it("locks the event hash and genesis previous hash", () => {
    assert.equal(eventHash({
      globalPosition: "1",
      eventId: "44444444-4444-4444-8444-444444444444",
      projectId: "11111111-1111-4111-8111-111111111111",
      vaultId: "55555555-5555-4555-8555-555555555555",
      storeId: "22222222-2222-4222-8222-222222222222",
      workspaceId: "workspace-a",
      branchScopeId: null,
      branchRef: "refs/heads/main",
      streamId: "stream-1",
      streamType: "test",
      streamVersion: "1",
      eventType: "TestRecorded",
      eventSchemaVersion: 1,
      sessionId: null,
      parentSessionId: null,
      actorRole: "primary",
      agentId: "agent-a",
      clientInstanceId: "client-a",
      correlationId: "corr-1",
      causationId: null,
      commandId: "33333333-3333-4333-8333-333333333333",
      idempotencyKey: "idem-1",
      commandEventIndex: 0,
      occurredAt: "2026-07-11T00:00:00.000Z",
      recordedAt: "2026-07-11T00:00:01.000Z",
      visibilityScope: "project",
      confidence: "high",
      verificationStatus: "verified",
      sourceRefs: [],
      evidenceRefs: [],
      evidenceDigests: [],
      payloadHash: payloadHash(payload),
      previousGlobalHash: "0".repeat(64),
    }), "dfb2678844522cffb3681a7402c209ce9ad741e9ad0a3367a911dbba53057de0");
  });
});
