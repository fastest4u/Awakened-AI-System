import { createHash, randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
} from "node:fs";
import { basename, isAbsolute, join, normalize, resolve } from "node:path";

import { LifecycleError } from "../lifecycle/errors.js";
import type { BuiltProjectionGeneration, StagedProjectionGeneration } from "./builder.js";
import type { ProjectBinding } from "./contracts.js";
import type { ProjectionEventReader, ProjectionEventSnapshot } from "./event-reader.js";
import {
  assertProjectionSidecarsAbsent,
  acquireProjectionManifestPublicationLease,
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
  sameRetirementImage,
  sameRetirementRenameContinuity,
  toRetirementImage,
  V2ReconciliationJournal,
} from "./reconciliation-journal.js";
import { assertUnpublishedProjectionV2Image } from "./integrity.js";
import {
  ProjectionLeaseUnavailableError,
  ProjectionReaderLeaseRegistry,
  type ProjectionReaderLease,
} from "./reader-lease.js";
import {
  V2ProjectionLeaseUnavailableError,
  V2ProjectionReaderLeaseRegistry,
  type V2ProjectionReaderLease,
} from "./v2-reader-lease.js";
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
const V2_RETIRED_FILE = /^\.projections-2-retired-[0-9a-f]{32}\.sqlite$/u;
const V2_LEGACY_QUARANTINE_FILE = /^\.projections-2-quarantine-[0-9a-f]{32}\.sqlite$/u;
const V2_RECONCILIATION_SIDECAR = /^(?:projections-2-[1-9][0-9]{0,9}|\.projections-2-(?:retired|quarantine)-[0-9a-f]{32})\.sqlite-(?:wal|shm)$/u;

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

interface V2ReconciliationEntry {
  readonly current: PublishedProjectionGenerationV2 | null;
  readonly highestObservedGeneration: number;
}

export interface V2ProjectionBuildCoordinatorOptions {
  readonly eventReader: ProjectionEventReader;
  readonly builder: V2ProjectionGenerationBuilder;
  readonly projectionDirectory: string;
  readonly leasedFilenames?: () => readonly string[];
  readonly evaluationLeases?: V2ProjectionReaderLeaseRegistry;
  readonly faultInjector?: Readonly<{
    hit(boundary:
      | "after-v2-generation-install-before-manifest"
      | "after-v2-orphan-image-before-validation"
      | "after-v2-orphan-reservation-before-quarantine"
      | "after-v2-orphan-quarantine-before-confirm"
      | "after-v2-retirement-intent-before-rename"
      | "after-v2-retirement-rename-before-complete"
      | "after-v2-retirement-recovery-before-final-scan"
      | ProjectionManifestPublicationFaultBoundary): void;
  }>;
  readonly now?: () => number;
  readonly pathInspection?: ProjectionPathInspection;
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
  readonly #externalLeasedFilenames: () => readonly string[];
  readonly #evaluationLeases: V2ProjectionReaderLeaseRegistry;
  readonly #leasedFilenames: () => readonly string[];
  readonly #faultInjector: V2ProjectionBuildCoordinatorOptions["faultInjector"];
  readonly #now: () => number;
  readonly #pathInspection: ProjectionPathInspection;
  readonly #reconciliationJournal = new V2ReconciliationJournal();
  #directoryIdentity: ProjectionDirectoryIdentity | null = null;
  readonly #projectTails = new Map<string, Promise<void>>();

