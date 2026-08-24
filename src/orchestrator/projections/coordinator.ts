import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  readdirSync,
} from "node:fs";
import { basename, isAbsolute, join, normalize, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { LifecycleError } from "../lifecycle/errors.js";
import type { BuiltProjectionGeneration, StagedProjectionGeneration } from "./builder.js";
import type { ProjectBinding } from "./contracts.js";
import type { ProjectionEventReader, ProjectionEventSnapshot } from "./event-reader.js";
import {
  assertProjectionSidecarsAbsent,
  parseProjectionManifest,
  parseProjectionManifestV2,
  PROJECTION_MANIFEST_FILENAME,
  publishProjectionManifest,
  verifyProjectionPublicationPaths,
  type ProjectionManifestV1,
  type ProjectionManifestV2,
  type ProjectionManifestPublicationFaultBoundary,
  type ProjectionPathInspection,
} from "./manifest.js";
import {
  ProjectionLeaseUnavailableError,
  ProjectionReaderLeaseRegistry,
  type ProjectionReaderLease,
} from "./reader-lease.js";
import {
  filesystemStableProjectionDirectoryOperations,
  PROJECTION_MANIFEST_PUBLICATION_LOCK_FILENAME,
  sameProjectionDirectoryIdentity,
  type ProjectionDirectoryIdentity,
  type StableProjectionGenerationIdentity,
} from "./stable-directory.js";

const MAX_GENERATION = 2_147_483_647;
const GENERATION_FILE = /^projections-1-([1-9][0-9]{0,9})\.sqlite$/u;
const V2_GENERATION_FILE = /^projections-2-([1-9][0-9]{0,9})\.sqlite$/u;

export interface PublishedProjectionGeneration extends BuiltProjectionGeneration {
  readonly directoryIdentity: ProjectionDirectoryIdentity;
}

export interface ProjectionGenerationBuilder {
  build(snapshot: ProjectionEventSnapshot, generation: number): Promise<BuiltProjectionGeneration>;
}

export interface V2ProjectionGenerationBuilder {
  buildV2(snapshot: ProjectionEventSnapshot, generation: number): Promise<StagedProjectionGeneration>;
}

export interface PublishedProjectionGenerationV2 {
  readonly manifest: ProjectionManifestV2;
  readonly projectionDirectory: string;
  readonly databasePath: string;
  readonly directoryIdentity: ProjectionDirectoryIdentity;
}

export interface V2ProjectionBuildCoordinatorOptions {
  readonly eventReader: ProjectionEventReader;
  readonly builder: V2ProjectionGenerationBuilder;
  readonly projectionDirectory: string;
  readonly leasedFilenames?: () => readonly string[];
  readonly faultInjector?: Readonly<{
    hit(boundary: "after-v2-generation-install-before-manifest" | ProjectionManifestPublicationFaultBoundary): void;
  }>;
  readonly now?: () => number;
}

export interface ProjectionBuildCoordinator {
  ensurePublished(
    binding: ProjectBinding,
    requiredEventPosition: bigint,
    deadlineMs: number,
  ): Promise<PublishedProjectionGeneration>;
  leasePublished(binding: ProjectBinding): Promise<ProjectionReaderLease>;
}

export type ProjectionBuildFaultBoundary =
  | "after-generation-fsync-before-manifest"
  | ProjectionManifestPublicationFaultBoundary;

export interface ProjectionBuildFaultInjector {
  hit(boundary: ProjectionBuildFaultBoundary): void;
}

export interface DefaultProjectionBuildCoordinatorOptions {
  readonly eventReader: ProjectionEventReader;
  readonly builder: ProjectionGenerationBuilder;
  readonly leases?: ProjectionReaderLeaseRegistry;
  readonly projectionDirectory: string;
  readonly faultInjector?: ProjectionBuildFaultInjector;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly pathInspection?: ProjectionPathInspection;
}

export class ProjectionLagError extends LifecycleError {
  constructor(
    readonly requiredEventPosition: bigint,
    readonly availableEventPosition: bigint,
  ) {
    super("PROJECTION_LAG", {
      expectedPosition: requiredEventPosition.toString(),
      actualPosition: availableEventPosition.toString(),
    });
  }
}

function notFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function position(manifest: ProjectionManifestV1): bigint {
  return BigInt(manifest.terminalEventPosition);
}

function canonicalDirectory(path: string): string {
  if (!isAbsolute(path) || normalize(path) !== path || resolve(path) !== path) {
    throw new Error("PROJECTION_PATH_INVALID");
  }
  return path;
}

const filesystemPathInspection: ProjectionPathInspection = Object.freeze({
  lstat: (path: string) => lstatSync(path),
  realpath: (path: string) => realpathSync(path),
});

function normalizedPath(path: string): string {
  const value = resolve(path);
  return process.platform === "win32" ? value.toLowerCase() : value;
}

interface DeadlineState {
  expired: boolean;
  activeSnapshot: ProjectionEventSnapshot | null;
}

export class DefaultProjectionBuildCoordinator implements ProjectionBuildCoordinator {
  readonly #eventReader: ProjectionEventReader;
  readonly #builder: ProjectionGenerationBuilder;
  readonly #leases: ProjectionReaderLeaseRegistry;
  readonly #projectionDirectory: string;
  readonly #faultInjector: ProjectionBuildFaultInjector | undefined;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #pathInspection: ProjectionPathInspection;
  #directoryIdentity: ProjectionDirectoryIdentity | null = null;
  readonly #projectTails = new Map<string, Promise<void>>();

  constructor(options: DefaultProjectionBuildCoordinatorOptions) {
    this.#eventReader = options.eventReader;
    this.#builder = options.builder;
    this.#leases = options.leases ?? new ProjectionReaderLeaseRegistry();
    this.#projectionDirectory = canonicalDirectory(options.projectionDirectory);
    this.#faultInjector = options.faultInjector;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((milliseconds) => new Promise<void>((resolveSleep) => {
      setTimeout(resolveSleep, milliseconds);
    }));
    this.#pathInspection = options.pathInspection ?? filesystemPathInspection;
    this.#assertProjectionDirectorySafe();
  }

  async ensurePublished(
    binding: ProjectBinding,
    requiredEventPosition: bigint,
    deadlineMs: number,
  ): Promise<PublishedProjectionGeneration> {
    if (
      typeof requiredEventPosition !== "bigint"
      || requiredEventPosition < 0n
      || !Number.isSafeInteger(deadlineMs)
      || deadlineMs < 0
    ) throw new TypeError("PROJECTION_REQUEST_INVALID");
    const expiresAt = this.#now() + deadlineMs;
    const deadline: DeadlineState = { expired: deadlineMs === 0, activeSnapshot: null };
    let available = 0n;
    const work = this.#serialized(binding.projectId, async () => {
      while (true) {
        const current = this.#loadPublished(binding);
        if (current !== null) {
          available = position(current.manifest);
          this.#assertBeforeDeadline(deadline, expiresAt, requiredEventPosition, available);
          if (available >= requiredEventPosition) return current;
        }
        this.#assertBeforeDeadline(deadline, expiresAt, requiredEventPosition, available);

        this.#cleanupKnownTemps();
        this.#assertBeforeDeadline(deadline, expiresAt, requiredEventPosition, available);
        const snapshot = await this.#eventReader.openCommittedSnapshot(binding);
        deadline.activeSnapshot = snapshot;
        try {
          this.#assertBeforeDeadline(deadline, expiresAt, requiredEventPosition, available);
          if (snapshot.terminalEventPosition < available) {
            throw new Error("PROJECTION_SOURCE_REGRESSION");
          }
          if (
            current !== null
            && snapshot.terminalEventPosition === available
            && snapshot.terminalEventHash !== current.manifest.terminalEventHash
          ) throw new Error("INTEGRITY_FAILURE");
          available = snapshot.terminalEventPosition;
          if (current === null || snapshot.terminalEventPosition > position(current.manifest)) {
            this.#assertBeforeDeadline(deadline, expiresAt, requiredEventPosition, available);
            const built = await this.#builder.build(snapshot, this.#nextGeneration());
            this.#assertBeforeDeadline(deadline, expiresAt, requiredEventPosition, available);
            this.#verifyBuilt(binding, built);
            this.#assertBeforeDeadline(deadline, expiresAt, requiredEventPosition, available);
            this.#faultInjector?.hit("after-generation-fsync-before-manifest");
            this.#assertBeforeDeadline(deadline, expiresAt, requiredEventPosition, available);
            publishProjectionManifest({
              projectionDirectory: this.#projectionDirectory,
              manifest: built.manifest,
              expectedBinding: binding,
            }, {
              faultInjector: this.#faultInjector,
            });
            const published = this.#loadPublished(binding);
            if (
              published === null
              || published.manifest.generation !== built.manifest.generation
              || published.manifest.databaseSha256 !== built.manifest.databaseSha256
            ) throw new Error("PROJECTION_PUBLICATION_INVALID");
            if (current !== null && current.databasePath !== published.databasePath) {
              this.#leases.retire(current);
            }
            available = position(published.manifest);
            if (available >= requiredEventPosition) return published;
          }
        } finally {
          if (deadline.activeSnapshot === snapshot) deadline.activeSnapshot = null;
          snapshot.close();
        }

        const remaining = expiresAt - this.#now();
        if (remaining <= 0) throw new ProjectionLagError(requiredEventPosition, available);
        await this.#sleep(Math.min(10, remaining));
        this.#assertBeforeDeadline(deadline, expiresAt, requiredEventPosition, available);
      }
    });
    return this.#deadlineResult(
      work,
      deadlineMs,
      expiresAt,
      deadline,
      () => new ProjectionLagError(requiredEventPosition, available),
    );
  }

  async leasePublished(binding: ProjectBinding): Promise<ProjectionReaderLease> {
    return this.#serialized(binding.projectId, async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const selected = this.#loadPublished(binding);
        if (selected === null) throw new ProjectionLagError(0n, 0n);
        let lease: ProjectionReaderLease;
        try {
          lease = this.#leases.acquire(selected);
        } catch (error) {
          if (error instanceof ProjectionLeaseUnavailableError) continue;
          throw error;
        }
        try {
          const confirmed = this.#loadPublished(binding);
          if (
            confirmed !== null
            && confirmed.databasePath === selected.databasePath
            && confirmed.manifest.databaseSha256 === selected.manifest.databaseSha256
          ) return lease;
        } catch (error) {
          lease.close();
          throw error;
        }
        lease.close();
      }
      throw new ProjectionLeaseUnavailableError();
    });
  }

  #loadPublished(binding: ProjectBinding): PublishedProjectionGeneration | null {
    if (!this.#assertProjectionDirectorySafe()) return null;
    this.#assertManifestPublicationUnlocked();
    const manifestPath = join(this.#projectionDirectory, PROJECTION_MANIFEST_FILENAME);
    const bytes = this.#readManifestBytes(manifestPath);
    if (bytes === null) {
      this.#assertManifestPublicationUnlocked();
      if (this.#readManifestBytes(manifestPath) === null) return null;
      throw new LifecycleError("MATERIALIZATION_CONFLICT");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(bytes) as unknown;
    } catch {
      throw new Error("PROJECTION_MANIFEST_INVALID");
    }
    const manifest = parseProjectionManifest(decoded, binding);
    const paths = verifyProjectionPublicationPaths(
      this.#projectionDirectory,
      manifest.databaseFile,
      this.#pathInspection,
    );
    const databaseSha256 = sha256File(paths.databasePath);
    assertProjectionSidecarsAbsent(paths.databasePath, this.#pathInspection);
    this.#assertProjectionDirectorySafe();
    const confirmedBytes = this.#readManifestBytes(manifestPath);
    this.#assertManifestPublicationUnlocked();
    if (confirmedBytes !== bytes) throw new LifecycleError("MATERIALIZATION_CONFLICT");
    if (databaseSha256 !== manifest.databaseSha256) {
      throw new Error("PROJECTION_DATABASE_CHECKSUM_INVALID");
    }
    return Object.freeze({
      manifest,
      projectionDirectory: this.#projectionDirectory,
      databasePath: paths.databasePath,
      directoryIdentity: this.#requiredDirectoryIdentity(),
    });
  }

  #readManifestBytes(path: string): string | null {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
  }

  #assertManifestPublicationUnlocked(): void {
    const lockPath = join(
      this.#projectionDirectory,
      PROJECTION_MANIFEST_PUBLICATION_LOCK_FILENAME,
    );
    try {
      this.#pathInspection.lstat(lockPath);
    } catch (error) {
      if (notFound(error)) return;
      throw new LifecycleError("MATERIALIZATION_CONFLICT");
    }
    throw new LifecycleError("MATERIALIZATION_CONFLICT");
  }

  #verifyBuilt(binding: ProjectBinding, built: BuiltProjectionGeneration): void {
    if (!this.#assertProjectionDirectorySafe()) throw new Error("PROJECTION_PATH_INVALID");
    if (resolve(built.projectionDirectory) !== resolve(this.#projectionDirectory)) {
      throw new Error("PROJECTION_PATH_INVALID");
    }
    const manifest = parseProjectionManifest(built.manifest, binding);
    const paths = verifyProjectionPublicationPaths(
      this.#projectionDirectory,
      manifest.databaseFile,
      this.#pathInspection,
    );
    const databaseSha256 = sha256File(paths.databasePath);
    assertProjectionSidecarsAbsent(paths.databasePath, this.#pathInspection);
    this.#assertProjectionDirectorySafe();
    if (
      resolve(paths.databasePath) !== resolve(built.databasePath)
      || databaseSha256 !== manifest.databaseSha256
    ) throw new Error("PROJECTION_DATABASE_CHECKSUM_INVALID");
  }

  #cleanupKnownTemps(): void {
    if (!this.#assertProjectionDirectorySafe()) return;
    filesystemStableProjectionDirectoryOperations.cleanupKnownTemps(
      this.#projectionDirectory,
      this.#requiredDirectoryIdentity(),
    );
  }

  #nextGeneration(): number {
    if (!this.#assertProjectionDirectorySafe()) return 1;
    let maximum = 0;
    for (const name of readdirSync(this.#projectionDirectory)) {
      const match = GENERATION_FILE.exec(name);
      if (match === null) continue;
      const path = join(this.#projectionDirectory, name);
      const stat = this.#pathInspection.lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("PROJECTION_PATH_INVALID");
      maximum = Math.max(maximum, Number(match[1]));
    }
    if (maximum >= MAX_GENERATION) throw new Error("PROJECTION_GENERATION_EXHAUSTED");
    return maximum + 1;
  }

  #assertProjectionDirectorySafe(): boolean {
    let stat;
    try {
      stat = this.#pathInspection.lstat(this.#projectionDirectory);
    } catch (error) {
      if (!notFound(error)) throw error;
      const parent = resolve(this.#projectionDirectory, "..");
      try {
        const parentStat = this.#pathInspection.lstat(parent);
        if (
          !parentStat.isDirectory()
          || parentStat.isSymbolicLink()
          || normalizedPath(this.#pathInspection.realpath(parent)) !== normalizedPath(parent)
        ) throw new Error("PROJECTION_PATH_INVALID");
      } catch (parentError) {
        if (parentError instanceof Error && parentError.message === "PROJECTION_PATH_INVALID") {
          throw parentError;
        }
        throw new Error("PROJECTION_PATH_INVALID", { cause: parentError });
      }
      return false;
    }
    if (
      !stat.isDirectory()
      || stat.isSymbolicLink()
      || normalizedPath(this.#pathInspection.realpath(this.#projectionDirectory))
        !== normalizedPath(this.#projectionDirectory)
    ) throw new Error("PROJECTION_PATH_INVALID");
    const identity = filesystemStableProjectionDirectoryOperations.capture(
      this.#projectionDirectory,
    );
    if (this.#directoryIdentity === null) this.#directoryIdentity = identity;
    else if (!sameProjectionDirectoryIdentity(this.#directoryIdentity, identity)) {
      throw new Error("PROJECTION_PATH_INVALID");
    }
    return true;
  }

  #requiredDirectoryIdentity(): ProjectionDirectoryIdentity {
    if (this.#directoryIdentity === null) throw new Error("PROJECTION_PATH_INVALID");
    return this.#directoryIdentity;
  }

  #assertBeforeDeadline(
    state: DeadlineState,
    expiresAt: number,
    requiredEventPosition: bigint,
    availableEventPosition: bigint,
  ): void {
    if (state.expired || this.#now() >= expiresAt) {
      state.expired = true;
      try { state.activeSnapshot?.close(); } catch { /* deadline failure remains authoritative */ }
      throw new ProjectionLagError(requiredEventPosition, availableEventPosition);
    }
  }

  #deadlineResult<T>(
    work: Promise<T>,
    deadlineMs: number,
    expiresAt: number,
    state: DeadlineState,
    lag: () => ProjectionLagError,
  ): Promise<T> {
    return new Promise<T>((resolveResult, rejectResult) => {
      let settled = false;
      const timer = setTimeout(() => {
        state.expired = true;
        try { state.activeSnapshot?.close(); } catch { /* deadline failure remains authoritative */ }
        if (settled) return;
        settled = true;
        rejectResult(lag());
      }, deadlineMs);
      work.then(
        (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (state.expired || this.#now() >= expiresAt) {
            rejectResult(lag());
            return;
          }
          resolveResult(result);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (state.expired || this.#now() >= expiresAt) {
            rejectResult(lag());
            return;
          }
          rejectResult(error);
        },
      );
    });
  }

  async #serialized<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#projectTails.get(projectId) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolveCurrent) => {
      release = resolveCurrent;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.#projectTails.set(projectId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.#projectTails.get(projectId) === tail) this.#projectTails.delete(projectId);
    }
  }
}

/**
 * Internal-only V2 adoption boundary. It intentionally has no reader-lease
 * method, so production V1 routing cannot consume a V2 generation.
 */
export class V2ProjectionBuildCoordinator {
  readonly #eventReader: ProjectionEventReader;
  readonly #builder: V2ProjectionGenerationBuilder;
  readonly #projectionDirectory: string;
  readonly #leasedFilenames: () => readonly string[];
  readonly #faultInjector: V2ProjectionBuildCoordinatorOptions["faultInjector"];
  readonly #now: () => number;
  readonly #projectTails = new Map<string, Promise<void>>();

  constructor(options: V2ProjectionBuildCoordinatorOptions) {
    this.#eventReader = options.eventReader;
    this.#builder = options.builder;
    this.#projectionDirectory = canonicalDirectory(options.projectionDirectory);
    this.#leasedFilenames = options.leasedFilenames ?? (() => Object.freeze([]));
    this.#faultInjector = options.faultInjector;
    this.#now = options.now ?? Date.now;
  }

  async ensurePublished(
    binding: ProjectBinding,
    requiredEventPosition: bigint,
    deadlineMs: number,
  ): Promise<PublishedProjectionGenerationV2> {
    if (
      typeof requiredEventPosition !== "bigint"
      || requiredEventPosition < 0n
      || !Number.isSafeInteger(deadlineMs)
      || deadlineMs < 0
    ) throw new TypeError("PROJECTION_REQUEST_INVALID");
    const expiresAt = this.#now() + deadlineMs;
    return this.#serialized(binding.projectId, async () => {
      const current = this.#loadPublished(binding);
      if (current !== null && BigInt(current.manifest.terminalEventPosition) >= requiredEventPosition) {
        return current;
      }
      this.#assertDeadline(expiresAt, requiredEventPosition, current);
      this.#cleanupKnownTemps();
      const snapshot = await this.#eventReader.openCommittedSnapshot(binding);
      try {
        this.#assertDeadline(expiresAt, requiredEventPosition, current);
        const staged = await this.#builder.buildV2(snapshot, this.#nextGeneration());
        this.#assertDeadline(expiresAt, requiredEventPosition, current);
        const stagedIdentity = this.#verifyStaged(binding, staged);
        const operations = filesystemStableProjectionDirectoryOperations;
        let installed = false;
        publishProjectionManifest({
          projectionDirectory: this.#projectionDirectory,
          manifest: staged.manifest,
          expectedBinding: binding,
        }, {
          faultInjector: this.#faultInjector,
          beforeManifestInstall: {
            install: (_directory, identity, lockToken): void => {
              const active = this.#loadPublished(binding);
              this.#reconcileUnpublished(active, identity, lockToken, binding);
              const outcome = operations.installGeneration(
                this.#projectionDirectory,
                identity,
                lockToken,
                basename(staged.temporaryDatabasePath),
                staged.manifest.databaseFile,
                stagedIdentity,
              );
              if (outcome !== "installed") throw new LifecycleError("MATERIALIZATION_CONFLICT");
              installed = true;
              this.#faultInjector?.hit("after-v2-generation-install-before-manifest");
              this.#assertDeadline(expiresAt, requiredEventPosition, active);
            },
          },
        });
        if (!installed) throw new Error("PROJECTION_PUBLICATION_INVALID");
        const published = this.#loadPublished(binding);
        if (
          published === null
          || published.manifest.generation !== staged.manifest.generation
          || published.manifest.databaseSha256 !== staged.manifest.databaseSha256
        ) throw new Error("PROJECTION_PUBLICATION_INVALID");
        return published;
      } finally {
        snapshot.close();
      }
    });
  }

  #loadPublished(binding: ProjectBinding): PublishedProjectionGenerationV2 | null {
    const manifestPath = join(this.#projectionDirectory, PROJECTION_MANIFEST_FILENAME);
    const bytes = this.#readManifestBytes(manifestPath);
    if (bytes === null) return null;
    const manifest = parseProjectionManifestV2(JSON.parse(bytes) as unknown, binding);
    const paths = verifyProjectionPublicationPaths(this.#projectionDirectory, manifest.databaseFile);
    if (sha256File(paths.databasePath) !== manifest.databaseSha256) {
      throw new Error("PROJECTION_DATABASE_CHECKSUM_INVALID");
    }
    const identity = filesystemStableProjectionDirectoryOperations.capture(this.#projectionDirectory);
    filesystemStableProjectionDirectoryOperations.assertGeneration(
      this.#projectionDirectory,
      manifest.databaseFile,
      identity,
    );
    return Object.freeze({
      manifest,
      projectionDirectory: this.#projectionDirectory,
      databasePath: paths.databasePath,
      directoryIdentity: identity,
    });
  }

  #verifyStaged(binding: ProjectBinding, staged: StagedProjectionGeneration): StableProjectionGenerationIdentity {
    if (resolve(staged.projectionDirectory) !== resolve(this.#projectionDirectory)) {
      throw new Error("PROJECTION_PATH_INVALID");
    }
    const manifest = parseProjectionManifestV2(staged.manifest, binding);
    const temporaryFilename = basename(staged.temporaryDatabasePath);
    if (
      resolve(join(this.#projectionDirectory, temporaryFilename)) !== resolve(staged.temporaryDatabasePath)
      || !/^\.projections-2-[1-9][0-9]{0,9}-[0-9a-f]{32}\.sqlite\.tmp$/u.test(temporaryFilename)
      || manifest.databaseFile !== `projections-2-${manifest.generation}.sqlite`
    ) throw new Error("PROJECTION_PATH_INVALID");
    const freshIdentity = filesystemStableProjectionDirectoryOperations.capture(this.#projectionDirectory);
    if (!sameProjectionDirectoryIdentity(freshIdentity, staged.directoryIdentity)) {
      throw new Error("PROJECTION_PATH_INVALID");
    }
    assertProjectionSidecarsAbsent(staged.temporaryDatabasePath);
    const stat = lstatSync(staged.temporaryDatabasePath, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 0n || sha256File(staged.temporaryDatabasePath) !== manifest.databaseSha256) {
      throw new Error("PROJECTION_DATABASE_CHECKSUM_INVALID");
    }
    return Object.freeze({
      filename: temporaryFilename,
      device: stat.dev.toString(),
      inode: stat.ino.toString(),
      size: stat.size.toString(),
      sha256: manifest.databaseSha256,
    });
  }

  #reconcileUnpublished(
    active: PublishedProjectionGenerationV2 | null,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    binding: ProjectBinding,
  ): readonly string[] {
    const leased = new Set(this.#leasedFilenames());
    const removed: string[] = [];
    for (const filename of readdirSync(this.#projectionDirectory).sort()) {
      if (V2_GENERATION_FILE.test(filename) === false) continue;
      if (active?.manifest.databaseFile === filename || leased.has(filename)) continue;
      const candidate = filesystemStableProjectionDirectoryOperations.captureGeneration(
        this.#projectionDirectory,
        filename,
        identity,
      );
      this.#assertUnpublishedV2Candidate(join(this.#projectionDirectory, filename), filename, binding);
      filesystemStableProjectionDirectoryOperations.removeGeneration(
        this.#projectionDirectory,
        identity,
        lockToken,
        candidate,
      );
      removed.push(filename);
    }
    return Object.freeze(removed);
  }

  #assertUnpublishedV2Candidate(path: string, filename: string, binding: ProjectBinding): void {
    // The file must be a readable schema-2 image bound to this request; a name
    // alone is never enough authority to remove it.
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(path, { readOnly: true });
      const metadata = database.prepare(`
        SELECT schema_version, project_id, vault_id, store_id, workspace_id,
               branch_scope_id, branch_ref, session_id, generation
        FROM projection_metadata WHERE singleton = 1
      `).get();
      const match = V2_GENERATION_FILE.exec(filename);
      const schemaVersion = typeof metadata?.schema_version === "bigint"
        ? metadata.schema_version
        : typeof metadata?.schema_version === "number" && Number.isSafeInteger(metadata.schema_version)
          ? BigInt(metadata.schema_version)
          : -1n;
      const generation = typeof metadata?.generation === "bigint"
        ? metadata.generation
        : typeof metadata?.generation === "number" && Number.isSafeInteger(metadata.generation)
          ? BigInt(metadata.generation)
          : -1n;
      if (
        metadata === undefined || match === null || schemaVersion !== 2n
        || metadata.project_id !== binding.projectId || metadata.vault_id !== binding.vaultId
        || metadata.store_id !== binding.storeId || metadata.workspace_id !== binding.workspaceId
        || metadata.branch_scope_id !== binding.branchScopeId || metadata.branch_ref !== binding.branchRef
        || metadata.session_id !== null || generation !== BigInt(match[1]!)
        || database.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok"
      ) throw new Error("PROJECTION_PUBLICATION_RECOVERY_REQUIRED");
    } catch (error) {
      if (error instanceof Error && error.message === "PROJECTION_PUBLICATION_RECOVERY_REQUIRED") throw error;
      throw new Error("PROJECTION_PUBLICATION_RECOVERY_REQUIRED", { cause: error });
    } finally {
      database?.close();
    }
  }

  #nextGeneration(): number {
    try {
      let maximum = 0;
      for (const filename of readdirSync(this.#projectionDirectory)) {
        const match = V2_GENERATION_FILE.exec(filename);
        if (match !== null) maximum = Math.max(maximum, Number(match[1]));
      }
      if (maximum >= MAX_GENERATION) throw new Error("PROJECTION_GENERATION_EXHAUSTED");
      return maximum + 1;
    } catch (error) {
      if (notFound(error)) return 1;
      throw error;
    }
  }

  #cleanupKnownTemps(): void {
    if (!existsSync(this.#projectionDirectory)) return;
    try {
      const identity = filesystemStableProjectionDirectoryOperations.capture(this.#projectionDirectory);
      filesystemStableProjectionDirectoryOperations.cleanupKnownTemps(this.#projectionDirectory, identity);
    } catch (error) {
      if (!notFound(error)) throw error;
    }
  }

  #readManifestBytes(path: string): string | null {
    try { return readFileSync(path, "utf8"); } catch (error) { if (notFound(error)) return null; throw error; }
  }

  #assertDeadline(
    expiresAt: number,
    required: bigint,
    current: PublishedProjectionGenerationV2 | null,
  ): void {
    if (this.#now() >= expiresAt) {
      throw new ProjectionLagError(required, current === null ? 0n : BigInt(current.manifest.terminalEventPosition));
    }
  }

  async #serialized<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#projectTails.get(projectId) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolveCurrent) => { release = resolveCurrent; });
    const tail = previous.catch(() => undefined).then(() => current);
    this.#projectTails.set(projectId, tail);
    await previous.catch(() => undefined);
    try { return await operation(); } finally {
      release();
      if (this.#projectTails.get(projectId) === tail) this.#projectTails.delete(projectId);
    }
  }
}

export async function ensurePublished(
  coordinator: ProjectionBuildCoordinator,
  binding: ProjectBinding,
  requiredEventPosition: bigint,
  deadlineMs: number,
): Promise<PublishedProjectionGeneration> {
  return coordinator.ensurePublished(binding, requiredEventPosition, deadlineMs);
}
