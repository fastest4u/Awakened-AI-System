import { LifecycleError } from "../lifecycle/errors.js";
import {
  SESSION_END_PHASES,
  type SessionEndPhase,
} from "../lifecycle/contracts/session-end.js";
import { decodeLifecycleIntentWitness } from "../lifecycle/lifecycle-intent-witness.js";
import {
  decodeSessionEndEffectiveStateV1,
  type SessionEndEffectiveStateV1,
} from "../lifecycle/session-end-effective-state.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import type { SqliteConnection, SqliteParams, SqliteRow } from "./sqlite-driver.js";

const MAX_PLAN_BYTES = 262_144;
const MAX_PLANS = 64;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const LOWER_HASH = /^[0-9a-f]{64}$/u;
const REQUEST_SNAPSHOT_KEYS = [
  "effectiveState", "previousState", "workflowGeneration", "workflowId",
] as const;
const AMENDMENT_SNAPSHOT_KEYS = [
  "effectiveState", "evidenceWindowAction", "preTransitionCheckpointId",
  "previousWorkflowGeneration", "workflowGeneration", "workflowId",
] as const;
const VALIDATION_PLAN_KEYS = [
  "commandId", "idempotencyKey", "profileId", "profileVersion", "resultId", "runId",
] as const;
const WORKFLOW_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const WORKFLOW_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;
const ACTIVE_WORKFLOW_PHASES = new Set<SessionEndPhase>([
  "requested",
  "children-resolved",
  "final-checkpoint-recorded",
  "ending-materialization-queued",
  "validating",
  "verification-passed",
  "verification-failed",
  "completion-appended",
  "completed-materialization-confirmed",
]);
const EVENTLESS_PHASE_TRANSITIONS = new Map<SessionEndPhase, SessionEndPhase>([
  ["requested", "children-resolved"],
]);

export interface SessionEndWorkflowRecordV1 {
  readonly projectId: string;
  readonly workflowId: string;
  readonly workflowType: "session-end";
  readonly generation: number;
  readonly state: string;
  readonly phase: SessionEndPhase;
  readonly rootCommandId: string;
  readonly resultJson: string | null;
  readonly errorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sessionId: string;
  readonly triggeringEventPosition: bigint;
  readonly expectedAuthorityCommitment: string;
  readonly coordinatorOwnerId: string | null;
  readonly coordinatorClaimToken: bigint | null;
  readonly coordinatorClaimExpiresAt: string | null;
  readonly coordinatorAttemptCount: bigint;
  readonly coordinatorFailureClass: "retryable" | "permanent" | null;
  readonly coordinatorErrorCode: string | null;
  readonly coordinatorNextAttemptAt: string | null;
  readonly validationAttemptPlanGeneration: number | null;
  readonly validationAttemptPlansJson: string | null;
  readonly evidenceFrozenCheckpointEventPosition: bigint | null;
  readonly evidenceFrozenGeneration: number | null;
  readonly evidenceWindowState: "open" | "sealed" | null;
  readonly finalEndingScopeBindingsJson: string | null;
}

export interface SessionEndWorkflowClaimV1 {
  readonly projectId: string;
  readonly workflowId: string;
  readonly sessionId: string;
  readonly workflowGeneration: number;
  readonly phase: SessionEndPhase;
  readonly ownerId: string;
  readonly claimToken: bigint;
  readonly claimExpiresAt: string;
  readonly triggeringEventPosition: bigint;
  readonly attemptCount: number;
}

export interface SessionEndWorkflowClaimNextInputV1 {
  readonly projectId: string;
  readonly ownerId: string;
  readonly observedNowMs: bigint;
  readonly leaseDurationMs: bigint;
}

export interface SessionEndWorkflowClaimInputV1 extends SessionEndWorkflowClaimNextInputV1 {
  readonly workflowId: string;
  readonly workflowGeneration: number;
}

export interface SessionEndWorkflowRenewInputV1 {
  readonly projectId: string;
  readonly workflowId: string;
  readonly workflowGeneration: number;
  readonly ownerId: string;
  readonly claimToken: bigint;
  readonly observedNowMs: bigint;
  readonly leaseDurationMs: bigint;
}

export interface SessionEndWorkflowReleaseInputV1 {
  readonly projectId: string;
  readonly workflowId: string;
  readonly workflowGeneration: number;
  readonly ownerId: string;
  readonly claimToken: bigint;
}

export interface SessionEndWorkflowEventlessPhaseInputV1 {
  readonly projectId: string;
  readonly workflowId: string;
  readonly workflowGeneration: number;
  readonly ownerId: string;
  readonly claimToken: bigint;
  readonly expectedPhase: SessionEndPhase;
  readonly nextPhase: SessionEndPhase;
  readonly observedNowMs: bigint;
}

/** The durable validation-plan shape.  Configuration material deliberately
 * does not cross this storage boundary; Task 15 derives it from the trusted
 * immutable profile registry. */
export interface PersistedValidationAttemptPlanV1 {
  readonly profileId: string;
  readonly profileVersion: number;
  readonly runId: string;
  readonly resultId: string;
  readonly commandId: string;
  readonly idempotencyKey: string;
}

export interface PersistedValidationAttemptPlansWriteV1 {
  readonly projectId: string;
  readonly workflowId: string;
  readonly workflowGeneration: number;
  readonly plans: unknown;
}

function integrity(): never {
  throw new LifecycleError("INTEGRITY_FAILURE");
}

