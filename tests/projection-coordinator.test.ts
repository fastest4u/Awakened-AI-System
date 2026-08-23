import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";

import { payloadHash } from "../src/orchestrator/crypto/event-hash.js";
import type {
  BranchScopeId,
  ProjectId,
  StoreId,
  VaultId,
  WorkspaceId,
} from "../src/orchestrator/identity/contracts.js";
import {
  ImmutableProjectionBuilder,
  type BuiltProjectionGeneration,
} from "../src/orchestrator/projections/builder.js";
import {
  DefaultProjectionBuildCoordinator,
  ProjectionLagError,
  type ProjectionGenerationBuilder,
} from "../src/orchestrator/projections/coordinator.js";
import type { ProjectBinding } from "../src/orchestrator/projections/contracts.js";
import {
  SqliteProjectionEventReader,
  type ProjectionEventReader,
  type ProjectionEventSnapshot,
} from "../src/orchestrator/projections/event-reader.js";
import {
  parseProjectionManifest,
  publishProjectionManifest,
  type ProjectionPathInspection,
} from "../src/orchestrator/projections/manifest.js";
import { ProjectionReaderLeaseRegistry } from "../src/orchestrator/projections/reader-lease.js";
import { PROJECT_MEMORY_APPLICATION_ID } from "../src/orchestrator/runtime/runtime-capabilities.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";

