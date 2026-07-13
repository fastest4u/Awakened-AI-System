import { randomUUID } from "node:crypto";
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
import type { IntegrityReport } from "../integrity/integrity.types.js";
import { BranchScopeRepository } from "../storage/branch-scope.repository.js";
import {
  EventStore,
  EventStoreError,
  SqliteEventStoreStatements,
} from "../storage/event-store.js";
import { MaintenanceFence } from "../storage/maintenance-fence.js";
import { eventCoreMigration } from "../storage/migrations/0001-event-core.js";
import { migrationChecksum } from "../storage/migration-runner.js";
import { NodeSqliteDriver } from "../storage/node-sqlite-driver.js";
import {
  expectedSchemaFingerprint,
  schemaFingerprint,
  type SchemaQueryConnection,
} from "../storage/schema-fingerprint.js";
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
import {
  decodeAppendCommandWire,
  decodeIntegrityReport,
  decodeMaintenanceLeaseWire,
  decodeWorkerBinding,
  decodeWorkerMessage,
  decodeWorkerResponseForRequest,
  encodeAppendResultWire,
  encodeMaintenanceLeaseWire,
  encodeWorkerBinding,
  type MaintenanceLeaseWire,
  type ProjectStoreRouteWire,
  type StoreIdentityExpectationWire,
  type StoreIdentityWire,
  type WorkerBindingAssertion,
  type WorkerRequest,
  type WorkerSuccessData,
} from "./worker-protocol.js";

const POSITIVE_SAFE_INTEGER = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

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
  selfUrl: URL;
  executorLeaseMs: number;
  appendRetryDeadlineMs: number;
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

  const migrations = connection.prepare(`
    SELECT version, name, checksum
    FROM schema_migrations
    ORDER BY version
  `).all();
  if (
    migrations.length !== 1
    || number(migrations[0]?.version) !== eventCoreMigration.version
    || migrations[0]?.name !== eventCoreMigration.name
    || migrations[0]?.checksum !== migrationChecksum(eventCoreMigration)
  ) {
    failure("MIGRATION_CHECKSUM_MISMATCH");
  }
  if (
    schemaFingerprint(connection as unknown as SchemaQueryConnection)
    !== expectedSchemaFingerprint([eventCoreMigration])
  ) {
    failure("SCHEMA_FINGERPRINT_MISMATCH");
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
  path: string;
  connection: SqliteConnection;
  maintenance: MaintenanceFence;
  eventStore: EventStore;
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
        return this.open(request.binding);
      case "append": {
        const active = this.requireActive(request.binding);
        return this.append(active, request.command);
      }
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
    const now = new Date().toISOString();
    let primaryError: unknown;
    let failed = false;
    try {
      active.connection.exec("BEGIN IMMEDIATE");
      active.maintenance.acknowledge(active.connection, lease, active.executorId, now);
      active.maintenance.closeExecutor(
        active.connection,
        active.context.binding.projectId,
        active.executorId,
        now,
      );
      active.connection.exec("COMMIT");
    } catch (error) {
      try { active.connection.exec("ROLLBACK"); } catch { /* preserve fence failure */ }
      primaryError = error;
      failed = true;
    }
    try {
      await this.closeHandles(active, false);
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
    if (this.#closed) return;
    const active = this.#active;
    if (active === null) {
      this.#closed = true;
      await this.terminateChildren();
      return;
    }
    await this.closeHandles(active, true);
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

  private async open(binding: unknown): Promise<WorkerSuccessData> {
    if (this.#active !== null || this.#closed) failure("PROJECT_BINDING_REQUIRED");
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
    const maintenance = this.#options.maintenanceFactory?.() ?? new MaintenanceFence();
    const executorId = randomUUID();
    const now = new Date().toISOString();
    try {
      identityFromConnection(
        connection,
        { projectId: context.binding.projectId, vaultId: context.binding.vaultId },
        context.binding.storeId,
      );
      const eventStore = this.#options.eventStoreFactory?.(connection, maintenance)
        ?? new EventStore(
          connection,
          new SqliteEventStoreStatements(connection),
          maintenance,
          new BranchScopeRepository(),
        );
      connection.exec("BEGIN IMMEDIATE");
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
      this.#active = {
        context,
        path,
        connection,
        maintenance,
        eventStore,
        executorId,
      };
    } catch (error) {
      try { connection.exec("ROLLBACK"); } catch { /* transaction may not have begun */ }
      connection.close();
      throw error;
    }
    return {
      projectId: context.binding.projectId,
      vaultId: context.binding.vaultId,
      storeId: context.binding.storeId,
      bindingGeneration: context.binding.generation,
      contextFingerprint: context.binding.contextFingerprint,
      executorId,
    };
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
    return retryPrimarySqliteBusy(
      () => encodeAppendResultWire(active.eventStore.append(command)),
      { deadlineMs: this.#options.appendRetryDeadlineMs },
    );
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
      const failChild = (error: ProjectStoreWorkerBackendError): void => {
        if (settled || terminating) return;
        terminating = true;
        void child.terminate().catch(() => undefined).then(() => {
          this.#children.delete(child);
          if (settled) return;
          settled = true;
          rejectReport(error);
        });
      };
      child.on("message", (value) => {
        if (settled || terminating) return;
        try {
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
        if (settled || terminating) return;
        if (exitCode !== 0 || response === undefined) {
          settled = true;
          rejectReport(new ProjectStoreWorkerBackendError("WORKER_UNAVAILABLE"));
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
    this.#children.clear();
    await Promise.allSettled(children.map(async (child) => child.terminate()));
  }

  private async closeHandles(active: ActiveStore, markLeaseClosed: boolean): Promise<void> {
    await this.terminateChildren();
    let primaryError: unknown;
    let failed = false;
    if (markLeaseClosed) {
      const now = new Date().toISOString();
      try {
        active.connection.exec("BEGIN IMMEDIATE");
        active.maintenance.closeExecutor(
          active.connection,
          active.context.binding.projectId,
          active.executorId,
          now,
        );
        active.connection.exec("COMMIT");
      } catch (error) {
        try { active.connection.exec("ROLLBACK"); } catch { /* preserve close failure */ }
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
    const integrity = new EventIntegrityService(connection);
    return request.type === "quickIntegrity"
      ? integrity.quickCheck(context, request.tailLimit)
      : integrity.fullCheck(context);
  } finally {
    connection.close();
  }
}