function exactPlan(value: unknown): PersistedValidationAttemptPlanV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) integrity();
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) integrity();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== VALIDATION_PLAN_KEYS.length
    || keys.some((key) => (
      typeof key !== "string" || !VALIDATION_PLAN_KEYS.includes(key as never)
    ))
  ) integrity();
  const source = Object.create(null) as Record<string, unknown>;
  for (const key of VALIDATION_PLAN_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || !("value" in descriptor)
    ) integrity();
    source[key] = descriptor.value;
  }
  const { profileId, profileVersion, runId, resultId, commandId, idempotencyKey } = source;
  if (
    typeof profileId !== "string" || profileId.length === 0
    || typeof profileVersion !== "number" || !Number.isSafeInteger(profileVersion) || profileVersion <= 0
    || typeof runId !== "string" || !UUID.test(runId)
    || typeof resultId !== "string" || !UUID.test(resultId)
    || typeof commandId !== "string" || !UUID.test(commandId)
    || typeof idempotencyKey !== "string" || idempotencyKey.length === 0
  ) integrity();
  return Object.freeze({ profileId, profileVersion, runId, resultId, commandId, idempotencyKey });
}

function exactPlanArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    integrity();
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined
    || !("value" in lengthDescriptor)
    || lengthDescriptor.enumerable !== false
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 1
    || lengthDescriptor.value > MAX_PLANS
  ) integrity();
  const length = lengthDescriptor.value as number;
  if (Reflect.ownKeys(value).length !== length + 1) integrity();
  const items: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || !("value" in descriptor)
    ) integrity();
    items.push(descriptor.value);
  }
  return items;
}

/** Strictly decodes the JSON-compatible six-key plan array, including every
 * migration-4 overlay invariant. */
export function decodePersistedValidationPlansV1(
  value: unknown,
): readonly PersistedValidationAttemptPlanV1[] {
  try {
    const plans = exactPlanArray(value).map(exactPlan);
    if (Buffer.byteLength(canonicalJson(plans), "utf8") > MAX_PLAN_BYTES) integrity();
    const profileKeys = new Set<string>();
    const runIds = new Set<string>();
    const resultIds = new Set<string>();
    const commandIds = new Set<string>();
    const idempotencyKeys = new Set<string>();
    for (let index = 0; index < plans.length; index += 1) {
      const plan = plans[index]!;
      const prior = plans[index - 1];
      if (prior !== undefined) {
        const comparison = Buffer.compare(Buffer.from(prior.profileId, "utf8"), Buffer.from(plan.profileId, "utf8"));
        if (comparison > 0 || (comparison === 0 && prior.profileVersion >= plan.profileVersion)) integrity();
      }
      const profileKey = `${plan.profileId}\u0000${plan.profileVersion}`;
      if (profileKeys.has(profileKey) || runIds.has(plan.runId) || resultIds.has(plan.resultId)
        || commandIds.has(plan.commandId) || idempotencyKeys.has(plan.idempotencyKey)) integrity();
      profileKeys.add(profileKey);
      runIds.add(plan.runId);
      resultIds.add(plan.resultId);
      commandIds.add(plan.commandId);
      idempotencyKeys.add(plan.idempotencyKey);
    }
    return Object.freeze(plans);
  } catch (error) {
    if (error instanceof LifecycleError && error.code === "INTEGRITY_FAILURE") throw error;
    return integrity();
  }
}

function rowString(row: SqliteRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) return integrity();
  return value;
}

function rowGeneration(row: SqliteRow): number {
  const value = row["validation_attempt_plan_generation"];
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) integrity();
  return number;
}

function oneOrNone(rows: SqliteRow[]): SqliteRow | null {
  if (rows.length > 1) integrity();
  return rows[0] ?? null;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) integrity();
  return value as Readonly<Record<string, unknown>>;
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    keys.length !== sortedExpected.length
    || keys.some((key, index) => key !== sortedExpected[index])
  ) integrity();
}

function assertSnapshotPayloadIdentity(
  eventType: string,
  payload: Readonly<Record<string, unknown>>,
  workflowId: string,
  workflowGeneration: number,
): void {
  if (payload.workflowId !== workflowId) integrity();
  if (eventType === "SessionEndRequested") {
    assertExactKeys(payload, REQUEST_SNAPSHOT_KEYS);
    if (
      payload.workflowGeneration !== workflowGeneration
      || (payload.previousState !== "active" && payload.previousState !== "suspended")
    ) integrity();
    return;
  }
  if (eventType !== "SessionEndAmended") integrity();
  assertExactKeys(payload, AMENDMENT_SNAPSHOT_KEYS);
  if (
    payload.workflowGeneration !== workflowGeneration
    || payload.previousWorkflowGeneration !== workflowGeneration - 1
    || typeof payload.preTransitionCheckpointId !== "string"
    || !UUID.test(payload.preTransitionCheckpointId)
    || (payload.evidenceWindowAction !== "unchanged"
      && payload.evidenceWindowAction !== "open"
      && payload.evidenceWindowAction !== "seal")
  ) integrity();
}

function assertAmendmentSnapshotCorrelation(
  command: Readonly<Record<string, unknown>>,
  state: SessionEndEffectiveStateV1,
  predecessor: SessionEndEffectiveStateV1,
  eventAction: unknown,
  predecessorEvidenceWindowState: unknown,
  evidenceWindowState: unknown,
  effectiveCheckpointVersion: unknown,
): void {
  if (command.commandType !== "amend-session-end") integrity();
  const amendment = record(command.amendment);
  const amendmentAction = amendment.amendmentVersion === 1
    ? "unchanged"
    : amendment.amendmentVersion === 2
      ? amendment.evidenceWindowAction
      : null;
  const request = state.request;
  const previousRequest = predecessor.request;
  if (
    amendmentAction === null
    || amendmentAction !== eventAction
    || (amendment.childEndPolicy !== null
      ? amendment.childEndPolicy !== request.childEndPolicy
      : request.childEndPolicy !== previousRequest.childEndPolicy)
    || (amendment.finalCheckpoint !== null
      ? canonicalJson(amendment.finalCheckpoint) !== canonicalJson(request.finalCheckpoint)
      : canonicalJson(request.finalCheckpoint) !== canonicalJson(previousRequest.finalCheckpoint))
    || (amendment.validationProfileIds !== null
      ? canonicalJson(amendment.validationProfileIds) !== canonicalJson(request.validationProfileIds)
      : canonicalJson(request.validationProfileIds) !== canonicalJson(previousRequest.validationProfileIds))
    || (amendment.requestedQualityThreshold !== null
      ? amendment.requestedQualityThreshold !== request.requestedQualityThreshold
      : request.requestedQualityThreshold !== previousRequest.requestedQualityThreshold)
    || (amendment.requireFullEvidence !== null
      ? amendment.requireFullEvidence !== request.requireFullEvidence
      : request.requireFullEvidence !== previousRequest.requireFullEvidence)
    || (amendment.requireMaterialization !== null
      ? amendment.requireMaterialization !== request.requireMaterialization
      : request.requireMaterialization !== previousRequest.requireMaterialization)
    || !(
      (amendmentAction === "unchanged"
        && predecessorEvidenceWindowState === evidenceWindowState)
      || (amendmentAction === "open"
        && predecessorEvidenceWindowState === "sealed"
        && evidenceWindowState === "open"
        && effectiveCheckpointVersion === 2)
      || (amendmentAction === "seal"
        && predecessorEvidenceWindowState === "open"
        && evidenceWindowState === "sealed"
        && effectiveCheckpointVersion === 2)
    )
  ) integrity();
}

