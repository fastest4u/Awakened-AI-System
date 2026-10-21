import type { StoredEvent } from "../contracts/event.js";
import {
  decodeValidationResultV1,
  type ValidationResultV1,
} from "../lifecycle/contracts/session-end.js";
import { parseCanonicalTimestamp, parseCanonicalUuid } from "../lifecycle/contracts/identifiers.js";
import { LifecycleError } from "../lifecycle/errors.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import type { SqliteConnection, SqliteRow, SqliteValue } from "./sqlite-driver.js";

const LOWER_HASH = /^[0-9a-f]{64}$/u;
const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;

const RESULT_COLUMNS = [
  "project_id",
  "vault_id",
  "store_id",
  "workspace_id",
  "session_id",
  "result_id",
  "validation_result_version",
  "workflow_id",
  "workflow_generation",
  "profile_id",
  "profile_version",
  "profile_configuration_hash",
  "run_id",
  "runner_id",
  "final_checkpoint_id",
  "final_checkpoint_fingerprint",
  "validation_start_scope_version",
  "validation_start_project_id",
  "validation_start_workspace_id",
  "validation_start_branch_ref",
  "validation_start_head_commit",
  "validation_start_dirty_fingerprint",
  "validation_completion_scope_version",
  "validation_completion_project_id",
  "validation_completion_workspace_id",
  "validation_completion_branch_ref",
  "validation_completion_head_commit",
  "validation_completion_dirty_fingerprint",
  "started_at",
  "completed_at",
  "status",
  "exit_classification",
  "redacted_summary",
  "output_fingerprint_algorithm",
  "output_fingerprint_schema_version",
  "output_fingerprint_key_id",
  "output_fingerprint_domain",
  "output_fingerprint_value",
  "artifact_references_json",
  "fresh",
  "recorded_event_position",
  "created_at",
] as const;

const EVENT_COLUMNS = ["event_type", "payload_json"] as const;

function invalid(): never {
  throw new LifecycleError("SESSION_VALIDATION_RESULT_INVALID");
}

function integrity(): never {
  throw new LifecycleError("INTEGRITY_FAILURE");
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.length
    || keys.some((key) => typeof key !== "string" || !expected.includes(key))
  ) invalid();
}

function requiredText(row: SqliteRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) integrity();
  return value;
}

function nullableText(row: SqliteRow, field: string): string | null {
  const value = row[field];
  if (value === null) return null;
  if (typeof value !== "string") integrity();
  return value;
}

function positiveInteger(value: SqliteValue, field: string): number {
  const numeric = typeof value === "bigint"
    ? value
    : typeof value === "number" && Number.isSafeInteger(value)
      ? BigInt(value)
      : null;
  if (numeric === null || numeric < 1n || numeric > BigInt(Number.MAX_SAFE_INTEGER)) integrity();
  void field;
  return Number(numeric);
}

function sqliteInteger(value: SqliteValue, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  void field;
  return integrity();
}

function eventPosition(value: unknown): bigint {
  if (typeof value !== "bigint" || value < 1n || value > SQLITE_INT64_MAX) invalid();
  return value;
}

function readEvent(
  connection: SqliteConnection,
  position: bigint,
): { readonly eventType: string; readonly payload: Record<string, unknown> } {
  const row = connection.prepare(`
    SELECT ${EVENT_COLUMNS.join(", ")}
    FROM events
    WHERE global_position = $position
  `).get({ $position: position });
  if (row === undefined) integrity();
  const keys = Reflect.ownKeys(row);
  if (
    keys.length !== EVENT_COLUMNS.length
    || keys.some((key) => typeof key !== "string" || !EVENT_COLUMNS.includes(key as never))
  ) integrity();
  const eventType = row.event_type;
  const payloadJson = row.payload_json;
  if (typeof eventType !== "string" || typeof payloadJson !== "string") integrity();
  let decoded: unknown;
  try {
    decoded = JSON.parse(payloadJson) as unknown;
    if (canonicalJson(decoded) !== payloadJson) integrity();
  } catch {
    integrity();
  }
  if (!plainRecord(decoded)) integrity();
  return Object.freeze({ eventType, payload: decoded });
}

function validationPayload(
  value: unknown,
): { readonly workflowId: string; readonly workflowGeneration: number; readonly plannedWorkId: string; readonly result: ValidationResultV1 } {
  if (!plainRecord(value)) invalid();
  exactKeys(value, ["workflowId", "workflowGeneration", "plannedWorkId", "validationResult"]);
  const workflowId = value.workflowId;
  const workflowGeneration = value.workflowGeneration;
  const plannedWorkId = value.plannedWorkId;
  if (
    typeof workflowId !== "string"
    || typeof workflowGeneration !== "number"
    || !Number.isSafeInteger(workflowGeneration)
    || workflowGeneration < 1
    || typeof plannedWorkId !== "string"
    || !LOWER_HASH.test(plannedWorkId)
  ) invalid();
  return Object.freeze({
    workflowId,
    workflowGeneration,
    plannedWorkId,
    result: decodeValidationResultV1(value.validationResult),
  });
}

