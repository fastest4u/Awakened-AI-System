import {
  decodeLifecycleEventPayload,
  type LifecycleEventType,
} from "../lifecycle/contracts/events.js";
import { decodeLifecycleIntentWitness, lifecycleIntentHashFromWitnessSource } from "../lifecycle/lifecycle-intent-witness.js";
import { LifecycleError } from "../lifecycle/errors.js";
import {
  decodeSessionEndEffectiveStateV1,
  type SessionEndEffectiveStateV1,
} from "../lifecycle/session-end-effective-state.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import type { SqliteConnection, SqliteParams, SqliteRow } from "./sqlite-driver.js";

const TABLE = "lifecycle_legacy_effective_state_sources";
const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;
const LOWER_HASH = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SOURCE_EVENT_TYPES = new Set<LifecycleEventType>([
  "SessionEndRequested",
  "SessionEndAmended",
]);

export interface LegacySessionEndEffectiveStateSourceInputV1 {
  readonly projectId: string;
  readonly sourceEventPosition: bigint;
  readonly sourceEventHash: string;
  readonly commandId: string;
  readonly commandHash: string;
  readonly sessionId: string;
  readonly workflowId: string;
  readonly workflowGeneration: number;
  readonly effectiveState: unknown;
  readonly evidenceWindowState: "open" | "sealed";
  readonly effectiveCheckpointVersion: 1 | 2;
  readonly predecessorEventPosition: bigint | null;
  readonly predecessorEventHash: string | null;
}

export interface LegacySessionEndEffectiveStateSourceV1 {
  readonly sourceContractVersion: 1;
  readonly projectId: string;
  readonly sourceEventPosition: bigint;
  readonly sourceEventHash: string;
  readonly commandId: string;
  readonly commandHash: string;
  readonly sessionId: string;
  readonly workflowId: string;
  readonly workflowGeneration: number;
  readonly effectiveState: SessionEndEffectiveStateV1;
  readonly evidenceWindowState: "open" | "sealed";
  readonly effectiveCheckpointVersion: 1 | 2;
  readonly predecessorEventPosition: bigint | null;
  readonly predecessorEventHash: string | null;
}

interface SourceRow {
  readonly projectId: string;
  readonly sourceEventPosition: bigint;
  readonly sourceEventHash: string;
  readonly commandId: string;
  readonly commandHash: string;
  readonly sessionId: string;
  readonly workflowId: string;
  readonly workflowGeneration: number;
  readonly effectiveStateJson: string;
  readonly effectiveStateHash: string;
  readonly evidenceWindowState: "open" | "sealed";
  readonly effectiveCheckpointVersion: 1 | 2;
  readonly predecessorEventPosition: bigint | null;
  readonly predecessorEventHash: string | null;
  readonly sourceContractVersion: 1;
}

interface SourceEventBinding {
  readonly eventType: LifecycleEventType;
  readonly eventSchemaVersion: number;
  readonly payload: Record<string, unknown>;
  readonly command: Record<string, unknown>;
}

function integrity(): never {
  throw new LifecycleError("INTEGRITY_FAILURE");
}

function requiredString(row: SqliteRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0) return integrity();
  return value;
}

function nullableString(row: SqliteRow, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  return requiredString(row, key);
}

function positiveInt64(value: unknown): bigint {
  const decoded = typeof value === "bigint"
    ? value
    : typeof value === "number" && Number.isSafeInteger(value)
      ? BigInt(value)
      : integrity();
  if (decoded < 1n || decoded > SQLITE_INT64_MAX) return integrity();
  return decoded;
}

function nullablePositiveInt64(value: unknown): bigint | null {
  return value === null ? null : positiveInt64(value);
}

function positiveGeneration(value: unknown): number {
  const decoded = typeof value === "bigint" ? Number(value) : value;
  if (
    typeof decoded !== "number"
    || !Number.isSafeInteger(decoded)
    || decoded < 1
  ) return integrity();
  return decoded;
}

function hash(value: unknown): string {
  if (typeof value !== "string" || !LOWER_HASH.test(value)) return integrity();
  return value;
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) return integrity();
  return value;
}

function canonicalRecord(source: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    return integrity();
  }
  if (canonicalJson(parsed) !== source
    || typeof parsed !== "object"
    || parsed === null
    || Array.isArray(parsed)
  ) return integrity();
  return parsed as Record<string, unknown>;
}

