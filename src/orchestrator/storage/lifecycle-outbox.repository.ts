import type { StoredEvent } from "../contracts/event.js";
import { outboxHash, payloadHash } from "../crypto/event-hash.js";
import type { ProjectId } from "../identity/contracts.js";
import { LifecycleError } from "../lifecycle/errors.js";
import {
  NO_LIFECYCLE_FAULTS,
  type LifecycleFaultInjector,
} from "../lifecycle/lifecycle-faults.js";
import {
  decodeLifecycleEventPayload,
  type LifecycleEventType,
} from "../lifecycle/contracts/events.js";
import {
  COMPATIBILITY_SESSION_LOG_ARTIFACT_KIND,
  decodeKeyedFingerprintV1,
  decodeLifecycleMaterializationPayloadV1,
  decodePendingLifecycleOutboxV1,
  type ExactPlannedRevisionQuery,
  type KeyedFingerprintV1,
  type LifecycleMaterializationPayloadV1,
  type LifecycleOutboxPlannedRevision,
  type PendingLifecycleOutboxV1,
} from "../lifecycle/materialization-queue.port.js";
import {
  parseCanonicalTimestamp,
  parseCanonicalUuid,
  type SessionId,
} from "../lifecycle/contracts/identifiers.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import type {
  LifecycleOutboxClaimNextInputV1,
  LifecycleOutboxAcknowledgementInputV1,
  LifecycleOutboxExactClaimInputV1,
  LifecycleOutboxCompletionQueryV1,
  LifecycleOutboxFailureInputV1,
  LifecycleOutboxMaterializationResultV1,
  LifecycleOutboxRenewInputV1,
  LifecycleOutboxClaimV1,
  LifecycleOutboxStorageRecord,
  LifecycleOutboxStatus,
} from "./lifecycle-storage.types.js";
import type { SqliteConnection, SqliteParams, SqliteRow } from "./sqlite-driver.js";

const LOWER_HASH = /^[0-9a-f]{64}$/u;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/u;
const MAX_SQLITE_INT64 = 9_223_372_036_854_775_807n;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000n;
const FAILURE_BACKOFF_BASE_MS = 1_000n;
const FAILURE_BACKOFF_MAX_MS = 60_000n;
const MAX_RECURSION = 1_024;
const LIFECYCLE_OUTBOX_KIND = "materialize-lifecycle-log";
const LIFECYCLE_TRIGGER_TYPES = new Set([
  "SessionCheckpointRecorded",
  "SessionEndAmended",
  "SessionEndVerificationFailed",
  "SessionEndVerificationInvalidated",
  "SessionEndCancelled",
  "SessionAbandoned",
  "SessionEnded",
] as const);

function integrity(): never {
  throw new LifecycleError("INTEGRITY_FAILURE");
}

function integrityBoundary<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof LifecycleError && error.code === "INTEGRITY_FAILURE") {
      throw error;
    }
    throw new LifecycleError("INTEGRITY_FAILURE");
  }
}

function stringValue(value: unknown, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) integrity();
  return value;
}

function nullableString(value: unknown): string | null {
  return value === null ? null : stringValue(value);
}

function hashValue(value: unknown): string {
  const result = stringValue(value);
  if (!LOWER_HASH.test(result)) integrity();
  return result;
}

function integerValue(value: unknown): bigint {
  let result: bigint;
  if (typeof value === "bigint") {
    result = value;
  } else if (typeof value === "number" && Number.isSafeInteger(value)) {
    result = BigInt(value);
  } else if (typeof value === "string" && POSITIVE_DECIMAL.test(value)) {
    result = BigInt(value);
  } else {
    integrity();
  }
  if (result < 0n || result > MAX_SQLITE_INT64) integrity();
  return result;
}

function positiveIntegerValue(value: unknown): bigint {
  const result = integerValue(value);
  if (result <= 0n) integrity();
  return result;
}

function inputFailure(): never {
  throw new LifecycleError("LIFECYCLE_INPUT_INVALID");
}

function ownerValue(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) inputFailure();
  return value;
}

function targetKeyValue(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024) inputFailure();
  return value;
}

function revisionInput(value: unknown): bigint {
  if (
    typeof value !== "bigint"
    || value < 1n
    || value > MAX_SQLITE_INT64
  ) inputFailure();
  return value;
}

function claimTokenInput(value: unknown): bigint {
  return revisionInput(value);
}

function timestampInput(value: unknown, field: string): string {
  if (typeof value !== "string") inputFailure();
  try {
    parseCanonicalTimestamp(value, field);
  } catch {
    inputFailure();
  }
  return value;
}

function safeErrorCodeInput(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) inputFailure();
  return value;
}

function timeFromMs(value: unknown, field: string): string {
  if (
    typeof value !== "bigint"
    || value < 0n
    || value > MAX_TIMESTAMP_MS
    || value > MAX_SQLITE_INT64
  ) inputFailure();
  try {
    return new Date(Number(value)).toISOString();
  } catch {
    inputFailure();
  }
}

function leaseUntil(observedNowMs: unknown, leaseDurationMs: unknown): string {
  if (typeof observedNowMs !== "bigint" || typeof leaseDurationMs !== "bigint") inputFailure();
  if (leaseDurationMs <= 0n || leaseDurationMs > MAX_SQLITE_INT64) inputFailure();
  timeFromMs(observedNowMs, "observedNowMs");
  const observed = observedNowMs;
  const expires = observed + leaseDurationMs;
  if (expires > MAX_TIMESTAMP_MS || expires > MAX_SQLITE_INT64) inputFailure();
  return timeFromMs(expires, "leaseExpiresAt");
}

function retryAt(observedNowMs: bigint, attemptCount: bigint): string {
  if (attemptCount <= 0n) inputFailure();
  const exponent = attemptCount > 7n ? 6n : attemptCount - 1n;
  const uncapped = FAILURE_BACKOFF_BASE_MS << exponent;
  const delay = uncapped > FAILURE_BACKOFF_MAX_MS ? FAILURE_BACKOFF_MAX_MS : uncapped;
  return timeFromMs(observedNowMs + delay, "nextAttemptAt");
}

function nullableIntegerValue(value: unknown): bigint | null {
  return value === null ? null : integerValue(value);
}

function safeNumber(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) integrity();
  return result;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) integrity();
  return value as Record<string, unknown>;
}

function canonicalPayload(value: string): {
  readonly payload: LifecycleMaterializationPayloadV1;
  readonly payloadJson: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
    if (canonicalJson(parsed) !== value) integrity();
  } catch {
    integrity();
  }
  const payload = decodeLifecycleMaterializationPayloadV1(parsed);
  return { payload, payloadJson: value };
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function rowField(row: SqliteRow, field: string): unknown {
  return row[field];
}

