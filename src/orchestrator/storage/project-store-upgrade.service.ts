import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { ProjectContext } from "../identity/contracts.js";
import { StoreManifestRepository } from "../identity/store-manifest.repository.js";
import { EventIntegrityService } from "../integrity/event-integrity.service.js";
import type { IntegrityReport } from "../integrity/integrity.types.js";
import type { MaintenanceClosureConfirmation } from "../runtime/project-store-executor.js";
import { ProjectStoreUpgradePhaseRunner } from "../runtime/project-store-upgrade-phase-runner.js";
import { DEFAULT_BUSY_TIMEOUT_MS } from "../runtime/runtime-capabilities.js";
import { MaintenanceFence, type MaintenanceLease } from "./maintenance-fence.js";
import { MigrationRunner } from "./migration-runner.js";
import { PROJECT_STORE_MIGRATIONS } from "./migrations/registry.js";
import { NodeSqliteDriver } from "./node-sqlite-driver.js";
import { inspectStoreSchema } from "./schema-compatibility.js";
import type { SqliteConnection, SqliteDriver, SqliteRow } from "./sqlite-driver.js";

export interface ProjectStoreUpgradePlan {
  projectId: string;
  storeId: string;
  appliedVersion: number;
  targetVersion: number;
  pending: readonly { version: number; name: string; checksum: string }[];
  status: "current" | "upgrade-required";
}

export interface ProjectStoreUpgradeResult {
  plan: ProjectStoreUpgradePlan;
  appliedVersions: readonly number[];
  resumedPostCommit: boolean;
  integrity: IntegrityReport;
}

export type ProjectStoreUpgradeFaultBoundary =
  | "after-fence-before-prefix-integrity"
  | "after-0002-ddl-before-migration-row"
  | "after-migration-row-before-project-version"
  | "after-project-version-before-commit"
  | "after-commit-before-full-integrity"
  | "after-full-integrity-before-manifest-record"
  | "after-manifest-record-before-fence-release";

export interface ProjectStoreUpgradeFaultInjector {
  hit(boundary: ProjectStoreUpgradeFaultBoundary): void;
}

export const NO_PROJECT_STORE_UPGRADE_FAULTS: ProjectStoreUpgradeFaultInjector = {
  hit: () => undefined,
};

export interface UpgradeExecutorRegistry {
  quiesceStore(context: ProjectContext, lease: MaintenanceLease): Promise<void>;
}

export interface UpgradeIntegrityManifestRecorder {
  record(
    context: ProjectContext,
    report: IntegrityReport,
    signal?: AbortSignal,
  ): void | Promise<void>;
}

export interface UpgradePostCommitIntegrityRunner {
  run(context: ProjectContext, signal: AbortSignal): Promise<IntegrityReport>;
}

export interface UpgradeLeaseScheduler {
  setTimeout(callback: () => void, milliseconds: number): object;
  clearTimeout(handle: object): void;
}

export interface ProjectStoreUpgradeServiceDependencies {
  sqliteDriver?: SqliteDriver;
  maintenanceFence?: MaintenanceFence;
  migrationRunner?: MigrationRunner;
  executorRegistry?: UpgradeExecutorRegistry;
  manifestRepository?: StoreManifestRepository;
  manifestRecorder?: UpgradeIntegrityManifestRecorder;
  postCommitIntegrityRunner?: UpgradePostCommitIntegrityRunner;
  upgradePhaseWorkerUrl?: URL;
  now?: () => string;
  randomId?: () => string;
  trustedTtlMs?: number;
  leaseHeartbeatMs?: number;
  leaseScheduler?: UpgradeLeaseScheduler;
  acquireRetryMs?: number;
  maximumAcquireAttempts?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  faultInjector?: ProjectStoreUpgradeFaultInjector;
}

interface ActiveOwner {
  context: ProjectContext;
  connection: SqliteConnection;
  lease: MaintenanceLease;
}

export class ProjectStoreUpgradeError extends Error {
  constructor(
    readonly code: string,
    readonly details: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "ProjectStoreUpgradeError";
  }
}

const NO_EXECUTORS: UpgradeExecutorRegistry = {
  async quiesceStore() { /* no process-local executors */ },
};

function fail(
  code: string,
  details: Record<string, unknown> = {},
  cause?: unknown,
): never {
  throw new ProjectStoreUpgradeError(
    code,
    details,
    cause === undefined ? undefined : { cause },
  );
}

function positiveInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) fail(code);
  return Number(value);
}

function timestamp(value: string, code: string): number {
  const instant = new Date(value).getTime();
  if (!Number.isFinite(instant)) fail(code);
  return instant;
}