function assertEventBinding(
  result: ValidationResultV1,
  event: StoredEvent,
): void {
  if (
    event.eventType !== "SessionValidationResultRecorded"
    || event.eventSchemaVersion !== 1
    || event.globalPosition < 1n
    || event.globalPosition > SQLITE_INT64_MAX
    || event.recordedAt !== parseCanonicalTimestamp(event.recordedAt, "event.recordedAt")
    || event.projectId !== result.projectId
    || event.vaultId !== result.vaultId
    || event.storeId !== result.storeId
    || event.workspaceId !== result.workspaceId
    || event.sessionId !== result.sessionId
  ) invalid();
  const payload = validationPayload(event.payload);
  if (
    payload.workflowId !== result.workflowId
    || payload.workflowGeneration !== result.workflowGeneration
    || payload.result.resultId !== result.resultId
    || canonicalJson(payload.result) !== canonicalJson(result)
  ) invalid();
}

function assertStoredPayloadBinding(
  result: ValidationResultV1,
  event: { readonly eventType: string; readonly payload: Record<string, unknown> },
): void {
  if (event.eventType !== "SessionValidationResultRecorded") integrity();
  const payload = validationPayload(event.payload);
  if (
    payload.workflowId !== result.workflowId
    || payload.workflowGeneration !== result.workflowGeneration
    || payload.result.resultId !== result.resultId
    || canonicalJson(payload.result) !== canonicalJson(result)
  ) integrity();
}

function decodeRow(row: SqliteRow): ValidationResultV1 {
  try {
    const artifactJson = requiredText(row, "artifact_references_json");
    const artifacts = JSON.parse(artifactJson) as unknown;
    if (canonicalJson(artifacts) !== artifactJson || !Array.isArray(artifacts)) integrity();
    const freshValue = typeof row.fresh === "bigint"
      ? row.fresh
      : typeof row.fresh === "number" && Number.isSafeInteger(row.fresh)
        ? BigInt(row.fresh)
        : null;
    if (freshValue === null || (freshValue !== 0n && freshValue !== 1n)) integrity();
    return decodeValidationResultV1({
      validationResultVersion: positiveInteger(row.validation_result_version, "validation_result_version"),
      resultId: requiredText(row, "result_id"),
      projectId: requiredText(row, "project_id"),
      vaultId: requiredText(row, "vault_id"),
      storeId: requiredText(row, "store_id"),
      workspaceId: requiredText(row, "workspace_id"),
      sessionId: requiredText(row, "session_id"),
      workflowId: requiredText(row, "workflow_id"),
      workflowGeneration: positiveInteger(row.workflow_generation, "workflow_generation"),
      finalCheckpointId: requiredText(row, "final_checkpoint_id"),
      finalCheckpointFingerprint: requiredText(row, "final_checkpoint_fingerprint"),
      profileId: requiredText(row, "profile_id"),
      profileVersion: positiveInteger(row.profile_version, "profile_version"),
      profileConfigurationHash: requiredText(row, "profile_configuration_hash"),
      runId: requiredText(row, "run_id"),
      runnerId: requiredText(row, "runner_id"),
      sourceStateAtStart: {
        sourceStateScopeVersion: positiveInteger(row.validation_start_scope_version, "validation_start_scope_version"),
        workspaceId: requiredText(row, "validation_start_workspace_id"),
        branchRef: nullableText(row, "validation_start_branch_ref"),
        headCommit: nullableText(row, "validation_start_head_commit"),
        dirtyWorktreeFingerprint: requiredText(row, "validation_start_dirty_fingerprint"),
      },
      sourceStateAtCompletion: {
        sourceStateScopeVersion: positiveInteger(
          row.validation_completion_scope_version,
          "validation_completion_scope_version",
        ),
        workspaceId: requiredText(row, "validation_completion_workspace_id"),
        branchRef: nullableText(row, "validation_completion_branch_ref"),
        headCommit: nullableText(row, "validation_completion_head_commit"),
        dirtyWorktreeFingerprint: requiredText(row, "validation_completion_dirty_fingerprint"),
      },
      startedAt: requiredText(row, "started_at"),
      completedAt: requiredText(row, "completed_at"),
      status: requiredText(row, "status"),
      exitClassification: requiredText(row, "exit_classification"),
      summary: requiredText(row, "redacted_summary"),
      outputFingerprint: {
        fingerprintSchemaVersion: positiveInteger(
          row.output_fingerprint_schema_version,
          "output_fingerprint_schema_version",
        ),
        fingerprintKeyId: requiredText(row, "output_fingerprint_key_id"),
        fingerprintDomain: requiredText(row, "output_fingerprint_domain"),
        fingerprint: requiredText(row, "output_fingerprint_value"),
      },
      artifactReferences: artifacts,
      fresh: freshValue === 1n,
    });
  } catch (error) {
    if (error instanceof LifecycleError && error.code === "INTEGRITY_FAILURE") throw error;
    integrity();
  }
}