function decodeStorageRow(row: SqliteRow): LifecycleOutboxStorageRecord {
  const kind = stringValue(rowField(row, "kind"));
  if (kind !== LIFECYCLE_OUTBOX_KIND) integrity();
  const status = stringValue(rowField(row, "status"));
  if (
    status !== "pending"
    && status !== "claimed"
    && status !== "completed"
    && status !== "failed"
  ) integrity();
  const originKind = stringValue(rowField(row, "origin_kind"));
  if (originKind !== "workflow" && originKind !== "terminal-event") integrity();
  const artifactKind = stringValue(rowField(row, "artifact_kind"));
  if (artifactKind !== COMPATIBILITY_SESSION_LOG_ARTIFACT_KIND) integrity();
  const fingerprintAlgorithm = stringValue(rowField(row, "fingerprint_algorithm"));
  if (fingerprintAlgorithm !== "hmac-sha256") integrity();
  const fingerprintDomain = stringValue(rowField(row, "fingerprint_domain"));
  if (fingerprintDomain !== "pm-materialization-fingerprint-v1") integrity();
  const failureClass = nullableString(rowField(row, "failure_class"));
  if (failureClass !== null && failureClass !== "retryable" && failureClass !== "permanent") {
    integrity();
  }
  const workflowId = nullableString(rowField(row, "workflow_id"));
  if (originKind === "workflow") {
    try {
      parseCanonicalUuid(workflowId, "outbox.workflowId");
    } catch {
      integrity();
    }
  } else if (workflowId !== null || rowField(row, "workflow_generation") !== null) {
    integrity();
  }
  const workflowGeneration = nullableIntegerValue(rowField(row, "workflow_generation"));
  if (originKind === "workflow" && (workflowGeneration === null || workflowGeneration <= 0n)) {
    integrity();
  }
  const fingerprintSchemaVersion = positiveIntegerValue(
    rowField(row, "fingerprint_schema_version"),
  );
  if (fingerprintSchemaVersion !== 1n) integrity();
  const claimOwner = nullableString(rowField(row, "claim_owner"));
  const claimToken = nullableIntegerValue(rowField(row, "claim_token"));
  const claimExpiresAt = nullableString(rowField(row, "claim_expires_at"));
  const safeErrorCode = nullableString(rowField(row, "safe_error_code"));
  const nextAttemptAt = nullableString(rowField(row, "next_attempt_at"));
  const attemptCount = integerValue(rowField(row, "attempt_count"));
  const createdAt = stringValue(rowField(row, "created_at"));
  const updatedAt = stringValue(rowField(row, "updated_at"));
  try {
    parseCanonicalTimestamp(createdAt, "outbox.createdAt");
    parseCanonicalTimestamp(updatedAt, "outbox.updatedAt");
    if (claimExpiresAt !== null) parseCanonicalTimestamp(claimExpiresAt, "outbox.claimExpiresAt");
    if (nextAttemptAt !== null) parseCanonicalTimestamp(nextAttemptAt, "outbox.nextAttemptAt");
  } catch {
    integrity();
  }
  if (attemptCount < 0n) integrity();
  if (status === "pending") {
    if (
      attemptCount !== 0n
      || claimOwner !== null
      || claimToken !== null
      || claimExpiresAt !== null
      || failureClass !== null
      || safeErrorCode !== null
      || nextAttemptAt !== null
    ) integrity();
  } else if (status === "claimed") {
    if (
      attemptCount <= 0n
      || claimOwner === null
      || claimToken === null
      || claimToken <= 0n
      || claimToken > attemptCount
      || claimExpiresAt === null
      || failureClass !== null
      || safeErrorCode !== null
      || nextAttemptAt !== null
    ) integrity();
  } else if (status === "completed") {
    if (
      attemptCount <= 0n
      || claimOwner === null
      || claimToken === null
      || claimToken <= 0n
      || claimToken > attemptCount
      || claimExpiresAt !== null
      || failureClass !== null
      || safeErrorCode !== null
      || nextAttemptAt !== null
    ) integrity();
  } else if (
    attemptCount <= 0n
    || claimOwner !== null
    || claimToken !== null
    || claimExpiresAt !== null
    || failureClass === null
    || safeErrorCode === null
    || (failureClass === "retryable" && nextAttemptAt === null)
    || (failureClass === "permanent" && nextAttemptAt !== null)
  ) {
    integrity();
  }
  const expectedPriorFingerprint = rowField(row, "expected_prior_fingerprint") === null
    ? null
    : hashValue(rowField(row, "expected_prior_fingerprint"));
  const workflowGenerationValue = workflowGeneration;
  return Object.freeze({
    projectId: stringValue(rowField(row, "project_id")),
    targetKey: stringValue(rowField(row, "target_key")),
    eventPosition: positiveIntegerValue(rowField(row, "event_position")),
    kind: "materialize-lifecycle-log",
    payloadJson: stringValue(rowField(row, "payload_json")),
    contentHash: hashValue(rowField(row, "content_hash")),
    status: status as LifecycleOutboxStatus,
    attemptCount,
    claimOwner,
    claimToken,
    claimExpiresAt,
    createdAt,
    updatedAt,
    sessionId: stringValue(rowField(row, "session_id")),
    originKind: originKind as LifecycleOutboxStorageRecord["originKind"],
    workflowId,
    workflowGeneration: workflowGenerationValue,
    artifactKind: artifactKind as "compatibility-session-log",
    artifactPath: stringValue(rowField(row, "artifact_path")),
    materializationRevision: positiveIntegerValue(rowField(row, "materialization_revision")),
    expectedPriorFingerprint,
    nextFingerprint: hashValue(rowField(row, "next_fingerprint")),
    fingerprintAlgorithm: fingerprintAlgorithm as "hmac-sha256",
    fingerprintSchemaVersion,
    fingerprintKeyId: stringValue(rowField(row, "fingerprint_key_id")),
    fingerprintDomain: fingerprintDomain as "pm-materialization-fingerprint-v1",
    failureClass: failureClass as LifecycleOutboxStorageRecord["failureClass"],
    safeErrorCode,
    nextAttemptAt,
  });
}

interface TriggerRow {
  readonly eventId: string;
  readonly eventType: string;
  readonly eventSchemaVersion: bigint;
  readonly streamVersion: bigint;
  readonly payloadJson: string;
  readonly payloadHash: string;
  readonly commandEventIndex: bigint;
  readonly sessionId: string | null;
  readonly parentSessionId: string | null;
  readonly streamType: string;
  readonly streamId: string;
  readonly occurredAt?: string;
}