  constructor(options: V2ProjectionBuildCoordinatorOptions) {
    this.#eventReader = options.eventReader;
    this.#builder = options.builder;
    this.#projectionDirectory = canonicalDirectory(options.projectionDirectory);
    this.#externalLeasedFilenames = options.leasedFilenames ?? (() => Object.freeze([]));
    this.#evaluationLeases = options.evaluationLeases ?? new V2ProjectionReaderLeaseRegistry();
    this.#leasedFilenames = () => Object.freeze([...new Set([
      ...this.#externalLeasedFilenames(),
      ...this.#evaluationLeases.activeFilenames(),
    ])].sort());
    this.#faultInjector = options.faultInjector;
    this.#now = options.now ?? Date.now;
    this.#pathInspection = options.pathInspection ?? filesystemPathInspection;
    this.#assertProjectionDirectorySafe();
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
      const identity = this.#ensureProjectionDirectory();
      const lease = acquireProjectionManifestPublicationLease(this.#projectionDirectory);
      if (!sameProjectionDirectoryIdentity(identity, lease.directoryIdentity)) {
        lease.release(true);
        throw new Error("PROJECTION_PATH_INVALID");
      }
      let retainLock = true;
      try {
        const reconciled = this.#reconcileEntry(
          binding,
          this.#loadPublishedLocked(binding, identity),
          identity,
          lease.lockToken,
        );
        const current = this.#persistObservedGeneration(
          binding,
          reconciled.current,
          reconciled.highestObservedGeneration,
          identity,
        );
        // A completed reconciliation is durable in the journal. Ordinary
        // source/build failures can release the cooperative lock; any later
        // publication ambiguity poisons its nested manifest attempt itself.
        retainLock = false;
        if (current !== null && BigInt(current.manifest.terminalEventPosition) >= requiredEventPosition) {
          return current;
        }
        this.#assertDeadline(expiresAt, requiredEventPosition, current);
        this.#cleanupKnownTemps();
        const snapshot = await this.#eventReader.openCommittedSnapshot(binding);
        try {
          this.#assertDeadline(expiresAt, requiredEventPosition, current);
          const generationFloor = Math.max(
          reconciled.highestObservedGeneration,
          current?.manifest.highestObservedGeneration ?? 0,
          current?.manifest.generation ?? 0,
          );
          const staged = await this.#builder.buildV2(snapshot, this.#nextGeneration(generationFloor));
          const stagedManifest = parseProjectionManifestV2({
            ...staged.manifest,
            highestObservedGeneration: Math.max(generationFloor, staged.manifest.generation),
          }, binding);
          const stagedForPublication = Object.freeze({ ...staged, manifest: stagedManifest });
          this.#assertDeadline(expiresAt, requiredEventPosition, current);
          const stagedIdentity = this.#verifyStaged(binding, stagedForPublication);
          const operations = filesystemStableProjectionDirectoryOperations;
          let installed = false;
          publishProjectionManifest({
            projectionDirectory: this.#projectionDirectory,
            manifest: stagedForPublication.manifest,
            expectedBinding: binding,
          }, {
            faultInjector: this.#faultInjector,
            beforeManifestInstall: {
              install: (_directory, lockedIdentity, lockToken): void => {
                if (
                  !sameProjectionDirectoryIdentity(lockedIdentity, stagedForPublication.directoryIdentity)
                  || !this.#assertProjectionDirectorySafe()
                  || !sameProjectionDirectoryIdentity(lockedIdentity, this.#requiredDirectoryIdentity())
                ) throw new Error("PROJECTION_PATH_INVALID");
                const active = this.#loadPublishedLocked(binding, lockedIdentity);
                if (active !== null && active.manifest.highestObservedGeneration > stagedForPublication.manifest.highestObservedGeneration) {
                  throw new LifecycleError("MATERIALIZATION_CONFLICT");
                }
                const outcome = operations.installGeneration(
                  this.#projectionDirectory,
                  lockedIdentity,
                  lockToken,
                  basename(stagedForPublication.temporaryDatabasePath),
                  stagedForPublication.manifest.databaseFile,
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
          const published = this.#loadPublishedLocked(binding, identity);
          if (
            published === null
            || published.manifest.generation !== stagedForPublication.manifest.generation
            || published.manifest.databaseSha256 !== stagedForPublication.manifest.databaseSha256
          ) throw new Error("PROJECTION_PUBLICATION_INVALID");
          return published;
        } finally {
          snapshot.close();
        }
      } finally {
        lease.release(retainLock);
      }
    });
  }

  async leasePublishedForEvaluation(binding: ProjectBinding): Promise<V2ProjectionReaderLease> {
    return this.#serialized(binding.projectId, async () => {
      const identity = this.#ensureProjectionDirectory();
      const publicationLease = acquireProjectionManifestPublicationLease(this.#projectionDirectory);
      if (!sameProjectionDirectoryIdentity(identity, publicationLease.directoryIdentity)) {
        publicationLease.release(true);
        throw new Error("PROJECTION_PATH_INVALID");
      }
      let failure: unknown;
      let retainLock = true;
      try {
        if (!sameProjectionDirectoryIdentity(identity, this.#requiredDirectoryIdentity())) {
          throw new Error("PROJECTION_PATH_INVALID");
        }
        const published = this.#loadPublishedLocked(binding, identity);
        if (published === null) throw new V2ProjectionLeaseUnavailableError();
        const image = filesystemStableProjectionDirectoryOperations.readGenerationImage(
          this.#projectionDirectory,
          identity,
          publicationLease.lockToken,
          published.manifest.databaseFile,
        );
        const evaluatorLease = this.#evaluationLeases.acquire(Object.freeze({ manifest: published.manifest, image }));
        retainLock = false;
        return evaluatorLease;
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        try {
          publicationLease.release(retainLock);
        } catch (error) {
          if (failure === undefined) throw error;
        }
      }
    });
  }

  #loadPublished(binding: ProjectBinding): PublishedProjectionGenerationV2 | null {
    if (!this.#assertProjectionDirectorySafe()) return null;
    this.#assertManifestPublicationUnlocked();
    const manifestPath = join(this.#projectionDirectory, PROJECTION_MANIFEST_FILENAME);
    const bytes = this.#readManifestBytes(manifestPath);
    if (bytes === null) {
      this.#assertManifestPublicationUnlocked();
      if (this.#readManifestBytes(manifestPath) === null) return null;
      throw new LifecycleError("MATERIALIZATION_CONFLICT");
    }
    const manifest = parseProjectionManifestV2(JSON.parse(bytes) as unknown, binding);
    const paths = verifyProjectionPublicationPaths(
      this.#projectionDirectory,
      manifest.databaseFile,
      this.#pathInspection,
    );
    if (sha256File(paths.databasePath) !== manifest.databaseSha256) {
      throw new Error("PROJECTION_DATABASE_CHECKSUM_INVALID");
    }
    assertProjectionSidecarsAbsent(paths.databasePath, this.#pathInspection);
    this.#assertProjectionDirectorySafe();
    const confirmedBytes = this.#readManifestBytes(manifestPath);
    this.#assertManifestPublicationUnlocked();
    if (confirmedBytes !== bytes) throw new LifecycleError("MATERIALIZATION_CONFLICT");
    const identity = this.#requiredDirectoryIdentity();
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

  #loadPublishedLocked(
    binding: ProjectBinding,
    identity: ProjectionDirectoryIdentity,
  ): PublishedProjectionGenerationV2 | null {
    if (!this.#assertProjectionDirectorySafe() || !sameProjectionDirectoryIdentity(
      identity,
      this.#requiredDirectoryIdentity(),
    )) throw new Error("PROJECTION_PATH_INVALID");
    const snapshot = filesystemStableProjectionDirectoryOperations.captureManifest(
      this.#projectionDirectory,
      identity,
    );
    if (snapshot.state === "missing") return null;
    const bytes = Buffer.from(snapshot.bytesBase64, "base64").toString("utf8");
    const manifest = parseProjectionManifestV2(JSON.parse(bytes) as unknown, binding);
    const paths = verifyProjectionPublicationPaths(
      this.#projectionDirectory,
      manifest.databaseFile,
      this.#pathInspection,
    );
    assertProjectionSidecarsAbsent(paths.databasePath, this.#pathInspection);
    if (sha256File(paths.databasePath) !== manifest.databaseSha256) {
      throw new Error("PROJECTION_DATABASE_CHECKSUM_INVALID");
    }
    if (!this.#assertProjectionDirectorySafe() || !sameProjectionDirectoryIdentity(
      identity,
      this.#requiredDirectoryIdentity(),
    )) throw new Error("PROJECTION_PATH_INVALID");
    const confirmed = filesystemStableProjectionDirectoryOperations.captureManifest(
      this.#projectionDirectory,
      identity,
    );
    if (confirmed.state !== "present" || confirmed.bytesBase64 !== snapshot.bytesBase64) {
      throw new LifecycleError("MATERIALIZATION_CONFLICT");
    }
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

  #reconcileEntry(
    binding: ProjectBinding,
    current: PublishedProjectionGenerationV2 | null,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
  ): V2ReconciliationEntry {
    if (current !== null && !sameProjectionDirectoryIdentity(identity, current.directoryIdentity)) {
      throw new Error("PROJECTION_PATH_INVALID");
    }
    const active = this.#loadPublishedLocked(binding, identity);
    const highestObservedGeneration = this.#reconcileUnpublished(active, identity, lockToken, binding);
    if (!this.#assertProjectionDirectorySafe() || !sameProjectionDirectoryIdentity(
      identity,
      this.#requiredDirectoryIdentity(),
    )) throw new Error("PROJECTION_PATH_INVALID");
    return Object.freeze({
      current: active,
      highestObservedGeneration: Math.max(
        highestObservedGeneration,
        active?.manifest.generation ?? 0,
        active?.manifest.highestObservedGeneration ?? 0,
      ),
    });
  }

  #persistObservedGeneration(
    binding: ProjectBinding,
    current: PublishedProjectionGenerationV2 | null,
    highestObservedGeneration: number,
    identity: ProjectionDirectoryIdentity,
  ): PublishedProjectionGenerationV2 | null {
    if (current === null || highestObservedGeneration <= current.manifest.highestObservedGeneration) {
      return current;
    }
    const manifest = parseProjectionManifestV2({
      ...current.manifest,
      highestObservedGeneration,
    }, binding);
    publishProjectionManifest({
      projectionDirectory: this.#projectionDirectory,
      manifest,
      expectedBinding: binding,
    });
    const published = this.#loadPublishedLocked(binding, identity);
    if (published === null || published.manifest.highestObservedGeneration < highestObservedGeneration) {
      throw new Error("PROJECTION_PUBLICATION_INVALID");
    }
    return published;
  }

  #verifyStaged(binding: ProjectBinding, staged: StagedProjectionGeneration): StableProjectionGenerationIdentity {
    if (
      !this.#assertProjectionDirectorySafe()
      || resolve(staged.projectionDirectory) !== resolve(this.#projectionDirectory)
      || !sameProjectionDirectoryIdentity(staged.directoryIdentity, this.#requiredDirectoryIdentity())
    ) {
      throw new Error("PROJECTION_PATH_INVALID");
    }
    const manifest = parseProjectionManifestV2(staged.manifest, binding);
    const temporaryFilename = basename(staged.temporaryDatabasePath);
    if (
      resolve(join(this.#projectionDirectory, temporaryFilename)) !== resolve(staged.temporaryDatabasePath)
      || !/^\.projections-2-[1-9][0-9]{0,9}-[0-9a-f]{32}\.sqlite\.tmp$/u.test(temporaryFilename)
      || manifest.databaseFile !== `projections-2-${manifest.generation}.sqlite`
    ) throw new Error("PROJECTION_PATH_INVALID");
    if (!this.#assertProjectionDirectorySafe() || !sameProjectionDirectoryIdentity(
      staged.directoryIdentity,
      this.#requiredDirectoryIdentity(),
    )) {
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
      ctimeNs: stat.ctimeNs.toString(),
      sha256: manifest.databaseSha256,
    });
  }

  #reconcileUnpublished(
    active: PublishedProjectionGenerationV2 | null,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    binding: ProjectBinding,
  ): number {
    const leased = new Set(this.#leasedFilenames());
    const records = this.#reconciliationJournal.snapshot(
      this.#projectionDirectory,
      identity,
      lockToken,
    );
    const initialFilenames = readdirSync(this.#projectionDirectory).sort();
    const initialFilenamesPresent = new Set(initialFilenames);
    const retiredFilenames = new Set<string>();
    const intentFinalFilenames = new Set<string>();
    for (const record of records) {
      if (
        !V2_RETIRED_FILE.test(record.retiredFilename)
        || retiredFilenames.has(record.retiredFilename)
      ) throw new Error("PROJECTION_PUBLICATION_RECOVERY_REQUIRED");
      retiredFilenames.add(record.retiredFilename);
      if (record.state !== "intent") continue;
      const finalMatch = V2_GENERATION_FILE.exec(record.finalFilename);
      if (
        finalMatch === null
        || Number(finalMatch[1]) !== record.generation
        || intentFinalFilenames.has(record.finalFilename)
        || active?.manifest.databaseFile === record.finalFilename
        || leased.has(record.finalFilename)
      ) throw new Error("PROJECTION_PUBLICATION_RECOVERY_REQUIRED");
      intentFinalFilenames.add(record.finalFilename);
    }
    const assertStrictRetirementEvidence = (filenamesPresent: ReadonlySet<string>): void => {
      for (const filename of filenamesPresent) {
        if (
          V2_LEGACY_QUARANTINE_FILE.test(filename)
          || V2_RECONCILIATION_SIDECAR.test(filename)
          || (V2_RETIRED_FILE.test(filename) && !retiredFilenames.has(filename))
        ) throw new Error("PROJECTION_PUBLICATION_RECOVERY_REQUIRED");
      }
    };
    assertStrictRetirementEvidence(initialFilenamesPresent);
    const resolvedRecords = [...records];
    for (const [index, record] of records.entries()) {
      let retired: StableProjectionGenerationIdentity | null;
      try {
        retired = filesystemStableProjectionDirectoryOperations.captureRetiredGeneration(
          this.#projectionDirectory,
          identity,
          lockToken,
          record.retiredFilename,
        );
      } catch (error) {
        this.#throwReconciliationRecovery(error);
      }
      if (record.state === "retired") {
        if (retired === null || !sameRetirementImage(retired, record.image)) {
          throw new Error("PROJECTION_PUBLICATION_RECOVERY_REQUIRED");
        }
        continue;
      }
      if (retired !== null) {
        if (
          initialFilenamesPresent.has(record.finalFilename)
          || !sameRetirementRenameContinuity(retired, record.image)
        ) throw new Error("PROJECTION_PUBLICATION_RECOVERY_REQUIRED");
        try {
          resolvedRecords[index] = this.#reconciliationJournal.completeRetirement(
            this.#projectionDirectory,
            identity,
            lockToken,
            record,
            toRetirementImage(retired),
          );
        } catch (error) {
          this.#throwReconciliationRecovery(error);
        }
        continue;
      }
      let finalImage;
      try {
        finalImage = filesystemStableProjectionDirectoryOperations.readGenerationImage(
          this.#projectionDirectory,
          identity,
          lockToken,
          record.finalFilename,
        );
      } catch (error) {
        this.#throwReconciliationRecovery(error);
      }
      if (!sameRetirementImage(finalImage.identity, record.image)) {
        throw new Error("PROJECTION_PUBLICATION_RECOVERY_REQUIRED");
      }
      this.#assertUnpublishedV2Candidate(finalImage.bytes, record.finalFilename, binding);
      try {
        filesystemStableProjectionDirectoryOperations.retireGeneration(
          this.#projectionDirectory,
          identity,
          lockToken,
          finalImage.identity,
          record.retiredFilename,
        );
      } catch (error) {
        this.#throwReconciliationRecovery(error);
      }
      this.#faultInjector?.hit("after-v2-retirement-rename-before-complete");
      try {
        retired = filesystemStableProjectionDirectoryOperations.captureRetiredGeneration(
          this.#projectionDirectory,
          identity,
          lockToken,
          record.retiredFilename,
        );
      } catch (error) {
        this.#throwReconciliationRecovery(error);
      }
      if (retired === null || !sameRetirementRenameContinuity(retired, record.image)) {
        throw new Error("PROJECTION_PUBLICATION_RECOVERY_REQUIRED");
      }
      try {
        resolvedRecords[index] = this.#reconciliationJournal.completeRetirement(
          this.#projectionDirectory,
          identity,
          lockToken,
          record,
          toRetirementImage(retired),
        );
      } catch (error) {
        this.#throwReconciliationRecovery(error);
      }
    }
    this.#faultInjector?.hit("after-v2-retirement-recovery-before-final-scan");
    const filenames = readdirSync(this.#projectionDirectory).sort();
    const filenamesPresent = new Set(filenames);
    assertStrictRetirementEvidence(filenamesPresent);
    for (const record of resolvedRecords) {
      if (record.state !== "retired" || !filenamesPresent.has(record.retiredFilename)) {
        throw new Error("PROJECTION_PUBLICATION_RECOVERY_REQUIRED");
      }
      let retired: StableProjectionGenerationIdentity | null;
      try {
        retired = filesystemStableProjectionDirectoryOperations.captureRetiredGeneration(
          this.#projectionDirectory,
          identity,
          lockToken,
          record.retiredFilename,
        );
      } catch (error) {
        this.#throwReconciliationRecovery(error);
      }
      if (retired === null || !sameRetirementImage(retired, record.image)) {
        throw new Error("PROJECTION_PUBLICATION_RECOVERY_REQUIRED");
      }
    }
    let highestObservedGeneration = active?.manifest.highestObservedGeneration ?? 0;
    for (const filename of filenames) {
      const match = V2_GENERATION_FILE.exec(filename);
      if (match === null) continue;
      highestObservedGeneration = Math.max(highestObservedGeneration, Number(match[1]));
    }
    highestObservedGeneration = this.#reconciliationJournal.reserveAtLeast(
      this.#projectionDirectory,
      identity,
      lockToken,
      highestObservedGeneration,
    );
    this.#faultInjector?.hit("after-v2-orphan-reservation-before-quarantine");
    for (const filename of filenames) {
      const match = V2_GENERATION_FILE.exec(filename);
      if (match === null) continue;
      if (active?.manifest.databaseFile === filename || leased.has(filename)) continue;
      const image = filesystemStableProjectionDirectoryOperations.readGenerationImage(
        this.#projectionDirectory,
        identity,
        lockToken,
        filename,
      );
      this.#faultInjector?.hit("after-v2-orphan-image-before-validation");
      this.#assertUnpublishedV2Candidate(
        image.bytes,
        filename,
        binding,
      );
      const retiredFilename = `.projections-2-retired-${randomBytes(16).toString("hex")}.sqlite`;
      const intent = this.#reconciliationJournal.beginRetirement(
        this.#projectionDirectory,
        identity,
        lockToken,
        Object.freeze({
          state: "intent",
          generation: Number(match[1]),
          finalFilename: filename,
          retiredFilename,
          image: toRetirementImage(image.identity),
        }),
      );
      this.#faultInjector?.hit("after-v2-retirement-intent-before-rename");
      filesystemStableProjectionDirectoryOperations.retireGeneration(
        this.#projectionDirectory,
        identity,
        lockToken,
        image.identity,
        intent.retiredFilename,
      );
      this.#faultInjector?.hit("after-v2-orphan-quarantine-before-confirm");
      this.#faultInjector?.hit("after-v2-retirement-rename-before-complete");
      const observed = filesystemStableProjectionDirectoryOperations.captureRetiredGeneration(
        this.#projectionDirectory,
        identity,
        lockToken,
        intent.retiredFilename,
      );
      if (observed === null || !sameRetirementRenameContinuity(observed, intent.image)) {
        throw new Error("PROJECTION_PUBLICATION_RECOVERY_REQUIRED");
      }
      this.#reconciliationJournal.completeRetirement(
        this.#projectionDirectory,
        identity,
        lockToken,
        intent,
        toRetirementImage(observed),
      );
    }
    return highestObservedGeneration;
  }

  #throwReconciliationRecovery(error: unknown): never {
    if (
      error instanceof Error
      && (
        error.message === "PROJECTION_PATH_INVALID"
        || error.message === "PROJECTION_PUBLICATION_RECOVERY_REQUIRED"
      )
    ) throw error;
    throw new Error("PROJECTION_PUBLICATION_RECOVERY_REQUIRED", { cause: error });
  }

  #assertUnpublishedV2Candidate(bytes: Uint8Array, filename: string, binding: ProjectBinding): void {
    try {
      assertUnpublishedProjectionV2Image(bytes, filename, binding);
    } catch (error) {
      if (error instanceof Error && error.message === "PROJECTION_PUBLICATION_RECOVERY_REQUIRED") throw error;
      throw new Error("PROJECTION_PUBLICATION_RECOVERY_REQUIRED", { cause: error });
    }
  }

  #ensureProjectionDirectory(): ProjectionDirectoryIdentity {
    if (!this.#assertProjectionDirectorySafe()) {
      try {
        mkdirSync(this.#projectionDirectory, { recursive: false });
      } catch (error) {
        if (!notFound(error) && !(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) {
          throw error;
        }
      }
      if (!this.#assertProjectionDirectorySafe()) throw new Error("PROJECTION_PATH_INVALID");
    }
    return this.#requiredDirectoryIdentity();
  }

  #nextGeneration(minimumGeneration: number): number {
    if (!this.#assertProjectionDirectorySafe()) return 1;
    if (!Number.isSafeInteger(minimumGeneration) || minimumGeneration < 0 || minimumGeneration > MAX_GENERATION) {
      throw new Error("PROJECTION_GENERATION_EXHAUSTED");
    }
    try {
      let maximum = minimumGeneration;
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
    if (!this.#assertProjectionDirectorySafe()) return;
    try {
      const identity = this.#requiredDirectoryIdentity();
      filesystemStableProjectionDirectoryOperations.cleanupKnownTemps(this.#projectionDirectory, identity);
    } catch (error) {
      if (!notFound(error)) throw error;
    }
  }

  #readManifestBytes(path: string): string | null {
    try { return readFileSync(path, "utf8"); } catch (error) { if (notFound(error)) return null; throw error; }
  }

  #assertManifestPublicationUnlocked(): void {
    const lockPath = join(this.#projectionDirectory, PROJECTION_MANIFEST_PUBLICATION_LOCK_FILENAME);
    try {
      this.#pathInspection.lstat(lockPath);
    } catch (error) {
      if (notFound(error)) return;
      throw new LifecycleError("MATERIALIZATION_CONFLICT");
    }
    throw new LifecycleError("MATERIALIZATION_CONFLICT");
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
        if (parentError instanceof Error && parentError.message === "PROJECTION_PATH_INVALID") throw parentError;
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
    const identity = filesystemStableProjectionDirectoryOperations.capture(this.#projectionDirectory);
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
