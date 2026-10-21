import type { JsonValue, StoredEvent } from "../contracts/event.js";
import { assertRetainedStoredEvent } from "../privacy/retained-evidence-codec.js";
import { LifecycleError } from "../lifecycle/errors.js";
import type {
  LifecycleCommandTransaction,
} from "../lifecycle/lifecycle-command.store.js";
import {
  childEventFoldFingerprint,
  classifyChildProjectionEvent,
  classifyWorkflowProjectionEvent,
  foldChildEventProjection,
  foldWorkflowGenerationProjection,
  reportItemSetFingerprint,
  workflowFingerprintV2,
  workflowGenerationFingerprint,
  type ChildEventFoldProjection,
  type WorkflowGenerationFoldProjection,
} from "../lifecycle/lifecycle-projection-folds.js";
import {
  decodeLifecycleEvent,
  type LifecycleEventCodecResult,
} from "../lifecycle/contracts/events.js";
import {
  decodeLifecycleIntentWitness,
  type LifecycleIntentWitnessV1,
} from "../lifecycle/lifecycle-intent-witness.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import type { EventAppendBatch } from "./event-append-transaction.js";
import type {
  SqliteConnection,
  SqliteParams,
  SqliteRow,
} from "./sqlite-driver.js";

const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;
const LOWER_HASH = /^[0-9a-f]{64}$/;

export const CHILD_EVENT_FOLD_CURSOR_SQL = `
  SELECT /* lifecycle-full:child-fold */ *
  FROM lifecycle_child_event_folds
    INDEXED BY lifecycle_child_event_folds_full_replay
  WHERE project_id = $projectId
  ORDER BY event_position, child_session_id, stream_version
`;

export const WORKFLOW_GENERATION_FOLD_CURSOR_SQL = `
  SELECT /* lifecycle-full:workflow-fold */ *
  FROM lifecycle_workflow_generation_folds
    INDEXED BY lifecycle_workflow_generation_folds_full_replay
  WHERE project_id = $projectId
  ORDER BY trigger_event_position, workflow_id, workflow_generation
`;

export interface ChildEventFoldCursor {
  readonly visits: number;
  peek(): ChildEventFoldProjection | null;
  advance(): ChildEventFoldProjection;
  close(): void;
}

export interface WorkflowGenerationFoldCursor {
  readonly visits: number;
  peek(): WorkflowGenerationFoldProjection | null;
  advance(): WorkflowGenerationFoldProjection;
  close(): void;
}

export function openChildEventFoldCursor(
  connection: SqliteConnection,
  projectId: string,
): ChildEventFoldCursor {
  return openDetachedProjectionCursor(
    connection,
    projectId,
    CHILD_EVENT_FOLD_CURSOR_SQL,
    hydrateChild,
  );
}

export function openWorkflowGenerationFoldCursor(
  connection: SqliteConnection,
  projectId: string,
): WorkflowGenerationFoldCursor {
  return openDetachedProjectionCursor(
    connection,
    projectId,
    WORKFLOW_GENERATION_FOLD_CURSOR_SQL,
    hydrateWorkflow,
  );
}
const CHILD_STATES = new Set([
  "active",
  "completion-proposed",
  "completed",
  "suspended",
  "transferred",
]);
const REPORT_CONSUMER_TYPES = new Set([
  "ChildCompletionProposed",
  "ChildWorkDispositioned",
  "ChildSessionCompleted",
]);

export interface LifecycleProjectionWriter {
  append<T extends JsonValue>(
    committed: EventAppendBatch<T>,
    transaction: LifecycleCommandTransaction,
  ): void;
}

function integrity(): never {
  throw new LifecycleError("INTEGRITY_FAILURE");
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return integrity();
  }
  return value as Readonly<Record<string, unknown>>;
}

function rowString(row: SqliteRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) return integrity();
  return value;
}

function nullableRowString(row: SqliteRow, key: string): string | null {
  return row[key] === null ? null : rowString(row, key);
}

function rowBigint(row: SqliteRow, key: string): bigint {
  const value = row[key];
  const result = typeof value === "bigint"
    ? value
    : typeof value === "number" && Number.isSafeInteger(value)
      ? BigInt(value)
      : null;
  if (result === null || result <= 0n || result > SQLITE_INT64_MAX) {
    return integrity();
  }
  return result;
}

function nullableRowBigint(row: SqliteRow, key: string): bigint | null {
  return row[key] === null ? null : rowBigint(row, key);
}

function rowInteger(row: SqliteRow, key: string): number {
  const value = row[key];
  const result = typeof value === "bigint" ? Number(value) : value;
  if (typeof result !== "number" || !Number.isSafeInteger(result)) {
    return integrity();
  }
  return result;
}

function nullableRowInteger(row: SqliteRow, key: string): number | null {
  return row[key] === null ? null : rowInteger(row, key);
}

function exactZeroOrOne(rows: SqliteRow[]): SqliteRow | null {
  if (rows.length > 1) return integrity();
  return rows[0] ?? null;
}

function parseCanonical(source: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return integrity();
  }
  if (canonicalJson(parsed) !== source) return integrity();
  return parsed;
}

function isDeeplyFrozen(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value !== "object" || value === null) return true;
  if (seen.has(value)) return true;
  seen.add(value);
  if (!Object.isFrozen(value)) return false;
  if (Array.isArray(value)) {
    return value.every((item) => isDeeplyFrozen(item, seen));
  }
  for (const nested of Object.values(value)) {
    if (!isDeeplyFrozen(nested, seen)) return false;
  }
  return true;
}

