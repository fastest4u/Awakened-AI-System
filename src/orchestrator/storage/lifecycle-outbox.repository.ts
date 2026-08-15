import type { StoredEvent } from "../contracts/event.js";
import { outboxHash, payloadHash } from "../crypto/event-hash.js";
import type { ProjectId } from "../identity/contracts.js";
import { LifecycleError } from "../lifecycle/errors.js";
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
  LifecycleOutboxStorageRecord,
  LifecycleOutboxStatus,
} from "./lifecycle-storage.types.js";
import type { SqliteConnection, SqliteParams, SqliteRow } from "./sqlite-driver.js";

const LOWER_HASH = /^[0-9a-f]{64}$/u;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/u;
const MAX_SQLITE_INT64 = 9_223_372_036_854_775_807n;
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
    kind: LIFECYCLE_OUTBOX_KIND,
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
  readonly eventType: string;
  readonly eventSchemaVersion: bigint;
  readonly payloadJson: string;
  readonly payloadHash: string;
  readonly commandEventIndex: bigint;
  readonly sessionId: string | null;
  readonly streamType: string;
  readonly streamId: string;
  readonly occurredAt?: string;
}

function decodeTriggerRow(row: SqliteRow): TriggerRow {
  return Object.freeze({
    eventType: stringValue(rowField(row, "event_type")),
    eventSchemaVersion: integerValue(rowField(row, "event_schema_version")),
    payloadJson: stringValue(rowField(row, "payload_json")),
    payloadHash: hashValue(rowField(row, "payload_hash")),
    commandEventIndex: integerValue(rowField(row, "command_event_index")),
    sessionId: rowField(row, "session_id") === null
      ? null
      : stringValue(rowField(row, "session_id")),
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
    SELECT event_type, event_schema_version, payload_json, payload_hash,
           command_event_index, session_id, stream_type, stream_id, occurred_at
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
    return jsonRecord(JSON.parse(payloadJson) as unknown);
  } catch {
    integrity();
  }
}

function assertTriggerBinding(
  connection: SqliteConnection,
  projectId: string,
  payload: LifecycleMaterializationPayloadV1,
  trigger: TriggerRow,
): void {
  if (
    !LIFECYCLE_TRIGGER_TYPES.has(payload.triggeringEventType as never)
    || trigger.eventType !== payload.triggeringEventType
    || trigger.commandEventIndex !== 0n
    || trigger.sessionId !== payload.sessionId
    || trigger.streamType !== "session"
    || trigger.streamId !== `session/${payload.sessionId}`
    || trigger.payloadHash !== payload.triggeringPayloadHash
  ) integrity();
  let eventPayload: Record<string, unknown>;
  try {
    eventPayload = parsePayloadObject(trigger.payloadJson);
  } catch {
    integrity();
  }
  const workflowId = eventPayload.workflowId;
  const workflowGeneration = eventPayload.workflowGeneration;
  if (payload.origin.kind === "terminal-event") {
    if (
      payload.triggeringEventType !== "SessionAbandoned"
      || trigger.eventSchemaVersion !== 1n
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
  const expectedSchemaVersion = payload.triggeringEventType === "SessionCheckpointRecorded"
    ? 3n
    : (payload.triggeringEventType === "SessionEndAmended"
      || payload.triggeringEventType === "SessionEndCancelled" ? 3n : 1n);
  if (trigger.eventSchemaVersion !== expectedSchemaVersion) integrity();
  if (payload.triggeringEventType === "SessionCheckpointRecorded") {
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
  assertTriggerBinding(connection, record.projectId, payload, trigger);
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
    || triggeringEvent.commandEventIndex !== 0
    || triggeringEvent.eventType !== payload.triggeringEventType
    || triggeringEvent.payloadHash !== payload.triggeringPayloadHash
    || canonicalJson(triggeringEvent.payload) !== triggeringEvent.payloadJson
    || payloadHash(triggeringEvent.payload) !== triggeringEvent.payloadHash
  ) integrity();
  const trigger = readTriggerRow(connection, triggeringEvent.projectId, triggeringEvent.globalPosition);
  if (
    trigger.eventType !== triggeringEvent.eventType
    || trigger.eventSchemaVersion !== BigInt(triggeringEvent.eventSchemaVersion)
    || trigger.sessionId !== triggeringEvent.sessionId
    || trigger.streamType !== triggeringEvent.streamType
    || trigger.streamId !== triggeringEvent.streamId
    || trigger.commandEventIndex !== BigInt(triggeringEvent.commandEventIndex)
    || trigger.payloadJson !== triggeringEvent.payloadJson
    || trigger.payloadHash !== triggeringEvent.payloadHash
  ) integrity();
  assertTriggerBinding(connection, triggeringEvent.projectId, payload, trigger);
  const artifactPath = artifactPathFor(connection, triggeringEvent.projectId, payload.sessionId);
  if (artifactPath !== payload.artifactPath) integrity();
}

export class LifecycleOutboxRepository {
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
      if (rows.length === 0) return null;
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
