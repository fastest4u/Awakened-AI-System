import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ProjectDescriptorV1,
  ProjectStoreRoute,
  StoreId,
} from "../identity/contracts.js";
import {
  GitWorkspaceResolver,
  SpawnSyncGitCommandRunner,
} from "../identity/git-workspace.resolver.js";
import { ProjectDescriptorRepository } from "../identity/project-descriptor.repository.js";
import { ProjectStoreRouter } from "../identity/project-store.router.js";
import {
  StoreManifestRepository,
  type StoreManifestIdentity,
} from "../identity/store-manifest.repository.js";
import {
  parseStoreManifest,
  type StoreManifestV1,
} from "../identity/store-manifest.schema.js";
import {
  DEFAULT_BUSY_TIMEOUT_MS,
  PROJECT_MEMORY_APPLICATION_ID,
  probeRuntimeCapabilities,
  type RuntimeCapabilityResult,
} from "../runtime/runtime-capabilities.js";
import { MigrationRunner, migrationChecksum } from "./migration-runner.js";
import { eventCoreMigration } from "./migrations/0001-event-core.js";
import { NodeSqliteDriver } from "./node-sqlite-driver.js";
import type { SqliteConnection, SqliteDriver } from "./sqlite-driver.js";

export interface ProjectStoreBootstrapInput {
  projectRoot: string;
  vaultRoot: string;
  replicaDecision?: "initialize-local";
}

export interface ProjectStoreBootstrapResult {
  descriptor: ProjectDescriptorV1;
  manifest: StoreManifestV1;
  route: ProjectStoreRoute;
  createdDescriptor: boolean;
  createdStore: boolean;
  recoveredManifest: boolean;
}

export type ProjectStoreBootstrapFaultBoundary =
  | "after-temp-schema-before-identity"
  | "after-temp-complete-before-publish"
  | "after-database-publish-before-manifest";

export interface ProjectStoreBootstrapFaultInjector {
  hit(boundary: ProjectStoreBootstrapFaultBoundary): void;
}

export const NO_PROJECT_STORE_BOOTSTRAP_FAULTS: ProjectStoreBootstrapFaultInjector = {
  hit: () => undefined,
};

export interface ProjectStoreBootstrapService {
  initialize(input: ProjectStoreBootstrapInput): Promise<ProjectStoreBootstrapResult>;
}

export type ProjectStoreBootstrapErrorCode =
  | "PROJECT_REPLICA_DECISION_REQUIRED"
  | "SCHEMA_TOO_NEW"
  | "SQLITE_CAPABILITY_MISSING"
  | "STORE_UNAVAILABLE";

export class ProjectStoreBootstrapError extends Error {
  constructor(
    readonly code: ProjectStoreBootstrapErrorCode,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "ProjectStoreBootstrapError";
  }
}

export interface ProjectStoreBootstrapDependencies {
  descriptorRepository: ProjectDescriptorRepository;
  workspaceResolver: GitWorkspaceResolver;
  router: ProjectStoreRouter;
  manifestRepository: StoreManifestRepository;
  sqliteDriver: SqliteDriver;
  migrationRunner: MigrationRunner;
  probeCapabilities: (path: string) => Promise<RuntimeCapabilityResult>;
  now: () => string;
  randomId: () => string;
  faultInjector: ProjectStoreBootstrapFaultInjector;
}

