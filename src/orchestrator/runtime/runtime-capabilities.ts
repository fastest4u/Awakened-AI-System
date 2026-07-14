export const MINIMUM_NODE_VERSION = "22.22.3";
export const MINIMUM_SQLITE_VERSION = "3.51.3";
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;
export const PROJECT_MEMORY_APPLICATION_ID = 0x504d454d;

export interface RuntimeCapabilityReport {
  nodeVersion: string;
  sqliteVersion: string;
  nodeVersionAtLeastMinimum: true;
  sqliteVersionAtLeastMinimum: true;
  nodeSqlite: true;
  wal: true;
  fts5: true;
  foreignKeys: true;
  synchronousFull: true;
  busyTimeoutMs: 5000;
  trustedSchemaOff: true;
  transactionRollback: true;
  applicationId: 0x504d454d;
}

export type RuntimeCapabilityResult =
  | ({ ok: true } & RuntimeCapabilityReport)
  | {
      ok: false;
      code: "SQLITE_CAPABILITY_MISSING";
      message: string;
      nodeVersion: string;
      sqliteVersion?: string;
      checks: Record<string, boolean>;
    };

type CapabilityChecks = {
  nodeVersionAtLeastMinimum: boolean;
  nodeSqlite: boolean;
  sqliteVersionAtLeastMinimum: boolean;
  wal: boolean;
  fts5: boolean;
  foreignKeys: boolean;
  synchronousFull: boolean;
  busyTimeout: boolean;
  trustedSchemaOff: boolean;
  transactionRollback: boolean;
  applicationId: boolean;
};

function parseStableVersion(value: string, label: string): readonly [bigint, bigint, bigint] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) {
    throw new Error(`${label} must be a stable numeric x.y.z version, received ${value}`);
  }
  return [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])];
}

export function compareVersions(left: string, right: string): -1 | 0 | 1 {
  const observed = parseStableVersion(left, "observed version");
  const minimum = parseStableVersion(right, "minimum version");
  for (let index = 0; index < observed.length; index += 1) {
    if (observed[index] < minimum[index]) return -1;
    if (observed[index] > minimum[index]) return 1;
  }
  return 0;
}

function rowValue(
  row: Record<string, import("node:sqlite").SQLOutputValue> | undefined,
  key: string,
): import("node:sqlite").SQLOutputValue {
  if (row === undefined || !(key in row)) {
    throw new Error(`Capability query did not return ${key}`);
  }
  return row[key];
}

function initialChecks(): CapabilityChecks {
  return {
    nodeVersionAtLeastMinimum: false,
    nodeSqlite: false,
    sqliteVersionAtLeastMinimum: false,
    wal: false,
    fts5: false,
    foreignKeys: false,
    synchronousFull: false,
    busyTimeout: false,
    trustedSchemaOff: false,
    transactionRollback: false,
    applicationId: false,
  };
}

export async function probeRuntimeCapabilities(
  probePath: string,
): Promise<RuntimeCapabilityResult> {
  const nodeVersion = process.versions.node;
  let sqliteVersion: string | undefined;
  const checks = initialChecks();
  let database: import("node:sqlite").DatabaseSync | undefined;

  try {
    checks.nodeVersionAtLeastMinimum = compareVersions(
      nodeVersion,
      MINIMUM_NODE_VERSION,
    ) >= 0;
    if (!checks.nodeVersionAtLeastMinimum) {
      throw new Error("Minimum Node.js version is unavailable");
    }

    const sqlite = await import("node:sqlite");
    checks.nodeSqlite = typeof sqlite.DatabaseSync === "function";
    if (!checks.nodeSqlite) throw new Error("node:sqlite DatabaseSync is unavailable");

    database = new sqlite.DatabaseSync(probePath, {
      open: true,
      readOnly: false,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
      allowBareNamedParameters: false,
      allowUnknownNamedParameters: false,
      timeout: DEFAULT_BUSY_TIMEOUT_MS,
    });

    sqliteVersion = String(
      rowValue(database.prepare("SELECT sqlite_version() AS version").get(), "version"),
    );
    checks.sqliteVersionAtLeastMinimum = compareVersions(
      sqliteVersion,
      MINIMUM_SQLITE_VERSION,
    ) >= 0;
    if (!checks.sqliteVersionAtLeastMinimum) {
      throw new Error("Minimum SQLite version is unavailable");
    }

    const journalMode = String(
      rowValue(database.prepare("PRAGMA journal_mode = WAL").get(), "journal_mode"),
    ).toLowerCase();
    checks.wal = journalMode === "wal";

    database.exec(`
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS};
      PRAGMA trusted_schema = OFF;
      PRAGMA application_id = ${PROJECT_MEMORY_APPLICATION_ID};
    `);
    checks.synchronousFull = Number(
      rowValue(database.prepare("PRAGMA synchronous").get(), "synchronous"),
    ) === 2;
    checks.foreignKeys = Number(
      rowValue(database.prepare("PRAGMA foreign_keys").get(), "foreign_keys"),
    ) === 1;
    checks.busyTimeout = Number(
      rowValue(database.prepare("PRAGMA busy_timeout").get(), "timeout"),
    ) === DEFAULT_BUSY_TIMEOUT_MS;
    checks.trustedSchemaOff = Number(
      rowValue(database.prepare("PRAGMA trusted_schema").get(), "trusted_schema"),
    ) === 0;
    checks.applicationId = Number(
      rowValue(database.prepare("PRAGMA application_id").get(), "application_id"),
    ) === PROJECT_MEMORY_APPLICATION_ID;

    database.exec("CREATE VIRTUAL TABLE capability_fts USING fts5(content)");
    database
      .prepare("INSERT INTO capability_fts(content) VALUES (?)")
      .run("wal-safe-token");
    checks.fts5 = Number(
      rowValue(
        database
          .prepare("SELECT count(*) AS count FROM capability_fts WHERE capability_fts MATCH ?")
          .get("\"wal-safe-token\""),
        "count",
      ),
    ) === 1;

    database.exec("CREATE TABLE rollback_probe(value TEXT NOT NULL) STRICT");
    database.exec("BEGIN IMMEDIATE");
    database
      .prepare("INSERT INTO rollback_probe(value) VALUES (?)")
      .run("must-rollback");
    database.exec("ROLLBACK");
    checks.transactionRollback = Number(
      rowValue(
        database.prepare("SELECT count(*) AS count FROM rollback_probe").get(),
        "count",
      ),
    ) === 0;

    if (Object.values(checks).some((passed) => !passed)) {
      throw new Error("One or more required SQLite capabilities failed");
    }

    return {
      ok: true,
      nodeVersion,
      sqliteVersion,
      nodeVersionAtLeastMinimum: true,
      sqliteVersionAtLeastMinimum: true,
      nodeSqlite: true,
      wal: true,
      fts5: true,
      foreignKeys: true,
      synchronousFull: true,
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
      trustedSchemaOff: true,
      transactionRollback: true,
      applicationId: PROJECT_MEMORY_APPLICATION_ID,
    };
  } catch {
    return {
      ok: false,
      code: "SQLITE_CAPABILITY_MISSING",
      message: "Required SQLite runtime capability probe failed",
      nodeVersion,
      ...(sqliteVersion === undefined ? {} : { sqliteVersion }),
      checks: { ...checks },
    };
  } finally {
    database?.close();
  }
}
