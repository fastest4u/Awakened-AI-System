import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { Confidence } from "../contracts/event.js";
import type { ProjectId } from "../identity/contracts.js";
import type { ProjectionItemStatus } from "../projections/contracts.js";
import type { ProjectionManifestV1, ProjectionManifestV2 } from "../projections/manifest-codec.js";
import { ProjectionImageMetadataError, readProjectionImageMetadata } from "../projections/image-metadata.js";
import {
  InternalRetrievalError,
  validateInternalRetrievalRequest,
  type InternalRetrievalRequest,
  type RetrievalCandidate,
  type RetrievalCandidateCollection,
  type RetrievalChannel,
  type RetrievalChannelResult,
  type RetrievalConflictGroup,
  type RetrievalFreshness,
  type RetrievalItem,
  type RetrievalItemStatus,
  type ValidatedInternalRetrievalRequest,
} from "./contracts.js";
import { isEligible } from "./eligibility.js";

type SqliteParameter = null | number | bigint | string | Uint8Array;
type Row = Record<string, unknown>;
export type RetrievalProjectionManifest = ProjectionManifestV1 | ProjectionManifestV2;

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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

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

function nullableUuid(source: Row, key: string): string | null {
  const value = nullableString(source, key);
  if (value !== null && !UUID.test(value)) return projectionInvalid();
  return value;
}

function bigintValue(source: Row, key: string): bigint {
  const value = source[key];
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return projectionInvalid();
}

function signedBigintValue(source: Row, key: string): bigint {
  const value = source[key];
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
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
  manifest: RetrievalProjectionManifest,
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
    conflictGroupId: nullableUuid(source, `${prefix}conflict_group_id`),
    supersedingItemId: nullableUuid(source, `${prefix}superseding_item_id`),
    retrievalFeedbackScoreUnits: 0,
  });
}

function scopedItem(
  source: Row,
  manifest: RetrievalProjectionManifest,
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
    conflictGroupId: null,
    supersedingItemId: null,
    retrievalFeedbackScoreUnits: 0,
  });
}

