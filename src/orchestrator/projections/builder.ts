import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";

import { fsyncDirectory, type DirectorySync } from "../identity/directory-durability.js";
import type { SqliteConnection, SqliteDriver, SqliteParams } from "../storage/sqlite-driver.js";
import {
  PROJECTION_NAMES,
  projectionCoreChecksum,
  type CanonicalProjectionRow,
  type ProjectionName,
} from "./checksum.js";
import type { ProjectionFoldState } from "./contracts.js";
import type { ProjectionEventSnapshot } from "./event-reader.js";
import {
  LegacyProjectionFoldAccumulator,
  ProjectionFoldAccumulator,
  type LegacyProjectionFoldState,
} from "./folds.js";
import {
  assertProjectionSidecarsAbsent,
  parseProjectionManifest,
  parseProjectionManifestV2,
  verifyProjectionPublicationPaths,
  type ProjectionManifestV1,
  type ProjectionManifestV2,
} from "./manifest.js";
import {
  captureProjectionDirectoryIdentity,
  type ProjectionDirectoryIdentity,
} from "./stable-directory.js";
import {
  createProjectionSchema,
  PROJECTION_SCHEMA_SQL_V1,
  PROJECTION_SCHEMA_VERSION,
} from "./schema.js";
import { decodeProjectionEvent, decodeProjectionEventV1 } from "./source-event-codec.js";

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAX_GENERATION = 2_147_483_647;

export interface BuiltProjectionGeneration {
  readonly manifest: ProjectionManifestV1;
  readonly projectionDirectory: string;
  readonly databasePath: string;
}

export interface StagedProjectionGeneration {
  readonly manifest: ProjectionManifestV2;
  readonly projectionDirectory: string;
  readonly temporaryDatabasePath: string;
  readonly directoryIdentity: ProjectionDirectoryIdentity;
}

/** @deprecated Use StagedProjectionGeneration; V2 files are never final at build time. */
export type BuiltProjectionGenerationV2 = StagedProjectionGeneration;

export interface ImmutableProjectionBuilderOptions {
  readonly driver: SqliteDriver;
  readonly projectionDirectory: string;
  readonly busyTimeoutMs?: number;
  readonly now?: () => string;
  readonly syncDirectory?: DirectorySync;
}

type ProjectionRows = Readonly<Record<ProjectionName, readonly CanonicalProjectionRow[]>>;
type LegacyProjectionName = Exclude<ProjectionName, "sessionCheckpoints">;
type LegacyProjectionRows = Readonly<Record<LegacyProjectionName, readonly CanonicalProjectionRow[]>>;
const LEGACY_PROJECTION_NAMES = Object.freeze([
  "sessionTree", "canonicalItems", "tasksFollowups", "artifactsFiles",
  "entityGraph", "lexicalChunks", "retrievalFeedback",
] as const satisfies readonly LegacyProjectionName[]);

function failure(message: string): never {
  throw new Error(message);
}

function safeDirectory(path: string, syncDirectory: DirectorySync): string {
  if (!isAbsolute(path) || normalize(path) !== path || resolve(path) !== path) {
    return failure("PROJECTION_PATH_INVALID");
  }
  const parent = dirname(path);
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || realpathSync(parent) !== parent) {
    return failure("PROJECTION_PATH_INVALID");
  }
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: false });
    syncDirectory(parent);
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) {
    return failure("PROJECTION_PATH_INVALID");
  }
  return path;
}

