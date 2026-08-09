import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import type {
  AppendCommand,
  AppendResult,
  JsonValue,
} from "../contracts/event.js";
import type { ProjectContext, ProjectId } from "../identity/contracts.js";
import type { IntegrityReport } from "../integrity/integrity.types.js";
import type { MaintenanceLease } from "../storage/maintenance-fence.js";
import type {
  AuthorityMaterialAdapter,
  LifecycleExecutionResult,
  WorkerLifecycleResult,
} from "../lifecycle/authority/authority-material-adapter.js";
import type {
  InternalWorkflowExecutionPlan,
  LifecycleSemanticCommandDraft,
  PreparedLifecycleWorkerCommand,
} from "../lifecycle/contracts/commands.js";
import type { PendingCommandIdentity } from "../lifecycle/authority/pending-authorization.store.js";
import {
  LIFECYCLE_ERROR_CODES,
  LifecycleError,
  type LifecycleErrorCode,
} from "../lifecycle/errors.js";
import type {
  LifecycleBoundedMutationForInput,
  LifecycleBoundedMutationInput,
  LifecycleBoundedResultFor,
  LifecycleFencedInput,
  LifecycleFencedOperationForInput,
  LifecycleFencedOperationWire,
  LifecycleFencedResultFor,
  LifecycleInternalResultFor,
  LifecycleQueryForInput,
  LifecycleQueryInput,
  LifecycleQueryResultFor,
  LifecycleResultFor,
  LifecycleSemanticOperationWire,
} from "./lifecycle-worker-protocol.js";
import {
  decodeLifecycleWorkerOperationWire,
  type LifecycleWorkerOperationWire,
  type LifecycleWorkerSuccessWire,
} from "./lifecycle-worker-protocol.js";
import {
  decodeAppendResultWire,
  decodeIntegrityReport,
  decodeMaintenanceLeaseWire,
  decodeWorkerRequest,
  decodeWorkerMessage,
  decodeWorkerResponseForRequest,
  encodeAppendCommandWire,
  encodeMaintenanceLeaseWire,
  encodeWorkerBinding,
  encodeWorkerBindingAssertion,
  type WorkerMessage,
  type WorkerNotification,
  type WorkerOpenResult,
  type WorkerPingResult,
  type WorkerRequest,
  type WorkerResponse,
} from "./worker-protocol.js";

export const DEFAULT_MAX_PENDING = 128;
export const DEFAULT_EXECUTOR_LEASE_MS = 15_000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;

const POSITIVE_SAFE_INTEGER = (value: number): boolean => Number.isSafeInteger(value) && value > 0;
const ASSERTION_FAILURES = new Set([
  "PROJECT_ID_MISMATCH",
  "VAULT_ID_MISMATCH",
  "STORE_ID_MISMATCH",
  "PROJECT_BINDING_REQUIRED",
]);
const MAINTENANCE_CONFIRMATION_CODES = new Set([
  "MAINTENANCE_CONFIRMATION_REQUIRED",
  "MAINTENANCE_CONFIRMATION_FAILED",
  "MAINTENANCE_LEASE_INVALID",
  "MAINTENANCE_LEASE_STALE",
  "MAINTENANCE_STATE_INVALID",
  "MAINTENANCE_TIMESTAMP_INVALID",
  "MAINTENANCE_EXECUTOR_NOT_REQUIRED",
  "MAINTENANCE_ACKNOWLEDGEMENT_REQUIRED",
  "EXECUTOR_LEASE_INVALID",
  "EXECUTOR_LEASE_NOT_ACTIVE",
]);
const DEFINITIVE_LIFECYCLE_ERROR_CODES = new Set<string>(
  LIFECYCLE_ERROR_CODES.filter((code) => (
    code !== "COMMAND_OUTCOME_UNKNOWN"
    && code !== "OPERATION_OUTCOME_UNKNOWN"
    && code !== "WORKER_PROTOCOL_ERROR"
  )),
);

export interface ProjectStoreExecutorOptions {
  workerUrl: URL;
  context: ProjectContext;
  maxPending: number;
  requestTimeoutMs: number;
  closeTimeoutMs: number;
  executorLeaseMs: number;
  heartbeatIntervalMs: number;
  appendRetryDeadlineMs?: number;
}

export interface WorkerLike {
  postMessage(value: unknown): void;
  terminate(): Promise<number>;
  on(event: "message", listener: (value: unknown) => void): this;
  on(event: "messageerror", listener: (error: unknown) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (exitCode: number) => void): this;
}

export type WorkerFactory = (
  workerUrl: URL,
  options: { workerData: Record<string, JsonValue> },
) => WorkerLike;

export interface ExecutorScheduler {
  setTimeout(callback: () => void, milliseconds: number): object;
  clearTimeout(handle: object): void;
}

export interface ProjectStoreExecutorDependencies {
  readonly workerFactory: WorkerFactory;
  readonly scheduler: ExecutorScheduler;
  readonly randomId: () => string;
  /**
   * Runs only after the store worker has exited. The implementation must use
   * the maintenance owner's already-open connection; it must not create a
   * short-lived publisher connection that would need to confirm its own close.
   */
  readonly confirmMaintenanceClosure: (
    confirmation: MaintenanceClosureConfirmation,
  ) => void | Promise<void>;
  readonly authorityMaterialAdapter?: AuthorityMaterialAdapter;
}

export interface MaintenanceClosureConfirmation {
  projectId: ProjectId;
  executorId: string;
  lease: MaintenanceLease;
  connectionClosed: true;
}

const DEFAULT_SCHEDULER: ExecutorScheduler = {
  setTimeout(callback, milliseconds) {
    return setTimeout(callback, milliseconds);
  },
  clearTimeout(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

function defaultWorkerFactory(
  workerUrl: URL,
  options: { workerData: Record<string, JsonValue> },
): WorkerLike {
  return new Worker(workerUrl, { workerData: options.workerData });
}

function safeDetails(value: unknown): Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const result: Record<string, JsonValue> = {};
  for (const [key, observed] of Object.entries(source)) {
    if (
      observed === null
      || typeof observed === "string"
      || typeof observed === "boolean"
      || (typeof observed === "number" && Number.isFinite(observed))
    ) {
      result[key] = observed;
    }
  }
  return result;
}

function assertDecodedLifecycleContextBinding(
  value: JsonValue,
  context: ProjectContext,
): void {
  if (value === null || typeof value !== "object") return;
  const expected: Readonly<Record<string, string>> = {
    projectId: context.binding.projectId,
    vaultId: context.binding.vaultId,
    storeId: context.binding.storeId,
    workspaceId: context.binding.workspaceId,
    clientNamespace: context.binding.clientNamespace,
  };
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") continue;
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !("value" in descriptor)
    ) continue;
    if (Object.hasOwn(expected, key) && descriptor.value !== expected[key]) {
      throw new ProjectStoreWorkerError("WORKER_PROTOCOL_ERROR");
    }
    assertDecodedLifecycleContextBinding(descriptor.value as JsonValue, context);
  }
}

