import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  realpathSync,
  readdirSync,
} from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";

import { LifecycleError } from "../lifecycle/errors.js";
import type { BuiltProjectionGeneration } from "./builder.js";
import type { ProjectBinding } from "./contracts.js";
import type { ProjectionEventReader, ProjectionEventSnapshot } from "./event-reader.js";
import {
  parseProjectionManifest,
  PROJECTION_MANIFEST_FILENAME,
  publishProjectionManifest,
  verifyProjectionPublicationPaths,
  type ProjectionManifestV1,
  type ProjectionPathInspection,
} from "./manifest.js";
import {
  ProjectionLeaseUnavailableError,
  ProjectionReaderLeaseRegistry,
  type ProjectionReaderLease,
} from "./reader-lease.js";
import {
  filesystemStableProjectionDirectoryOperations,
  sameProjectionDirectoryIdentity,
  type ProjectionDirectoryIdentity,
} from "./stable-directory.js";

const MAX_GENERATION = 2_147_483_647;
const GENERATION_FILE = /^projections-1-([1-9][0-9]{0,9})\.sqlite$/u;

export interface PublishedProjectionGeneration extends BuiltProjectionGeneration {
  readonly directoryIdentity: ProjectionDirectoryIdentity;
}

export interface ProjectionGenerationBuilder {
  build(snapshot: ProjectionEventSnapshot, generation: number): Promise<BuiltProjectionGeneration>;
}

export interface ProjectionBuildCoordinator {
  ensurePublished(
    binding: ProjectBinding,
    requiredEventPosition: bigint,
    deadlineMs: number,
  ): Promise<PublishedProjectionGeneration>;
  leasePublished(binding: ProjectBinding): Promise<ProjectionReaderLease>;
}

export type ProjectionBuildFaultBoundary = "after-generation-fsync-before-manifest";

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
    const deadline: DeadlineState = { expired: deadlineMs === 0 };
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
    const manifestPath = join(this.#projectionDirectory, PROJECTION_MANIFEST_FILENAME);
    let bytes: string;
    try {
      bytes = readFileSync(manifestPath, "utf8");
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(bytes) as unknown;
    } catch {
      throw new Error("PROJECTION_MANIFEST_INVALID");
    }
    const manifest = parseProjectionManifest(decoded, binding);
    const paths = verifyProjectionPublicationPaths(this.#projectionDirectory, manifest.databaseFile);
    if (sha256File(paths.databasePath) !== manifest.databaseSha256) {
      throw new Error("PROJECTION_DATABASE_CHECKSUM_INVALID");
    }
    return Object.freeze({
      manifest,
      projectionDirectory: this.#projectionDirectory,
      databasePath: paths.databasePath,
      directoryIdentity: this.#requiredDirectoryIdentity(),
    });
  }

  #verifyBuilt(binding: ProjectBinding, built: BuiltProjectionGeneration): void {
    if (!this.#assertProjectionDirectorySafe()) throw new Error("PROJECTION_PATH_INVALID");
    if (resolve(built.projectionDirectory) !== resolve(this.#projectionDirectory)) {
      throw new Error("PROJECTION_PATH_INVALID");
    }
    const manifest = parseProjectionManifest(built.manifest, binding);
    const paths = verifyProjectionPublicationPaths(this.#projectionDirectory, manifest.databaseFile);
    if (
      resolve(paths.databasePath) !== resolve(built.databasePath)
      || sha256File(paths.databasePath) !== manifest.databaseSha256
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

export async function ensurePublished(
  coordinator: ProjectionBuildCoordinator,
  binding: ProjectBinding,
  requiredEventPosition: bigint,
  deadlineMs: number,
): Promise<PublishedProjectionGeneration> {
  return coordinator.ensurePublished(binding, requiredEventPosition, deadlineMs);
}