function decodeTriggerRow(row: SqliteRow): TriggerRow {
  const eventId = stringValue(rowField(row, "event_id"));
  try {
    parseCanonicalUuid(eventId, "trigger.eventId");
  } catch {
    integrity();
  }
  const streamVersion = positiveIntegerValue(rowField(row, "stream_version"));
  const parentSessionId = rowField(row, "parent_session_id") === null
    ? null
    : stringValue(rowField(row, "parent_session_id"));
  if (parentSessionId !== null) integrity();
  return Object.freeze({
    eventId,
    eventType: stringValue(rowField(row, "event_type")),
    eventSchemaVersion: integerValue(rowField(row, "event_schema_version")),
    streamVersion,
    payloadJson: stringValue(rowField(row, "payload_json")),
    payloadHash: hashValue(rowField(row, "payload_hash")),
    commandEventIndex: integerValue(rowField(row, "command_event_index")),
    sessionId: rowField(row, "session_id") === null
      ? null
      : stringValue(rowField(row, "session_id")),
    parentSessionId,
    streamType: stringValue(rowField(row, "stream_type")),
    streamId: stringValue(rowField(row, "stream_id")),
    ...(rowField(row, "occurred_at") === undefined
      ? {}
      : { occurredAt: stringValue(rowField(row, "occurred_at")) }),
  });
}

function readTriggerRow(
  connection: SqliteConnection,
  projectId: string,
  eventPosition: bigint,
): TriggerRow {
  const rows = connection.prepare(`
    SELECT event_id, event_type, event_schema_version, stream_version,
           payload_json, payload_hash, command_event_index, session_id,
           parent_session_id, stream_type, stream_id, occurred_at
    FROM events
    WHERE project_id = $projectId AND global_position = $eventPosition
  `).all({
    $projectId: projectId,
    $eventPosition: eventPosition,
  });
  if (rows.length !== 1) integrity();
  return decodeTriggerRow(rows[0]!);
}

function parsePayloadObject(payloadJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(payloadJson) as unknown;
    if (canonicalJson(parsed) !== payloadJson) integrity();
    return jsonRecord(parsed);
  } catch {
    integrity();
  }
}

function assertTriggerBinding(
  connection: SqliteConnection,
  projectId: string,
  eventPosition: bigint,
  payload: LifecycleMaterializationPayloadV1,
  trigger: TriggerRow,
): void {
  if (
    !LIFECYCLE_TRIGGER_TYPES.has(payload.triggeringEventType as never)
    || trigger.eventType !== payload.triggeringEventType
    || trigger.commandEventIndex !== 0n
    || trigger.sessionId !== payload.sessionId
    || trigger.parentSessionId !== null
    || trigger.streamType !== "session"
    || trigger.streamId !== `session/${payload.sessionId}`
    || trigger.payloadHash !== payload.triggeringPayloadHash
  ) integrity();
  let eventPayload: Record<string, unknown>;
  try {
    eventPayload = parsePayloadObject(trigger.payloadJson);
    if (payloadHash(eventPayload) !== trigger.payloadHash) integrity();
  } catch {
    integrity();
  }
  const expectedSchemaVersion = payload.triggeringEventType === "SessionCheckpointRecorded"
    ? 3
    : (payload.triggeringEventType === "SessionEndAmended"
      || payload.triggeringEventType === "SessionEndCancelled" ? 3 : 1);
  if (trigger.eventSchemaVersion !== BigInt(expectedSchemaVersion)) integrity();
  let decodedEventPayload: Record<string, unknown>;
  try {
    decodedEventPayload = jsonRecord(decodeLifecycleEventPayload(
      payload.triggeringEventType as LifecycleEventType,
      safeNumber(trigger.eventSchemaVersion),
      eventPayload,
    ));
    if (canonicalJson(decodedEventPayload) !== trigger.payloadJson) integrity();
  } catch {
    integrity();
  }
  const workflowId = decodedEventPayload.workflowId;
  const workflowGeneration = decodedEventPayload.workflowGeneration;
  if (payload.origin.kind === "terminal-event") {
    if (
      payload.triggeringEventType !== "SessionAbandoned"
      || workflowId !== null
      || workflowGeneration !== null
    ) integrity();
    return;
  }
  if (
    typeof workflowId !== "string"
    || workflowId !== payload.origin.workflowId
    || (typeof workflowGeneration !== "number" && typeof workflowGeneration !== "bigint")
    || BigInt(workflowGeneration) !== BigInt(payload.origin.workflowGeneration)
  ) integrity();
  if (payload.triggeringEventType === "SessionCheckpointRecorded") {
    const checkpoint = jsonRecord(decodedEventPayload.checkpoint);
    if (
      decodedEventPayload.checkpointEventPosition !== eventPosition.toString()
      || checkpoint.sessionId !== payload.sessionId
      || checkpoint.parentSessionId !== null
    ) integrity();
    const workflow = connection.prepare(`
      SELECT 1 AS present
      FROM workflow_instances
      WHERE project_id = $projectId
        AND workflow_id = $workflowId
        AND session_id = $sessionId
        AND generation = $workflowGeneration
    `).get({
      $projectId: projectId,
      $workflowId: payload.origin.workflowId,
      $sessionId: payload.sessionId,
      $workflowGeneration: payload.origin.workflowGeneration,
    } as SqliteParams);
    if (workflow === undefined) integrity();
  }
}

function artifactPathFor(
  connection: SqliteConnection,
  projectId: string,
  sessionId: string,
): string {
  const rows = connection.prepare(`
    SELECT occurred_at
    FROM events
    WHERE project_id = $projectId
      AND session_id = $sessionId
      AND stream_id = $streamId
      AND stream_version = 1
      AND event_type = 'SessionStarted'
      AND event_schema_version = 1
  `).all({
    $projectId: projectId,
    $sessionId: sessionId,
    $streamId: `session/${sessionId}`,
  });
  if (rows.length !== 1) integrity();
  const occurredAt = stringValue(rows[0]!.occurred_at);
  try {
    parseCanonicalTimestamp(occurredAt, "sessionStarted.occurredAt");
  } catch {
    integrity();
  }
  return `05_Agent_Session_Logs/${occurredAt.slice(0, 10)}-session-${sessionId}.md`;
}

function queryRowByIdentity(
  connection: SqliteConnection,
  projectId: string,
  sessionId: string,
  artifactKind: string,
  materializationRevision: bigint,
): SqliteRow[] {
  return connection.prepare(`
    SELECT *
    FROM outbox
    WHERE project_id = $projectId
      AND session_id = $sessionId
      AND artifact_kind = $artifactKind
      AND materialization_revision = $materializationRevision
  `).all({
    $projectId: projectId,
    $sessionId: sessionId,
    $artifactKind: artifactKind,
    $materializationRevision: materializationRevision,
  });
}

function queryRowByTargetKey(
  connection: SqliteConnection,
  projectId: string,
  targetKey: string,
): SqliteRow[] {
  return connection.prepare(`
    SELECT *
    FROM outbox
    WHERE project_id = $projectId
      AND target_key = $targetKey
  `).all({
    $projectId: projectId,
    $targetKey: targetKey,
  });
}

function claimFromRawRow(
  connection: SqliteConnection,
  rawRow: SqliteRow,
): LifecycleOutboxClaimV1 {
  const record = decodeStorageRow(rawRow);
  if (
    (record.status !== "claimed" && record.status !== "completed")
    || record.claimOwner === null
    || record.claimToken === null
  ) integrity();
  const planned = validateRow(connection, rawRow, 0);
  return Object.freeze({
    planned,
    status: record.status,
    attemptCount: record.attemptCount,
    claimOwner: record.claimOwner,
    claimToken: record.claimToken,
    claimExpiresAt: record.claimExpiresAt,
  });
}

