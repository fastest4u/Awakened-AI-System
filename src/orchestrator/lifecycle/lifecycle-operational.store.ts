import { isPrimarySqliteBusy } from "../storage/event-append-transaction.js";
import type { JsonValue } from "../contracts/event.js";
import type { SqliteConnection } from "../storage/sqlite-driver.js";
import { LifecycleError } from "./errors.js";

const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WORKFLOW_OPERATIONS = new Set<WorkflowOperationalWorkIdentity["operation"]>([
  "claim", "renew", "release", "advance-eventless",
]);
const OUTBOX_OPERATIONS = new Set<OutboxOperationalWorkIdentity["operation"]>([
  "claim", "renew", "materialize", "record-failure",
]);

export interface WorkflowSelectionOperationalWorkIdentity {
  readonly kind: "workflow-selection";
  readonly projectId: string;
  readonly workId: string;
  readonly operation: "claim-next";
  readonly ownerId: string;
}

export interface OutboxSelectionOperationalWorkIdentity {
  readonly kind: "outbox-selection";
  readonly projectId: string;
  readonly workId: string;
  readonly operation: "claim-next";
  readonly ownerId: string;
}

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
  | WorkflowSelectionOperationalWorkIdentity
  | OutboxSelectionOperationalWorkIdentity
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
  : TWork extends WorkflowSelectionOperationalWorkIdentity
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
  /** Facade capabilities must be explicit own data properties; prototypes/accessors are excluded. */
  readonly transaction: (connection: SqliteConnection) => LifecycleOperationalRepositorySet;
  readonly afterCommit?: (work: LifecycleOperationalWorkIdentity) => undefined;
}

export class LifecycleOperationalStoreError extends LifecycleError {
  readonly work: LifecycleOperationalWorkIdentity | null;

  constructor(
    code: "OPERATION_OUTCOME_UNKNOWN" | "LIFECYCLE_INPUT_INVALID",
    work: LifecycleOperationalWorkIdentity | null,
  ) {
    super(code);
    this.work = work;
  }
}

function invalidWork(): never {
  throw new LifecycleOperationalStoreError("LIFECYCLE_INPUT_INVALID", null);
}

function strictDataRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidWork();
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) invalidWork();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))) {
    invalidWork();
  }
  const record: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) invalidWork();
    record[key] = descriptor.value;
  }
  return record;
}

function nonEmptyString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) invalidWork();
  return value;
}

function canonicalUuid(value: unknown): string {
  const decoded = nonEmptyString(value);
  if (!LOWER_UUID.test(decoded)) invalidWork();
  return decoded;
}

function positiveSqliteInt64(value: unknown): bigint {
  if (typeof value !== "bigint" || value < 1n || value > SQLITE_INT64_MAX) invalidWork();
  return value;
}

