import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ZodError } from "zod";
import { assertContainedPath, canonicalExistingDirectory } from "./canonical-path.js";
import type { ProjectDescriptorV1 } from "./contracts.js";
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
}

function descriptorPath(vaultRoot: string): string {
  return join(vaultRoot, DESCRIPTOR_DIRECTORY_NAME, DESCRIPTOR_FILE_NAME);
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

export class ProjectDescriptorRepository {
  constructor(private readonly dependencies: ProjectDescriptorDependencies = {
    now: () => new Date().toISOString(),
    randomId: randomUUID,
  }) {}

  inspect(vaultRoot: string): DescriptorInspection {
    const path = descriptorPath(vaultRoot);
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
    mkdirSync(requestedDirectory, { recursive: true });
    const publicationDirectory = canonicalExistingDirectory(requestedDirectory);
    assertContainedPath(canonicalVaultRoot, publicationDirectory);

    const publishedPath = join(publicationDirectory, DESCRIPTOR_FILE_NAME);
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
      return descriptor;
    } finally {
      if (temporaryCreated) unlinkTemporary(temporaryPath);
    }
  }
}