function rowForResult(
  result: ValidationResultV1,
  recordedEventPosition: bigint,
  createdAt: string,
): Record<`$${string}`, SqliteValue> {
  const start = result.sourceStateAtStart;
  const completion = result.sourceStateAtCompletion;
  return {
    $projectId: result.projectId,
    $vaultId: result.vaultId,
    $storeId: result.storeId,
    $workspaceId: result.workspaceId,
    $sessionId: result.sessionId,
    $resultId: result.resultId,
    $validationResultVersion: BigInt(result.validationResultVersion),
    $workflowId: result.workflowId,
    $workflowGeneration: BigInt(result.workflowGeneration),
    $profileId: result.profileId,
    $profileVersion: BigInt(result.profileVersion),
    $profileConfigurationHash: result.profileConfigurationHash,
    $runId: result.runId,
    $runnerId: result.runnerId,
    $finalCheckpointId: result.finalCheckpointId,
    $finalCheckpointFingerprint: result.finalCheckpointFingerprint,
    $validationStartScopeVersion: BigInt(start.sourceStateScopeVersion),
    $validationStartProjectId: result.projectId,
    $validationStartWorkspaceId: start.workspaceId,
    $validationStartBranchRef: start.branchRef,
    $validationStartHeadCommit: start.headCommit,
    $validationStartDirtyFingerprint: start.dirtyWorktreeFingerprint,
    $validationCompletionScopeVersion: BigInt(completion.sourceStateScopeVersion),
    $validationCompletionProjectId: result.projectId,
    $validationCompletionWorkspaceId: completion.workspaceId,
    $validationCompletionBranchRef: completion.branchRef,
    $validationCompletionHeadCommit: completion.headCommit,
    $validationCompletionDirtyFingerprint: completion.dirtyWorktreeFingerprint,
    $startedAt: result.startedAt,
    $completedAt: result.completedAt,
    $status: result.status,
    $exitClassification: result.exitClassification,
    $redactedSummary: result.summary,
    $outputFingerprintAlgorithm: "hmac-sha256",
    $outputFingerprintSchemaVersion: BigInt(result.outputFingerprint.fingerprintSchemaVersion),
    $outputFingerprintKeyId: result.outputFingerprint.fingerprintKeyId,
    $outputFingerprintDomain: result.outputFingerprint.fingerprintDomain,
    $outputFingerprintValue: result.outputFingerprint.fingerprint,
    $artifactReferencesJson: canonicalJson(result.artifactReferences),
    $fresh: result.fresh ? 1n : 0n,
    $recordedEventPosition: recordedEventPosition,
    $createdAt: createdAt,
  };
}

function rowResult(connection: SqliteConnection, projectId: string, resultId: string): SqliteRow | null {
  const row = connection.prepare(`
    SELECT ${RESULT_COLUMNS.join(", ")}
    FROM lifecycle_validation_results
    WHERE project_id = $projectId AND result_id = $resultId
  `).get({ $projectId: projectId, $resultId: resultId });
  return row ?? null;
}

function rowResultByEventPosition(connection: SqliteConnection, position: bigint): SqliteRow | null {
  const row = connection.prepare(`
    SELECT ${RESULT_COLUMNS.join(", ")}
    FROM lifecycle_validation_results
    WHERE recorded_event_position = $position
  `).all({ $position: position });
  if (row.length > 1) integrity();
  return row[0] ?? null;
}