function childWithoutFingerprint(
  row: ChildEventFoldProjection,
): Omit<ChildEventFoldProjection, "fingerprint"> {
  const { fingerprint: _fingerprint, ...without } = row;
  return without;
}

function workflowWithoutFingerprint(
  row: WorkflowGenerationFoldProjection,
): Omit<WorkflowGenerationFoldProjection, "fingerprint"> {
  const { fingerprint: _fingerprint, ...without } = row;
  return without;
}

function hydrateChild(row: SqliteRow): ChildEventFoldProjection {
  const eventPosition = rowBigint(row, "event_position");
  const streamVersion = rowBigint(row, "stream_version");
  const childState = rowString(row, "child_state");
  const latestCheckpointId = nullableRowString(row, "latest_checkpoint_id");
  const latestCheckpointEventPosition = nullableRowBigint(
    row,
    "latest_checkpoint_event_position",
  );
  const terminalEventType = nullableRowString(row, "terminal_event_type");
  const terminalEventPosition = nullableRowBigint(row, "terminal_event_position");
  const reportCount = rowInteger(row, "report_count");
  const latestReportId = nullableRowString(row, "latest_report_id");
  const completionReportId = nullableRowString(row, "completion_report_id");
  const reportedReportId = nullableRowString(row, "reported_report_id");
  const reportedItemCount = nullableRowInteger(row, "reported_item_count");
  const reportedItemSetFingerprint = nullableRowString(
    row,
    "reported_item_set_fingerprint",
  );
  const previousFingerprint = nullableRowString(row, "previous_fingerprint");
  const authorityCommitment = rowString(row, "authority_commitment");
  const reportIndexFingerprint = rowString(row, "report_index_fingerprint");
  const fingerprint = rowString(row, "fingerprint");
  if (
    !CHILD_STATES.has(childState)
    || !LOWER_HASH.test(authorityCommitment)
    || !LOWER_HASH.test(reportIndexFingerprint)
    || !LOWER_HASH.test(fingerprint)
    || (previousFingerprint !== null && !LOWER_HASH.test(previousFingerprint))
    || (reportedItemSetFingerprint !== null
      && !LOWER_HASH.test(reportedItemSetFingerprint))
    || reportCount < 0
    || reportCount > 200
    || (reportedItemCount !== null
      && (reportedItemCount < 0 || reportedItemCount > 200))
    || (latestCheckpointId === null) !== (latestCheckpointEventPosition === null)
    || (terminalEventType === null) !== (terminalEventPosition === null)
    || (reportedReportId === null) !== (reportedItemCount === null)
    || (reportedReportId === null) !== (reportedItemSetFingerprint === null)
    || (reportCount === 0) !== (latestReportId === null)
    || (completionReportId !== null && reportCount === 0)
    || (streamVersion === 1n) !== (previousFingerprint === null)
    || (latestCheckpointEventPosition !== null
      && latestCheckpointEventPosition > eventPosition)
    || (terminalEventPosition !== null && terminalEventPosition > eventPosition)
    || (childState === "completed"
      ? terminalEventType !== "ChildSessionCompleted"
      : childState === "transferred"
        ? terminalEventType !== "ChildWorkTransferCreated"
        : terminalEventType !== null)
  ) {
    return integrity();
  }
  const projection: ChildEventFoldProjection = Object.freeze({
    projectId: rowString(row, "project_id"),
    childSessionId: rowString(row, "child_session_id"),
    eventPosition,
    streamVersion,
    rootSessionId: rowString(row, "root_session_id"),
    childState: childState as ChildEventFoldProjection["childState"],
    latestCheckpointId,
    latestCheckpointEventPosition,
    authorityCommitment,
    terminalEventType:
      terminalEventType as ChildEventFoldProjection["terminalEventType"],
    terminalEventPosition,
    reportCount,
    latestReportId,
    reportIndexFingerprint,
    completionReportId,
    reportedReportId,
    reportedItemCount,
    reportedItemSetFingerprint,
    previousFingerprint,
    fingerprint,
  });
  if (childEventFoldFingerprint(childWithoutFingerprint(projection)) !== fingerprint) {
    return integrity();
  }
  return projection;
}

