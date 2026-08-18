import { createHash } from "node:crypto";
import { isPrimarySqliteBusy } from "../storage/event-append-transaction.js";
import type { ProjectId } from "../identity/contracts.js";
import type { SqliteConnection } from "../storage/sqlite-driver.js";
import { LifecycleOutboxRepository } from "../storage/lifecycle-outbox.repository.js";
import type {
  LifecycleChildTransferReadOperations,
  LifecycleEvidenceCoverageReadOperations,
  LifecycleSessionAuthorityReadOperations,
  LifecycleValidationPlanReadOperations,
  LifecycleOutboxAcknowledgementInputV1,
  LifecycleOutboxClaimNextInputV1,
  LifecycleOutboxClaimV1,
  LifecycleOutboxCompletionQueryV1,
  LifecycleOutboxExactClaimInputV1,
  LifecycleOutboxFailureInputV1,
  LifecycleOutboxMaterializationResultV1,
  LifecycleOutboxRenewInputV1,
  SessionEndWorkflowOperations,
} from "../storage/lifecycle-storage.types.js";
import { LifecycleError } from "./errors.js";
import {
  NO_LIFECYCLE_FAULTS,
  type LifecycleDurableBoundary,
  type LifecycleFaultContext,
  type LifecycleFaultInjector,
} from "./lifecycle-faults.js";
import type { WorkflowId } from "./contracts/identifiers.js";
import type {
  ExactPlannedRevisionQuery,
  LifecycleOutboxPlanReader,
  LifecycleOutboxPlannedRevision,
} from "./materialization-queue.port.js";
import type {
  CompatibilityLogMaterializationInput,
  LifecycleOutboxMaterializationOperations,
} from "../materialization/compatibility-log.materializer.js";

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

export interface WorkflowRecoveryOperationalWorkIdentity {
  readonly kind: "workflow-recovery";
  readonly projectId: string;
  readonly workId: string;
  readonly operation: "recovery";
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
  | WorkflowRecoveryOperationalWorkIdentity
  | OutboxOperationalWorkIdentity;

export interface ConnectionBoundSessionEndWorkflowOperations extends SessionEndWorkflowOperations {}
export interface ConnectionBoundLifecycleOutboxOperations {
  /** Optional keeps older injected repository bundles structurally compatible. */
  stage?: (value: string) => void;
  claimNext?(input: LifecycleOutboxClaimNextInputV1): LifecycleOutboxClaimV1 | null;
  getExactClaim?(input: LifecycleOutboxExactClaimInputV1): LifecycleOutboxClaimV1;
  renewClaim?(input: LifecycleOutboxRenewInputV1): LifecycleOutboxClaimV1 | null;
  isLatestRevision?(plan: LifecycleOutboxClaimV1["planned"]): boolean;
  isCurrentWorkflowGeneration?(plan: LifecycleOutboxClaimV1["planned"]): boolean;
  listCommittedLowerRevisionFingerprints?(
    claim: LifecycleOutboxClaimV1,
  ): readonly import("./materialization-queue.port.js").KeyedFingerprintV1[];
  recordFailure?(input: LifecycleOutboxFailureInputV1): boolean;
  materialize?(
    input: import("../materialization/compatibility-log.materializer.js").CompatibilityLogMaterializationInput,
  ): LifecycleOutboxMaterializationResultV1;
}

export interface LifecycleMaterializationCompletionReadOperations {
  isCompleted(input: LifecycleOutboxCompletionQueryV1): boolean;
}
/** Read-only lifecycle plan capability bound to the active SQLite transaction. */
export interface ConnectionBoundLifecycleOutboxPlanReads extends LifecycleOutboxPlanReader {}

/** Optional read-only sidecars; each is connection-bound by the repository factory. */
export interface LifecycleOperationalReadFacades {
  readonly validationPlans?: LifecycleValidationPlanReadOperations;
  readonly authority?: LifecycleSessionAuthorityReadOperations;
  readonly transfers?: LifecycleChildTransferReadOperations;
  readonly coverage?: LifecycleEvidenceCoverageReadOperations;
  readonly materializations?: LifecycleMaterializationCompletionReadOperations;
}

export interface LifecycleOperationalRepositorySet {
  readonly workflows: ConnectionBoundSessionEndWorkflowOperations;
  readonly outbox: ConnectionBoundLifecycleOutboxOperations;
  /** Optional for legacy factories; the store supplies its narrow connection-bound adapter. */
  readonly outboxPlans?: ConnectionBoundLifecycleOutboxPlanReads;
  /** Optional Task 15 read-only sidecars for newer repository factories. */
  readonly validationPlans?: LifecycleValidationPlanReadOperations;
  readonly authority?: LifecycleSessionAuthorityReadOperations;
  readonly transfers?: LifecycleChildTransferReadOperations;
  readonly coverage?: LifecycleEvidenceCoverageReadOperations;
  readonly materializations?: LifecycleMaterializationCompletionReadOperations;
}

export interface WorkflowOperationalTransaction extends LifecycleOperationalReadFacades {
  readonly workflows: ConnectionBoundSessionEndWorkflowOperations;
  readonly outboxPlans: ConnectionBoundLifecycleOutboxPlanReads;
}

export interface OutboxOperationalTransaction {
  readonly outbox: ConnectionBoundLifecycleOutboxOperations;
}

export type LifecycleOperationalTransaction =
  | WorkflowOperationalTransaction
  | OutboxOperationalTransaction;

export type LifecycleOperationalTransactionFor<
  TWork extends LifecycleOperationalWorkIdentity,
> = TWork extends WorkflowOperationalWorkIdentity | WorkflowRecoveryOperationalWorkIdentity
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
  /** Optional connection-bound augmentation applied after the base facade is created. */
  readonly decorateTransaction?: (
    repositories: LifecycleOperationalRepositorySet,
    connection: SqliteConnection,
  ) => LifecycleOperationalRepositorySet;
  readonly afterCommit?: (work: LifecycleOperationalWorkIdentity) => undefined;
  /** Optional fixture-only durable-boundary fault injection. */
  readonly faultInjector?: LifecycleFaultInjector;
}

