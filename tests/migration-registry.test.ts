import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import type { ProjectContext } from "../src/orchestrator/identity/contracts.js";
import { PROJECT_MEMORY_APPLICATION_ID } from "../src/orchestrator/runtime/runtime-capabilities.js";
import {
  MigrationRunner,
  migrationChecksum,
} from "../src/orchestrator/storage/migration-runner.js";
import { eventCoreMigration } from "../src/orchestrator/storage/migrations/0001-event-core.js";
import { sessionLifecycleMigration } from "../src/orchestrator/storage/migrations/0002-session-lifecycle.js";
import { qualifiedCheckpointCoverageMigration } from "../src/orchestrator/storage/migrations/0003-qualified-checkpoint-coverage.js";
import { sessionEndEffectiveStateMigration } from "../src/orchestrator/storage/migrations/0004-session-end-effective-state.js";
import { sessionEndFinalCheckpointTransitionMigration } from "../src/orchestrator/storage/migrations/0005-session-end-final-checkpoint-transition.js";
import { v2RolloutControlPlaneMigration } from "../src/orchestrator/storage/migrations/0006-v2-rollout-control-plane.js";
import { v2ShadowMigration } from "../src/orchestrator/storage/migrations/0007-v2-shadow-migration.js";
import { v2FreshStartMigration } from "../src/orchestrator/storage/migrations/0008-v2-fresh-start.js";
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
import { SqliteQualifiedCheckpointMigrationPreflight } from "../src/orchestrator/storage/qualified-checkpoint-migration-preflight.js";
import { SqliteSessionEndEffectiveStateMigrationPreflight } from "../src/orchestrator/storage/session-end-effective-state-migration-preflight.js";
import type { SqliteConnection } from "../src/orchestrator/storage/sqlite-driver.js";
import { applyCurrentProjectStoreSchema } from "./support/current-project-store-schema.js";

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
    { kind: "bootstrap-empty", beforeMigration: () => undefined },
  );
  addIdentity(connection, 1);
  return connection;
}

function currentConnection(): SqliteConnection {
  const connection = emptyConnection();
  applyCurrentProjectStoreSchema(connection, {
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
  }, NOW);
  return connection;
}

