import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import type { ProjectContext } from "../src/orchestrator/identity/contracts.js";
import { parseStoreManifest } from "../src/orchestrator/identity/store-manifest.schema.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import {
  MigrationRunner,
  type MigrationApplyMode,
} from "../src/orchestrator/storage/migration-runner.js";
import { eventCoreMigration } from "../src/orchestrator/storage/migrations/0001-event-core.js";
import { sessionLifecycleMigration } from "../src/orchestrator/storage/migrations/0002-session-lifecycle.js";
import { qualifiedCheckpointCoverageMigration } from "../src/orchestrator/storage/migrations/0003-qualified-checkpoint-coverage.js";
import {
  CURRENT_PROJECT_STORE_SCHEMA_VERSION,
  PROJECT_STORE_MIGRATIONS,
} from "../src/orchestrator/storage/migrations/registry.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import {
  QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE,
  QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE,
  SqliteQualifiedCheckpointMigrationPreflight,
  qualifiedCheckpointMigrationFailure,
} from "../src/orchestrator/storage/qualified-checkpoint-migration-preflight.js";
import { inspectStoreSchema } from "../src/orchestrator/storage/schema-compatibility.js";
import type {
  SqliteConnection,
  SqliteParams,
  SqliteValue,
} from "../src/orchestrator/storage/sqlite-driver.js";
import { checkpointFixture, lifecycleEvent } from "./support/lifecycle-fixtures.js";

const NOW = "2026-07-22T00:00:00.000Z";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const VAULT_ID = "22222222-2222-4222-8222-222222222222";
const STORE_ID = "33333333-3333-4333-8333-333333333333";
const ROOT_ID = "44444444-4444-4444-8444-444444444444";
const CHILD_ID = "55555555-5555-4555-8555-555555555555";
const ADAPTER_ID = "66666666-6666-4666-8666-666666666666";
const BATCH_ID = "77777777-7777-4777-8777-777777777777";
const OTHER_ROOT_ID = "99999999-9999-4999-8999-999999999999";
const H64 = "a".repeat(64);
const H64_B = "b".repeat(64);
const H64_C = "c".repeat(64);
const MAX_INT64 = 9_223_372_036_854_775_807n;
const registry = [
  eventCoreMigration,
  sessionLifecycleMigration,
  qualifiedCheckpointCoverageMigration,
] as const;
const roots: string[] = [];
const connections: SqliteConnection[] = [];
const driver = new NodeSqliteDriver({ DatabaseSync });
const context = {
  binding: {
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
  },
} as ProjectContext;

function mode(value: Record<string, unknown>): MigrationApplyMode {
  return value as MigrationApplyMode;
}

function emptyConnection(): SqliteConnection {
  const root = mkdtempSync(join(tmpdir(), "qualified-migration-"));
  roots.push(root);
  const connection = driver.open(join(root, "events.sqlite"), {
    mode: "create",
    busyTimeoutMs: 1_000,
  });
  connections.push(connection);
  return connection;
}

function insertIdentity(connection: SqliteConnection, schemaVersion: number): void {
  connection.prepare(`
    INSERT INTO project_meta(
      singleton, project_id, vault_id, store_id, schema_version, created_at
    ) VALUES (1, $projectId, $vaultId, $storeId, $schemaVersion, $createdAt)
  `).run({
    $projectId: PROJECT_ID,
    $vaultId: VAULT_ID,
    $storeId: STORE_ID,
    $schemaVersion: schemaVersion,
    $createdAt: NOW,
  });
  connection.exec(`
    INSERT INTO maintenance_state(
      singleton, epoch, mode, owner_id, fencing_token, lease_expires_at, requested_at
    ) VALUES (1, 0, 'idle', NULL, 0, NULL, NULL)
  `);
}

function sourceConnection(version: 1 | 2): SqliteConnection {
  const connection = emptyConnection();
  const runner = new MigrationRunner();
  runner.apply(connection, [eventCoreMigration], NOW, mode({
    kind: "bootstrap-empty",
    beforeMigration: () => undefined,
  }));
  insertIdentity(connection, 1);
  if (version === 2) {
    runner.apply(connection, registry.slice(0, 2), NOW, mode({
      kind: "explicit-upgrade",
      expectedAppliedVersion: 1,
      beforeMigration: () => undefined,
    }));
  }
  return connection;
}

function versions(connection: SqliteConnection): number[] {
  return connection.prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all().map((row) => Number(row.version));
}

function schemaVersion(connection: SqliteConnection): number {
  return Number(connection.prepare("SELECT schema_version FROM project_meta").get()?.schema_version);
}

function rawInsert(
  connection: SqliteConnection,
  table: string,
  values: Readonly<Record<string, SqliteValue>>,
): void {
  const columns = Object.keys(values);
  const parameters = Object.fromEntries(
    columns.map((column) => [`$${column}`, values[column]!]),
  ) as SqliteParams;
  connection.prepare(`
    INSERT INTO ${table}(${columns.join(", ")})
    VALUES (${columns.map((column) => `$${column}`).join(", ")})
  `).run(parameters);
}

function rawEvent(
  connection: SqliteConnection,
  position: number | bigint,
  options: {
    readonly streamType?: string;
    readonly sessionId?: string | null;
    readonly eventType?: string;
    readonly eventSchemaVersion?: number;
    readonly payload?: unknown;
    readonly streamVersion?: number | bigint;
    readonly parentSessionId?: string | null;
    readonly correlationId?: string;
  } = {},
): void {
  const positionValue = BigInt(position);
  const uuidTail = (offset: bigint): string => ((positionValue + offset) & 0xffff_ffff_ffffn)
    .toString(16).padStart(12, "0");
  const sessionId = options.sessionId ?? null;
  const streamType = options.streamType ?? "generic";
  rawInsert(connection, "events", {
    global_position: positionValue,
    event_id: `00000000-0000-4000-8000-${uuidTail(0n)}`,
    project_id: PROJECT_ID,
    vault_id: VAULT_ID,
    store_id: STORE_ID,
    workspace_id: "1".repeat(64),
    branch_scope_id: null,
    branch_ref: null,
    stream_id: sessionId === null ? `generic/${position}` : `session/${sessionId}`,
    stream_type: streamType,
    stream_version: options.streamVersion ?? 1,
    event_type: options.eventType ?? "GenericRecorded",
    event_schema_version: options.eventSchemaVersion ?? 1,
    session_id: sessionId,
    parent_session_id: options.parentSessionId ?? null,
    actor_role: "primary",
    agent_id: "agent-1",
    client_instance_id: "client-1",
    correlation_id: options.correlationId
      ?? `00000000-0000-4000-8000-${uuidTail(10_000n)}`,
    causation_id: null,
    command_id: `00000000-0000-4000-8000-${uuidTail(20_000n)}`,
    idempotency_key: `idempotency-${positionValue}`,
    command_event_index: 0,
    occurred_at: NOW,
    recorded_at: NOW,
    visibility_scope: "session",
    confidence: "high",
    verification_status: "verified",
    source_refs_json: "[]",
    evidence_refs_json: "[]",
    evidence_digests_json: "[]",
    payload_json: canonicalJson(options.payload ?? {}),
    payload_hash: H64,
    previous_global_hash: "0".repeat(64),
    event_hash: H64_B,
  });
}

function currentConnection(): SqliteConnection {
  const connection = sourceConnection(2);
  const preflight = new SqliteQualifiedCheckpointMigrationPreflight();
  new MigrationRunner().apply(connection, registry, NOW, mode({
    kind: "explicit-upgrade",
    expectedAppliedVersion: 2,
    beforeMigration(candidate: SqliteConnection, migration: { version: number }): void {
      if (migration.version === 3) preflight.assertEligibleAndStage(candidate, context);
    },
  }));
  connection.exec("PRAGMA foreign_keys = OFF");
  return connection;
}

function coverageRow(
  adapterSessionId = ADAPTER_ID,
  sessionId = ROOT_ID,
  overrides: Readonly<Record<string, SqliteValue>> = {},
): Record<string, SqliteValue> {
  return {
    project_id: PROJECT_ID,
    session_id: sessionId,
    adapter_session_id: adapterSessionId,
    capture_mode: "coverage-only",
    first_ordinal: 0,
    last_ordinal: 0,
    highest_contiguous_ordinal: 0,
    missing_intervals_json: "[]",
    fingerprint_algorithm: "hmac-sha256",
    fingerprint_schema_version: 1,
    fingerprint_key_id: "key-1",
    fingerprint_domain: "pm-evidence-frame-v1",
    latest_batch_id: BATCH_ID,
    latest_batch_event_position: 1,
    created_at: NOW,
    updated_at: NOW,
    coverage_fingerprint_algorithm: "hmac-sha256",
    coverage_fingerprint_schema_version: 1,
    coverage_fingerprint_key_id: "key-1",
    coverage_fingerprint_domain: "pm-evidence-coverage-v1",
    coverage_fingerprint_value: H64,
    ...overrides,
  };
}

function lifecycleWorkflow(
  overrides: Readonly<Record<string, SqliteValue>> = {},
): Record<string, SqliteValue> {
  return {
    project_id: PROJECT_ID,
    workflow_id: `session-end/${ROOT_ID}`,
    workflow_type: "session-end",
    generation: 1,
    state: "active",
    phase: "requested",
    root_command_id: "root-command",
    result_json: null,
    error_code: null,
    created_at: NOW,
    updated_at: NOW,
    session_id: ROOT_ID,
    triggering_event_position: 1,
    expected_authority_commitment: H64,
    coordinator_owner_id: null,
    coordinator_claim_token: null,
    coordinator_claim_expires_at: null,
    coordinator_attempt_count: 0,
    coordinator_failure_class: null,
    coordinator_error_code: null,
    coordinator_next_attempt_at: null,
    validation_attempt_plan_generation: null,
    validation_attempt_plans_json: null,
    evidence_frozen_checkpoint_event_position: null,
    evidence_frozen_generation: null,
    evidence_window_state: "sealed",
    final_ending_scope_bindings_json: null,
    ...overrides,
  };
}

function legacyLifecycleWorkflow(
  overrides: Readonly<Record<string, SqliteValue>> = {},
): Record<string, SqliteValue> {
  const row = lifecycleWorkflow(overrides);
  delete row.evidence_frozen_checkpoint_event_position;
  delete row.evidence_frozen_generation;
  delete row.evidence_window_state;
  delete row.final_ending_scope_bindings_json;
  return row;
}

function transitionRow(
  overrides: Readonly<Record<string, SqliteValue>> = {},
): Record<string, SqliteValue> {
  return {
    project_id: PROJECT_ID,
    session_id: ROOT_ID,
    adapter_session_id: ADAPTER_ID,
    batch_id: BATCH_ID,
    batch_event_position: 1,
    batch_first_ordinal: 0,
    batch_last_ordinal: 0,
    coverage_first_ordinal: 0,
    coverage_last_ordinal: 0,
    highest_contiguous_ordinal: 0,
    missing_intervals_json: "[]",
    frame_fingerprint_algorithm: "hmac-sha256",
    frame_fingerprint_schema_version: 1,
    frame_fingerprint_key_id: "key-1",
    frame_fingerprint_domain: "pm-evidence-frame-v1",
    previous_coverage_fingerprint_value: null,
    coverage_fingerprint_algorithm: "hmac-sha256",
    coverage_fingerprint_schema_version: 1,
    coverage_fingerprint_key_id: "key-1",
    coverage_fingerprint_domain: "pm-evidence-coverage-v1",
    coverage_fingerprint_value: H64,
    new_frame_count: 1,
    capture_mode: "coverage-only",
    content_retained: 0,
    created_at: NOW,
    ...overrides,
  };
}

function evidencePayload(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    adapterSessionId: ADAPTER_ID,
    batchId: BATCH_ID,
    batchFirstOrdinal: "0",
    batchLastOrdinal: "0",
    coverageFirstOrdinal: "0",
    coverageLastOrdinal: "0",
    highestContiguousOrdinal: "0",
    missingIntervals: [],
    frameFingerprintAlgorithm: "hmac-sha256",
    frameFingerprintSchemaVersion: 1,
    frameFingerprintKeyId: "key-1",
    frameFingerprintDomain: "pm-evidence-frame-v1",
    coverageFingerprintAlgorithm: "hmac-sha256",
    coverageFingerprintSchemaVersion: 1,
    coverageFingerprintKeyId: "key-1",
    coverageFingerprintDomain: "pm-evidence-coverage-v1",
    coverageFingerprint: H64,
    captureMode: "coverage-only",
    contentRetained: false,
    frames: [{
      frameId: "88888888-8888-4888-8888-888888888888",
      ordinal: "0",
      sourceKind: "model-turn",
      observedAt: NOW,
      contentFingerprint: H64_B,
    }],
    ...overrides,
  };
}

function evidenceFingerprintRow(
  overrides: Readonly<Record<string, SqliteValue>> = {},
): Record<string, SqliteValue> {
  return {
    project_id: PROJECT_ID,
    session_id: ROOT_ID,
    adapter_session_id: ADAPTER_ID,
    ordinal: 0,
    frame_id: "88888888-8888-4888-8888-888888888888",
    source_kind: "model-turn",
    observed_at: NOW,
    fingerprint_algorithm: "hmac-sha256",
    fingerprint_schema_version: 1,
    fingerprint_key_id: "key-1",
    fingerprint_domain: "pm-evidence-frame-v1",
    fingerprint_value: H64_B,
    batch_id: BATCH_ID,
    recorded_event_position: 1,
    created_at: NOW,
    ...overrides,
  };
}

