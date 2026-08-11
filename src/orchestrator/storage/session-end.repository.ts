import { LifecycleError } from "../lifecycle/errors.js";
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
  input: {
    readonly projectId: string;
    readonly workflowId: string;
    readonly workflowGeneration: number;
    readonly plans: unknown;
  },
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
