import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmdirSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { LifecycleError } from "../lifecycle/errors.js";
import type { SqliteDriver } from "../storage/sqlite-driver.js";
import {
  PROJECTION_NAMES,
  projectionCoreChecksum,
  type CanonicalProjectionRow,
  type ProjectionName,
} from "./checksum.js";
import type { ProjectBinding, ProjectionFoldState } from "./contracts.js";
import {
  replayCommittedProjectionEvents,
  type CommittedProjectionReplayResult,
} from "./event-reader.js";
import { ProjectionFoldAccumulator } from "./folds.js";
import {
  parseProjectionManifest,
  verifyProjectionPublicationPaths,
  type ProjectionManifestV1,
} from "./manifest.js";
import { PROJECTION_SCHEMA_SQL_V1, PROJECTION_SCHEMA_VERSION } from "./schema.js";
import { decodeProjectionEvent } from "./source-event-codec.js";
import {
  captureProjectionDirectoryIdentity,
  sameProjectionDirectoryIdentity,
  type ProjectionDirectoryIdentity,
} from "./stable-directory.js";

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAX_ROWS = 100_000;
const MAX_VALUE_BYTES = 256 * 1_024;
const MAX_CANONICAL_BYTES = 32 * 1024 * 1024;
const MAX_PROJECTION_DATABASE_BYTES = 128 * 1024 * 1024;

export type ProjectionIntegrityFaultBoundary =
  | "after-generation-identity-before-open"
  | "after-generation-open-before-inspection"
  | "after-private-root-validation-before-cleanup";

export interface ProjectionIntegrityFaultInjector {
  hit(boundary: ProjectionIntegrityFaultBoundary, inspectionRootPath?: string): void;
}

export interface ProjectionIntegrityServiceOptions {
  readonly driver: SqliteDriver;
  readonly eventStorePath: string;
  readonly projectionDirectory: string;
  readonly busyTimeoutMs?: number;
  readonly maxReplayEvents?: number;
  readonly maxReplayBytes?: number;
  readonly faultInjector?: ProjectionIntegrityFaultInjector;
}

export interface ProjectionIntegrityReport {
  readonly status: "passed";
  readonly terminalEventPosition: string;
}

type ProjectionRows = Readonly<Record<ProjectionName, readonly CanonicalProjectionRow[]>>;
type ExpectedProjectionRows = Readonly<
  Record<ProjectionName, ReadonlyMap<string, CanonicalProjectionRow>>
>;

interface ProjectionTable {
  readonly table: string;
  readonly columns: readonly string[];
  readonly keyColumns: readonly string[];
  readonly order: string;
  readonly canonicalRowId?: boolean;
}

interface ProjectionGenerationIdentity {
  readonly canonicalPath: string;
  readonly device: string;
  readonly inode: string;
  readonly size: string;
}

