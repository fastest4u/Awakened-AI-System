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
import type {
  InternalWorkflowSemanticCommand,
  LifecycleSemanticCommandDraft,
} from "./contracts/commands.js";
import type { CapabilityKind } from "./authority/capability-key-provider.js";
import {
  buildLifecycleIntentWitness,
  type TrustedLifecycleIntentAssertionsV1,
} from "./lifecycle-intent-witness.js";
import { LifecycleError } from "./errors.js";

const LOWER_HASH = /^[0-9a-f]{64}$/;
const POSITIVE_GENERATION = /^(?:[1-9][0-9]*)$/;
const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;

export interface LifecycleCommandEnvelope {
  readonly context: ProjectContext;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly commandType: string;
  readonly candidateIntentHash: string;
  readonly authoritativeIntentHash: string;
  readonly semanticCommand: LifecycleSemanticCommandDraft | InternalWorkflowSemanticCommand;
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
  /** Facade capabilities must be explicit own data properties; prototypes/accessors are excluded. */
  readonly transaction: (connection: SqliteConnection) => LifecycleCommandTransaction;
  readonly now?: () => string;
  readonly authorityMaterialStatus?: (
    authorization: PersistedLifecycleAuthorizationRecord,
  ) => AuthorityMaterialStatus;
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
    const envelope = immutableSnapshot(command);
    assertEnvelope(envelope);
    let transactionBegan = false;
    let commitAttempted = false;
    let commitFailed = false;
    let commitCompleted = false;
    let focused: LifecycleCommandTransaction | undefined;
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

      this.#events.assertCommandIdentityAvailable(envelope);
      this.#events.assertAppendAllowed();
      focused = projectCommandTransaction(this.#transaction(this.#connection));
      const next = invokeSynchronousTransactionCallback(focused, onNew, snapshotPreparedCommit);
      const resolvedEnvelope = resolveFreshCapabilityGeneration(envelope, next);
      const authorizationFingerprint = integrityFingerprint(next.authorizationRecord);
      assertAppendIdentity(resolvedEnvelope, next);
      const trustedAppend = appendWithTrustedIntent(resolvedEnvelope, next);
      const prepared = this.#events.prepare(
        trustedAppend,
        this.#now(),
        envelope.authoritativeIntentHash,
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
      this.#events.insertDedup(prepared, committed, next.authorizationRecord);
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