export class ProjectStoreWorkerError extends Error {
  constructor(
    readonly code: string,
    readonly details: Record<string, JsonValue> = {},
  ) {
    super(code);
    this.name = "ProjectStoreWorkerError";
  }
}

type RequestKind = "read" | "mutation" | "bounded" | "operational" | "control";

type PendingLifecycleIdentity =
  | {
      readonly kind: "semantic";
      readonly projectId: ProjectId;
      readonly commandId: string;
      readonly idempotencyKey: string;
    }
  | {
      readonly kind: "bounded";
      readonly operationId: string;
      readonly requestId: string;
    }
  | {
      readonly kind: "operational";
      readonly work: JsonValue;
    };
type SemanticPendingIdentity = Extract<PendingLifecycleIdentity, { readonly kind: "semantic" }>;

type ExactInput<I, Shape> = I & Record<Exclude<keyof I, keyof Shape>, never>;
type ExactBoundedInput<I extends LifecycleBoundedMutationInput> = ExactInput<
  I,
  Extract<LifecycleBoundedMutationInput, { readonly operation: I["operation"] }>
>;
type ExactQueryInput<I extends LifecycleQueryInput> = ExactInput<
  I,
  Extract<LifecycleQueryInput, { readonly operation: I["operation"] }>
>;
type ExactFencedInput<I extends LifecycleFencedInput> = ExactInput<
  I,
  Extract<LifecycleFencedInput, { readonly operation: I["operation"] }>
>;

function semanticIdentity(
  projectId: ProjectId,
  commandId: string,
  idempotencyKey: string,
): SemanticPendingIdentity {
  return Object.freeze({
    kind: "semantic" as const,
    projectId,
    commandId,
    idempotencyKey,
  });
}

function pendingCommandIdentity(identity: SemanticPendingIdentity): PendingCommandIdentity {
  return Object.freeze({
    projectId: identity.projectId,
    commandId: identity.commandId,
    idempotencyKey: identity.idempotencyKey,
  });
}

function boundedIdentity(
  operationId: string,
  requestId: string,
): PendingLifecycleIdentity {
  return Object.freeze({ kind: "bounded" as const, operationId, requestId });
}

function operationalIdentity(
  projectId: ProjectId,
  wire: LifecycleFencedOperationWire,
): PendingLifecycleIdentity {
  const input = wire.input as unknown as Readonly<Record<string, JsonValue>>;
  let work: JsonValue;
  switch (wire.operation) {
    case "workflow-claim-next":
      work = Object.freeze({
        kind: "workflow-selection",
        projectId,
        workId: input.workId,
        operation: "claim-next",
        ownerId: input.ownerId,
      });
      break;
    case "outbox-claim-next":
      work = Object.freeze({
        kind: "outbox-selection",
        projectId,
        workId: input.workId,
        operation: "claim-next",
        ownerId: input.ownerId,
      });
      break;
    case "workflow-recovery":
      work = Object.freeze({
        projectId,
        workId: input.workId,
        operation: "workflow-recovery",
        ownerId: input.ownerId,
        fencingToken: input.fencingToken,
      });
      break;
    case "workflow-claim":
    case "workflow-renew":
    case "workflow-release":
    case "workflow-eventless-phase": {
      const operation = {
        "workflow-claim": "claim",
        "workflow-renew": "renew",
        "workflow-release": "release",
        "workflow-eventless-phase": "advance-eventless",
      }[wire.operation];
      work = Object.freeze({
        kind: "workflow",
        projectId,
        workflowId: input.workflowId,
        workflowGeneration: String(input.workflowGeneration),
        operation,
        ownerId: input.ownerId,
        claimToken: input.fencingToken,
      });
      break;
    }
    case "outbox-claim":
    case "outbox-renew":
    case "outbox-materialize":
    case "outbox-failure": {
      const operation = {
        "outbox-claim": "claim",
        "outbox-renew": "renew",
        "outbox-materialize": "materialize",
        "outbox-failure": "record-failure",
      }[wire.operation];
      work = Object.freeze({
        kind: "outbox",
        projectId,
        targetKey: input.targetKey,
        materializationRevision: input.materializationRevision,
        operation,
        ownerId: input.ownerId,
        claimToken: input.fencingToken,
      });
      break;
    }
  }
  return Object.freeze({ kind: "operational" as const, work });
}

function identityOutcomeUnknown(identity: PendingLifecycleIdentity): ProjectStoreWorkerError {
  switch (identity.kind) {
    case "semantic":
      return new ProjectStoreWorkerError("COMMAND_OUTCOME_UNKNOWN", Object.freeze({
        commandId: identity.commandId,
        idempotencyKey: identity.idempotencyKey,
      }));
    case "bounded":
      return new ProjectStoreWorkerError("OPERATION_OUTCOME_UNKNOWN", Object.freeze({
        operationId: identity.operationId,
        requestId: identity.requestId,
      }));
    case "operational":
      return new ProjectStoreWorkerError("OPERATION_OUTCOME_UNKNOWN", Object.freeze({
        work: identity.work,
      }));
  }
}

interface PendingRequest {
  readonly request: WorkerRequest;
  readonly kind: RequestKind;
  readonly identity: PendingLifecycleIdentity | null;
  readonly timer: object;
  posted: boolean;
  resolve(value: unknown): void;
  reject(error: ProjectStoreWorkerError): void;
}

type ExecutorState = "new" | "open" | "closing" | "quiesced" | "poisoned" | "closed";