interface PinnedGenerationImage {
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

interface PrivateGenerationInspection {
  readonly database: DatabaseSync;
  close(): void;
}

const TABLES = Object.freeze({
  sessionTree: Object.freeze({
    table: "session_tree",
    columns: Object.freeze(["project_id", "session_id", "checkpoint_id", "checkpoint_version", "base_event_position", "source_event_position", "occurred_at", "task_summary"]),
    keyColumns: Object.freeze(["project_id", "session_id"]),
    order: "project_id, session_id",
  }),
  canonicalItems: Object.freeze({
    table: "canonical_items",
    columns: Object.freeze(["project_id", "item_id", "normalized_key", "status", "confidence", "verification_method", "valid_from", "valid_to", "summary", "content_hash", "known_from_event_position", "source_event_position"]),
    keyColumns: Object.freeze(["project_id", "item_id"]),
    order: "project_id, item_id",
  }),
  tasksFollowups: Object.freeze({
    table: "tasks_followups",
    columns: Object.freeze(["project_id", "session_id", "follow_up_id", "status", "summary", "confidence", "source_event_position"]),
    keyColumns: Object.freeze(["project_id", "follow_up_id"]),
    order: "project_id, follow_up_id",
  }),
  artifactsFiles: Object.freeze({
    table: "artifacts_files",
    columns: Object.freeze(["project_id", "session_id", "artifact_id", "path", "summary", "action", "content_hash", "branch_ref", "confidence", "source_event_position"]),
    keyColumns: Object.freeze(["project_id", "session_id", "artifact_id"]),
    order: "project_id, session_id, artifact_id",
  }),
  entityGraph: Object.freeze({
    table: "entity_graph",
    columns: Object.freeze(["project_id", "edge_id", "source_entity_id", "relationship", "target_entity_id", "source_event_position"]),
    keyColumns: Object.freeze(["project_id", "edge_id"]),
    order: "project_id, edge_id",
  }),
  lexicalChunks: Object.freeze({
    table: "lexical_chunks",
    columns: Object.freeze(["project_id", "chunk_id", "item_id", "session_id", "section", "normalized_key", "text", "source_event_position"]),
    keyColumns: Object.freeze(["project_id", "chunk_id"]),
    order: "project_id, chunk_id",
    canonicalRowId: true,
  }),
  retrievalFeedback: Object.freeze({
    table: "retrieval_feedback",
    columns: Object.freeze(["project_id", "feedback_id", "item_id", "outcome", "usefulness", "source_item_event_position", "source_event_position"]),
    keyColumns: Object.freeze(["project_id", "feedback_id"]),
    order: "project_id, feedback_id",
  }),
} as const satisfies Record<ProjectionName, ProjectionTable>);

const INTEGER_NUMBER_COLUMNS = new Set(["checkpoint_version", "usefulness"]);
const PRIVATE_INSPECTION_CLEANUP_TIMEOUT_MS = 5_000;
const PRIVATE_INSPECTION_CLEANUP_SCRIPT = String.raw`
"use strict";
const { lstatSync, realpathSync, readdirSync, unlinkSync } = require("node:fs");
const { resolve } = require("node:path");
const [expectedPath, expectedDevice, expectedInode] = process.argv.slice(1);
const normalized = (path) => {
  const value = resolve(path);
  return process.platform === "win32" ? value.toLowerCase() : value;
};
const invalid = () => { throw new Error("PROJECTION_PATH_INVALID"); };
const sleep = (milliseconds) => Atomics.wait(
  new Int32Array(new SharedArrayBuffer(4)),
  0,
  0,
  milliseconds,
);
const assertDirectory = () => {
  const directory = lstatSync(".", { bigint: true });
  if (!directory.isDirectory() || directory.isSymbolicLink()) invalid();
  if (
    normalized(realpathSync.native(".")) !== normalized(expectedPath)
    || directory.dev.toString() !== expectedDevice
    || directory.ino.toString() !== expectedInode
  ) invalid();
};
const allowed = new Set([
  "generation.sqlite",
  "generation.sqlite-journal",
  "generation.sqlite-shm",
  "generation.sqlite-wal",
]);
try {
  assertDirectory();
  const names = readdirSync(".");
  if (names.some((name) => !allowed.has(name))) invalid();
  for (const name of names) {
    let removed = false;
    for (let attempt = 0; attempt < 4 && !removed; attempt += 1) {
      assertDirectory();
      try {
        const entry = lstatSync(name);
        if (!entry.isFile() || entry.isSymbolicLink()) invalid();
        unlinkSync(name);
        removed = true;
      } catch (error) {
        if (error && error.code === "ENOENT") removed = true;
        else if (
          attempt < 3
          && error
          && (error.code === "EBUSY" || error.code === "EMFILE" || error.code === "ENFILE"
            || error.code === "ENOTEMPTY" || error.code === "EPERM")
        ) sleep(25);
        else throw error;
      }
    }
  }
  assertDirectory();
  if (readdirSync(".").length !== 0) invalid();
  process.stdout.write("cleaned");
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : "PROJECTION_PATH_INVALID");
  process.exitCode = 2;
}
`;

function integrity(): never {
  throw new LifecycleError("INTEGRITY_FAILURE");
}

function statement(database: DatabaseSync, sql: string): StatementSync {
  const result = database.prepare(sql);
  result.setReadBigInts(true);
  return result;
}

function normalizedPath(path: string): string {
  const value = resolve(path);
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function captureGenerationIdentity(path: string): ProjectionGenerationIdentity {
  const stat = lstatSync(path, { bigint: true });
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.size < 1n
    || stat.size > BigInt(MAX_PROJECTION_DATABASE_BYTES)
    || normalizedPath(realpathSync.native(path)) !== normalizedPath(path)
  ) return integrity();
  return Object.freeze({
    canonicalPath: path,
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    size: stat.size.toString(),
  });
}

function sameGenerationIdentity(
  left: ProjectionGenerationIdentity,
  right: ProjectionGenerationIdentity,
): boolean {
  return normalizedPath(left.canonicalPath) === normalizedPath(right.canonicalPath)
    && left.device === right.device
    && left.inode === right.inode
    && left.size === right.size;
}

function descriptorMatchesIdentity(
  descriptor: number,
  expected: ProjectionGenerationIdentity,
): boolean {
  const stat = fstatSync(descriptor, { bigint: true });
  return stat.isFile()
    && stat.dev.toString() === expected.device
    && stat.ino.toString() === expected.inode
    && stat.size.toString() === expected.size;
}

function readGenerationImage(
  path: string,
  expected: ProjectionGenerationIdentity,
): PinnedGenerationImage {
  const size = Number(expected.size);
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_PROJECTION_DATABASE_BYTES) {
    return integrity();
  }
  const bytes = Buffer.allocUnsafe(size);
  const descriptor = openSync(path, "r");
  try {
    if (!descriptorMatchesIdentity(descriptor, expected)) return integrity();
    let offset = 0;
    while (offset < bytes.length) {
      const bytesRead = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) return integrity();
      offset += bytesRead;
    }
    if (!descriptorMatchesIdentity(descriptor, expected)) return integrity();
  } finally {
    closeSync(descriptor);
  }
  return Object.freeze({
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

function hashGeneration(
  path: string,
  expected: ProjectionGenerationIdentity,
): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(path, "r");
  try {
    if (!descriptorMatchesIdentity(descriptor, expected)) return integrity();
    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (!descriptorMatchesIdentity(descriptor, expected)) return integrity();
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function hashGenerationDescriptor(
  descriptor: number,
  expected: ProjectionGenerationIdentity,
): string {
  if (!descriptorMatchesIdentity(descriptor, expected)) return integrity();
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  while (offset < Number(expected.size)) {
    const bytesRead = readSync(
      descriptor,
      buffer,
      0,
      Math.min(buffer.byteLength, Number(expected.size) - offset),
      offset,
    );
    if (bytesRead === 0) return integrity();
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  if (!descriptorMatchesIdentity(descriptor, expected)) return integrity();
  return hash.digest("hex");
}

function isPrivateInspectionChild(tempBase: string, candidate: string): boolean {
  const fromBase = relative(tempBase, candidate);
  return isAbsolute(candidate)
    && fromBase.length > 0
    && fromBase !== ".."
    && !fromBase.startsWith(`..${sep}`)
    && !isAbsolute(fromBase)
    && !fromBase.includes(sep)
    && /^project-memory-projection-integrity-[A-Za-z0-9_-]{6}$/u.test(fromBase);
}

function privateInspectionRoot(): Readonly<{
  readonly path: string;
  readonly identity: ProjectionDirectoryIdentity;
}> {
  const tempBase = realpathSync.native(tmpdir());
  const created = mkdtempSync(join(tempBase, "project-memory-projection-integrity-"));
  let root: Readonly<{
    readonly path: string;
    readonly identity: ProjectionDirectoryIdentity;
  }> | undefined;
  try {
    const canonical = realpathSync.native(created);
    if (
      normalizedPath(canonical) !== normalizedPath(created)
      || !isPrivateInspectionChild(tempBase, canonical)
    ) return integrity();
    chmodSync(canonical, 0o700);
    root = Object.freeze({
      path: canonical,
      identity: captureProjectionDirectoryIdentity(canonical),
    });
    return root;
  } catch (error) {
    if (root !== undefined) {
      try { removePrivateInspectionRoot(root); } catch { /* preserve creation failure */ }
    }
    throw error;
  }
}

function removePrivateInspectionRoot(
  root: Readonly<{ readonly path: string; readonly identity: ProjectionDirectoryIdentity }>,
  faultInjector?: ProjectionIntegrityFaultInjector,
): void {
  const tempBase = realpathSync.native(tmpdir());
  if (
    !isPrivateInspectionChild(tempBase, root.path)
    || !sameProjectionDirectoryIdentity(
      root.identity,
      captureProjectionDirectoryIdentity(root.path),
    )
  ) return integrity();
  faultInjector?.hit("after-private-root-validation-before-cleanup", root.path);
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      PRIVATE_INSPECTION_CLEANUP_SCRIPT,
      root.identity.canonicalPath,
      root.identity.device,
      root.identity.inode,
    ],
    {
      cwd: root.path,
      encoding: "utf8",
      maxBuffer: 1_024,
      timeout: PRIVATE_INSPECTION_CLEANUP_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  if (result.status !== 0 || result.error !== undefined || result.stdout !== "cleaned") {
    return integrity();
  }
  if (!sameProjectionDirectoryIdentity(
    root.identity,
    captureProjectionDirectoryIdentity(root.path),
  )) return integrity();
  // Only the now-empty directory entry is removed by pathname. Recursive
  // deletion is deliberately forbidden: a replacement can at worst make this
  // non-recursive rmdir fail, never expose another tree to deletion.
  rmdirSync(root.path);
}

function openPrivateGenerationInspection(
  pinnedImage: PinnedGenerationImage,
  busyTimeoutMs: number,
  faultInjector?: ProjectionIntegrityFaultInjector,
): PrivateGenerationInspection {
  const root = privateInspectionRoot();
  const databasePath = join(root.path, "generation.sqlite");
  let descriptor: number | undefined;
  let database: DatabaseSync | undefined;
  try {
    descriptor = openSync(databasePath, "wx+", 0o600);
    chmodSync(databasePath, 0o600);
    let offset = 0;
    while (offset < pinnedImage.bytes.byteLength) {
      const written = writeSync(
        descriptor,
        pinnedImage.bytes,
        offset,
        pinnedImage.bytes.byteLength - offset,
        offset,
      );
      if (written === 0) return integrity();
      offset += written;
    }
    fsyncSync(descriptor);
    const scratchIdentity = captureGenerationIdentity(databasePath);
    if (
      scratchIdentity.size !== String(pinnedImage.bytes.byteLength)
      || !descriptorMatchesIdentity(descriptor, scratchIdentity)
      || hashGenerationDescriptor(descriptor, scratchIdentity) !== pinnedImage.sha256
    ) return integrity();
    database = new DatabaseSync(databasePath, {
      open: true,
      readOnly: true,
      timeout: busyTimeoutMs,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
    });
    if (!sameGenerationIdentity(scratchIdentity, captureGenerationIdentity(databasePath))) {
      return integrity();
    }
    const openedDatabase = database;
    const openedDescriptor = descriptor;
    let closed = false;
    return Object.freeze({
      database: openedDatabase,
      close(): void {
        if (closed) return;
        closed = true;
        let closeError: unknown;
        try { openedDatabase.close(); } catch (error) { closeError = error; }
        try { closeSync(openedDescriptor); } catch (error) { closeError ??= error; }
        try { removePrivateInspectionRoot(root, faultInjector); } catch (error) { closeError ??= error; }
        if (closeError !== undefined) throw closeError;
      },
    });
  } catch (error) {
    try { database?.close(); } catch { /* preserve creation failure */ }
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* preserve creation failure */ }
    }
    try { removePrivateInspectionRoot(root, faultInjector); } catch { /* preserve creation failure */ }
    throw error;
  }
}

function projectionRowKey(
  definition: ProjectionTable,
  row: CanonicalProjectionRow,
): string {
  let key = "";
  for (const column of definition.keyColumns) {
    const value = row[column];
    if (typeof value !== "string") return integrity();
    key += `${Buffer.byteLength(value, "utf8")}:${value}`;
  }
  return key;
}

function expectedMap<T>(
  name: ProjectionName,
  source: readonly T[],
  convert: (row: T) => CanonicalProjectionRow,
): ReadonlyMap<string, CanonicalProjectionRow> {
  const result = new Map<string, CanonicalProjectionRow>();
  const definition: ProjectionTable = TABLES[name];
  for (const sourceRow of source) {
    const row = Object.freeze(convert(sourceRow));
    const key = projectionRowKey(definition, row);
    if (result.has(key) || result.size >= MAX_ROWS) return integrity();
    result.set(key, row);
  }
  return result;
}

function rowsFromState(state: ProjectionFoldState): ExpectedProjectionRows {
  return Object.freeze({
    sessionTree: expectedMap("sessionTree", state.sessionCheckpoints, (row) => ({
      project_id: row.projectId,
      session_id: row.sessionId,
      checkpoint_id: row.checkpointId,
      checkpoint_version: row.checkpointVersion,
      base_event_position: row.baseEventPosition.toString(),
      source_event_position: row.sourceEventPosition.toString(),
      occurred_at: row.occurredAt,
      task_summary: row.taskSummary,
    })),
    canonicalItems: expectedMap("canonicalItems", state.canonicalItems, (row) => ({
      project_id: row.projectId,
      item_id: row.itemId,
      normalized_key: row.normalizedKey,
      status: row.status,
      confidence: row.confidence,
      verification_method: row.verificationMethod,
      valid_from: row.validFrom,
      valid_to: row.validTo,
      summary: row.summary,
      content_hash: row.contentHash,
      known_from_event_position: row.knownFromEventPosition.toString(),
      source_event_position: row.sourceEventPosition.toString(),
    })),
    tasksFollowups: expectedMap("tasksFollowups", state.followUps, (row) => ({
      project_id: row.projectId,
      session_id: row.sessionId,
      follow_up_id: row.followUpId,
      status: row.status,
      summary: row.summary,
      confidence: row.confidence,
      source_event_position: row.sourceEventPosition.toString(),
    })),
    artifactsFiles: expectedMap("artifactsFiles", state.artifacts, (row) => ({
      project_id: row.projectId,
      session_id: row.sessionId,
      artifact_id: row.artifactId,
      path: row.path,
      summary: row.summary,
      action: row.action,
      content_hash: row.contentHash,
      branch_ref: row.branchRef,
      confidence: row.confidence,
      source_event_position: row.sourceEventPosition.toString(),
    })),
    entityGraph: new Map<string, CanonicalProjectionRow>(),
    lexicalChunks: expectedMap("lexicalChunks", state.lexicalChunks, (row) => ({
      project_id: row.projectId,
      chunk_id: row.chunkId,
      item_id: row.itemId,
      session_id: row.sessionId,
      section: row.section,
      normalized_key: row.normalizedKey,
      text: row.text,
      source_event_position: row.sourceEventPosition.toString(),
    })),
    retrievalFeedback: expectedMap("retrievalFeedback", state.retrievalFeedback, (row) => ({
      project_id: row.projectId,
      feedback_id: row.feedbackId,
      item_id: row.itemId,
      outcome: row.outcome,
      usefulness: row.usefulness,
      source_item_event_position: row.sourceItemEventPosition.toString(),
      source_event_position: row.sourceEventPosition.toString(),
    })),
  });
}

function replay(
  binding: ProjectBinding,
  manifest: ProjectionManifestV1,
  options: ProjectionIntegrityServiceOptions,
): ExpectedProjectionRows {
  const terminalEventPosition = BigInt(manifest.terminalEventPosition);
  const accumulator = new ProjectionFoldAccumulator();
  const replayResult: CommittedProjectionReplayResult = replayCommittedProjectionEvents(binding, {
    driver: options.driver,
    eventStorePath: options.eventStorePath,
    busyTimeoutMs: options.busyTimeoutMs,
    terminalEventPosition,
    maxEvents: options.maxReplayEvents,
    maxAggregateBytes: options.maxReplayBytes,
  }, (source) => {
    const decoded = decodeProjectionEvent(source);
    if (decoded.kind === "projected") accumulator.append(decoded.event);
  });
  if (
    replayResult.terminalEventPosition !== terminalEventPosition
    || replayResult.terminalEventHash !== manifest.terminalEventHash
  ) return integrity();
  return rowsFromState(accumulator.finish());
}

function canonicalValue(value: unknown, column: string): CanonicalProjectionRow[string] {
  if (value === null) return null;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) return integrity();
    return value;
  }
  if (typeof value === "bigint") {
    if (INTEGER_NUMBER_COLUMNS.has(column)) {
      if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
        return integrity();
      }
      return Number(value);
    }
    return value.toString();
  }
  return integrity();
}

