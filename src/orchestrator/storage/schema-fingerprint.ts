import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { DEFAULT_BUSY_TIMEOUT_MS } from "../runtime/runtime-capabilities.js";
import type { ProjectContext } from "../identity/contracts.js";
import type { Migration } from "./migration.js";
import { SqliteQualifiedCheckpointMigrationPreflight } from "./qualified-checkpoint-migration-preflight.js";
import type { SqliteConnection } from "./sqlite-driver.js";

export type DatabaseSyncConstructor = typeof import("node:sqlite").DatabaseSync;
const require = createRequire(import.meta.url);
let cachedDatabaseSync: DatabaseSyncConstructor | undefined;

function loadDatabaseSync(): DatabaseSyncConstructor {
  if (cachedDatabaseSync !== undefined) return cachedDatabaseSync;
  const sqlite = require("node:sqlite") as Pick<typeof import("node:sqlite"), "DatabaseSync">;
  cachedDatabaseSync = sqlite.DatabaseSync;
  return cachedDatabaseSync;
}

export interface SchemaEntry {
  type: string;
  name: string;
  tableName: string;
  sql: string;
}

export interface SchemaQueryConnection {
  prepare(sql: string): {
    all(): readonly Record<string, unknown>[];
  };
}

function userSchemaEntries(connection: SchemaQueryConnection): SchemaEntry[] {
  return connection.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    WHERE name NOT GLOB 'sqlite_*'
    ORDER BY type, name, tbl_name, sql
  `).all().map((row): SchemaEntry => {
    if (
      typeof row.type !== "string"
      || typeof row.name !== "string"
      || typeof row.tbl_name !== "string"
      || typeof row.sql !== "string"
    ) {
      throw new Error("SCHEMA_FINGERPRINT_UNAVAILABLE");
    }
    return {
      type: row.type,
      name: row.name,
      tableName: row.tbl_name,
      sql: row.sql,
    };
  });
}

export function schemaFingerprint(connection: SchemaQueryConnection): string {
  return createHash("sha256")
    .update(JSON.stringify(userSchemaEntries(connection)), "utf8")
    .digest("hex");
}

const expectedFingerprints = new Map<string, string>();

const FINGERPRINT_PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const FINGERPRINT_VAULT_ID = "22222222-2222-4222-8222-222222222222";
const FINGERPRINT_STORE_ID = "33333333-3333-4333-8333-333333333333";

function stageSchemaThree(database: InstanceType<DatabaseSyncConstructor>): void {
  database.exec(`
    INSERT INTO project_meta(
      singleton, project_id, vault_id, store_id, schema_version, created_at
    ) VALUES (
      1, '${FINGERPRINT_PROJECT_ID}', '${FINGERPRINT_VAULT_ID}',
      '${FINGERPRINT_STORE_ID}', 2, '1970-01-01T00:00:00.000Z'
    );
    INSERT INTO maintenance_state(
      singleton, epoch, mode, owner_id, fencing_token, lease_expires_at, requested_at
    ) VALUES (1, 0, 'idle', NULL, 0, NULL, NULL);
  `);
  new SqliteQualifiedCheckpointMigrationPreflight().assertEligibleAndStage(
    database as unknown as SqliteConnection,
    {
      binding: {
        projectId: FINGERPRINT_PROJECT_ID,
        vaultId: FINGERPRINT_VAULT_ID,
        storeId: FINGERPRINT_STORE_ID,
      },
    } as ProjectContext,
  );
}

export function expectedSchemaFingerprint(
  migrations: readonly Migration[],
  DatabaseSync: DatabaseSyncConstructor = loadDatabaseSync(),
): string {
  const key = createHash("sha256")
    .update(JSON.stringify(migrations.map(({ version, name, sql }) => [version, name, sql])), "utf8")
    .digest("hex");
  const cached = expectedFingerprints.get(key);
  if (cached !== undefined) return cached;

  const database = new DatabaseSync(":memory:", {
    open: true,
    readOnly: false,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
    allowBareNamedParameters: false,
    allowUnknownNamedParameters: false,
    timeout: DEFAULT_BUSY_TIMEOUT_MS,
  });
  try {
    for (const migration of migrations) {
      if (migration.version === 3) stageSchemaThree(database);
      database.exec(migration.sql);
    }
    const fingerprint = schemaFingerprint(database as unknown as SchemaQueryConnection);
    expectedFingerprints.set(key, fingerprint);
    return fingerprint;
  } finally {
    database.close();
  }
}

export function expectedSchemaFingerprintAtVersion(
  registry: readonly Migration[],
  version: number,
  DatabaseSync: DatabaseSyncConstructor = loadDatabaseSync(),
): string {
  if (!Number.isSafeInteger(version) || version < 0 || version > registry.length) {
    throw new Error("SCHEMA_VERSION_INVALID");
  }
  return expectedSchemaFingerprint(registry.slice(0, version), DatabaseSync);
}