function row(source: SqliteRow): SourceRow {
  const sourceContractVersion = source.source_contract_version;
  const workflowGeneration = positiveGeneration(source.workflow_generation);
  const effectiveCheckpointVersion = source.effective_checkpoint_version;
  if (effectiveCheckpointVersion !== 1n && effectiveCheckpointVersion !== 2n
    && effectiveCheckpointVersion !== 1 && effectiveCheckpointVersion !== 2) return integrity();
  const predecessorEventPosition = nullablePositiveInt64(source.predecessor_event_position);
  const predecessorEventHash = nullableString(source, "predecessor_event_hash");
  if ((predecessorEventPosition === null) !== (predecessorEventHash === null)) return integrity();
  return {
    projectId: requiredString(source, "project_id"),
    sourceEventPosition: positiveInt64(source.source_event_position),
    sourceEventHash: hash(source.source_event_hash),
    commandId: uuid(source.command_id),
    commandHash: hash(source.command_hash),
    sessionId: uuid(source.session_id),
    workflowId: uuid(source.workflow_id),
    workflowGeneration,
    effectiveStateJson: requiredString(source, "effective_state_json"),
    effectiveStateHash: hash(source.effective_state_hash),
    evidenceWindowState: source.evidence_window_state === "open"
      || source.evidence_window_state === "sealed"
      ? source.evidence_window_state
      : integrity(),
    effectiveCheckpointVersion: Number(effectiveCheckpointVersion) as 1 | 2,
    predecessorEventPosition,
    predecessorEventHash,
    sourceContractVersion: sourceContractVersion === 1n || sourceContractVersion === 1
      ? 1
      : integrity(),
  };
}

function oneSourceRow(connection: SqliteConnection, projectId: string, sourceEventPosition: bigint): SourceRow {
  const rows = connection.prepare(`
    SELECT project_id, source_event_position, source_event_hash,
           command_id, command_hash, session_id, workflow_id,
           workflow_generation, effective_state_json, effective_state_hash,
           evidence_window_state, effective_checkpoint_version,
           predecessor_event_position, predecessor_event_hash,
           source_contract_version
    FROM ${TABLE}
    WHERE project_id = $projectId AND source_event_position = $sourceEventPosition
    LIMIT 2
  `).all({
    $projectId: projectId,
    $sourceEventPosition: sourceEventPosition,
  });
  if (rows.length !== 1) return integrity();
  return row(rows[0]!);
}

function sourceEventBinding(
  connection: SqliteConnection,
  source: SourceRow,
): SourceEventBinding {
  const rows = connection.prepare(`
    SELECT e.event_type, e.event_schema_version, e.payload_json,
           e.event_hash, e.project_id, e.session_id, e.parent_session_id,
           e.stream_id, e.stream_type, e.command_event_index,
           e.command_id, e.idempotency_key, e.lifecycle_intent_json,
           d.command_hash, d.command_type, d.state
    FROM events AS e
    LEFT JOIN command_dedup AS d
      ON d.project_id = e.project_id
      AND d.command_id = e.command_id
      AND d.idempotency_key = e.idempotency_key
    WHERE e.project_id = $projectId
      AND e.global_position = $sourceEventPosition
    LIMIT 2
  `).all({
    $projectId: source.projectId,
    $sourceEventPosition: source.sourceEventPosition,
  });
  if (rows.length !== 1) return integrity();
  const event = rows[0]!;
  const eventType = requiredString(event, "event_type") as LifecycleEventType;
  const eventSchemaVersion = event.event_schema_version;
  const schemaVersion = typeof eventSchemaVersion === "bigint"
    ? Number(eventSchemaVersion)
    : eventSchemaVersion;
  const commandEventIndex = typeof event.command_event_index === "bigint"
    ? Number(event.command_event_index)
    : event.command_event_index;
  if (
    !SOURCE_EVENT_TYPES.has(eventType)
    || (schemaVersion !== 1 && schemaVersion !== 2)
    || requiredString(event, "event_hash") !== source.sourceEventHash
    || requiredString(event, "project_id") !== source.projectId
    || nullableString(event, "session_id") !== source.sessionId
    || event.parent_session_id !== null
    || requiredString(event, "stream_type") !== "session"
    || requiredString(event, "stream_id") !== `session/${source.sessionId}`
    || commandEventIndex !== 0
    || requiredString(event, "command_id") !== source.commandId
    || event.lifecycle_intent_json === null
    || requiredString(event, "state") !== "committed"
    || nullableString(event, "command_hash") !== source.commandHash
  ) return integrity();
  const payloadJson = requiredString(event, "payload_json");
  const payload = canonicalRecord(payloadJson);
  const decodedPayload = decodeLifecycleEventPayload(eventType, schemaVersion, payload) as unknown;
  if (
    typeof decodedPayload !== "object"
    || decodedPayload === null
    || Array.isArray(decodedPayload)
  ) return integrity();
  const intentJson = requiredString(event, "lifecycle_intent_json");
  if (lifecycleIntentHashFromWitnessSource(intentJson) !== source.commandHash) return integrity();
  const witness = decodeLifecycleIntentWitness(intentJson);
  const command = witness.intent.command as unknown as Record<string, unknown>;
  if (
    command.commandId !== source.commandId
    || command.idempotencyKey !== requiredString(event, "idempotency_key")
    || command.commandType !== requiredString(event, "command_type")
  ) return integrity();
  const payloadRecord = decodedPayload as Record<string, unknown>;
  if (
    payloadRecord.workflowId !== source.workflowId
    || payloadRecord.workflowGeneration !== source.workflowGeneration
  ) return integrity();
  return {
    eventType,
    eventSchemaVersion: schemaVersion,
    payload: payloadRecord,
    command,
  };
}