function sameRow(
  actual: CanonicalProjectionRow,
  expected: CanonicalProjectionRow,
  columns: readonly string[],
): boolean {
  for (const column of columns) {
    if (actual[column] !== expected[column]) return false;
  }
  return true;
}

function readExactRows(
  database: DatabaseSync,
  expectedRows: ExpectedProjectionRows,
  projectId: string,
  terminalEventPosition: bigint,
  manifestChecksums: Readonly<Record<ProjectionName, string>>,
): ProjectionRows {
  const result = {} as Record<ProjectionName, readonly CanonicalProjectionRow[]>;
  let totalBytes = 0;
  for (const name of PROJECTION_NAMES) {
    const definition: ProjectionTable = TABLES[name];
    const selected = definition.canonicalRowId
      ? ["row_id", ...definition.columns]
      : definition.columns;
    const iterator = statement(database, `
      SELECT ${selected.join(", ")}
      FROM ${definition.table}
      ORDER BY ${definition.order}
    `).iterate();
    const rows: CanonicalProjectionRow[] = [];
    const seen = new Set<string>();
    let index = 0;
    for (const raw of iterator) {
      if (index >= MAX_ROWS || index >= expectedRows[name].size) return integrity();
      if (definition.canonicalRowId && raw.row_id !== BigInt(index + 1)) return integrity();
      const row: Record<string, CanonicalProjectionRow[string]> = {};
      for (const column of definition.columns) {
        if (!(column in raw)) return integrity();
        row[column] = canonicalValue(raw[column], column);
        totalBytes += Buffer.byteLength(JSON.stringify(row[column]), "utf8");
        if (totalBytes > MAX_CANONICAL_BYTES) return integrity();
      }
      const canonical = Object.freeze(row);
      const key = projectionRowKey(definition, canonical);
      const expected = expectedRows[name].get(key);
      if (
        expected === undefined
        || seen.has(key)
        || !sameRow(canonical, expected, definition.columns)
      ) return integrity();
      seen.add(key);
      rows.push(canonical);
      index += 1;
    }
    if (index !== expectedRows[name].size || seen.size !== expectedRows[name].size) return integrity();
    const frozen = Object.freeze(rows);
    const checksum = projectionCoreChecksum(
      name,
      PROJECTION_SCHEMA_VERSION,
      projectId,
      terminalEventPosition,
      frozen,
    );
    if (checksum !== manifestChecksums[name]) return integrity();
    result[name] = frozen;
  }
  return Object.freeze(result);
}

