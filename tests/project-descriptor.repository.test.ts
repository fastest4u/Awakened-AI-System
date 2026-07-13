import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  assertContainedPath,
  canonicalExistingDirectory,
} from "../src/orchestrator/identity/canonical-path.js";
import {
  ProjectDescriptorRepository,
  type ProjectDescriptorDependencies,
} from "../src/orchestrator/identity/project-descriptor.repository.js";

describe("canonical project paths", () => {
  let root: string;
  let projectRoot: string;
  let vaultRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "memory-paths-"));
    projectRoot = join(root, "project");
    vaultRoot = join(projectRoot, "memory");
    mkdirSync(vaultRoot, { recursive: true });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("resolves an existing directory through the native real path", () => {
    assert.equal(canonicalExistingDirectory(projectRoot), resolve(realpathSync.native(projectRoot)));
  });

  it("rejects empty, missing, and non-directory paths", () => {
    assert.throws(() => canonicalExistingDirectory(""));
    assert.throws(() => canonicalExistingDirectory("   "));
    assert.throws(() => canonicalExistingDirectory(join(root, "missing")));

    const filePath = join(root, "file.txt");
    writeFileSync(filePath, "not a directory");
    assert.throws(() => canonicalExistingDirectory(filePath));
  });

  it("allows the root itself and descendants, including a segment beginning with two dots", () => {
    const dottedDirectory = join(projectRoot, "..cache");
    mkdirSync(dottedDirectory);
    const canonicalProject = canonicalExistingDirectory(projectRoot);

    assert.doesNotThrow(() => assertContainedPath(canonicalProject, canonicalProject));
    assert.doesNotThrow(() => assertContainedPath(canonicalProject, canonicalExistingDirectory(vaultRoot)));
    assert.doesNotThrow(() => assertContainedPath(canonicalProject, canonicalExistingDirectory(dottedDirectory)));
  });

  it("rejects empty inputs, parent traversal, prefix siblings, and different Windows volumes", () => {
    const canonicalProject = canonicalExistingDirectory(projectRoot);
    assert.throws(() => assertContainedPath("", canonicalProject));
    assert.throws(() => assertContainedPath(canonicalProject, ""));
    assert.throws(() => assertContainedPath(canonicalProject, canonicalExistingDirectory(root)));

    const prefixSibling = join(root, "project-copy");
    mkdirSync(prefixSibling);
    assert.throws(() => assertContainedPath(canonicalProject, canonicalExistingDirectory(prefixSibling)));

    if (process.platform === "win32") {
      assert.doesNotThrow(() => assertContainedPath(
        canonicalProject.replace(/^([A-Z]):/, (_match: string, drive: string) => `${drive.toLowerCase()}:`),
        canonicalExistingDirectory(vaultRoot),
      ));
      assert.throws(() => assertContainedPath("C:\\project", "D:\\project\\memory"));
    }
  });
});

