import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import {
  advanceEvidenceCoverageIntervals,
  assertEvidenceCoverageProjectionBounds,
} from "../src/orchestrator/lifecycle/evidence-coverage-accumulator.js";
import type { CheckpointEvidenceCoverageV2 } from "../src/orchestrator/lifecycle/contracts/checkpoint.js";
import type { RecordEvidenceBatchCommandV2 } from "../src/orchestrator/lifecycle/contracts/commands.js";
import type { FinalEndingScopeBindingV1 } from "../src/orchestrator/lifecycle/contracts/session-end.js";
import type { ProjectContext } from "../src/orchestrator/identity/contracts.js";
import type { StoredEvent } from "../src/orchestrator/contracts/event.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { EvidenceCoverageRepository } from "../src/orchestrator/storage/evidence-coverage.repository.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import type {
  SqliteConnection,
  SqliteParams,
  SqliteStatement,
  SqliteValue,
} from "../src/orchestrator/storage/sqlite-driver.js";
import { applyCurrentProjectStoreSchema } from "./support/current-project-store-schema.js";

const NOW = "2026-07-27T00:00:00.000Z";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const VAULT_ID = "22222222-2222-4222-8222-222222222222";
const STORE_ID = "33333333-3333-4333-8333-333333333333";
const SESSION_ID = "44444444-4444-4444-8444-444444444444";
const ADAPTER_ID = "55555555-5555-4555-8555-555555555555";
const BATCH_ID = "66666666-6666-4666-8666-666666666666";
const FRAME_ID = "77777777-7777-4777-8777-777777777777";
const H64 = "a".repeat(64);
const FRAME_H64 = "b".repeat(64);
const roots: string[] = [];
const connections: SqliteConnection[] = [];

function database(): SqliteConnection {
  const root = mkdtempSync(join(tmpdir(), "evidence-coverage-"));
  roots.push(root);
  const connection = new NodeSqliteDriver({ DatabaseSync }).open(
    join(root, "events.sqlite"),
    { mode: "create", busyTimeoutMs: 1_000 },
  );
  connections.push(connection);
  applyCurrentProjectStoreSchema(connection, {
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
  }, NOW);
  connection.exec("PRAGMA foreign_keys = OFF");
  return connection;
}

function rawInsert(
  connection: SqliteConnection,
  table: string,
  values: Readonly<Record<string, SqliteValue>>,
): void {
  const columns = Object.keys(values);
  connection.prepare(`
    INSERT INTO ${table}(${columns.join(", ")})
    VALUES (${columns.map((column) => `$${column}`).join(", ")})
  `).run(Object.fromEntries(
    columns.map((column) => [`$${column}`, values[column]!]),
  ) as SqliteParams);
}

function repositoryTableCounts(
  connection: SqliteConnection,
): Readonly<Record<string, bigint>> {
  return Object.freeze(Object.fromEntries([
    "events",
    "session_evidence_coverage_transitions",
    "session_evidence_coverage_transition_heads",
    "session_evidence_coverage",
    "session_evidence_fingerprints",
  ].map((table) => [
    table,
    connection.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count as bigint,
  ])));
}

function indexedUuid(index: number): string {
  return `${index.toString(16).padStart(8, "0")}-0000-4000-8000-${index
    .toString(16)
    .padStart(12, "0")}`;
}

function endingBinding(index: number): FinalEndingScopeBindingV1 {
  return {
    bindingVersion: 1,
    bindingKind: "current-child",
    childSessionId: indexedUuid(200_000 + index) as never,
    childState: "active",
    lastEventPosition: "1",
    streamVersion: "1",
    checkpointId: null,
    checkpointEventPosition: null,
    transferTicketId: null,
    transferTicketEventPosition: null,
  };
}

function carryEndingBinding(index: number): FinalEndingScopeBindingV1 {
  return {
    bindingVersion: 1,
    bindingKind: "carry-forward-ticket",
    childSessionId: indexedUuid(400_000 + index) as never,
    childState: "transferred",
    lastEventPosition: "1",
    streamVersion: "1",
    checkpointId: indexedUuid(500_000 + index) as never,
    checkpointEventPosition: "1",
    transferTicketId: indexedUuid(600_000 + index) as never,
    transferTicketEventPosition: "1",
  };
}

function rawGenericSessionEvent(
  connection: SqliteConnection,
  globalPosition: bigint,
): void {
  const index = Number(globalPosition);
  rawInsert(connection, "events", {
    global_position: globalPosition,
    event_id: indexedUuid(10_000 + index),
    project_id: PROJECT_ID,
    vault_id: VAULT_ID,
    store_id: STORE_ID,
    workspace_id: "c".repeat(64),
    branch_scope_id: null,
    branch_ref: null,
    stream_id: `generic/${SESSION_ID}`,
    stream_type: "generic",
    stream_version: globalPosition,
    event_type: "GenericEvent",
    event_schema_version: 1,
    session_id: SESSION_ID,
    parent_session_id: null,
    actor_role: "primary",
    agent_id: "agent-1",
    client_instance_id: "client-1",
    correlation_id: indexedUuid(20_000 + index),
    causation_id: null,
    command_id: indexedUuid(30_000 + index),
    idempotency_key: `generic-${index}`,
    command_event_index: 0,
    occurred_at: NOW,
    recorded_at: NOW,
    visibility_scope: "session",
    confidence: "high",
    verification_status: "verified",
    source_refs_json: "[]",
    evidence_refs_json: "[]",
    evidence_digests_json: "[]",
    payload_json: "{}",
    payload_hash: H64,
    previous_global_hash: "0".repeat(64),
    event_hash: H64,
    lifecycle_intent_json: null,
  });
}

function seedAuthorityForForeignKeys(
  connection: SqliteConnection,
  eventPosition: bigint,
  latestCheckpoint = false,
): void {
  rawInsert(connection, "streams", {
    project_id: PROJECT_ID,
    stream_id: `session/${SESSION_ID}`,
    stream_type: "session",
    current_version: 1n,
    created_at: NOW,
    updated_at: NOW,
  });
  connection.exec("DROP TRIGGER session_authority_insert_guard");
  const authority: Record<string, SqliteValue> = {
    project_id: PROJECT_ID,
    session_id: SESSION_ID,
    stream_id: `session/${SESSION_ID}`,
    session_kind: "root",
    parent_session_id: null,
    workspace_id: "c".repeat(64),
    client_namespace: "client-1",
    semantic_state: "active",
    owner_generation: 1n,
    child_capability_generation: 1n,
    direct_access_enabled: 0n,
    authority_commitment: "f".repeat(64),
    authority_event_position: eventPosition,
    created_at: NOW,
    updated_at: NOW,
  };
  if (latestCheckpoint) {
    authority.latest_checkpoint_id = indexedUuid(400_001);
    authority.latest_checkpoint_event_position = eventPosition;
    authority.latest_checkpoint_fingerprint = "e".repeat(64);
  }
  rawInsert(connection, "session_authority", authority);
}

function faultingConnection(
  connection: SqliteConnection,
  sqlMarker: string,
): SqliteConnection {
  let injected = false;
  return {
    exec(sql) {
      connection.exec(sql);
    },
    prepare(sql) {
      const statement = connection.prepare(sql);
      const wrapped: SqliteStatement = {
        run(params) {
          if (!injected && sql.includes(sqlMarker)) {
            injected = true;
            throw new Error(`injected:${sqlMarker}`);
          }
          return statement.run(params);
        },
        get(params) {
          return statement.get(params);
        },
        all(params) {
          return statement.all(params);
        },
        iterate(params) {
          return statement.iterate(params);
        },
      };
      return wrapped;
    },
    close() {
      connection.close();
    },
  };
}

function context(): ProjectContext {
  return {
    binding: {
      projectId: PROJECT_ID,
      vaultId: VAULT_ID,
      storeId: STORE_ID,
    },
  } as ProjectContext;
}

function command(
  overrides: Partial<RecordEvidenceBatchCommandV2> = {},
): RecordEvidenceBatchCommandV2 {
  return {
    commandType: "record-evidence-batch",
    commandId: "88888888-8888-4888-8888-888888888888",
    idempotencyKey: "evidence-batch-1",
    agentId: "agent-1",
    expectedProjectId: PROJECT_ID as never,
    expectedVaultId: VAULT_ID as never,
    expectedWorkspaceId: "c".repeat(64) as never,
    expectedBranchRef: null,
    adapterSessionId: ADAPTER_ID as never,
    batchId: BATCH_ID as never,
    sessionId: SESSION_ID as never,
    firstOrdinal: "5",
    lastOrdinal: "5",
    fingerprintSchemaVersion: 1,
    fingerprintKeyId: "key-1",
    fingerprintDomain: "pm-evidence-frame-v1",
    redactionStatus: "content-not-retained",
    frames: [{
      frameId: FRAME_ID as never,
      ordinal: "5",
      sourceKind: "model-turn",
      observedAt: NOW,
      contentFingerprint: FRAME_H64,
    }],
    ...overrides,
  };
}

interface ProviderRecorder {
  readonly provider: {
    currentKey(
      scope: { projectId: string; storeId: string },
      purpose: "evidence-fingerprint",
    ): { keyId: string };
    status(
      scope: { projectId: string; storeId: string },
      purpose: "evidence-fingerprint",
      keyId: string,
    ): "available" | "revoked" | "unavailable";
    fingerprint(input: {
      projectId: string;
      storeId: string;
      purpose: "evidence-fingerprint";
      keyId: string;
      domain: string;
      bytes: Uint8Array;
    }): string;
  };
  readonly calls: { currentKey: number; status: number; fingerprint: number };
  readonly statusInputs: {
    scope: { projectId: string; storeId: string };
    purpose: string;
    keyId: string;
  }[];
  readonly fingerprintInputs: {
    projectId: string;
    storeId: string;
    purpose: string;
    keyId: string;
    domain: string;
    bytes: Uint8Array;
    body: unknown;
  }[];
}

function providerRecorder(
  fingerprintFailure?: Error,
  statusResult: "available" | "revoked" | "unavailable" = "available",
  currentKeyId = "key-1",
): ProviderRecorder {
  const calls = { currentKey: 0, status: 0, fingerprint: 0 };
  const statusInputs: ProviderRecorder["statusInputs"][number][] = [];
  const fingerprintInputs: ProviderRecorder["fingerprintInputs"][number][] = [];
  return {
    calls,
    statusInputs,
    fingerprintInputs,
    provider: {
      currentKey(scope, purpose) {
        calls.currentKey += 1;
        assert.deepEqual(scope, { projectId: PROJECT_ID, storeId: STORE_ID });
        assert.equal(purpose, "evidence-fingerprint");
        return { keyId: currentKeyId };
      },
      status(scope, purpose, keyId) {
        calls.status += 1;
        statusInputs.push({ scope, purpose, keyId });
        return statusResult;
      },
      fingerprint(input) {
        calls.fingerprint += 1;
        fingerprintInputs.push({
          ...input,
          bytes: input.bytes,
          body: JSON.parse(Buffer.from(input.bytes).toString("utf8")),
        });
        if (fingerprintFailure !== undefined) throw fingerprintFailure;
        return H64;
      },
    },
  };
}

function isDeepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every(isDeepFrozen);
}

function storedEvent(
  connection: SqliteConnection,
  payload: Readonly<Record<string, unknown>>,
  overrides: Partial<StoredEvent> = {},
): StoredEvent {
  const payloadJson = canonicalJson(payload);
  const globalPosition = overrides.globalPosition ?? 1n;
  const sessionId = overrides.sessionId ?? SESSION_ID;
  const streamId = overrides.streamId ?? `session/${sessionId}`;
  const eventId = overrides.eventId
    ?? (globalPosition === 1n
      ? "99999999-9999-4999-8999-999999999999"
      : "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2");
  const commandId = overrides.commandId
    ?? "88888888-8888-4888-8888-888888888888";
  const idempotencyKey = overrides.idempotencyKey ?? "evidence-batch-1";
  const streamVersion = overrides.streamVersion ?? globalPosition;
  rawInsert(connection, "events", {
    global_position: globalPosition,
    event_id: eventId,
    project_id: PROJECT_ID,
    vault_id: VAULT_ID,
    store_id: STORE_ID,
    workspace_id: "c".repeat(64),
    branch_scope_id: null,
    branch_ref: null,
    stream_id: streamId,
    stream_type: "session",
    stream_version: streamVersion,
    event_type: "EvidenceCoverageRecorded",
    event_schema_version: 2,
    session_id: sessionId,
    parent_session_id: null,
    actor_role: "primary",
    agent_id: "agent-1",
    client_instance_id: "client-1",
    correlation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    causation_id: null,
    command_id: commandId,
    idempotency_key: idempotencyKey,
    command_event_index: 0,
    occurred_at: NOW,
    recorded_at: NOW,
    visibility_scope: "session",
    confidence: "high",
    verification_status: "verified",
    source_refs_json: "[]",
    evidence_refs_json: "[]",
    evidence_digests_json: "[]",
    payload_json: payloadJson,
    payload_hash: H64,
    previous_global_hash: "0".repeat(64),
    event_hash: H64,
    lifecycle_intent_json: null,
  });
  return {
    globalPosition,
    eventId,
    projectId: PROJECT_ID as never,
    vaultId: VAULT_ID as never,
    storeId: STORE_ID as never,
    workspaceId: "c".repeat(64) as never,
    branchScopeId: null,
    branchRef: null,
    streamId,
    streamType: "session",
    streamVersion,
    eventType: "EvidenceCoverageRecorded",
    eventSchemaVersion: 2,
    sessionId,
    parentSessionId: null,
    actorRole: "primary",
    agentId: "agent-1",
    clientInstanceId: "client-1",
    correlationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    causationId: null,
    commandId,
    idempotencyKey,
    commandEventIndex: 0,
    occurredAt: NOW,
    recordedAt: NOW,
    visibilityScope: "session",
    confidence: "high",
    verificationStatus: "verified",
    sourceRefs: [],
    evidenceRefs: [],
    evidenceDigests: [],
    payload: payload as never,
    payloadJson,
    payloadHash: H64,
    previousGlobalHash: "0".repeat(64),
    eventHash: H64,
    lifecycleIntentJson: null,
    ...overrides,
  };
}

