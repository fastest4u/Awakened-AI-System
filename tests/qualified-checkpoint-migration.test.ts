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
  QUALIFIED_CHECKPOINT_STAGE_CHILD_EVENT_FOLDS_TABLE,
  QUALIFIED_CHECKPOINT_STAGE_WORKFLOW_GENERATION_FOLDS_TABLE,
  SqliteQualifiedCheckpointMigrationPreflight,
  assertQualifiedCheckpointMigrationStage,
  qualifiedCheckpointMigrationFailure,
} from "../src/orchestrator/storage/qualified-checkpoint-migration-preflight.js";
import { inspectStoreSchema } from "../src/orchestrator/storage/schema-compatibility.js";
import {
  CHILD_EVENT_FOLD_CURSOR_SQL,
  WORKFLOW_GENERATION_FOLD_CURSOR_SQL,
} from "../src/orchestrator/storage/lifecycle-projection.repository.js";
import {
  LIFECYCLE_EVENT_CURSOR_SQL,
  QUALIFIED_ORDINAL_CURSOR_SQL,
  QUALIFIED_TRANSITION_CURSOR_SQL,
} from "../src/orchestrator/integrity/lifecycle-integrity.service.js";
import type {
  SqliteConnection,
  SqliteParams,
  SqliteValue,
} from "../src/orchestrator/storage/sqlite-driver.js";
import {
  checkpointFixture,
  childDispositionFixture,
  childReportFixture,
  lifecycleEvent,
  qualifiedCheckpointFixture,
} from "./support/lifecycle-fixtures.js";
import {
  buildLifecycleIntentWitness,
} from "../src/orchestrator/lifecycle/lifecycle-intent-witness.js";
import {
  referenceWorkflowGenerationFingerprint,
} from "./support/lifecycle-projection-reference.js";

const NOW = "2026-07-22T00:00:00.000Z";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const VAULT_ID = "22222222-2222-4222-8222-222222222222";
const STORE_ID = "33333333-3333-4333-8333-333333333333";
const ROOT_ID = "44444444-4444-4444-8444-444444444444";
const CHILD_ID = "55555555-5555-4555-8555-555555555555";
const CHILD_B_ID = "55555555-5555-4555-8555-555555555556";
const CHILD_C_ID = "55555555-5555-4555-8555-555555555557";
const ADAPTER_ID = "66666666-6666-4666-8666-666666666666";
const BATCH_ID = "77777777-7777-4777-8777-777777777777";
const OTHER_ROOT_ID = "99999999-9999-4999-8999-999999999999";
const PROJECTION_WORKFLOW_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_ID = "1".repeat(64);
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
    readonly commandId?: string;
    readonly commandEventIndex?: number;
    readonly lifecycleIntent?: string;
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
    workspace_id: WORKSPACE_ID,
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
    command_id: options.commandId
      ?? `00000000-0000-4000-8000-${uuidTail(20_000n)}`,
    idempotency_key: `idempotency-${positionValue}`,
    command_event_index: options.commandEventIndex ?? 0,
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
    ...(options.lifecycleIntent === undefined
      ? {}
      : { lifecycle_intent_json: options.lifecycleIntent }),
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

function eventCommandId(position: number | bigint): string {
  const tail = ((BigInt(position) + 20_000n) & 0xffff_ffff_ffffn)
    .toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${tail}`;
}

function checkpointDraft(version: 1 | 2): Record<string, unknown> {
  const source = version === 1
    ? checkpointFixture()
    : qualifiedCheckpointFixture();
  return {
    checkpointVersion: version,
    taskSummary: source.taskSummary,
    completedItems: source.completedItems,
    inProgressItems: source.inProgressItems,
    blockers: source.blockers,
    nextActions: source.nextActions,
    decisions: source.decisions,
    assumptions: source.assumptions,
    unresolvedConflicts: source.unresolvedConflicts,
    filesTouched: source.filesTouched,
    artifactReferences: source.artifactReferences,
    sourceReferences: source.sourceReferences,
    commandResults: source.commandResults,
    testResults: source.testResults,
    materialClaims: source.materialClaims,
  };
}

function requestIntentWitness(commandId: string, version: 1 | 2 = 1): string {
  const command = {
    commandType: "request-session-end",
    commandId,
    idempotencyKey: `migration/request/${commandId}`,
    agentId: "agent-1",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: null,
    request: {
      requestVersion: version,
      sessionId: ROOT_ID,
      childEndPolicy: "require-completed",
      finalCheckpoint: checkpointDraft(version),
      validationProfileIds: [],
      requestedQualityThreshold: 0,
      requireFullEvidence: false,
      requireMaterialization: false,
    },
  };
  return buildLifecycleIntentWitness(command as never, {
    authorizationKind: "protected",
    authorizationSessionId: ROOT_ID,
    targetSessionId: ROOT_ID,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    clientNamespace: "tests",
    capabilityKind: "root-session-handle",
    capabilityGeneration: "1",
    presentingActorRole: "primary",
    presentingClientInstanceId: "client-1",
    targetActorRole: "primary",
    targetClientInstanceId: "client-1",
    internalWorkflowId: null,
    internalWorkflowGeneration: null,
    internalPlannedWorkId: null,
  }).source;
}

function unchangedAmendmentIntentWitness(
  commandId: string,
  expectedStreamVersion: string,
): string {
  const command = {
    commandType: "amend-session-end",
    commandId,
    idempotencyKey: `migration/amend/${commandId}`,
    agentId: "agent-1",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: null,
    sessionId: ROOT_ID,
    workflowId: PROJECTION_WORKFLOW_ID,
    expectedStreamVersion,
    amendment: {
      amendmentVersion: 2,
      childEndPolicy: null,
      finalCheckpoint: null,
      validationProfileIds: null,
      requestedQualityThreshold: null,
      requireFullEvidence: null,
      requireMaterialization: null,
      evidenceWindowAction: "unchanged",
    },
  };
  return buildLifecycleIntentWitness(command as never, {
    authorizationKind: "protected",
    authorizationSessionId: ROOT_ID,
    targetSessionId: ROOT_ID,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    clientNamespace: "tests",
    capabilityKind: "root-session-handle",
    capabilityGeneration: "1",
    presentingActorRole: "primary",
    presentingClientInstanceId: "client-1",
    targetActorRole: "primary",
    targetClientInstanceId: "client-1",
    internalWorkflowId: null,
    internalWorkflowGeneration: null,
    internalPlannedWorkId: null,
  }).source;
}

function legacyAmendmentIntentWitness(
  commandId: string,
  expectedStreamVersion: string,
): string {
  return buildLifecycleIntentWitness({
    commandType: "amend-session-end",
    commandId,
    idempotencyKey: `migration/legacy-amend/${commandId}`,
    agentId: "agent-1",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: null,
    sessionId: ROOT_ID,
    workflowId: PROJECTION_WORKFLOW_ID,
    expectedStreamVersion,
    amendment: {
      amendmentVersion: 1,
      childEndPolicy: null,
      finalCheckpoint: null,
      validationProfileIds: null,
      requestedQualityThreshold: null,
      requireFullEvidence: null,
      requireMaterialization: true,
    },
  } as never, {
    authorizationKind: "protected",
    authorizationSessionId: ROOT_ID,
    targetSessionId: ROOT_ID,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    clientNamespace: "tests",
    capabilityKind: "root-session-handle",
    capabilityGeneration: "1",
    presentingActorRole: "primary",
    presentingClientInstanceId: "client-1",
    targetActorRole: "primary",
    targetClientInstanceId: "client-1",
    internalWorkflowId: null,
    internalWorkflowGeneration: null,
    internalPlannedWorkId: null,
  }).source;
}

function cancelIntentWitness(
  commandId: string,
  workflowId: string,
  expectedStreamVersion: string,
  preTransitionCheckpointId: string,
): string {
  return buildLifecycleIntentWitness({
    commandType: "cancel-session-end",
    commandId,
    idempotencyKey: `migration/cancel/${commandId}`,
    agentId: "agent-1",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: null,
    sessionId: ROOT_ID,
    workflowId,
    expectedStreamVersion,
    preTransitionCheckpointId,
  } as never, {
    authorizationKind: "protected",
    authorizationSessionId: ROOT_ID,
    targetSessionId: ROOT_ID,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    clientNamespace: "tests",
    capabilityKind: "root-session-handle",
    capabilityGeneration: "1",
    presentingActorRole: "primary",
    presentingClientInstanceId: "client-1",
    targetActorRole: "primary",
    targetClientInstanceId: "client-1",
    internalWorkflowId: null,
    internalWorkflowGeneration: null,
    internalPlannedWorkId: null,
  }).source;
}

function abandonIntentWitness(
  commandId: string,
  expectedStreamVersion: string,
  preTransitionCheckpointId: string,
  reasonCode: string,
): string {
  return buildLifecycleIntentWitness({
    commandType: "abandon-session",
    commandId,
    idempotencyKey: `migration/abandon/${commandId}`,
    agentId: "agent-1",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: null,
    sessionId: ROOT_ID,
    expectedStreamVersion,
    preTransitionCheckpointId,
    reasonCode,
  } as never, {
    authorizationKind: "protected",
    authorizationSessionId: ROOT_ID,
    targetSessionId: ROOT_ID,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    clientNamespace: "tests",
    capabilityKind: "root-session-handle",
    capabilityGeneration: "1",
    presentingActorRole: "primary",
    presentingClientInstanceId: "client-1",
    targetActorRole: "primary",
    targetClientInstanceId: "client-1",
    internalWorkflowId: null,
    internalWorkflowGeneration: null,
    internalPlannedWorkId: null,
  }).source;
}

function seedLegacyEndRequest(
  connection: SqliteConnection,
  position: number,
  streamVersion: number,
): {
  readonly workflow_id: string;
  readonly root_command_id: string;
  readonly triggering_event_position: bigint;
} {
  const commandId = eventCommandId(position);
  rawEvent(connection, position, {
    streamType: "session",
    sessionId: ROOT_ID,
    streamVersion,
    eventType: "SessionEndRequested",
    eventSchemaVersion: 1,
    commandId,
    lifecycleIntent: requestIntentWitness(commandId),
    payload: {
      workflowId: PROJECTION_WORKFLOW_ID,
      workflowGeneration: 1,
      previousState: "active",
      childEndPolicy: "require-completed",
      qualityThreshold: 0,
      requireFullEvidence: false,
      requireMaterialization: false,
    },
  });
  return {
    workflow_id: PROJECTION_WORKFLOW_ID,
    root_command_id: commandId,
    triggering_event_position: BigInt(position),
  };
}

function seedChildForkProjectionEvent(
  connection: SqliteConnection,
  position = 1,
): void {
  const fork = lifecycleEvent(1, "SessionForked", {}, {
    projectId: PROJECT_ID as never,
    vaultId: VAULT_ID as never,
    storeId: STORE_ID as never,
    workspaceId: WORKSPACE_ID as never,
    sessionId: CHILD_ID as never,
    parentSessionId: ROOT_ID as never,
    globalPosition: position,
    streamVersion: 1,
    authorityCommitment: H64,
  });
  rawEvent(connection, position, {
    streamType: "session",
    sessionId: CHILD_ID,
    parentSessionId: ROOT_ID,
    streamVersion: 1,
    eventType: "SessionForked",
    payload: fork.payload,
  });
}

function childProjectionRow(
  overrides: Readonly<Record<string, SqliteValue>> = {},
): Record<string, SqliteValue> {
  return {
    project_id: PROJECT_ID,
    child_session_id: CHILD_ID,
    event_position: 1,
    stream_version: 1,
    root_session_id: ROOT_ID,
    child_state: "active",
    latest_checkpoint_id: null,
    latest_checkpoint_event_position: null,
    authority_commitment: H64,
    terminal_event_type: null,
    terminal_event_position: null,
    report_count: 0,
    latest_report_id: null,
    report_index_fingerprint: H64,
    completion_report_id: null,
    reported_report_id: null,
    reported_item_count: null,
    reported_item_set_fingerprint: null,
    previous_fingerprint: null,
    fingerprint: H64_B,
    ...overrides,
  };
}

function workflowProjectionRow(
  triggerPosition = 2,
  overrides: Readonly<Record<string, SqliteValue>> = {},
): Record<string, SqliteValue> {
  return {
    project_id: PROJECT_ID,
    workflow_id: PROJECTION_WORKFLOW_ID,
    workflow_generation: 1,
    session_id: ROOT_ID,
    trigger_event_position: triggerPosition,
    root_command_id: eventCommandId(triggerPosition),
    evidence_window_state: "sealed",
    replacement_checkpoint_version: 1,
    effective_checkpoint_version: 1,
    effective_draft_source_event_position: triggerPosition,
    previous_fingerprint: null,
    fingerprint: H64,
    ...overrides,
  };
}

function intentWithWrongCommandId(source: string): string {
  const parsed = JSON.parse(source) as {
    intent: { command: { commandId: string } };
  };
  parsed.intent.command.commandId =
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  return canonicalJson(parsed as never);
}

function sessionEndStatus(
  phase: string,
  finalCheckpointId: string | null,
  finalCheckpointEventPosition: string | null,
  projection: {
    readonly workflowId?: string;
    readonly triggeringEventPosition?: string;
  } = {},
): Record<string, unknown> {
  return {
    resultVersion: 2,
    sessionId: ROOT_ID,
    workflowId: projection.workflowId ?? `session-end/${ROOT_ID}`,
    workflowGeneration: 1,
    phase,
    priorRootState: "active",
    triggeringEventPosition: projection.triggeringEventPosition ?? "1",
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
  const workflowInsertGuardSql = connection.prepare(`
    SELECT sql FROM sqlite_schema
    WHERE type = 'trigger'
      AND name = 'workflow_instances_lifecycle_insert_guard'
  `).get()?.sql;
  assert.equal(typeof workflowInsertGuardSql, "string");
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
  const projection = seedLegacyEndRequest(connection, 7, 3);
  const phase = options.phase ?? "final-checkpoint-recorded";
  rawInsert(connection, "workflow_instances", legacyLifecycleWorkflow({
    ...projection,
    phase,
    result_json: canonicalJson(sessionEndStatus(
      phase,
      String(rootFinal.checkpointId),
      "6",
      {
        workflowId: PROJECTION_WORKFLOW_ID,
        triggeringEventPosition: "7",
      },
    )),
  }));
  connection.exec(String(workflowInsertGuardSql));
}

function seedAllChildProjectionEventClasses(
  connection: SqliteConnection,
): void {
  seedChildForkProjectionEvent(connection, 1);
  const writeFixture = (
    position: number,
    streamVersion: number,
    eventType: Parameters<typeof lifecycleEvent>[1],
    childSessionId: string,
    payload: Record<string, unknown> = {},
  ): ReturnType<typeof lifecycleEvent> => {
    const event = lifecycleEvent(position, eventType, payload as never, {
      projectId: PROJECT_ID as never,
      vaultId: VAULT_ID as never,
      storeId: STORE_ID as never,
      workspaceId: WORKSPACE_ID as never,
      sessionId: childSessionId as never,
      parentSessionId: ROOT_ID as never,
      globalPosition: position,
      streamVersion,
      authorityCommitment: H64,
    });
    rawEvent(connection, position, {
      streamType: "session",
      sessionId: childSessionId,
      parentSessionId: ROOT_ID,
      streamVersion,
      eventType,
      payload: event.payload,
    });
    return event;
  };
  writeFixture(2, 2, "ChildAssignmentAmended", CHILD_ID);
  writeFixture(3, 3, "ChildWorkTransferClaimed", CHILD_ID);

  const forkB = lifecycleEvent(10, "SessionForked", {}, {
    projectId: PROJECT_ID as never,
    vaultId: VAULT_ID as never,
    storeId: STORE_ID as never,
    workspaceId: WORKSPACE_ID as never,
    sessionId: CHILD_B_ID as never,
    parentSessionId: ROOT_ID as never,
    globalPosition: 10,
    streamVersion: 1,
    authorityCommitment: H64,
  });
  rawEvent(connection, 10, {
    streamType: "session",
    sessionId: CHILD_B_ID,
    parentSessionId: ROOT_ID,
    streamVersion: 1,
    eventType: "SessionForked",
    payload: forkB.payload,
  });
  const checkpointB = writeFixture(
    11,
    2,
    "SessionCheckpointRecorded",
    CHILD_B_ID,
  );
  const checkpointBId = String(
    (checkpointB.payload as { checkpoint: { checkpointId: string } })
      .checkpoint.checkpointId,
  );
  writeFixture(12, 3, "ChildSessionSuspended", CHILD_B_ID, {
    checkpointId: checkpointBId,
    authorityCommitment: H64,
  });
  writeFixture(13, 4, "ChildWorkTransferCreated", CHILD_B_ID, {
    checkpointId: checkpointBId,
    authorityCommitment: H64,
  });

  const forkC = lifecycleEvent(20, "SessionForked", {}, {
    projectId: PROJECT_ID as never,
    vaultId: VAULT_ID as never,
    storeId: STORE_ID as never,
    workspaceId: WORKSPACE_ID as never,
    sessionId: CHILD_C_ID as never,
    parentSessionId: ROOT_ID as never,
    globalPosition: 20,
    streamVersion: 1,
    authorityCommitment: H64,
  });
  rawEvent(connection, 20, {
    streamType: "session",
    sessionId: CHILD_C_ID,
    parentSessionId: ROOT_ID,
    streamVersion: 1,
    eventType: "SessionForked",
    payload: forkC.payload,
  });
  const report = lifecycleEvent(21, "ChildWorkReported", {}, {
    projectId: PROJECT_ID as never,
    vaultId: VAULT_ID as never,
    storeId: STORE_ID as never,
    workspaceId: WORKSPACE_ID as never,
    sessionId: CHILD_C_ID as never,
    parentSessionId: ROOT_ID as never,
    globalPosition: 21,
    streamVersion: 2,
    authorityCommitment: H64,
  });
  const { allReportItemIds, ...storedReport } = report.payload.report;
  rawEvent(connection, 21, {
    streamType: "session",
    sessionId: CHILD_C_ID,
    parentSessionId: ROOT_ID,
    streamVersion: 2,
    eventType: "ChildWorkReported",
    payload: { ...report.payload, report: storedReport },
  });
  writeFixture(22, 3, "ChildCompletionProposed", CHILD_C_ID, {
    reportId: report.payload.report.reportId,
  });
  writeFixture(23, 4, "ChildWorkDispositioned", CHILD_C_ID, {
    disposition: {
      ...childDispositionFixture("rejected", report.payload.report.reportId),
      rejectedItemIds: allReportItemIds,
      allReportItemIds,
    },
  });
  writeFixture(24, 5, "ChildCompletionProposed", CHILD_C_ID, {
    reportId: report.payload.report.reportId,
  });
  writeFixture(25, 6, "ChildSessionCompleted", CHILD_C_ID, {
    reportId: report.payload.report.reportId,
    authorityCommitment: H64,
  });
}

function seedAllWorkflowProjectionTriggerClasses(
  connection: SqliteConnection,
): void {
  const checkpointId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  seedRootStart(connection);
  rawEvent(connection, 2, {
    streamType: "session",
    sessionId: ROOT_ID,
    streamVersion: 2,
    eventType: "SessionEndRequested",
    commandId: eventCommandId(2),
    lifecycleIntent: requestIntentWitness(eventCommandId(2)),
    payload: {
      workflowId: PROJECTION_WORKFLOW_ID,
      workflowGeneration: 1,
      previousState: "active",
      childEndPolicy: "require-completed",
      qualityThreshold: 0,
      requireFullEvidence: false,
      requireMaterialization: false,
    },
  });
  rawEvent(connection, 3, {
    streamType: "session",
    sessionId: ROOT_ID,
    streamVersion: 3,
    eventType: "SessionEndAmended",
    commandId: eventCommandId(3),
    lifecycleIntent: legacyAmendmentIntentWitness(eventCommandId(3), "2"),
    payload: {
      workflowId: PROJECTION_WORKFLOW_ID,
      previousWorkflowGeneration: 1,
      workflowGeneration: 2,
      preTransitionCheckpointId: checkpointId,
    },
  });
  rawEvent(connection, 4, {
    streamType: "session",
    sessionId: ROOT_ID,
    streamVersion: 4,
    eventType: "SessionEndCancelled",
    commandId: eventCommandId(4),
    lifecycleIntent: cancelIntentWitness(
      eventCommandId(4),
      PROJECTION_WORKFLOW_ID,
      "3",
      checkpointId,
    ),
    payload: {
      workflowId: PROJECTION_WORKFLOW_ID,
      workflowGeneration: 2,
      restoredState: "active",
      preTransitionCheckpointId: checkpointId,
    },
  });
  rawEvent(connection, 5, {
    streamType: "session",
    sessionId: ROOT_ID,
    streamVersion: 5,
    eventType: "SessionEndRequested",
    commandId: eventCommandId(5),
    lifecycleIntent: requestIntentWitness(eventCommandId(5)),
    payload: {
      workflowId: PROJECTION_WORKFLOW_ID,
      workflowGeneration: 3,
      previousState: "active",
      childEndPolicy: "require-completed",
      qualityThreshold: 0,
      requireFullEvidence: false,
      requireMaterialization: false,
    },
  });
  rawEvent(connection, 6, {
    streamType: "session",
    sessionId: ROOT_ID,
    streamVersion: 6,
    eventType: "SessionAbandoned",
    commandId: eventCommandId(6),
    lifecycleIntent: abandonIntentWitness(
      eventCommandId(6),
      "5",
      checkpointId,
      "explicit-user-approval",
    ),
    payload: {
      workflowId: PROJECTION_WORKFLOW_ID,
      workflowGeneration: 3,
      approvalId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      preTransitionCheckpointId: checkpointId,
      reasonCode: "explicit-user-approval",
      authorityCommitment: H64,
    },
  });
  rawInsert(connection, "workflow_instances", legacyLifecycleWorkflow({
    workflow_id: PROJECTION_WORKFLOW_ID,
    generation: 3,
    state: "completed",
    phase: "abandoned",
    root_command_id: eventCommandId(6),
    session_id: ROOT_ID,
    triggering_event_position: 6,
  }));
}

function seedAmendedWorkflowProjection(
  connection: SqliteConnection,
): void {
  const checkpointId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  seedRootStart(connection);
  rawEvent(connection, 2, {
    streamType: "session",
    sessionId: ROOT_ID,
    streamVersion: 2,
    eventType: "SessionEndRequested",
    commandId: eventCommandId(2),
    lifecycleIntent: requestIntentWitness(eventCommandId(2)),
    payload: {
      workflowId: PROJECTION_WORKFLOW_ID,
      workflowGeneration: 1,
      previousState: "active",
      childEndPolicy: "require-completed",
      qualityThreshold: 0,
      requireFullEvidence: false,
      requireMaterialization: false,
    },
  });
  rawEvent(connection, 3, {
    streamType: "session",
    sessionId: ROOT_ID,
    streamVersion: 3,
    eventType: "SessionEndAmended",
    commandId: eventCommandId(3),
    lifecycleIntent: legacyAmendmentIntentWitness(eventCommandId(3), "2"),
    payload: {
      workflowId: PROJECTION_WORKFLOW_ID,
      previousWorkflowGeneration: 1,
      workflowGeneration: 2,
      preTransitionCheckpointId: checkpointId,
    },
  });
  rawInsert(connection, "workflow_instances", legacyLifecycleWorkflow({
    workflow_id: PROJECTION_WORKFLOW_ID,
    generation: 2,
    state: "active",
    phase: "requested",
    root_command_id: eventCommandId(3),
    session_id: ROOT_ID,
    triggering_event_position: 3,
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
    CREATE TEMP TABLE ${QUALIFIED_CHECKPOINT_STAGE_CHILD_EVENT_FOLDS_TABLE} (
      project_id TEXT NOT NULL,
      child_session_id TEXT NOT NULL,
      event_position INTEGER NOT NULL,
      stream_version INTEGER NOT NULL,
      root_session_id TEXT NOT NULL,
      child_state TEXT NOT NULL,
      latest_checkpoint_id TEXT,
      latest_checkpoint_event_position INTEGER,
      authority_commitment TEXT NOT NULL,
      terminal_event_type TEXT,
      terminal_event_position INTEGER,
      report_count INTEGER NOT NULL,
      latest_report_id TEXT,
      report_index_fingerprint TEXT NOT NULL,
      completion_report_id TEXT,
      reported_report_id TEXT,
      reported_item_count INTEGER,
      reported_item_set_fingerprint TEXT,
      previous_fingerprint TEXT,
      fingerprint TEXT NOT NULL
    ) STRICT;
    CREATE TEMP TABLE
    ${QUALIFIED_CHECKPOINT_STAGE_WORKFLOW_GENERATION_FOLDS_TABLE} (
      project_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      workflow_generation INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      trigger_event_position INTEGER NOT NULL,
      root_command_id TEXT NOT NULL,
      evidence_window_state TEXT NOT NULL,
      replacement_checkpoint_version INTEGER,
      effective_checkpoint_version INTEGER NOT NULL,
      effective_draft_source_event_position INTEGER NOT NULL,
      previous_fingerprint TEXT,
      fingerprint TEXT NOT NULL
    ) STRICT;
    CREATE TEMP TABLE ${QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE} (
      singleton INTEGER PRIMARY KEY,
      project_id TEXT NOT NULL,
      vault_id TEXT NOT NULL,
      store_id TEXT NOT NULL,
      source_schema_version INTEGER NOT NULL,
      target_schema_version INTEGER NOT NULL,
      freeze_row_count INTEGER NOT NULL,
      child_fold_row_count INTEGER NOT NULL,
      workflow_generation_row_count INTEGER NOT NULL,
      sealed INTEGER NOT NULL
    ) STRICT;
    INSERT INTO ${QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE}
    VALUES (
      1, '${PROJECT_ID}', '${VAULT_ID}', '${STORE_ID}',
      2, 3, 0, 0, 0, 1
    );
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
    CREATE TEMP TRIGGER
    qualified_checkpoint_v3_stage_child_event_folds_no_insert
      BEFORE INSERT ON ${QUALIFIED_CHECKPOINT_STAGE_CHILD_EVENT_FOLDS_TABLE}
      BEGIN SELECT RAISE(ABORT, 'MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED'); END;
    CREATE TEMP TRIGGER
    qualified_checkpoint_v3_stage_child_event_folds_no_update
      BEFORE UPDATE ON ${QUALIFIED_CHECKPOINT_STAGE_CHILD_EVENT_FOLDS_TABLE}
      BEGIN SELECT RAISE(ABORT, 'MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED'); END;
    CREATE TEMP TRIGGER
    qualified_checkpoint_v3_stage_child_event_folds_no_delete
      BEFORE DELETE ON ${QUALIFIED_CHECKPOINT_STAGE_CHILD_EVENT_FOLDS_TABLE}
      BEGIN SELECT RAISE(ABORT, 'MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED'); END;
    CREATE TEMP TRIGGER
    qualified_checkpoint_v3_stage_workflow_generation_folds_no_insert
      BEFORE INSERT
      ON ${QUALIFIED_CHECKPOINT_STAGE_WORKFLOW_GENERATION_FOLDS_TABLE}
      BEGIN SELECT RAISE(ABORT, 'MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED'); END;
    CREATE TEMP TRIGGER
    qualified_checkpoint_v3_stage_workflow_generation_folds_no_update
      BEFORE UPDATE
      ON ${QUALIFIED_CHECKPOINT_STAGE_WORKFLOW_GENERATION_FOLDS_TABLE}
      BEGIN SELECT RAISE(ABORT, 'MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED'); END;
    CREATE TEMP TRIGGER
    qualified_checkpoint_v3_stage_workflow_generation_folds_no_delete
      BEFORE DELETE
      ON ${QUALIFIED_CHECKPOINT_STAGE_WORKFLOW_GENERATION_FOLDS_TABLE}
      BEGIN SELECT RAISE(ABORT, 'MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED'); END;
  `);
}

