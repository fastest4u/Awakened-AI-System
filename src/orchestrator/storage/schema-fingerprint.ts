import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { DEFAULT_BUSY_TIMEOUT_MS } from "../runtime/runtime-capabilities.js";
import type { Migration } from "./migration.js";

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
    for (const migration of migrations) database.exec(migration.sql);
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
