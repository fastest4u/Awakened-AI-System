import { createHash } from "node:crypto";
import { PROJECT_MEMORY_APPLICATION_ID } from "../runtime/runtime-capabilities.js";
import type { Migration } from "./migration.js";
import { PROJECT_STORE_MIGRATIONS } from "./migrations/registry.js";
import {
  expectedSchemaFingerprintAtVersion,
  schemaFingerprint,
  type SchemaQueryConnection,
} from "./schema-fingerprint.js";
import type { SqliteConnection, SqliteRow } from "./sqlite-driver.js";

export type SchemaCompatibilityErrorCode =
  | "MIGRATION_SET_INVALID"
  | "MIGRATION_CHECKSUM_MISMATCH"
  | "SCHEMA_TOO_NEW"
  | "SCHEMA_UPGRADE_REQUIRED"
  | "SCHEMA_FINGERPRINT_MISMATCH"
  | "PROJECT_SCHEMA_VERSION_MISMATCH"
  | "STORE_APPLICATION_ID_MISMATCH"
  | "STORE_NOT_EMPTY"
  | "MIGRATION_MODE_INVALID"
  | "MIGRATION_EXPECTED_VERSION_MISMATCH";

export class SchemaCompatibilityError extends Error {
  constructor(readonly code: SchemaCompatibilityErrorCode, message = code) {
    super(message);
    this.name = "SchemaCompatibilityError";
  }
}

export type StoreSchemaStatus = "current" | "upgrade-required";

export interface StoreSchemaInspection {
  status: StoreSchemaStatus;
  appliedVersion: number;
  targetVersion: number;
  pending: readonly { version: number; name: string; checksum: string }[];
  observedFingerprint: string;
  expectedFingerprint: string;
}

export interface RecordedMigration {
  version: number;
  name: string;
  checksum: string;
}

function fail(code: SchemaCompatibilityErrorCode): never {
  throw new SchemaCompatibilityError(code);
}

export function migrationChecksum(migration: Migration): string {
  return createHash("sha256").update(migration.sql, "utf8").digest("hex");
}

export function validateMigrationRegistry(registry: readonly Migration[]): void {
  const names = new Set<string>();
  for (const [index, migration] of registry.entries()) {
    if (
      migration.version !== index + 1
      || !Number.isSafeInteger(migration.version)
      || migration.name.length === 0
      || migration.name !== migration.name.trim()
      || names.has(migration.name)
      || migration.sql.trim().length === 0
    ) fail("MIGRATION_SET_INVALID");
    names.add(migration.name);
  }
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

function tableExists(connection: SqliteConnection, name: string): boolean {
  return numeric(connection.prepare(`
    SELECT count(*) AS count
    FROM sqlite_schema
    WHERE type = 'table' AND name = $name
  `).get({ $name: name })?.count) === 1;
}

export function readRecordedMigrations(connection: SqliteConnection): RecordedMigration[] {
  if (!tableExists(connection, "schema_migrations")) return [];
  return connection.prepare(`
    SELECT version, name, checksum
    FROM schema_migrations
    ORDER BY version
  `).all().map((row: SqliteRow): RecordedMigration => {
    const version = numeric(row.version);
    if (
      version === undefined
      || version <= 0
      || typeof row.name !== "string"
      || typeof row.checksum !== "string"
    ) fail("MIGRATION_CHECKSUM_MISMATCH");
    return { version, name: row.name, checksum: row.checksum };
  });
}

export function verifyRecordedMigrationPrefix(
  recorded: readonly RecordedMigration[],
  registry: readonly Migration[],
): void {
  const targetVersion = registry.length;
  if (recorded.some((row) => row.version > targetVersion)) fail("SCHEMA_TOO_NEW");
  for (const [index, row] of recorded.entries()) {
    const expected = registry[index];
    if (
      expected === undefined
      || row.version !== index + 1
      || row.version !== expected.version
      || row.name !== expected.name
      || row.checksum !== migrationChecksum(expected)
    ) fail("MIGRATION_CHECKSUM_MISMATCH");
  }
}

function verifyProjectSchemaVersion(
  connection: SqliteConnection,
  appliedVersion: number,
): void {
  if (!tableExists(connection, "project_meta")) {
    fail("PROJECT_SCHEMA_VERSION_MISMATCH");
  }
  const rows = connection.prepare(`
    SELECT schema_version FROM project_meta
  `).all();
  if (
    rows.length !== 1
    || numeric(rows[0]?.schema_version) !== appliedVersion
  ) fail("PROJECT_SCHEMA_VERSION_MISMATCH");
}

export function inspectStoreSchema(
  connection: SqliteConnection,
  registry: readonly Migration[] = PROJECT_STORE_MIGRATIONS,
): StoreSchemaInspection {
  validateMigrationRegistry(registry);
  if (applicationId(connection) !== PROJECT_MEMORY_APPLICATION_ID) {
    fail("STORE_APPLICATION_ID_MISMATCH");
  }
  const recorded = readRecordedMigrations(connection);
  verifyRecordedMigrationPrefix(recorded, registry);
  if (recorded.length === 0) fail("MIGRATION_CHECKSUM_MISMATCH");
  const appliedVersion = recorded.length;
  verifyProjectSchemaVersion(connection, appliedVersion);
  const observedFingerprint = schemaFingerprint(
    connection as unknown as SchemaQueryConnection,
  );
  const expectedFingerprint = expectedSchemaFingerprintAtVersion(
    registry,
    appliedVersion,
  );
  if (observedFingerprint !== expectedFingerprint) {
    fail("SCHEMA_FINGERPRINT_MISMATCH");
  }
  const pending = Object.freeze(registry.slice(appliedVersion).map((migration) =>
    Object.freeze({
      version: migration.version,
      name: migration.name,
      checksum: migrationChecksum(migration),
    })));
  return Object.freeze({
    status: pending.length === 0 ? "current" : "upgrade-required",
    appliedVersion,
    targetVersion: registry.length,
    pending,
    observedFingerprint,
    expectedFingerprint,
  });
}

export function requireCurrentStoreSchema(
  inspection: StoreSchemaInspection,
): StoreSchemaInspection {
  if (inspection.status !== "current") fail("SCHEMA_UPGRADE_REQUIRED");
  return inspection;
}