interface ExactClaimValues {
  readonly projectId: string;
  readonly targetKey: string;
  readonly materializationRevision: bigint;
  readonly ownerId: string;
  readonly claimToken: bigint;
}

function exactClaimValues(
  input: LifecycleOutboxExactClaimInputV1,
): ExactClaimValues {
  return {
    projectId: parseCanonicalUuid(input.projectId, "outbox.projectId"),
    targetKey: targetKeyValue(input.targetKey),
    materializationRevision: revisionInput(input.materializationRevision),
    ownerId: ownerValue(input.ownerId),
    claimToken: claimTokenInput(input.claimToken),
  };
}

function exactClaimRows(
  connection: SqliteConnection,
  values: ExactClaimValues,
): SqliteRow[] {
  return connection.prepare(`
    SELECT *
    FROM outbox
    WHERE project_id = $projectId
      AND target_key = $targetKey
      AND materialization_revision = $materializationRevision
  `).all({
    $projectId: values.projectId,
    $targetKey: values.targetKey,
    $materializationRevision: values.materializationRevision,
  });
}

function requireCurrentWorkflowGeneration(
  connection: SqliteConnection,
  plan: LifecycleOutboxPlannedRevision,
): void {
  if (hasCurrentWorkflowGeneration(connection, plan)) return;
  throw new LifecycleError("EVENT_CONFLICT");
}

function hasCurrentWorkflowGeneration(
  connection: SqliteConnection,
  plan: LifecycleOutboxPlannedRevision,
): boolean {
  if (plan.origin.kind === "terminal-event") return true;
  const row = connection.prepare(`
    SELECT 1 AS present
    FROM workflow_instances
    WHERE project_id = $projectId
      AND workflow_id = $workflowId
      AND session_id = $sessionId
      AND generation = $workflowGeneration
    LIMIT 2
  `).get({
    $projectId: plan.projectId,
    $workflowId: plan.origin.workflowId,
    $sessionId: plan.sessionId,
    $workflowGeneration: BigInt(plan.origin.workflowGeneration),
  });
  return row !== undefined;
}

function latestRevision(
  connection: SqliteConnection,
  plan: LifecycleOutboxPlannedRevision,
): bigint {
  const row = connection.prepare(`
    SELECT MAX(materialization_revision) AS latest_revision
    FROM outbox
    WHERE project_id = $projectId
      AND session_id = $sessionId
      AND artifact_kind = $artifactKind
  `).get({
    $projectId: plan.projectId,
    $sessionId: plan.sessionId,
    $artifactKind: plan.artifactKind,
  });
  if (row === undefined || row.latest_revision === null) integrity();
  return positiveIntegerValue(row.latest_revision);
}

function sameFingerprint(left: KeyedFingerprintV1, right: KeyedFingerprintV1): boolean {
  return left.algorithm === right.algorithm
    && left.schemaVersion === right.schemaVersion
    && left.keyId === right.keyId
    && left.domain === right.domain
    && left.value === right.value;
}

function assertClaimMatches(
  expected: LifecycleOutboxClaimV1,
  actual: LifecycleOutboxClaimV1,
): void {
  const planSnapshot = (plan: LifecycleOutboxPlannedRevision) => canonicalJson({
    ...plan,
    materializationRevision: plan.materializationRevision.toString(),
    triggeringEventPosition: plan.triggeringEventPosition.toString(),
  });
  if (
    expected.status !== actual.status
    || expected.attemptCount !== actual.attemptCount
    || expected.claimOwner !== actual.claimOwner
    || expected.claimToken !== actual.claimToken
    || expected.claimExpiresAt !== actual.claimExpiresAt
    || planSnapshot(expected.planned) !== planSnapshot(actual.planned)
  ) integrity();
}

function queryPriorRow(
  connection: SqliteConnection,
  record: LifecycleOutboxStorageRecord,
): SqliteRow | undefined {
  return connection.prepare(`
    SELECT *
    FROM outbox
    WHERE project_id = $projectId
      AND session_id = $sessionId
      AND artifact_kind = $artifactKind
      AND materialization_revision < $materializationRevision
    ORDER BY materialization_revision DESC
    LIMIT 1
  `).get({
    $projectId: record.projectId,
    $sessionId: record.sessionId,
    $artifactKind: record.artifactKind,
    $materializationRevision: record.materializationRevision,
  });
}

function compareQuery(
  query: ExactPlannedRevisionQuery,
  plan: LifecycleOutboxPlannedRevision,
): void {
  if (
    query.projectId !== plan.projectId
    || query.sessionId !== plan.sessionId
    || query.artifactKind !== plan.artifactKind
    || query.materializationRevision !== plan.materializationRevision
    || query.triggeringEventPosition !== plan.triggeringEventPosition
    || query.triggeringEventType !== plan.triggeringEventType
    || !sameJson(query.origin, plan.origin)
  ) integrity();
}

function validateRow(
  connection: SqliteConnection,
  rawRow: SqliteRow,
  depth: number,
): LifecycleOutboxPlannedRevision {
  if (depth > MAX_RECURSION) integrity();
  const record = decodeStorageRow(rawRow);
  if (record.kind !== LIFECYCLE_OUTBOX_KIND) integrity();
  const { payload } = canonicalPayload(record.payloadJson);
  const revision = BigInt(payload.materializationRevision);
  if (
    record.materializationRevision !== revision
    || record.eventPosition !== revision
    || record.projectId.length === 0
    || record.sessionId !== payload.sessionId
    || record.targetKey !== payload.targetKey
    || record.artifactKind !== payload.artifactKind
    || record.artifactPath !== payload.artifactPath
    || record.originKind !== payload.origin.kind
    || record.workflowId !== payload.origin.workflowId
    || record.workflowGeneration !== (
      payload.origin.kind === "workflow"
        ? BigInt(payload.origin.workflowGeneration)
        : null
    )
    || record.nextFingerprint !== payload.nextFingerprint.value
    || record.fingerprintAlgorithm !== payload.nextFingerprint.algorithm
    || record.fingerprintSchemaVersion !== BigInt(payload.nextFingerprint.schemaVersion)
    || record.fingerprintKeyId !== payload.nextFingerprint.keyId
    || record.fingerprintDomain !== payload.nextFingerprint.domain
    || record.contentHash !== outboxHash(payload)
  ) integrity();
  const trigger = readTriggerRow(connection, record.projectId, record.eventPosition);
  if (trigger.payloadJson.length === 0 || trigger.payloadHash !== payload.triggeringPayloadHash) {
    integrity();
  }
  assertTriggerBinding(connection, record.projectId, record.eventPosition, payload, trigger);
  const artifactPath = artifactPathFor(connection, record.projectId, record.sessionId);
  if (artifactPath !== record.artifactPath) integrity();

  const priorRaw = queryPriorRow(connection, record);
  let expectedPriorFingerprint: KeyedFingerprintV1 | null = null;
  if (priorRaw === undefined) {
    if (record.expectedPriorFingerprint !== null) integrity();
  } else {
    const priorRecord = decodeStorageRow(priorRaw);
    if (priorRecord.materializationRevision !== record.materializationRevision - 1n) integrity();
    const priorPlan = validateRow(connection, priorRaw, depth + 1);
    if (
      record.expectedPriorFingerprint === null
      || record.expectedPriorFingerprint !== priorPlan.nextFingerprint.value
    ) integrity();
    expectedPriorFingerprint = priorPlan.nextFingerprint;
  }
  const base = {
    projectId: record.projectId as ProjectId,
    sessionId: record.sessionId as SessionId,
    artifactKind: "compatibility-session-log" as const,
    materializationRevision: record.materializationRevision,
    triggeringEventPosition: record.eventPosition,
    origin: payload.origin,
    triggeringEventType: payload.triggeringEventType,
    targetKey: record.targetKey,
    artifactPath: record.artifactPath,
    triggeringPayloadHash: payload.triggeringPayloadHash,
    expectedPriorFingerprint,
    nextFingerprint: decodeKeyedFingerprintV1(payload.nextFingerprint),
    createdAt: record.createdAt,
  };
  if (payload.origin.kind === "workflow") {
    return Object.freeze({
      ...base,
      origin: payload.origin,
      triggeringEventType: payload.triggeringEventType,
    });
  }
  return Object.freeze({
    ...base,
    origin: payload.origin,
    triggeringEventType: "SessionAbandoned" as const,
  });
}

