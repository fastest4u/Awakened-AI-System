import { createHash } from "node:crypto";
import type {
  AppendCommand,
  AppendResult,
  JsonValue,
  LifecycleReplayExpectation,
  PersistedLifecycleAuthorizationRecord,
} from "../contracts/event.js";
import type { ProjectContext } from "../identity/contracts.js";
import type {
  EventAppendBatch,
  EventAppendReplay,
  PlannedEventAppend,
  PreparedEventAppend,
} from "../storage/event-append-transaction.js";
import {
  isPrimarySqliteBusy,
  matchesLifecycleReplayAuthorization,
} from "../storage/event-append-transaction.js";
import type { SqliteConnection } from "../storage/sqlite-driver.js";
import { LifecycleValidationResultRepository } from "../storage/lifecycle-validation-result.repository.js";
import type {
  EvidenceCoverageBatchInput,
  PreparedEvidenceCoverageBatch,
} from "../storage/evidence-coverage.repository.js";
import { EvidenceCoverageRepository } from "../storage/evidence-coverage.repository.js";
import type {
  LifecycleProjectionWriter,
} from "../storage/lifecycle-projection.repository.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import type { StoredEvent } from "../contracts/event.js";
import type {
  MinimumCheckpointCapacityInput,
  MinimumEndingScopeCapacityInput,
} from "./checkpoint-capacity.js";
import type { SessionEndWorkflowOperations } from "../storage/lifecycle-storage.types.js";
import type { CheckpointEvidenceCoverageV2 } from "./contracts/checkpoint.js";
import {
  decodeLifecycleEventPayload,
  type EvidenceCoverageRecordedV2,
  type SessionCheckpointRecordedPayloadV3,
} from "./contracts/events.js";
import {
  decodeFinalEndingScopeBindingsV1,
  type ValidationResultV1,
} from "./contracts/session-end.js";
import type { SessionId, WorkflowId } from "./contracts/identifiers.js";
import { sessionEndWorkflowId } from "./session-end-identifiers.js";
import type {
  InternalWorkflowPhasePlan,
  InternalWorkflowSemanticCommand,
  LifecycleSemanticCommandDraft,
} from "./contracts/commands.js";
import type { CapabilityKind } from "./authority/capability-key-provider.js";
import {
  buildLifecycleIntentWitness,
  type TrustedLifecycleIntentAssertionsV1,
} from "./lifecycle-intent-witness.js";
import { LifecycleError } from "./errors.js";
import {
  NO_LIFECYCLE_FAULTS,
  type LifecycleDurableBoundary,
  type LifecycleFaultContext,
  type LifecycleFaultInjector,
} from "./lifecycle-faults.js";

const LOWER_HASH = /^[0-9a-f]{64}$/;
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const POSITIVE_GENERATION = /^(?:[1-9][0-9]*)$/;
const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;
const SQLITE_INT64_MAX_TEXT = "9223372036854775807";
const SQLITE_UUID_GLOB = "[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[1-5][0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]";

function sqliteStrictUnsignedDecimal(expression: string): string {
  return `(
    typeof(${expression}) = 'text'
    AND length(${expression}) BETWEEN 1 AND 19
    AND ${expression} NOT GLOB '*[^0-9]*'
    AND (${expression} = '0' OR ${expression} NOT GLOB '0*')
    AND (length(${expression}) < 19 OR ${expression} <= '${SQLITE_INT64_MAX_TEXT}')
  )`;
}

function sqliteCanonicalUuid(expression: string): string {
  return `(
    typeof(${expression}) = 'text'
    AND length(${expression}) = 36
    AND lower(${expression}) = ${expression}
    AND ${expression} GLOB '${SQLITE_UUID_GLOB}'
  )`;
}

export interface LifecycleCommandEnvelope {
  readonly context: ProjectContext;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly commandType: string;
  readonly candidateIntentHash: string;
  readonly authoritativeIntentHash: string;
  readonly semanticCommand:
    | LifecycleSemanticCommandDraft
    | InternalWorkflowSemanticCommand
    | InternalWorkflowPhasePlan;
  readonly capabilityKind: CapabilityKind | null;
  readonly capabilityGeneration: string | null;
  /** Resolve the protected generation from verified authority only after an exact replay miss. */
  readonly capabilityGenerationResolution?: "fresh-commit";
  readonly replayExpectation: LifecycleReplayExpectation;
}

export interface ConnectionBoundSessionAuthority {}
export interface ConnectionBoundSessionLeases {}
export interface ConnectionBoundLifecycleApprovals {}
export interface ConnectionBoundChildTransfers {}
declare const PREPARED_EVIDENCE_COVERAGE_HANDLE: unique symbol;
export type PreparedEvidenceCoverageHandle = symbol & {
  readonly [PREPARED_EVIDENCE_COVERAGE_HANDLE]: true;
};
export interface ConnectionBoundPreparedEvidenceCoverageBatch {
  readonly handle: PreparedEvidenceCoverageHandle;
  readonly sessionId: SessionId;
  readonly adapterSessionId: EvidenceCoverageBatchInput["command"]["adapterSessionId"];
  readonly eventPayload: EvidenceCoverageRecordedV2;
}
export interface ConnectionBoundEvidenceCoverage {
  assertEvidenceWindowWritable(sessionId: SessionId): void;
  assertQuickHealthy(sessionIds: readonly SessionId[]): void;
  registerAffectedExistingSessions(sessionIds: readonly SessionId[]): void;
  assertVersion1Eligible(sessionIds: readonly SessionId[]): void;
  prepareBatch(
    input: EvidenceCoverageBatchInput,
  ): ConnectionBoundPreparedEvidenceCoverageBatch;
  persistPrepared(
    handle: PreparedEvidenceCoverageHandle,
    committedEvent: StoredEvent,
  ): void;
  snapshotV2(
    sessionId: SessionId,
    baseEventPosition: bigint,
  ): CheckpointEvidenceCoverageV2;
  minimumCheckpointUpperBound(input: MinimumCheckpointCapacityInput): number;
  minimumFinalEndingScopeBindingsUpperBound(
    input: MinimumEndingScopeCapacityInput,
  ): number;
}
/** Optional until the request/reopen slice wires the semantic command path. */
export interface ConnectionBoundSessionEndWorkflows extends Partial<SessionEndWorkflowOperations> {}
export interface ConnectionBoundValidationResults {
  /** Legacy mocks may carry unrelated test-only members. */
  readonly [key: string]: unknown;
  /** Optional for legacy transaction mocks; present when the repository is wired. */
  readonly record?: (input: ValidationResultV1, event: StoredEvent) => void;
  readonly get?: (projectId: string, resultId: string) => ValidationResultV1 | null;
  readonly list?: (input: {
    readonly projectId: string;
    readonly workflowId: string;
    readonly workflowGeneration: number;
  }) => readonly ValidationResultV1[];
}
export interface ConnectionBoundLifecycleOutbox {}

export interface LifecycleCommandTransaction {
  readonly authority: ConnectionBoundSessionAuthority;
  readonly leases: ConnectionBoundSessionLeases;
  readonly approvals: ConnectionBoundLifecycleApprovals;
  readonly transfers: ConnectionBoundChildTransfers;
  readonly coverage: ConnectionBoundEvidenceCoverage;
  readonly workflows: ConnectionBoundSessionEndWorkflows;
  readonly validation: ConnectionBoundValidationResults;
  readonly outbox: ConnectionBoundLifecycleOutbox;
}

export interface PreparedLifecycleCommit<T extends JsonValue> {
  readonly append: Omit<AppendCommand<T>, "lifecycleIntentWitness"> & {
    readonly lifecycleIntentWitness?: never;
  };
  readonly authorizationRecord: PersistedLifecycleAuthorizationRecord;
  /** Verified inside onNew; accepted only for a deferred protected envelope. */
  readonly freshCapabilityGeneration?: string;
  readonly beforeAppend?: (
    planned: PlannedEventAppend<T>,
    transaction: LifecycleCommandTransaction,
  ) => undefined;
  readonly afterAppend: (
    committed: EventAppendBatch<T>,
    transaction: LifecycleCommandTransaction,
  ) => undefined;
  /** Internal coordinators may resolve a planner command to the exact
   * append-time command after connection-bound evidence is prepared. */
  readonly resolvedSemanticCommand?: LifecycleCommandEnvelope["semanticCommand"];
  readonly resolvedAuthoritativeIntentHash?: string;
}

export type AuthorityMaterialStatus = "current" | "stale" | "unavailable" | "not-issued";

export interface LifecycleExecutionResult<T extends JsonValue> {
  readonly deduplicated: boolean;
  readonly publicResult: T;
  readonly appendResult: AppendResult<T>;
  readonly authorizationRecord: PersistedLifecycleAuthorizationRecord;
  readonly authorityMaterialStatus: AuthorityMaterialStatus;
}

/** The semantic store's private event-writer seam; service callbacks never receive it. */
export interface LifecycleEventAppendPort {
  findLifecycleReplay<T extends JsonValue>(
    command: LifecycleCommandEnvelope,
  ): EventAppendReplay<T> | null;
  assertCommandIdentityAvailable(command: LifecycleCommandEnvelope): void;
  assertAppendAllowed(): void;
  prepare<T extends JsonValue>(
    command: AppendCommand<T>,
    recordedAt: string,
    commandHashOverride: string,
  ): PreparedEventAppend<T>;
  planPrepared<T extends JsonValue>(prepared: PreparedEventAppend<T>): PlannedEventAppend<T>;
  appendPlanned<T extends JsonValue>(planned: PlannedEventAppend<T>): EventAppendBatch<T>;
  insertDedup<T extends JsonValue>(
    prepared: PreparedEventAppend<T>,
    batch: EventAppendBatch<T>,
    authorization: PersistedLifecycleAuthorizationRecord,
  ): void;
  result<T extends JsonValue>(batch: EventAppendBatch<T>): AppendResult<T>;
}

export interface LifecycleCommandStoreOptions {
  readonly connection: SqliteConnection;
  readonly events: LifecycleEventAppendPort;
  /** Store-owned projection persistence; must be an explicit own data property. */
  readonly projectionWriter: LifecycleProjectionWriter;
  /** Facade capabilities must be explicit own data properties; prototypes/accessors are excluded. */
  readonly transaction: (connection: SqliteConnection) => LifecycleCommandTransaction;
  /** Optional schema-3 coverage repository; kept production-unwired until lifecycle V2 routing lands. */
  readonly evidenceCoverageRepository?: EvidenceCoverageRepository;
  /** Optional Task 15 validation-result repository; legacy transaction factories may omit it. */
  readonly validationResultsRepository?: LifecycleValidationResultRepository;
  readonly now?: () => string;
  readonly authorityMaterialStatus?: (
    authorization: PersistedLifecycleAuthorizationRecord,
  ) => AuthorityMaterialStatus;
  /** Optional fixture-only durable-boundary fault injection. */
  readonly faultInjector?: LifecycleFaultInjector;
}

const PREFINAL_SESSION_END_PHASES = new Set([
  "requested",
  "children-resolved",
]);

function storageIntegrity(): never {
  throw new LifecycleCommandStoreError("INTEGRITY_FAILURE");
}