function schemaRows(database: DatabaseSync): readonly Readonly<Record<string, unknown>>[] {
  const rows: Readonly<Record<string, unknown>>[] = [];
  for (const row of statement(database, `
    SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    ORDER BY type, name, tbl_name
  `).iterate()) {
    if (rows.length >= 128) return integrity();
    rows.push(Object.freeze({
      type: row.type,
      name: row.name,
      tbl_name: row.tbl_name,
      sql: row.sql,
    }));
  }
  return Object.freeze(rows);
}

function sameRecords(
  actual: readonly Readonly<Record<string, unknown>>[],
  expected: readonly Readonly<Record<string, unknown>>[],
  columns: readonly string[],
): boolean {
  if (actual.length !== expected.length) return false;
  return actual.every((row, index) => columns.every(
    (column) => row[column] === expected[index]?.[column],
  ));
}

function ftsConfigRows(database: DatabaseSync): readonly Readonly<Record<string, unknown>>[] {
  const rows: Readonly<Record<string, unknown>>[] = [];
  for (const row of statement(database, `
    SELECT k, v FROM lexical_chunks_fts_config ORDER BY k
  `).iterate()) {
    if (rows.length >= 16) return integrity();
    rows.push(Object.freeze({ k: row.k, v: row.v }));
  }
  return Object.freeze(rows);
}