function assertEffectiveStateSource(
  source: SourceRow,
  binding: SourceEventBinding,
): SessionEndEffectiveStateV1 {
  const effectiveState = decodeSessionEndEffectiveStateV1(
    canonicalRecord(source.effectiveStateJson),
  );
  if (
    source.sourceContractVersion !== 1
    || effectiveState.effectiveStateHash !== source.effectiveStateHash
    || effectiveState.request.sessionId !== source.sessionId
    || effectiveState.request.requestVersion !== source.effectiveCheckpointVersion
    || effectiveState.effectiveFinalCheckpoint.checkpointVersion
      !== source.effectiveCheckpointVersion
  ) return integrity();
  if (binding.eventType === "SessionEndRequested") {
    const request = canonicalRecord(canonicalJson(binding.command.request));
    if (
      binding.command.commandType !== "request-session-end"
      || request.requestVersion !== source.effectiveCheckpointVersion
      || binding.eventSchemaVersion !== request.requestVersion
      || canonicalJson(request) !== canonicalJson(effectiveState.request)
      || source.evidenceWindowState !== (
        source.effectiveCheckpointVersion === 1 ? "sealed" : "open"
      )
    ) return integrity();
    return effectiveState;
  }
  if (
    binding.command.commandType !== "amend-session-end"
    || binding.command.sessionId !== source.sessionId
    || binding.command.workflowId !== source.workflowId
    || binding.payload.previousWorkflowGeneration !== source.workflowGeneration - 1
    || binding.payload.workflowGeneration !== source.workflowGeneration
  ) return integrity();
  const amendment = canonicalRecord(canonicalJson(binding.command.amendment));
  if (amendment.amendmentVersion !== binding.eventSchemaVersion) return integrity();
  if (binding.eventSchemaVersion === 1) {
    if (Object.hasOwn(binding.payload, "evidenceWindowAction")) return integrity();
  } else if (binding.payload.evidenceWindowAction !== amendment.evidenceWindowAction) {
    return integrity();
  }
  return effectiveState;
}