function removeKnownFile(path: string): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return failure("PROJECTION_PATH_INVALID");
    unlinkSync(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertRollbackJournalHeader(path: string): void {
  const handle = openSync(path, "r");
  const journalBytes = Buffer.alloc(2);
  try {
    if (readSync(handle, journalBytes, 0, journalBytes.length, 18) !== journalBytes.length) {
      return failure("PROJECTION_JOURNAL_MODE_INVALID");
    }
  } finally {
    closeSync(handle);
  }
  if (journalBytes[0] !== 1 || journalBytes[1] !== 1) {
    return failure("PROJECTION_JOURNAL_MODE_INVALID");
  }
}

function freezeRows(rows: CanonicalProjectionRow[]): readonly CanonicalProjectionRow[] {
  return Object.freeze(rows.map((row) => Object.freeze(row)));
}

function rowsFromState(state: ProjectionFoldState): ProjectionRows {
  return Object.freeze({
    sessionTree: freezeRows(state.sessionTree
      .map((row) => ({
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
      }))
      .sort((left, right) => String(left.session_id).localeCompare(String(right.session_id)))),
    sessionCheckpoints: freezeRows(state.sessionCheckpoints
      .map((row) => ({
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
      }))
      .sort((left, right) => `${String(left.session_id)}\0${String(left.source_event_position).padStart(20, "0")}\0${String(left.checkpoint_id)}`
        .localeCompare(`${String(right.session_id)}\0${String(right.source_event_position).padStart(20, "0")}\0${String(right.checkpoint_id)}`))),
    canonicalItems: freezeRows(state.canonicalItems
      .map((row) => ({
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
      }))
      .sort((left, right) => String(left.item_id).localeCompare(String(right.item_id)))),
    tasksFollowups: freezeRows(state.followUps
      .map((row) => ({
        project_id: row.projectId,
        session_id: row.sessionId,
        follow_up_id: row.followUpId,
        status: row.status,
        summary: row.summary,
        confidence: row.confidence,
        source_event_id: row.sourceEventId,
        source_event_position: row.sourceEventPosition.toString(),
        anchor: row.anchor,
      }))
      .sort((left, right) => String(left.follow_up_id).localeCompare(String(right.follow_up_id)))),
    artifactsFiles: freezeRows(state.artifacts
      .map((row) => ({
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
      }))
      .sort((left, right) => `${String(left.session_id)}\0${String(left.artifact_id)}`
        .localeCompare(`${String(right.session_id)}\0${String(right.artifact_id)}`))),
    entityGraph: freezeRows([
      ...state.entityNodes.map((row) => ({
        relation: "node", project_id: row.projectId, entity_id: row.entityId,
        normalized_name: row.normalizedName, entity_type: row.entityType,
        valid_from: row.validFrom, valid_to: row.validTo, source_event_id: row.sourceEventId,
        source_event_position: row.sourceEventPosition.toString(), anchor: row.anchor,
      })).sort((left, right) => String(left.entity_id).localeCompare(String(right.entity_id))),
      ...state.entityAliases.map((row) => ({
        relation: "alias", project_id: row.projectId, alias_id: row.aliasId, entity_id: row.entityId,
        normalized_alias: row.normalizedAlias, valid_from: row.validFrom, valid_to: row.validTo,
        source_event_id: row.sourceEventId, source_event_position: row.sourceEventPosition.toString(), anchor: row.anchor,
      })).sort((left, right) => String(left.alias_id).localeCompare(String(right.alias_id))),
      ...state.entityEdges.map((row) => ({
        relation: "edge", project_id: row.projectId, edge_id: row.edgeId,
        source_entity_id: row.sourceEntityId, target_entity_id: row.targetEntityId, edge_type: row.edgeType,
        valid_from: row.validFrom, valid_to: row.validTo, source_event_id: row.sourceEventId,
        source_event_position: row.sourceEventPosition.toString(), anchor: row.anchor,
      })).sort((left, right) => String(left.edge_id).localeCompare(String(right.edge_id))),
    ]),
    lexicalChunks: freezeRows(state.lexicalChunks
      .map((row) => ({
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
      }))
      .sort((left, right) => String(left.chunk_id).localeCompare(String(right.chunk_id)))),
    retrievalFeedback: freezeRows(state.retrievalFeedback
      .map((row) => ({
        project_id: row.projectId,
        feedback_id: row.feedbackId,
        item_id: row.itemId,
        outcome: row.outcome,
        usefulness: row.usefulness,
        source_item_event_position: row.sourceItemEventPosition.toString(),
        source_event_id: row.sourceEventId,
        source_event_position: row.sourceEventPosition.toString(),
        anchor: row.anchor,
      }))
      .sort((left, right) => String(left.feedback_id).localeCompare(String(right.feedback_id)))),
  });
}

function legacyRowsFromState(state: LegacyProjectionFoldState): LegacyProjectionRows {
  const latestCheckpoints = new Map<string, ProjectionFoldState["sessionCheckpoints"][number]>();
  for (const row of state.sessionCheckpoints) latestCheckpoints.set(row.sessionId, row);
  return Object.freeze({
    sessionTree: freezeRows([...latestCheckpoints.values()].map((row) => ({
      project_id: row.projectId, session_id: row.sessionId, checkpoint_id: row.checkpointId,
      checkpoint_version: row.checkpointVersion, base_event_position: row.baseEventPosition.toString(),
      source_event_position: row.sourceEventPosition.toString(), occurred_at: row.occurredAt,
      task_summary: row.taskSummary,
    })).sort((left, right) => String(left.session_id).localeCompare(String(right.session_id)))),
    canonicalItems: freezeRows(state.canonicalItems.map((row) => ({
      project_id: row.projectId, session_id: row.sessionId, item_id: row.itemId,
      normalized_key: row.normalizedKey, conflict_group_id: row.conflictGroupId,
      superseding_item_id: row.supersedingItemId, status: row.status, confidence: row.confidence,
      verification_method: row.verificationMethod, valid_from: row.validFrom, valid_to: row.validTo,
      summary: row.summary, content_hash: row.contentHash,
      known_from_event_position: row.knownFromEventPosition.toString(),
      source_event_position: row.sourceEventPosition.toString(),
    })).sort((left, right) => String(left.item_id).localeCompare(String(right.item_id)))),
    tasksFollowups: freezeRows(state.followUps.map((row) => ({
      project_id: row.projectId, session_id: row.sessionId, follow_up_id: row.followUpId,
      status: row.status === "blocked" ? "blocked" : "open", summary: row.summary,
      confidence: row.confidence, source_event_position: row.sourceEventPosition.toString(),
    })).sort((left, right) => String(left.follow_up_id).localeCompare(String(right.follow_up_id)))),
    artifactsFiles: freezeRows(state.artifacts.map((row) => ({
      project_id: row.projectId, session_id: row.sessionId, artifact_id: row.artifactId,
      path: row.path, summary: row.summary, action: row.action, content_hash: row.contentHash,
      branch_ref: row.branchRef, confidence: row.confidence,
      source_event_position: row.sourceEventPosition.toString(),
    })).sort((left, right) => `${String(left.session_id)}\0${String(left.artifact_id)}`
      .localeCompare(`${String(right.session_id)}\0${String(right.artifact_id)}`))),
    entityGraph: Object.freeze([]),
    lexicalChunks: freezeRows(state.lexicalChunks.map((row) => ({
      project_id: row.projectId, chunk_id: row.chunkId, item_id: row.itemId,
      session_id: row.sessionId, section: row.section, normalized_key: row.normalizedKey,
      text: row.text, source_event_position: row.sourceEventPosition.toString(),
    })).sort((left, right) => String(left.chunk_id).localeCompare(String(right.chunk_id)))),
    retrievalFeedback: freezeRows(state.retrievalFeedback.map((row) => ({
      project_id: row.projectId, feedback_id: row.feedbackId, item_id: row.itemId,
      outcome: row.outcome, usefulness: row.usefulness,
      source_item_event_position: row.sourceItemEventPosition.toString(),
      source_event_position: row.sourceEventPosition.toString(),
    })).sort((left, right) => String(left.feedback_id).localeCompare(String(right.feedback_id)))),
  });
}

function insertRows(
  connection: SqliteConnection,
  table: string,
  columns: readonly string[],
  rows: readonly CanonicalProjectionRow[],
): void {
  if (rows.length === 0) return;
  const parameters = columns.map((column) => `$${column}`);
  const statement = connection.prepare(`
    INSERT INTO ${table}(${columns.join(", ")})
    VALUES (${parameters.join(", ")})
  `);
  for (const row of rows) {
    const params: SqliteParams = {};
    for (const column of columns) {
      const value = row[column];
      if (value === undefined) return failure("PROJECTION_ROW_INVALID");
      params[`$${column}`] = typeof value === "boolean" ? (value ? 1 : 0) : value;
    }
    statement.run(params);
  }
}

const TABLES = Object.freeze({
  sessionTree: [
    "session_tree",
    ["project_id", "session_id", "root_session_id", "parent_session_id", "lifecycle_state", "owner_generation", "opened_event_position", "closed_event_position", "latest_checkpoint_id", "latest_checkpoint_event_position", "source_event_id", "source_event_position", "anchor"],
  ],
  sessionCheckpoints: [
    "session_checkpoints",
    ["project_id", "session_id", "checkpoint_id", "checkpoint_version", "base_event_position", "source_event_id", "source_event_position", "occurred_at", "task_summary", "anchor"],
  ],
  canonicalItems: [
    "canonical_items",
    ["project_id", "session_id", "item_id", "normalized_key", "conflict_group_id", "superseding_item_id", "status", "confidence", "verification_method", "valid_from", "valid_to", "summary", "content_hash", "known_from_event_position", "source_event_id", "source_event_position", "anchor"],
  ],
  tasksFollowups: [
    "tasks_followups",
    ["project_id", "session_id", "follow_up_id", "status", "summary", "confidence", "source_event_id", "source_event_position", "anchor"],
  ],
  artifactsFiles: [
    "artifacts_files",
    ["project_id", "session_id", "artifact_id", "path", "summary", "action", "content_hash", "branch_ref", "confidence", "symbol", "commit_hash", "heading", "source_event_id", "source_event_position", "anchor"],
  ],
  lexicalChunks: [
    "lexical_chunks",
    ["project_id", "chunk_id", "item_id", "session_id", "section", "normalized_key", "text", "source_event_id", "source_event_position", "anchor"],
  ],
  retrievalFeedback: [
    "retrieval_feedback",
    ["project_id", "feedback_id", "item_id", "outcome", "usefulness", "source_item_event_position", "source_event_id", "source_event_position", "anchor"],
  ],
} as const satisfies Record<Exclude<ProjectionName, "entityGraph">, readonly [string, readonly string[]]>);

const ENTITY_TABLES = Object.freeze([
  ["node", "entity_nodes", ["project_id", "entity_id", "normalized_name", "entity_type", "valid_from", "valid_to", "source_event_id", "source_event_position", "anchor"]],
  ["alias", "entity_aliases", ["project_id", "alias_id", "entity_id", "normalized_alias", "valid_from", "valid_to", "source_event_id", "source_event_position", "anchor"]],
  ["edge", "entity_edges", ["project_id", "edge_id", "source_entity_id", "target_entity_id", "edge_type", "valid_from", "valid_to", "source_event_id", "source_event_position", "anchor"]],
] as const);

const LEGACY_TABLES = Object.freeze({
  sessionTree: ["session_tree", ["project_id", "session_id", "checkpoint_id", "checkpoint_version", "base_event_position", "source_event_position", "occurred_at", "task_summary"]],
  canonicalItems: ["canonical_items", ["project_id", "session_id", "item_id", "normalized_key", "conflict_group_id", "superseding_item_id", "status", "confidence", "verification_method", "valid_from", "valid_to", "summary", "content_hash", "known_from_event_position", "source_event_position"]],
  tasksFollowups: ["tasks_followups", ["project_id", "session_id", "follow_up_id", "status", "summary", "confidence", "source_event_position"]],
  artifactsFiles: ["artifacts_files", ["project_id", "session_id", "artifact_id", "path", "summary", "action", "content_hash", "branch_ref", "confidence", "source_event_position"]],
  entityGraph: ["entity_graph", ["project_id", "edge_id", "source_entity_id", "relationship", "target_entity_id", "source_event_position"]],
  lexicalChunks: ["lexical_chunks", ["project_id", "chunk_id", "item_id", "session_id", "section", "normalized_key", "text", "source_event_position"]],
  retrievalFeedback: ["retrieval_feedback", ["project_id", "feedback_id", "item_id", "outcome", "usefulness", "source_item_event_position", "source_event_position"]],
} as const satisfies Record<LegacyProjectionName, readonly [string, readonly string[]]>);

const LEGACY_TABLE_ORDER = Object.freeze({
  sessionTree: "project_id, session_id",
  canonicalItems: "project_id, item_id",
  tasksFollowups: "project_id, follow_up_id",
  artifactsFiles: "project_id, session_id, artifact_id",
  entityGraph: "project_id, edge_id",
  lexicalChunks: "project_id, chunk_id",
  retrievalFeedback: "project_id, feedback_id",
} as const satisfies Record<LegacyProjectionName, string>);

const TABLE_ORDER = Object.freeze({
  sessionTree: "project_id, session_id",
  sessionCheckpoints: "project_id, session_id, source_event_position, checkpoint_id",
  canonicalItems: "project_id, item_id",
  tasksFollowups: "project_id, follow_up_id",
  artifactsFiles: "project_id, session_id, artifact_id",
  lexicalChunks: "project_id, chunk_id",
  retrievalFeedback: "project_id, feedback_id",
} as const satisfies Record<Exclude<ProjectionName, "entityGraph">, string>);

const INTEGER_NUMBER_COLUMNS = new Set(["checkpoint_version", "owner_generation", "usefulness"]);

function canonicalPersistedValue(
  value: unknown,
  column: string,
): CanonicalProjectionRow[string] {
  if (value === null || typeof value === "string") return value;
  if (typeof value === "bigint") {
    if (INTEGER_NUMBER_COLUMNS.has(column)) {
      if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
        return failure("PROJECTION_STRUCTURE_INVALID");
      }
      return Number(value);
    }
    return value.toString();
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return INTEGER_NUMBER_COLUMNS.has(column) ? value : value.toString();
  }
  return failure("PROJECTION_STRUCTURE_INVALID");
}