type SynchronousCallbackArity<T> = [T] extends [never]
  ? []
  : T extends PromiseLike<unknown>
    ? [never]
    : [];

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
  if (kindDescriptor.value === "workflow-recovery") {
    const work = strictDataRecord(value, [
      "kind", "projectId", "workId", "operation", "ownerId", "claimToken",
    ]);
    if (work.operation !== "recovery") invalidWork();
    return Object.freeze({
      kind: "workflow-recovery" as const,
      projectId: canonicalUuid(work.projectId),
      workId: nonEmptyString(work.workId),
      operation: "recovery" as const,
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

function operationalFaultBoundary(work: LifecycleOperationalWorkIdentity): LifecycleDurableBoundary {
  if (work.kind === "workflow-recovery") return "workflow-phase";
  if (work.kind === "workflow" || work.kind === "workflow-selection") return "workflow-phase";
  if (work.kind === "outbox-selection") return "outbox-claim";
  switch (work.operation) {
    case "materialize": return "materialization-ack";
    case "record-failure": return "outbox-failure";
    default: return "outbox-claim";
  }
}

function operationalFaultContext(work: LifecycleOperationalWorkIdentity): LifecycleFaultContext {
  const workflowId = work.kind === "workflow"
    ? work.workflowId as WorkflowId
    : null;
  const workId = work.kind === "workflow-selection"
    || work.kind === "outbox-selection"
    || work.kind === "workflow-recovery"
    ? work.workId
    : work.kind === "outbox"
      ? work.targetKey
    : null;
  const materializationRevision = work.kind === "outbox"
    ? work.materializationRevision.toString()
    : null;
  const workIdentity = JSON.stringify(work, (_key, value: unknown) => (
    typeof value === "bigint" ? value.toString() : value
  ));
  return Object.freeze({
    projectId: work.projectId as ProjectId,
    sessionId: null,
    workflowId,
    commandId: null,
    idempotencyKeyHash: createHash("sha256").update(workIdentity, "utf8").digest("hex"),
    workId,
    eventPosition: null,
    materializationRevision,
  });
}

/**
 * The operational layer may receive an older repository bundle that has not
 * installed the plan-read facade yet. Keep that compatibility at the bundle
 * boundary while exposing only the two immutable plan-read methods to the
 * workflow callback.
 */
class SqliteLifecycleOutboxPlanReads implements ConnectionBoundLifecycleOutboxPlanReads {
  readonly #repository = new LifecycleOutboxRepository();

  constructor(private readonly connection: SqliteConnection) {}

  getExactPlannedRevision(query: ExactPlannedRevisionQuery): LifecycleOutboxPlannedRevision | null {
    return this.#repository.getExactPlannedRevision(this.connection, query);
  }

  assertExactPlannedRevision(query: ExactPlannedRevisionQuery): LifecycleOutboxPlannedRevision {
    return this.#repository.assertExactPlannedRevision(this.connection, query);
  }
}

export interface LifecycleOutboxMaterializerRunner {
  materialize(
    input: CompatibilityLogMaterializationInput,
    operations: LifecycleOutboxMaterializationOperations,
  ): LifecycleOutboxMaterializationResultV1;
}

export function createConnectionBoundLifecycleOutboxOperations(
  connection: SqliteConnection,
  repository: LifecycleOutboxRepository,
  materializer: LifecycleOutboxMaterializerRunner,
): ConnectionBoundLifecycleOutboxOperations {
  const base = {
    claimNext: (input: LifecycleOutboxClaimNextInputV1) => repository.claimNext(connection, input),
    getExactClaim: (input: LifecycleOutboxExactClaimInputV1) => repository.getExactClaim(connection, input),
    renewClaim: (input: LifecycleOutboxRenewInputV1) => repository.renewClaim(connection, input),
    isLatestRevision: (plan: LifecycleOutboxClaimV1["planned"]) => repository.isLatestRevision(connection, plan),
    isCurrentWorkflowGeneration: (plan: LifecycleOutboxClaimV1["planned"]) =>
      repository.isCurrentWorkflowGeneration(connection, plan),
    listCommittedLowerRevisionFingerprints: (claim: LifecycleOutboxClaimV1) =>
      repository.listCommittedLowerRevisionFingerprints(connection, claim),
    recordFailure: (input: LifecycleOutboxFailureInputV1) => repository.recordFailure(connection, input),
  };
  const materializationOperations: LifecycleOutboxMaterializationOperations = {
    ...base,
    acknowledgeAfterReplacement: (input: LifecycleOutboxAcknowledgementInputV1) =>
      repository.acknowledgeAfterReplacement(connection, input),
  };
  return Object.freeze({
    ...base,
    materialize: (input: CompatibilityLogMaterializationInput) =>
      materializer.materialize(input, materializationOperations),
  });
}

export function createConnectionBoundLifecycleMaterializationReads(
  connection: SqliteConnection,
  repository: LifecycleOutboxRepository,
): LifecycleMaterializationCompletionReadOperations {
  return Object.freeze({
    isCompleted: (input: LifecycleOutboxCompletionQueryV1) =>
      repository.isCompleted(connection, input),
  });
}

function ownOptionalDataProperty<T>(source: object, property: string): T | undefined {
  const descriptor = Reflect.getOwnPropertyDescriptor(source, property);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) invalidWork();
  return descriptor.value as T | undefined;
}

function operationalReadFacades(
  repositories: LifecycleOperationalRepositorySet,
): LifecycleOperationalReadFacades {
  const validationPlans = ownOptionalDataProperty<LifecycleValidationPlanReadOperations>(
    repositories,
    "validationPlans",
  );
  const authority = ownOptionalDataProperty<LifecycleSessionAuthorityReadOperations>(
    repositories,
    "authority",
  );
  const transfers = ownOptionalDataProperty<LifecycleChildTransferReadOperations>(
    repositories,
    "transfers",
  );
  const coverage = ownOptionalDataProperty<LifecycleEvidenceCoverageReadOperations>(
    repositories,
    "coverage",
  );
  const materializations = ownOptionalDataProperty<LifecycleMaterializationCompletionReadOperations>(
    repositories,
    "materializations",
  );
  return Object.freeze({
    ...(validationPlans === undefined ? {} : { validationPlans }),
    ...(authority === undefined ? {} : { authority }),
    ...(transfers === undefined ? {} : { transfers }),
    ...(coverage === undefined ? {} : { coverage }),
    ...(materializations === undefined ? {} : { materializations }),
  });
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

/**
 * Operational transactions return typed repository records as well as public
 * JSON DTOs.  SQLite integer columns are intentionally represented as bigint,
 * so preserve those scalar values while still rejecting opaque or mutable
 * result objects at the transaction boundary.
 */
function immutableOperationalSnapshot<T>(value: T): T {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalidWork();
    return value;
  }
  if (typeof value === "bigint") return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => immutableOperationalSnapshot(item))) as T;
  }
  if (typeof value !== "object") invalidWork();
  const record = strictDataRecord(value, Reflect.ownKeys(value).map((key) => {
    if (typeof key !== "string") invalidWork();
    return key;
  }));
  const snapshot: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    snapshot[key] = immutableOperationalSnapshot(item);
  }
  return Object.freeze(snapshot) as T;
}