afterEach(() => {
  while (connections.length > 0) connections.pop()!.close();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("evidence coverage accumulator", () => {
  it("advances one adapter accumulator without rescanning historical ordinals", () => {
    const firstAboveZero = advanceEvidenceCoverageIntervals({
      priorCoverageLastOrdinal: null,
      priorMissingIntervals: [],
      newOrdinals: [5n],
    });

    assert.equal(firstAboveZero.coverageLastOrdinal, "5");
    assert.equal(firstAboveZero.highestContiguousOrdinal, null);
    assert.deepEqual(firstAboveZero.missingIntervals, [
      { firstOrdinal: "0", lastOrdinal: "4" },
    ]);

    const gapFill = advanceEvidenceCoverageIntervals({
      priorCoverageLastOrdinal: 5n,
      priorMissingIntervals: [{ firstOrdinal: 0n, lastOrdinal: 4n }],
      newOrdinals: [0n, 2n, 1n],
    });

    assert.equal(gapFill.coverageLastOrdinal, "5");
    assert.equal(gapFill.highestContiguousOrdinal, "2");
    assert.deepEqual(gapFill.missingIntervals, [
      { firstOrdinal: "3", lastOrdinal: "4" },
    ]);
  });

  it("handles bigint adjacency without converting ordinals to numbers", () => {
    const maximum = 9_223_372_036_854_775_807n;
    const result = advanceEvidenceCoverageIntervals({
      priorCoverageLastOrdinal: maximum - 2n,
      priorMissingIntervals: [{
        firstOrdinal: maximum - 2n,
        lastOrdinal: maximum - 2n,
      }],
      newOrdinals: [maximum - 2n, maximum],
    });

    assert.equal(result.coverageLastOrdinal, maximum.toString());
    assert.deepEqual(result.missingIntervals, [{
      firstOrdinal: (maximum - 1n).toString(),
      lastOrdinal: (maximum - 1n).toString(),
    }]);
  });

  it("preserves a bounded interval projection when a batch adds no ordinals", () => {
    const result = advanceEvidenceCoverageIntervals({
      priorCoverageLastOrdinal: 9n,
      priorMissingIntervals: [
        { firstOrdinal: 2n, lastOrdinal: 3n },
        { firstOrdinal: 7n, lastOrdinal: 8n },
      ],
      newOrdinals: [],
    });

    assert.equal(result.coverageLastOrdinal, "9");
    assert.equal(result.highestContiguousOrdinal, "1");
    assert.deepEqual(result.missingIntervals, [
      { firstOrdinal: "2", lastOrdinal: "3" },
      { firstOrdinal: "7", lastOrdinal: "8" },
    ]);
  });

  it("rejects adapter interval and byte limits before provider work", () => {
    const emptyCoverage: CheckpointEvidenceCoverageV2 = {
      coverageVersion: 2,
      captureMode: "coverage-only",
      contentRetained: false,
      adapterSessions: [],
    };

    assert.throws(
      () => assertEvidenceCoverageProjectionBounds({
        prospectiveAdapterCount: 201,
        prospectiveTotalIntervalCount: 0,
        targetIntervalCount: 0,
        evidenceCoverage: emptyCoverage,
      }),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "EVIDENCE_ADAPTER_SESSION_LIMIT"
      ),
    );

    assert.throws(
      () => assertEvidenceCoverageProjectionBounds({
        prospectiveAdapterCount: 1,
        prospectiveTotalIntervalCount: 201,
        targetIntervalCount: 201,
        evidenceCoverage: emptyCoverage,
      }),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "EVIDENCE_COVERAGE_TOO_FRAGMENTED"
      ),
    );

    const oversizedCoverage: CheckpointEvidenceCoverageV2 = {
      ...emptyCoverage,
      adapterSessions: [{
        adapterSessionId: "11111111-1111-4111-8111-111111111111" as never,
        coverageFirstOrdinal: "0",
        coverageLastOrdinal: "0",
        highestContiguousOrdinal: "0",
        missingIntervals: [],
        frameFingerprintAlgorithm: "hmac-sha256",
        frameFingerprintSchemaVersion: 1,
        frameFingerprintKeyId: "x".repeat(196_608),
        frameFingerprintDomain: "pm-evidence-frame-v1",
        coverageFingerprintAlgorithm: "hmac-sha256",
        coverageFingerprintSchemaVersion: 1,
        coverageFingerprintKeyId: "x".repeat(196_608),
        coverageFingerprintDomain: "pm-evidence-coverage-v1",
        coverageFingerprint: "a".repeat(64),
        latestBatchId: "22222222-2222-4222-8222-222222222222" as never,
        latestBatchEventPosition: "1",
      }],
    };
    assert.throws(
      () => assertEvidenceCoverageProjectionBounds({
        prospectiveAdapterCount: 1,
        prospectiveTotalIntervalCount: 0,
        targetIntervalCount: 0,
        evidenceCoverage: oversizedCoverage,
      }),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "EVIDENCE_COVERAGE_SNAPSHOT_TOO_LARGE"
      ),
    );
  });
});

