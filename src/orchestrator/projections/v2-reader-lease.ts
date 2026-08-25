import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { LifecycleError } from "../lifecycle/errors.js";
import { openImmutableProjectionImage } from "./integrity.js";
import type { ProjectionManifestV2 } from "./manifest.js";
import type { StableProjectionGenerationImage } from "./stable-directory.js";

export interface VerifiedV2ProjectionImage {
  readonly database: DatabaseSync;
  readonly sha256: string;
  close(): void;
}

export interface V2ProjectionReaderLease {
  readonly manifest: ProjectionManifestV2;
  readonly database: DatabaseSync;
  close(): void;
}

export interface LeasableV2ProjectionGeneration {
  readonly manifest: ProjectionManifestV2;
  readonly image: StableProjectionGenerationImage;
}

export class V2ProjectionLeaseUnavailableError extends Error {
  readonly code = "PROJECTION_LEASE_UNAVAILABLE" as const;

  constructor() {
    super("PROJECTION_LEASE_UNAVAILABLE");
    this.name = "V2ProjectionLeaseUnavailableError";
  }
}

function integrity(): never {
  throw new LifecycleError("INTEGRITY_FAILURE");
}

/** Opens a verified detached V2 generation image without retaining a pathname. */
export function openVerifiedV2ProjectionImage(
  image: StableProjectionGenerationImage,
  manifest: ProjectionManifestV2,
  busyTimeoutMs?: number,
): VerifiedV2ProjectionImage {
  let database: DatabaseSync | undefined;
  try {
    if (
      image.identity.filename !== manifest.databaseFile
      || image.identity.sha256 !== manifest.databaseSha256
      || createHash("sha256").update(image.bytes).digest("hex") !== manifest.databaseSha256
    ) return integrity();
    database = openImmutableProjectionImage(image.bytes, busyTimeoutMs);
    const openedDatabase = database;
    let closed = false;
    return Object.freeze({
      database: openedDatabase,
      sha256: manifest.databaseSha256,
      close(): void {
        if (closed) return;
        closed = true;
        openedDatabase.close();
      },
    });
  } catch {
    try { database?.close(); } catch { /* preserve fail-closed integrity result */ }
    return integrity();
  }
}

export class V2ProjectionReaderLeaseRegistry {
  readonly #activeFilenames = new Map<string, number>();

  acquire(generation: LeasableV2ProjectionGeneration): V2ProjectionReaderLease {
    const filename = generation.manifest.databaseFile;
    const image = openVerifiedV2ProjectionImage(generation.image, generation.manifest);
    const current = this.#activeFilenames.get(filename);
    if (
      current !== undefined
      && (!Number.isSafeInteger(current) || current < 1 || current === Number.MAX_SAFE_INTEGER)
    ) {
      try { image.close(); } catch { /* preserve fail-closed integrity result */ }
      return integrity();
    }
    this.#activeFilenames.set(filename, (current ?? 0) + 1);
    let closed = false;
    return Object.freeze({
      manifest: generation.manifest,
      database: image.database,
      close: (): void => {
        if (closed) return;
        closed = true;
        try {
          image.close();
        } finally {
          const active = this.#activeFilenames.get(filename);
          if (typeof active !== "number" || !Number.isSafeInteger(active) || active < 1) {
            this.#activeFilenames.delete(filename);
            return integrity();
          }
          if (active === 1) this.#activeFilenames.delete(filename);
          else this.#activeFilenames.set(filename, active - 1);
        }
      },
    });
  }

  activeFilenames(): readonly string[] {
    const filenames: string[] = [];
    for (const [filename, active] of this.#activeFilenames) {
      if (typeof active !== "number" || !Number.isSafeInteger(active) || active < 1) {
        return integrity();
      }
      filenames.push(filename);
    }
    return Object.freeze(filenames.sort((left, right) => left.localeCompare(right)));
  }
}
