import { decodeGovernedFixtureActionV1, decodeGovernedFixtureResultV1, type GovernedFixtureActionV1, type GovernedFixtureResultV1, type GovernedFixtureActionPortV1, type TrustedGovernedFixtureFactoryV1 } from "../governed-notes/fixture-control.js";
import { GovernedNoteError } from "../governed-notes/errors.js";
import { hasUncertainGovernedRecoveryCleanup } from "../governed-notes/service.js";
import { decodePreparedGovernedNoteCreateV1, decodePreparedGovernedNoteRecoveryV1 } from "../governed-notes/codec.js";
import type { GovernedNoteRuntime, GovernedNoteRuntimeFactoryPort } from "../governed-notes/contracts.js";
import { decodeGovernedNoteWorkerResponse, governedNoteRequestIds, isGovernedNoteRequest, sanitizeGovernedNoteError, type GovernedNoteWorkerRequest } from "../governed-notes/worker-protocol.js";
import { randomUUID } from "node:crypto";
import { RetainedEvidenceError } from "../privacy/evidence-contracts.js";
import { decodePreparedRetainedEvidenceCommand, decodeRetainedEvidenceWorkerResponse } from "../privacy/retained-evidence-worker-protocol.js";
import type { RetainedEvidenceRuntime, RetainedEvidenceRuntimeFactoryPort } from "../privacy/retained-evidence-runtime.factory.js";
import { FreshStartAdmissionGuard, assertFreshStartConnectionAllowed, bindFreshStartAdmissionContext } from "../fresh-start/fresh-start-admission.js";
import { FreshStartError } from "../fresh-start/contracts.js";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import type { JsonValue } from "../contracts/event.js";
import type { ProjectContext } from "../identity/contracts.js";
import { EventIntegrityService } from "../integrity/event-integrity.service.js";
import { LifecycleIntegrityService } from "../integrity/lifecycle-integrity.service.js";
import type {
  HistoricalEvidenceIntegrityProviderPort,
  IntegrityReport,
} from "../integrity/integrity.types.js";
import type { CapabilityKeyProvider } from "../lifecycle/authority/capability-key-provider.js";
import { LifecycleError } from "../lifecycle/errors.js";
import { BranchScopeRepository } from "../storage/branch-scope.repository.js";
import {
  EventStore,
  EventStoreError,
  SqliteEventStoreStatements,
} from "../storage/event-store.js";
import { MaintenanceFence } from "../storage/maintenance-fence.js";
import { PROJECT_STORE_MIGRATIONS } from "../storage/migrations/registry.js";
import { NodeSqliteDriver } from "../storage/node-sqlite-driver.js";
import {
  inspectStoreSchema,
  requireCurrentStoreSchema,
  SchemaCompatibilityError,
} from "../storage/schema-compatibility.js";
import type { SqliteConnection, SqliteRow } from "../storage/sqlite-driver.js";
import {
  compareVersions,
  DEFAULT_BUSY_TIMEOUT_MS,
  MINIMUM_NODE_VERSION,
  MINIMUM_SQLITE_VERSION,
  probeRuntimeCapabilities,
} from "./runtime-capabilities.js";
import type {
  WorkerHeartbeatObservation,
  WorkerRuntimeBackend,
} from "./project-store-worker-runtime.js";
import type { LifecycleWorkerRuntimeFactoryPort } from "./lifecycle-worker-runtime.factory.js";
import type { LifecycleWorkerRuntime } from "./lifecycle-worker-runtime.js";
import {
  decodeAppendCommandWire,
  decodeFreshStartContextWire,
  encodeFreshStartContextWire,
  decodeIntegrityProviderRequestWire,
  decodeIntegrityReport,
  decodeMaintenanceLeaseWire,
  decodeWorkerBinding,
  decodeWorkerMessage,
  decodeWorkerResponseForRequest,
  encodeAppendResultWire,
  encodeMaintenanceLeaseWire,
  encodeWorkerBinding,
  MAX_INTEGRITY_PROVIDER_INPUT_BYTES,
  type MaintenanceLeaseWire,
  type IntegrityProviderResponseWire,
  type ProjectStoreRouteWire,
  type StoreIdentityExpectationWire,
  type StoreIdentityWire,
  type WorkerBindingAssertion,
  type WorkerRequest,
  type WorkerSuccessData,
  type FreshStartContextWire,
  type FreshStartOpenWire,
} from "./worker-protocol.js";

const POSITIVE_SAFE_INTEGER = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

const terminalGovernedReadErrors = new WeakSet<object>();
/** Internal identity only: public error codes cannot certify owner health. */
export function isTerminalGovernedReadOwnerError(error: unknown): boolean {
  return typeof error === "object" && error !== null && terminalGovernedReadErrors.has(error);
}

export class ProjectStoreWorkerBackendError extends Error {
  constructor(
    readonly code: string,
    readonly details: Record<string, JsonValue> = {},
  ) {
    super(code);
    this.name = "ProjectStoreWorkerBackendError";
  }
}

