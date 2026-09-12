import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, normalize } from "node:path";
import {
  PROJECT_MEMORY_APPLICATION_ID,
} from "../runtime/runtime-capabilities.js";
import {
  SqliteCapabilityError,
  SqliteParamsError,
  type SqliteConnection,
  type SqliteDriver,
  type SqliteOpenOptions,
  type SqliteParams,
  type SqliteRow,
  type SqliteRunResult,
  type SqliteStatement,
  type SqliteValue,
} from "./sqlite-driver.js";

type NodeSqliteModule = Pick<typeof import("node:sqlite"), "DatabaseSync">;
type NativeDatabase = import("node:sqlite").DatabaseSync;
type NativeStatement = import("node:sqlite").StatementSync;

interface BoundFileIdentity { readonly path: string; readonly device: string; readonly inode: string; }
const boundConnections = new WeakMap<SqliteConnection, BoundFileIdentity>();
function bindingFailure(): never { throw new SqliteCapabilityError("SQLite connection file identity is unproven"); }
function captureBoundFile(path: string): BoundFileIdentity {
  try {
    if (typeof path !== "string" || !isAbsolute(path) || normalize(path) !== path || realpathSync.native(path) !== path) bindingFailure();
    let cursor = path;
    while (true) {
      const stat = lstatSync(cursor, { bigint: true });
      if (stat.isSymbolicLink() || (cursor !== path && !stat.isDirectory())) bindingFailure();
      const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
    }
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) bindingFailure();
    return Object.freeze({ path, device: String(stat.dev), inode: String(stat.ino) });
  } catch { bindingFailure(); }
}
function assertSameBoundFile(binding: BoundFileIdentity): void {
  const current = captureBoundFile(binding.path);
  if (current.device !== binding.device || current.inode !== binding.inode) bindingFailure();
}
/** Provenance of an owner-controlled pre/post native-open observation, not SQLite private-fd or ABA attestation. */
export function assertBoundSqliteConnectionIdentity(connection: SqliteConnection, expectedPath: string,
  expectedIdentity: { readonly device: string; readonly inode: string }): void {
  const binding = boundConnections.get(connection);
  if (!binding || binding.path !== expectedPath || binding.device !== expectedIdentity?.device || binding.inode !== expectedIdentity?.inode) bindingFailure();
  assertSameBoundFile(binding);
}

function nativeOptions(
  options: SqliteOpenOptions,
): import("node:sqlite").DatabaseSyncOptions {
  return {
    open: true,
    readOnly: options.mode === "read-only-existing",
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
    allowBareNamedParameters: false,
    allowUnknownNamedParameters: false,
    timeout: options.busyTimeoutMs,
  };
}

function value(
  database: NativeDatabase,
  sql: string,
  key: string,
): import("node:sqlite").SQLOutputValue {
  const row = database.prepare(sql).get();
  if (row === undefined || !(key in row)) {
    throw new SqliteCapabilityError(`SQLite did not return required ${key} value`);
  }
  return row[key];
}

function requireCapability(condition: boolean, message: string): void {
  if (!condition) throw new SqliteCapabilityError(message);
}

function verifyProjectIdentity(database: NativeDatabase): void {
  const applicationId = Number(value(database, "PRAGMA application_id", "application_id"));
  requireCapability(
    applicationId === PROJECT_MEMORY_APPLICATION_ID,
    "SQLite application identity does not match project memory",
  );

  const projectMetaRows = Number(
    value(
      database,
      "SELECT count(*) AS count FROM project_meta WHERE singleton = 1",
      "count",
    ),
  );
  requireCapability(
    projectMetaRows === 1,
    "SQLite project_meta identity is missing or ambiguous",
  );
}

function verifyConnectionLocalControls(
  database: NativeDatabase,
  busyTimeoutMs: number,
): void {
  requireCapability(
    Number(value(database, "PRAGMA foreign_keys", "foreign_keys")) === 1,
    "SQLite foreign key enforcement is unavailable",
  );
  requireCapability(
    Number(value(database, "PRAGMA busy_timeout", "timeout")) === busyTimeoutMs,
    "SQLite busy timeout was not applied",
  );
  requireCapability(
    Number(value(database, "PRAGMA trusted_schema", "trusted_schema")) === 0,
    "SQLite trusted schema hardening is unavailable",
  );
}

