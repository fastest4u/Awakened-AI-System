import type { SqliteConnection } from "../storage/sqlite-driver.js";
import {
  SessionEndWorkflowRepository,
  hydrateSessionEndEffectiveStateV1,
  readEffectiveStateSourceEventPositionV1,
  type PersistedValidationAttemptPlansWriteV1,
  type SessionEndWorkflowClaimInputV1,
  type SessionEndWorkflowClaimNextInputV1,
  type SessionEndWorkflowClaimV1,
  type SessionEndWorkflowEventlessPhaseInputV1,
  type SessionEndWorkflowEventfulPhaseInputV1,
  type SessionEndWorkflowFinalCheckpointInputV1,
  type SessionEndWorkflowRecoveryInputV1,
  type SessionEndWorkflowRecoveryResultV1,
  type SessionEndWorkflowRecordV1,
  type SessionEndWorkflowReleaseInputV1,
  type SessionEndWorkflowRenewInputV1,
  type StoredValidationAttemptPlansV1,
  type SessionEndWorkflowRequestedInputV1,
  type SessionEndWorkflowAmendmentInputV1,
  type SessionEndWorkflowCancellationInputV1,
  type SessionEndWorkflowAbandonmentInputV1,
  type HydratedSessionEndEffectiveStateV1,
} from "../storage/session-end.repository.js";
import type { SessionEndWorkflowOperations } from "../storage/lifecycle-storage.types.js";
import type { LifecycleFaultInjector } from "./lifecycle-faults.js";
import type {
  SessionEndPhase,
  SessionEndPhaseResultV2,
  SessionEndStatusV2,
} from "./contracts/session-end.js";

export interface RequestedSessionEndStatusInputV2 {
  readonly sessionId: string;
  readonly workflowId: string;
  readonly workflowGeneration: number;
  readonly priorRootState: "active" | "suspended";
  readonly triggeringEventPosition: bigint;
  readonly evidenceWindowState: "open" | "sealed";
  readonly materializationRequired: boolean;
}

/** Builds the canonical status stored alongside a newly requested workflow. */
export function requestedSessionEndStatusV2(
  input: RequestedSessionEndStatusInputV2,
): SessionEndStatusV2 {
  if (!Number.isSafeInteger(input.workflowGeneration) || input.workflowGeneration <= 0) {
    throw new Error("invalid workflow generation");
  }
  if (input.triggeringEventPosition <= 0n) throw new Error("invalid triggering position");
  if (input.evidenceWindowState !== "open" && input.evidenceWindowState !== "sealed") {
    throw new Error("invalid evidence window");
  }
  if (typeof input.materializationRequired !== "boolean") {
    throw new Error("invalid materialization requirement");
  }
  const evidenceWindow = Object.freeze({
    evidenceWindowState: input.evidenceWindowState,
    evidenceFrozenCheckpointEventPosition: null,
    evidenceFrozenGeneration: null,
  });
  return Object.freeze({
    resultVersion: 2,
    sessionId: input.sessionId,
    workflowId: input.workflowId,
    workflowGeneration: input.workflowGeneration,
    phase: "requested" as SessionEndPhase,
    priorRootState: input.priorRootState,
    triggeringEventPosition: input.triggeringEventPosition.toString(),
    finalCheckpointId: null,
    finalCheckpointEventPosition: null,
    evidenceWindow,
    validationPlansReady: false,
    qualityScore: null,
    safeFailureCode: null,
    materializationRequired: input.materializationRequired,
  }) as SessionEndStatusV2;
}

function statusObject(value: string): Record<string, unknown> | null {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return null; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const nested = record.status;
  if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  return record;
}

function materializationRequiredFromWorkflow(
  workflow: SessionEndWorkflowRecordV1,
): boolean {
  const current = workflow.resultJson === null ? null : statusObject(workflow.resultJson);
  return current !== null && typeof current.materializationRequired === "boolean"
    ? current.materializationRequired
    : true;
}

export interface SessionEndGenerationStatusInputV2 {
  readonly current: SessionEndWorkflowRecordV1;
  readonly priorRootState: "active" | "suspended";
  readonly workflowGeneration: number;
  readonly triggeringEventPosition: bigint;
  readonly phase: SessionEndPhase;
  readonly evidenceWindowState: "open" | "sealed";
  readonly materializationRequired: boolean;
  readonly clearFrozenGroup: boolean;
}