export interface ProjectStoreWorkerBackendOptions {
  /** Independently measures the executing deployment; absence keeps fresh stores closed. */
  readonly trustedFreshStartBuildInspector?: () => string;
  selfUrl: URL;
  executorLeaseMs: number;
  appendRetryDeadlineMs: number;
  readonly keyProvider?: CapabilityKeyProvider;
  readonly lifecycleRuntimeFactory?: LifecycleWorkerRuntimeFactoryPort;
  readonly trustedGovernedFixtureFactory?: TrustedGovernedFixtureFactoryV1;
  readonly governedNoteRuntimeFactory?: GovernedNoteRuntimeFactoryPort;
  readonly retainedEvidenceRuntimeFactory?: RetainedEvidenceRuntimeFactoryPort;
  afterReadOnlyIdentityVerified?: () => void;
  integrityWorkerFactory?: (
    url: URL,
    options: { workerData: Record<string, unknown> },
  ) => IntegrityWorkerLike;
  maintenanceFactory?: () => MaintenanceFence;
  eventStoreFactory?: (
    connection: SqliteConnection,
    maintenance: MaintenanceFence,
  ) => EventStore;
}

export interface IntegrityWorkerLike {
  postMessage(value: unknown): void;
  terminate(): Promise<number>;
  on(event: "message", listener: (value: unknown) => void): this;
  on(event: "messageerror", listener: (error: unknown) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (exitCode: number) => void): this;
}

function failure(code: string, details: Record<string, JsonValue> = {}): never {
  throw new ProjectStoreWorkerBackendError(code, details);
}

function terminationFailure(): ProjectStoreWorkerBackendError {
  return new ProjectStoreWorkerBackendError("WORKER_UNAVAILABLE", {
    terminationFailed: true,
  });
}

const INTRINSIC_UINT8_ARRAY_FILL = Uint8Array.prototype.fill;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const INTRINSIC_TYPED_ARRAY_BUFFER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "buffer",
)!.get!;
const INTRINSIC_TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "byteLength",
)!.get!;
const INTRINSIC_TYPED_ARRAY_BYTE_OFFSET = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "byteOffset",
)!.get!;
const INTRINSIC_ARRAY_BUFFER_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength",
)!.get!;

function ownsWholeBytes(bytes: Uint8Array, expectedByteLength: number): boolean {
  try {
    const buffer = INTRINSIC_TYPED_ARRAY_BUFFER.call(bytes) as ArrayBuffer;
    return buffer instanceof ArrayBuffer
      && INTRINSIC_TYPED_ARRAY_BYTE_LENGTH.call(bytes) === expectedByteLength
      && INTRINSIC_TYPED_ARRAY_BYTE_OFFSET.call(bytes) === 0
      && INTRINSIC_ARRAY_BUFFER_BYTE_LENGTH.call(buffer) === expectedByteLength;
  } catch {
    return false;
  }
}

function intrinsicByteLength(bytes: Uint8Array): number {
  try {
    return INTRINSIC_TYPED_ARRAY_BYTE_LENGTH.call(bytes) as number;
  } catch {
    return 0;
  }
}

function scrubProviderBytes(bytes: Uint8Array, expectedByteLength: number): boolean {
  const ownershipValid = ownsWholeBytes(bytes, expectedByteLength);
  try {
    INTRINSIC_UINT8_ARRAY_FILL.call(bytes, 0);
  } catch {
    return false;
  }
  return ownershipValid && ownsWholeBytes(bytes, expectedByteLength);
}

function zeroMalformedProviderFingerprint(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  const candidate = value as { operation?: unknown; bytes?: unknown };
  const bytes = candidate.bytes;
  if (
    candidate.operation === "fingerprint"
    && bytes instanceof Uint8Array
    && Object.getPrototypeOf(bytes) === Uint8Array.prototype
    && bytes.buffer instanceof ArrayBuffer
    && intrinsicByteLength(bytes) >= 1
    && intrinsicByteLength(bytes) <= MAX_INTEGRITY_PROVIDER_INPUT_BYTES
  ) scrubProviderBytes(bytes, intrinsicByteLength(bytes));
}

function canonicalEventsPath(route: ProjectStoreRouteWire): string {
  try {
    const requested = resolve(route.eventsPath);
    const canonical = resolve(realpathSync.native(requested));
    if (!statSync(canonical).isFile()) failure("STORE_UNAVAILABLE");
    const same = process.platform === "win32"
      ? requested.toLowerCase() === canonical.toLowerCase()
      : requested === canonical;
    const canonicalRoot = resolve(dirname(canonical));
    const routedRoot = resolve(route.storeRoot);
    const sameRoot = process.platform === "win32"
      ? canonicalRoot.toLowerCase() === routedRoot.toLowerCase()
      : canonicalRoot === routedRoot;
    if (!same || !sameRoot) {
      failure("STORE_ROUTE_INVALID");
    }
    return canonical;
  } catch (error) {
    if (error instanceof ProjectStoreWorkerBackendError) throw error;
    failure("STORE_UNAVAILABLE");
  }
}

function number(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "bigint") return undefined;
  const decoded = Number(value);
  return Number.isSafeInteger(decoded) ? decoded : undefined;
}

function requiredString(row: SqliteRow | undefined, key: string): string {
  const value = row?.[key];
  if (typeof value !== "string" || value.length === 0) failure("STORE_UNAVAILABLE");
  return value;
}