function rowString(row: Readonly<Record<string, unknown>>, field: string): string {
  const value = row[field];
  if (typeof value !== "string") return storageIntegrity();
  return value;
}

function rowBigint(row: Readonly<Record<string, unknown>>, field: string): bigint {
  const value = row[field];
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  return storageIntegrity();
}

function nullableRowBigint(
  row: Readonly<Record<string, unknown>>,
  field: string,
): bigint | null {
  return row[field] === null ? null : rowBigint(row, field);
}

function nullableRowString(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string | null {
  return row[field] === null ? null : rowString(row, field);
}

const SESSION_END_STATUS_KEYS = `
  'resultVersion', 'sessionId', 'workflowId', 'workflowGeneration', 'phase',
  'priorRootState', 'triggeringEventPosition', 'finalCheckpointId',
  'finalCheckpointEventPosition', 'evidenceWindow', 'validationPlansReady',
  'qualityScore', 'safeFailureCode', 'materializationRequired'
`;

const CHECKPOINT_KEYS = `
  'checkpointVersion', 'checkpointId', 'sessionId', 'parentSessionId',
  'baseEventPosition', 'checkpointEventPosition', 'createdAt',
  'creatorAgentId', 'creatorClientInstanceId', 'taskSummary',
  'completedItems', 'inProgressItems', 'blockers', 'nextActions', 'decisions',
  'assumptions', 'unresolvedConflicts', 'filesTouched', 'artifactReferences',
  'sourceReferences', 'commandResults', 'testResults', 'materialClaims',
  'sourceState', 'childSummaries', 'evidenceCoverage'
`;

const SESSION_END_PHASES = new Set([
  "requested",
  "children-resolved",
  "final-checkpoint-recorded",
  "ending-materialization-queued",
  "validating",
  "verification-passed",
  "verification-failed",
  "completion-appended",
  "completed-materialization-confirmed",
  "completed",
  "cancelled",
  "abandoned",
]);

const SESSION_END_PHASE_ACTIONS = new Set([
  "mark-children-resolved",
  "record-final-checkpoint-and-queue-ending",
  "confirm-ending-materialization",
  "begin-validation",
  "record-verification-failed",
  "record-verification-passed",
  "invalidate-verification",
  "append-terminal-completion",
  "confirm-completed-materialization",
  "complete-without-materialization",
  "complete-after-materialization",
]);

const SESSION_END_WORKFLOW_TRANSITIONS = new Set([
  "requested\u0000children-resolved\u0000mark-children-resolved",
  "children-resolved\u0000final-checkpoint-recorded\u0000record-final-checkpoint-and-queue-ending",
  "final-checkpoint-recorded\u0000ending-materialization-queued\u0000confirm-ending-materialization",
  "ending-materialization-queued\u0000validating\u0000begin-validation",
  "validating\u0000verification-failed\u0000record-verification-failed",
  "validating\u0000verification-passed\u0000record-verification-passed",
  "verification-passed\u0000verification-failed\u0000invalidate-verification",
  "verification-passed\u0000completion-appended\u0000append-terminal-completion",
  "completion-appended\u0000completed-materialization-confirmed\u0000confirm-completed-materialization",
  "completion-appended\u0000completed\u0000complete-without-materialization",
  "completed-materialization-confirmed\u0000completed\u0000complete-after-materialization",
]);

const SESSION_END_STATUS_FIELDS = [
  "resultVersion",
  "sessionId",
  "workflowId",
  "workflowGeneration",
  "phase",
  "priorRootState",
  "triggeringEventPosition",
  "finalCheckpointId",
  "finalCheckpointEventPosition",
  "evidenceWindow",
  "validationPlansReady",
  "qualityScore",
  "safeFailureCode",
  "materializationRequired",
] as const;

function hasExactJsonFields(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length
    && actual.every((field) => expected.includes(field));
}

function assertFrozenWorkflowResult(
  resultJson: string,
  expected: {
    readonly sessionId: SessionId;
    readonly workflowId: string;
    readonly workflowGeneration: bigint;
    readonly phase: string;
    readonly triggeringEventPosition: bigint;
    readonly frozenPosition: bigint;
    readonly frozenGeneration: bigint;
  },
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultJson) as unknown;
    if (!isPlainRecord(parsed) || canonicalJson(parsed) !== resultJson) {
      return storageIntegrity();
    }
  } catch {
    return storageIntegrity();
  }
  if (!isPlainRecord(parsed)) return storageIntegrity();
  let status: Readonly<Record<string, unknown>>;
  if (Object.hasOwn(parsed, "status")) {
    if (
      !hasExactJsonFields(parsed, [
        "resultVersion",
        "action",
        "progressed",
        "previousPhase",
        "status",
      ])
      || parsed.resultVersion !== 2
      || typeof parsed.action !== "string"
      || !SESSION_END_PHASE_ACTIONS.has(parsed.action)
      || parsed.progressed !== true
      || typeof parsed.previousPhase !== "string"
      || !SESSION_END_PHASES.has(parsed.previousPhase)
      || !isPlainRecord(parsed.status)
    ) return storageIntegrity();
    status = parsed.status;
    if (
      typeof status.phase !== "string"
      || !SESSION_END_WORKFLOW_TRANSITIONS.has(
        `${parsed.previousPhase}\u0000${status.phase}\u0000${parsed.action}`,
      )
    ) return storageIntegrity();
  } else {
    status = parsed;
  }
  const window = status.evidenceWindow;
  if (
    !hasExactJsonFields(status, SESSION_END_STATUS_FIELDS)
    || status.resultVersion !== 2
    || status.sessionId !== expected.sessionId
    || status.workflowId !== expected.workflowId
    || !Number.isSafeInteger(status.workflowGeneration)
    || BigInt(status.workflowGeneration as number) !== expected.workflowGeneration
    || (status.workflowGeneration as number) < 1
    || status.phase !== expected.phase
    || typeof status.phase !== "string"
    || !SESSION_END_PHASES.has(status.phase)
    || (status.priorRootState !== "active" && status.priorRootState !== "suspended")
    || !positiveCapabilityGeneration(status.triggeringEventPosition)
    || status.triggeringEventPosition !== expected.triggeringEventPosition.toString()
    || typeof status.finalCheckpointId !== "string"
    || !LOWER_UUID.test(status.finalCheckpointId)
    || !positiveCapabilityGeneration(status.finalCheckpointEventPosition)
    || status.finalCheckpointEventPosition !== expected.frozenPosition.toString()
    || !isPlainRecord(window)
    || !hasExactJsonFields(window, [
      "evidenceWindowState",
      "evidenceFrozenCheckpointEventPosition",
      "evidenceFrozenGeneration",
    ])
    || window.evidenceWindowState !== "sealed"
    || !positiveCapabilityGeneration(window.evidenceFrozenCheckpointEventPosition)
    || window.evidenceFrozenCheckpointEventPosition !== expected.frozenPosition.toString()
    || !Number.isSafeInteger(window.evidenceFrozenGeneration)
    || BigInt(window.evidenceFrozenGeneration as number) !== expected.frozenGeneration
    || typeof status.validationPlansReady !== "boolean"
    || (status.qualityScore !== null
      && (!Number.isSafeInteger(status.qualityScore)
        || (status.qualityScore as number) < 0
        || (status.qualityScore as number) > 10_000))
    || (status.safeFailureCode !== null && typeof status.safeFailureCode !== "string")
    || typeof status.materializationRequired !== "boolean"
  ) return storageIntegrity();
}