function decodeWork(value: unknown): LifecycleOperationalWorkIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidWork();
  const kindDescriptor = Reflect.getOwnPropertyDescriptor(value, "kind");
  if (kindDescriptor === undefined || !("value" in kindDescriptor)) invalidWork();
  if (kindDescriptor.value === "workflow-selection" || kindDescriptor.value === "outbox-selection") {
    const work = strictDataRecord(value, [
      "kind", "projectId", "workId", "operation", "ownerId",
    ]);
    if (work.operation !== "claim-next") invalidWork();
    const snapshot = Object.freeze({
      kind: kindDescriptor.value,
      projectId: canonicalUuid(work.projectId),
      workId: nonEmptyString(work.workId),
      operation: "claim-next" as const,
      ownerId: nonEmptyString(work.ownerId),
    });
    return snapshot as WorkflowSelectionOperationalWorkIdentity | OutboxSelectionOperationalWorkIdentity;
  }
  if (kindDescriptor.value === "workflow") {
    const work = strictDataRecord(value, [
      "kind", "projectId", "workflowId", "workflowGeneration", "operation", "ownerId", "claimToken",
    ]);
    if (!WORKFLOW_OPERATIONS.has(work.operation as WorkflowOperationalWorkIdentity["operation"])) {
      invalidWork();
    }
    return Object.freeze({
      kind: "workflow",
      projectId: canonicalUuid(work.projectId),
      workflowId: canonicalUuid(work.workflowId),
      workflowGeneration: positiveSqliteInt64(work.workflowGeneration),
      operation: work.operation as WorkflowOperationalWorkIdentity["operation"],
      ownerId: nonEmptyString(work.ownerId),
      claimToken: positiveSqliteInt64(work.claimToken),
    });
  }
  if (kindDescriptor.value === "outbox") {
    const work = strictDataRecord(value, [
      "kind", "projectId", "targetKey", "materializationRevision", "operation", "ownerId", "claimToken",
    ]);
    if (!OUTBOX_OPERATIONS.has(work.operation as OutboxOperationalWorkIdentity["operation"])) invalidWork();
    return Object.freeze({
      kind: "outbox",
      projectId: canonicalUuid(work.projectId),
      targetKey: nonEmptyString(work.targetKey),
      materializationRevision: positiveSqliteInt64(work.materializationRevision),
      operation: work.operation as OutboxOperationalWorkIdentity["operation"],
      ownerId: nonEmptyString(work.ownerId),
      claimToken: positiveSqliteInt64(work.claimToken),
    });
  }
  return invalidWork();
}

interface TransactionCallbackScope {
  active: boolean;
}

function callbackBoundaryFailure(work: LifecycleOperationalWorkIdentity): never {
  throw new LifecycleOperationalStoreError("LIFECYCLE_INPUT_INVALID", work);
}

function guardedFacade<T extends object>(value: T, work: LifecycleOperationalWorkIdentity): {
  readonly facade: T;
  readonly scope: TransactionCallbackScope;
} {
  const scope: TransactionCallbackScope = { active: true };
  const proxies = new WeakMap<object, object>();
  const methodWrappers = new WeakMap<object, Map<PropertyKey, (...args: unknown[]) => unknown>>();
  const callableWrappers = new WeakMap<Function, (...args: unknown[]) => unknown>();
  const active = (): void => {
    if (!scope.active) callbackBoundaryFailure(work);
  };
  function guardResult(result: unknown): unknown {
    synchronousCallbackResult(result, work);
    if (typeof result === "function") {
      const prior = callableWrappers.get(result);
      if (prior !== undefined) return prior;
      const wrapper = function(this: unknown, ...args: unknown[]): unknown {
        active();
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
        callbackBoundaryFailure(work);
      }
      return { found: false };
    }
    if (!("value" in descriptor)) {
      callbackBoundaryFailure(work);
    }
    return { found: true, value: descriptor.value };
  }
  function wrap(current: object): object {
    const prior = proxies.get(current);
    if (prior !== undefined) return prior;
    const target = Object.create(null) as Record<PropertyKey, unknown>;
    const proxy: Record<PropertyKey, unknown> = new Proxy(target, {
      get: (_target, property) => {
        active();
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
            active();
            return guardResult(Reflect.apply(member, current, args) as unknown);
          };
          wrappers.set(property, wrapper);
          return wrapper;
        }
        return guardResult(member);
      },
      has: (_target, property) => { active(); return dataMember(current, property).found; },
      ownKeys: () => { active(); return Reflect.ownKeys(current); },
      getOwnPropertyDescriptor: (_target, property): PropertyDescriptor | undefined => {
        active();
        const descriptor = Reflect.getOwnPropertyDescriptor(current, property);
        if (descriptor === undefined) return undefined;
        if (!("value" in descriptor)) callbackBoundaryFailure(work);
        return {
          configurable: true,
          enumerable: descriptor.enumerable ?? false,
          writable: false,
          value: Reflect.get(proxy, property) as unknown,
        };
      },
      getPrototypeOf: () => null,
      set: () => callbackBoundaryFailure(work),
      defineProperty: () => callbackBoundaryFailure(work),
      deleteProperty: () => callbackBoundaryFailure(work),
      preventExtensions: () => callbackBoundaryFailure(work),
      setPrototypeOf: () => callbackBoundaryFailure(work),
    });
    proxies.set(current, proxy);
    return proxy;
  }
  return { facade: wrap(value) as T, scope };
}

