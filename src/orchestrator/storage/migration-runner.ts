import { PROJECT_MEMORY_APPLICATION_ID } from "../runtime/runtime-capabilities.js";
import type { Migration } from "./migration.js";
import {
  inspectStoreSchema,
  migrationChecksum,
  SchemaCompatibilityError,
  type SchemaCompatibilityErrorCode,
  validateMigrationRegistry,
} from "./schema-compatibility.js";
import type { SqliteConnection } from "./sqlite-driver.js";

export { migrationChecksum } from "./schema-compatibility.js";
export { SchemaCompatibilityError as MigrationError } from "./schema-compatibility.js";
export type MigrationErrorCode = SchemaCompatibilityErrorCode;

export type MigrationApplyMode =
  | { kind: "bootstrap-empty" }
  | { kind: "explicit-upgrade"; expectedAppliedVersion: number };

function fail(code: SchemaCompatibilityErrorCode): never {
  throw new SchemaCompatibilityError(code);
}

function numeric(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "bigint") return undefined;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : undefined;
}

function applicationId(connection: SqliteConnection): number {
  const value = numeric(connection.prepare("PRAGMA application_id").get()?.application_id);
  if (value === undefined) fail("STORE_APPLICATION_ID_MISMATCH");
  return value;
}

function userSchemaObjectCount(connection: SqliteConnection): number {
  const count = numeric(connection.prepare(`
    SELECT count(*) AS count
    FROM sqlite_schema
    WHERE name NOT GLOB 'sqlite_*'
  `).get()?.count);
  if (count === undefined || count < 0) fail("STORE_NOT_EMPTY");
  return count;
}

function identityRowCount(connection: SqliteConnection): number {
  const count = numeric(connection.prepare(`
    SELECT count(*) AS count FROM project_meta WHERE singleton = 1
  `).get()?.count);
  if (count === undefined || count < 0 || count > 1) {
    fail("PROJECT_SCHEMA_VERSION_MISMATCH");
  }
  return count;
}

function validateMode(mode: MigrationApplyMode): void {
  if (mode.kind === "bootstrap-empty") return;
  if (
    mode.kind !== "explicit-upgrade"
    || !Number.isSafeInteger(mode.expectedAppliedVersion)
    || mode.expectedAppliedVersion < 0
  ) fail("MIGRATION_MODE_INVALID");
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
    registry: readonly Migration[],
    appliedAt: string,
    mode: MigrationApplyMode,
  ): number[] {
    validateMigrationRegistry(registry);
    validateMode(mode);
    if (appliedAt.trim().length === 0) fail("MIGRATION_MODE_INVALID");

    if (mode.kind === "bootstrap-empty") {
      const observedApplicationId = applicationId(connection);
      if (observedApplicationId !== 0) {
        fail(observedApplicationId === PROJECT_MEMORY_APPLICATION_ID
          ? "STORE_NOT_EMPTY"
          : "STORE_APPLICATION_ID_MISMATCH");
      }
      if (userSchemaObjectCount(connection) !== 0) fail("STORE_NOT_EMPTY");
    }

    try {
      connection.exec("BEGIN IMMEDIATE");
      let appliedVersion: number;
      if (mode.kind === "bootstrap-empty") {
        const lockedApplicationId = applicationId(connection);
        if (lockedApplicationId !== 0) {
          fail(lockedApplicationId === PROJECT_MEMORY_APPLICATION_ID
            ? "STORE_NOT_EMPTY"
            : "STORE_APPLICATION_ID_MISMATCH");
        }
        if (userSchemaObjectCount(connection) !== 0) fail("STORE_NOT_EMPTY");
        connection.exec(`PRAGMA application_id = ${PROJECT_MEMORY_APPLICATION_ID}`);
        if (applicationId(connection) !== PROJECT_MEMORY_APPLICATION_ID) {
          fail("STORE_APPLICATION_ID_MISMATCH");
        }
        appliedVersion = 0;
      } else {
        const inspection = inspectStoreSchema(connection, registry);
        appliedVersion = inspection.appliedVersion;
        if (appliedVersion !== mode.expectedAppliedVersion) {
          fail("MIGRATION_EXPECTED_VERSION_MISMATCH");
        }
        if (appliedVersion === inspection.targetVersion) {
          connection.exec("COMMIT");
          return [];
        }
      }

      const applied: number[] = [];
      for (const migration of registry.slice(appliedVersion)) {
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

        if (identityRowCount(connection) === 1) {
          const result = connection.prepare(`
            UPDATE project_meta
            SET schema_version = $version
            WHERE singleton = 1 AND schema_version = $previousVersion
          `).run({
            $version: migration.version,
            $previousVersion: migration.version - 1,
          });
          if (result.changes !== 1n) fail("PROJECT_SCHEMA_VERSION_MISMATCH");
        }
        applied.push(migration.version);
      }
      connection.exec("COMMIT");
      return applied;
    } catch (error) {
      rollbackPreservingOriginal(connection);
      throw error;
    }
  }
}