function assertFrozenWorkflowIntegrity(
  connection: SqliteConnection,
  projectId: string,
  workflowId: string,
  rootSessionId: SessionId,
  frozenPosition: bigint,
): void {
  let row: Readonly<Record<string, unknown>> | undefined;
  try {
    row = connection.prepare(`
      SELECT CASE WHEN
        json_valid(workflow.result_json)
        AND json(workflow.result_json) = workflow.result_json
        AND (
          (
            json_type(workflow.result_json, '$.status') IS NULL
            AND (SELECT count(*) FROM json_each(workflow.result_json)) = 14
            AND NOT EXISTS (
              SELECT 1 FROM json_each(workflow.result_json) AS field
              WHERE field.key NOT IN (${SESSION_END_STATUS_KEYS})
            )
          )
          OR (
            json_type(workflow.result_json, '$.status') = 'object'
            AND (SELECT count(*) FROM json_each(workflow.result_json)) = 5
            AND NOT EXISTS (
              SELECT 1 FROM json_each(workflow.result_json) AS field
              WHERE field.key NOT IN (
                'resultVersion', 'action', 'progressed', 'previousPhase', 'status'
              )
            )
            AND (SELECT count(*) FROM json_each(workflow.result_json, '$.status')) = 14
            AND NOT EXISTS (
              SELECT 1 FROM json_each(workflow.result_json, '$.status') AS field
              WHERE field.key NOT IN (${SESSION_END_STATUS_KEYS})
            )
          )
        )
        AND (
          CASE WHEN json_type(workflow.result_json, '$.status') = 'object'
            THEN json_extract(workflow.result_json, '$.status.resultVersion')
            ELSE json_extract(workflow.result_json, '$.resultVersion')
          END
        ) = 2
        AND (
          CASE WHEN json_type(workflow.result_json, '$.status') = 'object'
            THEN json_extract(workflow.result_json, '$.status.sessionId')
            ELSE json_extract(workflow.result_json, '$.sessionId')
          END
        ) = workflow.session_id
        AND (
          CASE WHEN json_type(workflow.result_json, '$.status') = 'object'
            THEN json_extract(workflow.result_json, '$.status.workflowId')
            ELSE json_extract(workflow.result_json, '$.workflowId')
          END
        ) = workflow.workflow_id
        AND (
          CASE WHEN json_type(workflow.result_json, '$.status') = 'object'
            THEN json_extract(workflow.result_json, '$.status.workflowGeneration')
            ELSE json_extract(workflow.result_json, '$.workflowGeneration')
          END
        ) = workflow.generation
        AND (
          CASE WHEN json_type(workflow.result_json, '$.status') = 'object'
            THEN json_extract(workflow.result_json, '$.status.phase')
            ELSE json_extract(workflow.result_json, '$.phase')
          END
        ) = workflow.phase
        AND (
          CASE WHEN json_type(workflow.result_json, '$.status') = 'object'
            THEN json_extract(
              workflow.result_json,
              '$.status.evidenceWindow.evidenceWindowState'
            )
            ELSE json_extract(
              workflow.result_json,
              '$.evidenceWindow.evidenceWindowState'
            )
          END
        ) = workflow.evidence_window_state
        AND (
          CASE WHEN json_type(workflow.result_json, '$.status') = 'object'
            THEN json_extract(
              workflow.result_json,
              '$.status.evidenceWindow.evidenceFrozenCheckpointEventPosition'
            )
            ELSE json_extract(
              workflow.result_json,
              '$.evidenceWindow.evidenceFrozenCheckpointEventPosition'
            )
          END
        ) = CAST(workflow.evidence_frozen_checkpoint_event_position AS TEXT)
        AND (
          CASE WHEN json_type(workflow.result_json, '$.status') = 'object'
            THEN json_extract(
              workflow.result_json,
              '$.status.evidenceWindow.evidenceFrozenGeneration'
            )
            ELSE json_extract(
              workflow.result_json,
              '$.evidenceWindow.evidenceFrozenGeneration'
            )
          END
        ) = workflow.evidence_frozen_generation
        AND (
          CASE WHEN json_type(workflow.result_json, '$.status') = 'object'
            THEN json_extract(workflow.result_json, '$.status.finalCheckpointEventPosition')
            ELSE json_extract(workflow.result_json, '$.finalCheckpointEventPosition')
          END
        ) = CAST(workflow.evidence_frozen_checkpoint_event_position AS TEXT)
        AND json_valid(event.payload_json)
        AND json(event.payload_json) = event.payload_json
        AND json_type(event.payload_json) = 'object'
        AND (SELECT count(*) FROM json_each(event.payload_json)) = 6
        AND NOT EXISTS (
          SELECT 1 FROM json_each(event.payload_json) AS field
          WHERE field.key NOT IN (
            'checkpoint', 'baseEventPosition', 'checkpointEventPosition',
            'finalCheckpointBindingVersion', 'workflowId', 'workflowGeneration'
          )
        )
        AND json_extract(event.payload_json, '$.finalCheckpointBindingVersion') = 1
        AND json_extract(event.payload_json, '$.workflowId') = workflow.workflow_id
        AND json_extract(event.payload_json, '$.workflowGeneration')
          = workflow.evidence_frozen_generation
        AND (
          workflow.evidence_frozen_generation = workflow.generation
          OR (
            workflow.evidence_frozen_generation < workflow.generation
            AND workflow.triggering_event_position > event.global_position
            AND (
              SELECT count(*)
              FROM events AS preserving_amendment
              WHERE preserving_amendment.project_id = workflow.project_id
                AND preserving_amendment.session_id = workflow.session_id
                AND preserving_amendment.stream_id = 'session/' || workflow.session_id
                AND preserving_amendment.stream_type = 'session'
                AND preserving_amendment.parent_session_id IS NULL
                AND preserving_amendment.event_type = 'SessionEndAmended'
                AND preserving_amendment.event_schema_version = 3
                AND preserving_amendment.global_position > event.global_position
                AND preserving_amendment.global_position
                  <= workflow.triggering_event_position
                AND json_extract(preserving_amendment.payload_json, '$.workflowId')
                  = workflow.workflow_id
                AND json_extract(
                  preserving_amendment.payload_json,
                  '$.workflowGeneration'
                ) > workflow.evidence_frozen_generation
                AND json_extract(
                  preserving_amendment.payload_json,
                  '$.workflowGeneration'
                ) <= workflow.generation
                AND json_extract(
                  preserving_amendment.payload_json,
                  '$.previousWorkflowGeneration'
                ) = json_extract(
                  preserving_amendment.payload_json,
                  '$.workflowGeneration'
                ) - 1
                AND json_extract(
                  preserving_amendment.payload_json,
                  '$.evidenceWindowAction'
                ) = 'unchanged'
            ) = workflow.generation - workflow.evidence_frozen_generation
            AND NOT EXISTS (
              SELECT 1
              FROM events AS carried_event
              WHERE carried_event.project_id = workflow.project_id
                AND carried_event.session_id = workflow.session_id
                AND carried_event.stream_id = 'session/' || workflow.session_id
                AND carried_event.stream_type = 'session'
                AND carried_event.parent_session_id IS NULL
                AND carried_event.global_position > event.global_position
                AND carried_event.global_position <= workflow.triggering_event_position
                AND NOT (
                  carried_event.event_type = 'SessionEndAmended'
                  AND carried_event.event_schema_version = 3
                  AND json_extract(carried_event.payload_json, '$.workflowId')
                    = workflow.workflow_id
                  AND json_extract(carried_event.payload_json, '$.workflowGeneration')
                    > workflow.evidence_frozen_generation
                  AND json_extract(carried_event.payload_json, '$.workflowGeneration')
                    <= workflow.generation
                  AND json_extract(
                    carried_event.payload_json,
                    '$.previousWorkflowGeneration'
                  ) = json_extract(
                    carried_event.payload_json,
                    '$.workflowGeneration'
                  ) - 1
                  AND json_extract(
                    carried_event.payload_json,
                    '$.evidenceWindowAction'
                  ) IN ('unchanged', 'seal')
                )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM events AS duplicate_generation
              WHERE duplicate_generation.project_id = workflow.project_id
                AND duplicate_generation.session_id = workflow.session_id
                AND duplicate_generation.stream_id = 'session/' || workflow.session_id
                AND duplicate_generation.stream_type = 'session'
                AND duplicate_generation.parent_session_id IS NULL
                AND duplicate_generation.event_type = 'SessionEndAmended'
                AND duplicate_generation.event_schema_version = 3
                AND duplicate_generation.global_position > event.global_position
                AND duplicate_generation.global_position
                  <= workflow.triggering_event_position
              GROUP BY json_extract(
                duplicate_generation.payload_json,
                '$.workflowGeneration'
              )
              HAVING count(*) <> 1
            )
            AND EXISTS (
              SELECT 1
              FROM events AS latest_preserving_amendment
              WHERE latest_preserving_amendment.project_id = workflow.project_id
                AND latest_preserving_amendment.global_position
                  = workflow.triggering_event_position
                AND latest_preserving_amendment.session_id = workflow.session_id
                AND latest_preserving_amendment.event_type = 'SessionEndAmended'
                AND latest_preserving_amendment.event_schema_version = 3
                AND json_extract(
                  latest_preserving_amendment.payload_json,
                  '$.workflowId'
                ) = workflow.workflow_id
                AND json_extract(
                  latest_preserving_amendment.payload_json,
                  '$.workflowGeneration'
                ) = workflow.generation
                AND json_extract(
                  latest_preserving_amendment.payload_json,
                  '$.evidenceWindowAction'
                ) = 'unchanged'
            )
          )
        )
        AND json_type(event.payload_json, '$.checkpoint') = 'object'
        AND (
          SELECT count(*) FROM json_each(event.payload_json, '$.checkpoint')
        ) = 26
        AND NOT EXISTS (
          SELECT 1 FROM json_each(event.payload_json, '$.checkpoint') AS field
          WHERE field.key NOT IN (${CHECKPOINT_KEYS})
        )
        AND json_extract(event.payload_json, '$.checkpoint.checkpointVersion') IN (1, 2)
        AND json_extract(event.payload_json, '$.checkpoint.sessionId') = workflow.session_id
        AND json_type(event.payload_json, '$.checkpoint.parentSessionId') = 'null'
        AND json_extract(event.payload_json, '$.checkpoint.checkpointEventPosition')
          = CAST(event.global_position AS TEXT)
        AND json_extract(event.payload_json, '$.checkpointEventPosition')
          = CAST(event.global_position AS TEXT)
        AND json_extract(event.payload_json, '$.checkpoint.baseEventPosition')
          = json_extract(event.payload_json, '$.baseEventPosition')
        AND CAST(json_extract(event.payload_json, '$.checkpoint.baseEventPosition') AS INTEGER)
          <= event.global_position
        AND json_extract(event.payload_json, '$.checkpoint.checkpointId') = (
          CASE WHEN json_type(workflow.result_json, '$.status') = 'object'
            THEN json_extract(workflow.result_json, '$.status.finalCheckpointId')
            ELSE json_extract(workflow.result_json, '$.finalCheckpointId')
          END
        )
        AND json_type(event.payload_json, '$.checkpoint.childSummaries') = 'array'
        AND json_type(event.payload_json, '$.checkpoint.evidenceCoverage') = 'object'
        AND json_extract(
          event.payload_json,
          '$.checkpoint.evidenceCoverage.captureMode'
        ) = 'coverage-only'
        AND json_type(
          event.payload_json,
          '$.checkpoint.evidenceCoverage.contentRetained'
        ) = 'false'
        AND json_valid(workflow.final_ending_scope_bindings_json)
        AND json(workflow.final_ending_scope_bindings_json)
          = workflow.final_ending_scope_bindings_json
        AND json_type(workflow.final_ending_scope_bindings_json) = 'array'
        AND length(CAST(workflow.final_ending_scope_bindings_json AS BLOB)) <= 262144
        AND json_array_length(workflow.final_ending_scope_bindings_json) <= 605
        AND json_array_length(
          event.payload_json,
          '$.checkpoint.childSummaries'
        ) = json_array_length(workflow.final_ending_scope_bindings_json)
        AND NOT EXISTS (
          SELECT 1
          FROM json_each(workflow.final_ending_scope_bindings_json) AS binding
          WHERE json_type(binding.value) <> 'object'
            OR (SELECT count(*) FROM json_each(binding.value)) <> 10
            OR (
              SELECT count(DISTINCT field.key)
              FROM json_each(binding.value) AS field
            ) <> 10
            OR EXISTS (
              SELECT 1 FROM json_each(binding.value) AS field
              WHERE field.key NOT IN (
                'bindingVersion', 'bindingKind', 'childSessionId', 'childState',
                'lastEventPosition', 'streamVersion', 'checkpointId',
                'checkpointEventPosition', 'transferTicketId',
                'transferTicketEventPosition'
              )
            )
            OR json_type(binding.value, '$.bindingVersion') <> 'integer'
            OR json_extract(binding.value, '$.bindingVersion') <> 1
            OR json_type(binding.value, '$.bindingKind') <> 'text'
            OR json_extract(binding.value, '$.bindingKind') NOT IN (
              'current-child', 'carry-forward-ticket'
            )
            OR NOT ${sqliteCanonicalUuid(
              "json_extract(binding.value, '$.childSessionId')",
            )}
            OR json_type(binding.value, '$.childState') <> 'text'
            OR json_extract(binding.value, '$.childState') NOT IN (
              'active', 'completion-proposed', 'completed', 'suspended', 'transferred'
            )
            OR NOT ${sqliteStrictUnsignedDecimal(
              "json_extract(binding.value, '$.lastEventPosition')",
            )}
            OR json_extract(binding.value, '$.lastEventPosition') = '0'
            OR NOT ${sqliteStrictUnsignedDecimal(
              "json_extract(binding.value, '$.streamVersion')",
            )}
            OR json_extract(binding.value, '$.streamVersion') = '0'
            OR (json_extract(binding.value, '$.checkpointId') IS NULL)
              <> (json_extract(binding.value, '$.checkpointEventPosition') IS NULL)
            OR (
              json_extract(binding.value, '$.checkpointId') IS NOT NULL
              AND NOT ${sqliteCanonicalUuid(
                "json_extract(binding.value, '$.checkpointId')",
              )}
            )
            OR (
              json_extract(binding.value, '$.checkpointEventPosition') IS NOT NULL
              AND (
                NOT ${sqliteStrictUnsignedDecimal(
                  "json_extract(binding.value, '$.checkpointEventPosition')",
                )}
                OR json_extract(binding.value, '$.checkpointEventPosition') = '0'
                OR CAST(
                  json_extract(binding.value, '$.checkpointEventPosition') AS INTEGER
                ) > CAST(
                  json_extract(binding.value, '$.lastEventPosition') AS INTEGER
                )
                OR NOT EXISTS (
                  SELECT 1
                  FROM events AS child_checkpoint
                  WHERE child_checkpoint.project_id = workflow.project_id
                    AND child_checkpoint.global_position = CAST(
                      json_extract(
                        binding.value,
                        '$.checkpointEventPosition'
                      ) AS INTEGER
                    )
                    AND child_checkpoint.session_id = json_extract(
                      binding.value,
                      '$.childSessionId'
                    )
                    AND child_checkpoint.event_type = 'SessionCheckpointRecorded'
                    AND child_checkpoint.event_schema_version IN (1, 2)
                    AND json_extract(
                      child_checkpoint.payload_json,
                      '$.checkpoint.checkpointId'
                    ) = json_extract(binding.value, '$.checkpointId')
                )
              )
            )
            OR (
              json_extract(binding.value, '$.bindingKind') = 'current-child'
              AND (
                json_extract(binding.value, '$.transferTicketId') IS NOT NULL
                OR json_extract(
                  binding.value,
                  '$.transferTicketEventPosition'
                ) IS NOT NULL
              )
            )
            OR (
              json_extract(binding.value, '$.bindingKind') = 'carry-forward-ticket'
              AND (
                json_extract(binding.value, '$.childState') <> 'transferred'
                OR json_extract(binding.value, '$.checkpointId') IS NULL
                OR json_extract(binding.value, '$.transferTicketId') IS NULL
                OR NOT ${sqliteCanonicalUuid(
                  "json_extract(binding.value, '$.transferTicketId')",
                )}
                OR json_extract(
                  binding.value,
                  '$.transferTicketEventPosition'
                ) IS NULL
                OR NOT ${sqliteStrictUnsignedDecimal(
                  "json_extract(binding.value, '$.transferTicketEventPosition')",
                )}
                OR json_extract(
                  binding.value,
                  '$.transferTicketEventPosition'
                ) = '0'
                OR json_extract(binding.value, '$.lastEventPosition')
                  <> json_extract(
                    binding.value,
                    '$.transferTicketEventPosition'
                  )
                OR NOT EXISTS (
                  SELECT 1
                  FROM child_transfer_tickets AS immutable_ticket
                  JOIN events AS immutable_transfer_event
                    ON immutable_transfer_event.project_id
                      = immutable_ticket.project_id
                    AND immutable_transfer_event.global_position
                      = immutable_ticket.created_event_position
                    AND immutable_transfer_event.session_id
                      = immutable_ticket.source_child_session_id
                    AND immutable_transfer_event.parent_session_id
                      = immutable_ticket.source_parent_session_id
                    AND immutable_transfer_event.event_type
                      = 'ChildWorkTransferCreated'
                    AND immutable_transfer_event.event_schema_version IN (1, 2)
                    AND json_valid(immutable_transfer_event.payload_json)
                    AND json(immutable_transfer_event.payload_json)
                      = immutable_transfer_event.payload_json
                    AND json_extract(
                      immutable_transfer_event.payload_json,
                      '$.transferTicketId'
                    ) = immutable_ticket.transfer_ticket_id
                    AND json_extract(
                      immutable_transfer_event.payload_json,
                      '$.checkpointId'
                    ) = immutable_ticket.checkpoint_id
                    AND (
                      immutable_transfer_event.event_schema_version = 1
                      OR (
                        json_extract(
                          immutable_transfer_event.payload_json,
                          '$.suspensionCheckpointId'
                        ) IS NOT NULL
                        AND EXISTS (
                          SELECT 1
                          FROM events AS immutable_suspension_event
                          WHERE immutable_suspension_event.project_id
                              = immutable_ticket.project_id
                            AND immutable_suspension_event.stream_id
                              = immutable_transfer_event.stream_id
                            AND immutable_suspension_event.stream_type = 'session'
                            AND immutable_suspension_event.session_id
                              = immutable_ticket.source_child_session_id
                            AND immutable_suspension_event.parent_session_id
                              = immutable_ticket.source_parent_session_id
                            AND immutable_suspension_event.event_type
                              = 'ChildSessionSuspended'
                            AND immutable_suspension_event.event_schema_version = 1
                            AND immutable_suspension_event.global_position
                              < immutable_ticket.created_event_position
                            AND json_valid(immutable_suspension_event.payload_json)
                            AND json(immutable_suspension_event.payload_json)
                              = immutable_suspension_event.payload_json
                            AND json_extract(
                              immutable_suspension_event.payload_json,
                              '$.checkpointId'
                            ) = json_extract(
                              immutable_transfer_event.payload_json,
                              '$.suspensionCheckpointId'
                            )
                        )
                      )
                    )
                  WHERE immutable_ticket.project_id = workflow.project_id
                    AND immutable_ticket.source_parent_session_id
                      = workflow.session_id
                    AND immutable_ticket.source_child_session_id
                      = json_extract(binding.value, '$.childSessionId')
                    AND immutable_ticket.transfer_ticket_id
                      = json_extract(binding.value, '$.transferTicketId')
                    AND immutable_ticket.checkpoint_id
                      = json_extract(binding.value, '$.checkpointId')
                    AND immutable_ticket.created_event_position = CAST(
                      json_extract(
                        binding.value,
                        '$.transferTicketEventPosition'
                      ) AS INTEGER
                    )
                    AND immutable_transfer_event.stream_version = CAST(
                      json_extract(binding.value, '$.streamVersion') AS INTEGER
                    )
                )
              )
            )
            OR json(binding.value) <> json_object(
              'bindingKind', json_extract(binding.value, '$.bindingKind'),
              'bindingVersion', json_extract(binding.value, '$.bindingVersion'),
              'checkpointEventPosition',
                json_extract(binding.value, '$.checkpointEventPosition'),
              'checkpointId', json_extract(binding.value, '$.checkpointId'),
              'childSessionId', json_extract(binding.value, '$.childSessionId'),
              'childState', json_extract(binding.value, '$.childState'),
              'lastEventPosition',
                json_extract(binding.value, '$.lastEventPosition'),
              'streamVersion', json_extract(binding.value, '$.streamVersion'),
              'transferTicketEventPosition',
                json_extract(binding.value, '$.transferTicketEventPosition'),
              'transferTicketId',
                json_extract(binding.value, '$.transferTicketId')
            )
            OR json_extract(binding.value, '$.childSessionId') IS NOT json_extract(
              event.payload_json,
              '$.checkpoint.childSummaries[' || binding.key || '].childSessionId'
            )
            OR json_extract(binding.value, '$.childState') IS NOT json_extract(
              event.payload_json,
              '$.checkpoint.childSummaries[' || binding.key || '].state'
            )
            OR json_extract(binding.value, '$.lastEventPosition') IS NOT json_extract(
              event.payload_json,
              '$.checkpoint.childSummaries[' || binding.key || '].lastEventPosition'
            )
            OR json_extract(binding.value, '$.streamVersion') IS NOT json_extract(
              event.payload_json,
              '$.checkpoint.childSummaries[' || binding.key || '].streamVersion'
            )
            OR json_extract(binding.value, '$.checkpointId') IS NOT json_extract(
              event.payload_json,
              '$.checkpoint.childSummaries[' || binding.key || '].latestCheckpointId'
            )
        )
      THEN 1 ELSE 0 END AS frozen_valid,
      event.payload_json AS checkpoint_payload_json,
      workflow.final_ending_scope_bindings_json AS ending_scope_bindings_json,
      workflow.result_json AS workflow_result_json,
      workflow.generation AS workflow_generation,
      workflow.phase AS workflow_phase,
      workflow.triggering_event_position AS triggering_event_position,
      workflow.evidence_frozen_generation AS frozen_generation
      FROM workflow_instances AS workflow
      JOIN events AS event
        ON event.global_position = workflow.evidence_frozen_checkpoint_event_position
       AND event.project_id = workflow.project_id
       AND event.session_id = workflow.session_id
       AND event.stream_id = 'session/' || workflow.session_id
       AND event.stream_type = 'session'
       AND event.parent_session_id IS NULL
       AND event.event_type = 'SessionCheckpointRecorded'
       AND event.event_schema_version = 3
      WHERE workflow.project_id = $projectId
        AND workflow.workflow_id = $workflowId
        AND workflow.session_id = $rootSessionId
        AND workflow.evidence_frozen_checkpoint_event_position = $frozenPosition
    `).get({
      $projectId: projectId,
      $workflowId: workflowId,
      $rootSessionId: rootSessionId,
      $frozenPosition: frozenPosition,
    });
  } catch {
    return storageIntegrity();
  }
  if (row === undefined || rowBigint(row, "frozen_valid") !== 1n) {
    return storageIntegrity();
  }
  try {
    assertFrozenWorkflowResult(
      rowString(row, "workflow_result_json"),
      {
        sessionId: rootSessionId,
        workflowId,
        workflowGeneration: rowBigint(row, "workflow_generation"),
        phase: rowString(row, "workflow_phase"),
        triggeringEventPosition: rowBigint(row, "triggering_event_position"),
        frozenPosition,
        frozenGeneration: rowBigint(row, "frozen_generation"),
      },
    );
    const payloadJson = rowString(row, "checkpoint_payload_json");
    const payload = JSON.parse(payloadJson) as unknown;
    if (!isPlainRecord(payload)) return storageIntegrity();
    const checkpointPayload = decodeLifecycleEventPayload(
      "SessionCheckpointRecorded",
      3,
      payload,
    ) as SessionCheckpointRecordedPayloadV3;
    if (canonicalJson(checkpointPayload) !== payloadJson) {
      return storageIntegrity();
    }
    const bindingsJson = rowString(row, "ending_scope_bindings_json");
    const bindings = JSON.parse(bindingsJson) as unknown;
    const decodedBindings = decodeFinalEndingScopeBindingsV1(bindings);
    if (canonicalJson(decodedBindings) !== bindingsJson) {
      return storageIntegrity();
    }
  } catch {
    return storageIntegrity();
  }
}

