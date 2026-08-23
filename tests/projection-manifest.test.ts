import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { LifecycleError } from "../src/orchestrator/lifecycle/errors.js";
import type { ProjectBinding } from "../src/orchestrator/projections/contracts.js";
import {
  parseProjectionManifest,
  publishProjectionManifest,
  serializeProjectionManifest,
  verifyProjectionPublicationPaths,
} from "../src/orchestrator/projections/manifest.js";
import {
  filesystemStableProjectionDirectoryOperations,
  PROJECTION_MANIFEST_PUBLICATION_LOCK_FILENAME,
  type StableProjectionManifestSnapshot,
} from "../src/orchestrator/projections/stable-directory.js";

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

function missingEntry(): never {
  throw Object.assign(new Error("missing"), { code: "ENOENT" });
}

function installManifestFromIsolatedProcess(source: string, target: string): void {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      'const { renameSync } = require("node:fs"); renameSync(process.argv[1], process.argv[2]);',
      source,
      target,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
}

function publishManifestFromIsolatedProcess(
  projectionDirectory: string,
  candidate: unknown,
): Readonly<{ status: "published" } | { status: "rejected"; code: string | null }> {
  const moduleUrl = new URL(
    "../src/orchestrator/projections/manifest.js",
    import.meta.url,
  ).href;
  const script = String.raw`
const [moduleUrl, projectionDirectory, manifestJson, bindingJson] = process.argv.slice(1);
const { publishProjectionManifest } = await import(moduleUrl);
try {
  publishProjectionManifest({
    projectionDirectory,
    manifest: JSON.parse(manifestJson),
    expectedBinding: JSON.parse(bindingJson),
  });
  process.stdout.write(JSON.stringify({ status: "published" }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    status: "rejected",
    code: error && typeof error === "object" && "code" in error ? String(error.code) : null,
  }));
}
`;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      script,
      moduleUrl,
      projectionDirectory,
      JSON.stringify(candidate),
      JSON.stringify(BINDING),
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as Readonly<
    { status: "published" } | { status: "rejected"; code: string | null }
  >;
}

