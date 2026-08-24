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
const CONFLICT_GROUP_ID = "00000000-0000-4000-8000-000000000049";
const SUPERSEDING_ITEM_ID = "00000000-0000-4000-8000-000000000050";
const ROOT_SESSION_ID = "00000000-0000-4000-8000-000000000051";
const CHILD_SESSION_ID = "00000000-0000-4000-8000-000000000052";
const FOLLOW_UP_IDS = [
  "00000000-0000-4000-8000-000000000053",
  "00000000-0000-4000-8000-000000000054",
  "00000000-0000-4000-8000-000000000055",
  "00000000-0000-4000-8000-000000000056",
  "00000000-0000-4000-8000-000000000057",
] as const;
const ARTIFACT_ID = "00000000-0000-4000-8000-000000000058";
const ENTITY_A = "00000000-0000-4000-8000-000000000059";
const ENTITY_B = "00000000-0000-4000-8000-000000000060";
const ALIAS_ID = "00000000-0000-4000-8000-000000000061";
const EDGE_ID = "00000000-0000-4000-8000-000000000062";
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

function governedPayload(overrides: Record<string, unknown> = {}): JsonValue {
  const statuses = ["open", "blocked", "completed", "carried-forward", "abandoned"] as const;
  return {
    sourceVersion: 2,
    binding: binding(),
    item: {
      itemId: ITEM_ID,
      normalizedKey: "decision:projection-boundary",
      status: "verified",
      confidence: "high",
      verificationMethod: "governed-source",
      validFrom: OCCURRED_AT,
      validTo: null,
      summary: "The summary mentions symbol=Fake and heading=Invented, but those are not structure.",
      contentHash: "b".repeat(64),
      conflictGroupId: CONFLICT_GROUP_ID,
      supersedingItemId: null,
      anchor: null,
    },
    followUps: statuses.map((status, index) => ({
      followUpId: FOLLOW_UP_IDS[index],
      status,
      summary: `Follow-up ${status}`,
      confidence: "high",
      anchor: index === 0 ? "memory/follow-ups#open" : null,
    })),
    artifacts: [{
      artifactId: ARTIFACT_ID,
      path: "src/orchestrator/projections/schema.ts",
      summary: "Projection schema",
      action: "modified",
      contentHash: "c".repeat(64),
      branchRef: BRANCH_REF,
      confidence: "high",
      symbol: "PROJECTION_SCHEMA_VERSION",
      commitHash: "d".repeat(64),
      heading: "Schema V2",
      anchor: "src/orchestrator/projections/schema.ts#L3",
    }],
    entities: [
      {
        entityId: ENTITY_A,
        normalizedName: "projection schema",
        entityType: "technical-contract",
        validFrom: OCCURRED_AT,
        validTo: null,
        anchor: "memory/entities#projection-schema",
      },
      {
        entityId: ENTITY_B,
        normalizedName: "integrity replay",
        entityType: "verification-process",
        validFrom: OCCURRED_AT,
        validTo: OCCURRED_AT,
        anchor: null,
      },
    ],
    aliases: [{
      aliasId: ALIAS_ID,
      entityId: ENTITY_A,
      normalizedAlias: "schema v2",
      validFrom: OCCURRED_AT,
      validTo: null,
      anchor: null,
    }],
    edges: [{
      edgeId: EDGE_ID,
      sourceEntityId: ENTITY_A,
      targetEntityId: ENTITY_B,
      edgeType: "verified-by",
      validFrom: OCCURRED_AT,
      validTo: null,
      anchor: "memory/entities#verified-by",
    }],
    ...overrides,
  } as JsonValue;
}

function rootStartedPayload(): JsonValue {
  return {
    sessionKind: "root",
    ownerGeneration: 1,
    continuityKey: "projection-root",
    clientNamespace: "projection-tests",
    creatingAgentId: "projection-test-agent",
    creatingClientInstanceId: "projection-test-client",
    authorityCommitment: "e".repeat(64),
  };
}

