import { statement, canonicalValue, schemaRows, sameRecords, ftsConfigRows, scalarCount, assertReferences, assertSqliteIntegrity, assertFtsSemantics, persistedCoreChecksums, readUnpublishedCoreRows, TABLES, ENTITY_TABLES, type ProjectionRowsV3, type ProjectionTable, assertCapturedProjectionV3Image, readCapturedProjectionV3Rows } from "./captured-image-v3.js";
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
import { deserializableImage, openImmutableProjectionImage } from "./immutable-image.js";
export { deserializableImage, openImmutableProjectionImage } from "./immutable-image.js";
import type { StoredEvent } from "../contracts/event.js";
import { ShadowMigrationError, type ShadowMigrationErrorCode } from "../migration/v2-shadow-migration.contracts.js";
import { EventStoreError } from "../storage/event-store.js";
import { isPrimarySqliteBusy } from "../storage/event-append-transaction.js";
import type { SqliteDriver, SqliteConnection, SqliteRow } from "../storage/sqlite-driver.js";
import { authenticateStoredEvent, type StoredEventChainCursor } from "../integrity/stored-event-authenticator.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import { foldProjectionSnapshotV3, readVerifiedLegacyProjectionConnection, type BuiltProjectionGeneration } from "./builder.js";
import {
  PROJECTION_NAMES,
  projectionCoreChecksum,
  type CanonicalProjectionRow,
  type ProjectionName,
} from "./checksum.js";
import type { ProjectBinding, ProjectionFoldState, ProjectionFoldStateV3, GovernedNoteProjectionRowV1, ProjectionSourceDisposition } from "./contracts.js";
import {
  replayCommittedProjectionEvents, replayCommittedProjectionSources,
  type CommittedProjectionReplayResult,
  type ProjectionEventSnapshot, type ProjectionEventSnapshotV3,
  MAX_PROJECTION_SOURCE_EVENTS,
  MAX_PROJECTION_SOURCE_BYTES,
} from "./event-reader.js";
import { ProjectionFoldAccumulator, ProjectionFoldAccumulatorV3 } from "./folds.js";
import {
  assertProjectionSidecarsAbsent,
  filesystemProjectionPathInspection,
  parseProjectionManifestV2, parseProjectionManifestV3, parseRichProjectionManifest,
  parseProjectionManifest,
  verifyProjectionPublicationPaths,
  type ProjectionManifestV2, type ProjectionManifestV3,
  type ProjectionNameV1,
  type ProjectionPathInspection,
} from "./manifest.js";
import { PROJECTION_SCHEMA_SQL_V1, PROJECTION_SCHEMA_SQL_V2, PROJECTION_SCHEMA_SQL_V1_LEGACY, PROJECTION_SCHEMA_SQL_V2_LEGACY, PROJECTION_SCHEMA_VERSION } from "./schema.js";
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
export type VerifiedCanonicalProjectionSnapshot = Readonly<{
  binding: ProjectBinding; terminalEventPosition: bigint; terminalEventHash: string;
}> & (Readonly<{ schemaVersion: 1; coreChecksums: Readonly<Record<ProjectionNameV1, string>>;
  rows: Readonly<Record<ProjectionNameV1, readonly CanonicalProjectionRow[]>> }>
  | Readonly<{ schemaVersion: 2; coreChecksums: Readonly<Record<ProjectionName, string>>; rows: ProjectionRows }>
  | Readonly<{ schemaVersion: 3; coreChecksums: ProjectionManifestV3["coreChecksums"]; rows: ProjectionRowsV3 }>);

export function readVerifiedCanonicalProjectionSnapshot(
  binding: ProjectBinding, manifestValue: unknown,
  options: ProjectionIntegrityServiceOptions & Readonly<{ sourceSnapshot: ProjectionEventSnapshot }>,
): VerifiedCanonicalProjectionSnapshot {
  return new ProjectionIntegrityService(options).readCanonicalSnapshot(binding, manifestValue, options.sourceSnapshot);
}
type ExpectedProjectionRows = Readonly<
  Record<ProjectionName, ReadonlyMap<string, CanonicalProjectionRow>>
>;


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


