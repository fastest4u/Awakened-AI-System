import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { ProjectDescriptorRepository } from "../src/orchestrator/identity/project-descriptor.repository.js";
import type { BranchScopeId, ProjectId } from "../src/orchestrator/identity/contracts.js";
import { DEFAULT_BUSY_TIMEOUT_MS, PROJECT_MEMORY_APPLICATION_ID } from "../src/orchestrator/runtime/runtime-capabilities.js";
import { BranchScopeRepository } from "../src/orchestrator/storage/branch-scope.repository.js";
import {
  DefaultProjectStoreBootstrapService,
  type ProjectStoreBootstrapFaultBoundary,
} from "../src/orchestrator/storage/project-store-bootstrap.service.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";

const roots: string[] = [];
const driver = new NodeSqliteDriver({ DatabaseSync });

function fixture(): { root: string; projectRoot: string; vaultRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "memory-bootstrap-"));
  roots.push(root);
  const projectRoot = join(root, "project");
  const vaultRoot = join(projectRoot, "memory");
  mkdirSync(vaultRoot, { recursive: true });
  return { root, projectRoot, vaultRoot };
}

function paths(vaultRoot: string): {
  descriptor: string;
  storeRoot: string;
  events: string;
  manifest: string;
} {
  const storeRoot = join(vaultRoot, ".memory-mcp", "v2");
  return {
    descriptor: join(vaultRoot, ".memory-mcp", "project-identity.json"),
    storeRoot,
    events: join(storeRoot, "events.sqlite"),
    manifest: join(storeRoot, "store-manifest.json"),
  };
}