function assertEvidenceWindowWritable(
  connection: SqliteConnection,
  sessionId: SessionId,
): void {
  const identity = connection.prepare(`
    SELECT project_id
    FROM project_meta
    WHERE singleton = 1
  `).get();
  if (identity === undefined) return storageIntegrity();
  const projectId = rowString(identity, "project_id");
  const authority = connection.prepare(`
    SELECT stream_id, session_kind, parent_session_id, workspace_id, client_namespace,
      owner_generation, child_capability_generation
    FROM session_authority
    WHERE project_id = $projectId
      AND session_id = $sessionId
  `).get({
    $projectId: projectId,
    $sessionId: sessionId,
  });
  if (authority === undefined) throw new LifecycleError("SESSION_NOT_FOUND");
  const streamId = rowString(authority, "stream_id");
  const kind = rowString(authority, "session_kind");
  const parentSessionId = nullableRowString(authority, "parent_session_id");
  const workspaceId = rowString(authority, "workspace_id");
  const clientNamespace = rowString(authority, "client_namespace");
  const ownerGeneration = nullableRowBigint(authority, "owner_generation");
  const childCapabilityGeneration = nullableRowBigint(
    authority,
    "child_capability_generation",
  );
  if (streamId !== `session/${sessionId}`) return storageIntegrity();
  let rootSessionId: SessionId;
  if (kind === "root") {
    if (
      parentSessionId !== null
      || ownerGeneration === null
      || ownerGeneration < 1n
      || childCapabilityGeneration !== null
    ) return storageIntegrity();
    rootSessionId = sessionId;
  } else if (kind === "child") {
    if (
      parentSessionId === null
      || !LOWER_UUID.test(parentSessionId)
      || ownerGeneration !== null
      || childCapabilityGeneration === null
      || childCapabilityGeneration < 1n
    ) return storageIntegrity();
    const parent = connection.prepare(`
      SELECT stream_id, session_kind, parent_session_id, workspace_id, client_namespace,
        owner_generation, child_capability_generation
      FROM session_authority
      WHERE project_id = $projectId
        AND session_id = $parentSessionId
    `).get({
      $projectId: projectId,
      $parentSessionId: parentSessionId,
    });
    const parentOwnerGeneration = parent === undefined
      ? null
      : nullableRowBigint(parent, "owner_generation");
    if (
      parent === undefined
      || rowString(parent, "stream_id") !== `session/${parentSessionId}`
      || rowString(parent, "session_kind") !== "root"
      || nullableRowString(parent, "parent_session_id") !== null
      || rowString(parent, "workspace_id") !== workspaceId
      || rowString(parent, "client_namespace") !== clientNamespace
      || parentOwnerGeneration === null
      || parentOwnerGeneration < 1n
      || nullableRowBigint(parent, "child_capability_generation") !== null
    ) return storageIntegrity();
    rootSessionId = parentSessionId as SessionId;
  } else {
    return storageIntegrity();
  }
  const workflow = connection.prepare(`
    SELECT workflow_type, generation, phase, session_id,
      evidence_frozen_checkpoint_event_position,
      evidence_frozen_generation,
      evidence_window_state,
      CASE WHEN final_ending_scope_bindings_json IS NULL
        THEN 1 ELSE 0 END AS bindings_is_null
    FROM workflow_instances
    WHERE project_id = $projectId
      AND workflow_id = $workflowId
  `).get({
    $projectId: projectId,
    $workflowId: sessionEndWorkflowId(rootSessionId),
  });
  if (workflow === undefined) return;
  const workflowType = rowString(workflow, "workflow_type");
  const generation = rowBigint(workflow, "generation");
  const phase = rowString(workflow, "phase");
  const workflowSessionId = nullableRowString(workflow, "session_id");
  const windowState = nullableRowString(workflow, "evidence_window_state");
  const frozenPosition = nullableRowBigint(
    workflow,
    "evidence_frozen_checkpoint_event_position",
  );
  const frozenGeneration = nullableRowBigint(workflow, "evidence_frozen_generation");
  const bindingsIsNull = rowBigint(workflow, "bindings_is_null");
  if (bindingsIsNull !== 0n && bindingsIsNull !== 1n) return storageIntegrity();
  if (
    workflowType !== "session-end"
    || generation < 1n
    || workflowSessionId !== rootSessionId
    || (windowState !== "open" && windowState !== "sealed")
  ) return storageIntegrity();
  const nullGroup = frozenPosition === null
    && frozenGeneration === null
    && bindingsIsNull === 1n;
  const completeGroup = frozenPosition !== null
    && frozenGeneration !== null
    && bindingsIsNull === 0n;
  if (!nullGroup && !completeGroup) return storageIntegrity();
  if (completeGroup) {
    if (
      frozenPosition < 1n
      || frozenGeneration > generation
      || windowState !== "sealed"
    ) return storageIntegrity();
    assertFrozenWorkflowIntegrity(
      connection,
      projectId,
      sessionEndWorkflowId(rootSessionId),
      rootSessionId,
      frozenPosition,
    );
  }
  if (phase === "cancelled") {
    if (windowState !== "sealed" || !nullGroup) return storageIntegrity();
    return;
  }
  if (completeGroup && PREFINAL_SESSION_END_PHASES.has(phase)) {
    return storageIntegrity();
  }
  if (completeGroup) throw new LifecycleError("SESSION_END_EVIDENCE_FROZEN");
  if (PREFINAL_SESSION_END_PHASES.has(phase)) return;
  return storageIntegrity();
}