function integrity(): never {
  throw new LifecycleError("INTEGRITY_FAILURE");
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
  const definition = TABLES[name];
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

function rowsFromState(state: ProjectionFoldState | ProjectionFoldStateV3): ExpectedProjectionRows {
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
  schemaVersion: 2 | 3 = 2,
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
      if (projectionCoreChecksum(name, schemaVersion, projectId, terminalEventPosition, frozenGraph) !== manifestChecksums[name]) {
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
      schemaVersion,
      projectId,
      terminalEventPosition,
      frozen,
    );
    if (checksum !== manifestChecksums[name]) return integrity();
    result[name] = frozen;
  }
  return Object.freeze(result);
}







function assertCanonicalSchema(database: DatabaseSync, version: 1 | 2 = 2, binding?: ProjectBinding): void {
  const reference = new DatabaseSync(":memory:", {
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
  });
  try {
    reference.exec(version === 1 ? PROJECTION_SCHEMA_SQL_V1 : PROJECTION_SCHEMA_SQL_V2);
    if (sameRecords(schemaRows(database), schemaRows(reference), ["type", "name", "tbl_name", "sql"])
      && sameRecords(ftsConfigRows(database), ftsConfigRows(reference), ["k", "v"])) return;
    if (!binding || ![binding.projectId, binding.vaultId, binding.storeId].every(id => HASH.test(id))) return integrity();
    const legacy = new DatabaseSync(":memory:");
    try {
      legacy.exec(version === 1 ? PROJECTION_SCHEMA_SQL_V1_LEGACY : PROJECTION_SCHEMA_SQL_V2_LEGACY);
      if (!sameRecords(schemaRows(database), schemaRows(legacy), ["type", "name", "tbl_name", "sql"])
        || !sameRecords(ftsConfigRows(database), ftsConfigRows(legacy), ["k", "v"])) return integrity();
    } finally { legacy.close(); }
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
    assertCanonicalSchema(database, 2, binding);
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

/** Reconciles schema3 under its own exact profile, using only owned captured bytes. */
export function assertUnpublishedProjectionV3Image(bytes: Uint8Array, filename: string, binding: ProjectBinding): void {
  let database: DatabaseSync | undefined;
  try {
    const match = /^projections-3-([1-9][0-9]{0,9})\.sqlite$/u.exec(filename);
    if (!match || bytes.byteLength > 64 * 1024 * 1024) return integrity();
    database = openImmutableProjectionImage(bytes);
    const metadata = statement(database, "SELECT terminal_event_position, terminal_event_hash, created_at FROM projection_metadata").get();
    if (!metadata) return integrity();
    const checksums: Record<string,string> = {};
    for (const row of statement(database, "SELECT projection_name,checksum FROM projection_core_checksums").iterate()) {
      if (typeof row.projection_name !== "string" || typeof row.checksum !== "string" || Object.hasOwn(checksums,row.projection_name)) return integrity();
      checksums[row.projection_name] = row.checksum;
    }
    const manifest = parseProjectionManifestV3({ schemaVersion:3, ...binding, sessionId:null, generation:Number(match[1]),
      highestObservedGeneration:Number(match[1]), terminalEventPosition:String(metadata.terminal_event_position),
      terminalEventHash:metadata.terminal_event_hash, databaseFile:filename, databaseSha256:createHash("sha256").update(bytes).digest("hex"),
      coreChecksums:checksums, createdAt:metadata.created_at },binding);
    assertCapturedProjectionV3Image(database,manifest);
  } catch { return integrity(); }
  finally { database?.close(); }
}

function inspectGeneration(
  path: string,
  binding: ProjectBinding,
  manifest: ProjectionManifestV2 | ProjectionManifestV3,
  expectedRows: ExpectedProjectionRows,
  busyTimeoutMs: number,
  directoryIdentity: ProjectionDirectoryIdentity,
  pathInspection: ProjectionPathInspection,
  faultInjector?: ProjectionIntegrityFaultInjector,
  governedRows?: readonly GovernedNoteProjectionRowV1[],
): ProjectionRows | ProjectionRowsV3 {
  let verifiedRows: ProjectionRows | ProjectionRowsV3 | undefined;
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
      if (manifest.schemaVersion === 3) assertCapturedProjectionV3Image(database, manifest);
      else { assertCanonicalSchema(database, 2, binding); assertMetadata(database, binding, manifest); }
      assertSqliteIntegrity(database);
      const rows = readExactRows(
        database,
        expectedRows,
        binding.projectId,
        BigInt(manifest.terminalEventPosition),
        manifest.coreChecksums,
        manifest.schemaVersion,
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
      if (manifest.schemaVersion === 3) {
        const captured = readCapturedProjectionV3Rows(database);
        if (!governedRows || canonicalJson(captured.governedNotes) !== canonicalJson(governedRows)) return integrity();
        verifiedRows = captured;
      } else verifiedRows = rows;
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
    if (!verifiedRows) return integrity();
    return verifiedRows;
  } finally {
    pinnedImage.close();
  }
}

function* committedSnapshotEvents(snapshot: ProjectionEventSnapshot): Iterable<StoredEvent> {
  try { yield* snapshot.events(); }
  catch (error) {
    if (error instanceof ShadowMigrationError || (error instanceof EventStoreError && error.code === "SQLITE_BUSY") || isPrimarySqliteBusy(error)) throw error;
    throw new ShadowMigrationError("MIGRATION_LEDGER_INTEGRITY_FAILURE");
  }
}

function authenticateProjectionSnapshot(
  snapshot: ProjectionEventSnapshot, binding: ProjectBinding,
  manifest: Pick<ProjectionManifestV2, "terminalEventPosition" | "terminalEventHash">,
  options: ProjectionIntegrityServiceOptions, consume: (source: StoredEvent) => void,
): void {
  const fields = ["projectId", "vaultId", "storeId", "workspaceId", "branchScopeId", "branchRef"] as const;
  const maxEvents = options.maxReplayEvents ?? MAX_PROJECTION_SOURCE_EVENTS;
  const maxBytes = options.maxReplayBytes ?? MAX_PROJECTION_SOURCE_BYTES;
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 0 || maxEvents > MAX_PROJECTION_SOURCE_EVENTS
    || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_PROJECTION_SOURCE_BYTES
    || fields.some(key => snapshot.binding[key] !== binding[key]) || snapshot.binding.sessionId !== null
    || !Number.isSafeInteger(snapshot.eventCount) || snapshot.eventCount < 0 || snapshot.eventCount > maxEvents
    || !Number.isSafeInteger(snapshot.aggregateBytes) || snapshot.aggregateBytes < 0 || snapshot.aggregateBytes > maxBytes
    || snapshot.terminalEventPosition !== BigInt(manifest.terminalEventPosition)
    || snapshot.terminalEventHash !== manifest.terminalEventHash) return integrity();
  let cursor: StoredEventChainCursor = { expectedPosition: 1n, previousEventHash: "0".repeat(64) };
  let count = 0;
  let bytes = 0;
  for (const source of committedSnapshotEvents(snapshot)) {
    if (++count > maxEvents || count > snapshot.eventCount || fields.some(key => source[key] !== binding[key])) return integrity();
    const authenticated = authenticateStoredEvent(source, cursor);
    cursor = authenticated.nextCursor;
    // Complete stored row domain, including nullable and numeric columns (8 bytes each).
    let rowBytes = 0;
    for (const key of ["globalPosition", "eventId", "projectId", "vaultId", "storeId", "workspaceId", "branchScopeId", "branchRef",
      "streamId", "streamType", "streamVersion", "eventType", "eventSchemaVersion", "sessionId", "parentSessionId", "actorRole", "agentId",
      "clientInstanceId", "correlationId", "causationId", "commandId", "idempotencyKey", "commandEventIndex", "occurredAt", "recordedAt",
      "visibilityScope", "confidence", "verificationStatus", "sourceRefs", "evidenceRefs", "evidenceDigests", "payloadJson", "payloadHash",
      "previousGlobalHash", "eventHash", "lifecycleIntentJson"] as const) {
      const value = source[key];
      rowBytes += ["sourceRefs", "evidenceRefs", "evidenceDigests"].includes(key)
        ? Buffer.byteLength(canonicalJson(value), "utf8") : typeof value === "string" ? Buffer.byteLength(value, "utf8") : 8;
    }
    bytes += rowBytes;
    if (rowBytes > 1024 * 1024 || bytes > maxBytes || bytes > snapshot.aggregateBytes) return integrity();
    consume(source);
  }
  if (count !== snapshot.eventCount || bytes !== snapshot.aggregateBytes || cursor.expectedPosition - 1n !== snapshot.terminalEventPosition
    || cursor.previousEventHash !== snapshot.terminalEventHash) return integrity();
}

export class ProjectionIntegrityService {
  readonly #options: ProjectionIntegrityServiceOptions;

  constructor(options: ProjectionIntegrityServiceOptions) {
    this.#options = Object.freeze({
      ...options,
      busyTimeoutMs: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
    });
  }

  /** Verifies a caller-owned committed snapshot; the caller retains close ownership. */
  verifyCommittedSnapshot(binding: ProjectBinding, manifestValue: unknown, snapshot: ProjectionEventSnapshot): ProjectionIntegrityReport {
    const verified = this.#readCommittedSnapshot(binding, manifestValue, snapshot);
    return Object.freeze({ status: "passed", terminalEventPosition: String(verified.terminalEventPosition) });
  }

  #readCommittedSnapshotV3(binding: ProjectBinding, manifest: ProjectionManifestV3, snapshot: ProjectionEventSnapshot): VerifiedCanonicalProjectionSnapshot {
    if (["projectId", "vaultId", "storeId", "workspaceId", "branchScopeId", "branchRef", "sessionId"].some(key =>
      snapshot.binding[key as keyof ProjectBinding] !== binding[key as keyof ProjectBinding])
      || snapshot.terminalEventPosition !== BigInt(manifest.terminalEventPosition)
      || snapshot.terminalEventHash !== manifest.terminalEventHash) return integrity();
    const state = foldProjectionSnapshotV3(snapshot as ProjectionEventSnapshotV3, this.#options.maxReplayEvents, this.#options.maxReplayBytes);
    return this.#inspectV3State(binding, manifest, state);
  }

  #inspectV3State(binding: ProjectBinding, manifest: ProjectionManifestV3, state: ProjectionFoldStateV3): VerifiedCanonicalProjectionSnapshot {
    const directory = captureProjectionDirectoryIdentity(this.#options.projectionDirectory);
    const inspection = this.#options.pathInspection ?? filesystemProjectionPathInspection;
    const paths = verifyProjectionPublicationPaths(this.#options.projectionDirectory, manifest.databaseFile, inspection);
    if (BigInt(captureGenerationIdentity(paths.databasePath).size) > 64n * 1024n * 1024n) return integrity();
    const rows = inspectGeneration(paths.databasePath, binding, manifest, rowsFromState(state),
      this.#options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS, directory, inspection, this.#options.faultInjector, state.governedNotes) as ProjectionRowsV3;
    return Object.freeze({ schemaVersion: 3, binding: Object.freeze({ ...binding }), rows, coreChecksums: manifest.coreChecksums,
      terminalEventPosition: BigInt(manifest.terminalEventPosition), terminalEventHash: manifest.terminalEventHash });
  }

  #readCommittedSnapshot(binding: ProjectBinding, manifestValue: unknown, snapshot: ProjectionEventSnapshot): VerifiedCanonicalProjectionSnapshot {
    try {
      const manifest = parseRichProjectionManifest(manifestValue, binding);
      if (manifest.schemaVersion === 3) return this.#readCommittedSnapshotV3(binding, manifest, snapshot);
      const accumulator = new ProjectionFoldAccumulator();
      authenticateProjectionSnapshot(snapshot, binding, manifest, this.#options, source => {
        const decoded = decodeProjectionEvent(source);
        if (decoded.kind === "projected") accumulator.append(decoded.event);
      });
      const directory = captureProjectionDirectoryIdentity(this.#options.projectionDirectory);
      const inspection = this.#options.pathInspection ?? filesystemProjectionPathInspection;
      const paths = verifyProjectionPublicationPaths(this.#options.projectionDirectory, manifest.databaseFile, inspection);
      const rows = inspectGeneration(paths.databasePath, binding, manifest, rowsFromState(accumulator.finish()),
        this.#options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS, directory, inspection, this.#options.faultInjector);
      return Object.freeze({ schemaVersion: 2, binding: Object.freeze({ ...binding }), rows, coreChecksums: manifest.coreChecksums,
        terminalEventPosition: BigInt(manifest.terminalEventPosition), terminalEventHash: manifest.terminalEventHash });
    } catch (error) {
      // A lazy committed reader can fail during iteration. Preserve only its safe classification.
      const codes: readonly ShadowMigrationErrorCode[] = ["MIGRATION_POLICY_INVALID", "MIGRATION_SOURCE_INVALID", "MIGRATION_SOURCE_MUTATED",
        "MIGRATION_LIMIT_EXCEEDED", "MIGRATION_IDENTITY_CONFLICT", "MIGRATION_LEDGER_INTEGRITY_FAILURE", "MIGRATION_OUTCOME_UNKNOWN",
        "MIGRATION_RETRY_EXHAUSTED", "PROJECTION_INTEGRITY_FAILURE", "PARITY_RULE_INVALID", "PARITY_BLOCKING_DIVERGENCE", "COMPATIBILITY_INTEGRITY_FAILURE"];
      if (error instanceof ShadowMigrationError && codes.includes(error.code)) throw new ShadowMigrationError(error.code);
      if ((error instanceof EventStoreError && error.code === "SQLITE_BUSY") || isPrimarySqliteBusy(error)) throw new EventStoreError("SQLITE_BUSY", { retryable: true });
      return integrity();
    }
  }

  /** Reopens descriptor-pinned V1 bytes; all SQL, including FTS writes, is detached. */
  readCanonicalSnapshot(binding: ProjectBinding, manifestValue: unknown, snapshot: ProjectionEventSnapshot): VerifiedCanonicalProjectionSnapshot {
    const descriptor = typeof manifestValue === "object" && manifestValue !== null
      ? Object.getOwnPropertyDescriptor(manifestValue, "schemaVersion") : undefined;
    if (!descriptor || !("value" in descriptor)) return integrity();
    if (descriptor.value === 2 || descriptor.value === 3) return this.#readCommittedSnapshot(binding, manifestValue, snapshot);
    const manifest = parseProjectionManifest(manifestValue, binding);
    const events: StoredEvent[] = [];
    authenticateProjectionSnapshot(snapshot, binding, manifest, this.#options, source => events.push(source));
    const verifiedSource = Object.freeze({ ...snapshot, events: () => events });
    let rows: Readonly<Record<ProjectionNameV1, readonly CanonicalProjectionRow[]>> | undefined;
    this.#inspectV1Generation(verifiedSource, manifest.createdAt, { manifest,
      projectionDirectory: this.#options.projectionDirectory,
      databasePath: verifyProjectionPublicationPaths(this.#options.projectionDirectory, manifest.databaseFile).databasePath,
    }, value => { rows = value; });
    if (!rows) return integrity();
    return Object.freeze({ schemaVersion: 1, binding: Object.freeze({ ...binding }), rows, coreChecksums: manifest.coreChecksums,
      terminalEventPosition: BigInt(manifest.terminalEventPosition), terminalEventHash: manifest.terminalEventHash });
  }

  verifyV1Generation(snapshot: ProjectionEventSnapshot, generation: BuiltProjectionGeneration): ProjectionIntegrityReport {
    const verified = this.#inspectV1Generation(snapshot, generation.manifest.createdAt, generation);
    return Object.freeze({ status: "passed", terminalEventPosition: verified.manifest.terminalEventPosition });
  }

  /** Recover only the fixed baseline orphan under the caller's publication lease. */
  recoverV1Generation(snapshot: ProjectionEventSnapshot, createdAt: string): BuiltProjectionGeneration {
    return this.#inspectV1Generation(snapshot, createdAt);
  }

  #inspectV1Generation(snapshot: ProjectionEventSnapshot, createdAt: string, generation?: BuiltProjectionGeneration,
    onVerified?: (rows: Readonly<Record<ProjectionNameV1, readonly CanonicalProjectionRow[]>>) => void): BuiltProjectionGeneration {
    let pinned: PinnedGenerationImage | undefined;
    let database: DatabaseSync | undefined;
    try {
      const manifest = generation ? parseProjectionManifest(generation.manifest, snapshot.binding) : undefined;
      const directory = captureProjectionDirectoryIdentity(this.#options.projectionDirectory);
      const paths = verifyProjectionPublicationPaths(this.#options.projectionDirectory, manifest?.databaseFile ?? "projections-1-1.sqlite");
      if (generation && (generation.projectionDirectory !== this.#options.projectionDirectory || generation.databasePath !== paths.databasePath
        || manifest!.terminalEventPosition !== String(snapshot.terminalEventPosition) || manifest!.terminalEventHash !== snapshot.terminalEventHash)) return integrity();
      assertProjectionSidecarsAbsent(paths.databasePath);
      const identity = captureGenerationIdentity(paths.databasePath);
      pinned = readGenerationImage(paths.databasePath, identity);
      if (manifest && pinned.sha256 !== manifest.databaseSha256) return integrity();
      database = openImmutableProjectionImage(pinned.bytes, this.#options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS);
      assertCanonicalSchema(database, 1, snapshot.binding);
      database.exec("PRAGMA query_only=OFF");
      const native = database;
      const connection: SqliteConnection = {
        exec(sql) { native.exec(sql); }, close() { native.close(); },
        prepare(sql) {
          const s = statement(native, sql);
          return {
            get(params) { return (params ? s.get(params) : s.get()) as SqliteRow | undefined; },
            all(params) { return (params ? s.all(params) : s.all()) as SqliteRow[]; },
            iterate(params) { return (params ? s.iterate(params) : s.iterate()) as IterableIterator<SqliteRow>; },
            run(params) { const r = params ? s.run(params) : s.run(); return { changes: BigInt(r.changes), lastInsertRowid: BigInt(r.lastInsertRowid) }; },
          };
        },
      };
      const verified = readVerifiedLegacyProjectionConnection(connection, snapshot,
        { generation: manifest?.generation ?? 1, createdAt }, manifest?.coreChecksums);
      const { coreChecksums } = verified;
      assertProjectionSidecarsAbsent(paths.databasePath);
      pinned.assertUnchanged();
      if (!sameGenerationIdentity(identity, captureGenerationIdentity(paths.databasePath))
        || !sameProjectionDirectoryIdentity(directory, captureProjectionDirectoryIdentity(this.#options.projectionDirectory))) return integrity();
      const verifiedManifest = manifest ?? parseProjectionManifest({ schemaVersion: 1, ...snapshot.binding, sessionId: null,
        generation: 1, terminalEventPosition: String(snapshot.terminalEventPosition), terminalEventHash: snapshot.terminalEventHash,
        databaseFile: "projections-1-1.sqlite", databaseSha256: pinned.sha256, coreChecksums, createdAt }, snapshot.binding);
      onVerified?.(verified.rows);
      return Object.freeze({ manifest: verifiedManifest, projectionDirectory: this.#options.projectionDirectory, databasePath: paths.databasePath });
    } catch { return integrity(); }
    finally {
      let cleanupFailed = false;
      try { database?.close(); } catch { cleanupFailed = true; }
      try { pinned?.close(); } catch { cleanupFailed = true; }
      if (cleanupFailed) integrity();
    }
  }

  verify(binding: ProjectBinding, manifestValue: unknown): ProjectionIntegrityReport {
    try {
      // Parse and reject non-V2 metadata before any directory or generation-byte inspection.
      const manifest = parseRichProjectionManifest(manifestValue, binding);
      if (manifest.schemaVersion === 3) {
        const accumulator = new ProjectionFoldAccumulatorV3();
        const replayed = replayCommittedProjectionSources(binding, { driver:this.#options.driver, eventStorePath:this.#options.eventStorePath,
          busyTimeoutMs:this.#options.busyTimeoutMs, terminalEventPosition:BigInt(manifest.terminalEventPosition),
          maxEvents:this.#options.maxReplayEvents, maxAggregateBytes:this.#options.maxReplayBytes }, source => accumulator.append(source));
        if (replayed.terminalEventPosition !== BigInt(manifest.terminalEventPosition)
          || replayed.terminalEventHash !== manifest.terminalEventHash) return integrity();
        this.#inspectV3State(binding,manifest,accumulator.finish());
        return Object.freeze({status:"passed",terminalEventPosition:manifest.terminalEventPosition});
      }
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