export interface StoredValidationAttemptPlansV1 {
  readonly workflowGeneration: number;
  readonly plans: readonly PersistedValidationAttemptPlanV1[];
}

export interface HydratedSessionEndEffectiveStateV1 {
  readonly eventPosition: bigint;
  readonly eventHash: string;
  readonly workflowId: string;
  readonly workflowGeneration: number;
  readonly effectiveState: SessionEndEffectiveStateV1;
}

/** Hydrates a Version-3 snapshot only from the immutable event selected by the
 * immutable generation fold. The mutable workflow row is identity-only. */
export function hydrateSessionEndEffectiveStateV1(
  connection: SqliteConnection,
  input: {
    readonly projectId: string;
    readonly workflowId: string;
    readonly workflowGeneration: number;
    readonly sessionId: string;
    readonly eventPosition: bigint;
  },
): HydratedSessionEndEffectiveStateV1 {
  try {
    if (
      input.projectId.length === 0 || input.workflowId.length === 0 || input.sessionId.length === 0
      || !Number.isSafeInteger(input.workflowGeneration) || input.workflowGeneration <= 0
      || input.eventPosition <= 0n
    ) integrity();
    const fold = oneOrNone(connection.prepare(`
      SELECT workflow_generation, fingerprint_schema_version, session_id, trigger_event_position,
             evidence_window_state, effective_checkpoint_version,
             effective_draft_source_event_position,
             effective_state_source_event_position, effective_state_version,
             effective_state_hash
      FROM lifecycle_workflow_generation_folds
      WHERE project_id = $projectId AND workflow_id = $workflowId
        AND workflow_generation = $workflowGeneration
      LIMIT 2
    `).all({
      $projectId: input.projectId,
      $workflowId: input.workflowId,
      $workflowGeneration: BigInt(input.workflowGeneration),
    }));
    const event = oneOrNone(connection.prepare(`
      SELECT event_type, event_schema_version, payload_json, event_hash,
             session_id, command_id, command_event_index, lifecycle_intent_json
      FROM events
      WHERE project_id = $projectId AND global_position = $eventPosition
      LIMIT 2
    `).all({ $projectId: input.projectId, $eventPosition: input.eventPosition }));
    const sourceFold = oneOrNone(connection.prepare(`
      SELECT workflow_generation, fingerprint_schema_version, session_id,
             evidence_window_state, effective_checkpoint_version,
             effective_draft_source_event_position,
             effective_state_source_event_position, effective_state_version,
             effective_state_hash
      FROM lifecycle_workflow_generation_folds
      WHERE project_id = $projectId AND workflow_id = $workflowId
        AND trigger_event_position = $eventPosition
        AND effective_state_source_event_position = $eventPosition
      LIMIT 2
    `).all({
      $projectId: input.projectId,
      $workflowId: input.workflowId,
      $eventPosition: input.eventPosition,
    }));
    const workflow = oneOrNone(connection.prepare(`
      SELECT workflow_id, generation, session_id, triggering_event_position
      FROM workflow_instances
      WHERE project_id = $projectId AND workflow_id = $workflowId
      LIMIT 2
    `).all({ $projectId: input.projectId, $workflowId: input.workflowId }));
    if (event === null || workflow === null || fold === null || sourceFold === null
      || rowString(event, "session_id") !== input.sessionId
      || rowString(fold, "session_id") !== input.sessionId
      || rowString(workflow, "session_id") !== input.sessionId
      || rowIntegerLike(fold["fingerprint_schema_version"]) !== 2
      || rowIntegerLike(sourceFold["fingerprint_schema_version"]) !== 2
      || rowIntegerLike(fold["effective_state_version"]) !== 1
      || rowIntegerLike(sourceFold["effective_state_version"]) !== 1
      || rowInt64(fold["effective_state_source_event_position"]) !== input.eventPosition
      || rowInt64(sourceFold["effective_state_source_event_position"]) !== input.eventPosition
      || rowIntegerLike(sourceFold["workflow_generation"]) < 1
      || rowIntegerLike(sourceFold["workflow_generation"]) > input.workflowGeneration
      || rowString(sourceFold, "session_id") !== input.sessionId
      || rowString(sourceFold, "effective_state_hash") !== rowString(fold, "effective_state_hash")
      || rowIntegerLike(sourceFold["effective_state_version"])
        !== rowIntegerLike(fold["effective_state_version"])
      || rowIntegerLike(workflow["generation"]) < input.workflowGeneration
      || rowString(workflow, "workflow_id") !== input.workflowId
      || rowIntegerLike(event["event_schema_version"]) !== 3
      || rowIntegerLike(event["command_event_index"]) !== 0
      || (rowString(event, "event_type") !== "SessionEndRequested"
        && rowString(event, "event_type") !== "SessionEndAmended")
    ) integrity();
    let payload: unknown;
    try { payload = JSON.parse(rowString(event, "payload_json")); } catch { return integrity(); }
    if (canonicalJson(payload) !== rowString(event, "payload_json")
      || typeof payload !== "object" || payload === null || Array.isArray(payload)) integrity();
    const record = payload as Record<string, unknown>;
    const eventType = rowString(event, "event_type");
    const sourceGeneration = rowIntegerLike(sourceFold["workflow_generation"]);
    assertSnapshotPayloadIdentity(eventType, record, input.workflowId, sourceGeneration);
    const effectiveState = decodeSessionEndEffectiveStateV1(record.effectiveState);
    const eventHash = rowString(event, "event_hash");
    if (
      !LOWER_HASH.test(eventHash)
      || effectiveState.request.sessionId !== input.sessionId
      || effectiveState.effectiveStateVersion
        !== rowIntegerLike(sourceFold["effective_state_version"])
      || effectiveState.effectiveStateHash !== rowString(sourceFold, "effective_state_hash")
      || effectiveState.effectiveStateHash !== rowString(fold, "effective_state_hash")
    ) integrity();
    const source = rowString(event, "lifecycle_intent_json");
    const witness = decodeLifecycleIntentWitness(source);
    const command = witness.intent.command as Readonly<Record<string, unknown>>;
    if (
      command.commandId !== rowString(event, "command_id")
      || (eventType === "SessionEndRequested"
        && (command.commandType !== "request-session-end"
          || canonicalJson(command.request) !== canonicalJson(effectiveState.request)))
      || (eventType === "SessionEndAmended"
        && (command.commandType !== "amend-session-end"
          || command.sessionId !== input.sessionId
          || command.workflowId !== input.workflowId))
    ) integrity();
    if (eventType === "SessionEndAmended") {
      if (
        sourceGeneration <= 1
        || rowIntegerLike(fold["effective_checkpoint_version"])
          !== rowIntegerLike(sourceFold["effective_checkpoint_version"])
        || rowInt64(fold["effective_draft_source_event_position"])
          !== rowInt64(sourceFold["effective_draft_source_event_position"])
      ) integrity();
      const predecessorFold = oneOrNone(connection.prepare(`
        SELECT workflow_generation, fingerprint_schema_version, session_id,
               trigger_event_position, evidence_window_state,
               effective_state_source_event_position, effective_state_version,
               effective_state_hash
        FROM lifecycle_workflow_generation_folds
        WHERE project_id = $projectId AND workflow_id = $workflowId
          AND workflow_generation = $workflowGeneration
        LIMIT 2
      `).all({
        $projectId: input.projectId,
        $workflowId: input.workflowId,
        $workflowGeneration: BigInt(sourceGeneration - 1),
      }));
      if (predecessorFold === null) integrity();
      const predecessorSourcePosition = rowInt64(
        predecessorFold["effective_state_source_event_position"],
      );
      const predecessorEvent = oneOrNone(connection.prepare(`
        SELECT event_type, event_schema_version, payload_json, event_hash,
               session_id, command_event_index
        FROM events
        WHERE project_id = $projectId AND global_position = $eventPosition
        LIMIT 2
      `).all({
        $projectId: input.projectId,
        $eventPosition: predecessorSourcePosition,
      }));
      const predecessorGeneration = rowIntegerLike(predecessorFold["workflow_generation"]);
      if (
        predecessorEvent === null
        || predecessorGeneration !== sourceGeneration - 1
        || rowIntegerLike(predecessorFold["fingerprint_schema_version"]) !== 2
        || rowString(predecessorFold, "session_id") !== input.sessionId
        || rowInt64(predecessorFold["trigger_event_position"]) !== predecessorSourcePosition
        || rowIntegerLike(predecessorFold["effective_state_version"]) !== 1
        || !LOWER_HASH.test(rowString(predecessorFold, "effective_state_hash"))
        || (rowString(predecessorEvent, "event_type") !== "SessionEndRequested"
          && rowString(predecessorEvent, "event_type") !== "SessionEndAmended")
        || rowIntegerLike(predecessorEvent["event_schema_version"]) !== 3
        || rowString(predecessorEvent, "session_id") !== input.sessionId
        || rowIntegerLike(predecessorEvent["command_event_index"]) !== 0
        || !LOWER_HASH.test(rowString(predecessorEvent, "event_hash"))
      ) integrity();
      let predecessorPayload: unknown;
      try { predecessorPayload = JSON.parse(rowString(predecessorEvent, "payload_json")); } catch { return integrity(); }
      if (
        canonicalJson(predecessorPayload) !== rowString(predecessorEvent, "payload_json")
        || typeof predecessorPayload !== "object" || predecessorPayload === null
        || Array.isArray(predecessorPayload)
      ) integrity();
      const predecessorRecord = predecessorPayload as Readonly<Record<string, unknown>>;
      assertSnapshotPayloadIdentity(
        rowString(predecessorEvent, "event_type"),
        predecessorRecord,
        input.workflowId,
        predecessorGeneration,
      );
      const predecessor = decodeSessionEndEffectiveStateV1(predecessorRecord.effectiveState);
      if (
        predecessor.request.sessionId !== input.sessionId
        || predecessor.effectiveStateVersion
          !== rowIntegerLike(predecessorFold["effective_state_version"])
        || predecessor.effectiveStateHash !== rowString(predecessorFold, "effective_state_hash")
      ) integrity();
      assertAmendmentSnapshotCorrelation(
        command,
        effectiveState,
        predecessor,
        record.evidenceWindowAction,
        rowString(predecessorFold, "evidence_window_state"),
        rowString(sourceFold, "evidence_window_state"),
        rowIntegerLike(sourceFold["effective_checkpoint_version"]),
      );
    }
    return Object.freeze({
      eventPosition: input.eventPosition,
      eventHash,
      workflowId: input.workflowId,
      workflowGeneration: input.workflowGeneration,
      effectiveState,
    });
  } catch (error) {
    if (error instanceof LifecycleError && error.code === "INTEGRITY_FAILURE") throw error;
    return integrity();
  }
}