function seedRootAuthorityForCoverage(connection: SqliteConnection): void {
  rawInsert(connection, "streams", {
    project_id: PROJECT_ID,
    stream_id: `session/${ROOT_ID}`,
    stream_type: "session",
    current_version: 2,
    created_at: NOW,
    updated_at: NOW,
  });
  rawInsert(connection, "session_authority", {
    project_id: PROJECT_ID,
    session_id: ROOT_ID,
    stream_id: `session/${ROOT_ID}`,
    session_kind: "root",
    parent_session_id: null,
    workspace_id: "1".repeat(64),
    client_namespace: "tests",
    semantic_state: "active",
    owner_generation: 1,
    child_capability_generation: null,
    direct_access_enabled: 0,
    continuity_fingerprint_algorithm: "hmac-sha256",
    continuity_fingerprint_schema_version: 1,
    continuity_fingerprint_key_id: "key-1",
    continuity_fingerprint_domain: "pm-continuity-v1",
    continuity_fingerprint: H64,
    root_handle_capability_version: 1,
    root_handle_key_id: "key-1",
    root_handle_issue_nonce: H64,
    root_handle_issued_at: NOW,
    root_handle_policy_code: "root-handle",
    root_handle_expiry_kind: "until-revoked",
    root_handle_expires_at: null,
    root_handle_actor_role: "primary",
    root_handle_client_instance_id: "client-1",
    root_handle_verifier: H64,
    root_handle_issuance_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    resume_token_capability_version: 1,
    resume_token_key_id: "key-1",
    resume_token_issue_nonce: H64,
    resume_token_issued_at: NOW,
    resume_token_policy_code: "resume-token",
    resume_token_expiry_kind: "until-revoked",
    resume_token_expires_at: null,
    resume_token_actor_role: "primary",
    resume_token_verifier: H64,
    resume_token_issuance_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    authority_commitment: H64,
    authority_event_position: 1,
    created_at: NOW,
    updated_at: NOW,
  });
}

function seedCoverageBaseline(connection: SqliteConnection): void {
  connection.exec("BEGIN IMMEDIATE");
  rawEvent(connection, 1, {
    streamType: "session",
    sessionId: ROOT_ID,
    eventType: "EvidenceCoverageRecorded",
    eventSchemaVersion: 2,
    payload: evidencePayload(),
  });
  rawInsert(connection, "session_evidence_coverage_transitions", transitionRow());
  rawInsert(connection, "session_evidence_coverage", coverageRow());
  rawInsert(connection, "session_evidence_fingerprints", evidenceFingerprintRow());
  connection.exec("COMMIT");
}

function seedSparseCoverageBaseline(connection: SqliteConnection): void {
  const secondBatch = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  connection.exec("BEGIN IMMEDIATE");
  rawEvent(connection, 1, {
    streamType: "session",
    sessionId: ROOT_ID,
    eventType: "EvidenceCoverageRecorded",
    eventSchemaVersion: 2,
    payload: evidencePayload({
      batchFirstOrdinal: "1",
      batchLastOrdinal: "1",
      coverageLastOrdinal: "1",
      highestContiguousOrdinal: null,
      missingIntervals: [{ firstOrdinal: "0", lastOrdinal: "0" }],
      frames: [{
        frameId: "aaaaaaaa-0000-4000-8000-000000000001",
        ordinal: "1",
        sourceKind: "tool-request",
        observedAt: NOW,
        contentFingerprint: H64,
      }],
    }),
  });
  rawInsert(connection, "session_evidence_coverage_transitions", transitionRow({
    batch_first_ordinal: 1,
    batch_last_ordinal: 1,
    coverage_last_ordinal: 1,
    highest_contiguous_ordinal: -1,
    missing_intervals_json: "[[0,0]]",
  }));
  rawInsert(connection, "session_evidence_coverage", coverageRow(
    ADAPTER_ID,
    ROOT_ID,
    {
      last_ordinal: 1,
      highest_contiguous_ordinal: -1,
      missing_intervals_json: "[[0,0]]",
    },
  ));
  rawInsert(connection, "session_evidence_fingerprints", evidenceFingerprintRow({
    ordinal: 1,
    frame_id: "aaaaaaaa-0000-4000-8000-000000000001",
    source_kind: "tool-request",
    fingerprint_value: H64,
  }));
  rawEvent(connection, 2, {
    streamType: "session",
    sessionId: ROOT_ID,
    streamVersion: 2,
    eventType: "EvidenceCoverageRecorded",
    eventSchemaVersion: 2,
    payload: evidencePayload({
      batchId: secondBatch,
      batchFirstOrdinal: "3",
      batchLastOrdinal: "3",
      coverageLastOrdinal: "3",
      highestContiguousOrdinal: null,
      missingIntervals: [
        { firstOrdinal: "0", lastOrdinal: "0" },
        { firstOrdinal: "2", lastOrdinal: "2" },
      ],
      coverageFingerprint: H64_B,
      frames: [{
        frameId: "aaaaaaaa-0000-4000-8000-000000000003",
        ordinal: "3",
        sourceKind: "tool-result",
        observedAt: NOW,
        contentFingerprint: H64_B,
      }],
    }),
  });
  rawInsert(connection, "session_evidence_coverage_transitions", transitionRow({
    batch_id: secondBatch,
    batch_event_position: 2,
    batch_first_ordinal: 3,
    batch_last_ordinal: 3,
    coverage_last_ordinal: 3,
    highest_contiguous_ordinal: -1,
    missing_intervals_json: "[[0,0],[2,2]]",
    previous_coverage_fingerprint_value: H64,
    coverage_fingerprint_value: H64_B,
  }));
  connection.prepare(`
    UPDATE session_evidence_coverage
    SET last_ordinal = 3, highest_contiguous_ordinal = -1,
        missing_intervals_json = '[[0,0],[2,2]]',
        latest_batch_id = $batchId, latest_batch_event_position = 2,
        coverage_fingerprint_value = $fingerprint, updated_at = $now
  `).run({ $batchId: secondBatch, $fingerprint: H64_B, $now: NOW });
  rawInsert(connection, "session_evidence_fingerprints", evidenceFingerprintRow({
    ordinal: 3,
    frame_id: "aaaaaaaa-0000-4000-8000-000000000003",
    source_kind: "tool-result",
    batch_id: secondBatch,
    recorded_event_position: 2,
  }));
  connection.exec("COMMIT");
}

function seedRootStart(connection: SqliteConnection, position = 1): void {
  rawEvent(connection, position, {
    streamType: "session",
    sessionId: ROOT_ID,
    streamVersion: 1,
    eventType: "SessionStarted",
    eventSchemaVersion: 1,
    payload: {
      sessionKind: "root",
      ownerGeneration: 1,
      continuityKey: "continuity-key",
      clientNamespace: "tests",
      creatingAgentId: "agent-1",
      creatingClientInstanceId: "client-1",
      authorityCommitment: H64,
    },
  });
}

function checkpointPayload(
  position: number,
  overrides: Parameters<typeof checkpointFixture>[0] = {},
): Record<string, unknown> {
  const checkpoint = checkpointFixture({
    sessionId: ROOT_ID as never,
    baseEventPosition: 1,
    checkpointEventPosition: position,
    ...overrides,
  });
  return {
    checkpoint,
    baseEventPosition: "1",
    checkpointEventPosition: String(position),
  };
}

function sessionEndStatus(
  phase: string,
  finalCheckpointId: string | null,
  finalCheckpointEventPosition: string | null,
): Record<string, unknown> {
  return {
    resultVersion: 2,
    sessionId: ROOT_ID,
    workflowId: `session-end/${ROOT_ID}`,
    workflowGeneration: 1,
    phase,
    priorRootState: "active",
    triggeringEventPosition: "1",
    finalCheckpointId,
    finalCheckpointEventPosition,
    evidenceWindow: {
      evidenceWindowState: "sealed",
      evidenceFrozenCheckpointEventPosition: finalCheckpointEventPosition,
      evidenceFrozenGeneration: finalCheckpointEventPosition === null ? null : 1,
    },
    validationPlansReady: false,
    qualityScore: null,
    safeFailureCode: null,
    materializationRequired: false,
  };
}

