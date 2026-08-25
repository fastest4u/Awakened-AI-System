import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { resolve } from "node:path";
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
  assertProjectionSidecarsAbsent,
  filesystemProjectionPathInspection,
  parseProjectionManifestV2,
  verifyProjectionPublicationPaths,
  type ProjectionManifestV2,
  type ProjectionPathInspection,
} from "./manifest.js";
import { PROJECTION_SCHEMA_SQL_V2, PROJECTION_SCHEMA_VERSION } from "./schema.js";
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
const UNPUBLISHED_V2_GENERATION_FILE = /^projections-2-([1-9][0-9]{0,9})\.sqlite$/u;
const HASH = /^[0-9a-f]{64}$/u;

export type ProjectionIntegrityFaultBoundary =
  | "after-generation-identity-before-open"
  | "after-generation-open-before-inspection";

export interface ProjectionIntegrityFaultInjector {
  hit(boundary: ProjectionIntegrityFaultBoundary): void;
}

export interface ProjectionIntegrityServiceOptions {
  readonly driver: SqliteDriver;
  readonly eventStorePath: string;
  readonly projectionDirectory: string;
  readonly busyTimeoutMs?: number;
  readonly maxReplayEvents?: number;
  readonly maxReplayBytes?: number;
  readonly faultInjector?: ProjectionIntegrityFaultInjector;
  readonly pathInspection?: ProjectionPathInspection;
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
  assertUnchanged(): void;
  close(): void;
}

interface PinnedGenerationInspection {
  readonly database: DatabaseSync;
  close(): void;
}

const TABLES = Object.freeze({
  sessionTree: Object.freeze({
    table: "session_tree",
    columns: Object.freeze(["project_id", "session_id", "root_session_id", "parent_session_id", "lifecycle_state", "owner_generation", "opened_event_position", "closed_event_position", "latest_checkpoint_id", "latest_checkpoint_event_position", "source_event_id", "source_event_position", "anchor"]),
    keyColumns: Object.freeze(["project_id", "session_id"]),
    order: "project_id, session_id",
  }),
  sessionCheckpoints: Object.freeze({
    table: "session_checkpoints",
    columns: Object.freeze(["project_id", "session_id", "checkpoint_id", "checkpoint_version", "base_event_position", "source_event_id", "source_event_position", "occurred_at", "task_summary", "anchor"]),
    keyColumns: Object.freeze(["project_id", "checkpoint_id"]),
    order: "project_id, session_id, source_event_position, checkpoint_id",
  }),
  canonicalItems: Object.freeze({
    table: "canonical_items",
    columns: Object.freeze(["project_id", "session_id", "item_id", "normalized_key", "conflict_group_id", "superseding_item_id", "status", "confidence", "verification_method", "valid_from", "valid_to", "summary", "content_hash", "known_from_event_position", "source_event_id", "source_event_position", "anchor"]),
    keyColumns: Object.freeze(["project_id", "item_id"]),
    order: "project_id, item_id",
  }),
  tasksFollowups: Object.freeze({
    table: "tasks_followups",
    columns: Object.freeze(["project_id", "session_id", "follow_up_id", "status", "summary", "confidence", "source_event_id", "source_event_position", "anchor"]),
    keyColumns: Object.freeze(["project_id", "follow_up_id"]),
    order: "project_id, follow_up_id",
  }),
  artifactsFiles: Object.freeze({
    table: "artifacts_files",
    columns: Object.freeze(["project_id", "session_id", "artifact_id", "path", "summary", "action", "content_hash", "branch_ref", "confidence", "symbol", "commit_hash", "heading", "source_event_id", "source_event_position", "anchor"]),
    keyColumns: Object.freeze(["project_id", "session_id", "artifact_id"]),
    order: "project_id, session_id, artifact_id",
  }),
  lexicalChunks: Object.freeze({
    table: "lexical_chunks",
    columns: Object.freeze(["project_id", "chunk_id", "item_id", "session_id", "section", "normalized_key", "text", "source_event_id", "source_event_position", "anchor"]),
    keyColumns: Object.freeze(["project_id", "chunk_id"]),
    order: "project_id, chunk_id",
    canonicalRowId: true,
  }),
  retrievalFeedback: Object.freeze({
    table: "retrieval_feedback",
    columns: Object.freeze(["project_id", "feedback_id", "item_id", "outcome", "usefulness", "source_item_event_position", "source_event_id", "source_event_position", "anchor"]),
    keyColumns: Object.freeze(["project_id", "feedback_id"]),
    order: "project_id, feedback_id",
  }),
} as const satisfies Record<Exclude<ProjectionName, "entityGraph">, ProjectionTable>);