function hydrateWorkflow(row: SqliteRow): WorkflowGenerationFoldProjection {
  const workflowGeneration = rowInteger(row, "workflow_generation");
  const triggerEventPosition = rowBigint(row, "trigger_event_position");
  const evidenceWindowState = rowString(row, "evidence_window_state");
  const replacementCheckpointVersion = nullableRowInteger(
    row,
    "replacement_checkpoint_version",
  );
  const effectiveCheckpointVersion = rowInteger(
    row,
    "effective_checkpoint_version",
  );
  const effectiveDraftSourceEventPosition = rowBigint(
    row,
    "effective_draft_source_event_position",
  );
  const fingerprintSchemaVersion = row["fingerprint_schema_version"] === undefined
    ? 1
    : rowInteger(row, "fingerprint_schema_version");
  const effectiveStateSourceEventPosition = row["effective_state_source_event_position"] === undefined
    ? null
    : nullableRowBigint(row, "effective_state_source_event_position");
  const effectiveStateVersion = row["effective_state_version"] === undefined
    ? null
    : nullableRowInteger(row, "effective_state_version");
  const effectiveStateHash = row["effective_state_hash"] === undefined
    ? null
    : nullableRowString(row, "effective_state_hash");
  const previousFingerprint = nullableRowString(row, "previous_fingerprint");
  const fingerprint = rowString(row, "fingerprint");
  if (
    workflowGeneration <= 0
    || (fingerprintSchemaVersion !== 1 && fingerprintSchemaVersion !== 2)
    || (evidenceWindowState !== "open" && evidenceWindowState !== "sealed")
    || (
      replacementCheckpointVersion !== null
      && replacementCheckpointVersion !== 1
      && replacementCheckpointVersion !== 2
    )
    || (effectiveCheckpointVersion !== 1 && effectiveCheckpointVersion !== 2)
    || (evidenceWindowState === "open" && effectiveCheckpointVersion !== 2)
    || effectiveDraftSourceEventPosition > triggerEventPosition
    || (
      replacementCheckpointVersion !== null
      && (
        replacementCheckpointVersion !== effectiveCheckpointVersion
        || effectiveDraftSourceEventPosition !== triggerEventPosition
      )
    )
    || (workflowGeneration === 1) !== (previousFingerprint === null)
    || (previousFingerprint !== null && !LOWER_HASH.test(previousFingerprint))
    || !LOWER_HASH.test(fingerprint)
    || (fingerprintSchemaVersion === 1 && (
      effectiveStateSourceEventPosition !== null
      || effectiveStateVersion !== null
      || effectiveStateHash !== null
    ))
    || (fingerprintSchemaVersion === 2 && (
      effectiveStateSourceEventPosition === null
      || effectiveStateVersion !== 1
      || effectiveStateHash === null
      || effectiveStateSourceEventPosition > triggerEventPosition
      || !LOWER_HASH.test(effectiveStateHash)
    ))
  ) {
    return integrity();
  }
  const projection: WorkflowGenerationFoldProjection = Object.freeze({
    projectId: rowString(row, "project_id"),
    workflowId: rowString(row, "workflow_id"),
    workflowGeneration,
    sessionId: rowString(row, "session_id"),
    triggerEventPosition,
    rootCommandId: rowString(row, "root_command_id"),
    evidenceWindowState,
    replacementCheckpointVersion,
    effectiveCheckpointVersion,
    effectiveDraftSourceEventPosition,
    fingerprintSchemaVersion: fingerprintSchemaVersion as 1 | 2,
    effectiveStateSourceEventPosition,
    effectiveStateVersion: effectiveStateVersion as 1 | null,
    effectiveStateHash,
    previousFingerprint,
    fingerprint,
  });
  if (
    fingerprintSchemaVersion === 1
    && workflowGenerationFingerprint(workflowWithoutFingerprint(projection))
      !== fingerprint
  ) {
    return integrity();
  }
  return projection;
}

interface DetachedProjectionCursor<T> {
  readonly visits: number;
  peek(): T | null;
  advance(): T;
  close(): void;
}

function openDetachedProjectionCursor<T>(
  connection: SqliteConnection,
  projectId: string,
  sql: string,
  hydrate: (row: SqliteRow) => T,
): DetachedProjectionCursor<T> {
  if (projectId.length === 0) return integrity();
  let iterator: IterableIterator<SqliteRow>;
  try {
    iterator = connection.prepare(sql).iterate({ $projectId: projectId });
  } catch {
    return integrity();
  }

  let lookahead: T | null = null;
  let visits = 0;
  let closed = false;
  const closeIterator = (): void => {
    const close = iterator.return;
    if (typeof close === "function") close.call(iterator);
  };
  const prime = (): void => {
    let next: IteratorResult<SqliteRow>;
    try {
      next = iterator.next();
    } catch {
      return integrity();
    }
    if (next.done === true) {
      lookahead = null;
      return;
    }
    try {
      lookahead = hydrate({ ...next.value });
    } catch (error) {
      if (error instanceof LifecycleError && error.code === "INTEGRITY_FAILURE") {
        throw error;
      }
      return integrity();
    }
  };

  try {
    prime();
  } catch (error) {
    try {
      closeIterator();
    } catch {
      // The hydration/iterator failure has precedence over close failure.
    }
    if (error instanceof LifecycleError && error.code === "INTEGRITY_FAILURE") {
      throw error;
    }
    return integrity();
  }

  return {
    get visits() { return visits; },
    peek() { return lookahead; },
    advance() {
      if (lookahead === null || closed) return integrity();
      const current = lookahead;
      prime();
      visits += 1;
      return current;
    },
    close() {
      if (closed) return;
      closed = true;
      lookahead = null;
      try {
        closeIterator();
      } catch {
        return integrity();
      }
    },
  };
}

const CHILD_COLUMNS = `
  project_id, child_session_id, event_position, stream_version,
  root_session_id, child_state, latest_checkpoint_id,
  latest_checkpoint_event_position, authority_commitment,
  terminal_event_type, terminal_event_position, report_count,
  latest_report_id, report_index_fingerprint, completion_report_id,
  reported_report_id, reported_item_count, reported_item_set_fingerprint,
  previous_fingerprint, fingerprint
`;

const WORKFLOW_COLUMNS = `
  project_id, workflow_id, workflow_generation, session_id,
  trigger_event_position, root_command_id, evidence_window_state,
  replacement_checkpoint_version, effective_checkpoint_version,
  effective_draft_source_event_position, fingerprint_schema_version,
  effective_state_source_event_position, effective_state_version,
  effective_state_hash, previous_fingerprint, fingerprint
`;