function identityFromConnection(
  connection: SqliteConnection,
  expected: StoreIdentityExpectationWire,
  expectedStoreId?: string,
): StoreIdentityWire {
  const journal = connection.prepare("PRAGMA journal_mode").get()?.journal_mode;
  if (typeof journal !== "string" || journal.toLowerCase() !== "wal") failure("STORE_UNAVAILABLE");

  try {
    requireCurrentStoreSchema(inspectStoreSchema(connection, PROJECT_STORE_MIGRATIONS));
  } catch (error) {
    if (error instanceof SchemaCompatibilityError) failure(error.code);
    throw error;
  }

  const rows = connection.prepare(`
    SELECT project_id, vault_id, store_id
    FROM project_meta
    WHERE singleton = 1
  `).all();
  if (rows.length !== 1) failure("STORE_UNAVAILABLE");
  const projectId = requiredString(rows[0], "project_id");
  const vaultId = requiredString(rows[0], "vault_id");
  const storeId = requiredString(rows[0], "store_id");
  if (projectId !== expected.projectId) failure("PROJECT_ID_MISMATCH");
  if (vaultId !== expected.vaultId) failure("VAULT_ID_MISMATCH");
  if (expectedStoreId !== undefined && storeId !== expectedStoreId) failure("STORE_ID_MISMATCH");
  return { projectId, vaultId, storeId };
}

async function sqliteDriver(): Promise<NodeSqliteDriver> {
  const sqlite = await import("node:sqlite");
  return new NodeSqliteDriver(sqlite);
}

export async function inspectProjectStoreIdentity(
  route: ProjectStoreRouteWire,
  expected: StoreIdentityExpectationWire,
  expectedStoreId?: string,
): Promise<StoreIdentityWire> {
  const path = canonicalEventsPath(route);
  const driver = await sqliteDriver();
  const connection = driver.open(path, {
    mode: "read-only-existing",
    busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
  });
  try {
    return identityFromConnection(connection, expected, expectedStoreId);
  } finally {
    connection.close();
  }
}

function addMilliseconds(now: string, milliseconds: number): string {
  const instant = new Date(now).getTime();
  if (!Number.isFinite(instant)) failure("MAINTENANCE_TIMESTAMP_INVALID");
  return new Date(instant + milliseconds).toISOString();
}