function assertAmendmentTransition(
  binding: SourceEventBinding,
  current: SessionEndEffectiveStateV1,
  predecessor: LegacySessionEndEffectiveStateSourceV1,
  currentEvidenceWindowState: "open" | "sealed",
  currentCheckpointVersion: 1 | 2,
): void {
  const amendment = binding.command.amendment;
  if (typeof amendment !== "object" || amendment === null || Array.isArray(amendment)) return integrity();
  const amendmentRecord = amendment as Record<string, unknown>;
  const action = amendmentRecord.amendmentVersion === 1
    ? "unchanged"
    : amendmentRecord.amendmentVersion === 2
      ? amendmentRecord.evidenceWindowAction
      : null;
  const request = current.request;
  const previousRequest = predecessor.effectiveState.request;
  if (
    action !== "unchanged" && action !== "open" && action !== "seal"
  ) return integrity();
  const currentValue = (value: unknown): string => canonicalJson(value);
  if (
    (amendmentRecord.childEndPolicy !== null
      ? amendmentRecord.childEndPolicy !== request.childEndPolicy
      : request.childEndPolicy !== previousRequest.childEndPolicy)
    || (amendmentRecord.finalCheckpoint !== null
      ? currentValue(amendmentRecord.finalCheckpoint) !== currentValue(request.finalCheckpoint)
      : currentValue(request.finalCheckpoint) !== currentValue(previousRequest.finalCheckpoint))
    || (amendmentRecord.validationProfileIds !== null
      ? currentValue(amendmentRecord.validationProfileIds) !== currentValue(request.validationProfileIds)
      : currentValue(request.validationProfileIds) !== currentValue(previousRequest.validationProfileIds))
    || (amendmentRecord.requestedQualityThreshold !== null
      ? amendmentRecord.requestedQualityThreshold !== request.requestedQualityThreshold
      : request.requestedQualityThreshold !== previousRequest.requestedQualityThreshold)
    || (amendmentRecord.requireFullEvidence !== null
      ? amendmentRecord.requireFullEvidence !== request.requireFullEvidence
      : request.requireFullEvidence !== previousRequest.requireFullEvidence)
    || (amendmentRecord.requireMaterialization !== null
      ? amendmentRecord.requireMaterialization !== request.requireMaterialization
      : request.requireMaterialization !== previousRequest.requireMaterialization)
    || !(
      (action === "unchanged"
        && predecessor.evidenceWindowState === currentEvidenceWindowState
        && predecessor.effectiveCheckpointVersion === currentCheckpointVersion)
      || (action === "open"
        && predecessor.evidenceWindowState === "sealed"
        && currentEvidenceWindowState === "open"
        && currentCheckpointVersion === 2)
      || (action === "seal"
        && predecessor.evidenceWindowState === "open"
        && currentEvidenceWindowState === "sealed"
        && currentCheckpointVersion === 2)
    )
  ) return integrity();
}

function validateSource(
  connection: SqliteConnection,
  source: SourceRow,
  visited: ReadonlySet<bigint>,
): LegacySessionEndEffectiveStateSourceV1 {
  if (visited.has(source.sourceEventPosition)) return integrity();
  const nextVisited = new Set(visited);
  nextVisited.add(source.sourceEventPosition);
  const binding = sourceEventBinding(connection, source);
  const effectiveState = assertEffectiveStateSource(source, binding);
  let predecessor: LegacySessionEndEffectiveStateSourceV1 | null = null;
  if (source.workflowGeneration === 1) {
    if (source.predecessorEventPosition !== null || source.predecessorEventHash !== null) return integrity();
  } else {
    if (source.predecessorEventPosition === null || source.predecessorEventHash === null) return integrity();
    const previous = oneSourceRow(
      connection,
      source.projectId,
      source.predecessorEventPosition,
    );
    if (
      previous.sourceEventHash !== source.predecessorEventHash
      || previous.projectId !== source.projectId
      || previous.sessionId !== source.sessionId
      || previous.workflowId !== source.workflowId
      || previous.workflowGeneration !== source.workflowGeneration - 1
    ) return integrity();
    predecessor = validateSource(connection, previous, nextVisited);
    if (binding.eventType !== "SessionEndAmended") return integrity();
    assertAmendmentTransition(
      binding,
      effectiveState,
      predecessor,
      source.evidenceWindowState,
      source.effectiveCheckpointVersion,
    );
  }
  return Object.freeze({
    sourceContractVersion: 1,
    projectId: source.projectId,
    sourceEventPosition: source.sourceEventPosition,
    sourceEventHash: source.sourceEventHash,
    commandId: source.commandId,
    commandHash: source.commandHash,
    sessionId: source.sessionId,
    workflowId: source.workflowId,
    workflowGeneration: source.workflowGeneration,
    effectiveState,
    evidenceWindowState: source.evidenceWindowState,
    effectiveCheckpointVersion: source.effectiveCheckpointVersion,
    predecessorEventPosition: source.predecessorEventPosition,
    predecessorEventHash: source.predecessorEventHash,
  });
}