function rowIntegerLike(value: unknown): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number)) integrity();
  return number;
}

function rowInt64(value: unknown): bigint {
  const bigint = typeof value === "bigint"
    ? value
    : typeof value === "number" && Number.isSafeInteger(value)
      ? BigInt(value)
      : null;
  if (bigint === null || bigint <= 0n || bigint > 9_223_372_036_854_775_807n) integrity();
  return bigint;
}

/** Connection-taking functions deliberately own no transaction: callers keep
 * the surrounding lifecycle command transaction and its lock semantics. */
export function readPersistedValidationAttemptPlansV1(
  connection: SqliteConnection,
  projectId: string,
  workflowId: string,
): StoredValidationAttemptPlansV1 | null {
  try {
    if (projectId.length === 0 || workflowId.length === 0) integrity();
    const row = oneOrNone(connection.prepare(`
      SELECT validation_attempt_plan_generation, validation_attempt_plans_json
      FROM workflow_instances
      WHERE project_id = $projectId AND workflow_id = $workflowId
      LIMIT 2
    `).all({ $projectId: projectId, $workflowId: workflowId }));
    if (row === null) return null;
    const source = rowString(row, "validation_attempt_plans_json");
    let parsed: unknown;
    try { parsed = JSON.parse(source); } catch { return integrity(); }
    if (canonicalJson(parsed) !== source) integrity();
    return Object.freeze({
      workflowGeneration: rowGeneration(row),
      plans: decodePersistedValidationPlansV1(parsed),
    });
  } catch (error) {
    if (error instanceof LifecycleError && error.code === "INTEGRITY_FAILURE") throw error;
    return integrity();
  }
}