function isRetryableBusy(error: unknown): error is EventStoreError {
  return error instanceof EventStoreError
    && error.code === "SQLITE_BUSY"
    && error.details.retryable === true;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

export interface PrimarySqliteBusyRetryOptions {
  deadlineMs: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export async function retryPrimarySqliteBusy<T>(
  operation: () => T,
  options: PrimarySqliteBusyRetryOptions,
): Promise<T> {
  if (!POSITIVE_SAFE_INTEGER(options.deadlineMs)) {
    throw new ProjectStoreWorkerBackendError("WORKER_CONFIG_INVALID");
  }
  const clock = options.now ?? Date.now;
  const pause = options.sleep ?? wait;
  const started = clock();
  let attempt = 0;
  for (;;) {
    try {
      return operation();
    } catch (error) {
      if (!isRetryableBusy(error)) throw error;
      const elapsed = clock() - started;
      if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= options.deadlineMs) throw error;
      attempt += 1;
      const jitter = Math.min(100, 5 + ((attempt * 17) % 47));
      if (elapsed + jitter >= options.deadlineMs) throw error;
      await pause(jitter);
    }
  }
}

function assertBinding(context: ProjectContext, assertion: WorkerBindingAssertion): void {
  const current = context.binding;
  if (assertion.projectId !== current.projectId) failure("PROJECT_ID_MISMATCH");
  if (assertion.vaultId !== current.vaultId) failure("VAULT_ID_MISMATCH");
  if (assertion.storeId !== current.storeId) failure("STORE_ID_MISMATCH");
  if (
    assertion.bindingGeneration !== current.generation
    || assertion.contextFingerprint !== current.contextFingerprint
  ) {
    failure("PROJECT_BINDING_REQUIRED", {
      staleGeneration: assertion.bindingGeneration,
      currentGeneration: current.generation,
    });
  }
}

interface ActiveStore {
  context: ProjectContext;
  connection: SqliteConnection;
  maintenance: MaintenanceFence;
  eventStore: EventStore;
  lifecycleRuntime: LifecycleWorkerRuntime | null;
  retainedEvidenceRuntime: RetainedEvidenceRuntime | null;
  governedNoteRuntime: GovernedNoteRuntime | null;
  governedFixture: GovernedFixtureActionPortV1 | null;
  executorId: string;
}

export class ProjectStoreWorkerBackend implements WorkerRuntimeBackend {
  readonly #options: ProjectStoreWorkerBackendOptions;
  readonly #children = new Set<IntegrityWorkerLike>();
  #active: ActiveStore | null = null;
  #closed = false;

  constructor(options: ProjectStoreWorkerBackendOptions) {
    if (
      !(options.selfUrl instanceof URL)
      || options.selfUrl.protocol !== "file:"
      || !POSITIVE_SAFE_INTEGER(options.executorLeaseMs)
      || !POSITIVE_SAFE_INTEGER(options.appendRetryDeadlineMs)
      || options.executorLeaseMs <= DEFAULT_BUSY_TIMEOUT_MS
    ) {
      throw new ProjectStoreWorkerBackendError("WORKER_CONFIG_INVALID");
    }
    this.#options = options;
  }

  async dispatch(request: WorkerRequest): Promise<WorkerSuccessData> {
    if (isGovernedNoteRequest(request)) return this.governedNote(request);
    if (this.#closed && request.type !== "ping") failure("WORKER_CLOSED");
    switch (request.type) {
      case "ping": return this.ping();
      case "verifyIdentity": {
        await inspectProjectStoreIdentity(request.route, request.expected, request.expected.storeId);
        return { verified: true };
      }
      case "inspectExisting":
        return inspectProjectStoreIdentity(request.route, request.expected);
      case "open":
        return this.open(request.binding, request.freshStart);
      case "append": {
        const active = this.requireActive(request.binding);
        return this.append(active, request.command);
      }
      case "lifecycle":
        const active = this.requireActive(request.binding);
        if (active.lifecycleRuntime === null) failure("LIFECYCLE_V2_DISABLED");
        return this.lifecycle(active, request);
      case "retained-evidence":
        return this.retainEvidence(this.requireActive(request.binding), request);
      case "quickIntegrity": {
        const active = this.requireActive(request.binding);
        return this.integrityInChild(active, request);
      }
      case "fullIntegrity": {
        const active = this.requireActive(request.binding);
        return this.integrityInChild(active, request);
      }
      case "quiesce":
      case "close":
        failure("WORKER_PROTOCOL_ERROR");
    }
  }

  async heartbeat(): Promise<WorkerHeartbeatObservation> {
    const active = this.active();
    const now = new Date().toISOString();
    const observation = active.maintenance.heartbeatExecutor(
      active.connection,
      active.context.binding.projectId,
      active.executorId,
      addMilliseconds(now, this.#options.executorLeaseMs),
      now,
    );
    return observation.mode === "idle"
      ? { mode: "idle" }
      : { mode: "quiescing", lease: encodeMaintenanceLeaseWire(observation.lease) };
  }

  async quiesceAndClose(
    leaseWire: MaintenanceLeaseWire,
    assertion: WorkerBindingAssertion,
  ): Promise<{ executorId: string; epoch: string; fencingToken: string }> {
    const active = this.active();
    assertBinding(active.context, assertion);
    return this.closeForMaintenance(active, leaseWire);
  }

  async quiesceObservedAndClose(
    leaseWire: MaintenanceLeaseWire,
  ): Promise<{ executorId: string; epoch: string; fencingToken: string }> {
    return this.closeForMaintenance(this.active(), leaseWire);
  }

  private async closeForMaintenance(
    active: ActiveStore,
    leaseWire: MaintenanceLeaseWire,
  ): Promise<{ executorId: string; epoch: string; fencingToken: string }> {
    const lease = decodeMaintenanceLeaseWire(leaseWire);
    const acknowledgedAt = new Date().toISOString();
    let primaryError: unknown;
    let failed = false;
    try {
      active.connection.exec("BEGIN IMMEDIATE");
      active.maintenance.acknowledge(
        active.connection,
        lease,
        active.executorId,
        acknowledgedAt,
      );
      active.connection.exec("COMMIT");
    } catch (error) {
      try { active.connection.exec("ROLLBACK"); } catch { /* preserve fence failure */ }
      primaryError = error;
      failed = true;
    }
    try {
      await this.closeHandles(active);
    } catch (error) {
      if (!failed) {
        primaryError = error;
        failed = true;
      }
    }
    if (failed) throw primaryError;
    return {
      executorId: active.executorId,
      epoch: leaseWire.epoch,
      fencingToken: leaseWire.fencingToken,
    };
  }

  async close(): Promise<void> {
    const active = this.#active;
    if (active === null) {
      try {
        await this.terminateChildren();
      } finally {
        this.#closed = true;
      }
      return;
    }
    await this.closeHandles(active);
  }

  private ping(): WorkerSuccessData {
    const sqliteVersion = (process.versions as Record<string, string | undefined>).sqlite;
    if (
      sqliteVersion === undefined
      || compareVersions(process.versions.node, MINIMUM_NODE_VERSION) < 0
      || compareVersions(sqliteVersion, MINIMUM_SQLITE_VERSION) < 0
    ) {
      failure("SQLITE_CAPABILITY_MISSING");
    }
    return {
      nodeVersion: process.versions.node,
      sqliteVersion,
      walSafe: true,
    };
  }

  private async open(binding: unknown, freshStartWire?: FreshStartContextWire): Promise<WorkerSuccessData> {
    if (this.#active !== null || this.#closed) failure("PROJECT_BINDING_REQUIRED");
    const requestedFresh = freshStartWire === undefined ? undefined : decodeFreshStartContextWire(freshStartWire);
    const context = decodeWorkerBinding(binding);
    const path = canonicalEventsPath(context.binding.storeRoute);

    const probeRoot = mkdtempSync(join(tmpdir(), "project-store-worker-probe-"));
    try {
      const capabilities = await probeRuntimeCapabilities(join(probeRoot, "capabilities.sqlite"));
      if (!capabilities.ok) failure(capabilities.code);
    } finally {
      rmSync(probeRoot, { recursive: true, force: true });
    }

    await inspectProjectStoreIdentity(
      context.binding.storeRoute,
      { projectId: context.binding.projectId, vaultId: context.binding.vaultId },
      context.binding.storeId,
    );
    this.#options.afterReadOnlyIdentityVerified?.();
    const driver = await sqliteDriver();
    const connection = driver.open(path, {
      mode: "existing",
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    });
    let lifecycleRuntime: LifecycleWorkerRuntime | null = null;
    let retainedEvidenceRuntime: RetainedEvidenceRuntime | null = null;
    let governedNoteRuntime: GovernedNoteRuntime | null = null;
    let governedFixture: GovernedFixtureActionPortV1 | null = null;
    let registrationBegan = false;
    try {
      const maintenance = this.#options.maintenanceFactory?.() ?? new MaintenanceFence();
      const executorId = randomUUID();
      const now = new Date().toISOString();
      identityFromConnection(
        connection,
        { projectId: context.binding.projectId, vaultId: context.binding.vaultId },
        context.binding.storeId,
      );
      if (requestedFresh !== undefined) {
        if (requestedFresh.identity.projectId !== context.binding.projectId || requestedFresh.identity.vaultId !== context.binding.vaultId
          || requestedFresh.identity.storeId !== context.binding.storeId) throw new FreshStartError("FRESH_START_IDENTITY_MISMATCH");
        const measuredBuildHash = this.#options.trustedFreshStartBuildInspector?.();
        if (measuredBuildHash === undefined) throw new FreshStartError("FRESH_START_CONTEXT_REQUIRED");
        if (measuredBuildHash !== requestedFresh.measuredBuildHash) throw new FreshStartError("FRESH_START_BUILD_MISMATCH");
        bindFreshStartAdmissionContext(connection, { ...requestedFresh, measuredBuildHash });
      }
      const eventStore = this.#options.eventStoreFactory?.(connection, maintenance)
        ?? new EventStore(
          connection,
          new SqliteEventStoreStatements(connection),
          maintenance,
          new BranchScopeRepository(),
        );
      if (
        this.#options.lifecycleRuntimeFactory !== undefined
        && this.#options.keyProvider !== undefined
      ) {
        lifecycleRuntime = this.#options.lifecycleRuntimeFactory.create({
          connection,
          maintenanceFence: maintenance,
          keyProvider: this.#options.keyProvider,
        });
      }
      if (this.#options.retainedEvidenceRuntimeFactory !== undefined && this.#options.keyProvider !== undefined) {
        try {
          retainedEvidenceRuntime = this.#options.retainedEvidenceRuntimeFactory.create({ connection, maintenanceFence: maintenance, keyProvider: this.#options.keyProvider });
        } catch { throw new RetainedEvidenceError("RETAINED_EVIDENCE_UNAVAILABLE"); }
      }
      if (this.#options.governedNoteRuntimeFactory !== undefined && this.#options.keyProvider !== undefined) {
        try { governedNoteRuntime = this.#options.governedNoteRuntimeFactory.create({ connection, maintenanceFence: maintenance, keyProvider: this.#options.keyProvider }); }
        catch { throw new GovernedNoteError("GOVERNED_NOTE_UNAVAILABLE"); }
      }
      if(this.#options.trustedGovernedFixtureFactory!==undefined){
        if(!lifecycleRuntime||!retainedEvidenceRuntime||!governedNoteRuntime||!this.#options.keyProvider)throw new GovernedNoteError("GOVERNED_NOTE_UNAVAILABLE");
        governedFixture=this.#options.trustedGovernedFixtureFactory.create({connection,maintenanceFence:maintenance,keyProvider:this.#options.keyProvider,context,lifecycleRuntime,retainedEvidenceRuntime,governedNoteRuntime});
      }
      connection.exec("BEGIN IMMEDIATE");
      registrationBegan = true;
      assertFreshStartConnectionAllowed(connection, "command-recovery");
      let freshStart: FreshStartOpenWire | undefined;
      if (requestedFresh !== undefined) {
        const admission = new FreshStartAdmissionGuard(connection).assertRequestAllowed({ ...requestedFresh, operation: "command-recovery" });
        if (admission.generation !== requestedFresh.generation) throw new FreshStartError("FRESH_START_ADMISSION_STALE");
        freshStart = Object.freeze({ ...encodeFreshStartContextWire(requestedFresh), eventPosition: admission.eventPosition.toString(), eventHash: admission.eventHash });
      }
      maintenance.registerExecutor(
        connection,
        context.binding.projectId,
        executorId,
        context.binding.generation,
        context.binding.contextFingerprint,
        addMilliseconds(now, this.#options.executorLeaseMs),
        now,
      );
      connection.exec("COMMIT");
      registrationBegan = false;
      this.#active = {
        context,
        connection,
        maintenance,
        eventStore,
        lifecycleRuntime,
        retainedEvidenceRuntime,
        governedNoteRuntime,
        governedFixture,
        executorId,
      };
      return {
        projectId: context.binding.projectId,
        vaultId: context.binding.vaultId,
        storeId: context.binding.storeId,
        bindingGeneration: context.binding.generation,
        contextFingerprint: context.binding.contextFingerprint,
        executorId,
        ...(freshStart === undefined ? {} : { freshStart }),
      };
    } catch (error) {
      if (registrationBegan) {
        try { connection.exec("ROLLBACK"); } catch { /* preserve the first open failure */ }
      }
      try { governedFixture?.dispose(); } catch { /* Preserve open uncertainty and attempt remaining cleanup. */ }
      if (lifecycleRuntime !== null) {
        try { lifecycleRuntime.dispose(); } catch { /* preserve the first open failure */ }
      }
      try { connection.close(); } catch { /* preserve the first open failure */ }
      throw error;
    }
  }

  async executeTrustedGovernedFixtureAction(binding:WorkerBindingAssertion,action:GovernedFixtureActionV1):Promise<GovernedFixtureResultV1>{
    const owned=decodeGovernedFixtureActionV1(action),active=this.requireActive(binding);
    if(!active.governedFixture)throw new GovernedNoteError("GOVERNED_NOTE_UNAVAILABLE");
    return decodeGovernedFixtureResultV1(await active.governedFixture.execute(owned),owned);
  }

  private active(): ActiveStore {
    if (this.#active === null || this.#closed) failure("WORKER_CLOSED");
    return this.#active;
  }

  private requireActive(assertion: WorkerBindingAssertion): ActiveStore {
    const active = this.active();
    assertBinding(active.context, assertion);
    return active;
  }

  private async append(
    active: ActiveStore,
    commandWire: Extract<WorkerRequest, { type: "append" }>["command"],
  ): Promise<WorkerSuccessData> {
    const command = decodeAppendCommandWire(commandWire, active.context);
    try {
      return await retryPrimarySqliteBusy(
        () => encodeAppendResultWire(active.eventStore.append(command)),
        { deadlineMs: this.#options.appendRetryDeadlineMs },
      );
    } catch (error) {
      if (error instanceof EventStoreError && error.code === "COMMAND_OUTCOME_UNKNOWN") {
        try {
          await this.closeHandles(active);
        } catch {
          // The parent poisons and terminates this worker from the exact unknown-outcome response.
        }
      }
      throw error;
    }
  }

  private async governedNote(request: GovernedNoteWorkerRequest): Promise<WorkerSuccessData> {
    const ids = governedNoteRequestIds(request);
    let active: ActiveStore | undefined, returned = false;
    try {
      active = this.requireActive(request.binding);
      const runtime = active.governedNoteRuntime;
      if (runtime === null) throw new GovernedNoteError("GOVERNED_NOTE_UNAVAILABLE");
      const context = active.context;
      const data = request.type === "governed-note-create"
        ? encodeAppendResultWire(await retryPrimarySqliteBusy(() => {
          const result = runtime.create(decodePreparedGovernedNoteCreateV1(request.prepared), context);
          returned = true;
          return result;
        }, { deadlineMs: this.#options.appendRetryDeadlineMs }))
        : runtime.recover(decodePreparedGovernedNoteRecoveryV1(request.prepared), context);
      returned = true;
      const response = decodeGovernedNoteWorkerResponse({ id: request.id, ok: true, data }, request);
      if (!response.ok) throw new GovernedNoteError("WORKER_PROTOCOL_ERROR");
      return response.data;
    } catch (error) {
      if (active && hasUncertainGovernedRecoveryCleanup(active.connection)) {
        // Invalidate before yielding. The runtime closes this owner's transport
        // without an ordinary ACK; actual worker exit poisons its parent owner.
        this.#closed = true;
        const terminal = new GovernedNoteError("GOVERNED_NOTE_UNAVAILABLE");
        terminalGovernedReadErrors.add(terminal);
        throw terminal;
      }
      let safe = sanitizeGovernedNoteError(error, ids);
      if (request.type === "governed-note-recover" && (safe.code === "COMMAND_OUTCOME_UNKNOWN" || safe.code === "GOVERNED_NOTE_OWNERSHIP_UNCERTAIN")) safe = new GovernedNoteError("WORKER_UNAVAILABLE");
      if (request.type === "governed-note-create" && (returned || safe.code === "COMMAND_OUTCOME_UNKNOWN")) safe = new GovernedNoteError("COMMAND_OUTCOME_UNKNOWN", ids);
      if (safe.code === "COMMAND_OUTCOME_UNKNOWN" && active) {
        try { await this.closeHandles(active); } catch { /* Parent preserves original identity and poisons this owner. */ }
      }
      throw safe;
    }
  }

  private async retainEvidence(active: ActiveStore, request: Extract<WorkerRequest, { type: "retained-evidence" }>): Promise<WorkerSuccessData> {
    if (active.retainedEvidenceRuntime === null) throw new RetainedEvidenceError("RETAINED_EVIDENCE_UNAVAILABLE");
    const prepared = decodePreparedRetainedEvidenceCommand(request.prepared);
    const original = { commandId: prepared.command.commandId, idempotencyKey: prepared.command.idempotencyKey };
    let returned = false;
    try {
      const result = await retryPrimarySqliteBusy(() => {
        try { return active.retainedEvidenceRuntime!.execute(prepared, active.context); }
        catch (error) {
          // The retained service emits this code only after establishing rollback/pre-BEGIN absence.
          // Raw native busy or unknown-outcome errors never enter this retry branch.
          if (error instanceof RetainedEvidenceError && error.code === "SQLITE_BUSY") throw new EventStoreError("SQLITE_BUSY", { retryable: true });
          throw error;
        }
      }, { deadlineMs: this.#options.appendRetryDeadlineMs });
      returned = true;
      const response = decodeRetainedEvidenceWorkerResponse({ id: request.id, ok: true, data: encodeAppendResultWire(result) }, request.id, prepared);
      if (!response.ok) throw new RetainedEvidenceError("INTEGRITY_FAILURE");
      return response.data;
    } catch (error) {
      const safe = returned || (error instanceof RetainedEvidenceError && error.code === "COMMAND_OUTCOME_UNKNOWN")
        ? new RetainedEvidenceError("COMMAND_OUTCOME_UNKNOWN", original)
        : error instanceof RetainedEvidenceError ? new RetainedEvidenceError(error.code, error.details)
          : error instanceof EventStoreError && error.code === "SQLITE_BUSY" ? new RetainedEvidenceError("SQLITE_BUSY")
            : new RetainedEvidenceError("RETAINED_EVIDENCE_UNAVAILABLE");
      if (safe.code === "COMMAND_OUTCOME_UNKNOWN") {
        try { await this.closeHandles(active); } catch { /* Parent poisons and terminates on the original recovery IDs. */ }
      }
      throw safe;
    }
  }

  private async lifecycle(
    active: ActiveStore,
    request: Extract<WorkerRequest, { type: "lifecycle" }>,
  ): Promise<WorkerSuccessData> {
    try {
      if (request.operation.kind === "query") assertFreshStartConnectionAllowed(active.connection, "content-read");
      const result = await active.lifecycleRuntime!.execute(request.operation, active.context);
      const semanticUnknown = request.operation.kind === "semantic"
        && typeof result.result === "object"
        && result.result !== null
        && !Array.isArray(result.result)
        && result.result.kind === "unknown"
        && result.result.errorCode === "COMMAND_OUTCOME_UNKNOWN";
      if (semanticUnknown) {
        try { await this.closeHandles(active); } catch { /* preserve the exact unknown result */ }
      }
      return result;
    } catch (error) {
      if (
        error instanceof LifecycleError
        && (error.code === "COMMAND_OUTCOME_UNKNOWN" || error.code === "OPERATION_OUTCOME_UNKNOWN")
      ) {
        try { await this.closeHandles(active); } catch { /* preserve the exact unknown error */ }
      }
      throw error;
    }
  }

  private integrityInChild(
    active: ActiveStore,
    request: Extract<WorkerRequest, { type: "quickIntegrity" | "fullIntegrity" }>,
  ): Promise<IntegrityReport> {
    const child = (this.#options.integrityWorkerFactory
      ?? ((url: URL, options: { workerData: Record<string, unknown> }) => new Worker(url, options)))(
      this.#options.selfUrl,
      { workerData: { role: "integrity", binding: encodeWorkerBinding(active.context) } },
    );
    this.#children.add(child);
    return new Promise<IntegrityReport>((resolveReport, rejectReport) => {
      let response: IntegrityReport | undefined;
      let settled = false;
      let terminating = false;
      let providerOperationActive = false;
      const providerRequestIds = new Set<string>();
      let terminationCause: ProjectStoreWorkerBackendError | undefined;
      const rejectOnce = (error: ProjectStoreWorkerBackendError): void => {
        if (settled) return;
        settled = true;
        rejectReport(error);
      };
      const failChild = (error: ProjectStoreWorkerBackendError): void => {
        if (settled || terminating) return;
        terminating = true;
        terminationCause = error;
        void Promise.resolve()
          .then(() => child.terminate())
          .then(
            () => {
              this.#children.delete(child);
              rejectOnce(error);
            },
            () => {
              rejectOnce(this.#children.has(child) ? terminationFailure() : error);
            },
          );
      };
      const handleProviderRequest = (
        providerRequest: ReturnType<typeof decodeIntegrityProviderRequestWire>,
      ): void => {
        if (
          response !== undefined
          || providerOperationActive
          || providerRequestIds.has(providerRequest.providerRequestId)
          || providerRequest.integrityRequestId !== request.id
          || (providerRequest.operation === "fingerprint" && request.type !== "fullIntegrity")
        ) {
          if (providerRequest.operation === "fingerprint") {
            scrubProviderBytes(
              providerRequest.bytes,
              intrinsicByteLength(providerRequest.bytes),
            );
          }
          failChild(new ProjectStoreWorkerBackendError("WORKER_PROTOCOL_ERROR"));
          return;
        }
        providerRequestIds.add(providerRequest.providerRequestId);
        providerOperationActive = true;
        const expectedByteLength = providerRequest.operation === "fingerprint"
          ? intrinsicByteLength(providerRequest.bytes)
          : 0;
        const operationPromise = (async () => {
          let providerResponse: IntegrityProviderResponseWire;
          try {
            const scope = {
              projectId: active.context.binding.projectId,
              storeId: active.context.binding.storeId,
            };
            const provider = this.#options.keyProvider;
            if (provider === undefined) {
              providerResponse = {
                type: "integrity-provider-response",
                integrityRequestId: providerRequest.integrityRequestId,
                providerRequestId: providerRequest.providerRequestId,
                operation: providerRequest.operation,
                ok: false,
                code: "EVIDENCE_HISTORICAL_KEY_UNAVAILABLE",
              };
            } else if (providerRequest.operation === "status") {
              let status: unknown;
              try {
                status = await provider.status(
                  scope,
                  "evidence-fingerprint",
                  providerRequest.keyId,
                );
              } catch {
                status = undefined;
              }
              if (status === "available") {
                providerResponse = {
                  type: "integrity-provider-response",
                  integrityRequestId: providerRequest.integrityRequestId,
                  providerRequestId: providerRequest.providerRequestId,
                  operation: "status",
                  ok: true,
                  status,
                };
              } else if (status === "revoked" || status === "unavailable") {
                providerResponse = {
                  type: "integrity-provider-response",
                  integrityRequestId: providerRequest.integrityRequestId,
                  providerRequestId: providerRequest.providerRequestId,
                  operation: "status",
                  ok: false,
                  code: "EVIDENCE_HISTORICAL_KEY_UNAVAILABLE",
                };
              } else {
                providerResponse = {
                  type: "integrity-provider-response",
                  integrityRequestId: providerRequest.integrityRequestId,
                  providerRequestId: providerRequest.providerRequestId,
                  operation: "status",
                  ok: false,
                  code: "INTEGRITY_FAILURE",
                };
              }
            } else {
              let fingerprint: unknown;
              let ownershipValid = false;
              try {
                fingerprint = await provider.fingerprint({
                  ...scope,
                  purpose: "evidence-fingerprint",
                  keyId: providerRequest.keyId,
                  domain: "pm-evidence-coverage-v1",
                  bytes: providerRequest.bytes,
                });
              } catch {
                fingerprint = undefined;
              } finally {
                ownershipValid = scrubProviderBytes(
                  providerRequest.bytes,
                  expectedByteLength,
                );
              }
              providerResponse = typeof fingerprint === "string"
                && /^[0-9a-f]{64}$/.test(fingerprint)
                && ownershipValid
                ? {
                    type: "integrity-provider-response",
                    integrityRequestId: providerRequest.integrityRequestId,
                    providerRequestId: providerRequest.providerRequestId,
                    operation: "fingerprint",
                    ok: true,
                    fingerprint,
                  }
                : {
                    type: "integrity-provider-response",
                    integrityRequestId: providerRequest.integrityRequestId,
                    providerRequestId: providerRequest.providerRequestId,
                    operation: "fingerprint",
                    ok: false,
                    code: "INTEGRITY_FAILURE",
                  };
            }
            if (!settled && !terminating) child.postMessage(providerResponse);
          } catch {
            if (!settled && !terminating) {
              failChild(new ProjectStoreWorkerBackendError("WORKER_UNAVAILABLE"));
            }
          } finally {
            if (providerRequest.operation === "fingerprint") {
              scrubProviderBytes(providerRequest.bytes, expectedByteLength);
            }
            providerOperationActive = false;
          }
        })();
        void operationPromise.catch(() => {
          if (providerRequest.operation === "fingerprint") {
            scrubProviderBytes(providerRequest.bytes, expectedByteLength);
          }
          providerOperationActive = false;
          if (!settled && !terminating) {
            failChild(new ProjectStoreWorkerBackendError("WORKER_PROTOCOL_ERROR"));
          }
        });
      };
      child.on("message", (value) => {
        if (settled || terminating) return;
        try {
          if (
            typeof value === "object"
            && value !== null
            && "type" in value
            && value.type === "integrity-provider-request"
          ) {
            try {
              handleProviderRequest(decodeIntegrityProviderRequestWire(value));
            } catch {
              zeroMalformedProviderFingerprint(value);
              throw new ProjectStoreWorkerBackendError("WORKER_PROTOCOL_ERROR");
            }
            return;
          }
          if (providerOperationActive) {
            failChild(new ProjectStoreWorkerBackendError("WORKER_PROTOCOL_ERROR"));
            return;
          }
          const message = decodeWorkerMessage(value);
          if (!("id" in message) || response !== undefined) {
            return failChild(new ProjectStoreWorkerBackendError("WORKER_PROTOCOL_ERROR"));
          }
          const decoded = decodeWorkerResponseForRequest(message, request);
          if (!decoded.ok) {
            failChild(new ProjectStoreWorkerBackendError(decoded.error.code, decoded.error.details));
            return;
          }
          response = decodeIntegrityReport(decoded.data);
        } catch {
          failChild(new ProjectStoreWorkerBackendError("WORKER_PROTOCOL_ERROR"));
        }
      });
      child.on("messageerror", () => failChild(new ProjectStoreWorkerBackendError("WORKER_PROTOCOL_ERROR")));
      child.on("error", () => failChild(new ProjectStoreWorkerBackendError("WORKER_UNAVAILABLE")));
      child.on("exit", (exitCode) => {
        this.#children.delete(child);
        if (settled) return;
        if (terminating) {
          rejectOnce(terminationCause ?? new ProjectStoreWorkerBackendError("WORKER_UNAVAILABLE"));
          return;
        }
        if (exitCode !== 0 || response === undefined) {
          rejectOnce(new ProjectStoreWorkerBackendError("WORKER_UNAVAILABLE"));
          return;
        }
        settled = true;
        resolveReport(response);
      });
      try {
        child.postMessage(request);
      } catch {
        failChild(new ProjectStoreWorkerBackendError("WORKER_UNAVAILABLE"));
      }
    });
  }

  private async terminateChildren(): Promise<void> {
    const children = [...this.#children];
    const terminated = await Promise.all(children.map(async (child) => {
      try {
        await child.terminate();
        this.#children.delete(child);
        return true;
      } catch {
        return !this.#children.has(child);
      }
    }));
    if (terminated.some((proved) => !proved)) throw terminationFailure();
  }

  private async closeHandles(active: ActiveStore): Promise<void> {
    let primaryError: unknown;
    let failed = false;
    try {
      await this.terminateChildren();
    } catch (error) {
      primaryError = error;
      failed = true;
    }
    try {
      active.governedFixture?.dispose();
    } catch (error) { if(!failed){primaryError=error;failed=true;} }
    try {
      active.lifecycleRuntime?.dispose();
    } catch (error) {
      if (!failed) {
        primaryError = error;
        failed = true;
      }
    }
    try {
      active.connection.close();
    } catch (error) {
      if (!failed) {
        primaryError = error;
        failed = true;
      }
    } finally {
      this.#active = null;
      this.#closed = true;
    }
    if (failed) throw primaryError;
  }
}

export async function runIntegrityChild(
  context: ProjectContext,
  request: Extract<WorkerRequest, { type: "quickIntegrity" | "fullIntegrity" }>,
  provider?: HistoricalEvidenceIntegrityProviderPort,
): Promise<IntegrityReport> {
  const path = canonicalEventsPath(context.binding.storeRoute);
  // The child is intentionally read-only and never registers an executor lease.
  const driver = await sqliteDriver();
  const connection = driver.open(path, {
    mode: "read-only-existing",
    busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
  });
  try {
    identityFromConnection(
      connection,
      { projectId: context.binding.projectId, vaultId: context.binding.vaultId },
      context.binding.storeId,
    );
    const integrity = new EventIntegrityService(
      connection,
      PROJECT_STORE_MIGRATIONS,
      [new LifecycleIntegrityService(connection, provider)],
    );
    return request.type === "quickIntegrity"
      ? await integrity.quickCheckAsync(context, request.tailLimit)
      : await integrity.fullCheckAsync(context);
  } finally {
    connection.close();
  }
}