function storedEventFromRow(row: SqliteRow): StoredEvent {
  const payloadJson = rowString(row, "payload_json");
  const sourceRefs = parseCanonical(rowString(row, "source_refs_json"));
  const evidenceRefs = parseCanonical(rowString(row, "evidence_refs_json"));
  const evidenceDigests = parseCanonical(rowString(row, "evidence_digests_json"));
  const payload = parseCanonical(payloadJson);
  if (
    !Array.isArray(sourceRefs)
    || sourceRefs.some((value) => typeof value !== "string")
    || !Array.isArray(evidenceRefs)
    || !Array.isArray(evidenceDigests)
  ) {
    return integrity();
  }
  const actorRole = rowString(row, "actor_role");
  const visibilityScope = rowString(row, "visibility_scope");
  const confidence = rowString(row, "confidence");
  const verificationStatus = rowString(row, "verification_status");
  const sessionId = nullableRowString(row, "session_id");
  const parentSessionId = nullableRowString(row, "parent_session_id");
  const lifecycleIntentJson = nullableRowString(row, "lifecycle_intent_json");
  if (
    (actorRole !== "primary"
      && actorRole !== "maintenance"
      && actorRole !== "untrusted")
    || (visibilityScope !== "project"
      && visibilityScope !== "session"
      && visibilityScope !== "private")
    || (confidence !== "low" && confidence !== "medium" && confidence !== "high")
    || (
      verificationStatus !== "unverified"
      && verificationStatus !== "partially-verified"
      && verificationStatus !== "verified"
    )
    || (lifecycleIntentJson !== null
      && rowInteger(row, "command_event_index") !== 0)
  ) {
    return integrity();
  }
  const event = Object.freeze({
    globalPosition: rowBigint(row, "global_position"),
    eventId: rowString(row, "event_id"),
    projectId: rowString(row, "project_id") as StoredEvent["projectId"],
    vaultId: rowString(row, "vault_id") as StoredEvent["vaultId"],
    storeId: rowString(row, "store_id") as StoredEvent["storeId"],
    workspaceId: rowString(row, "workspace_id") as StoredEvent["workspaceId"],
    branchScopeId: nullableRowString(row, "branch_scope_id") as StoredEvent["branchScopeId"],
    branchRef: nullableRowString(row, "branch_ref"),
    streamId: rowString(row, "stream_id"),
    streamType: rowString(row, "stream_type"),
    streamVersion: rowBigint(row, "stream_version"),
    eventType: rowString(row, "event_type"),
    eventSchemaVersion: rowInteger(row, "event_schema_version"),
    sessionId,
    parentSessionId,
    actorRole,
    agentId: rowString(row, "agent_id"),
    clientInstanceId: rowString(row, "client_instance_id"),
    correlationId: rowString(row, "correlation_id"),
    causationId: nullableRowString(row, "causation_id"),
    commandId: rowString(row, "command_id"),
    idempotencyKey: rowString(row, "idempotency_key"),
    commandEventIndex: rowInteger(row, "command_event_index"),
    occurredAt: rowString(row, "occurred_at"),
    recordedAt: rowString(row, "recorded_at"),
    visibilityScope,
    confidence,
    verificationStatus,
    sourceRefs: Object.freeze(sourceRefs),
    evidenceRefs: Object.freeze(evidenceRefs) as StoredEvent["evidenceRefs"],
    evidenceDigests: Object.freeze(evidenceDigests) as StoredEvent["evidenceDigests"],
    payload: payload as StoredEvent["payload"],
    payloadJson,
    payloadHash: rowString(row, "payload_hash"),
    previousGlobalHash: rowString(row, "previous_global_hash"),
    eventHash: rowString(row, "event_hash"),
    lifecycleIntentJson,
  } as StoredEvent);
  try { assertRetainedStoredEvent(event); } catch { return integrity(); }
  return event;
}

function comparableStoredEvent(event: StoredEvent): JsonValue {
  return {
    globalPosition: event.globalPosition.toString(),
    eventId: event.eventId,
    projectId: event.projectId,
    vaultId: event.vaultId,
    storeId: event.storeId,
    workspaceId: event.workspaceId,
    branchScopeId: event.branchScopeId,
    branchRef: event.branchRef,
    streamId: event.streamId,
    streamType: event.streamType,
    streamVersion: event.streamVersion.toString(),
    eventType: event.eventType,
    eventSchemaVersion: event.eventSchemaVersion,
    sessionId: event.sessionId,
    parentSessionId: event.parentSessionId,
    actorRole: event.actorRole,
    agentId: event.agentId,
    clientInstanceId: event.clientInstanceId,
    correlationId: event.correlationId,
    causationId: event.causationId,
    commandId: event.commandId,
    idempotencyKey: event.idempotencyKey,
    commandEventIndex: event.commandEventIndex,
    occurredAt: event.occurredAt,
    recordedAt: event.recordedAt,
    visibilityScope: event.visibilityScope,
    confidence: event.confidence,
    verificationStatus: event.verificationStatus,
    sourceRefs: event.sourceRefs,
    evidenceRefs: event.evidenceRefs,
    evidenceDigests: event.evidenceDigests,
    payload: event.payload,
    payloadJson: event.payloadJson,
    payloadHash: event.payloadHash,
    previousGlobalHash: event.previousGlobalHash,
    eventHash: event.eventHash,
    lifecycleIntentJson: event.lifecycleIntentJson ?? null,
  } as unknown as JsonValue;
}

function assertPersistedEventMatches(
  committed: StoredEvent,
  persisted: StoredEvent,
): void {
  if (
    canonicalJson(comparableStoredEvent(committed))
      !== canonicalJson(comparableStoredEvent(persisted))
  ) {
    integrity();
  }
}

