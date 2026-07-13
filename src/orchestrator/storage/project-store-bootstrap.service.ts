import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  ProjectDescriptorV1,
  ProjectStoreRoute,
  StoreId,
} from "../identity/contracts.js";
import {
  createDirectoryDurably,
  fsyncDirectory,
  type DirectorySync,
} from "../identity/directory-durability.js";
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
import {
  expectedSchemaFingerprint,
  schemaFingerprint,
  type SchemaQueryConnection,
} from "./schema-fingerprint.js";
import type { SqliteConnection, SqliteDriver } from "./sqlite-driver.js";

type DatabaseSyncConstructor = typeof import("node:sqlite").DatabaseSync;
type NodeSqliteModule = Pick<typeof import("node:sqlite"), "DatabaseSync">;

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
  sqliteDriver?: SqliteDriver;
  loadNodeSqlite: () => Promise<NodeSqliteModule>;
  migrationRunner: MigrationRunner;
  probeCapabilities: (path: string) => Promise<RuntimeCapabilityResult>;
  now: () => string;
  randomId: () => string;
  faultInjector: ProjectStoreBootstrapFaultInjector;
  syncDirectory?: DirectorySync;
}

interface ResolvedProjectStoreBootstrapDependencies
  extends Omit<ProjectStoreBootstrapDependencies, "syncDirectory"> {
  syncDirectory: DirectorySync;
}

interface StoreIdentity {
  storeId: StoreId;
  schemaVersion: 1;
}

type StoreValidationMode = "pristine-unpublished" | "published";

interface ReservedSqlitePath {
  path: string;
  ownsInitiallyAbsentSidecars: true;
}

const MAXIMUM_PATH_RESERVATION_ATTEMPTS = 8;

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

function cleanupReservedSqliteFiles(reservation: ReservedSqlitePath): void {
  unlinkIfPresent(reservation.path);
  unlinkIfPresent(`${reservation.path}-wal`);
  unlinkIfPresent(`${reservation.path}-shm`);
}

function hasSqliteSidecar(path: string): boolean {
  return existsSync(`${path}-wal`) || existsSync(`${path}-shm`);
}

function reserveSqlitePath(
  directory: string,
  name: (id: string) => string,
  randomId: () => string,
): ReservedSqlitePath {
  for (let attempt = 0; attempt < MAXIMUM_PATH_RESERVATION_ATTEMPTS; attempt += 1) {
    const path = join(directory, name(randomId()));
    if (hasSqliteSidecar(path)) continue;

    let handle: number;
    try {
      handle = openSync(path, "wx", 0o600);
    } catch (error) {
      if (errorCode(error) === "EEXIST") continue;
      throw bootstrapFailure("STORE_UNAVAILABLE", error);
    }
    try {
      closeSync(handle);
    } catch (error) {
      unlinkIfPresent(path);
      throw bootstrapFailure("STORE_UNAVAILABLE", error);
    }
    if (hasSqliteSidecar(path)) {
      unlinkIfPresent(path);
      continue;
    }
    return { path, ownsInitiallyAbsentSidecars: true };
  }
  throw bootstrapFailure("STORE_UNAVAILABLE");
}