function verifyMetadata(
  database: DatabaseSync,
  manifest: RetrievalProjectionManifest,
): void {
  try { readProjectionImageMetadata(database, manifest); }
  catch (error) {
    if (!(error instanceof ProjectionImageMetadataError)) throw error;
    if (error.kind === "malformed") return projectionInvalid();
    throw new InternalRetrievalError("PROJECTION_SCOPE_MISMATCH");
  }
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
  manifest: RetrievalProjectionManifest,
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
    conflictGroupId: null,
    supersedingItemId: null,
    retrievalFeedbackScoreUnits: 0,
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
  manifest: RetrievalProjectionManifest,
  request: ValidatedInternalRetrievalRequest,
  parameters: Readonly<Record<string, SqliteParameter>>,
): ChannelSelection {
  const rows = preparedRows(database, `
    SELECT item.project_id, item.session_id, item.item_id, item.normalized_key,
           item.conflict_group_id, item.superseding_item_id, item.status,
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
  manifest: RetrievalProjectionManifest,
  request: ValidatedInternalRetrievalRequest,
  parameters: Readonly<Record<string, SqliteParameter>>,
): ChannelSelection {
  if (manifest.schemaVersion === 2) {
    return Object.freeze({ items: Object.freeze([]), dropped: 0, overflow: false });
  }
  const rows = preparedRows(database, `
    SELECT item.project_id, item.session_id, item.item_id, item.normalized_key,
           item.conflict_group_id, item.superseding_item_id, item.status,
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
  manifest: RetrievalProjectionManifest,
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
           item.conflict_group_id AS canonical_conflict_group_id,
           item.superseding_item_id AS canonical_superseding_item_id,
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
  manifest: RetrievalProjectionManifest,
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
  manifest: RetrievalProjectionManifest,
  request: ValidatedInternalRetrievalRequest,
  parameters: Readonly<Record<string, SqliteParameter>>,
): ChannelSelection {
  const rows = manifest.schemaVersion === 2
    ? preparedRows(database, `
    SELECT project_id, session_id, checkpoint_id, task_summary, source_event_position,
           'high' AS confidence
    FROM session_checkpoints
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
  `, parameters)
    : preparedRows(database, `
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
  manifest: RetrievalProjectionManifest,
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

function itemKey(item: RetrievalItem): string {
  return `${item.kind}:${item.id}`;
}

function conflictCursor(
  manifest: RetrievalProjectionManifest,
  conflictGroupId: string,
  returnedMemberCount: number,
): string {
  const cursorPrefix = `retrieval-conflict-closure-v${manifest.schemaVersion}`;
  const digest = createHash("sha256")
    .update(cursorPrefix)
    .update("\u0000")
    .update(manifest.generation.toString())
    .update("\u0000")
    .update(manifest.terminalEventPosition)
    .update("\u0000")
    .update(conflictGroupId)
    .update("\u0000")
    .update(returnedMemberCount.toString())
    .digest("hex")
    .slice(0, 32);
  return `${cursorPrefix}:${returnedMemberCount}:${digest}`;
}

function conflictClosure(
  database: DatabaseSync,
  manifest: RetrievalProjectionManifest,
  request: ValidatedInternalRetrievalRequest,
  parameters: Readonly<Record<string, SqliteParameter>>,
  conflictGroupIds: readonly string[],
): Readonly<{
  readonly items: readonly RetrievalItem[];
  readonly eligibleCounts: ReadonlyMap<string, number>;
}> {
  if (conflictGroupIds.length === 0) {
    return Object.freeze({ items: Object.freeze([]), eligibleCounts: new Map() });
  }
  const groupParameters: Record<string, SqliteParameter> = { ...parameters };
  const placeholders = conflictGroupIds.map((groupId, index) => {
    const name = `$conflictGroup${index}`;
    groupParameters[name] = groupId;
    return name;
  });
  groupParameters.$closureLimit = request.candidateLimit;
  const membership = placeholders.join(", ");
  const countRows = preparedRows(database, `
    SELECT item.conflict_group_id, count(*) AS eligible_member_count
    FROM canonical_items AS item
    WHERE ${CANONICAL_ELIGIBILITY_SQL}
      AND item.conflict_group_id IN (${membership})
    GROUP BY item.conflict_group_id
    ORDER BY item.conflict_group_id
  `, groupParameters);
  const eligibleCounts = new Map<string, number>();
  for (const source of countRows) {
    const groupId = nullableUuid(source, "conflict_group_id");
    if (groupId === null || !conflictGroupIds.includes(groupId)) return projectionInvalid();
    const count = numberValue(source, "eligible_member_count");
    if (count < 1) return projectionInvalid();
    eligibleCounts.set(groupId, count);
  }
  if (eligibleCounts.size !== conflictGroupIds.length) return projectionInvalid();
  const rows = preparedRows(database, `
    SELECT item.project_id, item.session_id, item.item_id, item.normalized_key,
           item.conflict_group_id, item.superseding_item_id, item.status,
           item.confidence, item.verification_method, item.valid_from, item.valid_to,
           item.summary, item.known_from_event_position, item.source_event_position
    FROM canonical_items AS item
    WHERE ${CANONICAL_ELIGIBILITY_SQL}
      AND item.conflict_group_id IN (${membership})
    ORDER BY item.conflict_group_id, item.item_id
    LIMIT $closureLimit
  `, groupParameters);
  const terminalPosition = BigInt(manifest.terminalEventPosition);
  const items = rows.map((source) => canonicalItem(source, manifest, terminalPosition));
  if (items.some((item) => !isEligible(item, request, request.binding))) {
    return projectionInvalid();
  }
  return Object.freeze({ items: Object.freeze(items), eligibleCounts });
}

function feedbackScores(
  database: DatabaseSync,
  parameters: Readonly<Record<string, SqliteParameter>>,
  items: readonly RetrievalItem[],
): ReadonlyMap<string, number> {
  const itemIds = [...new Set(items
    .filter((item) => item.kind === "canonical")
    .map((item) => item.id))].sort();
  if (itemIds.length === 0) return new Map();
  const feedbackParameters: Record<string, SqliteParameter> = { ...parameters };
  const placeholders = itemIds.map((itemId, index) => {
    const name = `$feedbackItem${index}`;
    feedbackParameters[name] = itemId;
    return name;
  });
  const rows = preparedRows(database, `
    SELECT feedback.item_id,
           sum(CASE feedback.outcome
             WHEN 'accepted' THEN feedback.usefulness
             ELSE -feedback.usefulness
           END) AS signed_usefulness_units,
           count(*) AS feedback_count
    FROM retrieval_feedback AS feedback
    JOIN canonical_items AS item
      ON item.project_id = feedback.project_id
     AND item.item_id = feedback.item_id
     AND item.source_event_position = feedback.source_item_event_position
    WHERE feedback.project_id = $projectId
      AND feedback.item_id IN (${placeholders.join(", ")})
      AND feedback.source_event_position <= $terminalPosition
      AND ($knownAt IS NULL OR feedback.source_event_position <= $knownAt)
    GROUP BY feedback.item_id
    ORDER BY feedback.item_id
  `, feedbackParameters);
  const scores = new Map<string, number>();
  for (const source of rows) {
    const itemId = stringValue(source, "item_id");
    if (!itemIds.includes(itemId)) return projectionInvalid();
    const total = signedBigintValue(source, "signed_usefulness_units");
    const count = BigInt(numberValue(source, "feedback_count"));
    if (count < 1n || total < -10_000n * count || total > 10_000n * count) {
      return projectionInvalid();
    }
    scores.set(itemId, Number(total / count));
  }
  return scores;
}

function applyFeedback(item: RetrievalItem, scores: ReadonlyMap<string, number>): RetrievalItem {
  if (item.kind !== "canonical") return item;
  return Object.freeze({
    ...item,
    retrievalFeedbackScoreUnits: scores.get(item.id) ?? 0,
  });
}

function collectChannels(
  database: DatabaseSync,
  manifest: RetrievalProjectionManifest,
  request: ValidatedInternalRetrievalRequest,
): Readonly<{
  channels: readonly RetrievalChannelResult[];
  eligibleItemCount: number;
  droppedItemCount: number;
  truncated: boolean;
  conflictGroups: readonly RetrievalConflictGroup[];
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
  const directOutput: RetrievalChannelResult[] = [];
  const directUnique = new Map<string, RetrievalItem>();
  let dropped = 0;
  let truncated = false;
  for (const [channel, selection] of candidates) {
    dropped += selection.dropped;
    truncated ||= selection.overflow;
    const ranked: RetrievalCandidate[] = [];
    for (const [index, item] of selection.items.entries()) {
      const key = itemKey(item);
      if (!directUnique.has(key) && directUnique.size >= request.candidateLimit) {
        truncated = true;
        continue;
      }
      directUnique.set(key, item);
      ranked.push(Object.freeze({
        candidateId: candidateId(channel, item),
        channel,
        rank: index + 1,
        item,
      }));
    }
    directOutput.push(Object.freeze({ channel, candidates: Object.freeze(ranked) }));
  }
  const conflictGroupIds = [...new Set([...directUnique.values()]
    .map((item) => item.conflictGroupId)
    .filter((groupId): groupId is string => groupId !== null))].sort();
  const closure = conflictClosure(
    database,
    manifest,
    request,
    parameters,
    conflictGroupIds,
  );
  const allowed = new Map<string, RetrievalItem>();
  for (const conflictGroupId of conflictGroupIds) {
    const anchor = [...directUnique.values()]
      .filter((item) => item.conflictGroupId === conflictGroupId)
      .sort((left, right) => itemKey(left).localeCompare(itemKey(right)))[0];
    if (anchor === undefined) return projectionInvalid();
    allowed.set(itemKey(anchor), anchor);
  }
  for (const item of closure.items) {
    if (allowed.size >= request.candidateLimit) break;
    allowed.set(itemKey(item), item);
  }
  for (const [key, item] of directUnique) {
    if (allowed.size >= request.candidateLimit) break;
    allowed.set(key, item);
  }
  const groupedDirect = new Set([...directUnique]
    .filter(([, item]) => item.conflictGroupId !== null)
    .map(([key]) => key));
  const eligibleItemCount = directUnique.size - groupedDirect.size
    + [...closure.eligibleCounts.values()].reduce((total, count) => total + count, 0);
  truncated ||= eligibleItemCount > allowed.size;
  const rawChannels: RetrievalChannelResult[] = directOutput.map((channel) => {
    const filtered = channel.candidates.filter((candidate) => allowed.has(itemKey(candidate.item)));
    return Object.freeze({
      channel: channel.channel,
      candidates: Object.freeze(filtered.map((candidate, index) => Object.freeze({
        ...candidate,
        rank: index + 1,
      }))),
    });
  });
  const closureItems = closure.items.filter((item) => allowed.has(itemKey(item)));
  rawChannels.push(Object.freeze({
    channel: "conflict-closure",
    candidates: Object.freeze(closureItems.map((item, index) => Object.freeze({
      candidateId: candidateId("conflict-closure", item),
      channel: "conflict-closure" as const,
      rank: index + 1,
      item,
    }))),
  }));
  const scores = feedbackScores(database, parameters, [...allowed.values()]);
  const output = rawChannels.map((channel) => Object.freeze({
    channel: channel.channel,
    candidates: Object.freeze(channel.candidates.map((candidate) => Object.freeze({
      ...candidate,
      item: applyFeedback(candidate.item, scores),
    }))),
  }));
  const conflictGroups = conflictGroupIds.map((conflictGroupId): RetrievalConflictGroup => {
    const eligibleMemberCount = closure.eligibleCounts.get(conflictGroupId);
    if (eligibleMemberCount === undefined) return projectionInvalid();
    const returnedMemberCount = [...allowed.values()].filter(
      (item) => item.conflictGroupId === conflictGroupId,
    ).length;
    const groupTruncated = returnedMemberCount < eligibleMemberCount;
    return Object.freeze({
      conflictGroupId,
      eligibleMemberCount,
      returnedMemberCount,
      truncated: groupTruncated,
      cursor: groupTruncated
        ? conflictCursor(manifest, conflictGroupId, returnedMemberCount)
        : null,
    });
  });
  return Object.freeze({
    channels: Object.freeze(output),
    eligibleItemCount,
    droppedItemCount: dropped,
    truncated,
    conflictGroups: Object.freeze(conflictGroups),
  });
}

export function collectEligibleFromProjectionDatabase(
  database: DatabaseSync,
  manifest: RetrievalProjectionManifest,
  input: InternalRetrievalRequest,
): RetrievalCandidateCollection {
  const request = validateInternalRetrievalRequest(input);
  verifyMetadata(database, manifest);
  const collected = collectChannels(database, manifest, request);
  return Object.freeze({
    channels: collected.channels,
    eligibleItemCount: collected.eligibleItemCount,
    droppedItemCount: collected.droppedItemCount,
    truncated: collected.truncated,
    conflictGroups: collected.conflictGroups,
  });
}