const ENTITY_TABLES = Object.freeze([
  Object.freeze({ relation: "node", table: "entity_nodes", columns: Object.freeze(["project_id", "entity_id", "normalized_name", "entity_type", "valid_from", "valid_to", "source_event_id", "source_event_position", "anchor"]), key: "entity_id", order: "project_id, entity_id" }),
  Object.freeze({ relation: "alias", table: "entity_aliases", columns: Object.freeze(["project_id", "alias_id", "entity_id", "normalized_alias", "valid_from", "valid_to", "source_event_id", "source_event_position", "anchor"]), key: "alias_id", order: "project_id, alias_id" }),
  Object.freeze({ relation: "edge", table: "entity_edges", columns: Object.freeze(["project_id", "edge_id", "source_entity_id", "target_entity_id", "edge_type", "valid_from", "valid_to", "source_event_id", "source_event_position", "anchor"]), key: "edge_id", order: "project_id, edge_id" }),
] as const);

const INTEGER_NUMBER_COLUMNS = new Set(["checkpoint_version", "owner_generation", "usefulness"]);
function integrity(): never {
  throw new LifecycleError("INTEGRITY_FAILURE");
}

function deserializableImage(bytes: Uint8Array): Uint8Array {
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

function hashDescriptor(descriptor: number, size: number): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(size, 1024 * 1024));
  let offset = 0;
  while (offset < size) {
    const bytesRead = readSync(
      descriptor,
      buffer,
      0,
      Math.min(buffer.byteLength, size - offset),
      offset,
    );
    if (bytesRead === 0) return integrity();
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return hash.digest("hex");
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
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    let closed = false;
    return Object.freeze({
      bytes,
      sha256,
      assertUnchanged(): void {
        if (
          closed
          || !descriptorMatchesIdentity(descriptor, expected)
          || hashDescriptor(descriptor, size) !== sha256
          || !descriptorMatchesIdentity(descriptor, expected)
        ) return integrity();
      },
      close(): void {
        if (closed) return;
        closed = true;
        closeSync(descriptor);
      },
    });
  } catch (error) {
    try { closeSync(descriptor); } catch { /* preserve capture failure */ }
    throw error;
  }
}

/** Opens a detached immutable SQLite image without consulting a filesystem path. */
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