function persistedRows(connection: SqliteConnection): ProjectionRows {
  const result = {} as Record<ProjectionName, readonly CanonicalProjectionRow[]>;
  for (const name of PROJECTION_NAMES) {
    if (name === "entityGraph") {
      const graph: CanonicalProjectionRow[] = [];
      for (const [relation, table, columns] of ENTITY_TABLES) {
        for (const row of connection.prepare(`
          SELECT ${columns.join(", ")} FROM ${table} ORDER BY project_id, ${columns[1]}
        `).all()) {
          const canonical: Record<string, CanonicalProjectionRow[string]> = { relation };
          for (const column of columns) canonical[column] = canonicalPersistedValue(row[column], column);
          graph.push(Object.freeze(canonical));
        }
      }
      result[name] = Object.freeze(graph);
      continue;
    }
    const [table, columns] = TABLES[name];
    result[name] = freezeRows(connection.prepare(`
      SELECT ${columns.join(", ")} FROM ${table} ORDER BY ${TABLE_ORDER[name]}
    `).all().map((row) => {
      const canonical: Record<string, CanonicalProjectionRow[string]> = {};
      for (const column of columns) {
        if (!(column in row)) return failure("PROJECTION_STRUCTURE_INVALID");
        canonical[column] = canonicalPersistedValue(row[column], column);
      }
      return canonical;
    }));
  }
  return Object.freeze(result);
}

