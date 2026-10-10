import type { ProjectBinding } from "./contracts.js";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { LifecycleError } from "../lifecycle/errors.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import { PROJECTION_NAMES, PROJECTION_NAMES_V3, projectionCoreChecksum, type ProjectionName, type ProjectionNameV3, type CanonicalProjectionRow } from "./checksum.js";
import { validateGovernedNoteProjectionRows, type GovernedNoteProjectionRowV1, type CanonicalItemProjection } from "./contracts.js";
import { parseProjectionManifestV3, type ProjectionManifestV3 } from "./manifest-codec.js";
import { readProjectionImageMetadata } from "./image-metadata.js";
import { PROJECTION_SCHEMA_SQL_V3 } from "./schema.js";
const MAX_ROWS = 100_000;
const MAX_VALUE_BYTES = 256 * 1024;
const MAX_CANONICAL_BYTES = 32 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/u;
type ProjectionRows = Readonly<Record<ProjectionName, readonly CanonicalProjectionRow[]>>;
export type ProjectionRowsV3 = Readonly<Record<ProjectionNameV3, readonly CanonicalProjectionRow[]>>;
function integrity(): never { throw new LifecycleError("INTEGRITY_FAILURE"); }
export interface ProjectionTable {
  readonly table: string;
  readonly columns: readonly string[];
  readonly keyColumns: readonly string[];
  readonly order: string;
  readonly canonicalRowId?: boolean;
}