function publishedGeneration(target: string): number {
  return parseProjectionManifest(JSON.parse(readFileSync(target, "utf8")), BINDING).generation;
}

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

  it("rejects exact WAL and SHM sibling entries before replacing a manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "projection-manifest-sidecars-"));
    roots.push(root);
    const databaseFile = "projections-1-2.sqlite";
    const databasePath = join(root, databaseFile);
    const target = join(root, "projection-manifest.json");
    writeFileSync(databasePath, "independent projection", "utf8");
    writeFileSync(target, "previous manifest bytes", "utf8");
    writeFileSync(`${databasePath}-wal`, "unexpected WAL", "utf8");

    assert.throws(
      () => publishProjectionManifest({
        projectionDirectory: root,
        manifest: manifest(),
        expectedBinding: BINDING,
      }),
      (error: unknown) => error instanceof LifecycleError
        && error.code === "INTEGRITY_FAILURE",
    );
    assert.equal(readFileSync(target, "utf8"), "previous manifest bytes");

    rmSync(`${databasePath}-wal`);
    mkdirSync(`${databasePath}-shm`);
    assert.throws(
      () => verifyProjectionPublicationPaths(root, databaseFile),
      (error: unknown) => error instanceof LifecycleError
        && error.code === "INTEGRITY_FAILURE",
    );
  });

  for (const boundary of [
    "after-manifest-temp-fsync-before-replace",
    "after-manifest-replace-before-validation",
  ] as const) {
    it(`preserves the previous manifest when a sidecar appears at ${boundary}`, () => {
      const root = mkdtempSync(join(tmpdir(), "projection-manifest-publish-race-"));
      roots.push(root);
      const oldManifest = parseProjectionManifest(manifest({
        generation: 1,
        databaseFile: "projections-1-1.sqlite",
        terminalEventPosition: "16",
      }), BINDING);
      const newManifest = parseProjectionManifest(manifest(), BINDING);
      writeFileSync(join(root, oldManifest.databaseFile), "old independent projection", "utf8");
      writeFileSync(join(root, newManifest.databaseFile), "new independent projection", "utf8");
      const target = publishProjectionManifest({
        projectionDirectory: root,
        manifest: oldManifest,
        expectedBinding: BINDING,
      });
      const oldAuthority = readFileSync(target);
      let injected = false;

      assert.throws(
        () => publishProjectionManifest({
          projectionDirectory: root,
          manifest: newManifest,
          expectedBinding: BINDING,
        }, {
          faultInjector: {
            hit(actual): void {
              if (actual !== boundary || injected) return;
              injected = true;
              writeFileSync(
                join(root, `${newManifest.databaseFile}-wal`),
                "sidecar injected in manifest finalization window",
                "utf8",
              );
            },
          },
        }),
        (error: unknown) => error instanceof LifecycleError
          && error.code === "INTEGRITY_FAILURE",
      );
      assert.equal(injected, true);
      assert.deepEqual(readFileSync(target), oldAuthority);
      assert.equal(
        parseProjectionManifest(JSON.parse(readFileSync(target, "utf8")), BINDING).generation,
        oldManifest.generation,
      );
      assert.equal(existsSync(join(root, ".projection-manifest.json.tmp")), false);
      assert.equal(
        readFileSync(join(root, `${newManifest.databaseFile}-wal`), "utf8"),
        "sidecar injected in manifest finalization window",
      );
    });
  }

  it("does not roll an outer failure over a later successful nested publication", () => {
    const root = mkdtempSync(join(tmpdir(), "projection-manifest-nested-publish-"));
    roots.push(root);
    const first = parseProjectionManifest(manifest({
      generation: 1,
      databaseFile: "projections-1-1.sqlite",
      terminalEventPosition: "16",
    }), BINDING);
    const second = parseProjectionManifest(manifest(), BINDING);
    const third = parseProjectionManifest(manifest({
      generation: 3,
      databaseFile: "projections-1-3.sqlite",
      terminalEventPosition: "18",
    }), BINDING);
    for (const candidate of [first, second, third]) {
      writeFileSync(join(root, candidate.databaseFile), `generation ${candidate.generation}`, "utf8");
    }
    const target = publishProjectionManifest({
      projectionDirectory: root,
      manifest: first,
      expectedBinding: BINDING,
    });
    let nestedPublished = false;

    assert.throws(
      () => publishProjectionManifest({
        projectionDirectory: root,
        manifest: second,
        expectedBinding: BINDING,
      }, {
        faultInjector: {
          hit(boundary): void {
            if (boundary !== "after-manifest-replace-before-validation" || nestedPublished) return;
            nestedPublished = true;
            publishProjectionManifest({
              projectionDirectory: root,
              manifest: third,
              expectedBinding: BINDING,
            });
            assert.equal(
              parseProjectionManifest(JSON.parse(readFileSync(target, "utf8")), BINDING).generation,
              3,
            );
            writeFileSync(`${join(root, second.databaseFile)}-wal`, "outer sidecar failure", "utf8");
          },
        },
      }),
      (error: unknown) => error instanceof LifecycleError
        && error.code === "INTEGRITY_FAILURE",
    );
    assert.equal(nestedPublished, true);
    assert.equal(
      parseProjectionManifest(JSON.parse(readFileSync(target, "utf8")), BINDING).generation,
      3,
      "outer rollback must not overwrite the later successful publication",
    );
  });

  it("does not claim a later manifest first observed after its own target rename", () => {
    const root = mkdtempSync(join(tmpdir(), "projection-manifest-post-rename-observation-"));
    roots.push(root);
    const first = parseProjectionManifest(manifest({
      generation: 1,
      databaseFile: "projections-1-1.sqlite",
      terminalEventPosition: "16",
    }), BINDING);
    const second = parseProjectionManifest(manifest(), BINDING);
    const third = parseProjectionManifest(manifest({
      generation: 3,
      databaseFile: "projections-1-3.sqlite",
      terminalEventPosition: "18",
    }), BINDING);
    for (const candidate of [first, second, third]) {
      writeFileSync(join(root, candidate.databaseFile), `generation ${candidate.generation}`, "utf8");
    }
    const target = publishProjectionManifest({
      projectionDirectory: root,
      manifest: first,
      expectedBinding: BINDING,
    });
    let captures = 0;
    let nestedPublished = false;

    assert.throws(
      () => publishProjectionManifest({
        projectionDirectory: root,
        manifest: second,
        expectedBinding: BINDING,
      }, {
        directoryOperations: {
          ...filesystemStableProjectionDirectoryOperations,
          captureManifest(directory, identity): StableProjectionManifestSnapshot {
            captures += 1;
            if (captures === 3) {
              nestedPublished = true;
              publishProjectionManifest({
                projectionDirectory: root,
                manifest: third,
                expectedBinding: BINDING,
              });
            }
            return filesystemStableProjectionDirectoryOperations.captureManifest(
              directory,
              identity,
            );
          },
        },
      }),
      (error: unknown) => error instanceof LifecycleError
        && error.code === "MATERIALIZATION_CONFLICT"
        && error.retryable,
    );
    assert.equal(captures, 3, "an unowned observation must not enter rollback");
    assert.equal(nestedPublished, true);
    assert.equal(
      parseProjectionManifest(JSON.parse(readFileSync(target, "utf8")), BINDING).generation,
      3,
      "an observation of generation 3 cannot make the generation-2 attempt own generation 3",
    );
  });

  it("does not restore stale authority when a nested publish starts at rollback entry", () => {
    const root = mkdtempSync(join(tmpdir(), "projection-manifest-rollback-entry-"));
    roots.push(root);
    const first = parseProjectionManifest(manifest({
      generation: 1,
      databaseFile: "projections-1-1.sqlite",
      terminalEventPosition: "16",
    }), BINDING);
    const second = parseProjectionManifest(manifest(), BINDING);
    const third = parseProjectionManifest(manifest({
      generation: 3,
      databaseFile: "projections-1-3.sqlite",
      terminalEventPosition: "18",
    }), BINDING);
    for (const candidate of [first, second, third]) {
      writeFileSync(join(root, candidate.databaseFile), `generation ${candidate.generation}`, "utf8");
    }
    const target = publishProjectionManifest({
      projectionDirectory: root,
      manifest: first,
      expectedBinding: BINDING,
    });
    let captures = 0;
    let nestedPublished = false;

    assert.throws(
      () => publishProjectionManifest({
        projectionDirectory: root,
        manifest: second,
        expectedBinding: BINDING,
      }, {
        directoryOperations: {
          ...filesystemStableProjectionDirectoryOperations,
          captureManifest(directory, identity): StableProjectionManifestSnapshot {
            captures += 1;
            const snapshot = filesystemStableProjectionDirectoryOperations.captureManifest(
              directory,
              identity,
            );
            if (captures === 4) {
              nestedPublished = true;
              publishProjectionManifest({
                projectionDirectory: root,
                manifest: third,
                expectedBinding: BINDING,
              });
            }
            return snapshot;
          },
        },
        faultInjector: {
          hit(boundary): void {
            if (boundary === "after-manifest-replace-before-validation") {
              writeFileSync(
                `${join(root, second.databaseFile)}-wal`,
                "outer sidecar failure",
                "utf8",
              );
            }
          },
        },
      }),
      (error: unknown) => error instanceof LifecycleError
        && error.code === "INTEGRITY_FAILURE",
    );
    assert.equal(
      captures,
      4,
      "the publication epoch must stop rollback before a stale second comparison",
    );
    assert.equal(nestedPublished, true);
    assert.equal(
      parseProjectionManifest(JSON.parse(readFileSync(target, "utf8")), BINDING).generation,
      3,
    );
  });

  it("does not overwrite external authority installed after the final success snapshot", () => {
    const root = mkdtempSync(join(tmpdir(), "projection-manifest-external-success-gap-"));
    roots.push(root);
    const first = parseProjectionManifest(manifest({
      generation: 1,
      databaseFile: "projections-1-1.sqlite",
      terminalEventPosition: "16",
    }), BINDING);
    const second = parseProjectionManifest(manifest(), BINDING);
    const third = parseProjectionManifest(manifest({
      generation: 3,
      databaseFile: "projections-1-3.sqlite",
      terminalEventPosition: "18",
    }), BINDING);
    for (const candidate of [first, second, third]) {
      writeFileSync(join(root, candidate.databaseFile), `generation ${candidate.generation}`, "utf8");
    }
    const target = publishProjectionManifest({
      projectionDirectory: root,
      manifest: first,
      expectedBinding: BINDING,
    });
    const external = join(root, "external-generation-3.json");
    writeFileSync(external, serializeProjectionManifest(third));
    let captures = 0;
    let injected = false;

    assert.throws(
      () => publishProjectionManifest({
        projectionDirectory: root,
        manifest: second,
        expectedBinding: BINDING,
      }, {
        directoryOperations: {
          ...filesystemStableProjectionDirectoryOperations,
          captureManifest(directory, identity): StableProjectionManifestSnapshot {
            captures += 1;
            const snapshot = filesystemStableProjectionDirectoryOperations.captureManifest(
              directory,
              identity,
            );
            if (captures === 2) {
              installManifestFromIsolatedProcess(external, target);
              injected = true;
            }
            return snapshot;
          },
        },
      }),
      (error: unknown) => error instanceof LifecycleError
        && error.code === "MATERIALIZATION_CONFLICT"
        && error.retryable,
    );
    assert.equal(injected, true);
    assert.equal(publishedGeneration(target), 3);
  });

  it("does not overwrite external authority installed after the final rollback snapshot", () => {
    const root = mkdtempSync(join(tmpdir(), "projection-manifest-external-rollback-gap-"));
    roots.push(root);
    const first = parseProjectionManifest(manifest({
      generation: 1,
      databaseFile: "projections-1-1.sqlite",
      terminalEventPosition: "16",
    }), BINDING);
    const second = parseProjectionManifest(manifest(), BINDING);
    const third = parseProjectionManifest(manifest({
      generation: 3,
      databaseFile: "projections-1-3.sqlite",
      terminalEventPosition: "18",
    }), BINDING);
    for (const candidate of [first, second, third]) {
      writeFileSync(join(root, candidate.databaseFile), `generation ${candidate.generation}`, "utf8");
    }
    const target = publishProjectionManifest({
      projectionDirectory: root,
      manifest: first,
      expectedBinding: BINDING,
    });
    const external = join(root, "external-generation-3.json");
    writeFileSync(external, serializeProjectionManifest(third));
    let captures = 0;
    let injected = false;

    assert.throws(
      () => publishProjectionManifest({
        projectionDirectory: root,
        manifest: second,
        expectedBinding: BINDING,
      }, {
        directoryOperations: {
          ...filesystemStableProjectionDirectoryOperations,
          captureManifest(directory, identity): StableProjectionManifestSnapshot {
            captures += 1;
            const snapshot = filesystemStableProjectionDirectoryOperations.captureManifest(
              directory,
              identity,
            );
            if (captures === 5) {
              installManifestFromIsolatedProcess(external, target);
              injected = true;
            }
            return snapshot;
          },
        },
        faultInjector: {
          hit(boundary): void {
            if (boundary === "after-manifest-replace-before-validation") {
              writeFileSync(`${join(root, second.databaseFile)}-wal`, "outer failure", "utf8");
            }
          },
        },
      }),
      (error: unknown) => error instanceof LifecycleError
        && error.code === "INTEGRITY_FAILURE",
    );
    assert.equal(injected, true);
    assert.equal(publishedGeneration(target), 3);
  });

  it("restores prior authority after a nested publication attempt fails before replacement", () => {
    const root = mkdtempSync(join(tmpdir(), "projection-manifest-nested-failure-"));
    roots.push(root);
    const first = parseProjectionManifest(manifest({
      generation: 1,
      databaseFile: "projections-1-1.sqlite",
      terminalEventPosition: "16",
    }), BINDING);
    const second = parseProjectionManifest(manifest(), BINDING);
    const third = parseProjectionManifest(manifest({
      generation: 3,
      databaseFile: "projections-1-3.sqlite",
      terminalEventPosition: "18",
    }), BINDING);
    for (const candidate of [first, second, third]) {
      writeFileSync(join(root, candidate.databaseFile), `generation ${candidate.generation}`, "utf8");
    }
    const target = publishProjectionManifest({
      projectionDirectory: root,
      manifest: first,
      expectedBinding: BINDING,
    });
    let nestedFailed = false;

    assert.throws(
      () => publishProjectionManifest({
        projectionDirectory: root,
        manifest: second,
        expectedBinding: BINDING,
      }, {
        faultInjector: {
          hit(boundary): void {
            if (boundary !== "after-manifest-replace-before-validation") return;
            try {
              publishProjectionManifest({
                projectionDirectory: root,
                manifest: third,
                expectedBinding: BINDING,
              }, {
                faultInjector: {
                  hit(nestedBoundary): void {
                    if (nestedBoundary === "after-manifest-temp-fsync-before-replace") {
                      throw new Error("nested pre-replacement failure");
                    }
                  },
                },
              });
            } catch (error) {
              assert.match(String(error), /nested pre-replacement failure/u);
              nestedFailed = true;
            }
            writeFileSync(`${join(root, second.databaseFile)}-wal`, "outer failure", "utf8");
          },
        },
      }),
      (error: unknown) => error instanceof LifecycleError
        && error.code === "INTEGRITY_FAILURE",
    );
    assert.equal(nestedFailed, true);
    assert.equal(publishedGeneration(target), 1);
  });

  it("fences a cooperative isolated publisher for the complete outer transaction", () => {
    const root = mkdtempSync(join(tmpdir(), "projection-manifest-process-lock-"));
    roots.push(root);
    const first = parseProjectionManifest(manifest({
      generation: 1,
      databaseFile: "projections-1-1.sqlite",
      terminalEventPosition: "16",
    }), BINDING);
    const second = parseProjectionManifest(manifest(), BINDING);
    const third = parseProjectionManifest(manifest({
      generation: 3,
      databaseFile: "projections-1-3.sqlite",
      terminalEventPosition: "18",
    }), BINDING);
    for (const candidate of [first, second, third]) {
      writeFileSync(join(root, candidate.databaseFile), `generation ${candidate.generation}`, "utf8");
    }
    const target = publishProjectionManifest({
      projectionDirectory: root,
      manifest: first,
      expectedBinding: BINDING,
    });
    let isolatedResult: ReturnType<typeof publishManifestFromIsolatedProcess> | undefined;

    assert.throws(
      () => publishProjectionManifest({
        projectionDirectory: root,
        manifest: second,
        expectedBinding: BINDING,
      }, {
        faultInjector: {
          hit(boundary): void {
            if (boundary !== "after-manifest-replace-before-validation") return;
            isolatedResult = publishManifestFromIsolatedProcess(root, third);
            writeFileSync(`${join(root, second.databaseFile)}-wal`, "outer failure", "utf8");
          },
        },
      }),
      (error: unknown) => error instanceof LifecycleError
        && error.code === "INTEGRITY_FAILURE",
    );
    assert.deepEqual(isolatedResult, {
      status: "rejected",
      code: "MATERIALIZATION_CONFLICT",
    });
    assert.equal(publishedGeneration(target), 1);
  });

  it("fails closed on a foreign publication lock without stealing or rewriting it", () => {
    const root = mkdtempSync(join(tmpdir(), "projection-manifest-foreign-lock-"));
    roots.push(root);
    const first = parseProjectionManifest(manifest({
      generation: 1,
      databaseFile: "projections-1-1.sqlite",
      terminalEventPosition: "16",
    }), BINDING);
    const second = parseProjectionManifest(manifest(), BINDING);
    for (const candidate of [first, second]) {
      writeFileSync(join(root, candidate.databaseFile), `generation ${candidate.generation}`, "utf8");
    }
    const target = publishProjectionManifest({
      projectionDirectory: root,
      manifest: first,
      expectedBinding: BINDING,
    });
    const lockPath = join(root, PROJECTION_MANIFEST_PUBLICATION_LOCK_FILENAME);
    writeFileSync(lockPath, "foreign producer lock", "utf8");

    assert.throws(
      () => publishProjectionManifest({
        projectionDirectory: root,
        manifest: second,
        expectedBinding: BINDING,
      }),
      (error: unknown) => error instanceof LifecycleError
        && error.code === "MATERIALIZATION_CONFLICT"
        && error.retryable,
    );
    assert.equal(readFileSync(lockPath, "utf8"), "foreign producer lock");
    assert.equal(publishedGeneration(target), 1);
  });

  it("does not replace a manifest source changed after prior capture", () => {
    const root = mkdtempSync(join(tmpdir(), "projection-manifest-source-cas-"));
    roots.push(root);
    const first = parseProjectionManifest(manifest({
      generation: 1,
      databaseFile: "projections-1-1.sqlite",
      terminalEventPosition: "16",
    }), BINDING);
    const second = parseProjectionManifest(manifest(), BINDING);
    const third = parseProjectionManifest(manifest({
      generation: 3,
      databaseFile: "projections-1-3.sqlite",
      terminalEventPosition: "18",
    }), BINDING);
    for (const candidate of [first, second, third]) {
      writeFileSync(join(root, candidate.databaseFile), `generation ${candidate.generation}`, "utf8");
    }
    const target = publishProjectionManifest({
      projectionDirectory: root,
      manifest: first,
      expectedBinding: BINDING,
    });
    const concurrent = join(root, "concurrent-manifest.json");
    writeFileSync(concurrent, serializeProjectionManifest(third));
    let replacedByConcurrent = false;

    assert.throws(
      () => publishProjectionManifest({
        projectionDirectory: root,
        manifest: second,
        expectedBinding: BINDING,
      }, {
        faultInjector: {
          hit(boundary): void {
            if (boundary !== "after-manifest-temp-fsync-before-replace" || replacedByConcurrent) return;
            replacedByConcurrent = true;
            renameSync(concurrent, target);
          },
        },
      }),
      (error: unknown) => error instanceof LifecycleError
        && error.code === "MATERIALIZATION_CONFLICT"
        && error.retryable
        && error.recoveryActions.includes("reconcile-materialization"),
    );
    assert.equal(replacedByConcurrent, true);
    assert.equal(
      parseProjectionManifest(JSON.parse(readFileSync(target, "utf8")), BINDING).generation,
      3,
    );
  });

  it("removes only its own failed first publication when no prior manifest exists", () => {
    const root = mkdtempSync(join(tmpdir(), "projection-manifest-first-rollback-"));
    roots.push(root);
    const second = parseProjectionManifest(manifest(), BINDING);
    const databasePath = join(root, second.databaseFile);
    const target = join(root, "projection-manifest.json");
    writeFileSync(databasePath, "generation 2", "utf8");

    assert.throws(
      () => publishProjectionManifest({
        projectionDirectory: root,
        manifest: second,
        expectedBinding: BINDING,
      }, {
        faultInjector: {
          hit(boundary): void {
            if (boundary === "after-manifest-replace-before-validation") {
              writeFileSync(`${databasePath}-wal`, "first-publication sidecar", "utf8");
            }
          },
        },
      }),
      (error: unknown) => error instanceof LifecycleError
        && error.code === "INTEGRITY_FAILURE",
    );
    assert.equal(existsSync(target), false);
  });

  it("does not source rollback bytes through an A-to-B-to-A directory swap", () => {
    const root = mkdtempSync(join(tmpdir(), "projection-manifest-capture-swap-"));
    roots.push(root);
    const projectionDirectory = join(root, "projections");
    const originalDirectory = join(root, "original-projections");
    const alternateDirectory = join(root, "alternate-projections");
    mkdirSync(projectionDirectory);
    mkdirSync(alternateDirectory);
    const first = parseProjectionManifest(manifest({
      generation: 1,
      databaseFile: "projections-1-1.sqlite",
      terminalEventPosition: "16",
    }), BINDING);
    const second = parseProjectionManifest(manifest(), BINDING);
    const third = parseProjectionManifest(manifest({
      generation: 3,
      databaseFile: "projections-1-3.sqlite",
      terminalEventPosition: "18",
    }), BINDING);
    writeFileSync(join(projectionDirectory, first.databaseFile), "generation 1", "utf8");
    writeFileSync(join(projectionDirectory, second.databaseFile), "generation 2", "utf8");
    writeFileSync(join(alternateDirectory, third.databaseFile), "generation 3", "utf8");
    publishProjectionManifest({
      projectionDirectory,
      manifest: first,
      expectedBinding: BINDING,
    });
    publishProjectionManifest({
      projectionDirectory: alternateDirectory,
      manifest: third,
      expectedBinding: BINDING,
    });
    let swapped = false;
    const captureManifest = (): StableProjectionManifestSnapshot => {
      renameSync(projectionDirectory, originalDirectory);
      renameSync(alternateDirectory, projectionDirectory);
      swapped = true;
      try {
        const directoryIdentity = filesystemStableProjectionDirectoryOperations.capture(
          projectionDirectory,
        );
        const target = join(projectionDirectory, "projection-manifest.json");
        const stat = lstatSync(target, { bigint: true });
        const bytes = readFileSync(target);
        return Object.freeze({
          state: "present",
          directoryIdentity,
          fileIdentity: Object.freeze({
            device: stat.dev.toString(),
            inode: stat.ino.toString(),
            size: stat.size.toString(),
            sha256: createHash("sha256").update(bytes).digest("hex"),
          }),
          bytesBase64: bytes.toString("base64"),
        });
      } finally {
        renameSync(projectionDirectory, alternateDirectory);
        renameSync(originalDirectory, projectionDirectory);
      }
    };

    assert.throws(
      () => publishProjectionManifest({
        projectionDirectory,
        manifest: second,
        expectedBinding: BINDING,
      }, {
        directoryOperations: {
          ...filesystemStableProjectionDirectoryOperations,
          captureManifest,
        },
      }),
      (error: unknown) => error instanceof LifecycleError
        && error.code === "MATERIALIZATION_CONFLICT",
    );
    assert.equal(swapped, true);
    assert.equal(
      parseProjectionManifest(
        JSON.parse(readFileSync(join(projectionDirectory, "projection-manifest.json"), "utf8")),
        BINDING,
      ).generation,
      1,
    );
    assert.equal(
      parseProjectionManifest(
        JSON.parse(readFileSync(join(alternateDirectory, "projection-manifest.json"), "utf8")),
        BINDING,
      ).generation,
      3,
    );
  });

  it("does not roll back through a replaced projection directory", () => {
    const root = mkdtempSync(join(tmpdir(), "projection-manifest-rollback-directory-"));
    roots.push(root);
    const projectionDirectory = join(root, "projections");
    const originalDirectory = join(root, "original-projections");
    const alternateDirectory = join(root, "alternate-projections");
    mkdirSync(projectionDirectory);
    mkdirSync(alternateDirectory);
    const first = parseProjectionManifest(manifest({
      generation: 1,
      databaseFile: "projections-1-1.sqlite",
      terminalEventPosition: "16",
    }), BINDING);
    const second = parseProjectionManifest(manifest(), BINDING);
    const third = parseProjectionManifest(manifest({
      generation: 3,
      databaseFile: "projections-1-3.sqlite",
      terminalEventPosition: "18",
    }), BINDING);
    writeFileSync(join(projectionDirectory, first.databaseFile), "generation 1", "utf8");
    writeFileSync(join(projectionDirectory, second.databaseFile), "generation 2", "utf8");
    writeFileSync(join(alternateDirectory, third.databaseFile), "generation 3", "utf8");
    publishProjectionManifest({
      projectionDirectory,
      manifest: first,
      expectedBinding: BINDING,
    });
    publishProjectionManifest({
      projectionDirectory: alternateDirectory,
      manifest: third,
      expectedBinding: BINDING,
    });
    let swapped = false;
    try {
      assert.throws(
        () => publishProjectionManifest({
          projectionDirectory,
          manifest: second,
          expectedBinding: BINDING,
        }, {
          faultInjector: {
            hit(boundary): void {
              if (boundary !== "after-manifest-replace-before-validation" || swapped) return;
              renameSync(projectionDirectory, originalDirectory);
              renameSync(alternateDirectory, projectionDirectory);
              swapped = true;
            },
          },
        }),
        (error: unknown) => error instanceof LifecycleError
          && error.code === "MATERIALIZATION_CONFLICT"
          && error.retryable,
      );
      assert.equal(swapped, true);
      assert.equal(
        parseProjectionManifest(
          JSON.parse(readFileSync(join(projectionDirectory, "projection-manifest.json"), "utf8")),
          BINDING,
        ).generation,
        3,
        "rollback must not overwrite authority in the replacement directory",
      );
    } finally {
      if (swapped) {
        renameSync(projectionDirectory, alternateDirectory);
        renameSync(originalDirectory, projectionDirectory);
      }
    }
  });

  it("treats a symlink-shaped exact sidecar sibling as an integrity failure", () => {
    const root = mkdtempSync(join(tmpdir(), "projection-manifest-sidecar-shape-"));
    roots.push(root);
    const databaseFile = "projections-1-2.sqlite";
    const databasePath = join(root, databaseFile);
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
        lstat: (path) => {
          if (path === root) return regularDirectory;
          if (path === databasePath) return regularFile;
          if (path === `${databasePath}-wal`) return symlink;
          return missingEntry();
        },
        realpath: (path) => path,
      }),
      (error: unknown) => error instanceof LifecycleError
        && error.code === "INTEGRITY_FAILURE",
    );
  });

  it("maps a non-ENOENT exact sidecar lstat failure to integrity failure", () => {
    const root = mkdtempSync(join(tmpdir(), "projection-manifest-sidecar-error-"));
    roots.push(root);
    const databaseFile = "projections-1-2.sqlite";
    const databasePath = join(root, databaseFile);
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

    assert.throws(
      () => verifyProjectionPublicationPaths(root, databaseFile, {
        lstat: (path) => {
          if (path === root) return regularDirectory;
          if (path === databasePath) return regularFile;
          if (path === `${databasePath}-wal`) {
            throw Object.assign(new Error("access denied"), { code: "EACCES" });
          }
          return missingEntry();
        },
        realpath: (path) => path,
      }),
      (error: unknown) => error instanceof LifecycleError
        && error.code === "INTEGRITY_FAILURE",
    );
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
        lstat: (path) => {
          if (path === root) return symlink;
          if (path === databasePath) return regularFile;
          return missingEntry();
        },
        realpath: (path) => path,
      }),
      /PROJECTION_MANIFEST_PATH_INVALID/u,
    );
    assert.throws(
      () => verifyProjectionPublicationPaths(root, databaseFile, {
        lstat: (path) => {
          if (path === root) return regularDirectory;
          if (path === databasePath) return symlink;
          return missingEntry();
        },
        realpath: (path) => path,
      }),
      /PROJECTION_MANIFEST_PATH_INVALID/u,
    );
  });
});
