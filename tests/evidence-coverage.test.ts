import { strict as assert } from "node:assert";
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
        if (sql.includes("count(DISTINCT adapter_session_id)")) {
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

    assert.match(lifetimeCountSql, /session_evidence_coverage_transitions/);
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

});
