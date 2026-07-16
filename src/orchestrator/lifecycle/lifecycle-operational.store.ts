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

export interface LifecycleOperationalRepositorySet {
  readonly workflows: ConnectionBoundSessionEndWorkflowOperations;
  readonly outbox: ConnectionBoundLifecycleOutboxOperations;
}

export interface WorkflowOperationalTransaction {
  readonly workflows: ConnectionBoundSessionEndWorkflowOperations;
}

export interface OutboxOperationalTransaction {
  readonly outbox: ConnectionBoundLifecycleOutboxOperations;
}

export type LifecycleOperationalTransaction =
  | WorkflowOperationalTransaction
  | OutboxOperationalTransaction;

export type LifecycleOperationalTransactionFor<
  TWork extends LifecycleOperationalWorkIdentity,
> = TWork extends WorkflowOperationalWorkIdentity
  ? WorkflowOperationalTransaction
  : OutboxOperationalTransaction;

export interface LifecycleOperationalResult<
  T,
  TWork extends LifecycleOperationalWorkIdentity = LifecycleOperationalWorkIdentity,
> {
  readonly work: TWork;
  readonly publicResult: T;
}

export interface LifecycleOperationalStoreOptions {
  readonly connection: SqliteConnection;
  readonly transaction: (connection: SqliteConnection) => LifecycleOperationalRepositorySet;
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
  readonly #transaction: (connection: SqliteConnection) => LifecycleOperationalRepositorySet;
  readonly #afterCommit: (work: LifecycleOperationalWorkIdentity) => void;

  constructor(options: LifecycleOperationalStoreOptions) {
    this.#connection = options.connection;
    this.#transaction = options.transaction;
    this.#afterCommit = options.afterCommit ?? (() => undefined);
  }

  execute<TWork extends LifecycleOperationalWorkIdentity, T>(
    work: TWork,
    onCurrent: (transaction: LifecycleOperationalTransactionFor<TWork>) => T,
  ): LifecycleOperationalResult<T, TWork> {
    assertWork(work);
    let transactionBegan = false;
    let commitAttempted = false;
    try {
      this.#connection.exec("BEGIN IMMEDIATE");
      transactionBegan = true;
      const repositories = this.#transaction(this.#connection);
      const focused = work.kind === "workflow"
        ? Object.freeze({ workflows: repositories.workflows })
        : Object.freeze({ outbox: repositories.outbox });
      const result = onCurrent(focused as LifecycleOperationalTransactionFor<TWork>);
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
