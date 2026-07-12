import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ZodError } from "zod";
import { canonicalExistingDirectory } from "./canonical-path.js";
import type {
  ProjectId,
  ProjectStoreRoute,
  StoreId,
  VaultId,
} from "./contracts.js";
import {
  parseStoreManifest,
  type StoreManifestV1,
} from "./store-manifest.schema.js";

export interface StoreManifestIdentity {
  storeId: StoreId;
  projectId: ProjectId;
  vaultId: VaultId;
}

export interface ExpectedStoreManifestIdentity {
  projectId: ProjectId;
  vaultId: VaultId;
  storeId?: StoreId;
}

export type StoreManifestInspection =
  | { status: "valid"; path: string; manifest: StoreManifestV1 }
  | { status: "missing"; path: string }
  | { status: "invalid"; path: string; issues: string[] };

export interface StoreManifestRepositoryDependencies {
  now: () => string;
}

export interface StoreIntegrityResult {
  ok: boolean;
  schemaFingerprint: string;
  terminalEventHash: string;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function inspectionIssues(error: unknown): string[] {
  if (error instanceof ZodError) {
    return error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `${path}: ${issue.message}`;
    });
  }
  return [error instanceof Error ? error.message : String(error)];
}

function unlinkTemporary(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

export class StoreManifestRepository {
  constructor(private readonly dependencies: StoreManifestRepositoryDependencies = {
    now: () => new Date().toISOString(),
  }) {}

  inspect(
    route: ProjectStoreRoute,
    expected: ExpectedStoreManifestIdentity,
  ): StoreManifestInspection {
    let source: string;
    try {
      source = readFileSync(route.storeManifestPath, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return { status: "missing", path: route.storeManifestPath };
      }
      return {
        status: "invalid",
        path: route.storeManifestPath,
        issues: inspectionIssues(error),
      };
    }

    try {
      const manifest = parseStoreManifest(JSON.parse(source) as unknown);
      const issues: string[] = [];
      if (manifest.projectId !== expected.projectId) {
        issues.push("STORE_MANIFEST_PROJECT_ID_MISMATCH");
      }
      if (manifest.vaultId !== expected.vaultId) {
        issues.push("STORE_MANIFEST_VAULT_ID_MISMATCH");
      }
      if (expected.storeId !== undefined && manifest.storeId !== expected.storeId) {
        issues.push("STORE_MANIFEST_STORE_ID_MISMATCH");
      }
      return issues.length === 0
        ? { status: "valid", path: route.storeManifestPath, manifest }
        : { status: "invalid", path: route.storeManifestPath, issues };
    } catch (error) {
      return {
        status: "invalid",
        path: route.storeManifestPath,
        issues: inspectionIssues(error),
      };
    }
  }

  createExplicit(
    route: ProjectStoreRoute,
    identity: StoreManifestIdentity,
  ): StoreManifestV1 {
    const manifest = parseStoreManifest({
      schemaVersion: 1,
      storeId: identity.storeId,
      projectId: identity.projectId,
      vaultId: identity.vaultId,
      createdAt: this.dependencies.now(),
      lastIntegrity: { status: "never" },
    });

    mkdirSync(route.storeRoot, { recursive: true });
    const publicationDirectory = canonicalExistingDirectory(dirname(route.storeManifestPath));
    const publishedPath = join(publicationDirectory, "store-manifest.json");
    const temporaryPath = join(
      publicationDirectory,
      `.store-manifest.json.${process.pid}.${randomUUID()}.tmp`,
    );
    let temporaryCreated = false;

    try {
      const handle = openSync(temporaryPath, "wx", 0o600);
      temporaryCreated = true;
      try {
        writeFileSync(handle, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }

      try {
        linkSync(temporaryPath, publishedPath);
      } catch (error) {
        if (errorCode(error) === "EEXIST") {
          throw new Error("STORE_MANIFEST_EXISTS", { cause: error });
        }
        throw error;
      }
      return manifest;
    } finally {
      if (temporaryCreated) unlinkTemporary(temporaryPath);
    }
  }

  recordIntegrity(
    route: ProjectStoreRoute,
    expected: StoreManifestIdentity,
    result: StoreIntegrityResult,
  ): StoreManifestV1 {
    const current = parseStoreManifest(
      JSON.parse(readFileSync(route.storeManifestPath, "utf8")) as unknown,
    );
    if (
      current.storeId !== expected.storeId
      || current.projectId !== expected.projectId
      || current.vaultId !== expected.vaultId
    ) {
      throw new Error("STORE_MANIFEST_IDENTITY_MISMATCH");
    }
    if (typeof result.ok !== "boolean") throw new Error("STORE_INTEGRITY_RESULT_INVALID");

    const updated = parseStoreManifest({
      ...current,
      lastIntegrity: {
        status: result.ok ? "passed" : "failed",
        checkedAt: this.dependencies.now(),
        schemaFingerprint: result.schemaFingerprint,
        terminalEventHash: result.terminalEventHash,
      },
    });
    const publicationDirectory = canonicalExistingDirectory(dirname(route.storeManifestPath));
    const publishedPath = join(publicationDirectory, "store-manifest.json");
    const temporaryPath = join(
      publicationDirectory,
      `.store-manifest.json.${process.pid}.${randomUUID()}.tmp`,
    );
    let temporaryCreated = false;

    try {
      const handle = openSync(temporaryPath, "wx", 0o600);
      temporaryCreated = true;
      try {
        writeFileSync(handle, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }
      renameSync(temporaryPath, publishedPath);
      temporaryCreated = false;
      return updated;
    } finally {
      if (temporaryCreated) unlinkTemporary(temporaryPath);
    }
  }
}