describe("evidence coverage repository", () => {
  it("prepares a deeply frozen authenticated first batch with exact provider framing", () => {
    const connection = database();
    const recorder = providerRecorder();
    const repository = new EvidenceCoverageRepository(recorder.provider);

    const prepared = repository.prepareBatch(connection, {
      context: context(),
      command: command(),
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: null,
    });

    assert.equal(recorder.calls.currentKey, 1);
    assert.equal(recorder.calls.status, 0);
    assert.equal(recorder.calls.fingerprint, 1);
    assert.equal(isDeepFrozen(prepared), true);
    assert.equal(prepared.previousCoverageFingerprint, null);
    assert.deepEqual(prepared.newFrames, command().frames);
    assert.deepEqual(prepared.eventPayload.missingIntervals, [{
      firstOrdinal: "0",
      lastOrdinal: "4",
    }]);
    assert.equal(prepared.eventPayload.highestContiguousOrdinal, null);
    assert.equal(prepared.eventPayload.coverageLastOrdinal, "5");

    const providerInput = recorder.fingerprintInputs[0]!;
    assert.deepEqual(
      {
        projectId: providerInput.projectId,
        storeId: providerInput.storeId,
        purpose: providerInput.purpose,
        keyId: providerInput.keyId,
        domain: providerInput.domain,
      },
      {
        projectId: PROJECT_ID,
        storeId: STORE_ID,
        purpose: "evidence-fingerprint",
        keyId: "key-1",
        domain: "pm-evidence-coverage-v1",
      },
    );
    assert.deepEqual(providerInput.body, {
      coverageAccumulatorVersion: 1,
      projectId: PROJECT_ID,
      storeId: STORE_ID,
      sessionId: SESSION_ID,
      adapterSessionId: ADAPTER_ID,
      previousCoverageFingerprint: null,
      captureMode: "coverage-only",
      contentRetained: false,
      frameFingerprintProfile: {
        algorithm: "hmac-sha256",
        schemaVersion: 1,
        keyId: "key-1",
        domain: "pm-evidence-frame-v1",
      },
      coverageFingerprintProfile: {
        algorithm: "hmac-sha256",
        schemaVersion: 1,
        keyId: "key-1",
        domain: "pm-evidence-coverage-v1",
      },
      coverageFirstOrdinal: "0",
      coverageLastOrdinal: "5",
      highestContiguousOrdinal: null,
      missingIntervals: [{ firstOrdinal: "0", lastOrdinal: "4" }],
      newFrames: command().frames,
    });
    assert.equal(providerInput.bytes.every((byte) => byte === 0), true);
  });

  it("matches a fixed rolling HMAC vector and remains history-sensitive", () => {
    const capturedBodies: string[] = [];
    const provider = {
      currentKey() {
        return { keyId: "key-1" };
      },
      status() {
        return "available" as const;
      },
      fingerprint(input: {
        domain: string;
        bytes: Uint8Array;
      }) {
        const body = Buffer.from(input.bytes);
        capturedBodies.push(body.toString("utf8"));
        return createHmac("sha256", "task-12c-fixed-key")
          .update(Buffer.from(input.domain, "utf8"))
          .update(Buffer.from([0]))
          .update(body)
          .digest("hex");
      },
    };
    const firstConnection = database();
    const firstRepository = new EvidenceCoverageRepository(provider);
    const fixed = firstRepository.prepareBatch(firstConnection, {
      context: context(),
      command: command(),
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: 1n,
    });
    assert.equal(
      fixed.eventPayload.coverageFingerprint,
      "264ab9b80bbb9e89c18f61f559f4703c2e903724dac031783ba16cbdcfe82f34",
    );
    assert.equal(capturedBodies[0]!.startsWith("{"), true);
    assert.equal(capturedBodies[0]!.endsWith("}"), true);
    assert.equal(capturedBodies[0]!.includes("\n"), false);

    const togetherConnection = database();
    const togetherRepository = new EvidenceCoverageRepository(provider);
    const frames = [
      {
        frameId: indexedUuid(90_001) as never,
        ordinal: "0",
        sourceKind: "model-turn" as const,
        observedAt: NOW,
        contentFingerprint: "1".repeat(64),
      },
      {
        frameId: indexedUuid(90_002) as never,
        ordinal: "1",
        sourceKind: "tool-result" as const,
        observedAt: NOW,
        contentFingerprint: "2".repeat(64),
      },
    ];
    const together = togetherRepository.prepareBatch(togetherConnection, {
      context: context(),
      command: command({
        commandId: indexedUuid(90_003),
        idempotencyKey: "history-together",
        batchId: indexedUuid(90_004) as never,
        firstOrdinal: "0",
        lastOrdinal: "1",
        frames,
      }),
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: 1n,
    });

    const splitConnection = database();
    const splitRepository = new EvidenceCoverageRepository(provider);
    const splitFirstCommand = command({
      commandId: indexedUuid(90_005),
      idempotencyKey: "history-split-1",
      batchId: indexedUuid(90_006) as never,
      firstOrdinal: "0",
      lastOrdinal: "0",
      frames: [frames[0]!],
    });
    const splitFirst = splitRepository.prepareBatch(splitConnection, {
      context: context(),
      command: splitFirstCommand,
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: 1n,
    });
    splitRepository.persistPrepared(
      splitConnection,
      splitFirst,
      storedEvent(
        splitConnection,
        splitFirst.eventPayload as unknown as Readonly<Record<string, unknown>>,
        {
          commandId: splitFirstCommand.commandId,
          idempotencyKey: splitFirstCommand.idempotencyKey,
        },
      ),
    );
    const splitSecond = splitRepository.prepareBatch(splitConnection, {
      context: context(),
      command: command({
        commandId: indexedUuid(90_007),
        idempotencyKey: "history-split-2",
        batchId: indexedUuid(90_008) as never,
        firstOrdinal: "1",
        lastOrdinal: "1",
        frames: [frames[1]!],
      }),
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: 2n,
    });
    assert.notEqual(
      together.eventPayload.coverageFingerprint,
      splitSecond.eventPayload.coverageFingerprint,
    );
  });

  it("zeroizes only caller-owned canonical bytes when fingerprinting fails", () => {
    const connection = database();
    const recorder = providerRecorder(new Error("provider unavailable"));
    const repository = new EvidenceCoverageRepository(recorder.provider);

    assert.throws(
      () => repository.prepareBatch(connection, {
        context: context(),
        command: command(),
        prospectiveEndingScopeBindings: [],
        plannedEventPosition: 1n,
      }),
      /provider unavailable/,
    );
    assert.equal(recorder.fingerprintInputs.length, 1);
    assert.equal(
      recorder.fingerprintInputs[0]!.bytes.every((byte) => byte === 0),
      true,
    );
  });

  it("persists transition aggregate and ordinal rows bound to the committed event", () => {
    const connection = database();
    const recorder = providerRecorder();
    const repository = new EvidenceCoverageRepository(recorder.provider);
    const prepared = repository.prepareBatch(connection, {
      context: context(),
      command: command(),
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: 1n,
    });
    const committed = storedEvent(
      connection,
      prepared.eventPayload as unknown as Readonly<Record<string, unknown>>,
    );

    repository.persistPrepared(connection, prepared, committed);

    assert.equal(
      connection.prepare("SELECT count(*) AS count FROM session_evidence_coverage_transitions")
        .get()!.count,
      1n,
    );
    assert.equal(
      connection.prepare("SELECT count(*) AS count FROM session_evidence_coverage")
        .get()!.count,
      1n,
    );
    assert.equal(
      connection.prepare("SELECT count(*) AS count FROM session_evidence_fingerprints")
        .get()!.count,
      1n,
    );
    const snapshot = repository.snapshotV2(
      connection,
      SESSION_ID as never,
      committed.globalPosition,
    );
    assert.deepEqual(snapshot.adapterSessions, [{
      adapterSessionId: ADAPTER_ID,
      coverageFirstOrdinal: "0",
      coverageLastOrdinal: "5",
      highestContiguousOrdinal: null,
      missingIntervals: [{ firstOrdinal: "0", lastOrdinal: "4" }],
      frameFingerprintAlgorithm: "hmac-sha256",
      frameFingerprintSchemaVersion: 1,
      frameFingerprintKeyId: "key-1",
      frameFingerprintDomain: "pm-evidence-frame-v1",
      coverageFingerprintAlgorithm: "hmac-sha256",
      coverageFingerprintSchemaVersion: 1,
      coverageFingerprintKeyId: "key-1",
      coverageFingerprintDomain: "pm-evidence-coverage-v1",
      coverageFingerprint: H64,
      latestBatchId: BATCH_ID,
      latestBatchEventPosition: "1",
    }]);
    assert.deepEqual(
      repository.snapshotFromTransitionsV2(
        connection,
        SESSION_ID as never,
        committed.globalPosition,
      ),
      snapshot,
    );
    assert.throws(
      () => repository.assertVersion1Eligible(connection, [SESSION_ID as never]),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "CHECKPOINT_EVIDENCE_VERSION_REQUIRED"
      ),
    );
  });

  it("uses the recorded profile and fingerprints only genuinely new overlap frames", () => {
    const connection = database();
    const recorder = providerRecorder();
    const repository = new EvidenceCoverageRepository(recorder.provider);
    const first = repository.prepareBatch(connection, {
      context: context(),
      command: command(),
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: 1n,
    });
    repository.persistPrepared(
      connection,
      first,
      storedEvent(
        connection,
        first.eventPayload as unknown as Readonly<Record<string, unknown>>,
      ),
    );

    const secondCommand = command({
      commandId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      idempotencyKey: "evidence-batch-2",
      batchId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as never,
      firstOrdinal: "5",
      lastOrdinal: "6",
      frames: [
        command().frames[0]!,
        {
          frameId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" as never,
          ordinal: "6",
          sourceKind: "tool-result",
          observedAt: NOW,
          contentFingerprint: "d".repeat(64),
        },
      ],
    });
    const second = repository.prepareBatch(connection, {
      context: context(),
      command: secondCommand,
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: 2n,
    });

    assert.equal(recorder.calls.currentKey, 1);
    assert.equal(recorder.calls.status, 1);
    assert.equal(recorder.calls.fingerprint, 2);
    assert.deepEqual(second.newFrames, [secondCommand.frames[1]]);
    assert.equal(second.previousCoverageFingerprint, H64);
    assert.deepEqual(
      (recorder.fingerprintInputs[1]!.body as {
        newFrames: readonly unknown[];
      }).newFrames,
      [secondCommand.frames[1]],
    );
    repository.persistPrepared(
      connection,
      second,
      storedEvent(
        connection,
        second.eventPayload as unknown as Readonly<Record<string, unknown>>,
        {
          globalPosition: 2n,
          commandId: secondCommand.commandId,
          idempotencyKey: secondCommand.idempotencyKey,
          streamVersion: 2n,
        },
      ),
    );

    const callsBeforeZeroNew = { ...recorder.calls };
    const zeroNewCommand = command({
      commandId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      idempotencyKey: "evidence-batch-3",
      batchId: "ffffffff-ffff-4fff-bfff-ffffffffffff" as never,
    });
    const zeroNew = repository.prepareBatch(connection, {
      context: context(),
      command: zeroNewCommand,
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: 3n,
    });
    assert.equal(recorder.calls.currentKey, callsBeforeZeroNew.currentKey);
    assert.equal(recorder.calls.status, callsBeforeZeroNew.status + 1);
    assert.equal(recorder.calls.fingerprint, callsBeforeZeroNew.fingerprint);
    assert.equal(zeroNew.eventPayload.coverageFingerprint, second.eventPayload.coverageFingerprint);
    assert.deepEqual(zeroNew.newFrames, []);

    const callsBeforeContradiction = { ...recorder.calls };
    assert.throws(
      () => repository.prepareBatch(connection, {
        context: context(),
        command: command({
          commandId: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          idempotencyKey: "evidence-contradiction",
          batchId: "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as never,
          frames: [{
            ...command().frames[0]!,
            contentFingerprint: "e".repeat(64),
          }],
        }),
        prospectiveEndingScopeBindings: [],
        plannedEventPosition: 3n,
      }),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "LIFECYCLE_INPUT_INVALID"
      ),
    );
    assert.deepEqual(recorder.calls, callsBeforeContradiction);
  });

  it("rolls back the event and every first-batch repository boundary fault", () => {
    const boundaries = [
      "INSERT INTO session_evidence_coverage_transitions",
      "INSERT INTO session_evidence_coverage(",
      "INSERT INTO session_evidence_fingerprints",
    ] as const;
    for (const boundary of boundaries) {
      const connection = database();
      const repository = new EvidenceCoverageRepository(providerRecorder().provider);
      const prepared = repository.prepareBatch(connection, {
        context: context(),
        command: command(),
        prospectiveEndingScopeBindings: [],
        plannedEventPosition: 1n,
      });
      connection.exec("BEGIN IMMEDIATE");
      const committed = storedEvent(
        connection,
        prepared.eventPayload as unknown as Readonly<Record<string, unknown>>,
      );
      assert.throws(
        () => repository.persistPrepared(
          faultingConnection(connection, boundary),
          prepared,
          committed,
        ),
        new RegExp(`injected:${boundary.replace(/[()]/g, "\\$&")}`),
      );
      connection.exec("ROLLBACK");

      for (const table of [
        "events",
        "session_evidence_coverage_transitions",
        "session_evidence_coverage_transition_heads",
        "session_evidence_coverage",
        "session_evidence_fingerprints",
      ]) {
        assert.equal(
          connection.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count,
          0n,
          `${boundary} left a row in ${table}`,
        );
      }
    }
  });

  it("rolls back every later-batch repository boundary fault", () => {
    const boundaries = [
      "INSERT INTO session_evidence_coverage_transitions",
      "UPDATE session_evidence_coverage SET",
      "INSERT INTO session_evidence_fingerprints",
    ] as const;
    for (const boundary of boundaries) {
      const connection = database();
      const repository = new EvidenceCoverageRepository(providerRecorder().provider);
      const first = repository.prepareBatch(connection, {
        context: context(),
        command: command(),
        prospectiveEndingScopeBindings: [],
        plannedEventPosition: 1n,
      });
      repository.persistPrepared(
        connection,
        first,
        storedEvent(
          connection,
          first.eventPayload as unknown as Readonly<Record<string, unknown>>,
        ),
      );
      const laterCommand = command({
        commandId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        idempotencyKey: "later-batch",
        batchId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as never,
        firstOrdinal: "6",
        lastOrdinal: "6",
        frames: [{
          frameId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" as never,
          ordinal: "6",
          sourceKind: "tool-result",
          observedAt: NOW,
          contentFingerprint: "d".repeat(64),
        }],
      });
      const later = repository.prepareBatch(connection, {
        context: context(),
        command: laterCommand,
        prospectiveEndingScopeBindings: [],
        plannedEventPosition: 2n,
      });
      connection.exec("BEGIN IMMEDIATE");
      const committed = storedEvent(
        connection,
        later.eventPayload as unknown as Readonly<Record<string, unknown>>,
        {
          globalPosition: 2n,
          commandId: laterCommand.commandId,
          idempotencyKey: laterCommand.idempotencyKey,
          streamVersion: 2n,
        },
      );
      assert.throws(
        () => repository.persistPrepared(
          faultingConnection(connection, boundary),
          later,
          committed,
        ),
        new RegExp(`injected:${boundary.replace(/[()]/g, "\\$&")}`),
      );
      connection.exec("ROLLBACK");

      assert.equal(
        connection.prepare("SELECT count(*) AS count FROM events").get()!.count,
        1n,
      );
      assert.equal(
        connection.prepare(
          "SELECT count(*) AS count FROM session_evidence_coverage_transitions",
        ).get()!.count,
        1n,
      );
      assert.equal(
        connection.prepare("SELECT count(*) AS count FROM session_evidence_coverage")
          .get()!.count,
        1n,
      );
      assert.equal(
        connection.prepare(
          "SELECT count(*) AS count FROM session_evidence_coverage_transition_heads",
        ).get()!.count,
        1n,
      );
      assert.equal(
        connection.prepare("SELECT count(*) AS count FROM session_evidence_fingerprints")
          .get()!.count,
        1n,
      );
      assert.equal(
        connection.prepare(
          "SELECT latest_batch_event_position FROM session_evidence_coverage",
        ).get()!.latest_batch_event_position,
        1n,
      );
    }
  });

  it("rejects unbranded and event-mismatched persistence plans", () => {
    const connection = database();
    const recorder = providerRecorder();
    const repository = new EvidenceCoverageRepository(recorder.provider);
    const prepared = repository.prepareBatch(connection, {
      context: context(),
      command: command(),
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: 1n,
    });
    const committed = storedEvent(
      connection,
      prepared.eventPayload as unknown as Readonly<Record<string, unknown>>,
    );

    assert.throws(
      () => repository.persistPrepared(
        connection,
        { ...prepared } as typeof prepared,
        committed,
      ),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "INTEGRITY_FAILURE"
      ),
    );
    assert.throws(
      () => repository.persistPrepared(
        connection,
        prepared,
        { ...committed, sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      ),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "INTEGRITY_FAILURE"
      ),
    );
  });

  it("rejects the complete committed-event and prior-CAS mismatch matrix", () => {
    const prepareFirst = (
      plannedEventPosition: bigint | null = 1n,
    ): {
      connection: SqliteConnection;
      repository: EvidenceCoverageRepository;
      prepared: ReturnType<EvidenceCoverageRepository["prepareBatch"]>;
    } => {
      const connection = database();
      const repository = new EvidenceCoverageRepository(providerRecorder().provider);
      const prepared = repository.prepareBatch(connection, {
        context: context(),
        command: command(),
        prospectiveEndingScopeBindings: [],
        plannedEventPosition,
      });
      return { connection, repository, prepared };
    };
    const expectIntegrity = (operation: () => void): void => {
      assert.throws(
        operation,
        (error: unknown) => (
          error instanceof Error
          && "code" in error
          && error.code === "INTEGRITY_FAILURE"
        ),
      );
    };

    {
      const { connection, repository, prepared } = prepareFirst();
      const committed = storedEvent(
        connection,
        prepared.eventPayload as unknown as Readonly<Record<string, unknown>>,
      );
      connection.exec("DROP TRIGGER events_no_delete");
      connection.prepare("DELETE FROM events WHERE global_position = 1").run();
      expectIntegrity(() => repository.persistPrepared(connection, prepared, committed));
    }
    {
      const { connection, repository, prepared } = prepareFirst(2n);
      const committed = storedEvent(
        connection,
        prepared.eventPayload as unknown as Readonly<Record<string, unknown>>,
      );
      expectIntegrity(() => repository.persistPrepared(connection, prepared, committed));
    }
    for (const overrides of [
      { projectId: indexedUuid(91_001) },
      { storeId: indexedUuid(91_002) },
      { sessionId: indexedUuid(91_003) },
    ]) {
      const { connection, repository, prepared } = prepareFirst();
      const committed = storedEvent(
        connection,
        prepared.eventPayload as unknown as Readonly<Record<string, unknown>>,
      );
      expectIntegrity(() => repository.persistPrepared(
        connection,
        prepared,
        { ...committed, ...overrides } as StoredEvent,
      ));
    }
    for (const mutate of [
      (payload: Record<string, unknown>) => {
        payload.batchId = indexedUuid(91_004);
      },
      (payload: Record<string, unknown>) => {
        payload.coverageLastOrdinal = "6";
      },
    ]) {
      const { connection, repository, prepared } = prepareFirst();
      const payload = structuredClone(
        prepared.eventPayload,
      ) as unknown as Record<string, unknown>;
      mutate(payload);
      const committed = storedEvent(connection, payload);
      expectIntegrity(() => repository.persistPrepared(connection, prepared, committed));
    }
    {
      const { connection, repository, prepared } = prepareFirst();
      const committed = storedEvent(
        connection,
        prepared.eventPayload as unknown as Readonly<Record<string, unknown>>,
      );
      connection.exec("DROP TRIGGER events_no_update");
      connection.prepare(`
        UPDATE events SET payload_json = '{}'
        WHERE global_position = 1
      `).run();
      expectIntegrity(() => repository.persistPrepared(connection, prepared, committed));
    }
    for (const drift of ["digest", "position"] as const) {
      const connection = database();
      const repository = new EvidenceCoverageRepository(providerRecorder().provider);
      const first = repository.prepareBatch(connection, {
        context: context(),
        command: command(),
        prospectiveEndingScopeBindings: [],
        plannedEventPosition: 1n,
      });
      repository.persistPrepared(
        connection,
        first,
        storedEvent(
          connection,
          first.eventPayload as unknown as Readonly<Record<string, unknown>>,
        ),
      );
      const laterCommand = command({
        commandId: indexedUuid(91_005),
        idempotencyKey: "cas-drift",
        batchId: indexedUuid(91_006) as never,
        firstOrdinal: "6",
        lastOrdinal: "6",
        frames: [{
          frameId: indexedUuid(91_007) as never,
          ordinal: "6",
          sourceKind: "tool-result",
          observedAt: NOW,
          contentFingerprint: "d".repeat(64),
        }],
      });
      const later = repository.prepareBatch(connection, {
        context: context(),
        command: laterCommand,
        prospectiveEndingScopeBindings: [],
        plannedEventPosition: 2n,
      });
      const committed = storedEvent(
        connection,
        later.eventPayload as unknown as Readonly<Record<string, unknown>>,
        {
          globalPosition: 2n,
          eventId: indexedUuid(91_008),
          commandId: laterCommand.commandId,
          idempotencyKey: laterCommand.idempotencyKey,
          streamVersion: 2n,
        },
      );
      connection.exec("DROP TRIGGER session_evidence_coverage_v3_update_guard");
      if (drift === "digest") {
        connection.prepare(`
          UPDATE session_evidence_coverage
          SET coverage_fingerprint_value = $digest
        `).run({ $digest: "c".repeat(64) });
      } else {
        connection.prepare(`
          UPDATE session_evidence_coverage
          SET latest_batch_event_position = 99
        `).run();
      }
      const stateBeforeRejectedPersist = repositoryTableCounts(connection);
      expectIntegrity(() => repository.persistPrepared(connection, later, committed));
      assert.deepEqual(
        repositoryTableCounts(connection),
        stateBeforeRejectedPersist,
      );
    }
  });

  it("separates current and historical snapshots across ordered independent adapters", () => {
    const connection = database();
    const repository = new EvidenceCoverageRepository(providerRecorder().provider);
    const adapterB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const adapterA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const record = (
      batchCommand: RecordEvidenceBatchCommandV2,
      position: bigint,
      streamVersion: bigint,
    ): void => {
      const prepared = repository.prepareBatch(connection, {
        context: context(),
        command: batchCommand,
        prospectiveEndingScopeBindings: [],
        plannedEventPosition: position,
      });
      repository.persistPrepared(
        connection,
        prepared,
        storedEvent(
          connection,
          prepared.eventPayload as unknown as Readonly<Record<string, unknown>>,
          {
            globalPosition: position,
            eventId: indexedUuid(92_000 + Number(position)),
            commandId: batchCommand.commandId,
            idempotencyKey: batchCommand.idempotencyKey,
            streamVersion,
          },
        ),
      );
    };
    record(command({
      commandId: indexedUuid(92_010),
      idempotencyKey: "adapter-b-1",
      adapterSessionId: adapterB as never,
      batchId: indexedUuid(92_011) as never,
      firstOrdinal: "0",
      lastOrdinal: "0",
      frames: [{
        frameId: indexedUuid(92_012) as never,
        ordinal: "0",
        sourceKind: "model-turn",
        observedAt: NOW,
        contentFingerprint: "1".repeat(64),
      }],
    }), 1n, 1n);
    record(command({
      commandId: indexedUuid(92_020),
      idempotencyKey: "adapter-a-1",
      adapterSessionId: adapterA as never,
      batchId: indexedUuid(92_021) as never,
      firstOrdinal: "0",
      lastOrdinal: "0",
      frames: [{
        frameId: indexedUuid(92_022) as never,
        ordinal: "0",
        sourceKind: "tool-request",
        observedAt: NOW,
        contentFingerprint: "2".repeat(64),
      }],
    }), 2n, 2n);
    record(command({
      commandId: indexedUuid(92_030),
      idempotencyKey: "adapter-b-2",
      adapterSessionId: adapterB as never,
      batchId: indexedUuid(92_031) as never,
      firstOrdinal: "1",
      lastOrdinal: "1",
      frames: [{
        frameId: indexedUuid(92_032) as never,
        ordinal: "1",
        sourceKind: "tool-result",
        observedAt: NOW,
        contentFingerprint: "3".repeat(64),
      }],
    }), 3n, 3n);

    const historical = repository.snapshotFromTransitionsV2(
      connection,
      SESSION_ID as never,
      2n,
    );
    assert.deepEqual(
      historical.adapterSessions.map((entry) => entry.adapterSessionId),
      [adapterA, adapterB],
    );
    assert.deepEqual(
      historical.adapterSessions.map((entry) => entry.latestBatchEventPosition),
      ["2", "1"],
    );
    assert.throws(
      () => repository.snapshotV2(connection, SESSION_ID as never, 2n),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "INTEGRITY_FAILURE"
      ),
    );
    assert.deepEqual(
      repository.snapshotV2(connection, SESSION_ID as never, 3n)
        .adapterSessions.map((entry) => entry.adapterSessionId),
      [adapterA, adapterB],
    );

    const unavailable = new EvidenceCoverageRepository(
      providerRecorder(undefined, "unavailable").provider,
    );
    for (const snapshot of [
      () => unavailable.snapshotV2(connection, SESSION_ID as never, 3n),
      () => unavailable.snapshotFromTransitionsV2(
        connection,
        SESSION_ID as never,
        2n,
      ),
    ]) {
      assert.throws(
        snapshot,
        (error: unknown) => (
          error instanceof Error
          && "code" in error
          && error.code === "EVIDENCE_HISTORICAL_KEY_UNAVAILABLE"
        ),
      );
    }
  });

  it("enforces repository adapter and interval boundaries before provider work", () => {
    const connection = database();
    const recorder = providerRecorder();
    const repository = new EvidenceCoverageRepository(recorder.provider);
    const adapterIds: string[] = [];
    for (let index = 0; index < 200; index += 1) {
      const position = BigInt(index + 1);
      const adapterSessionId = indexedUuid(100_000 + index);
      adapterIds.push(adapterSessionId);
      const batchCommand = command({
        commandId: indexedUuid(101_000 + index),
        idempotencyKey: `adapter-bound-${index}`,
        adapterSessionId: adapterSessionId as never,
        batchId: indexedUuid(102_000 + index) as never,
        firstOrdinal: "1",
        lastOrdinal: "1",
        frames: [{
          frameId: indexedUuid(103_000 + index) as never,
          ordinal: "1",
          sourceKind: "adapter-event",
          observedAt: NOW,
          contentFingerprint: index.toString(16).padStart(64, "0"),
        }],
      });
      const prepared = repository.prepareBatch(connection, {
        context: context(),
        command: batchCommand,
        prospectiveEndingScopeBindings: [],
        plannedEventPosition: position,
      });
      repository.persistPrepared(
        connection,
        prepared,
        storedEvent(
          connection,
          prepared.eventPayload as unknown as Readonly<Record<string, unknown>>,
          {
            globalPosition: position,
            eventId: indexedUuid(104_000 + index),
            commandId: batchCommand.commandId,
            idempotencyKey: batchCommand.idempotencyKey,
            streamVersion: position,
          },
        ),
      );
    }
    assert.equal(
      connection.prepare(
        "SELECT count(*) AS count FROM session_evidence_coverage",
      ).get()!.count,
      200n,
    );
    const providerBeforeAdapter201 = { ...recorder.calls };
    assert.throws(
      () => repository.prepareBatch(connection, {
        context: context(),
        command: command({
          commandId: indexedUuid(105_001),
          idempotencyKey: "adapter-bound-201",
          adapterSessionId: indexedUuid(105_002) as never,
          batchId: indexedUuid(105_003) as never,
          firstOrdinal: "0",
          lastOrdinal: "0",
          frames: [{
            frameId: indexedUuid(105_004) as never,
            ordinal: "0",
            sourceKind: "adapter-event",
            observedAt: NOW,
            contentFingerprint: "a".repeat(64),
          }],
        }),
        prospectiveEndingScopeBindings: [],
        plannedEventPosition: 201n,
      }),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "EVIDENCE_ADAPTER_SESSION_LIMIT"
      ),
    );
    assert.deepEqual(recorder.calls, providerBeforeAdapter201);

    const providerBeforeTotal201 = { ...recorder.calls };
    assert.throws(
      () => repository.prepareBatch(connection, {
        context: context(),
        command: command({
          commandId: indexedUuid(105_011),
          idempotencyKey: "total-interval-bound-201",
          adapterSessionId: adapterIds[0] as never,
          batchId: indexedUuid(105_012) as never,
          firstOrdinal: "3",
          lastOrdinal: "3",
          frames: [{
            frameId: indexedUuid(105_013) as never,
            ordinal: "3",
            sourceKind: "tool-result",
            observedAt: NOW,
            contentFingerprint: "b".repeat(64),
          }],
        }),
        prospectiveEndingScopeBindings: [],
        plannedEventPosition: 201n,
      }),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "EVIDENCE_COVERAGE_TOO_FRAGMENTED"
      ),
    );
    assert.deepEqual(recorder.calls, providerBeforeTotal201);
    assert.equal(
      connection.prepare(
        "SELECT coalesce(sum(json_array_length(missing_intervals_json)), 0) AS count FROM session_evidence_coverage",
      ).get()!.count,
      200n,
    );

    const fragmentedConnection = database();
    const fragmentedRecorder = providerRecorder();
    const fragmentedRepository = new EvidenceCoverageRepository(
      fragmentedRecorder.provider,
    );
    let eventPosition = 1n;
    const firstFragmentCommand = command({
      commandId: indexedUuid(106_001),
      idempotencyKey: "fragment-first",
      batchId: indexedUuid(106_002) as never,
      firstOrdinal: "401",
      lastOrdinal: "401",
      frames: [{
        frameId: indexedUuid(106_003) as never,
        ordinal: "401",
        sourceKind: "external-observation",
        observedAt: NOW,
        contentFingerprint: "c".repeat(64),
      }],
    });
    let fragmentPrepared = fragmentedRepository.prepareBatch(
      fragmentedConnection,
      {
        context: context(),
        command: firstFragmentCommand,
        prospectiveEndingScopeBindings: [],
        plannedEventPosition: eventPosition,
      },
    );
    fragmentedRepository.persistPrepared(
      fragmentedConnection,
      fragmentPrepared,
      storedEvent(
        fragmentedConnection,
        fragmentPrepared.eventPayload as unknown as Readonly<Record<string, unknown>>,
        {
          globalPosition: eventPosition,
          eventId: indexedUuid(106_004),
          commandId: firstFragmentCommand.commandId,
          idempotencyKey: firstFragmentCommand.idempotencyKey,
          streamVersion: eventPosition,
        },
      ),
    );
    for (let ordinal = 1; ordinal <= 397; ordinal += 2) {
      eventPosition += 1n;
      const batchCommand = command({
        commandId: indexedUuid(107_000 + ordinal),
        idempotencyKey: `fragment-${ordinal}`,
        batchId: indexedUuid(108_000 + ordinal) as never,
        firstOrdinal: ordinal.toString(),
        lastOrdinal: ordinal.toString(),
        frames: [{
          frameId: indexedUuid(109_000 + ordinal) as never,
          ordinal: ordinal.toString(),
          sourceKind: "external-observation",
          observedAt: NOW,
          contentFingerprint: ordinal.toString(16).padStart(64, "0"),
        }],
      });
      fragmentPrepared = fragmentedRepository.prepareBatch(
        fragmentedConnection,
        {
          context: context(),
          command: batchCommand,
          prospectiveEndingScopeBindings: [],
          plannedEventPosition: eventPosition,
        },
      );
      fragmentedRepository.persistPrepared(
        fragmentedConnection,
        fragmentPrepared,
        storedEvent(
          fragmentedConnection,
          fragmentPrepared.eventPayload as unknown as Readonly<Record<string, unknown>>,
          {
            globalPosition: eventPosition,
            eventId: indexedUuid(110_000 + ordinal),
            commandId: batchCommand.commandId,
            idempotencyKey: batchCommand.idempotencyKey,
            streamVersion: eventPosition,
          },
        ),
      );
    }
    assert.equal(fragmentPrepared.eventPayload.missingIntervals.length, 200);
    const providerBeforePerAdapter201 = { ...fragmentedRecorder.calls };
    assert.throws(
      () => fragmentedRepository.prepareBatch(fragmentedConnection, {
        context: context(),
        command: command({
          commandId: indexedUuid(111_001),
          idempotencyKey: "fragment-201",
          batchId: indexedUuid(111_002) as never,
          firstOrdinal: "399",
          lastOrdinal: "399",
          frames: [{
            frameId: indexedUuid(111_003) as never,
            ordinal: "399",
            sourceKind: "external-observation",
            observedAt: NOW,
            contentFingerprint: "d".repeat(64),
          }],
        }),
        prospectiveEndingScopeBindings: [],
        plannedEventPosition: eventPosition + 1n,
      }),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "EVIDENCE_COVERAGE_TOO_FRAGMENTED"
      ),
    );
    assert.deepEqual(fragmentedRecorder.calls, providerBeforePerAdapter201);
    assert.equal(
      fragmentedConnection.prepare(
        "SELECT json_array_length(missing_intervals_json) AS count FROM session_evidence_coverage",
      ).get()!.count,
      200n,
    );
  });

  it("enforces exact coverage checkpoint ending-scope and planned-position byte bounds", () => {
    const adapterEntry = (
      index: number,
      keyId: string,
    ): CheckpointEvidenceCoverageV2["adapterSessions"][number] => ({
      adapterSessionId: indexedUuid(300_000 + index) as never,
      coverageFirstOrdinal: "0",
      coverageLastOrdinal: "0",
      highestContiguousOrdinal: "0",
      missingIntervals: [],
      frameFingerprintAlgorithm: "hmac-sha256",
      frameFingerprintSchemaVersion: 1,
      frameFingerprintKeyId: keyId,
      frameFingerprintDomain: "pm-evidence-frame-v1",
      coverageFingerprintAlgorithm: "hmac-sha256",
      coverageFingerprintSchemaVersion: 1,
      coverageFingerprintKeyId: keyId,
      coverageFingerprintDomain: "pm-evidence-coverage-v1",
      coverageFingerprint: "a".repeat(64),
      latestBatchId: indexedUuid(301_000 + index) as never,
      latestBatchEventPosition: "1",
    });
    const exactEntries = Array.from(
      { length: 200 },
      (_, index) => adapterEntry(
        index,
        index === 0
          ? "x".repeat(127)
          : "\u0000".repeat(index === 1 ? 39 : 27),
      ),
    );
    exactEntries[0] = {
      ...exactEntries[0]!,
      coverageLastOrdinal: "1",
      highestContiguousOrdinal: null,
      missingIntervals: [{ firstOrdinal: "0", lastOrdinal: "1" }],
    };
    const exactCoverage: CheckpointEvidenceCoverageV2 = {
      coverageVersion: 2,
      captureMode: "coverage-only",
      contentRetained: false,
      adapterSessions: exactEntries,
    };
    assert.equal(
      Buffer.byteLength(canonicalJson(exactCoverage), "utf8"),
      196_608,
    );
    assert.doesNotThrow(() => assertEvidenceCoverageProjectionBounds({
      prospectiveAdapterCount: 200,
      prospectiveTotalIntervalCount: 1,
      targetIntervalCount: 1,
      evidenceCoverage: exactCoverage,
    }));
    const overCoverage: CheckpointEvidenceCoverageV2 = {
      ...exactCoverage,
      adapterSessions: exactCoverage.adapterSessions.map((entry, index) =>
        index === 2
          ? { ...entry, latestBatchEventPosition: "10" }
          : entry),
    };
    assert.equal(
      Buffer.byteLength(canonicalJson(overCoverage), "utf8"),
      196_609,
    );
    assert.throws(
      () => assertEvidenceCoverageProjectionBounds({
        prospectiveAdapterCount: 200,
        prospectiveTotalIntervalCount: 1,
        targetIntervalCount: 1,
        evidenceCoverage: overCoverage,
      }),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "EVIDENCE_COVERAGE_SNAPSHOT_TOO_LARGE"
      ),
    );

    const coverageConnection = database();
    coverageConnection.exec(`
      DROP TRIGGER IF EXISTS events_no_update;
      DROP TRIGGER IF EXISTS session_evidence_coverage_insert_guard;
      DROP TRIGGER IF EXISTS session_evidence_coverage_v3_insert_guard;
      DROP TRIGGER IF EXISTS session_evidence_coverage_transitions_insert_guard;
      DROP TRIGGER IF EXISTS session_evidence_coverage_transitions_advance_head;
    `);
    const targetAdapterIndex = 199;
    const targetAdapterSessionId = indexedUuid(
      300_000 + targetAdapterIndex,
    );
    const targetBatchId = indexedUuid(301_000 + targetAdapterIndex);
    const maximumOrdinal = "9223372036854775807";
    const maximumMissingOrdinal = "9223372036854775806";
    let exactCoveragePosition = 200n;
    const projections = (keyIds: readonly string[]) => Array.from(
      { length: 200 },
      (_, index) => ({
        ...adapterEntry(index, keyIds[index]!),
        coverageLastOrdinal: maximumOrdinal,
        highestContiguousOrdinal: null,
        missingIntervals: [{
          firstOrdinal: "0",
          lastOrdinal: maximumMissingOrdinal,
        }],
        coverageFingerprint: index === targetAdapterIndex
          ? "0".repeat(64)
          : H64,
        latestBatchEventPosition: index === targetAdapterIndex
          ? exactCoveragePosition.toString()
          : BigInt(index + 1).toString(),
      }),
    );
    const coverageBytes = (keyIds: readonly string[]): number =>
      Buffer.byteLength(canonicalJson({
        coverageVersion: 2,
        captureMode: "coverage-only",
        contentRetained: false,
        adapterSessions: projections(keyIds),
      }), "utf8");
    let keyIds = Array.from({ length: 200 }, () => "k");
    if ((196_608 - coverageBytes(keyIds)) % 2 !== 0) {
      exactCoveragePosition = 1_000n;
    }
    let remainingKeyBytes = (196_608 - coverageBytes(keyIds)) / 2;
    assert.equal(Number.isInteger(remainingKeyBytes), true);
    assert.equal(remainingKeyBytes >= 0, true);
    keyIds = keyIds.map(() => {
      const added = Math.min(127, remainingKeyBytes);
      remainingKeyBytes -= added;
      return "k".repeat(added + 1);
    });
    assert.equal(remainingKeyBytes, 0);
    assert.equal(coverageBytes(keyIds), 196_608);

    for (let index = 0; index < targetAdapterIndex; index += 1) {
      const position = BigInt(index + 1);
      rawGenericSessionEvent(coverageConnection, position);
    }
    coverageConnection.prepare(`
      UPDATE events
      SET stream_id = $streamId,
          stream_type = 'session',
          event_type = 'EvidenceCoverageRecorded',
          event_schema_version = 2
    `).run({ $streamId: `session/${SESSION_ID}` });
    for (let index = 0; index < targetAdapterIndex; index += 1) {
      const entry = projections(keyIds)[index]!;
      const position = BigInt(entry.latestBatchEventPosition);
      rawInsert(coverageConnection, "session_evidence_coverage_transitions", {
        project_id: PROJECT_ID,
        session_id: SESSION_ID,
        adapter_session_id: entry.adapterSessionId,
        batch_id: entry.latestBatchId,
        batch_event_position: position,
        batch_first_ordinal: BigInt(maximumOrdinal),
        batch_last_ordinal: BigInt(maximumOrdinal),
        coverage_first_ordinal: 0n,
        coverage_last_ordinal: BigInt(maximumOrdinal),
        highest_contiguous_ordinal: -1n,
        missing_intervals_json: `[[0,${maximumMissingOrdinal}]]`,
        frame_fingerprint_algorithm: "hmac-sha256",
        frame_fingerprint_schema_version: 1n,
        frame_fingerprint_key_id: entry.frameFingerprintKeyId,
        frame_fingerprint_domain: "pm-evidence-frame-v1",
        previous_coverage_fingerprint_value: null,
        coverage_fingerprint_algorithm: "hmac-sha256",
        coverage_fingerprint_schema_version: 1n,
        coverage_fingerprint_key_id: entry.coverageFingerprintKeyId,
        coverage_fingerprint_domain: "pm-evidence-coverage-v1",
        coverage_fingerprint_value: H64,
        new_frame_count: 1n,
        capture_mode: "coverage-only",
        content_retained: 0n,
        created_at: NOW,
      });
      rawInsert(coverageConnection, "session_evidence_coverage", {
        project_id: PROJECT_ID,
        session_id: SESSION_ID,
        adapter_session_id: entry.adapterSessionId,
        capture_mode: "coverage-only",
        first_ordinal: 0n,
        last_ordinal: BigInt(maximumOrdinal),
        highest_contiguous_ordinal: -1n,
        missing_intervals_json: `[[0,${maximumMissingOrdinal}]]`,
        fingerprint_algorithm: "hmac-sha256",
        fingerprint_schema_version: 1n,
        fingerprint_key_id: entry.frameFingerprintKeyId,
        fingerprint_domain: "pm-evidence-frame-v1",
        latest_batch_id: entry.latestBatchId,
        latest_batch_event_position: position,
        created_at: NOW,
        updated_at: NOW,
        coverage_fingerprint_algorithm: "hmac-sha256",
        coverage_fingerprint_schema_version: 1n,
        coverage_fingerprint_key_id: entry.coverageFingerprintKeyId,
        coverage_fingerprint_domain: "pm-evidence-coverage-v1",
        coverage_fingerprint_value: H64,
      });
      rawInsert(
        coverageConnection,
        "session_evidence_coverage_transition_heads",
        {
          project_id: PROJECT_ID,
          session_id: SESSION_ID,
          adapter_session_id: entry.adapterSessionId,
          batch_event_position: position,
        },
      );
    }
    const coverageCommand = command({
      commandId: indexedUuid(303_000),
      idempotencyKey: "exact-coverage-repository-bound",
      sessionId: SESSION_ID as never,
      adapterSessionId: targetAdapterSessionId as never,
      batchId: targetBatchId as never,
      fingerprintKeyId: keyIds[targetAdapterIndex],
      firstOrdinal: maximumOrdinal,
      lastOrdinal: maximumOrdinal,
      frames: [{
        frameId: indexedUuid(303_001) as never,
        ordinal: maximumOrdinal,
        sourceKind: "external-observation",
        observedAt: NOW,
        contentFingerprint: "f".repeat(64),
      }],
    });
    const exactCoverageRecorder = providerRecorder(
      undefined,
      "available",
      keyIds[targetAdapterIndex],
    );
    const exactCoveragePrepared = new EvidenceCoverageRepository(
      exactCoverageRecorder.provider,
    ).prepareBatch(coverageConnection, {
      context: context(),
      command: coverageCommand,
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: exactCoveragePosition,
    });
    const exactCoverageSnapshot: CheckpointEvidenceCoverageV2 = {
      coverageVersion: 2,
      captureMode: "coverage-only",
      contentRetained: false,
      adapterSessions: projections(keyIds).map((entry, index) =>
        index === targetAdapterIndex
          ? {
            ...entry,
            coverageFingerprint:
              exactCoveragePrepared.eventPayload.coverageFingerprint,
          }
          : entry),
    };
    assert.equal(
      Buffer.byteLength(canonicalJson(exactCoverageSnapshot), "utf8"),
      196_608,
    );
    assert.equal(exactCoverageRecorder.calls.currentKey, 1);
    const coverageState = repositoryTableCounts(coverageConnection);
    const overCoverageRecorder = providerRecorder(
      undefined,
      "available",
      keyIds[targetAdapterIndex],
    );
    const overCoveragePosition = exactCoveragePosition * 10n;
    assert.equal(
      coverageBytes(keyIds) + (
        overCoveragePosition.toString().length
        - exactCoveragePosition.toString().length
      ),
      196_609,
    );
    assert.throws(
      () => new EvidenceCoverageRepository(overCoverageRecorder.provider)
        .prepareBatch(coverageConnection, {
          context: context(),
          command: coverageCommand,
          prospectiveEndingScopeBindings: [],
          plannedEventPosition: overCoveragePosition,
        }),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "EVIDENCE_COVERAGE_SNAPSHOT_TOO_LARGE"
      ),
    );
    assert.deepEqual(
      overCoverageRecorder.calls,
      { currentKey: 0, status: 0, fingerprint: 0 },
    );
    assert.deepEqual(repositoryTableCounts(coverageConnection), coverageState);

    const exactBindings = Array.from({ length: 580 }, (_, index) =>
      endingBinding(index));
    const exactCommand = command({
      fingerprintKeyId: "k",
      firstOrdinal: "1000",
      lastOrdinal: "1000",
      frames: [{
        frameId: indexedUuid(302_001) as never,
        ordinal: "1000",
        sourceKind: "external-observation",
        observedAt: NOW,
        contentFingerprint: "f".repeat(64),
      }],
    });
    const exactConnection = database();
    const exactRecorder = providerRecorder(undefined, "available", "k");
    const exactRepository = new EvidenceCoverageRepository(exactRecorder.provider);
    const exactPrepared = exactRepository.prepareBatch(exactConnection, {
      context: context(),
      command: exactCommand,
      prospectiveEndingScopeBindings: exactBindings,
      plannedEventPosition: 1n,
    });
    const prospectiveCoverage: CheckpointEvidenceCoverageV2 = {
      coverageVersion: 2,
      captureMode: "coverage-only",
      contentRetained: false,
      adapterSessions: [{
        adapterSessionId: exactPrepared.adapterSessionId,
        coverageFirstOrdinal: "0",
        coverageLastOrdinal: exactPrepared.eventPayload.coverageLastOrdinal,
        highestContiguousOrdinal:
          exactPrepared.eventPayload.highestContiguousOrdinal,
        missingIntervals: exactPrepared.eventPayload.missingIntervals,
        frameFingerprintAlgorithm: "hmac-sha256",
        frameFingerprintSchemaVersion: 1,
        frameFingerprintKeyId: "k",
        frameFingerprintDomain: "pm-evidence-frame-v1",
        coverageFingerprintAlgorithm: "hmac-sha256",
        coverageFingerprintSchemaVersion: 1,
        coverageFingerprintKeyId: "k",
        coverageFingerprintDomain: "pm-evidence-coverage-v1",
        coverageFingerprint: exactPrepared.eventPayload.coverageFingerprint,
        latestBatchId: exactPrepared.eventPayload.batchId,
        latestBatchEventPosition: "1",
      }],
    };
    assert.equal(
      exactRepository.minimumCheckpointUpperBound(exactConnection, {
        evidenceCoverage: prospectiveCoverage,
        endingScopeBindings: exactBindings,
      }),
      262_144,
    );
    assert.equal(exactRecorder.calls.currentKey, 1);

    const plusOneConnection = database();
    const plusOneRecorder = providerRecorder(undefined, "available", "k");
    assert.throws(
      () => new EvidenceCoverageRepository(plusOneRecorder.provider)
        .prepareBatch(plusOneConnection, {
          context: context(),
          command: exactCommand,
          prospectiveEndingScopeBindings: exactBindings,
          plannedEventPosition: 10n,
        }),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "CHECKPOINT_CAPACITY_EXCEEDED"
      ),
    );
    assert.deepEqual(
      plusOneRecorder.calls,
      { currentKey: 0, status: 0, fingerprint: 0 },
    );
    assert.deepEqual(
      repositoryTableCounts(plusOneConnection),
      {
        events: 0n,
        session_evidence_coverage_transitions: 0n,
        session_evidence_coverage_transition_heads: 0n,
        session_evidence_coverage: 0n,
        session_evidence_fingerprints: 0n,
      },
    );
    const plusOneCoverage: CheckpointEvidenceCoverageV2 = {
      ...prospectiveCoverage,
      adapterSessions: prospectiveCoverage.adapterSessions.map((entry) => ({
        ...entry,
        latestBatchEventPosition: "10",
      })),
    };
    assert.equal(
      exactRepository.minimumCheckpointUpperBound(plusOneConnection, {
        evidenceCoverage: plusOneCoverage,
        endingScopeBindings: exactBindings,
      }),
      262_145,
    );

    const placeholderConnection = database();
    const placeholderRecorder = providerRecorder(undefined, "available", "k");
    assert.throws(
      () => new EvidenceCoverageRepository(placeholderRecorder.provider)
        .prepareBatch(placeholderConnection, {
          context: context(),
          command: exactCommand,
          prospectiveEndingScopeBindings: exactBindings,
          plannedEventPosition: null,
        }),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "CHECKPOINT_CAPACITY_EXCEEDED"
      ),
    );
    assert.deepEqual(
      placeholderRecorder.calls,
      { currentKey: 0, status: 0, fingerprint: 0 },
    );
    assert.deepEqual(
      repositoryTableCounts(placeholderConnection),
      {
        events: 0n,
        session_evidence_coverage_transitions: 0n,
        session_evidence_coverage_transition_heads: 0n,
        session_evidence_coverage: 0n,
        session_evidence_fingerprints: 0n,
      },
    );
    const finalExactBindings = Array.from({ length: 605 }, (_, index) =>
      carryEndingBinding(index));
    assert.equal(
      exactRepository.minimumFinalEndingScopeBindingsUpperBound(
        exactConnection,
        { endingScopeBindings: finalExactBindings },
      ),
      261_966,
    );
    const finalExactConnection = database();
    const finalExactRecorder = providerRecorder(undefined, "available", "k");
    assert.doesNotThrow(() =>
      new EvidenceCoverageRepository(finalExactRecorder.provider)
        .prepareBatch(finalExactConnection, {
          context: context(),
          command: exactCommand,
          prospectiveEndingScopeBindings: finalExactBindings,
          plannedEventPosition: 1n,
        }));
    assert.equal(finalExactRecorder.calls.currentKey, 1);
    assert.deepEqual(
      repositoryTableCounts(finalExactConnection),
      {
        events: 0n,
        session_evidence_coverage_transitions: 0n,
        session_evidence_coverage_transition_heads: 0n,
        session_evidence_coverage: 0n,
        session_evidence_fingerprints: 0n,
      },
    );

    const finalOverBindings = Array.from({ length: 606 }, (_, index) =>
      carryEndingBinding(index));
    assert.equal(
      exactRepository.minimumFinalEndingScopeBindingsUpperBound(
        exactConnection,
        { endingScopeBindings: finalOverBindings },
      ),
      262_399,
    );
    const finalOverConnection = database();
    const finalOverRecorder = providerRecorder(undefined, "available", "k");
    assert.throws(
      () => new EvidenceCoverageRepository(finalOverRecorder.provider)
        .prepareBatch(finalOverConnection, {
          context: context(),
          command: exactCommand,
          prospectiveEndingScopeBindings: finalOverBindings,
          plannedEventPosition: 1n,
        }),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "CHECKPOINT_CAPACITY_EXCEEDED"
      ),
    );
    assert.deepEqual(
      finalOverRecorder.calls,
      { currentKey: 0, status: 0, fingerprint: 0 },
    );
    assert.deepEqual(
      repositoryTableCounts(finalOverConnection),
      {
        events: 0n,
        session_evidence_coverage_transitions: 0n,
        session_evidence_coverage_transition_heads: 0n,
        session_evidence_coverage: 0n,
        session_evidence_fingerprints: 0n,
      },
    );
  });

  it("persists transition aggregate and ordinal order with real foreign keys", () => {
    const connection = database();
    const repository = new EvidenceCoverageRepository(providerRecorder().provider);
    const prepared = repository.prepareBatch(connection, {
      context: context(),
      command: command(),
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: 1n,
    });
    const committed = storedEvent(
      connection,
      prepared.eventPayload as unknown as Readonly<Record<string, unknown>>,
    );
    seedAuthorityForForeignKeys(connection, committed.globalPosition);
    connection.exec("PRAGMA foreign_keys = ON");
    const order: string[] = [];
    const inspected: SqliteConnection = {
      exec(sql) {
        connection.exec(sql);
      },
      prepare(sql) {
        const statement = connection.prepare(sql);
        return {
          run(params) {
            if (sql.includes("INSERT INTO session_evidence_coverage_transitions")) {
              order.push("transition");
            } else if (sql.includes("INSERT INTO session_evidence_coverage(")) {
              order.push("aggregate");
            } else if (sql.includes("INSERT INTO session_evidence_fingerprints")) {
              order.push("ordinal");
            }
            return statement.run(params);
          },
          get(params) {
            return statement.get(params);
          },
          all(params) {
            return statement.all(params);
          },
          iterate(params) {
            return statement.iterate(params);
          },
        };
      },
      close() {
        connection.close();
      },
    };

    connection.exec("BEGIN IMMEDIATE");
    repository.persistPrepared(inspected, prepared, committed);
    connection.exec("COMMIT");
    assert.deepEqual(order, ["transition", "aggregate", "ordinal"]);
    assert.equal(
      connection.prepare(
        "SELECT count(*) AS count FROM session_evidence_coverage_transition_heads",
      ).get()!.count,
      1n,
    );
    assert.equal(
      connection.prepare("PRAGMA foreign_key_check").all().length,
      0,
    );
  });

  it("checks each distinct current profile once during bounded quick health", () => {
    const connection = database();
    const recorder = providerRecorder();
    const repository = new EvidenceCoverageRepository(recorder.provider);
    const first = repository.prepareBatch(connection, {
      context: context(),
      command: command(),
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: 1n,
    });
    repository.persistPrepared(
      connection,
      first,
      storedEvent(
        connection,
        first.eventPayload as unknown as Readonly<Record<string, unknown>>,
      ),
    );

    const secondCommand = command({
      commandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      idempotencyKey: "evidence-second-adapter",
      adapterSessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as never,
      batchId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as never,
      firstOrdinal: "0",
      lastOrdinal: "0",
      frames: [{
        frameId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" as never,
        ordinal: "0",
        sourceKind: "adapter-event",
        observedAt: NOW,
        contentFingerprint: "d".repeat(64),
      }],
    });
    const second = repository.prepareBatch(connection, {
      context: context(),
      command: secondCommand,
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: 2n,
    });
    repository.persistPrepared(
      connection,
      second,
      storedEvent(
        connection,
        second.eventPayload as unknown as Readonly<Record<string, unknown>>,
        {
          globalPosition: 2n,
          commandId: secondCommand.commandId,
          idempotencyKey: secondCommand.idempotencyKey,
          streamVersion: 2n,
        },
      ),
    );

    const statusCallsBeforeHealth = recorder.calls.status;
    repository.assertQuickHealthy(connection, [SESSION_ID as never]);
    assert.equal(recorder.calls.status, statusCallsBeforeHealth + 1);
    assert.deepEqual(recorder.statusInputs.at(-1), {
      scope: { projectId: PROJECT_ID, storeId: STORE_ID },
      purpose: "evidence-fingerprint",
      keyId: "key-1",
    });

    const unavailable = providerRecorder(undefined, "unavailable");
    assert.throws(
      () => new EvidenceCoverageRepository(unavailable.provider)
        .assertQuickHealthy(connection, [SESSION_ID as never]),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "EVIDENCE_HISTORICAL_KEY_UNAVAILABLE"
      ),
    );
    assert.equal(unavailable.calls.status, 1);
  });

  it("rejects an over-bound historical key in an event-time transition snapshot", () => {
    const connection = database();
    const repository = new EvidenceCoverageRepository(providerRecorder().provider);
    const prepared = repository.prepareBatch(connection, {
      context: context(),
      command: command(),
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: 1n,
    });
    repository.persistPrepared(
      connection,
      prepared,
      storedEvent(
        connection,
        prepared.eventPayload as unknown as Readonly<Record<string, unknown>>,
      ),
    );

    connection.exec("DROP TRIGGER session_evidence_coverage_transitions_no_update");
    connection.prepare(`
      UPDATE session_evidence_coverage_transitions
      SET frame_fingerprint_key_id = $keyId,
          coverage_fingerprint_key_id = $keyId
    `).run({ $keyId: "k".repeat(129) });

    assert.throws(
      () => repository.snapshotFromTransitionsV2(
        connection,
        SESSION_ID as never,
        1n,
      ),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "INTEGRITY_FAILURE"
      ),
    );
  });

  it("counts profile key bounds by Unicode scalar rather than UTF-16 units", () => {
    const connection = database();
    const keyId = "💡".repeat(128);
    const repository = new EvidenceCoverageRepository(
      providerRecorder(undefined, "available", keyId).provider,
    );

    const prepared = repository.prepareBatch(connection, {
      context: context(),
      command: command({ fingerprintKeyId: keyId }),
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: 1n,
    });

    assert.equal(prepared.eventPayload.frameFingerprintKeyId, keyId);
    assert.equal(prepared.eventPayload.coverageFingerprintKeyId, keyId);
  });

  it("deduplicates quick-health status across sessions sharing one profile", () => {
    const connection = database();
    const recorder = providerRecorder();
    const repository = new EvidenceCoverageRepository(recorder.provider);
    const first = repository.prepareBatch(connection, {
      context: context(),
      command: command(),
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: 1n,
    });
    repository.persistPrepared(
      connection,
      first,
      storedEvent(
        connection,
        first.eventPayload as unknown as Readonly<Record<string, unknown>>,
      ),
    );

    const secondSessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const secondCommand = command({
      commandId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      idempotencyKey: "evidence-second-session",
      sessionId: secondSessionId as never,
      adapterSessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as never,
      batchId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" as never,
      firstOrdinal: "0",
      lastOrdinal: "0",
      frames: [{
        frameId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" as never,
        ordinal: "0",
        sourceKind: "external-observation",
        observedAt: NOW,
        contentFingerprint: "e".repeat(64),
      }],
    });
    const second = repository.prepareBatch(connection, {
      context: context(),
      command: secondCommand,
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: 2n,
    });
    repository.persistPrepared(
      connection,
      second,
      storedEvent(
        connection,
        second.eventPayload as unknown as Readonly<Record<string, unknown>>,
        {
          globalPosition: 2n,
          sessionId: secondSessionId,
          streamId: `session/${secondSessionId}`,
          commandId: secondCommand.commandId,
          idempotencyKey: secondCommand.idempotencyKey,
          streamVersion: 1n,
        },
      ),
    );

    const statusCallsBeforeHealth = recorder.calls.status;
    repository.assertQuickHealthy(
      connection,
      [SESSION_ID as never, secondSessionId as never],
    );
    assert.equal(recorder.calls.status, statusCallsBeforeHealth + 1);
  });

  it("counts lifetime adapters before selecting an event-time snapshot", () => {
    const connection = database();
    const repository = new EvidenceCoverageRepository(providerRecorder().provider);
    const prepared = repository.prepareBatch(connection, {
      context: context(),
      command: command(),
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: 1n,
    });
    repository.persistPrepared(
      connection,
      prepared,
      storedEvent(
        connection,
        prepared.eventPayload as unknown as Readonly<Record<string, unknown>>,
      ),
    );

    let lifetimeCountSql = "";
    const inspected: SqliteConnection = {
      exec(sql) {
        connection.exec(sql);
      },
      prepare(sql) {
        if (sql.includes("FROM session_evidence_coverage_transition_heads")) {
          lifetimeCountSql = sql;
        }
        return connection.prepare(sql);
      },
      close() {
        connection.close();
      },
    };
    repository.snapshotFromTransitionsV2(
      inspected,
      SESSION_ID as never,
      1n,
    );

    assert.match(lifetimeCountSql, /session_evidence_coverage_transition_heads/);
    assert.match(lifetimeCountSql, /LIMIT 201/);
    assert.doesNotMatch(lifetimeCountSql, /batch_event_position\s*<=/);
  });

  it("rejects every coverage artifact during Version 1 eligibility", () => {
    const connection = database();
    rawInsert(connection, "session_evidence_coverage_transition_heads", {
      project_id: PROJECT_ID,
      session_id: SESSION_ID,
      adapter_session_id: ADAPTER_ID,
      batch_event_position: 1n,
    });

    assert.throws(
      () => new EvidenceCoverageRepository(providerRecorder().provider)
        .assertVersion1Eligible(connection, [SESSION_ID as never]),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "CHECKPOINT_EVIDENCE_VERSION_REQUIRED"
      ),
    );
  });

  it("rejects the independent Version 1 eligibility artifact matrix", () => {
    const assertRejected = (
      seed: (connection: SqliteConnection) => void,
    ): void => {
      const connection = database();
      seed(connection);
      assert.throws(
        () => new EvidenceCoverageRepository(providerRecorder().provider)
          .assertVersion1Eligible(connection, [SESSION_ID as never]),
        (error: unknown) => (
          error instanceof Error
          && "code" in error
          && error.code === "CHECKPOINT_EVIDENCE_VERSION_REQUIRED"
        ),
      );
    };
    assertRejected((connection) => {
      connection.exec("DROP TRIGGER session_evidence_coverage_v3_insert_guard");
      rawInsert(connection, "session_evidence_coverage", {
        project_id: PROJECT_ID,
        session_id: SESSION_ID,
        adapter_session_id: ADAPTER_ID,
        capture_mode: "coverage-only",
        first_ordinal: 0n,
        last_ordinal: 0n,
        highest_contiguous_ordinal: 0n,
        missing_intervals_json: "[]",
        fingerprint_algorithm: "hmac-sha256",
        fingerprint_schema_version: 1n,
        fingerprint_key_id: "key-1",
        fingerprint_domain: "pm-evidence-frame-v1",
        latest_batch_id: BATCH_ID,
        latest_batch_event_position: 1n,
        created_at: NOW,
        updated_at: NOW,
        coverage_fingerprint_algorithm: "hmac-sha256",
        coverage_fingerprint_schema_version: 1n,
        coverage_fingerprint_key_id: "key-1",
        coverage_fingerprint_domain: "pm-evidence-coverage-v1",
        coverage_fingerprint_value: H64,
      });
    });
    assertRejected((connection) => {
      connection.exec(
        "DROP TRIGGER session_evidence_coverage_transitions_insert_guard",
      );
      connection.exec(
        "DROP TRIGGER session_evidence_coverage_transitions_advance_head",
      );
      rawInsert(connection, "session_evidence_coverage_transitions", {
        project_id: PROJECT_ID,
        session_id: SESSION_ID,
        adapter_session_id: ADAPTER_ID,
        batch_id: BATCH_ID,
        batch_event_position: 1n,
        batch_first_ordinal: 0n,
        batch_last_ordinal: 0n,
        coverage_first_ordinal: 0n,
        coverage_last_ordinal: 0n,
        highest_contiguous_ordinal: 0n,
        missing_intervals_json: "[]",
        frame_fingerprint_algorithm: "hmac-sha256",
        frame_fingerprint_schema_version: 1n,
        frame_fingerprint_key_id: "key-1",
        frame_fingerprint_domain: "pm-evidence-frame-v1",
        previous_coverage_fingerprint_value: null,
        coverage_fingerprint_algorithm: "hmac-sha256",
        coverage_fingerprint_schema_version: 1n,
        coverage_fingerprint_key_id: "key-1",
        coverage_fingerprint_domain: "pm-evidence-coverage-v1",
        coverage_fingerprint_value: H64,
        new_frame_count: 1n,
        capture_mode: "coverage-only",
        content_retained: 0n,
        created_at: NOW,
      });
    });
    assertRejected((connection) => {
      rawInsert(connection, "session_evidence_coverage_transition_heads", {
        project_id: PROJECT_ID,
        session_id: SESSION_ID,
        adapter_session_id: ADAPTER_ID,
        batch_event_position: 1n,
      });
    });
    assertRejected((connection) => {
      rawInsert(connection, "session_evidence_fingerprints", {
        project_id: PROJECT_ID,
        session_id: SESSION_ID,
        adapter_session_id: ADAPTER_ID,
        ordinal: 0n,
        frame_id: FRAME_ID,
        source_kind: "model-turn",
        observed_at: NOW,
        fingerprint_algorithm: "hmac-sha256",
        fingerprint_schema_version: 1n,
        fingerprint_key_id: "key-1",
        fingerprint_domain: "pm-evidence-frame-v1",
        fingerprint_value: FRAME_H64,
        batch_id: BATCH_ID,
        recorded_event_position: 1n,
        created_at: NOW,
      });
    });
    assertRejected((connection) => {
      rawGenericSessionEvent(connection, 1n);
      seedAuthorityForForeignKeys(connection, 1n);
      connection.exec("DROP TRIGGER events_no_update");
      connection.prepare(`
        UPDATE events
        SET stream_id = $streamId,
            stream_type = 'session',
            event_type = 'EvidenceCoverageRecorded'
        WHERE global_position = 1
      `).run({ $streamId: `session/${SESSION_ID}` });
    });
    for (const evidenceCoverage of [
      {
        highestContiguousOrdinal: "0",
        missingIntervals: [],
      },
      {
        adapterSessions: [{
          adapterSessionId: ADAPTER_ID,
        }],
      },
    ]) {
      assertRejected((connection) => {
        rawGenericSessionEvent(connection, 1n);
        seedAuthorityForForeignKeys(connection, 1n, true);
        connection.exec("DROP TRIGGER events_no_update");
        connection.prepare(`
          UPDATE events
          SET stream_id = $streamId,
              stream_type = 'session',
              event_type = 'SessionCheckpointRecorded',
              payload_json = $payloadJson
          WHERE global_position = 1
        `).run({
          $streamId: `session/${SESSION_ID}`,
          $payloadJson: canonicalJson({
            checkpoint: { evidenceCoverage },
          }),
        });
      });
    }
  });

  it("rejects non-current evidence events and superseded coverage checkpoints", () => {
    const assertHistoricalRejected = (
      eventType: string,
      eventSchemaVersion: bigint,
      payload: Readonly<Record<string, unknown>>,
    ): string => {
      const connection = database();
      rawGenericSessionEvent(connection, 1n);
      rawGenericSessionEvent(connection, 2n);
      connection.exec("DROP TRIGGER events_no_update");
      const laterIsCheckpoint = eventType === "SessionCheckpointRecorded";
      const laterPayload = laterIsCheckpoint
        ? {
          checkpoint: {
            checkpointVersion: Number(eventSchemaVersion),
            evidenceCoverage: {
              highestContiguousOrdinal: null,
              missingIntervals: [],
              adapterSessions: [],
            },
          },
        }
        : {};
      connection.prepare(`
        UPDATE events
        SET stream_id = $streamId,
            stream_type = 'session',
            stream_version = global_position,
            event_type = CASE global_position
              WHEN 1 THEN $eventType
              ELSE $laterEventType
            END,
            event_schema_version = CASE global_position
              WHEN 1 THEN $eventSchemaVersion
              ELSE $laterEventSchemaVersion
            END,
            payload_json = CASE global_position
              WHEN 1 THEN $payloadJson
              ELSE $laterPayloadJson
            END
      `).run({
        $streamId: `session/${SESSION_ID}`,
        $eventType: eventType,
        $eventSchemaVersion: eventSchemaVersion,
        $payloadJson: canonicalJson(payload),
        $laterEventType: laterIsCheckpoint
          ? "SessionCheckpointRecorded"
          : "GenericEvent",
        $laterEventSchemaVersion: laterIsCheckpoint
          ? eventSchemaVersion
          : 1n,
        $laterPayloadJson: canonicalJson(laterPayload),
      });
      let artifactSql = "";
      const inspected: SqliteConnection = {
        exec(sql) {
          connection.exec(sql);
        },
        prepare(sql) {
          if (
            sql.includes("FROM events")
            && sql.includes("EvidenceCoverageRecorded")
            && sql.includes("LIMIT 1")
          ) {
            artifactSql = sql;
          }
          return connection.prepare(sql);
        },
        close() {
          connection.close();
        },
      };
      assert.throws(
        () => new EvidenceCoverageRepository(providerRecorder().provider)
          .assertVersion1Eligible(inspected, [SESSION_ID as never]),
        (error: unknown) => (
          error instanceof Error
          && "code" in error
          && error.code === "CHECKPOINT_EVIDENCE_VERSION_REQUIRED"
        ),
      );
      return artifactSql;
    };

    const evidenceSql = assertHistoricalRejected(
      "EvidenceCoverageRecorded",
      99n,
      {},
    );
    const checkpointV1Sql = assertHistoricalRejected(
      "SessionCheckpointRecorded",
      1n,
      {
        checkpoint: {
          checkpointVersion: 1,
          evidenceCoverage: {
            highestContiguousOrdinal: "0",
            missingIntervals: [],
            adapterSessions: [],
          },
        },
      },
    );
    const checkpointV2Sql = assertHistoricalRejected(
      "SessionCheckpointRecorded",
      2n,
      {
        checkpoint: {
          checkpointVersion: 2,
          evidenceCoverage: {
            highestContiguousOrdinal: null,
            missingIntervals: [],
            adapterSessions: [{ adapterSessionId: ADAPTER_ID }],
          },
        },
      },
    );
    assert.equal(evidenceSql, checkpointV1Sql);
    assert.equal(evidenceSql, checkpointV2Sql);
  });

  it("keeps clean missing null and empty historical checkpoint coverage eligible", () => {
    const connection = database();
    for (let position = 1n; position <= 3n; position += 1n) {
      rawGenericSessionEvent(connection, position);
    }
    connection.exec("DROP TRIGGER events_no_update");
    const cleanPayloads = [
      { checkpoint: { checkpointVersion: 1 } },
      {
        checkpoint: {
          checkpointVersion: 1,
          evidenceCoverage: {
            highestContiguousOrdinal: null,
            missingIntervals: [],
            adapterSessions: [],
          },
        },
      },
      {
        checkpoint: {
          checkpointVersion: 2,
          evidenceCoverage: {
            highestContiguousOrdinal: null,
            missingIntervals: [],
            adapterSessions: [],
          },
        },
      },
    ];
    for (let index = 0; index < cleanPayloads.length; index += 1) {
      connection.prepare(`
        UPDATE events
        SET stream_id = $streamId,
            stream_type = 'session',
            stream_version = global_position,
            event_type = 'SessionCheckpointRecorded',
            event_schema_version = $eventSchemaVersion,
            payload_json = $payloadJson
        WHERE global_position = $globalPosition
      `).run({
        $streamId: `session/${SESSION_ID}`,
        $eventSchemaVersion: index === 2 ? 2n : 1n,
        $payloadJson: canonicalJson(cleanPayloads[index]),
        $globalPosition: BigInt(index + 1),
      });
    }
    let artifactSql = "";
    const inspected: SqliteConnection = {
      exec(sql) {
        connection.exec(sql);
      },
      prepare(sql) {
        if (
          sql.includes("FROM events")
          && sql.includes("EvidenceCoverageRecorded")
          && sql.includes("LIMIT 1")
        ) {
          artifactSql = sql;
        }
        return connection.prepare(sql);
      },
      close() {
        connection.close();
      },
    };
    assert.doesNotThrow(() =>
      new EvidenceCoverageRepository(providerRecorder().provider)
        .assertVersion1Eligible(inspected, [SESSION_ID as never]));
    assert.notEqual(artifactSql, "");
    const plan = connection.prepare(
      `EXPLAIN QUERY PLAN ${artifactSql}`,
    ).all({
      $projectId: PROJECT_ID,
      $sessionId: SESSION_ID,
    }).map((row) => String(row.detail));
    assert.equal(
      plan.some((detail) =>
        detail.includes(
          "SEARCH events USING INDEX events_session_evidence_artifacts "
          + "(project_id=? AND session_id=?)",
        )),
      true,
    );
    assert.equal(
      plan.some((detail) =>
        /SCAN events|USE TEMP B-TREE/i.test(detail)),
      false,
    );
  });

  it("bounds event-time snapshot work by adapter identities rather than transition history", () => {
    const connection = database();
    const repository = new EvidenceCoverageRepository(providerRecorder().provider);
    let priorPosition = 0n;
    for (let index = 0; index < 32; index += 1) {
      const position = BigInt(index + 1);
      const ordinal = BigInt(index + 5).toString();
      const batchCommand = command({
        commandId: indexedUuid(40_000 + index),
        idempotencyKey: `deep-batch-${index}`,
        batchId: indexedUuid(50_000 + index) as never,
        firstOrdinal: ordinal,
        lastOrdinal: ordinal,
        frames: [{
          frameId: indexedUuid(60_000 + index) as never,
          ordinal,
          sourceKind: "adapter-event",
          observedAt: NOW,
          contentFingerprint: index.toString(16).padStart(64, "0"),
        }],
      });
      const prepared = repository.prepareBatch(connection, {
        context: context(),
        command: batchCommand,
        prospectiveEndingScopeBindings: [],
        plannedEventPosition: position,
      });
      repository.persistPrepared(
        connection,
        prepared,
        storedEvent(
          connection,
          prepared.eventPayload as unknown as Readonly<Record<string, unknown>>,
          {
            globalPosition: position,
            eventId: indexedUuid(70_000 + index),
            commandId: batchCommand.commandId,
            idempotencyKey: batchCommand.idempotencyKey,
            streamVersion: position,
          },
        ),
      );
      priorPosition = position;
    }
    assert.equal(priorPosition, 32n);

    let headEnumerations = 0;
    let indexedTransitionSeeks = 0;
    let unboundedTransitionQueries = 0;
    let headEnumerationSql = "";
    const inspected: SqliteConnection = {
      exec(sql) {
        connection.exec(sql);
      },
      prepare(sql) {
        if (sql.includes("FROM session_evidence_coverage_transition_heads")) {
          headEnumerations += 1;
          headEnumerationSql = sql;
        }
        if (
          sql.includes("FROM session_evidence_coverage_transitions")
          && sql.includes("ORDER BY batch_event_position DESC")
          && sql.includes("LIMIT 1")
        ) {
          indexedTransitionSeeks += 1;
        }
        if (
          sql.includes("count(DISTINCT adapter_session_id)")
          || sql.includes("SELECT max(candidate.batch_event_position)")
        ) {
          unboundedTransitionQueries += 1;
        }
        return connection.prepare(sql);
      },
      close() {
        connection.close();
      },
    };

    const historical = repository.snapshotFromTransitionsV2(
      inspected,
      SESSION_ID as never,
      16n,
    );
    assert.equal(historical.adapterSessions[0]!.latestBatchEventPosition, "16");
    assert.equal(headEnumerations, 1);
    assert.equal(indexedTransitionSeeks, 1);
    assert.equal(unboundedTransitionQueries, 0);
    assert.doesNotMatch(headEnumerationSql, /ORDER BY|CAST\s*\(/i);
    const headPlan = connection.prepare(
      `EXPLAIN QUERY PLAN ${headEnumerationSql}`,
    ).all({
      $projectId: PROJECT_ID,
      $sessionId: SESSION_ID,
    }).map((row) => String(row.detail));
    assert.equal(
      headPlan.some((detail) =>
        detail.includes(
          "SEARCH session_evidence_coverage_transition_heads "
          + "USING COVERING INDEX sqlite_autoindex_"
          + "session_evidence_coverage_transition_heads_1 "
          + "(project_id=? AND session_id=?)",
        )),
      true,
    );
    assert.equal(
      headPlan.some((detail) =>
        /SCAN|USE TEMP B-TREE/i.test(detail)),
      false,
    );
  });

  it("keeps Version 1 eligibility independent of deep event history", () => {
    const connection = database();
    for (let position = 1n; position <= 512n; position += 1n) {
      rawGenericSessionEvent(connection, position);
    }
    let historyJsonQueries = 0;
    const inspected: SqliteConnection = {
      exec(sql) {
        connection.exec(sql);
      },
      prepare(sql) {
        if (
          sql.includes("SELECT 1 FROM events")
          && sql.includes("json_array_length")
        ) {
          historyJsonQueries += 1;
        }
        return connection.prepare(sql);
      },
      close() {
        connection.close();
      },
    };

    new EvidenceCoverageRepository(providerRecorder().provider)
      .assertVersion1Eligible(inspected, [SESSION_ID as never]);
    assert.equal(historyJsonQueries, 0);
  });

  it("detaches the complete batch before re-entrant provider alias mutation", () => {
    const connection = database();
    const mutableCommand = command() as RecordEvidenceBatchCommandV2 & {
      batchId: string;
      frames: {
        frameId: string;
        ordinal: string;
        sourceKind: "model-turn";
        observedAt: string;
        contentFingerprint: string;
      }[];
    };
    const originalBatchId = mutableCommand.batchId;
    const originalFingerprint = mutableCommand.frames[0]!.contentFingerprint;
    const recorder = providerRecorder();
    const provider = {
      ...recorder.provider,
      currentKey(
        scope: { projectId: string; storeId: string },
        purpose: "evidence-fingerprint",
      ) {
        mutableCommand.batchId = "ffffffff-ffff-4fff-bfff-ffffffffffff" as never;
        mutableCommand.frames[0]!.contentFingerprint = "e".repeat(64);
        return recorder.provider.currentKey(scope, purpose);
      },
    };

    const prepared = new EvidenceCoverageRepository(provider).prepareBatch(
      connection,
      {
        context: context(),
        command: mutableCommand,
        prospectiveEndingScopeBindings: [],
        plannedEventPosition: 1n,
      },
    );

    assert.equal(prepared.eventPayload.batchId, originalBatchId);
    assert.equal(
      prepared.eventPayload.frames[0]!.contentFingerprint,
      originalFingerprint,
    );
    assert.equal(prepared.newFrames[0]!.contentFingerprint, originalFingerprint);
    assert.equal(
      (recorder.fingerprintInputs[0]!.body as {
        newFrames: readonly { contentFingerprint: string }[];
      }).newFrames[0]!.contentFingerprint,
      originalFingerprint,
    );
  });

  it("matches only incoming ordinal and frame IDs without scanning deep ordinal history", () => {
    const connection = database();
    const repository = new EvidenceCoverageRepository(providerRecorder().provider);
    const frames = Array.from({ length: 2_000 }, (_, index) => ({
      frameId: indexedUuid(500_000 + index) as never,
      ordinal: index.toString(),
      sourceKind: "adapter-event" as const,
      observedAt: NOW,
      contentFingerprint: index.toString(16).padStart(64, "0"),
    }));
    const initialCommand = command({
      commandId: indexedUuid(502_001),
      idempotencyKey: "deep-ordinal-initial",
      batchId: indexedUuid(502_002) as never,
      firstOrdinal: "0",
      lastOrdinal: "1999",
      frames,
    });
    const initial = repository.prepareBatch(connection, {
      context: context(),
      command: initialCommand,
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: 1n,
    });
    repository.persistPrepared(
      connection,
      initial,
      storedEvent(
        connection,
        initial.eventPayload as unknown as Readonly<Record<string, unknown>>,
        {
          commandId: initialCommand.commandId,
          idempotencyKey: initialCommand.idempotencyKey,
        },
      ),
    );

    const ordinalQueries: string[] = [];
    const inspected: SqliteConnection = {
      exec(sql) {
        connection.exec(sql);
      },
      prepare(sql) {
        if (sql.includes("FROM session_evidence_fingerprints")) {
          ordinalQueries.push(sql);
        }
        return connection.prepare(sql);
      },
      close() {
        connection.close();
      },
    };
    const overlap = repository.prepareBatch(inspected, {
      context: context(),
      command: command({
        commandId: indexedUuid(502_003),
        idempotencyKey: "deep-ordinal-overlap",
        batchId: indexedUuid(502_004) as never,
        firstOrdinal: "0",
        lastOrdinal: "0",
        frames: [frames[0]!],
      }),
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: 2n,
    });

    assert.deepEqual(overlap.newFrames, []);
    assert.equal(ordinalQueries.length, 1);
    assert.match(ordinalQueries[0]!, /ordinal IN \(\$ordinal0\)/);
    assert.match(ordinalQueries[0]!, /frame_id IN \(\$frame0\)/);
    assert.doesNotMatch(ordinalQueries[0]!, /ORDER BY|LIMIT 2000\b/);
  });

  it("rejects a missing immutable row for an ordinal projected as covered", () => {
    const connection = database();
    const recorder = providerRecorder();
    const repository = new EvidenceCoverageRepository(recorder.provider);
    const prepared = repository.prepareBatch(connection, {
      context: context(),
      command: command(),
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: 1n,
    });
    repository.persistPrepared(
      connection,
      prepared,
      storedEvent(
        connection,
        prepared.eventPayload as unknown as Readonly<Record<string, unknown>>,
      ),
    );
    connection.exec("DROP TRIGGER session_evidence_fingerprints_no_delete");
    connection.prepare(`
      DELETE FROM session_evidence_fingerprints
      WHERE project_id = $projectId
        AND session_id = $sessionId
        AND adapter_session_id = $adapterSessionId
        AND ordinal = 5
    `).run({
      $projectId: PROJECT_ID,
      $sessionId: SESSION_ID,
      $adapterSessionId: ADAPTER_ID,
    });
    const callsBefore = { ...recorder.calls };

    assert.throws(
      () => repository.prepareBatch(connection, {
        context: context(),
        command: command({
          commandId: indexedUuid(80_001),
          idempotencyKey: "covered-row-missing",
          batchId: indexedUuid(80_002) as never,
        }),
        prospectiveEndingScopeBindings: [],
        plannedEventPosition: 2n,
      }),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "INTEGRITY_FAILURE"
      ),
    );
    assert.deepEqual(recorder.calls, callsBefore);
  });

  it("rejects an immutable row for an ordinal projected as missing", () => {
    const connection = database();
    const recorder = providerRecorder();
    const repository = new EvidenceCoverageRepository(recorder.provider);
    const prepared = repository.prepareBatch(connection, {
      context: context(),
      command: command(),
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: 1n,
    });
    repository.persistPrepared(
      connection,
      prepared,
      storedEvent(
        connection,
        prepared.eventPayload as unknown as Readonly<Record<string, unknown>>,
      ),
    );
    const missingFrame = {
      frameId: indexedUuid(81_001) as never,
      ordinal: "2",
      sourceKind: "tool-request" as const,
      observedAt: NOW,
      contentFingerprint: "e".repeat(64),
    };
    rawInsert(connection, "session_evidence_fingerprints", {
      project_id: PROJECT_ID,
      session_id: SESSION_ID,
      adapter_session_id: ADAPTER_ID,
      ordinal: 2n,
      frame_id: missingFrame.frameId,
      source_kind: missingFrame.sourceKind,
      observed_at: missingFrame.observedAt,
      fingerprint_algorithm: "hmac-sha256",
      fingerprint_schema_version: 1,
      fingerprint_key_id: "key-1",
      fingerprint_domain: "pm-evidence-frame-v1",
      fingerprint_value: missingFrame.contentFingerprint,
      batch_id: indexedUuid(81_002),
      recorded_event_position: 1n,
      created_at: NOW,
    });
    const callsBefore = { ...recorder.calls };

    assert.throws(
      () => repository.prepareBatch(connection, {
        context: context(),
        command: command({
          commandId: indexedUuid(81_003),
          idempotencyKey: "missing-row-present",
          batchId: indexedUuid(81_004) as never,
          firstOrdinal: "2",
          lastOrdinal: "2",
          frames: [missingFrame],
        }),
        prospectiveEndingScopeBindings: [],
        plannedEventPosition: 2n,
      }),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "INTEGRITY_FAILURE"
      ),
    );
    assert.deepEqual(recorder.calls, callsBefore);
  });

});
