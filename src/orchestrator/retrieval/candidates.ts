import { DatabaseSync } from "node:sqlite";

import type { Confidence } from "../contracts/event.js";
import type { ProjectId } from "../identity/contracts.js";
import type { ProjectionItemStatus } from "../projections/contracts.js";
import {
  assertProjectionSidecarsAbsent,
  parseProjectionManifest,
  type ProjectionManifestV1,
} from "../projections/manifest.js";
import type { ProjectionReaderLease } from "../projections/reader-lease.js";
import {
  InternalRetrievalError,
  validateInternalRetrievalRequest,
  type InternalRetrievalRequest,
  type RetrievalCandidate,
  type RetrievalCandidateCollection,
  type RetrievalChannel,
  type RetrievalChannelResult,
  type RetrievalFreshness,
  type RetrievalItem,
  type RetrievalItemStatus,
  type ValidatedInternalRetrievalRequest,
} from "./contracts.js";
import { isEligible } from "./eligibility.js";

type SqliteParameter = null | number | bigint | string | Uint8Array;
type Row = Record<string, unknown>;

interface ChannelSelection {
  readonly items: readonly RetrievalItem[];
  readonly dropped: number;
  readonly overflow: boolean;
}

const CONFIDENCE = new Set<Confidence>(["high", "medium", "low", "guess"]);
const CANONICAL_STATUS = new Set<ProjectionItemStatus>([
  "candidate", "provisional", "verified", "conflicted", "superseded",
  "retracted", "expired", "erased-evidence",
]);

function projectionInvalid(): never {
  throw new InternalRetrievalError("RETRIEVAL_PROJECTION_INVALID");
}

function row(value: unknown): Row {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return projectionInvalid();
  }
  return value as Row;
}

function stringValue(source: Row, key: string): string {
  const value = source[key];
  if (typeof value !== "string") return projectionInvalid();
  return value;
}

function nullableString(source: Row, key: string): string | null {
  const value = source[key];
  if (value === null) return null;
  if (typeof value !== "string") return projectionInvalid();
  return value;
}

function bigintValue(source: Row, key: string): bigint {
  const value = source[key];
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return projectionInvalid();
}

