import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
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
import { emptyProjectionFoldState, foldProjectionEvent } from "./folds.js";
import {
  parseProjectionManifest,
  verifyProjectionPublicationPaths,
  type ProjectionManifestV1,
} from "./manifest.js";
import { createProjectionSchema, PROJECTION_SCHEMA_VERSION } from "./schema.js";
import { decodeProjectionEvent } from "./source-event-codec.js";

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAX_GENERATION = 2_147_483_647;

export interface BuiltProjectionGeneration {
  readonly manifest: ProjectionManifestV1;
  readonly projectionDirectory: string;
  readonly databasePath: string;
}

export interface ImmutableProjectionBuilderOptions {
  readonly driver: SqliteDriver;
  readonly projectionDirectory: string;
  readonly busyTimeoutMs?: number;
  readonly now?: () => string;
  readonly syncDirectory?: DirectorySync;
}

type ProjectionRows = Readonly<Record<ProjectionName, readonly CanonicalProjectionRow[]>>;

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

function freezeRows(rows: CanonicalProjectionRow[]): readonly CanonicalProjectionRow[] {
  return Object.freeze(rows.map((row) => Object.freeze(row)));
}

function rowsFromState(state: ProjectionFoldState): ProjectionRows {
  return Object.freeze({
    sessionTree: freezeRows(state.sessionCheckpoints
      .map((row) => ({
        project_id: row.projectId,
        session_id: row.sessionId,
        checkpoint_id: row.checkpointId,
        checkpoint_version: row.checkpointVersion,
        base_event_position: row.baseEventPosition.toString(),
        source_event_position: row.sourceEventPosition.toString(),
        occurred_at: row.occurredAt,
        task_summary: row.taskSummary,
      }))
      .sort((left, right) => String(left.session_id).localeCompare(String(right.session_id)))),
    canonicalItems: freezeRows(state.canonicalItems
      .map((row) => ({
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
        source_event_position: row.sourceEventPosition.toString(),
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
        source_event_position: row.sourceEventPosition.toString(),
      }))
      .sort((left, right) => `${String(left.session_id)}\0${String(left.artifact_id)}`
        .localeCompare(`${String(right.session_id)}\0${String(right.artifact_id)}`))),
    entityGraph: Object.freeze([]),
    lexicalChunks: freezeRows(state.lexicalChunks
      .map((row) => ({
        project_id: row.projectId,
        chunk_id: row.chunkId,
        item_id: row.itemId,
        session_id: row.sessionId,
        section: row.section,
        normalized_key: row.normalizedKey,
        text: row.text,
        source_event_position: row.sourceEventPosition.toString(),
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
        source_event_position: row.sourceEventPosition.toString(),
      }))
      .sort((left, right) => String(left.feedback_id).localeCompare(String(right.feedback_id)))),
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
    ["project_id", "session_id", "checkpoint_id", "checkpoint_version", "base_event_position", "source_event_position", "occurred_at", "task_summary"],
  ],
  canonicalItems: [
    "canonical_items",
    ["project_id", "item_id", "normalized_key", "status", "confidence", "verification_method", "valid_from", "valid_to", "summary", "content_hash", "known_from_event_position", "source_event_position"],
  ],
  tasksFollowups: [
    "tasks_followups",
    ["project_id", "session_id", "follow_up_id", "status", "summary", "confidence", "source_event_position"],
  ],
  artifactsFiles: [
    "artifacts_files",
    ["project_id", "session_id", "artifact_id", "path", "summary", "action", "content_hash", "branch_ref", "confidence", "source_event_position"],
  ],
  entityGraph: [
    "entity_graph",
    ["project_id", "edge_id", "source_entity_id", "relationship", "target_entity_id", "source_event_position"],
  ],
  lexicalChunks: [
    "lexical_chunks",
    ["project_id", "chunk_id", "item_id", "session_id", "section", "normalized_key", "text", "source_event_position"],
  ],
  retrievalFeedback: [
    "retrieval_feedback",
    ["project_id", "feedback_id", "item_id", "outcome", "usefulness", "source_item_event_position", "source_event_position"],
  ],
} as const);

const TABLE_ORDER = Object.freeze({
  sessionTree: "project_id, session_id",
  canonicalItems: "project_id, item_id",
  tasksFollowups: "project_id, follow_up_id",
  artifactsFiles: "project_id, session_id, artifact_id",
  entityGraph: "project_id, edge_id",
  lexicalChunks: "project_id, chunk_id",
  retrievalFeedback: "project_id, feedback_id",
} as const satisfies Record<ProjectionName, string>);

const INTEGER_NUMBER_COLUMNS = new Set(["checkpoint_version", "usefulness"]);

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
    verified[name] = checksum;
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

function populate(
  connection: SqliteConnection,
  snapshot: ProjectionEventSnapshot,
  generation: number,
  createdAt: string,
  rows: ProjectionRows,
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
    for (const name of PROJECTION_NAMES) {
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
    const [table] = TABLES[name];
    if (scalarCount(connection, `SELECT count(*) AS n FROM ${table}`) !== BigInt(rows[name].length)) {
      return failure("PROJECTION_STRUCTURE_INVALID");
    }
  }
  if (
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
      WHERE chunk.item_id IS NOT NULL AND item.item_id IS NULL
    `) !== 0n
  ) return failure("PROJECTION_REFERENCE_INVALID");
  const integrity = connection.prepare("PRAGMA integrity_check").get();
  if (integrity?.integrity_check !== "ok") return failure("PROJECTION_STRUCTURE_INVALID");
  if (connection.prepare("PRAGMA foreign_key_check").all().length !== 0) {
    return failure("PROJECTION_REFERENCE_INVALID");
  }
}

function fold(snapshot: ProjectionEventSnapshot): ProjectionFoldState {
  let state = emptyProjectionFoldState();
  for (const source of snapshot.events) {
    const decoded = decodeProjectionEvent(source);
    if (decoded.kind === "projected") state = foldProjectionEvent(state, decoded.event);
  }
  return state;
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

  async build(snapshot: ProjectionEventSnapshot, generation: number): Promise<BuiltProjectionGeneration> {
    if (!Number.isSafeInteger(generation) || generation < 1 || generation > MAX_GENERATION) {
      return failure("PROJECTION_GENERATION_INVALID");
    }
    const directory = safeDirectory(this.#projectionDirectory, this.#syncDirectory);
    const databaseFile = `projections-1-${generation}.sqlite`;
    const databasePath = join(directory, databaseFile);
    const tempPath = join(directory, `.projections-1-${generation}.sqlite.tmp`);
    if (existsSync(databasePath)) return failure("PROJECTION_GENERATION_EXISTS");
    for (const knownTemp of [tempPath, `${tempPath}-wal`, `${tempPath}-shm`]) removeKnownFile(knownTemp);

    const state = fold(snapshot);
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
      populate(connection, snapshot, generation, createdAt, rows);
      verifyStructure(connection, snapshot, generation, rows);
      const persistedCoreChecksums = verifyPersistedChecksums(
        connection,
        snapshot,
        coreChecksums,
      );
      connection.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      connection.close();
      connection = undefined;
      for (const sidecar of [`${tempPath}-wal`, `${tempPath}-shm`]) removeKnownFile(sidecar);

      // Windows requires a writable file handle for FlushFileBuffers/fsync.
      const handle = openSync(tempPath, "r+");
      try {
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }
      renameSync(tempPath, databasePath);
      this.#syncDirectory(directory);
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
      verifyProjectionPublicationPaths(directory, databaseFile);
      return Object.freeze({ manifest, projectionDirectory: directory, databasePath });
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