const EVENT_COLUMNS = `
  global_position, event_id, project_id, vault_id, store_id, workspace_id,
  branch_scope_id, branch_ref, stream_id, stream_type, stream_version,
  event_type, event_schema_version, session_id, parent_session_id,
  actor_role, agent_id, client_instance_id, correlation_id, causation_id,
  command_id, idempotency_key, command_event_index, occurred_at, recorded_at,
  visibility_scope, confidence, verification_status, source_refs_json,
  evidence_refs_json, evidence_digests_json, payload_json, payload_hash,
  previous_global_hash, event_hash, lifecycle_intent_json
`;

function decodeStoredLifecycleEvent(
  event: StoredEvent,
  authorityCommitment: string,
): LifecycleEventCodecResult {
  try {
    return decodeLifecycleEvent({
      eventSchemaVersion: event.eventSchemaVersion,
      eventId: event.eventId,
      projectId: event.projectId,
      vaultId: event.vaultId,
      storeId: event.storeId,
      workspaceId: event.workspaceId,
      streamId: event.streamId,
      streamVersion: event.streamVersion.toString(),
      globalPosition: event.globalPosition.toString(),
      sessionId: event.sessionId,
      parentSessionId: event.parentSessionId,
      eventType: event.eventType,
      correlationId: event.correlationId,
      causationId: event.causationId,
      commandId: event.commandId,
      idempotencyKey: event.idempotencyKey,
      occurredAt: event.occurredAt,
      authorityCommitment,
      payload: event.payload,
    });
  } catch {
    return integrity();
  }
}

function reportIdFor(event: StoredEvent): string | null {
  if (!REPORT_CONSUMER_TYPES.has(event.eventType)) return null;
  const payload = record(event.payload);
  const candidate = event.eventType === "ChildWorkDispositioned"
    ? record(payload.disposition).reportId
    : payload.reportId;
  if (typeof candidate !== "string" || candidate.length === 0) return integrity();
  return candidate;
}

function assertCommittedBatch<T extends JsonValue>(
  committed: EventAppendBatch<T>,
): readonly StoredEvent[] {
  if (!isDeeplyFrozen(committed) || committed.events.length === 0) {
    return integrity();
  }
  const sorted = [...committed.events].sort((left, right) =>
    left.globalPosition < right.globalPosition
      ? -1
      : left.globalPosition > right.globalPosition
        ? 1
        : 0);
  const first = sorted[0]!;
  const last = sorted.at(-1)!;
  if (
    committed.storedResponse.firstGlobalPosition !== first.globalPosition.toString()
    || committed.storedResponse.lastGlobalPosition !== last.globalPosition.toString()
    || committed.storedResponse.finalStreamVersion !== last.streamVersion.toString()
    || committed.storedResponse.eventIds.length !== sorted.length
    || sorted.some(
      (event, index) =>
        event.globalPosition <= 0n
        || event.globalPosition > SQLITE_INT64_MAX
        || event.streamVersion <= 0n
        || event.streamVersion > SQLITE_INT64_MAX
        || event.projectId !== first.projectId
        || event.vaultId !== first.vaultId
        || event.storeId !== first.storeId
        || event.workspaceId !== first.workspaceId
        || event.commandId !== first.commandId
        || event.idempotencyKey !== first.idempotencyKey
        || event.commandEventIndex !== index
        || committed.storedResponse.eventIds[index] !== event.eventId
        || (index > 0
          && event.globalPosition !== sorted[index - 1]!.globalPosition + 1n)
        || (index > 0
          && event.streamVersion !== sorted[index - 1]!.streamVersion + 1n)
        || (event.commandEventIndex !== 0 && event.lifecycleIntentJson != null),
    )
  ) {
    return integrity();
  }
  return Object.freeze(sorted);
}

