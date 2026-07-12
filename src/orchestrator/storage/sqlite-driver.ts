export type SqliteValue = null | number | bigint | string | Uint8Array;
export type SqliteParams = Record<`$${string}`, SqliteValue>;
export type SqliteRow = Record<string, SqliteValue>;

export interface SqliteRunResult {
  changes: bigint;
  lastInsertRowid: bigint;
}

export interface SqliteStatement {
  run(params?: SqliteParams): SqliteRunResult;
  get(params?: SqliteParams): SqliteRow | undefined;
  all(params?: SqliteParams): SqliteRow[];
  iterate(params?: SqliteParams): IterableIterator<SqliteRow>;
}

export interface SqliteConnection {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export interface SqliteOpenOptions {
  mode: "create" | "existing" | "read-only-existing";
  busyTimeoutMs: number;
}

export interface SqliteDriver {
  open(path: string, options: SqliteOpenOptions): SqliteConnection;
}

export class SqliteCapabilityError extends Error {
  readonly code = "SQLITE_CAPABILITY_MISSING" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SqliteCapabilityError";
  }
}

export class SqliteParamsError extends Error {
  readonly code = "SQLITE_PARAMS_INVALID" as const;

  constructor(message: string) {
    super(message);
    this.name = "SqliteParamsError";
  }
}