function persistedLegacyRows(connection: SqliteConnection): LegacyProjectionRows {
  const result = {} as Record<LegacyProjectionName, readonly CanonicalProjectionRow[]>;
  for (const name of LEGACY_PROJECTION_NAMES) {
    const [table, columns] = LEGACY_TABLES[name];
    result[name] = freezeRows(connection.prepare(`
      SELECT ${columns.join(", ")} FROM ${table} ORDER BY ${LEGACY_TABLE_ORDER[name]}
    `).all().map((row) => {
      const canonical: Record<string, CanonicalProjectionRow[string]> = {};
      for (const column of columns) {
        if (!(column in row)) return failure("PROJECTION_STRUCTURE_INVALID");
        canonical[column] = canonicalPersistedValue(row[column], column);
      }
      return canonical;
    }));
  }
  return Object.freeze(result);
}

function verifyPersistedChecksums(
  connection: SqliteConnection,
  snapshot: ProjectionEventSnapshot,
  expected: Readonly<Record<ProjectionName, string>>,
): Readonly<Record<ProjectionName, string>> {
  const rows = persistedRows(connection);
  const verified = {} as Record<ProjectionName, string>;
  for (const name of PROJECTION_NAMES) {
    const checksum = projectionCoreChecksum(
      name,
      PROJECTION_SCHEMA_VERSION,
      snapshot.binding.projectId,
      snapshot.terminalEventPosition,
      rows[name],
    );
    if (checksum !== expected[name]) return failure("PROJECTION_CHECKSUM_INVALID");
    const persisted = connection.prepare(`
      SELECT checksum FROM projection_core_checksums WHERE projection_name = $projectionName
    `).get({ $projectionName: name });
    if (persisted?.checksum !== checksum) return failure("PROJECTION_CHECKSUM_INVALID");
    verified[name] = checksum;
  }
  if (scalarCount(connection, "SELECT count(*) AS n FROM projection_core_checksums") !== BigInt(PROJECTION_NAMES.length)) {
    return failure("PROJECTION_CHECKSUM_INVALID");
  }
  try {
    connection.prepare(`
      INSERT INTO lexical_chunks_fts(lexical_chunks_fts, rank)
      VALUES ('integrity-check', 1)
    `).run();
  } catch {
    return failure("PROJECTION_FTS_INVALID");
  }
  return Object.freeze(verified);
}

