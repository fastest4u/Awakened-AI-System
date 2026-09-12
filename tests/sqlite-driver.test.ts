import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  linkSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import {
  DEFAULT_BUSY_TIMEOUT_MS,
  MINIMUM_NODE_VERSION,
  MINIMUM_SQLITE_VERSION,
  PROJECT_MEMORY_APPLICATION_ID,
  compareVersions,
  probeRuntimeCapabilities,
} from "../src/orchestrator/runtime/runtime-capabilities.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import type {
  SqliteConnection,
  SqliteOpenOptions,
  SqliteParams,
} from "../src/orchestrator/storage/sqlite-driver.js";
import { applyCurrentProjectStoreSchema } from "./support/current-project-store-schema.js";

const temporaryDirectories: string[] = [];
const bindingModuleUrl = new URL("../src/orchestrator/storage/node-sqlite-driver.js", import.meta.url).href;
const boundOptions: SqliteOpenOptions & { bindFileIdentity: true } = { mode: "existing", busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS, bindFileIdentity: true };
const physicalIdentity = (path: string) => { const stat = lstatSync(path, { bigint: true }); return { device: String(stat.dev), inode: String(stat.ino) }; };
function createBindingDatabase(path: string): void {
  const connection = new NodeSqliteDriver({ DatabaseSync }).open(path, { mode: "create", busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS });
  try { applyCurrentProjectStoreSchema(connection, { projectId: "11111111-1111-4111-8111-111111111111",
    vaultId: "22222222-2222-4222-8222-222222222222", storeId: "33333333-3333-4333-8333-333333333333" }, "2026-09-12T00:00:00.000Z"); }
  finally { connection.close(); }
}

