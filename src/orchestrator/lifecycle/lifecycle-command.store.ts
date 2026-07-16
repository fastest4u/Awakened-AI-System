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
import { canonicalJson } from "../serialization/canonical-json.js";
import { LifecycleError } from "./errors.js";

const LOWER_HASH = /^[0-9a-f]{64}$/;

export interface LifecycleCommandEnvelope {
  readonly context: ProjectContext;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly commandType: string;
  readonly candidateIntentHash: string;
  readonly authoritativeIntentHash: string;
  readonly replayExpectation: LifecycleReplayExpectation;
}

export interface ConnectionBoundSessionAuthority {}
export interface ConnectionBoundSessionLeases {}
export interface ConnectionBoundLifecycleApprovals {}
export interface ConnectionBoundChildTransfers {}
export interface ConnectionBoundEvidenceCoverage {}
export interface ConnectionBoundSessionEndWorkflows {}
export interface ConnectionBoundValidationResults {}
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
  readonly append: AppendCommand<T>;
  readonly authorizationRecord: PersistedLifecycleAuthorizationRecord;
  readonly beforeAppend?: (
    planned: PlannedEventAppend<T>,
    transaction: LifecycleCommandTransaction,
  ) => void;
  readonly afterAppend: (
    committed: EventAppendBatch<T>,
    transaction: LifecycleCommandTransaction,
  ) => void;
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
  readonly transaction: (connection: SqliteConnection) => LifecycleCommandTransaction;
  readonly now?: () => string;
  readonly authorityMaterialStatus?: (
    authorization: PersistedLifecycleAuthorizationRecord,
    transaction: LifecycleCommandTransaction,
  ) => AuthorityMaterialStatus;
}

export class LifecycleCommandStoreError extends LifecycleError {
  readonly details: Readonly<Record<string, string>>;

  constructor(
    code: "IDEMPOTENCY_CONFLICT" | "COMMAND_OUTCOME_UNKNOWN" | "LIFECYCLE_INPUT_INVALID" | "INTEGRITY_FAILURE",
    details: Readonly<Record<string, string>> = {},
  ) {
    super(code, details);
    this.details = Object.freeze({ ...details });
  }
}

function authorizationMatchesExpectation(
  record: PersistedLifecycleAuthorizationRecord,
  expectation: LifecycleReplayExpectation,
): boolean {
  return matchesLifecycleReplayAuthorization(record, expectation);
}

function assertEnvelope(command: LifecycleCommandEnvelope): void {
  if (!LOWER_HASH.test(command.candidateIntentHash)
    || !LOWER_HASH.test(command.authoritativeIntentHash)
    || command.commandId.length === 0
    || command.idempotencyKey.length === 0
    || command.commandType.length === 0) {
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
}

function withoutAuthorization<T extends JsonValue>(
  result: EventAppendReplay<T>,
): AppendResult<T> {
  const { authorizationRecord: _authorizationRecord, ...appendResult } = result;
  return appendResult;
}

function assertCommittedMatchesPlan<T extends JsonValue>(
  planned: PlannedEventAppend<T>,
  committed: EventAppendBatch<T>,
): void {
  const responseMatches = planned.responseHash === committed.responseHash
    && planned.storedResponse.firstGlobalPosition === committed.storedResponse.firstGlobalPosition
    && planned.storedResponse.lastGlobalPosition === committed.storedResponse.lastGlobalPosition
    && planned.storedResponse.finalStreamVersion === committed.storedResponse.finalStreamVersion
    && canonicalJson(planned.storedResponse.eventIds) === canonicalJson(committed.storedResponse.eventIds)
    && canonicalJson(planned.storedResponse.response) === canonicalJson(committed.storedResponse.response);
  const eventsMatch = planned.events.length === committed.events.length
    && planned.events.every((event, index) => {
      const inserted = committed.events[index];
      return inserted !== undefined
        && event.eventId === inserted.eventId
        && event.globalPosition === inserted.globalPosition
        && event.streamVersion === inserted.streamVersion
        && event.commandEventIndex === inserted.commandEventIndex
        && event.eventHash === inserted.eventHash;
    });
  if (!responseMatches || !eventsMatch) {
    throw new LifecycleCommandStoreError("INTEGRITY_FAILURE");
  }
}

export class LifecycleCommandStore {
  readonly #connection: SqliteConnection;
  readonly #events: LifecycleEventAppendPort;
  readonly #transaction: (connection: SqliteConnection) => LifecycleCommandTransaction;
  readonly #now: () => string;
  readonly #materialStatus: NonNullable<LifecycleCommandStoreOptions["authorityMaterialStatus"]>;

  constructor(options: LifecycleCommandStoreOptions) {
    this.#connection = options.connection;
    this.#events = options.events;
    this.#transaction = options.transaction;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#materialStatus = options.authorityMaterialStatus ?? (() => "unavailable");
  }

  execute<T extends JsonValue>(
    command: LifecycleCommandEnvelope,
    onNew: (transaction: LifecycleCommandTransaction) => PreparedLifecycleCommit<T>,
  ): LifecycleExecutionResult<T> {
    assertEnvelope(command);
    let transactionBegan = false;
    let commitAttempted = false;
    let focused: LifecycleCommandTransaction | undefined;
    try {
      this.#connection.exec("BEGIN IMMEDIATE");
      transactionBegan = true;
      const replay = this.#events.findLifecycleReplay<T>(command);
      if (replay !== null) {
        this.#connection.exec("ROLLBACK");
        transactionBegan = false;
        if (replay.authorizationRecord === null
          || !authorizationMatchesExpectation(
            replay.authorizationRecord,
            command.replayExpectation,
          )) {
          throw new LifecycleCommandStoreError("IDEMPOTENCY_CONFLICT");
        }
        focused = this.#transaction(this.#connection);
        return {
          deduplicated: true,
          publicResult: replay.response,
          appendResult: withoutAuthorization(replay),
          authorizationRecord: replay.authorizationRecord,
          authorityMaterialStatus: this.#materialStatus(replay.authorizationRecord, focused),
        };
      }

      this.#events.assertCommandIdentityAvailable(command);
      this.#events.assertAppendAllowed();
      focused = this.#transaction(this.#connection);
      const next = onNew(focused);
      assertAppendIdentity(command, next);
      const prepared = this.#events.prepare(
        next.append,
        this.#now(),
        command.authoritativeIntentHash,
      );
      const planned = this.#events.planPrepared(prepared);
      next.beforeAppend?.(planned, focused);
      const committed = this.#events.appendPlanned(planned);
      assertCommittedMatchesPlan(planned, committed);
      next.afterAppend(committed, focused);
      this.#events.insertDedup(prepared, committed, next.authorizationRecord);
      commitAttempted = true;
      this.#connection.exec("COMMIT");
      transactionBegan = false;
      const appendResult = this.#events.result(committed);
      return {
        deduplicated: false,
        publicResult: appendResult.response,
        appendResult,
        authorizationRecord: next.authorizationRecord,
        authorityMaterialStatus: this.#materialStatus(next.authorizationRecord, focused),
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
      if (rollbackFailed || (commitAttempted && !isPrimarySqliteBusy(error))) {
        throw new LifecycleCommandStoreError("COMMAND_OUTCOME_UNKNOWN", {
          commandId: command.commandId,
          idempotencyKey: command.idempotencyKey,
        });
      }
      throw error;
    }
  }
}