function verifyWal(database: NativeDatabase): void {
  requireCapability(
    String(value(database, "PRAGMA journal_mode", "journal_mode")).toLowerCase() === "wal",
    "SQLite WAL mode is unavailable",
  );
}

function verifyWritableConnectionHardening(
  database: NativeDatabase,
  busyTimeoutMs: number,
): void {
  verifyWal(database);
  requireCapability(
    Number(value(database, "PRAGMA synchronous", "synchronous")) === 2,
    "SQLite synchronous FULL mode is unavailable",
  );
  verifyConnectionLocalControls(database, busyTimeoutMs);
}

function configureWritableConnection(
  database: NativeDatabase,
  busyTimeoutMs: number,
): void {
  const journalMode = String(
    value(database, "PRAGMA journal_mode = WAL", "journal_mode"),
  ).toLowerCase();
  requireCapability(journalMode === "wal", "SQLite WAL mode is unavailable");
  database.exec(`
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = ${busyTimeoutMs};
    PRAGMA trusted_schema = OFF;
  `);
  verifyWritableConnectionHardening(database, busyTimeoutMs);
}

function configureReadOnlyConnection(
  database: NativeDatabase,
  busyTimeoutMs: number,
): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA trusted_schema = OFF;
  `);
  verifyConnectionLocalControls(database, busyTimeoutMs);
}

function isSqliteValue(value: unknown): value is SqliteValue {
  return value === null
    || typeof value === "number"
    || typeof value === "bigint"
    || typeof value === "string"
    || value instanceof Uint8Array;
}

function paramsError(message: string): SqliteParamsError {
  return new SqliteParamsError(`SQLITE_PARAMS_INVALID: ${message}`);
}

function validateParams(params: SqliteParams): Record<string, SqliteValue> {
  const prototype = Object.getPrototypeOf(params) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw paramsError("parameters must be a plain record");
  }

  const bound: Record<string, SqliteValue> = {};
  for (const key of Reflect.ownKeys(params)) {
    if (typeof key !== "string" || !key.startsWith("$")) {
      throw paramsError("every parameter name must start with $");
    }
    const descriptor = Object.getOwnPropertyDescriptor(params, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw paramsError("parameters must be enumerable data properties");
    }
    if (!isSqliteValue(descriptor.value)) {
      throw paramsError(
        "parameter values must be null, number, bigint, string, or Uint8Array",
      );
    }
    bound[key] = descriptor.value;
  }
  return bound;
}

function bigintResult(value: number | bigint, field: string): bigint {
  if (typeof value !== "bigint") {
    throw new SqliteCapabilityError(
      `node:sqlite did not return bigint-safe ${field}`,
    );
  }
  return value;
}

class NodeSqliteStatement implements SqliteStatement {
  readonly #statement: NativeStatement;

  constructor(statement: NativeStatement) {
    this.#statement = statement;
    statement.setReadBigInts(true);
  }

  run(params?: SqliteParams): SqliteRunResult {
    const result = params === undefined
      ? this.#statement.run()
      : this.#statement.run(validateParams(params));
    return {
      changes: bigintResult(result.changes, "changes"),
      lastInsertRowid: bigintResult(result.lastInsertRowid, "lastInsertRowid"),
    };
  }

  get(params?: SqliteParams): SqliteRow | undefined {
    const row = params === undefined
      ? this.#statement.get()
      : this.#statement.get(validateParams(params));
    return row as SqliteRow | undefined;
  }

  all(params?: SqliteParams): SqliteRow[] {
    const rows = params === undefined
      ? this.#statement.all()
      : this.#statement.all(validateParams(params));
    return rows as SqliteRow[];
  }

  iterate(params?: SqliteParams): IterableIterator<SqliteRow> {
    const rows = params === undefined
      ? this.#statement.iterate()
      : this.#statement.iterate(validateParams(params));
    return rows as IterableIterator<SqliteRow>;
  }
}

class NodeSqliteConnection implements SqliteConnection {
  readonly #database: NativeDatabase;

  constructor(database: NativeDatabase, binding?: BoundFileIdentity) {
    this.#database = database;
    if (binding !== undefined) { boundConnections.set(this, binding); Object.freeze(this); }
  }

  exec(sql: string): void {
    this.#database.exec(sql);
  }

  prepare(sql: string): SqliteStatement {
    return new NodeSqliteStatement(this.#database.prepare(sql));
  }

  close(): void {
    boundConnections.delete(this);
    this.#database.close();
  }
}

export class NodeSqliteDriver implements SqliteDriver {
  readonly #sqlite: NodeSqliteModule;

  constructor(sqlite: NodeSqliteModule) {
    this.#sqlite = sqlite;
  }

  open(path: string, options: SqliteOpenOptions): SqliteConnection {
    if (
      options.mode !== "create"
      && options.mode !== "existing"
      && options.mode !== "read-only-existing"
    ) {
      throw new SqliteCapabilityError("SQLite open mode is invalid");
    }
    if (!Number.isSafeInteger(options.busyTimeoutMs) || options.busyTimeoutMs < 0) {
      throw new SqliteCapabilityError("SQLite busy timeout must be a non-negative safe integer");
    }
    if (options.bindFileIdentity !== undefined && (options.bindFileIdentity !== true || options.mode === "create")) bindingFailure();

    if (options.mode === "create") {
      return this.openCreate(path, options);
    }
    return this.openExisting(path, options);
  }

  private openCreate(path: string, options: SqliteOpenOptions): SqliteConnection {
    let database: NativeDatabase | undefined;
    try {
      database = new this.#sqlite.DatabaseSync(path, nativeOptions(options));
      configureWritableConnection(database, options.busyTimeoutMs);
      return new NodeSqliteConnection(database);
    } catch (error) {
      database?.close();
      throw this.capabilityFailure("SQLite create-mode hardening failed", error);
    }
  }

  private openExisting(path: string, options: SqliteOpenOptions): SqliteConnection {
    // The migration owner must control this pathname throughout synchronous native opening and transactions.
    const binding = options.bindFileIdentity === true ? captureBoundFile(path) : undefined;
    const readOnlyOptions: SqliteOpenOptions = {
      ...options,
      mode: "read-only-existing",
    };
    let preflight: NativeDatabase | undefined;
    try {
      preflight = new this.#sqlite.DatabaseSync(path, nativeOptions(readOnlyOptions));
      if (binding !== undefined) assertSameBoundFile(binding);
      configureReadOnlyConnection(preflight, options.busyTimeoutMs);
      verifyProjectIdentity(preflight);
      if (options.mode === "read-only-existing") {
        verifyWal(preflight);
        if (binding !== undefined) assertSameBoundFile(binding);
        return new NodeSqliteConnection(preflight, binding);
      }
      preflight.close();
      preflight = undefined;
    } catch (error) {
      preflight?.close();
      throw this.capabilityFailure("SQLite existing-store preflight failed", error);
    }

    let database: NativeDatabase | undefined;
    try {
      database = new this.#sqlite.DatabaseSync(path, nativeOptions(options));
      if (binding !== undefined) assertSameBoundFile(binding);
      verifyProjectIdentity(database);
      configureWritableConnection(database, options.busyTimeoutMs);
      if (binding !== undefined) assertSameBoundFile(binding);
      return new NodeSqliteConnection(database, binding);
    } catch (error) {
      database?.close();
      throw this.capabilityFailure("SQLite existing-store hardening failed", error);
    }
  }

  private capabilityFailure(message: string, cause: unknown): SqliteCapabilityError {
    return cause instanceof SqliteCapabilityError
      ? cause
      : new SqliteCapabilityError(message, { cause });
  }
}
