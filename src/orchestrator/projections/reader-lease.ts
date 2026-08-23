import { join, resolve } from "node:path";

import { LifecycleError } from "../lifecycle/errors.js";
import {
  assertProjectionSidecarsAbsent,
  filesystemProjectionPathInspection,
  type ProjectionManifestV1,
  type ProjectionPathInspection,
} from "./manifest.js";
import {
  filesystemStableProjectionDirectoryOperations,
  sameProjectionDirectoryIdentity,
  type ProjectionDirectoryIdentity,
} from "./stable-directory.js";

export interface ProjectionReaderLease {
  readonly manifest: ProjectionManifestV1;
  readonly databasePath: string;
  close(): void;
}

export interface LeasableProjectionGeneration {
  readonly manifest: ProjectionManifestV1;
  readonly projectionDirectory: string;
  readonly databasePath: string;
  readonly directoryIdentity: ProjectionDirectoryIdentity;
}

interface LeaseEntry {
  readonly generation: LeasableProjectionGeneration;
  leases: number;
  retired: boolean;
  attempts: number;
  lastErrorCode: string | null;
}

export interface ProjectionReclamationIssue {
  readonly databasePath: string;
  readonly generation: number;
  readonly attempts: number;
  readonly errorCode: string;
}

export type ProjectionReclamationFaultBoundary =
  "after-retired-generation-check-before-retention";

export interface ProjectionReclamationFaultInjector {
  hit(
    boundary: ProjectionReclamationFaultBoundary,
    generation: LeasableProjectionGeneration,
  ): void;
}

export interface ProjectionReaderLeaseRegistryOptions {
  readonly pathInspection?: ProjectionPathInspection;
  readonly reclamationFaultInjector?: ProjectionReclamationFaultInjector;
}

export class ProjectionLeaseUnavailableError extends Error {
  readonly code = "PROJECTION_LEASE_UNAVAILABLE" as const;

  constructor() {
    super("PROJECTION_LEASE_UNAVAILABLE");
    this.name = "ProjectionLeaseUnavailableError";
  }
}

function key(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function safeErrorCode(error: unknown): string {
  if (error instanceof LifecycleError) return error.code;
  if (typeof error === "object" && error !== null && "code" in error) {
    return String(error.code).slice(0, 128);
  }
  if (error instanceof Error && /^PROJECTION_[A-Z_]+$/u.test(error.message)) {
    return error.message;
  }
  if (error instanceof Error && error.name.length > 0) return error.name.slice(0, 128);
  return "PROJECTION_RECLAMATION_FAILED";
}

export class ProjectionReaderLeaseRegistry {
  readonly #entries = new Map<string, LeaseEntry>();
  readonly #pathInspection: ProjectionPathInspection;
  readonly #reclamationFaultInjector: ProjectionReclamationFaultInjector | undefined;

  constructor(options: ProjectionReaderLeaseRegistryOptions = {}) {
    this.#pathInspection = options.pathInspection ?? filesystemProjectionPathInspection;
    this.#reclamationFaultInjector = options.reclamationFaultInjector;
  }

  acquire(generation: LeasableProjectionGeneration): ProjectionReaderLease {
    if (resolve(join(generation.projectionDirectory, generation.manifest.databaseFile))
      !== resolve(generation.databasePath)) {
      throw new Error("PROJECTION_LEASE_PATH_INVALID");
    }
    const id = key(generation.databasePath);
    const current = this.#entries.get(id);
    if (current?.retired === true) throw new ProjectionLeaseUnavailableError();
    try {
      assertProjectionSidecarsAbsent(generation.databasePath, this.#pathInspection);
      const identity = filesystemStableProjectionDirectoryOperations.capture(
        generation.projectionDirectory,
      );
      if (!sameProjectionDirectoryIdentity(identity, generation.directoryIdentity)) {
        throw new ProjectionLeaseUnavailableError();
      }
      filesystemStableProjectionDirectoryOperations.assertGeneration(
        generation.projectionDirectory,
        generation.manifest.databaseFile,
        generation.directoryIdentity,
      );
    } catch (error) {
      if (error instanceof LifecycleError && error.code === "INTEGRITY_FAILURE") throw error;
      throw new ProjectionLeaseUnavailableError();
    }
    const entry = current ?? {
      generation,
      leases: 0,
      retired: false,
      attempts: 0,
      lastErrorCode: null,
    };
    entry.leases += 1;
    this.#entries.set(id, entry);
    let closed = false;
    return Object.freeze({
      manifest: generation.manifest,
      databasePath: generation.databasePath,
      close: (): void => {
        if (closed) return;
        closed = true;
        entry.leases -= 1;
        if (entry.leases < 0) {
          entry.leases = 0;
          entry.lastErrorCode = "PROJECTION_LEASE_UNDERFLOW";
          return;
        }
        this.#attemptReclamation(entry);
      },
    });
  }

  retire(generation: LeasableProjectionGeneration): void {
    const id = key(generation.databasePath);
    const current = this.#entries.get(id);
    const entry = current ?? {
      generation,
      leases: 0,
      retired: false,
      attempts: 0,
      lastErrorCode: null,
    };
    entry.retired = true;
    this.#entries.set(id, entry);
    this.#attemptReclamation(entry);
  }

  reclamationIssues(): readonly ProjectionReclamationIssue[] {
    return Object.freeze([...this.#entries.values()]
      .filter((entry) => entry.retired && entry.lastErrorCode !== null)
      .map((entry) => Object.freeze({
        databasePath: entry.generation.databasePath,
        generation: entry.generation.manifest.generation,
        attempts: entry.attempts,
        errorCode: entry.lastErrorCode!,
      }))
      .sort((left, right) => left.databasePath.localeCompare(right.databasePath)));
  }

  retryReclamation(): void {
    for (const entry of this.#entries.values()) this.#attemptReclamation(entry);
  }

  #attemptReclamation(entry: LeaseEntry): void {
    if (!entry.retired || entry.leases !== 0) return;
    entry.attempts += 1;
    try {
      assertProjectionSidecarsAbsent(entry.generation.databasePath, this.#pathInspection);
      const identity = filesystemStableProjectionDirectoryOperations.capture(
        entry.generation.projectionDirectory,
      );
      if (!sameProjectionDirectoryIdentity(identity, entry.generation.directoryIdentity)) {
        throw new Error("PROJECTION_PATH_INVALID");
      }
      filesystemStableProjectionDirectoryOperations.assertGeneration(
        entry.generation.projectionDirectory,
        entry.generation.manifest.databaseFile,
        entry.generation.directoryIdentity,
      );
      this.#reclamationFaultInjector?.hit(
        "after-retired-generation-check-before-retention",
        entry.generation,
      );
      assertProjectionSidecarsAbsent(entry.generation.databasePath, this.#pathInspection);
      filesystemStableProjectionDirectoryOperations.assertGeneration(
        entry.generation.projectionDirectory,
        entry.generation.manifest.databaseFile,
        entry.generation.directoryIdentity,
      );
      // Automatic unlink cannot make the sidecar-absence check atomic with removal.
      // Retain the tombstoned generation for audited, out-of-band reclamation.
      entry.lastErrorCode = "PROJECTION_RECLAMATION_DEFERRED";
    } catch (error) {
      entry.lastErrorCode = safeErrorCode(error);
    }
  }
}