/** Rebuilds the canonical 14-key public status for a generation transition. */
export function sessionEndGenerationStatusV2(
  input: SessionEndGenerationStatusInputV2,
): SessionEndStatusV2 {
  const currentStatus = input.current.resultJson === null
    ? null
    : statusObject(input.current.resultJson);
  const base = currentStatus === null
    ? requestedSessionEndStatusV2({
        sessionId: input.current.sessionId,
        workflowId: input.current.workflowId,
        workflowGeneration: input.current.generation,
        priorRootState: input.priorRootState,
        triggeringEventPosition: input.current.triggeringEventPosition,
        evidenceWindowState: input.current.evidenceWindowState ?? input.evidenceWindowState,
        materializationRequired: input.materializationRequired,
      })
    : currentStatus;
  const frozen = input.clearFrozenGroup
    ? Object.freeze({
        evidenceWindowState: input.evidenceWindowState,
        evidenceFrozenCheckpointEventPosition: null,
        evidenceFrozenGeneration: null,
      })
    : Object.freeze({
        evidenceWindowState: input.evidenceWindowState,
        evidenceFrozenCheckpointEventPosition:
          base.evidenceWindow && typeof base.evidenceWindow === "object"
            && base.evidenceWindow !== null
            && !Array.isArray(base.evidenceWindow)
            ? (base.evidenceWindow as Record<string, unknown>)
              .evidenceFrozenCheckpointEventPosition ?? null
            : null,
        evidenceFrozenGeneration:
          base.evidenceWindow && typeof base.evidenceWindow === "object"
            && base.evidenceWindow !== null
            && !Array.isArray(base.evidenceWindow)
            ? (base.evidenceWindow as Record<string, unknown>)
              .evidenceFrozenGeneration ?? null
            : null,
      });
  return Object.freeze({
    resultVersion: 2,
    sessionId: input.current.sessionId,
    workflowId: input.current.workflowId,
    workflowGeneration: input.workflowGeneration,
    phase: input.phase,
    priorRootState: input.priorRootState,
    triggeringEventPosition: input.triggeringEventPosition.toString(),
    finalCheckpointId: input.clearFrozenGroup ? null : (base.finalCheckpointId ?? null),
    finalCheckpointEventPosition: input.clearFrozenGroup
      ? null
      : (base.finalCheckpointEventPosition ?? null),
    evidenceWindow: frozen,
    validationPlansReady: input.clearFrozenGroup ? false : base.validationPlansReady === true,
    qualityScore: input.clearFrozenGroup ? null : (base.qualityScore ?? null),
    safeFailureCode: input.clearFrozenGroup ? null : (base.safeFailureCode ?? null),
    materializationRequired: input.materializationRequired,
  }) as SessionEndStatusV2;
}

export interface SessionEndFinalCheckpointStatusInputV2 {
  readonly current: SessionEndWorkflowRecordV1;
  readonly checkpointId: string;
  readonly checkpointEventPosition: bigint;
  readonly priorRootState: "active" | "suspended";
}

/** Builds the frozen status written when the V3 final marker commits. */
export function sessionEndFinalCheckpointStatusV2(
  input: SessionEndFinalCheckpointStatusInputV2,
): SessionEndStatusV2 {
  const currentStatus = input.current.resultJson === null
    ? null
    : statusObject(input.current.resultJson);
  const materializationRequired = currentStatus !== null
    && typeof currentStatus.materializationRequired === "boolean"
    ? currentStatus.materializationRequired
    : true;
  return Object.freeze({
    resultVersion: 2,
    sessionId: input.current.sessionId,
    workflowId: input.current.workflowId,
    workflowGeneration: input.current.generation,
    phase: "final-checkpoint-recorded" as const,
    priorRootState: input.priorRootState,
    triggeringEventPosition: input.checkpointEventPosition.toString(),
    finalCheckpointId: input.checkpointId,
    finalCheckpointEventPosition: input.checkpointEventPosition.toString(),
    evidenceWindow: Object.freeze({
      evidenceWindowState: "sealed" as const,
      evidenceFrozenCheckpointEventPosition: input.checkpointEventPosition.toString(),
      evidenceFrozenGeneration: input.current.generation,
    }),
    validationPlansReady: false,
    qualityScore: null,
    safeFailureCode: null,
    materializationRequired,
  }) as SessionEndStatusV2;
}

