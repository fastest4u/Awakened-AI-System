import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  linkSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ZodError } from "zod";
import { assertContainedPath, canonicalExistingDirectory } from "./canonical-path.js";
import type { ProjectDescriptorV1 } from "./contracts.js";
import {
  createDirectoryDurably,
  fsyncDirectory,
  type DirectorySync,
} from "./directory-durability.js";
import { parseProjectDescriptor } from "./project-descriptor.schema.js";

const DESCRIPTOR_DIRECTORY_NAME = ".memory-mcp";
const DESCRIPTOR_FILE_NAME = "project-identity.json";

export type DescriptorInspection =
  | { status: "valid"; path: string; descriptor: ProjectDescriptorV1 }
  | { status: "missing"; path: string }
  | { status: "invalid"; path: string; issues: string[] };

export interface ProjectDescriptorDependencies {
  now: () => string;
  randomId: () => string;
  syncDirectory?: DirectorySync;
}

interface ResolvedProjectDescriptorDependencies {
  now: () => string;
  randomId: () => string;
  syncDirectory: DirectorySync;
}

function descriptorPath(vaultRoot: string): string {
  return join(vaultRoot, DESCRIPTOR_DIRECTORY_NAME, DESCRIPTOR_FILE_NAME);
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
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

type DescriptorAuthorityStatus = "regular" | "missing" | "invalid";

function descriptorAuthorityStatus(
  vaultRoot: string,
  path: string,
): DescriptorAuthorityStatus {
  let canonicalVaultRoot: string;
  try {
    canonicalVaultRoot = canonicalExistingDirectory(vaultRoot);
  } catch {
    return "invalid";
  }
  const requestedDirectory = dirname(path);
  const expectedDirectory = join(canonicalVaultRoot, DESCRIPTOR_DIRECTORY_NAME);
  try {
    const directory = lstatSync(requestedDirectory);
    if (directory.isSymbolicLink() || !directory.isDirectory()) return "invalid";
    const canonicalDirectory = resolve(realpathSync.native(requestedDirectory));
    if (!samePath(canonicalDirectory, expectedDirectory)) return "invalid";
  } catch (error) {
    return errorCode(error) === "ENOENT" ? "missing" : "invalid";
  }

  try {
    const authority = lstatSync(path);
    if (authority.isSymbolicLink() || !authority.isFile()) return "invalid";
    const canonicalPath = resolve(realpathSync.native(path));
    return samePath(canonicalPath, join(expectedDirectory, DESCRIPTOR_FILE_NAME))
      ? "regular"
      : "invalid";
  } catch (error) {
    return errorCode(error) === "ENOENT" ? "missing" : "invalid";
  }
}

export class ProjectDescriptorRepository {
  private readonly dependencies: ResolvedProjectDescriptorDependencies;

  constructor(dependencies: ProjectDescriptorDependencies = {
    now: () => new Date().toISOString(),
    randomId: randomUUID,
  }) {
    this.dependencies = {
      now: dependencies.now,
      randomId: dependencies.randomId,
      syncDirectory: dependencies.syncDirectory ?? fsyncDirectory,
    };
  }

  inspect(vaultRoot: string): DescriptorInspection {
    const path = descriptorPath(vaultRoot);
    const authority = descriptorAuthorityStatus(vaultRoot, path);
    if (authority === "missing") return { status: "missing", path };
    if (authority === "invalid") {
      return { status: "invalid", path, issues: ["PROJECT_DESCRIPTOR_INVALID"] };
    }
    let source: string;
    try {
      source = readFileSync(path, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { status: "missing", path };
      return { status: "invalid", path, issues: inspectionIssues(error) };
    }

    try {
      const descriptor = parseProjectDescriptor(JSON.parse(source) as unknown);
      return { status: "valid", path, descriptor };
    } catch (error) {
      return { status: "invalid", path, issues: inspectionIssues(error) };
    }
  }

  createExplicit(projectRoot: string, vaultRoot: string): ProjectDescriptorV1 {
    const canonicalProjectRoot = canonicalExistingDirectory(projectRoot);
    const canonicalVaultRoot = canonicalExistingDirectory(vaultRoot);
    assertContainedPath(canonicalProjectRoot, canonicalVaultRoot);

    const descriptor = parseProjectDescriptor({
      schemaVersion: 1,
      projectId: this.dependencies.randomId(),
      vaultId: this.dependencies.randomId(),
      createdAt: this.dependencies.now(),
    });

    const requestedDirectory = join(canonicalVaultRoot, DESCRIPTOR_DIRECTORY_NAME);
    createDirectoryDurably(requestedDirectory, this.dependencies.syncDirectory);
    const publicationDirectory = canonicalExistingDirectory(requestedDirectory);
    assertContainedPath(canonicalVaultRoot, publicationDirectory);

    const publishedPath = join(publicationDirectory, DESCRIPTOR_FILE_NAME);
    if (descriptorAuthorityStatus(canonicalVaultRoot, publishedPath) === "invalid") {
      throw new Error("PROJECT_DESCRIPTOR_INVALID");
    }
    const temporaryPath = join(
      publicationDirectory,
      `.${DESCRIPTOR_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`,
    );
    let temporaryCreated = false;

    try {
      const handle = openSync(temporaryPath, "wx", 0o600);
      temporaryCreated = true;
      try {
        writeFileSync(handle, `${JSON.stringify(descriptor, null, 2)}\n`, "utf8");
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }

      try {
        linkSync(temporaryPath, publishedPath);
      } catch (error) {
        if (errorCode(error) === "EEXIST") {
          throw new Error("PROJECT_DESCRIPTOR_EXISTS", { cause: error });
        }
        throw error;
      }
      this.dependencies.syncDirectory(publicationDirectory);
      return descriptor;
    } finally {
      if (temporaryCreated && unlinkTemporary(temporaryPath)) {
        this.dependencies.syncDirectory(publicationDirectory);
      }
    }
  }
}