function fsyncFile(path: string): void {
  const handle = openSync(path, "r+");
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
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

function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function validateExistingStore(
  DatabaseSync: DatabaseSyncConstructor,
  path: string,
  descriptor: ProjectDescriptorV1,
  expectedStoreId?: StoreId,
  mode: StoreValidationMode = "published",
): StoreIdentity {
  let database: InstanceType<DatabaseSyncConstructor> | undefined;
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

    if (
      schemaFingerprint(database as unknown as SchemaQueryConnection)
      !== expectedSchemaFingerprint([eventCoreMigration], DatabaseSync)
    ) {
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
    const maintenanceRow = maintenance[0];
    const epoch = numeric(maintenanceRow?.epoch);
    const fencingToken = numeric(maintenanceRow?.fencing_token);
    const structurallyValidMaintenance = maintenance.length === 1
      && epoch !== undefined
      && epoch >= 0
      && (maintenanceRow?.mode === "idle" || maintenanceRow?.mode === "quiescing")
      && nullableString(maintenanceRow?.owner_id)
      && fencingToken !== undefined
      && fencingToken >= 0
      && nullableString(maintenanceRow?.lease_expires_at)
      && nullableString(maintenanceRow?.requested_at);
    const pristineMaintenance = epoch === 0
      && maintenanceRow?.mode === "idle"
      && maintenanceRow.owner_id === null
      && fencingToken === 0
      && maintenanceRow.lease_expires_at === null
      && maintenanceRow.requested_at === null;
    if (
      !structurallyValidMaintenance
      || (mode === "pristine-unpublished" && !pristineMaintenance)
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

  readonly #dependencies: ResolvedProjectStoreBootstrapDependencies;
  #nodeSqlite: Promise<NodeSqliteModule> | undefined;

  constructor(dependencies: Partial<ProjectStoreBootstrapDependencies> = {}) {
    this.#dependencies = {
      descriptorRepository: dependencies.descriptorRepository
        ?? new ProjectDescriptorRepository(),
      workspaceResolver: dependencies.workspaceResolver
        ?? new GitWorkspaceResolver(new SpawnSyncGitCommandRunner()),
      router: dependencies.router ?? new ProjectStoreRouter(),
      manifestRepository: dependencies.manifestRepository
        ?? new StoreManifestRepository(),
      sqliteDriver: dependencies.sqliteDriver,
      loadNodeSqlite: dependencies.loadNodeSqlite ?? (() => import("node:sqlite")),
      migrationRunner: dependencies.migrationRunner ?? new MigrationRunner(),
      probeCapabilities: dependencies.probeCapabilities ?? probeRuntimeCapabilities,
      now: dependencies.now ?? (() => new Date().toISOString()),
      randomId: dependencies.randomId ?? randomUUID,
      faultInjector: dependencies.faultInjector
        ?? NO_PROJECT_STORE_BOOTSTRAP_FAULTS,
      syncDirectory: dependencies.syncDirectory ?? fsyncDirectory,
    };
  }

  async initialize(
    input: ProjectStoreBootstrapInput,
  ): Promise<ProjectStoreBootstrapResult> {
    const DatabaseSync = await this.databaseSync();
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
        if (!(error instanceof Error) || error.message !== "PROJECT_DESCRIPTOR_EXISTS") {
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
        DatabaseSync,
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
      const identity = validateExistingStore(DatabaseSync, route.eventsPath, descriptor);
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
    const initialization = this.createStore(
      DatabaseSync,
      descriptor,
      route,
      createdDescriptor,
    );
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

  private async databaseSync(): Promise<DatabaseSyncConstructor> {
    try {
      this.#nodeSqlite ??= this.#dependencies.loadNodeSqlite();
      const sqlite = await this.#nodeSqlite;
      if (typeof sqlite.DatabaseSync !== "function") {
        throw new Error("node:sqlite DatabaseSync is unavailable");
      }
      return sqlite.DatabaseSync;
    } catch (error) {
      throw bootstrapFailure("SQLITE_CAPABILITY_MISSING", error);
    }
  }

  private async createStore(
    DatabaseSync: DatabaseSyncConstructor,
    descriptor: ProjectDescriptorV1,
    route: ProjectStoreRoute,
    createdDescriptor: boolean,
  ): Promise<ProjectStoreBootstrapResult> {
    createDirectoryDurably(route.storeRoot, this.#dependencies.syncDirectory);
    const capabilityReservation = reserveSqlitePath(
      route.storeRoot,
      (id) => `.events.sqlite.capability-${id}.tmp`,
      this.#dependencies.randomId,
    );
    let capability: RuntimeCapabilityResult;
    try {
      try {
        capability = await this.#dependencies.probeCapabilities(
          capabilityReservation.path,
        );
      } catch (error) {
        throw bootstrapFailure("SQLITE_CAPABILITY_MISSING", error);
      }
    } finally {
      cleanupReservedSqliteFiles(capabilityReservation);
    }
    if (!capability.ok) {
      throw bootstrapFailure("SQLITE_CAPABILITY_MISSING");
    }

    const storeId = this.#dependencies.randomId() as StoreId;
    const temporaryReservation = reserveSqlitePath(
      route.storeRoot,
      (id) => `.events.sqlite.bootstrap-${id}.tmp`,
      this.#dependencies.randomId,
    );
    const temporaryPath = temporaryReservation.path;
    let connection: SqliteConnection | undefined;
    let publishedByThisContender = false;
    try {
      const sqliteDriver = this.#dependencies.sqliteDriver
        ?? new NodeSqliteDriver({ DatabaseSync });
      connection = sqliteDriver.open(temporaryPath, {
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

      validateExistingStore(
        DatabaseSync,
        temporaryPath,
        descriptor,
        storeId,
        "pristine-unpublished",
      );
      fsyncFile(temporaryPath);
      try {
        linkSync(temporaryPath, route.eventsPath);
        publishedByThisContender = true;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }

      const winningIdentity = validateExistingStore(
        DatabaseSync,
        route.eventsPath,
        descriptor,
      );
      fsyncFile(route.eventsPath);
      this.#dependencies.syncDirectory(dirname(route.eventsPath));
      unlinkIfPresent(temporaryPath);
      this.#dependencies.syncDirectory(dirname(route.eventsPath));
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
      cleanupReservedSqliteFiles(temporaryReservation);
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
      if (!(error instanceof Error) || error.message !== "STORE_MANIFEST_EXISTS") {
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
