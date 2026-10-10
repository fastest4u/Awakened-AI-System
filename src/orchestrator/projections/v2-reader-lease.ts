import type { ProjectBinding } from "./contracts.js";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { LifecycleError } from "../lifecycle/errors.js";
import { openImmutableProjectionImage } from "./immutable-image.js";
import { parseRichProjectionManifest, type ProjectionManifestV2, type ProjectionManifestV3 } from "./manifest-codec.js";
import { assertCapturedProjectionV3Image } from "./captured-image-v3.js";
type RichManifest = ProjectionManifestV2 | ProjectionManifestV3;
import type {
  StableProjectionGenerationImage,
  StableProjectionGenerationIdentity,
} from "./stable-directory.js";

export interface VerifiedV2ProjectionImage {
  readonly database: DatabaseSync;
  readonly sha256: string;
  close(): void;
}

export interface V2ProjectionReaderLease {
  readonly manifest: RichManifest;
  readonly database: DatabaseSync;
  close(): void;
}

export interface LeasableV2ProjectionGeneration {
  readonly manifest: RichManifest;
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

function snapshotManifest(manifest: RichManifest): RichManifest {
  return parseRichProjectionManifest(manifest, Object.fromEntries(["projectId", "vaultId", "storeId", "workspaceId", "branchScopeId", "branchRef", "sessionId"].map(key => [key, Object.getOwnPropertyDescriptor(manifest, key)?.value])) as unknown as ProjectBinding);
}

function snapshotImageIdentity(
  identity: StableProjectionGenerationIdentity,
): StableProjectionGenerationIdentity {
  return Object.freeze({
    filename: identity.filename,
    device: identity.device,
    inode: identity.inode,
    size: identity.size,
    ctimeNs: identity.ctimeNs,
    sha256: identity.sha256,
  });
}

function snapshotImage(image: StableProjectionGenerationImage): StableProjectionGenerationImage {
  const identity = snapshotImageIdentity(image.identity);
  const bytes = Uint8Array.from(image.bytes);
  return Object.freeze({ identity, bytes });
}

function openVerifiedV2ProjectionImageSnapshot(
  identity: StableProjectionGenerationIdentity,
  bytes: Uint8Array,
  manifest: RichManifest,
  busyTimeoutMs?: number,
): VerifiedV2ProjectionImage {
  let database: DatabaseSync | undefined;
  try {
    if (
      identity.filename !== manifest.databaseFile
      || identity.sha256 !== manifest.databaseSha256
      || createHash("sha256").update(bytes).digest("hex") !== manifest.databaseSha256
    ) return integrity();
    database = openImmutableProjectionImage(bytes, busyTimeoutMs);
    if (manifest.schemaVersion === 3) assertCapturedProjectionV3Image(database, manifest);
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

/** Opens a verified detached V2 generation image without retaining a pathname. */
export function openVerifiedV2ProjectionImage(
  image: StableProjectionGenerationImage,
  manifest: RichManifest,
  busyTimeoutMs?: number,
): VerifiedV2ProjectionImage {
  try {
    const identity = snapshotImageIdentity(image.identity);
    if (manifest.schemaVersion === 3 && image.bytes.byteLength > 64 * 1024 * 1024) return integrity();
    const bytes = Uint8Array.from(image.bytes);
    return openVerifiedV2ProjectionImageSnapshot(
      identity,
      bytes,
      snapshotManifest(manifest),
      busyTimeoutMs,
    );
  } catch {
    return integrity();
  }
}

export class V2ProjectionReaderLeaseRegistry {
  readonly #activeFilenames = new Map<string, number>();

  acquire(generation: LeasableV2ProjectionGeneration): V2ProjectionReaderLease {
    let manifest: RichManifest;
    let stableImage: StableProjectionGenerationImage;
    try {
      manifest = snapshotManifest(generation.manifest);
      if (manifest.schemaVersion === 3 && generation.image.bytes.byteLength > 64 * 1024 * 1024) return integrity();
      stableImage = snapshotImage(generation.image);
    } catch {
      return integrity();
    }
    const bytes = stableImage.bytes;
    const image = openVerifiedV2ProjectionImageSnapshot(stableImage.identity, bytes, manifest);
    const filename = manifest.databaseFile;
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
      manifest,
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