function verifyLegacyPersistedChecksums(
  connection: SqliteConnection,
  snapshot: ProjectionEventSnapshot,
  expected: Readonly<Record<LegacyProjectionName, string>>,
): Readonly<Record<LegacyProjectionName, string>> {
  const rows = persistedLegacyRows(connection);
  const verified = {} as Record<LegacyProjectionName, string>;
  for (const name of LEGACY_PROJECTION_NAMES) {
    const checksum = projectionCoreChecksum(name, 1, snapshot.binding.projectId, snapshot.terminalEventPosition, rows[name]);
    if (checksum !== expected[name]) return failure("PROJECTION_CHECKSUM_INVALID");
    verified[name] = checksum;
  }
  try {
    connection.prepare(`INSERT INTO lexical_chunks_fts(lexical_chunks_fts, rank) VALUES ('integrity-check', 1)`).run();
  } catch {
    return failure("PROJECTION_FTS_INVALID");
  }
  return Object.freeze(verified);
}

function createLegacyProjectionSchema(connection: SqliteConnection): void {
  connection.exec("BEGIN IMMEDIATE");
  try {
    connection.exec(PROJECTION_SCHEMA_SQL_V1);
    connection.exec("COMMIT");
  } catch (error) {
    try { connection.exec("ROLLBACK"); } catch { /* preserve schema failure */ }
    throw error;
  }
}

function populate(
  connection: SqliteConnection,
  snapshot: ProjectionEventSnapshot,
  generation: number,
  createdAt: string,
  rows: ProjectionRows,
  coreChecksums: Readonly<Record<ProjectionName, string>>,
): void {
  connection.exec("BEGIN IMMEDIATE");
  try {
    connection.prepare(`
      UPDATE projection_metadata SET
        project_id = $projectId,
        vault_id = $vaultId,
        store_id = $storeId,
        workspace_id = $workspaceId,
        branch_scope_id = $branchScopeId,
        branch_ref = $branchRef,
        session_id = NULL,
        generation = $generation,
        terminal_event_position = $terminalEventPosition,
        terminal_event_hash = $terminalEventHash,
        created_at = $createdAt
      WHERE singleton = 1 AND schema_version = 2
    `).run({
      $projectId: snapshot.binding.projectId,
      $vaultId: snapshot.binding.vaultId,
      $storeId: snapshot.binding.storeId,
      $workspaceId: snapshot.binding.workspaceId,
      $branchScopeId: snapshot.binding.branchScopeId,
      $branchRef: snapshot.binding.branchRef,
      $generation: generation,
      $terminalEventPosition: snapshot.terminalEventPosition,
      $terminalEventHash: snapshot.terminalEventHash,
      $createdAt: createdAt,
    });
    for (const name of PROJECTION_NAMES) {
      connection.prepare(`
        INSERT INTO projection_core_checksums(projection_name, checksum)
        VALUES ($projectionName, $checksum)
      `).run({ $projectionName: name, $checksum: coreChecksums[name] });
    }
    for (const name of PROJECTION_NAMES) {
      if (name === "entityGraph") {
        const relationRows = rows.entityGraph;
        for (const [relation, table, columns] of ENTITY_TABLES) {
          insertRows(
            connection,
            table,
            columns,
            relationRows.filter((row) => row.relation === relation).map((row) => {
              const physical: Record<string, CanonicalProjectionRow[string]> = {};
              for (const column of columns) {
                const value = row[column];
                if (value === undefined) return failure("PROJECTION_ROW_INVALID");
                physical[column] = value;
              }
              return Object.freeze(physical);
            }),
          );
        }
        continue;
      }
      const [table, columns] = TABLES[name];
      insertRows(connection, table, columns, rows[name]);
    }
    connection.exec("COMMIT");
  } catch (error) {
    try {
      connection.exec("ROLLBACK");
    } catch {
      // Preserve the population failure.
    }
    throw error;
  }
}

function populateLegacy(
  connection: SqliteConnection,
  snapshot: ProjectionEventSnapshot,
  generation: number,
  createdAt: string,
  rows: LegacyProjectionRows,
): void {
  connection.exec("BEGIN IMMEDIATE");
  try {
    connection.prepare(`
      UPDATE projection_metadata SET
        project_id = $projectId, vault_id = $vaultId, store_id = $storeId,
        workspace_id = $workspaceId, branch_scope_id = $branchScopeId, branch_ref = $branchRef,
        session_id = NULL, generation = $generation,
        terminal_event_position = $terminalEventPosition, terminal_event_hash = $terminalEventHash,
        created_at = $createdAt
      WHERE singleton = 1 AND schema_version = 1
    `).run({
      $projectId: snapshot.binding.projectId,
      $vaultId: snapshot.binding.vaultId,
      $storeId: snapshot.binding.storeId,
      $workspaceId: snapshot.binding.workspaceId,
      $branchScopeId: snapshot.binding.branchScopeId,
      $branchRef: snapshot.binding.branchRef,
      $generation: generation,
      $terminalEventPosition: snapshot.terminalEventPosition,
      $terminalEventHash: snapshot.terminalEventHash,
      $createdAt: createdAt,
    });
    for (const name of LEGACY_PROJECTION_NAMES) {
      const [table, columns] = LEGACY_TABLES[name];
      insertRows(connection, table, columns, rows[name]);
    }
    connection.exec("COMMIT");
  } catch (error) {
    try { connection.exec("ROLLBACK"); } catch { /* preserve population failure */ }
    throw error;
  }
}

