import { hasUncertainGovernedRecoveryCleanup } from "../governed-notes/service.js";
import { randomUUID } from "node:crypto";
import type {
  AppendCommand,
  AppendResult,
  JsonValue,
} from "../contracts/event.js";
import { BranchScopeRepository } from "./branch-scope.repository.js";
import {
  EventAppendTransaction,
  EventStoreError,
  NO_EVENT_STORE_FAULTS,
  SqliteEventAppendStatements,
  isPrimarySqliteBusy,
  normalizeEventStoreError,
  type EventAppendStatements,
  type EventStoreFaultContext,
  type EventStoreFaultInjector,
} from "./event-append-transaction.js";
import { MaintenanceFence } from "./maintenance-fence.js";
import type { SqliteConnection } from "./sqlite-driver.js";

export {
  EventStoreError,
  GENESIS_GLOBAL_HASH,
  MAX_CANONICAL_COMMAND_BYTES,
  MAX_EVENTS_PER_COMMAND,
  NO_EVENT_STORE_FAULTS,
  SqliteEventAppendStatements,
} from "./event-append-transaction.js";
export type {
  EventAppendStatements,
  EventStoreFaultBoundary,
  EventStoreFaultContext,
  EventStoreFaultInjector,
} from "./event-append-transaction.js";

/** Backwards-compatible name retained for existing EventStore construction. */
export { SqliteEventAppendStatements as SqliteEventStoreStatements };

export class EventStore {
  constructor(
    private readonly connection: SqliteConnection,
    private readonly statements: EventAppendStatements,
    private readonly maintenance: MaintenanceFence,
    private readonly branchScopes: BranchScopeRepository,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly randomId: () => string = randomUUID,
    private readonly faultInjector: EventStoreFaultInjector = NO_EVENT_STORE_FAULTS,
  ) {}

  append<TResponse extends JsonValue>(
    command: AppendCommand<TResponse>,
  ): AppendResult<TResponse> {
    if (hasUncertainGovernedRecoveryCleanup(this.connection)) throw new EventStoreError("GOVERNED_NOTE_UNAVAILABLE");
    const transaction = new EventAppendTransaction(
      this.connection,
      this.statements,
      this.maintenance,
      this.branchScopes,
      this.randomId,
      this.faultInjector,
    );
    const prepared = transaction.prepare(command, this.now());
    const faultContext: EventStoreFaultContext = {
      projectId: command.context.binding.projectId,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
    };
    let transactionBegan = false;
    let commitAttempted = false;
    try {
      this.faultInjector.hit("before-begin", faultContext);
      this.connection.exec("BEGIN IMMEDIATE");
      transactionBegan = true;
      const replay = transaction.findReplay(prepared, null);
      if (replay !== null) {
        this.connection.exec("ROLLBACK");
        transactionBegan = false;
        const { authorizationRecord: _authorizationRecord, ...publicReplay } = replay;
        return publicReplay;
      }
      transaction.assertCommandIdAvailable(prepared);
      transaction.assertAppendAllowed();
      const planned = transaction.planPrepared(prepared);
      const committed = transaction.appendPlanned(planned);
      transaction.insertDedup(prepared, committed, null);
      commitAttempted = true;
      this.connection.exec("COMMIT");
      transactionBegan = false;
      this.faultInjector.hit("after-commit-before-response", faultContext);
      return transaction.result(committed);
    } catch (error) {
      let rollbackFailed = false;
      if (transactionBegan) {
        try {
          this.connection.exec("ROLLBACK");
          transactionBegan = false;
        } catch {
          rollbackFailed = true;
        }
      }
      if (rollbackFailed || (commitAttempted && !isPrimarySqliteBusy(error))) {
        throw new EventStoreError("COMMAND_OUTCOME_UNKNOWN", {
          commandId: command.commandId,
          idempotencyKey: command.idempotencyKey,
        });
      }
      throw normalizeEventStoreError(error);
    }
  }
}