function isThenable(value: unknown): boolean {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return false;
  try {
    return typeof Reflect.get(value, "then") === "function";
  } catch {
    return true;
  }
}

function synchronousCallbackResult<T>(
  result: T,
  work: LifecycleOperationalWorkIdentity,
): T {
  if (isThenable(result)) {
    try {
      if (result instanceof Promise) void result.catch(() => undefined);
    } catch {
      // The callback result is rejected below.
    }
    callbackBoundaryFailure(work);
  }
  return result;
}

function undefinedCallbackResult(
  result: unknown,
  work: LifecycleOperationalWorkIdentity,
): undefined {
  if (result !== undefined) callbackBoundaryFailure(work);
  return undefined;
}

function invokeSynchronousTransactionCallback<TTransaction extends object, T, TResult>(
  transaction: TTransaction,
  work: LifecycleOperationalWorkIdentity,
  callback: (guarded: TTransaction) => T,
  transform: (result: T) => TResult,
): TResult {
  const guarded = guardedFacade(transaction, work);
  try {
    return transform(synchronousCallbackResult(callback(guarded.facade), work));
  } finally {
    guarded.scope.active = false;
  }
}

function immutableJsonSnapshot<T extends JsonValue>(value: T): T {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalidWork();
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => immutableJsonSnapshot(item))) as T;
  }
  if (typeof value !== "object") invalidWork();
  const record = strictDataRecord(value, Reflect.ownKeys(value).map((key) => {
    if (typeof key !== "string") invalidWork();
    return key;
  }));
  const snapshot: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(record)) {
    snapshot[key] = immutableJsonSnapshot(item as JsonValue);
  }
  return Object.freeze(snapshot) as T;
}

export class LifecycleOperationalStore {
  readonly #connection: SqliteConnection;
  readonly #transaction: (connection: SqliteConnection) => LifecycleOperationalRepositorySet;
  readonly #afterCommit: (work: LifecycleOperationalWorkIdentity) => undefined;

  constructor(options: LifecycleOperationalStoreOptions) {
    this.#connection = options.connection;
    this.#transaction = options.transaction;
    this.#afterCommit = options.afterCommit ?? (() => undefined);
  }

  execute<TWork extends LifecycleOperationalWorkIdentity, T extends JsonValue>(
    work: TWork,
    onCurrent: (transaction: LifecycleOperationalTransactionFor<TWork>) => T,
  ): LifecycleOperationalResult<T, TWork> {
    const workSnapshot = decodeWork(work) as TWork;
    let transactionBegan = false;
    let commitAttempted = false;
    let commitFailed = false;
    let commitCompleted = false;
    try {
      this.#connection.exec("BEGIN IMMEDIATE");
      transactionBegan = true;
      const repositories = this.#transaction(this.#connection);
      const focused = workSnapshot.kind === "workflow" || workSnapshot.kind === "workflow-selection"
        ? { workflows: repositories.workflows }
        : { outbox: repositories.outbox };
      const result = invokeSynchronousTransactionCallback(
        focused as LifecycleOperationalTransactionFor<TWork>,
        workSnapshot,
        onCurrent,
        immutableJsonSnapshot,
      );
      commitAttempted = true;
      try {
        this.#connection.exec("COMMIT");
      } catch (error) {
        commitFailed = true;
        throw error;
      }
      commitCompleted = true;
      transactionBegan = false;
      undefinedCallbackResult(
        synchronousCallbackResult(this.#afterCommit(workSnapshot), workSnapshot),
        workSnapshot,
      );
      return { work: workSnapshot, publicResult: result };
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
        throw new LifecycleOperationalStoreError("OPERATION_OUTCOME_UNKNOWN", workSnapshot);
      }
      throw error;
    }
  }
}