function scalarCount(connection: SqliteConnection, sql: string): bigint {
  const row = connection.prepare(sql).get();
  const value = row?.n;
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  return failure("PROJECTION_STRUCTURE_INVALID");
}

function verifyStructure(
  connection: SqliteConnection,
  snapshot: ProjectionEventSnapshot,
  generation: number,
  rows: ProjectionRows,
): void {
  const metadata = connection.prepare(`
    SELECT project_id, vault_id, store_id, workspace_id, branch_scope_id, branch_ref,
           session_id, generation, terminal_event_position, terminal_event_hash
    FROM projection_metadata WHERE singleton = 1
  `).get();
  if (
    metadata === undefined
    || metadata.project_id !== snapshot.binding.projectId
    || metadata.vault_id !== snapshot.binding.vaultId
    || metadata.store_id !== snapshot.binding.storeId
    || metadata.workspace_id !== snapshot.binding.workspaceId
    || metadata.branch_scope_id !== snapshot.binding.branchScopeId
    || metadata.branch_ref !== snapshot.binding.branchRef
    || metadata.session_id !== null
    || metadata.generation !== BigInt(generation)
    || metadata.terminal_event_position !== snapshot.terminalEventPosition
    || metadata.terminal_event_hash !== snapshot.terminalEventHash
  ) return failure("PROJECTION_STRUCTURE_INVALID");
  for (const name of PROJECTION_NAMES) {
    if (name === "entityGraph") {
      const count = ENTITY_TABLES.reduce(
        (total, [, table]) => total + scalarCount(connection, `SELECT count(*) AS n FROM ${table}`),
        0n,
      );
      if (count !== BigInt(rows.entityGraph.length)) return failure("PROJECTION_STRUCTURE_INVALID");
      continue;
    }
    const [table] = TABLES[name];
    if (scalarCount(connection, `SELECT count(*) AS n FROM ${table}`) !== BigInt(rows[name].length)) {
      return failure("PROJECTION_STRUCTURE_INVALID");
    }
  }
  if (
    scalarCount(connection, `
      SELECT count(*) AS n FROM canonical_items AS item
      LEFT JOIN canonical_items AS target
        ON target.project_id = item.project_id AND target.item_id = item.superseding_item_id
      WHERE item.superseding_item_id IS NOT NULL AND target.item_id IS NULL
    `) !== 0n
    ||
    scalarCount(connection, `
      SELECT count(*) AS n FROM retrieval_feedback AS feedback
      LEFT JOIN canonical_items AS item
        ON item.project_id = feedback.project_id AND item.item_id = feedback.item_id
      WHERE item.item_id IS NULL
    `) !== 0n
    || scalarCount(connection, `
      SELECT count(*) AS n FROM lexical_chunks AS chunk
      LEFT JOIN canonical_items AS item
        ON item.project_id = chunk.project_id AND item.item_id = chunk.item_id
      WHERE chunk.item_id IS NOT NULL
        AND (item.item_id IS NULL OR NOT (chunk.session_id IS item.session_id))
    `) !== 0n
    || scalarCount(connection, `
      SELECT count(*) AS n FROM entity_aliases AS alias
      LEFT JOIN entity_nodes AS entity
        ON entity.project_id = alias.project_id AND entity.entity_id = alias.entity_id
      WHERE entity.entity_id IS NULL
    `) !== 0n
    || scalarCount(connection, `
      SELECT count(*) AS n FROM entity_edges AS edge
      LEFT JOIN entity_nodes AS source
        ON source.project_id = edge.project_id AND source.entity_id = edge.source_entity_id
      LEFT JOIN entity_nodes AS target
        ON target.project_id = edge.project_id AND target.entity_id = edge.target_entity_id
      WHERE source.entity_id IS NULL OR target.entity_id IS NULL
    `) !== 0n
  ) return failure("PROJECTION_REFERENCE_INVALID");
  const integrity = connection.prepare("PRAGMA integrity_check").get();
  if (integrity?.integrity_check !== "ok") return failure("PROJECTION_STRUCTURE_INVALID");
  if (connection.prepare("PRAGMA foreign_key_check").all().length !== 0) {
    return failure("PROJECTION_REFERENCE_INVALID");
  }
}