function canonicalEventsPath(context: ProjectContext): string {
  const requested = resolve(context.binding.storeRoute.eventsPath);
  const canonical = resolve(realpathSync.native(requested));
  if (!statSync(canonical).isFile()) throw new ProjectStoreWorkerError("STORE_UNAVAILABLE");
  const same = process.platform === "win32"
    ? requested.toLowerCase() === canonical.toLowerCase()
    : requested === canonical;
  if (!same) throw new ProjectStoreWorkerError("STORE_ROUTE_INVALID");
  return canonical;
}

function validateOptions(options: ProjectStoreExecutorOptions): void {
  if (!(options.workerUrl instanceof URL) || options.workerUrl.protocol !== "file:") {
    throw new ProjectStoreWorkerError("WORKER_CONFIG_INVALID");
  }
  if (
    !POSITIVE_SAFE_INTEGER(options.maxPending)
    || !POSITIVE_SAFE_INTEGER(options.requestTimeoutMs)
    || !POSITIVE_SAFE_INTEGER(options.closeTimeoutMs)
    || !POSITIVE_SAFE_INTEGER(options.executorLeaseMs)
    || !POSITIVE_SAFE_INTEGER(options.heartbeatIntervalMs)
    || options.heartbeatIntervalMs >= options.executorLeaseMs
  ) {
    throw new ProjectStoreWorkerError("WORKER_CONFIG_INVALID");
  }
  if (
    options.appendRetryDeadlineMs !== undefined
    && !POSITIVE_SAFE_INTEGER(options.appendRetryDeadlineMs)
  ) {
    throw new ProjectStoreWorkerError("WORKER_CONFIG_INVALID");
  }
  canonicalEventsPath(options.context);
}

export function projectStoreExecutorKey(context: ProjectContext): string {
  const binding = context.binding;
  return JSON.stringify([
    canonicalEventsPath(context),
    binding.storeId,
    binding.generation,
    binding.contextFingerprint,
  ]);
}

function storeReuseKey(context: ProjectContext): string {
  return canonicalEventsPath(context);
}

function assertCommandContext(command: AppendCommand<JsonValue>, context: ProjectContext): void {
  const supplied = command.context?.binding;
  const current = context.binding;
  if (supplied?.projectId !== current.projectId) {
    throw new ProjectStoreWorkerError("PROJECT_ID_MISMATCH");
  }
  if (supplied.vaultId !== current.vaultId) {
    throw new ProjectStoreWorkerError("VAULT_ID_MISMATCH");
  }
  if (supplied.storeId !== current.storeId) {
    throw new ProjectStoreWorkerError("STORE_ID_MISMATCH");
  }
  if (
    supplied.generation !== current.generation
    || supplied.contextFingerprint !== current.contextFingerprint
  ) {
    throw new ProjectStoreWorkerError("PROJECT_BINDING_REQUIRED", {
      staleGeneration: supplied.generation,
      currentGeneration: current.generation,
    });
  }
}

function openAuthorityError(
  context: ProjectContext,
  result: WorkerOpenResult,
): ProjectStoreWorkerError | null {
  const current = context.binding;
  if (result.projectId !== current.projectId) return new ProjectStoreWorkerError("PROJECT_ID_MISMATCH");
  if (result.vaultId !== current.vaultId) return new ProjectStoreWorkerError("VAULT_ID_MISMATCH");
  if (result.storeId !== current.storeId) return new ProjectStoreWorkerError("STORE_ID_MISMATCH");
  if (
    result.bindingGeneration !== current.generation
    || result.contextFingerprint !== current.contextFingerprint
  ) {
    return new ProjectStoreWorkerError("PROJECT_BINDING_REQUIRED", {
      staleGeneration: result.bindingGeneration,
      currentGeneration: current.generation,
    });
  }
  return null;
}

function sameMaintenanceLease(left: MaintenanceLease, right: MaintenanceLease): boolean {
  return left.epoch === right.epoch
    && left.fencingToken === right.fencingToken
    && left.ownerId === right.ownerId
    && left.leaseExpiresAt === right.leaseExpiresAt;
}

function confirmationError(error: unknown): ProjectStoreWorkerError {
  try {
    if (typeof error !== "object" || error === null) {
      return new ProjectStoreWorkerError("MAINTENANCE_CONFIRMATION_FAILED");
    }
    Object.getPrototypeOf(error);
    const code = Reflect.get(error, "code") as unknown;
    return new ProjectStoreWorkerError(
      typeof code === "string" && MAINTENANCE_CONFIRMATION_CODES.has(code)
        ? code
        : "MAINTENANCE_CONFIRMATION_FAILED",
    );
  } catch {
    return new ProjectStoreWorkerError("MAINTENANCE_CONFIRMATION_FAILED");
  }
}

function terminationFailure(): ProjectStoreWorkerError {
  return new ProjectStoreWorkerError("WORKER_UNAVAILABLE", {
    terminationFailed: true,
  });
}

export class ProjectStoreExecutor {
  readonly #options: ProjectStoreExecutorOptions;
  readonly #dependencies: ProjectStoreExecutorDependencies;
  readonly #worker: WorkerLike;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #drainWaiters = new Set<() => void>();
  #state: ExecutorState = "new";
  #terminalError: ProjectStoreWorkerError | null = null;
  #opened: WorkerOpenResult | null = null;
  #sequence = 0;
  #closePromise: Promise<void> | null = null;
  #quiescePromise: Promise<void> | null = null;
  #openPromise: Promise<WorkerOpenResult> | null = null;
  #terminationPromise: Promise<void> | null = null;
  #expectedTermination = false;
  #explicitMaintenanceLease: MaintenanceLease | null = null;
  #quiescedNotification: WorkerNotification | null = null;
  #observedClosurePromise: Promise<void> | null = null;
  readonly #workerExit: Promise<number>;
  #resolveWorkerExit!: (exitCode: number) => void;
  readonly #poisonedSignal: Promise<ProjectStoreWorkerError>;
  #resolvePoisonedSignal!: (error: ProjectStoreWorkerError) => void;

