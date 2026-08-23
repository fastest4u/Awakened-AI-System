import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
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
import { openCommittedProjectionEventSnapshot } from "./event-reader.js";
import { emptyProjectionFoldState, foldProjectionEvent } from "./folds.js";
import {
  parseProjectionManifest,
  verifyProjectionPublicationPaths,
  type ProjectionManifestV1,
} from "./manifest.js";
import { PROJECTION_SCHEMA_VERSION } from "./schema.js";
import { decodeProjectionEvent } from "./source-event-codec.js";

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAX_ROWS = 100_000;
const MAX_VALUE_BYTES = 256 * 1_024;
const MAX_CANONICAL_BYTES = 32 * 1024 * 1024;

export interface ProjectionIntegrityServiceOptions {
  readonly driver: SqliteDriver;
  readonly eventStorePath: string;
  readonly projectionDirectory: string;
  readonly busyTimeoutMs?: number;
}

export interface ProjectionIntegrityReport {
  readonly status: "passed";
  readonly terminalEventPosition: string;
}

type ProjectionRows = Readonly<Record<ProjectionName, readonly CanonicalProjectionRow[]>>;

interface ProjectionTable {
  readonly table: string;
  readonly columns: readonly string[];
  readonly order: string;
  readonly canonicalRowId?: boolean;
}

const TABLES = Object.freeze({
  sessionTree: Object.freeze({
    table: "session_tree",
    columns: Object.freeze(["project_id", "session_id", "checkpoint_id", "checkpoint_version", "base_event_position", "source_event_position", "occurred_at", "task_summary"]),
    order: "project_id, session_id",
  }),
  canonicalItems: Object.freeze({
    table: "canonical_items",
    columns: Object.freeze(["project_id", "item_id", "normalized_key", "status", "confidence", "verification_method", "valid_from", "valid_to", "summary", "content_hash", "known_from_event_position", "source_event_position"]),
    order: "project_id, item_id",
  }),
  tasksFollowups: Object.freeze({
    table: "tasks_followups",
    columns: Object.freeze(["project_id", "session_id", "follow_up_id", "status", "summary", "confidence", "source_event_position"]),
    order: "project_id, follow_up_id",
  }),
  artifactsFiles: Object.freeze({
    table: "artifacts_files",
    columns: Object.freeze(["project_id", "session_id", "artifact_id", "path", "summary", "action", "content_hash", "branch_ref", "confidence", "source_event_position"]),
    order: "project_id, session_id, artifact_id",
  }),
  entityGraph: Object.freeze({
    table: "entity_graph",
    columns: Object.freeze(["project_id", "edge_id", "source_entity_id", "relationship", "target_entity_id", "source_event_position"]),
    order: "project_id, edge_id",
  }),
  lexicalChunks: Object.freeze({
    table: "lexical_chunks",
    columns: Object.freeze(["project_id", "chunk_id", "item_id", "session_id", "section", "normalized_key", "text", "source_event_position"]),
    order: "project_id, chunk_id",
    canonicalRowId: true,
  }),
  retrievalFeedback: Object.freeze({
    table: "retrieval_feedback",
    columns: Object.freeze(["project_id", "feedback_id", "item_id", "outcome", "usefulness", "source_item_event_position", "source_event_position"]),
    order: "project_id, feedback_id",
  }),
} as const satisfies Record<ProjectionName, ProjectionTable>);

const INTEGER_NUMBER_COLUMNS = new Set(["checkpoint_version", "usefulness"]);

function integrity(): never {
  throw new LifecycleError("INTEGRITY_FAILURE");
}

function statement(database: DatabaseSync, sql: string): StatementSync {
  const result = database.prepare(sql);
  result.setReadBigInts(true);
  return result;
}