function addMilliseconds(value: string, milliseconds: number): string {
  return new Date(timestamp(value, "MAINTENANCE_TIMESTAMP_INVALID") + milliseconds).toISOString();
}

function canonicalEventsPath(context: ProjectContext): string {
  try {
    const requested = resolve(context.binding.storeRoute.eventsPath);
    const canonical = resolve(realpathSync.native(requested));
    if (!statSync(canonical).isFile()) fail("STORE_UNAVAILABLE");
    const same = process.platform === "win32"
      ? requested.toLowerCase() === canonical.toLowerCase()
      : requested === canonical;
    if (!same) fail("STORE_ROUTE_INVALID");
    return canonical;
  } catch (error) {
    if (error instanceof ProjectStoreUpgradeError) throw error;
    fail("STORE_UNAVAILABLE", {}, error);
  }
}

function requiredString(row: SqliteRow | undefined, key: string): string {
  const value = row?.[key];
  if (typeof value !== "string" || value.length === 0) fail("STORE_UNAVAILABLE");
  return value;
}

function sameLease(left: MaintenanceLease, right: MaintenanceLease): boolean {
  return left.epoch === right.epoch
    && left.fencingToken === right.fencingToken
    && left.ownerId === right.ownerId
    && left.leaseExpiresAt === right.leaseExpiresAt;
}