  constructor(
    options: ProjectStoreExecutorOptions,
    dependencies: Partial<ProjectStoreExecutorDependencies> = {},
  ) {
    validateOptions(options);
    this.#options = options;
    this.#dependencies = {
      workerFactory: dependencies.workerFactory ?? defaultWorkerFactory,
      scheduler: dependencies.scheduler ?? DEFAULT_SCHEDULER,
      randomId: dependencies.randomId ?? randomUUID,
      confirmMaintenanceClosure: dependencies.confirmMaintenanceClosure
        ?? (() => {
          throw new ProjectStoreWorkerError("MAINTENANCE_CONFIRMATION_REQUIRED");
        }),
      ...(dependencies.authorityMaterialAdapter === undefined
        ? {}
        : { authorityMaterialAdapter: dependencies.authorityMaterialAdapter }),
    };
    this.#workerExit = new Promise<number>((resolveExit) => {
      this.#resolveWorkerExit = resolveExit;
    });
    this.#poisonedSignal = new Promise<ProjectStoreWorkerError>((resolvePoisoned) => {
      this.#resolvePoisonedSignal = resolvePoisoned;
    });
    const workerData: Record<string, JsonValue> = {
      role: "store",
      executorLeaseMs: options.executorLeaseMs,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      appendRetryDeadlineMs: options.appendRetryDeadlineMs ?? options.requestTimeoutMs,
    };
    this.#worker = this.#dependencies.workerFactory(options.workerUrl, { workerData });
    this.#worker.on("message", (value) => this.onMessage(value));
    this.#worker.on("messageerror", () => {
      this.poisonInBackground(new ProjectStoreWorkerError("WORKER_PROTOCOL_ERROR"));
    });
    this.#worker.on("error", () => {
      this.poisonInBackground(new ProjectStoreWorkerError("WORKER_UNAVAILABLE"));
    });
    this.#worker.on("exit", (exitCode) => this.onExit(exitCode));
  }

  ping(): Promise<WorkerPingResult> {
    this.assertCallable(["new"]);
    return this.request({ id: "", type: "ping" }, "read") as Promise<WorkerPingResult>;
  }

  open(): Promise<WorkerOpenResult> {
    if (this.#openPromise !== null) return this.#openPromise;
    this.assertCallable(["new"]);
    this.#openPromise = (async () => {
      const result = await this.request({
        id: "",
        type: "open",
        binding: encodeWorkerBinding(this.#options.context),
      }, "control") as WorkerOpenResult;
      const authorityError = openAuthorityError(this.#options.context, result);
      if (authorityError !== null) {
        await this.poison(authorityError);
        throw authorityError;
      }
      this.#opened = result;
      if (this.#state === "new") this.#state = "open";
      return result;
    })();
    return this.#openPromise;
  }

  append<T extends JsonValue>(command: AppendCommand<T>): Promise<AppendResult<T>> {
    this.assertCallable(["open"]);
    assertCommandContext(command, this.#options.context);
    const binding = encodeWorkerBindingAssertion(this.#options.context);
    return this.request({
      id: "",
      type: "append",
      binding,
      command: encodeAppendCommandWire(command),
    }, "mutation", semanticIdentity(
      this.#options.context.binding.projectId,
      command.commandId,
      command.idempotencyKey,
    )).then((value) => decodeAppendResultWire(value) as AppendResult<T>);
  }

  executeLifecycleMutation<C extends LifecycleSemanticCommandDraft>(
    command: PreparedLifecycleWorkerCommand<C>,
  ): Promise<LifecycleExecutionResult<LifecycleResultFor<C>>> {
    this.assertCallable(["open"]);
    const adapter = this.#dependencies.authorityMaterialAdapter;
    if (adapter === undefined) throw new ProjectStoreWorkerError("LIFECYCLE_V2_DISABLED");
    const wire = decodeLifecycleWorkerOperationWire({
      kind: "semantic",
      operation: command.command.commandType,
      prepared: command,
    });
    if (wire.kind !== "semantic") throw new ProjectStoreWorkerError("WORKER_PROTOCOL_ERROR");
    const identity = semanticIdentity(
      this.#options.context.binding.projectId,
      wire.prepared.command.commandId,
      wire.prepared.command.idempotencyKey,
    );
    return this.executeExternalLifecycle<C>(
      wire as LifecycleSemanticOperationWire<C>,
      identity,
      adapter,
    );
  }

  executeLifecycleInternalMutation<I extends InternalWorkflowExecutionPlan>(
    plan: I,
  ): Promise<LifecycleInternalResultFor<I>> {
    this.assertCallable(["open"]);
    const wire = decodeLifecycleWorkerOperationWire({
      kind: "internal-semantic",
      operation: plan.commandType,
      command: plan,
    });
    if (wire.kind !== "internal-semantic") {
      throw new ProjectStoreWorkerError("WORKER_PROTOCOL_ERROR");
    }
    const identity = semanticIdentity(
      this.#options.context.binding.projectId,
      wire.command.commandId,
      wire.command.idempotencyKey,
    );
    return this.requestLifecycleResult(wire, "mutation", identity) as Promise<
      LifecycleInternalResultFor<I>
    >;
  }

  executeLifecycleBounded<I extends LifecycleBoundedMutationInput>(
    operation: ExactBoundedInput<I>,
  ): Promise<LifecycleBoundedResultFor<LifecycleBoundedMutationForInput<I>>> {
    this.assertCallable(["open"]);
    const wire = decodeLifecycleWorkerOperationWire({
      kind: "bounded",
      operation: operation.operation,
      input: operation,
    });
    if (wire.kind !== "bounded") throw new ProjectStoreWorkerError("WORKER_PROTOCOL_ERROR");
    const identity = boundedIdentity(wire.input.operationId, wire.input.requestId);
    return this.requestLifecycleResult(wire, "bounded", identity) as unknown as Promise<
      LifecycleBoundedResultFor<LifecycleBoundedMutationForInput<I>>
    >;
  }

  queryLifecycle<I extends LifecycleQueryInput>(
    query: ExactQueryInput<I>,
  ): Promise<LifecycleQueryResultFor<LifecycleQueryForInput<I>>> {
    this.assertCallable(["open"]);
    const wire = decodeLifecycleWorkerOperationWire({
      kind: "query",
      operation: query.operation,
      input: query,
    });
    if (wire.kind !== "query") throw new ProjectStoreWorkerError("WORKER_PROTOCOL_ERROR");
    return this.requestLifecycleResult(wire, "read", null) as unknown as Promise<
      LifecycleQueryResultFor<LifecycleQueryForInput<I>>
    >;
  }

  executeLifecycleFenced<I extends LifecycleFencedInput>(
    operation: ExactFencedInput<I>,
  ): Promise<LifecycleFencedResultFor<LifecycleFencedOperationForInput<I>>> {
    this.assertCallable(["open"]);
    const wire = decodeLifecycleWorkerOperationWire({
      kind: "fenced",
      operation: operation.operation,
      input: operation,
    });
    if (wire.kind !== "fenced") throw new ProjectStoreWorkerError("WORKER_PROTOCOL_ERROR");
    const identity = operationalIdentity(this.#options.context.binding.projectId, wire);
    return this.requestLifecycleResult(wire, "operational", identity) as Promise<
      LifecycleFencedResultFor<LifecycleFencedOperationForInput<I>>
    >;
  }

  private requestLifecycleResult(
    operation: LifecycleWorkerOperationWire,
    kind: RequestKind,
    identity: PendingLifecycleIdentity | null,
  ): Promise<JsonValue> {
    return this.request({
      id: "",
      type: "lifecycle",
      binding: encodeWorkerBindingAssertion(this.#options.context),
      operation,
    }, kind, identity).then((value) => (value as LifecycleWorkerSuccessWire).result);
  }

  private async executeExternalLifecycle<C extends LifecycleSemanticCommandDraft>(
    operation: LifecycleSemanticOperationWire<C>,
    identity: SemanticPendingIdentity,
    adapter: AuthorityMaterialAdapter,
  ): Promise<LifecycleExecutionResult<LifecycleResultFor<C>>> {
    const completionIdentity = pendingCommandIdentity(identity);
    let result: WorkerLifecycleResult<LifecycleResultFor<C>>;
    try {
      result = await this.requestLifecycleResult(
        operation,
        "mutation",
        identity,
      ) as WorkerLifecycleResult<LifecycleResultFor<C>>;
    } catch (error) {
      if (
        error instanceof ProjectStoreWorkerError
        && DEFINITIVE_LIFECYCLE_ERROR_CODES.has(error.code)
      ) {
        return adapter.complete(completionIdentity, Object.freeze({
          kind: "rejected" as const,
          errorCode: error.code as Exclude<
            LifecycleErrorCode,
            "COMMAND_OUTCOME_UNKNOWN" | "OPERATION_OUTCOME_UNKNOWN"
          >,
        }));
      }
      throw error;
    }
    try {
      return await adapter.complete(completionIdentity, result);
    } catch (error) {
      if (
        error instanceof LifecycleError
        && (error.code === "COMMAND_OUTCOME_UNKNOWN" || error.code === "OPERATION_OUTCOME_UNKNOWN")
      ) {
        const exactUnknown = identityOutcomeUnknown(identity);
        await this.poison(exactUnknown);
        throw exactUnknown;
      }
      throw error;
    }
  }

  quickIntegrity(tailLimit = 256): Promise<IntegrityReport> {
    this.assertCallable(["open"]);
    return this.request({
      id: "",
      type: "quickIntegrity",
      binding: encodeWorkerBindingAssertion(this.#options.context),
      tailLimit,
    }, "read").then((value) => this.decodeBoundIntegrityReport(value, "quick"));
  }

  fullIntegrity(): Promise<IntegrityReport> {
    this.assertCallable(["open"]);
    return this.request({
      id: "",
      type: "fullIntegrity",
      binding: encodeWorkerBindingAssertion(this.#options.context),
    }, "read").then((value) => this.decodeBoundIntegrityReport(value, "full"));
  }

  private decodeBoundIntegrityReport(
    value: unknown,
    expectedMode: "quick" | "full",
  ): IntegrityReport {
    const report = decodeIntegrityReport(value);
    if (
      report.mode !== expectedMode
      || report.ok !== (report.issues.length === 0)
    ) {
      const error = new ProjectStoreWorkerError("WORKER_PROTOCOL_ERROR");
      this.poisonInBackground(error);
      throw error;
    }
    const binding = this.#options.context.binding;
    const authorityError = report.projectId !== binding.projectId
      ? new ProjectStoreWorkerError("PROJECT_ID_MISMATCH")
      : report.storeId !== binding.storeId
        ? new ProjectStoreWorkerError("STORE_ID_MISMATCH")
        : null;
    if (authorityError !== null) {
      this.poisonInBackground(authorityError);
      throw authorityError;
    }
    return report;
  }

  quiesce(lease: MaintenanceLease): Promise<void> {
    let encodedLease: ReturnType<typeof encodeMaintenanceLeaseWire>;
    let expectedLease: MaintenanceLease;
    try {
      encodedLease = encodeMaintenanceLeaseWire(lease);
      expectedLease = decodeMaintenanceLeaseWire(encodedLease);
    } catch {
      const failure = new ProjectStoreWorkerError("WORKER_PROTOCOL_ERROR");
      this.#quiescePromise ??= (async () => {
        await this.poison(failure);
        throw failure;
      })();
      return this.#quiescePromise;
    }
    if (this.#quiescePromise !== null) {
      if (
        this.#explicitMaintenanceLease !== null
        && sameMaintenanceLease(this.#explicitMaintenanceLease, expectedLease)
      ) {
        return this.#quiescePromise;
      }
      return Promise.reject(new ProjectStoreWorkerError("MAINTENANCE_QUIESCING"));
    }
    if (this.#quiescedNotification !== null) {
      const observedLease = decodeMaintenanceLeaseWire({
        epoch: this.#quiescedNotification.epoch,
        fencingToken: this.#quiescedNotification.fencingToken,
        ownerId: this.#quiescedNotification.ownerId,
        leaseExpiresAt: this.#quiescedNotification.leaseExpiresAt,
      });
      if (!sameMaintenanceLease(observedLease, expectedLease)) {
        return Promise.reject(new ProjectStoreWorkerError("MAINTENANCE_QUIESCING"));
      }
      const observed = this.#observedClosurePromise ?? Promise.resolve();
      return observed.then(() => {
        if (this.#state !== "quiesced") {
          throw this.#terminalError ?? new ProjectStoreWorkerError("WORKER_CLOSED");
        }
      });
    }
    try {
      this.assertCallable(["open"]);
      if (this.#explicitMaintenanceLease !== null) {
        throw new ProjectStoreWorkerError("MAINTENANCE_QUIESCING");
      }
    } catch (error) {
      return Promise.reject(error);
    }
    this.#explicitMaintenanceLease = expectedLease;
    this.#expectedTermination = true;
    this.#quiescePromise = this.quiesceOwned(encodedLease, expectedLease);
    return this.#quiescePromise;
  }

  private async quiesceOwned(
    encodedLease: ReturnType<typeof encodeMaintenanceLeaseWire>,
    expectedLease: MaintenanceLease,
  ): Promise<void> {
    let requestError: ProjectStoreWorkerError | null = null;
    try {
      const response = await this.request({
        id: "",
        type: "quiesce",
        binding: encodeWorkerBindingAssertion(this.#options.context),
        lease: encodedLease,
      }, "control") as { quiesced: true; epoch: string; connectionClosed: true };
      if (response.epoch !== expectedLease.epoch.toString()) {
        requestError = new ProjectStoreWorkerError("WORKER_PROTOCOL_ERROR");
      }
    } catch (error) {
      requestError = error instanceof ProjectStoreWorkerError
        ? error
        : new ProjectStoreWorkerError("WORKER_UNAVAILABLE");
    }

    if (requestError !== null && requestError.code !== "MAINTENANCE_QUIESCING") {
      await this.poison(requestError);
      this.failMaintenanceClosure(requestError);
    }
    let evidenceDeadline: object | null = null;
    const boundedEvidence = requestError?.code === "MAINTENANCE_QUIESCING"
      ? new Promise<{ kind: "timeout" }>((resolveTimeout) => {
          evidenceDeadline = this.#dependencies.scheduler.setTimeout(
            () => resolveTimeout({ kind: "timeout" }),
            this.#options.closeTimeoutMs,
          );
        })
      : new Promise<never>(() => undefined);
    const termination = await Promise.race([
      this.#workerExit.then(() => ({ kind: "exit" as const })),
      this.#poisonedSignal.then((error) => ({ kind: "failure" as const, error })),
      boundedEvidence,
    ]).finally(() => {
      if (evidenceDeadline !== null) {
        this.#dependencies.scheduler.clearTimeout(evidenceDeadline);
      }
    });
    if (termination.kind === "timeout") {
      const failure = new ProjectStoreWorkerError("WORKER_TIMEOUT");
      await this.poison(failure);
      this.failMaintenanceClosure(failure);
    }
    if (termination.kind === "failure") {
      await (this.#terminationPromise ?? Promise.resolve());
      this.failMaintenanceClosure(termination.error);
    }
    if (this.#state === "poisoned" || this.#terminalError !== null) {
      this.failMaintenanceClosure(
        this.#terminalError ?? new ProjectStoreWorkerError("WORKER_PROTOCOL_ERROR"),
      );
    }
    const notification = this.#quiescedNotification;
    if (notification === null) {
      this.failMaintenanceClosure(new ProjectStoreWorkerError("WORKER_PROTOCOL_ERROR"));
    }
    const observedLease = decodeMaintenanceLeaseWire({
      epoch: notification.epoch,
      fencingToken: notification.fencingToken,
      ownerId: notification.ownerId,
      leaseExpiresAt: notification.leaseExpiresAt,
    });
    if (
      !sameMaintenanceLease(observedLease, expectedLease)
      || this.#state !== "closed"
    ) {
      this.failMaintenanceClosure(new ProjectStoreWorkerError("WORKER_PROTOCOL_ERROR"));
    }

    let ownerError: ProjectStoreWorkerError | null = null;
    try {
      await this.#dependencies.confirmMaintenanceClosure({
        projectId: this.#options.context.binding.projectId,
        executorId: this.#opened!.executorId,
        lease: expectedLease,
        connectionClosed: true,
      });
    } catch (error) {
      ownerError = confirmationError(error);
    }
    if (ownerError !== null) {
      this.#state = "poisoned";
      this.#terminalError = ownerError;
      this.rejectAll(ownerError);
      throw ownerError;
    }
    this.#state = "quiesced";
    this.#terminalError = new ProjectStoreWorkerError("WORKER_CLOSED");
  }

  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    if (this.#quiescePromise !== null) {
      this.#closePromise = this.#quiescePromise;
      return this.#closePromise;
    }
    if (this.#state === "closed" || this.#state === "quiesced") return Promise.resolve();
    if (this.#state === "poisoned") {
      this.#closePromise = this.#terminationPromise ?? Promise.resolve();
      return this.#closePromise;
    }
    this.#state = "closing";
    this.#closePromise = this.closeOwned();
    return this.#closePromise;
  }

  async invalidateForRebind(next: ProjectContext): Promise<void> {
    if (this.#state === "closed" || this.#state === "quiesced") return;
    if (this.#state === "poisoned") {
      await (this.#terminationPromise ?? Promise.resolve());
      return;
    }
    await this.poison(new ProjectStoreWorkerError("PROJECT_BINDING_REQUIRED", {
      staleGeneration: this.#options.context.binding.generation,
      nextGeneration: next.binding.generation,
    }));
  }

  private assertCallable(allowed: readonly ExecutorState[]): void {
    if (allowed.includes(this.#state)) return;
    throw this.#terminalError ?? new ProjectStoreWorkerError(
      this.#state === "closing" || this.#state === "closed" || this.#state === "quiesced"
        ? "WORKER_CLOSED"
        : "PROJECT_BINDING_REQUIRED",
    );
  }

  private request(
    request: WorkerRequest,
    kind: RequestKind,
    identity: PendingLifecycleIdentity | null = null,
  ): Promise<unknown> {
    if (this.#pending.size >= this.#options.maxPending) {
      return Promise.reject(new ProjectStoreWorkerError("STORE_QUEUE_FULL"));
    }
    const id = `${this.#dependencies.randomId()}:${++this.#sequence}`;
    const candidate = { ...request, id } as WorkerRequest;
    const completeRequest = candidate.type === "lifecycle"
      ? decodeWorkerRequest(candidate)
      : candidate;
    return new Promise<unknown>((resolveRequest, rejectRequest) => {
      const timer = this.#dependencies.scheduler.setTimeout(() => {
        this.poisonInBackground(new ProjectStoreWorkerError("WORKER_TIMEOUT"));
      }, this.#options.requestTimeoutMs);
      const pending: PendingRequest = {
        request: completeRequest,
        kind,
        identity,
        timer,
        posted: false,
        resolve: resolveRequest,
        reject: rejectRequest,
      };
      this.#pending.set(id, pending);
      try {
        this.#worker.postMessage(completeRequest);
        pending.posted = true;
      } catch {
        this.#pending.delete(id);
        this.#dependencies.scheduler.clearTimeout(timer);
        rejectRequest(new ProjectStoreWorkerError("WORKER_UNAVAILABLE"));
        this.notifyDrain();
        this.poisonInBackground(new ProjectStoreWorkerError("WORKER_UNAVAILABLE"));
      }
    });
  }

  private onMessage(value: unknown): void {
    let message: WorkerMessage;
    try {
      message = decodeWorkerMessage(value);
    } catch {
      this.poisonInBackground(new ProjectStoreWorkerError("WORKER_PROTOCOL_ERROR"));
      return;
    }
    if (!("id" in message)) {
      this.onNotification(message);
      return;
    }
    const pending = this.#pending.get(message.id);
    if (pending === undefined) {
      this.poisonInBackground(new ProjectStoreWorkerError("WORKER_PROTOCOL_ERROR"));
      return;
    }
    let response: WorkerResponse;
    try {
      response = decodeWorkerResponseForRequest(message, pending.request);
      if (response.ok && pending.request.type === "lifecycle") {
        const success = response.data as LifecycleWorkerSuccessWire;
        assertDecodedLifecycleContextBinding(success.result, this.#options.context);
      }
    } catch {
      this.poisonInBackground(new ProjectStoreWorkerError("WORKER_PROTOCOL_ERROR"));
      return;
    }
    this.#pending.delete(message.id);
    this.#dependencies.scheduler.clearTimeout(pending.timer);
    if (!response.ok) {
      const reported = new ProjectStoreWorkerError(
        response.error.code,
        safeDetails(response.error.details),
      );
      const uncertain = reported.code === "COMMAND_OUTCOME_UNKNOWN"
        || reported.code === "OPERATION_OUTCOME_UNKNOWN"
        || reported.code === "WORKER_PROTOCOL_ERROR";
      const exactUnknown = uncertain
        ? this.unknownOutcome(pending)
        : null;
      const error = uncertain
        ? exactUnknown ?? new ProjectStoreWorkerError("WORKER_PROTOCOL_ERROR")
        : reported;
      pending.reject(error);
      if (
        pending.request.type === "open"
        || ASSERTION_FAILURES.has(error.code)
        || uncertain
      ) {
        this.poisonInBackground(error);
      }
    } else {
      pending.resolve(response.data);
    }
    this.notifyDrain();
  }

  private onNotification(notification: WorkerNotification): void {
    if (
      notification.type !== "quiesced"
      || this.#opened === null
      || notification.executorId !== this.#opened.executorId
      || notification.connectionClosed !== true
    ) {
      this.poisonInBackground(new ProjectStoreWorkerError("WORKER_PROTOCOL_ERROR"));
      return;
    }
    if (this.#quiescedNotification !== null) {
      this.poisonInBackground(new ProjectStoreWorkerError("WORKER_PROTOCOL_ERROR"));
      return;
    }
    const observedLease = decodeMaintenanceLeaseWire({
      epoch: notification.epoch,
      fencingToken: notification.fencingToken,
      ownerId: notification.ownerId,
      leaseExpiresAt: notification.leaseExpiresAt,
    });
    if (
      this.#explicitMaintenanceLease !== null
      && !sameMaintenanceLease(observedLease, this.#explicitMaintenanceLease)
    ) {
      this.poisonInBackground(new ProjectStoreWorkerError("WORKER_PROTOCOL_ERROR"));
      return;
    }
    this.#quiescedNotification = notification;
    this.#expectedTermination = true;
  }

  private onExit(exitCode: number): void {
    this.#resolveWorkerExit(exitCode);
    if (this.#expectedTermination) {
      if (this.#pending.size > 0) {
        const failure = new ProjectStoreWorkerError("WORKER_UNAVAILABLE", {
          abnormalExit: exitCode !== 0,
        });
        this.#state = "poisoned";
        this.#terminalError = failure;
        this.rejectAll(failure);
      }
      if (this.#state === "poisoned" || this.#terminalError !== null) return;
      this.#state = "closed";
      if (this.#explicitMaintenanceLease === null && this.#quiescedNotification !== null) {
        this.#observedClosurePromise = this.confirmObservedMaintenanceClosure(
          this.#quiescedNotification,
        );
        void this.#observedClosurePromise;
      }
      return;
    }
    this.poisonInBackground(new ProjectStoreWorkerError("WORKER_UNAVAILABLE", {
      abnormalExit: exitCode !== 0,
    }), false);
  }

  private failMaintenanceClosure(error: ProjectStoreWorkerError): never {
    this.#state = "poisoned";
    this.#terminalError = error;
    this.rejectAll(error);
    throw error;
  }

  private async confirmObservedMaintenanceClosure(
    notification: WorkerNotification,
  ): Promise<void> {
    const lease = decodeMaintenanceLeaseWire({
      epoch: notification.epoch,
      fencingToken: notification.fencingToken,
      ownerId: notification.ownerId,
      leaseExpiresAt: notification.leaseExpiresAt,
    });
    try {
      await this.#dependencies.confirmMaintenanceClosure({
        projectId: this.#options.context.binding.projectId,
        executorId: notification.executorId,
        lease,
        connectionClosed: true,
      });
      this.#state = "quiesced";
      this.#terminalError = new ProjectStoreWorkerError("WORKER_CLOSED");
    } catch (error) {
      const failure = confirmationError(error);
      this.#state = "poisoned";
      this.#terminalError = failure;
      this.rejectAll(failure);
    }
  }

  private unknownOutcome(pending: PendingRequest): ProjectStoreWorkerError | null {
    if (!pending.posted || pending.identity === null) return null;
    return identityOutcomeUnknown(pending.identity);
  }

  private rejectAll(readError: ProjectStoreWorkerError): void {
    const requests = [...this.#pending.values()];
    this.#pending.clear();
    for (const pending of requests) {
      this.#dependencies.scheduler.clearTimeout(pending.timer);
      pending.reject(this.unknownOutcome(pending) ?? readError);
    }
    this.notifyDrain();
  }

  private async poison(error: ProjectStoreWorkerError, terminate = true): Promise<void> {
    if (this.#state === "closed") return;
    if (this.#state === "poisoned") {
      if (terminate) await (this.#terminationPromise ?? Promise.resolve());
      return;
    }
    this.#state = "poisoned";
    this.#terminalError = error;
    this.rejectAll(error);
    this.#resolvePoisonedSignal(error);
    if (terminate) {
      await this.terminateWorker();
    }
  }

  private poisonInBackground(error: ProjectStoreWorkerError, terminate = true): void {
    void this.poison(error, terminate).catch(() => {
      // terminateWorker records a stable terminal failure for later close callers.
    });
  }

  private notifyDrain(): void {
    if (this.#pending.size !== 0) return;
    for (const waiter of this.#drainWaiters) waiter();
    this.#drainWaiters.clear();
  }

  private waitForDrain(): Promise<void> {
    if (this.#pending.size === 0) return Promise.resolve();
    return new Promise((resolveDrain) => this.#drainWaiters.add(resolveDrain));
  }

  private async closeOwned(): Promise<void> {
    let deadline!: object;
    const forced = new Promise<{ kind: "forced" }>((resolveForced) => {
      deadline = this.#dependencies.scheduler.setTimeout(
        () => resolveForced({ kind: "forced" }),
        this.#options.closeTimeoutMs,
      );
    });
    const graceful = (async () => {
      await this.waitForDrain();
      if (this.#state === "poisoned" || this.#state === "quiesced") return;
      await this.request({ id: "", type: "close" }, "control");
      await this.terminateWorker();
      this.#state = "closed";
    })();
    try {
      const outcome = await Promise.race([
        graceful.then(
          () => ({ kind: "graceful" as const }),
          (error: unknown) => ({ kind: "failed" as const, error }),
        ),
        forced,
      ]);
      if (outcome.kind === "forced") {
        await this.poison(new ProjectStoreWorkerError("WORKER_TIMEOUT"));
        this.#state = "closed";
        return;
      }
      if (outcome.kind === "failed") {
        const error = outcome.error instanceof ProjectStoreWorkerError
          ? outcome.error
          : new ProjectStoreWorkerError("WORKER_UNAVAILABLE");
        await this.poison(error);
        throw error;
      }
    } finally {
      this.#dependencies.scheduler.clearTimeout(deadline);
    }
  }

  canReuse(): boolean {
    return this.#state === "new" || this.#state === "open";
  }

  hasRegisteredExecutor(): boolean {
    return this.#opened !== null;
  }

  private terminateWorker(): Promise<void> {
    if (this.#terminationPromise !== null) return this.#terminationPromise;
    this.#expectedTermination = true;
    this.#terminationPromise = (async () => {
      try {
        const exitCode = await this.#worker.terminate();
        this.#resolveWorkerExit(exitCode);
      } catch {
        const failure = terminationFailure();
        this.#state = "poisoned";
        this.#terminalError = failure;
        this.rejectAll(failure);
        this.#resolvePoisonedSignal(failure);
        throw failure;
      }
    })();
    return this.#terminationPromise;
  }
}

export class ProjectStoreExecutorRegistry {
  readonly #entries = new Map<string, { key: string; executor: ProjectStoreExecutor }>();
  readonly #acquisitions = new Map<string, Promise<ProjectStoreExecutor>>();
  readonly #quiescences = new Map<
    string,
    { lease: MaintenanceLease; promise: Promise<void> }
  >();

  constructor(private readonly dependencies: Partial<ProjectStoreExecutorDependencies> = {}) {}

  async acquire(options: ProjectStoreExecutorOptions): Promise<ProjectStoreExecutor> {
    const reuseKey = storeReuseKey(options.context);
    if (this.#quiescences.has(reuseKey)) {
      throw new ProjectStoreWorkerError("MAINTENANCE_QUIESCING");
    }
    const predecessor = this.#acquisitions.get(reuseKey);
    const acquisition = (async () => {
      if (predecessor !== undefined) await predecessor.catch(() => undefined);
      if (this.#quiescences.has(reuseKey)) {
        throw new ProjectStoreWorkerError("MAINTENANCE_QUIESCING");
      }
      const exactKey = projectStoreExecutorKey(options.context);
      const current = this.#entries.get(reuseKey);
      if (current?.key === exactKey && current.executor.canReuse()) return current.executor;
      if (current !== undefined) await current.executor.invalidateForRebind(options.context);
      const executor = new ProjectStoreExecutor(options, this.dependencies);
      this.#entries.set(reuseKey, { key: exactKey, executor });
      return executor;
    })();
    this.#acquisitions.set(reuseKey, acquisition);
    try {
      return await acquisition;
    } finally {
      if (this.#acquisitions.get(reuseKey) === acquisition) {
        this.#acquisitions.delete(reuseKey);
      }
    }
  }

  async quiesceStore(
    context: ProjectContext,
    lease: MaintenanceLease,
  ): Promise<void> {
    const reuseKey = storeReuseKey(context);
    const currentQuiescence = this.#quiescences.get(reuseKey);
    if (currentQuiescence !== undefined) {
      return sameMaintenanceLease(currentQuiescence.lease, lease)
        ? currentQuiescence.promise
        : Promise.reject(new ProjectStoreWorkerError("MAINTENANCE_QUIESCING"));
    }
    const quiescence = this.quiesceStoreOwned(reuseKey, lease);
    const active = { lease, promise: quiescence };
    this.#quiescences.set(reuseKey, active);
    try {
      await quiescence;
    } finally {
      if (this.#quiescences.get(reuseKey) === active) this.#quiescences.delete(reuseKey);
    }
  }

  private async quiesceStoreOwned(
    reuseKey: string,
    lease: MaintenanceLease,
  ): Promise<void> {
    for (;;) {
      const acquiring = this.#acquisitions.get(reuseKey);
      if (acquiring !== undefined) await acquiring;
      if (this.#acquisitions.get(reuseKey) !== undefined) continue;
      const current = this.#entries.get(reuseKey);
      if (current === undefined) return;
      if (!current.executor.hasRegisteredExecutor()) {
        if (this.#entries.get(reuseKey) === current) this.#entries.delete(reuseKey);
        return;
      }
      try {
        await current.executor.quiesce(lease);
      } finally {
        if (this.#entries.get(reuseKey) === current) this.#entries.delete(reuseKey);
      }
      if (this.#entries.get(reuseKey) === undefined) return;
    }
  }
}