export function writePersistedValidationAttemptPlansV1(
  connection: SqliteConnection,
  input: PersistedValidationAttemptPlansWriteV1,
): void {
  try {
    if (!Number.isSafeInteger(input.workflowGeneration) || input.workflowGeneration <= 0) integrity();
    const plans = decodePersistedValidationPlansV1(input.plans);
    const result = connection.prepare(`
      UPDATE workflow_instances
      SET validation_attempt_plan_generation = $workflowGeneration,
          validation_attempt_plans_json = $plansJson
      WHERE project_id = $projectId
        AND workflow_id = $workflowId
        AND generation = $workflowGeneration
        AND validation_attempt_plan_generation IS NULL
        AND validation_attempt_plans_json IS NULL
    `).run({
      $projectId: input.projectId,
      $workflowId: input.workflowId,
      $workflowGeneration: BigInt(input.workflowGeneration),
      $plansJson: canonicalJson(plans),
    } satisfies SqliteParams);
    if (result.changes !== 1n) integrity();
  } catch (error) {
    if (error instanceof LifecycleError && error.code === "INTEGRITY_FAILURE") throw error;
    return integrity();
  }
}

function workflowFailure(): never {
  throw new LifecycleError("INTEGRITY_FAILURE");
}

function workflowInputFailure(field: string): never {
  throw new LifecycleError("LIFECYCLE_INPUT_INVALID", { field });
}

function workflowUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !WORKFLOW_UUID.test(value)) workflowInputFailure(field);
  return value;
}

function workflowOwner(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    workflowInputFailure(field);
  }
  return value;
}

function workflowGeneration(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    workflowInputFailure(field);
  }
  return value;
}

function workflowInt64(value: unknown, field: string, allowZero = false): bigint {
  if (
    typeof value !== "bigint"
    || value < (allowZero ? 0n : 1n)
    || value > SQLITE_INT64_MAX
  ) workflowInputFailure(field);
  return value;
}

function workflowTime(value: bigint, field: string): string {
  workflowInt64(value, field, true);
  if (value > 8_640_000_000_000_000n) workflowInputFailure(field);
  return new Date(Number(value)).toISOString();
}

function workflowLeaseUntil(observedNowMs: bigint, leaseDurationMs: bigint): string {
  workflowInt64(observedNowMs, "observedNowMs", true);
  workflowInt64(leaseDurationMs, "leaseDurationMs");
  const expires = observedNowMs + leaseDurationMs;
  if (expires > 8_640_000_000_000_000n || expires > SQLITE_INT64_MAX) {
    workflowInputFailure("leaseDurationMs");
  }
  return workflowTime(expires, "leaseUntil");
}

function nullableWorkflowText(row: SqliteRow, field: string): string | null {
  const value = row[field];
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0) workflowFailure();
  return value;
}

function workflowRowInt64(
  row: SqliteRow,
  field: string,
  allowNull = false,
  allowZero = false,
): bigint | null {
  const value = row[field];
  if (value === null && allowNull) return null;
  const minimum = allowZero ? 0n : 1n;
  if (typeof value === "bigint" && value >= minimum && value <= SQLITE_INT64_MAX) {
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= Number(minimum)) {
    return BigInt(value);
  }
  workflowFailure();
}

function workflowRowNumber(row: SqliteRow, field: string, allowNull = false): number | null {
  const value = workflowRowInt64(row, field, allowNull);
  if (value === null) return null;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) workflowFailure();
  return Number(value);
}

function workflowTimestamp(value: unknown, field: string, allowNull = false): string | null {
  if (value === null && allowNull) return null;
  if (typeof value !== "string" || !WORKFLOW_TIMESTAMP.test(value)) workflowFailure();
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    workflowFailure();
  }
  return value;
}

function requiredWorkflowTimestamp(row: SqliteRow, field: string): string {
  const value = workflowTimestamp(row[field], field);
  if (value === null) workflowFailure();
  return value;
}

function workflowJson(value: unknown, field: string, allowNull = false): string | null {
  if (value === null && allowNull) return null;
  if (typeof value !== "string") workflowFailure();
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { workflowFailure(); }
  if (canonicalJson(parsed) !== value) workflowFailure();
  return value;
}

