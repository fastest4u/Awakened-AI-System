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

interface EligibleLexicalRow {
  readonly rowId: bigint;
  readonly chunkId: string;
  readonly normalizedKey: string;
  readonly text: string;
  readonly item: RetrievalItem;
}

interface AliasRow {
  readonly source: string;
  readonly target: string;
  readonly sourceEventPosition: bigint;
}

interface EligibilitySnapshot {
  readonly items: ReadonlyMap<string, RetrievalItem>;
  readonly canonicalById: ReadonlyMap<string, RetrievalItem>;
  readonly canonicalByKey: ReadonlyMap<string, RetrievalItem>;
  readonly lexical: readonly EligibleLexicalRow[];
  readonly aliases: readonly AliasRow[];
  readonly artifacts: readonly RetrievalItem[];
  readonly checkpoints: readonly RetrievalItem[];
  readonly followUps: readonly RetrievalItem[];
  readonly dropped: number;
  readonly truncated: boolean;
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

function status(source: Row): ProjectionItemStatus {
  const value = source.status;
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
): RetrievalItem {
  const sourcePosition = bigintValue(source, "source_event_position");
  return frozenItem({
    id: stringValue(source, "item_id"),
    kind: "canonical",
    projectId: stringValue(source, "project_id") as ProjectId,
    workspaceId: manifest.workspaceId,
    branchScopeId: manifest.branchScopeId,
    branchRef: manifest.branchRef,
    sessionId: null,
    visibility: "project",
    status: status(source),
    confidence: confidence(source),
    verificationMethod: stringValue(source, "verification_method"),
    validFrom: stringValue(source, "valid_from"),
    validTo: nullableString(source, "valid_to"),
    knownFromEventPosition: bigintValue(source, "known_from_event_position"),
    sourceEventPosition: sourcePosition,
    summary: stringValue(source, "summary"),
    normalizedKey: stringValue(source, "normalized_key"),
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

function scanParameters(
  request: ValidatedInternalRetrievalRequest,
  terminalPosition: bigint,
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
    $scanLimit: request.candidateLimit + 1,
  });
}

function collectEligibility(
  database: DatabaseSync,
  manifest: ProjectionManifestV1,
  request: ValidatedInternalRetrievalRequest,
): EligibilitySnapshot {
  const terminalPosition = BigInt(manifest.terminalEventPosition);
  const parameters = scanParameters(request, terminalPosition);
  const items = new Map<string, RetrievalItem>();
  const canonicalById = new Map<string, RetrievalItem>();
  const canonicalByKey = new Map<string, RetrievalItem>();
  const lexical: EligibleLexicalRow[] = [];
  const aliases: AliasRow[] = [];
  const artifacts: RetrievalItem[] = [];
  const checkpoints: RetrievalItem[] = [];
  const followUps: RetrievalItem[] = [];
  let dropped = 0;
  let truncated = false;

  const bounded = (rows: readonly Row[]): readonly Row[] => {
    if (rows.length > request.candidateLimit) truncated = true;
    return rows.slice(0, request.candidateLimit);
  };
  const accept = (candidate: RetrievalItem): boolean => {
    if (!isEligible(candidate, request, request.binding)) {
      dropped += 1;
      return false;
    }
    items.set(`${candidate.kind}:${candidate.id}`, candidate);
    return true;
  };

  for (const source of bounded(preparedRows(database, `
    SELECT project_id, item_id, normalized_key, status, confidence, verification_method,
           valid_from, valid_to, summary, known_from_event_position, source_event_position
    FROM canonical_items
    WHERE project_id = $projectId
      AND source_event_position <= $terminalPosition
      AND status NOT IN ('retracted', 'expired', 'erased-evidence')
      AND (
        $knownAt IS NULL
        OR (
          known_from_event_position <= $knownAt
          AND source_event_position <= $knownAt
        )
      )
      AND (
        $validAt IS NULL
        OR (
          valid_from <= $validAt
          AND (valid_to IS NULL OR $validAt < valid_to)
        )
      )
    ORDER BY source_event_position DESC, item_id
    LIMIT $scanLimit
  `, parameters))) {
    const candidate = canonicalItem(source, manifest, terminalPosition);
    if (!accept(candidate)) continue;
    canonicalById.set(candidate.id, candidate);
    canonicalByKey.set(candidate.normalizedKey, candidate);
  }

  for (const source of bounded(preparedRows(database, `
    SELECT row_id, project_id, chunk_id, item_id, session_id, section, normalized_key, text,
           source_event_position
    FROM lexical_chunks
    WHERE project_id = $projectId
      AND source_event_position <= $terminalPosition
      AND ($knownAt IS NULL OR source_event_position <= $knownAt)
      AND (
        (session_id IS NULL AND $visibilityLevel >= 2)
        OR (session_id = $sessionId AND $visibilityLevel >= 3)
      )
    ORDER BY source_event_position DESC, chunk_id
    LIMIT $scanLimit
  `, parameters))) {
    const sourcePosition = bigintValue(source, "source_event_position");
    const sessionId = nullableString(source, "session_id");
    const chunkId = stringValue(source, "chunk_id");
    const chunk = frozenItem({
      id: chunkId,
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
    const targetId = nullableString(source, "item_id");
    const target = targetId === null ? chunk : canonicalById.get(targetId);
    if (!isEligible(chunk, request, request.binding) || target === undefined) {
      dropped += 1;
      continue;
    }
    if (target === chunk) accept(chunk);
    lexical.push(Object.freeze({
      rowId: bigintValue(source, "row_id"),
      chunkId,
      normalizedKey: chunk.normalizedKey,
      text: chunk.summary,
      item: target,
    }));
  }

  for (const source of bounded(preparedRows(database, `
    SELECT project_id, edge_id, source_entity_id, relationship, target_entity_id,
           source_event_position
    FROM entity_graph
    WHERE project_id = $projectId
      AND relationship = 'alias'
      AND source_event_position <= $terminalPosition
      AND ($knownAt IS NULL OR source_event_position <= $knownAt)
    ORDER BY source_event_position DESC, edge_id
    LIMIT $scanLimit
  `, parameters))) {
    const sourcePosition = bigintValue(source, "source_event_position");
    if (request.knownAt !== undefined && sourcePosition > request.knownAt) {
      dropped += 1;
      continue;
    }
    aliases.push(Object.freeze({
      source: stringValue(source, "source_entity_id"),
      target: stringValue(source, "target_entity_id"),
      sourceEventPosition: sourcePosition,
    }));
  }

  for (const source of bounded(preparedRows(database, `
    SELECT project_id, session_id, artifact_id, path, summary, branch_ref, confidence,
           source_event_position
    FROM artifacts_files
    WHERE project_id = $projectId
      AND source_event_position <= $terminalPosition
      AND ($knownAt IS NULL OR source_event_position <= $knownAt)
      AND (branch_ref IS NULL OR branch_ref = $branchRef)
      AND session_id = $sessionId
      AND $visibilityLevel >= 3
    ORDER BY source_event_position DESC, artifact_id
    LIMIT $scanLimit
  `, parameters))) {
    const candidate = scopedItem(source, manifest, terminalPosition, {
      idColumn: "artifact_id",
      kind: "artifact",
      status: "active",
      summaryColumn: source.summary === null ? "path" : "summary",
      normalizedKeyColumn: "path",
      anchorColumn: "path",
      verificationMethod: "checkpoint-artifact",
      branchRef: nullableString(source, "branch_ref") ?? manifest.branchRef,
    });
    if (accept(candidate)) artifacts.push(candidate);
  }

  for (const source of bounded(preparedRows(database, `
    SELECT project_id, session_id, checkpoint_id, task_summary, source_event_position,
           'high' AS confidence
    FROM session_tree
    WHERE project_id = $projectId
      AND source_event_position <= $terminalPosition
      AND ($knownAt IS NULL OR source_event_position <= $knownAt)
      AND session_id = $sessionId
      AND $visibilityLevel >= 3
    ORDER BY source_event_position DESC, checkpoint_id
    LIMIT $scanLimit
  `, parameters))) {
    const candidate = scopedItem(source, manifest, terminalPosition, {
      idColumn: "checkpoint_id",
      kind: "checkpoint",
      status: "active",
      summaryColumn: "task_summary",
      verificationMethod: "session-checkpoint",
    });
    if (accept(candidate)) checkpoints.push(candidate);
  }

  for (const source of bounded(preparedRows(database, `
    SELECT project_id, session_id, follow_up_id, status, summary, confidence,
           source_event_position
    FROM tasks_followups
    WHERE project_id = $projectId
      AND status IN ('open', 'blocked')
      AND source_event_position <= $terminalPosition
      AND ($knownAt IS NULL OR source_event_position <= $knownAt)
      AND session_id = $sessionId
      AND $visibilityLevel >= 3
    ORDER BY source_event_position DESC, follow_up_id
    LIMIT $scanLimit
  `, parameters))) {
    const itemStatus = source.status;
    if (itemStatus !== "open" && itemStatus !== "blocked") return projectionInvalid();
    const candidate = scopedItem(source, manifest, terminalPosition, {
      idColumn: "follow_up_id",
      kind: "follow-up",
      status: itemStatus,
      summaryColumn: "summary",
      verificationMethod: "open-follow-up",
    });
    if (accept(candidate)) followUps.push(candidate);
  }

  return Object.freeze({
    items,
    canonicalById,
    canonicalByKey,
    lexical: Object.freeze(lexical),
    aliases: Object.freeze(aliases),
    artifacts: Object.freeze(artifacts),
    checkpoints: Object.freeze(checkpoints),
    followUps: Object.freeze(followUps),
    dropped,
    truncated,
  });
}

function normalized(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function includesQuery(candidate: string, query: string): boolean {
  return normalized(candidate).includes(query);
}

function exactChannel(snapshot: EligibilitySnapshot, query: string): readonly RetrievalItem[] {
  const results = new Map<string, RetrievalItem>();
  for (const item of snapshot.canonicalById.values()) {
    if (normalized(item.id) === query || normalized(item.normalizedKey) === query) {
      results.set(item.id, item);
    }
  }
  return Object.freeze([...results.values()].sort((left, right) => left.id.localeCompare(right.id)));
}

function aliasChannel(snapshot: EligibilitySnapshot, query: string): readonly RetrievalItem[] {
  const results = new Map<string, RetrievalItem>();
  for (const alias of snapshot.aliases) {
    let identity: string | undefined;
    if (normalized(alias.source) === query) identity = alias.target;
    else if (normalized(alias.target) === query) identity = alias.source;
    if (identity === undefined) continue;
    const target = snapshot.canonicalById.get(identity) ?? snapshot.canonicalByKey.get(identity);
    if (target !== undefined) results.set(target.id, target);
  }
  return Object.freeze([...results.values()].sort((left, right) => left.id.localeCompare(right.id)));
}

function ftsExpression(query: string): string | null {
  const terms = query.split(/\s+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
    .slice(0, 64);
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
}

function lexicalChannel(
  database: DatabaseSync,
  snapshot: EligibilitySnapshot,
  query: string,
  limit: number,
): readonly RetrievalItem[] {
  // The snapshot is complete before FTS5 is prepared. Query one eligible rowid
  // at a time so an ineligible chunk cannot enter the lexical candidate set.
  if (snapshot.lexical.length === 0) return Object.freeze([]);
  const expression = ftsExpression(query);
  if (expression === null) return Object.freeze([]);
  try {
    const statement = database.prepare(`
      SELECT bm25(lexical_chunks_fts) AS score
      FROM lexical_chunks_fts
      WHERE lexical_chunks_fts.rowid = $rowId
        AND lexical_chunks_fts MATCH $query
      LIMIT 1
    `);
    const matches: Array<{
      readonly chunkId: string;
      readonly item: RetrievalItem;
      readonly score: number;
    }> = [];
    for (const lexical of snapshot.lexical) {
      const hit = statement.get({ $rowId: lexical.rowId, $query: expression });
      if (hit === undefined) continue;
      if (typeof hit.score !== "number" || !Number.isFinite(hit.score)) {
        return projectionInvalid();
      }
      matches.push({ chunkId: lexical.chunkId, item: lexical.item, score: hit.score });
    }
    matches.sort((left, right) => left.score - right.score
      || left.item.id.localeCompare(right.item.id)
      || left.chunkId.localeCompare(right.chunkId));
    const results = new Map<string, RetrievalItem>();
    for (const match of matches) {
      results.set(match.item.id, match.item);
      if (results.size >= limit) break;
    }
    return Object.freeze([...results.values()]);
  } catch (error) {
    if (error instanceof InternalRetrievalError) throw error;
    return projectionInvalid();
  }
}

function matchingItems(
  items: readonly RetrievalItem[],
  query: string,
  fields: (item: RetrievalItem) => readonly string[],
): readonly RetrievalItem[] {
  return Object.freeze(items
    .filter((item) => fields(item).some((value) => includesQuery(value, query)))
    .sort((left, right) => (
      right.sourceEventPosition === left.sourceEventPosition
        ? left.id.localeCompare(right.id)
        : right.sourceEventPosition > left.sourceEventPosition ? 1 : -1
    )));
}

function candidateId(channel: RetrievalChannel, item: RetrievalItem): string {
  return `${channel}:${item.kind}:${item.id}`;
}

function channels(
  database: DatabaseSync,
  snapshot: EligibilitySnapshot,
  request: ValidatedInternalRetrievalRequest,
): readonly RetrievalChannelResult[] {
  const query = normalized(request.query);
  const candidates = new Map<RetrievalChannel, readonly RetrievalItem[]>([
    ["exact", exactChannel(snapshot, query)],
    ["alias", aliasChannel(snapshot, query)],
    ["lexical", lexicalChannel(database, snapshot, query, request.candidateLimit)],
    ["symbol-path", matchingItems(
      snapshot.artifacts,
      query,
      (item) => [item.id, item.normalizedKey, item.summary, item.anchor ?? ""],
    )],
    ["session-checkpoint", matchingItems(
      snapshot.checkpoints,
      query,
      (item) => [item.id, item.summary],
    )],
    ["open-follow-up", matchingItems(
      snapshot.followUps,
      query,
      (item) => [item.id, item.summary],
    )],
  ]);
  let remaining = request.candidateLimit;
  const output: RetrievalChannelResult[] = [];
  for (const [channel, items] of candidates) {
    const selected = items.slice(0, remaining);
    remaining -= selected.length;
    const ranked: RetrievalCandidate[] = selected.map((item, index) => Object.freeze({
      candidateId: candidateId(channel, item),
      channel,
      rank: index + 1,
      item,
    }));
    output.push(Object.freeze({ channel, candidates: Object.freeze(ranked) }));
  }
  return Object.freeze(output);
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
      const eligible = collectEligibility(database, manifest, request);
      const channelResults = channels(database, eligible, request);
      const candidateCount = channelResults.reduce(
        (total, channel) => total + channel.candidates.length,
        0,
      );
      return Object.freeze({
        channels: channelResults,
        eligibleItemCount: eligible.items.size,
        droppedItemCount: eligible.dropped,
        truncated: eligible.truncated || candidateCount >= request.candidateLimit,
      });
    } finally {
      database.close();
      assertProjectionSidecarsAbsent(lease.databasePath);
    }
  }
}