export function connectionBoundEvidenceCoverage(
  connection: SqliteConnection,
  repository: EvidenceCoverageRepository,
): ConnectionBoundEvidenceCoverage {
  const preparedByHandle = new Map<
    PreparedEvidenceCoverageHandle,
    PreparedEvidenceCoverageBatch
  >();
  const facade: ConnectionBoundEvidenceCoverage = {
    assertEvidenceWindowWritable: (sessionId) =>
      assertEvidenceWindowWritable(connection, sessionId),
    assertQuickHealthy: (sessionIds) =>
      repository.assertQuickHealthy(connection, sessionIds),
    registerAffectedExistingSessions: (sessionIds) =>
      repository.assertQuickHealthy(connection, sessionIds),
    assertVersion1Eligible: (sessionIds) =>
      repository.assertVersion1Eligible(connection, sessionIds),
    prepareBatch: (input) => {
      const prepared = repository.prepareBatch(connection, input);
      const handle = Symbol("prepared-evidence-coverage") as PreparedEvidenceCoverageHandle;
      preparedByHandle.set(handle, prepared);
      return Object.freeze({
        handle,
        sessionId: prepared.sessionId,
        adapterSessionId: prepared.adapterSessionId,
        eventPayload: prepared.eventPayload,
      });
    },
    persistPrepared: (handle, event) => {
      if (typeof handle !== "symbol") return storageIntegrity();
      const preparedHandle = handle as PreparedEvidenceCoverageHandle;
      const prepared = preparedByHandle.get(preparedHandle);
      if (prepared === undefined) return storageIntegrity();
      preparedByHandle.delete(preparedHandle);
      repository.persistPrepared(connection, prepared, event);
    },
    snapshotV2: (sessionId, baseEventPosition) =>
      repository.snapshotV2(connection, sessionId, baseEventPosition),
    minimumCheckpointUpperBound: (input) =>
      repository.minimumCheckpointUpperBound(connection, input),
    minimumFinalEndingScopeBindingsUpperBound: (input) =>
      repository.minimumFinalEndingScopeBindingsUpperBound(connection, input),
  };
  return Object.freeze(facade);
}

export function connectionBoundValidationResults(
  connection: SqliteConnection,
  repository: LifecycleValidationResultRepository,
): ConnectionBoundValidationResults {
  return Object.freeze({
    record: (input: ValidationResultV1, event: StoredEvent): void => {
      repository.record(connection, input, event);
    },
    get: (projectId: string, resultId: string): ValidationResultV1 | null =>
      repository.get(connection, projectId, resultId),
    list: (input: {
      readonly projectId: string;
      readonly workflowId: string;
      readonly workflowGeneration: number;
    }): readonly ValidationResultV1[] => repository.list(connection, input),
  });
}

export class LifecycleCommandStoreError extends LifecycleError {
  constructor(
    code: "IDEMPOTENCY_CONFLICT" | "COMMAND_OUTCOME_UNKNOWN" | "LIFECYCLE_INPUT_INVALID" | "INTEGRITY_FAILURE",
    details: Readonly<Record<string, string>> = {},
  ) {
    super(code, details);
  }
}

function authorizationMatchesExpectation(
  record: PersistedLifecycleAuthorizationRecord,
  expectation: LifecycleReplayExpectation,
): boolean {
  return matchesLifecycleReplayAuthorization(record, expectation);
}

function assertEnvelope(command: LifecycleCommandEnvelope): void {
  const deferredGeneration = command.capabilityGenerationResolution === "fresh-commit";
  if (!LOWER_HASH.test(command.candidateIntentHash)
    || !LOWER_HASH.test(command.authoritativeIntentHash)
    || command.commandId.length === 0
    || command.idempotencyKey.length === 0
    || command.commandType.length === 0
    || command.semanticCommand.commandId !== command.commandId
    || command.semanticCommand.idempotencyKey !== command.idempotencyKey
    || command.semanticCommand.commandType !== command.commandType
    || (command.capabilityGenerationResolution !== undefined && !deferredGeneration)
    || (deferredGeneration
      ? command.capabilityKind === null || command.capabilityGeneration !== null
      : ((command.capabilityKind === null) !== (command.capabilityGeneration === null)))) {
    throw new LifecycleCommandStoreError("LIFECYCLE_INPUT_INVALID");
  }
  if (command.candidateIntentHash !== command.authoritativeIntentHash) {
    throw new LifecycleCommandStoreError("IDEMPOTENCY_CONFLICT");
  }
}

function assertAppendIdentity<T extends JsonValue>(
  envelope: LifecycleCommandEnvelope,
  prepared: PreparedLifecycleCommit<T>,
): void {
  const append = prepared.append;
  if (append.commandId !== envelope.commandId
    || append.idempotencyKey !== envelope.idempotencyKey
    || append.commandType !== envelope.commandType
    || !authorizationMatchesExpectation(prepared.authorizationRecord, envelope.replayExpectation)) {
    throw new LifecycleCommandStoreError("IDEMPOTENCY_CONFLICT");
  }
  const expected = envelope.context.binding;
  const actual = append.context.binding;
  if (expected.projectId !== actual.projectId
    || expected.vaultId !== actual.vaultId
    || expected.storeId !== actual.storeId
    || expected.workspaceId !== actual.workspaceId
    || expected.clientNamespace !== actual.clientNamespace) {
    throw new LifecycleCommandStoreError("IDEMPOTENCY_CONFLICT");
  }
  const expectedTargetStream = `session/${prepared.authorizationRecord.targetSessionId}`;
  if (append.streamId !== expectedTargetStream) {
    const authorization = prepared.authorizationRecord;
    const semantic = envelope.semanticCommand;
    const childSessionId = append.streamId.startsWith("session/")
      ? append.streamId.slice("session/".length)
      : "";
    const rootSessionId = authorization.targetSessionId;
    const fork = semantic.commandType === "fork-child"
      && semantic.parentSessionId === rootSessionId
      && append.events.length === 1;
    const claim = semantic.commandType === "claim-child-transfer"
      && semantic.rootSessionId === rootSessionId
      && append.events.length === 2
      && append.events[1]?.eventType === "ChildWorkTransferClaimed";
    if (
      authorization.kind !== "protected"
      || authorization.authorizationSessionId !== rootSessionId
      || (!fork && !claim)
      || append.streamType !== "session"
      || append.expectedStreamVersion !== 0n
      || !LOWER_UUID.test(childSessionId)
      || childSessionId === rootSessionId
      || append.events[0]?.eventType !== "SessionForked"
      || append.events.some((event) => event.sessionId !== childSessionId
        || event.parentSessionId !== rootSessionId)
    ) throw new LifecycleCommandStoreError("IDEMPOTENCY_CONFLICT");
  }
}