function assertCanonicalSchema(database: DatabaseSync): void {
  const reference = new DatabaseSync(":memory:", {
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
  });
  try {
    reference.exec(PROJECTION_SCHEMA_SQL_V1);
    if (
      !sameRecords(schemaRows(database), schemaRows(reference), ["type", "name", "tbl_name", "sql"])
      || !sameRecords(ftsConfigRows(database), ftsConfigRows(reference), ["k", "v"])
    ) return integrity();
  } finally {
    reference.close();
  }
}

function assertMetadata(
  database: DatabaseSync,
  binding: ProjectBinding,
  manifest: ProjectionManifestV1,
): void {
  const iterator = statement(database, `
    SELECT singleton, schema_version, project_id, vault_id, store_id, workspace_id,
           branch_scope_id, branch_ref, session_id, generation,
           terminal_event_position, terminal_event_hash, created_at
    FROM projection_metadata ORDER BY singleton
  `).iterate();
  const first = iterator.next();
  if (first.done || !iterator.next().done) return integrity();
  const row = first.value;
  if (
    row.singleton !== 1n
    || row.schema_version !== 1n
    || row.project_id !== binding.projectId
    || row.vault_id !== binding.vaultId
    || row.store_id !== binding.storeId
    || row.workspace_id !== binding.workspaceId
    || row.branch_scope_id !== binding.branchScopeId
    || row.branch_ref !== binding.branchRef
    || row.session_id !== null
    || row.generation !== BigInt(manifest.generation)
    || row.terminal_event_position !== BigInt(manifest.terminalEventPosition)
    || row.terminal_event_hash !== manifest.terminalEventHash
    || row.created_at !== manifest.createdAt
  ) return integrity();
}