function openPinnedGenerationInspection(
  pinnedImage: PinnedGenerationImage,
  busyTimeoutMs: number,
): PinnedGenerationInspection {
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
    database.deserialize(deserializableImage(pinnedImage.bytes));
    database.enableDefensive(true);
    database.exec(`
      CREATE VIRTUAL TABLE temp.actual_vocab USING fts5vocab(
        main,
        lexical_chunks_fts,
        instance
      );
      PRAGMA query_only = ON;
    `);
    database.exec(`
      PRAGMA trusted_schema = OFF;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = ${busyTimeoutMs};
    `);
    if (
      Number(database.prepare("PRAGMA query_only").get()?.query_only) !== 1
      || Number(database.prepare("PRAGMA trusted_schema").get()?.trusted_schema) !== 0
      || Number(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys) !== 1
      || Number(database.prepare("PRAGMA busy_timeout").get()?.timeout) !== busyTimeoutMs
    ) {
      return integrity();
    }
    const openedDatabase = database;
    let closed = false;
    return Object.freeze({
      database: openedDatabase,
      close(): void {
        if (closed) return;
        closed = true;
        let closeError: unknown;
        try { openedDatabase.close(); } catch (error) { closeError = error; }
        if (closeError !== undefined) throw closeError;
      },
    });
  } catch (error) {
    try { database?.close(); } catch { /* preserve creation failure */ }
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
  name: Exclude<ProjectionName, "entityGraph">,
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

function entityRowKey(row: CanonicalProjectionRow): string {
  const relation = row.relation;
  const projectId = row.project_id;
  const identity = relation === "node" ? row.entity_id : relation === "alias" ? row.alias_id : row.edge_id;
  if (typeof relation !== "string" || typeof projectId !== "string" || typeof identity !== "string") return integrity();
  return `${relation.length}:${relation}${projectId.length}:${projectId}${identity.length}:${identity}`;
}

function expectedEntityMap(rows: readonly CanonicalProjectionRow[]): ReadonlyMap<string, CanonicalProjectionRow> {
  const result = new Map<string, CanonicalProjectionRow>();
  for (const row of rows) {
    const frozen = Object.freeze(row);
    const key = entityRowKey(frozen);
    if (result.has(key) || result.size >= MAX_ROWS) return integrity();
    result.set(key, frozen);
  }
  return result;
}

function rowsFromState(state: ProjectionFoldState): ExpectedProjectionRows {
  return Object.freeze({
    sessionTree: expectedMap("sessionTree", state.sessionTree, (row) => ({
      project_id: row.projectId,
      session_id: row.sessionId,
      root_session_id: row.rootSessionId,
      parent_session_id: row.parentSessionId,
      lifecycle_state: row.lifecycleState,
      owner_generation: row.ownerGeneration,
      opened_event_position: row.openedEventPosition.toString(),
      closed_event_position: row.closedEventPosition?.toString() ?? null,
      latest_checkpoint_id: row.latestCheckpointId,
      latest_checkpoint_event_position: row.latestCheckpointEventPosition?.toString() ?? null,
      source_event_id: row.sourceEventId,
      source_event_position: row.sourceEventPosition.toString(),
      anchor: row.anchor,
    })),
    sessionCheckpoints: expectedMap("sessionCheckpoints", state.sessionCheckpoints, (row) => ({
      project_id: row.projectId,
      session_id: row.sessionId,
      checkpoint_id: row.checkpointId,
      checkpoint_version: row.checkpointVersion,
      base_event_position: row.baseEventPosition.toString(),
      source_event_id: row.sourceEventId,
      source_event_position: row.sourceEventPosition.toString(),
      occurred_at: row.occurredAt,
      task_summary: row.taskSummary,
      anchor: row.anchor,
    })),
    canonicalItems: expectedMap("canonicalItems", state.canonicalItems, (row) => ({
      project_id: row.projectId,
      session_id: row.sessionId,
      item_id: row.itemId,
      normalized_key: row.normalizedKey,
      conflict_group_id: row.conflictGroupId,
      superseding_item_id: row.supersedingItemId,
      status: row.status,
      confidence: row.confidence,
      verification_method: row.verificationMethod,
      valid_from: row.validFrom,
      valid_to: row.validTo,
      summary: row.summary,
      content_hash: row.contentHash,
      known_from_event_position: row.knownFromEventPosition.toString(),
      source_event_id: row.sourceEventId,
      source_event_position: row.sourceEventPosition.toString(),
      anchor: row.anchor,
    })),
    tasksFollowups: expectedMap("tasksFollowups", state.followUps, (row) => ({
      project_id: row.projectId,
      session_id: row.sessionId,
      follow_up_id: row.followUpId,
      status: row.status,
      summary: row.summary,
      confidence: row.confidence,
      source_event_id: row.sourceEventId,
      source_event_position: row.sourceEventPosition.toString(),
      anchor: row.anchor,
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
      symbol: row.symbol,
      commit_hash: row.commitHash,
      heading: row.heading,
      source_event_id: row.sourceEventId,
      source_event_position: row.sourceEventPosition.toString(),
      anchor: row.anchor,
    })),
    entityGraph: expectedEntityMap([
      ...state.entityNodes.map((row) => ({
        relation: "node", project_id: row.projectId, entity_id: row.entityId,
        normalized_name: row.normalizedName, entity_type: row.entityType, valid_from: row.validFrom,
        valid_to: row.validTo, source_event_id: row.sourceEventId,
        source_event_position: row.sourceEventPosition.toString(), anchor: row.anchor,
      })),
      ...state.entityAliases.map((row) => ({
        relation: "alias", project_id: row.projectId, alias_id: row.aliasId, entity_id: row.entityId,
        normalized_alias: row.normalizedAlias, valid_from: row.validFrom, valid_to: row.validTo,
        source_event_id: row.sourceEventId, source_event_position: row.sourceEventPosition.toString(), anchor: row.anchor,
      })),
      ...state.entityEdges.map((row) => ({
        relation: "edge", project_id: row.projectId, edge_id: row.edgeId,
        source_entity_id: row.sourceEntityId, target_entity_id: row.targetEntityId, edge_type: row.edgeType,
        valid_from: row.validFrom, valid_to: row.validTo, source_event_id: row.sourceEventId,
        source_event_position: row.sourceEventPosition.toString(), anchor: row.anchor,
      })),
    ]),
    lexicalChunks: expectedMap("lexicalChunks", state.lexicalChunks, (row) => ({
      project_id: row.projectId,
      chunk_id: row.chunkId,
      item_id: row.itemId,
      session_id: row.sessionId,
      section: row.section,
      normalized_key: row.normalizedKey,
      text: row.text,
      source_event_id: row.sourceEventId,
      source_event_position: row.sourceEventPosition.toString(),
      anchor: row.anchor,
    })),
    retrievalFeedback: expectedMap("retrievalFeedback", state.retrievalFeedback, (row) => ({
      project_id: row.projectId,
      feedback_id: row.feedbackId,
      item_id: row.itemId,
      outcome: row.outcome,
      usefulness: row.usefulness,
      source_item_event_position: row.sourceItemEventPosition.toString(),
      source_event_id: row.sourceEventId,
      source_event_position: row.sourceEventPosition.toString(),
      anchor: row.anchor,
    })),
  });
}

function replay(
  binding: ProjectBinding,
  manifest: ProjectionManifestV2,
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
    if (name === "entityGraph") {
      const graphRows: CanonicalProjectionRow[] = [];
      const seen = new Set<string>();
      for (const entity of ENTITY_TABLES) {
        for (const raw of statement(database, `
          SELECT ${entity.columns.join(", ")} FROM ${entity.table} ORDER BY ${entity.order}
        `).iterate()) {
          if (graphRows.length >= MAX_ROWS || graphRows.length >= expectedRows.entityGraph.size) return integrity();
          const row: Record<string, CanonicalProjectionRow[string]> = { relation: entity.relation };
          for (const column of entity.columns) {
            if (!(column in raw)) return integrity();
            row[column] = canonicalValue(raw[column], column);
            totalBytes += Buffer.byteLength(JSON.stringify(row[column]), "utf8");
            if (totalBytes > MAX_CANONICAL_BYTES) return integrity();
          }
          const canonical = Object.freeze(row);
          const key = entityRowKey(canonical);
          const expected = expectedRows.entityGraph.get(key);
          if (
            expected === undefined || seen.has(key)
            || !sameRow(canonical, expected, ["relation", ...entity.columns])
          ) return integrity();
          seen.add(key);
          graphRows.push(canonical);
        }
      }
      if (graphRows.length !== expectedRows.entityGraph.size || seen.size !== expectedRows.entityGraph.size) return integrity();
      const frozenGraph = Object.freeze(graphRows);
      if (projectionCoreChecksum(name, PROJECTION_SCHEMA_VERSION, projectId, terminalEventPosition, frozenGraph) !== manifestChecksums[name]) {
        return integrity();
      }
      result[name] = frozenGraph;
      continue;
    }
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
    reference.exec(PROJECTION_SCHEMA_SQL_V2);
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
  manifest: ProjectionManifestV2,
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
    || row.schema_version !== 2n
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
      SELECT count(*) AS n FROM canonical_items AS item
      LEFT JOIN canonical_items AS target
        ON target.project_id = item.project_id AND target.item_id = item.superseding_item_id
      WHERE item.superseding_item_id IS NOT NULL AND target.item_id IS NULL
    `) !== 0n
    ||
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
      WHERE chunk.item_id IS NOT NULL
        AND (item.item_id IS NULL OR NOT (chunk.session_id IS item.session_id))
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
    || scalarCount(database, `
      SELECT count(*) AS n FROM entity_aliases AS alias
      LEFT JOIN entity_nodes AS entity
        ON entity.project_id = alias.project_id AND entity.entity_id = alias.entity_id
      WHERE entity.entity_id IS NULL
    `) !== 0n
    || scalarCount(database, `
      SELECT count(*) AS n FROM entity_edges AS edge
      LEFT JOIN entity_nodes AS source
        ON source.project_id = edge.project_id AND source.entity_id = edge.source_entity_id
      LEFT JOIN entity_nodes AS target
        ON target.project_id = edge.project_id AND target.entity_id = edge.target_entity_id
      WHERE source.entity_id IS NULL OR target.entity_id IS NULL
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
  const reference = new DatabaseSync(":memory:", {
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
    allowBareNamedParameters: false,
    allowUnknownNamedParameters: false,
    defensive: true,
  });
  try {
    reference.enableDefensive(true);
    reference.exec(`
      CREATE VIRTUAL TABLE expected_fts USING fts5(
        normalized_key,
        text,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE VIRTUAL TABLE expected_vocab USING fts5vocab(
        expected_fts,
        instance
      );
      PRAGMA trusted_schema = OFF;
    `);
    const insert = reference.prepare(`
      INSERT INTO expected_fts(rowid, normalized_key, text) VALUES (?, ?, ?)
    `);
    for (let index = 0; index < lexicalRows.length; index += 1) {
      const row = lexicalRows[index]!;
      insert.run(index + 1, row.normalized_key as string, row.text as string);
    }
    const actual = statement(database, `
      SELECT term, doc, col, offset FROM temp.actual_vocab
      ORDER BY term, doc, col, offset
    `).iterate();
    const expected = statement(reference, `
      SELECT term, doc, col, offset FROM expected_vocab
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
      const expectedRows = statement(reference, `
        SELECT ${columns} FROM expected_fts_${shadow.suffix}
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
  } finally {
    reference.close();
  }
}

function assertUnpublishedV2Metadata(
  database: DatabaseSync,
  filename: string,
  binding: ProjectBinding,
): bigint {
  const iterator = statement(database, `
    SELECT singleton, schema_version, project_id, vault_id, store_id, workspace_id,
           branch_scope_id, branch_ref, session_id, generation,
           terminal_event_position, terminal_event_hash, created_at
    FROM projection_metadata ORDER BY singleton
  `).iterate();
  const first = iterator.next();
  const filenameMatch = UNPUBLISHED_V2_GENERATION_FILE.exec(filename);
  if (first.done || !iterator.next().done || filenameMatch === null) return integrity();
  const metadata = first.value;
  const terminalEventPosition = metadata.terminal_event_position;
  if (
    metadata.singleton !== 1n
    || metadata.schema_version !== BigInt(PROJECTION_SCHEMA_VERSION)
    || metadata.project_id !== binding.projectId
    || metadata.vault_id !== binding.vaultId
    || metadata.store_id !== binding.storeId
    || metadata.workspace_id !== binding.workspaceId
    || metadata.branch_scope_id !== binding.branchScopeId
    || metadata.branch_ref !== binding.branchRef
    || metadata.session_id !== null
    || metadata.generation !== BigInt(filenameMatch[1]!)
    || typeof terminalEventPosition !== "bigint" || terminalEventPosition < 0n
    || typeof metadata.terminal_event_hash !== "string" || !HASH.test(metadata.terminal_event_hash)
    || typeof metadata.created_at !== "string" || metadata.created_at.length === 0 || metadata.created_at.length > 128
  ) return integrity();
  return terminalEventPosition;
}

function persistedCoreChecksums(database: DatabaseSync): Readonly<Record<ProjectionName, string>> {
  const result = {} as Record<ProjectionName, string>;
  const seen = new Set<string>();
  for (const row of statement(database, `
    SELECT projection_name, checksum FROM projection_core_checksums ORDER BY projection_name
  `).iterate()) {
    if (
      typeof row.projection_name !== "string"
      || typeof row.checksum !== "string"
      || !HASH.test(row.checksum)
      || seen.has(row.projection_name)
      || !PROJECTION_NAMES.includes(row.projection_name as ProjectionName)
    ) return integrity();
    seen.add(row.projection_name);
    result[row.projection_name as ProjectionName] = row.checksum;
  }
  if (seen.size !== PROJECTION_NAMES.length) return integrity();
  return Object.freeze(result);
}

function readUnpublishedCoreRows(database: DatabaseSync): ProjectionRows {
  const result = {} as Record<ProjectionName, readonly CanonicalProjectionRow[]>;
  let totalBytes = 0;
  for (const name of PROJECTION_NAMES) {
    if (name === "entityGraph") {
      const rows: CanonicalProjectionRow[] = [];
      for (const entity of ENTITY_TABLES) {
        for (const raw of statement(database, `
          SELECT ${entity.columns.join(", ")} FROM ${entity.table} ORDER BY ${entity.order}
        `).iterate()) {
          if (rows.length >= MAX_ROWS) return integrity();
          const row: Record<string, CanonicalProjectionRow[string]> = { relation: entity.relation };
          for (const column of entity.columns) {
            if (!(column in raw)) return integrity();
            row[column] = canonicalValue(raw[column], column);
            totalBytes += Buffer.byteLength(JSON.stringify(row[column]), "utf8");
            if (totalBytes > MAX_CANONICAL_BYTES) return integrity();
          }
          rows.push(Object.freeze(row));
        }
      }
      result[name] = Object.freeze(rows);
      continue;
    }
    const definition: ProjectionTable = TABLES[name];
    const selected = definition.canonicalRowId
      ? ["row_id", ...definition.columns]
      : definition.columns;
    const rows: CanonicalProjectionRow[] = [];
    for (const raw of statement(database, `
      SELECT ${selected.join(", ")} FROM ${definition.table} ORDER BY ${definition.order}
    `).iterate()) {
      if (rows.length >= MAX_ROWS) return integrity();
      if (definition.canonicalRowId && raw.row_id !== BigInt(rows.length + 1)) return integrity();
      const row: Record<string, CanonicalProjectionRow[string]> = {};
      for (const column of definition.columns) {
        if (!(column in raw)) return integrity();
        row[column] = canonicalValue(raw[column], column);
        totalBytes += Buffer.byteLength(JSON.stringify(row[column]), "utf8");
        if (totalBytes > MAX_CANONICAL_BYTES) return integrity();
      }
      rows.push(Object.freeze(row));
    }
    result[name] = Object.freeze(rows);
  }
  return Object.freeze(result);
}

/**
 * Validates an unpublished V2 generation from immutable bytes before any
 * reconciliation disposition can be considered.
 */
export function assertUnpublishedProjectionV2Image(
  bytes: Uint8Array,
  filename: string,
  binding: ProjectBinding,
): void {
  let database: DatabaseSync | undefined;
  try {
    database = openImmutableProjectionImage(bytes);
    database.exec("BEGIN");
    assertCanonicalSchema(database);
    const terminalEventPosition = assertUnpublishedV2Metadata(database, filename, binding);
    assertSqliteIntegrity(database);
    const checksums = persistedCoreChecksums(database);
    const rows = readUnpublishedCoreRows(database);
    for (const name of PROJECTION_NAMES) {
      if (
        projectionCoreChecksum(
          name,
          PROJECTION_SCHEMA_VERSION,
          binding.projectId,
          terminalEventPosition,
          rows[name],
        ) !== checksums[name]
      ) return integrity();
    }
    assertReferences(database);
    assertFtsSemantics(database, rows.lexicalChunks);
    database.exec("COMMIT");
  } catch (error) {
    try { database?.exec("ROLLBACK"); } catch { /* preserve integrity failure */ }
    throw error;
  } finally {
    database?.close();
  }
}

function inspectGeneration(
  path: string,
  binding: ProjectBinding,
  manifest: ProjectionManifestV2,
  expectedRows: ExpectedProjectionRows,
  busyTimeoutMs: number,
  directoryIdentity: ProjectionDirectoryIdentity,
  pathInspection: ProjectionPathInspection,
  faultInjector?: ProjectionIntegrityFaultInjector,
): void {
  assertProjectionSidecarsAbsent(path, pathInspection);
  const generationIdentity = captureGenerationIdentity(path);
  if (!sameProjectionDirectoryIdentity(
    directoryIdentity,
    captureProjectionDirectoryIdentity(directoryIdentity.canonicalPath),
  )) return integrity();
  const pinnedImage = readGenerationImage(path, generationIdentity);
  try {
    if (pinnedImage.sha256 !== manifest.databaseSha256) return integrity();
    faultInjector?.hit("after-generation-identity-before-open");
    assertProjectionSidecarsAbsent(path, pathInspection);
    const inspection = openPinnedGenerationInspection(pinnedImage, busyTimeoutMs);
    const database = inspection.database;
    try {
      faultInjector?.hit("after-generation-open-before-inspection");
      assertProjectionSidecarsAbsent(path, pathInspection);
      if (
        !sameGenerationIdentity(generationIdentity, captureGenerationIdentity(path))
        || !sameProjectionDirectoryIdentity(
          directoryIdentity,
          captureProjectionDirectoryIdentity(directoryIdentity.canonicalPath),
        )
      ) return integrity();
      pinnedImage.assertUnchanged();
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
      assertProjectionSidecarsAbsent(path, pathInspection);
      if (
        !sameGenerationIdentity(generationIdentity, captureGenerationIdentity(path))
        || !sameProjectionDirectoryIdentity(
          directoryIdentity,
          captureProjectionDirectoryIdentity(directoryIdentity.canonicalPath),
        )
      ) return integrity();
      pinnedImage.assertUnchanged();
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* preserve integrity failure */ }
      throw error;
    } finally {
      inspection.close();
    }
    assertProjectionSidecarsAbsent(path, pathInspection);
    if (
      !sameGenerationIdentity(generationIdentity, captureGenerationIdentity(path))
      || !sameProjectionDirectoryIdentity(
        directoryIdentity,
        captureProjectionDirectoryIdentity(directoryIdentity.canonicalPath),
      )
    ) return integrity();
    pinnedImage.assertUnchanged();
  } finally {
    pinnedImage.close();
  }
}

export class ProjectionIntegrityService {
  readonly #options: ProjectionIntegrityServiceOptions;

  constructor(options: ProjectionIntegrityServiceOptions) {
    this.#options = Object.freeze({
      ...options,
      busyTimeoutMs: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
    });
  }

  verify(binding: ProjectBinding, manifestValue: unknown): ProjectionIntegrityReport {
    try {
      // Parse and reject non-V2 metadata before any directory or generation-byte inspection.
      const manifest = parseProjectionManifestV2(manifestValue, binding);
      const directoryIdentity = captureProjectionDirectoryIdentity(
        this.#options.projectionDirectory,
      );
      const paths = verifyProjectionPublicationPaths(
        this.#options.projectionDirectory,
        manifest.databaseFile,
        this.#options.pathInspection ?? filesystemProjectionPathInspection,
      );
      const expectedRows = replay(binding, manifest, this.#options);
      inspectGeneration(
        paths.databasePath,
        binding,
        manifest,
        expectedRows,
        this.#options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
        directoryIdentity,
        this.#options.pathInspection ?? filesystemProjectionPathInspection,
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