function validateProvidedEvent(
  connection: SqliteConnection,
  pending: PendingLifecycleOutboxV1,
  triggeringEvent: StoredEvent,
): void {
  const payload = pending.payload;
  const revision = BigInt(payload.materializationRevision);
  if (
    pending.eventIndex !== 0
    || pending.kind !== LIFECYCLE_OUTBOX_KIND
    || triggeringEvent.globalPosition !== revision
    || triggeringEvent.sessionId !== payload.sessionId
    || triggeringEvent.streamType !== "session"
    || triggeringEvent.streamId !== `session/${payload.sessionId}`
    || triggeringEvent.parentSessionId !== null
    || triggeringEvent.commandEventIndex !== 0
    || triggeringEvent.eventType !== payload.triggeringEventType
    || triggeringEvent.payloadHash !== payload.triggeringPayloadHash
    || canonicalJson(triggeringEvent.payload) !== triggeringEvent.payloadJson
    || payloadHash(triggeringEvent.payload) !== triggeringEvent.payloadHash
  ) integrity();
  try {
    parseCanonicalUuid(triggeringEvent.eventId, "triggeringEvent.eventId");
    if (triggeringEvent.streamVersion < 1n || triggeringEvent.streamVersion > MAX_SQLITE_INT64) {
      integrity();
    }
  } catch {
    integrity();
  }
  const trigger = readTriggerRow(connection, triggeringEvent.projectId, triggeringEvent.globalPosition);
  if (
    trigger.eventType !== triggeringEvent.eventType
    || trigger.eventId !== triggeringEvent.eventId
    || trigger.eventSchemaVersion !== BigInt(triggeringEvent.eventSchemaVersion)
    || trigger.streamVersion !== triggeringEvent.streamVersion
    || trigger.sessionId !== triggeringEvent.sessionId
    || trigger.parentSessionId !== triggeringEvent.parentSessionId
    || trigger.streamType !== triggeringEvent.streamType
    || trigger.streamId !== triggeringEvent.streamId
    || trigger.commandEventIndex !== BigInt(triggeringEvent.commandEventIndex)
    || trigger.payloadJson !== triggeringEvent.payloadJson
    || trigger.payloadHash !== triggeringEvent.payloadHash
  ) integrity();
  assertTriggerBinding(connection, triggeringEvent.projectId, triggeringEvent.globalPosition, payload, trigger);
  const artifactPath = artifactPathFor(connection, triggeringEvent.projectId, payload.sessionId);
  if (artifactPath !== payload.artifactPath) integrity();
}

export class LifecycleOutboxRepository {
  readonly #faultInjector: LifecycleFaultInjector;

  constructor(options: { readonly faultInjector?: LifecycleFaultInjector } = {}) {
    this.#faultInjector = options.faultInjector ?? NO_LIFECYCLE_FAULTS;
  }