function errorCode(expected: string): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.equal(
      typeof error === "object" && error !== null && "code" in error,
      true,
    );
    assert.equal(String((error as { code: unknown }).code), expected);
    return true;
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("DefaultProjectStoreBootstrapService", () => {
  it("creates the descriptor and one complete immutable store only on explicit initialize", async () => {
    const { projectRoot, vaultRoot } = fixture();
    const expected = paths(vaultRoot);
    const service = new DefaultProjectStoreBootstrapService();

    assert.equal(existsSync(expected.descriptor), false);
    assert.equal(existsSync(expected.storeRoot), false);

    const result = await service.initialize({ projectRoot, vaultRoot });
    assert.equal(result.createdDescriptor, true);
    assert.equal(result.createdStore, true);
    assert.equal(result.recoveredManifest, false);
    assert.equal(result.route.eventsPath, expected.events);
    assert.equal(readdirSync(expected.storeRoot).filter((name) => name === "events.sqlite").length, 1);
    assert.equal(readdirSync(expected.storeRoot).filter((name) => name === "store-manifest.json").length, 1);
    assert.equal(result.descriptor.projectId, result.manifest.projectId);
    assert.equal(result.descriptor.vaultId, result.manifest.vaultId);

    const database = driver.open(expected.events, {
      mode: "read-only-existing",
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    });
    try {
      const meta = database.prepare(`
        SELECT project_id, vault_id, store_id, schema_version
        FROM project_meta WHERE singleton = 1
      `).get();
      assert.equal(meta?.project_id, result.descriptor.projectId);
      assert.equal(meta?.vault_id, result.descriptor.vaultId);
      assert.equal(meta?.store_id, result.manifest.storeId);
      assert.equal(meta?.schema_version, 1n);
      assert.equal(database.prepare("SELECT count(*) AS count FROM schema_migrations").get()?.count, 1n);
      const maintenance = database
        .prepare("SELECT epoch, mode, owner_id, fencing_token FROM maintenance_state")
        .get();
      assert.equal(maintenance?.epoch, 0n);
      assert.equal(maintenance?.mode, "idle");
      assert.equal(maintenance?.owner_id, null);
      assert.equal(maintenance?.fencing_token, 0n);
    } finally {
      database.close();
    }

    const again = await service.initialize({ projectRoot, vaultRoot });
    assert.equal(again.createdDescriptor, false);
    assert.equal(again.createdStore, false);
    assert.equal(again.recoveredManifest, false);
    assert.deepEqual(again.descriptor, result.descriptor);
    assert.deepEqual(again.manifest, result.manifest);
  });

  it("requires an explicit replica decision only for an existing descriptor with no store evidence", async () => {
    const { projectRoot, vaultRoot } = fixture();
    new ProjectDescriptorRepository().createExplicit(projectRoot, vaultRoot);
    const expected = paths(vaultRoot);
    const service = new DefaultProjectStoreBootstrapService();

    await assert.rejects(
      service.initialize({ projectRoot, vaultRoot }),
      errorCode("PROJECT_REPLICA_DECISION_REQUIRED"),
    );
    assert.equal(existsSync(expected.events), false);
    assert.equal(existsSync(expected.manifest), false);

    const initialized = await service.initialize({
      projectRoot,
      vaultRoot,
      replicaDecision: "initialize-local",
    });
    assert.equal(initialized.createdDescriptor, false);
    assert.equal(initialized.createdStore, true);
  });

  it("recovers a missing manifest from the complete database identity without choosing a second store", async () => {
    const { projectRoot, vaultRoot } = fixture();
    const expected = paths(vaultRoot);
    const first = await new DefaultProjectStoreBootstrapService().initialize({ projectRoot, vaultRoot });
    unlinkSync(expected.manifest);

    const recovered = await new DefaultProjectStoreBootstrapService().initialize({ projectRoot, vaultRoot });
    assert.equal(recovered.recoveredManifest, true);
    assert.equal(recovered.createdStore, false);
    assert.equal(recovered.manifest.storeId, first.manifest.storeId);
    assert.equal(JSON.parse(readFileSync(expected.manifest, "utf8")).storeId, first.manifest.storeId);
  });

  it("fails closed for every authoritative partial or corrupt state", async () => {
    {
      const { projectRoot, vaultRoot } = fixture();
      const expected = paths(vaultRoot);
      await new DefaultProjectStoreBootstrapService().initialize({ projectRoot, vaultRoot });
      unlinkSync(expected.events);
      await assert.rejects(
        new DefaultProjectStoreBootstrapService().initialize({ projectRoot, vaultRoot }),
        errorCode("STORE_UNAVAILABLE"),
      );
      assert.equal(existsSync(expected.events), false);
    }

    {
      const { projectRoot, vaultRoot } = fixture();
      const expected = paths(vaultRoot);
      new ProjectDescriptorRepository().createExplicit(projectRoot, vaultRoot);
      mkdirSync(expected.storeRoot, { recursive: true });
      writeFileSync(expected.manifest, "{malformed");
      await assert.rejects(
        new DefaultProjectStoreBootstrapService().initialize({
          projectRoot,
          vaultRoot,
          replicaDecision: "initialize-local",
        }),
        errorCode("STORE_UNAVAILABLE"),
      );
      assert.equal(readFileSync(expected.manifest, "utf8"), "{malformed");
      assert.equal(existsSync(expected.events), false);
    }

    for (const contents of ["not a sqlite database", ""]) {
      const { projectRoot, vaultRoot } = fixture();
      const expected = paths(vaultRoot);
      new ProjectDescriptorRepository().createExplicit(projectRoot, vaultRoot);
      mkdirSync(expected.storeRoot, { recursive: true });
      writeFileSync(expected.events, contents);
      await assert.rejects(
        new DefaultProjectStoreBootstrapService().initialize({ projectRoot, vaultRoot }),
        errorCode("STORE_UNAVAILABLE"),
      );
      assert.equal(readFileSync(expected.events, "utf8"), contents);
    }
  });

  it("never overwrites a nonzero wrong application id", async () => {
    const { projectRoot, vaultRoot } = fixture();
    const expected = paths(vaultRoot);
    new ProjectDescriptorRepository().createExplicit(projectRoot, vaultRoot);
    mkdirSync(expected.storeRoot, { recursive: true });
    const database = new DatabaseSync(expected.events);
    database.exec(`PRAGMA application_id = 1234; CREATE TABLE evidence(value TEXT) STRICT;`);
    database.close();

    await assert.rejects(
      new DefaultProjectStoreBootstrapService().initialize({ projectRoot, vaultRoot }),
      errorCode("STORE_UNAVAILABLE"),
    );
    const reopened = new DatabaseSync(expected.events, { readOnly: true });
    try {
      assert.equal(reopened.prepare("PRAGMA application_id").get()?.application_id, 1234);
      assert.equal(reopened.prepare("SELECT count(*) AS count FROM evidence").get()?.count, 0);
    } finally {
      reopened.close();
    }
  });

  it("rejects descriptor, manifest, and database identity disagreement without repairing evidence", async () => {
    {
      const { projectRoot, vaultRoot } = fixture();
      const expected = paths(vaultRoot);
      await new DefaultProjectStoreBootstrapService().initialize({ projectRoot, vaultRoot });
      unlinkSync(expected.manifest);
      const database = new DatabaseSync(expected.events);
      database.exec("DROP TRIGGER project_meta_no_update");
      database.prepare(`
        UPDATE project_meta SET project_id = $projectId WHERE singleton = 1
      `).run({ $projectId: "99999999-9999-4999-8999-999999999999" });
      database.close();

      await assert.rejects(
        new DefaultProjectStoreBootstrapService().initialize({ projectRoot, vaultRoot }),
        errorCode("STORE_UNAVAILABLE"),
      );
      assert.equal(existsSync(expected.manifest), false);
    }

    {
      const { projectRoot, vaultRoot } = fixture();
      const expected = paths(vaultRoot);
      await new DefaultProjectStoreBootstrapService().initialize({ projectRoot, vaultRoot });
      const manifest = JSON.parse(readFileSync(expected.manifest, "utf8")) as Record<string, unknown>;
      manifest.projectId = "99999999-9999-4999-8999-999999999999";
      writeFileSync(expected.manifest, `${JSON.stringify(manifest, null, 2)}\n`);

      await assert.rejects(
        new DefaultProjectStoreBootstrapService().initialize({
          projectRoot,
          vaultRoot,
          replicaDecision: "initialize-local",
        }),
        errorCode("STORE_UNAVAILABLE"),
      );
      assert.equal(
        (JSON.parse(readFileSync(expected.manifest, "utf8")) as Record<string, unknown>).projectId,
        "99999999-9999-4999-8999-999999999999",
      );
    }
  });

  it("converges concurrent first-open contenders on one descriptor and one checksummed schema", async () => {
    const { projectRoot, vaultRoot } = fixture();
    const [left, right] = await Promise.all([
      new DefaultProjectStoreBootstrapService().initialize({ projectRoot, vaultRoot }),
      new DefaultProjectStoreBootstrapService().initialize({ projectRoot, vaultRoot }),
    ]);
    assert.deepEqual(left.descriptor, right.descriptor);
    assert.equal(left.manifest.storeId, right.manifest.storeId);
    assert.equal([left.createdStore, right.createdStore].filter(Boolean).length, 1);

    const database = driver.open(paths(vaultRoot).events, {
      mode: "read-only-existing",
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    });
    try {
      assert.equal(database.prepare("SELECT count(*) AS count FROM schema_migrations").get()?.count, 1n);
      assert.equal(database.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    } finally {
      database.close();
    }
  });

  it("keeps unpublished crashes non-authoritative and recovers publication-before-manifest", async () => {
    for (const boundary of [
      "after-temp-schema-before-identity",
      "after-temp-complete-before-publish",
    ] satisfies ProjectStoreBootstrapFaultBoundary[]) {
      const { projectRoot, vaultRoot } = fixture();
      const expected = paths(vaultRoot);
      const service = new DefaultProjectStoreBootstrapService({
        faultInjector: { hit(observed): void {
          if (observed === boundary) throw new Error(`INJECTED_${boundary}`);
        } },
      });
      await assert.rejects(service.initialize({ projectRoot, vaultRoot }), new RegExp(`INJECTED_${boundary}`));
      assert.equal(existsSync(expected.events), false);
      assert.equal(existsSync(expected.manifest), false);
      assert.equal(
        existsSync(expected.storeRoot)
          ? readdirSync(expected.storeRoot).some((name) => name.includes("bootstrap"))
          : false,
        false,
      );
    }

    const { projectRoot, vaultRoot } = fixture();
    const expected = paths(vaultRoot);
    const crash = new DefaultProjectStoreBootstrapService({
      faultInjector: { hit(boundary): void {
        if (boundary === "after-database-publish-before-manifest") {
          throw new Error("INJECTED_AFTER_PUBLICATION");
        }
      } },
    });
    await assert.rejects(crash.initialize({ projectRoot, vaultRoot }), /INJECTED_AFTER_PUBLICATION/);
    assert.equal(existsSync(expected.events), true);
    assert.equal(existsSync(expected.manifest), false);

    const recovered = await new DefaultProjectStoreBootstrapService().initialize({ projectRoot, vaultRoot });
    assert.equal(recovered.recoveredManifest, true);
    assert.equal(recovered.createdStore, false);
  });

  it("rejects schema versions newer than the binary during inspection", async () => {
    const { projectRoot, vaultRoot } = fixture();
    const expected = paths(vaultRoot);
    await new DefaultProjectStoreBootstrapService().initialize({ projectRoot, vaultRoot });
    unlinkSync(expected.manifest);
    const database = new DatabaseSync(expected.events);
    database.exec("DROP TRIGGER schema_migrations_no_update");
    database.prepare(`
      UPDATE schema_migrations
      SET version = 2, name = 'future', checksum = $checksum
      WHERE version = 1
    `).run({ $checksum: "f".repeat(64) });
    database.close();

    await assert.rejects(
      new DefaultProjectStoreBootstrapService().initialize({ projectRoot, vaultRoot }),
      errorCode("SCHEMA_TOO_NEW"),
    );
    assert.equal(existsSync(expected.manifest), false);
  });
});

describe("BranchScopeRepository", () => {
  it("preserves UUID only across an explicit rename and creates a new UUID after retirement", async () => {
    const { projectRoot, vaultRoot } = fixture();
    const initialized = await new DefaultProjectStoreBootstrapService().initialize({ projectRoot, vaultRoot });
    const connection = driver.open(initialized.route.eventsPath, {
      mode: "existing",
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    });
    const ids = [
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ] as BranchScopeId[];
    const repository = new BranchScopeRepository({ randomId: () => ids.shift()! });
    const projectId = initialized.descriptor.projectId as ProjectId;
    try {
      connection.exec("BEGIN IMMEDIATE");
      const first = repository.resolveOrCreate(connection, projectId, {
        branchRef: "refs/heads/main",
        headCommit: "1".repeat(40),
        detached: false,
      }, "2026-07-11T00:00:00.000Z");
      repository.recordRename(
        connection,
        projectId,
        first,
        "refs/heads/trunk",
        "2026-07-11T00:00:01.000Z",
      );
      assert.equal(repository.inspect(connection, projectId, {
        branchRef: "refs/heads/trunk",
        headCommit: "2".repeat(40),
        detached: false,
      }), first);
      assert.equal(repository.inspect(connection, projectId, {
        branchRef: "refs/heads/main",
        headCommit: "1".repeat(40),
        detached: false,
      }), null);
      repository.retire(connection, projectId, first, "2026-07-11T00:00:02.000Z");
      const reused = repository.resolveOrCreate(connection, projectId, {
        branchRef: "refs/heads/trunk",
        headCommit: "3".repeat(40),
        detached: false,
      }, "2026-07-11T00:00:03.000Z");
      assert.notEqual(reused, first);
      connection.exec("COMMIT");
    } catch (error) {
      try { connection.exec("ROLLBACK"); } catch { /* preserve original */ }
      throw error;
    } finally {
      connection.close();
    }
  });

  it("matches detached scopes by their creation commit", async () => {
    const { projectRoot, vaultRoot } = fixture();
    const initialized = await new DefaultProjectStoreBootstrapService().initialize({ projectRoot, vaultRoot });
    const connection = driver.open(initialized.route.eventsPath, {
      mode: "existing",
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    });
    const repository = new BranchScopeRepository({
      randomId: () => "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as BranchScopeId,
    });
    try {
      connection.exec("BEGIN IMMEDIATE");
      const first = repository.resolveOrCreate(connection, initialized.descriptor.projectId, {
        branchRef: null,
        headCommit: "4".repeat(40),
        detached: true,
      }, "2026-07-11T00:00:00.000Z");
      assert.equal(repository.resolveOrCreate(connection, initialized.descriptor.projectId, {
        branchRef: null,
        headCommit: "4".repeat(40),
        detached: true,
      }, "2026-07-11T00:00:01.000Z"), first);
      connection.exec("COMMIT");
    } catch (error) {
      try { connection.exec("ROLLBACK"); } catch { /* preserve original */ }
      throw error;
    } finally {
      connection.close();
    }
  });
});