function mutateSealedTempTable(
  connection: SqliteConnection,
  denialTriggerName: string,
  mutate: () => void,
): void {
  const triggerSql = connection.prepare(`
    SELECT sql FROM temp.sqlite_schema
    WHERE type = 'trigger' AND name = $name
  `).get({ $name: denialTriggerName })?.sql;
  assert.equal(typeof triggerSql, "string", denialTriggerName);
  connection.exec(`DROP TRIGGER temp.${denialTriggerName}`);
  mutate();
  connection.exec(
    String(triggerSql).replace(/^CREATE TRIGGER/i, "CREATE TEMP TRIGGER"),
  );
}

function replaceFreezeStageRowsUnchecked(
  connection: SqliteConnection,
  overrides: Readonly<Record<string, SqliteValue>>,
): void {
  const triggerNames = [
    "qualified_checkpoint_v3_stage_rows_no_insert",
    "qualified_checkpoint_v3_stage_rows_no_update",
    "qualified_checkpoint_v3_stage_rows_no_delete",
  ] as const;
  const triggerSql = triggerNames.map((name) => {
    const sql = connection.prepare(`
      SELECT sql FROM temp.sqlite_schema
      WHERE type = 'trigger' AND name = $name
    `).get({ $name: name })?.sql;
    assert.equal(typeof sql, "string", name);
    return String(sql).replace(/^CREATE TRIGGER/i, "CREATE TEMP TRIGGER");
  });
  const rows = connection.prepare(
    `SELECT * FROM ${QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE}`,
  ).all().map((row) => ({
    ...(row as Readonly<Record<string, SqliteValue>>),
    ...overrides,
  }));
  for (const name of triggerNames) connection.exec(`DROP TRIGGER temp.${name}`);
  connection.exec(`
    ALTER TABLE ${QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE}
      RENAME TO qualified_checkpoint_v3_stage_rows_checked;
    CREATE TEMP TABLE ${QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE} (
      workflow_id TEXT PRIMARY KEY,
      source_generation INTEGER NOT NULL,
      source_phase TEXT NOT NULL,
      evidence_frozen_checkpoint_event_position INTEGER,
      evidence_frozen_generation INTEGER,
      evidence_window_state TEXT NOT NULL,
      final_ending_scope_bindings_json TEXT
    ) STRICT;
  `);
  for (const row of rows) {
    rawInsert(connection, QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE, row);
  }
  connection.exec("DROP TABLE qualified_checkpoint_v3_stage_rows_checked");
  for (const sql of triggerSql) connection.exec(sql);
}

function replaceProjectionStageRowUnchecked(
  connection: SqliteConnection,
  table: typeof QUALIFIED_CHECKPOINT_STAGE_CHILD_EVENT_FOLDS_TABLE
    | typeof QUALIFIED_CHECKPOINT_STAGE_WORKFLOW_GENERATION_FOLDS_TABLE,
  keyColumn: "event_position" | "workflow_generation",
  keyValue: number,
  overrides: Readonly<Record<string, SqliteValue>>,
): void {
  const suffix = table === QUALIFIED_CHECKPOINT_STAGE_CHILD_EVENT_FOLDS_TABLE
    ? "child_event_folds"
    : "workflow_generation_folds";
  const triggerNames = ["insert", "update", "delete"].map(
    (operation) => `qualified_checkpoint_v3_stage_${suffix}_no_${operation}`,
  );
  const triggerSql = triggerNames.map((name) => {
    const sql = connection.prepare(`
      SELECT sql FROM temp.sqlite_schema
      WHERE type = 'trigger' AND name = $name
    `).get({ $name: name })?.sql;
    assert.equal(typeof sql, "string", name);
    return String(sql).replace(/^CREATE TRIGGER/i, "CREATE TEMP TRIGGER");
  });
  const rows = connection.prepare(`SELECT * FROM ${table}`).all().map(
    (row) => {
      const record = row as Readonly<Record<string, SqliteValue>>;
      return diagnosticBigInt(record[keyColumn]) === BigInt(keyValue)
        ? { ...record, ...overrides }
        : record;
    },
  );
  const checkedTable = `${table}_checked`;
  for (const name of triggerNames) connection.exec(`DROP TRIGGER temp.${name}`);
  connection.exec(`ALTER TABLE ${table} RENAME TO ${checkedTable}`);
  if (table === QUALIFIED_CHECKPOINT_STAGE_CHILD_EVENT_FOLDS_TABLE) {
    connection.exec(`
      CREATE TEMP TABLE ${table} (
        project_id TEXT NOT NULL,
        child_session_id TEXT NOT NULL,
        event_position INTEGER NOT NULL,
        stream_version INTEGER NOT NULL,
        root_session_id TEXT NOT NULL,
        child_state TEXT NOT NULL,
        latest_checkpoint_id TEXT,
        latest_checkpoint_event_position INTEGER,
        authority_commitment TEXT NOT NULL,
        terminal_event_type TEXT,
        terminal_event_position INTEGER,
        report_count INTEGER NOT NULL,
        latest_report_id TEXT,
        report_index_fingerprint TEXT NOT NULL,
        completion_report_id TEXT,
        reported_report_id TEXT,
        reported_item_count INTEGER,
        reported_item_set_fingerprint TEXT,
        previous_fingerprint TEXT,
        fingerprint TEXT NOT NULL
      ) STRICT
    `);
  } else {
    connection.exec(`
      CREATE TEMP TABLE ${table} (
        project_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        workflow_generation INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        trigger_event_position INTEGER NOT NULL,
        root_command_id TEXT NOT NULL,
        evidence_window_state TEXT NOT NULL,
        replacement_checkpoint_version INTEGER,
        effective_checkpoint_version INTEGER NOT NULL,
        effective_draft_source_event_position INTEGER NOT NULL,
        previous_fingerprint TEXT,
        fingerprint TEXT NOT NULL
      ) STRICT
    `);
  }
  for (const row of rows) rawInsert(connection, table, row);
  connection.exec(`DROP TABLE ${checkedTable}`);
  for (const sql of triggerSql) connection.exec(sql);
}

type FirstGuardFamily =
  | "marker"
  | "seal"
  | "freeze"
  | "project-identity"
  | "legacy-source"
  | "child-projection"
  | "workflow-projection";

const FIRST_GUARD_FAMILY_CLAUSES: Readonly<Record<
  FirstGuardFamily,
  readonly number[]
>> = Object.freeze({
  marker: Object.freeze([0, 1, 2, 3, 4, 5, 6, 7]),
  seal: Object.freeze([8]),
  freeze: Object.freeze([9, 12, 13]),
  "project-identity": Object.freeze([10, 11]),
  "legacy-source": Object.freeze([14, 15, 16, 17, 18, 19, 20]),
  "child-projection": Object.freeze([21, 22, 23]),
  "workflow-projection": Object.freeze([24, 25, 26, 27]),
});

function splitTopLevelSqlConjunction(expression: string): readonly string[] {
  const clauses: string[] = [];
  let start = 0;
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index]!;
    if (character === "'") {
      if (quoted && expression[index + 1] === "'") {
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (quoted) continue;
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character === ")") {
      depth -= 1;
      continue;
    }
    if (
      depth === 0
      && expression.slice(index, index + 3) === "AND"
      && /\s/.test(expression[index - 1] ?? " ")
      && /\s/.test(expression[index + 3] ?? " ")
    ) {
      clauses.push(expression.slice(start, index).trim());
      start = index + 3;
      index += 2;
    }
  }
  clauses.push(expression.slice(start).trim());
  return clauses;
}

function firstGuardClauses(): readonly string[] {
  const sql = qualifiedCheckpointCoverageMigration.sql;
  const prefix = "INSERT INTO qualified_checkpoint_v3_guard(value)\n"
    + "SELECT CASE WHEN\n";
  const start = sql.indexOf(prefix);
  assert.ok(start >= 0, "first pre-copy guard start");
  const expressionStart = start + prefix.length;
  const end = sql.indexOf("THEN 1 ELSE 0 END;", expressionStart);
  assert.ok(end > expressionStart, "first pre-copy guard end");
  const clauses = splitTopLevelSqlConjunction(
    sql.slice(expressionStart, end).trim(),
  );
  assert.equal(clauses.length, 28, "first pre-copy guard clause inventory");
  return clauses;
}

function evaluateFirstGuardFamilies(
  connection: SqliteConnection,
): Readonly<Record<FirstGuardFamily, boolean>> {
  const clauses = firstGuardClauses();
  return Object.fromEntries(
    Object.entries(FIRST_GUARD_FAMILY_CLAUSES).map(([family, indexes]) => {
      const expression = indexes.map((index) => `(${clauses[index]})`)
        .join(" AND ");
      const row = connection.prepare(`
        SELECT CASE WHEN ${expression} THEN 1 ELSE 0 END AS valid
      `).get();
      return [family, row?.valid === 1n];
    }),
  ) as Readonly<Record<FirstGuardFamily, boolean>>;
}

function assertFirstGuardFamilyIsolation(
  connection: SqliteConnection,
  intendedFalse: readonly FirstGuardFamily[],
  caseName: string,
): void {
  const actual = evaluateFirstGuardFamilies(connection);
  const intended = new Set(intendedFalse);
  for (const family of Object.keys(
    FIRST_GUARD_FAMILY_CLAUSES,
  ) as FirstGuardFamily[]) {
    assert.equal(
      actual[family],
      !intended.has(family),
      `${caseName}: ${family}`,
    );
  }
}

function rowsInsideNotExistsClause(
  connection: SqliteConnection,
  clauseIndex: number,
  select: string,
): readonly Readonly<Record<string, SqliteValue>>[] {
  const clause = firstGuardClauses()[clauseIndex]!;
  const prefix = "NOT EXISTS (";
  assert.ok(clause.startsWith(prefix), `clause ${clauseIndex} NOT EXISTS`);
  assert.ok(clause.endsWith(")"), `clause ${clauseIndex} closes`);
  const inner = clause.slice(prefix.length, -1).trim();
  assert.match(inner, /^SELECT 1\b/);
  return connection.prepare(
    inner.replace(/^SELECT 1\b/, `SELECT ${select}`),
  ).all() as readonly Readonly<Record<string, SqliteValue>>[];
}

interface ChildFirstGuardDiagnostic {
  readonly countMatches: boolean;
  readonly invalidStagePositions: readonly bigint[];
  readonly unlinkedSourcePositions: readonly bigint[];
}

function diagnosticBigInt(value: SqliteValue | undefined): bigint {
  assert.ok(
    typeof value === "bigint"
    || typeof value === "number"
    || typeof value === "string",
  );
  return BigInt(value);
}

function diagnoseChildFirstGuard(
  connection: SqliteConnection,
): ChildFirstGuardDiagnostic {
  const clauses = firstGuardClauses();
  const count = connection.prepare(`
    SELECT CASE WHEN ${clauses[21]} THEN 1 ELSE 0 END AS valid
  `).get()?.valid === 1n;
  const invalidStagePositions = rowsInsideNotExistsClause(
    connection,
    22,
    "child.event_position AS event_position",
  ).map((row) => diagnosticBigInt(row.event_position)).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0);
  const unlinkedSourcePositions = rowsInsideNotExistsClause(
    connection,
    23,
    "source.global_position AS event_position",
  ).map((row) => diagnosticBigInt(row.event_position)).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0);
  return {
    countMatches: count,
    invalidStagePositions,
    unlinkedSourcePositions,
  };
}

interface WorkflowFirstGuardDiagnostic {
  readonly groupingCountMatches: boolean;
  readonly invalidStageGenerations: readonly bigint[];
  readonly uncoveredInstanceGenerations: readonly bigint[];
  readonly uncoveredLatestGenerations: readonly bigint[];
}

function diagnoseWorkflowFirstGuard(
  connection: SqliteConnection,
): WorkflowFirstGuardDiagnostic {
  const clauses = firstGuardClauses();
  const count = connection.prepare(`
    SELECT CASE WHEN ${clauses[24]} THEN 1 ELSE 0 END AS valid
  `).get()?.valid === 1n;
  const generations = (
    clauseIndex: number,
    select: string,
  ): readonly bigint[] => rowsInsideNotExistsClause(
    connection,
    clauseIndex,
    select,
  ).map((row) => diagnosticBigInt(row.generation)).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0);
  return {
    groupingCountMatches: count,
    invalidStageGenerations: generations(
      25,
      "workflow.workflow_generation AS generation",
    ),
    uncoveredInstanceGenerations: generations(
      26,
      "instance.generation AS generation",
    ),
    uncoveredLatestGenerations: generations(
      27,
      "fold.workflow_generation AS generation",
    ),
  };
}

function expectChildFirstGuardDiagnostic(
  expected: ChildFirstGuardDiagnostic,
  caseName?: string,
): (connection: SqliteConnection) => void {
  return (connection) => assert.deepEqual(
    diagnoseChildFirstGuard(connection),
    expected,
    caseName,
  );
}

function expectWorkflowFirstGuardDiagnostic(
  expected: WorkflowFirstGuardDiagnostic,
  caseName?: string,
): (connection: SqliteConnection) => void {
  return (connection) => assert.deepEqual(
    diagnoseWorkflowFirstGuard(connection),
    expected,
    caseName,
  );
}

function assertNoPersistentProjectionTable(
  connection: SqliteConnection,
  caseName: string,
): void {
  assert.equal(
    connection.prepare(`
      SELECT count(*) AS count FROM sqlite_schema
      WHERE name IN (
        'lifecycle_child_event_folds',
        'lifecycle_workflow_generation_folds'
      )
    `).get()?.count,
    0n,
    caseName,
  );
}

function assertPreCopyMutationRejected(
  caseName: string,
  seed: (connection: SqliteConnection) => void,
  mutate: (connection: SqliteConnection) => void,
  stage: "preflight" | "forged-empty" = "preflight",
  intendedFalseFamilies: readonly FirstGuardFamily[] = [],
  assertLeafDiagnostic: (connection: SqliteConnection) => void =
    () => undefined,
): void {
  const connection = sourceConnection(2);
  connection.exec("PRAGMA foreign_keys = OFF");
  seed(connection);
  connection.exec("BEGIN IMMEDIATE");
  if (stage === "preflight") {
    new SqliteQualifiedCheckpointMigrationPreflight()
      .assertEligibleAndStage(connection, context);
  } else {
    installForgedEmptyStage(connection);
  }
  mutate(connection);
  assertFirstGuardFamilyIsolation(
    connection,
    intendedFalseFamilies,
    caseName,
  );
  assertLeafDiagnostic(connection);
  assert.throws(
    () => connection.exec(qualifiedCheckpointCoverageMigration.sql),
    /MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED/,
    caseName,
  );
  assertNoPersistentProjectionTable(connection, caseName);
  connection.exec("ROLLBACK");
  assert.equal(schemaVersion(connection), 2, caseName);
}

afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("qualified checkpoint migration", () => {
  it("migration 3 full replay cursors use global order indexes without temp sorting", () => {
    const connection = currentConnection();
    const indexes = [
      {
        table: "lifecycle_child_event_folds",
        name: "lifecycle_child_event_folds_full_replay",
        columns: ["project_id", "event_position", "child_session_id", "stream_version"],
        sql: CHILD_EVENT_FOLD_CURSOR_SQL,
      },
      {
        table: "lifecycle_workflow_generation_folds",
        name: "lifecycle_workflow_generation_folds_full_replay",
        columns: ["project_id", "trigger_event_position", "workflow_id", "workflow_generation"],
        sql: WORKFLOW_GENERATION_FOLD_CURSOR_SQL,
      },
      {
        table: "session_evidence_coverage_transitions",
        name: "session_evidence_coverage_transitions_full_replay",
        columns: ["project_id", "batch_event_position", "session_id", "adapter_session_id"],
        sql: QUALIFIED_TRANSITION_CURSOR_SQL,
      },
      {
        table: "session_evidence_fingerprints",
        name: "session_evidence_fingerprints_full_replay",
        columns: ["project_id", "recorded_event_position", "session_id", "adapter_session_id", "ordinal"],
        sql: QUALIFIED_ORDINAL_CURSOR_SQL,
      },
    ] as const;

    for (const candidate of indexes) {
      const metadata = connection.prepare(
        `PRAGMA index_list('${candidate.table}')`,
      ).all().find((row) => row.name === candidate.name);
      assert.equal(metadata?.unique, 0n, candidate.name);
      assert.equal(metadata?.partial, 0n, candidate.name);
      assert.deepEqual(
        connection.prepare(`PRAGMA index_info('${candidate.name}')`).all()
          .map((row) => row.name),
        candidate.columns,
        candidate.name,
      );
    }

    const cursorPlans = [
      [LIFECYCLE_EVENT_CURSOR_SQL, "events_project_position"],
      ...indexes.map((candidate) => [candidate.sql, candidate.name] as const),
    ] as const;
    for (const [sql, expectedIndex] of cursorPlans) {
      const plan = connection.prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all({ $projectId: PROJECT_ID })
        .map((row) => String(row.detail))
        .join("\n");
      assert.match(plan, new RegExp(expectedIndex), expectedIndex);
      assert.doesNotMatch(plan, /USE TEMP B-TREE/i, expectedIndex);
      assert.doesNotMatch(plan, /^SCAN (?:events|lifecycle_|session_evidence_)/im, expectedIndex);
    }
  });

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
              SET freeze_row_count = freeze_row_count + 1;
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
    assert.deepEqual(PROJECT_STORE_MIGRATIONS.map((migration) => migration.version), [1, 2, 3, 4, 5, 6]);
    assert.equal(CURRENT_PROJECT_STORE_SCHEMA_VERSION, 6);
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
        'session_evidence_coverage_latest_transition',
        'child_transfer_tickets_unclaimed_source_root'
      )
    `).get()?.count, 4n);
    const transferProjectionIndexSql = String(connection.prepare(`
      SELECT sql FROM sqlite_schema
      WHERE type = 'index'
        AND name = 'child_transfer_tickets_unclaimed_source_root'
    `).get()?.sql);
    assert.match(
      transferProjectionIndexSql,
      /ON child_transfer_tickets\(\s*project_id,\s*source_parent_session_id,\s*source_child_session_id,\s*transfer_ticket_id\s*\)/,
    );
    assert.match(
      transferProjectionIndexSql,
      /WHERE claimed_by_root_session_id IS NULL[\s\S]*claimed_child_session_id IS NULL[\s\S]*claimed_event_position IS NULL[\s\S]*claimed_at IS NULL/,
    );
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
      SELECT sealed, freeze_row_count
      FROM ${QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE}
    `).get()?.sealed, 1n);
    for (const mutation of [
      `INSERT INTO ${QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE}(
        singleton, project_id, vault_id, store_id, source_schema_version,
        target_schema_version, freeze_row_count, child_fold_row_count,
        workflow_generation_row_count, sealed
      ) VALUES (
        2, '${PROJECT_ID}', '${VAULT_ID}', '${STORE_ID}', 2, 3, 0, 0, 0, 1
      )`,
      `UPDATE ${QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE}
       SET freeze_row_count = 1`,
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
       UPDATE ${QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE}
       SET freeze_row_count = 1`,
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

    const strictValidCheckpoint = sourceConnection(2);
    strictValidCheckpoint.exec("PRAGMA foreign_keys = OFF");
    seedRootStart(strictValidCheckpoint, 1);
    const rootCorrelationId = strictValidCheckpoint.prepare(`
      SELECT correlation_id
      FROM events
      WHERE global_position = 1
    `).get()?.correlation_id;
    if (typeof rootCorrelationId !== "string") {
      assert.fail("expected the valid V1 root start correlation ID");
    }
    const checkpoint = qualifiedCheckpointFixture({
      sessionId: ROOT_ID as never,
      parentSessionId: null,
      baseEventPosition: 1,
      checkpointEventPosition: 2,
    });
    rawEvent(strictValidCheckpoint, 2, {
      streamType: "session",
      sessionId: ROOT_ID,
      parentSessionId: null,
      streamVersion: 2,
      eventType: "SessionCheckpointRecorded",
      eventSchemaVersion: 2,
      correlationId: rootCorrelationId,
      payload: {
        checkpoint,
        baseEventPosition: "1",
        checkpointEventPosition: "2",
      },
    });
    assert.throws(
      () => new SqliteQualifiedCheckpointMigrationPreflight()
        .assertEligibleAndStage(strictValidCheckpoint, context),
      (error) => (
        typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED"
      ),
    );
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

    const tampered = sourceConnection(2);
    seedTransferredFinalHistory(tampered);
    tampered.exec("BEGIN IMMEDIATE");
    new SqliteQualifiedCheckpointMigrationPreflight()
      .assertEligibleAndStage(tampered, context);
    const nonzeroMarker = tampered.prepare(`
      SELECT freeze_row_count, child_fold_row_count,
             workflow_generation_row_count
      FROM temp.${QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE}
    `).get();
    assert.deepEqual({ ...nonzeroMarker }, {
      freeze_row_count: 1n,
      child_fold_row_count: 4n,
      workflow_generation_row_count: 1n,
    });
    tampered.exec(`
      DROP TRIGGER qualified_checkpoint_v3_stage_child_event_folds_no_update;
      UPDATE ${QUALIFIED_CHECKPOINT_STAGE_CHILD_EVENT_FOLDS_TABLE}
      SET fingerprint = '${H64_C}'
      WHERE event_position = (
        SELECT max(event_position)
        FROM ${QUALIFIED_CHECKPOINT_STAGE_CHILD_EVENT_FOLDS_TABLE}
      );
      CREATE TEMP TRIGGER
      qualified_checkpoint_v3_stage_child_event_folds_no_update
      BEFORE UPDATE ON ${QUALIFIED_CHECKPOINT_STAGE_CHILD_EVENT_FOLDS_TABLE}
      BEGIN
        SELECT RAISE(ABORT, 'MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED');
      END;
    `);
    assert.throws(
      () => assertQualifiedCheckpointMigrationStage(tampered),
      /MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED/,
    );
    tampered.exec("ROLLBACK");

    const populated = sourceConnection(2);
    seedTransferredFinalHistory(populated);
    const preflight = new SqliteQualifiedCheckpointMigrationPreflight();
    new MigrationRunner().apply(populated, registry, NOW, mode({
      kind: "explicit-upgrade",
      expectedAppliedVersion: 2,
      beforeMigration(candidate: SqliteConnection, migration: { version: number }): void {
        if (migration.version === 3) {
          preflight.assertEligibleAndStage(candidate, context);
        }
      },
    }));
    assert.equal(
      populated.prepare(`
        SELECT count(*) AS count FROM lifecycle_child_event_folds
      `).get()?.count,
      4n,
    );
    assert.equal(
      populated.prepare(`
        SELECT count(*) AS count FROM lifecycle_workflow_generation_folds
      `).get()?.count,
      1n,
    );
    assert.equal(
      populated.prepare(`
        SELECT count(*) AS count FROM temp.sqlite_schema
        WHERE name GLOB 'qualified_checkpoint_v3_stage*'
      `).get()?.count,
      0n,
    );
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
      seedRootStart(connection);
      const projection = seedLegacyEndRequest(connection, 2, 2);
      rawInsert(connection, "workflow_instances", legacyLifecycleWorkflow({
        ...projection,
      }));
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
    seedRootStart(success);
    const projection = seedLegacyEndRequest(success, 2, 2);
    rawInsert(success, "workflow_instances", legacyLifecycleWorkflow({
      ...projection,
    }));
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
      const projection = seedLegacyEndRequest(connection, 2, 2);
      const finalCheckpoint = candidate.hasHistoricalFinal
        ? checkpointFixture({
            checkpointId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" as never,
            sessionId: ROOT_ID as never,
            baseEventPosition: 1,
            checkpointEventPosition: 3,
          })
        : null;
      if (finalCheckpoint !== null) {
        rawEvent(connection, 3, {
          streamType: "session",
          sessionId: ROOT_ID,
          streamVersion: 3,
          eventType: "SessionCheckpointRecorded",
          payload: {
            checkpoint: finalCheckpoint,
            baseEventPosition: "1",
            checkpointEventPosition: "3",
          },
        });
      }
      rawInsert(connection, "workflow_instances", legacyLifecycleWorkflow({
        ...projection,
        phase: candidate.phase,
        result_json: finalCheckpoint === null
          ? null
          : canonicalJson(sessionEndStatus(
              candidate.phase,
              String(finalCheckpoint.checkpointId),
              "3",
              {
                workflowId: PROJECTION_WORKFLOW_ID,
                triggeringEventPosition: "2",
              },
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
        candidate.keepsFinal ? 3n : null,
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

  it("migration 3 seals and verifies both authenticated lifecycle projection stages", () => {
    const connection = sourceConnection(2);
    connection.exec("BEGIN IMMEDIATE");
    new SqliteQualifiedCheckpointMigrationPreflight()
      .assertEligibleAndStage(connection, context);
    const marker = connection.prepare(`
      SELECT freeze_row_count, child_fold_row_count,
             workflow_generation_row_count, sealed
      FROM temp.${QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE}
    `).get();
    assert.deepEqual({ ...marker }, {
      freeze_row_count: 0n,
      child_fold_row_count: 0n,
      workflow_generation_row_count: 0n,
      sealed: 1n,
    });
    assert.equal(
      connection.prepare(`
        SELECT count(*) AS count FROM temp.sqlite_schema
        WHERE type = 'table' AND name IN (
          $childTable, $workflowTable
        )
      `).get({
        $childTable: QUALIFIED_CHECKPOINT_STAGE_CHILD_EVENT_FOLDS_TABLE,
        $workflowTable: QUALIFIED_CHECKPOINT_STAGE_WORKFLOW_GENERATION_FOLDS_TABLE,
      })?.count,
      2n,
    );
    assert.equal(
      connection.prepare(`
        SELECT count(*) AS count FROM temp.sqlite_schema
        WHERE type = 'trigger'
          AND name GLOB 'qualified_checkpoint_v3_stage_*_no_*'
      `).get()?.count,
      12n,
    );
    connection.exec("ROLLBACK");
  });

  it("migration 3 pre-copy guard covers marker identity cardinality counts and every denial trigger", () => {
    assertPreCopyMutationRejected(
      "marker cardinality",
      () => undefined,
      (connection) => mutateSealedTempTable(
        connection,
        "qualified_checkpoint_v3_stage_marker_no_insert",
        () => rawInsert(connection, QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE, {
          singleton: 2,
          project_id: PROJECT_ID,
          vault_id: VAULT_ID,
          store_id: STORE_ID,
          source_schema_version: 2,
          target_schema_version: 3,
          freeze_row_count: 0,
          child_fold_row_count: 0,
          workflow_generation_row_count: 0,
          sealed: 1,
        }),
      ),
      "forged-empty",
      ["marker"],
    );
    const markerMutations = [
      [
        "marker singleton",
        "singleton",
        2,
        "marker-and-project-identity",
      ],
      ["marker source schema", "source_schema_version", 1, "marker"],
      ["marker target schema", "target_schema_version", 2, "marker"],
      ["marker sealed state", "sealed", 0, "marker"],
      [
        "marker project identity",
        "project_id",
        "99999999-9999-4999-8999-999999999998",
        "project-identity",
      ],
      [
        "marker vault identity",
        "vault_id",
        "99999999-9999-4999-8999-999999999997",
        "project-identity",
      ],
      [
        "marker store identity",
        "store_id",
        "99999999-9999-4999-8999-999999999996",
        "project-identity",
      ],
      ["marker freeze row count", "freeze_row_count", 1, "marker"],
      ["marker child fold row count", "child_fold_row_count", 1, "marker"],
      [
        "marker workflow generation row count",
        "workflow_generation_row_count",
        1,
        "marker",
      ],
    ] as const;
    for (const candidate of markerMutations) {
      const [name, column, value, family] = candidate;
      assertPreCopyMutationRejected(
        name,
        () => undefined,
        (connection) => mutateSealedTempTable(
          connection,
          "qualified_checkpoint_v3_stage_marker_no_update",
          () => connection.prepare(`
            UPDATE ${QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE}
            SET ${column} = $value
          `).run({ $value: value }),
        ),
        "forged-empty",
        family === "marker-and-project-identity"
          ? ["marker", "project-identity"]
          : [family],
      );
    }

    assertPreCopyMutationRejected(
      "freeze-stage/source cardinality",
      () => undefined,
      (connection) => {
        mutateSealedTempTable(
          connection,
          "qualified_checkpoint_v3_stage_rows_no_insert",
          () => rawInsert(connection, QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE, {
            workflow_id: PROJECTION_WORKFLOW_ID,
            source_generation: 1,
            source_phase: "requested",
            evidence_frozen_checkpoint_event_position: null,
            evidence_frozen_generation: null,
            evidence_window_state: "sealed",
            final_ending_scope_bindings_json: null,
          }),
        );
        mutateSealedTempTable(
          connection,
          "qualified_checkpoint_v3_stage_marker_no_update",
          () => connection.prepare(`
            UPDATE ${QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE}
            SET freeze_row_count = 1
          `).run(),
        );
      },
      "forged-empty",
      ["freeze"],
    );

    const denialTriggers = [
      "qualified_checkpoint_v3_stage_marker_no_insert",
      "qualified_checkpoint_v3_stage_marker_no_update",
      "qualified_checkpoint_v3_stage_marker_no_delete",
      "qualified_checkpoint_v3_stage_rows_no_insert",
      "qualified_checkpoint_v3_stage_rows_no_update",
      "qualified_checkpoint_v3_stage_rows_no_delete",
      "qualified_checkpoint_v3_stage_child_event_folds_no_insert",
      "qualified_checkpoint_v3_stage_child_event_folds_no_update",
      "qualified_checkpoint_v3_stage_child_event_folds_no_delete",
      "qualified_checkpoint_v3_stage_workflow_generation_folds_no_insert",
      "qualified_checkpoint_v3_stage_workflow_generation_folds_no_update",
      "qualified_checkpoint_v3_stage_workflow_generation_folds_no_delete",
    ] as const;
    for (const triggerName of denialTriggers) {
      assertPreCopyMutationRejected(
        `missing denial trigger ${triggerName}`,
        () => undefined,
        (connection) => connection.exec(`DROP TRIGGER temp.${triggerName}`),
        "forged-empty",
        ["seal"],
      );
    }
  });

  it("migration 3 unmutated shared projection fixtures pass every first-guard family", () => {
    for (const fixture of [
      {
        name: "empty legacy",
        seed(): void {
          // Empty schema-2 source is the minimal legacy baseline.
        },
      },
      {
        name: "freeze stage",
        seed: seedTransferredFinalHistory,
      },
      {
        name: "child projection",
        seed: seedAllChildProjectionEventClasses,
      },
      {
        name: "workflow projection",
        seed: seedAllWorkflowProjectionTriggerClasses,
      },
      {
        name: "amended workflow projection",
        seed: seedAmendedWorkflowProjection,
      },
    ]) {
      const connection = sourceConnection(2);
      connection.exec("PRAGMA foreign_keys = OFF");
      fixture.seed(connection);
      const preflight = new SqliteQualifiedCheckpointMigrationPreflight();
      const applied = new MigrationRunner().apply(
        connection,
        registry,
        NOW,
        mode({
          kind: "explicit-upgrade",
          expectedAppliedVersion: 2,
          beforeMigration(
            candidate: SqliteConnection,
            migration: { version: number },
          ): void {
            if (migration.version !== 3) return;
            preflight.assertEligibleAndStage(candidate, context);
            assertFirstGuardFamilyIsolation(candidate, [], fixture.name);
            assert.deepEqual(
              diagnoseChildFirstGuard(candidate),
              {
                countMatches: true,
                invalidStagePositions: [],
                unlinkedSourcePositions: [],
              },
              fixture.name,
            );
            assert.deepEqual(
              diagnoseWorkflowFirstGuard(candidate),
              {
                groupingCountMatches: true,
                invalidStageGenerations: [],
                uncoveredInstanceGenerations: [],
                uncoveredLatestGenerations: [],
              },
              fixture.name,
            );
          },
        }),
      );
      assert.deepEqual(applied, [3], fixture.name);
      assert.equal(schemaVersion(connection), 3, fixture.name);
    }
  });

  it("migration 3 pre-copy guard covers every freeze-stage source and sealed-field predicate", () => {
    const stageMutations = [
      ["workflow identity", "workflow_id",
        "99999999-9999-4999-8999-999999999995"],
      ["source generation", "source_generation", 99],
      ["source phase", "source_phase", "requested"],
      ["sealed evidence window", "evidence_window_state", "open"],
      ["bindings JSON validity", "final_ending_scope_bindings_json", "{"],
      ["bindings JSON array shape", "final_ending_scope_bindings_json", "{}"],
      ["bindings JSON canonical form", "final_ending_scope_bindings_json", "[ ]"],
    ] as const;
    for (const [name, column, value] of stageMutations) {
      assertPreCopyMutationRejected(
        name,
        (connection) => seedTransferredFinalHistory(connection),
        (connection) => mutateSealedTempTable(
          connection,
          "qualified_checkpoint_v3_stage_rows_no_update",
          () => connection.prepare(`
            UPDATE ${QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE}
            SET ${column} = $value
          `).run({ $value: value }),
        ),
        "preflight",
        ["freeze"],
      );
    }
    for (const [name, overrides] of [
      [
        "frozen checkpoint null parity",
        { evidence_frozen_checkpoint_event_position: null },
      ],
      [
        "frozen generation null parity",
        { evidence_frozen_generation: null },
      ],
      [
        "bindings null parity",
        { final_ending_scope_bindings_json: null },
      ],
    ] as const) {
      assertPreCopyMutationRejected(
        name,
        (connection) => seedTransferredFinalHistory(connection),
        (connection) => replaceFreezeStageRowsUnchecked(
          connection,
          overrides,
        ),
        "preflight",
        ["freeze"],
      );
    }
    assertPreCopyMutationRejected(
      "bindings JSON byte bound",
      (connection) => seedTransferredFinalHistory(connection),
      (connection) => mutateSealedTempTable(
        connection,
        "qualified_checkpoint_v3_stage_rows_no_update",
        () => connection.prepare(`
          UPDATE ${QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE}
          SET final_ending_scope_bindings_json = $value
        `).run({ $value: `["${"x".repeat(262_145)}"]` }),
      ),
      "preflight",
      ["freeze"],
    );
    assertPreCopyMutationRejected(
      "workflow source without freeze stage",
      (connection) => seedTransferredFinalHistory(connection),
      (connection) => {
        mutateSealedTempTable(
          connection,
          "qualified_checkpoint_v3_stage_rows_no_delete",
          () => connection.exec(
            `DELETE FROM ${QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE}`,
          ),
        );
        mutateSealedTempTable(
          connection,
          "qualified_checkpoint_v3_stage_marker_no_update",
          () => connection.exec(`
            UPDATE ${QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE}
            SET freeze_row_count = 0
          `),
        );
      },
      "preflight",
      ["freeze"],
    );
  });

  it("migration 3 pre-copy guard covers every legacy-source eligibility predicate class", () => {
    for (const candidate of [
      {
        name: "project metadata cardinality",
        seed(): void {
          // Empty schema-2 source is otherwise eligible.
        },
        mutate(connection: SqliteConnection): void {
          connection.exec("DROP TRIGGER project_meta_no_delete");
          connection.exec("DELETE FROM project_meta");
        },
      },
      {
        name: "preexisting evidence coverage",
        seed(): void {
          // Empty schema-2 source is otherwise eligible.
        },
        mutate(connection: SqliteConnection): void {
          const row = coverageRow();
          delete row.coverage_fingerprint_algorithm;
          delete row.coverage_fingerprint_schema_version;
          delete row.coverage_fingerprint_key_id;
          delete row.coverage_fingerprint_domain;
          delete row.coverage_fingerprint_value;
          rawInsert(connection, "session_evidence_coverage", row);
        },
      },
      {
        name: "preexisting evidence fingerprints",
        seed(): void {
          // Empty schema-2 source is otherwise eligible.
        },
        mutate(connection: SqliteConnection): void {
          rawInsert(
            connection,
            "session_evidence_fingerprints",
            evidenceFingerprintRow(),
          );
        },
      },
      {
        name: "legacy event schema version",
        seed(connection: SqliteConnection): void {
          seedAllWorkflowProjectionTriggerClasses(connection);
        },
        mutate(connection: SqliteConnection): void {
          connection.exec("DROP TRIGGER events_no_update");
          connection.exec(`
            UPDATE events SET event_schema_version = 2
            WHERE global_position = 2
          `);
        },
      },
      {
        name: "legacy checkpoint coverage shape",
        seed(connection: SqliteConnection): void {
          seedAllChildProjectionEventClasses(connection);
        },
        mutate(connection: SqliteConnection): void {
          const source = connection.prepare(`
            SELECT payload_json FROM events WHERE global_position = 11
          `).get();
          const payload = JSON.parse(String(source?.payload_json)) as {
            checkpoint: {
              checkpointVersion: number;
              evidenceCoverage: {
                highestContiguousOrdinal: string | null;
              };
            };
          };
          payload.checkpoint.checkpointVersion = 2;
          payload.checkpoint.evidenceCoverage.highestContiguousOrdinal = "0";
          connection.exec("DROP TRIGGER events_no_update");
          connection.prepare(`
            UPDATE events SET payload_json = $payload
            WHERE global_position = 11
          `).run({ $payload: canonicalJson(payload as never) });
        },
      },
      {
        name: "legacy request version marker",
        seed(connection: SqliteConnection): void {
          seedAllWorkflowProjectionTriggerClasses(connection);
        },
        mutate(connection: SqliteConnection): void {
          const source = connection.prepare(`
            SELECT payload_json FROM events WHERE global_position = 2
          `).get();
          const payload = JSON.parse(String(source?.payload_json)) as
            Record<string, unknown>;
          payload.requestVersion = 2;
          connection.exec("DROP TRIGGER events_no_update");
          connection.prepare(`
            UPDATE events SET payload_json = $payload
            WHERE global_position = 2
          `).run({ $payload: canonicalJson(payload as never) });
        },
      },
      {
        name: "legacy amendment version marker",
        seed(connection: SqliteConnection): void {
          seedAllWorkflowProjectionTriggerClasses(connection);
        },
        mutate(connection: SqliteConnection): void {
          const source = connection.prepare(`
            SELECT payload_json FROM events WHERE global_position = 3
          `).get();
          const payload = JSON.parse(String(source?.payload_json)) as
            Record<string, unknown>;
          payload.amendmentVersion = 2;
          connection.exec("DROP TRIGGER events_no_update");
          connection.prepare(`
            UPDATE events SET payload_json = $payload
            WHERE global_position = 3
          `).run({ $payload: canonicalJson(payload as never) });
        },
      },
    ]) {
      assertPreCopyMutationRejected(
        candidate.name,
        candidate.seed,
        candidate.mutate,
        "preflight",
        candidate.name === "project metadata cardinality"
          ? ["project-identity"]
          : ["legacy-source"],
      );
    }
  });

  it("migration 3 pre-copy guard covers every child source linkage and payload predicate class", () => {
    const sourceLinkageMutations = [
      ["target event position", "global_position", 101],
      [
        "target project identity",
        "project_id",
        "99999999-9999-4999-8999-999999999994",
      ],
      [
        "target child identity",
        "session_id",
        "99999999-9999-4999-8999-999999999993",
      ],
      [
        "target root identity",
        "parent_session_id",
        "99999999-9999-4999-8999-999999999992",
      ],
      ["target stream id", "stream_id", "session/wrong-child"],
      ["target stream type", "stream_type", "generic"],
      ["target stream version", "stream_version", 99],
      ["target supported type", "event_type", "GenericRecorded"],
    ] as const;
    for (const [name, column, value] of sourceLinkageMutations) {
      const sourceStillQualifies =
        column !== "stream_type" && column !== "event_type";
      const stagedCoverageKeyChanged = [
        "global_position",
        "project_id",
        "session_id",
        "stream_version",
      ].includes(column);
      const sourcePosition = column === "global_position" ? 101n : 1n;
      assertPreCopyMutationRejected(
        `child ${name}`,
        (connection) => {
          seedAllChildProjectionEventClasses(connection);
        },
        (connection) => {
          connection.exec("DROP TRIGGER events_no_update");
          connection.prepare(`
            UPDATE events SET ${column} = $value
            WHERE global_position = 1
          `).run({ $value: value });
        },
        "preflight",
        ["child-projection"],
        expectChildFirstGuardDiagnostic({
          countMatches: sourceStillQualifies,
          invalidStagePositions: [1n],
          unlinkedSourcePositions: sourceStillQualifies
              && stagedCoverageKeyChanged
            ? [sourcePosition]
            : [],
        }, name),
      );
    }

    const stageLinkageMutations = [
      ["genesis previous fingerprint", 1, "previous_fingerprint", H64],
      ["non-genesis previous fingerprint", 2, "previous_fingerprint", H64_C],
      ["non-genesis stream adjacency", 2, "stream_version", 99],
      [
        "checkpoint id linkage",
        12,
        "latest_checkpoint_id",
        "99999999-9999-4999-8999-999999999991",
      ],
      ["checkpoint event linkage", 12, "latest_checkpoint_event_position", 10],
      ["terminal event linkage", 25, "terminal_event_position", 24],
      [
        "reported report id linkage",
        21,
        "reported_report_id",
        "99999999-9999-4999-8999-999999999990",
      ],
      ["reported item count linkage", 21, "reported_item_count", 199],
      [
        "latest report witness linkage",
        22,
        "latest_report_id",
        "99999999-9999-4999-8999-999999999989",
      ],
      [
        "completion report witness linkage",
        22,
        "completion_report_id",
        "99999999-9999-4999-8999-999999999988",
      ],
    ] as const;
    for (const [name, position, column, value] of stageLinkageMutations) {
      assertPreCopyMutationRejected(
        `child ${name}`,
        (connection) => {
          seedAllChildProjectionEventClasses(connection);
        },
        (connection) => mutateSealedTempTable(
          connection,
          "qualified_checkpoint_v3_stage_child_event_folds_no_update",
          () => connection.prepare(`
            UPDATE ${QUALIFIED_CHECKPOINT_STAGE_CHILD_EVENT_FOLDS_TABLE}
            SET ${column} = $value
            WHERE event_position = $position
          `).run({ $value: value, $position: position }),
        ),
        "preflight",
        ["child-projection"],
        expectChildFirstGuardDiagnostic({
          countMatches: true,
          invalidStagePositions: position === 12
            && (
              column === "latest_checkpoint_id"
              || column === "latest_checkpoint_event_position"
            )
              ? [12n, 13n]
              : position === 21 && column === "reported_report_id"
                ? [21n, 22n, 23n, 24n, 25n]
                : position === 21 && column === "reported_item_count"
                  ? [21n, 23n]
                  : position === 22 && column === "latest_report_id"
                    ? [22n, 23n]
                    : position === 22 && column === "completion_report_id"
                      ? [22n, 23n]
                      : position === 2 && column === "stream_version"
                        ? [2n, 3n]
                      : [BigInt(position)],
          unlinkedSourcePositions:
            position === 2 && column === "stream_version" ? [2n] : [],
        }),
      );
    }
    assertPreCopyMutationRejected(
      "child terminal type linkage",
      (connection) => {
        seedAllChildProjectionEventClasses(connection);
      },
      (connection) => mutateSealedTempTable(
        connection,
        "qualified_checkpoint_v3_stage_child_event_folds_no_update",
        () => connection.exec(`
          UPDATE ${QUALIFIED_CHECKPOINT_STAGE_CHILD_EVENT_FOLDS_TABLE}
          SET child_state = 'transferred',
              terminal_event_type = 'ChildWorkTransferCreated'
          WHERE event_position = 25
        `),
      ),
      "preflight",
      ["child-projection"],
      expectChildFirstGuardDiagnostic({
        countMatches: true,
        invalidStagePositions: [25n],
        unlinkedSourcePositions: [],
      }),
    );

    const payloadClasses = [
      {
        name: "SessionForked authority commitment",
        position: 1,
        mutate(payload: Record<string, unknown>): void {
          payload.authorityCommitment = H64_B;
        },
      },
      {
        name: "SessionForked second-chain authority commitment",
        position: 10,
        mutate(payload: Record<string, unknown>): void {
          payload.authorityCommitment = H64_B;
        },
      },
      {
        name: "SessionCheckpointRecorded checkpoint identity",
        position: 11,
        mutate(payload: Record<string, unknown>): void {
          (payload.checkpoint as Record<string, unknown>).checkpointId =
            "99999999-9999-4999-8999-999999999991";
        },
      },
      {
        name: "ChildSessionSuspended checkpoint identity",
        position: 12,
        mutate(payload: Record<string, unknown>): void {
          payload.checkpointId =
            "99999999-9999-4999-8999-999999999991";
        },
      },
      {
        name: "ChildWorkTransferCreated checkpoint identity",
        position: 13,
        mutate(payload: Record<string, unknown>): void {
          payload.checkpointId =
            "99999999-9999-4999-8999-999999999991";
        },
      },
      {
        name: "SessionForked report-chain authority commitment",
        position: 20,
        mutate(payload: Record<string, unknown>): void {
          payload.authorityCommitment = H64_B;
        },
      },
      {
        name: "ChildWorkReported report identity",
        position: 21,
        mutate(payload: Record<string, unknown>): void {
          (payload.report as Record<string, unknown>).reportId =
            "99999999-9999-4999-8999-999999999990";
        },
      },
      {
        name: "ChildCompletionProposed report identity",
        position: 22,
        mutate(payload: Record<string, unknown>): void {
          payload.reportId =
            "99999999-9999-4999-8999-999999999990";
        },
      },
      {
        name: "ChildWorkDispositioned report identity",
        position: 23,
        mutate(payload: Record<string, unknown>): void {
          (payload.disposition as Record<string, unknown>).reportId =
            "99999999-9999-4999-8999-999999999990";
        },
      },
      {
        name: "ChildSessionCompleted report identity",
        position: 25,
        mutate(payload: Record<string, unknown>): void {
          payload.reportId =
            "99999999-9999-4999-8999-999999999990";
        },
      },
    ] as const;
    for (const candidate of payloadClasses) {
      assertPreCopyMutationRejected(
        `child payload class ${candidate.name}`,
        (connection) => {
          seedAllChildProjectionEventClasses(connection);
        },
        (connection) => {
          const source = connection.prepare(`
            SELECT payload_json FROM events
            WHERE global_position = $position
          `).get({ $position: candidate.position });
          const payload = JSON.parse(String(source?.payload_json)) as
            Record<string, unknown>;
          candidate.mutate(payload);
          connection.exec("DROP TRIGGER events_no_update");
          connection.prepare(`
            UPDATE events SET payload_json = $payload
            WHERE global_position = $position
          `).run({
            $payload: canonicalJson(payload as never),
            $position: candidate.position,
          });
        },
        "preflight",
        ["child-projection"],
        expectChildFirstGuardDiagnostic({
          countMatches: true,
          invalidStagePositions: candidate.position === 11
            ? [11n, 12n, 13n]
            : [BigInt(candidate.position)],
          unlinkedSourcePositions: [],
        }),
      );
    }

    assertPreCopyMutationRejected(
      "child EvidenceCoverageRecorded source denial",
      (connection) => {
        seedAllChildProjectionEventClasses(connection);
      },
      (connection) => {
        const coverage = lifecycleEvent(14, "EvidenceCoverageRecorded", {}, {
          projectId: PROJECT_ID as never,
          vaultId: VAULT_ID as never,
          storeId: STORE_ID as never,
          workspaceId: WORKSPACE_ID as never,
          sessionId: CHILD_B_ID as never,
          parentSessionId: ROOT_ID as never,
          globalPosition: 14,
          streamVersion: 5,
          authorityCommitment: H64,
        });
        rawEvent(connection, 14, {
          streamType: "session",
          sessionId: CHILD_B_ID,
          parentSessionId: ROOT_ID,
          streamVersion: 5,
          eventType: "EvidenceCoverageRecorded",
          payload: coverage.payload,
        });
      },
      "preflight",
      ["legacy-source", "child-projection"],
      expectChildFirstGuardDiagnostic({
        countMatches: false,
        invalidStagePositions: [],
        unlinkedSourcePositions: [14n],
      }),
    );

    for (const candidate of [
      {
        name: "missing staged source row",
        diagnostic: {
          countMatches: false,
          invalidStagePositions: [2n],
          unlinkedSourcePositions: [],
        },
        mutate(connection: SqliteConnection): void {
          connection.exec("DROP TRIGGER events_no_delete");
          connection.exec("DELETE FROM events WHERE global_position = 2");
        },
      },
      {
        name: "extra supported source row",
        diagnostic: {
          countMatches: false,
          invalidStagePositions: [],
          unlinkedSourcePositions: [14n],
        },
        mutate(connection: SqliteConnection): void {
          const amended = lifecycleEvent(14, "ChildAssignmentAmended", {}, {
            projectId: PROJECT_ID as never,
            vaultId: VAULT_ID as never,
            storeId: STORE_ID as never,
            workspaceId: WORKSPACE_ID as never,
            sessionId: CHILD_B_ID as never,
            parentSessionId: ROOT_ID as never,
            globalPosition: 14,
            streamVersion: 5,
            authorityCommitment: H64,
          });
          rawEvent(connection, 14, {
            streamType: "session",
            sessionId: CHILD_B_ID,
            parentSessionId: ROOT_ID,
            streamVersion: 5,
            eventType: "ChildAssignmentAmended",
            payload: amended.payload,
          });
        },
      },
      {
        name: "disposition item-set linkage",
        diagnostic: {
          countMatches: true,
          invalidStagePositions: [23n],
          unlinkedSourcePositions: [],
        },
        mutate(connection: SqliteConnection): void {
          const source = connection.prepare(`
            SELECT payload_json FROM events WHERE global_position = 23
          `).get();
          const payload = JSON.parse(String(source?.payload_json)) as {
            disposition: { allReportItemIds: string[] };
          };
          payload.disposition.allReportItemIds = [
            ...payload.disposition.allReportItemIds,
            "99999999-9999-4999-8999-999999999987",
          ];
          connection.exec("DROP TRIGGER events_no_update");
          connection.prepare(`
            UPDATE events SET payload_json = $payload
            WHERE global_position = 23
          `).run({ $payload: canonicalJson(payload as never) });
        },
      },
    ]) {
      assertPreCopyMutationRejected(
        `child ${candidate.name}`,
        (connection) => {
          seedAllChildProjectionEventClasses(connection);
        },
        candidate.mutate,
        "preflight",
        ["child-projection"],
        expectChildFirstGuardDiagnostic(candidate.diagnostic),
      );
    }
  });

  it("migration 3 child guard isolates every supported carry and transition leaf", () => {
    const branches = [
      { name: "assignment", position: 2, nextState: "suspended" },
      { name: "claim", position: 3, nextState: "suspended" },
      { name: "checkpoint", position: 11, nextState: "suspended" },
      { name: "suspension", position: 12, nextState: "active" },
      { name: "transfer", position: 13, nextState: "suspended" },
      { name: "report", position: 21, nextState: "suspended" },
      { name: "proposal", position: 22, nextState: "active" },
      { name: "disposition", position: 23, nextState: "completion-proposed" },
      { name: "completion", position: 25, nextState: "active" },
    ] as const;
    const branchChild = (position: number): string =>
      position < 10 ? CHILD_ID : position < 20 ? CHILD_B_ID : CHILD_C_ID;
    const seedThrough = (
      connection: SqliteConnection,
      position: number,
    ): void => {
      seedAllChildProjectionEventClasses(connection);
      connection.exec("DROP TRIGGER events_no_delete");
      connection.prepare(`
        DELETE FROM events
        WHERE session_id = $session_id
          AND global_position > $position
      `).run({
        $session_id: branchChild(position),
        $position: position,
      });
    };
    const commonLeafMutations = [
      {
        name: "state transition",
        overrides(branch: typeof branches[number]) {
          return { child_state: branch.nextState };
        },
      },
      {
        name: "checkpoint id carry",
        overrides() {
          return {
            latest_checkpoint_id:
              "99999999-9999-4999-8999-999999999966",
          };
        },
      },
      {
        name: "checkpoint event-position carry",
        overrides() {
          return { latest_checkpoint_event_position: 999 };
        },
      },
      {
        name: "terminal type carry",
        overrides(branch: typeof branches[number]) {
          return {
            terminal_event_type: branch.position === 25
              ? "ChildWorkTransferCreated"
              : "ChildSessionCompleted",
          };
        },
      },
      {
        name: "terminal event-position carry",
        overrides(branch: typeof branches[number]) {
          return {
            terminal_event_position: branch.position - 1,
          };
        },
      },
      {
        name: "completion report carry",
        overrides() {
          return {
            completion_report_id:
              "99999999-9999-4999-8999-999999999965",
          };
        },
      },
      {
        name: "authority carry or override",
        overrides() {
          return { authority_commitment: H64_B };
        },
      },
      {
        name: "report-count carry or advance",
        overrides(
          branch: typeof branches[number],
          row: Readonly<Record<string, SqliteValue>>,
        ) {
          return { report_count: diagnosticBigInt(row.report_count) + 1n };
        },
      },
      {
        name: "latest-report carry or advance",
        overrides() {
          return {
            latest_report_id:
              "99999999-9999-4999-8999-999999999964",
          };
        },
      },
      {
        name: "report-index carry or advance",
        overrides(
          branch: typeof branches[number],
          row: Readonly<Record<string, SqliteValue>>,
          connection: SqliteConnection,
        ) {
          if (branch.position !== 21) {
            return {
              report_index_fingerprint: row.report_index_fingerprint === H64_B
                ? H64_C
                : H64_B,
            };
          }
          const predecessor = connection.prepare(`
            SELECT report_index_fingerprint
            FROM ${QUALIFIED_CHECKPOINT_STAGE_CHILD_EVENT_FOLDS_TABLE}
            WHERE event_position = 20
          `).get();
          return {
            report_index_fingerprint:
              String(predecessor?.report_index_fingerprint),
          };
        },
      },
    ] as const;

    for (const branch of branches) {
      for (const leaf of commonLeafMutations) {
        const caseName = `child ${branch.name} ${leaf.name}`;
        assertPreCopyMutationRejected(
          caseName,
          (connection) => seedThrough(connection, branch.position),
          (connection) => {
            const row = connection.prepare(`
              SELECT *
              FROM ${QUALIFIED_CHECKPOINT_STAGE_CHILD_EVENT_FOLDS_TABLE}
              WHERE event_position = $position
            `).get({ $position: branch.position }) as
              Readonly<Record<string, SqliteValue>>;
            replaceProjectionStageRowUnchecked(
              connection,
              QUALIFIED_CHECKPOINT_STAGE_CHILD_EVENT_FOLDS_TABLE,
              "event_position",
              branch.position,
              leaf.overrides(branch, row, connection),
            );
          },
          "preflight",
          ["child-projection"],
          expectChildFirstGuardDiagnostic({
            countMatches: true,
            invalidStagePositions: [BigInt(branch.position)],
            unlinkedSourcePositions: [],
          }, caseName),
        );
      }
    }
  });

  it("migration 3 pre-copy guard covers every workflow source intent lineage and trigger predicate class", () => {
    const triggerSourceMutations = [
      ["trigger event position", 6, "global_position", 101],
      [
        "trigger project identity",
        2,
        "project_id",
        "99999999-9999-4999-8999-999999999986",
      ],
      [
        "trigger session identity",
        6,
        "session_id",
        "99999999-9999-4999-8999-999999999985",
      ],
      ["trigger parent identity", 6, "parent_session_id", CHILD_ID],
      ["trigger stream id", 6, "stream_id", "session/wrong-root"],
      ["trigger stream type", 6, "stream_type", "generic"],
      [
        "trigger command identity",
        6,
        "command_id",
        "99999999-9999-4999-8999-999999999984",
      ],
      ["trigger supported type", 6, "event_type", "GenericRecorded"],
    ] as const;
    for (const [name, position, column, value] of triggerSourceMutations) {
      assertPreCopyMutationRejected(
        `workflow ${name}`,
        (connection) => {
          seedAllWorkflowProjectionTriggerClasses(connection);
        },
        (connection) => {
          connection.exec("DROP TRIGGER events_no_update");
          connection.prepare(`
            UPDATE events SET ${column} = $value
            WHERE global_position = $position
          `).run({ $value: value, $position: position });
        },
        "preflight",
        ["workflow-projection"],
        expectWorkflowFirstGuardDiagnostic({
          groupingCountMatches: true,
          invalidStageGenerations: position === 2 ? [1n, 2n] : [3n],
          uncoveredInstanceGenerations: [],
          uncoveredLatestGenerations: [],
        }),
      );
    }
    const effectiveSourceMutations = [
      ["source event position", 5, "global_position", 105],
      [
        "source project identity",
        2,
        "project_id",
        "99999999-9999-4999-8999-999999999973",
      ],
      [
        "source session identity",
        5,
        "session_id",
        "99999999-9999-4999-8999-999999999972",
      ],
      ["source parent identity", 5, "parent_session_id", CHILD_ID],
      ["source stream id", 5, "stream_id", "session/wrong-source-root"],
      ["source stream type", 5, "stream_type", "generic"],
      [
        "source command identity",
        5,
        "command_id",
        "99999999-9999-4999-8999-999999999971",
      ],
      ["source command-event-0 linkage", 5, "command_event_index", 1],
      ["source supported type", 5, "event_type", "GenericRecorded"],
      ["source intent presence", 5, "lifecycle_intent_json", null],
    ] as const;
    for (const [name, position, column, value] of effectiveSourceMutations) {
      assertPreCopyMutationRejected(
        `workflow ${name}`,
        (connection) => {
          seedAllWorkflowProjectionTriggerClasses(connection);
        },
        (connection) => {
          connection.exec("DROP TRIGGER events_no_update");
          connection.prepare(`
            UPDATE events SET ${column} = $value
            WHERE global_position = $position
          `).run({ $value: value, $position: position });
        },
        "preflight",
        ["workflow-projection"],
        expectWorkflowFirstGuardDiagnostic({
          groupingCountMatches: true,
          invalidStageGenerations: position === 2 ? [1n, 2n] : [3n],
          uncoveredInstanceGenerations: [],
          uncoveredLatestGenerations: [],
        }),
      );
    }

    const stageLineageMutations = [
      [
        "stage project identity",
        3,
        "project_id",
        "99999999-9999-4999-8999-999999999983",
      ],
      [
        "stage workflow identity",
        3,
        "workflow_id",
        "99999999-9999-4999-8999-999999999982",
      ],
      [
        "stage session identity",
        3,
        "session_id",
        "99999999-9999-4999-8999-999999999981",
      ],
      [
        "stage root command linkage",
        3,
        "root_command_id",
        "99999999-9999-4999-8999-999999999980",
      ],
      ["genesis predecessor fingerprint", 1, "previous_fingerprint", H64],
      ["non-genesis predecessor fingerprint", 2, "previous_fingerprint", H64_C],
      ["generation adjacency", 3, "workflow_generation", 4],
      ["effective checkpoint lineage", 3, "effective_checkpoint_version", 2],
      [
        "effective draft source linkage",
        3,
        "effective_draft_source_event_position",
        1,
      ],
    ] as const;
    for (const [name, generation, column, value] of stageLineageMutations) {
      const changedGeneration = column === "workflow_generation"
        ? BigInt(value)
        : BigInt(generation);
      const identityBreaksInstance = [
        "workflow_id",
        "session_id",
        "root_command_id",
        "workflow_generation",
      ].includes(column);
      assertPreCopyMutationRejected(
        `workflow ${name}`,
        (connection) => {
          seedAllWorkflowProjectionTriggerClasses(connection);
        },
        (connection) => mutateSealedTempTable(
          connection,
          "qualified_checkpoint_v3_stage_workflow_generation_folds_no_update",
          () => connection.prepare(`
            UPDATE ${QUALIFIED_CHECKPOINT_STAGE_WORKFLOW_GENERATION_FOLDS_TABLE}
            SET ${column} = $value
            WHERE workflow_generation = $generation
          `).run({ $value: value, $generation: generation }),
        ),
        "preflight",
        ["workflow-projection"],
        expectWorkflowFirstGuardDiagnostic({
          groupingCountMatches: true,
          invalidStageGenerations: [changedGeneration],
          uncoveredInstanceGenerations: identityBreaksInstance ? [3n] : [],
          uncoveredLatestGenerations: column === "project_id"
            ? [2n]
            : column === "workflow_id"
              ? [2n, 3n]
            : identityBreaksInstance
              ? [changedGeneration]
              : [],
        }),
      );
    }
    assertPreCopyMutationRejected(
      "workflow stage trigger event linkage and adjacency",
      (connection) => {
        seedAllWorkflowProjectionTriggerClasses(connection);
      },
      (connection) => mutateSealedTempTable(
        connection,
        "qualified_checkpoint_v3_stage_workflow_generation_folds_no_update",
        () => connection.exec(`
          UPDATE ${QUALIFIED_CHECKPOINT_STAGE_WORKFLOW_GENERATION_FOLDS_TABLE}
          SET trigger_event_position = 3,
              effective_draft_source_event_position = 3
          WHERE workflow_generation = 3
        `),
      ),
      "preflight",
      ["workflow-projection"],
      expectWorkflowFirstGuardDiagnostic({
        groupingCountMatches: true,
        invalidStageGenerations: [3n],
        uncoveredInstanceGenerations: [3n],
        uncoveredLatestGenerations: [3n],
      }),
    );

    const intentMutations = [
      {
        name: "command-event-0 linkage",
        mutate(intent: Record<string, unknown>): Record<string, unknown> {
          return intent;
        },
        column: "command_event_index",
        value: 1,
      },
      {
        name: "intent presence",
        mutate(intent: Record<string, unknown>): Record<string, unknown> {
          return intent;
        },
        column: "lifecycle_intent_json",
        value: null,
      },
      {
        name: "intent command identity",
        mutate(intent: Record<string, unknown>): Record<string, unknown> {
          const command = (intent.intent as { command: Record<string, unknown> })
            .command;
          command.commandId =
            "99999999-9999-4999-8999-999999999979";
          return intent;
        },
      },
      {
        name: "intent command type",
        mutate(intent: Record<string, unknown>): Record<string, unknown> {
          const command = (intent.intent as { command: Record<string, unknown> })
            .command;
          command.commandType = "request-session-end";
          return intent;
        },
      },
      {
        name: "intent session linkage",
        mutate(intent: Record<string, unknown>): Record<string, unknown> {
          const command = (intent.intent as { command: Record<string, unknown> })
            .command;
          command.sessionId =
            "99999999-9999-4999-8999-999999999978";
          return intent;
        },
      },
      {
        name: "abandon checkpoint payload parity",
        mutate(intent: Record<string, unknown>): Record<string, unknown> {
          const command = (intent.intent as { command: Record<string, unknown> })
            .command;
          command.preTransitionCheckpointId =
            "99999999-9999-4999-8999-999999999977";
          return intent;
        },
      },
      {
        name: "abandon reason payload parity",
        mutate(intent: Record<string, unknown>): Record<string, unknown> {
          const command = (intent.intent as { command: Record<string, unknown> })
            .command;
          command.reasonCode = "operator-emergency";
          return intent;
        },
      },
    ] as const;
    for (const candidate of intentMutations) {
      assertPreCopyMutationRejected(
        `workflow ${candidate.name}`,
        (connection) => {
          seedAllWorkflowProjectionTriggerClasses(connection);
        },
        (connection) => {
          const source = connection.prepare(`
            SELECT lifecycle_intent_json FROM events
            WHERE global_position = 6
          `).get();
          const intent = JSON.parse(String(source?.lifecycle_intent_json)) as
            Record<string, unknown>;
          const value = "column" in candidate
            ? candidate.value
            : canonicalJson(candidate.mutate(intent) as never);
          const column = "column" in candidate
            ? candidate.column
            : "lifecycle_intent_json";
          connection.exec("DROP TRIGGER events_no_update");
          connection.prepare(`
            UPDATE events SET ${column} = $value
            WHERE global_position = 6
          `).run({ $value: value });
        },
        "preflight",
        ["workflow-projection"],
        expectWorkflowFirstGuardDiagnostic({
          groupingCountMatches: true,
          invalidStageGenerations: [3n],
          uncoveredInstanceGenerations: [],
          uncoveredLatestGenerations: [],
        }),
      );
    }

    const payloadClasses = [
      {
        name: "SessionEndRequested generation-one workflow identity",
        position: 2,
        invalidGenerations: [1, 2],
        groupingCountMatches: true,
        mutate(payload: Record<string, unknown>): void {
          payload.workflowId =
            "99999999-9999-4999-8999-999999999976";
        },
      },
      {
        name: "SessionEndAmended predecessor generation",
        position: 3,
        invalidGenerations: [2],
        groupingCountMatches: true,
        seed: seedAmendedWorkflowProjection,
        mutate(payload: Record<string, unknown>): void {
          payload.previousWorkflowGeneration = 99;
        },
      },
      {
        name: "SessionEndCancelled checkpoint parity",
        position: 4,
        invalidGenerations: [2],
        groupingCountMatches: true,
        mutate(payload: Record<string, unknown>): void {
          payload.preTransitionCheckpointId =
            "99999999-9999-4999-8999-999999999975";
        },
      },
      {
        name: "SessionAbandoned checkpoint parity",
        position: 6,
        invalidGenerations: [3],
        groupingCountMatches: true,
        mutate(payload: Record<string, unknown>): void {
          payload.preTransitionCheckpointId =
            "99999999-9999-4999-8999-999999999973";
        },
      },
    ] as const;
    for (const candidate of payloadClasses) {
      assertPreCopyMutationRejected(
        `workflow payload class ${candidate.name}`,
        (connection) => {
          if ("seed" in candidate) {
            candidate.seed(connection);
          } else {
            seedAllWorkflowProjectionTriggerClasses(connection);
          }
        },
        (connection) => {
          const source = connection.prepare(`
            SELECT payload_json FROM events
            WHERE global_position = $position
          `).get({ $position: candidate.position });
          const payload = JSON.parse(String(source?.payload_json)) as
            Record<string, unknown>;
          candidate.mutate(payload);
          connection.exec("DROP TRIGGER events_no_update");
          connection.prepare(`
            UPDATE events SET payload_json = $payload
            WHERE global_position = $position
          `).run({
            $payload: canonicalJson(payload as never),
            $position: candidate.position,
          });
        },
        "preflight",
        ["workflow-projection"],
        expectWorkflowFirstGuardDiagnostic({
          groupingCountMatches: candidate.groupingCountMatches,
          invalidStageGenerations: candidate.invalidGenerations.map(BigInt),
          uncoveredInstanceGenerations: [],
          uncoveredLatestGenerations: [],
        }),
      );
    }

    for (const candidate of [
      {
        name: "request trigger and source workflow payload identity",
        position: 2,
        field: "workflowId",
        value: "99999999-9999-4999-8999-999999999976",
        invalidGenerations: [1n, 2n],
      },
      {
        name: "request trigger and source workflow generation payload",
        position: 2,
        field: "workflowGeneration",
        value: 99,
        invalidGenerations: [1n],
      },
    ] as const) {
      assertPreCopyMutationRejected(
        `workflow ${candidate.name}`,
        (connection) => {
          seedAllWorkflowProjectionTriggerClasses(connection);
        },
        (connection) => {
          const source = connection.prepare(`
            SELECT payload_json FROM events
            WHERE global_position = $position
          `).get({ $position: candidate.position });
          const payload = JSON.parse(String(source?.payload_json)) as
            Record<string, unknown>;
          payload[candidate.field] = candidate.value;
          connection.exec("DROP TRIGGER events_no_update");
          connection.prepare(`
            UPDATE events SET payload_json = $payload
            WHERE global_position = $position
          `).run({
            $payload: canonicalJson(payload as never),
            $position: candidate.position,
          });
        },
        "preflight",
        ["workflow-projection"],
        expectWorkflowFirstGuardDiagnostic({
          groupingCountMatches: true,
          invalidStageGenerations: candidate.invalidGenerations,
          uncoveredInstanceGenerations: [],
          uncoveredLatestGenerations: [],
        }),
      );
    }

    for (const [name, field, value] of [
      [
        "source intent command linkage",
        "commandId",
        "99999999-9999-4999-8999-999999999974",
      ],
      ["source intent command type", "commandType", "abandon-session"],
    ] as const) {
      assertPreCopyMutationRejected(
        `workflow ${name}`,
        (connection) => {
          seedAllWorkflowProjectionTriggerClasses(connection);
        },
        (connection) => {
          const source = connection.prepare(`
            SELECT lifecycle_intent_json FROM events WHERE global_position = 5
          `).get();
          const intent = JSON.parse(String(source?.lifecycle_intent_json)) as {
            intent: { command: Record<string, unknown> };
          };
          intent.intent.command[field] = value;
          connection.exec("DROP TRIGGER events_no_update");
          connection.prepare(`
            UPDATE events SET lifecycle_intent_json = $intent
            WHERE global_position = 5
          `).run({ $intent: canonicalJson(intent as never) });
        },
        "preflight",
        ["workflow-projection"],
        expectWorkflowFirstGuardDiagnostic({
          groupingCountMatches: true,
          invalidStageGenerations: [3n],
          uncoveredInstanceGenerations: [],
          uncoveredLatestGenerations: [],
        }),
      );
    }
    for (const candidate of [
      {
        name: "request trigger intent type",
        position: 2,
        mutate(command: Record<string, unknown>): void {
          command.commandType = "amend-session-end";
        },
      },
      {
        name: "request trigger intent session",
        position: 2,
        mutate(command: Record<string, unknown>): void {
          (command.request as Record<string, unknown>).sessionId =
            "99999999-9999-4999-8999-999999999970";
        },
      },
      {
        name: "amend trigger intent type",
        position: 3,
        mutate(command: Record<string, unknown>): void {
          command.commandType = "request-session-end";
        },
      },
      {
        name: "amend trigger intent session",
        position: 3,
        mutate(command: Record<string, unknown>): void {
          command.sessionId =
            "99999999-9999-4999-8999-999999999969";
        },
      },
      {
        name: "amend trigger intent workflow",
        position: 3,
        mutate(command: Record<string, unknown>): void {
          command.workflowId =
            "99999999-9999-4999-8999-999999999968";
        },
      },
      {
        name: "request effective-source intent session",
        position: 5,
        mutate(command: Record<string, unknown>): void {
          (command.request as Record<string, unknown>).sessionId =
            "99999999-9999-4999-8999-999999999967";
        },
      },
    ] as const) {
      assertPreCopyMutationRejected(
        `workflow ${candidate.name}`,
        (connection) => {
          if (candidate.position === 3) {
            seedAmendedWorkflowProjection(connection);
          } else {
            seedAllWorkflowProjectionTriggerClasses(connection);
          }
        },
        (connection) => {
          const source = connection.prepare(`
            SELECT lifecycle_intent_json FROM events
            WHERE global_position = $position
          `).get({ $position: candidate.position });
          const intent = JSON.parse(String(source?.lifecycle_intent_json)) as {
            intent: { command: Record<string, unknown> };
          };
          candidate.mutate(intent.intent.command);
          connection.exec("DROP TRIGGER events_no_update");
          connection.prepare(`
            UPDATE events SET lifecycle_intent_json = $intent
            WHERE global_position = $position
          `).run({
            $intent: canonicalJson(intent as never),
            $position: candidate.position,
          });
        },
        "preflight",
        ["workflow-projection"],
        expectWorkflowFirstGuardDiagnostic({
          groupingCountMatches: true,
          invalidStageGenerations: candidate.position === 2
            ? [1n, 2n]
            : [BigInt(candidate.position === 3 ? 2 : 3)],
          uncoveredInstanceGenerations: [],
          uncoveredLatestGenerations: [],
        }),
      );
    }
    assertPreCopyMutationRejected(
      "workflow extra supported trigger source",
      (connection) => {
        seedAllWorkflowProjectionTriggerClasses(connection);
      },
      (connection) => rawEvent(connection, 7, {
        streamType: "session",
        sessionId: ROOT_ID,
        streamVersion: 7,
        eventType: "SessionEndRequested",
        commandId: eventCommandId(7),
        lifecycleIntent: requestIntentWitness(eventCommandId(7)),
        payload: {
          workflowId: PROJECTION_WORKFLOW_ID,
          workflowGeneration: 4,
          previousState: "active",
          childEndPolicy: "require-completed",
          qualityThreshold: 0,
          requireFullEvidence: false,
          requireMaterialization: false,
        },
      }),
      "preflight",
      ["workflow-projection"],
      expectWorkflowFirstGuardDiagnostic({
        groupingCountMatches: false,
        invalidStageGenerations: [],
        uncoveredInstanceGenerations: [],
        uncoveredLatestGenerations: [],
      }),
    );
  });

  it("migration 3 workflow guard isolates every transition carry and intent leaf", () => {
    const branches = [
      {
        name: "initial request",
        position: 2,
        generation: 1,
        phase: "requested",
        state: "active",
      },
      {
        name: "amendment",
        position: 3,
        generation: 2,
        phase: "requested",
        state: "active",
      },
      {
        name: "cancellation",
        position: 4,
        generation: 2,
        phase: "cancelled",
        state: "completed",
      },
      {
        name: "reopen request",
        position: 5,
        generation: 3,
        phase: "requested",
        state: "active",
      },
      {
        name: "abandonment",
        position: 6,
        generation: 3,
        phase: "abandoned",
        state: "completed",
      },
    ] as const;
    const seedBranch = (
      connection: SqliteConnection,
      branch: typeof branches[number],
    ): void => {
      if (branch.name === "amendment") {
        seedAmendedWorkflowProjection(connection);
      } else {
        seedAllWorkflowProjectionTriggerClasses(connection);
        if (branch.position < 6) {
          connection.exec("DROP TRIGGER events_no_delete");
          connection.prepare(`
            DELETE FROM events WHERE global_position > $position
          `).run({ $position: branch.position });
        }
        connection.exec("DELETE FROM workflow_instances");
        rawInsert(connection, "workflow_instances", legacyLifecycleWorkflow({
          workflow_id: PROJECTION_WORKFLOW_ID,
          generation: branch.generation,
          state: branch.state,
          phase: branch.phase,
          root_command_id: eventCommandId(branch.position),
          session_id: ROOT_ID,
          triggering_event_position: branch.position,
        }));
      }
    };
    const stageLeaves = [
      {
        name: "replacement checkpoint version",
        overrides(row: Readonly<Record<string, SqliteValue>>) {
          return {
            replacement_checkpoint_version:
              row.replacement_checkpoint_version === null ? 2 : null,
          };
        },
      },
      {
        name: "effective checkpoint version",
        overrides(row: Readonly<Record<string, SqliteValue>>) {
          return {
            effective_checkpoint_version:
              diagnosticBigInt(row.effective_checkpoint_version) === 1n
                ? 2
                : 1,
          };
        },
      },
      {
        name: "evidence-window state",
        overrides(row: Readonly<Record<string, SqliteValue>>) {
          return {
            evidence_window_state:
              row.evidence_window_state === "sealed" ? "open" : "sealed",
          };
        },
      },
      {
        name: "effective source or carry",
        overrides() {
          return { effective_draft_source_event_position: 1 };
        },
      },
    ] as const;
    for (const branch of branches) {
      for (const leaf of stageLeaves) {
        const caseName = `workflow ${branch.name} ${leaf.name}`;
        assertPreCopyMutationRejected(
          caseName,
          (connection) => seedBranch(connection, branch),
          (connection) => {
            const row = connection.prepare(`
              SELECT *
              FROM ${QUALIFIED_CHECKPOINT_STAGE_WORKFLOW_GENERATION_FOLDS_TABLE}
              WHERE workflow_generation = $generation
            `).get({ $generation: branch.generation }) as
              Readonly<Record<string, SqliteValue>>;
            replaceProjectionStageRowUnchecked(
              connection,
              QUALIFIED_CHECKPOINT_STAGE_WORKFLOW_GENERATION_FOLDS_TABLE,
              "workflow_generation",
              branch.generation,
              leaf.overrides(row),
            );
          },
          "preflight",
          ["workflow-projection"],
          expectWorkflowFirstGuardDiagnostic({
            groupingCountMatches: true,
            invalidStageGenerations: [BigInt(branch.generation)],
            uncoveredInstanceGenerations: [],
            uncoveredLatestGenerations: [],
          }, caseName),
        );
      }
    }

    for (const [name, field, value] of [
      ["command type", "commandType", "abandon-session"],
      [
        "session identity",
        "sessionId",
        "99999999-9999-4999-8999-999999999963",
      ],
      [
        "workflow identity",
        "workflowId",
        "99999999-9999-4999-8999-999999999962",
      ],
      [
        "checkpoint identity",
        "preTransitionCheckpointId",
        "99999999-9999-4999-8999-999999999961",
      ],
    ] as const) {
      const caseName = `workflow isolated cancel intent ${name}`;
      assertPreCopyMutationRejected(
        caseName,
        (connection) => seedBranch(connection, branches[2]),
        (connection) => {
          const source = connection.prepare(`
            SELECT lifecycle_intent_json FROM events
            WHERE global_position = 4
          `).get();
          const intent = JSON.parse(String(source?.lifecycle_intent_json)) as {
            intent: { command: Record<string, unknown> };
          };
          intent.intent.command[field] = value;
          connection.exec("DROP TRIGGER events_no_update");
          connection.prepare(`
            UPDATE events SET lifecycle_intent_json = $intent
            WHERE global_position = 4
          `).run({ $intent: canonicalJson(intent as never) });
        },
        "preflight",
        ["workflow-projection"],
        expectWorkflowFirstGuardDiagnostic({
          groupingCountMatches: true,
          invalidStageGenerations: [2n],
          uncoveredInstanceGenerations: [],
          uncoveredLatestGenerations: [],
        }, caseName),
      );
    }

    assertPreCopyMutationRejected(
      "workflow later same-generation last-semantic-event",
      (connection) => seedAllWorkflowProjectionTriggerClasses(connection),
      (connection) => rawEvent(connection, 7, {
        streamType: "session",
        sessionId: ROOT_ID,
        streamVersion: 7,
        eventType: "SessionAbandoned",
        commandId: eventCommandId(7),
        lifecycleIntent: abandonIntentWitness(
          eventCommandId(7),
          "6",
          "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          "explicit-user-approval",
        ),
        payload: {
          workflowId: PROJECTION_WORKFLOW_ID,
          workflowGeneration: 3,
          approvalId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          preTransitionCheckpointId:
            "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          reasonCode: "explicit-user-approval",
          authorityCommitment: H64,
        },
      }),
      "preflight",
      ["workflow-projection"],
      expectWorkflowFirstGuardDiagnostic({
        groupingCountMatches: true,
        invalidStageGenerations: [3n],
        uncoveredInstanceGenerations: [],
        uncoveredLatestGenerations: [],
      }, "workflow later same-generation last-semantic-event"),
    );

    assertPreCopyMutationRejected(
      "workflow exact cancelled-predecessor provenance",
      (connection) => seedBranch(connection, branches[3]),
      (connection) => replaceProjectionStageRowUnchecked(
        connection,
        QUALIFIED_CHECKPOINT_STAGE_WORKFLOW_GENERATION_FOLDS_TABLE,
        "workflow_generation",
        2,
        { trigger_event_position: 3 },
      ),
      "preflight",
      ["workflow-projection"],
      expectWorkflowFirstGuardDiagnostic({
        groupingCountMatches: true,
        invalidStageGenerations: [2n, 3n],
        uncoveredInstanceGenerations: [],
        uncoveredLatestGenerations: [],
      }, "workflow exact cancelled-predecessor provenance"),
    );
  });

  it("migration 3 pre-copy guard rejects any invalid sealed projection stage", () => {
    const sql = qualifiedCheckpointCoverageMigration.sql;
    const firstGuard = sql.indexOf(
      "INSERT INTO qualified_checkpoint_v3_guard(value)",
    );
    const firstGuardEnd = sql.indexOf(
      "THEN 1 ELSE 0 END;",
      firstGuard,
    );
    const firstPersistentCopy = sql.indexOf(
      "INSERT INTO lifecycle_child_event_folds",
    );
    assert.ok(
      firstGuard >= 0
      && firstGuardEnd > firstGuard
      && firstPersistentCopy > firstGuardEnd,
    );
    const preCopy = sql.slice(firstGuard, firstGuardEnd);
    assert.match(preCopy, /child_fold_row_count/);
    assert.match(preCopy, /workflow_generation_row_count/);
    assert.match(preCopy, /qualified_checkpoint_v3_stage_child_event_folds/);
    assert.match(preCopy, /qualified_checkpoint_v3_stage_workflow_generation_folds/);
    assert.doesNotMatch(preCopy, /FROM lifecycle_child_event_folds/);
    assert.doesNotMatch(preCopy, /FROM lifecycle_workflow_generation_folds/);

    const forgedSource = sourceConnection(2);
    forgedSource.exec("PRAGMA foreign_keys = OFF");
    seedRootStart(forgedSource);
    const projection = seedLegacyEndRequest(forgedSource, 2, 2);
    rawInsert(forgedSource, "workflow_instances", legacyLifecycleWorkflow({
      ...projection,
    }));
    forgedSource.exec("BEGIN IMMEDIATE");
    new SqliteQualifiedCheckpointMigrationPreflight()
      .assertEligibleAndStage(forgedSource, context);
    forgedSource.exec("DROP TRIGGER events_no_update");
    forgedSource.prepare(`
      UPDATE events SET lifecycle_intent_json = $intent
      WHERE global_position = 2
    `).run({
      $intent: intentWithWrongCommandId(
        requestIntentWitness(eventCommandId(2)),
      ),
    });
    assert.throws(
      () => forgedSource.exec(qualifiedCheckpointCoverageMigration.sql),
      /MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED/,
    );
    assert.equal(
      forgedSource.prepare(`
        SELECT count(*) AS count FROM sqlite_schema
        WHERE name IN (
          'lifecycle_child_event_folds',
          'lifecycle_workflow_generation_folds'
        )
      `).get()?.count,
      0n,
    );
    forgedSource.exec("ROLLBACK");

    const missingDraftSource = sourceConnection(2);
    missingDraftSource.exec("PRAGMA foreign_keys = OFF");
    seedRootStart(missingDraftSource);
    const requestCommandId = eventCommandId(2);
    rawEvent(missingDraftSource, 2, {
      streamType: "session",
      sessionId: ROOT_ID,
      streamVersion: 2,
      eventType: "SessionEndRequested",
      commandId: requestCommandId,
      lifecycleIntent: requestIntentWitness(requestCommandId),
      payload: {
        workflowId: PROJECTION_WORKFLOW_ID,
        workflowGeneration: 1,
        previousState: "active",
        childEndPolicy: "require-completed",
        qualityThreshold: 0,
        requireFullEvidence: false,
        requireMaterialization: false,
      },
    });
    const cancelCommandId = eventCommandId(3);
    const preTransitionCheckpointId =
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    rawEvent(missingDraftSource, 3, {
      streamType: "session",
      sessionId: ROOT_ID,
      streamVersion: 3,
      eventType: "SessionEndCancelled",
      commandId: cancelCommandId,
      lifecycleIntent: cancelIntentWitness(
        cancelCommandId,
        PROJECTION_WORKFLOW_ID,
        "2",
        preTransitionCheckpointId,
      ),
      payload: {
        workflowId: PROJECTION_WORKFLOW_ID,
        workflowGeneration: 1,
        restoredState: "active",
        preTransitionCheckpointId,
      },
    });
    rawInsert(missingDraftSource, "workflow_instances", legacyLifecycleWorkflow({
      workflow_id: PROJECTION_WORKFLOW_ID,
      generation: 1,
      state: "completed",
      phase: "cancelled",
      root_command_id: cancelCommandId,
      session_id: ROOT_ID,
      triggering_event_position: 3,
    }));
    missingDraftSource.exec("BEGIN IMMEDIATE");
    new SqliteQualifiedCheckpointMigrationPreflight()
      .assertEligibleAndStage(missingDraftSource, context);
    missingDraftSource.exec("DROP TRIGGER events_no_update");
    missingDraftSource.prepare(`
      UPDATE events SET lifecycle_intent_json = NULL
      WHERE global_position = 2
    `).run();
    assert.throws(
      () => missingDraftSource.exec(qualifiedCheckpointCoverageMigration.sql),
      /MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED/,
    );
    assert.equal(
      missingDraftSource.prepare(`
        SELECT count(*) AS count FROM sqlite_schema
        WHERE name IN (
          'lifecycle_child_event_folds',
          'lifecycle_workflow_generation_folds'
        )
      `).get()?.count,
      0n,
    );
    missingDraftSource.exec("ROLLBACK");

    const forgedConsumer = sourceConnection(2);
    forgedConsumer.exec("PRAGMA foreign_keys = OFF");
    seedRootStart(forgedConsumer);
    const childFork = lifecycleEvent(1, "SessionForked", {}, {
      projectId: PROJECT_ID as never,
      vaultId: VAULT_ID as never,
      storeId: STORE_ID as never,
      workspaceId: WORKSPACE_ID as never,
      sessionId: CHILD_ID as never,
      parentSessionId: ROOT_ID as never,
      globalPosition: 2,
      streamVersion: 1,
      authorityCommitment: H64,
    });
    rawEvent(forgedConsumer, 2, {
      streamType: "session",
      sessionId: CHILD_ID,
      parentSessionId: ROOT_ID,
      streamVersion: 1,
      eventType: "SessionForked",
      payload: childFork.payload,
    });
    const childReport = lifecycleEvent(3, "ChildWorkReported", {}, {
      projectId: PROJECT_ID as never,
      vaultId: VAULT_ID as never,
      storeId: STORE_ID as never,
      workspaceId: WORKSPACE_ID as never,
      sessionId: CHILD_ID as never,
      parentSessionId: ROOT_ID as never,
      globalPosition: 3,
      streamVersion: 2,
      authorityCommitment: H64,
    });
    const {
      allReportItemIds: reportItemIds,
      ...storedReportPayload
    } = childReport.payload.report;
    rawEvent(forgedConsumer, 3, {
      streamType: "session",
      sessionId: CHILD_ID,
      parentSessionId: ROOT_ID,
      streamVersion: 2,
      eventType: "ChildWorkReported",
      payload: {
        ...childReport.payload,
        report: storedReportPayload,
      },
    });
    const reportPayload = childReport.payload.report;
    const dispositionPayload = {
      ...childDispositionFixture("accepted", reportPayload.reportId),
      acceptedItemIds: reportItemIds,
      allReportItemIds: reportItemIds,
    };
    const disposition = lifecycleEvent(4, "ChildWorkDispositioned", {
      disposition: dispositionPayload,
    }, {
      projectId: PROJECT_ID as never,
      vaultId: VAULT_ID as never,
      storeId: STORE_ID as never,
      workspaceId: WORKSPACE_ID as never,
      sessionId: CHILD_ID as never,
      parentSessionId: ROOT_ID as never,
      globalPosition: 4,
      streamVersion: 3,
      authorityCommitment: H64,
    });
    rawEvent(forgedConsumer, 4, {
      streamType: "session",
      sessionId: CHILD_ID,
      parentSessionId: ROOT_ID,
      streamVersion: 3,
      eventType: "ChildWorkDispositioned",
      payload: disposition.payload,
    });
    forgedConsumer.exec("BEGIN IMMEDIATE");
    new SqliteQualifiedCheckpointMigrationPreflight()
      .assertEligibleAndStage(forgedConsumer, context);
    const forgedDisposition = {
      ...disposition.payload,
      disposition: {
        ...disposition.payload.disposition,
        reportId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      },
    };
    forgedConsumer.exec("DROP TRIGGER events_no_update");
    forgedConsumer.prepare(`
      UPDATE events SET payload_json = $payload
      WHERE global_position = 4
    `).run({ $payload: canonicalJson(forgedDisposition as never) });
    assert.throws(
      () => forgedConsumer.exec(qualifiedCheckpointCoverageMigration.sql),
      /MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED/,
    );
    forgedConsumer.exec("ROLLBACK");
  });

  it("migration 3 post-copy guard rejects missing extra or changed projection rows", () => {
    const sql = qualifiedCheckpointCoverageMigration.sql;
    const childCopy = sql.indexOf("INSERT INTO lifecycle_child_event_folds");
    const postCopy = sql.slice(childCopy);
    assert.match(
      postCopy,
      /qualified_checkpoint_v3_stage_child_event_folds[\s\S]*EXCEPT\s+SELECT \* FROM lifecycle_child_event_folds/,
    );
    assert.match(
      postCopy,
      /lifecycle_child_event_folds[\s\S]*EXCEPT\s+SELECT \* FROM qualified_checkpoint_v3_stage_child_event_folds/,
    );
    assert.match(
      postCopy,
      /qualified_checkpoint_v3_stage_workflow_generation_folds[\s\S]*EXCEPT\s+SELECT \* FROM lifecycle_workflow_generation_folds/,
    );
    assert.match(
      postCopy,
      /lifecycle_workflow_generation_folds[\s\S]*EXCEPT\s+SELECT \* FROM qualified_checkpoint_v3_stage_workflow_generation_folds/,
    );

    const firstGuard = sql.indexOf(
      "INSERT INTO qualified_checkpoint_v3_guard(value)",
    );
    const secondGuard = sql.indexOf(
      "INSERT INTO qualified_checkpoint_v3_guard(value)",
      firstGuard + 1,
    );
    assert.ok(firstGuard >= 0 && secondGuard > firstGuard);
    const prefix = sql.slice(0, secondGuard);
    const suffix = sql.slice(secondGuard);
    const divergences = [
      {
        name: "missing child",
        sql: `
          DROP TRIGGER lifecycle_child_event_folds_no_delete;
          DELETE FROM lifecycle_child_event_folds
          WHERE event_position = (
            SELECT max(event_position) FROM lifecycle_child_event_folds
          );
        `,
      },
      {
        name: "changed child",
        sql: `
          DROP TRIGGER lifecycle_child_event_folds_no_update;
          UPDATE lifecycle_child_event_folds SET fingerprint = '${H64_C}'
          WHERE event_position = (
            SELECT max(event_position) FROM lifecycle_child_event_folds
          );
        `,
      },
      {
        name: "extra child",
        sql: `
          DROP TRIGGER lifecycle_child_event_folds_insert_guard;
          INSERT INTO lifecycle_child_event_folds
          SELECT project_id, child_session_id, event_position + 1000,
                 stream_version + 1000, root_session_id, child_state,
                 latest_checkpoint_id, latest_checkpoint_event_position,
                 authority_commitment, terminal_event_type,
                 terminal_event_position, report_count, latest_report_id,
                 report_index_fingerprint, completion_report_id,
                 reported_report_id, reported_item_count,
                 reported_item_set_fingerprint, fingerprint, '${H64_C}'
          FROM lifecycle_child_event_folds
          ORDER BY event_position DESC LIMIT 1;
        `,
      },
      {
        name: "missing workflow",
        sql: `
          DROP TRIGGER lifecycle_workflow_generation_folds_no_delete;
          DELETE FROM lifecycle_workflow_generation_folds;
        `,
      },
      {
        name: "changed workflow",
        sql: `
          DROP TRIGGER lifecycle_workflow_generation_folds_no_update;
          UPDATE lifecycle_workflow_generation_folds
          SET fingerprint = '${H64_C}';
        `,
      },
      {
        name: "extra workflow",
        sql: `
          DROP TRIGGER lifecycle_workflow_generation_folds_insert_guard;
          INSERT INTO lifecycle_workflow_generation_folds
          SELECT project_id, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
                 workflow_generation, session_id, trigger_event_position,
                 root_command_id,
                 evidence_window_state, replacement_checkpoint_version,
                 effective_checkpoint_version,
                 effective_draft_source_event_position, fingerprint, '${H64_C}'
          FROM lifecycle_workflow_generation_folds
          ORDER BY workflow_generation DESC LIMIT 1;
        `,
      },
    ] as const;
    for (const divergence of divergences) {
      const connection = sourceConnection(2);
      seedTransferredFinalHistory(connection);
      connection.exec("BEGIN IMMEDIATE");
      new SqliteQualifiedCheckpointMigrationPreflight()
        .assertEligibleAndStage(connection, context);
      connection.exec(prefix);
      connection.exec(divergence.sql);
      assert.throws(
        () => connection.exec(suffix),
        /MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED/,
        divergence.name,
      );
      connection.exec("ROLLBACK");
      assert.equal(schemaVersion(connection), 2, divergence.name);
      assert.equal(
        connection.prepare(`
          SELECT count(*) AS count FROM sqlite_schema
          WHERE name IN (
            'lifecycle_child_event_folds',
            'lifecycle_workflow_generation_folds'
          )
        `).get()?.count,
        0n,
        divergence.name,
      );
    }
  });

  it("migration 3 enforces immutable child-event projection identity and adjacency", () => {
    const connection = currentConnection();
    const table = connection.prepare(`
      SELECT sql FROM sqlite_schema
      WHERE type = 'table' AND name = 'lifecycle_child_event_folds'
    `).get();
    assert.equal(typeof table?.sql, "string");
    assert.match(String(table?.sql), /PRIMARY KEY \(project_id, child_session_id, event_position\)/);
    assert.match(String(table?.sql), /UNIQUE \(project_id, child_session_id, stream_version\)/);
    const triggers = connection.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'trigger' AND name GLOB 'lifecycle_child_event_folds_*'
      ORDER BY name
    `).all().map((row) => row.name);
    assert.deepEqual(triggers, [
      "lifecycle_child_event_folds_insert_guard",
      "lifecycle_child_event_folds_no_delete",
      "lifecycle_child_event_folds_no_update",
    ]);

    const badGenesis = currentConnection();
    seedChildForkProjectionEvent(badGenesis);
    assert.throws(
      () => rawInsert(
        badGenesis,
        "lifecycle_child_event_folds",
        childProjectionRow({ child_state: "suspended" }),
      ),
      /LIFECYCLE_CHILD_EVENT_FOLD_INVALID/,
    );

    const badCheckpointCarry = currentConnection();
    seedChildForkProjectionEvent(badCheckpointCarry);
    rawInsert(
      badCheckpointCarry,
      "lifecycle_child_event_folds",
      childProjectionRow(),
    );
    const checkpoint = checkpointFixture({
      sessionId: CHILD_ID as never,
      parentSessionId: ROOT_ID as never,
      baseEventPosition: 1,
      checkpointEventPosition: 2,
    });
    rawEvent(badCheckpointCarry, 2, {
      streamType: "session",
      sessionId: CHILD_ID,
      parentSessionId: ROOT_ID,
      streamVersion: 2,
      eventType: "SessionCheckpointRecorded",
      payload: {
        checkpoint,
        baseEventPosition: "1",
        checkpointEventPosition: "2",
      },
    });
    assert.throws(
      () => rawInsert(
        badCheckpointCarry,
        "lifecycle_child_event_folds",
        childProjectionRow({
          event_position: 2,
          stream_version: 2,
          child_state: "suspended",
          latest_checkpoint_id: checkpoint.checkpointId,
          latest_checkpoint_event_position: 2,
          previous_fingerprint: H64_B,
          fingerprint: H64_C,
        }),
      ),
      /LIFECYCLE_CHILD_EVENT_FOLD_INVALID/,
    );

    const badReportAdvance = currentConnection();
    seedChildForkProjectionEvent(badReportAdvance);
    rawInsert(
      badReportAdvance,
      "lifecycle_child_event_folds",
      childProjectionRow(),
    );
    const reportEvent = lifecycleEvent(2, "ChildWorkReported", {}, {
      projectId: PROJECT_ID as never,
      vaultId: VAULT_ID as never,
      storeId: STORE_ID as never,
      workspaceId: WORKSPACE_ID as never,
      sessionId: CHILD_ID as never,
      parentSessionId: ROOT_ID as never,
      globalPosition: 2,
      streamVersion: 2,
      authorityCommitment: H64,
    });
    rawEvent(badReportAdvance, 2, {
      streamType: "session",
      sessionId: CHILD_ID,
      parentSessionId: ROOT_ID,
      streamVersion: 2,
      eventType: "ChildWorkReported",
      payload: reportEvent.payload,
    });
    const report = reportEvent.payload.report;
    const reportedItemCount = [
      report.findings,
      report.proposedDecisions,
      report.filesObservedOrChanged,
      report.verificationPerformed,
      report.openFollowUps,
      report.blockers,
    ].reduce((count, items) => count + items.length, 0);
    assert.throws(
      () => rawInsert(
        badReportAdvance,
        "lifecycle_child_event_folds",
        childProjectionRow({
          event_position: 2,
          stream_version: 2,
          report_count: 2,
          latest_report_id: report.reportId,
          report_index_fingerprint: H64_C,
          reported_report_id: report.reportId,
          reported_item_count: reportedItemCount,
          reported_item_set_fingerprint: H64,
          previous_fingerprint: H64_B,
          fingerprint: H64_C,
        }),
      ),
      /LIFECYCLE_CHILD_EVENT_FOLD_INVALID/,
    );
  });

  it("migration 3 enforces immutable workflow-generation provenance and adjacency", () => {
    const connection = currentConnection();
    const table = connection.prepare(`
      SELECT sql FROM sqlite_schema
      WHERE type = 'table' AND name = 'lifecycle_workflow_generation_folds'
    `).get();
    assert.equal(typeof table?.sql, "string");
    assert.match(
      String(table?.sql),
      /PRIMARY KEY \(project_id, workflow_id, workflow_generation\)/,
    );
    assert.match(
      String(table?.sql),
      /UNIQUE \(project_id, workflow_id, trigger_event_position\)/,
    );
    const triggers = connection.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'trigger' AND name GLOB 'lifecycle_workflow_generation_folds_*'
      ORDER BY name
    `).all().map((row) => row.name);
    assert.deepEqual(triggers, [
      "lifecycle_workflow_generation_folds_insert_guard",
      "lifecycle_workflow_generation_folds_no_delete",
      "lifecycle_workflow_generation_folds_no_update",
    ]);

    const missingInitialReplacement = currentConnection();
    seedRootStart(missingInitialReplacement);
    seedLegacyEndRequest(missingInitialReplacement, 2, 2);
    assert.throws(
      () => rawInsert(
        missingInitialReplacement,
        "lifecycle_workflow_generation_folds",
        workflowProjectionRow(2, {
          replacement_checkpoint_version: null,
        }),
      ),
      /LIFECYCLE_WORKFLOW_GENERATION_FOLD_INVALID/,
    );

    const wrongIntentCommand = currentConnection();
    seedRootStart(wrongIntentCommand);
    const commandId = eventCommandId(2);
    rawEvent(wrongIntentCommand, 2, {
      streamType: "session",
      sessionId: ROOT_ID,
      streamVersion: 2,
      eventType: "SessionEndRequested",
      eventSchemaVersion: 1,
      commandId,
      lifecycleIntent: intentWithWrongCommandId(
        requestIntentWitness(commandId),
      ),
      payload: {
        workflowId: PROJECTION_WORKFLOW_ID,
        workflowGeneration: 1,
        previousState: "active",
        childEndPolicy: "require-completed",
        qualityThreshold: 0,
        requireFullEvidence: false,
        requireMaterialization: false,
      },
    });
    assert.throws(
      () => rawInsert(
        wrongIntentCommand,
        "lifecycle_workflow_generation_folds",
        workflowProjectionRow(),
      ),
      /LIFECYCLE_WORKFLOW_GENERATION_FOLD_INVALID/,
    );

    const badWindowAndCarry = currentConnection();
    seedRootStart(badWindowAndCarry);
    const requestCommandId = eventCommandId(2);
    rawEvent(badWindowAndCarry, 2, {
      streamType: "session",
      sessionId: ROOT_ID,
      streamVersion: 2,
      eventType: "SessionEndRequested",
      eventSchemaVersion: 2,
      commandId: requestCommandId,
      lifecycleIntent: requestIntentWitness(requestCommandId, 2),
      payload: {
        workflowId: PROJECTION_WORKFLOW_ID,
        workflowGeneration: 1,
        previousState: "active",
        childEndPolicy: "require-completed",
        qualityThreshold: 0,
        requireFullEvidence: false,
        requireMaterialization: false,
        requestVersion: 2,
      },
    });
    assert.throws(
      () => rawInsert(
        badWindowAndCarry,
        "lifecycle_workflow_generation_folds",
        workflowProjectionRow(2, {
          evidence_window_state: "open",
          replacement_checkpoint_version: null,
          effective_checkpoint_version: 2,
        }),
      ),
      /LIFECYCLE_WORKFLOW_GENERATION_FOLD_INVALID/,
    );
    rawInsert(
      badWindowAndCarry,
      "lifecycle_workflow_generation_folds",
      workflowProjectionRow(2, {
        evidence_window_state: "open",
        replacement_checkpoint_version: 2,
        effective_checkpoint_version: 2,
      }),
    );
    const amendmentCommandId = eventCommandId(3);
    rawEvent(badWindowAndCarry, 3, {
      streamType: "session",
      sessionId: ROOT_ID,
      streamVersion: 3,
      eventType: "SessionEndAmended",
      eventSchemaVersion: 2,
      commandId: amendmentCommandId,
      lifecycleIntent: unchangedAmendmentIntentWitness(
        amendmentCommandId,
        "2",
      ),
      payload: {
        workflowId: PROJECTION_WORKFLOW_ID,
        previousWorkflowGeneration: 1,
        workflowGeneration: 2,
        preTransitionCheckpointId:
          "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        amendmentVersion: 2,
        finalCheckpointVersion: null,
        evidenceWindowAction: "unchanged",
      },
    });
    const generationTwo = workflowProjectionRow(3, {
      workflow_generation: 2,
      root_command_id: amendmentCommandId,
      evidence_window_state: "sealed",
      replacement_checkpoint_version: null,
      effective_checkpoint_version: 2,
      effective_draft_source_event_position: 2,
      previous_fingerprint: H64,
      fingerprint: H64_B,
    });
    assert.throws(
      () => rawInsert(
        badWindowAndCarry,
        "lifecycle_workflow_generation_folds",
        generationTwo,
      ),
      /LIFECYCLE_WORKFLOW_GENERATION_FOLD_INVALID/,
    );
    assert.throws(
      () => rawInsert(
        badWindowAndCarry,
        "lifecycle_workflow_generation_folds",
        {
          ...generationTwo,
          evidence_window_state: "open",
          effective_draft_source_event_position: 3,
        },
      ),
      /LIFECYCLE_WORKFLOW_GENERATION_FOLD_INVALID/,
    );
    assert.throws(
      () => rawInsert(
        badWindowAndCarry,
        "lifecycle_workflow_generation_folds",
        {
          ...generationTwo,
          evidence_window_state: "open",
          effective_draft_source_event_position: 1,
        },
      ),
      /LIFECYCLE_WORKFLOW_GENERATION_FOLD_INVALID/,
    );
  });

  it("migration 3 preflight requires an exact cancelled predecessor before reopen", () => {
    for (const predecessorType of [
      "SessionEndRequested",
      "SessionEndAmended",
      "SessionAbandoned",
      "SessionEndCancelled",
    ] as const) {
      const connection = sourceConnection(2);
      connection.exec("PRAGMA foreign_keys = OFF");
      seedRootStart(connection);
      rawEvent(connection, 2, {
        streamType: "session",
        sessionId: ROOT_ID,
        streamVersion: 2,
        eventType: "SessionEndRequested",
        commandId: eventCommandId(2),
        lifecycleIntent: requestIntentWitness(eventCommandId(2)),
        payload: {
          workflowId: PROJECTION_WORKFLOW_ID,
          workflowGeneration: 1,
          previousState: "active",
          childEndPolicy: "require-completed",
          qualityThreshold: 0,
          requireFullEvidence: false,
          requireMaterialization: false,
        },
      });

      let reopenPosition = 3;
      let reopenGeneration = 2;
      if (predecessorType === "SessionEndAmended") {
        rawEvent(connection, 3, {
          streamType: "session",
          sessionId: ROOT_ID,
          streamVersion: 3,
          eventType: predecessorType,
          commandId: eventCommandId(3),
          lifecycleIntent: legacyAmendmentIntentWitness(eventCommandId(3), "2"),
          payload: {
            workflowId: PROJECTION_WORKFLOW_ID,
            previousWorkflowGeneration: 1,
            workflowGeneration: 2,
            preTransitionCheckpointId:
              "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          },
        });
        reopenPosition = 4;
        reopenGeneration = 3;
      } else if (predecessorType === "SessionAbandoned") {
        rawEvent(connection, 3, {
          streamType: "session",
          sessionId: ROOT_ID,
          streamVersion: 3,
          eventType: predecessorType,
          commandId: eventCommandId(3),
          lifecycleIntent: abandonIntentWitness(
            eventCommandId(3),
            "2",
            "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            "explicit-user-approval",
          ),
          payload: {
            workflowId: PROJECTION_WORKFLOW_ID,
            workflowGeneration: 1,
            approvalId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            preTransitionCheckpointId:
              "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            reasonCode: "explicit-user-approval",
            authorityCommitment: H64,
          },
        });
        reopenPosition = 4;
      } else if (predecessorType === "SessionEndCancelled") {
        rawEvent(connection, 3, {
          streamType: "session",
          sessionId: ROOT_ID,
          streamVersion: 3,
          eventType: predecessorType,
          commandId: eventCommandId(3),
          lifecycleIntent: cancelIntentWitness(
            eventCommandId(3),
            PROJECTION_WORKFLOW_ID,
            "2",
            "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          ),
          payload: {
            workflowId: PROJECTION_WORKFLOW_ID,
            workflowGeneration: 1,
            restoredState: "active",
            preTransitionCheckpointId:
              "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          },
        });
        reopenPosition = 4;
      }

      rawEvent(connection, reopenPosition, {
        streamType: "session",
        sessionId: ROOT_ID,
        streamVersion: reopenPosition,
        eventType: "SessionEndRequested",
        commandId: eventCommandId(reopenPosition),
        lifecycleIntent: requestIntentWitness(eventCommandId(reopenPosition)),
        payload: {
          workflowId: PROJECTION_WORKFLOW_ID,
          workflowGeneration: reopenGeneration,
          previousState: "active",
          childEndPolicy: "require-completed",
          qualityThreshold: 0,
          requireFullEvidence: false,
          requireMaterialization: false,
        },
      });
      rawInsert(connection, "workflow_instances", legacyLifecycleWorkflow({
        workflow_id: PROJECTION_WORKFLOW_ID,
        generation: reopenGeneration,
        state: "active",
        phase: "requested",
        root_command_id: eventCommandId(reopenPosition),
        session_id: ROOT_ID,
        triggering_event_position: reopenPosition,
      }));

      connection.exec("BEGIN IMMEDIATE");
      const stage = () => new SqliteQualifiedCheckpointMigrationPreflight()
        .assertEligibleAndStage(connection, context);
      if (predecessorType === "SessionEndCancelled") {
        assert.doesNotThrow(stage);
      } else {
        assert.throws(
          stage,
          /MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED/,
          predecessorType,
        );
      }
      connection.exec("ROLLBACK");
    }
  });

  it("migration 3 preflight advances each child lifecycle stream exactly once", () => {
    const connection = sourceConnection(2);
    seedTransferredFinalHistory(connection);
    const preparedSql: string[] = [];
    const observed: SqliteConnection = {
      exec(sql): void {
        connection.exec(sql);
      },
      prepare(sql) {
        preparedSql.push(sql.replace(/\s+/g, " ").trim());
        return connection.prepare(sql);
      },
      close(): void {
        connection.close();
      },
    };
    connection.exec("BEGIN IMMEDIATE");
    new SqliteQualifiedCheckpointMigrationPreflight()
      .assertEligibleAndStage(observed, context);
    assert.equal(
      preparedSql.filter((sql) =>
        sql.includes("ORDER BY global_position")
        && sql.includes("FROM events")).length,
      1,
    );
    assert.equal(
      preparedSql.filter((sql) =>
        sql.includes("WHERE project_id = $projectId AND global_position = $position"))
        .length,
      0,
    );
    connection.exec("ROLLBACK");
  });

  it("migration 3 persistent workflow guard requires an exact cancelled predecessor before reopen", () => {
    for (const predecessorType of [
      "SessionEndRequested",
      "SessionEndAmended",
      "SessionAbandoned",
      "SessionEndCancelled",
    ] as const) {
      const connection = currentConnection();
      seedRootStart(connection);
      seedLegacyEndRequest(connection, 2, 2);
      rawInsert(
        connection,
        "lifecycle_workflow_generation_folds",
        workflowProjectionRow(),
      );

      let reopenPosition = 3;
      let reopenGeneration = 2;
      let previousFingerprint = H64;
      if (predecessorType === "SessionEndAmended") {
        rawEvent(connection, 3, {
          streamType: "session",
          sessionId: ROOT_ID,
          streamVersion: 3,
          eventType: predecessorType,
          commandId: eventCommandId(3),
          lifecycleIntent: legacyAmendmentIntentWitness(eventCommandId(3), "2"),
          payload: {
            workflowId: PROJECTION_WORKFLOW_ID,
            previousWorkflowGeneration: 1,
            workflowGeneration: 2,
            preTransitionCheckpointId:
              "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          },
        });
        rawInsert(
          connection,
          "lifecycle_workflow_generation_folds",
          workflowProjectionRow(3, {
            workflow_generation: 2,
            root_command_id: eventCommandId(3),
            replacement_checkpoint_version: null,
            effective_draft_source_event_position: 2,
            previous_fingerprint: H64,
            fingerprint: H64_B,
          }),
        );
        reopenPosition = 4;
        reopenGeneration = 3;
        previousFingerprint = H64_B;
      } else if (
        predecessorType === "SessionAbandoned"
        || predecessorType === "SessionEndCancelled"
      ) {
        const checkpointId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        rawEvent(connection, 3, {
          streamType: "session",
          sessionId: ROOT_ID,
          streamVersion: 3,
          eventType: predecessorType,
          commandId: eventCommandId(3),
          lifecycleIntent: predecessorType === "SessionAbandoned"
            ? abandonIntentWitness(
                eventCommandId(3),
                "2",
                checkpointId,
                "explicit-user-approval",
              )
            : cancelIntentWitness(
                eventCommandId(3),
                PROJECTION_WORKFLOW_ID,
                "2",
                checkpointId,
              ),
          payload: predecessorType === "SessionAbandoned"
            ? {
                workflowId: PROJECTION_WORKFLOW_ID,
                workflowGeneration: 2,
                approvalId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                preTransitionCheckpointId: checkpointId,
                reasonCode: "explicit-user-approval",
                authorityCommitment: H64,
              }
            : {
                workflowId: PROJECTION_WORKFLOW_ID,
                workflowGeneration: 2,
                restoredState: "active",
                preTransitionCheckpointId: checkpointId,
              },
        });
        rawInsert(
          connection,
          "lifecycle_workflow_generation_folds",
          workflowProjectionRow(3, {
            workflow_generation: 2,
            root_command_id: eventCommandId(3),
            replacement_checkpoint_version: null,
            effective_draft_source_event_position: 2,
            previous_fingerprint: H64,
            fingerprint: H64_B,
          }),
        );
        reopenPosition = 4;
        reopenGeneration = 3;
        previousFingerprint = H64_B;
      }

      rawEvent(connection, reopenPosition, {
        streamType: "session",
        sessionId: ROOT_ID,
        streamVersion: reopenPosition,
        eventType: "SessionEndRequested",
        commandId: eventCommandId(reopenPosition),
        lifecycleIntent: requestIntentWitness(eventCommandId(reopenPosition)),
        payload: {
          workflowId: PROJECTION_WORKFLOW_ID,
          workflowGeneration: reopenGeneration,
          previousState: "active",
          childEndPolicy: "require-completed",
          qualityThreshold: 0,
          requireFullEvidence: false,
          requireMaterialization: false,
        },
      });
      const insertReopen = () => rawInsert(
        connection,
        "lifecycle_workflow_generation_folds",
        workflowProjectionRow(reopenPosition, {
          workflow_generation: reopenGeneration,
          root_command_id: eventCommandId(reopenPosition),
          replacement_checkpoint_version: 1,
          effective_checkpoint_version: 1,
          effective_draft_source_event_position: reopenPosition,
          previous_fingerprint: previousFingerprint,
          fingerprint: H64_C,
        }),
      );
      if (predecessorType === "SessionEndCancelled") {
        assert.doesNotThrow(insertReopen);
      } else {
        assert.throws(
          insertReopen,
          /LIFECYCLE_WORKFLOW_GENERATION_FOLD_INVALID/,
          predecessorType,
        );
      }
    }
  });

  it("migration 3 persistent workflow guard rejects cancel checkpoint intent mismatch", () => {
    const connection = currentConnection();
    seedRootStart(connection);
    seedLegacyEndRequest(connection, 2, 2);
    rawInsert(
      connection,
      "lifecycle_workflow_generation_folds",
      workflowProjectionRow(),
    );
    const eventCheckpointId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const intentCheckpointId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const commandId = eventCommandId(3);
    rawEvent(connection, 3, {
      streamType: "session",
      sessionId: ROOT_ID,
      streamVersion: 3,
      eventType: "SessionEndCancelled",
      commandId,
      lifecycleIntent: cancelIntentWitness(
        commandId,
        PROJECTION_WORKFLOW_ID,
        "2",
        intentCheckpointId,
      ),
      payload: {
        workflowId: PROJECTION_WORKFLOW_ID,
        workflowGeneration: 2,
        restoredState: "active",
        preTransitionCheckpointId: eventCheckpointId,
      },
    });
    assert.throws(
      () => rawInsert(
        connection,
        "lifecycle_workflow_generation_folds",
        workflowProjectionRow(3, {
          workflow_generation: 2,
          root_command_id: commandId,
          replacement_checkpoint_version: null,
          effective_draft_source_event_position: 2,
          previous_fingerprint: H64,
          fingerprint: H64_B,
        }),
      ),
      /LIFECYCLE_WORKFLOW_GENERATION_FOLD_INVALID/,
    );
  });

  it("migration 3 pre-copy guard rejects cancel and abandon event-intent parity mismatch", () => {
    for (const candidate of [
      {
        name: "cancel checkpoint",
        eventType: "SessionEndCancelled",
        phase: "cancelled",
        mismatchCheckpoint: true,
        mismatchReason: false,
      },
      {
        name: "abandon checkpoint",
        eventType: "SessionAbandoned",
        phase: "abandoned",
        mismatchCheckpoint: true,
        mismatchReason: false,
      },
      {
        name: "abandon reason",
        eventType: "SessionAbandoned",
        phase: "abandoned",
        mismatchCheckpoint: false,
        mismatchReason: true,
      },
    ] as const) {
      const connection = sourceConnection(2);
      connection.exec("PRAGMA foreign_keys = OFF");
      seedRootStart(connection);
      seedLegacyEndRequest(connection, 2, 2);
      const checkpointId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      const commandId = eventCommandId(3);
      rawEvent(connection, 3, {
        streamType: "session",
        sessionId: ROOT_ID,
        streamVersion: 3,
        eventType: candidate.eventType,
        commandId,
        lifecycleIntent: candidate.eventType === "SessionEndCancelled"
          ? cancelIntentWitness(
              commandId,
              PROJECTION_WORKFLOW_ID,
              "2",
              checkpointId,
            )
          : abandonIntentWitness(
              commandId,
              "2",
              checkpointId,
              "explicit-user-approval",
            ),
        payload: candidate.eventType === "SessionEndCancelled"
          ? {
              workflowId: PROJECTION_WORKFLOW_ID,
              workflowGeneration: 1,
              restoredState: "active",
              preTransitionCheckpointId: checkpointId,
            }
          : {
              workflowId: PROJECTION_WORKFLOW_ID,
              workflowGeneration: 1,
              approvalId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
              preTransitionCheckpointId: checkpointId,
              reasonCode: "explicit-user-approval",
              authorityCommitment: H64,
            },
      });
      rawInsert(connection, "workflow_instances", legacyLifecycleWorkflow({
        workflow_id: PROJECTION_WORKFLOW_ID,
        generation: 1,
        state: "completed",
        phase: candidate.phase,
        root_command_id: commandId,
        session_id: ROOT_ID,
        triggering_event_position: 3,
      }));

      connection.exec("BEGIN IMMEDIATE");
      new SqliteQualifiedCheckpointMigrationPreflight()
        .assertEligibleAndStage(connection, context);
      const mismatchedIntent = candidate.eventType === "SessionEndCancelled"
        ? cancelIntentWitness(
            commandId,
            PROJECTION_WORKFLOW_ID,
            "2",
            "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          )
        : abandonIntentWitness(
            commandId,
            "2",
            candidate.mismatchCheckpoint
              ? "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
              : checkpointId,
            candidate.mismatchReason
              ? "operator-emergency"
              : "explicit-user-approval",
          );
      connection.exec("DROP TRIGGER events_no_update");
      connection.prepare(`
        UPDATE events SET lifecycle_intent_json = $intent
        WHERE global_position = 3
      `).run({ $intent: mismatchedIntent });
      assert.throws(
        () => connection.exec(qualifiedCheckpointCoverageMigration.sql),
        /MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED/,
        candidate.name,
      );
      connection.exec("ROLLBACK");
      assert.equal(schemaVersion(connection), 2, candidate.name);
    }
  });

  it("migration 3 persistent workflow guard rejects abandon event-intent parity mismatch", () => {
    for (const mismatch of [
      {
        name: "checkpoint",
        intentCheckpointId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        intentReasonCode: "explicit-user-approval",
      },
      {
        name: "reason",
        intentCheckpointId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        intentReasonCode: "operator-emergency",
      },
    ]) {
      const connection = currentConnection();
      seedRootStart(connection);
      seedLegacyEndRequest(connection, 2, 2);
      rawInsert(
        connection,
        "lifecycle_workflow_generation_folds",
        workflowProjectionRow(),
      );
      const commandId = eventCommandId(3);
      rawEvent(connection, 3, {
        streamType: "session",
        sessionId: ROOT_ID,
        streamVersion: 3,
        eventType: "SessionAbandoned",
        commandId,
        lifecycleIntent: abandonIntentWitness(
          commandId,
          "2",
          mismatch.intentCheckpointId,
          mismatch.intentReasonCode,
        ),
        payload: {
          workflowId: PROJECTION_WORKFLOW_ID,
          workflowGeneration: 2,
          approvalId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          preTransitionCheckpointId:
            "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          reasonCode: "explicit-user-approval",
          authorityCommitment: H64,
        },
      });
      assert.throws(
        () => rawInsert(
          connection,
          "lifecycle_workflow_generation_folds",
          workflowProjectionRow(3, {
            workflow_generation: 2,
            root_command_id: commandId,
            replacement_checkpoint_version: null,
            effective_draft_source_event_position: 2,
            previous_fingerprint: H64,
            fingerprint: H64_B,
          }),
        ),
        /LIFECYCLE_WORKFLOW_GENERATION_FOLD_INVALID/,
        mismatch.name,
      );
    }
  });

  it("migration 3 persistent child guard rejects disposition report item-set mismatch", () => {
    const connection = currentConnection();
    seedChildForkProjectionEvent(connection);
    rawInsert(
      connection,
      "lifecycle_child_event_folds",
      childProjectionRow(),
    );
    const reported = lifecycleEvent(2, "ChildWorkReported", {}, {
      projectId: PROJECT_ID as never,
      vaultId: VAULT_ID as never,
      storeId: STORE_ID as never,
      workspaceId: WORKSPACE_ID as never,
      sessionId: CHILD_ID as never,
      parentSessionId: ROOT_ID as never,
      globalPosition: 2,
      streamVersion: 2,
      authorityCommitment: H64,
    });
    const {
      allReportItemIds,
      ...storedReport
    } = reported.payload.report;
    rawEvent(connection, 2, {
      streamType: "session",
      sessionId: CHILD_ID,
      parentSessionId: ROOT_ID,
      streamVersion: 2,
      eventType: "ChildWorkReported",
      payload: {
        ...reported.payload,
        report: storedReport,
      },
    });
    rawInsert(
      connection,
      "lifecycle_child_event_folds",
      childProjectionRow({
        event_position: 2,
        stream_version: 2,
        report_count: 1,
        latest_report_id: reported.payload.report.reportId,
        report_index_fingerprint: H64_B,
        reported_report_id: reported.payload.report.reportId,
        reported_item_count: allReportItemIds.length,
        reported_item_set_fingerprint: H64_C,
        previous_fingerprint: H64_B,
        fingerprint: H64_C,
      }),
    );
    const wrongItemIds = allReportItemIds.map((_, index) =>
      `ffffffff-ffff-4fff-8fff-${(index + 1).toString(16).padStart(12, "0")}`);
    const disposition = {
      ...childDispositionFixture("accepted", reported.payload.report.reportId),
      acceptedItemIds: wrongItemIds,
      allReportItemIds: wrongItemIds,
    };
    rawEvent(connection, 3, {
      streamType: "session",
      sessionId: CHILD_ID,
      parentSessionId: ROOT_ID,
      streamVersion: 3,
      eventType: "ChildWorkDispositioned",
      payload: { disposition },
    });
    assert.throws(
      () => rawInsert(
        connection,
        "lifecycle_child_event_folds",
        childProjectionRow({
          event_position: 3,
          stream_version: 3,
          report_count: 1,
          latest_report_id: reported.payload.report.reportId,
          report_index_fingerprint: H64_B,
          previous_fingerprint: H64_C,
          fingerprint: H64,
        }),
      ),
      /LIFECYCLE_CHILD_EVENT_FOLD_INVALID/,
    );
  });

  it("migration 3 enforces all child projection deferred foreign keys", () => {
    const cases = [
      {
        name: "event_position",
        eventPositions: [] as const,
        row: childProjectionRow(),
      },
      {
        name: "latest_checkpoint_event_position",
        eventPositions: [3] as const,
        row: childProjectionRow({
          event_position: 3,
          latest_checkpoint_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          latest_checkpoint_event_position: 2,
        }),
      },
      {
        name: "terminal_event_position",
        eventPositions: [3] as const,
        row: childProjectionRow({
          event_position: 3,
          child_state: "completed",
          terminal_event_type: "ChildSessionCompleted",
          terminal_event_position: 2,
        }),
      },
    ] as const;
    for (const candidate of cases) {
      const connection = currentConnection();
      connection.exec("PRAGMA foreign_keys = OFF");
      connection.exec("DROP TRIGGER lifecycle_child_event_folds_insert_guard");
      for (const position of candidate.eventPositions) rawEvent(connection, position);
      connection.exec("PRAGMA foreign_keys = ON");
      connection.exec("BEGIN IMMEDIATE");
      rawInsert(
        connection,
        "lifecycle_child_event_folds",
        candidate.row,
      );
      assert.throws(
        () => connection.exec("COMMIT"),
        /FOREIGN KEY constraint failed/,
        candidate.name,
      );
      connection.exec("ROLLBACK");
    }
  });

  it("migration 3 installed projection indexes expose exact keys and serve lookups", () => {
    const child = currentConnection();
    seedChildForkProjectionEvent(child);
    rawInsert(child, "lifecycle_child_event_folds", childProjectionRow());
    const reportEvent = lifecycleEvent(2, "ChildWorkReported", {}, {
      projectId: PROJECT_ID as never,
      vaultId: VAULT_ID as never,
      storeId: STORE_ID as never,
      workspaceId: WORKSPACE_ID as never,
      sessionId: CHILD_ID as never,
      parentSessionId: ROOT_ID as never,
      globalPosition: 2,
      streamVersion: 2,
      authorityCommitment: H64,
    });
    const { allReportItemIds, ...storedReport } = reportEvent.payload.report;
    rawEvent(child, 2, {
      streamType: "session",
      sessionId: CHILD_ID,
      parentSessionId: ROOT_ID,
      streamVersion: 2,
      eventType: "ChildWorkReported",
      payload: { ...reportEvent.payload, report: storedReport },
    });
    rawInsert(
      child,
      "lifecycle_child_event_folds",
      childProjectionRow({
        event_position: 2,
        stream_version: 2,
        report_count: 1,
        latest_report_id: reportEvent.payload.report.reportId,
        report_index_fingerprint: H64_B,
        reported_report_id: reportEvent.payload.report.reportId,
        reported_item_count: allReportItemIds.length,
        reported_item_set_fingerprint: H64_C,
        previous_fingerprint: H64_B,
        fingerprint: H64_C,
      }),
    );

    const expectedIndexes = [
      {
        table: "lifecycle_child_event_folds",
        name: "lifecycle_child_event_folds_at_event",
        unique: 0n,
        partial: 0n,
        columns: ["project_id", "child_session_id", "event_position"],
        sql: `
          SELECT event_position
          FROM lifecycle_child_event_folds
            INDEXED BY lifecycle_child_event_folds_at_event
          WHERE project_id = $projectId
            AND child_session_id = $childSessionId
            AND event_position <= $eventPosition
          ORDER BY event_position DESC
          LIMIT 1
        `,
        params: {
          $projectId: PROJECT_ID,
          $childSessionId: CHILD_ID,
          $eventPosition: 2,
        },
        expected: 2n,
      },
      {
        table: "lifecycle_child_event_folds",
        name: "lifecycle_child_event_folds_root_at_event",
        unique: 0n,
        partial: 0n,
        columns: ["project_id", "root_session_id", "event_position"],
        sql: `
          SELECT event_position
          FROM lifecycle_child_event_folds
            INDEXED BY lifecycle_child_event_folds_root_at_event
          WHERE project_id = $projectId
            AND root_session_id = $rootSessionId
            AND event_position <= $eventPosition
          ORDER BY event_position DESC
          LIMIT 1
        `,
        params: {
          $projectId: PROJECT_ID,
          $rootSessionId: ROOT_ID,
          $eventPosition: 2,
        },
        expected: 2n,
      },
      {
        table: "lifecycle_child_event_folds",
        name: "lifecycle_child_event_folds_report_witness",
        unique: 1n,
        partial: 1n,
        columns: ["project_id", "child_session_id", "reported_report_id"],
        sql: `
          SELECT event_position
          FROM lifecycle_child_event_folds
            INDEXED BY lifecycle_child_event_folds_report_witness
          WHERE project_id = $projectId
            AND child_session_id = $childSessionId
            AND reported_report_id = $reportId
        `,
        params: {
          $projectId: PROJECT_ID,
          $childSessionId: CHILD_ID,
          $reportId: reportEvent.payload.report.reportId,
        },
        expected: 2n,
      },
    ] as const;
    for (const candidate of expectedIndexes) {
      const metadata = child.prepare(
        `PRAGMA index_list('${candidate.table}')`,
      ).all().find((row) => row.name === candidate.name);
      assert.equal(metadata?.unique, candidate.unique, candidate.name);
      assert.equal(metadata?.partial, candidate.partial, candidate.name);
      assert.deepEqual(
        child.prepare(`PRAGMA index_info('${candidate.name}')`).all()
          .map((row) => row.name),
        candidate.columns,
        candidate.name,
      );
      const plan = child.prepare(
        `EXPLAIN QUERY PLAN ${candidate.sql}`,
      ).all(candidate.params).map((row) => String(row.detail)).join("\n");
      assert.match(plan, new RegExp(candidate.name), candidate.name);
      assert.equal(
        child.prepare(candidate.sql).get(candidate.params)?.event_position,
        candidate.expected,
        candidate.name,
      );
    }
    const reportIndexSql = child.prepare(`
      SELECT sql FROM sqlite_schema
      WHERE type = 'index'
        AND name = 'lifecycle_child_event_folds_report_witness'
    `).get()?.sql;
    assert.match(
      String(reportIndexSql),
      /WHERE reported_report_id IS NOT NULL/,
    );

    const workflow = currentConnection();
    seedRootStart(workflow);
    seedLegacyEndRequest(workflow, 2, 2);
    rawInsert(
      workflow,
      "lifecycle_workflow_generation_folds",
      workflowProjectionRow(),
    );
    const workflowIndex =
      "lifecycle_workflow_generation_folds_session";
    const workflowMetadata = workflow.prepare(`
      PRAGMA index_list('lifecycle_workflow_generation_folds')
    `).all().find((row) => row.name === workflowIndex);
    assert.equal(workflowMetadata?.unique, 0n);
    assert.equal(workflowMetadata?.partial, 0n);
    assert.deepEqual(
      workflow.prepare(`PRAGMA index_info('${workflowIndex}')`).all()
        .map((row) => row.name),
      ["project_id", "session_id", "workflow_id", "workflow_generation"],
    );
    const workflowLookup = `
      SELECT workflow_generation
      FROM lifecycle_workflow_generation_folds
        INDEXED BY lifecycle_workflow_generation_folds_session
      WHERE project_id = $projectId
        AND session_id = $sessionId
        AND workflow_id = $workflowId
        AND workflow_generation <= $generation
      ORDER BY workflow_generation DESC
      LIMIT 1
    `;
    const workflowParams = {
      $projectId: PROJECT_ID,
      $sessionId: ROOT_ID,
      $workflowId: PROJECTION_WORKFLOW_ID,
      $generation: 1,
    };
    const workflowPlan = workflow.prepare(
      `EXPLAIN QUERY PLAN ${workflowLookup}`,
    ).all(workflowParams).map((row) => String(row.detail)).join("\n");
    assert.match(workflowPlan, new RegExp(workflowIndex));
    assert.equal(
      workflow.prepare(workflowLookup).get(workflowParams)?.workflow_generation,
      1n,
    );
  });

  it("migration 3 projection tables enforce every row constraint index and immutable guard", () => {
    const childConstraintCases = [
      ["event position", { event_position: 0 }],
      ["stream version", { stream_version: 0 }],
      ["child state", { child_state: "unknown" }],
      ["checkpoint position", {
        latest_checkpoint_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        latest_checkpoint_event_position: 0,
      }],
      ["authority hash", { authority_commitment: "not-a-hash" }],
      ["terminal type", {
        child_state: "completed",
        terminal_event_type: "SessionEnded",
        terminal_event_position: 1,
      }],
      ["terminal position", {
        child_state: "completed",
        terminal_event_type: "ChildSessionCompleted",
        terminal_event_position: 0,
      }],
      ["negative report count", { report_count: -1 }],
      ["oversized report count", {
        report_count: 201,
        latest_report_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      }],
      ["report-index hash", { report_index_fingerprint: "not-a-hash" }],
      ["reported count", {
        report_count: 1,
        latest_report_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        reported_report_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        reported_item_count: 201,
        reported_item_set_fingerprint: H64,
      }],
      ["reported set hash", {
        report_count: 1,
        latest_report_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        reported_report_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        reported_item_count: 1,
        reported_item_set_fingerprint: "not-a-hash",
      }],
      ["previous hash", { previous_fingerprint: "not-a-hash" }],
      ["fingerprint", { fingerprint: "not-a-hash" }],
      ["checkpoint pair", {
        latest_checkpoint_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      }],
      ["terminal pair", { terminal_event_position: 1 }],
      ["report pair", {
        report_count: 1,
        latest_report_id: null,
      }],
      ["reported triple", {
        reported_report_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      }],
      ["completion witness", {
        completion_report_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      }],
      ["state terminal shape", {
        child_state: "completed",
        terminal_event_type: null,
        terminal_event_position: null,
      }],
      ["terminal ordering", {
        child_state: "completed",
        terminal_event_type: "ChildSessionCompleted",
        terminal_event_position: 2,
      }],
      ["checkpoint ordering", {
        latest_checkpoint_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        latest_checkpoint_event_position: 2,
      }],
    ] as const;
    for (const [name, overrides] of childConstraintCases) {
      const connection = currentConnection();
      connection.exec("DROP TRIGGER lifecycle_child_event_folds_insert_guard");
      assert.throws(
        () => rawInsert(
          connection,
          "lifecycle_child_event_folds",
          childProjectionRow(overrides),
        ),
        /constraint failed|CHECK constraint failed/,
        name,
      );
    }

    const childPrimary = currentConnection();
    childPrimary.exec("DROP TRIGGER lifecycle_child_event_folds_insert_guard");
    rawInsert(childPrimary, "lifecycle_child_event_folds", childProjectionRow());
    assert.throws(
      () => rawInsert(childPrimary, "lifecycle_child_event_folds", childProjectionRow()),
      /UNIQUE constraint failed/,
    );

    const childStreamUnique = currentConnection();
    childStreamUnique.exec("DROP TRIGGER lifecycle_child_event_folds_insert_guard");
    rawInsert(childStreamUnique, "lifecycle_child_event_folds", childProjectionRow());
    assert.throws(
      () => rawInsert(
        childStreamUnique,
        "lifecycle_child_event_folds",
        childProjectionRow({ event_position: 2, fingerprint: H64_C }),
      ),
      /UNIQUE constraint failed/,
    );

    const childReportUnique = currentConnection();
    childReportUnique.exec("DROP TRIGGER lifecycle_child_event_folds_insert_guard");
    const reportId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const reportRow = childProjectionRow({
      report_count: 1,
      latest_report_id: reportId,
      reported_report_id: reportId,
      reported_item_count: 1,
      reported_item_set_fingerprint: H64,
    });
    rawInsert(childReportUnique, "lifecycle_child_event_folds", reportRow);
    assert.throws(
      () => rawInsert(
        childReportUnique,
        "lifecycle_child_event_folds",
        {
          ...reportRow,
          event_position: 2,
          stream_version: 2,
          previous_fingerprint: H64_B,
          fingerprint: H64_C,
        },
      ),
      /UNIQUE constraint failed/,
    );

    const immutableChild = currentConnection();
    seedChildForkProjectionEvent(immutableChild);
    rawInsert(
      immutableChild,
      "lifecycle_child_event_folds",
      childProjectionRow(),
    );
    assert.throws(
      () => immutableChild.exec(`
        UPDATE lifecycle_child_event_folds SET fingerprint = '${H64_C}'
      `),
      /LIFECYCLE_CHILD_EVENT_FOLD_IMMUTABLE/,
    );
    assert.throws(
      () => immutableChild.exec("DELETE FROM lifecycle_child_event_folds"),
      /LIFECYCLE_CHILD_EVENT_FOLD_IMMUTABLE/,
    );

    const workflowConstraintCases = [
      ["generation", { workflow_generation: 0 }],
      ["trigger position", { trigger_event_position: 0 }],
      ["window", { evidence_window_state: "unknown" }],
      ["replacement version", { replacement_checkpoint_version: 3 }],
      ["effective version", { effective_checkpoint_version: 3 }],
      ["source position", { effective_draft_source_event_position: 0 }],
      ["previous hash", { previous_fingerprint: "not-a-hash" }],
      ["fingerprint", { fingerprint: "not-a-hash" }],
      ["open version", {
        evidence_window_state: "open",
        effective_checkpoint_version: 1,
      }],
      ["replacement parity", {
        replacement_checkpoint_version: 2,
        effective_checkpoint_version: 1,
      }],
      ["replacement source", {
        replacement_checkpoint_version: 1,
        effective_draft_source_event_position: 1,
      }],
      ["source ordering", {
        replacement_checkpoint_version: null,
        effective_draft_source_event_position: 3,
      }],
    ] as const;
    for (const [name, overrides] of workflowConstraintCases) {
      const connection = currentConnection();
      connection.exec(
        "DROP TRIGGER lifecycle_workflow_generation_folds_insert_guard",
      );
      assert.throws(
        () => rawInsert(
          connection,
          "lifecycle_workflow_generation_folds",
          workflowProjectionRow(2, overrides),
        ),
        /constraint failed|CHECK constraint failed/,
        name,
      );
    }

    const workflowPrimary = currentConnection();
    workflowPrimary.exec(
      "DROP TRIGGER lifecycle_workflow_generation_folds_insert_guard",
    );
    rawInsert(
      workflowPrimary,
      "lifecycle_workflow_generation_folds",
      workflowProjectionRow(),
    );
    assert.throws(
      () => rawInsert(
        workflowPrimary,
        "lifecycle_workflow_generation_folds",
        workflowProjectionRow(),
      ),
      /UNIQUE constraint failed/,
    );

    const workflowTriggerUnique = currentConnection();
    workflowTriggerUnique.exec(
      "DROP TRIGGER lifecycle_workflow_generation_folds_insert_guard",
    );
    rawInsert(
      workflowTriggerUnique,
      "lifecycle_workflow_generation_folds",
      workflowProjectionRow(),
    );
    assert.throws(
      () => rawInsert(
        workflowTriggerUnique,
        "lifecycle_workflow_generation_folds",
        workflowProjectionRow(2, {
          workflow_generation: 2,
          previous_fingerprint: H64,
          fingerprint: H64_B,
        }),
      ),
      /UNIQUE constraint failed/,
    );

    for (const missing of ["trigger", "source"] as const) {
      const connection = currentConnection();
      connection.exec(
        "DROP TRIGGER lifecycle_workflow_generation_folds_insert_guard",
      );
      rawEvent(connection, missing === "trigger" ? 1 : 2);
      connection.exec("PRAGMA foreign_keys = ON");
      connection.exec("BEGIN IMMEDIATE");
      rawInsert(
        connection,
        "lifecycle_workflow_generation_folds",
        workflowProjectionRow(2, {
          replacement_checkpoint_version: null,
          effective_draft_source_event_position: 1,
        }),
      );
      assert.throws(
        () => connection.exec("COMMIT"),
        /FOREIGN KEY constraint failed/,
        missing,
      );
      connection.exec("ROLLBACK");
    }

    const immutableWorkflow = currentConnection();
    seedRootStart(immutableWorkflow);
    seedLegacyEndRequest(immutableWorkflow, 2, 2);
    rawInsert(
      immutableWorkflow,
      "lifecycle_workflow_generation_folds",
      workflowProjectionRow(),
    );
    assert.throws(
      () => immutableWorkflow.exec(`
        UPDATE lifecycle_workflow_generation_folds
        SET fingerprint = '${H64_C}'
      `),
      /LIFECYCLE_WORKFLOW_GENERATION_FOLD_IMMUTABLE/,
    );
    assert.throws(
      () => immutableWorkflow.exec(
        "DELETE FROM lifecycle_workflow_generation_folds",
      ),
      /LIFECYCLE_WORKFLOW_GENERATION_FOLD_IMMUTABLE/,
    );
  });

  it("migration 3 backfills three reports while consumers bind the first non-latest witness", () => {
    const connection = sourceConnection(2);
    connection.exec("PRAGMA foreign_keys = OFF");
    seedChildForkProjectionEvent(connection);
    const reports = [0, 1, 2].map((offset) => childReportFixture({
      childSessionId: CHILD_ID as never,
      parentSessionId: ROOT_ID as never,
      reportId: `aaaaaaaa-aaaa-4aaa-8aaa-${(offset + 1)
        .toString(16).padStart(12, "0")}` as never,
      itemIds: [
        `bbbbbbbb-bbbb-4bbb-8bbb-${(offset + 1)
          .toString(16).padStart(12, "0")}` as never,
        `cccccccc-cccc-4ccc-8ccc-${(offset + 1)
          .toString(16).padStart(12, "0")}` as never,
      ],
    }));
    for (let index = 0; index < reports.length; index += 1) {
      const report = reports[index]!;
      const { allReportItemIds: _allReportItemIds, ...storedReport } = report;
      rawEvent(connection, index + 2, {
        streamType: "session",
        sessionId: CHILD_ID,
        parentSessionId: ROOT_ID,
        streamVersion: index + 2,
        eventType: "ChildWorkReported",
        payload: {
          report: storedReport,
          childAuthorAgentId: "agent-child",
          primaryRecorderAgentId: "agent-primary",
        },
      });
    }
    const first = reports[0]!;
    rawEvent(connection, 5, {
      streamType: "session",
      sessionId: CHILD_ID,
      parentSessionId: ROOT_ID,
      streamVersion: 5,
      eventType: "ChildCompletionProposed",
      payload: { reportId: first.reportId },
    });
    rawEvent(connection, 6, {
      streamType: "session",
      sessionId: CHILD_ID,
      parentSessionId: ROOT_ID,
      streamVersion: 6,
      eventType: "ChildWorkDispositioned",
      payload: {
        disposition: {
          ...childDispositionFixture("rejected", first.reportId),
          rejectedItemIds: first.allReportItemIds,
          allReportItemIds: first.allReportItemIds,
        },
      },
    });
    rawEvent(connection, 7, {
      streamType: "session",
      sessionId: CHILD_ID,
      parentSessionId: ROOT_ID,
      streamVersion: 7,
      eventType: "ChildCompletionProposed",
      payload: { reportId: first.reportId },
    });
    rawEvent(connection, 8, {
      streamType: "session",
      sessionId: CHILD_ID,
      parentSessionId: ROOT_ID,
      streamVersion: 8,
      eventType: "ChildSessionCompleted",
      payload: {
        reportId: first.reportId,
        authorityCommitment: H64,
      },
    });

    new MigrationRunner().apply(connection, registry, NOW, mode({
      kind: "explicit-upgrade",
      expectedAppliedVersion: 2,
      beforeMigration(candidate: SqliteConnection, migration: { version: number }): void {
        if (migration.version === 3) {
          new SqliteQualifiedCheckpointMigrationPreflight()
            .assertEligibleAndStage(candidate, context);
        }
      },
    }));

    const rows = connection.prepare(`
      SELECT event_position, child_state, latest_report_id,
             completion_report_id, reported_report_id
      FROM lifecycle_child_event_folds
      ORDER BY event_position
    `).all();
    assert.equal(rows.length, 8);
    assert.deepEqual(
      rows.filter((row) => row.reported_report_id !== null)
        .map((row) => row.reported_report_id),
      reports.map((report) => report.reportId),
    );
    for (const eventPosition of [5n, 6n, 7n, 8n]) {
      const row = rows.find((candidate) =>
        candidate.event_position === eventPosition);
      assert.equal(row?.latest_report_id, reports[2]!.reportId);
    }
    assert.equal(rows[4]?.completion_report_id, first.reportId);
    assert.equal(rows[5]?.completion_report_id, null);
    assert.equal(rows[6]?.completion_report_id, first.reportId);
    assert.equal(rows[7]?.completion_report_id, first.reportId);
    assert.equal(rows[7]?.child_state, "completed");
  });

  it("migration 3 collapses schema 2 cancel and abandon at the same generation", () => {
    const connection = sourceConnection(2);
    connection.exec("PRAGMA foreign_keys = OFF");
    seedAllWorkflowProjectionTriggerClasses(connection);

    new MigrationRunner().apply(connection, registry, NOW, mode({
      kind: "explicit-upgrade",
      expectedAppliedVersion: 2,
      beforeMigration(
        candidate: SqliteConnection,
        migration: { version: number },
      ): void {
        if (migration.version === 3) {
          new SqliteQualifiedCheckpointMigrationPreflight()
            .assertEligibleAndStage(candidate, context);
        }
      },
    }));

    assert.deepEqual(
      connection.prepare(`
        SELECT workflow_generation, trigger_event_position,
               effective_draft_source_event_position
        FROM lifecycle_workflow_generation_folds
        ORDER BY workflow_generation
      `).all().map((row) => ({ ...row })),
      [
        {
          workflow_generation: 1n,
          trigger_event_position: 2n,
          effective_draft_source_event_position: 2n,
        },
        {
          workflow_generation: 2n,
          trigger_event_position: 4n,
          effective_draft_source_event_position: 2n,
        },
        {
          workflow_generation: 3n,
          trigger_event_position: 6n,
          effective_draft_source_event_position: 5n,
        },
      ],
    );
  });

  it("migration 3 copies child and workflow predecessor chains deterministically", () => {
    const connection = sourceConnection(2);
    connection.exec("PRAGMA foreign_keys = OFF");
    connection.exec("PRAGMA reverse_unordered_selects = ON");
    const workflowB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const checkpointId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const approvalId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const abandonReason = "explicit-user-approval";
    seedRootStart(connection);

    rawEvent(connection, 2, {
      streamType: "session",
      sessionId: ROOT_ID,
      streamVersion: 2,
      eventType: "SessionEndRequested",
      commandId: eventCommandId(2),
      lifecycleIntent: requestIntentWitness(eventCommandId(2)),
      payload: {
        workflowId: PROJECTION_WORKFLOW_ID,
        workflowGeneration: 1,
        previousState: "active",
        childEndPolicy: "require-completed",
        qualityThreshold: 0,
        requireFullEvidence: false,
        requireMaterialization: false,
      },
    });
    rawEvent(connection, 3, {
      streamType: "session",
      sessionId: ROOT_ID,
      streamVersion: 3,
      eventType: "SessionEndRequested",
      commandId: eventCommandId(3),
      lifecycleIntent: requestIntentWitness(eventCommandId(3)),
      payload: {
        workflowId: workflowB,
        workflowGeneration: 1,
        previousState: "active",
        childEndPolicy: "require-completed",
        qualityThreshold: 0,
        requireFullEvidence: false,
        requireMaterialization: false,
      },
    });
    rawEvent(connection, 4, {
      streamType: "session",
      sessionId: ROOT_ID,
      streamVersion: 4,
      eventType: "SessionEndCancelled",
      commandId: eventCommandId(4),
      lifecycleIntent: cancelIntentWitness(
        eventCommandId(4),
        PROJECTION_WORKFLOW_ID,
        "3",
        checkpointId,
      ),
      payload: {
        workflowId: PROJECTION_WORKFLOW_ID,
        workflowGeneration: 1,
        restoredState: "active",
        preTransitionCheckpointId: checkpointId,
      },
    });
    rawEvent(connection, 5, {
      streamType: "session",
      sessionId: ROOT_ID,
      streamVersion: 5,
      eventType: "SessionEndRequested",
      commandId: eventCommandId(5),
      lifecycleIntent: requestIntentWitness(eventCommandId(5)),
      payload: {
        workflowId: PROJECTION_WORKFLOW_ID,
        workflowGeneration: 2,
        previousState: "active",
        childEndPolicy: "require-completed",
        qualityThreshold: 0,
        requireFullEvidence: false,
        requireMaterialization: false,
      },
    });
    rawEvent(connection, 6, {
      streamType: "session",
      sessionId: ROOT_ID,
      streamVersion: 6,
      eventType: "SessionAbandoned",
      commandId: eventCommandId(6),
      lifecycleIntent: abandonIntentWitness(
        eventCommandId(6),
        "5",
        checkpointId,
        abandonReason,
      ),
      payload: {
        workflowId: PROJECTION_WORKFLOW_ID,
        workflowGeneration: 2,
        approvalId,
        preTransitionCheckpointId: checkpointId,
        reasonCode: abandonReason,
        authorityCommitment: H64,
      },
    });
    const childFork = lifecycleEvent(7, "SessionForked", {}, {
      projectId: PROJECT_ID as never,
      vaultId: VAULT_ID as never,
      storeId: STORE_ID as never,
      workspaceId: WORKSPACE_ID as never,
      sessionId: CHILD_ID as never,
      parentSessionId: ROOT_ID as never,
      globalPosition: 7,
      streamVersion: 1,
      authorityCommitment: H64,
    });
    rawEvent(connection, 7, {
      streamType: "session",
      sessionId: CHILD_ID,
      parentSessionId: ROOT_ID,
      streamVersion: 1,
      eventType: "SessionForked",
      payload: childFork.payload,
    });
    const childCheckpoint = checkpointFixture({
      checkpointId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" as never,
      sessionId: CHILD_ID as never,
      parentSessionId: ROOT_ID as never,
      baseEventPosition: 7,
      checkpointEventPosition: 8,
    });
    rawEvent(connection, 8, {
      streamType: "session",
      sessionId: CHILD_ID,
      parentSessionId: ROOT_ID,
      streamVersion: 2,
      eventType: "SessionCheckpointRecorded",
      payload: {
        checkpoint: childCheckpoint,
        baseEventPosition: "7",
        checkpointEventPosition: "8",
      },
    });
    rawInsert(connection, "workflow_instances", legacyLifecycleWorkflow({
      workflow_id: PROJECTION_WORKFLOW_ID,
      generation: 2,
      state: "completed",
      phase: "abandoned",
      root_command_id: eventCommandId(6),
      session_id: ROOT_ID,
      triggering_event_position: 6,
    }));
    rawInsert(connection, "workflow_instances", legacyLifecycleWorkflow({
      workflow_id: workflowB,
      generation: 1,
      state: "active",
      phase: "requested",
      root_command_id: eventCommandId(3),
      session_id: ROOT_ID,
      triggering_event_position: 3,
    }));

    new MigrationRunner().apply(connection, registry, NOW, mode({
      kind: "explicit-upgrade",
      expectedAppliedVersion: 2,
      beforeMigration(candidate: SqliteConnection, migration: { version: number }): void {
        if (migration.version === 3) {
          new SqliteQualifiedCheckpointMigrationPreflight()
            .assertEligibleAndStage(candidate, context);
          const marker = candidate.prepare(`
            SELECT workflow_generation_row_count
            FROM qualified_checkpoint_v3_stage_marker
          `).get();
          assert.equal(marker?.workflow_generation_row_count, 3n);
        }
      },
    }));

    const rows = connection.prepare(`
      SELECT * FROM lifecycle_workflow_generation_folds
      ORDER BY trigger_event_position
    `).all();
    assert.equal(rows.length, 3);
    const [workflowBGenerationOne, workflowAGenerationOne, workflowAGenerationTwo]
      = rows;
    assert.equal(workflowBGenerationOne?.workflow_id, workflowB);
    assert.equal(workflowBGenerationOne?.trigger_event_position, 3n);
    assert.equal(workflowAGenerationOne?.workflow_id, PROJECTION_WORKFLOW_ID);
    assert.equal(workflowAGenerationOne?.workflow_generation, 1n);
    assert.equal(workflowAGenerationOne?.trigger_event_position, 4n);
    assert.equal(workflowAGenerationOne?.replacement_checkpoint_version, null);
    assert.equal(workflowAGenerationOne?.effective_draft_source_event_position, 2n);
    assert.equal(workflowAGenerationOne?.previous_fingerprint, null);
    assert.equal(
      workflowAGenerationOne?.fingerprint,
      referenceWorkflowGenerationFingerprint({
        projectId: PROJECT_ID,
        workflowId: PROJECTION_WORKFLOW_ID,
        workflowGeneration: 1,
        sessionId: ROOT_ID,
        triggerEventPosition: 4n,
        rootCommandId: eventCommandId(4),
        evidenceWindowState: "sealed",
        replacementCheckpointVersion: null,
        effectiveCheckpointVersion: 1,
        effectiveDraftSourceEventPosition: 2n,
        previousFingerprint: null,
      }),
    );
    assert.equal(workflowAGenerationTwo?.workflow_id, PROJECTION_WORKFLOW_ID);
    assert.equal(workflowAGenerationTwo?.workflow_generation, 2n);
    assert.equal(workflowAGenerationTwo?.trigger_event_position, 6n);
    assert.equal(workflowAGenerationTwo?.replacement_checkpoint_version, null);
    assert.equal(workflowAGenerationTwo?.effective_draft_source_event_position, 5n);
    assert.equal(
      workflowAGenerationTwo?.previous_fingerprint,
      workflowAGenerationOne?.fingerprint,
    );
    assert.equal(
      workflowAGenerationTwo?.fingerprint,
      referenceWorkflowGenerationFingerprint({
        projectId: PROJECT_ID,
        workflowId: PROJECTION_WORKFLOW_ID,
        workflowGeneration: 2,
        sessionId: ROOT_ID,
        triggerEventPosition: 6n,
        rootCommandId: eventCommandId(6),
        evidenceWindowState: "sealed",
        replacementCheckpointVersion: null,
        effectiveCheckpointVersion: 1,
        effectiveDraftSourceEventPosition: 5n,
        previousFingerprint: String(workflowAGenerationOne?.fingerprint),
      }),
    );
    const childRows = connection.prepare(`
      SELECT event_position, stream_version
      FROM lifecycle_child_event_folds
      WHERE project_id = $projectId AND child_session_id = $childSessionId
      ORDER BY stream_version
    `).all({
      $projectId: PROJECT_ID,
      $childSessionId: CHILD_ID,
    }).map((row) => ({ ...row }));
    assert.deepEqual(childRows, [
      { event_position: 7n, stream_version: 1n },
      { event_position: 8n, stream_version: 2n },
    ]);
  });
});
