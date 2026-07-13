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
import { join, resolve, sep } from "node:path";
import { afterEach, describe, it } from "node:test";
import type {
  GitWorkspaceSnapshot,
  NonGitWorkspaceSnapshot,
  ProjectDescriptorV1,
  ProjectId,
  ProjectStoreRoute,
  StoreId,
  VaultId,
  WorkspaceId,
} from "../src/orchestrator/identity/contracts.js";
import { ProjectStoreRouter } from "../src/orchestrator/identity/project-store.router.js";
import {
  parseStoreManifest,
  type StoreManifestV1,
} from "../src/orchestrator/identity/store-manifest.schema.js";
import { StoreManifestRepository } from "../src/orchestrator/identity/store-manifest.repository.js";
import type { StoreManifestRepositoryDependencies } from "../src/orchestrator/identity/store-manifest.repository.js";

const descriptor: ProjectDescriptorV1 = {
  schemaVersion: 1,
  projectId: "11111111-1111-4111-8111-111111111111" as ProjectId,
  vaultId: "22222222-2222-4222-8222-222222222222" as VaultId,
  createdAt: "2026-07-12T00:00:00.000Z",
};

const validManifest: StoreManifestV1 = {
  schemaVersion: 1,
  storeId: "33333333-3333-4333-8333-333333333333" as StoreManifestV1["storeId"],
  projectId: descriptor.projectId,
  vaultId: descriptor.vaultId,
  createdAt: "2026-07-12T00:01:00.000Z",
  lastIntegrity: { status: "never" },
};

describe("store manifest schema", () => {
  it("parses the exact V1 manifest shape", () => {
    assert.deepEqual(parseStoreManifest(validManifest), validManifest);
  });

  it("accepts valid leap-day timestamps with colonized numeric offsets", () => {
    const manifest: StoreManifestV1 = {
      ...validManifest,
      createdAt: "2024-02-29T23:59:59.123456789+02:30",
      lastIntegrity: {
        status: "passed",
        checkedAt: "2024-02-29T21:29:59.123456789-00:00",
        schemaFingerprint: "schema-v1",
        terminalEventHash: "event-hash",
      },
    };

    assert.deepEqual(parseStoreManifest(manifest), manifest);
  });

  it("rejects non-UUID store, project, and vault identities", () => {
    for (const field of ["storeId", "projectId", "vaultId"] as const) {
      assert.throws(() => parseStoreManifest({ ...validManifest, [field]: "not-a-uuid" }), field);
    }
  });

  it("rejects a createdAt value without an RFC3339 offset", () => {
    assert.throws(() => parseStoreManifest({ ...validManifest, createdAt: "2026-07-12" }));
  });

  it("rejects an integrity checkedAt value without an RFC3339 offset", () => {
    assert.throws(() => parseStoreManifest({
      ...validManifest,
      lastIntegrity: {
        status: "passed",
        checkedAt: "2026-07-12",
        schemaFingerprint: "schema-v1",
        terminalEventHash: "event-hash",
      },
    }));
  });

  for (const [caseName, invalidTimestamp] of [
    ["a colonless numeric offset", "2026-07-12T00:01:00+0200"],
    ["an impossible calendar date", "2026-02-30T00:01:00Z"],
    ["24:00 as a time", "2026-07-12T24:00:00Z"],
  ] as const) {
    it(`rejects ${caseName} in createdAt`, () => {
      const createdAt = invalidTimestamp;
      assert.throws(() => parseStoreManifest({ ...validManifest, createdAt }), createdAt);
    });

    it(`rejects ${caseName} in integrity checkedAt`, () => {
      const checkedAt = invalidTimestamp;
      assert.throws(() => parseStoreManifest({
        ...validManifest,
        lastIntegrity: {
          status: "passed",
          checkedAt,
          schemaFingerprint: "schema-v1",
          terminalEventHash: "event-hash",
        },
      }), checkedAt);
    });
  }

  it("rejects unknown root and integrity fields", () => {
    assert.throws(() => parseStoreManifest({ ...validManifest, extra: true }));
    assert.throws(() => parseStoreManifest({
      ...validManifest,
      lastIntegrity: { status: "never", extra: true },
    }));
  });
});

