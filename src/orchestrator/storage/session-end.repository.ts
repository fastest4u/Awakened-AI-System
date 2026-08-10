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
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source).sort();
  const expected = [
    "commandId", "idempotencyKey", "profileId", "profileVersion", "resultId", "runId",
  ];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    integrity();
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

/** Strictly decodes the JSON-compatible six-key plan array, including every
 * migration-4 overlay invariant. */
export function decodePersistedValidationPlansV1(
  value: unknown,
): readonly PersistedValidationAttemptPlanV1[] {
  try {
    if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PLANS) integrity();
    const plans = value.map(exactPlan);
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

function assertAmendmentSnapshotCorrelation(
  command: Readonly<Record<string, unknown>>,
  state: SessionEndEffectiveStateV1,
): void {
  if (command.commandType !== "amend-session-end") integrity();
  const amendment = record(command.amendment);
  const request = state.request;
  if (
    amendment.amendmentVersion !== 2
    || (amendment.childEndPolicy !== null && amendment.childEndPolicy !== request.childEndPolicy)
    || (amendment.finalCheckpoint !== null
      && canonicalJson(amendment.finalCheckpoint) !== canonicalJson(request.finalCheckpoint))
    || (amendment.validationProfileIds !== null
      && canonicalJson(amendment.validationProfileIds) !== canonicalJson(request.validationProfileIds))
    || (amendment.requestedQualityThreshold !== null
      && amendment.requestedQualityThreshold !== request.requestedQualityThreshold)
    || (amendment.requireFullEvidence !== null
      && amendment.requireFullEvidence !== request.requireFullEvidence)
    || (amendment.requireMaterialization !== null
      && amendment.requireMaterialization !== request.requireMaterialization)
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
      SELECT fingerprint_schema_version, session_id, trigger_event_position,
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
    const workflow = oneOrNone(connection.prepare(`
      SELECT workflow_id, generation, session_id, triggering_event_position
      FROM workflow_instances
      WHERE project_id = $projectId AND workflow_id = $workflowId
      LIMIT 2
    `).all({ $projectId: input.projectId, $workflowId: input.workflowId }));
    if (event === null || workflow === null || fold === null
      || rowString(event, "session_id") !== input.sessionId
      || rowString(fold, "session_id") !== input.sessionId
      || rowString(workflow, "session_id") !== input.sessionId
      || rowIntegerLike(fold["fingerprint_schema_version"]) !== 2
      || rowIntegerLike(fold["effective_state_version"]) !== 1
      || rowInt64(fold["effective_state_source_event_position"]) !== input.eventPosition
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
    if (record.workflowId !== input.workflowId) integrity();
    const effectiveState = decodeSessionEndEffectiveStateV1(record.effectiveState);
    const eventHash = rowString(event, "event_hash");
    if (
      !/^[0-9a-f]{64}$/u.test(eventHash)
      || effectiveState.effectiveStateHash !== rowString(fold, "effective_state_hash")
    ) integrity();
    const source = rowString(event, "lifecycle_intent_json");
    const witness = decodeLifecycleIntentWitness(source);
    const command = witness.intent.command as Readonly<Record<string, unknown>>;
    if (
      command.commandId !== rowString(event, "command_id")
      || (rowString(event, "event_type") === "SessionEndRequested"
        && canonicalJson(command.request) !== canonicalJson(effectiveState.request))
      || (rowString(event, "event_type") === "SessionEndAmended"
        && (command.commandType !== "amend-session-end"
          || command.sessionId !== input.sessionId
          || command.workflowId !== input.workflowId))
    ) integrity();
    if (rowString(event, "event_type") === "SessionEndAmended") {
      assertAmendmentSnapshotCorrelation(command, effectiveState);
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