function currentChildBinding(
  index: number,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    bindingKind: "current-child",
    bindingVersion: 1,
    checkpointEventPosition: null,
    checkpointId: null,
    childSessionId: `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
    childState: "active",
    lastEventPosition: String(100_000 + index),
    streamVersion: "1",
    transferTicketEventPosition: null,
    transferTicketId: null,
    ...overrides,
  };
}

function endingScopeBytes(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value as never), "utf8");
}

function exactEndingScopeBindingBytes(targetBytes: number): readonly Record<string, unknown>[] {
  const bindings: Record<string, unknown>[] = [];
  let currentBytes = 2;
  while (true) {
    const next = currentChildBinding(bindings.length);
    const nextBytes = endingScopeBytes(next) + (bindings.length === 0 ? 0 : 1);
    if (currentBytes + nextBytes > targetBytes) break;
    bindings.push(next);
    currentBytes += nextBytes;
  }
  let remaining = targetBytes - currentBytes;
  for (let index = 0; index < bindings.length && remaining > 0; index += 1) {
    const increment = Math.min(18, remaining);
    bindings[index] = {
      ...bindings[index],
      streamVersion: `1${"0".repeat(increment)}`,
    };
    remaining -= increment;
  }
  if (remaining !== 0 || endingScopeBytes(bindings) !== targetBytes) {
    throw new Error(`unable to synthesize exact ${targetBytes}-byte ending scope`);
  }
  return bindings;
}

function phaseResult(
  action: string,
  previousPhase: string,
  status: Record<string, unknown>,
): Record<string, unknown> {
  return {
    resultVersion: 2,
    action,
    progressed: true,
    previousPhase,
    status,
  };
}

function seedRootFinalCheckpoint(
  connection: SqliteConnection,
  childSummaries: readonly Record<string, unknown>[] = [],
): ReturnType<typeof checkpointFixture> {
  const finalCheckpoint = {
    ...checkpointFixture({
      checkpointId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" as never,
      sessionId: ROOT_ID as never,
      baseEventPosition: 1,
      checkpointEventPosition: MAX_INT64,
    }),
    childSummaries,
  };
  rawEvent(connection, MAX_INT64, {
    streamType: "session",
    sessionId: ROOT_ID,
    streamVersion: 2,
    eventType: "SessionCheckpointRecorded",
    payload: {
      checkpoint: finalCheckpoint,
      baseEventPosition: "1",
      checkpointEventPosition: MAX_INT64.toString(),
    },
  });
  return finalCheckpoint as unknown as ReturnType<typeof checkpointFixture>;
}

function seedFinalWorkflowGuardFixture(
  connection: SqliteConnection,
  bindings: readonly Record<string, unknown>[],
  write: "insert" | "update",
  persistedBindings: readonly Record<string, unknown>[] = bindings,
  beforeWrite: () => void = () => undefined,
): void {
  connection.exec("DROP TRIGGER session_authority_insert_guard");
  for (const [index, binding] of bindings.entries()) {
    const childSessionId = String(binding.childSessionId);
    const lastEventPosition = BigInt(String(binding.lastEventPosition));
    const streamVersion = BigInt(String(binding.streamVersion));
    rawEvent(connection, lastEventPosition, {
      streamType: "session",
      sessionId: childSessionId,
      parentSessionId: ROOT_ID,
      streamVersion,
      eventType: "GenericSessionNote",
      payload: { fixtureIndex: index },
    });
    rawInsert(connection, "streams", {
      project_id: PROJECT_ID,
      stream_id: `session/${childSessionId}`,
      stream_type: "session",
      current_version: streamVersion,
      created_at: NOW,
      updated_at: NOW,
    });
    rawInsert(connection, "session_authority", {
      project_id: PROJECT_ID,
      session_id: childSessionId,
      stream_id: `session/${childSessionId}`,
      session_kind: "child",
      parent_session_id: ROOT_ID,
      workspace_id: "1".repeat(64),
      client_namespace: "tests",
      semantic_state: "active",
      direct_access_enabled: 0,
      authority_commitment: H64,
      authority_event_position: lastEventPosition,
      created_at: NOW,
      updated_at: NOW,
    });
  }
  const finalCheckpoint = seedRootFinalCheckpoint(
    connection,
    bindings.map((binding) => ({
      childSessionId: binding.childSessionId,
      state: binding.childState,
      lastEventPosition: binding.lastEventPosition,
      streamVersion: binding.streamVersion,
      latestCheckpointId: binding.checkpointId,
    })),
  );
  const status = sessionEndStatus(
    "final-checkpoint-recorded",
    String(finalCheckpoint.checkpointId),
    MAX_INT64.toString(),
  );
  const bindingsJson = canonicalJson(persistedBindings as never);
  beforeWrite();
  if (write === "insert") {
    rawInsert(connection, "workflow_instances", lifecycleWorkflow({
      phase: "final-checkpoint-recorded",
      result_json: canonicalJson(status),
      evidence_frozen_checkpoint_event_position: MAX_INT64,
      evidence_frozen_generation: 1,
      final_ending_scope_bindings_json: bindingsJson,
    }));
    return;
  }
  rawInsert(connection, "workflow_instances", lifecycleWorkflow({ phase: "children-resolved" }));
  connection.prepare(`
    UPDATE workflow_instances
    SET phase = 'final-checkpoint-recorded', result_json = $result,
        evidence_frozen_checkpoint_event_position = $position,
        evidence_frozen_generation = 1,
        final_ending_scope_bindings_json = $bindings
  `).run({
    $result: canonicalJson(phaseResult(
      "record-final-checkpoint-and-queue-ending",
      "children-resolved",
      status,
    )),
    $position: MAX_INT64,
    $bindings: bindingsJson,
  });
}

function seedTransferredFinalHistory(
  connection: SqliteConnection,
  options: {
    readonly summaryState?: "active" | "transferred";
    readonly ticketParentSessionId?: string;
    readonly includeTicket?: boolean;
    readonly includeSummary?: boolean;
    readonly phase?: "final-checkpoint-recorded" | "cancelled" | "abandoned";
  } = {},
): void {
  const childCorrelationId = "12121212-1212-4121-8121-121212121212";
  connection.exec("PRAGMA foreign_keys = OFF");
  connection.exec("DROP TRIGGER workflow_instances_lifecycle_insert_guard");
  seedRootStart(connection, 1);
  const childFork = lifecycleEvent(1, "SessionForked", {}, {
    projectId: PROJECT_ID as never,
    vaultId: VAULT_ID as never,
    storeId: STORE_ID as never,
    workspaceId: "1".repeat(64) as never,
    sessionId: CHILD_ID as never,
    parentSessionId: ROOT_ID as never,
    globalPosition: 2,
    streamVersion: 1,
    authorityCommitment: H64,
  });
  rawEvent(connection, 2, {
    streamType: "session",
    sessionId: CHILD_ID,
    parentSessionId: ROOT_ID,
    streamVersion: 1,
    eventType: "SessionForked",
    payload: childFork.payload,
    correlationId: childCorrelationId,
  });
  const childCheckpoint = checkpointFixture({
    checkpointId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as never,
    sessionId: CHILD_ID as never,
    parentSessionId: ROOT_ID as never,
    baseEventPosition: 2,
    checkpointEventPosition: 3,
  });
  rawEvent(connection, 3, {
    streamType: "session",
    sessionId: CHILD_ID,
    parentSessionId: ROOT_ID,
    streamVersion: 2,
    eventType: "SessionCheckpointRecorded",
    payload: {
      checkpoint: childCheckpoint,
      baseEventPosition: "2",
      checkpointEventPosition: "3",
    },
    correlationId: childCorrelationId,
  });
  const suspended = lifecycleEvent(3, "ChildSessionSuspended", {
    checkpointId: childCheckpoint.checkpointId,
    authorityCommitment: H64_B,
  }, {
    projectId: PROJECT_ID as never,
    vaultId: VAULT_ID as never,
    storeId: STORE_ID as never,
    workspaceId: "1".repeat(64) as never,
    sessionId: CHILD_ID as never,
    parentSessionId: ROOT_ID as never,
    globalPosition: 4,
    streamVersion: 3,
    authorityCommitment: H64_B,
  });
  rawEvent(connection, 4, {
    streamType: "session",
    sessionId: CHILD_ID,
    parentSessionId: ROOT_ID,
    streamVersion: 3,
    eventType: "ChildSessionSuspended",
    payload: suspended.payload,
    correlationId: childCorrelationId,
  });
  const transfer = lifecycleEvent(4, "ChildWorkTransferCreated", {
    checkpointId: childCheckpoint.checkpointId,
    authorityCommitment: H64_C,
  }, {
    projectId: PROJECT_ID as never,
    vaultId: VAULT_ID as never,
    storeId: STORE_ID as never,
    workspaceId: "1".repeat(64) as never,
    sessionId: CHILD_ID as never,
    parentSessionId: ROOT_ID as never,
    globalPosition: 5,
    streamVersion: 4,
    authorityCommitment: H64_C,
  });
  rawEvent(connection, 5, {
    streamType: "session",
    sessionId: CHILD_ID,
    parentSessionId: ROOT_ID,
    streamVersion: 4,
    eventType: "ChildWorkTransferCreated",
    payload: transfer.payload,
    correlationId: childCorrelationId,
  });
  rawInsert(connection, "streams", {
    project_id: PROJECT_ID,
    stream_id: `session/${CHILD_ID}`,
    stream_type: "session",
    current_version: 4,
    created_at: NOW,
    updated_at: NOW,
  });
  rawInsert(connection, "session_authority", {
    project_id: PROJECT_ID,
    session_id: CHILD_ID,
    stream_id: `session/${CHILD_ID}`,
    session_kind: "child",
    parent_session_id: ROOT_ID,
    workspace_id: "1".repeat(64),
    client_namespace: "tests",
    semantic_state: "transferred",
    owner_generation: null,
    child_capability_generation: null,
    direct_access_enabled: 0,
    authority_commitment: H64_C,
    authority_event_position: 5,
    latest_checkpoint_id: childCheckpoint.checkpointId,
    latest_checkpoint_event_position: 3,
    latest_checkpoint_fingerprint: createHash("sha256")
      .update("project-memory/checkpoint/v1\n", "utf8")
      .update(canonicalJson(childCheckpoint), "utf8")
      .digest("hex"),
    terminal_event_position: 5,
    terminal_event_type: "ChildWorkTransferCreated",
    terminal_at: NOW,
    created_at: NOW,
    updated_at: NOW,
  });
  if (options.includeTicket !== false) {
    rawInsert(connection, "child_transfer_tickets", {
      project_id: PROJECT_ID,
      transfer_ticket_id: transfer.payload.transferTicketId,
      source_parent_session_id: options.ticketParentSessionId ?? ROOT_ID,
      source_child_session_id: CHILD_ID,
      source_assignment_json: "{}",
      source_scope_json: "{}",
      checkpoint_id: childCheckpoint.checkpointId,
      follow_ups_json: "[]",
      source_state_json: "{}",
      lineage_json: "{}",
      created_event_position: 5,
      created_at: NOW,
      claimed_by_root_session_id: null,
      claimed_child_session_id: null,
      claimed_event_position: null,
      claimed_at: null,
    });
  }
  const rootFinal = {
    ...checkpointFixture({
      checkpointId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" as never,
      sessionId: ROOT_ID as never,
      baseEventPosition: 1,
      checkpointEventPosition: 6,
    }),
    childSummaries: options.includeSummary === false ? [] : [{
        childSessionId: CHILD_ID,
        state: options.summaryState ?? "transferred",
        lastEventPosition: "5",
        streamVersion: "4",
        latestCheckpointId: childCheckpoint.checkpointId,
      }],
  };
  rawEvent(connection, 6, {
    streamType: "session",
    sessionId: ROOT_ID,
    streamVersion: 2,
    eventType: "SessionCheckpointRecorded",
    payload: {
      checkpoint: rootFinal,
      baseEventPosition: "1",
      checkpointEventPosition: "6",
    },
  });
  const phase = options.phase ?? "final-checkpoint-recorded";
  rawInsert(connection, "workflow_instances", legacyLifecycleWorkflow({
    phase,
    result_json: canonicalJson(sessionEndStatus(
      phase,
      String(rootFinal.checkpointId),
      "6",
    )),
  }));
}

function installForgedEmptyStage(connection: SqliteConnection): void {
  connection.exec(`
    CREATE TEMP TABLE ${QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE} (
      workflow_id TEXT PRIMARY KEY,
      source_generation INTEGER NOT NULL,
      source_phase TEXT NOT NULL,
      evidence_frozen_checkpoint_event_position INTEGER,
      evidence_frozen_generation INTEGER,
      evidence_window_state TEXT NOT NULL,
      final_ending_scope_bindings_json TEXT
    ) STRICT;
    CREATE TEMP TABLE ${QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE} (
      singleton INTEGER PRIMARY KEY,
      project_id TEXT NOT NULL,
      vault_id TEXT NOT NULL,
      store_id TEXT NOT NULL,
      source_schema_version INTEGER NOT NULL,
      target_schema_version INTEGER NOT NULL,
      staged_row_count INTEGER NOT NULL,
      sealed INTEGER NOT NULL
    ) STRICT;
    INSERT INTO ${QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE}
    VALUES (1, '${PROJECT_ID}', '${VAULT_ID}', '${STORE_ID}', 2, 3, 0, 1);
    CREATE TEMP TRIGGER qualified_checkpoint_v3_stage_marker_no_insert
      BEFORE INSERT ON ${QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE}
      BEGIN SELECT RAISE(ABORT, 'MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED'); END;
    CREATE TEMP TRIGGER qualified_checkpoint_v3_stage_marker_no_update
      BEFORE UPDATE ON ${QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE}
      BEGIN SELECT RAISE(ABORT, 'MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED'); END;
    CREATE TEMP TRIGGER qualified_checkpoint_v3_stage_marker_no_delete
      BEFORE DELETE ON ${QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE}
      BEGIN SELECT RAISE(ABORT, 'MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED'); END;
    CREATE TEMP TRIGGER qualified_checkpoint_v3_stage_rows_no_insert
      BEFORE INSERT ON ${QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE}
      BEGIN SELECT RAISE(ABORT, 'MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED'); END;
    CREATE TEMP TRIGGER qualified_checkpoint_v3_stage_rows_no_update
      BEFORE UPDATE ON ${QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE}
      BEGIN SELECT RAISE(ABORT, 'MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED'); END;
    CREATE TEMP TRIGGER qualified_checkpoint_v3_stage_rows_no_delete
      BEFORE DELETE ON ${QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE}
      BEGIN SELECT RAISE(ABORT, 'MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED'); END;
  `);
}

afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("qualified checkpoint migration", () => {
  it("requires migration-3 preflight for every explicit upgrade", () => {
    for (const beforeMigration of [undefined, () => undefined]) {
      const connection = sourceConnection(2);
      assert.throws(
        () => new MigrationRunner().apply(connection, registry, NOW, mode({
          kind: "explicit-upgrade",
          expectedAppliedVersion: 2,
          ...(beforeMigration === undefined ? {} : { beforeMigration }),
        })),
        beforeMigration === undefined
          ? /MIGRATION_MODE_INVALID/
          : /MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED/,
      );
      assert.deepEqual(versions(connection), [1, 2]);
      assert.equal(schemaVersion(connection), 2);
      assert.equal(
        connection.prepare(`
          SELECT count(*) AS count FROM sqlite_schema
          WHERE name = 'session_evidence_coverage_transitions'
        `).get()?.count,
        0n,
      );
    }
  });

  it("consumes and drops the canonical staged backfill exactly once", () => {
    const connection = sourceConnection(2);
    const preflight = new SqliteQualifiedCheckpointMigrationPreflight();
    const applied = new MigrationRunner().apply(connection, registry, NOW, mode({
      kind: "explicit-upgrade",
      expectedAppliedVersion: 2,
      beforeMigration(candidate: SqliteConnection, migration: { version: number }): void {
        if (migration.version === 3) preflight.assertEligibleAndStage(candidate, context);
      },
    }));

    assert.deepEqual(applied, [3]);
    assert.deepEqual(versions(connection), [1, 2, 3]);
    assert.equal(schemaVersion(connection), 3);
    assert.equal(
      connection.prepare(`
        SELECT count(*) AS count FROM temp.sqlite_schema
        WHERE name IN ($marker, $rows)
      `).get({
        $marker: QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE,
        $rows: QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE,
      })?.count,
      0n,
    );
    assert.throws(
      () => connection.exec(qualifiedCheckpointCoverageMigration.sql),
      /MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED/,
    );
  });

  it("rolls schema-1 and schema-2 sources back after staged-backfill failure", () => {
    for (const sourceVersion of [1, 2] as const) {
      const connection = sourceConnection(sourceVersion);
      const preflight = new SqliteQualifiedCheckpointMigrationPreflight();
      assert.throws(
        () => new MigrationRunner().apply(connection, registry, NOW, mode({
          kind: "explicit-upgrade",
          expectedAppliedVersion: sourceVersion,
          beforeMigration(candidate: SqliteConnection, migration: { version: number }): void {
            if (migration.version !== 3) return;
            preflight.assertEligibleAndStage(candidate, context);
            candidate.exec(`
              DROP TRIGGER qualified_checkpoint_v3_stage_marker_no_update;
              UPDATE ${QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE}
              SET staged_row_count = staged_row_count + 1;
            `);
          },
        })),
        /MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED/,
      );
      assert.deepEqual(versions(connection), sourceVersion === 1 ? [1] : [1, 2]);
      assert.equal(schemaVersion(connection), sourceVersion);
      assert.equal(
        connection.prepare(`
          SELECT count(*) AS count FROM sqlite_schema
          WHERE name = 'session_evidence_coverage_transitions'
        `).get()?.count,
        0n,
      );
      assert.equal(
        connection.prepare(`
          SELECT count(*) AS count FROM temp.sqlite_schema
          WHERE name GLOB 'qualified_checkpoint_v3_stage*'
        `).get()?.count,
        0n,
      );
    }
  });

  it("freezes schema-3 registry, manifest, migration-2 bytes, and old-reader fencing", () => {
    assert.deepEqual(PROJECT_STORE_MIGRATIONS.map((migration) => migration.version), [1, 2, 3]);
    assert.equal(CURRENT_PROJECT_STORE_SCHEMA_VERSION, 3);
    assert.equal(parseStoreManifest({
      schemaVersion: 1,
      storeId: STORE_ID,
      projectId: PROJECT_ID,
      vaultId: VAULT_ID,
      createdAt: NOW,
      lastIntegrity: { status: "never" },
    }).schemaVersion, 1);
    const migration2Path = join(
      process.cwd(),
      "src/orchestrator/storage/migrations/0002-session-lifecycle.ts",
    );
    assert.equal(
      createHash("sha256").update(readFileSync(migration2Path)).digest("hex").toUpperCase(),
      "68B4039048A359C523B7842F6D17BAA5760E9760D2B4E9F80BB8A48DC339EB06",
    );

    const connection = currentConnection();
    assert.deepEqual(versions(connection), [1, 2, 3]);
    assert.equal(schemaVersion(connection), 3);
    assert.throws(
      () => inspectStoreSchema(connection, registry.slice(0, 2)),
      /SCHEMA_TOO_NEW/,
    );
  });

  it("installs the exact schema-3 columns, strict transition table, indexes, and guards", () => {
    const connection = currentConnection();
    const coverageColumns = connection.prepare("PRAGMA table_info(session_evidence_coverage)")
      .all().map((row) => String(row.name));
    assert.deepEqual(coverageColumns.slice(-5), [
      "coverage_fingerprint_algorithm",
      "coverage_fingerprint_schema_version",
      "coverage_fingerprint_key_id",
      "coverage_fingerprint_domain",
      "coverage_fingerprint_value",
    ]);
    const workflowColumns = connection.prepare("PRAGMA table_info(workflow_instances)")
      .all().map((row) => String(row.name));
    assert.deepEqual(workflowColumns.slice(-4), [
      "evidence_frozen_checkpoint_event_position",
      "evidence_frozen_generation",
      "evidence_window_state",
      "final_ending_scope_bindings_json",
    ]);
    const transitionSql = String(connection.prepare(`
      SELECT sql FROM sqlite_schema
      WHERE type = 'table' AND name = 'session_evidence_coverage_transitions'
    `).get()?.sql);
    assert.match(transitionSql, /STRICT$/);
    assert.doesNotMatch(transitionSql, /observed_at|content_fingerprint|body|evidence_reference/i);
    const headSql = String(connection.prepare(`
      SELECT sql FROM sqlite_schema
      WHERE type = 'table' AND name = 'session_evidence_coverage_transition_heads'
    `).get()?.sql);
    assert.match(headSql, /DEFERRABLE INITIALLY DEFERRED/);
    assert.match(headSql, /STRICT$/);
    assert.equal(connection.prepare(`
      SELECT count(*) AS count FROM sqlite_schema
      WHERE type = 'index' AND name IN (
        'session_evidence_coverage_project_adapter',
        'session_evidence_coverage_transitions_snapshot',
        'session_evidence_coverage_latest_transition'
      )
    `).get()?.count, 3n);
    assert.equal(connection.prepare(`
      SELECT count(*) AS count FROM sqlite_schema
      WHERE type = 'trigger' AND name IN (
        'session_evidence_coverage_v3_insert_guard',
        'session_evidence_coverage_v3_update_guard',
        'session_evidence_coverage_no_delete',
        'session_evidence_coverage_transitions_insert_guard',
        'session_evidence_coverage_transitions_advance_head',
        'session_evidence_coverage_transitions_no_update',
        'session_evidence_coverage_transitions_no_delete',
        'events_lifecycle_version_v3_guard',
        'workflow_instances_evidence_v3_insert_guard',
        'workflow_instances_evidence_v3_update_guard'
      )
    `).get()?.count, 10n);
    assert.match(
      qualifiedCheckpointCoverageMigration.sql,
      /length\(CAST\(NEW\.final_ending_scope_bindings_json AS BLOB\)\) > 262144/,
    );
  });

  it("installs an index-backed exact historical evidence-artifact predicate", () => {
    const connection = currentConnection();
    const indexSql = String(connection.prepare(`
      SELECT sql FROM sqlite_schema
      WHERE type = 'index' AND name = 'events_session_evidence_artifacts'
    `).get()?.sql);
    assert.match(
      indexSql,
      /ON events\(project_id, session_id\)/,
    );
    assert.match(
      indexSql,
      /stream_type = 'session'[\s\S]*session_id IS NOT NULL/,
    );
    assert.match(
      indexSql,
      /event_type = 'EvidenceCoverageRecorded'/,
    );
    assert.doesNotMatch(
      indexSql,
      /EvidenceCoverageRecorded'[\s\S]{0,120}event_schema_version/,
    );
    assert.match(
      indexSql,
      /highestContiguousOrdinal[\s\S]*missingIntervals[\s\S]*adapterSessions/,
    );

    const plan = connection.prepare(`
      EXPLAIN QUERY PLAN
      SELECT 1
      FROM events
      WHERE project_id = $projectId
        AND session_id = $sessionId
        AND stream_type = 'session'
        AND session_id IS NOT NULL
        AND (
          event_type = 'EvidenceCoverageRecorded'
          OR (
            event_type = 'SessionCheckpointRecorded'
            AND (
              json_extract(
                payload_json,
                '$.checkpoint.evidenceCoverage.highestContiguousOrdinal'
              ) IS NOT NULL
              OR coalesce(json_array_length(
                payload_json,
                '$.checkpoint.evidenceCoverage.missingIntervals'
              ), 0) > 0
              OR coalesce(json_array_length(
                payload_json,
                '$.checkpoint.evidenceCoverage.adapterSessions'
              ), 0) > 0
            )
          )
        )
      LIMIT 1
    `).all({
      $projectId: PROJECT_ID,
      $sessionId: ROOT_ID,
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

  it("runs the migration-3 hook after complete uncommitted schema 2 on every source path", () => {
    const sourceVersions = [0, 1, 2] as const;
    for (const sourceVersion of sourceVersions) {
      const connection = sourceVersion === 0 ? emptyConnection() : sourceConnection(sourceVersion);
      const observed: Array<{ history: number[]; identity: number; v2: bigint; v3: bigint }> = [];
      const preflight = new SqliteQualifiedCheckpointMigrationPreflight();
      const applied = new MigrationRunner().apply(connection, registry, NOW, mode({
        kind: sourceVersion === 0 ? "bootstrap-empty" : "explicit-upgrade",
        ...(sourceVersion === 0 ? {} : { expectedAppliedVersion: sourceVersion }),
        beforeMigration(candidate: SqliteConnection, migration: { version: number }): void {
          if (migration.version !== 3) return;
          if (sourceVersion === 0) insertIdentity(candidate, 2);
          observed.push({
            history: versions(candidate),
            identity: schemaVersion(candidate),
            v2: candidate.prepare(`
              SELECT count(*) AS count FROM sqlite_schema
              WHERE name = 'session_evidence_coverage'
            `).get()?.count as bigint,
            v3: candidate.prepare(`
              SELECT count(*) AS count FROM sqlite_schema
              WHERE name = 'session_evidence_coverage_transitions'
            `).get()?.count as bigint,
          });
          preflight.assertEligibleAndStage(candidate, context);
        },
      }));
      assert.deepEqual(observed, [{ history: [1, 2], identity: 2, v2: 1n, v3: 0n }]);
      assert.deepEqual(applied, sourceVersion === 0 ? [1, 2, 3]
        : sourceVersion === 1 ? [2, 3] : [3]);
      assert.deepEqual(versions(connection), [1, 2, 3]);
      assert.equal(schemaVersion(connection), 3);
    }
  });

  it("seals stage identity last and makes both TEMP tables immutable", () => {
    const connection = sourceConnection(2);
    connection.exec("BEGIN IMMEDIATE");
    new SqliteQualifiedCheckpointMigrationPreflight().assertEligibleAndStage(connection, context);
    assert.equal(connection.prepare(`
      SELECT sealed, staged_row_count FROM ${QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE}
    `).get()?.sealed, 1n);
    for (const mutation of [
      `INSERT INTO ${QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE}(
        singleton, project_id, vault_id, store_id, source_schema_version,
        target_schema_version, staged_row_count, sealed
      ) VALUES (2, '${PROJECT_ID}', '${VAULT_ID}', '${STORE_ID}', 2, 3, 0, 1)`,
      `UPDATE ${QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE} SET staged_row_count = 1`,
      `DELETE FROM ${QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE}`,
      `INSERT INTO ${QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE}(
        workflow_id, source_generation, source_phase, evidence_window_state
      ) VALUES ('fake', 1, 'requested', 'sealed')`,
    ]) {
      assert.throws(() => connection.exec(mutation), /MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED/);
    }
    connection.exec("ROLLBACK");
    assert.equal(connection.prepare(`
      SELECT count(*) AS count FROM temp.sqlite_schema
      WHERE name GLOB 'qualified_checkpoint_v3_stage*'
    `).get()?.count, 0n);
  });

  it("rejects missing, extra, wrong-identity, and mutated staged handoffs atomically", () => {
    const mutations = [
      `DROP TRIGGER qualified_checkpoint_v3_stage_marker_no_update;
       UPDATE ${QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE} SET project_id = 'wrong'`,
      `DROP TRIGGER qualified_checkpoint_v3_stage_marker_no_update;
       UPDATE ${QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE} SET staged_row_count = 1`,
      `DROP TRIGGER qualified_checkpoint_v3_stage_marker_no_delete;
       DELETE FROM ${QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE}`,
      `DROP TRIGGER qualified_checkpoint_v3_stage_rows_no_insert;
       INSERT INTO ${QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE}(
         workflow_id, source_generation, source_phase, evidence_window_state
       ) VALUES ('extra', 1, 'requested', 'sealed')`,
    ];
    for (const mutation of mutations) {
      const connection = sourceConnection(2);
      connection.exec("BEGIN IMMEDIATE");
      new SqliteQualifiedCheckpointMigrationPreflight().assertEligibleAndStage(connection, context);
      connection.exec(mutation);
      assert.throws(
        () => connection.exec(qualifiedCheckpointCoverageMigration.sql),
        /MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED/,
      );
      connection.exec("ROLLBACK");
      assert.deepEqual(versions(connection), [1, 2]);
      assert.equal(schemaVersion(connection), 2);
      assert.equal(connection.prepare(`
        SELECT count(*) AS count FROM temp.sqlite_schema
        WHERE name GLOB 'qualified_checkpoint_v3_stage*'
      `).get()?.count, 0n);
    }
  });

  it("semantically revalidates staged frozen rows before any schema-3 copy", () => {
    const connection = sourceConnection(2);
    connection.exec("PRAGMA foreign_keys = OFF");
    rawInsert(connection, "workflow_instances", legacyLifecycleWorkflow());
    assert.throws(
      () => new MigrationRunner().apply(connection, registry, NOW, mode({
        kind: "explicit-upgrade",
        expectedAppliedVersion: 2,
        beforeMigration(candidate: SqliteConnection, migration: { version: number }): void {
          if (migration.version !== 3) return;
          new SqliteQualifiedCheckpointMigrationPreflight()
            .assertEligibleAndStage(candidate, context);
          candidate.exec(`
            DROP TRIGGER qualified_checkpoint_v3_stage_rows_no_update;
            UPDATE ${QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE}
            SET evidence_frozen_checkpoint_event_position = 999,
                evidence_frozen_generation = 1,
                final_ending_scope_bindings_json = '[]';
            CREATE TEMP TRIGGER qualified_checkpoint_v3_stage_rows_no_update
            BEFORE UPDATE ON ${QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE}
            BEGIN SELECT RAISE(ABORT, 'MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED'); END;
          `);
        },
      })),
      /MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED/,
    );
    assert.deepEqual(versions(connection), [1, 2]);
    assert.equal(schemaVersion(connection), 2);
  });

  it("rejects recreated stage trigger names with the wrong target, operation, or body", () => {
    const replacements = [
      `CREATE TEMP TRIGGER qualified_checkpoint_v3_stage_marker_no_insert
       BEFORE UPDATE ON ${QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE}
       BEGIN SELECT RAISE(ABORT, 'MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED'); END;`,
      `CREATE TEMP TRIGGER qualified_checkpoint_v3_stage_marker_no_insert
       BEFORE INSERT ON ${QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE}
       BEGIN SELECT RAISE(ABORT, 'WRONG_BODY'); END;`,
    ];
    for (const replacement of replacements) {
      const connection = sourceConnection(2);
      assert.throws(
        () => new MigrationRunner().apply(connection, registry, NOW, mode({
          kind: "explicit-upgrade",
          expectedAppliedVersion: 2,
          beforeMigration(candidate: SqliteConnection, migration: { version: number }): void {
            if (migration.version !== 3) return;
            new SqliteQualifiedCheckpointMigrationPreflight()
              .assertEligibleAndStage(candidate, context);
            candidate.exec(`
              DROP TRIGGER qualified_checkpoint_v3_stage_marker_no_insert;
              ${replacement}
            `);
          },
        })),
        /MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED/,
      );
      assert.deepEqual(versions(connection), [1, 2]);
      assert.equal(schemaVersion(connection), 2);
    }
  });

  it("does not let a forged override smuggle malformed legacy lifecycle history", () => {
    const connection = sourceConnection(2);
    connection.exec("PRAGMA foreign_keys = OFF");
    seedRootStart(connection);
    rawEvent(connection, 2, {
      streamType: "session",
      sessionId: ROOT_ID,
      streamVersion: 2,
      eventType: "SessionSuspended",
      eventSchemaVersion: 1,
      payload: { authorityCommitment: H64, unexpected: true },
    });
    assert.throws(
      () => new MigrationRunner().apply(connection, registry, NOW, mode({
        kind: "explicit-upgrade",
        expectedAppliedVersion: 2,
        beforeMigration(candidate: SqliteConnection, migration: { version: number }): void {
          if (migration.version === 3) installForgedEmptyStage(candidate);
        },
      })),
      /MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED/,
    );
    assert.deepEqual(versions(connection), [1, 2]);
    assert.equal(schemaVersion(connection), 2);
  });

  it("backstops malformed legacy lifecycle history inside target SQL", () => {
    const connection = sourceConnection(2);
    connection.exec("PRAGMA foreign_keys = OFF");
    seedRootStart(connection);
    rawEvent(connection, 2, {
      streamType: "session",
      sessionId: ROOT_ID,
      streamVersion: 2,
      eventType: "SessionSuspended",
      eventSchemaVersion: 1,
      payload: { authorityCommitment: H64, unexpected: true },
    });
    installForgedEmptyStage(connection);
    assert.throws(
      () => connection.exec(qualifiedCheckpointCoverageMigration.sql),
      /MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED/,
    );
    assert.equal(schemaVersion(connection), 2);
  });

  it("normalizes only the exact migration precondition failure tuple", () => {
    const exact = Object.assign(new Error("MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 1811,
    });
    assert.equal(
      qualifiedCheckpointMigrationFailure(exact)?.code,
      "MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED",
    );
    for (const candidate of [
      Object.assign(new Error("MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED"), {
        code: "ERR_SQLITE_ERROR", errcode: 1,
      }),
      Object.assign(new Error("other"), { code: "ERR_SQLITE_ERROR", errcode: 1811 }),
      Object.assign(new Error("MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED"), {
        code: "OTHER", errcode: 1811,
      }),
      new TypeError("MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED"),
    ]) assert.equal(qualifiedCheckpointMigrationFailure(candidate), undefined);
  });

  it("preserves unrelated preflight error identity while normalizing recognized failures", () => {
    const connection = sourceConnection(2);
    const sentinel = Object.assign(new Error("unrelated sentinel"), {
      code: "UNRELATED_DRIVER_FAILURE",
    });
    const throwingConnection: SqliteConnection = {
      exec: (sql) => connection.exec(sql),
      prepare(sql) {
        if (sql.includes("FROM project_meta")) throw sentinel;
        return connection.prepare(sql);
      },
      close: () => undefined,
    };
    let observed: unknown;
    try {
      new SqliteQualifiedCheckpointMigrationPreflight()
        .assertEligibleAndStage(throwingConnection, context);
    } catch (error) {
      observed = error;
    }
    assert.equal(observed, sentinel);

    const semanticConnection = sourceConnection(2);
    assert.throws(
      () => new SqliteQualifiedCheckpointMigrationPreflight().assertEligibleAndStage(
        semanticConnection,
        {
          binding: {
            ...context.binding,
            projectId: OTHER_ROOT_ID,
          },
        } as ProjectContext,
      ),
      (error) => (
        typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED"
      ),
    );

    const sqliteGuardConnection = sourceConnection(2);
    const sqliteGuard = Object.assign(
      new Error("MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED"),
      { code: "ERR_SQLITE_ERROR", errcode: 1811 },
    );
    const guardedConnection: SqliteConnection = {
      exec: (sql) => sqliteGuardConnection.exec(sql),
      prepare(sql) {
        if (sql.includes("FROM project_meta")) throw sqliteGuard;
        return sqliteGuardConnection.prepare(sql);
      },
      close: () => undefined,
    };
    assert.throws(
      () => new SqliteQualifiedCheckpointMigrationPreflight()
        .assertEligibleAndStage(guardedConnection, context),
      (error) => (
        error !== sqliteGuard
        && typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED"
      ),
    );
  });

  it("ignores unrelated generic outer Version 2 rows but rejects unsupported lifecycle history", () => {
    const accepted = sourceConnection(2);
    accepted.exec("PRAGMA foreign_keys = OFF");
    rawEvent(accepted, 1, {
      streamType: "session",
      sessionId: ROOT_ID,
      eventType: "GenericSessionNote",
      eventSchemaVersion: 2,
      payload: { arbitrary: true },
    });
    accepted.exec("BEGIN IMMEDIATE");
    new SqliteQualifiedCheckpointMigrationPreflight().assertEligibleAndStage(accepted, context);
    accepted.exec("ROLLBACK");

    for (const eventType of ["SessionStarted", "SessionCheckpointRecorded"]) {
      const rejected = sourceConnection(2);
      rejected.exec("PRAGMA foreign_keys = OFF");
      rawEvent(rejected, 1, {
        streamType: "session",
        sessionId: ROOT_ID,
        eventType,
        eventSchemaVersion: 2,
        payload: {},
      });
      assert.throws(
        () => new SqliteQualifiedCheckpointMigrationPreflight()
          .assertEligibleAndStage(rejected, context),
        /MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED/,
      );
    }
  });

  it("rejects missing nested lifecycle version tags while preserving generic positive versions", () => {
    const connection = currentConnection();
    const invalid = [
      { eventType: "SessionCheckpointRecorded", eventSchemaVersion: 1, payload: { checkpoint: {} } },
      { eventType: "SessionCheckpointRecorded", eventSchemaVersion: 2, payload: { checkpoint: {} } },
      { eventType: "SessionEndRequested", eventSchemaVersion: 2, payload: {} },
      { eventType: "SessionEndAmended", eventSchemaVersion: 2, payload: {} },
      { eventType: "SessionStarted", eventSchemaVersion: 2, payload: {} },
    ];
    for (const [index, candidate] of invalid.entries()) {
      assert.throws(
        () => rawEvent(connection, 10 + index, {
          streamType: "session",
          sessionId: ROOT_ID,
          ...candidate,
        }),
        /LIFECYCLE_EVENT_VERSION_INVALID/,
        `${candidate.eventType}/${candidate.eventSchemaVersion}`,
      );
    }
    rawEvent(connection, 2_000_000, {
      eventType: "GenericRecorded",
      eventSchemaVersion: 99,
      payload: { version: 99 },
    });
    assert.equal(connection.prepare(`
      SELECT event_schema_version FROM events WHERE global_position = 2000000
    `).get()?.event_schema_version, 99n);
  });

  it("ties every aggregate projection byte-for-byte to its immutable latest transition", () => {
    const connection = currentConnection();
    rawEvent(connection, 1, {
      streamType: "session",
      sessionId: ROOT_ID,
      eventType: "EvidenceCoverageRecorded",
      eventSchemaVersion: 2,
      payload: evidencePayload(),
    });
    rawInsert(connection, "session_evidence_coverage_transitions", transitionRow());
    assert.throws(
      () => rawInsert(connection, "session_evidence_coverage", coverageRow(
        ADAPTER_ID,
        ROOT_ID,
        { last_ordinal: 1 },
      )),
      /SESSION_EVIDENCE_COVERAGE_INVALID/,
    );
    rawInsert(connection, "session_evidence_coverage", coverageRow());
    assert.throws(
      () => connection.exec(`
        UPDATE session_evidence_coverage SET coverage_fingerprint_value = '${H64_B}'
      `),
      /SESSION_EVIDENCE_COVERAGE_INVALID/,
    );
    assert.throws(
      () => connection.exec("DELETE FROM session_evidence_coverage"),
      /SESSION_EVIDENCE_COVERAGE_IMMUTABLE/,
    );
    assert.throws(
      () => connection.exec(`
        UPDATE session_evidence_coverage_transitions SET new_frame_count = 2
      `),
      /SESSION_EVIDENCE_COVERAGE_TRANSITION_IMMUTABLE/,
    );
    assert.throws(
      () => connection.exec("DELETE FROM session_evidence_coverage_transitions"),
      /SESSION_EVIDENCE_COVERAGE_TRANSITION_IMMUTABLE/,
    );
  });

  it("accepts an identical-overlap batch with zero genuinely new frames", () => {
    const connection = currentConnection();
    seedCoverageBaseline(connection);
    const secondBatch = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    assert.doesNotThrow(() => {
      connection.exec("BEGIN IMMEDIATE");
      rawEvent(connection, 2, {
        streamType: "session",
        sessionId: ROOT_ID,
        streamVersion: 2,
        eventType: "EvidenceCoverageRecorded",
        eventSchemaVersion: 2,
        payload: evidencePayload({ batchId: secondBatch }),
      });
      rawInsert(connection, "session_evidence_coverage_transitions", transitionRow({
        batch_id: secondBatch,
        batch_event_position: 2,
        previous_coverage_fingerprint_value: H64,
        new_frame_count: 0,
      }));
      connection.prepare(`
        UPDATE session_evidence_coverage
        SET latest_batch_id = $batchId, latest_batch_event_position = 2,
            updated_at = $now
      `).run({ $batchId: secondBatch, $now: NOW });
      connection.exec("COMMIT");
    });
  });

  it("accepts a mixed-overlap batch whose genuinely-new subset is sparse", () => {
    const connection = currentConnection();
    seedSparseCoverageBaseline(connection);
    const thirdBatch = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const frames = [
      {
        frameId: "aaaaaaaa-0000-4000-8000-000000000000",
        ordinal: "0",
        sourceKind: "model-turn",
        observedAt: NOW,
        contentFingerprint: H64_C,
      },
      {
        frameId: "aaaaaaaa-0000-4000-8000-000000000001",
        ordinal: "1",
        sourceKind: "tool-request",
        observedAt: NOW,
        contentFingerprint: H64,
      },
      {
        frameId: "aaaaaaaa-0000-4000-8000-000000000002",
        ordinal: "2",
        sourceKind: "external-observation",
        observedAt: NOW,
        contentFingerprint: H64_C,
      },
      {
        frameId: "aaaaaaaa-0000-4000-8000-000000000003",
        ordinal: "3",
        sourceKind: "tool-result",
        observedAt: NOW,
        contentFingerprint: H64_B,
      },
      {
        frameId: "aaaaaaaa-0000-4000-8000-000000000004",
        ordinal: "4",
        sourceKind: "adapter-event",
        observedAt: NOW,
        contentFingerprint: H64_C,
      },
    ];
    assert.doesNotThrow(() => {
      connection.exec("BEGIN IMMEDIATE");
      rawEvent(connection, 3, {
        streamType: "session",
        sessionId: ROOT_ID,
        streamVersion: 3,
        eventType: "EvidenceCoverageRecorded",
        eventSchemaVersion: 2,
        payload: evidencePayload({
          batchId: thirdBatch,
          batchLastOrdinal: "4",
          coverageLastOrdinal: "4",
          highestContiguousOrdinal: "4",
          coverageFingerprint: H64_C,
          frames,
        }),
      });
      rawInsert(connection, "session_evidence_coverage_transitions", transitionRow({
        batch_id: thirdBatch,
        batch_event_position: 3,
        batch_last_ordinal: 4,
        coverage_last_ordinal: 4,
        highest_contiguous_ordinal: 4,
        previous_coverage_fingerprint_value: H64_B,
        coverage_fingerprint_value: H64_C,
        new_frame_count: 3,
      }));
      connection.prepare(`
        UPDATE session_evidence_coverage
        SET last_ordinal = 4, highest_contiguous_ordinal = 4,
            missing_intervals_json = '[]',
            latest_batch_id = $batchId, latest_batch_event_position = 3,
            coverage_fingerprint_value = $fingerprint, updated_at = $now
      `).run({
        $batchId: thirdBatch,
        $fingerprint: H64_C,
        $now: NOW,
      });
      rawInsert(connection, "session_evidence_fingerprints", evidenceFingerprintRow({
        ordinal: 0,
        frame_id: "aaaaaaaa-0000-4000-8000-000000000000",
        fingerprint_value: H64_C,
        batch_id: thirdBatch,
        recorded_event_position: 3,
      }));
      rawInsert(connection, "session_evidence_fingerprints", evidenceFingerprintRow({
        ordinal: 2,
        frame_id: "aaaaaaaa-0000-4000-8000-000000000002",
        source_kind: "external-observation",
        fingerprint_value: H64_C,
        batch_id: thirdBatch,
        recorded_event_position: 3,
      }));
      rawInsert(connection, "session_evidence_fingerprints", evidenceFingerprintRow({
        ordinal: 4,
        frame_id: "aaaaaaaa-0000-4000-8000-000000000004",
        source_kind: "adapter-event",
        fingerprint_value: H64_C,
        batch_id: thirdBatch,
        recorded_event_position: 3,
      }));
      connection.exec("COMMIT");
    });
  });

  it("rejects a contradictory overlap before transition persistence", () => {
    const connection = currentConnection();
    seedCoverageBaseline(connection);
    const secondBatch = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    rawEvent(connection, 2, {
      streamType: "session",
      sessionId: ROOT_ID,
      streamVersion: 2,
      eventType: "EvidenceCoverageRecorded",
      eventSchemaVersion: 2,
      payload: evidencePayload({
        batchId: secondBatch,
        frames: [{
          frameId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
          ordinal: "0",
          sourceKind: "model-turn",
          observedAt: NOW,
          contentFingerprint: H64_B,
        }],
      }),
    });
    assert.throws(
      () => rawInsert(connection, "session_evidence_coverage_transitions", transitionRow({
        batch_id: secondBatch,
        batch_event_position: 2,
        previous_coverage_fingerprint_value: H64,
        new_frame_count: 0,
      })),
      /SESSION_EVIDENCE_COVERAGE_TRANSITION_INVALID/,
    );
  });

  it("rejects coercive or incomplete evidence interval and decimal payloads", () => {
    const cases = [
      {
        payload: evidencePayload({ unexpected: true }),
        transition: transitionRow(),
      },
      {
        payload: evidencePayload({
          highestContiguousOrdinal: null,
          missingIntervals: [{}],
        }),
        transition: transitionRow({
          highest_contiguous_ordinal: -1,
          missing_intervals_json: "[[0,0]]",
        }),
      },
      {
        payload: evidencePayload({
          batchFirstOrdinal: "1x",
          batchLastOrdinal: "1x",
          coverageFirstOrdinal: "0",
          coverageLastOrdinal: "1x",
          highestContiguousOrdinal: "1x",
          frames: [{
            frameId: "88888888-8888-4888-8888-888888888888",
            ordinal: "1x",
            sourceKind: "model-turn",
            observedAt: NOW,
            contentFingerprint: H64_B,
          }],
        }),
        transition: transitionRow({
          batch_first_ordinal: 1,
          batch_last_ordinal: 1,
          coverage_last_ordinal: 1,
          highest_contiguous_ordinal: 1,
        }),
      },
      {
        payload: evidencePayload({
          batchFirstOrdinal: "9223372036854775808",
          batchLastOrdinal: "9223372036854775808",
          coverageLastOrdinal: "9223372036854775808",
          highestContiguousOrdinal: "9223372036854775808",
          frames: [{
            frameId: "88888888-8888-4888-8888-888888888888",
            ordinal: "9223372036854775808",
            sourceKind: "model-turn",
            observedAt: NOW,
            contentFingerprint: H64_B,
          }],
        }),
        transition: transitionRow({
          batch_first_ordinal: 9_223_372_036_854_775_807n,
          batch_last_ordinal: 9_223_372_036_854_775_807n,
          coverage_last_ordinal: 9_223_372_036_854_775_807n,
          highest_contiguous_ordinal: 9_223_372_036_854_775_807n,
        }),
      },
    ];
    for (const candidate of cases) {
      const connection = currentConnection();
      rawEvent(connection, 1, {
        streamType: "session",
        sessionId: ROOT_ID,
        eventType: "EvidenceCoverageRecorded",
        eventSchemaVersion: 2,
        payload: candidate.payload,
      });
      assert.throws(
        () => rawInsert(
          connection,
          "session_evidence_coverage_transitions",
          candidate.transition,
        ),
        /SESSION_EVIDENCE_COVERAGE_TRANSITION_INVALID/,
      );
    }
  });

  it("cannot commit a newer transition without advancing its aggregate projection", () => {
    const connection = currentConnection();
    seedRootAuthorityForCoverage(connection);
    connection.exec("PRAGMA foreign_keys = ON");
    seedCoverageBaseline(connection);
    const secondBatch = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    connection.exec("BEGIN IMMEDIATE");
    rawEvent(connection, 2, {
      streamType: "session",
      sessionId: ROOT_ID,
      streamVersion: 2,
      eventType: "EvidenceCoverageRecorded",
      eventSchemaVersion: 2,
      payload: evidencePayload({
        batchId: secondBatch,
        batchFirstOrdinal: "1",
        batchLastOrdinal: "1",
        coverageLastOrdinal: "1",
        highestContiguousOrdinal: "1",
        coverageFingerprint: H64_B,
        frames: [{
          frameId: "aaaaaaaa-0000-4000-8000-000000000001",
          ordinal: "1",
          sourceKind: "tool-request",
          observedAt: NOW,
          contentFingerprint: H64,
        }],
      }),
    });
    rawInsert(connection, "session_evidence_coverage_transitions", transitionRow({
      batch_id: secondBatch,
      batch_event_position: 2,
      batch_first_ordinal: 1,
      batch_last_ordinal: 1,
      coverage_last_ordinal: 1,
      highest_contiguous_ordinal: 1,
      previous_coverage_fingerprint_value: H64,
      coverage_fingerprint_value: H64_B,
    }));
    assert.throws(() => connection.exec("COMMIT"), /constraint|aggregate/i);
    connection.exec("ROLLBACK");
  });

  it("rejects permissive workflow results before staging", () => {
    const invalidResults = [
      canonicalJson({ arbitrary: true }),
      canonicalJson({
        ...sessionEndStatus("requested", null, null),
        workflowId: "session-end/other-session",
      }),
    ];
    for (const result_json of invalidResults) {
      const connection = sourceConnection(2);
      connection.exec("PRAGMA foreign_keys = OFF");
      connection.exec("DROP TRIGGER workflow_instances_lifecycle_insert_guard");
      rawInsert(connection, "workflow_instances", legacyLifecycleWorkflow({ result_json }));
      assert.throws(
        () => new SqliteQualifiedCheckpointMigrationPreflight()
          .assertEligibleAndStage(connection, context),
        /MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED/,
      );
    }
  });

  it("rejects raw workflow rewrites that forge a frozen group", () => {
    const connection = currentConnection();
    rawInsert(connection, "workflow_instances", lifecycleWorkflow());
    const forgedBindings = canonicalJson([{
      bindingVersion: 1,
      bindingKind: "current-child",
      childSessionId: CHILD_ID,
      childState: "active",
      lastEventPosition: "7",
      streamVersion: "1",
      checkpointId: null,
      checkpointEventPosition: null,
      transferTicketId: null,
      transferTicketEventPosition: null,
    }]);
    assert.throws(
      () => connection.prepare(`
        UPDATE workflow_instances
        SET evidence_frozen_checkpoint_event_position = 7,
            evidence_frozen_generation = 1,
            final_ending_scope_bindings_json = $bindings
      `).run({ $bindings: forgedBindings }),
      /WORKFLOW_EVIDENCE_STATE_INVALID/,
    );
  });

  it("byte-matches persistent final bindings to the root checkpoint summaries", () => {
    const connection = currentConnection();
    const checkpointBindings = [currentChildBinding(0)];
    const forgedBindings = [{ ...checkpointBindings[0], childState: "suspended" }];
    assert.throws(
      () => seedFinalWorkflowGuardFixture(
        connection,
        checkpointBindings,
        "insert",
        forgedBindings,
      ),
      /WORKFLOW_EVIDENCE_STATE_INVALID/,
    );
  });

  it("preserves a frozen event-time baseline after mutable child state evolves", () => {
    const connection = currentConnection();
    const binding = currentChildBinding(0);
    seedFinalWorkflowGuardFixture(connection, [binding], "insert");
    const childSessionId = String(binding.childSessionId);
    const nextPosition = BigInt(String(binding.lastEventPosition)) + 1n;
    const nextStreamVersion = BigInt(String(binding.streamVersion)) + 1n;

    assert.doesNotThrow(() => {
      rawEvent(connection, nextPosition, {
        streamType: "session",
        sessionId: childSessionId,
        parentSessionId: ROOT_ID,
        streamVersion: nextStreamVersion,
        eventType: "GenericSessionNote",
        payload: { evolvedAfterFreeze: true },
      });
      connection.prepare(`
        UPDATE streams
        SET current_version = $streamVersion, updated_at = $now
        WHERE project_id = $projectId AND stream_id = $streamId
      `).run({
        $streamVersion: nextStreamVersion,
        $now: NOW,
        $projectId: PROJECT_ID,
        $streamId: `session/${childSessionId}`,
      });
      connection.prepare(`
        UPDATE session_authority
        SET semantic_state = 'suspended',
            authority_event_position = $eventPosition,
            updated_at = $now
        WHERE project_id = $projectId AND session_id = $sessionId
      `).run({
        $eventPosition: nextPosition,
        $now: NOW,
        $projectId: PROJECT_ID,
        $sessionId: childSessionId,
      });
    });

    assert.doesNotThrow(() => connection.prepare(`
      UPDATE workflow_instances
      SET phase = 'ending-materialization-queued', result_json = $result
      WHERE project_id = $projectId AND workflow_id = $workflowId
    `).run({
      $result: canonicalJson(phaseResult(
        "confirm-ending-materialization",
        "final-checkpoint-recorded",
        sessionEndStatus(
          "ending-materialization-queued",
          "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          MAX_INT64.toString(),
        ),
      )),
      $projectId: PROJECT_ID,
      $workflowId: `session-end/${ROOT_ID}`,
    }));
  });

  it("still rejects a final freeze whose bindings are stale at freeze time", () => {
    const connection = currentConnection();
    const binding = currentChildBinding(0);
    const childSessionId = String(binding.childSessionId);
    const nextPosition = BigInt(String(binding.lastEventPosition)) + 1n;
    const nextStreamVersion = BigInt(String(binding.streamVersion)) + 1n;

    assert.throws(
      () => seedFinalWorkflowGuardFixture(
        connection,
        [binding],
        "update",
        [binding],
        () => {
          rawEvent(connection, nextPosition, {
            streamType: "session",
            sessionId: childSessionId,
            parentSessionId: ROOT_ID,
            streamVersion: nextStreamVersion,
            eventType: "GenericSessionNote",
            payload: { evolvedBeforeFreeze: true },
          });
          connection.prepare(`
            UPDATE streams
            SET current_version = $streamVersion, updated_at = $now
            WHERE project_id = $projectId AND stream_id = $streamId
          `).run({
            $streamVersion: nextStreamVersion,
            $now: NOW,
            $projectId: PROJECT_ID,
            $streamId: `session/${childSessionId}`,
          });
          connection.prepare(`
            UPDATE session_authority
            SET semantic_state = 'suspended',
                authority_event_position = $eventPosition,
                updated_at = $now
            WHERE project_id = $projectId AND session_id = $sessionId
          `).run({
            $eventPosition: nextPosition,
            $now: NOW,
            $projectId: PROJECT_ID,
            $sessionId: childSessionId,
          });
        },
      ),
      /WORKFLOW_EVIDENCE_STATE_INVALID/,
    );
  });

  it("requires exact V2 or null results and binds the complete evidence window", () => {
    const arbitrary = currentConnection();
    assert.throws(
      () => rawInsert(arbitrary, "workflow_instances", lifecycleWorkflow({
        result_json: canonicalJson({ arbitrary: true }),
      })),
      /WORKFLOW_EVIDENCE_STATE_INVALID/,
    );

    const extraKey = currentConnection();
    assert.throws(
      () => rawInsert(extraKey, "workflow_instances", lifecycleWorkflow({
        result_json: canonicalJson({
          ...sessionEndStatus("requested", null, null),
          unexpected: true,
        }),
      })),
      /WORKFLOW_EVIDENCE_STATE_INVALID/,
    );

    const zeroGeneration = currentConnection();
    const finalCheckpoint = seedRootFinalCheckpoint(zeroGeneration);
    const zeroStatus = {
      ...sessionEndStatus(
        "final-checkpoint-recorded",
        String(finalCheckpoint.checkpointId),
        MAX_INT64.toString(),
      ),
      evidenceWindow: {
        evidenceWindowState: "sealed",
        evidenceFrozenCheckpointEventPosition: MAX_INT64.toString(),
        evidenceFrozenGeneration: 0,
      },
    };
    assert.throws(
      () => rawInsert(zeroGeneration, "workflow_instances", lifecycleWorkflow({
        phase: "final-checkpoint-recorded",
        result_json: canonicalJson(zeroStatus),
        evidence_frozen_checkpoint_event_position: MAX_INT64,
        evidence_frozen_generation: 0,
        final_ending_scope_bindings_json: "[]",
      })),
      /WORKFLOW_EVIDENCE_STATE_INVALID/,
    );

    const wrongTrigger = currentConnection();
    const checkpoint = seedRootFinalCheckpoint(wrongTrigger);
    const wrongTriggerStatus = {
      ...sessionEndStatus(
        "final-checkpoint-recorded",
        String(checkpoint.checkpointId),
        MAX_INT64.toString(),
      ),
      triggeringEventPosition: "9223372036854775808",
    };
    assert.throws(
      () => rawInsert(wrongTrigger, "workflow_instances", lifecycleWorkflow({
        phase: "final-checkpoint-recorded",
        result_json: canonicalJson(wrongTriggerStatus),
        evidence_frozen_checkpoint_event_position: MAX_INT64,
        evidence_frozen_generation: 1,
        final_ending_scope_bindings_json: "[]",
      })),
      /WORKFLOW_EVIDENCE_STATE_INVALID/,
    );
  });

  it("allows only the exact ordinary phase/action transition matrix", () => {
    const matrix = [
      ["requested", "children-resolved", "mark-children-resolved"],
      ["children-resolved", "final-checkpoint-recorded", "record-final-checkpoint-and-queue-ending"],
      ["final-checkpoint-recorded", "ending-materialization-queued", "confirm-ending-materialization"],
      ["ending-materialization-queued", "validating", "begin-validation"],
      ["validating", "verification-failed", "record-verification-failed"],
      ["validating", "verification-passed", "record-verification-passed"],
      ["verification-passed", "verification-failed", "invalidate-verification"],
      ["verification-passed", "completion-appended", "append-terminal-completion"],
      ["completion-appended", "completed-materialization-confirmed", "confirm-completed-materialization"],
      ["completion-appended", "completed", "complete-without-materialization"],
      ["completed-materialization-confirmed", "completed", "complete-after-materialization"],
    ] as const;
    for (const [from, to, action] of matrix) {
      const connection = currentConnection();
      const needsFinal = from !== "requested" && from !== "children-resolved";
      const freezesNow = to === "final-checkpoint-recorded";
      const hasFinal = needsFinal || freezesNow;
      const checkpoint = hasFinal ? seedRootFinalCheckpoint(connection) : null;
      const startStatus = checkpoint === null || freezesNow
        ? null
        : sessionEndStatus(from, String(checkpoint.checkpointId), MAX_INT64.toString());
      rawInsert(connection, "workflow_instances", lifecycleWorkflow({
        phase: from,
        result_json: startStatus === null ? null : canonicalJson(startStatus),
        evidence_frozen_checkpoint_event_position: needsFinal ? MAX_INT64 : null,
        evidence_frozen_generation: needsFinal ? 1 : null,
        final_ending_scope_bindings_json: needsFinal ? "[]" : null,
      }));
      const nextStatus = sessionEndStatus(
        to,
        checkpoint === null ? null : String(checkpoint.checkpointId),
        checkpoint === null ? null : MAX_INT64.toString(),
      );
      assert.doesNotThrow(() => connection.prepare(`
        UPDATE workflow_instances
        SET phase = $phase, result_json = $result,
            evidence_frozen_checkpoint_event_position = $position,
            evidence_frozen_generation = $frozenGeneration,
            final_ending_scope_bindings_json = $bindings
      `).run({
        $phase: to,
        $result: canonicalJson(phaseResult(action, from, nextStatus)),
        $position: hasFinal ? MAX_INT64 : null,
        $frozenGeneration: hasFinal ? 1 : null,
        $bindings: hasFinal ? "[]" : null,
      }), `${from} -> ${to}`);
    }

    const actionLie = currentConnection();
    rawInsert(actionLie, "workflow_instances", lifecycleWorkflow());
    assert.throws(() => actionLie.prepare(`
      UPDATE workflow_instances SET phase = 'children-resolved', result_json = $result
    `).run({
      $result: canonicalJson(phaseResult(
        "begin-validation",
        "requested",
        sessionEndStatus("children-resolved", null, null),
      )),
    }), /WORKFLOW_EVIDENCE_STATE_INVALID/);

    const falseProgress = currentConnection();
    rawInsert(falseProgress, "workflow_instances", lifecycleWorkflow());
    assert.throws(() => falseProgress.prepare(`
      UPDATE workflow_instances SET phase = 'children-resolved', result_json = $result
    `).run({
      $result: canonicalJson({
        ...phaseResult(
          "mark-children-resolved",
          "requested",
          sessionEndStatus("children-resolved", null, null),
        ),
        progressed: false,
      }),
    }), /WORKFLOW_EVIDENCE_STATE_INVALID/);
  });

  it("rejects same-generation cancellation and arbitrary preserved-group backtracking", () => {
    const cancel = currentConnection();
    rawInsert(cancel, "workflow_instances", lifecycleWorkflow({ phase: "children-resolved" }));
    assert.throws(() => cancel.prepare(`
      UPDATE workflow_instances SET phase = 'cancelled', result_json = $result
    `).run({ $result: canonicalJson(sessionEndStatus("cancelled", null, null)) }),
    /WORKFLOW_EVIDENCE_STATE_INVALID/);

    const backtrack = currentConnection();
    seedFinalWorkflowGuardFixture(backtrack, [], "insert");
    assert.throws(() => backtrack.prepare(`
      UPDATE workflow_instances SET phase = 'requested', result_json = $result
    `).run({
      $result: canonicalJson(sessionEndStatus(
        "requested",
        "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        MAX_INT64.toString(),
      )),
    }), /WORKFLOW_EVIDENCE_STATE_INVALID/);
  });

  it("admits the generation-fenced open, seal, cancel, and reopen transitions", () => {
    const connection = currentConnection();
    rawInsert(connection, "workflow_instances", lifecycleWorkflow());
    assert.doesNotThrow(() => connection.prepare(`
      UPDATE workflow_instances
      SET generation = 2, phase = 'children-resolved', result_json = $result,
          evidence_window_state = 'open'
    `).run({
      $result: canonicalJson({
        ...sessionEndStatus("children-resolved", null, null),
        workflowGeneration: 2,
        evidenceWindow: {
          evidenceWindowState: "open",
          evidenceFrozenCheckpointEventPosition: null,
          evidenceFrozenGeneration: null,
        },
      }),
    }));
    assert.doesNotThrow(() => connection.prepare(`
      UPDATE workflow_instances
      SET generation = 3, result_json = $result, evidence_window_state = 'sealed'
    `).run({
      $result: canonicalJson({
        ...sessionEndStatus("children-resolved", null, null),
        workflowGeneration: 3,
      }),
    }));
    assert.doesNotThrow(() => connection.prepare(`
      UPDATE workflow_instances
      SET generation = 4, phase = 'cancelled', result_json = $result
    `).run({
      $result: canonicalJson({
        ...sessionEndStatus("cancelled", null, null),
        workflowGeneration: 4,
      }),
    }));
    assert.doesNotThrow(() => connection.prepare(`
      UPDATE workflow_instances
      SET generation = 5, phase = 'requested', root_command_id = 'root-command-5',
          triggering_event_position = 5, result_json = NULL
    `).run());
  });

  it("admits generation-fenced unchanged and abandoned transitions", () => {
    const unchanged = currentConnection();
    const unchangedCheckpoint = seedRootFinalCheckpoint(unchanged);
    rawInsert(unchanged, "workflow_instances", lifecycleWorkflow({
      phase: "final-checkpoint-recorded",
      result_json: canonicalJson(sessionEndStatus(
        "final-checkpoint-recorded",
        String(unchangedCheckpoint.checkpointId),
        MAX_INT64.toString(),
      )),
      evidence_frozen_checkpoint_event_position: MAX_INT64,
      evidence_frozen_generation: 1,
      final_ending_scope_bindings_json: "[]",
    }));
    assert.doesNotThrow(() => unchanged.prepare(`
      UPDATE workflow_instances SET generation = 2, result_json = $result
    `).run({
      $result: canonicalJson({
        ...sessionEndStatus(
          "final-checkpoint-recorded",
          String(unchangedCheckpoint.checkpointId),
          MAX_INT64.toString(),
        ),
        workflowGeneration: 2,
      }),
    }));

    for (const withFinal of [false, true]) {
      const abandoned = currentConnection();
      const checkpoint = withFinal ? seedRootFinalCheckpoint(abandoned) : null;
      rawInsert(abandoned, "workflow_instances", lifecycleWorkflow({
        phase: checkpoint === null ? "children-resolved" : "final-checkpoint-recorded",
        result_json: checkpoint === null ? null : canonicalJson(sessionEndStatus(
          "final-checkpoint-recorded",
          String(checkpoint.checkpointId),
          MAX_INT64.toString(),
        )),
        evidence_frozen_checkpoint_event_position: checkpoint === null ? null : MAX_INT64,
        evidence_frozen_generation: checkpoint === null ? null : 1,
        final_ending_scope_bindings_json: checkpoint === null ? null : "[]",
      }));
      assert.doesNotThrow(() => abandoned.prepare(`
        UPDATE workflow_instances
        SET generation = 2, phase = 'abandoned', result_json = $result
      `).run({
        $result: canonicalJson({
          ...sessionEndStatus(
            "abandoned",
            checkpoint === null ? null : String(checkpoint.checkpointId),
            checkpoint === null ? null : MAX_INT64.toString(),
          ),
          workflowGeneration: 2,
        }),
      }), withFinal ? "post-final abandonment" : "pre-final abandonment");
    }
  });

  it("accepts 101 strict current-child bindings below the byte-derived limit", () => {
    const connection = currentConnection();
    const bindings = Array.from({ length: 101 }, (_, index) => currentChildBinding(index));
    assert.ok(endingScopeBytes(bindings) < 262_144);
    assert.doesNotThrow(() => seedFinalWorkflowGuardFixture(connection, bindings, "insert"));
  });

  it("enforces the exact final-binding byte boundary through INSERT and UPDATE", () => {
    const exact = exactEndingScopeBindingBytes(262_144);
    const over = exactEndingScopeBindingBytes(262_145);
    assert.equal(endingScopeBytes(exact), 262_144);
    assert.equal(endingScopeBytes(over), 262_145);
    for (const write of ["insert", "update"] as const) {
      const accepted = currentConnection();
      assert.doesNotThrow(
        () => seedFinalWorkflowGuardFixture(accepted, exact, write),
        `${write} exact boundary`,
      );
      const rejected = currentConnection();
      assert.throws(
        () => seedFinalWorkflowGuardFixture(rejected, over, write),
        /WORKFLOW_EVIDENCE_STATE_INVALID/,
        `${write} limit plus one`,
      );
    }
  });

  it("uses UTF-8 BLOB bytes at the exact final-binding boundary", () => {
    const connection = currentConnection();
    const asciiAtLimit = `["${"a".repeat(262_140)}"]`;
    const asciiOverLimit = `["${"a".repeat(262_141)}"]`;
    const multibyteAtLimit = `["${"é".repeat(131_070)}"]`;
    const measured = connection.prepare(`
      SELECT length(CAST($value AS BLOB)) AS bytes, length($value) AS characters
    `);
    const asciiMeasurement = measured.get({ $value: asciiAtLimit });
    assert.equal(asciiMeasurement?.bytes, 262_144n);
    assert.equal(asciiMeasurement?.characters, 262_144n);
    assert.equal(measured.get({ $value: asciiOverLimit })?.bytes, 262_145n);
    const multibyteMeasurement = measured.get({ $value: multibyteAtLimit });
    assert.equal(multibyteMeasurement?.bytes, 262_144n);
    assert.equal(multibyteMeasurement?.characters, 131_074n);

    const finalCheckpoint = seedRootFinalCheckpoint(connection);
    assert.throws(
      () => rawInsert(connection, "workflow_instances", lifecycleWorkflow({
        phase: "final-checkpoint-recorded",
        result_json: canonicalJson(sessionEndStatus(
          "final-checkpoint-recorded",
          String(finalCheckpoint.checkpointId),
          MAX_INT64.toString(),
        )),
        evidence_frozen_checkpoint_event_position: MAX_INT64,
        evidence_frozen_generation: 1,
        final_ending_scope_bindings_json: `[
          "${"é".repeat(131_071)}"
        ]`.replace(/\s/g, ""),
      })),
      /WORKFLOW_EVIDENCE_STATE_INVALID/,
    );
  });

  it("rechecks Version 1 checkpoint coverage in target SQL even with a forged hook", () => {
    const connection = sourceConnection(2);
    connection.exec("PRAGMA foreign_keys = OFF");
    const checkpoint = checkpointFixture({
      sessionId: ROOT_ID as never,
      baseEventPosition: 1,
      checkpointEventPosition: 2,
    });
    rawEvent(connection, 2, {
      streamType: "session",
      sessionId: ROOT_ID,
      eventType: "SessionCheckpointRecorded",
      eventSchemaVersion: 1,
      payload: {
        checkpoint: {
          ...checkpoint,
          evidenceCoverage: {
            ...checkpoint.evidenceCoverage,
            highestContiguousOrdinal: "0",
          },
        },
        baseEventPosition: "1",
        checkpointEventPosition: "2",
      },
    });
    assert.throws(
      () => new MigrationRunner().apply(connection, registry, NOW, mode({
        kind: "explicit-upgrade",
        expectedAppliedVersion: 2,
        beforeMigration(candidate: SqliteConnection, migration: { version: number }): void {
          if (migration.version === 3) installForgedEmptyStage(candidate);
        },
      })),
      /MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED/,
    );
    assert.deepEqual(versions(connection), [1, 2]);
    assert.equal(schemaVersion(connection), 2);
  });

  it("fails through the normalized probe when any TEMP immutability trigger is absent", () => {
    const connection = sourceConnection(2);
    assert.throws(
      () => new MigrationRunner().apply(connection, registry, NOW, mode({
        kind: "explicit-upgrade",
        expectedAppliedVersion: 2,
        beforeMigration(candidate: SqliteConnection, migration: { version: number }): void {
          if (migration.version !== 3) return;
          new SqliteQualifiedCheckpointMigrationPreflight()
            .assertEligibleAndStage(candidate, context);
          candidate.exec("DROP TRIGGER qualified_checkpoint_v3_stage_rows_no_delete");
        },
      })),
      /MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED/,
    );
    assert.deepEqual(versions(connection), [1, 2]);
    assert.equal(schemaVersion(connection), 2);
  });

  it("strict-decodes every known lifecycle event and rejects malformed payloads", () => {
    const connection = sourceConnection(2);
    connection.exec("PRAGMA foreign_keys = OFF");
    seedRootStart(connection);
    rawEvent(connection, 2, {
      streamType: "session",
      sessionId: ROOT_ID,
      streamVersion: 2,
      eventType: "SessionSuspended",
      eventSchemaVersion: 1,
      payload: { authorityCommitment: H64, unexpected: true },
    });
    assert.throws(
      () => new SqliteQualifiedCheckpointMigrationPreflight()
        .assertEligibleAndStage(connection, context),
      /MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED/,
    );
  });

  it("rejects nonempty legacy coverage and duplicate or cross-session checkpoint identity", () => {
    const coverage = sourceConnection(2);
    coverage.exec("PRAGMA foreign_keys = OFF");
    rawInsert(coverage, "session_evidence_coverage", {
      project_id: PROJECT_ID,
      session_id: ROOT_ID,
      adapter_session_id: ADAPTER_ID,
      capture_mode: "coverage-only",
      first_ordinal: 0,
      last_ordinal: 0,
      highest_contiguous_ordinal: 0,
      missing_intervals_json: "[]",
      fingerprint_algorithm: "hmac-sha256",
      fingerprint_schema_version: 1,
      fingerprint_key_id: "key-1",
      fingerprint_domain: "pm-evidence-frame-v1",
      latest_batch_id: BATCH_ID,
      latest_batch_event_position: 1,
      created_at: NOW,
      updated_at: NOW,
    });
    assert.throws(
      () => new SqliteQualifiedCheckpointMigrationPreflight()
        .assertEligibleAndStage(coverage, context),
      /MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED/,
    );

    const duplicate = sourceConnection(2);
    duplicate.exec("PRAGMA foreign_keys = OFF");
    seedRootStart(duplicate);
    rawEvent(duplicate, 2, {
      streamType: "session", sessionId: ROOT_ID, streamVersion: 2,
      eventType: "SessionCheckpointRecorded", payload: checkpointPayload(2),
    });
    rawEvent(duplicate, 3, {
      streamType: "session", sessionId: ROOT_ID, streamVersion: 3,
      eventType: "SessionCheckpointRecorded", payload: checkpointPayload(3),
    });
    assert.throws(
      () => new SqliteQualifiedCheckpointMigrationPreflight()
        .assertEligibleAndStage(duplicate, context),
      /MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED/,
    );

    const crossSession = sourceConnection(2);
    crossSession.exec("PRAGMA foreign_keys = OFF");
    seedRootStart(crossSession);
    rawEvent(crossSession, 2, {
      streamType: "session", sessionId: ROOT_ID, streamVersion: 2,
      eventType: "SessionCheckpointRecorded",
      payload: checkpointPayload(2, {
        sessionId: CHILD_ID as never,
        parentSessionId: ROOT_ID as never,
      }),
    });
    assert.throws(
      () => new SqliteQualifiedCheckpointMigrationPreflight()
        .assertEligibleAndStage(crossSession, context),
      /MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED/,
    );
  });

  it("rejects a final child summary whose declared state disagrees with its fold and authority", () => {
    const connection = sourceConnection(2);
    seedTransferredFinalHistory(connection, {
      summaryState: "active",
      includeTicket: false,
    });
    assert.throws(
      () => new SqliteQualifiedCheckpointMigrationPreflight()
        .assertEligibleAndStage(connection, context),
      /MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED/,
    );
  });

  it("stages a fold-valid transferred child with its exact retained ticket", () => {
    const connection = sourceConnection(2);
    seedTransferredFinalHistory(connection);
    connection.exec("BEGIN IMMEDIATE");
    assert.doesNotThrow(
      () => new SqliteQualifiedCheckpointMigrationPreflight()
        .assertEligibleAndStage(connection, context),
    );
    connection.exec("ROLLBACK");
  });

  it("binds a retained transfer ticket to the exact final root and transfer event parent", () => {
    const connection = sourceConnection(2);
    seedTransferredFinalHistory(connection, {
      ticketParentSessionId: OTHER_ROOT_ID,
    });
    assert.throws(
      () => new SqliteQualifiedCheckpointMigrationPreflight()
        .assertEligibleAndStage(connection, context),
      /MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED/,
    );
  });

  it("requires every retained transfer ticket in the final checkpoint and capacity union", () => {
    const connection = sourceConnection(2);
    seedTransferredFinalHistory(connection, { includeSummary: false });
    assert.throws(
      () => new SqliteQualifiedCheckpointMigrationPreflight()
        .assertEligibleAndStage(connection, context),
      /MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED/,
    );
  });

  it("does not downgrade a transferred child summary without its exact ticket", () => {
    const connection = sourceConnection(2);
    connection.exec("PRAGMA foreign_keys = OFF");
    connection.exec("DROP TRIGGER workflow_instances_lifecycle_insert_guard");
    seedRootStart(connection, 1);
    const childFork = lifecycleEvent(1, "SessionForked", {}, {
      projectId: PROJECT_ID as never,
      vaultId: VAULT_ID as never,
      storeId: STORE_ID as never,
      workspaceId: "1".repeat(64) as never,
      sessionId: CHILD_ID as never,
      parentSessionId: ROOT_ID as never,
      globalPosition: 2,
      streamVersion: 1,
      authorityCommitment: H64,
    });
    rawEvent(connection, 2, {
      streamType: "session", sessionId: CHILD_ID, parentSessionId: ROOT_ID,
      streamVersion: 1, eventType: "SessionForked", payload: childFork.payload,
    });
    const childCheckpoint = checkpointFixture({
      sessionId: CHILD_ID as never,
      parentSessionId: ROOT_ID as never,
      baseEventPosition: 2,
      checkpointEventPosition: 3,
    });
    rawEvent(connection, 3, {
      streamType: "session", sessionId: CHILD_ID, parentSessionId: ROOT_ID,
      streamVersion: 2, eventType: "SessionCheckpointRecorded",
      payload: {
        checkpoint: childCheckpoint,
        baseEventPosition: "2",
        checkpointEventPosition: "3",
      },
    });
    const transfer = lifecycleEvent(3, "ChildWorkTransferCreated", {
      checkpointId: childCheckpoint.checkpointId,
      authorityCommitment: H64,
    }, {
      projectId: PROJECT_ID as never,
      vaultId: VAULT_ID as never,
      storeId: STORE_ID as never,
      workspaceId: "1".repeat(64) as never,
      sessionId: CHILD_ID as never,
      parentSessionId: ROOT_ID as never,
      globalPosition: 4,
      streamVersion: 3,
      authorityCommitment: H64,
    });
    rawEvent(connection, 4, {
      streamType: "session", sessionId: CHILD_ID, parentSessionId: ROOT_ID,
      streamVersion: 3, eventType: "ChildWorkTransferCreated", payload: transfer.payload,
    });
    const rootFinal = {
      ...checkpointFixture({
        sessionId: ROOT_ID as never,
        baseEventPosition: 1,
        checkpointEventPosition: 5,
      }),
      childSummaries: [{
        childSessionId: CHILD_ID,
        state: "transferred",
        lastEventPosition: "4",
        streamVersion: "3",
        latestCheckpointId: childCheckpoint.checkpointId,
      }],
    };
    rawEvent(connection, 5, {
      streamType: "session", sessionId: ROOT_ID, streamVersion: 2,
      eventType: "SessionCheckpointRecorded",
      payload: {
        checkpoint: rootFinal,
        baseEventPosition: "1",
        checkpointEventPosition: "5",
      },
    });
    rawInsert(connection, "workflow_instances", legacyLifecycleWorkflow({
      phase: "final-checkpoint-recorded",
      result_json: canonicalJson(sessionEndStatus(
        "final-checkpoint-recorded",
        String(rootFinal.checkpointId),
        "5",
      )),
    }));
    assert.throws(
      () => new SqliteQualifiedCheckpointMigrationPreflight()
        .assertEligibleAndStage(connection, context),
      /MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED/,
    );
  });

  it("rejects missing or identity-mutated staged workflow rows and backfills byte-identically", () => {
    const mutations = [
      `DROP TRIGGER qualified_checkpoint_v3_stage_rows_no_delete;
       DELETE FROM ${QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE}`,
      `DROP TRIGGER qualified_checkpoint_v3_stage_rows_no_update;
       UPDATE ${QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE} SET source_generation = 2`,
      `DROP TRIGGER qualified_checkpoint_v3_stage_rows_no_update;
       UPDATE ${QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE} SET source_phase = 'children-resolved'`,
    ];
    for (const mutation of mutations) {
      const connection = sourceConnection(2);
      connection.exec("PRAGMA foreign_keys = OFF");
      rawInsert(connection, "workflow_instances", legacyLifecycleWorkflow());
      assert.throws(
        () => new MigrationRunner().apply(connection, registry, NOW, mode({
          kind: "explicit-upgrade",
          expectedAppliedVersion: 2,
          beforeMigration(candidate: SqliteConnection, migration: { version: number }): void {
            if (migration.version !== 3) return;
            new SqliteQualifiedCheckpointMigrationPreflight()
              .assertEligibleAndStage(candidate, context);
            candidate.exec(mutation);
          },
        })),
        /MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED/,
      );
      assert.deepEqual(versions(connection), [1, 2]);
      assert.equal(schemaVersion(connection), 2);
    }

    const success = sourceConnection(2);
    success.exec("PRAGMA foreign_keys = OFF");
    rawInsert(success, "workflow_instances", legacyLifecycleWorkflow());
    const preflight = new SqliteQualifiedCheckpointMigrationPreflight();
    new MigrationRunner().apply(success, registry, NOW, mode({
      kind: "explicit-upgrade",
      expectedAppliedVersion: 2,
      beforeMigration(candidate: SqliteConnection, migration: { version: number }): void {
        if (migration.version === 3) preflight.assertEligibleAndStage(candidate, context);
      },
    }));
    const backfilled = success.prepare(`
      SELECT evidence_frozen_checkpoint_event_position, evidence_frozen_generation,
             evidence_window_state, final_ending_scope_bindings_json
      FROM workflow_instances
    `).get();
    assert.equal(backfilled?.evidence_frozen_checkpoint_event_position, null);
    assert.equal(backfilled?.evidence_frozen_generation, null);
    assert.equal(backfilled?.evidence_window_state, "sealed");
    assert.equal(backfilled?.final_ending_scope_bindings_json, null);
  });

  it("successfully backfills every post-final, cancelled, and abandoned history shape", () => {
    const postFinalPhases = [
      "final-checkpoint-recorded",
      "ending-materialization-queued",
      "validating",
      "verification-passed",
      "verification-failed",
      "completion-appended",
      "completed-materialization-confirmed",
      "completed",
    ] as const;
    const cases: Array<{
      readonly phase: string;
      readonly hasHistoricalFinal: boolean;
      readonly keepsFinal: boolean;
    }> = [
      ...postFinalPhases.map((phase) => ({
        phase,
        hasHistoricalFinal: true,
        keepsFinal: true,
      })),
      { phase: "cancelled", hasHistoricalFinal: false, keepsFinal: false },
      { phase: "cancelled", hasHistoricalFinal: true, keepsFinal: false },
      { phase: "abandoned", hasHistoricalFinal: false, keepsFinal: false },
      { phase: "abandoned", hasHistoricalFinal: true, keepsFinal: true },
    ];
    for (const candidate of cases) {
      const connection = sourceConnection(2);
      connection.exec("PRAGMA foreign_keys = OFF");
      seedRootStart(connection);
      const finalCheckpoint = candidate.hasHistoricalFinal
        ? checkpointFixture({
            checkpointId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" as never,
            sessionId: ROOT_ID as never,
            baseEventPosition: 1,
            checkpointEventPosition: 2,
          })
        : null;
      if (finalCheckpoint !== null) {
        rawEvent(connection, 2, {
          streamType: "session",
          sessionId: ROOT_ID,
          streamVersion: 2,
          eventType: "SessionCheckpointRecorded",
          payload: {
            checkpoint: finalCheckpoint,
            baseEventPosition: "1",
            checkpointEventPosition: "2",
          },
        });
      }
      rawInsert(connection, "workflow_instances", legacyLifecycleWorkflow({
        phase: candidate.phase,
        result_json: finalCheckpoint === null
          ? null
          : canonicalJson(sessionEndStatus(
              candidate.phase,
              String(finalCheckpoint.checkpointId),
              "2",
            )),
      }));
      const preflight = new SqliteQualifiedCheckpointMigrationPreflight();
      new MigrationRunner().apply(connection, registry, NOW, mode({
        kind: "explicit-upgrade",
        expectedAppliedVersion: 2,
        beforeMigration(candidateConnection: SqliteConnection, migration: { version: number }): void {
          if (migration.version === 3) {
            preflight.assertEligibleAndStage(candidateConnection, context);
          }
        },
      }));
      const row = connection.prepare(`
        SELECT evidence_frozen_checkpoint_event_position, evidence_frozen_generation,
               evidence_window_state, final_ending_scope_bindings_json
        FROM workflow_instances
      `).get();
      assert.equal(row?.evidence_window_state, "sealed", candidate.phase);
      assert.equal(
        row?.evidence_frozen_checkpoint_event_position,
        candidate.keepsFinal ? 2n : null,
        candidate.phase,
      );
      assert.equal(row?.evidence_frozen_generation, candidate.keepsFinal ? 1n : null);
      assert.equal(row?.final_ending_scope_bindings_json, candidate.keepsFinal ? "[]" : null);
    }
  });

  it("enforces workflow shapes and project-scoped adapter uniqueness through raw SQL", () => {
    const nonLifecycle = currentConnection();
    assert.throws(
      () => rawInsert(nonLifecycle, "workflow_instances", {
        ...lifecycleWorkflow({
          workflow_id: "ordinary-workflow",
          workflow_type: "ordinary",
          session_id: null,
          triggering_event_position: null,
          expected_authority_commitment: null,
          evidence_window_state: "sealed",
        }),
      }),
      /WORKFLOW_EVIDENCE_STATE_INVALID/,
    );

    const lifecycle = currentConnection();
    rawInsert(lifecycle, "workflow_instances", lifecycleWorkflow());
    assert.throws(
      () => rawInsert(lifecycle, "workflow_instances", lifecycleWorkflow({
        workflow_id: `session-end/${CHILD_ID}`,
        session_id: CHILD_ID,
        phase: "completed",
      })),
      /WORKFLOW_EVIDENCE_STATE_INVALID/,
    );
    assert.throws(
      () => lifecycle.exec("UPDATE workflow_instances SET evidence_window_state = 'open'"),
      /WORKFLOW_EVIDENCE_STATE_INVALID/,
    );

    const coverage = currentConnection();
    rawEvent(coverage, 1, {
      streamType: "session", sessionId: ROOT_ID,
      eventType: "EvidenceCoverageRecorded", eventSchemaVersion: 2,
      payload: evidencePayload(),
    });
    rawInsert(coverage, "session_evidence_coverage_transitions", transitionRow());
    rawInsert(coverage, "session_evidence_coverage", coverageRow());
    const otherBatch = "99999999-9999-4999-8999-999999999999";
    rawEvent(coverage, 2, {
      streamType: "session", sessionId: CHILD_ID,
      eventType: "EvidenceCoverageRecorded", eventSchemaVersion: 2,
      payload: evidencePayload({ batchId: otherBatch }),
    });
    rawInsert(coverage, "session_evidence_coverage_transitions", transitionRow({
      session_id: CHILD_ID,
      batch_id: otherBatch,
      batch_event_position: 2,
    }));
    assert.throws(
      () => rawInsert(coverage, "session_evidence_coverage", coverageRow(
        ADAPTER_ID,
        CHILD_ID,
        { latest_batch_id: otherBatch, latest_batch_event_position: 2 },
      )),
      /UNIQUE constraint failed/,
    );
  });

  it("uses the prospective NEW row for the 200-interval cross-adapter bound", () => {
    const connection = currentConnection();
    const intervals = Array.from({ length: 200 }, (_, ordinal) => ({
      firstOrdinal: String(ordinal * 2),
      lastOrdinal: String(ordinal * 2),
    }));
    const intervalsJson = canonicalJson(intervals.map((_, ordinal) => [ordinal * 2, ordinal * 2]));
    rawEvent(connection, 1, {
      streamType: "session", sessionId: ROOT_ID,
      eventType: "EvidenceCoverageRecorded", eventSchemaVersion: 2,
      payload: evidencePayload({
        batchFirstOrdinal: "400",
        batchLastOrdinal: "400",
        coverageLastOrdinal: "400",
        highestContiguousOrdinal: null,
        missingIntervals: intervals,
        frames: [{
          frameId: "88888888-8888-4888-8888-888888888888",
          ordinal: "400",
          sourceKind: "model-turn",
          observedAt: NOW,
          contentFingerprint: H64_B,
        }],
      }),
    });
    rawInsert(connection, "session_evidence_coverage_transitions", transitionRow({
      batch_first_ordinal: 400,
      batch_last_ordinal: 400,
      coverage_last_ordinal: 400,
      highest_contiguous_ordinal: -1,
      missing_intervals_json: intervalsJson,
    }));
    rawInsert(connection, "session_evidence_coverage", coverageRow(
      ADAPTER_ID,
      ROOT_ID,
      {
        last_ordinal: 400,
        highest_contiguous_ordinal: -1,
        missing_intervals_json: intervalsJson,
      },
    ));

    const secondAdapter = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const secondBatch = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const oneInterval = [{ firstOrdinal: "0", lastOrdinal: "0" }];
    const oneIntervalJson = canonicalJson([[0, 0]]);
    rawEvent(connection, 2, {
      streamType: "session", sessionId: ROOT_ID, streamVersion: 2,
      eventType: "EvidenceCoverageRecorded", eventSchemaVersion: 2,
      payload: evidencePayload({
        adapterSessionId: secondAdapter,
        batchId: secondBatch,
        batchFirstOrdinal: "1",
        batchLastOrdinal: "1",
        coverageLastOrdinal: "1",
        highestContiguousOrdinal: null,
        missingIntervals: oneInterval,
        frames: [{
          frameId: "aaaaaaaa-0000-4000-8000-000000000001",
          ordinal: "1",
          sourceKind: "tool-request",
          observedAt: NOW,
          contentFingerprint: H64,
        }],
      }),
    });
    rawInsert(connection, "session_evidence_coverage_transitions", transitionRow({
      adapter_session_id: secondAdapter,
      batch_id: secondBatch,
      batch_event_position: 2,
      batch_first_ordinal: 1,
      batch_last_ordinal: 1,
      coverage_last_ordinal: 1,
      highest_contiguous_ordinal: -1,
      missing_intervals_json: oneIntervalJson,
    }));
    assert.throws(
      () => rawInsert(connection, "session_evidence_coverage", coverageRow(
        secondAdapter,
        ROOT_ID,
        {
          latest_batch_id: secondBatch,
          latest_batch_event_position: 2,
          last_ordinal: 1,
          highest_contiguous_ordinal: -1,
          missing_intervals_json: oneIntervalJson,
        },
      )),
      /SESSION_EVIDENCE_COVERAGE_INVALID/,
    );
  });
});