export class SqliteLifecycleProjectionRepository
implements LifecycleProjectionWriter {
  readonly #connection: SqliteConnection;

  constructor(connection: SqliteConnection) {
    this.#connection = connection;
  }

  append<T extends JsonValue>(
    committed: EventAppendBatch<T>,
    transaction: LifecycleCommandTransaction,
  ): void {
    try {
      if (typeof transaction !== "object" || transaction === null) integrity();
      for (const event of assertCommittedBatch(committed)) {
        assertPersistedEventMatches(event, this.#eventAt(event.globalPosition));
        const child = classifyChildProjectionEvent(event);
        if (child === "child-only" || child === "dual-scope-child") {
          this.#appendChild(event);
        }
        const workflow = classifyWorkflowProjectionEvent(event);
        if (workflow.kind === "identified") this.#appendWorkflow(event, workflow);
      }
    } catch (error) {
      if (error instanceof LifecycleError && error.code === "INTEGRITY_FAILURE") {
        throw error;
      }
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
  }

  findChildAtEvent(
    projectId: string,
    childSessionId: string,
    eventPosition: bigint,
  ): ChildEventFoldProjection | null {
    try {
      if (eventPosition <= 0n || eventPosition > SQLITE_INT64_MAX) integrity();
      const row = exactZeroOrOne(this.#connection.prepare(`
        SELECT ${CHILD_COLUMNS}
        FROM lifecycle_child_event_folds
        WHERE project_id = $projectId
          AND child_session_id = $childSessionId
          AND event_position = $eventPosition
        LIMIT 2
      `).all({ $projectId: projectId, $childSessionId: childSessionId, $eventPosition: eventPosition }));
      return row === null ? null : hydrateChild(row);
    } catch (error) {
      if (error instanceof LifecycleError && error.code === "INTEGRITY_FAILURE") {
        throw error;
      }
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
  }

  findChildByStreamVersion(
    projectId: string,
    childSessionId: string,
    streamVersion: bigint,
  ): ChildEventFoldProjection | null {
    try {
      if (streamVersion <= 0n || streamVersion > SQLITE_INT64_MAX) integrity();
      const row = exactZeroOrOne(this.#connection.prepare(`
        SELECT ${CHILD_COLUMNS}
        FROM lifecycle_child_event_folds
        WHERE project_id = $projectId
          AND child_session_id = $childSessionId
          AND stream_version = $streamVersion
        LIMIT 2
      `).all({ $projectId: projectId, $childSessionId: childSessionId, $streamVersion: streamVersion }));
      return row === null ? null : hydrateChild(row);
    } catch (error) {
      if (error instanceof LifecycleError && error.code === "INTEGRITY_FAILURE") {
        throw error;
      }
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
  }

  findReportWitness(
    projectId: string,
    childSessionId: string,
    reportId: string,
  ): ChildEventFoldProjection | null {
    try {
      if (reportId.length === 0) integrity();
      const row = exactZeroOrOne(this.#connection.prepare(`
        SELECT ${CHILD_COLUMNS}
        FROM lifecycle_child_event_folds
        WHERE project_id = $projectId
          AND child_session_id = $childSessionId
          AND reported_report_id = $reportId
        LIMIT 2
      `).all({ $projectId: projectId, $childSessionId: childSessionId, $reportId: reportId }));
      return row === null ? null : hydrateChild(row);
    } catch (error) {
      if (error instanceof LifecycleError && error.code === "INTEGRITY_FAILURE") {
        throw error;
      }
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
  }

  findWorkflowGeneration(
    projectId: string,
    workflowId: string,
    workflowGeneration: number,
  ): WorkflowGenerationFoldProjection | null {
    try {
      if (!Number.isSafeInteger(workflowGeneration) || workflowGeneration <= 0) {
        integrity();
      }
      const projection = this.#workflowGenerationRow(
        projectId,
        workflowId,
        workflowGeneration,
      );
      return projection === null ? null : this.#verifyWorkflowHydration(projection);
    } catch (error) {
      if (error instanceof LifecycleError && error.code === "INTEGRITY_FAILURE") {
        throw error;
      }
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
  }

  findWorkflowPredecessor(
    projectId: string,
    workflowId: string,
    workflowGeneration: number,
  ): WorkflowGenerationFoldProjection | null {
    if (!Number.isSafeInteger(workflowGeneration) || workflowGeneration <= 0) {
      return integrity();
    }
    return workflowGeneration === 1
      ? null
      : this.findWorkflowGeneration(
          projectId,
          workflowId,
          workflowGeneration - 1,
        );
  }

  #eventAt(globalPosition: bigint): StoredEvent {
    const row = exactZeroOrOne(this.#connection.prepare(`
      SELECT ${EVENT_COLUMNS}
      FROM events
      WHERE global_position = $globalPosition
      LIMIT 2
    `).all({ $globalPosition: globalPosition }));
    return row === null ? integrity() : storedEventFromRow(row);
  }

  #workflowGenerationRow(
    projectId: string,
    workflowId: string,
    workflowGeneration: number,
  ): WorkflowGenerationFoldProjection | null {
    const row = exactZeroOrOne(this.#connection.prepare(`
      SELECT ${WORKFLOW_COLUMNS}
      FROM lifecycle_workflow_generation_folds
      WHERE project_id = $projectId
        AND workflow_id = $workflowId
        AND workflow_generation = $workflowGeneration
      LIMIT 2
    `).all({
      $projectId: projectId,
      $workflowId: workflowId,
      $workflowGeneration: BigInt(workflowGeneration),
    }));
    return row === null ? null : hydrateWorkflow(row);
  }

  #verifyWorkflowHydration(
    projection: WorkflowGenerationFoldProjection,
  ): WorkflowGenerationFoldProjection {
    if (projection.fingerprintSchemaVersion === 1) return projection;
    const trigger = this.#eventAt(projection.triggerEventPosition);
    const predecessor = projection.workflowGeneration === 1
      ? null
      : this.#workflowGenerationRow(
          projection.projectId,
          projection.workflowId,
          projection.workflowGeneration - 1,
        );
    if (
      trigger.projectId !== projection.projectId
      || trigger.sessionId !== projection.sessionId
      || trigger.commandId !== projection.rootCommandId
      || trigger.eventSchemaVersion !== 3
      || trigger.eventHash.length !== 64
      || !LOWER_HASH.test(trigger.eventHash)
      || (projection.workflowGeneration === 1) !== (predecessor === null)
      || (predecessor !== null && (
        predecessor.sessionId !== projection.sessionId
        || predecessor.triggerEventPosition >= projection.triggerEventPosition
        || projection.previousFingerprint !== predecessor.fingerprint
      ))
      || workflowFingerprintV2({
        ...workflowWithoutFingerprint(projection),
        triggerEventHash: trigger.eventHash,
        previousFingerprintSchemaVersion: predecessor?.fingerprintSchemaVersion ?? null,
      }) !== projection.fingerprint
    ) integrity();
    return projection;
  }

  #intentFor(event: StoredEvent): LifecycleIntentWitnessV1 {
    let source: string;
    if (event.commandEventIndex === 0) {
      if (event.lifecycleIntentJson === null || event.lifecycleIntentJson === undefined) {
        return integrity();
      }
      source = event.lifecycleIntentJson;
    } else {
      const row = exactZeroOrOne(this.#connection.prepare(`
        SELECT ${EVENT_COLUMNS}
        FROM events
        WHERE project_id = $projectId
          AND command_id = $commandId
          AND command_event_index = 0
        LIMIT 2
      `).all({ $projectId: event.projectId, $commandId: event.commandId }));
      if (row === null) return integrity();
      const commandEventZero = storedEventFromRow(row);
      if (
        commandEventZero.commandEventIndex !== 0
        || commandEventZero.globalPosition > event.globalPosition
        || commandEventZero.projectId !== event.projectId
        || commandEventZero.vaultId !== event.vaultId
        || commandEventZero.storeId !== event.storeId
        || commandEventZero.workspaceId !== event.workspaceId
        || commandEventZero.streamId !== event.streamId
        || commandEventZero.sessionId !== event.sessionId
        || commandEventZero.commandId !== event.commandId
        || commandEventZero.idempotencyKey !== event.idempotencyKey
        || commandEventZero.lifecycleIntentJson === null
        || commandEventZero.lifecycleIntentJson === undefined
      ) {
        return integrity();
      }
      source = commandEventZero.lifecycleIntentJson;
    }
    try {
      return decodeLifecycleIntentWitness(source);
    } catch {
      return integrity();
    }
  }

  #assertReportWitness(
    event: StoredEvent,
    witness: ChildEventFoldProjection,
    reportId: string,
  ): void {
    if (
      witness.projectId !== event.projectId
      || witness.childSessionId !== event.sessionId
      || witness.reportedReportId !== reportId
      || witness.reportedItemCount === null
      || witness.reportedItemSetFingerprint === null
      || witness.eventPosition >= event.globalPosition
      || witness.streamVersion >= event.streamVersion
    ) {
      integrity();
    }
    const source = this.#eventAt(witness.eventPosition);
    if (
      source.projectId !== witness.projectId
      || source.sessionId !== witness.childSessionId
      || source.streamVersion !== witness.streamVersion
      || source.eventType !== "ChildWorkReported"
    ) {
      integrity();
    }
    const decoded = decodeStoredLifecycleEvent(source, witness.authorityCommitment);
    if (decoded.eventType !== "ChildWorkReported") integrity();
    const report = decoded.payload.report;
    if (
      report.reportId !== reportId
      || report.allReportItemIds.length !== witness.reportedItemCount
      || reportItemSetFingerprint({
        projectId: witness.projectId,
        childSessionId: witness.childSessionId,
        reportId,
        allReportItemIds: report.allReportItemIds,
      }) !== witness.reportedItemSetFingerprint
    ) {
      integrity();
    }
  }

  #appendChild(event: StoredEvent): void {
    if (
      event.sessionId === null
      || event.streamType !== "session"
      || event.streamId !== `session/${event.sessionId}`
    ) {
      integrity();
    }
    const previous = event.streamVersion === 1n
      ? null
      : this.findChildByStreamVersion(
          event.projectId,
          event.sessionId,
          event.streamVersion - 1n,
        );
    if ((event.streamVersion === 1n) !== (previous === null)) integrity();
    const reportId = reportIdFor(event);
    const reportWitness = reportId === null
      ? null
      : this.findReportWitness(event.projectId, event.sessionId, reportId);
    if (reportId !== null) {
      if (reportWitness === null) integrity();
      this.#assertReportWitness(event, reportWitness, reportId);
    }
    let projection: ChildEventFoldProjection;
    try {
      projection = foldChildEventProjection(previous, event, reportWitness);
    } catch {
      return integrity();
    }
    const result = this.#connection.prepare(`
      INSERT INTO lifecycle_child_event_folds(
        project_id, child_session_id, event_position, stream_version,
        root_session_id, child_state, latest_checkpoint_id,
        latest_checkpoint_event_position, authority_commitment,
        terminal_event_type, terminal_event_position, report_count,
        latest_report_id, report_index_fingerprint, completion_report_id,
        reported_report_id, reported_item_count, reported_item_set_fingerprint,
        previous_fingerprint, fingerprint
      ) VALUES (
        $projectId, $childSessionId, $eventPosition, $streamVersion,
        $rootSessionId, $childState, $latestCheckpointId,
        $latestCheckpointEventPosition, $authorityCommitment,
        $terminalEventType, $terminalEventPosition, $reportCount,
        $latestReportId, $reportIndexFingerprint, $completionReportId,
        $reportedReportId, $reportedItemCount, $reportedItemSetFingerprint,
        $previousFingerprint, $fingerprint
      )
    `).run({
      $projectId: projection.projectId,
      $childSessionId: projection.childSessionId,
      $eventPosition: projection.eventPosition,
      $streamVersion: projection.streamVersion,
      $rootSessionId: projection.rootSessionId,
      $childState: projection.childState,
      $latestCheckpointId: projection.latestCheckpointId,
      $latestCheckpointEventPosition: projection.latestCheckpointEventPosition,
      $authorityCommitment: projection.authorityCommitment,
      $terminalEventType: projection.terminalEventType,
      $terminalEventPosition: projection.terminalEventPosition,
      $reportCount: BigInt(projection.reportCount),
      $latestReportId: projection.latestReportId,
      $reportIndexFingerprint: projection.reportIndexFingerprint,
      $completionReportId: projection.completionReportId,
      $reportedReportId: projection.reportedReportId,
      $reportedItemCount: projection.reportedItemCount === null
        ? null
        : BigInt(projection.reportedItemCount),
      $reportedItemSetFingerprint: projection.reportedItemSetFingerprint,
      $previousFingerprint: projection.previousFingerprint,
      $fingerprint: projection.fingerprint,
    } satisfies SqliteParams);
    if (result.changes !== 1n) integrity();
  }

  #assertWorkflowSource(
    trigger: StoredEvent,
    projection: WorkflowGenerationFoldProjection,
  ): void {
    const source = this.#eventAt(projection.effectiveDraftSourceEventPosition);
    if (
      source.projectId !== projection.projectId
      || source.sessionId !== projection.sessionId
      || source.parentSessionId !== null
      || source.streamType !== "session"
      || source.streamId !== `session/${projection.sessionId}`
      || (source.eventType !== "SessionEndRequested"
        && source.eventType !== "SessionEndAmended")
      || source.globalPosition > trigger.globalPosition
    ) {
      integrity();
    }
    const sourcePayload = record(source.payload);
    const sourceAuthority = typeof sourcePayload.authorityCommitment === "string"
      ? sourcePayload.authorityCommitment
      : "0".repeat(64);
    const decoded = decodeStoredLifecycleEvent(source, sourceAuthority);
    const sourceIntent = this.#intentFor(source);
    const command = record(sourceIntent.intent.command);
    let checkpoint: unknown;
    if (
      decoded.eventType === "SessionEndRequested"
      && command.commandType === "request-session-end"
    ) {
      checkpoint = record(record(command.request).finalCheckpoint).checkpointVersion;
    } else if (
      decoded.eventType === "SessionEndAmended"
      && command.commandType === "amend-session-end"
    ) {
      checkpoint = record(record(command.amendment).finalCheckpoint).checkpointVersion;
    } else {
      return integrity();
    }
    const payload = record(source.payload);
    if (
      payload.workflowId !== projection.workflowId
      || checkpoint !== projection.effectiveCheckpointVersion
    ) {
      integrity();
    }
  }

  #appendWorkflow(
    event: StoredEvent,
    identity: {
      readonly workflowId: string;
      readonly workflowGeneration: number;
    },
  ): void {
    if (
      event.parentSessionId !== null
      || event.sessionId === null
      || event.streamType !== "session"
      || event.streamId !== `session/${event.sessionId}`
    ) {
      integrity();
    }
    const previous = this.findWorkflowPredecessor(
      event.projectId,
      identity.workflowId,
      identity.workflowGeneration,
    );
    if ((identity.workflowGeneration === 1) !== (previous === null)) integrity();
    const intent = this.#intentFor(event);
    let projection: WorkflowGenerationFoldProjection;
    try {
      projection = foldWorkflowGenerationProjection(
        previous,
        event,
        intent,
        "live-schema-3",
      );
    } catch {
      return integrity();
    }
    if (
      projection.workflowId !== identity.workflowId
      || projection.workflowGeneration !== identity.workflowGeneration
      || projection.projectId !== event.projectId
      || projection.sessionId !== event.sessionId
      || projection.triggerEventPosition !== event.globalPosition
      || projection.rootCommandId !== event.commandId
    ) {
      integrity();
    }
    this.#assertWorkflowSource(event, projection);
    const result = this.#connection.prepare(`
      INSERT INTO lifecycle_workflow_generation_folds(
        project_id, workflow_id, workflow_generation, session_id,
        trigger_event_position, root_command_id, evidence_window_state,
        replacement_checkpoint_version, effective_checkpoint_version,
        effective_draft_source_event_position, fingerprint_schema_version,
        effective_state_source_event_position, effective_state_version,
        effective_state_hash, previous_fingerprint, fingerprint
      ) VALUES (
        $projectId, $workflowId, $workflowGeneration, $sessionId,
        $triggerEventPosition, $rootCommandId, $evidenceWindowState,
        $replacementCheckpointVersion, $effectiveCheckpointVersion,
        $effectiveDraftSourceEventPosition, $fingerprintSchemaVersion,
        $effectiveStateSourceEventPosition, $effectiveStateVersion,
        $effectiveStateHash, $previousFingerprint, $fingerprint
      )
    `).run({
      $projectId: projection.projectId,
      $workflowId: projection.workflowId,
      $workflowGeneration: BigInt(projection.workflowGeneration),
      $sessionId: projection.sessionId,
      $triggerEventPosition: projection.triggerEventPosition,
      $rootCommandId: projection.rootCommandId,
      $evidenceWindowState: projection.evidenceWindowState,
      $replacementCheckpointVersion: projection.replacementCheckpointVersion,
      $effectiveCheckpointVersion: projection.effectiveCheckpointVersion,
      $effectiveDraftSourceEventPosition:
        projection.effectiveDraftSourceEventPosition,
      $fingerprintSchemaVersion: BigInt(projection.fingerprintSchemaVersion),
      $effectiveStateSourceEventPosition:
        projection.effectiveStateSourceEventPosition,
      $effectiveStateVersion: projection.effectiveStateVersion === null
        ? null
        : BigInt(projection.effectiveStateVersion),
      $effectiveStateHash: projection.effectiveStateHash,
      $previousFingerprint: projection.previousFingerprint,
      $fingerprint: projection.fingerprint,
    });
    if (result.changes !== 1n) integrity();
  }
}
