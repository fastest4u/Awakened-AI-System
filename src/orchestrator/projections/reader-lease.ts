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
}

function key(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function notFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
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
    if (current?.retired === true) throw new Error("PROJECTION_GENERATION_RETIRED");
    const entry = current ?? { generation, leases: 0, retired: false };
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
        if (entry.leases < 0) throw new Error("PROJECTION_LEASE_UNDERFLOW");
        this.#reclaim(id, entry);
      },
    });
  }

  retire(generation: LeasableProjectionGeneration): void {
    const id = key(generation.databasePath);
    const current = this.#entries.get(id);
    const entry = current ?? { generation, leases: 0, retired: false };
    entry.retired = true;
    this.#entries.set(id, entry);
    this.#reclaim(id, entry);
  }

  #reclaim(id: string, entry: LeaseEntry): void {
    if (!entry.retired || entry.leases !== 0) return;
    try {
      const stat = lstatSync(entry.generation.databasePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error("PROJECTION_LEASE_PATH_INVALID");
      }
      unlinkSync(entry.generation.databasePath);
      this.#syncDirectory(entry.generation.projectionDirectory);
    } catch (error) {
      if (!notFound(error)) throw error;
    }
    this.#entries.delete(id);
  }
}
