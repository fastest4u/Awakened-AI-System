import assert from "node:assert/strict";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import type { ProjectBinding } from "../src/orchestrator/projections/contracts.js";
import {
  parseProjectionManifest,
  publishProjectionManifest,
  serializeProjectionManifest,
  verifyProjectionPublicationPaths,
} from "../src/orchestrator/projections/manifest.js";

const BINDING: ProjectBinding = Object.freeze({
  projectId: "1".repeat(64) as ProjectBinding["projectId"],
  vaultId: "2".repeat(64) as ProjectBinding["vaultId"],
  storeId: "3".repeat(64) as ProjectBinding["storeId"],
  workspaceId: "4".repeat(64) as ProjectBinding["workspaceId"],
  branchScopeId: "00000000-0000-4000-8000-000000000041" as ProjectBinding["branchScopeId"],
  branchRef: "refs/heads/projection-contracts",
  sessionId: null,
});
const HASH = "a".repeat(64);
const CORE_CHECKSUMS = Object.freeze({
  artifactsFiles: "c".repeat(64),
  canonicalItems: "d".repeat(64),
  entityGraph: "e".repeat(64),
  lexicalChunks: "f".repeat(64),
  retrievalFeedback: "5".repeat(64),
  sessionTree: "6".repeat(64),
  tasksFollowups: "7".repeat(64),
});
const roots: string[] = [];

