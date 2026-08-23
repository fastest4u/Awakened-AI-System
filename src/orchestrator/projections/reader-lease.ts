import { lstatSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

import { fsyncDirectory, type DirectorySync } from "../identity/directory-durability.js";
import type { ProjectionManifestV1 } from "./manifest.js";

export interface ProjectionReaderLease {
  readonly manifest: ProjectionManifestV1;
  readonly databasePath: string;
  close(): void;
}

export interface LeasableProjectionGeneration {
  readonly manifest: ProjectionManifestV1;
  readonly projectionDirectory: string;
  readonly databasePath: string;
}

interface LeaseEntry {
  readonly generation: LeasableProjectionGeneration;
  leases: number;
  retired: boolean;
  fileRemoved: boolean;
  attempts: number;
  lastErrorCode: string | null;
}

export interface ProjectionReclamationIssue {
  readonly databasePath: string;
  readonly generation: number;
  readonly attempts: number;
  readonly errorCode: string;
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

function notFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function safeErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    return String(error.code).slice(0, 128);
  }
  if (error instanceof Error && error.name.length > 0) return error.name.slice(0, 128);
  return "PROJECTION_RECLAMATION_FAILED";
}

export class ProjectionReaderLeaseRegistry {
  readonly #entries = new Map<string, LeaseEntry>();
  readonly #syncDirectory: DirectorySync;

  constructor(syncDirectory: DirectorySync = fsyncDirectory) {
    this.#syncDirectory = syncDirectory;
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
      const stat = lstatSync(generation.databasePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new ProjectionLeaseUnavailableError();
    } catch (error) {
      if (error instanceof ProjectionLeaseUnavailableError) throw error;
      if (notFound(error)) throw new ProjectionLeaseUnavailableError();
      throw error;
    }
    const entry = current ?? {
      generation,
      leases: 0,
      retired: false,
      fileRemoved: false,
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
        this.#attemptReclamation(id, entry);
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
      fileRemoved: false,
      attempts: 0,
      lastErrorCode: null,
    };
    entry.retired = true;
    this.#entries.set(id, entry);
    this.#attemptReclamation(id, entry);
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
    for (const [id, entry] of this.#entries) this.#attemptReclamation(id, entry);
  }

  #attemptReclamation(id: string, entry: LeaseEntry): void {
    if (!entry.retired || entry.leases !== 0) return;
    entry.attempts += 1;
    try {
      if (!entry.fileRemoved) {
        try {
          const stat = lstatSync(entry.generation.databasePath);
          if (!stat.isFile() || stat.isSymbolicLink()) {
            throw new Error("PROJECTION_LEASE_PATH_INVALID");
          }
          unlinkSync(entry.generation.databasePath);
        } catch (error) {
          if (!notFound(error)) throw error;
        }
        entry.fileRemoved = true;
      }
      this.#syncDirectory(entry.generation.projectionDirectory);
    } catch (error) {
      entry.lastErrorCode = safeErrorCode(error);
      return;
    }
    this.#entries.delete(id);
  }
}