  insertLifecycle(
    connection: SqliteConnection,
    pendingInput: PendingLifecycleOutboxV1,
    triggeringEvent: StoredEvent,
    createdAt: string,
  ): void {
    integrityBoundary(() => {
      let pending: PendingLifecycleOutboxV1;
      try {
        pending = decodePendingLifecycleOutboxV1(pendingInput);
      } catch {
        integrity();
      }
      try {
        parseCanonicalTimestamp(createdAt, "outbox.createdAt");
      } catch {
        integrity();
      }
      validateProvidedEvent(connection, pending, triggeringEvent);
      const existing = queryRowByIdentity(
        connection,
        triggeringEvent.projectId,
        pending.payload.sessionId,
        pending.payload.artifactKind,
        BigInt(pending.payload.materializationRevision),
      );
      if (existing.length !== 0) integrity();
      const provisionalRecord: LifecycleOutboxStorageRecord = Object.freeze({
        projectId: triggeringEvent.projectId,
        targetKey: pending.targetKey,
        eventPosition: triggeringEvent.globalPosition,
        kind: LIFECYCLE_OUTBOX_KIND,
        payloadJson: canonicalJson(pending.payload),
        contentHash: outboxHash(pending.payload),
        status: "pending",
        attemptCount: 0n,
        claimOwner: null,
        claimToken: null,
        claimExpiresAt: null,
        createdAt,
        updatedAt: createdAt,
        sessionId: pending.payload.sessionId,
        originKind: pending.payload.origin.kind,
        workflowId: pending.payload.origin.workflowId,
        workflowGeneration: pending.payload.origin.kind === "workflow"
          ? BigInt(pending.payload.origin.workflowGeneration)
          : null,
        artifactKind: COMPATIBILITY_SESSION_LOG_ARTIFACT_KIND,
        artifactPath: pending.payload.artifactPath,
        materializationRevision: BigInt(pending.payload.materializationRevision),
        expectedPriorFingerprint: null,
        nextFingerprint: pending.payload.nextFingerprint.value,
        fingerprintAlgorithm: pending.payload.nextFingerprint.algorithm,
        fingerprintSchemaVersion: BigInt(pending.payload.nextFingerprint.schemaVersion),
        fingerprintKeyId: pending.payload.nextFingerprint.keyId,
        fingerprintDomain: pending.payload.nextFingerprint.domain,
        failureClass: null,
        safeErrorCode: null,
        nextAttemptAt: null,
      });
      const priorRaw = queryPriorRow(connection, provisionalRecord);
      let expectedPriorFingerprint: string | null = null;
      if (priorRaw !== undefined) {
        const priorRecord = decodeStorageRow(priorRaw);
        if (priorRecord.materializationRevision !== provisionalRecord.materializationRevision - 1n) {
          integrity();
        }
        const priorPlan = validateRow(connection, priorRaw, 0);
        expectedPriorFingerprint = priorPlan.nextFingerprint.value;
      }
      const values: SqliteParams = {
        $projectId: provisionalRecord.projectId,
        $targetKey: provisionalRecord.targetKey,
        $eventPosition: provisionalRecord.eventPosition,
        $kind: provisionalRecord.kind,
        $payloadJson: provisionalRecord.payloadJson,
        $contentHash: provisionalRecord.contentHash,
        $status: provisionalRecord.status,
        $attemptCount: provisionalRecord.attemptCount,
        $claimOwner: null,
        $claimToken: null,
        $claimExpiresAt: null,
        $createdAt: provisionalRecord.createdAt,
        $updatedAt: provisionalRecord.updatedAt,
        $sessionId: provisionalRecord.sessionId,
        $originKind: provisionalRecord.originKind,
        $workflowId: provisionalRecord.workflowId,
        $workflowGeneration: provisionalRecord.workflowGeneration,
        $artifactKind: provisionalRecord.artifactKind,
        $artifactPath: provisionalRecord.artifactPath,
        $materializationRevision: provisionalRecord.materializationRevision,
        $expectedPriorFingerprint: expectedPriorFingerprint,
        $nextFingerprint: provisionalRecord.nextFingerprint,
        $fingerprintAlgorithm: provisionalRecord.fingerprintAlgorithm,
        $fingerprintSchemaVersion: provisionalRecord.fingerprintSchemaVersion,
        $fingerprintKeyId: provisionalRecord.fingerprintKeyId,
        $fingerprintDomain: provisionalRecord.fingerprintDomain,
        $failureClass: null,
        $safeErrorCode: null,
        $nextAttemptAt: null,
      };
      try {
        this.#faultInjector.hit(
          "outbox-insert",
          "before-write",
          {
            projectId: triggeringEvent.projectId,
            sessionId: pending.payload.sessionId,
            workflowId: pending.payload.origin.kind === "workflow"
              ? pending.payload.origin.workflowId
              : null,
            commandId: triggeringEvent.commandId,
            idempotencyKeyHash: null,
            workId: pending.targetKey,
            eventPosition: triggeringEvent.globalPosition.toString(),
            materializationRevision: provisionalRecord.materializationRevision.toString(),
          },
        );
        connection.prepare(`
          INSERT INTO outbox(
            project_id, target_key, event_position, kind, payload_json,
            content_hash, status, attempt_count, claim_owner, claim_token,
            claim_expires_at, created_at, updated_at, session_id, origin_kind,
            workflow_id, workflow_generation, artifact_kind, artifact_path,
            materialization_revision, expected_prior_fingerprint, next_fingerprint,
            fingerprint_algorithm, fingerprint_schema_version, fingerprint_key_id,
            fingerprint_domain, failure_class, safe_error_code, next_attempt_at
          ) VALUES (
            $projectId, $targetKey, $eventPosition, $kind, $payloadJson,
            $contentHash, $status, $attemptCount, $claimOwner, $claimToken,
            $claimExpiresAt, $createdAt, $updatedAt, $sessionId, $originKind,
            $workflowId, $workflowGeneration, $artifactKind, $artifactPath,
            $materializationRevision, $expectedPriorFingerprint, $nextFingerprint,
            $fingerprintAlgorithm, $fingerprintSchemaVersion, $fingerprintKeyId,
            $fingerprintDomain, $failureClass, $safeErrorCode, $nextAttemptAt
          )
        `).run(values);
      } catch {
        integrity();
      }
    });
  }

  claimNext(
    connection: SqliteConnection,
    input: LifecycleOutboxClaimNextInputV1,
  ): LifecycleOutboxClaimV1 | null {
    const projectId = parseCanonicalUuid(input.projectId, "outbox.projectId");
    const ownerId = ownerValue(input.ownerId);
    const observedAt = timeFromMs(input.observedNowMs, "observedNowMs");
    const claimExpiresAt = leaseUntil(input.observedNowMs, input.leaseDurationMs);
    const candidate = connection.prepare(`
      SELECT o.*
      FROM outbox AS o
      WHERE o.project_id = $projectId
        AND o.kind = $kind
        AND o.session_id IS NOT NULL
        AND o.materialization_revision = (
          SELECT max(latest.materialization_revision)
          FROM outbox AS latest
          WHERE latest.project_id = o.project_id
            AND latest.session_id = o.session_id
            AND latest.artifact_kind = o.artifact_kind
        )
        AND (
          o.status = 'pending'
          OR (o.status = 'failed' AND o.failure_class = 'retryable' AND o.next_attempt_at <= $observedAt)
          OR (o.status = 'claimed' AND o.claim_expires_at <= $observedAt)
        )
        AND (
          o.origin_kind = 'terminal-event'
          OR EXISTS (
            SELECT 1
            FROM workflow_instances AS w
            WHERE w.project_id = o.project_id
              AND w.workflow_id = o.workflow_id
              AND w.session_id = o.session_id
              AND w.generation = o.workflow_generation
          )
        )
      ORDER BY o.materialization_revision ASC, o.target_key COLLATE BINARY ASC
      LIMIT 1
    `).get({
      $projectId: projectId,
      $kind: LIFECYCLE_OUTBOX_KIND,
      $observedAt: observedAt,
    });
    if (candidate === undefined) return null;
    const candidateRecord = decodeStorageRow(candidate);
    const candidatePlan = validateRow(connection, candidate, 0);
    const nextAttemptCount = candidateRecord.attemptCount + 1n;
    if (nextAttemptCount > MAX_SQLITE_INT64) inputFailure();
    const changed = connection.prepare(`
      UPDATE outbox
      SET status = 'claimed',
          attempt_count = attempt_count + 1,
          claim_owner = $ownerId,
          claim_token = attempt_count + 1,
          claim_expires_at = $claimExpiresAt,
          updated_at = $updatedAt,
          failure_class = NULL,
          safe_error_code = NULL,
          next_attempt_at = NULL
      WHERE project_id = $projectId
        AND target_key = $targetKey
        AND materialization_revision = $materializationRevision
        AND status = $status
        AND attempt_count = $attemptCount
        AND (
          status = 'pending'
          OR (status = 'failed' AND failure_class = 'retryable' AND next_attempt_at <= $observedAt)
          OR (status = 'claimed' AND claim_expires_at <= $observedAt)
        )
        AND (
          origin_kind = 'terminal-event'
          OR EXISTS (
            SELECT 1
            FROM workflow_instances AS w
            WHERE w.project_id = outbox.project_id
              AND w.workflow_id = outbox.workflow_id
              AND w.session_id = outbox.session_id
              AND w.generation = outbox.workflow_generation
          )
        )
    `).run({
      $projectId: projectId,
      $targetKey: candidateRecord.targetKey,
      $materializationRevision: candidateRecord.materializationRevision,
      $status: candidateRecord.status,
      $attemptCount: candidateRecord.attemptCount,
      $ownerId: ownerId,
      $claimExpiresAt: claimExpiresAt,
      $updatedAt: observedAt,
      $observedAt: observedAt,
    });
    const changedCount = BigInt(changed.changes as unknown as bigint | number);
    if (changedCount === 0n) return null;
    if (changedCount !== 1n) integrity();
    const row = queryRowByTargetKey(connection, projectId, candidatePlan.targetKey);
    if (row.length !== 1) integrity();
    return claimFromRawRow(connection, row[0]!);
  }

  getExactClaim(
    connection: SqliteConnection,
    input: LifecycleOutboxExactClaimInputV1,
  ): LifecycleOutboxClaimV1 {
    const values = exactClaimValues(input);
    const rows = exactClaimRows(connection, values);
    if (rows.length === 0) throw new LifecycleError("EVENT_CONFLICT");
    if (rows.length !== 1) integrity();
    const record = decodeStorageRow(rows[0]!);
    if (
      record.status !== "claimed"
      && record.status !== "completed"
    ) throw new LifecycleError("EVENT_CONFLICT");
    if (record.claimOwner !== values.ownerId || record.claimToken !== values.claimToken) {
      throw new LifecycleError("EVENT_CONFLICT");
    }
    const claim = claimFromRawRow(connection, rows[0]!);
    if (claim.status === "claimed") requireCurrentWorkflowGeneration(connection, claim.planned);
    return claim;
  }

  renewClaim(
    connection: SqliteConnection,
    input: LifecycleOutboxRenewInputV1,
  ): LifecycleOutboxClaimV1 | null {
    const values = exactClaimValues(input);
    const observedAt = timeFromMs(input.observedNowMs, "observedNowMs");
    const claimExpiresAt = leaseUntil(input.observedNowMs, input.leaseDurationMs);
    const rows = exactClaimRows(connection, values);
    if (rows.length === 0) return null;
    if (rows.length !== 1) integrity();
    const current = decodeStorageRow(rows[0]!);
    const plan = validateRow(connection, rows[0]!, 0);
    if (
      current.status !== "claimed"
      || current.claimOwner !== values.ownerId
      || current.claimToken !== values.claimToken
      || latestRevision(connection, plan) !== values.materializationRevision
    ) return null;
    requireCurrentWorkflowGeneration(connection, plan);
    const changed = connection.prepare(`
      UPDATE outbox
      SET claim_expires_at = $claimExpiresAt,
          updated_at = $updatedAt
      WHERE project_id = $projectId
        AND target_key = $targetKey
        AND materialization_revision = $materializationRevision
        AND status = 'claimed'
        AND claim_owner = $ownerId
        AND claim_token = $claimToken
        AND claim_expires_at > $observedAt
        AND (
          origin_kind = 'terminal-event'
          OR EXISTS (
            SELECT 1
            FROM workflow_instances AS w
            WHERE w.project_id = outbox.project_id
              AND w.workflow_id = outbox.workflow_id
              AND w.session_id = outbox.session_id
              AND w.generation = outbox.workflow_generation
          )
        )
    `).run({
      $projectId: values.projectId,
      $targetKey: values.targetKey,
      $materializationRevision: values.materializationRevision,
      $ownerId: values.ownerId,
      $claimToken: values.claimToken,
      $claimExpiresAt: claimExpiresAt,
      $updatedAt: observedAt,
      $observedAt: observedAt,
    });
    const changedCount = BigInt(changed.changes as unknown as bigint | number);
    if (changedCount === 0n) return null;
    if (changedCount !== 1n) integrity();
    const refreshed = exactClaimRows(connection, values);
    if (refreshed.length !== 1) integrity();
    return claimFromRawRow(connection, refreshed[0]!);
  }

  listCommittedLowerRevisionFingerprints(
    connection: SqliteConnection,
    claim: LifecycleOutboxClaimV1,
  ): readonly KeyedFingerprintV1[] {
    const exact = this.getExactClaim(connection, {
      projectId: claim.planned.projectId,
      targetKey: claim.planned.targetKey,
      materializationRevision: claim.planned.materializationRevision,
      ownerId: claim.claimOwner,
      claimToken: claim.claimToken,
    });
    assertClaimMatches(claim, exact);
    const rows = connection.prepare(`
      SELECT *
      FROM outbox
      WHERE project_id = $projectId
        AND session_id = $sessionId
        AND artifact_kind = $artifactKind
        AND artifact_path = $artifactPath
        AND materialization_revision < $materializationRevision
      ORDER BY materialization_revision ASC
    `).all({
      $projectId: claim.planned.projectId,
      $sessionId: claim.planned.sessionId,
      $artifactKind: claim.planned.artifactKind,
      $artifactPath: claim.planned.artifactPath,
      $materializationRevision: claim.planned.materializationRevision,
    });
    const fingerprints: KeyedFingerprintV1[] = [];
    for (const row of rows) {
      const record = decodeStorageRow(row);
      if (record.status !== "completed") continue;
      const plan = validateRow(connection, row, 0);
      if (
        plan.projectId !== claim.planned.projectId
        || plan.sessionId !== claim.planned.sessionId
        || plan.artifactKind !== claim.planned.artifactKind
        || plan.artifactPath !== claim.planned.artifactPath
      ) integrity();
      fingerprints.push(plan.nextFingerprint);
    }
    return Object.freeze(fingerprints);
  }

  isLatestRevision(
    connection: SqliteConnection,
    plan: LifecycleOutboxPlannedRevision,
  ): boolean {
    return latestRevision(connection, plan) === plan.materializationRevision;
  }

  isCurrentWorkflowGeneration(
    connection: SqliteConnection,
    plan: LifecycleOutboxPlannedRevision,
  ): boolean {
    return hasCurrentWorkflowGeneration(connection, plan);
  }

  isCompleted(
    connection: SqliteConnection,
    input: LifecycleOutboxCompletionQueryV1,
  ): boolean {
    const projectId = parseCanonicalUuid(input.projectId, "outbox.projectId");
    const targetKey = targetKeyValue(input.targetKey);
    const materializationRevision = revisionInput(input.materializationRevision);
    const rows = connection.prepare(`
      SELECT *
      FROM outbox
      WHERE project_id = $projectId
        AND target_key = $targetKey
        AND materialization_revision = $materializationRevision
    `).all({
      $projectId: projectId,
      $targetKey: targetKey,
      $materializationRevision: materializationRevision,
    });
    if (rows.length === 0) return false;
    if (rows.length !== 1) integrity();
    const record = decodeStorageRow(rows[0]!);
    void validateRow(connection, rows[0]!, 0);
    return record.status === "completed";
  }

  recordFailure(
    connection: SqliteConnection,
    input: LifecycleOutboxFailureInputV1,
  ): boolean {
    const values = exactClaimValues(input);
    const observedAt = timeFromMs(input.observedNowMs, "observedNowMs");
    const failureClass = input.failureClass;
    if (failureClass !== "retryable" && failureClass !== "permanent") inputFailure();
    const safeErrorCode = safeErrorCodeInput(input.safeErrorCode);
    const rows = exactClaimRows(connection, values);
    if (rows.length === 0) return false;
    if (rows.length !== 1) integrity();
    const current = decodeStorageRow(rows[0]!);
    const plan = validateRow(connection, rows[0]!, 0);
    if (
      current.status !== "claimed"
      || current.claimOwner !== values.ownerId
      || current.claimToken !== values.claimToken
      || latestRevision(connection, plan) !== values.materializationRevision
    ) return false;
    if (input.attemptCount !== undefined && input.attemptCount !== current.attemptCount) {
      inputFailure();
    }
    requireCurrentWorkflowGeneration(connection, plan);
    const expectedNextAttemptAt = failureClass === "retryable"
      ? retryAt(input.observedNowMs, current.attemptCount)
      : null;
    if (input.nextAttemptAt !== expectedNextAttemptAt) inputFailure();
    const changed = connection.prepare(`
      UPDATE outbox
      SET status = 'failed',
          claim_owner = NULL,
          claim_token = NULL,
          claim_expires_at = NULL,
          updated_at = $updatedAt,
          failure_class = $failureClass,
          safe_error_code = $safeErrorCode,
          next_attempt_at = $nextAttemptAt
      WHERE project_id = $projectId
        AND target_key = $targetKey
        AND materialization_revision = $materializationRevision
        AND status = 'claimed'
        AND claim_owner = $ownerId
        AND claim_token = $claimToken
        AND claim_expires_at > $observedAt
        AND (
          origin_kind = 'terminal-event'
          OR EXISTS (
            SELECT 1
            FROM workflow_instances AS w
            WHERE w.project_id = outbox.project_id
              AND w.workflow_id = outbox.workflow_id
              AND w.session_id = outbox.session_id
              AND w.generation = outbox.workflow_generation
          )
        )
    `).run({
      $projectId: values.projectId,
      $targetKey: values.targetKey,
      $materializationRevision: values.materializationRevision,
      $ownerId: values.ownerId,
      $claimToken: values.claimToken,
      $updatedAt: observedAt,
      $failureClass: failureClass,
      $safeErrorCode: safeErrorCode,
      $nextAttemptAt: expectedNextAttemptAt,
      $observedAt: observedAt,
    });
    const changedCount = BigInt(changed.changes as unknown as bigint | number);
    if (changedCount > 1n) integrity();
    return changedCount === 1n;
  }

  acknowledgeAfterReplacement(
    connection: SqliteConnection,
    input: LifecycleOutboxAcknowledgementInputV1,
  ): LifecycleOutboxMaterializationResultV1 {
    const values = exactClaimValues(input);
    const completedAt = timestampInput(input.completedAt, "completedAt");
    const targetPath = input.targetPath;
    if (typeof targetPath !== "string" || targetPath.length === 0 || targetPath.length > 4_096) inputFailure();
    let targetFingerprint: KeyedFingerprintV1;
    try {
      targetFingerprint = decodeKeyedFingerprintV1(input.targetFingerprint);
    } catch {
      inputFailure();
    }
    const rows = exactClaimRows(connection, values);
    if (rows.length === 0) throw new LifecycleError("EVENT_CONFLICT");
    if (rows.length !== 1) integrity();
    const current = decodeStorageRow(rows[0]!);
    const plan = validateRow(connection, rows[0]!, 0);
    if (targetPath !== plan.artifactPath || !sameFingerprint(targetFingerprint, plan.nextFingerprint)) {
      throw new LifecycleError("MATERIALIZATION_CONFLICT");
    }
    const latest = latestRevision(connection, plan);
    if (current.status === "completed") {
      if (
        current.claimOwner !== values.ownerId
        || current.claimToken !== values.claimToken
      ) throw new LifecycleError("EVENT_CONFLICT");
      const claim = claimFromRawRow(connection, rows[0]!);
      return Object.freeze({
        status: latest > plan.materializationRevision
          ? "superseded-after-completion"
          : "completed",
        claim,
      });
    }
    if (
      current.status !== "claimed"
      || current.claimOwner !== values.ownerId
      || current.claimToken !== values.claimToken
      || latest !== plan.materializationRevision
    ) throw new LifecycleError("EVENT_CONFLICT");
    requireCurrentWorkflowGeneration(connection, plan);
    const changed = connection.prepare(`
      UPDATE outbox
      SET status = 'completed',
          claim_expires_at = NULL,
          updated_at = $updatedAt,
          failure_class = NULL,
          safe_error_code = NULL,
          next_attempt_at = NULL
      WHERE project_id = $projectId
        AND target_key = $targetKey
        AND materialization_revision = $materializationRevision
        AND status = 'claimed'
        AND claim_owner = $ownerId
        AND claim_token = $claimToken
    `).run({
      $projectId: values.projectId,
      $targetKey: values.targetKey,
      $materializationRevision: values.materializationRevision,
      $ownerId: values.ownerId,
      $claimToken: values.claimToken,
      $updatedAt: completedAt,
    });
    const changedCount = BigInt(changed.changes as unknown as bigint | number);
    if (changedCount !== 1n) throw new LifecycleError("EVENT_CONFLICT");
    const completedRows = exactClaimRows(connection, values);
    if (completedRows.length !== 1) integrity();
    const claim = claimFromRawRow(connection, completedRows[0]!);
    return Object.freeze({ status: "completed", claim });
  }

  getExactPlannedRevision(
    connection: SqliteConnection,
    query: ExactPlannedRevisionQuery,
  ): LifecycleOutboxPlannedRevision | null {
    return integrityBoundary(() => {
      const rows = queryRowByIdentity(
        connection,
        query.projectId,
        query.sessionId,
        query.artifactKind,
        query.materializationRevision,
      );
      if (rows.length === 0) {
        const targetRows = queryRowByTargetKey(
          connection,
          query.projectId,
          `lifecycle-log/${query.sessionId}/${query.materializationRevision.toString()}`,
        );
        if (targetRows.length !== 0) integrity();
        return null;
      }
      if (rows.length !== 1) integrity();
      const plan = validateRow(connection, rows[0]!, 0);
      compareQuery(query, plan);
      return plan;
    });
  }

  assertExactPlannedRevision(
    connection: SqliteConnection,
    query: ExactPlannedRevisionQuery,
  ): LifecycleOutboxPlannedRevision {
    const plan = this.getExactPlannedRevision(connection, query);
    if (plan === null) integrity();
    return plan;
  }
}