function sha256File(path: string): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(path, "r");
  try {
    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function frozenRows(rows: CanonicalProjectionRow[]): readonly CanonicalProjectionRow[] {
  return Object.freeze(rows.map((row) => Object.freeze(row)));
}

function rowsFromState(state: ProjectionFoldState): ProjectionRows {
  return Object.freeze({
    sessionTree: frozenRows(state.sessionCheckpoints.map((row) => ({
      project_id: row.projectId,
      session_id: row.sessionId,
      checkpoint_id: row.checkpointId,
      checkpoint_version: row.checkpointVersion,
      base_event_position: row.baseEventPosition.toString(),
      source_event_position: row.sourceEventPosition.toString(),
      occurred_at: row.occurredAt,
      task_summary: row.taskSummary,
    })).sort((left, right) => String(left.session_id).localeCompare(String(right.session_id)))),
    canonicalItems: frozenRows(state.canonicalItems.map((row) => ({
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
    })).sort((left, right) => String(left.item_id).localeCompare(String(right.item_id)))),
    tasksFollowups: frozenRows(state.followUps.map((row) => ({
      project_id: row.projectId,
      session_id: row.sessionId,
      follow_up_id: row.followUpId,
      status: row.status,
      summary: row.summary,
      confidence: row.confidence,
      source_event_position: row.sourceEventPosition.toString(),
    })).sort((left, right) => String(left.follow_up_id).localeCompare(String(right.follow_up_id)))),
    artifactsFiles: frozenRows(state.artifacts.map((row) => ({
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
    })).sort((left, right) => `${String(left.session_id)}\0${String(left.artifact_id)}`
      .localeCompare(`${String(right.session_id)}\0${String(right.artifact_id)}`))),
    entityGraph: Object.freeze([]),
    lexicalChunks: frozenRows(state.lexicalChunks.map((row) => ({
      project_id: row.projectId,
      chunk_id: row.chunkId,
      item_id: row.itemId,
      session_id: row.sessionId,
      section: row.section,
      normalized_key: row.normalizedKey,
      text: row.text,
      source_event_position: row.sourceEventPosition.toString(),
    })).sort((left, right) => String(left.chunk_id).localeCompare(String(right.chunk_id)))),
    retrievalFeedback: frozenRows(state.retrievalFeedback.map((row) => ({
      project_id: row.projectId,
      feedback_id: row.feedbackId,
      item_id: row.itemId,
      outcome: row.outcome,
      usefulness: row.usefulness,
      source_item_event_position: row.sourceItemEventPosition.toString(),
      source_event_position: row.sourceEventPosition.toString(),
    })).sort((left, right) => String(left.feedback_id).localeCompare(String(right.feedback_id)))),
  });
}

function replay(
  binding: ProjectBinding,
  manifest: ProjectionManifestV1,
  options: ProjectionIntegrityServiceOptions,
): ProjectionRows {
  const terminalEventPosition = BigInt(manifest.terminalEventPosition);
  const snapshot = openCommittedProjectionEventSnapshot(binding, {
    driver: options.driver,
    eventStorePath: options.eventStorePath,
    busyTimeoutMs: options.busyTimeoutMs,
    terminalEventPosition,
  });
  try {
    if (
      snapshot.terminalEventPosition !== terminalEventPosition
      || snapshot.terminalEventHash !== manifest.terminalEventHash
    ) return integrity();
    let state = emptyProjectionFoldState();
    for (const source of snapshot.events) {
      const decoded = decodeProjectionEvent(source);
      if (decoded.kind === "projected") state = foldProjectionEvent(state, decoded.event);
    }
    return rowsFromState(state);
  } finally {
    snapshot.close();
  }
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
  expectedRows: ProjectionRows,
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
    let index = 0;
    for (const raw of iterator) {
      if (index >= MAX_ROWS || index >= expectedRows[name].length) return integrity();
      if (definition.canonicalRowId && raw.row_id !== BigInt(index + 1)) return integrity();
      const row: Record<string, CanonicalProjectionRow[string]> = {};
      for (const column of definition.columns) {
        if (!(column in raw)) return integrity();
        row[column] = canonicalValue(raw[column], column);
        totalBytes += Buffer.byteLength(JSON.stringify(row[column]), "utf8");
        if (totalBytes > MAX_CANONICAL_BYTES) return integrity();
      }
      const canonical = Object.freeze(row);
      if (!sameRow(canonical, expectedRows[name][index]!, definition.columns)) return integrity();
      rows.push(canonical);
      index += 1;
    }
    if (index !== expectedRows[name].length) return integrity();
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

function assertTableColumns(database: DatabaseSync): void {
  const expected = new Map<string, readonly string[]>([
    ["projection_metadata", ["singleton", "schema_version", "project_id", "vault_id", "store_id", "workspace_id", "branch_scope_id", "branch_ref", "session_id", "generation", "terminal_event_position", "terminal_event_hash", "created_at"]],
    ...PROJECTION_NAMES.map((name) => [
      TABLES[name].table,
      (TABLES[name] as ProjectionTable).canonicalRowId
        ? ["row_id", ...TABLES[name].columns]
        : TABLES[name].columns,
    ] as const),
    ["lexical_chunks_fts", ["normalized_key", "text"]],
  ]);
  for (const [table, columns] of expected) {
    const actual = statement(database, `PRAGMA table_info(${table})`).all()
      .map((row) => row.name);
    if (
      actual.length !== columns.length
      || actual.some((value, index) => value !== columns[index])
    ) return integrity();
  }
}

function assertMetadata(
  database: DatabaseSync,
  binding: ProjectBinding,
  manifest: ProjectionManifestV1,
): void {
  const rows = statement(database, `
    SELECT singleton, schema_version, project_id, vault_id, store_id, workspace_id,
           branch_scope_id, branch_ref, session_id, generation,
           terminal_event_position, terminal_event_hash, created_at
    FROM projection_metadata ORDER BY singleton
  `).all();
  if (rows.length !== 1) return integrity();
  const row = rows[0]!;
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
  const rows = statement(database, "PRAGMA integrity_check").all();
  if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") return integrity();
  if (statement(database, "PRAGMA foreign_key_check").all().length !== 0) return integrity();
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
}

function inspectGeneration(
  path: string,
  binding: ProjectBinding,
  manifest: ProjectionManifestV1,
  expectedRows: ProjectionRows,
  busyTimeoutMs: number,
): void {
  const beforeHash = sha256File(path);
  if (beforeHash !== manifest.databaseSha256) return integrity();
  const database = new DatabaseSync(path, {
    open: true,
    readOnly: true,
    timeout: busyTimeoutMs,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
  });
  try {
    database.exec("PRAGMA trusted_schema = OFF; BEGIN");
    assertTableColumns(database);
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
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* preserve integrity failure */ }
    throw error;
  } finally {
    database.close();
  }
  if (sha256File(path) !== beforeHash) return integrity();
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
