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
const H64 = "a".repeat(64);
const H64_B = "b".repeat(64);
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
  position: number,
  options: {
    readonly streamType?: string;
    readonly sessionId?: string | null;
    readonly eventType?: string;
    readonly eventSchemaVersion?: number;
    readonly payload?: unknown;
    readonly streamVersion?: number;
    readonly parentSessionId?: string | null;
  } = {},
): void {
  const sessionId = options.sessionId ?? null;
  const streamType = options.streamType ?? "generic";
  rawInsert(connection, "events", {
    global_position: position,
    event_id: `${position.toString(16).padStart(8, "0")}-0000-4000-8000-${position.toString(16).padStart(12, "0")}`,
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
    correlation_id: `${(position + 10_000).toString(16).padStart(8, "0")}-0000-4000-8000-${(position + 10_000).toString(16).padStart(12, "0")}`,
    causation_id: null,
    command_id: `${(position + 20_000).toString(16).padStart(8, "0")}-0000-4000-8000-${(position + 20_000).toString(16).padStart(12, "0")}`,
    idempotency_key: `idempotency-${position}`,
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
    assert.equal(connection.prepare(`
      SELECT count(*) AS count FROM sqlite_schema
      WHERE type = 'index' AND name IN (
        'session_evidence_coverage_project_adapter',
        'session_evidence_coverage_transitions_snapshot'
      )
    `).get()?.count, 2n);
    assert.equal(connection.prepare(`
      SELECT count(*) AS count FROM sqlite_schema
      WHERE type = 'trigger' AND name IN (
        'session_evidence_coverage_v3_insert_guard',
        'session_evidence_coverage_v3_update_guard',
        'session_evidence_coverage_no_delete',
        'session_evidence_coverage_transitions_insert_guard',
        'session_evidence_coverage_transitions_no_update',
        'session_evidence_coverage_transitions_no_delete',
        'events_lifecycle_version_v3_guard',
        'workflow_instances_evidence_v3_insert_guard',
        'workflow_instances_evidence_v3_update_guard'
      )
    `).get()?.count, 9n);
    assert.match(
      qualifiedCheckpointCoverageMigration.sql,
      /length\(CAST\(NEW\.final_ending_scope_bindings_json AS BLOB\)\) > 262144/,
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
        highestContiguousOrdinal: null,
        missingIntervals: oneInterval,
      }),
    });
    rawInsert(connection, "session_evidence_coverage_transitions", transitionRow({
      adapter_session_id: secondAdapter,
      batch_id: secondBatch,
      batch_event_position: 2,
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
          highest_contiguous_ordinal: -1,
          missing_intervals_json: oneIntervalJson,
        },
      )),
      /SESSION_EVIDENCE_COVERAGE_INVALID/,
    );
  });
});