function scalarCount(database: DatabaseSync, sql: string): bigint {
  const value = statement(database, sql).get()?.n;
  if (typeof value !== "bigint" || value < 0n) return integrity();
  return value;
}

function assertReferences(database: DatabaseSync): void {
  if (
    scalarCount(database, `
      SELECT count(*) AS n FROM retrieval_feedback AS feedback
      LEFT JOIN canonical_items AS item
        ON item.project_id = feedback.project_id AND item.item_id = feedback.item_id
      WHERE item.item_id IS NULL
    `) !== 0n
    || scalarCount(database, `
      SELECT count(*) AS n FROM lexical_chunks AS chunk
      LEFT JOIN canonical_items AS item
        ON item.project_id = chunk.project_id AND item.item_id = chunk.item_id
      WHERE chunk.item_id IS NOT NULL AND item.item_id IS NULL
    `) !== 0n
    || scalarCount(database, `
      SELECT count(*) AS n FROM tasks_followups AS follow_up
      LEFT JOIN session_tree AS session
        ON session.project_id = follow_up.project_id AND session.session_id = follow_up.session_id
      WHERE session.session_id IS NULL
    `) !== 0n
    || scalarCount(database, `
      SELECT count(*) AS n FROM artifacts_files AS artifact
      LEFT JOIN session_tree AS session
        ON session.project_id = artifact.project_id AND session.session_id = artifact.session_id
      WHERE session.session_id IS NULL
    `) !== 0n
  ) return integrity();
}