/** Builds the public result for the eventless final-materialization handoff. */
export function sessionEndMaterializationQueuedResultV2(
  current: SessionEndWorkflowRecordV1,
): SessionEndPhaseResultV2 {
  const status = sessionEndGenerationStatusV2({
    current,
    priorRootState: current.state === "suspended" ? "suspended" : "active",
    workflowGeneration: current.generation,
    triggeringEventPosition: current.triggeringEventPosition,
    phase: "ending-materialization-queued",
    evidenceWindowState: "sealed",
    materializationRequired: materializationRequiredFromWorkflow(current),
    clearFrozenGroup: false,
  });
  return Object.freeze({
    resultVersion: 2,
    action: "confirm-ending-materialization" as const,
    progressed: true,
    previousPhase: "final-checkpoint-recorded" as const,
    status,
  });
}

/** Builds the eventless result after the immutable validation plan has been
 * persisted and the workflow has entered the validation phase. */
export function sessionEndValidationStartedResultV2(
  current: SessionEndWorkflowRecordV1,
): SessionEndPhaseResultV2 {
  const base = sessionEndGenerationStatusV2({
    current,
    priorRootState: current.state === "suspended" ? "suspended" : "active",
    workflowGeneration: current.generation,
    triggeringEventPosition: current.triggeringEventPosition,
    phase: "validating",
    evidenceWindowState: "sealed",
    materializationRequired: materializationRequiredFromWorkflow(current),
    clearFrozenGroup: false,
  });
  const status = Object.freeze({
    ...(base as unknown as Record<string, unknown>),
    validationPlansReady: true,
  }) as unknown as SessionEndStatusV2;
  return Object.freeze({
    resultVersion: 2,
    action: "begin-validation" as const,
    progressed: true,
    previousPhase: "ending-materialization-queued" as const,
    status,
  });
}

/**
 * A plain own-property facade is required by the transaction guard.  Every
 * method closes over the storage repository while deliberately omitting the
 * SQLite connection from the public capability surface.
 */
export class ConnectionBoundSessionEndWorkflowOperations
  implements SessionEndWorkflowOperations
{
  readonly #repository: SessionEndWorkflowRepository;

  readonly read = (projectId: string, workflowId: string): SessionEndWorkflowRecordV1 | null =>
    this.#repository.read(projectId, workflowId);

  readonly claimNext = (
    input: SessionEndWorkflowClaimNextInputV1,
  ): SessionEndWorkflowClaimV1 | null => this.#repository.claimNext(input);

  readonly claim = (
    input: SessionEndWorkflowClaimInputV1,
  ): SessionEndWorkflowClaimV1 | null => this.#repository.claim(input);

  readonly renew = (
    input: SessionEndWorkflowRenewInputV1,
  ): SessionEndWorkflowClaimV1 | null => this.#repository.renew(input);

  readonly release = (input: SessionEndWorkflowReleaseInputV1): boolean =>
    this.#repository.release(input);

  readonly advanceEventlessPhase = (
    input: SessionEndWorkflowEventlessPhaseInputV1,
  ): boolean => this.#repository.advanceEventlessPhase(input);

  readonly advanceEventfulPhase = (
    input: SessionEndWorkflowEventfulPhaseInputV1,
  ): boolean => this.#repository.advanceEventfulPhase(input);

  readonly recover = (
    input: SessionEndWorkflowRecoveryInputV1,
  ): SessionEndWorkflowRecoveryResultV1 => this.#repository.recover(input);

  readonly recordFinalCheckpoint = (
    input: SessionEndWorkflowFinalCheckpointInputV1,
  ): void => this.#repository.recordFinalCheckpoint(input);

  readonly readPersistedValidationAttemptPlansV1 = (
    projectId: string,
    workflowId: string,
  ): StoredValidationAttemptPlansV1 | null =>
    this.#repository.readPersistedValidationAttemptPlansV1(projectId, workflowId);

  readonly writePersistedValidationAttemptPlansV1 = (
    input: PersistedValidationAttemptPlansWriteV1,
  ): void => {
    this.#repository.writePersistedValidationAttemptPlansV1(input);
  };

  constructor(
    connection: SqliteConnection,
    options: { readonly faultInjector?: LifecycleFaultInjector } = {},
  ) {
    this.#repository = new SessionEndWorkflowRepository(connection, options);
    Object.defineProperty(this, "recordFinalCheckpoint", { enumerable: false });
    Object.defineProperty(this, "recover", { enumerable: false });
    Object.defineProperty(this, "advanceEventfulPhase", { enumerable: false });
    Object.freeze(this);
  }
}

