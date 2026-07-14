import { createHash } from "node:crypto";
import { PROJECT_MEMORY_APPLICATION_ID } from "../runtime/runtime-capabilities.js";
import type { SqliteConnection, SqliteRow } from "./sqlite-driver.js";
import type { Migration } from "./migration.js";

export type MigrationErrorCode =
  | "MIGRATION_SET_INVALID"
  | "MIGRATION_CHECKSUM_MISMATCH"
  | "MIGRATION_NAME_MISMATCH"
  | "SCHEMA_TOO_NEW"
  | "STORE_APPLICATION_ID_MISMATCH";

export class MigrationError extends Error {
  constructor(readonly code: MigrationErrorCode, message = code) {
    super(message);
    this.name = "MigrationError";
  }
}

export function migrationChecksum(migration: Migration): string {
  return createHash("sha256").update(migration.sql, "utf8").digest("hex");
}

function fail(code: MigrationErrorCode): never {
  throw new MigrationError(code);
}

function validateMigrations(migrations: readonly Migration[]): void {
  let previousVersion = 0;
  const names = new Set<string>();
  for (const migration of migrations) {
    if (
      !Number.isSafeInteger(migration.version)
      || migration.version <= previousVersion
      || migration.version <= 0
      || migration.name.trim().length === 0
      || migration.name !== migration.name.trim()
      || names.has(migration.name)
      || migration.sql.trim().length === 0
    ) {
      fail("MIGRATION_SET_INVALID");
    }
    previousVersion = migration.version;
    names.add(migration.name);
  }
}

function applicationId(connection: SqliteConnection): number {
  const value = connection.prepare("PRAGMA application_id").get()?.application_id;
  if (typeof value !== "bigint" && typeof value !== "number") {
    fail("STORE_APPLICATION_ID_MISMATCH");
  }
  return Number(value);
}

function tableExists(connection: SqliteConnection, name: string): boolean {
  return connection.prepare(`
    SELECT count(*) AS count
    FROM sqlite_schema
    WHERE type = 'table' AND name = $name
  `).get({ $name: name })?.count === 1n;
}

interface RecordedMigration {
  version: number;
  name: string;
  checksum: string;
}

function recordedMigrations(connection: SqliteConnection): RecordedMigration[] {
  if (!tableExists(connection, "schema_migrations")) return [];
  return connection.prepare(`
    SELECT version, name, checksum
    FROM schema_migrations
    ORDER BY version
  `).all().map((row: SqliteRow): RecordedMigration => {
    if (
      (typeof row.version !== "bigint" && typeof row.version !== "number")
      || typeof row.name !== "string"
      || typeof row.checksum !== "string"
    ) {
      fail("MIGRATION_CHECKSUM_MISMATCH");
    }
    const version = Number(row.version);
    if (!Number.isSafeInteger(version) || version <= 0) {
      fail("MIGRATION_CHECKSUM_MISMATCH");
    }
    return { version, name: row.name, checksum: row.checksum };
  });
}

function verifyRecorded(
  recorded: readonly RecordedMigration[],
  migrations: readonly Migration[],
): void {
  const byVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  const maximumVersion = migrations.at(-1)?.version ?? 0;
  for (const applied of recorded) {
    if (applied.version > maximumVersion) fail("SCHEMA_TOO_NEW");
    const expected = byVersion.get(applied.version);
    if (expected === undefined) fail("MIGRATION_CHECKSUM_MISMATCH");
    if (applied.name !== expected.name) fail("MIGRATION_NAME_MISMATCH");
    if (applied.checksum !== migrationChecksum(expected)) {
      fail("MIGRATION_CHECKSUM_MISMATCH");
    }
  }
}

function rollbackPreservingOriginal(connection: SqliteConnection): void {
  try {
    connection.exec("ROLLBACK");
  } catch {
    // The original migration error remains authoritative.
  }
}

export class MigrationRunner {
  apply(
    connection: SqliteConnection,
    migrations: readonly Migration[],
    appliedAt: string,
  ): number[] {
    validateMigrations(migrations);

    const observedApplicationId = applicationId(connection);
    if (observedApplicationId === 0) {
      connection.exec(`PRAGMA application_id = ${PROJECT_MEMORY_APPLICATION_ID}`);
    } else if (observedApplicationId !== PROJECT_MEMORY_APPLICATION_ID) {
      fail("STORE_APPLICATION_ID_MISMATCH");
    }

    verifyRecorded(recordedMigrations(connection), migrations);
    const applied: number[] = [];
    for (const migration of migrations) {
      try {
        connection.exec("BEGIN IMMEDIATE");
        const lockedApplicationId = applicationId(connection);
        if (lockedApplicationId !== PROJECT_MEMORY_APPLICATION_ID) {
          fail("STORE_APPLICATION_ID_MISMATCH");
        }
        const recorded = recordedMigrations(connection);
        verifyRecorded(recorded, migrations);
        if (recorded.some((item) => item.version === migration.version)) {
          connection.exec("COMMIT");
          continue;
        }

        connection.exec(migration.sql);
        connection.prepare(`
          INSERT INTO schema_migrations(version, name, checksum, applied_at)
          VALUES ($version, $name, $checksum, $appliedAt)
        `).run({
          $version: migration.version,
          $name: migration.name,
          $checksum: migrationChecksum(migration),
          $appliedAt: appliedAt,
        });
        connection.exec("COMMIT");
        applied.push(migration.version);
      } catch (error) {
        rollbackPreservingOriginal(connection);
        throw error;
      }
    }
    return applied;
  }
}
