import type { SqliteConnection } from "../storage/sqlite-driver.js";
import {
  SessionEndWorkflowRepository,
  type PersistedValidationAttemptPlansWriteV1,
  type SessionEndWorkflowClaimInputV1,
  type SessionEndWorkflowClaimNextInputV1,
  type SessionEndWorkflowClaimV1,
  type SessionEndWorkflowEventlessPhaseInputV1,
  type SessionEndWorkflowRecordV1,
  type SessionEndWorkflowReleaseInputV1,
  type SessionEndWorkflowRenewInputV1,
  type StoredValidationAttemptPlansV1,
  type SessionEndWorkflowRequestedInputV1,
} from "../storage/session-end.repository.js";
import type { SessionEndWorkflowOperations } from "../storage/lifecycle-storage.types.js";
import type {
  SessionEndPhase,
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

  constructor(connection: SqliteConnection) {
    this.#repository = new SessionEndWorkflowRepository(connection);
    Object.freeze(this);
  }
}

export interface SessionEndWorkflowServiceOptions {
  readonly connection: SqliteConnection;
}

/**
 * Composition root for session-end workflow operations.  Business services
 * can receive the returned capability inside an already-open transaction;
 * this object never exposes transaction control or the underlying connection.
 */
export class SessionEndWorkflowService {
  readonly #operations: ConnectionBoundSessionEndWorkflowOperations;
  readonly #repository: SessionEndWorkflowRepository;

  constructor(options: SessionEndWorkflowServiceOptions) {
    this.#repository = new SessionEndWorkflowRepository(options.connection);
    this.#operations = new ConnectionBoundSessionEndWorkflowOperations(options.connection);
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
}