function childForkedPayload(): JsonValue {
  return {
    parentSessionId: ROOT_SESSION_ID,
    assignment: {
      assignmentId: "00000000-0000-4000-8000-000000000063",
      summary: "Verify schema V2",
      scope: "projection remediation",
    },
    rootOwnerGeneration: 3,
    directAccessEnabled: false,
    authorityCommitment: "f".repeat(64),
    sourceTransferTicketId: null,
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

  it("decodes only explicit Version 2 conflict and supersession references", () => {
    const payload = memoryPayload({
      sourceVersion: 2,
      conflictGroupId: CONFLICT_GROUP_ID,
      supersedingItemId: SUPERSEDING_ITEM_ID,
    });
    const decoded = decodeProjectionEvent(storedEvent("MemorySourceRecorded", payload, {
      eventSchemaVersion: 2,
    }));

    assert.equal(decoded.kind, "projected");
    if (decoded.kind !== "projected" || decoded.event.kind !== "memory-source") return;
    assert.equal(decoded.event.conflictGroupId, CONFLICT_GROUP_ID);
    assert.equal(decoded.event.supersedingItemId, SUPERSEDING_ITEM_ID);
    assert.throws(
      () => decodeProjectionEvent(storedEvent("MemorySourceRecorded", memoryPayload({
        conflictGroupId: CONFLICT_GROUP_ID,
      }))),
      /INTEGRITY_FAILURE/u,
    );
  });

  it("decodes the exact governed schema-3 form without inferring structured fields from summary text", () => {
    const decoded = decodeProjectionEvent(storedEvent(
      "MemorySourceRecorded",
      governedPayload(),
      { eventSchemaVersion: 3 },
    ));

    assert.equal(decoded.kind, "projected");
    if (decoded.kind !== "projected" || decoded.event.kind !== "governed-memory-source") return;
    assert.equal(decoded.event.item.anchor, null);
    assert.deepEqual(decoded.event.followUps.map((row) => row.status), [
      "open", "blocked", "completed", "carried-forward", "abandoned",
    ]);
    assert.equal(decoded.event.artifacts[0]?.symbol, "PROJECTION_SCHEMA_VERSION");
    assert.equal(decoded.event.artifacts[0]?.commitHash, "d".repeat(64));
    assert.equal(decoded.event.artifacts[0]?.heading, "Schema V2");
    assert.equal(decoded.event.entities[1]?.anchor, null);
    assert.equal(decoded.event.aliases[0]?.entityId, ENTITY_A);
    assert.equal(decoded.event.edges[0]?.edgeType, "verified-by");
    assert.equal("symbol" in decoded.event.item, false);
    assert.equal("heading" in decoded.event.item, false);
  });

  it("keeps MemorySourceRecorded schemas 1 and 2 explicit and rejects schema-3 omissions or aliases", () => {
    for (const [eventSchemaVersion, payload] of [
      [1, memoryPayload()],
      [2, memoryPayload({
        sourceVersion: 2,
        conflictGroupId: CONFLICT_GROUP_ID,
        supersedingItemId: null,
      })],
    ] as const) {
      const decoded = decodeProjectionEvent(storedEvent("MemorySourceRecorded", payload, {
        eventSchemaVersion,
      }));
      assert.equal(decoded.kind, "projected");
      if (decoded.kind !== "projected") continue;
      assert.equal(decoded.event.kind, "memory-source");
    }

    const governed = governedPayload() as Record<string, unknown>;
    const { edges: _edges, ...missingEdges } = governed;
    assert.throws(
      () => decodeProjectionEvent(storedEvent("MemorySourceRecorded", missingEdges as JsonValue, {
        eventSchemaVersion: 3,
      })),
      /INTEGRITY_FAILURE/u,
    );
    assert.throws(
      () => decodeProjectionEvent(storedEvent("MemorySourceRecorded", {
        ...governed,
        entityEdges: governed.edges,
      } as JsonValue, { eventSchemaVersion: 3 })),
      /INTEGRITY_FAILURE/u,
    );
  });

  it("rejects duplicate, self, invalid-validity, and over-bound governed structures", () => {
    const governed = governedPayload() as Record<string, unknown>;
    const entities = governed.entities as Array<Record<string, unknown>>;
    const aliases = governed.aliases as Array<Record<string, unknown>>;
    const edges = governed.edges as Array<Record<string, unknown>>;
    const followUps = governed.followUps as Array<Record<string, unknown>>;
    const item = governed.item as Record<string, unknown>;
    assert.equal(decodeProjectionEvent(storedEvent("MemorySourceRecorded", {
      ...governed,
      item: { ...item, validTo: item.validFrom },
    } as JsonValue, { eventSchemaVersion: 3 })).kind, "projected");
    const invalidPayloads: JsonValue[] = [
      { ...governed, followUps: [followUps[0], followUps[0]] } as JsonValue,
      { ...governed, entities: [entities[0], entities[0]] } as JsonValue,
      {
        ...governed,
        followUps: [{ ...followUps[0], followUpId: (governed.artifacts as Array<Record<string, unknown>>)[0]?.artifactId }],
      } as JsonValue,
      {
        ...governed,
        edges: [{ ...edges[0], targetEntityId: ENTITY_A }],
      } as JsonValue,
      {
        ...governed,
        entities: [{
          ...entities[0],
          validFrom: "2026-08-24T01:00:00.000Z",
          validTo: OCCURRED_AT,
        }, entities[1]],
      } as JsonValue,
      { ...governed, artifacts: Array.from({ length: 201 }, () => governed.artifacts as never) } as JsonValue,
      {
        ...governed,
        aliases: [{ ...aliases[0], normalizedAlias: "x".repeat((4 * 1_024) + 1) }],
      } as JsonValue,
    ];
    for (const payload of invalidPayloads) {
      assert.throws(
        () => decodeProjectionEvent(storedEvent("MemorySourceRecorded", payload, {
          eventSchemaVersion: 3,
        })),
        /INTEGRITY_FAILURE/u,
      );
    }
  });

  it("decodes production-compatible lifecycle opening records from authenticated envelopes", () => {
    const root = decodeProjectionEvent(storedEvent("SessionStarted", rootStartedPayload(), {
      globalPosition: 1n,
      streamVersion: 1n,
      sessionId: ROOT_SESSION_ID,
      parentSessionId: null,
      streamId: `session/${ROOT_SESSION_ID}`,
    }));
    assert.equal(root.kind, "projected");
    if (root.kind !== "projected" || root.event.kind !== "session-lifecycle") return;
    assert.equal(root.event.sessionId, ROOT_SESSION_ID);
    assert.equal(root.event.parentSessionId, null);
    assert.equal(root.event.ownerGeneration, 1);

    const child = decodeProjectionEvent(storedEvent("SessionForked", childForkedPayload(), {
      globalPosition: 2n,
      streamVersion: 1n,
      sessionId: CHILD_SESSION_ID,
      parentSessionId: ROOT_SESSION_ID,
      streamId: `session/${CHILD_SESSION_ID}`,
    }));
    assert.equal(child.kind, "projected");
    if (child.kind !== "projected" || child.event.kind !== "session-lifecycle") return;
    assert.equal(child.event.sessionId, CHILD_SESSION_ID);
    assert.equal(child.event.parentSessionId, ROOT_SESSION_ID);
    assert.equal(child.event.ownerGeneration, 3);

    assert.throws(
      () => decodeProjectionEvent(storedEvent("SessionForked", {
        ...childForkedPayload() as Record<string, unknown>,
        assignment: { summary: "hand-invented incomplete DTO" },
      } as JsonValue, {
        globalPosition: 2n,
        streamVersion: 1n,
        sessionId: CHILD_SESSION_ID,
        parentSessionId: ROOT_SESSION_ID,
        streamId: `session/${CHILD_SESSION_ID}`,
      })),
      /INTEGRITY_FAILURE/u,
    );
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