function schemaSevenConnection(): SqliteConnection {
  const connection = emptyConnection();
  const context = { binding: { projectId: PROJECT_ID, vaultId: VAULT_ID, storeId: STORE_ID } } as ProjectContext;
  const qualified = new SqliteQualifiedCheckpointMigrationPreflight();
  const sessionEnd = new SqliteSessionEndEffectiveStateMigrationPreflight();
  new MigrationRunner().apply(connection, PROJECT_STORE_MIGRATIONS.slice(0, 7), NOW, {
    kind: "bootstrap-empty",
    beforeMigration(migrationConnection, migration): void {
      if (migration.version === 3) {
        migrationConnection.prepare(`INSERT INTO project_meta(
          singleton, project_id, vault_id, store_id, schema_version, created_at
        ) VALUES (1, $projectId, $vaultId, $storeId, 2, $createdAt)`).run({
          $projectId: PROJECT_ID, $vaultId: VAULT_ID, $storeId: STORE_ID, $createdAt: NOW,
        });
        migrationConnection.exec(`INSERT INTO maintenance_state(
          singleton, epoch, mode, owner_id, fencing_token, lease_expires_at, requested_at
        ) VALUES (1, 0, 'idle', NULL, 0, NULL, NULL)`);
        qualified.assertEligibleAndStage(migrationConnection, context);
      }
      if (migration.version === 4) sessionEnd.assertEligible(migrationConnection, context);
    },
  });
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
  it("expects exact migrations 0001 through 0008 and preserves frozen checksums", () => {
    assert.equal(Object.isFrozen(PROJECT_STORE_MIGRATIONS), true);
    assert.deepEqual(PROJECT_STORE_MIGRATIONS, [
      eventCoreMigration,
      sessionLifecycleMigration,
      qualifiedCheckpointCoverageMigration,
      sessionEndEffectiveStateMigration,
      sessionEndFinalCheckpointTransitionMigration,
      v2RolloutControlPlaneMigration,
      v2ShadowMigration,
      v2FreshStartMigration,
    ]);
    assert.equal(PROJECT_STORE_MIGRATIONS[5]?.name, "v2-rollout-control-plane");
    assert.equal(CURRENT_PROJECT_STORE_SCHEMA_VERSION, 8);
    assert.deepEqual(PROJECT_STORE_MIGRATIONS.map(({ name }) => name), [
      "event-core", "session-lifecycle", "qualified-checkpoint-coverage",
      "session-end-effective-state", "session-end-final-checkpoint-transition",
      "v2-rollout-control-plane", "v2-shadow-migration", "v2-fresh-start",
    ]);
    assert.deepEqual(PROJECT_STORE_MIGRATIONS.map(migrationChecksum), [
      "f1964555526ba3fabb47e652eb022bb5c16a346f99c38a85454238f59ad5b8de",
      "85666a0bdee4455068f03a81e9d3720df172d15fce6d8e6f0cb3f5f7d0a81293",
      "71f32239e9354fbf317a39b7661937cd036d6c13196f44e042fa128305da2dac",
      "4d1d13827d12b0d667eb2d7250a5bd4335dc51204b1654a6ee040ec4cc4381ef",
      "9b0dda728c8a5679e70657f9bd129b3a8f8685aaf26beecc99729aa9e425bc64",
      "27dd709cb8653dacb2859e52fc5be6221e5bdb0fa6061ae3ea0f53b9596abc24",
      "fc3becb6329a7bcbc9c6775c436260a61cca6dffa432f8817bc583623df2c32a",
      migrationChecksum(v2FreshStartMigration),
    ]);
    assert.equal(
      migrationChecksum(sessionLifecycleMigration),
      "85666a0bdee4455068f03a81e9d3720df172d15fce6d8e6f0cb3f5f7d0a81293",
    );
    assert.equal(
      migrationChecksum(sessionEndEffectiveStateMigration),
      "4d1d13827d12b0d667eb2d7250a5bd4335dc51204b1654a6ee040ec4cc4381ef",
    );
    assert.deepEqual(
      PROJECT_STORE_MIGRATIONS.map((migration) => migration.version),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    assert.equal(
      createHash("sha256").update(readFileSync(resolve(
        "src/orchestrator/storage/migrations/0002-session-lifecycle.ts",
      ))).digest("hex").toUpperCase(),
      "68B4039048A359C523B7842F6D17BAA5760E9760D2B4E9F80BB8A48DC339EB06",
    );
    assert.equal(
      createHash("sha256").update(readFileSync(resolve(
        "src/orchestrator/storage/migrations/0003-qualified-checkpoint-coverage.ts",
      ))).digest("hex").toUpperCase(),
      "C023A8EDB88A94B749D4837F7300A76D081C843BF41BE058C3AA4AD5D6A158C4",
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
    assert.equal(inspection.targetVersion, 8);
    assert.deepEqual(
      inspection.pending.map(({ version, name, checksum }) => ({ version, name, checksum })),
      [{
        version: 2,
        name: sessionLifecycleMigration.name,
        checksum: migrationChecksum(sessionLifecycleMigration),
      }, {
        version: 3,
        name: qualifiedCheckpointCoverageMigration.name,
        checksum: migrationChecksum(qualifiedCheckpointCoverageMigration),
      }, {
        version: 4,
        name: sessionEndEffectiveStateMigration.name,
        checksum: migrationChecksum(sessionEndEffectiveStateMigration),
      }, {
        version: 5,
        name: sessionEndFinalCheckpointTransitionMigration.name,
        checksum: migrationChecksum(sessionEndFinalCheckpointTransitionMigration),
      }, {
        version: 6,
        name: "v2-rollout-control-plane",
        checksum: migrationChecksum(PROJECT_STORE_MIGRATIONS[5]!),
      }, {
        version: 7,
        name: "v2-shadow-migration",
        checksum: migrationChecksum(v2ShadowMigration),
      }, {
        version: 8,
        name: "v2-fresh-start",
        checksum: migrationChecksum(v2FreshStartMigration),
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
    const connection = currentConnection();
    const inspection = inspectStoreSchema(connection);
    assert.deepEqual(
      connection.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all()
        .map(({ version, name, checksum }) => ({ version: Number(version), name, checksum })),
      PROJECT_STORE_MIGRATIONS.map((migration) => ({
        version: migration.version, name: migration.name, checksum: migrationChecksum(migration),
      })),
    );
    assert.equal(inspection.status, "current");
    assert.equal(inspection.appliedVersion, 8);
    assert.equal(inspection.targetVersion, 8);
    assert.deepEqual(inspection.pending, []);
    assert.equal(requireCurrentStoreSchema(inspection), inspection);
    assert.equal(
      inspection.expectedFingerprint,
      expectedSchemaFingerprint(PROJECT_STORE_MIGRATIONS, DatabaseSync),
    );
  });

  it("upgrades an old-profile schema-7 store additively and preserves its rows", () => {
    const connection = schemaSevenConnection();
    const oldRollout = connection.prepare("SELECT * FROM rollout_control_state").all();
    const oldChecksums = connection.prepare("SELECT checksum FROM schema_migrations WHERE version <= 7 ORDER BY version").all();
    assert.equal(inspectStoreSchema(connection).status, "upgrade-required");
    const applied = new MigrationRunner().apply(connection, PROJECT_STORE_MIGRATIONS, NOW, {
      kind: "explicit-upgrade", expectedAppliedVersion: 7, beforeMigration: () => undefined,
    });
    assert.deepEqual(applied, [8]);
    assert.deepEqual(connection.prepare("SELECT * FROM rollout_control_state").all(), oldRollout);
    assert.deepEqual(connection.prepare("SELECT checksum FROM schema_migrations WHERE version <= 7 ORDER BY version").all(), oldChecksums);
    for (const table of ["fresh_start_installation", "fresh_start_releases", "fresh_start_transitions", "fresh_start_control_state"]) {
      assert.equal(connection.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n, 0n);
    }
    assert.equal(inspectStoreSchema(connection).status, "current");
  });

  it("rejects a future recorded version before interpreting it as prefix drift", () => {
    const connection = currentConnection();
    dropHistoryGuards(connection);
    connection.prepare(`
      INSERT INTO schema_migrations(version, name, checksum, applied_at)
      VALUES (9, 'future', $checksum, $appliedAt)
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

  it("rejects a published migration prefix without exactly one project identity", () => {
    const connection = emptyConnection();
    new MigrationRunner().apply(
      connection,
      [eventCoreMigration],
      NOW,
      { kind: "bootstrap-empty", beforeMigration: () => undefined },
    );

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
        { kind: "bootstrap-empty", beforeMigration: () => undefined },
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