function verifyLegacyStructure(
  connection: SqliteConnection,
  snapshot: ProjectionEventSnapshot,
  generation: number,
  rows: LegacyProjectionRows,
): void {
  const metadata = connection.prepare(`
    SELECT schema_version, project_id, vault_id, store_id, workspace_id, branch_scope_id, branch_ref,
           session_id, generation, terminal_event_position, terminal_event_hash
    FROM projection_metadata WHERE singleton = 1
  `).get();
  if (
    metadata === undefined || metadata.schema_version !== 1n
    || metadata.project_id !== snapshot.binding.projectId || metadata.vault_id !== snapshot.binding.vaultId
    || metadata.store_id !== snapshot.binding.storeId || metadata.workspace_id !== snapshot.binding.workspaceId
    || metadata.branch_scope_id !== snapshot.binding.branchScopeId || metadata.branch_ref !== snapshot.binding.branchRef
    || metadata.session_id !== null || metadata.generation !== BigInt(generation)
    || metadata.terminal_event_position !== snapshot.terminalEventPosition
    || metadata.terminal_event_hash !== snapshot.terminalEventHash
  ) return failure("PROJECTION_STRUCTURE_INVALID");
  for (const name of LEGACY_PROJECTION_NAMES) {
    const [table] = LEGACY_TABLES[name];
    if (scalarCount(connection, `SELECT count(*) AS n FROM ${table}`) !== BigInt(rows[name].length)) {
      return failure("PROJECTION_STRUCTURE_INVALID");
    }
  }
  if (
    scalarCount(connection, `
      SELECT count(*) AS n FROM canonical_items AS item
      LEFT JOIN canonical_items AS target
        ON target.project_id = item.project_id AND target.item_id = item.superseding_item_id
      WHERE item.superseding_item_id IS NOT NULL AND target.item_id IS NULL
    `) !== 0n
    || scalarCount(connection, `
      SELECT count(*) AS n FROM retrieval_feedback AS feedback
      LEFT JOIN canonical_items AS item
        ON item.project_id = feedback.project_id AND item.item_id = feedback.item_id
      WHERE item.item_id IS NULL
    `) !== 0n
  ) return failure("PROJECTION_REFERENCE_INVALID");
  if (connection.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") {
    return failure("PROJECTION_STRUCTURE_INVALID");
  }
}

function foldV2(snapshot: ProjectionEventSnapshot): ProjectionFoldState {
  const accumulator = new ProjectionFoldAccumulator();
  for (const source of snapshot.events()) {
    const decoded = decodeProjectionEvent(source);
    if (decoded.kind === "projected") accumulator.append(decoded.event);
  }
  return accumulator.finish();
}

function foldLegacy(snapshot: ProjectionEventSnapshot): LegacyProjectionFoldState {
  const accumulator = new LegacyProjectionFoldAccumulator();
  for (const source of snapshot.events()) {
    const decoded = decodeProjectionEventV1(source);
    if (decoded.kind !== "projected") continue;
    if (decoded.event.kind === "session-lifecycle" || decoded.event.kind === "governed-memory-source") {
      return failure("INTEGRITY_FAILURE");
    }
    accumulator.append(decoded.event);
  }
  return accumulator.finish();
}

export class ImmutableProjectionBuilder {
  readonly #driver: SqliteDriver;
  readonly #projectionDirectory: string;
  readonly #busyTimeoutMs: number;
  readonly #now: () => string;
  readonly #syncDirectory: DirectorySync;

  constructor(options: ImmutableProjectionBuilderOptions) {
    this.#driver = options.driver;
    this.#projectionDirectory = options.projectionDirectory;
    this.#busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#syncDirectory = options.syncDirectory ?? fsyncDirectory;
  }