function inputRow(input: LegacySessionEndEffectiveStateSourceInputV1): SourceRow {
  const effectiveState = decodeSessionEndEffectiveStateV1(input.effectiveState);
  if (
    !UUID.test(input.projectId)
    || !UUID.test(input.sessionId)
    || !UUID.test(input.workflowId)
    || !UUID.test(input.commandId)
    || !LOWER_HASH.test(input.sourceEventHash)
    || !LOWER_HASH.test(input.commandHash)
    || input.sourceEventPosition < 1n
    || input.sourceEventPosition > SQLITE_INT64_MAX
    || !Number.isSafeInteger(input.workflowGeneration)
    || input.workflowGeneration < 1
    || (input.evidenceWindowState !== "open" && input.evidenceWindowState !== "sealed")
    || (input.effectiveCheckpointVersion !== 1 && input.effectiveCheckpointVersion !== 2)
    || (input.predecessorEventPosition !== null
      && (input.predecessorEventPosition < 1n
        || input.predecessorEventPosition >= input.sourceEventPosition))
    || (input.predecessorEventPosition === null) !== (input.predecessorEventHash === null)
    || (input.predecessorEventHash !== null && !LOWER_HASH.test(input.predecessorEventHash))
  ) return integrity();
  if (
    effectiveState.request.sessionId !== input.sessionId
    || effectiveState.request.requestVersion !== input.effectiveCheckpointVersion
    || effectiveState.effectiveFinalCheckpoint.checkpointVersion
      !== input.effectiveCheckpointVersion
    || (input.workflowGeneration === 1 && input.predecessorEventPosition !== null)
    || (input.workflowGeneration > 1 && input.predecessorEventPosition === null)
  ) return integrity();
  return {
    projectId: input.projectId,
    sourceEventPosition: input.sourceEventPosition,
    sourceEventHash: input.sourceEventHash,
    commandId: input.commandId,
    commandHash: input.commandHash,
    sessionId: input.sessionId,
    workflowId: input.workflowId,
    workflowGeneration: input.workflowGeneration,
    effectiveStateJson: canonicalJson(effectiveState),
    effectiveStateHash: effectiveState.effectiveStateHash,
    evidenceWindowState: input.evidenceWindowState,
    effectiveCheckpointVersion: input.effectiveCheckpointVersion,
    predecessorEventPosition: input.predecessorEventPosition,
    predecessorEventHash: input.predecessorEventHash,
    sourceContractVersion: 1,
  };
}

export function persistLegacySessionEndEffectiveStateSourceV1(
  connection: SqliteConnection,
  input: LegacySessionEndEffectiveStateSourceInputV1,
): LegacySessionEndEffectiveStateSourceV1 {
  try {
    const source = inputRow(input);
    const validated = validateSource(connection, source, new Set());
    connection.prepare(`
      INSERT INTO ${TABLE}(
        project_id, source_event_position, source_event_hash,
        command_id, command_hash, session_id, workflow_id,
        workflow_generation, effective_state_json, effective_state_hash,
        evidence_window_state, effective_checkpoint_version,
        predecessor_event_position, predecessor_event_hash,
        source_contract_version
      ) VALUES (
        $projectId, $sourceEventPosition, $sourceEventHash,
        $commandId, $commandHash, $sessionId, $workflowId,
        $workflowGeneration, $effectiveStateJson, $effectiveStateHash,
        $evidenceWindowState, $effectiveCheckpointVersion,
        $predecessorEventPosition, $predecessorEventHash,
        $sourceContractVersion
      )
    `).run({
      $projectId: source.projectId,
      $sourceEventPosition: source.sourceEventPosition,
      $sourceEventHash: source.sourceEventHash,
      $commandId: source.commandId,
      $commandHash: source.commandHash,
      $sessionId: source.sessionId,
      $workflowId: source.workflowId,
      $workflowGeneration: BigInt(source.workflowGeneration),
      $effectiveStateJson: source.effectiveStateJson,
      $effectiveStateHash: source.effectiveStateHash,
      $evidenceWindowState: source.evidenceWindowState,
      $effectiveCheckpointVersion: source.effectiveCheckpointVersion,
      $predecessorEventPosition: source.predecessorEventPosition,
      $predecessorEventHash: source.predecessorEventHash,
      $sourceContractVersion: 1,
    } as SqliteParams);
    return readLegacySessionEndEffectiveStateSourceV1(connection, {
      projectId: source.projectId,
      sourceEventPosition: source.sourceEventPosition,
    });
  } catch (error) {
    if (error instanceof LifecycleError && error.code === "INTEGRITY_FAILURE") throw error;
    return integrity();
  }
}

export function readLegacySessionEndEffectiveStateSourceV1(
  connection: SqliteConnection,
  input: { readonly projectId: string; readonly sourceEventPosition: bigint },
): LegacySessionEndEffectiveStateSourceV1 {
  try {
    if (!UUID.test(input.projectId) || input.sourceEventPosition < 1n) return integrity();
    const source = oneSourceRow(connection, input.projectId, input.sourceEventPosition);
    return validateSource(connection, source, new Set());
  } catch (error) {
    if (error instanceof LifecycleError && error.code === "INTEGRITY_FAILURE") throw error;
    return integrity();
  }
}
