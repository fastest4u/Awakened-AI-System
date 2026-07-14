import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  linkSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { ZodError } from "zod";
import { canonicalExistingDirectory } from "./canonical-path.js";
import type {
  ProjectId,
  ProjectStoreRoute,
  StoreId,
  VaultId,
} from "./contracts.js";
import {
  createDirectoryDurably,
  fsyncDirectory,
  type DirectorySync,
} from "./directory-durability.js";
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
  syncDirectory?: DirectorySync;
}

interface ResolvedStoreManifestRepositoryDependencies {
  now: () => string;
  syncDirectory: DirectorySync;
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

function unlinkTemporary(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    return false;
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isLexicallyCanonical(path: string): boolean {
  const normalized = resolve(path);
  return process.platform === "win32"
    ? path.toLowerCase() === normalized.toLowerCase()
    : path === normalized;
}

function routeInvalid(): Error {
  return new Error("STORE_ROUTE_INVALID");
}

function assertManifestRouteShape(route: ProjectStoreRoute): void {
  if (
    !isAbsolute(route.storeRoot)
    || !isAbsolute(route.storeManifestPath)
    || !isLexicallyCanonical(route.storeRoot)
    || !isLexicallyCanonical(route.storeManifestPath)
    || !samePath(dirname(route.storeManifestPath), route.storeRoot)
    || basename(route.storeManifestPath) !== "store-manifest.json"
  ) {
    throw routeInvalid();
  }
}

function manifestDurableBase(route: ProjectStoreRoute, projectId: ProjectId): string {
  assertManifestRouteShape(route);
  if (basename(route.storeRoot) !== "v2") throw routeInvalid();

  let requestedBase: string;
  if (route.kind === "vault-local") {
    const authorityDirectory = dirname(route.storeRoot);
    if (basename(authorityDirectory) !== ".memory-mcp") throw routeInvalid();
    requestedBase = dirname(authorityDirectory);
  } else if (route.kind === "git-common") {
    const projectDirectory = dirname(route.storeRoot);
    const projectMemoryDirectory = dirname(projectDirectory);
    if (
      basename(projectDirectory) !== projectId
      || basename(projectMemoryDirectory) !== "project-memory"
    ) {
      throw routeInvalid();
    }
    requestedBase = dirname(projectMemoryDirectory);
  } else {
    throw routeInvalid();
  }

  let canonicalBase: string;
  try {
    canonicalBase = canonicalExistingDirectory(requestedBase);
  } catch {
    throw routeInvalid();
  }
  if (!samePath(canonicalBase, requestedBase)) throw routeInvalid();
  return canonicalBase;
}

function assertCanonicalExistingAncestor(path: string): void {
  let cursor = resolve(path);
  while (true) {
    try {
      const authority = lstatSync(cursor);
      if (authority.isSymbolicLink()) throw routeInvalid();
      const canonical = resolve(realpathSync.native(cursor));
      if (!samePath(canonical, cursor)) throw routeInvalid();
      return;
    } catch (error) {
      if (error instanceof Error && error.message === "STORE_ROUTE_INVALID") throw error;
      if (errorCode(error) !== "ENOENT") throw routeInvalid();
      const parent = dirname(cursor);
      if (parent === cursor) throw routeInvalid();
      cursor = parent;
    }
  }
}

type ManifestAuthorityStatus = "regular" | "missing";

function manifestAuthorityStatus(
  route: ProjectStoreRoute,
  projectId: ProjectId,
): ManifestAuthorityStatus {
  manifestDurableBase(route, projectId);
  assertCanonicalExistingAncestor(route.storeRoot);

  let root;
  try {
    root = lstatSync(route.storeRoot);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "missing";
    throw routeInvalid();
  }
  if (root.isSymbolicLink() || !root.isDirectory()) throw routeInvalid();
  const canonicalRoot = resolve(realpathSync.native(route.storeRoot));
  if (!samePath(canonicalRoot, route.storeRoot)) throw routeInvalid();

  let authority;
  try {
    authority = lstatSync(route.storeManifestPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "missing";
    throw routeInvalid();
  }
  if (authority.isSymbolicLink() || !authority.isFile()) throw routeInvalid();
  const canonicalManifest = resolve(realpathSync.native(route.storeManifestPath));
  if (
    !samePath(canonicalManifest, route.storeManifestPath)
    || !samePath(dirname(canonicalManifest), canonicalRoot)
  ) {
    throw routeInvalid();
  }
  return "regular";
}

export class StoreManifestRepository {
  private readonly dependencies: ResolvedStoreManifestRepositoryDependencies;

  constructor(dependencies: StoreManifestRepositoryDependencies = {
    now: () => new Date().toISOString(),
  }) {
    this.dependencies = {
      now: dependencies.now,
      syncDirectory: dependencies.syncDirectory ?? fsyncDirectory,
    };
  }

  inspect(
    route: ProjectStoreRoute,
    expected: ExpectedStoreManifestIdentity,
  ): StoreManifestInspection {
    let authority: ManifestAuthorityStatus;
    try {
      authority = manifestAuthorityStatus(route, expected.projectId);
    } catch {
      return {
        status: "invalid",
        path: route.storeManifestPath,
        issues: ["STORE_ROUTE_INVALID"],
      };
    }
    if (authority === "missing") {
      return { status: "missing", path: route.storeManifestPath };
    }
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

    const durableBase = manifestDurableBase(route, identity.projectId);
    assertCanonicalExistingAncestor(route.storeRoot);
    createDirectoryDurably(route.storeRoot, durableBase, this.dependencies.syncDirectory);
    manifestAuthorityStatus(route, identity.projectId);
    const publicationDirectory = canonicalExistingDirectory(dirname(route.storeManifestPath));
    if (!samePath(publicationDirectory, route.storeRoot)) throw routeInvalid();
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
      this.dependencies.syncDirectory(publicationDirectory);
      return manifest;
    } finally {
      if (temporaryCreated && unlinkTemporary(temporaryPath)) {
        this.dependencies.syncDirectory(publicationDirectory);
      }
    }
  }

  recordIntegrity(
    route: ProjectStoreRoute,
    expected: StoreManifestIdentity,
    result: StoreIntegrityResult,
  ): StoreManifestV1 {
    if (manifestAuthorityStatus(route, expected.projectId) !== "regular") throw routeInvalid();
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
    if (!samePath(publicationDirectory, route.storeRoot)) throw routeInvalid();
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
      this.dependencies.syncDirectory(publicationDirectory);
      return updated;
    } finally {
      if (temporaryCreated && unlinkTemporary(temporaryPath)) {
        this.dependencies.syncDirectory(publicationDirectory);
      }
    }
  }
}