describe("opt-in SQLite open-time file binding", () => {
  it("binds only genuine open native wrappers and refuses unbound copied forged and closed connections", async () => {
    const { assertBoundSqliteConnectionIdentity: check } = await import(bindingModuleUrl);
    assert.equal(typeof check, "function");
    const path = join(realpathSync.native(temporaryDirectory()), "bound.sqlite"); createBindingDatabase(path);
    const driver = new NodeSqliteDriver({ DatabaseSync }), connection = driver.open(path, boundOptions);
    const expected = physicalIdentity(path);
    try {
      check(connection, path, expected);
      const wrapper: SqliteConnection = { exec: sql => connection.exec(sql), prepare: sql => connection.prepare(sql), close: () => {} };
      for (const falseConnection of [wrapper, { ...connection }, Object.create(Object.getPrototypeOf(connection)), {}])
        assert.throws(() => check(falseConnection, path, expected), errorHasCode("SQLITE_CAPABILITY_MISSING"));
      const unbound = driver.open(path, { mode: "existing", busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS });
      try { assert.throws(() => check(unbound, path, expected), errorHasCode("SQLITE_CAPABILITY_MISSING")); }
      finally { unbound.close(); }
      const readOnly = driver.open(path, { ...boundOptions, mode: "read-only-existing" });
      try { check(readOnly, path, expected); assert.equal(readOnly.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1n); }
      finally { readOnly.close(); }
    } finally { connection.close(); }
    assert.throws(() => check(connection, path, expected), errorHasCode("SQLITE_CAPABILITY_MISSING"));
  });

  it("rejects invalid opt-in and create before opening any native handle", () => {
    let opened = 0;
    class CountedDatabase extends DatabaseSync { constructor(...args: ConstructorParameters<typeof DatabaseSync>) { opened++; super(...args); } }
    const driver = new NodeSqliteDriver({ DatabaseSync: CountedDatabase }), directory = realpathSync.native(temporaryDirectory());
    for (const options of [{ ...boundOptions, mode: "create" }, { ...boundOptions, bindFileIdentity: false }, { ...boundOptions, bindFileIdentity: "true" }]) {
      const path = join(directory, "must-not-create.sqlite");
      assert.throws(() => { driver.open(path, options as SqliteOpenOptions).close(); }, errorHasCode("SQLITE_CAPABILITY_MISSING"));
      assert.equal(existsSync(path), false);
    }
    assert.equal(opened, 0);
  });

  it("rejects missing noncanonical junction and hardlinked bound paths before native open", () => {
    const directory = realpathSync.native(temporaryDirectory()), path = join(directory, "bound.sqlite"); createBindingDatabase(path);
    const hardlink = join(directory, "hardlink.sqlite"); linkSync(path, hardlink);
    const alias = join(directory, "alias"); symlinkSync(directory, alias, process.platform === "win32" ? "junction" : "dir");
    let opened = 0;
    class CountedDatabase extends DatabaseSync { constructor(...args: ConstructorParameters<typeof DatabaseSync>) { opened++; super(...args); } }
    const driver = new NodeSqliteDriver({ DatabaseSync: CountedDatabase });
    for (const invalid of [join(directory, "missing.sqlite"), `${directory}/../not-normalized.sqlite`, hardlink, join(alias, "bound.sqlite")])
      assert.throws(() => { driver.open(invalid, boundOptions).close(); }, errorHasCode("SQLITE_CAPABILITY_MISSING"));
    assert.equal(opened, 0); assert.equal(lstatSync(path).nlink, 2);
  });

  for (const nativeOpen of [1, 2]) it(`rejects persistent substitution after native constructor ${nativeOpen} before writable hardening`, t => {
    const directory = realpathSync.native(temporaryDirectory()), owned = join(directory, "owned"); mkdirSync(owned);
    const path = join(owned, "a.sqlite"), replacement = join(directory, "b.sqlite"); createBindingDatabase(path); createBindingDatabase(replacement);
    const beforeA = readFileSync(path), beforeB = readFileSync(replacement), idA = physicalIdentity(path), idB = physicalIdentity(replacement);
    let opens = 0, hardenings = 0, swapped = false; const denied: string[] = [];
    class ReplacedDatabase extends DatabaseSync {
      constructor(...args: ConstructorParameters<typeof DatabaseSync>) {
        super(...args); opens++;
        if (opens === nativeOpen) {
          try { renameSync(path, join(owned, "retained.sqlite")); swapped = true; }
          catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) { super.close(); throw error; }
            denied.push(`file:${code}`);
            try { renameSync(owned, `${owned}-retained`); mkdirSync(owned); swapped = true; }
            catch (ancestorError) {
              const ancestorCode = (ancestorError as NodeJS.ErrnoException).code;
              if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(ancestorCode ?? "")) { super.close(); throw ancestorError; }
              denied.push(`ancestor:${ancestorCode}`);
            }
          }
          if (swapped) renameSync(replacement, path);
        }
      }
      override prepare(sql: string): StatementSync {
        if (sql === "PRAGMA journal_mode = WAL") hardenings++;
        return super.prepare(sql);
      }
    }
    let connection: SqliteConnection | undefined, failure: unknown;
    try { connection = new NodeSqliteDriver({ DatabaseSync: ReplacedDatabase }).open(path, boundOptions); }
    catch (error) { failure = error; } finally { connection?.close(); }
    if (!swapped) {
      assert.equal(denied.length, 2); t.diagnostic(`Windows native-open replacement prevented (${denied.join(",")}); stale-handle guard not exercised`);
      assert.deepEqual(physicalIdentity(path), idA); assert.deepEqual(readFileSync(path), beforeA);
      assert.deepEqual(physicalIdentity(replacement), idB); assert.deepEqual(readFileSync(replacement), beforeB); return;
    }
    assert.ok(failure); errorHasCode("SQLITE_CAPABILITY_MISSING")(failure); assert.equal(hardenings, 0);
    assert.deepEqual(physicalIdentity(path), idB); assert.deepEqual(readFileSync(path), beforeB);
    const retained = existsSync(join(owned, "retained.sqlite")) ? join(owned, "retained.sqlite") : join(`${owned}-retained`, basename(path));
    assert.deepEqual(physicalIdentity(retained), idA); assert.deepEqual(readFileSync(retained), beforeA);
  });

  it("refuses a stale bound native connection when the current pathname names another physical store", async t => {
    const { assertBoundSqliteConnectionIdentity: check } = await import(bindingModuleUrl);
    const directory = realpathSync.native(temporaryDirectory()), owned = join(directory, "owned"); mkdirSync(owned);
    const path = join(owned, "a.sqlite"), replacement = join(directory, "b.sqlite"); createBindingDatabase(path); createBindingDatabase(replacement);
    const idA = physicalIdentity(path), idB = physicalIdentity(replacement), beforeA = readFileSync(path), beforeB = readFileSync(replacement);
    const connection = new NodeSqliteDriver({ DatabaseSync }).open(path, boundOptions); let swapped = false;
    try {
      try { renameSync(path, join(owned, "retained.sqlite")); swapped = true; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw error;
        try { renameSync(owned, `${owned}-retained`); mkdirSync(owned); swapped = true; }
        catch (ancestorError) {
          const ancestorCode = (ancestorError as NodeJS.ErrnoException).code;
          if (! ["EPERM", "EACCES", "EBUSY"].includes(ancestorCode ?? "")) throw ancestorError;
          t.diagnostic(`Windows stale-handle setup prevented (file:${code},ancestor:${ancestorCode}); not stale-handle refusal proof`);
        }
      }
      if (swapped) {
        renameSync(replacement, path);
        const named = connection.prepare("PRAGMA database_list").all().find(row => row.name === "main")?.file;
        assert.equal(typeof named, "string"); assert.deepEqual(physicalIdentity(String(named)), idB);
        assert.throws(() => check(connection, path, idB), errorHasCode("SQLITE_CAPABILITY_MISSING"));
        assert.deepEqual(readFileSync(path), beforeB);
        const retained = existsSync(join(owned, "retained.sqlite")) ? join(owned, "retained.sqlite") : join(`${owned}-retained`, basename(path));
        assert.deepEqual(physicalIdentity(retained), idA); assert.deepEqual(readFileSync(retained), beforeA);
      } else { assert.deepEqual(physicalIdentity(path), idA); assert.deepEqual(readFileSync(path), beforeA); assert.deepEqual(readFileSync(replacement), beforeB); }
    } finally { connection.close(); }
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "project-memory-driver-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function errorHasCode(expected: string): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.equal(
      typeof error === "object" && error !== null && "code" in error,
      true,
    );
    assert.equal(String((error as { code: unknown }).code), expected);
    return true;
  };
}