function numberValue(source: Row, key: string): number {
  const value = source[key];
  if (typeof value === "bigint" && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  return projectionInvalid();
}

function confidence(source: Row, key = "confidence"): Confidence {
  const value = source[key];
  if (typeof value !== "string" || !CONFIDENCE.has(value as Confidence)) {
    return projectionInvalid();
  }
  return value as Confidence;
}

function status(source: Row, key = "status"): ProjectionItemStatus {
  const value = source[key];
  if (typeof value !== "string" || !CANONICAL_STATUS.has(value as ProjectionItemStatus)) {
    return projectionInvalid();
  }
  return value as ProjectionItemStatus;
}

function preparedRows(
  database: DatabaseSync,
  sql: string,
  parameters: Readonly<Record<string, SqliteParameter>>,
): readonly Row[] {
  const statement = database.prepare(sql);
  statement.setReadBigInts(true);
  const bound: Record<string, SqliteParameter> = {};
  for (const match of sql.matchAll(/\$[A-Za-z][A-Za-z0-9]*/gu)) {
    const name = match[0];
    const value = parameters[name];
    if (value === undefined) return projectionInvalid();
    bound[name] = value;
  }
  return statement.all(bound) as Row[];
}

function freshness(sourcePosition: bigint, terminalPosition: bigint): RetrievalFreshness {
  return sourcePosition <= terminalPosition ? "fresh" : "corrupt";
}

function frozenItem(item: RetrievalItem): RetrievalItem {
  return Object.freeze(item);
}

function canonicalItem(
  source: Row,
  manifest: ProjectionManifestV1,
  terminalPosition: bigint,
  prefix = "",
): RetrievalItem {
  const sourcePosition = bigintValue(source, `${prefix}source_event_position`);
  const sessionId = nullableString(source, `${prefix}session_id`);
  return frozenItem({
    id: stringValue(source, `${prefix}item_id`),
    kind: "canonical",
    projectId: stringValue(source, `${prefix}project_id`) as ProjectId,
    workspaceId: manifest.workspaceId,
    branchScopeId: manifest.branchScopeId,
    branchRef: manifest.branchRef,
    sessionId,
    visibility: sessionId === null ? "project" : "session",
    status: status(source, `${prefix}status`),
    confidence: confidence(source, `${prefix}confidence`),
    verificationMethod: stringValue(source, `${prefix}verification_method`),
    validFrom: stringValue(source, `${prefix}valid_from`),
    validTo: nullableString(source, `${prefix}valid_to`),
    knownFromEventPosition: bigintValue(source, `${prefix}known_from_event_position`),
    sourceEventPosition: sourcePosition,
    summary: stringValue(source, `${prefix}summary`),
    normalizedKey: stringValue(source, `${prefix}normalized_key`),
    anchor: null,
    freshness: freshness(sourcePosition, terminalPosition),
  });
}

function scopedItem(
  source: Row,
  manifest: ProjectionManifestV1,
  terminalPosition: bigint,
  options: Readonly<{
    idColumn: string;
    kind: RetrievalItem["kind"];
    status: RetrievalItemStatus;
    summaryColumn: string;
    normalizedKeyColumn?: string;
    anchorColumn?: string;
    verificationMethod: string;
    branchRef?: string | null;
  }>,
): RetrievalItem {
  const sourcePosition = bigintValue(source, "source_event_position");
  const sessionId = nullableString(source, "session_id");
  const summary = stringValue(source, options.summaryColumn);
  const normalizedKey = options.normalizedKeyColumn === undefined
    ? stringValue(source, options.idColumn)
    : stringValue(source, options.normalizedKeyColumn);
  const anchor = options.anchorColumn === undefined
    ? null
    : nullableString(source, options.anchorColumn);
  return frozenItem({
    id: stringValue(source, options.idColumn),
    kind: options.kind,
    projectId: stringValue(source, "project_id") as ProjectId,
    workspaceId: manifest.workspaceId,
    branchScopeId: manifest.branchScopeId,
    branchRef: options.branchRef === undefined ? manifest.branchRef : options.branchRef,
    sessionId,
    visibility: sessionId === null ? "branch" : "session",
    status: options.status,
    confidence: confidence(source),
    verificationMethod: options.verificationMethod,
    validFrom: null,
    validTo: null,
    knownFromEventPosition: sourcePosition,
    sourceEventPosition: sourcePosition,
    summary,
    normalizedKey,
    anchor,
    freshness: freshness(sourcePosition, terminalPosition),
  });
}

function verifyMetadata(
  database: DatabaseSync,
  manifest: ProjectionManifestV1,
): void {
  const statement = database.prepare(`
    SELECT project_id, vault_id, store_id, workspace_id, branch_scope_id, branch_ref,
           session_id, generation, terminal_event_position, terminal_event_hash
    FROM projection_metadata WHERE singleton = 1 AND schema_version = 1
  `);
  statement.setReadBigInts(true);
  const metadata = statement.get();
  if (metadata === undefined) return projectionInvalid();
  const source = row(metadata);
  if (
    source.project_id !== manifest.projectId
    || source.vault_id !== manifest.vaultId
    || source.store_id !== manifest.storeId
    || source.workspace_id !== manifest.workspaceId
    || source.branch_scope_id !== manifest.branchScopeId
    || source.branch_ref !== manifest.branchRef
    || source.session_id !== null
    || numberValue(source, "generation") !== manifest.generation
    || bigintValue(source, "terminal_event_position") !== BigInt(manifest.terminalEventPosition)
    || source.terminal_event_hash !== manifest.terminalEventHash
  ) throw new InternalRetrievalError("PROJECTION_SCOPE_MISMATCH");
}

function normalized(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function ftsExpression(query: string): string | null {
  const terms = query.split(/\s+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
    .slice(0, 64);
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
}

function channelParameters(
  request: ValidatedInternalRetrievalRequest,
  terminalPosition: bigint,
  query: string,
): Readonly<Record<string, SqliteParameter>> {
  const visibility = request.visibility
    ?? (request.sessionId === undefined ? "branch" : "session");
  const visibilityLevel = {
    project: 0,
    workspace: 1,
    branch: 2,
    session: 3,
  }[visibility];
  return Object.freeze({
    $projectId: request.binding.projectId,
    $terminalPosition: terminalPosition,
    $knownAt: request.knownAt ?? null,
    $validAt: request.validAt ?? null,
    $visibilityLevel: visibilityLevel,
    $sessionId: request.sessionId ?? null,
    $branchRef: request.binding.branchRef,
    $query: query,
    $scanLimit: request.candidateLimit + 1,
  });
}

function lexicalItem(
  source: Row,
  manifest: ProjectionManifestV1,
  terminalPosition: bigint,
): RetrievalItem {
  const sourcePosition = bigintValue(source, "source_event_position");
  const sessionId = nullableString(source, "session_id");
  return frozenItem({
    id: stringValue(source, "chunk_id"),
    kind: "lexical",
    projectId: stringValue(source, "project_id") as ProjectId,
    workspaceId: manifest.workspaceId,
    branchScopeId: manifest.branchScopeId,
    branchRef: manifest.branchRef,
    sessionId,
    visibility: sessionId === null ? "branch" : "session",
    status: "active",
    confidence: "medium",
    verificationMethod: "projection-chunk",
    validFrom: null,
    validTo: null,
    knownFromEventPosition: sourcePosition,
    sourceEventPosition: sourcePosition,
    summary: stringValue(source, "text"),
    normalizedKey: stringValue(source, "normalized_key"),
    anchor: stringValue(source, "section"),
    freshness: freshness(sourcePosition, terminalPosition),
  });
}

function boundedSelection(
  rows: readonly Row[],
  request: ValidatedInternalRetrievalRequest,
  convert: (source: Row) => RetrievalItem,
): ChannelSelection {
  const selected = new Map<string, RetrievalItem>();
  let dropped = 0;
  for (const source of rows) {
    const candidate = convert(source);
    if (!isEligible(candidate, request, request.binding)) {
      dropped += 1;
      continue;
    }
    selected.set(`${candidate.kind}:${candidate.id}`, candidate);
  }
  const overflow = selected.size > request.candidateLimit;
  return Object.freeze({
    items: Object.freeze([...selected.values()].slice(0, request.candidateLimit)),
    dropped,
    overflow,
  });
}

const CANONICAL_ELIGIBILITY_SQL = `
  item.project_id = $projectId
  AND item.source_event_position <= $terminalPosition
  AND item.status NOT IN ('retracted', 'expired', 'erased-evidence')
  AND (
    item.session_id IS NULL
    OR (item.session_id = $sessionId AND $visibilityLevel >= 3)
  )
  AND (
    $knownAt IS NULL
    OR (
      item.known_from_event_position <= $knownAt
      AND item.source_event_position <= $knownAt
    )
  )
  AND (
    $validAt IS NULL
    OR (
      item.valid_from <= $validAt
      AND (item.valid_to IS NULL OR $validAt < item.valid_to)
    )
  )
`;

function exactSelection(
  database: DatabaseSync,
  manifest: ProjectionManifestV1,
  request: ValidatedInternalRetrievalRequest,
  parameters: Readonly<Record<string, SqliteParameter>>,
): ChannelSelection {
  const rows = preparedRows(database, `
    SELECT item.project_id, item.session_id, item.item_id, item.normalized_key, item.status,
           item.confidence, item.verification_method, item.valid_from, item.valid_to,
           item.summary, item.known_from_event_position, item.source_event_position
    FROM canonical_items AS item
    WHERE ${CANONICAL_ELIGIBILITY_SQL}
      AND (lower(item.item_id) = $query OR item.normalized_key = $query)
    ORDER BY item.source_event_position DESC, item.item_id
    LIMIT $scanLimit
  `, parameters);
  const terminalPosition = BigInt(manifest.terminalEventPosition);
  return boundedSelection(rows, request, (source) => (
    canonicalItem(source, manifest, terminalPosition)
  ));
}

function aliasSelection(
  database: DatabaseSync,
  manifest: ProjectionManifestV1,
  request: ValidatedInternalRetrievalRequest,
  parameters: Readonly<Record<string, SqliteParameter>>,
): ChannelSelection {
  const rows = preparedRows(database, `
    SELECT item.project_id, item.session_id, item.item_id, item.normalized_key, item.status,
           item.confidence, item.verification_method, item.valid_from, item.valid_to,
           item.summary, item.known_from_event_position, item.source_event_position
    FROM entity_graph AS edge
    JOIN canonical_items AS item
      ON item.project_id = edge.project_id
     AND (
       (
         lower(edge.source_entity_id) = $query
         AND (
           lower(item.item_id) = lower(edge.target_entity_id)
           OR item.normalized_key = lower(edge.target_entity_id)
         )
       )
       OR (
         lower(edge.target_entity_id) = $query
         AND (
           lower(item.item_id) = lower(edge.source_entity_id)
           OR item.normalized_key = lower(edge.source_entity_id)
         )
       )
     )
    WHERE edge.project_id = $projectId
      AND edge.relationship = 'alias'
      AND edge.source_event_position <= $terminalPosition
      AND ($knownAt IS NULL OR edge.source_event_position <= $knownAt)
      AND ${CANONICAL_ELIGIBILITY_SQL}
    ORDER BY edge.source_event_position DESC, item.item_id
    LIMIT $scanLimit
  `, parameters);
  const terminalPosition = BigInt(manifest.terminalEventPosition);
  return boundedSelection(rows, request, (source) => (
    canonicalItem(source, manifest, terminalPosition)
  ));
}

function lexicalSelection(
  database: DatabaseSync,
  manifest: ProjectionManifestV1,
  request: ValidatedInternalRetrievalRequest,
  parameters: Readonly<Record<string, SqliteParameter>>,
  expression: string | null,
): ChannelSelection {
  if (expression === null) return Object.freeze({ items: Object.freeze([]), dropped: 0, overflow: false });
  const lexicalParameters = Object.freeze({ ...parameters, $ftsQuery: expression });
  const rows = preparedRows(database, `
    SELECT bm25(lexical_chunks_fts) AS fts_score,
           chunk.project_id, chunk.chunk_id, chunk.item_id, chunk.session_id, chunk.section,
           chunk.normalized_key, chunk.text, chunk.source_event_position,
           item.project_id AS canonical_project_id,
           item.session_id AS canonical_session_id,
           item.item_id AS canonical_item_id,
           item.normalized_key AS canonical_normalized_key,
           item.status AS canonical_status,
           item.confidence AS canonical_confidence,
           item.verification_method AS canonical_verification_method,
           item.valid_from AS canonical_valid_from,
           item.valid_to AS canonical_valid_to,
           item.summary AS canonical_summary,
           item.known_from_event_position AS canonical_known_from_event_position,
           item.source_event_position AS canonical_source_event_position
    FROM lexical_chunks_fts
    JOIN lexical_chunks AS chunk ON chunk.row_id = lexical_chunks_fts.rowid
    LEFT JOIN canonical_items AS item
      ON item.project_id = chunk.project_id AND item.item_id = chunk.item_id
    WHERE lexical_chunks_fts MATCH $ftsQuery
      AND chunk.project_id = $projectId
      AND chunk.source_event_position <= $terminalPosition
      AND ($knownAt IS NULL OR chunk.source_event_position <= $knownAt)
      AND (
        (chunk.session_id IS NULL AND $visibilityLevel >= 2)
        OR (chunk.session_id = $sessionId AND $visibilityLevel >= 3)
      )
      AND (
        chunk.item_id IS NULL
        OR (${CANONICAL_ELIGIBILITY_SQL})
      )
    ORDER BY fts_score, COALESCE(item.item_id, chunk.chunk_id), chunk.chunk_id
    LIMIT $scanLimit
  `, lexicalParameters);
  const terminalPosition = BigInt(manifest.terminalEventPosition);
  return boundedSelection(rows, request, (source) => {
    if (typeof source.fts_score !== "number" || !Number.isFinite(source.fts_score)) {
      return projectionInvalid();
    }
    return source.item_id === null
      ? lexicalItem(source, manifest, terminalPosition)
      : canonicalItem(source, manifest, terminalPosition, "canonical_");
  });
}

function symbolPathSelection(
  database: DatabaseSync,
  manifest: ProjectionManifestV1,
  request: ValidatedInternalRetrievalRequest,
  parameters: Readonly<Record<string, SqliteParameter>>,
): ChannelSelection {
  const rows = preparedRows(database, `
    SELECT project_id, session_id, artifact_id, path, summary, branch_ref, confidence,
           source_event_position
    FROM artifacts_files
    WHERE project_id = $projectId
      AND source_event_position <= $terminalPosition
      AND ($knownAt IS NULL OR source_event_position <= $knownAt)
      AND (branch_ref IS NULL OR branch_ref = $branchRef)
      AND session_id = $sessionId
      AND $visibilityLevel >= 3
      AND (
        instr(lower(artifact_id), $query) > 0
        OR instr(lower(path), $query) > 0
        OR instr(lower(COALESCE(summary, '')), $query) > 0
      )
    ORDER BY source_event_position DESC, artifact_id
    LIMIT $scanLimit
  `, parameters);
  const terminalPosition = BigInt(manifest.terminalEventPosition);
  return boundedSelection(rows, request, (source) => scopedItem(
    source,
    manifest,
    terminalPosition,
    {
      idColumn: "artifact_id",
      kind: "artifact",
      status: "active",
      summaryColumn: source.summary === null ? "path" : "summary",
      normalizedKeyColumn: "path",
      anchorColumn: "path",
      verificationMethod: "checkpoint-artifact",
      branchRef: nullableString(source, "branch_ref") ?? manifest.branchRef,
    },
  ));
}

function checkpointSelection(
  database: DatabaseSync,
  manifest: ProjectionManifestV1,
  request: ValidatedInternalRetrievalRequest,
  parameters: Readonly<Record<string, SqliteParameter>>,
): ChannelSelection {
  const rows = preparedRows(database, `
    SELECT project_id, session_id, checkpoint_id, task_summary, source_event_position,
           'high' AS confidence
    FROM session_tree
    WHERE project_id = $projectId
      AND source_event_position <= $terminalPosition
      AND ($knownAt IS NULL OR source_event_position <= $knownAt)
      AND session_id = $sessionId
      AND $visibilityLevel >= 3
      AND (
        instr(lower(checkpoint_id), $query) > 0
        OR instr(lower(task_summary), $query) > 0
      )
    ORDER BY source_event_position DESC, checkpoint_id
    LIMIT $scanLimit
  `, parameters);
  const terminalPosition = BigInt(manifest.terminalEventPosition);
  return boundedSelection(rows, request, (source) => scopedItem(
    source,
    manifest,
    terminalPosition,
    {
      idColumn: "checkpoint_id",
      kind: "checkpoint",
      status: "active",
      summaryColumn: "task_summary",
      verificationMethod: "session-checkpoint",
    },
  ));
}

function followUpSelection(
  database: DatabaseSync,
  manifest: ProjectionManifestV1,
  request: ValidatedInternalRetrievalRequest,
  parameters: Readonly<Record<string, SqliteParameter>>,
): ChannelSelection {
  const rows = preparedRows(database, `
    SELECT project_id, session_id, follow_up_id, status, summary, confidence,
           source_event_position
    FROM tasks_followups
    WHERE project_id = $projectId
      AND status IN ('open', 'blocked')
      AND source_event_position <= $terminalPosition
      AND ($knownAt IS NULL OR source_event_position <= $knownAt)
      AND session_id = $sessionId
      AND $visibilityLevel >= 3
      AND (
        instr(lower(follow_up_id), $query) > 0
        OR instr(lower(summary), $query) > 0
      )
    ORDER BY source_event_position DESC, follow_up_id
    LIMIT $scanLimit
  `, parameters);
  const terminalPosition = BigInt(manifest.terminalEventPosition);
  return boundedSelection(rows, request, (source) => {
    const itemStatus = source.status;
    if (itemStatus !== "open" && itemStatus !== "blocked") return projectionInvalid();
    return scopedItem(source, manifest, terminalPosition, {
      idColumn: "follow_up_id",
      kind: "follow-up",
      status: itemStatus,
      summaryColumn: "summary",
      verificationMethod: "open-follow-up",
    });
  });
}

function candidateId(channel: RetrievalChannel, item: RetrievalItem): string {
  return `${channel}:${item.kind}:${item.id}`;
}

function collectChannels(
  database: DatabaseSync,
  manifest: ProjectionManifestV1,
  request: ValidatedInternalRetrievalRequest,
): Readonly<{
  channels: readonly RetrievalChannelResult[];
  eligibleItemCount: number;
  droppedItemCount: number;
  truncated: boolean;
}> {
  const query = normalized(request.query);
  const terminalPosition = BigInt(manifest.terminalEventPosition);
  const parameters = channelParameters(request, terminalPosition, query);
  const candidates = new Map<RetrievalChannel, ChannelSelection>([
    ["exact", exactSelection(database, manifest, request, parameters)],
    ["alias", aliasSelection(database, manifest, request, parameters)],
    ["lexical", lexicalSelection(database, manifest, request, parameters, ftsExpression(query))],
    ["symbol-path", symbolPathSelection(database, manifest, request, parameters)],
    ["session-checkpoint", checkpointSelection(database, manifest, request, parameters)],
    ["open-follow-up", followUpSelection(database, manifest, request, parameters)],
  ]);
  const output: RetrievalChannelResult[] = [];
  const unique = new Set<string>();
  let dropped = 0;
  let truncated = false;
  for (const [channel, selection] of candidates) {
    dropped += selection.dropped;
    truncated ||= selection.overflow;
    const ranked: RetrievalCandidate[] = [];
    for (const [index, item] of selection.items.entries()) {
      const key = `${item.kind}:${item.id}`;
      if (!unique.has(key) && unique.size >= request.candidateLimit) {
        truncated = true;
        continue;
      }
      unique.add(key);
      ranked.push(Object.freeze({
        candidateId: candidateId(channel, item),
        channel,
        rank: index + 1,
        item,
      }));
    }
    output.push(Object.freeze({ channel, candidates: Object.freeze(ranked) }));
  }
  return Object.freeze({
    channels: Object.freeze(output),
    eligibleItemCount: unique.size,
    droppedItemCount: dropped,
    truncated,
  });
}

function openProjection(path: string, deadlineMs: number): DatabaseSync {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, {
      open: true,
      readOnly: true,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
      allowBareNamedParameters: false,
      allowUnknownNamedParameters: false,
      timeout: deadlineMs,
    });
    database.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;");
    if (
      Number(database.prepare("PRAGMA query_only").get()?.query_only) !== 1
      || Number(database.prepare("PRAGMA trusted_schema").get()?.trusted_schema) !== 0
    ) return projectionInvalid();
    return database;
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Preserve the projection-open failure.
    }
    if (error instanceof InternalRetrievalError) throw error;
    return projectionInvalid();
  }
}

export class SqliteRetrievalCandidateRepository {
  collectEligible(
    lease: ProjectionReaderLease,
    input: InternalRetrievalRequest,
  ): RetrievalCandidateCollection {
    const request = validateInternalRetrievalRequest(input);
    let manifest: ProjectionManifestV1;
    try {
      manifest = parseProjectionManifest(lease.manifest, request.binding);
    } catch {
      throw new InternalRetrievalError("PROJECTION_SCOPE_MISMATCH");
    }
    assertProjectionSidecarsAbsent(lease.databasePath);
    const database = openProjection(lease.databasePath, request.consistency.deadlineMs);
    try {
      verifyMetadata(database, manifest);
      const collected = collectChannels(database, manifest, request);
      return Object.freeze({
        channels: collected.channels,
        eligibleItemCount: collected.eligibleItemCount,
        droppedItemCount: collected.droppedItemCount,
        truncated: collected.truncated,
      });
    } catch (error) {
      if (error instanceof InternalRetrievalError) throw error;
      return projectionInvalid();
    } finally {
      database.close();
      assertProjectionSidecarsAbsent(lease.databasePath);
    }
  }
}