interface StoreIdentity {
  storeId: StoreId;
  schemaVersion: 1;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function cleanupSqliteFiles(path: string): void {
  unlinkIfPresent(path);
  unlinkIfPresent(`${path}-wal`);
  unlinkIfPresent(`${path}-shm`);
}

function fsyncFile(path: string): void {
  const handle = openSync(path, "r+");
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

const directoryFsyncUnsupported = new Set([
  "EINVAL",
  "EISDIR",
  "ENOTSUP",
  "EOPNOTSUPP",
  ...(process.platform === "win32" ? ["EACCES", "EBADF", "EPERM"] : []),
]);

function fsyncDirectory(path: string): void {
  let handle: number | undefined;
  try {
    handle = openSync(path, "r");
    fsyncSync(handle);
  } catch (error) {
    if (!directoryFsyncUnsupported.has(errorCode(error) ?? "")) throw error;
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

function bootstrapFailure(
  code: ProjectStoreBootstrapErrorCode,
  cause?: unknown,
): ProjectStoreBootstrapError {
  return new ProjectStoreBootstrapError(
    code,
    cause === undefined ? undefined : { cause },
  );
}

function numeric(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "bigint") return undefined;
  const converted = Number(value);
  return Number.isSafeInteger(converted) ? converted : undefined;
}

function validateExistingStore(
  path: string,
  descriptor: ProjectDescriptorV1,
  expectedStoreId?: StoreId,
): StoreIdentity {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, {
      open: true,
      readOnly: true,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
      allowBareNamedParameters: false,
      allowUnknownNamedParameters: false,
      timeout: DEFAULT_BUSY_TIMEOUT_MS,
    });

    const applicationId = numeric(
      database.prepare("PRAGMA application_id").get()?.application_id,
    );
    if (applicationId !== PROJECT_MEMORY_APPLICATION_ID) {
      throw bootstrapFailure("STORE_UNAVAILABLE");
    }
    const journalMode = database.prepare("PRAGMA journal_mode").get()?.journal_mode;
    if (String(journalMode).toLowerCase() !== "wal") {
      throw bootstrapFailure("STORE_UNAVAILABLE");
    }

    const migrations = database.prepare(`
      SELECT version, name, checksum
      FROM schema_migrations
      ORDER BY version
    `).all();
    const maximumVersion = migrations.reduce(
      (maximum, row) => Math.max(maximum, numeric(row.version) ?? Number.MAX_SAFE_INTEGER),
      0,
    );
    if (maximumVersion > eventCoreMigration.version) {
      throw bootstrapFailure("SCHEMA_TOO_NEW");
    }
    if (
      migrations.length !== 1
      || numeric(migrations[0]?.version) !== eventCoreMigration.version
      || migrations[0]?.name !== eventCoreMigration.name
      || migrations[0]?.checksum !== migrationChecksum(eventCoreMigration)
    ) {
      throw bootstrapFailure("STORE_UNAVAILABLE");
    }

    const requiredTables = [
      "branch_scopes",
      "command_dedup",
      "events",
      "executor_leases",
      "maintenance_acknowledgements",
      "maintenance_required_executors",
      "maintenance_state",
      "outbox",
      "project_meta",
      "schema_migrations",
      "streams",
      "workflow_instances",
    ];
    const requiredTriggers = [
      "command_dedup_no_delete",
      "command_dedup_no_update",
      "events_identity_guard",
      "events_no_delete",
      "events_no_update",
      "project_meta_no_delete",
      "project_meta_no_update",
      "schema_migrations_no_delete",
      "schema_migrations_no_update",
    ];
    const requiredIndexes = [
      "branch_scopes_active_ref",
      "branch_scopes_detached_head",
      "command_dedup_event_range",
      "events_project_hash_chain",
      "events_project_idempotency",
      "events_project_position",
      "events_stream_range",
      "outbox_delivery_order",
    ];
    for (const [type, names] of [
      ["table", requiredTables],
      ["trigger", requiredTriggers],
      ["index", requiredIndexes],
    ] as const) {
      const present = new Set(database.prepare(`
        SELECT name FROM sqlite_schema WHERE type = $type
      `).all({ $type: type }).map((row) => row.name));
      if (names.some((name) => !present.has(name))) {
        throw bootstrapFailure("STORE_UNAVAILABLE");
      }
    }
    const strictTables = new Map(database.prepare("PRAGMA table_list").all()
      .map((row) => [row.name, numeric(row.strict)]));
    if (requiredTables.some((name) => strictTables.get(name) !== 1)) {
      throw bootstrapFailure("STORE_UNAVAILABLE");
    }

    const rows = database.prepare(`
      SELECT project_id, vault_id, store_id, schema_version, created_at
      FROM project_meta
      WHERE singleton = 1
    `).all();
    const meta = rows[0];
    if (
      rows.length !== 1
      || meta?.project_id !== descriptor.projectId
      || meta.vault_id !== descriptor.vaultId
      || typeof meta.store_id !== "string"
      || typeof meta.created_at !== "string"
      || numeric(meta.schema_version) !== eventCoreMigration.version
      || (expectedStoreId !== undefined && meta.store_id !== expectedStoreId)
    ) {
      throw bootstrapFailure("STORE_UNAVAILABLE");
    }
    const parsedIdentity = parseStoreManifest({
      schemaVersion: 1,
      projectId: meta.project_id,
      vaultId: meta.vault_id,
      storeId: meta.store_id,
      createdAt: meta.created_at,
      lastIntegrity: { status: "never" },
    });

    const maintenance = database.prepare(`
      SELECT epoch, mode, owner_id, fencing_token, lease_expires_at, requested_at
      FROM maintenance_state WHERE singleton = 1
    `).all();
    if (
      maintenance.length !== 1
      || numeric(maintenance[0]?.epoch) !== 0
      || maintenance[0]?.mode !== "idle"
      || maintenance[0]?.owner_id !== null
      || numeric(maintenance[0]?.fencing_token) !== 0
      || maintenance[0]?.lease_expires_at !== null
      || maintenance[0]?.requested_at !== null
    ) {
      throw bootstrapFailure("STORE_UNAVAILABLE");
    }

    if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) {
      throw bootstrapFailure("STORE_UNAVAILABLE");
    }
    const integrityRows = database.prepare("PRAGMA integrity_check").all();
    if (
      integrityRows.length === 0
      || integrityRows.some((row) => row.integrity_check !== "ok")
    ) {
      throw bootstrapFailure("STORE_UNAVAILABLE");
    }
    return {
      storeId: parsedIdentity.storeId,
      schemaVersion: 1,
    };
  } catch (error) {
    if (error instanceof ProjectStoreBootstrapError) throw error;
    throw bootstrapFailure("STORE_UNAVAILABLE", error);
  } finally {
    database?.close();
  }
}