function transaction<T>(connection: SqliteConnection, operation: () => T): T {
  connection.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    connection.exec("COMMIT");
    return result;
  } catch (error) {
    try { connection.exec("ROLLBACK"); } catch { /* preserve original */ }
    throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  try {
    return typeof error === "object" && error !== null && "code" in error
      ? String(Reflect.get(error, "code"))
      : undefined;
  } catch {
    return undefined;
  }
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

export class ProjectStoreUpgradeService {
  readonly #driver: Promise<SqliteDriver>;
  readonly #fence: MaintenanceFence;
  readonly #migrationRunner: MigrationRunner;
  readonly #registry: UpgradeExecutorRegistry;
  readonly #manifestRecorder: UpgradeIntegrityManifestRecorder;
  readonly #postCommitIntegrityRunner: UpgradePostCommitIntegrityRunner;
  readonly #now: () => string;
  readonly #randomId: () => string;
  readonly #trustedTtlMs: number;
  readonly #leaseHeartbeatMs: number;
  readonly #leaseScheduler: UpgradeLeaseScheduler;
  readonly #acquireRetryMs: number;
  readonly #maximumAcquireAttempts: number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #faults: ProjectStoreUpgradeFaultInjector;
  readonly #owners = new Map<string, ActiveOwner>();

  constructor(dependencies: ProjectStoreUpgradeServiceDependencies = {}) {
    this.#driver = dependencies.sqliteDriver === undefined
      ? import("node:sqlite").then((sqlite) => new NodeSqliteDriver(sqlite))
      : Promise.resolve(dependencies.sqliteDriver);
    this.#fence = dependencies.maintenanceFence ?? new MaintenanceFence();
    this.#migrationRunner = dependencies.migrationRunner ?? new MigrationRunner();
    this.#registry = dependencies.executorRegistry ?? NO_EXECUTORS;
    const phaseRunner = new ProjectStoreUpgradePhaseRunner(
      dependencies.upgradePhaseWorkerUrl === undefined
        ? {}
        : { workerUrl: dependencies.upgradePhaseWorkerUrl },
    );
    const manifestRepository = dependencies.manifestRepository;
    this.#manifestRecorder = dependencies.manifestRecorder
      ?? (manifestRepository === undefined
        ? {
            record: (context, report, signal) => phaseRunner.recordManifest(
              context,
              report,
              signal ?? new AbortController().signal,
            ),
          }
        : {
            record(context, report) {
              manifestRepository.recordIntegrity(context.binding.storeRoute, {
                projectId: context.binding.projectId,
                vaultId: context.binding.vaultId,
                storeId: context.binding.storeId,
              }, {
                ok: report.ok,
                schemaFingerprint: report.schemaFingerprint,
                terminalEventHash: report.terminalEventHash,
              });
            },
          });
    this.#postCommitIntegrityRunner = dependencies.postCommitIntegrityRunner ?? {
      run: (context, signal) => phaseRunner.fullIntegrity(context, signal),
    };
    this.#now = dependencies.now ?? (() => new Date().toISOString());
    this.#randomId = dependencies.randomId ?? randomUUID;
    this.#trustedTtlMs = positiveInteger(
      dependencies.trustedTtlMs ?? 60_000,
      "MAINTENANCE_LEASE_INVALID",
    );
    this.#leaseHeartbeatMs = positiveInteger(
      dependencies.leaseHeartbeatMs ?? Math.max(1, Math.floor(this.#trustedTtlMs / 3)),
      "MAINTENANCE_LEASE_INVALID",
    );
    if (this.#leaseHeartbeatMs >= this.#trustedTtlMs) fail("MAINTENANCE_LEASE_INVALID");
    this.#leaseScheduler = dependencies.leaseScheduler ?? {
      setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    };
    this.#acquireRetryMs = positiveInteger(
      dependencies.acquireRetryMs ?? 5,
      "MAINTENANCE_LEASE_INVALID",
    );
    this.#maximumAcquireAttempts = positiveInteger(
      dependencies.maximumAcquireAttempts ?? 2_000,
      "MAINTENANCE_LEASE_INVALID",
    );
    this.#sleep = dependencies.sleep ?? defaultSleep;
    this.#faults = dependencies.faultInjector ?? NO_PROJECT_STORE_UPGRADE_FAULTS;
  }

  async inspect(context: ProjectContext): Promise<ProjectStoreUpgradePlan> {
    const path = canonicalEventsPath(context);
    const driver = await this.#driver;
    const connection = driver.open(path, {
      mode: "read-only-existing",
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    });
    try {
      return this.inspectConnection(connection, context);
    } finally {
      connection.close();
    }
  }

  async apply(context: ProjectContext): Promise<ProjectStoreUpgradeResult> {
    const initialPlan = await this.inspect(context);
    const path = canonicalEventsPath(context);
    const driver = await this.#driver;
    const connection = driver.open(path, {
      mode: "existing",
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    });
    const ownerKey = this.ownerKey(context);
    let active: ActiveOwner | undefined;
    let primaryError: unknown;
    try {
      const lease = await this.acquireOwner(connection);
      active = { context, connection, lease };
      if (this.#owners.has(ownerKey)) fail("MAINTENANCE_ALREADY_ACTIVE");
      this.#owners.set(ownerKey, active);

      await this.#registry.quiesceStore(context, active.lease);
      active.lease = this.renewReady(active);

      let lockedPlan = this.inspectConnection(connection, context);
      let appliedVersions: readonly number[] = [];
      if (lockedPlan.status === "upgrade-required") {
        this.#faults.hit("after-fence-before-prefix-integrity");
        const prefixIntegrity = new EventIntegrityService(
          connection,
          PROJECT_STORE_MIGRATIONS.slice(0, lockedPlan.appliedVersion),
        ).fullCheck(context);
        if (!prefixIntegrity.ok) {
          fail("PREFIX_INTEGRITY_FAILED", { issues: prefixIntegrity.issues });
        }
        active.lease = this.renewReady(active);
        lockedPlan = this.inspectConnection(connection, context);
        if (lockedPlan.status === "upgrade-required") {
          const targetVersion = PROJECT_STORE_MIGRATIONS.at(-1)?.version;
          let liveLease = active.lease;
          appliedVersions = this.#migrationRunner.apply(
            connection,
            PROJECT_STORE_MIGRATIONS,
            this.#now(),
            {
              kind: "explicit-upgrade",
              expectedAppliedVersion: lockedPlan.appliedVersion,
              renewMutableBoundary: () => {
                liveLease = this.#fence.renewOwner(
                  connection,
                  liveLease,
                  this.#now(),
                  this.#trustedTtlMs,
                );
                this.#fence.assertReady(connection, liveLease, this.#now());
              },
              faultInjector: {
                hit: (boundary, migration) => {
                  if (migration.version !== targetVersion) return;
                  if (boundary === "after-ddl-before-migration-row") {
                    this.#faults.hit("after-0002-ddl-before-migration-row");
                  } else if (boundary === "after-migration-row-before-project-version") {
                    this.#faults.hit("after-migration-row-before-project-version");
                  } else {
                    this.#faults.hit("after-project-version-before-commit");
                  }
                },
              },
            },
          );
          active.lease = liveLease;
          this.#faults.hit("after-commit-before-full-integrity");
        }
      }

      active.lease = this.renewReady(active);
      const currentPlan = this.inspectConnection(connection, context);
      if (currentPlan.status !== "current") fail("SCHEMA_UPGRADE_REQUIRED");
      const integrity = await this.guardedPhase(
        active,
        (signal) => this.#postCommitIntegrityRunner.run(context, signal),
      );
      if (!integrity.ok) fail("POST_UPGRADE_INTEGRITY_FAILED", { issues: integrity.issues });
      this.#faults.hit("after-full-integrity-before-manifest-record");

      active.lease = this.renewReady(active);
      await this.guardedPhase(
        active,
        async (signal) => this.#manifestRecorder.record(context, integrity, signal),
      );
      this.#faults.hit("after-manifest-record-before-fence-release");

      transaction(connection, () => {
        active!.lease = this.#fence.renewOwner(
          connection,
          active!.lease,
          this.#now(),
          this.#trustedTtlMs,
        );
        this.#fence.assertReady(connection, active!.lease, this.#now());
        this.#fence.release(connection, active!.lease, true, this.#now());
      });
      return {
        plan: lockedPlan,
        appliedVersions,
        resumedPostCommit: initialPlan.status === "current",
        integrity,
      };
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      if (this.#owners.get(ownerKey) === active) this.#owners.delete(ownerKey);
      try {
        connection.close();
      } catch (closeError) {
        if (primaryError === undefined) throw closeError;
      }
    }
  }

  async confirmMaintenanceClosure(
    confirmation: MaintenanceClosureConfirmation,
  ): Promise<void> {
    const active = [...this.#owners.values()].find((candidate) => (
      candidate.context.binding.projectId === confirmation.projectId
      && sameLease(candidate.lease, confirmation.lease)
    ));
    if (active === undefined || confirmation.connectionClosed !== true) {
      fail("MAINTENANCE_CONFIRMATION_FAILED");
    }
    transaction(active.connection, () => {
      this.#fence.confirmExecutorClosed(
        active.connection,
        active.lease,
        active.context.binding.projectId,
        confirmation.executorId,
        this.#now(),
      );
    });
  }

  private ownerKey(context: ProjectContext): string {
    return `${context.binding.projectId}\u0000${context.binding.storeId}`;
  }

  private async acquireOwner(connection: SqliteConnection): Promise<MaintenanceLease> {
    const ownerId = this.#randomId();
    if (typeof ownerId !== "string" || ownerId.trim().length === 0) {
      fail("MAINTENANCE_LEASE_INVALID");
    }
    for (let attempt = 0; attempt < this.#maximumAcquireAttempts; attempt += 1) {
      const now = this.#now();
      try {
        return transaction(connection, () => this.#fence.acquire(
          connection,
          ownerId,
          addMilliseconds(now, this.#trustedTtlMs),
          now,
        ));
      } catch (error) {
        if (errorCode(error) !== "MAINTENANCE_ALREADY_ACTIVE") throw error;
        if (attempt + 1 === this.#maximumAcquireAttempts) throw error;
        await this.#sleep(this.#acquireRetryMs);
      }
    }
    fail("MAINTENANCE_ALREADY_ACTIVE");
  }

  private renewReady(active: ActiveOwner): MaintenanceLease {
    return transaction(active.connection, () => {
      const renewed = this.#fence.renewOwner(
        active.connection,
        active.lease,
        this.#now(),
        this.#trustedTtlMs,
      );
      this.#fence.assertReady(active.connection, renewed, this.#now());
      return renewed;
    });
  }

  private async guardedPhase<T>(
    active: ActiveOwner,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let timer: object | undefined;
    let stopped = false;
    let rejectHeartbeat!: (error: unknown) => void;
    const heartbeatFailure = new Promise<never>((_resolve, reject) => {
      rejectHeartbeat = reject;
    });
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) this.#leaseScheduler.clearTimeout(timer);
      timer = undefined;
    };
    const schedule = (): void => {
      timer = this.#leaseScheduler.setTimeout(() => {
        timer = undefined;
        if (stopped) return;
        try {
          active.lease = this.renewReady(active);
          schedule();
        } catch (error) {
          stop();
          controller.abort(error);
          rejectHeartbeat(error);
        }
      }, this.#leaseHeartbeatMs);
    };
    schedule();
    const phase = Promise.resolve().then(() => operation(controller.signal));
    void phase.catch(() => undefined);
    try {
      return await Promise.race([phase, heartbeatFailure]);
    } finally {
      stop();
    }
  }

  private inspectConnection(
    connection: SqliteConnection,
    context: ProjectContext,
  ): ProjectStoreUpgradePlan {
    const inspection = inspectStoreSchema(connection, PROJECT_STORE_MIGRATIONS);
    const rows = connection.prepare(`
      SELECT project_id, vault_id, store_id
      FROM project_meta WHERE singleton = 1
    `).all();
    if (rows.length !== 1) fail("STORE_UNAVAILABLE");
    const projectId = requiredString(rows[0], "project_id");
    const vaultId = requiredString(rows[0], "vault_id");
    const storeId = requiredString(rows[0], "store_id");
    if (projectId !== context.binding.projectId) fail("PROJECT_ID_MISMATCH");
    if (vaultId !== context.binding.vaultId) fail("VAULT_ID_MISMATCH");
    if (storeId !== context.binding.storeId) fail("STORE_ID_MISMATCH");
    return Object.freeze({
      projectId,
      storeId,
      appliedVersion: inspection.appliedVersion,
      targetVersion: inspection.targetVersion,
      pending: inspection.pending,
      status: inspection.status,
    });
  }
}
