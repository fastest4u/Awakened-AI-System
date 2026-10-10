import { DatabaseSync } from "node:sqlite";
import { LifecycleError } from "../lifecycle/errors.js";

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
function integrity(): never {
  throw new LifecycleError("INTEGRITY_FAILURE");
}

export function deserializableImage(bytes: Uint8Array): Uint8Array {
  const result = Uint8Array.from(bytes);
  const sqliteHeader = Buffer.from("SQLite format 3\0", "binary");
  if (
    result.byteLength < 100
    || !Buffer.from(result.subarray(0, sqliteHeader.byteLength)).equals(sqliteHeader)
    || (result[18] !== 1 && result[18] !== 2)
    || (result[19] !== 1 && result[19] !== 2)
  ) return integrity();
  // A deserialized in-memory database has no sibling WAL. Normalize only the
  // isolated copy's journal header; the manifest SHA domain and pinned bytes
  // remain the exact raw on-disk image.
  result[18] = 1;
  result[19] = 1;
  return result;
}

/** Opens a detached immutable SQLite image of its actual profile without consulting a filesystem path. */
export function openImmutableProjectionImage(
  bytes: Uint8Array,
  busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS,
): DatabaseSync {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(":memory:", {
      open: true,
      readOnly: false,
      timeout: busyTimeoutMs,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
      allowBareNamedParameters: false,
      allowUnknownNamedParameters: false,
      defensive: true,
    });
    database.deserialize(deserializableImage(bytes));
    database.enableDefensive(true);
    database.exec(`
      CREATE VIRTUAL TABLE temp.actual_vocab USING fts5vocab(
        main,
        lexical_chunks_fts,
        instance
      );
      PRAGMA query_only = ON;
      PRAGMA trusted_schema = OFF;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = ${busyTimeoutMs};
    `);
    if (
      Number(database.prepare("PRAGMA query_only").get()?.query_only) !== 1
      || Number(database.prepare("PRAGMA trusted_schema").get()?.trusted_schema) !== 0
      || Number(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys) !== 1
      || Number(database.prepare("PRAGMA busy_timeout").get()?.timeout) !== busyTimeoutMs
    ) return integrity();
    return database;
  } catch (error) {
    try { database?.close(); } catch { /* preserve immutable-image failure */ }
    throw error;
  }
}
