import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
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
import { ImmutableProjectionBuilder } from "../src/orchestrator/projections/builder.js";
import {
  DefaultProjectionBuildCoordinator,
  ProjectionLagError,
  type ProjectionGenerationBuilder,
} from "../src/orchestrator/projections/coordinator.js";
import type { ProjectBinding } from "../src/orchestrator/projections/contracts.js";
import { SqliteProjectionEventReader } from "../src/orchestrator/projections/event-reader.js";
import { parseProjectionManifest } from "../src/orchestrator/projections/manifest.js";
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
    const result = await coordinator.ensurePublished(BINDING, 8n, 200);
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
      () => coordinator.ensurePublished(BINDING, 9n, 200),
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
    const ninth = await coordinator.ensurePublished(BINDING, 9n, 200);
    assert.equal(ninth.manifest.terminalEventPosition, "9");
    assert.equal(existsSync(firstDatabase), true, "leased retired generation must remain");
    oldReader.close();
    assert.equal(existsSync(firstDatabase), false, "closed retired generation may be reclaimed");

    append(source, 10);
    const concurrent = await Promise.all([
      coordinator.ensurePublished(BINDING, 10n, 200),
      coordinator.ensurePublished(BINDING, 10n, 200),
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
});