describe("ProjectStoreRouter", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it("routes a Git workspace beneath its common directory without creating state", () => {
    root = mkdtempSync(join(tmpdir(), "memory-store-route-"));
    const vaultRoot = join(root, "vault");
    const gitCommonDir = join(root, "repo", ".git");
    const gitDir = join(gitCommonDir, "worktrees", "feature");
    const worktreeRoot = join(root, "repo-feature");
    mkdirSync(vaultRoot, { recursive: true });
    mkdirSync(gitDir, { recursive: true });
    mkdirSync(worktreeRoot, { recursive: true });
    const workspace: GitWorkspaceSnapshot = {
      kind: "git",
      worktreeRoot: resolve(realpathSync.native(worktreeRoot)),
      gitDir: resolve(realpathSync.native(gitDir)),
      gitCommonDir: resolve(realpathSync.native(gitCommonDir)),
      headCommit: "0123456789abcdef0123456789abcdef01234567",
      branchRef: "refs/heads/feature",
      detached: false,
      workspaceId: "workspace-a" as WorkspaceId,
    };

    const route = new ProjectStoreRouter().route(descriptor, vaultRoot, workspace);
    const expectedRoot = join(gitCommonDir, "project-memory", descriptor.projectId, "v2");
    assert.deepEqual(route, {
      kind: "git-common",
      storeRoot: expectedRoot,
      eventsPath: join(expectedRoot, "events.sqlite"),
      storeManifestPath: join(expectedRoot, "store-manifest.json"),
      projectionManifestPath: join(expectedRoot, "current-projection.json"),
    });
    assert.equal(existsSync(join(gitCommonDir, "project-memory")), false);
  });

  it("routes a non-Git workspace beneath the canonical vault without creating state", () => {
    root = mkdtempSync(join(tmpdir(), "memory-store-route-non-git-"));
    const vaultRoot = join(root, "vault with spaces");
    const workspaceRoot = join(root, "โครงการ plain");
    mkdirSync(vaultRoot, { recursive: true });
    mkdirSync(workspaceRoot, { recursive: true });
    const workspace: NonGitWorkspaceSnapshot = {
      kind: "non-git",
      workspaceRoot: resolve(realpathSync.native(workspaceRoot)),
      workspaceId: "workspace-non-git" as WorkspaceId,
    };

    const route = new ProjectStoreRouter().route(descriptor, vaultRoot, workspace);
    const expectedRoot = join(resolve(realpathSync.native(vaultRoot)), ".memory-mcp", "v2");
    assert.deepEqual(route, {
      kind: "vault-local",
      storeRoot: expectedRoot,
      eventsPath: join(expectedRoot, "events.sqlite"),
      storeManifestPath: join(expectedRoot, "store-manifest.json"),
      projectionManifestPath: join(expectedRoot, "current-projection.json"),
    });
    assert.equal(existsSync(join(vaultRoot, ".memory-mcp")), false);
    assert.equal("gitDir" in workspace, false);
    assert.equal("gitCommonDir" in workspace, false);
  });

  it("routes distinct linked-worktree identities to the same Git-common store", () => {
    root = mkdtempSync(join(tmpdir(), "memory-store-route-linked-"));
    const vaultRoot = join(root, "vault");
    const gitCommonDir = join(root, "repo", ".git");
    const firstGitDir = join(gitCommonDir, "worktrees", "first");
    const secondGitDir = join(gitCommonDir, "worktrees", "second");
    const firstRoot = join(root, "worktree first");
    const secondRoot = join(root, "สำเนา second");
    mkdirSync(vaultRoot, { recursive: true });
    mkdirSync(firstGitDir, { recursive: true });
    mkdirSync(secondGitDir, { recursive: true });
    mkdirSync(firstRoot);
    mkdirSync(secondRoot);
    const workspace = (worktreeRoot: string, gitDir: string, workspaceId: string): GitWorkspaceSnapshot => ({
      kind: "git",
      worktreeRoot: resolve(realpathSync.native(worktreeRoot)),
      gitDir: resolve(realpathSync.native(gitDir)),
      gitCommonDir: resolve(realpathSync.native(gitCommonDir)),
      headCommit: "0123456789abcdef0123456789abcdef01234567",
      branchRef: "refs/heads/feature",
      detached: false,
      workspaceId: workspaceId as WorkspaceId,
    });
    const first = workspace(firstRoot, firstGitDir, "workspace-first");
    const second = workspace(secondRoot, secondGitDir, "workspace-second");

    assert.notEqual(first.workspaceId, second.workspaceId);
    assert.equal(
      new ProjectStoreRouter().route(descriptor, vaultRoot, first).storeRoot,
      new ProjectStoreRouter().route(descriptor, vaultRoot, second).storeRoot,
    );
    assert.equal(existsSync(join(gitCommonDir, "project-memory")), false);
  });
});