function withoutAuthorization<T extends JsonValue>(
  result: EventAppendReplay<T>,
): AppendResult<T> {
  const { authorizationRecord: _authorizationRecord, ...appendResult } = result;
  return appendResult;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

interface TransactionCallbackScope {
  active: boolean;
}

function callbackBoundaryFailure(): never {
  throw new LifecycleCommandStoreError("LIFECYCLE_INPUT_INVALID");
}

function assertCallbackActive(scope: TransactionCallbackScope): void {
  if (!scope.active) callbackBoundaryFailure();
}

function guardedFacade<T extends object>(value: T, scope: TransactionCallbackScope): T {
  const proxies = new WeakMap<object, object>();
  const methodWrappers = new WeakMap<object, Map<PropertyKey, (...args: unknown[]) => unknown>>();
  const callableWrappers = new WeakMap<Function, (...args: unknown[]) => unknown>();

  function guardResult(result: unknown): unknown {
    if (isThenable(result)) {
      discardNativePromise(result);
      callbackBoundaryFailure();
    }
    if (typeof result === "function") {
      const prior = callableWrappers.get(result);
      if (prior !== undefined) return prior;
      const wrapper = function(this: unknown, ...args: unknown[]): unknown {
        assertCallbackActive(scope);
        return guardResult(Reflect.apply(result, this, args) as unknown);
      };
      callableWrappers.set(result, wrapper);
      return wrapper;
    }
    if (Array.isArray(result)) return Object.freeze(result.map((item) => guardResult(item)));
    if (typeof result === "object" && result !== null) return wrap(result);
    return result;
  }

  function dataMember(
    current: object,
    property: PropertyKey,
  ): { readonly found: true; readonly value: unknown } | { readonly found: false } {
    const descriptor = Reflect.getOwnPropertyDescriptor(current, property);
    if (descriptor === undefined) {
      if (Reflect.getOwnPropertyDescriptor(Object.prototype, property) !== undefined
        || Reflect.getOwnPropertyDescriptor(Function.prototype, property) !== undefined) {
        callbackBoundaryFailure();
      }
      return { found: false };
    }
    if (!("value" in descriptor)) {
      callbackBoundaryFailure();
    }
    return { found: true, value: descriptor.value };
  }

  function wrap(current: object): object {
    const prior = proxies.get(current);
    if (prior !== undefined) return prior;
    const target = Object.create(null) as Record<PropertyKey, unknown>;
    const proxy: Record<PropertyKey, unknown> = new Proxy(target, {
      get: (_target, property) => {
        assertCallbackActive(scope);
        const resolved = dataMember(current, property);
        if (!resolved.found) return undefined;
        const member = resolved.value;
        if (typeof member === "function") {
          let wrappers = methodWrappers.get(current);
          if (wrappers === undefined) {
            wrappers = new Map();
            methodWrappers.set(current, wrappers);
          }
          const priorWrapper = wrappers.get(property);
          if (priorWrapper !== undefined) return priorWrapper;
          const wrapper = (...args: unknown[]): unknown => {
            assertCallbackActive(scope);
            return guardResult(Reflect.apply(member, current, args) as unknown);
          };
          wrappers.set(property, wrapper);
          return wrapper;
        }
        return guardResult(member);
      },
      has: (_target, property) => {
        assertCallbackActive(scope);
        return dataMember(current, property).found;
      },
      ownKeys: () => {
        assertCallbackActive(scope);
        return Reflect.ownKeys(current);
      },
      getOwnPropertyDescriptor: (_target, property): PropertyDescriptor | undefined => {
        assertCallbackActive(scope);
        const descriptor = Reflect.getOwnPropertyDescriptor(current, property);
        if (descriptor === undefined) return undefined;
        if (!("value" in descriptor)) callbackBoundaryFailure();
        return {
          configurable: true,
          enumerable: descriptor.enumerable ?? false,
          writable: false,
          value: Reflect.get(proxy, property) as unknown,
        };
      },
      getPrototypeOf: () => null,
      set: () => callbackBoundaryFailure(),
      defineProperty: () => callbackBoundaryFailure(),
      deleteProperty: () => callbackBoundaryFailure(),
      preventExtensions: () => callbackBoundaryFailure(),
      setPrototypeOf: () => callbackBoundaryFailure(),
    });
    proxies.set(current, proxy);
    return proxy;
  }

  return wrap(value) as T;
}

function isThenable(value: unknown): boolean {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return false;
  try {
    return typeof Reflect.get(value, "then") === "function";
  } catch {
    return true;
  }
}

function discardNativePromise(value: unknown): void {
  try {
    if (value instanceof Promise) void value.catch(() => undefined);
  } catch {
    // The callback result is rejected below; hostile Promise branding must not mask that result.
  }
}

function synchronousCallbackResult<T>(result: T): T {
  if (isThenable(result)) {
    discardNativePromise(result);
    callbackBoundaryFailure();
  }
  return result;
}

function undefinedCallbackResult(result: unknown): undefined {
  if (result !== undefined) callbackBoundaryFailure();
  return undefined;
}

function materialStatusResult(result: unknown): AuthorityMaterialStatus {
  if (result !== "current"
    && result !== "stale"
    && result !== "unavailable"
    && result !== "not-issued") {
    callbackBoundaryFailure();
  }
  return result;
}

function invokeSynchronousTransactionCallback<T, TResult>(
  transaction: LifecycleCommandTransaction,
  callback: (guarded: LifecycleCommandTransaction) => T,
  transform: (result: T) => TResult,
): TResult {
  const scope: TransactionCallbackScope = { active: true };
  const guarded = guardedFacade(transaction, scope);
  try {
    return transform(synchronousCallbackResult(callback(guarded)));
  } finally {
    scope.active = false;
  }
}

function projectCommandTransaction(
  transaction: LifecycleCommandTransaction,
): LifecycleCommandTransaction {
  return {
    authority: transaction.authority,
    leases: transaction.leases,
    approvals: transaction.approvals,
    transfers: transaction.transfers,
    coverage: transaction.coverage,
    workflows: transaction.workflows,
    validation: transaction.validation,
    outbox: transaction.outbox,
  };
}

function immutableSnapshot<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => immutableSnapshot(item))) as T;
  }
  if (typeof value !== "object" || value === null) return value;
  if (!isPlainRecord(value)) throw new LifecycleCommandStoreError("INTEGRITY_FAILURE");
  const snapshot: Record<string, unknown> = {};
  for (const key of Object.keys(value)) snapshot[key] = immutableSnapshot(value[key]);
  return Object.freeze(snapshot) as T;
}

interface SnapshottedLifecycleCommit<T extends JsonValue> {
  readonly append: PreparedLifecycleCommit<T>["append"];
  readonly authorizationRecord: PersistedLifecycleAuthorizationRecord;
  readonly freshCapabilityGeneration?: string;
  readonly beforeAppend?: PreparedLifecycleCommit<T>["beforeAppend"];
  readonly afterAppend: PreparedLifecycleCommit<T>["afterAppend"];
  readonly resolvedSemanticCommand?: LifecycleCommandEnvelope["semanticCommand"];
  readonly resolvedAuthoritativeIntentHash?: string;
}

function dataProperty(record: Record<string, unknown>, property: string): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(record, property);
  if (descriptor === undefined || !("value" in descriptor)) callbackBoundaryFailure();
  return descriptor.value;
}

function snapshotPreparedCommit<T extends JsonValue>(
  value: PreparedLifecycleCommit<T>,
): SnapshottedLifecycleCommit<T> {
  if (!isPlainRecord(value)) callbackBoundaryFailure();
  const authorizationValue = dataProperty(value, "authorizationRecord");
  const appendValue = dataProperty(value, "append");
  if (!isPlainRecord(authorizationValue) || !isPlainRecord(appendValue)) callbackBoundaryFailure();
  if (Object.hasOwn(appendValue, "lifecycleIntentWitness")) callbackBoundaryFailure();
  const authorizationRecord = immutableSnapshot(authorizationValue as PersistedLifecycleAuthorizationRecord);
  const append = immutableSnapshot(
    appendValue as unknown as PreparedLifecycleCommit<T>["append"],
  );
  const afterAppend = dataProperty(value, "afterAppend");
  const beforeDescriptor = Reflect.getOwnPropertyDescriptor(value, "beforeAppend");
  const generationDescriptor = Reflect.getOwnPropertyDescriptor(value, "freshCapabilityGeneration");
  const resolvedCommandDescriptor = Reflect.getOwnPropertyDescriptor(value, "resolvedSemanticCommand");
  const resolvedHashDescriptor = Reflect.getOwnPropertyDescriptor(value, "resolvedAuthoritativeIntentHash");
  if (typeof afterAppend !== "function"
    || (beforeDescriptor !== undefined
      && (!("value" in beforeDescriptor)
        || (beforeDescriptor.value !== undefined && typeof beforeDescriptor.value !== "function")))
    || (generationDescriptor !== undefined
      && (!("value" in generationDescriptor)
        || (generationDescriptor.value !== undefined
          && typeof generationDescriptor.value !== "string")))) {
    callbackBoundaryFailure();
  }
  if (resolvedCommandDescriptor !== undefined
    && (!(("value" in resolvedCommandDescriptor)
      && (resolvedCommandDescriptor.value === undefined
        || isPlainRecord(resolvedCommandDescriptor.value))))) {
    callbackBoundaryFailure();
  }
  if (resolvedHashDescriptor !== undefined
    && (!(("value" in resolvedHashDescriptor)
      && (resolvedHashDescriptor.value === undefined
        || (typeof resolvedHashDescriptor.value === "string"
          && LOWER_HASH.test(resolvedHashDescriptor.value)))))) {
    callbackBoundaryFailure();
  }
  return Object.freeze({
    append,
    authorizationRecord,
    ...(generationDescriptor?.value === undefined
      ? {}
      : { freshCapabilityGeneration: generationDescriptor.value as string }),
    ...(beforeDescriptor?.value === undefined
      ? {}
      : { beforeAppend: beforeDescriptor.value as PreparedLifecycleCommit<T>["beforeAppend"] }),
    afterAppend: afterAppend as PreparedLifecycleCommit<T>["afterAppend"],
    ...(resolvedCommandDescriptor?.value === undefined
      ? {}
      : { resolvedSemanticCommand: immutableSnapshot(
          resolvedCommandDescriptor.value as LifecycleCommandEnvelope["semanticCommand"],
        ) }),
    ...(resolvedHashDescriptor?.value === undefined
      ? {}
      : { resolvedAuthoritativeIntentHash: resolvedHashDescriptor.value as string }),
  });
}

function positiveCapabilityGeneration(value: unknown): value is string {
  if (typeof value !== "string" || !POSITIVE_GENERATION.test(value)) return false;
  return BigInt(value) <= SQLITE_INT64_MAX;
}

function resolveFreshCapabilityGeneration<T extends JsonValue>(
  envelope: LifecycleCommandEnvelope,
  commit: SnapshottedLifecycleCommit<T>,
): LifecycleCommandEnvelope {
  if (envelope.capabilityGenerationResolution !== "fresh-commit") {
    if (commit.freshCapabilityGeneration !== undefined) callbackBoundaryFailure();
    return envelope;
  }
  if (!positiveCapabilityGeneration(commit.freshCapabilityGeneration)) callbackBoundaryFailure();
  return Object.freeze({
    ...envelope,
    capabilityGeneration: commit.freshCapabilityGeneration,
    capabilityGenerationResolution: undefined,
  });
}

