import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { PROJECT_MEMORY_APPLICATION_ID } from "../src/orchestrator/runtime/runtime-capabilities.js";
import {
  MigrationRunner,
  migrationChecksum,
} from "../src/orchestrator/storage/migration-runner.js";
import { eventCoreMigration } from "../src/orchestrator/storage/migrations/0001-event-core.js";
import { sessionLifecycleMigration } from "../src/orchestrator/storage/migrations/0002-session-lifecycle.js";
import {
  CURRENT_PROJECT_STORE_SCHEMA_VERSION,
  PROJECT_STORE_MIGRATIONS,
} from "../src/orchestrator/storage/migrations/registry.js";
import {
  inspectStoreSchema,
  requireCurrentStoreSchema,
} from "../src/orchestrator/storage/schema-compatibility.js";
import {
  expectedSchemaFingerprint,
  expectedSchemaFingerprintAtVersion,
} from "../src/orchestrator/storage/schema-fingerprint.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import type { SqliteConnection } from "../src/orchestrator/storage/sqlite-driver.js";

const NOW = "2026-07-14T00:00:00.000Z";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const VAULT_ID = "22222222-2222-4222-8222-222222222222";
const STORE_ID = "33333333-3333-4333-8333-333333333333";
const driver = new NodeSqliteDriver({ DatabaseSync });
const connections: SqliteConnection[] = [];
const roots: string[] = [];

function emptyConnection(): SqliteConnection {
  const root = mkdtempSync(join(tmpdir(), "migration-registry-"));
  roots.push(root);
  const connection = driver.open(join(root, "events.sqlite"), {
    mode: "create",
    busyTimeoutMs: 1_000,
  });
  connections.push(connection);
  return connection;
}