export interface SessionEndWorkflowServiceOptions {
  readonly connection: SqliteConnection;
  readonly faultInjector?: LifecycleFaultInjector;
}

/**
 * Composition root for session-end workflow operations.  Business services
 * can receive the returned capability inside an already-open transaction;
 * this object never exposes transaction control or the underlying connection.
 */
export class SessionEndWorkflowService {
  readonly #connection: SqliteConnection;
  readonly #operations: ConnectionBoundSessionEndWorkflowOperations;
  readonly #repository: SessionEndWorkflowRepository;

  constructor(options: SessionEndWorkflowServiceOptions) {
    this.#connection = options.connection;
    this.#repository = new SessionEndWorkflowRepository(options.connection, options);
    this.#operations = new ConnectionBoundSessionEndWorkflowOperations(options.connection, options);
  }

  get operations(): ConnectionBoundSessionEndWorkflowOperations {
    return this.#operations;
  }

  read(projectId: string, workflowId: string): SessionEndWorkflowRecordV1 | null {
    return this.#repository.read(projectId, workflowId);
  }

  createRequested(input: SessionEndWorkflowRequestedInputV1): void {
    this.#repository.createRequested(input);
  }

  reopenCancelled(input: SessionEndWorkflowRequestedInputV1): void {
    this.#repository.reopenCancelled(input);
  }

  amendGeneration(input: SessionEndWorkflowAmendmentInputV1): void {
    this.#repository.amendGeneration(input);
  }

  cancelGeneration(input: SessionEndWorkflowCancellationInputV1): void {
    this.#repository.cancelGeneration(input);
  }

  abandonGeneration(input: SessionEndWorkflowAbandonmentInputV1): void {
    this.#repository.abandonGeneration(input);
  }

  recordFinalCheckpoint(input: SessionEndWorkflowFinalCheckpointInputV1): void {
    this.#repository.recordFinalCheckpoint(input);
  }

  hydrateEffectiveStateV1(input: {
    readonly projectId: string;
    readonly workflowId: string;
    readonly workflowGeneration: number;
    readonly sessionId: string;
  }): HydratedSessionEndEffectiveStateV1 {
    return hydrateSessionEndEffectiveStateV1(this.#connection, {
      ...input,
      eventPosition: readEffectiveStateSourceEventPositionV1(this.#connection, input),
    });
  }

  priorRootState(workflow: SessionEndWorkflowRecordV1): "active" | "suspended" {
    const rows = this.#connection.prepare(`
      SELECT payload_json
      FROM events
      WHERE project_id = $projectId
        AND event_type = 'SessionEndRequested'
        AND json_extract(payload_json, '$.workflowId') = $workflowId
        AND json_extract(payload_json, '$.workflowGeneration') <= $workflowGeneration
      ORDER BY json_extract(payload_json, '$.workflowGeneration') DESC,
               global_position DESC
      LIMIT 2
    `).all({
      $projectId: workflow.projectId,
      $workflowId: workflow.workflowId,
      $workflowGeneration: workflow.generation,
    });
    const payload = rows[0]?.payload_json;
    if (typeof payload !== "string") throw new Error("missing session-end request origin");
    let parsed: unknown;
    try { parsed = JSON.parse(payload); } catch { throw new Error("invalid session-end request origin"); }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("invalid session-end request origin");
    }
    const previousState = (parsed as Record<string, unknown>).previousState;
    if (previousState !== "active" && previousState !== "suspended") {
      throw new Error("invalid session-end request origin");
    }
    return previousState;
  }
}