function decodeWorkflowRow(row: SqliteRow): SessionEndWorkflowRecordV1 {
  const projectId = rowString(row, "project_id");
  const workflowId = rowString(row, "workflow_id");
  const workflowType = rowString(row, "workflow_type");
  const phase = rowString(row, "phase");
  const state = rowString(row, "state");
  const sessionId = rowString(row, "session_id");
  const generation = workflowRowNumber(row, "generation");
  const triggeringEventPosition = workflowRowInt64(row, "triggering_event_position");
  const coordinatorAttemptCount = workflowRowInt64(row, "coordinator_attempt_count", true, true);
  const validationAttemptPlanGeneration = workflowRowNumber(
    row,
    "validation_attempt_plan_generation",
    true,
  );
  const evidenceFrozenGeneration = workflowRowNumber(row, "evidence_frozen_generation", true);
  if (
    !WORKFLOW_UUID.test(projectId)
    || !WORKFLOW_UUID.test(workflowId)
    || workflowType !== "session-end"
    || generation === null
    || !SESSION_END_PHASES.includes(phase as SessionEndPhase)
    || !WORKFLOW_UUID.test(sessionId)
    || triggeringEventPosition === null
    || coordinatorAttemptCount === null
    || coordinatorAttemptCount > SQLITE_INT64_MAX
    || (evidenceFrozenGeneration !== null && evidenceFrozenGeneration <= 0)
  ) workflowFailure();
  const evidenceWindowState = nullableWorkflowText(row, "evidence_window_state");
  if (evidenceWindowState === null
    || (evidenceWindowState !== "open" && evidenceWindowState !== "sealed")) {
    workflowFailure();
  }
  const coordinatorOwnerId = nullableWorkflowText(row, "coordinator_owner_id");
  const coordinatorClaimToken = workflowRowInt64(row, "coordinator_claim_token", true);
  const coordinatorClaimExpiresAt = workflowTimestamp(
    row["coordinator_claim_expires_at"],
    "coordinator_claim_expires_at",
    true,
  );
  if ((coordinatorOwnerId === null)
    !== (coordinatorClaimToken === null)
    || (coordinatorOwnerId === null) !== (coordinatorClaimExpiresAt === null)) {
    workflowFailure();
  }
  if (coordinatorClaimToken !== null && coordinatorClaimToken > coordinatorAttemptCount) {
    workflowFailure();
  }
  const coordinatorFailureClass = nullableWorkflowText(row, "coordinator_failure_class");
  const coordinatorErrorCode = nullableWorkflowText(row, "coordinator_error_code");
  if (coordinatorFailureClass !== null
    && coordinatorFailureClass !== "retryable"
    && coordinatorFailureClass !== "permanent") workflowFailure();
  const coordinatorNextAttemptAt = workflowTimestamp(
    row["coordinator_next_attempt_at"],
    "coordinator_next_attempt_at",
    true,
  );
  if ((coordinatorFailureClass === null) !== (coordinatorErrorCode === null)
    || (coordinatorFailureClass === null && coordinatorNextAttemptAt !== null)
    || (coordinatorFailureClass === "retryable" && coordinatorNextAttemptAt === null)
    || (coordinatorFailureClass === "permanent" && coordinatorNextAttemptAt !== null)) {
    workflowFailure();
  }
  const validationAttemptPlansJson = workflowJson(
    row["validation_attempt_plans_json"],
    "validation_attempt_plans_json",
    true,
  );
  if ((validationAttemptPlanGeneration === null) !== (validationAttemptPlansJson === null)
    || (validationAttemptPlanGeneration !== null && validationAttemptPlanGeneration !== generation)) {
    workflowFailure();
  }
  const resultJson = workflowJson(row["result_json"], "result_json", true);
  const finalEndingScopeBindingsJson = workflowJson(
    row["final_ending_scope_bindings_json"],
    "final_ending_scope_bindings_json",
    true,
  );
  const frozenCheckpointPosition = workflowRowInt64(
    row,
    "evidence_frozen_checkpoint_event_position",
    true,
  );
  const frozenGroupComplete = frozenCheckpointPosition !== null
    && evidenceFrozenGeneration !== null
    && finalEndingScopeBindingsJson !== null;
  if (
    (frozenCheckpointPosition === null)
      !== (evidenceFrozenGeneration === null)
    || (frozenCheckpointPosition === null) !== (finalEndingScopeBindingsJson === null)
    || (frozenGroupComplete && evidenceWindowState !== "sealed")
  ) workflowFailure();
  return Object.freeze({
    projectId,
    workflowId,
    workflowType: "session-end",
    generation,
    state,
    phase: phase as SessionEndPhase,
    rootCommandId: rowString(row, "root_command_id"),
    resultJson,
    errorCode: nullableWorkflowText(row, "error_code"),
    createdAt: requiredWorkflowTimestamp(row, "created_at"),
    updatedAt: requiredWorkflowTimestamp(row, "updated_at"),
    sessionId,
    triggeringEventPosition,
    expectedAuthorityCommitment: (() => {
      const value = rowString(row, "expected_authority_commitment");
      if (!LOWER_HASH.test(value)) workflowFailure();
      return value;
    })(),
    coordinatorOwnerId,
    coordinatorClaimToken,
    coordinatorClaimExpiresAt,
    coordinatorAttemptCount,
    coordinatorFailureClass,
    coordinatorErrorCode,
    coordinatorNextAttemptAt,
    validationAttemptPlanGeneration,
    validationAttemptPlansJson,
    evidenceFrozenCheckpointEventPosition: frozenCheckpointPosition,
    evidenceFrozenGeneration,
    evidenceWindowState: evidenceWindowState as "open" | "sealed" | null,
    finalEndingScopeBindingsJson,
  });
}

const WORKFLOW_READ_COLUMNS = `
  project_id, workflow_id, workflow_type, generation, state, phase,
  root_command_id, result_json, error_code, created_at, updated_at,
  session_id, triggering_event_position, expected_authority_commitment,
  coordinator_owner_id, coordinator_claim_token, coordinator_claim_expires_at,
  coordinator_attempt_count, coordinator_failure_class, coordinator_error_code,
  coordinator_next_attempt_at, validation_attempt_plan_generation,
  validation_attempt_plans_json, evidence_frozen_checkpoint_event_position,
  evidence_frozen_generation, evidence_window_state, final_ending_scope_bindings_json
`;