function insertBootstrapIdentity(
  connection: SqliteConnection,
  descriptor: ProjectDescriptorV1,
  storeId: StoreId,
  createdAt: string,
): void {
  connection.exec("BEGIN IMMEDIATE");
  try {
    connection.prepare(`
      INSERT INTO project_meta(
        singleton, project_id, vault_id, store_id, schema_version, created_at
      ) VALUES (1, $projectId, $vaultId, $storeId, 1, $createdAt)
    `).run({
      $projectId: descriptor.projectId,
      $vaultId: descriptor.vaultId,
      $storeId: storeId,
      $createdAt: createdAt,
    });
    connection.exec(`
      INSERT INTO maintenance_state(
        singleton, epoch, mode, owner_id, fencing_token, lease_expires_at, requested_at
      ) VALUES (1, 0, 'idle', NULL, 0, NULL, NULL)
    `);
    connection.exec("COMMIT");
  } catch (error) {
    try { connection.exec("ROLLBACK"); } catch { /* preserve original */ }
    throw error;
  }
}

function manifestIdentity(
  descriptor: ProjectDescriptorV1,
  storeId: StoreId,
): StoreManifestIdentity {
  return {
    projectId: descriptor.projectId,
    vaultId: descriptor.vaultId,
    storeId,
  };
}

export class DefaultProjectStoreBootstrapService implements ProjectStoreBootstrapService {
  static readonly #activeInitializations = new Map<
    string,
    Promise<ProjectStoreBootstrapResult>
  >();

  readonly #dependencies: ProjectStoreBootstrapDependencies;