function ownDataPropertyValues(value: object): unknown[] {
  return Reflect.ownKeys(value).flatMap((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor
      ? [descriptor.value]
      : [];
  });
}

function readJournalMode(path: string): string {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return String(database.prepare("PRAGMA journal_mode").get()?.journal_mode);
  } finally {
    database.close();
  }
}

function createRawExistingDatabase(
  path: string,
  options: { applicationId?: number; wal?: boolean; projectMeta?: boolean } = {},
): void {
  const database = new DatabaseSync(path, {
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
    if (options.wal !== false) database.prepare("PRAGMA journal_mode = WAL").get();
    database.exec(`
      PRAGMA application_id = ${options.applicationId ?? PROJECT_MEMORY_APPLICATION_ID};
      CREATE TABLE IF NOT EXISTS sentinel(value TEXT NOT NULL) STRICT;
    `);
    if (options.projectMeta !== false) {
      database.exec(`
        CREATE TABLE project_meta (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          project_id TEXT NOT NULL UNIQUE,
          vault_id TEXT NOT NULL UNIQUE,
          store_id TEXT NOT NULL UNIQUE,
          schema_version INTEGER NOT NULL CHECK (schema_version > 0),
          created_at TEXT NOT NULL
        ) STRICT;
        INSERT INTO project_meta VALUES (1, 'project', 'vault', 'store', 1, '2026-07-12T00:00:00.000Z');
      `);
    }
  } finally {
    database.close();
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("runtime SQLite capabilities", () => {
  it("compares only stable numeric x.y.z versions", () => {
    assert.equal(compareVersions("3.51.3", "3.51.3"), 0);
    assert.equal(compareVersions("3.53.0", "3.51.3"), 1);
    assert.equal(compareVersions("3.51.2", "3.51.3"), -1);
    assert.equal(compareVersions("100000000000000000000.0.0", "99999999999999999999.0.0"), 1);
    for (const invalid of ["3.51", "3.51.3.0", "3.51.3-rc1", " 3.51.3", "v3.51.3"]) {
      assert.throws(
        () => compareVersions(invalid, "3.51.3"),
        /stable numeric x\.y\.z/,
      );
    }
  });

  it("proves the real Node and SQLite capability contract and stays in parity with the prebuild gate", async () => {
    const probePath = join(temporaryDirectory(), "capability.sqlite");
    const report = await probeRuntimeCapabilities(probePath);

    if (!report.ok) assert.fail(report.message);
    assert.equal(report.ok, true);
    assert.equal(report.nodeVersionAtLeastMinimum, true);
    assert.equal(report.sqliteVersionAtLeastMinimum, true);
    assert.equal(report.wal, true);
    assert.equal(report.fts5, true);
    assert.equal(report.foreignKeys, true);
    assert.equal(report.synchronousFull, true);
    assert.equal(report.busyTimeoutMs, DEFAULT_BUSY_TIMEOUT_MS);
    assert.equal(report.trustedSchemaOff, true);
    assert.equal(report.transactionRollback, true);
    assert.equal(report.applicationId, PROJECT_MEMORY_APPLICATION_ID);
    assert.equal(compareVersions(report.nodeVersion, MINIMUM_NODE_VERSION) >= 0, true);
    assert.equal(compareVersions(report.sqliteVersion, MINIMUM_SQLITE_VERSION) >= 0, true);

    const standalone = JSON.parse(
      execFileSync(process.execPath, ["scripts/check-runtime.js", "--json"], {
        cwd: process.cwd(),
        encoding: "utf8",
      }),
    ) as unknown;
    assert.deepEqual(report, standalone);
  });

  it("fails closed with individual checks when the probe database cannot be opened", async () => {
    const directory = temporaryDirectory();
    const missingParent = join(directory, "missing", "capability.sqlite");
    const report = await probeRuntimeCapabilities(missingParent);

    assert.equal(report.ok, false);
    if (report.ok) assert.fail("probe unexpectedly succeeded");
    assert.equal(report.code, "SQLITE_CAPABILITY_MISSING");
    assert.equal(report.nodeVersion, process.versions.node);
    assert.equal(typeof report.message, "string");
    assert.equal(report.message.length > 0, true);
    assert.equal(Object.values(report.checks).every((value) => typeof value === "boolean"), true);
    assert.equal(report.checks.nodeVersionAtLeastMinimum, true);
    assert.equal(report.checks.nodeSqlite, true);
    assert.equal(report.checks.sqliteVersionAtLeastMinimum, false);
    assert.equal(existsSync(missingParent), false);
  });

  it("closes the disposable database after a post-open capability failure", async () => {
    const directory = temporaryDirectory();
    const probePath = join(directory, "capability.sqlite");
    const prepared = new DatabaseSync(probePath);
    try {
      prepared.exec("CREATE TABLE capability_fts(content TEXT NOT NULL) STRICT");
    } finally {
      prepared.close();
    }

    const report = await probeRuntimeCapabilities(probePath);

    assert.equal(report.ok, false);
    if (report.ok) assert.fail("probe unexpectedly succeeded");
    assert.equal(report.code, "SQLITE_CAPABILITY_MISSING");
    assert.equal(report.checks.sqliteVersionAtLeastMinimum, true);
    assert.equal(report.checks.wal, true);
    assert.equal(report.checks.fts5, false);

    rmSync(directory, { recursive: true });
    assert.equal(existsSync(directory), false);
    mkdirSync(directory);
    const reopened = new DatabaseSync(probePath);
    reopened.close();
  });
});

describe("NodeSqliteDriver", () => {
  const driver = new NodeSqliteDriver({ DatabaseSync });

  it("creates a hardened WAL connection with bigint-safe statements and functional FTS5", () => {
    const databasePath = join(temporaryDirectory(), "events.sqlite");
    const connection = driver.open(databasePath, {
      mode: "create",
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    });
    try {
      assert.equal("loadExtension" in connection, false);
      assert.equal(connection.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
      assert.equal(connection.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1n);
      assert.equal(connection.prepare("PRAGMA synchronous").get()?.synchronous, 2n);
      assert.equal(connection.prepare("PRAGMA trusted_schema").get()?.trusted_schema, 0n);
      assert.equal(connection.prepare("PRAGMA busy_timeout").get()?.timeout, 5000n);
      assert.equal(connection.prepare("PRAGMA application_id").get()?.application_id, 0n);

      connection.exec("CREATE TABLE sample(value INTEGER NOT NULL) STRICT");
      const inserted = connection
        .prepare("INSERT INTO sample(value) VALUES ($value)")
        .run({ $value: 9007199254740993n });
      assert.equal(inserted.changes, 1n);
      assert.equal(typeof inserted.changes, "bigint");
      assert.equal(typeof inserted.lastInsertRowid, "bigint");
      assert.equal(
        connection.prepare("SELECT value FROM sample").get()?.value,
        9007199254740993n,
      );
      assert.deepEqual(
        connection.prepare("SELECT value FROM sample").all().map((row) => row.value),
        [9007199254740993n],
      );
      assert.deepEqual(
        [...connection.prepare("SELECT value FROM sample").iterate()].map((row) => row.value),
        [9007199254740993n],
      );

      connection.exec("CREATE VIRTUAL TABLE sample_fts USING fts5(content)");
      connection
        .prepare("INSERT INTO sample_fts(content) VALUES ($content)")
        .run({ $content: "wal-safe-token" });
      const ftsRow = connection
        .prepare("SELECT count(*) AS count FROM sample_fts WHERE sample_fts MATCH $query")
        .get({ $query: "\"wal-safe-token\"" });
      assert.equal(ftsRow?.count, 1n);
    } finally {
      connection.close();
    }
  });

  it("uses zero native arguments when params are absent and rejects non-dollar named bindings", () => {
    const databasePath = join(temporaryDirectory(), "events.sqlite");
    const connection = driver.open(databasePath, {
      mode: "create",
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    });
    try {
      connection.exec("CREATE TABLE sample(value INTEGER NOT NULL) STRICT");
      assert.equal(connection.prepare("INSERT INTO sample VALUES (7)").run().changes, 1n);
      assert.equal(connection.prepare("SELECT value FROM sample").get()?.value, 7n);
      assert.throws(
        () => connection
          .prepare("INSERT INTO sample VALUES ($value)")
          .run({ value: 8 } as unknown as SqliteParams),
        errorHasCode("SQLITE_PARAMS_INVALID"),
      );
    } finally {
      connection.close();
    }
  });

  it("passes exactly zero native arguments to every statement method when params are absent", () => {
    const calls: Array<{ sql: string; method: string; argumentsLength: number }> = [];
    class InstrumentedDatabaseSync extends DatabaseSync {
      override prepare(sql: string): StatementSync {
        const statement = super.prepare(sql);
        return new Proxy(statement, {
          get(target, property): unknown {
            const member = Reflect.get(target, property, target) as unknown;
            if (typeof member !== "function") return member;
            return (...args: unknown[]): unknown => {
              if (
                sql.includes("argument-probe")
                && ["run", "get", "all", "iterate"].includes(String(property))
              ) {
                calls.push({
                  sql,
                  method: String(property),
                  argumentsLength: args.length,
                });
              }
              return Reflect.apply(member, target, args);
            };
          },
        });
      }
    }
    const instrumentedDriver = new NodeSqliteDriver({
      DatabaseSync: InstrumentedDatabaseSync,
    });
    const databasePath = join(temporaryDirectory(), "arguments.sqlite");
    const connection = instrumentedDriver.open(databasePath, {
      mode: "create",
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    });
    try {
      connection.exec("CREATE TABLE argument_probe(value INTEGER NOT NULL) STRICT");
      connection.prepare("INSERT INTO argument_probe VALUES (1) /* argument-probe-run */").run();
      connection.prepare("SELECT value FROM argument_probe /* argument-probe-get */").get();
      connection.prepare("SELECT value FROM argument_probe /* argument-probe-all */").all();
      [...connection
        .prepare("SELECT value FROM argument_probe /* argument-probe-iterate */")
        .iterate()];
      assert.deepEqual(
        calls.map(({ method, argumentsLength }) => ({ method, argumentsLength })),
        [
          { method: "run", argumentsLength: 0 },
          { method: "get", argumentsLength: 0 },
          { method: "all", argumentsLength: 0 },
          { method: "iterate", argumentsLength: 0 },
        ],
      );
    } finally {
      connection.close();
    }
  });

  it("rejects every parameter value outside the narrow SqliteValue domain", () => {
    const databasePath = join(temporaryDirectory(), "events.sqlite");
    const connection = driver.open(databasePath, {
      mode: "create",
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    });
    try {
      connection.exec("CREATE TABLE sample(value BLOB) STRICT");
      const statement = connection.prepare("INSERT INTO sample VALUES ($value)");
      for (const invalid of [
        {},
        undefined,
        new DataView(new ArrayBuffer(4)),
        new Uint16Array([1, 2]),
      ]) {
        assert.throws(
          () => statement.run({ $value: invalid } as unknown as SqliteParams),
          errorHasCode("SQLITE_PARAMS_INVALID"),
        );
      }
      assert.equal(statement.run({ $value: new Uint8Array([1, 2]) }).changes, 1n);
    } finally {
      connection.close();
    }
  });

  it("does not expose native connection or statement handles as own properties", () => {
    const databasePath = join(temporaryDirectory(), "events.sqlite");
    const connection = driver.open(databasePath, {
      mode: "create",
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    });
    try {
      const statement = connection.prepare("SELECT 1 AS value");
      assert.equal(
        ownDataPropertyValues(connection).some((value) => value instanceof DatabaseSync),
        false,
      );
      assert.equal(
        ownDataPropertyValues(statement).some((value) => value instanceof StatementSync),
        false,
      );
    } finally {
      connection.close();
    }
  });

  it("rolls back a transaction without leaving inserted rows", () => {
    const databasePath = join(temporaryDirectory(), "events.sqlite");
    const connection = driver.open(databasePath, {
      mode: "create",
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    });
    try {
      connection.exec("CREATE TABLE rollback_probe(value TEXT NOT NULL) STRICT");
      connection.exec("BEGIN IMMEDIATE");
      connection
        .prepare("INSERT INTO rollback_probe(value) VALUES ($value)")
        .run({ $value: "must-rollback" });
      connection.exec("ROLLBACK");
      assert.equal(
        connection.prepare("SELECT count(*) AS count FROM rollback_probe").get()?.count,
        0n,
      );
    } finally {
      connection.close();
    }
  });

  it("refuses missing existing paths without creating a database", () => {
    const databasePath = join(temporaryDirectory(), "missing.sqlite");

    assert.throws(
      () => driver.open(databasePath, {
        mode: "existing",
        busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
      }),
      errorHasCode("SQLITE_CAPABILITY_MISSING"),
    );
    assert.equal(existsSync(databasePath), false);

    assert.throws(
      () => driver.open(databasePath, {
        mode: "read-only-existing",
        busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
      }),
      errorHasCode("SQLITE_CAPABILITY_MISSING"),
    );
    assert.equal(existsSync(databasePath), false);
  });

  it("rejects invalid modes before opening or mutating a database", () => {
    const walPath = join(temporaryDirectory(), "wal.sqlite");
    createRawExistingDatabase(walPath);
    assert.throws(
      () => {
        const connection = driver.open(walPath, {
          mode: "exsting",
          busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
        } as unknown as SqliteOpenOptions);
        connection.close();
      },
      errorHasCode("SQLITE_CAPABILITY_MISSING"),
    );
    assert.equal(readJournalMode(walPath), "wal");

    const deletePath = join(temporaryDirectory(), "delete.sqlite");
    createRawExistingDatabase(deletePath, { wal: false });
    assert.throws(
      () => driver.open(deletePath, {
        mode: "exsting",
        busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
      } as unknown as SqliteOpenOptions),
      errorHasCode("SQLITE_CAPABILITY_MISSING"),
    );
    assert.equal(readJournalMode(deletePath), "delete");
  });

  it("transitions an identified DELETE-journal database to WAL only for writable existing mode", () => {
    const databasePath = join(temporaryDirectory(), "events.sqlite");
    createRawExistingDatabase(databasePath, { wal: false });

    const connection = driver.open(databasePath, {
      mode: "existing",
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    });
    try {
      assert.equal(connection.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
    } finally {
      connection.close();
    }
    assert.equal(readJournalMode(databasePath), "wal");
  });

  it("opens an existing identified store in writable and read-only modes", () => {
    const databasePath = join(temporaryDirectory(), "events.sqlite");
    createRawExistingDatabase(databasePath);

    const writable = driver.open(databasePath, {
      mode: "existing",
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    });
    try {
      writable.prepare("INSERT INTO sentinel(value) VALUES ($value)").run({ $value: "written" });
      assert.equal(writable.prepare("SELECT count(*) AS count FROM sentinel").get()?.count, 1n);
    } finally {
      writable.close();
    }

    const readOnly = driver.open(databasePath, {
      mode: "read-only-existing",
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    });
    try {
      assert.equal(readOnly.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
      assert.equal(readOnly.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1n);
      assert.equal(readOnly.prepare("PRAGMA trusted_schema").get()?.trusted_schema, 0n);
      assert.equal(readOnly.prepare("SELECT count(*) AS count FROM project_meta").get()?.count, 1n);
      assert.throws(
        () => readOnly.prepare("INSERT INTO sentinel(value) VALUES ($value)").run({ $value: "denied" }),
        /read-?only/i,
      );
    } finally {
      readOnly.close();
    }
  });

  it("rejects an existing database with no project_meta identity", () => {
    const databasePath = join(temporaryDirectory(), "events.sqlite");
    createRawExistingDatabase(databasePath, { projectMeta: false });

    assert.throws(
      () => driver.open(databasePath, {
        mode: "existing",
        busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
      }),
      errorHasCode("SQLITE_CAPABILITY_MISSING"),
    );
  });

  it("rejects and does not overwrite a wrong application ID", () => {
    const databasePath = join(temporaryDirectory(), "events.sqlite");
    createRawExistingDatabase(databasePath, { applicationId: 1234 });

    assert.throws(
      () => driver.open(databasePath, {
        mode: "existing",
        busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
      }),
      errorHasCode("SQLITE_CAPABILITY_MISSING"),
    );

    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(
        database.prepare("PRAGMA application_id").get()?.application_id,
        1234,
      );
    } finally {
      database.close();
    }
  });

  it("does not transition a read-only existing database into WAL", () => {
    const databasePath = join(temporaryDirectory(), "events.sqlite");
    createRawExistingDatabase(databasePath, { wal: false });

    assert.throws(
      () => driver.open(databasePath, {
        mode: "read-only-existing",
        busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
      }),
      errorHasCode("SQLITE_CAPABILITY_MISSING"),
    );

    assert.equal(readJournalMode(databasePath), "delete");
  });

  it("closes a database when a post-open hardening probe fails", () => {
    class FailingProbeDatabaseSync extends DatabaseSync {
      override prepare(sql: string): StatementSync {
        if (sql === "PRAGMA journal_mode = WAL") {
          throw new Error("INJECTED_POST_OPEN_PROBE_FAILURE");
        }
        return super.prepare(sql);
      }
    }
    const failingDriver = new NodeSqliteDriver({
      DatabaseSync: FailingProbeDatabaseSync,
    });
    const databasePath = join(temporaryDirectory(), "failure.sqlite");

    assert.throws(
      () => failingDriver.open(databasePath, {
        mode: "create",
        busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
      }),
      errorHasCode("SQLITE_CAPABILITY_MISSING"),
    );
    rmSync(databasePath);
    assert.equal(existsSync(databasePath), false);

    const reopened = new DatabaseSync(databasePath);
    reopened.close();
  });
});