function claimFromWorkflow(
  workflow: SessionEndWorkflowRecordV1,
): SessionEndWorkflowClaimV1 | null {
  if (
    workflow.coordinatorOwnerId === null
    || workflow.coordinatorClaimToken === null
    || workflow.coordinatorClaimExpiresAt === null
  ) return null;
  if (workflow.coordinatorAttemptCount > BigInt(Number.MAX_SAFE_INTEGER)) workflowFailure();
  return Object.freeze({
    projectId: workflow.projectId,
    workflowId: workflow.workflowId,
    sessionId: workflow.sessionId,
    workflowGeneration: workflow.generation,
    phase: workflow.phase,
    ownerId: workflow.coordinatorOwnerId,
    claimToken: workflow.coordinatorClaimToken,
    claimExpiresAt: workflow.coordinatorClaimExpiresAt,
    triggeringEventPosition: workflow.triggeringEventPosition,
    attemptCount: Number(workflow.coordinatorAttemptCount),
  });
}

const ACTIVE_PHASE_SQL = [...ACTIVE_WORKFLOW_PHASES].map((phase) => `'${phase}'`).join(", ");

function changed(result: { readonly changes: bigint }): boolean {
  return result.changes === 1n || (result.changes as unknown) === 1;
}

/** Storage-only, connection-bound operations for the session-end workflow row. */
export class SessionEndWorkflowRepository {
  readonly #connection: SqliteConnection;

  constructor(connection: SqliteConnection) {
    this.#connection = connection;
  }

