import { isPrimarySqliteBusy } from "../storage/event-append-transaction.js";
import type { SqliteConnection } from "../storage/sqlite-driver.js";
import { LifecycleError } from "./errors.js";

export interface WorkflowOperationalWorkIdentity {
  readonly kind: "workflow";
  readonly projectId: string;
  readonly workflowId: string;
  readonly workflowGeneration: bigint;
  readonly operation: "claim" | "renew" | "release" | "advance-eventless";
  readonly ownerId: string;
  readonly claimToken: bigint;
}

export interface OutboxOperationalWorkIdentity {
  readonly kind: "outbox";
  readonly projectId: string;
  readonly targetKey: string;
  readonly materializationRevision: bigint;
  readonly operation: "claim" | "renew" | "materialize" | "record-failure";
  readonly ownerId: string;
  readonly claimToken: bigint;
}

export type LifecycleOperationalWorkIdentity =
  | WorkflowOperationalWorkIdentity
  | OutboxOperationalWorkIdentity;

export interface ConnectionBoundSessionEndWorkflowOperations {}
export interface ConnectionBoundLifecycleOutboxOperations {}

export interface LifecycleOperationalTransaction {
  readonly workflows: ConnectionBoundSessionEndWorkflowOperations;
  readonly outbox: ConnectionBoundLifecycleOutboxOperations;
}

export interface LifecycleOperationalResult<T> {
  readonly work: LifecycleOperationalWorkIdentity;
  readonly publicResult: T;
}

export interface LifecycleOperationalStoreOptions {
  readonly connection: SqliteConnection;
  readonly transaction: (connection: SqliteConnection) => LifecycleOperationalTransaction;
  readonly afterCommit?: (work: LifecycleOperationalWorkIdentity) => void;
}

export class LifecycleOperationalStoreError extends LifecycleError {
  readonly work: LifecycleOperationalWorkIdentity;

  constructor(
    code: "OPERATION_OUTCOME_UNKNOWN" | "LIFECYCLE_INPUT_INVALID",
    work: LifecycleOperationalWorkIdentity,
  ) {
    super(code);
    this.work = work;
  }
}

function assertWork(work: LifecycleOperationalWorkIdentity): void {
  const revision = work.kind === "workflow"
    ? work.workflowGeneration
    : work.materializationRevision;
  if (work.projectId.length === 0
    || work.ownerId.length === 0
    || work.claimToken <= 0n
    || revision <= 0n
    || (work.kind === "workflow" ? work.workflowId.length === 0 : work.targetKey.length === 0)) {
    throw new LifecycleOperationalStoreError("LIFECYCLE_INPUT_INVALID", work);
  }
}

export class LifecycleOperationalStore {
  readonly #connection: SqliteConnection;
  readonly #transaction: (connection: SqliteConnection) => LifecycleOperationalTransaction;
  readonly #afterCommit: (work: LifecycleOperationalWorkIdentity) => void;

  constructor(options: LifecycleOperationalStoreOptions) {
    this.#connection = options.connection;
    this.#transaction = options.transaction;
    this.#afterCommit = options.afterCommit ?? (() => undefined);
  }

  execute<T>(
    work: LifecycleOperationalWorkIdentity,
    onCurrent: (transaction: LifecycleOperationalTransaction) => T,
  ): LifecycleOperationalResult<T> {
    assertWork(work);
    let transactionBegan = false;
    let commitAttempted = false;
    try {
      this.#connection.exec("BEGIN IMMEDIATE");
      transactionBegan = true;
      const result = onCurrent(this.#transaction(this.#connection));
      commitAttempted = true;
      this.#connection.exec("COMMIT");
      transactionBegan = false;
      this.#afterCommit(work);
      return { work, publicResult: result };
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
      if (rollbackFailed || (commitAttempted && !isPrimarySqliteBusy(error))) {
        throw new LifecycleOperationalStoreError("OPERATION_OUTCOME_UNKNOWN", work);
      }
      throw error;
    }
  }
}