function trustedIntentAssertions(
  envelope: LifecycleCommandEnvelope,
  authorization: PersistedLifecycleAuthorizationRecord,
): TrustedLifecycleIntentAssertionsV1 {
  const internal = authorization.kind === "internal-workflow" ? authorization : null;
  if (internal !== null && (
    internal.workflowGeneration < 1n
    || internal.workflowGeneration > BigInt(Number.MAX_SAFE_INTEGER)
  )) {
    throw new LifecycleCommandStoreError("LIFECYCLE_INPUT_INVALID");
  }
  const proofPresent = authorization.kind === "protected" && authorization.proof !== null;
  const capabilityPairPresent = envelope.capabilityKind !== null
    && envelope.capabilityGeneration !== null;
  const capabilityPairAbsent = envelope.capabilityKind === null
    && envelope.capabilityGeneration === null;
  if (
    (!capabilityPairPresent && !capabilityPairAbsent)
    || proofPresent !== capabilityPairPresent
    || (authorization.kind !== "protected" && capabilityPairPresent)
  ) {
    throw new LifecycleCommandStoreError("IDEMPOTENCY_CONFLICT");
  }
  const binding = envelope.context.binding;
  return {
    authorizationKind: authorization.kind,
    authorizationSessionId: authorization.authorizationSessionId,
    targetSessionId: authorization.targetSessionId,
    projectId: binding.projectId,
    vaultId: binding.vaultId,
    storeId: binding.storeId,
    workspaceId: binding.workspaceId,
    clientNamespace: binding.clientNamespace,
    capabilityKind: envelope.capabilityKind,
    capabilityGeneration: envelope.capabilityGeneration,
    presentingActorRole: authorization.presenting.actorRole,
    presentingClientInstanceId: authorization.presenting.clientInstanceId,
    targetActorRole: authorization.target.actorRole,
    targetClientInstanceId: authorization.target.clientInstanceId,
    internalWorkflowId: internal?.workflowId ?? null,
    internalWorkflowGeneration: internal === null ? null : Number(internal.workflowGeneration),
    internalPlannedWorkId: internal?.plannedWorkId ?? null,
  };
}

function appendWithTrustedIntent<T extends JsonValue>(
  envelope: LifecycleCommandEnvelope,
  commit: SnapshottedLifecycleCommit<T>,
): AppendCommand<T> {
  let built;
  try {
    built = buildLifecycleIntentWitness(
      envelope.semanticCommand,
      trustedIntentAssertions(envelope, commit.authorizationRecord),
    );
  } catch (error) {
    if (error instanceof LifecycleCommandStoreError) throw error;
    throw new LifecycleCommandStoreError("IDEMPOTENCY_CONFLICT");
  }
  if (built.intentHash !== envelope.authoritativeIntentHash) {
    throw new LifecycleCommandStoreError("IDEMPOTENCY_CONFLICT");
  }
  return Object.freeze({
    ...commit.append,
    lifecycleIntentWitness: built.source,
  }) as AppendCommand<T>;
}

function integrityJson(value: unknown): JsonValue {
  if (value === null) return { type: "null" };
  if (typeof value === "string") return { type: "string", value };
  if (typeof value === "boolean") return { type: "boolean", value };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new LifecycleCommandStoreError("INTEGRITY_FAILURE");
    return { type: "number", value: Object.is(value, -0) ? "-0" : value.toString() };
  }
  if (typeof value === "bigint") return { type: "bigint", value: value.toString() };
  if (value === undefined) return { type: "undefined" };
  if (Array.isArray(value)) {
    return { type: "array", value: value.map((item) => integrityJson(item)) };
  }
  if (!isPlainRecord(value)) throw new LifecycleCommandStoreError("INTEGRITY_FAILURE");
  const normalized: Record<string, JsonValue> = {};
  for (const key of Object.keys(value)) {
    normalized[key] = integrityJson(value[key]);
  }
  return { type: "object", value: normalized };
}

function integrityFingerprint(value: unknown): string {
  return canonicalJson(integrityJson(value));
}

function batchFingerprint<T extends JsonValue>(batch: EventAppendBatch<T>): string {
  return integrityFingerprint({
    events: batch.events,
    storedResponse: batch.storedResponse,
    responseHash: batch.responseHash,
  });
}

function immutableBatchSnapshot<T extends JsonValue>(
  batch: EventAppendBatch<T>,
): EventAppendBatch<T> {
  return immutableSnapshot({
    events: batch.events,
    storedResponse: batch.storedResponse,
    responseHash: batch.responseHash,
  });
}

function immutablePlannedSnapshot<T extends JsonValue>(
  planned: PlannedEventAppend<T>,
): PlannedEventAppend<T> {
  return immutableSnapshot({
    plannedOnly: true as const,
    events: planned.events,
    storedResponse: planned.storedResponse,
    responseHash: planned.responseHash,
  });
}

function assertBatchUnchanged<T extends JsonValue>(
  batch: EventAppendBatch<T>,
  expectedFingerprint: string,
): void {
  if (batchFingerprint(batch) !== expectedFingerprint) {
    throw new LifecycleCommandStoreError("INTEGRITY_FAILURE");
  }
}

function assertCommittedMatchesPlan<T extends JsonValue>(
  planned: PlannedEventAppend<T>,
  committed: EventAppendBatch<T>,
): void {
  if (batchFingerprint(planned) !== batchFingerprint(committed)) {
    throw new LifecycleCommandStoreError("INTEGRITY_FAILURE");
  }
}

function affectedExistingSessionIds(
  envelope: LifecycleCommandEnvelope,
): readonly SessionId[] {
  const command = envelope.semanticCommand;
  switch (command.commandType) {
    case "root-start":
      return Object.freeze([]);
    case "root-resume":
      return Object.freeze(command.sessionId === null ? [] : [command.sessionId]);
    case "root-recovery":
    case "root-suspend":
    case "record-checkpoint":
    case "record-evidence-batch":
    case "amend-session-end":
    case "cancel-session-end":
    case "abandon-session":
      return Object.freeze([command.sessionId]);
    case "fork-child":
      return Object.freeze([command.parentSessionId]);
    case "amend-child-assignment":
    case "record-child-report":
    case "disposition-child-report":
    case "complete-child-session":
    case "suspend-child-session":
    case "create-child-transfer":
      return Object.freeze([command.parentSessionId, command.childSessionId]);
    case "propose-child-completion":
      return Object.freeze([command.childSessionId]);
    case "claim-child-transfer":
      return Object.freeze([command.rootSessionId]);
    case "request-session-end":
      return Object.freeze([command.request.sessionId]);
    case "internal-validation-result":
    case "internal-workflow-phase":
      if (envelope.replayExpectation.kind !== "internal-workflow") {
        return storageIntegrity();
      }
      if (command.commandType === "internal-workflow-phase") {
        const action = "plannedAction" in command ? command.plannedAction : command.action;
        if (action.action === "carry-forward-child") {
          return Object.freeze([action.rootSessionId, action.childSessionId]);
        }
      }
      return Object.freeze([
        envelope.replayExpectation.targetSessionId as SessionId,
      ]);
  }
}

const COVERAGE_FACADE_METHODS = [
  "assertEvidenceWindowWritable",
  "assertQuickHealthy",
  "registerAffectedExistingSessions",
  "assertVersion1Eligible",
  "prepareBatch",
  "persistPrepared",
  "snapshotV2",
  "minimumCheckpointUpperBound",
  "minimumFinalEndingScopeBindingsUpperBound",
] as const;

function assertCompleteCoverageFacade(
  coverage: ConnectionBoundEvidenceCoverage,
): ConnectionBoundEvidenceCoverage {
  if (typeof coverage !== "object" || coverage === null) return storageIntegrity();
  for (const method of COVERAGE_FACADE_METHODS) {
    const descriptor = Reflect.getOwnPropertyDescriptor(coverage, method);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !("value" in descriptor)
      || typeof descriptor.value !== "function"
    ) return storageIntegrity();
  }
  return coverage;
}

interface FreshIntegrityCoordinator {
  readonly coverage: ConnectionBoundEvidenceCoverage;
  register(sessionIds: readonly SessionId[]): void;
  seal(): void;
  assertRegistered(sessionIds: readonly SessionId[]): void;
}

function createFreshIntegrityCoordinator(
  coverageValue: ConnectionBoundEvidenceCoverage,
): FreshIntegrityCoordinator {
  const coverage = assertCompleteCoverageFacade(coverageValue);
  const checked = new Set<SessionId>();
  let acceptingRegistrations = true;
  const register = (sessionIds: readonly SessionId[]): void => {
    if (
      !acceptingRegistrations
      || !Array.isArray(sessionIds)
      || Object.getPrototypeOf(sessionIds) !== Array.prototype
      || sessionIds.length > 200
    ) return storageIntegrity();
    const pending: SessionId[] = [];
    for (const sessionId of sessionIds) {
      if (typeof sessionId !== "string" || !LOWER_UUID.test(sessionId)) {
        return storageIntegrity();
      }
      const trustedSessionId = sessionId as SessionId;
      if (!checked.has(trustedSessionId)) pending.push(trustedSessionId);
    }
    if (pending.length === 0) return;
    coverage.assertQuickHealthy(Object.freeze(pending));
    for (const sessionId of pending) checked.add(sessionId);
  };
  return {
    coverage: Object.freeze({
      ...coverage,
      registerAffectedExistingSessions: register,
    }),
    register,
    seal: () => {
      acceptingRegistrations = false;
    },
    assertRegistered: (sessionIds) => {
      for (const sessionId of sessionIds) {
        if (!checked.has(sessionId)) return storageIntegrity();
      }
    },
  };
}

function invokeFreshIntegrityGate(
  envelope: LifecycleCommandEnvelope,
  coordinator: FreshIntegrityCoordinator,
): void {
  const coverage = coordinator.coverage;
  const affected = affectedExistingSessionIds(envelope);
  if (envelope.semanticCommand.commandType === "record-evidence-batch") {
    coverage.assertEvidenceWindowWritable(envelope.semanticCommand.sessionId);
    coordinator.register(affected);
    return;
  }
  coordinator.register(affected);
}

function callbackRequiredAffectedSessionIds<T extends JsonValue>(
  envelope: LifecycleCommandEnvelope,
  commit: SnapshottedLifecycleCommit<T>,
): readonly SessionId[] {
  if (envelope.semanticCommand.commandType !== "claim-child-transfer") {
    return Object.freeze([]);
  }
  const claimed = commit.append.events[1];
  if (
    claimed?.eventType !== "ChildWorkTransferClaimed"
    || !isPlainRecord(claimed.payload)
  ) return storageIntegrity();
  const previousChildSessionId = claimed.payload.previousChildSessionId;
  if (
    typeof previousChildSessionId !== "string"
    || !LOWER_UUID.test(previousChildSessionId)
  ) return storageIntegrity();
  return Object.freeze([previousChildSessionId as SessionId]);
}

function lifecycleFaultContext(command: LifecycleCommandEnvelope): LifecycleFaultContext {
  const semantic = command.semanticCommand as unknown as Readonly<Record<string, unknown>>;
  const sessionId = typeof semantic.sessionId === "string"
    ? semantic.sessionId as SessionId
    : null;
  const workflowId = typeof semantic.workflowId === "string"
    ? semantic.workflowId as WorkflowId
    : null;
  return Object.freeze({
    projectId: command.context.binding.projectId,
    sessionId,
    workflowId,
    commandId: command.commandId,
    idempotencyKeyHash: createHash("sha256")
      .update(command.idempotencyKey, "utf8")
      .digest("hex"),
    workId: null,
    eventPosition: null,
    materializationRevision: null,
  });
}