export class LifecycleValidationResultRepository {
  record(
    connection: SqliteConnection,
    input: ValidationResultV1,
    event: StoredEvent,
  ): void {
    const result = decodeValidationResultV1(input);
    assertEventBinding(result, event);
    const existing = rowResult(connection, result.projectId, result.resultId);
    if (existing !== null) {
      const hydrated = decodeRow(existing);
      const boundEvent = readEvent(connection, event.globalPosition);
      assertStoredPayloadBinding(hydrated, boundEvent);
      if (
        canonicalJson(hydrated) !== canonicalJson(result)
        || sqliteInteger(existing.recorded_event_position, "recorded_event_position") !== event.globalPosition
        || existing.created_at !== event.recordedAt
      ) integrity();
      return;
    }
    if (rowResultByEventPosition(connection, event.globalPosition) !== null) integrity();
    const params = rowForResult(result, eventPosition(event.globalPosition), event.recordedAt);
    try {
      const write = connection.prepare(`
        INSERT INTO lifecycle_validation_results(
          project_id, vault_id, store_id, workspace_id, session_id, result_id,
          validation_result_version, workflow_id, workflow_generation, profile_id,
          profile_version, profile_configuration_hash, run_id, runner_id,
          final_checkpoint_id, final_checkpoint_fingerprint,
          validation_start_scope_version, validation_start_project_id,
          validation_start_workspace_id, validation_start_branch_ref,
          validation_start_head_commit, validation_start_dirty_fingerprint,
          validation_completion_scope_version, validation_completion_project_id,
          validation_completion_workspace_id, validation_completion_branch_ref,
          validation_completion_head_commit, validation_completion_dirty_fingerprint,
          started_at, completed_at, status, exit_classification, redacted_summary,
          output_fingerprint_algorithm, output_fingerprint_schema_version,
          output_fingerprint_key_id, output_fingerprint_domain, output_fingerprint_value,
          artifact_references_json, fresh, recorded_event_position, created_at
        ) VALUES (
          $projectId, $vaultId, $storeId, $workspaceId, $sessionId, $resultId,
          $validationResultVersion, $workflowId, $workflowGeneration, $profileId,
          $profileVersion, $profileConfigurationHash, $runId, $runnerId,
          $finalCheckpointId, $finalCheckpointFingerprint,
          $validationStartScopeVersion, $validationStartProjectId,
          $validationStartWorkspaceId, $validationStartBranchRef,
          $validationStartHeadCommit, $validationStartDirtyFingerprint,
          $validationCompletionScopeVersion, $validationCompletionProjectId,
          $validationCompletionWorkspaceId, $validationCompletionBranchRef,
          $validationCompletionHeadCommit, $validationCompletionDirtyFingerprint,
          $startedAt, $completedAt, $status, $exitClassification, $redactedSummary,
          $outputFingerprintAlgorithm, $outputFingerprintSchemaVersion,
          $outputFingerprintKeyId, $outputFingerprintDomain, $outputFingerprintValue,
          $artifactReferencesJson, $fresh, $recordedEventPosition, $createdAt
        )
      `).run(params);
      if (write.changes !== 1n && (write.changes as unknown) !== 1) integrity();
    } catch (error) {
      if (error instanceof LifecycleError) throw error;
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
  }

  get(
    connection: SqliteConnection,
    projectId: string,
    resultId: string,
  ): ValidationResultV1 | null {
    parseCanonicalUuid(projectId, "projectId");
    parseCanonicalUuid(resultId, "resultId");
    const row = rowResult(connection, projectId, resultId);
    if (row === null) return null;
    const result = decodeRow(row);
    const position = row.recorded_event_position;
    const normalizedPosition = sqliteInteger(position, "recorded_event_position");
    if (normalizedPosition < 1n) integrity();
    assertStoredPayloadBinding(result, readEvent(connection, normalizedPosition));
    return result;
  }

  list(
    connection: SqliteConnection,
    input: {
      readonly projectId: string;
      readonly workflowId: string;
      readonly workflowGeneration: number;
    },
  ): readonly ValidationResultV1[] {
    parseCanonicalUuid(input.projectId, "projectId");
    parseCanonicalUuid(input.workflowId, "workflowId");
    if (!Number.isSafeInteger(input.workflowGeneration) || input.workflowGeneration < 1) invalid();
    const rows = connection.prepare(`
      SELECT ${RESULT_COLUMNS.join(", ")}
      FROM lifecycle_validation_results
      WHERE project_id = $projectId
        AND workflow_id = $workflowId
        AND workflow_generation = $workflowGeneration
      ORDER BY profile_id, profile_version
    `).all({
      $projectId: input.projectId,
      $workflowId: input.workflowId,
      $workflowGeneration: BigInt(input.workflowGeneration),
    });
    return Object.freeze(rows.map((row) => {
      const result = decodeRow(row);
      const position = row.recorded_event_position;
      const normalizedPosition = sqliteInteger(position, "recorded_event_position");
      if (normalizedPosition < 1n) integrity();
      assertStoredPayloadBinding(result, readEvent(connection, normalizedPosition));
      return result;
    }));
  }
}