export const TABLES = Object.freeze({
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

export const ENTITY_TABLES = Object.freeze([
  Object.freeze({ relation: "node", table: "entity_nodes", columns: Object.freeze(["project_id", "entity_id", "normalized_name", "entity_type", "valid_from", "valid_to", "source_event_id", "source_event_position", "anchor"]), key: "entity_id", order: "project_id, entity_id" }),
  Object.freeze({ relation: "alias", table: "entity_aliases", columns: Object.freeze(["project_id", "alias_id", "entity_id", "normalized_alias", "valid_from", "valid_to", "source_event_id", "source_event_position", "anchor"]), key: "alias_id", order: "project_id, alias_id" }),
  Object.freeze({ relation: "edge", table: "entity_edges", columns: Object.freeze(["project_id", "edge_id", "source_entity_id", "target_entity_id", "edge_type", "valid_from", "valid_to", "source_event_id", "source_event_position", "anchor"]), key: "edge_id", order: "project_id, edge_id" }),
] as const);

const INTEGER_NUMBER_COLUMNS = new Set(["checkpoint_version", "owner_generation", "usefulness"]);
export function statement(database: DatabaseSync, sql: string): StatementSync {
  const result = database.prepare(sql);
  result.setReadBigInts(true);
  return result;
}

export function canonicalValue(value: unknown, column: string): CanonicalProjectionRow[string] {
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

export function schemaRows(database: DatabaseSync): readonly Readonly<Record<string, unknown>>[] {
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

export function sameRecords(
  actual: readonly Readonly<Record<string, unknown>>[],
  expected: readonly Readonly<Record<string, unknown>>[],
  columns: readonly string[],
): boolean {
  if (actual.length !== expected.length) return false;
  return actual.every((row, index) => columns.every(
    (column) => row[column] === expected[index]?.[column],
  ));
}

export function ftsConfigRows(database: DatabaseSync): readonly Readonly<Record<string, unknown>>[] {
  const rows: Readonly<Record<string, unknown>>[] = [];
  for (const row of statement(database, `
    SELECT k, v FROM lexical_chunks_fts_config ORDER BY k
  `).iterate()) {
    if (rows.length >= 16) return integrity();
    rows.push(Object.freeze({ k: row.k, v: row.v }));
  }
  return Object.freeze(rows);
}

export function scalarCount(database: DatabaseSync, sql: string): bigint {
  const value = statement(database, sql).get()?.n;
  if (typeof value !== "bigint" || value < 0n) return integrity();
  return value;
}

export function assertReferences(database: DatabaseSync): void {
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

export function assertSqliteIntegrity(database: DatabaseSync): void {
  const integrityRows = statement(database, "PRAGMA integrity_check(1)").iterate();
  const first = integrityRows.next();
  if (first.done || first.value.integrity_check !== "ok" || !integrityRows.next().done) {
    return integrity();
  }
  if (!statement(database, "PRAGMA foreign_key_check").iterate().next().done) return integrity();
}

export function assertFtsSemantics(
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

export function persistedCoreChecksums(database: DatabaseSync): Readonly<Record<ProjectionName, string>> {
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

export function readUnpublishedCoreRows(database: DatabaseSync): ProjectionRows {
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

/** All rows come from this already owned image; no filesystem or writer is consulted. */
export function readCapturedProjectionV3Rows(database: DatabaseSync): ProjectionRowsV3 {
  const core = readUnpublishedCoreRows(database);
  const governed: GovernedNoteProjectionRowV1[] = [];
  let bytes = 2 + PROJECTION_NAMES.reduce((total, name) => total + Buffer.byteLength(canonicalJson(core[name]), "utf8"), 0);
  if (bytes > MAX_CANONICAL_BYTES) return integrity();
  for (const row of statement(database, `SELECT project_id, item_id, record_kind, format, body, body_content_hash,
    source_event_position FROM governed_notes ORDER BY project_id COLLATE BINARY, item_id COLLATE BINARY`).iterate()) {
    if (governed.length >= MAX_ROWS) return integrity();
    const value = { projectId: row.project_id, itemId: row.item_id, recordKind: row.record_kind, format: row.format,
      body: row.body, bodyContentHash: row.body_content_hash, sourceEventPosition: canonicalValue(row.source_event_position, "source_event_position") };
    bytes += Buffer.byteLength(canonicalJson(value), "utf8") + (governed.length === 0 ? 0 : 1);
    if (bytes > MAX_CANONICAL_BYTES) return integrity();
    governed.push(Object.freeze(value) as GovernedNoteProjectionRowV1);
  }
  return Object.freeze({ ...core, governedNotes: Object.freeze(governed) });
}

/** Pure validation of the exact database supplied by the capture owner. */
export function assertCapturedProjectionV3Image(database: DatabaseSync, manifestValue: ProjectionManifestV3): void {
  try {
    const manifest = parseProjectionManifestV3(manifestValue, Object.fromEntries(["projectId", "vaultId", "storeId", "workspaceId", "branchScopeId", "branchRef", "sessionId"].map(key => [key, Object.getOwnPropertyDescriptor(manifestValue, key)?.value])) as unknown as ProjectBinding);
    const reference = new DatabaseSync(":memory:", { allowExtension: false, enableDoubleQuotedStringLiterals: false });
    try {
      reference.exec(PROJECTION_SCHEMA_SQL_V3);
      if (!sameRecords(schemaRows(database), schemaRows(reference), ["type", "name", "tbl_name", "sql"])
        || !sameRecords(ftsConfigRows(database), ftsConfigRows(reference), ["k", "v"])) return integrity();
    } finally { reference.close(); }
    readProjectionImageMetadata(database, manifest);
    if (statement(database, "SELECT created_at FROM projection_metadata").get()?.created_at !== manifest.createdAt) return integrity();
    assertSqliteIntegrity(database);
    const rows = readCapturedProjectionV3Rows(database);
    const checksums = new Map<string, string>();
    for (const row of statement(database, "SELECT projection_name, checksum FROM projection_core_checksums").iterate()) {
      if (typeof row.projection_name !== "string" || typeof row.checksum !== "string"
        || !PROJECTION_NAMES_V3.includes(row.projection_name as ProjectionNameV3) || checksums.has(row.projection_name)) return integrity();
      checksums.set(row.projection_name, row.checksum);
    }
    if (checksums.size !== PROJECTION_NAMES_V3.length) return integrity();
    for (const name of PROJECTION_NAMES_V3) {
      if (checksums.get(name) !== manifest.coreChecksums[name]
        || projectionCoreChecksum(name, 3, manifest.projectId, BigInt(manifest.terminalEventPosition), rows[name]) !== manifest.coreChecksums[name]) return integrity();
    }
    const items = rows.canonicalItems.map(row => ({ projectId: row.project_id, itemId: row.item_id,
      normalizedKey: row.normalized_key, verificationMethod: row.verification_method,
      sourceEventPosition: BigInt(row.source_event_position as string) })) as Pick<CanonicalItemProjection,
        "projectId" | "itemId" | "normalizedKey" | "verificationMethod" | "sourceEventPosition">[];
    validateGovernedNoteProjectionRows(items, rows.governedNotes as readonly GovernedNoteProjectionRowV1[], BigInt(manifest.terminalEventPosition));
    assertReferences(database);
    assertFtsSemantics(database, rows.lexicalChunks);
  } catch { return integrity(); }
}