function semanticActionName(
  command: LifecycleCommandEnvelope["semanticCommand"],
): string | null {
  const candidate = command as unknown as Readonly<Record<string, unknown>>;
  const action = candidate.action;
  if (typeof action !== "object" || action === null || Array.isArray(action)) return null;
  const descriptor = Reflect.getOwnPropertyDescriptor(action, "action");
  return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
    ? descriptor.value
    : null;
}

/**
 * Logical aliases whose commit boundary is owned by this outer transaction.
 * Physical repository sub-boundaries remain classified at their exact owners.
 */
export function lifecycleSemanticFaultBoundaries(
  command: LifecycleCommandEnvelope["semanticCommand"],
): readonly LifecycleDurableBoundary[] {
  const boundaries: LifecycleDurableBoundary[] = ["event-append"];
  switch (command.commandType) {
    case "root-resume":
    case "claim-child-transfer":
      boundaries.push("generation-fence");
      break;
    case "root-recovery":
      boundaries.push("ownership-recovery", "generation-fence");
      break;
    case "root-suspend":
      boundaries.push("session-suspend");
      break;
    case "request-session-end":
      boundaries.push("workflow-create");
      break;
    case "cancel-session-end":
      boundaries.push("cancellation-rewrite");
      break;
    case "abandon-session":
      boundaries.push("abandonment-rewrite");
      break;
    case "internal-validation-result":
      boundaries.push("validation-result");
      break;
    case "internal-workflow-phase": {
      boundaries.push("workflow-phase");
      const action = semanticActionName(command);
      if (action === "record-final-checkpoint-and-queue-ending") {
        boundaries.push("final-checkpoint", "outbox-insert");
      } else if (
        action === "record-verification-passed"
        || action === "record-verification-failed"
        || action === "invalidate-verification"
      ) {
        boundaries.push("verification-event");
      } else if (action === "append-terminal-completion") {
        boundaries.push("final-source-state-check", "session-ended");
      } else if (action === "abandon-root" || action === "abandon-generation") {
        boundaries.push("abandonment-rewrite");
      }
      break;
    }
  }
  return Object.freeze(boundaries);
}

export class LifecycleCommandStore {
  readonly #connection: SqliteConnection;
  readonly #events: LifecycleEventAppendPort;
  readonly #projectionWriter: LifecycleProjectionWriter;
  readonly #transaction: (connection: SqliteConnection) => LifecycleCommandTransaction;
  readonly #coverageRepository: EvidenceCoverageRepository | undefined;
  readonly #validationResultsRepository: LifecycleValidationResultRepository | undefined;
  readonly #now: () => string;
  readonly #materialStatus: NonNullable<LifecycleCommandStoreOptions["authorityMaterialStatus"]>;
  readonly #faults: LifecycleFaultInjector;

  constructor(options: LifecycleCommandStoreOptions) {
    const projectionWriterDescriptor = Reflect.getOwnPropertyDescriptor(
      options,
      "projectionWriter",
    );
    if (
      projectionWriterDescriptor === undefined
      || !("value" in projectionWriterDescriptor)
      || typeof projectionWriterDescriptor.value !== "object"
      || projectionWriterDescriptor.value === null
      || typeof (projectionWriterDescriptor.value as LifecycleProjectionWriter).append
        !== "function"
    ) {
      throw new LifecycleCommandStoreError("INTEGRITY_FAILURE");
    }
    this.#connection = options.connection;
    this.#events = options.events;
    this.#projectionWriter =
      projectionWriterDescriptor.value as LifecycleProjectionWriter;
    this.#transaction = options.transaction;
    this.#coverageRepository = options.evidenceCoverageRepository;
    this.#validationResultsRepository = options.validationResultsRepository;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#materialStatus = options.authorityMaterialStatus ?? (() => "unavailable");
    this.#faults = options.faultInjector ?? NO_LIFECYCLE_FAULTS;
  }

  execute<T extends JsonValue>(
    command: LifecycleCommandEnvelope,
    onNew: (transaction: LifecycleCommandTransaction) => PreparedLifecycleCommit<T>,
  ): LifecycleExecutionResult<T> {
    const envelope = immutableSnapshot(command);
    assertEnvelope(envelope);
    let transactionBegan = false;
    let commitAttempted = false;
    let commitFailed = false;
    let commitCompleted = false;
    let focused: LifecycleCommandTransaction | undefined;
    let freshIntegrity: FreshIntegrityCoordinator | undefined;
    const faultContext = lifecycleFaultContext(envelope);
    try {
      this.#connection.exec("BEGIN IMMEDIATE");
      transactionBegan = true;
      const replay = this.#events.findLifecycleReplay<T>(envelope);
      if (replay !== null) {
        const replayAuthorization = replay.authorizationRecord === null
          ? null
          : immutableSnapshot(replay.authorizationRecord);
        if (replayAuthorization === null
          || !authorizationMatchesExpectation(
            replayAuthorization,
            envelope.replayExpectation,
          )) {
          throw new LifecycleCommandStoreError("IDEMPOTENCY_CONFLICT");
        }
        const authorityMaterialStatus = materialStatusResult(synchronousCallbackResult(
          this.#materialStatus(replayAuthorization),
        ));
        this.#connection.exec("ROLLBACK");
        transactionBegan = false;
        return {
          deduplicated: true,
          publicResult: replay.response,
          appendResult: withoutAuthorization(replay),
          authorizationRecord: replayAuthorization,
          authorityMaterialStatus,
        };
      }

      this.#faults.hit("event-append", "before-write", faultContext);
      this.#events.assertCommandIdentityAvailable(envelope);
      this.#events.assertAppendAllowed();
      const rawTransaction = this.#transaction(this.#connection);
      const projected = projectCommandTransaction(this.#coverageRepository === undefined
        ? rawTransaction
        : {
            ...rawTransaction,
            coverage: connectionBoundEvidenceCoverage(
              this.#connection,
              this.#coverageRepository,
              ),
            });
      const withValidation = this.#validationResultsRepository === undefined
        ? projected
        : {
            ...projected,
            validation: connectionBoundValidationResults(
              this.#connection,
              this.#validationResultsRepository,
            ),
          };
      freshIntegrity = createFreshIntegrityCoordinator(projected.coverage);
      focused = {
        ...withValidation,
        coverage: freshIntegrity.coverage,
      };
      invokeSynchronousTransactionCallback(
        focused,
        () => invokeFreshIntegrityGate(envelope, freshIntegrity!),
        undefinedCallbackResult,
      );
      const next = invokeSynchronousTransactionCallback(focused, onNew, snapshotPreparedCommit);
      freshIntegrity.seal();
      const capabilityResolvedEnvelope = resolveFreshCapabilityGeneration(envelope, next);
      const resolvedEnvelope = next.resolvedSemanticCommand === undefined
        ? capabilityResolvedEnvelope
        : Object.freeze({
            ...capabilityResolvedEnvelope,
            semanticCommand: next.resolvedSemanticCommand,
            authoritativeIntentHash: next.resolvedAuthoritativeIntentHash
              ?? capabilityResolvedEnvelope.authoritativeIntentHash,
            candidateIntentHash: next.resolvedAuthoritativeIntentHash
              ?? capabilityResolvedEnvelope.candidateIntentHash,
            commandType: next.resolvedSemanticCommand.commandType,
          });
      assertEnvelope(resolvedEnvelope);
      const semanticFaultBoundaries = lifecycleSemanticFaultBoundaries(
        resolvedEnvelope.semanticCommand,
      );
      const authorizationFingerprint = integrityFingerprint(next.authorizationRecord);
      assertAppendIdentity(resolvedEnvelope, next);
      freshIntegrity.assertRegistered(
        callbackRequiredAffectedSessionIds(resolvedEnvelope, next),
      );
      const trustedAppend = appendWithTrustedIntent(resolvedEnvelope, next);
      const prepared = this.#events.prepare(
        trustedAppend,
        this.#now(),
        resolvedEnvelope.authoritativeIntentHash,
      );
      const planned = this.#events.planPrepared(prepared);
      const plannedFingerprint = batchFingerprint(planned);
      if (next.beforeAppend !== undefined) {
        invokeSynchronousTransactionCallback(focused, (transaction) =>
          next.beforeAppend?.(immutablePlannedSnapshot(planned), transaction), undefinedCallbackResult);
      }
      assertBatchUnchanged(planned, plannedFingerprint);
      const committed = this.#events.appendPlanned(planned);
      assertCommittedMatchesPlan(planned, committed);
      const committedFingerprint = batchFingerprint(committed);
      invokeSynchronousTransactionCallback(focused, (transaction) =>
        next.afterAppend(immutableBatchSnapshot(committed), transaction), undefinedCallbackResult);
      assertBatchUnchanged(planned, plannedFingerprint);
      assertBatchUnchanged(committed, committedFingerprint);
      assertCommittedMatchesPlan(planned, committed);
      if (integrityFingerprint(next.authorizationRecord) !== authorizationFingerprint) {
        throw new LifecycleCommandStoreError("INTEGRITY_FAILURE");
      }
      assertAppendIdentity(resolvedEnvelope, next);
      invokeSynchronousTransactionCallback(focused, (transaction) =>
        this.#projectionWriter.append(
          immutableBatchSnapshot(committed),
          transaction,
        ), undefinedCallbackResult);
      assertBatchUnchanged(committed, committedFingerprint);
      this.#events.insertDedup(prepared, committed, next.authorizationRecord);
      this.#faults.hit("event-append", "after-write-before-commit", Object.freeze({
        ...faultContext,
        eventPosition: committed.storedResponse.lastGlobalPosition,
      }));
      const authorityMaterialStatus = materialStatusResult(synchronousCallbackResult(
        this.#materialStatus(next.authorizationRecord),
      ));
      commitAttempted = true;
      try {
        this.#connection.exec("COMMIT");
      } catch (error) {
        commitFailed = true;
        throw error;
      }
      commitCompleted = true;
      transactionBegan = false;
      this.#faults.hit("event-append", "after-commit-before-response", Object.freeze({
        ...faultContext,
        eventPosition: committed.storedResponse.lastGlobalPosition,
      }));
      for (const boundary of semanticFaultBoundaries) {
        if (boundary === "event-append") continue;
        this.#faults.hit(boundary, "after-commit-before-response", Object.freeze({
          ...faultContext,
          eventPosition: committed.storedResponse.lastGlobalPosition,
        }));
      }
      const appendResult = this.#events.result(committed);
      return {
        deduplicated: false,
        publicResult: appendResult.response,
        appendResult,
        authorizationRecord: next.authorizationRecord,
        authorityMaterialStatus,
      };
    } catch (error) {
      let rollbackFailed = false;
      if (transactionBegan) {
        try {
          this.#connection.exec("ROLLBACK");
          transactionBegan = false;
        } catch {
          rollbackFailed = true;
        }
      }
      const retryableBusyCommitFailure = commitFailed && isPrimarySqliteBusy(error);
      if (rollbackFailed
        || commitCompleted
        || (commitAttempted && !retryableBusyCommitFailure)) {
        throw new LifecycleCommandStoreError("COMMAND_OUTCOME_UNKNOWN", {
          commandId: envelope.commandId,
          idempotencyKey: envelope.idempotencyKey,
        });
      }
      throw error;
    }
  }
}
