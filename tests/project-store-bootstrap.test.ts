import { strict as assert } from "node:assert";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { ProjectDescriptorRepository } from "../src/orchestrator/identity/project-descriptor.repository.js";
import type {
  BranchScopeId,
  GitWorkspaceSnapshot,
  ProjectDescriptorV1,
  ProjectId,
  ProjectStoreRoute,
  WorkspaceSnapshot,
  WorkspaceId,
} from "../src/orchestrator/identity/contracts.js";
import {
  GitWorkspaceResolver,
  SpawnSyncGitCommandRunner,
} from "../src/orchestrator/identity/git-workspace.resolver.js";
import { ProjectStoreRouter } from "../src/orchestrator/identity/project-store.router.js";
import { StoreManifestRepository } from "../src/orchestrator/identity/store-manifest.repository.js";
import { DEFAULT_BUSY_TIMEOUT_MS, PROJECT_MEMORY_APPLICATION_ID } from "../src/orchestrator/runtime/runtime-capabilities.js";
import { BranchScopeRepository } from "../src/orchestrator/storage/branch-scope.repository.js";
import {
  DefaultProjectStoreBootstrapService,
  type ProjectStoreBootstrapFaultBoundary,
  type ProjectStoreBootstrapDependencies,
} from "../src/orchestrator/storage/project-store-bootstrap.service.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import { expectedSchemaFingerprint } from "../src/orchestrator/storage/schema-fingerprint.js";
import { eventCoreMigration } from "../src/orchestrator/storage/migrations/0001-event-core.js";
import {
  CURRENT_PROJECT_STORE_SCHEMA_VERSION,
  PROJECT_STORE_MIGRATIONS,
} from "../src/orchestrator/storage/migrations/registry.js";
import { canonicalMkdtemp } from "./support/canonical-temp.js";

const roots: string[] = [];
const driver = new NodeSqliteDriver({ DatabaseSync });