export class LifecycleOperationalStore {
  readonly #connection: SqliteConnection;
  readonly #transaction: (connection: SqliteConnection) => LifecycleOperationalRepositorySet;
  readonly #decorateTransaction: (
    repositories: LifecycleOperationalRepositorySet,
    connection: SqliteConnection,
  ) => LifecycleOperationalRepositorySet;
  readonly #afterCommit: (work: LifecycleOperationalWorkIdentity) => undefined;
  readonly #faults: LifecycleFaultInjector;

  constructor(options: LifecycleOperationalStoreOptions) {
    this.#connection = options.connection;
    this.#transaction = options.transaction;
    this.#decorateTransaction = options.decorateTransaction ?? ((repositories) => repositories);
    this.#afterCommit = options.afterCommit ?? (() => undefined);
    this.#faults = options.faultInjector ?? NO_LIFECYCLE_FAULTS;
  }

  execute<TWork extends LifecycleOperationalWorkIdentity, T>(
    work: TWork,
    onCurrent: (transaction: LifecycleOperationalTransactionFor<TWork>) => T,
    ..._synchronousCallbackOnly: SynchronousCallbackArity<T>
  ): LifecycleOperationalResult<T, TWork> {
    const workSnapshot = decodeWork(work) as TWork;
    let transactionBegan = false;
    let commitAttempted = false;
    let commitFailed = false;
    let commitCompleted = false;
    const faultBoundary = operationalFaultBoundary(workSnapshot);
    const faultContext = operationalFaultContext(workSnapshot);
    try {
      this.#connection.exec("BEGIN IMMEDIATE");
      transactionBegan = true;
      if (workSnapshot.kind !== "outbox" || workSnapshot.operation !== "materialize") {
        this.#faults.hit(faultBoundary, "before-write", faultContext);
      }
      const repositories = this.#decorateTransaction(
        this.#transaction(this.#connection),
        this.#connection,
      );
      const readFacades = operationalReadFacades(repositories);
      const focused = workSnapshot.kind === "workflow"
        || workSnapshot.kind === "workflow-recovery"
        || workSnapshot.kind === "workflow-selection"
        ? {
            ...readFacades,
            workflows: repositories.workflows,
            outboxPlans: repositories.outboxPlans
              ?? new SqliteLifecycleOutboxPlanReads(this.#connection),
          }
        : { outbox: repositories.outbox };
      const result = invokeSynchronousTransactionCallback(
        focused as LifecycleOperationalTransactionFor<TWork>,
        workSnapshot,
        onCurrent,
        immutableOperationalSnapshot,
      );
      if (workSnapshot.kind !== "outbox" || workSnapshot.operation !== "materialize") {
        this.#faults.hit(faultBoundary, "after-write-before-commit", faultContext);
      }
      commitAttempted = true;
      try {
        this.#connection.exec("COMMIT");
      } catch (error) {
        commitFailed = true;
        throw error;
      }
      commitCompleted = true;
      transactionBegan = false;
      this.#faults.hit(faultBoundary, "after-commit-before-response", faultContext);
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
