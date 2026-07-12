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
import { ProjectDescriptorRepository } from "../src/orchestrator/identity/project-descriptor.repository.js";

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

  it("validates generated identity before creating descriptor state", () => {
    const repository = new ProjectDescriptorRepository({
      now: () => "not-a-timestamp",
      randomId: () => "not-a-uuid",
    });

    assert.throws(() => repository.createExplicit(projectRoot, vaultRoot));
    assert.equal(existsSync(join(vaultRoot, ".memory-mcp")), false);
  });
});
