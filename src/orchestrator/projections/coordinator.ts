import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";

import type { BuiltProjectionGeneration } from "./builder.js";
import type { ProjectBinding } from "./contracts.js";
import type { ProjectionEventReader, ProjectionEventSnapshot } from "./event-reader.js";
import {
  parseProjectionManifest,
  PROJECTION_MANIFEST_FILENAME,
  publishProjectionManifest,
  verifyProjectionPublicationPaths,
  type ProjectionManifestV1,
} from "./manifest.js";
import {
  ProjectionReaderLeaseRegistry,
  type ProjectionReaderLease,
} from "./reader-lease.js";

const MAX_GENERATION = 2_147_483_647;
const GENERATION_FILE = /^projections-1-([1-9][0-9]{0,9})\.sqlite$/u;
const GENERATION_TEMP = /^\.projections-1-[1-9][0-9]{0,9}\.sqlite\.tmp(?:-(?:wal|shm))?$/u;

export interface PublishedProjectionGeneration extends BuiltProjectionGeneration {}

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
}

export class ProjectionLagError extends Error {
  readonly code = "PROJECTION_LAG" as const;

  constructor(
    readonly requiredEventPosition: bigint,
    readonly availableEventPosition: bigint,
  ) {
    super("PROJECTION_LAG");
    this.name = "ProjectionLagError";
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

export class DefaultProjectionBuildCoordinator implements ProjectionBuildCoordinator {
  readonly #eventReader: ProjectionEventReader;
  readonly #builder: ProjectionGenerationBuilder;
  readonly #leases: ProjectionReaderLeaseRegistry;
  readonly #projectionDirectory: string;
  readonly #faultInjector: ProjectionBuildFaultInjector | undefined;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
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
    return this.#serialized(binding.projectId, async () => {
      let available = 0n;
      let attemptedSnapshot = false;
      while (true) {
        const current = this.#loadPublished(binding);
        if (current !== null) {
          available = position(current.manifest);
          if (available >= requiredEventPosition) return current;
        }
        if (attemptedSnapshot && this.#now() >= expiresAt) {
          throw new ProjectionLagError(requiredEventPosition, available);
        }

        this.#cleanupKnownTemps();
        const snapshot = await this.#eventReader.openCommittedSnapshot(binding);
        attemptedSnapshot = true;
        try {
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
            const built = await this.#builder.build(snapshot, this.#nextGeneration());
            this.#verifyBuilt(binding, built);
            this.#faultInjector?.hit("after-generation-fsync-before-manifest");
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
      }
    });
  }

  async leasePublished(binding: ProjectBinding): Promise<ProjectionReaderLease> {
    const current = this.#loadPublished(binding);
    if (current === null) throw new ProjectionLagError(0n, 0n);
    return this.#leases.acquire(current);
  }

  #loadPublished(binding: ProjectBinding): PublishedProjectionGeneration | null {
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
    });
  }

  #verifyBuilt(binding: ProjectBinding, built: BuiltProjectionGeneration): void {
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
    if (!existsSync(this.#projectionDirectory)) return;
    for (const name of readdirSync(this.#projectionDirectory)) {
      if (name !== `.${PROJECTION_MANIFEST_FILENAME}.tmp` && !GENERATION_TEMP.test(name)) continue;
      const path = join(this.#projectionDirectory, name);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("PROJECTION_PATH_INVALID");
      unlinkSync(path);
    }
  }

  #nextGeneration(): number {
    if (!existsSync(this.#projectionDirectory)) return 1;
    let maximum = 0;
    for (const name of readdirSync(this.#projectionDirectory)) {
      const match = GENERATION_FILE.exec(name);
      if (match === null) continue;
      const path = join(this.#projectionDirectory, name);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("PROJECTION_PATH_INVALID");
      maximum = Math.max(maximum, Number(match[1]));
    }
    if (maximum >= MAX_GENERATION) throw new Error("PROJECTION_GENERATION_EXHAUSTED");
    return maximum + 1;
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