  /** Legacy production build boundary. V2 adoption is intentionally a separate API. */
  async build(snapshot: ProjectionEventSnapshot, generation: number): Promise<BuiltProjectionGeneration> {
    if (!Number.isSafeInteger(generation) || generation < 1 || generation > MAX_GENERATION) {
      return failure("PROJECTION_GENERATION_INVALID");
    }
    const directory = safeDirectory(this.#projectionDirectory, this.#syncDirectory);
    const databaseFile = `projections-1-${generation}.sqlite`;
    const databasePath = join(directory, databaseFile);
    const tempPath = join(directory, `.projections-1-${generation}.sqlite.tmp`);
    if (existsSync(databasePath)) return failure("PROJECTION_GENERATION_EXISTS");
    assertProjectionSidecarsAbsent(databasePath);
    for (const knownTemp of [tempPath, `${tempPath}-wal`, `${tempPath}-shm`]) removeKnownFile(knownTemp);

    const state = foldLegacy(snapshot);
    const rows = legacyRowsFromState(state);
    const createdAt = this.#now();
    const coreChecksums = {} as Record<LegacyProjectionName, string>;
    for (const name of LEGACY_PROJECTION_NAMES) {
      coreChecksums[name] = projectionCoreChecksum(
        name, 1, snapshot.binding.projectId, snapshot.terminalEventPosition, rows[name],
      );
    }

    let connection: SqliteConnection | undefined;
    try {
      connection = this.#driver.open(tempPath, { mode: "create", busyTimeoutMs: this.#busyTimeoutMs });
      createLegacyProjectionSchema(connection);
      populateLegacy(connection, snapshot, generation, createdAt, rows);
      verifyLegacyStructure(connection, snapshot, generation, rows);
      const persistedCoreChecksums = verifyLegacyPersistedChecksums(connection, snapshot, coreChecksums);
      const checkpoint = connection.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      if (checkpoint?.busy !== 0n) return failure("PROJECTION_CHECKPOINT_FAILED");
      const journalMode = connection.prepare("PRAGMA journal_mode=DELETE").get();
      if (journalMode?.journal_mode !== "delete") return failure("PROJECTION_JOURNAL_MODE_INVALID");
      connection.close();
      connection = undefined;
      assertProjectionSidecarsAbsent(tempPath);
      assertRollbackJournalHeader(tempPath);
      const handle = openSync(tempPath, "r+");
      try { fsyncSync(handle); } finally { closeSync(handle); }
      assertProjectionSidecarsAbsent(tempPath);
      assertProjectionSidecarsAbsent(databasePath);
      renameSync(tempPath, databasePath);
      this.#syncDirectory(directory);
      verifyProjectionPublicationPaths(directory, databaseFile);
      assertRollbackJournalHeader(databasePath);
      const manifest = parseProjectionManifest({
        schemaVersion: 1,
        projectId: snapshot.binding.projectId,
        vaultId: snapshot.binding.vaultId,
        storeId: snapshot.binding.storeId,
        workspaceId: snapshot.binding.workspaceId,
        branchScopeId: snapshot.binding.branchScopeId,
        branchRef: snapshot.binding.branchRef,
        sessionId: null,
        generation,
        terminalEventPosition: snapshot.terminalEventPosition.toString(),
        terminalEventHash: snapshot.terminalEventHash,
        databaseFile,
        databaseSha256: sha256File(databasePath),
        coreChecksums: persistedCoreChecksums,
        createdAt,
      }, snapshot.binding);
      return Object.freeze({ manifest, projectionDirectory: directory, databasePath });
    } catch (error) {
      try { connection?.close(); } catch { /* preserve build failure */ }
      for (const knownTemp of [tempPath, `${tempPath}-wal`, `${tempPath}-shm`]) {
        try { removeKnownFile(knownTemp); } catch { /* preserve build failure */ }
      }
      throw error;
    }
  }

  async buildV2(snapshot: ProjectionEventSnapshot, generation: number): Promise<StagedProjectionGeneration> {
    if (!Number.isSafeInteger(generation) || generation < 1 || generation > MAX_GENERATION) {
      return failure("PROJECTION_GENERATION_INVALID");
    }
    const directory = safeDirectory(this.#projectionDirectory, this.#syncDirectory);
    const databaseFile = `projections-2-${generation}.sqlite`;
    const databasePath = join(directory, databaseFile);
    const tempPath = join(
      directory,
      `.projections-2-${generation}-${randomBytes(16).toString("hex")}.sqlite.tmp`,
    );
    if (existsSync(databasePath)) return failure("PROJECTION_GENERATION_EXISTS");
    assertProjectionSidecarsAbsent(databasePath);
    for (const knownTemp of [tempPath, `${tempPath}-wal`, `${tempPath}-shm`]) removeKnownFile(knownTemp);

    const state = foldV2(snapshot);
    const rows = rowsFromState(state);
    const createdAt = this.#now();
    const coreChecksums = {} as Record<ProjectionName, string>;
    for (const name of PROJECTION_NAMES) {
      coreChecksums[name] = projectionCoreChecksum(
        name,
        PROJECTION_SCHEMA_VERSION,
        snapshot.binding.projectId,
        snapshot.terminalEventPosition,
        rows[name],
      );
    }

    let connection: SqliteConnection | undefined;
    try {
      connection = this.#driver.open(tempPath, {
        mode: "create",
        busyTimeoutMs: this.#busyTimeoutMs,
      });
      createProjectionSchema(connection);
      populate(connection, snapshot, generation, createdAt, rows, coreChecksums);
      verifyStructure(connection, snapshot, generation, rows);
      const persistedCoreChecksums = verifyPersistedChecksums(
        connection,
        snapshot,
        coreChecksums,
      );
      const checkpoint = connection.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      if (checkpoint?.busy !== 0n) return failure("PROJECTION_CHECKPOINT_FAILED");
      const journalMode = connection.prepare("PRAGMA journal_mode=DELETE").get();
      if (journalMode?.journal_mode !== "delete") return failure("PROJECTION_JOURNAL_MODE_INVALID");
      connection.close();
      connection = undefined;
      assertProjectionSidecarsAbsent(tempPath);
      assertRollbackJournalHeader(tempPath);

      // Windows requires a writable file handle for FlushFileBuffers/fsync.
      const handle = openSync(tempPath, "r+");
      try {
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }
      assertProjectionSidecarsAbsent(tempPath);
      const directoryIdentity = captureProjectionDirectoryIdentity(directory);
      const manifest = parseProjectionManifestV2({
        schemaVersion: 2,
        projectId: snapshot.binding.projectId,
        vaultId: snapshot.binding.vaultId,
        storeId: snapshot.binding.storeId,
        workspaceId: snapshot.binding.workspaceId,
        branchScopeId: snapshot.binding.branchScopeId,
        branchRef: snapshot.binding.branchRef,
        sessionId: null,
        generation,
        highestObservedGeneration: generation,
        terminalEventPosition: snapshot.terminalEventPosition.toString(),
        terminalEventHash: snapshot.terminalEventHash,
        databaseFile,
        databaseSha256: sha256File(tempPath),
        coreChecksums: persistedCoreChecksums,
        createdAt,
      }, snapshot.binding);
      return Object.freeze({
        manifest,
        projectionDirectory: directory,
        temporaryDatabasePath: tempPath,
        directoryIdentity,
      });
    } catch (error) {
      try {
        connection?.close();
      } catch {
        // Preserve the build failure.
      }
      for (const knownTemp of [tempPath, `${tempPath}-wal`, `${tempPath}-shm`]) {
        try {
          removeKnownFile(knownTemp);
        } catch {
          // Preserve the build failure.
        }
      }
      throw error;
    }
  }
}