function addIdentity(connection: SqliteConnection, schemaVersion: number): void {
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

function v1Connection(): SqliteConnection {
  const connection = emptyConnection();
  new MigrationRunner().apply(
    connection,
    [eventCoreMigration],
    NOW,
    { kind: "bootstrap-empty" },
  );
  addIdentity(connection, 1);
  return connection;
}

function currentConnection(): SqliteConnection {
  const connection = emptyConnection();
  new MigrationRunner().apply(
    connection,
    PROJECT_STORE_MIGRATIONS,
    NOW,
    { kind: "bootstrap-empty" },
  );
  addIdentity(connection, CURRENT_PROJECT_STORE_SCHEMA_VERSION);
  return connection;
}

function dropHistoryGuards(connection: SqliteConnection): void {
  connection.exec(`
    DROP TRIGGER schema_migrations_no_update;
    DROP TRIGGER schema_migrations_no_delete;
  `);
}

afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("project-store migration registry", () => {
  it("is the frozen, contiguous, uniquely named current-schema authority", () => {
    assert.equal(Object.isFrozen(PROJECT_STORE_MIGRATIONS), true);
    assert.deepEqual(PROJECT_STORE_MIGRATIONS, [
      eventCoreMigration,
      sessionLifecycleMigration,
    ]);
    assert.equal(CURRENT_PROJECT_STORE_SCHEMA_VERSION, 2);
    assert.deepEqual(
      PROJECT_STORE_MIGRATIONS.map((migration) => migration.version),
      [1, 2],
    );
    assert.equal(
      new Set(PROJECT_STORE_MIGRATIONS.map((migration) => migration.name)).size,
      PROJECT_STORE_MIGRATIONS.length,
    );
    for (const [index, migration] of PROJECT_STORE_MIGRATIONS.entries()) {
      assert.equal(migration.version, index + 1);
      assert.equal(migration.name, migration.name.trim());
      assert.notEqual(migration.name, "");
    }
  });

  it("accepts only an exact immutable prefix and requires an explicit upgrade", () => {
    const connection = v1Connection();
    const inspection = inspectStoreSchema(connection);
    assert.equal(inspection.status, "upgrade-required");
    assert.equal(inspection.appliedVersion, 1);
    assert.equal(inspection.targetVersion, 2);
    assert.deepEqual(
      inspection.pending.map(({ version, name, checksum }) => ({ version, name, checksum })),
      [{
        version: 2,
        name: sessionLifecycleMigration.name,
        checksum: migrationChecksum(sessionLifecycleMigration),
      }],
    );
    assert.equal(
      inspection.observedFingerprint,
      expectedSchemaFingerprintAtVersion(PROJECT_STORE_MIGRATIONS, 1, DatabaseSync),
    );
    assert.equal(inspection.expectedFingerprint, inspection.observedFingerprint);
    assert.throws(
      () => requireCurrentStoreSchema(inspection),
      /SCHEMA_UPGRADE_REQUIRED/,
    );
  });

  it("reports the complete registry as current", () => {
    const inspection = inspectStoreSchema(currentConnection());
    assert.equal(inspection.status, "current");
    assert.equal(inspection.appliedVersion, 2);
    assert.equal(inspection.targetVersion, 2);
    assert.deepEqual(inspection.pending, []);
    assert.equal(requireCurrentStoreSchema(inspection), inspection);
    assert.equal(
      inspection.expectedFingerprint,
      expectedSchemaFingerprint(PROJECT_STORE_MIGRATIONS, DatabaseSync),
    );
  });

  it("rejects a future recorded version before interpreting it as prefix drift", () => {
    const connection = currentConnection();
    dropHistoryGuards(connection);
    connection.prepare(`
      INSERT INTO schema_migrations(version, name, checksum, applied_at)
      VALUES (3, 'future', $checksum, $appliedAt)
    `).run({ $checksum: "f".repeat(64), $appliedAt: NOW });
    assert.throws(() => inspectStoreSchema(connection), /SCHEMA_TOO_NEW/);
  });

  it("maps gaps, name changes, and checksum changes to immutable-prefix mismatch", () => {
    for (const corrupt of [
      (connection: SqliteConnection): void => {
        connection.exec("DELETE FROM schema_migrations WHERE version = 1");
      },
      (connection: SqliteConnection): void => {
        connection.exec("UPDATE schema_migrations SET name = 'renamed' WHERE version = 1");
      },
      (connection: SqliteConnection): void => {
        connection.prepare(`
          UPDATE schema_migrations SET checksum = $checksum WHERE version = 1
        `).run({ $checksum: "a".repeat(64) });
      },
    ]) {
      const connection = currentConnection();
      dropHistoryGuards(connection);
      corrupt(connection);
      assert.throws(
        () => inspectStoreSchema(connection),
        /MIGRATION_CHECKSUM_MISMATCH/,
      );
    }
  });

  it("rejects exact history whose schema objects drifted", () => {
    const connection = currentConnection();
    connection.exec("DROP INDEX session_authority_safe_resume");
    assert.throws(
      () => inspectStoreSchema(connection),
      /SCHEMA_FINGERPRINT_MISMATCH/,
    );
  });

  it("requires the project identity version to equal the exact applied prefix", () => {
    const connection = currentConnection();
    connection.exec("DROP TRIGGER project_meta_schema_version_monotonic");
    connection.exec("UPDATE project_meta SET schema_version = 1");
    assert.throws(
      () => inspectStoreSchema(connection),
      /PROJECT_SCHEMA_VERSION_MISMATCH/,
    );
  });

  it("validates the complete binary registry before touching SQLite", () => {
    const connection = emptyConnection();
    assert.throws(
      () => new MigrationRunner().apply(
        connection,
        [eventCoreMigration, { ...sessionLifecycleMigration, version: 3 }],
        NOW,
        { kind: "bootstrap-empty" },
      ),
      /MIGRATION_SET_INVALID/,
    );
    assert.equal(
      connection.prepare("PRAGMA application_id").get()?.application_id,
      0n,
    );
    assert.equal(
      connection.prepare(`
        SELECT count(*) AS count FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'
      `).get()?.count,
      0n,
    );
  });

  it("keeps read-only inspection from adopting an empty database", () => {
    const connection = emptyConnection();
    assert.throws(() => inspectStoreSchema(connection), /STORE_APPLICATION_ID_MISMATCH/);
    assert.equal(
      connection.prepare("PRAGMA application_id").get()?.application_id,
      0n,
    );
    assert.equal(PROJECT_MEMORY_APPLICATION_ID > 0, true);
  });
});