  read(projectId: string, workflowId: string): SessionEndWorkflowRecordV1 | null {
    workflowUuid(projectId, "projectId");
    workflowUuid(workflowId, "workflowId");
    const rows = this.#connection.prepare(`
      SELECT ${WORKFLOW_READ_COLUMNS}
      FROM workflow_instances
      WHERE project_id = $projectId AND workflow_id = $workflowId
      LIMIT 2
    `).all({ $projectId: projectId, $workflowId: workflowId });
    const row = oneOrNone(rows);
    return row === null ? null : decodeWorkflowRow(row);
  }

  claimNext(input: SessionEndWorkflowClaimNextInputV1): SessionEndWorkflowClaimV1 | null {
    workflowUuid(input.projectId, "projectId");
    workflowOwner(input.ownerId, "ownerId");
    workflowTime(input.observedNowMs, "observedNowMs");
    workflowLeaseUntil(input.observedNowMs, input.leaseDurationMs);
    const candidates = this.#connection.prepare(`
      SELECT workflow_id, generation
      FROM workflow_instances
      WHERE project_id = $projectId
        AND workflow_type = 'session-end'
        AND state = 'active'
        AND session_id IS NOT NULL
        AND phase IN (${ACTIVE_PHASE_SQL})
        AND (coordinator_owner_id IS NULL OR coordinator_claim_expires_at <= $observedAt)
        AND (coordinator_next_attempt_at IS NULL OR coordinator_next_attempt_at <= $observedAt)
      ORDER BY triggering_event_position ASC, workflow_id COLLATE BINARY ASC
      LIMIT 1
    `).all({
      $projectId: input.projectId,
      $observedAt: workflowTime(input.observedNowMs, "observedNowMs"),
    });
    const candidate = candidates[0] ?? null;
    if (candidate === null) return null;
    const workflowId = workflowUuid(candidate.workflow_id, "workflowId");
    const generation = workflowRowNumber(candidate, "generation");
    if (generation === null) workflowFailure();
    return this.claim({
      ...input,
      workflowId,
      workflowGeneration: generation,
    });
  }

  claim(input: SessionEndWorkflowClaimInputV1): SessionEndWorkflowClaimV1 | null {
    workflowUuid(input.projectId, "projectId");
    workflowUuid(input.workflowId, "workflowId");
    workflowGeneration(input.workflowGeneration, "workflowGeneration");
    workflowOwner(input.ownerId, "ownerId");
    workflowInt64(input.observedNowMs, "observedNowMs", true);
    const observedAt = workflowTime(input.observedNowMs, "observedNowMs");
    const claimExpiresAt = workflowLeaseUntil(input.observedNowMs, input.leaseDurationMs);
    const result = this.#connection.prepare(`
      UPDATE workflow_instances
      SET coordinator_owner_id = $ownerId,
          coordinator_claim_token = coordinator_attempt_count + 1,
          coordinator_claim_expires_at = $claimExpiresAt,
          coordinator_attempt_count = coordinator_attempt_count + 1,
          coordinator_failure_class = NULL,
          coordinator_error_code = NULL,
          coordinator_next_attempt_at = NULL,
          updated_at = $updatedAt
      WHERE project_id = $projectId
        AND workflow_id = $workflowId
        AND workflow_type = 'session-end'
        AND generation = $workflowGeneration
        AND state = 'active'
        AND session_id IS NOT NULL
        AND phase IN (${ACTIVE_PHASE_SQL})
        AND coordinator_attempt_count < $maxInt64
        AND (coordinator_owner_id IS NULL OR coordinator_claim_expires_at <= $observedAt)
    `).run({
      $projectId: input.projectId,
      $workflowId: input.workflowId,
      $workflowGeneration: BigInt(input.workflowGeneration),
      $ownerId: input.ownerId,
      $claimExpiresAt: claimExpiresAt,
      $updatedAt: observedAt,
      $maxInt64: SQLITE_INT64_MAX,
      $observedAt: observedAt,
    });
    if (!changed(result)) return null;
    return claimFromWorkflow(this.read(input.projectId, input.workflowId)!);
  }

  renew(input: SessionEndWorkflowRenewInputV1): SessionEndWorkflowClaimV1 | null {
    workflowUuid(input.projectId, "projectId");
    workflowUuid(input.workflowId, "workflowId");
    workflowGeneration(input.workflowGeneration, "workflowGeneration");
    workflowOwner(input.ownerId, "ownerId");
    workflowInt64(input.claimToken, "claimToken");
    const observedAt = workflowTime(input.observedNowMs, "observedNowMs");
    const claimExpiresAt = workflowLeaseUntil(input.observedNowMs, input.leaseDurationMs);
    const result = this.#connection.prepare(`
      UPDATE workflow_instances
      SET coordinator_claim_expires_at = $claimExpiresAt,
          updated_at = $updatedAt
      WHERE project_id = $projectId AND workflow_id = $workflowId
        AND workflow_type = 'session-end' AND generation = $workflowGeneration
        AND coordinator_owner_id = $ownerId
        AND coordinator_claim_token = $claimToken
        AND coordinator_claim_expires_at > $observedAt
        AND phase IN (${ACTIVE_PHASE_SQL})
    `).run({
      $projectId: input.projectId,
      $workflowId: input.workflowId,
      $workflowGeneration: BigInt(input.workflowGeneration),
      $ownerId: input.ownerId,
      $claimToken: input.claimToken,
      $claimExpiresAt: claimExpiresAt,
      $updatedAt: observedAt,
      $observedAt: observedAt,
    });
    if (!changed(result)) return null;
    return claimFromWorkflow(this.read(input.projectId, input.workflowId)!);
  }

  release(input: SessionEndWorkflowReleaseInputV1): boolean {
    workflowUuid(input.projectId, "projectId");
    workflowUuid(input.workflowId, "workflowId");
    workflowGeneration(input.workflowGeneration, "workflowGeneration");
    workflowOwner(input.ownerId, "ownerId");
    workflowInt64(input.claimToken, "claimToken");
    const result = this.#connection.prepare(`
      UPDATE workflow_instances
      SET coordinator_owner_id = NULL,
          coordinator_claim_token = NULL,
          coordinator_claim_expires_at = NULL,
          updated_at = updated_at
      WHERE project_id = $projectId AND workflow_id = $workflowId
        AND workflow_type = 'session-end' AND generation = $workflowGeneration
        AND coordinator_owner_id = $ownerId
        AND coordinator_claim_token = $claimToken
    `).run({
      $projectId: input.projectId,
      $workflowId: input.workflowId,
      $workflowGeneration: BigInt(input.workflowGeneration),
      $ownerId: input.ownerId,
      $claimToken: input.claimToken,
    });
    return changed(result);
  }

  advanceEventlessPhase(input: SessionEndWorkflowEventlessPhaseInputV1): boolean {
    workflowUuid(input.projectId, "projectId");
    workflowUuid(input.workflowId, "workflowId");
    workflowGeneration(input.workflowGeneration, "workflowGeneration");
    workflowOwner(input.ownerId, "ownerId");
    workflowInt64(input.claimToken, "claimToken");
    workflowTime(input.observedNowMs, "observedNowMs");
    if (!ACTIVE_WORKFLOW_PHASES.has(input.expectedPhase)
      || !SESSION_END_PHASES.includes(input.nextPhase)
      || EVENTLESS_PHASE_TRANSITIONS.get(input.expectedPhase) !== input.nextPhase) {
      workflowInputFailure("phase");
    }
    const result = this.#connection.prepare(`
      UPDATE workflow_instances
      SET phase = $nextPhase,
          coordinator_owner_id = NULL,
          coordinator_claim_token = NULL,
          coordinator_claim_expires_at = NULL,
          updated_at = $updatedAt
      WHERE project_id = $projectId AND workflow_id = $workflowId
        AND workflow_type = 'session-end' AND generation = $workflowGeneration
        AND phase = $expectedPhase
        AND coordinator_owner_id = $ownerId
        AND coordinator_claim_token = $claimToken
        AND coordinator_claim_expires_at > $observedAt
    `).run({
      $projectId: input.projectId,
      $workflowId: input.workflowId,
      $workflowGeneration: BigInt(input.workflowGeneration),
      $expectedPhase: input.expectedPhase,
      $nextPhase: input.nextPhase,
      $ownerId: input.ownerId,
      $claimToken: input.claimToken,
      $updatedAt: workflowTime(input.observedNowMs, "observedNowMs"),
      $observedAt: workflowTime(input.observedNowMs, "observedNowMs"),
    });
    return changed(result);
  }

  readPersistedValidationAttemptPlansV1(
    projectId: string,
    workflowId: string,
  ): StoredValidationAttemptPlansV1 | null {
    return readPersistedValidationAttemptPlansV1(this.#connection, projectId, workflowId);
  }

  writePersistedValidationAttemptPlansV1(
    input: PersistedValidationAttemptPlansWriteV1,
  ): void {
    writePersistedValidationAttemptPlansV1(this.#connection, input);
  }
}

/** A small bound facade for a transaction that has already been opened by its
 * caller. It has no begin/commit/rollback methods by design. */
export class BoundSessionEndRepository {
  readonly #connection: SqliteConnection;

  constructor(connection: SqliteConnection) { this.#connection = connection; }

  readPersistedValidationAttemptPlansV1(projectId: string, workflowId: string) {
    return readPersistedValidationAttemptPlansV1(this.#connection, projectId, workflowId);
  }

  hydrateSessionEndEffectiveStateV1(input: {
    readonly projectId: string;
    readonly workflowId: string;
    readonly workflowGeneration: number;
    readonly sessionId: string;
    readonly eventPosition: bigint;
  }): HydratedSessionEndEffectiveStateV1 {
    return hydrateSessionEndEffectiveStateV1(this.#connection, input);
  }

  writePersistedValidationAttemptPlansV1(input: {
    readonly projectId: string;
    readonly workflowId: string;
    readonly workflowGeneration: number;
    readonly plans: unknown;
  }): void {
    writePersistedValidationAttemptPlansV1(this.#connection, input);
  }
}