  constructor(dependencies: Partial<ProjectStoreBootstrapDependencies> = {}) {
    this.#dependencies = {
      descriptorRepository: dependencies.descriptorRepository
        ?? new ProjectDescriptorRepository(),
      workspaceResolver: dependencies.workspaceResolver
        ?? new GitWorkspaceResolver(new SpawnSyncGitCommandRunner()),
      router: dependencies.router ?? new ProjectStoreRouter(),
      manifestRepository: dependencies.manifestRepository
        ?? new StoreManifestRepository(),
      sqliteDriver: dependencies.sqliteDriver
        ?? new NodeSqliteDriver({ DatabaseSync }),
      migrationRunner: dependencies.migrationRunner ?? new MigrationRunner(),
      probeCapabilities: dependencies.probeCapabilities ?? probeRuntimeCapabilities,
      now: dependencies.now ?? (() => new Date().toISOString()),
      randomId: dependencies.randomId ?? randomUUID,
      faultInjector: dependencies.faultInjector
        ?? NO_PROJECT_STORE_BOOTSTRAP_FAULTS,
    };
  }

  async initialize(
    input: ProjectStoreBootstrapInput,
  ): Promise<ProjectStoreBootstrapResult> {
    const initial = this.#dependencies.descriptorRepository.inspect(input.vaultRoot);
    if (initial.status === "invalid") throw bootstrapFailure("STORE_UNAVAILABLE");

    let descriptor: ProjectDescriptorV1;
    let createdDescriptor = false;
    const initializationWasRequestedWithoutDescriptor = initial.status === "missing";
    if (initial.status === "valid") {
      descriptor = initial.descriptor;
    } else {
      try {
        descriptor = this.#dependencies.descriptorRepository.createExplicit(
          input.projectRoot,
          input.vaultRoot,
        );
        createdDescriptor = true;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("PROJECT_DESCRIPTOR_EXISTS")) {
          throw error;
        }
        const winner = this.#dependencies.descriptorRepository.inspect(input.vaultRoot);
        if (winner.status !== "valid") throw bootstrapFailure("STORE_UNAVAILABLE", error);
        descriptor = winner.descriptor;
      }
    }

    const workspace = this.#dependencies.workspaceResolver.inspect(
      input.projectRoot,
      descriptor,
    );
    const route = this.#dependencies.router.route(descriptor, input.vaultRoot, workspace);
    const manifestInspection = this.#dependencies.manifestRepository.inspect(route, {
      projectId: descriptor.projectId,
      vaultId: descriptor.vaultId,
    });
    const databaseExists = existsSync(route.eventsPath);

    if (manifestInspection.status === "invalid") {
      throw bootstrapFailure("STORE_UNAVAILABLE");
    }
    if (manifestInspection.status === "valid") {
      if (!databaseExists) throw bootstrapFailure("STORE_UNAVAILABLE");
      validateExistingStore(
        route.eventsPath,
        descriptor,
        manifestInspection.manifest.storeId,
      );
      return {
        descriptor,
        manifest: manifestInspection.manifest,
        route,
        createdDescriptor,
        createdStore: false,
        recoveredManifest: false,
      };
    }

    if (databaseExists) {
      const identity = validateExistingStore(route.eventsPath, descriptor);
      const manifest = this.publishOrAdoptManifest(route, descriptor, identity.storeId);
      return {
        descriptor,
        manifest,
        route,
        createdDescriptor,
        createdStore: false,
        recoveredManifest: true,
      };
    }

    if (
      !initializationWasRequestedWithoutDescriptor
      && input.replicaDecision !== "initialize-local"
    ) {
      const active = DefaultProjectStoreBootstrapService.#activeInitializations.get(
        route.eventsPath,
      );
      if (active !== undefined) {
        await active;
        return this.initialize(input);
      }
      throw bootstrapFailure("PROJECT_REPLICA_DECISION_REQUIRED");
    }

    const active = DefaultProjectStoreBootstrapService.#activeInitializations.get(
      route.eventsPath,
    );
    if (active !== undefined) {
      await active;
      return this.initialize(input);
    }
    const initialization = this.createStore(descriptor, route, createdDescriptor);
    DefaultProjectStoreBootstrapService.#activeInitializations.set(
      route.eventsPath,
      initialization,
    );
    try {
      return await initialization;
    } finally {
      if (
        DefaultProjectStoreBootstrapService.#activeInitializations.get(route.eventsPath)
        === initialization
      ) {
        DefaultProjectStoreBootstrapService.#activeInitializations.delete(route.eventsPath);
      }
    }
  }

  private async createStore(
    descriptor: ProjectDescriptorV1,
    route: ProjectStoreRoute,
    createdDescriptor: boolean,
  ): Promise<ProjectStoreBootstrapResult> {
    mkdirSync(route.storeRoot, { recursive: true });
    const capabilityPath = join(
      route.storeRoot,
      `.events.sqlite.capability-${this.#dependencies.randomId()}.tmp`,
    );
    let capability: RuntimeCapabilityResult;
    try {
      try {
        capability = await this.#dependencies.probeCapabilities(capabilityPath);
      } catch (error) {
        throw bootstrapFailure("SQLITE_CAPABILITY_MISSING", error);
      }
    } finally {
      cleanupSqliteFiles(capabilityPath);
    }
    if (!capability.ok) {
      throw bootstrapFailure("SQLITE_CAPABILITY_MISSING");
    }

    const storeId = this.#dependencies.randomId() as StoreId;
    const temporaryPath = join(
      route.storeRoot,
      `.events.sqlite.bootstrap-${this.#dependencies.randomId()}.tmp`,
    );
    let connection: SqliteConnection | undefined;
    let publishedByThisContender = false;
    try {
      const reservation = openSync(temporaryPath, "wx", 0o600);
      closeSync(reservation);
      connection = this.#dependencies.sqliteDriver.open(temporaryPath, {
        mode: "create",
        busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
      });
      this.#dependencies.migrationRunner.apply(
        connection,
        [eventCoreMigration],
        this.#dependencies.now(),
      );
      this.#dependencies.faultInjector.hit("after-temp-schema-before-identity");
      insertBootstrapIdentity(
        connection,
        descriptor,
        storeId,
        this.#dependencies.now(),
      );
      this.#dependencies.faultInjector.hit("after-temp-complete-before-publish");
      const checkpoint = connection.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      const checkpointBusy = numeric(checkpoint?.busy);
      const checkpointLog = numeric(checkpoint?.log);
      const checkpointed = numeric(checkpoint?.checkpointed);
      if (
        checkpointBusy !== 0
        || checkpointLog === undefined
        || checkpointed === undefined
        || (checkpointLog !== 0 && checkpointed !== checkpointLog)
      ) {
        throw bootstrapFailure("STORE_UNAVAILABLE");
      }
      connection.close();
      connection = undefined;

      validateExistingStore(temporaryPath, descriptor, storeId);
      fsyncFile(temporaryPath);
      try {
        linkSync(temporaryPath, route.eventsPath);
        publishedByThisContender = true;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
      unlinkIfPresent(temporaryPath);

      const winningIdentity = validateExistingStore(route.eventsPath, descriptor);
      fsyncFile(route.eventsPath);
      fsyncDirectory(dirname(route.eventsPath));
      this.#dependencies.faultInjector.hit("after-database-publish-before-manifest");
      const manifest = this.publishOrAdoptManifest(
        route,
        descriptor,
        winningIdentity.storeId,
      );
      return {
        descriptor,
        manifest,
        route,
        createdDescriptor,
        createdStore: publishedByThisContender,
        recoveredManifest: false,
      };
    } finally {
      try { connection?.close(); } catch { /* cleanup continues */ }
      cleanupSqliteFiles(temporaryPath);
    }
  }

  private publishOrAdoptManifest(
    route: ProjectStoreRoute,
    descriptor: ProjectDescriptorV1,
    storeId: StoreId,
  ): StoreManifestV1 {
    try {
      return this.#dependencies.manifestRepository.createExplicit(
        route,
        manifestIdentity(descriptor, storeId),
      );
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("STORE_MANIFEST_EXISTS")) {
        throw error;
      }
      const winner = this.#dependencies.manifestRepository.inspect(route, {
        projectId: descriptor.projectId,
        vaultId: descriptor.vaultId,
        storeId,
      });
      if (winner.status !== "valid") throw bootstrapFailure("STORE_UNAVAILABLE", error);
      return winner.manifest;
    }
  }
}
