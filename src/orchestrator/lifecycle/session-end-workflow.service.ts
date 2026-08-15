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
} from "../storage/session-end.repository.js";
import type { SessionEndWorkflowOperations } from "../storage/lifecycle-storage.types.js";

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

  constructor(options: SessionEndWorkflowServiceOptions) {
    this.#operations = new ConnectionBoundSessionEndWorkflowOperations(options.connection);
  }

  get operations(): ConnectionBoundSessionEndWorkflowOperations {
    return this.#operations;
  }
}