function assertSqliteIntegrity(database: DatabaseSync): void {
  const integrityRows = statement(database, "PRAGMA integrity_check(1)").iterate();
  const first = integrityRows.next();
  if (first.done || first.value.integrity_check !== "ok" || !integrityRows.next().done) {
    return integrity();
  }
  if (!statement(database, "PRAGMA foreign_key_check").iterate().next().done) return integrity();
}

function assertFtsSemantics(
  database: DatabaseSync,
  lexicalRows: readonly CanonicalProjectionRow[],
): void {
  database.exec(`
    CREATE VIRTUAL TABLE temp.expected_fts USING fts5(
      normalized_key,
      text,
      tokenize = 'unicode61 remove_diacritics 2'
    );
    CREATE VIRTUAL TABLE temp.actual_vocab USING fts5vocab(
      main,
      lexical_chunks_fts,
      instance
    );
    CREATE VIRTUAL TABLE temp.expected_vocab USING fts5vocab(
      temp,
      expected_fts,
      instance
    );
  `);
  const insert = database.prepare(`
    INSERT INTO temp.expected_fts(rowid, normalized_key, text) VALUES (?, ?, ?)
  `);
  for (let index = 0; index < lexicalRows.length; index += 1) {
    const row = lexicalRows[index]!;
    insert.run(index + 1, row.normalized_key as string, row.text as string);
  }
  const actual = statement(database, `
    SELECT term, doc, col, offset FROM temp.actual_vocab
    ORDER BY term, doc, col, offset
  `).iterate();
  const expected = statement(database, `
    SELECT term, doc, col, offset FROM temp.expected_vocab
    ORDER BY term, doc, col, offset
  `).iterate();
  while (true) {
    const left = actual.next();
    const right = expected.next();
    if (left.done || right.done) {
      if (left.done !== right.done) return integrity();
      break;
    }
    for (const column of ["term", "doc", "col", "offset"] as const) {
      if (left.value[column] !== right.value[column]) return integrity();
    }
  }
  // Vocab authenticates the semantic term/posting content represented by the
  // data/idx segment layout. The data id=1 averages record, every per-document
  // size record, and config are additionally rank-sensitive and must match the
  // independently populated canonical index byte-for-byte. The data id=10
  // structure record is intentionally not byte-compared because equivalent
  // segment histories have different physical encodings.
  const shadows = [
    Object.freeze({ suffix: "data", columns: Object.freeze(["id", "block"]), where: "WHERE id = 1", order: "id" }),
    Object.freeze({ suffix: "docsize", columns: Object.freeze(["id", "sz"]), where: "", order: "id" }),
    Object.freeze({ suffix: "config", columns: Object.freeze(["k", "v"]), where: "", order: "k" }),
  ] as const;
  for (const shadow of shadows) {
    const columns = shadow.columns.join(", ");
    const actualRows = statement(database, `
      SELECT ${columns} FROM lexical_chunks_fts_${shadow.suffix}
      ${shadow.where} ORDER BY ${shadow.order}
    `).iterate();
    const expectedRows = statement(database, `
      SELECT ${columns} FROM temp.expected_fts_${shadow.suffix}
      ${shadow.where} ORDER BY ${shadow.order}
    `).iterate();
    let count = 0;
    while (true) {
      const actualRow = actualRows.next();
      const expectedRow = expectedRows.next();
      if (actualRow.done || expectedRow.done) {
        if (actualRow.done !== expectedRow.done) return integrity();
        break;
      }
      if (count >= MAX_ROWS * 4) return integrity();
      for (const column of shadow.columns) {
        const actualValue = actualRow.value[column];
        const expectedValue = expectedRow.value[column];
        if (actualValue instanceof Uint8Array && expectedValue instanceof Uint8Array) {
          if (
            actualValue.byteLength !== expectedValue.byteLength
            || !Buffer.from(actualValue).equals(Buffer.from(expectedValue))
          ) return integrity();
        } else if (actualValue !== expectedValue) return integrity();
      }
      count += 1;
    }
  }
}