describe("StoreManifestRepository", () => {
  let root: string | undefined;
  let vaultRoot: string;
  let workspaceRoot: string;
  let route: ProjectStoreRoute;

  const identity = {
    storeId: validManifest.storeId as StoreId,
    projectId: descriptor.projectId,
    vaultId: descriptor.vaultId,
  };

  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  const arrangeRoute = (): void => {
    root = mkdtempSync(join(tmpdir(), "memory-store-manifest-"));
    vaultRoot = join(root, "vault");
    workspaceRoot = join(root, "workspace");
    mkdirSync(vaultRoot);
    mkdirSync(workspaceRoot);
    route = new ProjectStoreRouter().route(descriptor, vaultRoot, {
      kind: "non-git",
      workspaceRoot: resolve(realpathSync.native(workspaceRoot)),
      workspaceId: "manifest-workspace" as WorkspaceId,
    });
  };

  it("reports a missing manifest without creating store state", () => {
    arrangeRoute();

    assert.deepEqual(new StoreManifestRepository().inspect(route, identity), {
      status: "missing",
      path: route.storeManifestPath,
    });
    assert.equal(existsSync(route.storeRoot), false);
  });

  it("explicitly creates a manifest with the caller-supplied store identity", () => {
    arrangeRoute();
    const repository = new StoreManifestRepository({
      now: () => "2026-07-12T00:01:00.000Z",
    });

    const manifest = repository.createExplicit(route, identity);

    assert.deepEqual(manifest, validManifest);
    assert.deepEqual(repository.inspect(route, identity), {
      status: "valid",
      path: route.storeManifestPath,
      manifest,
    });
    assert.equal(
      readFileSync(route.storeManifestPath, "utf8"),
      `${JSON.stringify(validManifest, null, 2)}\n`,
    );
  });

  it("syncs created ancestors, hard-link publication, and temporary cleanup in durability order", () => {
    arrangeRoute();
    const publicationParent = resolve(vaultRoot, ".memory-mcp");
    const barriers: Array<{
      path: string;
      published: boolean;
      temporaryCount: number;
    }> = [];
    const dependencies: StoreManifestRepositoryDependencies = {
      now: () => "2026-07-12T00:01:00.000Z",
      syncDirectory(path: string): void {
        const entries = existsSync(route.storeRoot) ? readdirSync(route.storeRoot) : [];
        barriers.push({
          path,
          published: existsSync(route.storeManifestPath),
          temporaryCount: entries.filter((entry) => entry.endsWith(".tmp")).length,
        });
      },
    };

    new StoreManifestRepository(dependencies).createExplicit(route, identity);

    assert.deepEqual(barriers, [
      { path: resolve(vaultRoot), published: false, temporaryCount: 0 },
      { path: publicationParent, published: false, temporaryCount: 0 },
      { path: route.storeRoot, published: true, temporaryCount: 1 },
      { path: route.storeRoot, published: true, temporaryCount: 0 },
    ]);
  });

  it("fails closed when a manifest directory durability barrier fails", () => {
    arrangeRoute();
    const failure = Object.assign(new Error("manifest directory durability failed"), {
      code: "EIO",
    });
    const dependencies: StoreManifestRepositoryDependencies = {
      now: () => "2026-07-12T00:01:00.000Z",
      syncDirectory(): never {
        throw failure;
      },
    };

    assert.throws(
      () => new StoreManifestRepository(dependencies).createExplicit(route, identity),
      (error: unknown) => error === failure,
    );
    assert.equal(existsSync(route.storeManifestPath), false);
  });

  it("never overwrites an existing manifest and cleans its contender temporary file", () => {
    arrangeRoute();
    const repository = new StoreManifestRepository({
      now: () => "2026-07-12T00:01:00.000Z",
    });
    const first = repository.createExplicit(route, identity);
    const firstBytes = readFileSync(route.storeManifestPath, "utf8");

    assert.throws(
      () => repository.createExplicit(route, {
        ...identity,
        storeId: "44444444-4444-4444-8444-444444444444" as StoreId,
      }),
      /STORE_MANIFEST_EXISTS/,
    );

    assert.equal(readFileSync(route.storeManifestPath, "utf8"), firstBytes);
    assert.equal(JSON.parse(firstBytes).storeId, first.storeId);
    assert.deepEqual(readdirSync(route.storeRoot), ["store-manifest.json"]);
  });

  it("classifies strict-schema and expected project identity mismatches as invalid", () => {
    arrangeRoute();
    const repository = new StoreManifestRepository({
      now: () => "2026-07-12T00:01:00.000Z",
    });
    repository.createExplicit(route, identity);
    const originalBytes = readFileSync(route.storeManifestPath, "utf8");

    const projectMismatch = repository.inspect(route, {
      ...identity,
      projectId: "55555555-5555-4555-8555-555555555555" as ProjectId,
    });
    assert.equal(projectMismatch.status, "invalid");
    if (projectMismatch.status === "invalid") {
      assert.deepEqual(projectMismatch.issues, ["STORE_MANIFEST_PROJECT_ID_MISMATCH"]);
    }
    const vaultMismatch = repository.inspect(route, {
      ...identity,
      vaultId: "66666666-6666-4666-8666-666666666666" as VaultId,
    });
    assert.equal(vaultMismatch.status, "invalid");
    if (vaultMismatch.status === "invalid") {
      assert.deepEqual(vaultMismatch.issues, ["STORE_MANIFEST_VAULT_ID_MISMATCH"]);
    }
    assert.equal(readFileSync(route.storeManifestPath, "utf8"), originalBytes);

    const strictViolation = JSON.stringify({ ...validManifest, unexpected: true });
    writeFileSync(route.storeManifestPath, strictViolation);
    assert.equal(repository.inspect(route, identity).status, "invalid");
    assert.equal(readFileSync(route.storeManifestPath, "utf8"), strictViolation);
  });

  it("rejects a valid manifest reached through an external store-root reparse point", () => {
    arrangeRoute();
    const externalStoreRoot = join(root!, "external-store-authority");
    mkdirSync(externalStoreRoot);
    writeFileSync(
      join(externalStoreRoot, "store-manifest.json"),
      `${JSON.stringify(validManifest, null, 2)}\n`,
    );
    mkdirSync(resolve(vaultRoot, ".memory-mcp"));
    symlinkSync(
      externalStoreRoot,
      route.storeRoot,
      process.platform === "win32" ? "junction" : "dir",
    );

    const inspection = new StoreManifestRepository().inspect(route, identity);

    assert.equal(inspection.status, "invalid");
    if (inspection.status === "invalid") {
      assert.deepEqual(inspection.issues, ["STORE_ROUTE_INVALID"]);
    }
  });

  it("rejects a direct manifest file symlink or Windows authority reparse point", () => {
    arrangeRoute();
    mkdirSync(route.storeRoot, { recursive: true });
    const externalPath = join(root!, "external-store-manifest.json");
    writeFileSync(externalPath, `${JSON.stringify(validManifest, null, 2)}\n`);
    try {
      symlinkSync(externalPath, route.storeManifestPath, "file");
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "";
      if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) {
        const fallbackDirectory = join(root!, "external-manifest-reparse-directory");
        mkdirSync(fallbackDirectory);
        symlinkSync(fallbackDirectory, route.storeManifestPath, "junction");
      } else {
        throw error;
      }
    }

    const inspection = new StoreManifestRepository().inspect(route, identity);

    assert.equal(inspection.status, "invalid");
    if (inspection.status === "invalid") {
      assert.deepEqual(inspection.issues, ["STORE_ROUTE_INVALID"]);
    }
  });

  it("rejects manifest authority input outside the declared store root for reads and writes", () => {
    arrangeRoute();
    mkdirSync(route.storeRoot, { recursive: true });
    const externalRoot = join(root!, "external-manifest-authority");
    mkdirSync(externalRoot);
    const externalManifestPath = join(externalRoot, "store-manifest.json");
    const originalBytes = `${JSON.stringify(validManifest, null, 2)}\n`;
    writeFileSync(externalManifestPath, originalBytes);
    const escapedRoute: ProjectStoreRoute = {
      ...route,
      storeManifestPath: externalManifestPath,
    };
    const repository = new StoreManifestRepository({
      now: () => "2026-07-12T00:02:00.000Z",
    });

    const inspection = repository.inspect(escapedRoute, identity);
    assert.equal(inspection.status, "invalid");
    if (inspection.status === "invalid") {
      assert.deepEqual(inspection.issues, ["STORE_ROUTE_INVALID"]);
    }
    assert.throws(
      () => repository.createExplicit(escapedRoute, identity),
      /STORE_ROUTE_INVALID/,
    );
    assert.throws(
      () => repository.recordIntegrity(escapedRoute, identity, {
        ok: true,
        schemaFingerprint: "schema-v1",
        terminalEventHash: "event-hash",
      }),
      /STORE_ROUTE_INVALID/,
    );
    assert.equal(readFileSync(externalManifestPath, "utf8"), originalBytes);
  });

  it("rejects a noncanonical lexical alias for the manifest authority file", () => {
    arrangeRoute();
    const repository = new StoreManifestRepository({
      now: () => "2026-07-12T00:01:00.000Z",
    });
    repository.createExplicit(route, identity);
    mkdirSync(join(route.storeRoot, "nested"));
    const aliasedRoute: ProjectStoreRoute = {
      ...route,
      storeManifestPath: `${route.storeRoot}${sep}nested${sep}..${sep}store-manifest.json`,
    };

    const inspection = repository.inspect(aliasedRoute, identity);

    assert.equal(inspection.status, "invalid");
    if (inspection.status === "invalid") {
      assert.deepEqual(inspection.issues, ["STORE_ROUTE_INVALID"]);
    }
  });

  it("atomically records integrity while preserving immutable manifest identity", () => {
    arrangeRoute();
    const times = [
      "2026-07-12T00:01:00.000Z",
      "2026-07-12T00:02:00.000Z",
    ];
    const repository = new StoreManifestRepository({ now: () => times.shift()! });
    const created = repository.createExplicit(route, identity);

    const updated = repository.recordIntegrity(route, identity, {
      ok: true,
      schemaFingerprint: "schema-v1",
      terminalEventHash: "event-hash",
    });

    assert.deepEqual(updated, {
      ...created,
      lastIntegrity: {
        status: "passed",
        checkedAt: "2026-07-12T00:02:00.000Z",
        schemaFingerprint: "schema-v1",
        terminalEventHash: "event-hash",
      },
    });
    assert.deepEqual(repository.inspect(route, identity), {
      status: "valid",
      path: route.storeManifestPath,
      manifest: updated,
    });
    assert.deepEqual(readdirSync(route.storeRoot), ["store-manifest.json"]);
  });

  it("syncs the replacement directory only after integrity bytes are renamed into place", () => {
    arrangeRoute();
    const observed: Array<{
      path: string;
      status: string;
      temporaryCount: number;
    }> = [];
    const dependencies: StoreManifestRepositoryDependencies = {
      now: (() => {
        const times = [
          "2026-07-12T00:01:00.000Z",
          "2026-07-12T00:02:00.000Z",
        ];
        return () => times.shift()!;
      })(),
      syncDirectory(path: string): void {
        if (!existsSync(route.storeManifestPath)) return;
        const manifest = JSON.parse(readFileSync(route.storeManifestPath, "utf8")) as {
          lastIntegrity: { status: string };
        };
        observed.push({
          path,
          status: manifest.lastIntegrity.status,
          temporaryCount: readdirSync(route.storeRoot)
            .filter((entry) => entry.endsWith(".tmp")).length,
        });
      },
    };
    const repository = new StoreManifestRepository(dependencies);
    repository.createExplicit(route, identity);
    observed.splice(0);

    repository.recordIntegrity(route, identity, {
      ok: true,
      schemaFingerprint: "schema-v1",
      terminalEventHash: "event-hash",
    });

    assert.deepEqual(observed, [{
      path: route.storeRoot,
      status: "passed",
      temporaryCount: 0,
    }]);
  });

  it("refuses integrity updates for a mismatched store identity without changing bytes", () => {
    arrangeRoute();
    const repository = new StoreManifestRepository({
      now: () => "2026-07-12T00:01:00.000Z",
    });
    repository.createExplicit(route, identity);
    const originalBytes = readFileSync(route.storeManifestPath, "utf8");

    assert.throws(() => repository.recordIntegrity(route, {
      ...identity,
      storeId: "77777777-7777-4777-8777-777777777777" as StoreId,
    }, {
      ok: false,
      schemaFingerprint: "schema-v1",
      terminalEventHash: "event-hash",
    }), /STORE_MANIFEST_IDENTITY_MISMATCH/);

    assert.equal(readFileSync(route.storeManifestPath, "utf8"), originalBytes);
    assert.deepEqual(readdirSync(route.storeRoot), ["store-manifest.json"]);
  });
});