const PROJECT_ID = "1".repeat(64) as ProjectId;
const VAULT_ID = "2".repeat(64) as VaultId;
const STORE_ID = "3".repeat(64) as StoreId;
const WORKSPACE_ID = "4".repeat(64) as WorkspaceId;
const BRANCH_SCOPE_ID = "00000000-0000-4000-8000-000000000051" as BranchScopeId;
const BRANCH_REF = "refs/heads/projection-coordinator";
const NOW = "2026-08-23T03:00:00.000Z";
const BINDING: ProjectBinding = Object.freeze({
  projectId: PROJECT_ID,
  vaultId: VAULT_ID,
  storeId: STORE_ID,
  workspaceId: WORKSPACE_ID,
  branchScopeId: BRANCH_SCOPE_ID,
  branchRef: BRANCH_REF,
  sessionId: null,
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sourceDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA application_id = ${PROJECT_MEMORY_APPLICATION_ID};
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE project_meta(singleton INTEGER PRIMARY KEY, project_id TEXT, vault_id TEXT, store_id TEXT) STRICT;
    INSERT INTO project_meta VALUES (1, '${PROJECT_ID}', '${VAULT_ID}', '${STORE_ID}');
    CREATE TABLE events(
      global_position INTEGER PRIMARY KEY, event_id TEXT, project_id TEXT, vault_id TEXT,
      store_id TEXT, workspace_id TEXT, branch_scope_id TEXT, branch_ref TEXT,
      stream_id TEXT, stream_type TEXT, stream_version INTEGER, event_type TEXT,
      event_schema_version INTEGER, session_id TEXT, parent_session_id TEXT,
      actor_role TEXT, agent_id TEXT, client_instance_id TEXT, correlation_id TEXT,
      causation_id TEXT, command_id TEXT, idempotency_key TEXT, command_event_index INTEGER,
      occurred_at TEXT, recorded_at TEXT, visibility_scope TEXT, confidence TEXT,
      verification_status TEXT, source_refs_json TEXT, evidence_refs_json TEXT,
      evidence_digests_json TEXT, payload_json TEXT, payload_hash TEXT,
      previous_global_hash TEXT, event_hash TEXT, lifecycle_intent_json TEXT
    ) STRICT;
  `);
  return database;
}

function append(database: DatabaseSync, position: number): void {
  const json = canonicalJson({ ignored: position });
  database.prepare(`
    INSERT INTO events VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, 'project', 'project', ?, 'IgnoredEvent', 1, NULL, NULL,
      'primary', 'coordinator-test', 'coordinator-client', ?, NULL, ?, ?, 0,
      ?, ?, 'project', 'high', 'verified', '[]', '[]', '[]', ?, ?, ?, ?, NULL
    )
  `).run(
    position,
    `00000000-0000-4000-8000-${String(position).padStart(12, "0")}`,
    PROJECT_ID,
    VAULT_ID,
    STORE_ID,
    WORKSPACE_ID,
    BRANCH_SCOPE_ID,
    BRANCH_REF,
    position,
    `00000000-0000-4000-a000-${String(position).padStart(12, "0")}`,
    `00000000-0000-4000-9000-${String(position).padStart(12, "0")}`,
    `coordinator/${position}`,
    NOW,
    NOW,
    json,
    payloadHash({ ignored: position }),
    position === 1 ? "0".repeat(64) : String(position - 1).repeat(64).slice(0, 64),
    String(position).repeat(64).slice(0, 64),
  );
}

function emptySnapshot(onClose: () => void = () => undefined): ProjectionEventSnapshot {
  let closed = false;
  return Object.freeze({
    binding: BINDING,
    events: Object.freeze([]),
    terminalEventPosition: 0n,
    terminalEventHash: "0".repeat(64),
    close(): void {
      if (closed) return;
      closed = true;
      onClose();
    },
  });
}

class PublishDuringAcquireRegistry extends ProjectionReaderLeaseRegistry {
  replacement: BuiltProjectionGeneration | null = null;

  override acquire(generation: Parameters<ProjectionReaderLeaseRegistry["acquire"]>[0]) {
    const replacement = this.replacement;
    if (replacement !== null) {
      this.replacement = null;
      publishProjectionManifest({
        projectionDirectory: replacement.projectionDirectory,
        manifest: replacement.manifest,
        expectedBinding: BINDING,
      });
      this.retire(generation);
    }
    return super.acquire(generation);
  }
}

describe("projection build coordinator", () => {
  it("publishes atomically, preserves crash-window authority, serializes builds, and pins leases", async () => {
    const root = mkdtempSync(join(tmpdir(), "projection-coordinator-"));
    roots.push(root);
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const source = sourceDatabase(sourcePath);
    for (let position = 1; position <= 8; position += 1) append(source, position);

    const driver = new NodeSqliteDriver({ DatabaseSync });
    const eventReader = new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath });
    const concreteBuilder = new ImmutableProjectionBuilder({
      driver,
      projectionDirectory,
      now: () => NOW,
    });
    let activeBuilds = 0;
    let maximumActiveBuilds = 0;
    const builder: ProjectionGenerationBuilder = {
      async build(snapshot, generation) {
        activeBuilds += 1;
        maximumActiveBuilds = Math.max(maximumActiveBuilds, activeBuilds);
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        try {
          return await concreteBuilder.build(snapshot, generation);
        } finally {
          activeBuilds -= 1;
        }
      },
    };
    let failAfterFsync = false;
    const leases = new ProjectionReaderLeaseRegistry();
    const coordinator = new DefaultProjectionBuildCoordinator({
      eventReader,
      builder,
      leases,
      projectionDirectory,
      faultInjector: {
        hit(boundary) {
          if (failAfterFsync && boundary === "after-generation-fsync-before-manifest") {
            throw new Error("injected after-generation-fsync-before-manifest");
          }
        },
      },
    });

    // Only exact coordinator-owned temporary names may be reclaimed.
    mkdirSync(projectionDirectory);
    const knownManifestTemp = join(projectionDirectory, ".projection-manifest.json.tmp");
    const knownGenerationTemp = join(projectionDirectory, ".projections-1-77.sqlite.tmp");
    const unrelatedTemp = join(projectionDirectory, "unrelated.tmp");
    writeFileSync(knownManifestTemp, "stale", "utf8");
    writeFileSync(knownGenerationTemp, "stale", "utf8");
    writeFileSync(unrelatedTemp, "keep", "utf8");
    const result = await coordinator.ensurePublished(BINDING, 8n, 2_000);
    assert.equal(result.manifest.terminalEventPosition, "8");
    assert.equal(result.manifest.sessionId, null);
    assert.equal(existsSync(knownManifestTemp), false);
    assert.equal(existsSync(knownGenerationTemp), false);
    assert.equal(existsSync(unrelatedTemp), true);
    const firstDatabase = result.databasePath;
    const firstBytes = readFileSync(firstDatabase);
    const oldReader = await coordinator.leasePublished(BINDING);

    append(source, 9);
    failAfterFsync = true;
    await assert.rejects(
      () => coordinator.ensurePublished(BINDING, 9n, 2_000),
      /after-generation-fsync-before-manifest/u,
    );
    assert.equal(source.prepare("SELECT count(*) AS n FROM events").get()?.n, 9);
    const manifestPath = join(projectionDirectory, "projection-manifest.json");
    assert.equal(
      parseProjectionManifest(JSON.parse(readFileSync(manifestPath, "utf8")), BINDING)
        .terminalEventPosition,
      "8",
    );
    assert.deepEqual(readFileSync(firstDatabase), firstBytes);

    failAfterFsync = false;
    const ninth = await coordinator.ensurePublished(BINDING, 9n, 2_000);
    assert.equal(ninth.manifest.terminalEventPosition, "9");
    assert.equal(existsSync(firstDatabase), true, "leased retired generation must remain");
    oldReader.close();
    assert.equal(existsSync(firstDatabase), false, "closed retired generation may be reclaimed");

    append(source, 10);
    const concurrent = await Promise.all([
      coordinator.ensurePublished(BINDING, 10n, 2_000),
      coordinator.ensurePublished(BINDING, 10n, 2_000),
    ]);
    assert.equal(concurrent[0].manifest.terminalEventPosition, "10");
    assert.equal(concurrent[1].manifest.terminalEventPosition, "10");
    assert.equal(maximumActiveBuilds, 1);

    await assert.rejects(
      () => coordinator.ensurePublished(BINDING, 11n, 5),
      (error: unknown) => error instanceof ProjectionLagError
        && error.code === "PROJECTION_LAG"
        && error.requiredEventPosition === 11n
        && error.availableEventPosition === 10n,
    );
    assert.equal(existsSync(unrelatedTemp), true);
    source.close();
  });

  it("reselects the manifest when publication retires a generation between load and acquire", async () => {
    const root = mkdtempSync(join(tmpdir(), "projection-lease-race-"));
    roots.push(root);
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const source = sourceDatabase(sourcePath);
    for (let position = 1; position <= 8; position += 1) append(source, position);
    const driver = new NodeSqliteDriver({ DatabaseSync });
    const eventReader = new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath });
    const builder = new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW });
    const leases = new PublishDuringAcquireRegistry();
    const coordinator = new DefaultProjectionBuildCoordinator({
      eventReader,
      builder,
      leases,
      projectionDirectory,
    });

    const first = await coordinator.ensurePublished(BINDING, 8n, 2_000);
    append(source, 9);
    const snapshot = await eventReader.openCommittedSnapshot(BINDING);
    leases.replacement = await builder.build(snapshot, 2);
    snapshot.close();

    const lease = await coordinator.leasePublished(BINDING);
    assert.equal(lease.manifest.generation, 2);
    assert.equal(lease.manifest.terminalEventPosition, "9");
    assert.equal(existsSync(lease.databasePath), true);
    assert.equal(existsSync(first.databasePath), false);
    lease.close();
    source.close();
  });

  it("returns projection lag at a zero deadline without starting source or build work", async () => {
    const root = mkdtempSync(join(tmpdir(), "projection-zero-deadline-"));
    roots.push(root);
    let reads = 0;
    let builds = 0;
    const coordinator = new DefaultProjectionBuildCoordinator({
      projectionDirectory: join(root, "projections"),
      eventReader: {
        async openCommittedSnapshot() {
          reads += 1;
          return emptySnapshot();
        },
      },
      builder: {
        async build() {
          builds += 1;
          throw new Error("builder must not run");
        },
      },
    });

    await assert.rejects(
      () => coordinator.ensurePublished(BINDING, 1n, 0),
      (error: unknown) => error instanceof ProjectionLagError,
    );
    assert.equal(reads, 0);
    assert.equal(builds, 0);
  });

  it("returns projection lag at a zero deadline even when a sufficient generation exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "projection-existing-zero-deadline-"));
    roots.push(root);
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const source = sourceDatabase(sourcePath);
    append(source, 1);
    const driver = new NodeSqliteDriver({ DatabaseSync });
    const coordinator = new DefaultProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
    });
    await coordinator.ensurePublished(BINDING, 1n, 2_000);

    await assert.rejects(
      () => coordinator.ensurePublished(BINDING, 1n, 0),
      (error: unknown) => error instanceof ProjectionLagError
        && error.availableEventPosition === 1n,
    );
    source.close();
  });

  it("maps a synchronously blocking source rejection observed after expiry to projection lag", async () => {
    const root = mkdtempSync(join(tmpdir(), "projection-blocking-deadline-"));
    roots.push(root);
    const projectionDirectory = join(root, "projections");
    const coordinator = new DefaultProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: {
        async openCommittedSnapshot() {
          const releaseAt = Date.now() + 25;
          while (Date.now() < releaseAt) {
            // Deliberately block the event loop past the absolute deadline.
          }
          throw new Error("late synchronous source failure");
        },
      },
      builder: { async build() { throw new Error("not reached"); } },
    });

    await assert.rejects(
      () => coordinator.ensurePublished(BINDING, 1n, 5),
      (error: unknown) => error instanceof ProjectionLagError,
    );
    assert.equal(existsSync(join(projectionDirectory, "projection-manifest.json")), false);
  });

  it("bounds a slow source snapshot and closes its late result without invoking the builder", async () => {
    const root = mkdtempSync(join(tmpdir(), "projection-slow-snapshot-"));
    roots.push(root);
    let closed = 0;
    let builds = 0;
    const eventReader: ProjectionEventReader = {
      async openCommittedSnapshot() {
        await new Promise<void>((resolve) => setTimeout(resolve, 35));
        return emptySnapshot(() => { closed += 1; });
      },
    };
    const coordinator = new DefaultProjectionBuildCoordinator({
      projectionDirectory: join(root, "projections"),
      eventReader,
      builder: {
        async build() {
          builds += 1;
          throw new Error("late builder must not run");
        },
      },
    });

    await assert.rejects(
      () => coordinator.ensurePublished(BINDING, 1n, 5),
      (error: unknown) => error instanceof ProjectionLagError,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.equal(closed, 1);
    assert.equal(builds, 0);
  });

  it("does not publish a build that completes after its caller deadline", async () => {
    const root = mkdtempSync(join(tmpdir(), "projection-slow-build-"));
    roots.push(root);
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const source = sourceDatabase(sourcePath);
    append(source, 1);
    const driver = new NodeSqliteDriver({ DatabaseSync });
    const eventReader = new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath });
    const concrete = new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW });
    const coordinator = new DefaultProjectionBuildCoordinator({
      projectionDirectory,
      eventReader,
      builder: {
        async build(snapshot, generation) {
          await new Promise<void>((resolve) => setTimeout(resolve, 35));
          return concrete.build(snapshot, generation);
        },
      },
    });

    await assert.rejects(
      () => coordinator.ensurePublished(BINDING, 1n, 5),
      (error: unknown) => error instanceof ProjectionLagError,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 70));
    assert.equal(existsSync(join(projectionDirectory, "projection-manifest.json")), false);
    source.close();
  });

  it("rejects a symlink-shaped projection directory before cleanup traversal", () => {
    const root = mkdtempSync(join(tmpdir(), "projection-path-safety-"));
    roots.push(root);
    const projectionDirectory = join(root, "projections");
    mkdirSync(projectionDirectory);
    const knownTemp = join(projectionDirectory, ".projection-manifest.json.tmp");
    writeFileSync(knownTemp, "outside-authority", "utf8");
    const inspection: ProjectionPathInspection = {
      lstat(path) {
        const stat = lstatSync(path);
        if (path !== projectionDirectory) return stat;
        return {
          isDirectory: () => true,
          isFile: () => false,
          isSymbolicLink: () => true,
        };
      },
      realpath: realpathSync,
    };

    assert.throws(
      () => new DefaultProjectionBuildCoordinator({
        projectionDirectory,
        eventReader: { async openCommittedSnapshot() { return emptySnapshot(); } },
        builder: { async build() { throw new Error("not reached"); } },
        pathInspection: inspection,
      }),
      /PROJECTION_PATH_INVALID/u,
    );
    assert.equal(readFileSync(knownTemp, "utf8"), "outside-authority");
  });

  it("does not follow a projection directory replaced after cleanup authorization", async () => {
    const root = mkdtempSync(join(tmpdir(), "projection-cleanup-swap-"));
    roots.push(root);
    const projectionDirectory = join(root, "projections");
    const originalDirectory = join(root, "original-projections");
    const attackerDirectory = join(root, "attacker-directory");
    mkdirSync(projectionDirectory);
    mkdirSync(attackerDirectory);
    const knownName = ".projection-manifest.json.tmp";
    writeFileSync(join(projectionDirectory, knownName), "owned stale temp", "utf8");
    writeFileSync(join(attackerDirectory, knownName), "outside victim", "utf8");
    let directoryRealpaths = 0;
    const inspection: ProjectionPathInspection = {
      lstat: lstatSync,
      realpath(path) {
        if (path === projectionDirectory) {
          directoryRealpaths += 1;
          if (directoryRealpaths === 3) {
            renameSync(projectionDirectory, originalDirectory);
            renameSync(attackerDirectory, projectionDirectory);
            return projectionDirectory;
          }
        }
        return realpathSync(path);
      },
    };
    const coordinator = new DefaultProjectionBuildCoordinator({
      projectionDirectory,
      pathInspection: inspection,
      eventReader: { async openCommittedSnapshot() { throw new Error("source must not run"); } },
      builder: { async build() { throw new Error("builder must not run"); } },
    });

    await assert.rejects(
      () => coordinator.ensurePublished(BINDING, 1n, 2_000),
      /PROJECTION_PATH_INVALID/u,
    );
    assert.equal(readFileSync(join(projectionDirectory, knownName), "utf8"), "outside victim");
    assert.equal(readFileSync(join(originalDirectory, knownName), "utf8"), "owned stale temp");
  });

  it("never reclaims through a replaced parent and retries against the pinned directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "projection-reclaim-parent-swap-"));
    roots.push(root);
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const originalDirectory = join(root, "original-projections");
    const attackerDirectory = join(root, "attacker-directory");
    const displacedAttackerDirectory = join(root, "displaced-attacker");
    const source = sourceDatabase(sourcePath);
    append(source, 1);
    const driver = new NodeSqliteDriver({ DatabaseSync });
    const leases = new ProjectionReaderLeaseRegistry();
    const coordinator = new DefaultProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
      leases,
    });
    const published = await coordinator.ensurePublished(BINDING, 1n, 2_000);
    mkdirSync(attackerDirectory);
    writeFileSync(join(attackerDirectory, published.manifest.databaseFile), "outside victim", "utf8");
    renameSync(projectionDirectory, originalDirectory);
    renameSync(attackerDirectory, projectionDirectory);

    leases.retire(published);
    assert.equal(
      readFileSync(join(projectionDirectory, published.manifest.databaseFile), "utf8"),
      "outside victim",
    );
    assert.equal(leases.reclamationIssues().length, 1);

    renameSync(projectionDirectory, displacedAttackerDirectory);
    renameSync(originalDirectory, projectionDirectory);
    leases.retryReclamation();
    assert.equal(existsSync(published.databasePath), false);
    assert.equal(
      readFileSync(join(displacedAttackerDirectory, published.manifest.databaseFile), "utf8"),
      "outside victim",
    );
    assert.equal(leases.reclamationIssues().length, 0);
    source.close();
  });

  it("keeps publication successful and records retryable retired-file cleanup failures", async () => {
    const root = mkdtempSync(join(tmpdir(), "projection-reclaim-retry-"));
    roots.push(root);
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const source = sourceDatabase(sourcePath);
    append(source, 1);
    const driver = new NodeSqliteDriver({ DatabaseSync });
    const eventReader = new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath });
    const builder = new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW });
    let directorySyncs = 0;
    const leases = new ProjectionReaderLeaseRegistry(() => {
      directorySyncs += 1;
      if (directorySyncs === 1) throw new Error("injected retired-directory fsync failure");
    });
    const coordinator = new DefaultProjectionBuildCoordinator({
      projectionDirectory,
      eventReader,
      builder,
      leases,
    });

    const first = await coordinator.ensurePublished(BINDING, 1n, 2_000);
    append(source, 2);
    const second = await coordinator.ensurePublished(BINDING, 2n, 2_000);
    assert.equal(second.manifest.terminalEventPosition, "2");
    assert.equal(
      parseProjectionManifest(
        JSON.parse(readFileSync(join(projectionDirectory, "projection-manifest.json"), "utf8")),
        BINDING,
      ).generation,
      second.manifest.generation,
    );
    assert.equal(existsSync(first.databasePath), false);
    assert.equal(leases.reclamationIssues().length, 1);
    leases.retryReclamation();
    assert.equal(leases.reclamationIssues().length, 0);
    assert.equal(directorySyncs, 2);
    source.close();
  });
});