function inspectGeneration(
  path: string,
  binding: ProjectBinding,
  manifest: ProjectionManifestV1,
  expectedRows: ExpectedProjectionRows,
  busyTimeoutMs: number,
  directoryIdentity: ProjectionDirectoryIdentity,
  faultInjector?: ProjectionIntegrityFaultInjector,
): void {
  const generationIdentity = captureGenerationIdentity(path);
  if (!sameProjectionDirectoryIdentity(
    directoryIdentity,
    captureProjectionDirectoryIdentity(directoryIdentity.canonicalPath),
  )) return integrity();
  const pinnedImage = readGenerationImage(path, generationIdentity);
  if (pinnedImage.sha256 !== manifest.databaseSha256) return integrity();
  faultInjector?.hit("after-generation-identity-before-open");
  const inspection = openPrivateGenerationInspection(pinnedImage, busyTimeoutMs, faultInjector);
  const database = inspection.database;
  try {
    faultInjector?.hit("after-generation-open-before-inspection");
    if (
      !sameGenerationIdentity(generationIdentity, captureGenerationIdentity(path))
      || !sameProjectionDirectoryIdentity(
        directoryIdentity,
        captureProjectionDirectoryIdentity(directoryIdentity.canonicalPath),
      )
    ) return integrity();
    database.exec("PRAGMA trusted_schema = OFF; BEGIN");
    assertCanonicalSchema(database);
    assertMetadata(database, binding, manifest);
    assertSqliteIntegrity(database);
    const rows = readExactRows(
      database,
      expectedRows,
      binding.projectId,
      BigInt(manifest.terminalEventPosition),
      manifest.coreChecksums,
    );
    assertReferences(database);
    assertFtsSemantics(database, rows.lexicalChunks);
    if (
      !sameGenerationIdentity(generationIdentity, captureGenerationIdentity(path))
      || !sameProjectionDirectoryIdentity(
        directoryIdentity,
        captureProjectionDirectoryIdentity(directoryIdentity.canonicalPath),
      )
      || hashGeneration(path, generationIdentity) !== pinnedImage.sha256
    ) return integrity();
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* preserve integrity failure */ }
    throw error;
  } finally {
    inspection.close();
  }
  if (
    !sameGenerationIdentity(generationIdentity, captureGenerationIdentity(path))
    || !sameProjectionDirectoryIdentity(
      directoryIdentity,
      captureProjectionDirectoryIdentity(directoryIdentity.canonicalPath),
    )
    || hashGeneration(path, generationIdentity) !== pinnedImage.sha256
  ) return integrity();
}

export class ProjectionIntegrityService {
  readonly #options: ProjectionIntegrityServiceOptions;

  constructor(options: ProjectionIntegrityServiceOptions) {
    this.#options = Object.freeze({
      ...options,
      busyTimeoutMs: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
    });
  }

  verify(binding: ProjectBinding, manifestValue: ProjectionManifestV1): ProjectionIntegrityReport {
    try {
      const manifest = parseProjectionManifest(manifestValue, binding);
      const directoryIdentity = captureProjectionDirectoryIdentity(
        this.#options.projectionDirectory,
      );
      const paths = verifyProjectionPublicationPaths(
        this.#options.projectionDirectory,
        manifest.databaseFile,
      );
      const expectedRows = replay(binding, manifest, this.#options);
      inspectGeneration(
        paths.databasePath,
        binding,
        manifest,
        expectedRows,
        this.#options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
        directoryIdentity,
        this.#options.faultInjector,
      );
      return Object.freeze({
        status: "passed",
        terminalEventPosition: manifest.terminalEventPosition,
      });
    } catch (error) {
      if (error instanceof LifecycleError && error.code === "INTEGRITY_FAILURE") throw error;
      return integrity();
    }
  }
}
