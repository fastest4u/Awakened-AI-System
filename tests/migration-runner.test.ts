import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import {
  DEFAULT_BUSY_TIMEOUT_MS,
  PROJECT_MEMORY_APPLICATION_ID,
} from "../src/orchestrator/runtime/runtime-capabilities.js";
import { MigrationRunner, migrationChecksum } from "../src/orchestrator/storage/migration-runner.js";
import { eventCoreMigration } from "../src/orchestrator/storage/migrations/0001-event-core.js";
import { sessionLifecycleMigration } from "../src/orchestrator/storage/migrations/0002-session-lifecycle.js";
import { PROJECT_STORE_MIGRATIONS } from "../src/orchestrator/storage/migrations/registry.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import { SqliteQualifiedCheckpointMigrationPreflight } from "../src/orchestrator/storage/qualified-checkpoint-migration-preflight.js";
import type { ProjectContext } from "../src/orchestrator/identity/contracts.js";

const roots: string[] = [];
const driver = new NodeSqliteDriver({ DatabaseSync });

function databasePath(): string {
  const root = mkdtempSync(join(tmpdir(), "memory-migrations-"));
  roots.push(root);
  return join(root, "events.sqlite");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("MigrationRunner", () => {
  it("applies the checksummed event core once and makes migration history immutable", () => {
    const connection = driver.open(databasePath(), {
      mode: "create",
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    });
    try {
      const runner = new MigrationRunner();
      const applied = runner.apply(
        connection,
        [eventCoreMigration],
        "2026-07-11T00:00:00.000Z",
        { kind: "bootstrap-empty", beforeMigration: () => undefined },
      );
      assert.deepEqual(applied, [1]);
      connection.exec(`
        INSERT INTO project_meta(
          singleton, project_id, vault_id, store_id, schema_version, created_at
        ) VALUES (
          1,
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
          '33333333-3333-4333-8333-333333333333',
          1,
          '2026-07-11T00:00:00.000Z'
        )
      `);
      assert.deepEqual(
        runner.apply(
          connection,
          [eventCoreMigration],
          "2026-07-11T00:00:01.000Z",
          { kind: "explicit-upgrade", expectedAppliedVersion: 1, beforeMigration: () => undefined },
        ),
        [],
      );
      assert.throws(
        () => runner.apply(
          connection,
          [eventCoreMigration],
          "2026-07-11T00:00:01.500Z",
          { kind: "explicit-upgrade", expectedAppliedVersion: 0, beforeMigration: () => undefined },
        ),
        /MIGRATION_EXPECTED_VERSION_MISMATCH/,
      );
      assert.equal(
        connection.prepare("SELECT checksum FROM schema_migrations WHERE version = 1").get()?.checksum,
        migrationChecksum(eventCoreMigration),
      );
      assert.throws(
        () => connection.exec("UPDATE schema_migrations SET name='changed' WHERE version=1"),
        /SCHEMA_MIGRATIONS_IMMUTABLE/,
      );
      assert.throws(
        () => runner.apply(connection, [{
          ...eventCoreMigration,
          sql: `${eventCoreMigration.sql}\nSELECT 1;`,
        }], "2026-07-11T00:00:02.000Z", {
          kind: "explicit-upgrade",
          beforeMigration: () => undefined,
          expectedAppliedVersion: 1,
        }),
        /MIGRATION_CHECKSUM_MISMATCH/,
      );
    } finally {
      connection.close();
    }
  });

  it("validates the complete migration list before touching SQLite", () => {
    const connection = driver.open(databasePath(), {
      mode: "create",
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    });
    try {
      const runner = new MigrationRunner();
      for (const migrations of [
        [{ ...eventCoreMigration, version: 0 }],
        [eventCoreMigration, { ...eventCoreMigration, version: 2 }],
        [{ ...eventCoreMigration, name: "" }],
        [eventCoreMigration, { ...eventCoreMigration, version: 2, sql: "SELECT 1;" }],
        [{ ...eventCoreMigration, version: 2 }, eventCoreMigration],
      ]) {
        assert.throws(
          () => runner.apply(
            connection,
            migrations,
            "2026-07-11T00:00:00.000Z",
            { kind: "bootstrap-empty", beforeMigration: () => undefined },
          ),
          /MIGRATION_SET_INVALID/,
        );
      }
      assert.equal(
        connection.prepare("PRAGMA application_id").get()?.application_id,
        0n,
      );
      assert.equal(
        connection.prepare("SELECT count(*) AS count FROM sqlite_schema").get()?.count,
        0n,
      );
    } finally {
      connection.close();
    }
  });

  it("rolls back a failed migration and rejects a schema newer than the binary", () => {
    const connection = driver.open(databasePath(), {
      mode: "create",
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    });
    try {
      const runner = new MigrationRunner();
      assert.throws(
        () => runner.apply(connection, [{
          version: 1,
          name: "broken",
          sql: "CREATE TABLE partial(value TEXT) STRICT; SELECT * FROM missing_table;",
        }], "2026-07-11T00:00:00.000Z", {
          kind: "bootstrap-empty", beforeMigration: () => undefined,
        }),
      );
      assert.equal(
        connection.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name = $name").get({
          $name: "partial",
        })?.count,
        0n,
      );

      connection.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          checksum TEXT NOT NULL,
          applied_at TEXT NOT NULL
        ) STRICT;
      `);
      connection.prepare(`
        INSERT INTO schema_migrations(version, name, checksum, applied_at)
        VALUES ($version, $name, $checksum, $appliedAt)
      `).run({
        $version: 2,
        $name: "future",
        $checksum: "f".repeat(64),
        $appliedAt: "2026-07-11T00:00:00.000Z",
      });
      connection.exec(`PRAGMA application_id = ${PROJECT_MEMORY_APPLICATION_ID}`);
      assert.throws(
        () => runner.apply(
          connection,
          [eventCoreMigration],
          "2026-07-11T00:00:01.000Z",
          { kind: "explicit-upgrade", expectedAppliedVersion: 1, beforeMigration: () => undefined },
        ),
        /SCHEMA_TOO_NEW/,
      );
    } finally {
      connection.close();
    }
  });

  it("creates only the strict event-core schema and enforces every immutable identity guard", () => {
    const connection = driver.open(databasePath(), {
      mode: "create",
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    });
    try {
      new MigrationRunner().apply(
        connection,
        [eventCoreMigration],
        "2026-07-11T00:00:00.000Z",
        { kind: "bootstrap-empty", beforeMigration: () => undefined },
      );
      const requiredTables = [
        "branch_scopes",
        "command_dedup",
        "events",
        "executor_leases",
        "maintenance_acknowledgements",
        "maintenance_required_executors",
        "maintenance_state",
        "outbox",
        "project_meta",
        "schema_migrations",
        "streams",
        "workflow_instances",
      ];
      const tableRows = connection.prepare("PRAGMA table_list").all();
      for (const table of requiredTables) {
        const row = tableRows.find((candidate) => candidate.name === table);
        assert.equal(row?.strict, 1n, `${table} must be STRICT`);
      }
      const commandColumns = connection.prepare("PRAGMA table_info(command_dedup)").all();
      assert.deepEqual(
        commandColumns.map((row) => row.name),
        [
          "project_id",
          "idempotency_key",
          "command_id",
          "command_type",
          "command_hash",
          "workspace_head_commit",
          "outbox_order_json",
          "state",
          "first_global_position",
          "last_global_position",
          "final_stream_version",
          "event_ids_json",
          "response_json",
          "response_hash",
          "committed_at",
        ],
      );
      for (const forbidden of [
        "evidence",
        "projection_state",
        "session_authority",
        "session_leases",
      ]) {
        assert.equal(tableRows.some((row) => row.name === forbidden), false);
      }
      assert.deepEqual(
        connection.prepare(`
          SELECT name FROM sqlite_schema WHERE type = 'trigger' ORDER BY name
        `).all().map((row) => row.name),
        [
          "command_dedup_no_delete",
          "command_dedup_no_update",
          "events_identity_guard",
          "events_no_delete",
          "events_no_update",
          "project_meta_no_delete",
          "project_meta_no_update",
          "schema_migrations_no_delete",
          "schema_migrations_no_update",
        ],
      );

      connection.prepare(`
        INSERT INTO project_meta(
          singleton, project_id, vault_id, store_id, schema_version, created_at
        ) VALUES (1, $projectId, $vaultId, $storeId, 1, $createdAt)
      `).run({
        $projectId: "11111111-1111-4111-8111-111111111111",
        $vaultId: "22222222-2222-4222-8222-222222222222",
        $storeId: "33333333-3333-4333-8333-333333333333",
        $createdAt: "2026-07-11T00:00:00.000Z",
      });
      assert.throws(
        () => connection.exec("UPDATE project_meta SET schema_version = 2"),
        /PROJECT_META_IMMUTABLE/,
      );
      connection.exec(`
        INSERT INTO streams(
          project_id, stream_id, stream_type, current_version, created_at, updated_at
        ) VALUES (
          '11111111-1111-4111-8111-111111111111', 'stream-1', 'task', 0,
          '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z'
        );
      `);
      const insertEvent = connection.prepare(`
        INSERT INTO events(
          global_position, event_id, project_id, vault_id, store_id, workspace_id,
          branch_scope_id, branch_ref, stream_id, stream_type, stream_version,
          event_type, event_schema_version, session_id, parent_session_id,
          actor_role, agent_id, client_instance_id, correlation_id, causation_id,
          command_id, idempotency_key, command_event_index, occurred_at, recorded_at,
          visibility_scope, confidence, verification_status, source_refs_json,
          evidence_refs_json, evidence_digests_json, payload_json, payload_hash,
          previous_global_hash, event_hash
        ) VALUES (
          $position, $eventId, '11111111-1111-4111-8111-111111111111', $vaultId,
          '33333333-3333-4333-8333-333333333333', 'workspace-1', NULL, NULL,
          'stream-1', 'task', $position, 'TaskRecorded', 1, NULL, NULL,
          'primary', 'agent-1', 'client-1', 'correlation-1', NULL,
          $commandId, $idempotencyKey, 0,
          '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z',
          'project', 'high', 'verified', '[]', '[]', '[]', '{}',
          $payloadHash, $previousHash, $eventHash
        )
      `);
      const hashes = {
        $payloadHash: "a".repeat(64),
        $previousHash: "0".repeat(64),
        $eventHash: "b".repeat(64),
      };
      assert.throws(() => insertEvent.run({
        $position: 1,
        $eventId: "event-wrong",
        $vaultId: "99999999-9999-4999-8999-999999999999",
        $commandId: "command-wrong",
        $idempotencyKey: "idempotency-wrong",
        ...hashes,
      }), /EVENT_PROJECT_IDENTITY_MISMATCH/);
      insertEvent.run({
        $position: 1,
        $eventId: "event-1",
        $vaultId: "22222222-2222-4222-8222-222222222222",
        $commandId: "command-1",
        $idempotencyKey: "idempotency-1",
        ...hashes,
      });
      assert.throws(
        () => connection.exec("UPDATE events SET confidence = 'low'"),
        /EVENTS_IMMUTABLE/,
      );

      connection.exec(`
        INSERT INTO command_dedup(
          project_id, idempotency_key, command_id, command_type, command_hash,
          workspace_head_commit, outbox_order_json, state,
          first_global_position, last_global_position, final_stream_version,
          event_ids_json, response_json, response_hash, committed_at
        ) VALUES (
          '11111111-1111-4111-8111-111111111111', 'idempotency-1', 'command-1',
          'record', '${"c".repeat(64)}', NULL, '[]', 'committed', 1, 1, 1,
          '["event-1"]', '{}', '${"d".repeat(64)}', '2026-07-11T00:00:00.000Z'
        );
      `);
      assert.throws(
        () => connection.exec("DELETE FROM command_dedup"),
        /COMMAND_DEDUP_IMMUTABLE/,
      );
    } finally {
      connection.close();
    }
  });

  it("rolls back every pending DDL, history, and project-version change atomically", () => {
    const connection = driver.open(databasePath(), {
      mode: "create",
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    });
    try {
      const runner = new MigrationRunner();
      runner.apply(
        connection,
        [eventCoreMigration],
        "2026-07-11T00:00:00.000Z",
        { kind: "bootstrap-empty", beforeMigration: () => undefined },
      );
      connection.exec(`
        INSERT INTO project_meta(
          singleton, project_id, vault_id, store_id, schema_version, created_at
        ) VALUES (
          1,
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
          '33333333-3333-4333-8333-333333333333',
          1,
          '2026-07-11T00:00:00.000Z'
        );
        INSERT INTO maintenance_state(
          singleton, epoch, mode, owner_id, fencing_token, lease_expires_at, requested_at
        ) VALUES (1, 0, 'idle', NULL, 0, NULL, NULL);
      `);

      const injectedFailure = {
        ...sessionLifecycleMigration,
        sql: `${sessionLifecycleMigration.sql}\n`
          + "CREATE TABLE rollback_witness(value TEXT) STRICT;\n"
          + "SELECT * FROM injected_missing_table;",
      };
      assert.throws(() => runner.apply(
        connection,
        [eventCoreMigration, injectedFailure],
        "2026-07-11T00:00:01.000Z",
        { kind: "explicit-upgrade", expectedAppliedVersion: 1, beforeMigration: () => undefined },
      ));
      assert.deepEqual(
        connection.prepare("SELECT version FROM schema_migrations ORDER BY version")
          .all().map((row) => row.version),
        [1n],
      );
      assert.equal(
        connection.prepare("SELECT schema_version FROM project_meta").get()?.schema_version,
        1n,
      );
      assert.equal(
        connection.prepare(`
          SELECT count(*) AS count FROM sqlite_schema
          WHERE name IN ('session_authority', 'rollback_witness')
        `).get()?.count,
        0n,
      );
      assert.equal(
        connection.prepare(`
          SELECT count(*) AS count FROM sqlite_schema
          WHERE type = 'trigger' AND name = 'project_meta_no_update'
        `).get()?.count,
        1n,
      );

      assert.deepEqual(runner.apply(
        connection,
        PROJECT_STORE_MIGRATIONS,
        "2026-07-11T00:00:02.000Z",
        {
          kind: "explicit-upgrade",
          expectedAppliedVersion: 1,
          beforeMigration: (migrationConnection, migration) => {
            if (migration.version !== 3) return;
            new SqliteQualifiedCheckpointMigrationPreflight().assertEligibleAndStage(
              migrationConnection,
              {
                binding: {
                  projectId: "11111111-1111-4111-8111-111111111111",
                  vaultId: "22222222-2222-4222-8222-222222222222",
                  storeId: "33333333-3333-4333-8333-333333333333",
                },
              } as ProjectContext,
            );
          },
        },
      ), [2, 3]);
      assert.equal(
        connection.prepare("SELECT schema_version FROM project_meta").get()?.schema_version,
        3n,
      );
    } finally {
      connection.close();
    }
  });

  it("rejects an identity-less explicit upgrade without applying pending schema", () => {
    const connection = driver.open(databasePath(), {
      mode: "create",
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    });
    try {
      const runner = new MigrationRunner();
      runner.apply(
        connection,
        [eventCoreMigration],
        "2026-07-11T00:00:00.000Z",
        { kind: "bootstrap-empty", beforeMigration: () => undefined },
      );

      assert.throws(
        () => runner.apply(
          connection,
          PROJECT_STORE_MIGRATIONS,
          "2026-07-11T00:00:01.000Z",
          { kind: "explicit-upgrade", expectedAppliedVersion: 1, beforeMigration: () => undefined },
        ),
        /PROJECT_SCHEMA_VERSION_MISMATCH/,
      );
      assert.deepEqual(
        connection.prepare("SELECT version FROM schema_migrations ORDER BY version")
          .all().map((row) => row.version),
        [1n],
      );
      assert.equal(
        connection.prepare(`
          SELECT count(*) AS count FROM sqlite_schema
          WHERE name = 'session_authority'
        `).get()?.count,
        0n,
      );
    } finally {
      connection.close();
    }
  });
});
