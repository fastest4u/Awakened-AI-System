import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MIN_NODE = "22.22.3";
const MIN_SQLITE = "3.51.3";
const APPLICATION_ID = 0x504d454d;
const asJson = process.argv.includes("--json");

function parseStableVersion(value, label) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) throw new Error(`${label} must be a stable numeric x.y.z version, received ${value}`);
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  const a = parseStableVersion(left, "observed version");
  const b = parseStableVersion(right, "minimum version");
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return Math.sign(a[index] - b[index]);
  }
  return 0;
}

function value(row, key) {
  if (!row || !(key in row)) throw new Error(`Capability query did not return ${key}`);
  return row[key];
}

async function main() {
  const nodeVersion = process.versions.node;
  if (compareVersions(nodeVersion, MIN_NODE) < 0) throw new Error(`Node ${nodeVersion} is below ${MIN_NODE}`);
  const sqlite = await import("node:sqlite");
  const directory = mkdtempSync(join(tmpdir(), "project-memory-runtime-"));
  const path = join(directory, "capability.sqlite");
  let database;
  try {
    database = new sqlite.DatabaseSync(path, {
      open: true,
      readOnly: false,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
      allowBareNamedParameters: false,
      allowUnknownNamedParameters: false,
      timeout: 5000,
    });
    const sqliteVersion = String(value(database.prepare("SELECT sqlite_version() AS version").get(), "version"));
    if (compareVersions(sqliteVersion, MIN_SQLITE) < 0) throw new Error(`SQLite ${sqliteVersion} is below ${MIN_SQLITE}`);
    const journalMode = String(value(database.prepare("PRAGMA journal_mode = WAL").get(), "journal_mode")).toLowerCase();
    database.exec(`
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA trusted_schema = OFF;
      PRAGMA application_id = ${APPLICATION_ID};
    `);
    const synchronous = Number(value(database.prepare("PRAGMA synchronous").get(), "synchronous"));
    const foreignKeys = Number(value(database.prepare("PRAGMA foreign_keys").get(), "foreign_keys"));
    const busyTimeoutMs = Number(value(database.prepare("PRAGMA busy_timeout").get(), "timeout"));
    const trustedSchema = Number(value(database.prepare("PRAGMA trusted_schema").get(), "trusted_schema"));
    const applicationId = Number(value(database.prepare("PRAGMA application_id").get(), "application_id"));
    database.exec("CREATE VIRTUAL TABLE capability_fts USING fts5(content)");
    database.prepare("INSERT INTO capability_fts(content) VALUES (?)").run("wal-safe-token");
    const ftsCount = Number(value(database.prepare("SELECT count(*) AS count FROM capability_fts WHERE capability_fts MATCH ?").get("\"wal-safe-token\""), "count"));
    database.exec("CREATE TABLE rollback_probe(value TEXT NOT NULL) STRICT");
    database.exec("BEGIN IMMEDIATE");
    database.prepare("INSERT INTO rollback_probe(value) VALUES (?)").run("must-rollback");
    database.exec("ROLLBACK");
    const rollbackCount = Number(value(database.prepare("SELECT count(*) AS count FROM rollback_probe").get(), "count"));
    if (journalMode !== "wal" || synchronous !== 2 || foreignKeys !== 1 || busyTimeoutMs !== 5000 || trustedSchema !== 0 || applicationId !== APPLICATION_ID || ftsCount !== 1 || rollbackCount !== 0) {
      throw new Error("One or more functional SQLite capability checks failed");
    }
    const report = {
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
      busyTimeoutMs: 5000,
      trustedSchemaOff: true,
      transactionRollback: true,
      applicationId,
    };
    process.stdout.write(asJson ? `${JSON.stringify(report)}\n` : `Runtime OK: Node ${nodeVersion}, SQLite ${sqliteVersion}, WAL, FTS5\n`);
  } finally {
    database?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, code: "SQLITE_CAPABILITY_MISSING", message: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
});