describe("ProjectDescriptorRepository", () => {
  let root: string;
  let projectRoot: string;
  let vaultRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "memory-identity-"));
    projectRoot = join(root, "project");
    vaultRoot = join(projectRoot, "memory");
    mkdirSync(vaultRoot, { recursive: true });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reports missing without creating files or directories", () => {
    const repository = new ProjectDescriptorRepository();
    const result = repository.inspect(vaultRoot);

    assert.equal(result.status, "missing");
    assert.equal(result.path, join(vaultRoot, ".memory-mcp", "project-identity.json"));
    assert.equal(existsSync(join(vaultRoot, ".memory-mcp")), false);
  });

  it("creates one strict descriptor only through the explicit method", () => {
    const repository = new ProjectDescriptorRepository({
      now: () => "2026-07-11T00:00:00.000Z",
      randomId: (() => {
        const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
        return () => ids.shift()!;
      })(),
    });

    const descriptor = repository.createExplicit(projectRoot, vaultRoot);
    assert.equal(descriptor.projectId, "11111111-1111-4111-8111-111111111111");
    assert.equal(descriptor.vaultId, "22222222-2222-4222-8222-222222222222");
    assert.deepEqual(repository.inspect(vaultRoot), {
      status: "valid",
      path: join(vaultRoot, ".memory-mcp", "project-identity.json"),
      descriptor,
    });
    assert.equal(
      readFileSync(join(vaultRoot, ".memory-mcp", "project-identity.json"), "utf8"),
      `${JSON.stringify(descriptor, null, 2)}\n`,
    );
  });

  it("replays the vault ancestor barrier when a contender pre-created the descriptor directory", () => {
    const canonicalVaultRoot = resolve(realpathSync.native(vaultRoot));
    const descriptorDirectory = join(canonicalVaultRoot, ".memory-mcp");
    const publishedPath = join(descriptorDirectory, "project-identity.json");
    mkdirSync(descriptorDirectory, { recursive: true });
    const barriers: Array<{
      path: string;
      directoryExists: boolean;
      published: boolean;
      temporaryCount: number;
    }> = [];
    const dependencies: ProjectDescriptorDependencies = {
      now: () => "2026-07-11T00:00:00.000Z",
      randomId: (() => {
        const ids = [
          "11111111-1111-4111-8111-111111111111",
          "22222222-2222-4222-8222-222222222222",
        ];
        return () => ids.shift()!;
      })(),
      syncDirectory(path: string): void {
        const directoryExists = existsSync(descriptorDirectory);
        const entries = directoryExists ? readdirSync(descriptorDirectory) : [];
        barriers.push({
          path,
          directoryExists,
          published: existsSync(publishedPath),
          temporaryCount: entries.filter((entry) => entry.endsWith(".tmp")).length,
        });
      },
    };

    new ProjectDescriptorRepository(dependencies).createExplicit(projectRoot, vaultRoot);

    assert.deepEqual(barriers, [
      {
        path: canonicalVaultRoot,
        directoryExists: true,
        published: false,
        temporaryCount: 0,
      },
      {
        path: descriptorDirectory,
        directoryExists: true,
        published: true,
        temporaryCount: 1,
      },
      {
        path: descriptorDirectory,
        directoryExists: true,
        published: true,
        temporaryCount: 0,
      },
    ]);
  });

  it("fails closed when a directory durability barrier fails", () => {
    const failure = Object.assign(new Error("descriptor directory durability failed"), {
      code: "EIO",
    });
    const dependencies: ProjectDescriptorDependencies = {
      now: () => "2026-07-11T00:00:00.000Z",
      randomId: (() => {
        const ids = [
          "11111111-1111-4111-8111-111111111111",
          "22222222-2222-4222-8222-222222222222",
        ];
        return () => ids.shift()!;
      })(),
      syncDirectory(): never {
        throw failure;
      },
    };

    assert.throws(
      () => new ProjectDescriptorRepository(dependencies).createExplicit(projectRoot, vaultRoot),
      (error: unknown) => error === failure,
    );
    assert.equal(existsSync(join(vaultRoot, ".memory-mcp", "project-identity.json")), false);
  });

  it("never overwrites an existing descriptor and removes its temporary publication name", () => {
    const repository = new ProjectDescriptorRepository();
    const first = repository.createExplicit(projectRoot, vaultRoot);

    assert.throws(() => repository.createExplicit(projectRoot, vaultRoot), /PROJECT_DESCRIPTOR_EXISTS/);
    const descriptorDirectory = join(vaultRoot, ".memory-mcp");
    const saved = JSON.parse(readFileSync(join(descriptorDirectory, "project-identity.json"), "utf8"));
    assert.equal(saved.projectId, first.projectId);
    assert.deepEqual(readdirSync(descriptorDirectory), ["project-identity.json"]);
  });

  it("rejects extra fields and malformed identity", () => {
    const directory = join(vaultRoot, ".memory-mcp");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "project-identity.json"), JSON.stringify({
      schemaVersion: 1,
      projectId: "x",
      vaultId: "y",
      createdAt: "now",
      extra: true,
    }));

    const result = new ProjectDescriptorRepository().inspect(vaultRoot);
    assert.equal(result.status, "invalid");
    if (result.status === "invalid") assert.ok(result.issues.length > 0);
  });

  it("reports malformed JSON and invalid RFC3339 timestamps without changing either file", () => {
    const directory = join(vaultRoot, ".memory-mcp");
    const descriptorPath = join(directory, "project-identity.json");
    mkdirSync(directory, { recursive: true });
    writeFileSync(descriptorPath, "{malformed");
    assert.equal(new ProjectDescriptorRepository().inspect(vaultRoot).status, "invalid");
    assert.equal(readFileSync(descriptorPath, "utf8"), "{malformed");

    const invalidTimestamp = JSON.stringify({
      schemaVersion: 1,
      projectId: "11111111-1111-4111-8111-111111111111",
      vaultId: "22222222-2222-4222-8222-222222222222",
      createdAt: "2026-07-11",
    });
    writeFileSync(descriptorPath, invalidTimestamp);
    assert.equal(new ProjectDescriptorRepository().inspect(vaultRoot).status, "invalid");
    assert.equal(readFileSync(descriptorPath, "utf8"), invalidTimestamp);
  });

  it("rejects a vault outside the project before creating descriptor state", () => {
    const externalVault = join(root, "external-memory");
    mkdirSync(externalVault);

    assert.throws(() => new ProjectDescriptorRepository().createExplicit(projectRoot, externalVault));
    assert.equal(existsSync(join(externalVault, ".memory-mcp")), false);
  });

  it("does not publish through a descriptor-directory link outside the vault", () => {
    const externalDirectory = join(root, "external-descriptor-directory");
    mkdirSync(externalDirectory);
    symlinkSync(
      externalDirectory,
      join(vaultRoot, ".memory-mcp"),
      process.platform === "win32" ? "junction" : "dir",
    );

    assert.throws(() => new ProjectDescriptorRepository().createExplicit(projectRoot, vaultRoot));
    assert.equal(existsSync(join(externalDirectory, "project-identity.json")), false);
  });

  it("rejects a valid descriptor reached through an external directory reparse point", () => {
    const externalDirectory = join(root, "external-descriptor-authority");
    mkdirSync(externalDirectory);
    writeFileSync(
      join(externalDirectory, "project-identity.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        projectId: "11111111-1111-4111-8111-111111111111",
        vaultId: "22222222-2222-4222-8222-222222222222",
        createdAt: "2026-07-11T00:00:00.000Z",
      })}\n`,
    );
    symlinkSync(
      externalDirectory,
      join(vaultRoot, ".memory-mcp"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const inspection = new ProjectDescriptorRepository().inspect(vaultRoot);

    assert.equal(inspection.status, "invalid");
    if (inspection.status === "invalid") {
      assert.deepEqual(inspection.issues, ["PROJECT_DESCRIPTOR_INVALID"]);
    }
  });

  it("rejects a direct descriptor file symlink or Windows authority reparse point", () => {
    const descriptorDirectory = join(vaultRoot, ".memory-mcp");
    mkdirSync(descriptorDirectory);
    const externalPath = join(root, "external-project-identity.json");
    writeFileSync(
      externalPath,
      `${JSON.stringify({
        schemaVersion: 1,
        projectId: "11111111-1111-4111-8111-111111111111",
        vaultId: "22222222-2222-4222-8222-222222222222",
        createdAt: "2026-07-11T00:00:00.000Z",
      })}\n`,
    );
    try {
      symlinkSync(externalPath, join(descriptorDirectory, "project-identity.json"), "file");
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "";
      if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) {
        const fallbackDirectory = join(root, "external-descriptor-reparse-directory");
        mkdirSync(fallbackDirectory);
        symlinkSync(
          fallbackDirectory,
          join(descriptorDirectory, "project-identity.json"),
          "junction",
        );
      } else {
        throw error;
      }
    }

    const inspection = new ProjectDescriptorRepository().inspect(vaultRoot);

    assert.equal(inspection.status, "invalid");
    if (inspection.status === "invalid") {
      assert.deepEqual(inspection.issues, ["PROJECT_DESCRIPTOR_INVALID"]);
    }
  });

  it("validates generated identity before creating descriptor state", () => {
    const repository = new ProjectDescriptorRepository({
      now: () => "not-a-timestamp",
      randomId: () => "not-a-uuid",
    });

    assert.throws(() => repository.createExplicit(projectRoot, vaultRoot));
    assert.equal(existsSync(join(vaultRoot, ".memory-mcp")), false);
  });
});