function manifest(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    projectId: BINDING.projectId,
    vaultId: BINDING.vaultId,
    storeId: BINDING.storeId,
    workspaceId: BINDING.workspaceId,
    branchScopeId: BINDING.branchScopeId,
    branchRef: BINDING.branchRef,
    sessionId: null,
    generation: 2,
    terminalEventPosition: "17",
    terminalEventHash: HASH,
    databaseFile: "projections-1-2.sqlite",
    databaseSha256: "b".repeat(64),
    coreChecksums: CORE_CHECKSUMS,
    createdAt: "2026-08-23T02:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("immutable projection manifest", () => {
  it("parses exact own data and binds every project/workspace/branch scope field", () => {
    const parsed = parseProjectionManifest(manifest(), BINDING);

    assert.equal(parsed.generation, 2);
    assert.equal(parsed.sessionId, null);
    assert.equal(Object.isFrozen(parsed), true);
    assert.equal(Object.isFrozen(parsed.coreChecksums), true);
    assert.deepEqual(parsed.coreChecksums, CORE_CHECKSUMS);

    for (const [field, value] of [
      ["projectId", "9".repeat(64)],
      ["vaultId", "9".repeat(64)],
      ["storeId", "9".repeat(64)],
      ["workspaceId", "9".repeat(64)],
      ["branchScopeId", null],
      ["branchRef", "refs/heads/other"],
    ] as const) {
      assert.throws(
        () => parseProjectionManifest(manifest({ [field]: value }), BINDING),
        /PROJECTION_MANIFEST_INVALID/u,
        field,
      );
    }
    assert.throws(
      () => parseProjectionManifest(manifest(), { ...BINDING, projectId: "9".repeat(64) as never }),
      /PROJECTION_MANIFEST_INVALID/u,
    );
    assert.throws(
      () => parseProjectionManifest(manifest(), {
        ...BINDING,
        sessionId: "00000000-0000-4000-8000-000000000042",
      }),
      /PROJECTION_MANIFEST_INVALID/u,
    );
  });

  it("rejects aliases, traversal, noncanonical identities and hashes, and oversized checksum maps", () => {
    const invalid = [
      manifest({ databaseFile: "../projections-1-2.sqlite" }),
      manifest({ databaseFile: ".\\projections-1-2.sqlite" }),
      manifest({ databaseFile: "PROJECTIONS-1-2.SQLITE" }),
      manifest({ databaseFile: "projections-01-2.sqlite" }),
      manifest({ terminalEventPosition: "017" }),
      manifest({ terminalEventPosition: "9223372036854775808" }),
      manifest({ terminalEventHash: HASH.toUpperCase() }),
      manifest({ databaseSha256: "b".repeat(63) }),
      manifest({ sessionId: "00000000-0000-4000-8000-000000000042" }),
      manifest({ coreChecksums: {} }),
      manifest({ coreChecksums: { sessionTree: "6".repeat(64) } }),
      manifest({ coreChecksums: { session_tree: "c".repeat(64) } }),
      manifest({ coreChecksums: Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => [`alias${index}`, HASH])) }),
      { ...manifest(), manifestPath: "projection-manifest.json" },
      Object.assign(Object.create({ inherited: true }) as object, manifest()),
    ];
    for (const candidate of invalid) {
      assert.throws(
        () => parseProjectionManifest(candidate, BINDING),
        /PROJECTION_MANIFEST_INVALID/u,
      );
    }

    let invoked = false;
    const accessor = manifest();
    Object.defineProperty(accessor, "databaseFile", {
      enumerable: true,
      get() {
        invoked = true;
        return "projections-1-2.sqlite";
      },
    });
    assert.throws(() => parseProjectionManifest(accessor, BINDING), /PROJECTION_MANIFEST_INVALID/u);
    assert.equal(invoked, false);

    const publishInput = {
      manifest: manifest(),
      expectedBinding: BINDING,
    } as Record<string, unknown>;
    Object.defineProperty(publishInput, "projectionDirectory", {
      enumerable: true,
      get() {
        invoked = true;
        return "C:\\untrusted";
      },
    });
    assert.throws(
      () => publishProjectionManifest(publishInput as never),
      /PROJECTION_MANIFEST_INVALID|PROJECTION_MANIFEST_PATH_INVALID/u,
    );
    assert.equal(invoked, false);
  });

  it("serializes canonical bytes and publishes only through a safe projection directory", (t) => {
    const root = mkdtempSync(join(tmpdir(), "projection-manifest-"));
    roots.push(root);
    const parsed = parseProjectionManifest(manifest(), BINDING);
    writeFileSync(join(root, parsed.databaseFile), "independent projection", "utf8");
    const expected = `${JSON.stringify({
      branchRef: BINDING.branchRef,
      branchScopeId: BINDING.branchScopeId,
      coreChecksums: CORE_CHECKSUMS,
      createdAt: "2026-08-23T02:00:00.000Z",
      databaseFile: "projections-1-2.sqlite",
      databaseSha256: "b".repeat(64),
      generation: 2,
      projectId: BINDING.projectId,
      schemaVersion: 1,
      sessionId: null,
      storeId: BINDING.storeId,
      terminalEventHash: HASH,
      terminalEventPosition: "17",
      vaultId: BINDING.vaultId,
      workspaceId: BINDING.workspaceId,
    })}\n`;

    assert.equal(Buffer.from(serializeProjectionManifest(parsed)).toString("utf8"), expected);
    const target = publishProjectionManifest({
      projectionDirectory: root,
      manifest: parsed,
      expectedBinding: BINDING,
    });
    assert.equal(target, join(root, "projection-manifest.json"));
    assert.equal(readFileSync(target, "utf8"), expected);
    assert.equal(lstatSync(target).isSymbolicLink(), false);

    const outside = mkdtempSync(join(tmpdir(), "projection-manifest-outside-"));
    roots.push(outside);
    const alias = join(root, "alias");
    try {
      symlinkSync(outside, alias, "junction");
    } catch (error) {
      t.diagnostic(`symlink creation unavailable: ${String(error)}`);
      return;
    }
    assert.throws(
      () => publishProjectionManifest({
        projectionDirectory: alias,
        manifest: parsed,
        expectedBinding: BINDING,
      }),
      /PROJECTION_MANIFEST_PATH_INVALID|MATERIALIZATION_CONFLICT/u,
    );
    assert.equal(readFileSync(target, "utf8"), expected);
  });

  it("refuses to replace a manifest target that is a symlink", (t) => {
    const root = mkdtempSync(join(tmpdir(), "projection-manifest-target-"));
    roots.push(root);
    const outside = join(root, "outside.json");
    const target = join(root, "projection-manifest.json");
    writeFileSync(outside, "outside", "utf8");
    writeFileSync(join(root, "projections-1-2.sqlite"), "independent projection", "utf8");
    try {
      symlinkSync(outside, target);
    } catch (error) {
      t.skip(`symlink creation unavailable: ${String(error)}`);
      return;
    }
    assert.throws(
      () => publishProjectionManifest({
        projectionDirectory: root,
        manifest: manifest(),
        expectedBinding: BINDING,
      }),
      /MATERIALIZATION_CONFLICT/u,
    );
    assert.equal(readFileSync(outside, "utf8"), "outside");
  });

  it("fails closed on symlinks through the production path-verification boundary", () => {
    const root = mkdtempSync(join(tmpdir(), "projection-manifest-inspection-"));
    roots.push(root);
    const databaseFile = "projections-1-2.sqlite";
    const databasePath = join(root, databaseFile);
    writeFileSync(databasePath, "independent projection", "utf8");
    const regularDirectory = {
      isDirectory: () => true,
      isFile: () => false,
      isSymbolicLink: () => false,
    };
    const regularFile = {
      isDirectory: () => false,
      isFile: () => true,
      isSymbolicLink: () => false,
    };
    const symlink = {
      isDirectory: () => false,
      isFile: () => false,
      isSymbolicLink: () => true,
    };

    assert.throws(
      () => verifyProjectionPublicationPaths(root, databaseFile, {
        lstat: (path) => path === root ? symlink : regularFile,
        realpath: (path) => path,
      }),
      /PROJECTION_MANIFEST_PATH_INVALID/u,
    );
    assert.throws(
      () => verifyProjectionPublicationPaths(root, databaseFile, {
        lstat: (path) => path === root ? regularDirectory : symlink,
        realpath: (path) => path,
      }),
      /PROJECTION_MANIFEST_PATH_INVALID/u,
    );
  });
});