function fixture(): { root: string; projectRoot: string; vaultRoot: string } {
  const root = canonicalMkdtemp("memory-bootstrap-");
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
  it("does not load node:sqlite until initialize and caches the native module", async () => {
    const { projectRoot, vaultRoot } = fixture();
    const expected = paths(vaultRoot);
    let loads = 0;
    const service = new DefaultProjectStoreBootstrapService({
      async loadNodeSqlite() {
        loads += 1;
        return { DatabaseSync };
      },
    });
    assert.equal(loads, 0);
    assert.equal(existsSync(expected.descriptor), false);
    await service.initialize({ projectRoot, vaultRoot });
    assert.equal(loads, 1);
    await service.initialize({ projectRoot, vaultRoot });
    assert.equal(loads, 1);
  });

  it("fails before identity mutation when lazy node:sqlite loading fails", async () => {
    const { projectRoot, vaultRoot } = fixture();
    const expected = paths(vaultRoot);
    const service = new DefaultProjectStoreBootstrapService({
      async loadNodeSqlite() { throw new Error("native sqlite unavailable"); },
    });
    assert.equal(existsSync(expected.descriptor), false);
    await assert.rejects(
      service.initialize({ projectRoot, vaultRoot }),
      errorCode("SQLITE_CAPABILITY_MISSING"),
    );
    assert.equal(existsSync(expected.descriptor), false);
    assert.equal(existsSync(expected.storeRoot), false);
  });

  it("preserves the event-core schema fingerprint after lazy native loading", () => {
    assert.equal(
      expectedSchemaFingerprint([eventCoreMigration], DatabaseSync),
      "cc5836d8494419704620cd406cce41a60c1cd387d5008242915a3a18094f3001",
    );
  });

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
      assert.equal(meta?.schema_version, BigInt(CURRENT_PROJECT_STORE_SCHEMA_VERSION));
      assert.equal(result.manifest.schemaVersion, 1);
      assert.deepEqual(
        database.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all()
          .map((row) => ({ version: row.version, name: row.name })),
        PROJECT_STORE_MIGRATIONS.map((migration) => ({
          version: BigInt(migration.version),
          name: migration.name,
        })),
      );
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

  it("replays every Git-store ancestor when a contender pre-created the complete tree", async () => {
    const { root, projectRoot, vaultRoot } = fixture();
    const gitCommonDir = join(root, "git-common");
    mkdirSync(gitCommonDir);
    const workspace: GitWorkspaceSnapshot = {
      kind: "git",
      worktreeRoot: projectRoot,
      gitDir: join(projectRoot, ".git"),
      gitCommonDir,
      headCommit: "a".repeat(40),
      branchRef: "refs/heads/main",
      detached: false,
      workspaceId: "bootstrap-git-workspace" as WorkspaceId,
    };
    class StaticGitWorkspaceResolver extends GitWorkspaceResolver {
      constructor() {
        super(new SpawnSyncGitCommandRunner());
      }

      override inspect(): GitWorkspaceSnapshot {
        return workspace;
      }
    }
    const barriers: Array<{
      path: string;
      databasePublished: boolean;
      manifestPublished: boolean;
      temporaryDatabaseCount: number;
    }> = [];
    let eventsPath = "";
    let manifestPath = "";
    let storeRoot = "";
    class ObservingProjectStoreRouter extends ProjectStoreRouter {
      override route(
        descriptor: ProjectDescriptorV1,
        actualVaultRoot: string,
        actualWorkspace: WorkspaceSnapshot,
      ): ProjectStoreRoute {
        assert.equal(actualVaultRoot, vaultRoot);
        assert.strictEqual(actualWorkspace, workspace);
        const observedRoute = super.route(descriptor, actualVaultRoot, actualWorkspace);
        mkdirSync(observedRoute.storeRoot, { recursive: true });
        storeRoot = observedRoute.storeRoot;
        eventsPath = observedRoute.eventsPath;
        manifestPath = observedRoute.storeManifestPath;
        return observedRoute;
      }
    }
    const dependencies: Partial<ProjectStoreBootstrapDependencies> = {
      workspaceResolver: new StaticGitWorkspaceResolver(),
      syncDirectory(path: string): void {
        barriers.push({
          path,
          databasePublished: eventsPath.length > 0 && existsSync(eventsPath),
          manifestPublished: manifestPath.length > 0 && existsSync(manifestPath),
          temporaryDatabaseCount: storeRoot.length > 0 && existsSync(storeRoot)
            ? readdirSync(storeRoot).filter((name) =>
              name.startsWith(".events.sqlite.bootstrap-") && name.endsWith(".tmp")
            ).length
            : 0,
        });
      },
      router: new ObservingProjectStoreRouter(),
    };

    const result = await new DefaultProjectStoreBootstrapService(dependencies).initialize({
      projectRoot,
      vaultRoot,
    });
    const projectMemoryRoot = join(gitCommonDir, "project-memory");
    const projectStoreRoot = join(projectMemoryRoot, result.descriptor.projectId);

    assert.deepEqual(barriers, [
      {
        path: gitCommonDir,
        databasePublished: false,
        manifestPublished: false,
        temporaryDatabaseCount: 0,
      },
      {
        path: projectMemoryRoot,
        databasePublished: false,
        manifestPublished: false,
        temporaryDatabaseCount: 0,
      },
      {
        path: projectStoreRoot,
        databasePublished: false,
        manifestPublished: false,
        temporaryDatabaseCount: 0,
      },
      {
        path: result.route.storeRoot,
        databasePublished: true,
        manifestPublished: false,
        temporaryDatabaseCount: 1,
      },
      {
        path: result.route.storeRoot,
        databasePublished: true,
        manifestPublished: false,
        temporaryDatabaseCount: 0,
      },
    ]);
  });

  it("replays vault-local ancestors when a contender pre-created the complete tree", async () => {
    const { projectRoot, vaultRoot } = fixture();
    const barriers: Array<{
      path: string;
      databasePublished: boolean;
      temporaryDatabaseCount: number;
    }> = [];
    let storeRoot = "";
    let eventsPath = "";
    class PrecreatedVaultStoreRouter extends ProjectStoreRouter {
      override route(
        descriptor: ProjectDescriptorV1,
        actualVaultRoot: string,
        workspace: WorkspaceSnapshot,
      ): ProjectStoreRoute {
        const observedRoute = super.route(descriptor, actualVaultRoot, workspace);
        mkdirSync(observedRoute.storeRoot, { recursive: true });
        storeRoot = observedRoute.storeRoot;
        eventsPath = observedRoute.eventsPath;
        return observedRoute;
      }
    }
    const dependencies: Partial<ProjectStoreBootstrapDependencies> = {
      router: new PrecreatedVaultStoreRouter(),
      syncDirectory(path: string): void {
        const entries = storeRoot.length > 0 && existsSync(storeRoot)
          ? readdirSync(storeRoot)
          : [];
        barriers.push({
          path,
          databasePublished: eventsPath.length > 0 && existsSync(eventsPath),
          temporaryDatabaseCount: entries.filter((name) =>
            name.startsWith(".events.sqlite.bootstrap-") && name.endsWith(".tmp")
          ).length,
        });
      },
    };

    const result = await new DefaultProjectStoreBootstrapService(dependencies).initialize({
      projectRoot,
      vaultRoot,
    });

    assert.deepEqual(barriers, [
      {
        path: resolve(vaultRoot),
        databasePublished: false,
        temporaryDatabaseCount: 0,
      },
      {
        path: resolve(vaultRoot, ".memory-mcp"),
        databasePublished: false,
        temporaryDatabaseCount: 0,
      },
      {
        path: result.route.storeRoot,
        databasePublished: true,
        temporaryDatabaseCount: 1,
      },
      {
        path: result.route.storeRoot,
        databasePublished: true,
        temporaryDatabaseCount: 0,
      },
    ]);
  });

  it("accepts a legitimately advanced published maintenance state without replacing identity", async () => {
    const { projectRoot, vaultRoot } = fixture();
    const expected = paths(vaultRoot);
    const first = await new DefaultProjectStoreBootstrapService().initialize({ projectRoot, vaultRoot });
    const database = new DatabaseSync(expected.events);
    database.exec(`
      UPDATE maintenance_state
      SET epoch = 3,
          mode = 'quiescing',
          owner_id = 'maintenance-owner',
          fencing_token = 7,
          lease_expires_at = '2026-07-11T00:10:00.000Z',
          requested_at = '2026-07-11T00:05:00.000Z'
      WHERE singleton = 1;
    `);
    database.close();

    const inspected = await new DefaultProjectStoreBootstrapService().initialize({
      projectRoot,
      vaultRoot,
    });
    assert.equal(inspected.createdStore, false);
    assert.equal(inspected.recoveredManifest, false);
    assert.deepEqual(inspected.descriptor, first.descriptor);
    assert.equal(inspected.manifest.storeId, first.manifest.storeId);
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
      database.exec("DROP TRIGGER project_meta_identity_immutable");
      database.prepare(`
        UPDATE project_meta SET project_id = $projectId WHERE singleton = 1
      `).run({ $projectId: "99999999-9999-4999-8999-999999999999" });
      database.close();

      await assert.rejects(
        new DefaultProjectStoreBootstrapService().initialize({ projectRoot, vaultRoot }),
        errorCode("SCHEMA_FINGERPRINT_MISMATCH"),
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

  it("rejects same-name trigger drift and any extra user schema object", async () => {
    {
      const { projectRoot, vaultRoot } = fixture();
      const expected = paths(vaultRoot);
      await new DefaultProjectStoreBootstrapService().initialize({ projectRoot, vaultRoot });
      const database = new DatabaseSync(expected.events);
      database.exec(`
        DROP TRIGGER events_identity_guard;
        CREATE TRIGGER events_identity_guard
        BEFORE INSERT ON events
        BEGIN SELECT 1; END;
      `);
      database.close();

      await assert.rejects(
        new DefaultProjectStoreBootstrapService().initialize({ projectRoot, vaultRoot }),
        errorCode("SCHEMA_FINGERPRINT_MISMATCH"),
      );
    }

    for (const table of ["evidence", "rogue_lifecycle", "projection_state"]) {
      const { projectRoot, vaultRoot } = fixture();
      const expected = paths(vaultRoot);
      await new DefaultProjectStoreBootstrapService().initialize({ projectRoot, vaultRoot });
      const database = new DatabaseSync(expected.events);
      database.exec(`CREATE TABLE ${table}(value TEXT NOT NULL) STRICT`);
      database.close();

      await assert.rejects(
        new DefaultProjectStoreBootstrapService().initialize({ projectRoot, vaultRoot }),
        errorCode("SCHEMA_FINGERPRINT_MISMATCH"),
      );
    }
  });

  it("retries deterministic probe and bootstrap path collisions without deleting sentinels", async () => {
    const { projectRoot, vaultRoot } = fixture();
    const expected = paths(vaultRoot);
    mkdirSync(expected.storeRoot, { recursive: true });
    const probeCollision = join(
      expected.storeRoot,
      ".events.sqlite.capability-probe-collision.tmp",
    );
    const bootstrapCollision = join(
      expected.storeRoot,
      ".events.sqlite.bootstrap-bootstrap-collision.tmp",
    );
    writeFileSync(probeCollision, "probe-sentinel");
    writeFileSync(bootstrapCollision, "bootstrap-sentinel");
    const ids = [
      "probe-collision",
      "probe-fresh",
      "44444444-4444-4444-8444-444444444444",
      "bootstrap-collision",
      "bootstrap-fresh",
    ];

    const initialized = await new DefaultProjectStoreBootstrapService({
      randomId: () => ids.shift()!,
    }).initialize({ projectRoot, vaultRoot });
    assert.equal(initialized.createdStore, true);
    assert.equal(initialized.manifest.storeId, "44444444-4444-4444-8444-444444444444");
    assert.equal(readFileSync(probeCollision, "utf8"), "probe-sentinel");
    assert.equal(readFileSync(bootstrapCollision, "utf8"), "bootstrap-sentinel");
    assert.equal(ids.length, 0);
  });

  it("preserves WAL-only and SHM-only sidecar collisions for probe and bootstrap reservations", async () => {
    const { projectRoot, vaultRoot } = fixture();
    const expected = paths(vaultRoot);
    mkdirSync(expected.storeRoot, { recursive: true });
    const probeWalBase = join(
      expected.storeRoot,
      ".events.sqlite.capability-probe-wal.tmp",
    );
    const probeShmBase = join(
      expected.storeRoot,
      ".events.sqlite.capability-probe-shm.tmp",
    );
    const bootstrapWalBase = join(
      expected.storeRoot,
      ".events.sqlite.bootstrap-bootstrap-wal.tmp",
    );
    const bootstrapShmBase = join(
      expected.storeRoot,
      ".events.sqlite.bootstrap-bootstrap-shm.tmp",
    );
    writeFileSync(`${probeWalBase}-wal`, "probe-wal-sentinel");
    writeFileSync(`${probeShmBase}-shm`, "probe-shm-sentinel");
    writeFileSync(`${bootstrapWalBase}-wal`, "bootstrap-wal-sentinel");
    writeFileSync(`${bootstrapShmBase}-shm`, "bootstrap-shm-sentinel");
    const ids = [
      "probe-wal",
      "probe-shm",
      "probe-fresh-sidecars",
      "55555555-5555-4555-8555-555555555555",
      "bootstrap-wal",
      "bootstrap-shm",
      "bootstrap-fresh-sidecars",
    ];

    const initialized = await new DefaultProjectStoreBootstrapService({
      randomId: () => ids.shift()!,
    }).initialize({ projectRoot, vaultRoot });
    assert.equal(initialized.createdStore, true);
    assert.equal(initialized.manifest.storeId, "55555555-5555-4555-8555-555555555555");
    assert.equal(readFileSync(`${probeWalBase}-wal`, "utf8"), "probe-wal-sentinel");
    assert.equal(readFileSync(`${probeShmBase}-shm`, "utf8"), "probe-shm-sentinel");
    assert.equal(
      readFileSync(`${bootstrapWalBase}-wal`, "utf8"),
      "bootstrap-wal-sentinel",
    );
    assert.equal(
      readFileSync(`${bootstrapShmBase}-shm`, "utf8"),
      "bootstrap-shm-sentinel",
    );
    for (const collidedBase of [
      probeWalBase,
      probeShmBase,
      bootstrapWalBase,
      bootstrapShmBase,
    ]) {
      assert.equal(existsSync(collidedBase), false);
    }
    assert.equal(ids.length, 0);
  });

  it("does not classify substring-only descriptor or manifest errors as publication races", async () => {
    {
      class MisleadingDescriptorRepository extends ProjectDescriptorRepository {
        override createExplicit(): never {
          throw new Error("NOT_A_RACE_PROJECT_DESCRIPTOR_EXISTS_SUFFIX");
        }
      }
      const { projectRoot, vaultRoot } = fixture();
      await assert.rejects(
        new DefaultProjectStoreBootstrapService({
          descriptorRepository: new MisleadingDescriptorRepository(),
        }).initialize({ projectRoot, vaultRoot }),
        /NOT_A_RACE_PROJECT_DESCRIPTOR_EXISTS_SUFFIX/,
      );
    }

    {
      class MisleadingManifestRepository extends StoreManifestRepository {
        override createExplicit(): never {
          throw new Error("NOT_A_RACE_STORE_MANIFEST_EXISTS_SUFFIX");
        }
      }
      const { projectRoot, vaultRoot } = fixture();
      await assert.rejects(
        new DefaultProjectStoreBootstrapService({
          manifestRepository: new MisleadingManifestRepository(),
        }).initialize({ projectRoot, vaultRoot }),
        /NOT_A_RACE_STORE_MANIFEST_EXISTS_SUFFIX/,
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
      assert.equal(
        database.prepare("SELECT count(*) AS count FROM schema_migrations").get()?.count,
        BigInt(PROJECT_STORE_MIGRATIONS.length),
      );
      assert.equal(database.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    } finally {
      database.close();
    }
  });

  it("adopts a complete hard-link winner published at the pre-publication fault boundary", async () => {
    const { projectRoot, vaultRoot } = fixture();
    const expected = paths(vaultRoot);
    const winner = await new DefaultProjectStoreBootstrapService().initialize({ projectRoot, vaultRoot });
    const savedWinner = join(expected.storeRoot, ".deterministic-winner.sqlite");
    linkSync(expected.events, savedWinner);
    unlinkSync(expected.events);
    unlinkSync(expected.manifest);

    const contender = new DefaultProjectStoreBootstrapService({
      faultInjector: {
        hit(boundary): void {
          if (boundary === "after-temp-complete-before-publish") {
            linkSync(savedWinner, expected.events);
          }
        },
      },
    });
    const adopted = await contender.initialize({
      projectRoot,
      vaultRoot,
      replicaDecision: "initialize-local",
    });
    assert.equal(adopted.createdStore, false);
    assert.equal(adopted.manifest.storeId, winner.manifest.storeId);
    assert.equal(adopted.descriptor.projectId, winner.descriptor.projectId);
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
      SET version = 3, name = 'future', checksum = $checksum
      WHERE version = 2
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
