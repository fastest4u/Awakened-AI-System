import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, type TestContext } from "node:test";
import {
  createProjectionFixtureControls,
  rootEvidence,
  forwardingInspection,
  assertRawProjectionRefusal,
  samePathSpelling,
  type SpellingEvidence,
} from "./support/projection-fixture-controls.js";

import { eventHash, payloadHash } from "../src/orchestrator/crypto/event-hash.js";
import type {
  BranchScopeId,
  ProjectId,
  StoreId,
  VaultId,
  WorkspaceId,
} from "../src/orchestrator/identity/contracts.js";
import { LifecycleError } from "../src/orchestrator/lifecycle/errors.js";
import {
  ImmutableProjectionBuilder,
  type BuiltProjectionGeneration,
} from "../src/orchestrator/projections/builder.js";
import {
  DefaultProjectionBuildCoordinator,
  ProjectionLagError,
  V2ProjectionBuildCoordinator,
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
  parseProjectionManifestV2,
  publishProjectionManifest,
  type ProjectionPathInspection,
} from "../src/orchestrator/projections/manifest.js";
import { ProjectionReaderLeaseRegistry } from "../src/orchestrator/projections/reader-lease.js";
import {
  filesystemStableProjectionDirectoryOperations,
  PROJECTION_MANIFEST_PUBLICATION_LOCK_FILENAME,
} from "../src/orchestrator/projections/stable-directory.js";
import {
  V2ProjectionReaderLeaseRegistry,
  type V2ProjectionReaderLease,
} from "../src/orchestrator/projections/v2-reader-lease.js";
import { PROJECT_MEMORY_APPLICATION_ID } from "../src/orchestrator/runtime/runtime-capabilities.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import { GENESIS_GLOBAL_HASH } from "../src/orchestrator/storage/event-store.js";
import { capturePathSnapshot, createCiDiagnosticCollector } from "./support/ci-path-diagnostics.js";

const PROJECT_ID = "1".repeat(64) as ProjectId;
const VAULT_ID = "2".repeat(64) as VaultId;
const STORE_ID = "3".repeat(64) as StoreId;
const WORKSPACE_ID = "4".repeat(64) as WorkspaceId;
const BRANCH_SCOPE_ID = "00000000-0000-4000-8000-000000000051" as BranchScopeId;
const BRANCH_REF = "refs/heads/projection-coordinator";
const NOW = "2026-08-23T03:00:00.000Z";
const FUNCTIONAL_TEST_DEADLINE_MS = 15_000;
const BINDING: ProjectBinding = Object.freeze({
  projectId: PROJECT_ID,
  vaultId: VAULT_ID,
  storeId: STORE_ID,
  workspaceId: WORKSPACE_ID,
  branchScopeId: BRANCH_SCOPE_ID,
  branchRef: BRANCH_REF,
  sessionId: null,
});

const { it, fixtureRoot, ownerForPath, cleanupFixtures, roots, trackResource, closeOwned, fixtureDatabase } = createProjectionFixtureControls();
afterEach(t => {
  try { cleanupFixtures(t as TestContext); } finally { activeEvidence = undefined; }
});

function sourceDatabase(path: string): DatabaseSync {
  const database = fixtureDatabase(path);
  try { database.exec(`
    PRAGMA application_id = ${PROJECT_MEMORY_APPLICATION_ID};
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE project_meta(singleton INTEGER PRIMARY KEY, project_id TEXT, vault_id TEXT, store_id TEXT) STRICT;
    INSERT INTO project_meta VALUES (1, '${PROJECT_ID}', '${VAULT_ID}', '${STORE_ID}');
    CREATE TABLE command_dedup(project_id TEXT, command_id TEXT, idempotency_key TEXT, command_type TEXT) STRICT;
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
  `); }
  catch (primary) {
    try { closeOwned(database); } catch { ownerForPath(path).retain(); }
    throw primary;
  }
  return database;
}

function append(
  database: DatabaseSync,
  position: number,
  scope: Readonly<{
    workspaceId?: string;
    branchScopeId?: string | null;
    branchRef?: string | null;
  }> = {},
): void {
  const workspaceId = scope.workspaceId ?? WORKSPACE_ID;
  const branchScopeId = scope.branchScopeId === undefined ? BRANCH_SCOPE_ID : scope.branchScopeId;
  const branchRef = scope.branchRef === undefined ? BRANCH_REF : scope.branchRef;
  const payload = { ignored: position };
  const json = canonicalJson(payload);
  const eventId = `00000000-0000-4000-8000-${String(position).padStart(12, "0")}`;
  const correlationId = `00000000-0000-4000-a000-${String(position).padStart(12, "0")}`;
  const commandId = `00000000-0000-4000-9000-${String(position).padStart(12, "0")}`;
  const hashedPayload = payloadHash(payload);
  const previousGlobalHash = position === 1
    ? GENESIS_GLOBAL_HASH
    : database.prepare("SELECT event_hash FROM events WHERE global_position = ?").get(position - 1)?.event_hash;
  if (typeof previousGlobalHash !== "string") throw new Error("missing predecessor fixture hash");
  const hashMaterial = {
    globalPosition: String(position),
    eventId,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId,
    branchScopeId,
    branchRef,
    streamId: "project",
    streamType: "project",
    streamVersion: String(position),
    eventType: "IgnoredEvent",
    eventSchemaVersion: 1,
    sessionId: null,
    parentSessionId: null,
    actorRole: "primary",
    agentId: "coordinator-test",
    clientInstanceId: "coordinator-client",
    correlationId,
    causationId: null,
    commandId,
    idempotencyKey: `coordinator/${position}`,
    commandEventIndex: 0,
    occurredAt: NOW,
    recordedAt: NOW,
    visibilityScope: "project",
    confidence: "high",
    verificationStatus: "verified",
    sourceRefs: [],
    evidenceRefs: [],
    evidenceDigests: [],
    payloadHash: hashedPayload,
    previousGlobalHash,
  };
  database.prepare(`
    INSERT INTO events VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, 'project', 'project', ?, 'IgnoredEvent', 1, NULL, NULL,
      'primary', 'coordinator-test', 'coordinator-client', ?, NULL, ?, ?, 0,
      ?, ?, 'project', 'high', 'verified', '[]', '[]', '[]', ?, ?, ?, ?, NULL
    )
  `).run(
    position,
    eventId,
    PROJECT_ID,
    VAULT_ID,
    STORE_ID,
    workspaceId,
    branchScopeId,
    branchRef,
    position,
    correlationId,
    commandId,
    `coordinator/${position}`,
    NOW,
    NOW,
    json,
    hashedPayload,
    previousGlobalHash,
    eventHash(hashMaterial),
  );
}

function emptySnapshot(onClose: () => void = () => undefined): ProjectionEventSnapshot {
  let closed = false;
  let streamed = false;
  return Object.freeze({
    binding: BINDING,
    eventCount: 0,
    aggregateBytes: 0,
    terminalEventPosition: 0n,
    terminalEventHash: "0".repeat(64),
    events(): Iterable<never> {
      if (streamed) throw new Error("INTEGRITY_FAILURE");
      streamed = true;
      return Object.freeze([]);
    },
    close(): void {
      if (closed) return;
      closed = true;
      onClose();
    },
  }) as unknown as ProjectionEventSnapshot;
}

function denyingSidecarInspection(isArmed: () => boolean): ProjectionPathInspection {
  return Object.freeze({
    lstat(path: string) {
      if (isArmed() && (path.endsWith("-wal") || path.endsWith("-shm"))) {
        throw Object.assign(new Error("injected exact-sidecar lstat denial"), { code: "EACCES" });
      }
      return lstatSync(path);
    },
    realpath: (path: string) => realpathSync(path),
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

interface PublishedV2CoordinatorFixture {
  readonly source: DatabaseSync;
  readonly coordinator: V2ProjectionBuildCoordinator;
  readonly projectionDirectory: string;
}

async function publishedV2CoordinatorFixture(
  evaluationLeases?: V2ProjectionReaderLeaseRegistry,
): Promise<PublishedV2CoordinatorFixture> {
  const root = fixtureRoot("projection-v2-evaluation-lease-", "native");
  const sourcePath = join(root, "events.sqlite");
  const projectionDirectory = join(root, "projections");
  const source = sourceDatabase(sourcePath);
  append(source, 1);
  const driver = new NodeSqliteDriver({ DatabaseSync });
  const coordinator = new V2ProjectionBuildCoordinator({
    projectionDirectory,
    eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
    builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
    evaluationLeases,
    now: () => 0,
  });
  await coordinator.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS);
  return Object.freeze({ source, coordinator, projectionDirectory });
}

interface V2DeadlineFixture {
  readonly source: DatabaseSync;
  readonly coordinator: V2ProjectionBuildCoordinator;
  readonly projectionDirectory: string;
  readonly calls: Readonly<{ sourceSnapshots: number; builds: number }>;
  setNow(now: () => number): void;
}

async function v2DeadlineFixture(): Promise<V2DeadlineFixture> {
  const root = fixtureRoot("projection-v2-deadline-", "native");
  const sourcePath = join(root, "events.sqlite");
  const projectionDirectory = join(root, "projections");
  const source = sourceDatabase(sourcePath);
  append(source, 1);
  const driver = new NodeSqliteDriver({ DatabaseSync });
  const eventReader = new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath });
  const builder = new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW });
  let currentNow: () => number = () => 0;
  let sourceSnapshots = 0;
  let builds = 0;
  const coordinator = new V2ProjectionBuildCoordinator({
    projectionDirectory,
    eventReader: {
      async openCommittedSnapshot(binding) {
        sourceSnapshots += 1;
        return eventReader.openCommittedSnapshot(binding);
      },
    },
    builder: {
      async buildV2(snapshot, generation) {
        builds += 1;
        return builder.buildV2(snapshot, generation);
      },
    },
    now: () => currentNow(),
  });
  await coordinator.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS);
  return Object.freeze({
    source,
    coordinator,
    projectionDirectory,
    get calls() { return Object.freeze({ sourceSnapshots, builds }); },
    setNow(now: () => number): void { currentNow = now; },
  });
}

function assertOriginalV2EvaluationLease(lease: V2ProjectionReaderLease): void {
  assert.equal(
    Number(lease.database.prepare("SELECT schema_version FROM projection_metadata").get()?.schema_version),
    2,
  );
  assert.equal(
    Number(lease.database.prepare("SELECT terminal_event_position FROM projection_metadata").get()?.terminal_event_position),
    1,
  );
  assert.equal(
    lease.database.prepare("SELECT created_at FROM projection_metadata").get()?.created_at,
    NOW,
  );
}

class SwapAfterV2EvaluatorLeaseRegistry extends V2ProjectionReaderLeaseRegistry {
  captured: V2ProjectionReaderLease | undefined;
  readonly #afterAcquire: () => void;

  constructor(afterAcquire: () => void) {
    super();
    this.#afterAcquire = afterAcquire;
  }

  override acquire(
    generation: Parameters<V2ProjectionReaderLeaseRegistry["acquire"]>[0],
  ): V2ProjectionReaderLease {
    const lease = super.acquire(generation);
    this.captured = lease;
    this.#afterAcquire();
    return lease;
  }
}


let activeEvidence: SpellingEvidence | undefined;

async function assertV2Adoption(t: TestContext, rootSpelling: "raw" | "native"): Promise<void> {
  const root = fixtureRoot("projection-v2-adoption-", rootSpelling);
  const evidence = rootEvidence(ownerForPath(root), root, rootSpelling);
  activeEvidence = evidence;
  const sourcePath = join(root, "events.sqlite");
  const projectionDirectory = join(root, "projections");
  const source = sourceDatabase(sourcePath);
  const collector = createCiDiagnosticCollector(line => t.diagnostic(line));
  let primaryFailed = false;
  try {
    append(source, 1);
    const driver = new NodeSqliteDriver({ DatabaseSync });
    evidence.phase = "coordinator-constructor";
    const coordinator = new V2ProjectionBuildCoordinator({
      pathInspection: forwardingInspection(evidence, projectionDirectory),
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
    });

    capturePathSnapshot({ family: "coordinator", caseId: "coordinator-control", directory: projectionDirectory }, collector);
    evidence.phase = "ensure-published";
    const published = await coordinator.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS);
    assert.equal(published.manifest.schemaVersion, 2);
    assert.equal(published.manifest.databaseFile, "projections-2-1.sqlite");
    assert.equal(existsSync(published.databasePath), true);
    assert.equal(
      parseProjectionManifestV2(
        JSON.parse(readFileSync(join(projectionDirectory, "projection-manifest.json"), "utf8")),
        BINDING,
      ).databaseSha256,
      published.manifest.databaseSha256,
    );
    assert.deepEqual(
      readdirSync(projectionDirectory).filter((name) => name.startsWith(".projections-2-")),
      [],
    );
    evidence.phase = "business-assertions-completed";
  } catch (error) { primaryFailed = true; throw error; }
  finally {
    let closed = false;
    try { closeOwned(source); closed = true; }
    catch (error) { if (!primaryFailed) throw error; }
    finally {
      try {
        t.diagnostic(`CI path diagnostics incomplete=${collector.incomplete}`);
        t.diagnostic(`owned source closure=${closed ? "closed" : "unavailable"}`);
      } catch { /* Reporting cannot replace the primary outcome or prevent closure. */ }
    }
  }
}

describe("projection build coordinator", () => {
  it("coordinator fixture retains root when source setup cannot close", () => {
    const root = fixtureRoot("projection-source-setup-close-", "native");
    const setupError = new Error("controlled source setup failure");
    const closeError = new Error("controlled uncertainty after native close returned");
    const originalExec = DatabaseSync.prototype.exec;
    const originalClose = DatabaseSync.prototype.close;
    let acquired: DatabaseSync | undefined;
    let nativeClosed = false;
    let closeAttempts = 0;
    let acquiredPath: unknown;
    try {
      DatabaseSync.prototype.exec = function () { acquired = this; acquiredPath = this.prepare("PRAGMA database_list").get()?.file; throw setupError; };
      DatabaseSync.prototype.close = function () {
        closeAttempts += 1;
        originalClose.call(this);
        nativeClosed = true;
        throw closeError;
      };
      assert.throws(() => sourceDatabase(join(root, "events.sqlite")), error => error === setupError);
      assert.equal(closeAttempts, 1, "setup failure must attempt its acquired native close");
      assert.equal(nativeClosed, true, "injected uncertainty follows a returned native close");
      assert.equal(typeof acquiredPath === "string" && [ownerForPath(root).rawRoot, ownerForPath(root).nativeRoot].some(ownedRoot =>
        samePathSpelling(join(ownedRoot, "events.sqlite"), acquiredPath as string)), true,
      "source opened against a previously proved spelling of the original owned root");
      assert.throws(() => ownerForPath(root).cleanup(), /CI_PROJECTION_FIXTURE_CLEANUP_INCOMPLETE/u);
      assert.equal(existsSync(root), true, "uncertain fixture remains owned and retained");
    } finally {
      DatabaseSync.prototype.exec = originalExec;
      DatabaseSync.prototype.close = originalClose;
      if (acquired !== undefined && !nativeClosed) originalClose.call(acquired);
      roots.splice(roots.indexOf(ownerForPath(root)), 1);
    }
  });
  it("adopts a staged V2 generation before publishing its manifest authority", t => assertV2Adoption(t, "native"));

  it("projection spelling control: coordinator", async t => {
    for (const spelling of ["raw", "native"] as const) {
      let failure: unknown;
      try { await assertV2Adoption(t, spelling); } catch (original) { failure = original; }
      const evidence = activeEvidence!;
      t.diagnostic(`spelling=${spelling} nonNative=${evidence.nonNative} phase=${evidence.phase} inspectionChecks=${JSON.stringify(evidence.inspectionChecks)} captureAttempts=${evidence.captureAttempts} captureOutcome=${evidence.captureOutcome}`);
      if (spelling === "raw" && evidence.nonNative) {
        assertRawProjectionRefusal(failure, evidence);
      } else {
        if (failure !== undefined) throw failure;
        assert.equal(evidence.phase, "business-assertions-completed");
      }
    }
  });

  it("reconciles a positively identified V2 orphan after an install-before-manifest fault", async () => {
    const root = fixtureRoot("projection-v2-orphan-recovery-", "native");
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const source = sourceDatabase(sourcePath);
    append(source, 1);
    const driver = new NodeSqliteDriver({ DatabaseSync });
    const faulted = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
      faultInjector: {
        hit(boundary): void {
          if (boundary === "after-v2-generation-install-before-manifest") {
            throw new Error("injected V2 post-install fault");
          }
        },
      },
    });

    await assert.rejects(
      () => faulted.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS),
      /injected V2 post-install fault/u,
    );
    assert.equal(existsSync(join(projectionDirectory, "projections-2-1.sqlite")), true);
    assert.equal(existsSync(join(projectionDirectory, "projection-manifest.json")), false);

    append(source, 2);
    const restarted = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
    });
    const published = await restarted.ensurePublished(BINDING, 2n, FUNCTIONAL_TEST_DEADLINE_MS);

    assert.equal(published.manifest.generation, 2);
    assert.equal(existsSync(join(projectionDirectory, "projections-2-1.sqlite")), false);
    assert.equal(existsSync(join(projectionDirectory, "projections-2-2.sqlite")), true);
    closeOwned(source);
  });

  it("reconciles an identified V2 orphan even when its active generation already meets the request", async () => {
    const root = fixtureRoot("projection-v2-fresh-orphan-", "native");
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const source = sourceDatabase(sourcePath);
    append(source, 1);
    const driver = new NodeSqliteDriver({ DatabaseSync });
    const healthy = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
    });
    await healthy.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS);

    append(source, 2);
    const faulted = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
      faultInjector: { hit: (boundary) => {
        if (boundary === "after-v2-generation-install-before-manifest") throw new Error("post-install");
      } },
    });
    await assert.rejects(() => faulted.ensurePublished(BINDING, 2n, FUNCTIONAL_TEST_DEADLINE_MS), /post-install/u);
    const orphan = join(projectionDirectory, "projections-2-2.sqlite");
    assert.equal(existsSync(orphan), true);

    const fresh = await healthy.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS);
    assert.equal(fresh.manifest.generation, 1);
    assert.equal(existsSync(orphan), false, "fresh reads must reconcile a verified orphan before return");
    closeOwned(source);
  });

  it("persists a retired V2 generation high-water across reconciliation and coordinator restart", async () => {
    const root = fixtureRoot("projection-v2-retired-high-water-", "native");
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const source = sourceDatabase(sourcePath);
    append(source, 1);
    const driver = new NodeSqliteDriver({ DatabaseSync });
    const healthy = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
    });
    await healthy.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS);

    append(source, 2);
    const faulted = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
      faultInjector: { hit: (boundary) => {
        if (boundary === "after-v2-generation-install-before-manifest") throw new Error("post-install");
      } },
    });
    await assert.rejects(() => faulted.ensurePublished(BINDING, 2n, FUNCTIONAL_TEST_DEADLINE_MS), /post-install/u);
    assert.equal(existsSync(join(projectionDirectory, "projections-2-2.sqlite")), true);

    const reconciler = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
    });
    await reconciler.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS);
    assert.equal(existsSync(join(projectionDirectory, "projections-2-2.sqlite")), false);
    const retired = readdirSync(projectionDirectory).filter((name) => (
      /^\.projections-2-retired-[0-9a-f]{32}\.sqlite$/u.test(name)
    ));
    assert.equal(retired.length, 1, "a verified orphan is retained, never unlinked");
    const journal = JSON.parse(
      readFileSync(join(projectionDirectory, "projection-reconciliation-v2.json"), "utf8"),
    ) as {
      retirements: Array<{
        state: string;
        retiredFilename: string;
        image: { ctimeNs: string };
      }>;
    };
    assert.equal(journal.retirements.length, 1);
    assert.equal(journal.retirements[0]?.state, "retired");
    assert.equal(journal.retirements[0]?.retiredFilename, retired[0]);
    assert.equal(
      journal.retirements[0]?.image.ctimeNs,
      lstatSync(join(projectionDirectory, retired[0]!), { bigint: true }).ctimeNs.toString(),
    );
    assert.equal(
      parseProjectionManifestV2(
        JSON.parse(readFileSync(join(projectionDirectory, "projection-manifest.json"), "utf8")),
        BINDING,
      ).highestObservedGeneration,
      2,
    );

    append(source, 3);
    const restarted = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
    });
    const published = await restarted.ensurePublished(BINDING, 3n, FUNCTIONAL_TEST_DEADLINE_MS);
    assert.equal(published.manifest.generation, 3, "a retained V2 final name must remain retired after restart");
    closeOwned(source);
  });

  it("recovers a retirement intent after its rename before journal completion", async () => {
    const root = fixtureRoot("projection-v2-retirement-intent-recovery-", "native");
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const journalPath = join(projectionDirectory, "projection-reconciliation-v2.json");
    const source = sourceDatabase(sourcePath);
    append(source, 1);
    const driver = new NodeSqliteDriver({ DatabaseSync });
    const faulted = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
      faultInjector: { hit(boundary): void {
        if (boundary === "after-v2-generation-install-before-manifest") throw new Error("post-install");
      } },
    });
    await assert.rejects(() => faulted.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS), /post-install/u);

    const interrupted = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
      faultInjector: { hit(boundary): void {
        if (boundary === "after-v2-retirement-rename-before-complete") {
          throw new Error("rename-before-complete");
        }
      } },
    });
    await assert.rejects(
      () => interrupted.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS),
      /rename-before-complete/u,
    );
    const afterFault = JSON.parse(readFileSync(journalPath, "utf8")) as {
      retirements: readonly { state: string }[];
    };
    assert.equal(afterFault.retirements[0]?.state, "intent");
    assert.equal(existsSync(join(projectionDirectory, "projections-2-1.sqlite")), false);
    rmSync(join(projectionDirectory, PROJECTION_MANIFEST_PUBLICATION_LOCK_FILENAME));
    const restart = spawnSync(process.execPath, ["--input-type=module", "--eval", `
      import { DatabaseSync } from "node:sqlite";
      import { ImmutableProjectionBuilder } from "./dist-test/src/orchestrator/projections/builder.js";
      import { V2ProjectionBuildCoordinator } from "./dist-test/src/orchestrator/projections/coordinator.js";
      import { SqliteProjectionEventReader } from "./dist-test/src/orchestrator/projections/event-reader.js";
      import { NodeSqliteDriver } from "./dist-test/src/orchestrator/storage/node-sqlite-driver.js";

      const driver = new NodeSqliteDriver({ DatabaseSync });
      const coordinator = new V2ProjectionBuildCoordinator({
        projectionDirectory: ${JSON.stringify(projectionDirectory)},
        eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: ${JSON.stringify(sourcePath)} }),
        builder: new ImmutableProjectionBuilder({
          driver,
          projectionDirectory: ${JSON.stringify(projectionDirectory)},
          now: () => ${JSON.stringify(NOW)},
        }),
      });
      await coordinator.ensurePublished(${JSON.stringify(BINDING)}, 1n, ${FUNCTIONAL_TEST_DEADLINE_MS});
    `], { cwd: process.cwd(), encoding: "utf8", timeout: 15_000 });
    assert.equal(restart.status, 0, restart.stderr);
    const retiredName = readdirSync(projectionDirectory).find((name) => (
      /^\.projections-2-retired-[0-9a-f]{32}\.sqlite$/u.test(name)
    ));
    assert.notEqual(retiredName, undefined);
    const afterRestart = JSON.parse(readFileSync(journalPath, "utf8")) as {
      retirements: readonly { state: string; image: { ctimeNs: string } }[];
    };
    assert.equal(afterRestart.retirements[0]?.state, "retired");
    assert.equal(
      afterRestart.retirements[0]?.image.ctimeNs,
      lstatSync(join(projectionDirectory, retiredName!), { bigint: true }).ctimeNs.toString(),
    );
    assert.equal(existsSync(join(projectionDirectory, "projections-2-1.sqlite")), false);
    closeOwned(source);
  });

  it("recovers a retirement intent before its rename in a fresh process", async () => {
    const root = fixtureRoot("projection-v2-retirement-intent-prerename-", "native");
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const journalPath = join(projectionDirectory, "projection-reconciliation-v2.json");
    const source = sourceDatabase(sourcePath);
    append(source, 1);
    const driver = new NodeSqliteDriver({ DatabaseSync });
    const faulted = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
      faultInjector: { hit(boundary): void {
        if (boundary === "after-v2-generation-install-before-manifest") throw new Error("post-install");
      } },
    });
    await assert.rejects(() => faulted.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS), /post-install/u);

    const interrupted = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
      faultInjector: { hit(boundary): void {
        if (boundary === "after-v2-retirement-intent-before-rename") {
          throw new Error("intent-before-rename");
        }
      } },
    });
    await assert.rejects(
      () => interrupted.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS),
      /intent-before-rename/u,
    );
    const afterFault = JSON.parse(readFileSync(journalPath, "utf8")) as {
      highestReservedGeneration: number;
      retirements: readonly { state: string }[];
    };
    assert.equal(afterFault.highestReservedGeneration, 1);
    assert.equal(afterFault.retirements[0]?.state, "intent");
    assert.equal(existsSync(join(projectionDirectory, "projections-2-1.sqlite")), true);
    rmSync(join(projectionDirectory, PROJECTION_MANIFEST_PUBLICATION_LOCK_FILENAME));

    const restart = spawnSync(process.execPath, ["--input-type=module", "--eval", `
      import { DatabaseSync } from "node:sqlite";
      import { ImmutableProjectionBuilder } from "./dist-test/src/orchestrator/projections/builder.js";
      import { V2ProjectionBuildCoordinator } from "./dist-test/src/orchestrator/projections/coordinator.js";
      import { SqliteProjectionEventReader } from "./dist-test/src/orchestrator/projections/event-reader.js";
      import { NodeSqliteDriver } from "./dist-test/src/orchestrator/storage/node-sqlite-driver.js";

      const driver = new NodeSqliteDriver({ DatabaseSync });
      const coordinator = new V2ProjectionBuildCoordinator({
        projectionDirectory: ${JSON.stringify(projectionDirectory)},
        eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: ${JSON.stringify(sourcePath)} }),
        builder: new ImmutableProjectionBuilder({
          driver,
          projectionDirectory: ${JSON.stringify(projectionDirectory)},
          now: () => ${JSON.stringify(NOW)},
        }),
      });
      await coordinator.ensurePublished(${JSON.stringify(BINDING)}, 1n, ${FUNCTIONAL_TEST_DEADLINE_MS});
    `], { cwd: process.cwd(), encoding: "utf8", timeout: 15_000 });
    assert.equal(restart.status, 0, restart.stderr);
    const retiredName = readdirSync(projectionDirectory).find((name) => (
      /^\.projections-2-retired-[0-9a-f]{32}\.sqlite$/u.test(name)
    ));
    assert.notEqual(retiredName, undefined);
    const afterRestart = JSON.parse(readFileSync(journalPath, "utf8")) as {
      highestReservedGeneration: number;
      retirements: readonly { state: string; image: { ctimeNs: string } }[];
    };
    assert.equal(afterRestart.highestReservedGeneration, 1);
    assert.equal(afterRestart.retirements[0]?.state, "retired");
    assert.equal(
      afterRestart.retirements[0]?.image.ctimeNs,
      lstatSync(join(projectionDirectory, retiredName!), { bigint: true }).ctimeNs.toString(),
    );
    assert.equal(existsSync(join(projectionDirectory, "projections-2-1.sqlite")), false);
    assert.equal(
      parseProjectionManifestV2(
        JSON.parse(readFileSync(join(projectionDirectory, "projection-manifest.json"), "utf8")),
        BINDING,
      ).generation,
      2,
    );
    closeOwned(source);
  });

  it("rejects ctime-changed retired evidence after its journal record is complete", async () => {
    const root = fixtureRoot("projection-v2-retired-evidence-ctime-", "native");
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const source = sourceDatabase(sourcePath);
    append(source, 1);
    const driver = new NodeSqliteDriver({ DatabaseSync });
    const faulted = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
      faultInjector: { hit(boundary): void {
        if (boundary === "after-v2-generation-install-before-manifest") throw new Error("post-install");
      } },
    });
    await assert.rejects(() => faulted.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS), /post-install/u);

    const reconciler = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
    });
    await reconciler.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS);
    const retiredName = readdirSync(projectionDirectory).find((name) => (
      /^\.projections-2-retired-[0-9a-f]{32}\.sqlite$/u.test(name)
    ));
    assert.notEqual(retiredName, undefined);
    const retiredPath = join(projectionDirectory, retiredName!);
    const ctimeBefore = lstatSync(retiredPath, { bigint: true }).ctimeNs;
    const temporaryPath = join(projectionDirectory, ".retired-evidence-ctime.tmp");
    renameSync(retiredPath, temporaryPath);
    renameSync(temporaryPath, retiredPath);
    assert.notEqual(lstatSync(retiredPath, { bigint: true }).ctimeNs, ctimeBefore);

    const restarted = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
    });
    await assert.rejects(
      () => restarted.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS),
      /PROJECTION_PUBLICATION_RECOVERY_REQUIRED/u,
    );
    assert.equal(existsSync(retiredPath), true);
    assert.equal(existsSync(join(projectionDirectory, PROJECTION_MANIFEST_PUBLICATION_LOCK_FILENAME)), true);
    closeOwned(source);
  });

  it("rejects missing retired evidence after recovery before the final scan", async () => {
    const root = fixtureRoot("projection-v2-retired-evidence-missing-", "native");
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const source = sourceDatabase(sourcePath);
    append(source, 1);
    const driver = new NodeSqliteDriver({ DatabaseSync });
    const faulted = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
      faultInjector: { hit(boundary): void {
        if (boundary === "after-v2-generation-install-before-manifest") throw new Error("post-install");
      } },
    });
    await assert.rejects(() => faulted.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS), /post-install/u);

    const reconciler = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
    });
    await reconciler.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS);
    const retiredName = readdirSync(projectionDirectory).find((name) => (
      /^\.projections-2-retired-[0-9a-f]{32}\.sqlite$/u.test(name)
    ));
    assert.notEqual(retiredName, undefined);
    const retiredPath = join(projectionDirectory, retiredName!);

    const recovery = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
      faultInjector: { hit(boundary): void {
        if (boundary === "after-v2-retirement-recovery-before-final-scan") rmSync(retiredPath);
      } },
    });
    await assert.rejects(
      () => recovery.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS),
      /PROJECTION_PUBLICATION_RECOVERY_REQUIRED/u,
    );
    assert.equal(existsSync(retiredPath), false);
    assert.equal(existsSync(join(projectionDirectory, PROJECTION_MANIFEST_PUBLICATION_LOCK_FILENAME)), true);
    closeOwned(source);
  });

  it("retains swapped retired evidence after recovery before the final scan", async () => {
    const root = fixtureRoot("projection-v2-retired-evidence-swap-", "native");
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const source = sourceDatabase(sourcePath);
    append(source, 1);
    const driver = new NodeSqliteDriver({ DatabaseSync });
    const faulted = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
      faultInjector: { hit(boundary): void {
        if (boundary === "after-v2-generation-install-before-manifest") throw new Error("post-install");
      } },
    });
    await assert.rejects(() => faulted.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS), /post-install/u);

    const reconciler = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
    });
    await reconciler.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS);
    const retiredName = readdirSync(projectionDirectory).find((name) => (
      /^\.projections-2-retired-[0-9a-f]{32}\.sqlite$/u.test(name)
    ));
    assert.notEqual(retiredName, undefined);
    const retiredPath = join(projectionDirectory, retiredName!);
    const retainedBytes = readFileSync(retiredPath);
    const displacedPath = join(projectionDirectory, "displaced-retired-evidence.sqlite");
    const forgedPath = join(projectionDirectory, "forged-retired-evidence.sqlite");
    writeFileSync(forgedPath, "forged retained evidence", "utf8");

    const recovery = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
      faultInjector: { hit(boundary): void {
        if (boundary !== "after-v2-retirement-recovery-before-final-scan") return;
        renameSync(retiredPath, displacedPath);
        renameSync(forgedPath, retiredPath);
      } },
    });
    await assert.rejects(
      () => recovery.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS),
      /PROJECTION_PUBLICATION_RECOVERY_REQUIRED/u,
    );
    assert.deepEqual(readFileSync(displacedPath), retainedBytes);
    assert.equal(readFileSync(retiredPath, "utf8"), "forged retained evidence");
    assert.equal(existsSync(join(projectionDirectory, PROJECTION_MANIFEST_PUBLICATION_LOCK_FILENAME)), true);
    closeOwned(source);
  });

  it("migrates a prior canonical retired V2 generation high-water journal during reconciliation", async () => {
    const root = fixtureRoot("projection-v2-legacy-journal-", "native");
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const source = sourceDatabase(sourcePath);
    append(source, 1);
    const driver = new NodeSqliteDriver({ DatabaseSync });
    const healthy = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
    });
    await healthy.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS);

    append(source, 2);
    const faulted = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
      faultInjector: { hit(boundary): void {
        if (boundary === "after-v2-generation-install-before-manifest") throw new Error("post-install");
      } },
    });
    await assert.rejects(() => faulted.ensurePublished(BINDING, 2n, FUNCTIONAL_TEST_DEADLINE_MS), /post-install/u);
    assert.equal(existsSync(join(projectionDirectory, "projections-2-2.sqlite")), true);

    writeFileSync(
      join(projectionDirectory, "projection-reconciliation-v2.json"),
      '{"highestReservedGeneration":1,"schemaVersion":1}\n',
      "utf8",
    );
    await healthy.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS);

    const journalText = readFileSync(
      join(projectionDirectory, "projection-reconciliation-v2.json"),
      "utf8",
    );
    const journal = JSON.parse(journalText) as {
      highestReservedGeneration: number;
      retirements: Array<{ state: string; retiredFilename: string }>;
      schemaVersion?: unknown;
    };
    assert.equal(journal.highestReservedGeneration, 2);
    assert.equal(journal.retirements.length, 1);
    assert.equal(journal.retirements[0]?.state, "retired");
    assert.match(journal.retirements[0]?.retiredFilename ?? "", /^\.projections-2-retired-[0-9a-f]{32}\.sqlite$/u);
    assert.equal(Object.prototype.hasOwnProperty.call(journal, "schemaVersion"), false);
    assert.equal(journalText, `${JSON.stringify(journal)}\n`);
    closeOwned(source);
  });

  it("rejects a zero retired V2 generation high-water record without rewriting evidence", async () => {
    const root = fixtureRoot("projection-v2-zero-retired-generation-", "native");
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const source = sourceDatabase(sourcePath);
    append(source, 1);
    const driver = new NodeSqliteDriver({ DatabaseSync });
    const coordinator = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
    });
    await coordinator.ensurePublished(BINDING, 1n, 5_000);

    const retiredFilename = `.projections-2-retired-${"a".repeat(32)}.sqlite`;
    const retiredPath = join(projectionDirectory, retiredFilename);
    writeFileSync(retiredPath, "retained evidence", "utf8");
    const journalPath = join(projectionDirectory, "projection-reconciliation-v2.json");
    const journalBytes = `${JSON.stringify({
      highestReservedGeneration: 1,
      retirements: [{
        state: "retired",
        generation: 0,
        retiredFilename,
        image: {
          device: "0",
          inode: "0",
          size: "0",
          ctimeNs: "0",
          sha256: "0".repeat(64),
        },
      }],
    })}\n`;
    writeFileSync(journalPath, journalBytes, "utf8");

    await assert.rejects(
      () => coordinator.ensurePublished(BINDING, 1n, 5_000),
      /PROJECTION_PUBLICATION_RECOVERY_REQUIRED/u,
    );
    assert.equal(readFileSync(journalPath, "utf8"), journalBytes);
    assert.equal(readFileSync(retiredPath, "utf8"), "retained evidence");
    assert.equal(existsSync(join(projectionDirectory, PROJECTION_MANIFEST_PUBLICATION_LOCK_FILENAME)), true);
    closeOwned(source);
  });

  it("rejects unjournaled retired evidence before source access", async () => {
    const root = fixtureRoot("projection-v2-unjournaled-retired-", "native");
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const source = sourceDatabase(sourcePath);
    append(source, 1);
    const driver = new NodeSqliteDriver({ DatabaseSync });
    const healthy = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
    });
    await healthy.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS);
    const retiredPath = join(projectionDirectory, `.projections-2-retired-${"a".repeat(32)}.sqlite`);
    writeFileSync(retiredPath, "unjournaled retained evidence", "utf8");

    const recovery = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: { async openCommittedSnapshot() { throw new Error("source must not run"); } },
      builder: { async buildV2() { throw new Error("builder must not run"); } },
    });
    await assert.rejects(
      () => recovery.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS),
      /PROJECTION_PUBLICATION_RECOVERY_REQUIRED/u,
    );
    assert.equal(existsSync(retiredPath), true);
    assert.equal(existsSync(join(projectionDirectory, PROJECTION_MANIFEST_PUBLICATION_LOCK_FILENAME)), true);
    closeOwned(source);
  });

  it("rejects legacy quarantine evidence before source access", async () => {
    const root = fixtureRoot("projection-v2-legacy-quarantine-", "native");
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const source = sourceDatabase(sourcePath);
    append(source, 1);
    const driver = new NodeSqliteDriver({ DatabaseSync });
    const healthy = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
    });
    await healthy.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS);
    const quarantinePath = join(projectionDirectory, `.projections-2-quarantine-${"b".repeat(32)}.sqlite`);
    writeFileSync(quarantinePath, "legacy quarantine evidence", "utf8");

    const recovery = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: { async openCommittedSnapshot() { throw new Error("source must not run"); } },
      builder: { async buildV2() { throw new Error("builder must not run"); } },
    });
    await assert.rejects(
      () => recovery.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS),
      /PROJECTION_PUBLICATION_RECOVERY_REQUIRED/u,
    );
    assert.equal(existsSync(quarantinePath), true);
    assert.equal(existsSync(join(projectionDirectory, PROJECTION_MANIFEST_PUBLICATION_LOCK_FILENAME)), true);
    closeOwned(source);
  });

  it("does not reuse a reserved V2 final generation after restart without an active manifest", async () => {
    const root = fixtureRoot("projection-v2-journal-without-manifest-", "native");
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const source = sourceDatabase(sourcePath);
    append(source, 1);
    const driver = new NodeSqliteDriver({ DatabaseSync });
    const faulted = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
      faultInjector: { hit(boundary: unknown): void {
        if (boundary === "after-v2-generation-install-before-manifest") throw new Error("post-install");
      } },
    });
    await assert.rejects(() => faulted.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS), /post-install/u);
    assert.equal(existsSync(join(projectionDirectory, "projection-manifest.json")), false);
    assert.equal(existsSync(join(projectionDirectory, "projections-2-1.sqlite")), true);

    const unavailable = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: { async openCommittedSnapshot() { throw new Error("SOURCE_UNAVAILABLE"); } },
      builder: { async buildV2() { throw new Error("builder must not run"); } },
    });
    await assert.rejects(() => unavailable.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS), /SOURCE_UNAVAILABLE/u);
    assert.equal(existsSync(join(projectionDirectory, "projections-2-1.sqlite")), false);
    assert.match(
      readFileSync(join(projectionDirectory, "projection-reconciliation-v2.json"), "utf8"),
      /"highestReservedGeneration":1/u,
    );

    const restarted = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
    });
    const published = await restarted.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS);
    assert.equal(published.manifest.generation, 2);
    closeOwned(source);
  });

  it("durably reserves an orphan before quarantine disposition", async () => {
    const root = fixtureRoot("projection-v2-journal-before-quarantine-", "native");
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const source = sourceDatabase(sourcePath);
    append(source, 1);
    const driver = new NodeSqliteDriver({ DatabaseSync });
    const faulted = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
      faultInjector: { hit(boundary: unknown): void {
        if (boundary === "after-v2-generation-install-before-manifest") throw new Error("post-install");
      } },
    });
    await assert.rejects(() => faulted.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS), /post-install/u);

    const recovery = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
      faultInjector: { hit(boundary: unknown): void {
        if (boundary === "after-v2-orphan-reservation-before-quarantine") throw new Error("crash-after-reservation");
      } },
    });
    await assert.rejects(() => recovery.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS), /crash-after-reservation/u);
    assert.equal(existsSync(join(projectionDirectory, "projections-2-1.sqlite")), true);
    assert.match(
      readFileSync(join(projectionDirectory, "projection-reconciliation-v2.json"), "utf8"),
      /"highestReservedGeneration":1/u,
    );
    assert.equal(existsSync(join(projectionDirectory, PROJECTION_MANIFEST_PUBLICATION_LOCK_FILENAME)), true);
    closeOwned(source);
  });

  it("takes the V2 publication lock before initial source access", async () => {
    const root = fixtureRoot("projection-v2-initial-lock-before-source-", "native");
    const projectionDirectory = join(root, "projections");
    let sawLock = false;
    const coordinator = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: { async openCommittedSnapshot() {
        sawLock = existsSync(join(projectionDirectory, PROJECTION_MANIFEST_PUBLICATION_LOCK_FILENAME));
        throw new Error("SOURCE_UNAVAILABLE");
      } },
      builder: { async buildV2() { throw new Error("builder must not run"); } },
    });
    await assert.rejects(() => coordinator.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS), /SOURCE_UNAVAILABLE/u);
    assert.equal(sawLock, true);
  });

  it("retains a V2 orphan when its terminal metadata no longer matches its persisted core checksums", async () => {
    const root = fixtureRoot("projection-v2-orphan-terminal-integrity-", "native");
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const source = sourceDatabase(sourcePath);
    append(source, 1);
    const driver = new NodeSqliteDriver({ DatabaseSync });
    const faulted = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
      faultInjector: { hit: (boundary) => {
        if (boundary === "after-v2-generation-install-before-manifest") throw new Error("post-install");
      } },
    });
    await assert.rejects(() => faulted.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS), /post-install/u);
    const orphan = join(projectionDirectory, "projections-2-1.sqlite");
    const forged = fixtureDatabase(orphan);
    try {
      forged.exec(`
        UPDATE projection_metadata
        SET terminal_event_position = 0, terminal_event_hash = '${"0".repeat(64)}'
        WHERE singleton = 1
      `);
    } finally {
      closeOwned(forged);
    }

    const recovery = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
    });
    await assert.rejects(
      () => recovery.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS),
      /PROJECTION_PUBLICATION_RECOVERY_REQUIRED/u,
    );
    assert.equal(existsSync(orphan), true);
    assert.equal(existsSync(join(projectionDirectory, PROJECTION_MANIFEST_PUBLICATION_LOCK_FILENAME)), true);
    closeOwned(source);
  });

  it("retains a final V2 orphan after an A-to-B-to-A swap following image capture", async () => {
    const root = fixtureRoot("projection-v2-orphan-capture-swap-", "native");
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const source = sourceDatabase(sourcePath);
    append(source, 1);
    const driver = new NodeSqliteDriver({ DatabaseSync });
    const faulted = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
      faultInjector: { hit: (boundary) => {
        if (boundary === "after-v2-generation-install-before-manifest") throw new Error("post-install");
      } },
    });
    await assert.rejects(() => faulted.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS), /post-install/u);
    const orphan = join(projectionDirectory, "projections-2-1.sqlite");
    const displaced = join(projectionDirectory, "displaced-valid-orphan.sqlite");
    const forged = join(projectionDirectory, "forged-orphan.sqlite");
    writeFileSync(forged, "not a sqlite image", "utf8");

    const recovery = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
      faultInjector: { hit(boundary: unknown): void {
        if (boundary !== "after-v2-orphan-image-before-validation") return;
        renameSync(orphan, displaced);
        renameSync(forged, orphan);
        renameSync(orphan, forged);
        renameSync(displaced, orphan);
      } },
    });
    await assert.rejects(
      () => recovery.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS),
      /PROJECTION_PATH_INVALID/u,
    );
    assert.equal(existsSync(orphan), true);
    assert.equal(readFileSync(forged, "utf8"), "not a sqlite image");
    assert.equal(existsSync(join(projectionDirectory, PROJECTION_MANIFEST_PUBLICATION_LOCK_FILENAME)), true);
    closeOwned(source);
  });

  it("retains retired evidence when it differs from the validated V2 image", async () => {
    const root = fixtureRoot("projection-v2-retired-swap-", "native");
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const source = sourceDatabase(sourcePath);
    append(source, 1);
    const driver = new NodeSqliteDriver({ DatabaseSync });
    const faulted = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
      faultInjector: { hit(boundary: unknown): void {
        if (boundary === "after-v2-generation-install-before-manifest") throw new Error("post-install");
      } },
    });
    await assert.rejects(() => faulted.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS), /post-install/u);
    const forged = join(projectionDirectory, "forged-retired.sqlite");
    writeFileSync(forged, "not a sqlite image", "utf8");

    const recovery = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
      faultInjector: { hit(boundary: unknown): void {
        if (boundary !== "after-v2-orphan-quarantine-before-confirm") return;
        const retired = readdirSync(projectionDirectory).find((name) => (
          /^\.projections-2-retired-[0-9a-f]{32}\.sqlite$/u.test(name)
        ));
        assert.notEqual(retired, undefined);
        renameSync(join(projectionDirectory, retired!), join(projectionDirectory, "displaced-valid-orphan.sqlite"));
        renameSync(forged, join(projectionDirectory, retired!));
      } },
    });
    await assert.rejects(
      () => recovery.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS),
      /PROJECTION_PUBLICATION_RECOVERY_REQUIRED/u,
    );
    assert.equal(existsSync(join(projectionDirectory, "displaced-valid-orphan.sqlite")), true);
    assert.equal(
      readdirSync(projectionDirectory).some((name) => (
        /^\.projections-2-retired-[0-9a-f]{32}\.sqlite$/u.test(name)
      )),
      true,
    );
    assert.equal(existsSync(join(projectionDirectory, PROJECTION_MANIFEST_PUBLICATION_LOCK_FILENAME)), true);
    closeOwned(source);
  });

  it("fails closed if the V2 projection directory swaps after authorization", async () => {
    const root = fixtureRoot("projection-v2-directory-swap-", "native");
    const projectionDirectory = join(root, "projections");
    const originalDirectory = join(root, "original-projections");
    const attackerDirectory = join(root, "attacker-projections");
    mkdirSync(projectionDirectory);
    mkdirSync(attackerDirectory);
    const knownTemp = ".projections-2-1-deadbeefdeadbeefdeadbeefdeadbeef.sqlite.tmp";
    writeFileSync(join(projectionDirectory, knownTemp), "owned stale temp", "utf8");
    writeFileSync(join(attackerDirectory, knownTemp), "outside victim", "utf8");
    let directoryRealpaths = 0;
    const inspection: ProjectionPathInspection = {
      lstat: lstatSync,
      realpath(path: string): string {
        if (path === projectionDirectory && ++directoryRealpaths === 3) {
          renameSync(projectionDirectory, originalDirectory);
          renameSync(attackerDirectory, projectionDirectory);
          return projectionDirectory;
        }
        return realpathSync(path);
      },
    };
    const coordinator = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      pathInspection: inspection,
      eventReader: { async openCommittedSnapshot() { throw new Error("source must not run"); } },
      builder: { async buildV2() { throw new Error("builder must not run"); } },
    });

    await assert.rejects(
      () => coordinator.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS),
      /PROJECTION_PATH_INVALID/u,
    );
    assert.equal(readFileSync(join(projectionDirectory, knownTemp), "utf8"), "outside victim");
    assert.equal(readFileSync(join(originalDirectory, knownTemp), "utf8"), "owned stale temp");
  });

  it("takes the V2 publication lock before a directory-swap journal snapshot", async () => {
    const root = fixtureRoot("projection-v2-journal-snapshot-swap-", "native");
    const projectionDirectory = join(root, "projections");
    const originalDirectory = join(root, "original-projections");
    const attackerDirectory = join(root, "attacker-projections");
    mkdirSync(projectionDirectory);
    mkdirSync(attackerDirectory);
    let swapped = false;
    const coordinator = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      leasedFilenames: () => {
        if (!swapped) {
          swapped = true;
          renameSync(projectionDirectory, originalDirectory);
          renameSync(attackerDirectory, projectionDirectory);
        }
        return [];
      },
      eventReader: { async openCommittedSnapshot() { throw new Error("source must not run"); } },
      builder: { async buildV2() { throw new Error("builder must not run"); } },
    });

    await assert.rejects(
      () => coordinator.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS),
      /PROJECTION_PATH_INVALID/u,
    );
    assert.equal(existsSync(join(originalDirectory, PROJECTION_MANIFEST_PUBLICATION_LOCK_FILENAME)), true);
  });

  it("retains an unreadable final-named V2 candidate rather than deleting on uncertain observation", async () => {
    const root = fixtureRoot("projection-v2-orphan-uncertain-", "native");
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const source = sourceDatabase(sourcePath);
    append(source, 1);
    mkdirSync(projectionDirectory);
    const uncertain = join(projectionDirectory, "projections-2-1.sqlite");
    writeFileSync(uncertain, "not a sqlite image", "utf8");
    const driver = new NodeSqliteDriver({ DatabaseSync });
    const coordinator = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
    });

    await assert.rejects(
      () => coordinator.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS),
      /PROJECTION_PUBLICATION_RECOVERY_REQUIRED/u,
    );
    assert.equal(existsSync(uncertain), true);
    assert.equal(existsSync(join(projectionDirectory, "projection-manifest.json")), false);
    closeOwned(source);
  });

  it("poisons and retains the publication lock when fresh reconciliation cannot verify a final V2 candidate", async () => {
    const root = fixtureRoot("projection-v2-fresh-poison-", "native");
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const source = sourceDatabase(sourcePath);
    append(source, 1);
    const driver = new NodeSqliteDriver({ DatabaseSync });
    const coordinator = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
    });
    await coordinator.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS);
    const uncertain = join(projectionDirectory, "projections-2-2.sqlite");
    writeFileSync(uncertain, "not a sqlite image", "utf8");

    await assert.rejects(
      () => coordinator.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS),
      /PROJECTION_PUBLICATION_RECOVERY_REQUIRED/u,
    );
    assert.equal(existsSync(uncertain), true);
    assert.equal(
      existsSync(join(projectionDirectory, PROJECTION_MANIFEST_PUBLICATION_LOCK_FILENAME)),
      true,
      "uncertain reconciliation must retain the lock as recovery evidence",
    );
    closeOwned(source);
  });

  it("reconciles before opening a source snapshot for a non-fresh V2 request", async () => {
    const root = fixtureRoot("projection-v2-nonfresh-entry-reconcile-", "native");
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const source = sourceDatabase(sourcePath);
    append(source, 1);
    const driver = new NodeSqliteDriver({ DatabaseSync });
    const published = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
    });
    await published.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS);
    writeFileSync(join(projectionDirectory, "projections-2-2.sqlite"), "not a sqlite image", "utf8");
    let sourceOpened = false;
    const coordinator = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: { async openCommittedSnapshot() {
        sourceOpened = true;
        throw new Error("source must not run");
      } },
      builder: { async buildV2() { throw new Error("builder must not run"); } },
    });

    await assert.rejects(
      () => coordinator.ensurePublished(BINDING, 2n, FUNCTIONAL_TEST_DEADLINE_MS),
      /PROJECTION_PUBLICATION_RECOVERY_REQUIRED/u,
    );
    assert.equal(sourceOpened, false);
    closeOwned(source);
  });

  it("removes a verified V2 orphan before a non-fresh source failure", async () => {
    const root = fixtureRoot("projection-v2-nonfresh-valid-reconcile-", "native");
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const source = sourceDatabase(sourcePath);
    append(source, 1);
    const driver = new NodeSqliteDriver({ DatabaseSync });
    const healthy = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
    });
    await healthy.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS);
    append(source, 2);
    const faulted = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
      faultInjector: { hit: (boundary) => {
        if (boundary === "after-v2-generation-install-before-manifest") throw new Error("post-install");
      } },
    });
    await assert.rejects(() => faulted.ensurePublished(BINDING, 2n, FUNCTIONAL_TEST_DEADLINE_MS), /post-install/u);
    const orphan = join(projectionDirectory, "projections-2-2.sqlite");
    assert.equal(existsSync(orphan), true);

    const recovery = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: { async openCommittedSnapshot() { throw new Error("SOURCE_UNAVAILABLE"); } },
      builder: { async buildV2() { throw new Error("builder must not run"); } },
    });
    await assert.rejects(() => recovery.ensurePublished(BINDING, 2n, FUNCTIONAL_TEST_DEADLINE_MS), /SOURCE_UNAVAILABLE/u);
    assert.equal(existsSync(orphan), false);
    closeOwned(source);
  });

  it("does not reconcile a final V2 generation named by the lease registry", async () => {
    const root = fixtureRoot("projection-v2-orphan-lease-", "native");
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const source = sourceDatabase(sourcePath);
    append(source, 1);
    const driver = new NodeSqliteDriver({ DatabaseSync });
    const faulted = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
      faultInjector: { hit: (boundary) => {
        if (boundary === "after-v2-generation-install-before-manifest") throw new Error("post-install");
      } },
    });
    await assert.rejects(() => faulted.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS), /post-install/u);

    append(source, 2);
    const restarted = new V2ProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
      leasedFilenames: () => Object.freeze(["projections-2-1.sqlite"]),
    });
    await restarted.ensurePublished(BINDING, 2n, FUNCTIONAL_TEST_DEADLINE_MS);
    assert.equal(existsSync(join(projectionDirectory, "projections-2-1.sqlite")), true);
    closeOwned(source);
  });

  it("acquires a published V2 evaluator lease from a stable private image", async () => {
    const fixture = await publishedV2CoordinatorFixture();
    try {
      const lease = trackResource(await fixture.coordinator.leasePublishedForEvaluation(BINDING), fixture.projectionDirectory);
      try {
        assert.equal(lease.manifest.databaseFile, "projections-2-1.sqlite");
        assertOriginalV2EvaluationLease(lease);
      } finally {
        closeOwned(lease);
      }
    } finally {
      closeOwned(fixture.source);
    }
  });

  it("fails closed without an evaluator lease when the V2 directory swaps during acquisition", async () => {
    const fixture = await publishedV2CoordinatorFixture();
    try {
      const root = join(fixture.projectionDirectory, "..");
      const originalDirectory = join(root, "original-projections");
      const attackerDirectory = join(root, "attacker-projections");
      mkdirSync(attackerDirectory);
      let directoryRealpaths = 0;
      const evaluationLeases = new V2ProjectionReaderLeaseRegistry();
      const coordinator = new V2ProjectionBuildCoordinator({
        projectionDirectory: fixture.projectionDirectory,
        evaluationLeases,
        pathInspection: {
          lstat: lstatSync,
          realpath(path: string): string {
            if (path === fixture.projectionDirectory && ++directoryRealpaths === 3) {
              renameSync(fixture.projectionDirectory, originalDirectory);
              renameSync(attackerDirectory, fixture.projectionDirectory);
              return fixture.projectionDirectory;
            }
            return realpathSync(path);
          },
        },
        eventReader: { async openCommittedSnapshot() { throw new Error("source must not run"); } },
        builder: { async buildV2() { throw new Error("builder must not run"); } },
      });

      await assert.rejects(
        () => coordinator.leasePublishedForEvaluation(BINDING),
        /PROJECTION_PATH_INVALID/u,
      );
      assert.deepEqual(evaluationLeases.activeFilenames(), []);
      assert.equal(
        existsSync(join(originalDirectory, PROJECTION_MANIFEST_PUBLICATION_LOCK_FILENAME)),
        true,
      );
    } finally {
      closeOwned(fixture.source);
    }
  });

  it("retains swapped V2 evaluator acquisition lock evidence when the lock sees another directory identity", async () => {
    const fixture = await publishedV2CoordinatorFixture();
    try {
      const root = join(fixture.projectionDirectory, "..");
      const originalDirectory = join(root, "original-projections");
      const attackerDirectory = join(root, "attacker-projections");
      mkdirSync(attackerDirectory);
      const nativeRealpath = realpathSync.native;
      let stableCaptures = 0;
      realpathSync.native = ((path: string): string => {
        const canonical = nativeRealpath(path);
        if (path === fixture.projectionDirectory && ++stableCaptures === 2) {
          renameSync(fixture.projectionDirectory, originalDirectory);
          renameSync(attackerDirectory, fixture.projectionDirectory);
        }
        return canonical;
      }) as typeof realpathSync.native;
      const evaluationLeases = new V2ProjectionReaderLeaseRegistry();
      const coordinator = new V2ProjectionBuildCoordinator({
        projectionDirectory: fixture.projectionDirectory,
        evaluationLeases,
        eventReader: { async openCommittedSnapshot() { throw new Error("source must not run"); } },
        builder: { async buildV2() { throw new Error("builder must not run"); } },
      });

      try {
        await assert.rejects(
          () => coordinator.leasePublishedForEvaluation(BINDING),
          /PROJECTION_PATH_INVALID/u,
        );
        assert.deepEqual(evaluationLeases.activeFilenames(), []);
        assert.equal(
          existsSync(join(fixture.projectionDirectory, PROJECTION_MANIFEST_PUBLICATION_LOCK_FILENAME)),
          true,
        );
      } finally {
        realpathSync.native = nativeRealpath;
      }
    } finally {
      closeOwned(fixture.source);
    }
  });

  it("rejects final V2 WAL and SHM sidecars before acquiring evaluator leases", async () => {
    for (const suffix of ["-wal", "-shm"]) {
      const evaluationLeases = new V2ProjectionReaderLeaseRegistry();
      const fixture = await publishedV2CoordinatorFixture(evaluationLeases);
      try {
        writeFileSync(join(fixture.projectionDirectory, `projections-2-1.sqlite${suffix}`), "sidecar", "utf8");
        await assert.rejects(
          () => fixture.coordinator.leasePublishedForEvaluation(BINDING),
          (error: unknown) => error instanceof LifecycleError && error.code === "INTEGRITY_FAILURE",
        );
        assert.deepEqual(evaluationLeases.activeFilenames(), []);
        assert.equal(
          existsSync(join(fixture.projectionDirectory, PROJECTION_MANIFEST_PUBLICATION_LOCK_FILENAME)),
          true,
        );
      } finally {
        closeOwned(fixture.source);
      }
    }
  });

  it("retains V2 evaluator acquisition lock evidence when the published final checksum no longer matches", async () => {
    const evaluationLeases = new V2ProjectionReaderLeaseRegistry();
    const fixture = await publishedV2CoordinatorFixture(evaluationLeases);
    try {
      truncateSync(join(fixture.projectionDirectory, "projections-2-1.sqlite"), 0);
      await assert.rejects(
        () => fixture.coordinator.leasePublishedForEvaluation(BINDING),
        /PROJECTION_DATABASE_CHECKSUM_INVALID/u,
      );
      assert.deepEqual(evaluationLeases.activeFilenames(), []);
      assert.equal(
        existsSync(join(fixture.projectionDirectory, PROJECTION_MANIFEST_PUBLICATION_LOCK_FILENAME)),
        true,
      );
    } finally {
      closeOwned(fixture.source);
    }
  });

  it("closes an unreturned V2 evaluator lease when publication release fails after acquisition", async () => {
    let swapAfterAcquire = (): void => undefined;
    const evaluationLeases = new SwapAfterV2EvaluatorLeaseRegistry(() => swapAfterAcquire());
    const fixture = await publishedV2CoordinatorFixture(evaluationLeases);
    try {
      const root = join(fixture.projectionDirectory, "..");
      const originalDirectory = join(root, "original-projections");
      const attackerDirectory = join(root, "attacker-projections");
      mkdirSync(attackerDirectory);
      swapAfterAcquire = (): void => {
        renameSync(fixture.projectionDirectory, originalDirectory);
        renameSync(attackerDirectory, fixture.projectionDirectory);
      };

      await assert.rejects(
        () => fixture.coordinator.leasePublishedForEvaluation(BINDING),
        (error: unknown) => error instanceof LifecycleError && error.code === "MATERIALIZATION_CONFLICT",
      );
      assert.deepEqual(evaluationLeases.activeFilenames(), []);
      assert.notEqual(evaluationLeases.captured, undefined);
      assert.throws(() => evaluationLeases.captured!.database.prepare("SELECT 1").get());
      assert.equal(
        existsSync(join(originalDirectory, PROJECTION_MANIFEST_PUBLICATION_LOCK_FILENAME)),
        true,
      );
    } finally {
      closeOwned(fixture.source);
    }
  });

  it("keeps a V2 evaluator lease usable after its original final file is renamed away", async () => {
    const fixture = await publishedV2CoordinatorFixture();
    try {
      const lease = trackResource(await fixture.coordinator.leasePublishedForEvaluation(BINDING), fixture.projectionDirectory);
      try {
        const finalPath = join(fixture.projectionDirectory, lease.manifest.databaseFile);
        renameSync(finalPath, `${finalPath}.moved`);
        assertOriginalV2EvaluationLease(lease);
      } finally {
        closeOwned(lease);
      }
    } finally {
      closeOwned(fixture.source);
    }
  });

  it("keeps a V2 evaluator lease on its original image after another valid final replaces its filename", async () => {
    const fixture = await publishedV2CoordinatorFixture();
    try {
      const lease = trackResource(await fixture.coordinator.leasePublishedForEvaluation(BINDING), fixture.projectionDirectory);
      try {
        append(fixture.source, 2);
        const replacement = await fixture.coordinator.ensurePublished(BINDING, 2n, FUNCTIONAL_TEST_DEADLINE_MS);
        const finalPath = join(fixture.projectionDirectory, lease.manifest.databaseFile);
        const replacementPath = join(fixture.projectionDirectory, replacement.manifest.databaseFile);
        renameSync(finalPath, `${finalPath}.original`);
        renameSync(replacementPath, finalPath);
        const replaced = fixtureDatabase(finalPath);
        try {
          assert.equal(
            Number(replaced.prepare("SELECT terminal_event_position FROM projection_metadata").get()?.terminal_event_position),
            2,
          );
        } finally {
          closeOwned(replaced);
        }
        assertOriginalV2EvaluationLease(lease);
      } finally {
        closeOwned(lease);
      }
    } finally {
      closeOwned(fixture.source);
    }
  });

  it("keeps a V2 evaluator lease usable after its original final file is truncated", async () => {
    const fixture = await publishedV2CoordinatorFixture();
    try {
      const lease = trackResource(await fixture.coordinator.leasePublishedForEvaluation(BINDING), fixture.projectionDirectory);
      try {
        truncateSync(join(fixture.projectionDirectory, lease.manifest.databaseFile), 0);
        assertOriginalV2EvaluationLease(lease);
      } finally {
        closeOwned(lease);
      }
    } finally {
      closeOwned(fixture.source);
    }
  });

  it("keeps a V2 evaluator lease on its original image after the final SQLite content changes", async () => {
    const fixture = await publishedV2CoordinatorFixture();
    try {
      const lease = trackResource(await fixture.coordinator.leasePublishedForEvaluation(BINDING), fixture.projectionDirectory);
      try {
        const final = fixtureDatabase(join(fixture.projectionDirectory, lease.manifest.databaseFile));
        try {
          final.prepare("UPDATE projection_metadata SET created_at = ? WHERE singleton = 1").run("mutated");
        } finally {
          closeOwned(final);
        }
        assertOriginalV2EvaluationLease(lease);
      } finally {
        closeOwned(lease);
      }
    } finally {
      closeOwned(fixture.source);
    }
  });

  it("retains a V2 evaluator-leased generation until its lease closes, then retires it", async () => {
    const evaluationLeases = new V2ProjectionReaderLeaseRegistry();
    const fixture = await publishedV2CoordinatorFixture(evaluationLeases);
    try {
      const lease = trackResource(await fixture.coordinator.leasePublishedForEvaluation(BINDING), fixture.projectionDirectory);
      const firstFinal = lease.manifest.databaseFile;
      try {
        append(fixture.source, 2);
        const second = await fixture.coordinator.ensurePublished(BINDING, 2n, FUNCTIONAL_TEST_DEADLINE_MS);
        assert.equal(second.manifest.databaseFile, "projections-2-2.sqlite");

        await fixture.coordinator.ensurePublished(BINDING, 2n, FUNCTIONAL_TEST_DEADLINE_MS);
        assert.equal(existsSync(join(fixture.projectionDirectory, firstFinal)), true);
        assert.deepEqual(evaluationLeases.activeFilenames(), [firstFinal]);
      } finally {
        closeOwned(lease);
      }

      await fixture.coordinator.ensurePublished(BINDING, 2n, FUNCTIONAL_TEST_DEADLINE_MS);
      assert.equal(existsSync(join(fixture.projectionDirectory, firstFinal)), false);
      assert.deepEqual(
        readdirSync(fixture.projectionDirectory).filter((name) => /^projections-2-[1-9][0-9]*\.sqlite$/u.test(name)),
        ["projections-2-2.sqlite"],
      );
      const retired = readdirSync(fixture.projectionDirectory).filter((name) => (
        /^\.projections-2-retired-[0-9a-f]{32}\.sqlite$/u.test(name)
      ));
      assert.equal(retired.length, 1);
      const journal = JSON.parse(
        readFileSync(join(fixture.projectionDirectory, "projection-reconciliation-v2.json"), "utf8"),
      ) as { retirements: Array<{ state: string; generation: number; retiredFilename: string }> };
      assert.equal(journal.retirements.length, 1);
      assert.equal(journal.retirements[0]?.state, "retired");
      assert.equal(journal.retirements[0]?.generation, 1);
      assert.equal(journal.retirements[0]?.retiredFilename, retired[0]);
    } finally {
      closeOwned(fixture.source);
    }
  });

  it("publishes atomically, preserves crash-window authority, serializes builds, and pins leases", async () => {
    const root = fixtureRoot("projection-coordinator-", "native");
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
    const result = await coordinator.ensurePublished(BINDING, 8n, FUNCTIONAL_TEST_DEADLINE_MS);
    assert.equal(result.manifest.terminalEventPosition, "8");
    assert.equal(result.manifest.sessionId, null);
    assert.equal(existsSync(knownManifestTemp), false);
    assert.equal(existsSync(knownGenerationTemp), false);
    assert.equal(existsSync(unrelatedTemp), true);
    const firstDatabase = result.databasePath;
    const firstBytes = readFileSync(firstDatabase);
    const oldReader = trackResource(await coordinator.leasePublished(BINDING), projectionDirectory);

    append(source, 9);
    failAfterFsync = true;
    await assert.rejects(
      () => coordinator.ensurePublished(BINDING, 9n, FUNCTIONAL_TEST_DEADLINE_MS),
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
    const ninth = await coordinator.ensurePublished(BINDING, 9n, FUNCTIONAL_TEST_DEADLINE_MS);
    assert.equal(ninth.manifest.terminalEventPosition, "9");
    assert.equal(existsSync(firstDatabase), true, "leased retired generation must remain");
    closeOwned(oldReader);
    assert.equal(existsSync(firstDatabase), true, "retired generation remains for audited reclamation");

    append(source, 10);
    const concurrent = await Promise.all([
      coordinator.ensurePublished(BINDING, 10n, FUNCTIONAL_TEST_DEADLINE_MS),
      coordinator.ensurePublished(BINDING, 10n, FUNCTIONAL_TEST_DEADLINE_MS),
    ]);
    assert.equal(concurrent[0].manifest.terminalEventPosition, "10");
    assert.equal(concurrent[1].manifest.terminalEventPosition, "10");
    assert.equal(maximumActiveBuilds, 1);

    await assert.rejects(
      () => coordinator.ensurePublished(BINDING, 11n, 5),
      (error: unknown) => error instanceof ProjectionLagError
        && error instanceof LifecycleError
        && error.name === "ProjectionLagError"
        && error.code === "PROJECTION_LAG"
        && error.retryable
        && error.safeMessage === "The required projection consistency was not reached"
        && error.recoveryActions[0] === "wait-for-projection"
        && error.requiredEventPosition === 11n
        && error.availableEventPosition === 10n,
    );
    assert.equal(existsSync(unrelatedTemp), true);
    closeOwned(source);
  });

  it("rejects a forged chain hash outside the requested projection binding", async () => {
    const root = fixtureRoot("projection-cross-scope-chain-", "native");
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const source = sourceDatabase(sourcePath);
    append(source, 1, {
      workspaceId: "5".repeat(64),
      branchScopeId: null,
      branchRef: null,
    });
    append(source, 2);
    const driver = new NodeSqliteDriver({ DatabaseSync });
    const eventReader = new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath });
    const validSnapshot = trackResource(await eventReader.openCommittedSnapshot(BINDING), sourcePath);
    assert.equal(validSnapshot.eventCount, 2);
    assert.deepEqual(
      [...validSnapshot.events()].map((event) => event.globalPosition),
      [2n],
    );
    closeOwned(validSnapshot);
    source.prepare(`
      UPDATE events SET event_hash = ? WHERE global_position = 1
    `).run("f".repeat(64));
    const coordinator = new DefaultProjectionBuildCoordinator({
      projectionDirectory,
      eventReader,
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
    });

    await assert.rejects(
      () => coordinator.ensurePublished(BINDING, 2n, 5_000),
      /INTEGRITY_FAILURE/u,
    );
    assert.equal(existsSync(join(projectionDirectory, "projection-manifest.json")), false);
    closeOwned(source);
  });

  it("reselects the manifest when publication retires a generation between load and acquire", async () => {
    const root = fixtureRoot("projection-lease-race-", "native");
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

    const first = await coordinator.ensurePublished(BINDING, 8n, FUNCTIONAL_TEST_DEADLINE_MS);
    append(source, 9);
    const snapshot = trackResource(await eventReader.openCommittedSnapshot(BINDING), sourcePath);
    leases.replacement = await builder.build(snapshot, 2);
    closeOwned(snapshot);

    const lease = trackResource(await coordinator.leasePublished(BINDING), projectionDirectory);
    assert.equal(lease.manifest.generation, 2);
    assert.equal(lease.manifest.terminalEventPosition, "9");
    assert.equal(existsSync(lease.databasePath), true);
    assert.equal(existsSync(first.databasePath), true);
    closeOwned(lease);
    closeOwned(source);
  });

  it("refuses publication when a generation sidecar appears before manifest replacement", async () => {
    const root = fixtureRoot("projection-publication-sidecar-", "native");
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const source = sourceDatabase(sourcePath);
    append(source, 1);
    const driver = new NodeSqliteDriver({ DatabaseSync });
    let injected = false;
    const coordinator = new DefaultProjectionBuildCoordinator({
      projectionDirectory,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
      faultInjector: {
        hit(boundary) {
          if (boundary !== "after-generation-fsync-before-manifest" || injected) return;
          injected = true;
          writeFileSync(
            join(projectionDirectory, "projections-1-1.sqlite-wal"),
            "unexpected published-generation WAL",
            "utf8",
          );
        },
      },
    });

    await assert.rejects(
      () => coordinator.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS),
      /INTEGRITY_FAILURE/u,
    );
    assert.equal(injected, true);
    assert.equal(existsSync(join(projectionDirectory, "projection-manifest.json")), false);
    assert.equal(
      readFileSync(join(projectionDirectory, "projections-1-1.sqlite-wal"), "utf8"),
      "unexpected published-generation WAL",
    );
    closeOwned(source);
  });

  it("maps a sidecar added to the published generation to integrity failure on manifest load", async () => {
    const root = fixtureRoot("projection-published-sidecar-", "native");
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
    const published = await coordinator.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS);
    writeFileSync(`${published.databasePath}-shm`, "unexpected published SHM", "utf8");

    await assert.rejects(
      () => coordinator.leasePublished(BINDING),
      (error: unknown) => error instanceof LifecycleError
        && error.code === "INTEGRITY_FAILURE",
    );
    assert.equal(readFileSync(`${published.databasePath}-shm`, "utf8"), "unexpected published SHM");
    closeOwned(source);
  });

  it("maps a non-ENOENT sidecar lstat failure on manifest load to integrity failure", async () => {
    const root = fixtureRoot("projection-load-sidecar-error-", "native");
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const source = sourceDatabase(sourcePath);
    append(source, 1);
    const driver = new NodeSqliteDriver({ DatabaseSync });
    let armed = false;
    const coordinator = new DefaultProjectionBuildCoordinator({
      projectionDirectory,
      pathInspection: denyingSidecarInspection(() => armed),
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
    });
    await coordinator.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS);
    armed = true;

    await assert.rejects(
      () => coordinator.leasePublished(BINDING),
      (error: unknown) => error instanceof LifecycleError
        && error.code === "INTEGRITY_FAILURE",
    );
    closeOwned(source);
  });

  it("fails closed while a manifest publication lock is present", async () => {
    const root = fixtureRoot("projection-load-publication-lock-", "native");
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
    await coordinator.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS);
    const lockPath = join(projectionDirectory, PROJECTION_MANIFEST_PUBLICATION_LOCK_FILENAME);
    writeFileSync(lockPath, "foreign publication in progress", "utf8");

    await assert.rejects(
      () => coordinator.leasePublished(BINDING),
      (error: unknown) => error instanceof LifecycleError
        && error.code === "MATERIALIZATION_CONFLICT"
        && error.retryable,
    );
    assert.equal(readFileSync(lockPath, "utf8"), "foreign publication in progress");
    closeOwned(source);
  });

  it("retains the publication lock and prior hold when installed-manifest observation is ambiguous", async () => {
    const root = fixtureRoot("projection-installed-observation-error-", "native");
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const source = sourceDatabase(sourcePath);
    append(source, 1);
    const driver = new NodeSqliteDriver({ DatabaseSync });
    const eventReader = new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath });
    const builder = new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW });
    const coordinator = new DefaultProjectionBuildCoordinator({
      projectionDirectory,
      eventReader,
      builder,
    });
    const first = await coordinator.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS);
    const validLease = trackResource(await coordinator.leasePublished(BINDING), projectionDirectory);
    assert.equal(first.manifest.generation, 1);
    assert.equal(validLease.manifest.generation, 1);
    closeOwned(validLease);

    append(source, 2);
    const snapshot = trackResource(await eventReader.openCommittedSnapshot(BINDING), sourcePath);
    const second = await builder.build(snapshot, 2);
    closeOwned(snapshot);
    let installed = false;
    let observationDenied = false;

    assert.throws(
      () => publishProjectionManifest({
        projectionDirectory,
        manifest: second.manifest,
        expectedBinding: BINDING,
      }, {
        directoryOperations: {
          ...filesystemStableProjectionDirectoryOperations,
          installManifestIfExpected(directory, identity, lockToken, attemptToken, expected) {
            const result = filesystemStableProjectionDirectoryOperations.installManifestIfExpected(
              directory,
              identity,
              lockToken,
              attemptToken,
              expected,
            );
            installed = result === "installed";
            return result;
          },
          captureManifest(directory, identity) {
            if (installed && !observationDenied) {
              observationDenied = true;
              writeFileSync(`${second.databasePath}-wal`, "post-install observation ambiguity", "utf8");
              throw Object.assign(new Error("injected installed-manifest observation denial"), {
                code: "EACCES",
              });
            }
            return filesystemStableProjectionDirectoryOperations.captureManifest(directory, identity);
          },
        },
      }),
      (error: unknown) => error instanceof LifecycleError
        && error.code === "MATERIALIZATION_CONFLICT"
        && error.retryable
        && error.recoveryActions.includes("reconcile-materialization"),
    );
    assert.equal(installed, true);
    assert.equal(observationDenied, true);

    const manifestPath = join(projectionDirectory, "projection-manifest.json");
    const manifestGeneration = parseProjectionManifest(
      JSON.parse(readFileSync(manifestPath, "utf8")),
      BINDING,
    ).generation;
    const priorHolds = readdirSync(projectionDirectory).filter((name) => (
      /^\.projection-manifest\.previous-[0-9a-f]{32}$/u.test(name)
    ));
    const priorHoldGenerations = priorHolds.map((name) => parseProjectionManifest(
      JSON.parse(readFileSync(join(projectionDirectory, name), "utf8")),
      BINDING,
    ).generation);
    const attemptedHoldGenerations = readdirSync(projectionDirectory)
      .filter((name) => /^\.projection-manifest\.attempted-[0-9a-f]{32}$/u.test(name))
      .map((name) => parseProjectionManifest(
        JSON.parse(readFileSync(join(projectionDirectory, name), "utf8")),
        BINDING,
      ).generation);
    const lockPath = join(projectionDirectory, PROJECTION_MANIFEST_PUBLICATION_LOCK_FILENAME);
    const lockToken = existsSync(lockPath) ? readFileSync(lockPath, "utf8") : null;
    let readerFailureCode: string | null = null;
    try {
      const lease = trackResource(await coordinator.leasePublished(BINDING), projectionDirectory);
      closeOwned(lease);
    } catch (error) {
      if (!(error instanceof LifecycleError)) throw error;
      readerFailureCode = error.code;
    }
    const lockTokenAfterReader = existsSync(lockPath) ? readFileSync(lockPath, "utf8") : null;

    assert.deepEqual({
      attemptedHoldGenerations,
      manifestGeneration,
      priorHoldGenerations,
      lockRetained: typeof lockToken === "string" && /^[0-9a-f]{32}$/u.test(lockToken),
      lockUnchangedAfterReader: lockTokenAfterReader === lockToken && lockToken !== null,
      sidecarRetained: readFileSync(`${second.databasePath}-wal`, "utf8")
        === "post-install observation ambiguity",
      readerFailureCode,
    }, {
      attemptedHoldGenerations: [2],
      manifestGeneration: 2,
      priorHoldGenerations: [1],
      lockRetained: true,
      lockUnchangedAfterReader: true,
      sidecarRetained: true,
      readerFailureCode: "MATERIALIZATION_CONFLICT",
    });
    closeOwned(source);
  });

  it("preserves a lease-boundary sidecar lstat integrity failure", async () => {
    const root = fixtureRoot("projection-lease-sidecar-error-", "native");
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const source = sourceDatabase(sourcePath);
    append(source, 1);
    const driver = new NodeSqliteDriver({ DatabaseSync });
    let armed = false;
    const leases = new ProjectionReaderLeaseRegistry({
      pathInspection: denyingSidecarInspection(() => armed),
    });
    const coordinator = new DefaultProjectionBuildCoordinator({
      projectionDirectory,
      leases,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
    });
    await coordinator.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS);
    armed = true;

    await assert.rejects(
      () => coordinator.leasePublished(BINDING),
      (error: unknown) => error instanceof LifecycleError
        && error.code === "INTEGRITY_FAILURE",
    );
    closeOwned(source);
  });

  it("never reclaims a published generation main file while a sidecar entry exists", async () => {
    const root = fixtureRoot("projection-sidecar-reclamation-", "native");
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
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
    const published = await coordinator.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS);
    writeFileSync(`${published.databasePath}-wal`, "unexpected published WAL", "utf8");

    leases.retire(published);

    assert.equal(existsSync(published.databasePath), true);
    assert.equal(readFileSync(`${published.databasePath}-wal`, "utf8"), "unexpected published WAL");
    assert.equal(leases.reclamationIssues().length, 1);
    closeOwned(source);
  });

  it("preserves main and sidecar when a sidecar appears after the reclamation precheck", async () => {
    const root = fixtureRoot("projection-reclamation-race-", "native");
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const source = sourceDatabase(sourcePath);
    append(source, 1);
    const driver = new NodeSqliteDriver({ DatabaseSync });
    let injected = false;
    const leases = new ProjectionReaderLeaseRegistry({
      reclamationFaultInjector: {
        hit(boundary, generation): void {
          if (boundary !== "after-retired-generation-check-before-retention" || injected) return;
          injected = true;
          writeFileSync(`${generation.databasePath}-wal`, "late reclamation WAL", "utf8");
        },
      },
    });
    const coordinator = new DefaultProjectionBuildCoordinator({
      projectionDirectory,
      leases,
      eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath }),
      builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
    });
    const published = await coordinator.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS);

    leases.retire(published);

    assert.equal(injected, true);
    assert.equal(existsSync(published.databasePath), true);
    assert.equal(readFileSync(`${published.databasePath}-wal`, "utf8"), "late reclamation WAL");
    assert.deepEqual(
      leases.reclamationIssues().map((issue) => issue.errorCode),
      ["INTEGRITY_FAILURE"],
    );
    closeOwned(source);
  });

  it("returns projection lag at a zero deadline without starting source or build work", async () => {
    const root = fixtureRoot("projection-zero-deadline-", "native");
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
    const root = fixtureRoot("projection-existing-zero-deadline-", "native");
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
    await coordinator.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS);

    await assert.rejects(
      () => coordinator.ensurePublished(BINDING, 1n, 0),
      (error: unknown) => error instanceof ProjectionLagError
        && error.availableEventPosition === 1n,
    );
    closeOwned(source);
  });

  it("maps a synchronously blocking source rejection observed after expiry to projection lag", async () => {
    const root = fixtureRoot("projection-blocking-deadline-", "native");
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
    const root = fixtureRoot("projection-slow-snapshot-", "native");
    let closed = 0;
    let builds = 0;
    let resolveSourceOpened = (): void => undefined;
    const sourceOpened = new Promise<void>((resolve) => { resolveSourceOpened = resolve; });
    let resolveLateSnapshot = (_snapshot: ProjectionEventSnapshot): void => undefined;
    const lateSnapshot = new Promise<ProjectionEventSnapshot>((resolve) => { resolveLateSnapshot = resolve; });
    let resolveClosed = (): void => undefined;
    const closedOnce = new Promise<void>((resolve) => { resolveClosed = resolve; });
    const eventReader: ProjectionEventReader = {
      async openCommittedSnapshot() {
        resolveSourceOpened();
        return lateSnapshot;
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
      now: () => 0,
    });

    const publication = coordinator.ensurePublished(BINDING, 1n, 5);
    await sourceOpened;
    await assert.rejects(publication, (error: unknown) => error instanceof ProjectionLagError);
    resolveLateSnapshot(emptySnapshot(() => { closed += 1; resolveClosed(); }));
    await closedOnce;
    assert.equal(closed, 1);
    assert.equal(builds, 0);
  });

  it("closes an active source snapshot as soon as the build deadline expires", async () => {
    const root = fixtureRoot("projection-active-snapshot-deadline-", "native");
    let closed = 0;
    let resolveBuilderEntered = (): void => undefined;
    const builderEntered = new Promise<void>((resolve) => { resolveBuilderEntered = resolve; });
    let resolveBuild = (_built: BuiltProjectionGeneration): void => undefined;
    const blockedBuild = new Promise<BuiltProjectionGeneration>((resolve) => { resolveBuild = resolve; });
    let resolveBuildReturned = (): void => undefined;
    const buildReturned = new Promise<void>((resolve) => { resolveBuildReturned = resolve; });
    const coordinator = new DefaultProjectionBuildCoordinator({
      projectionDirectory: join(root, "projections"),
      eventReader: {
        async openCommittedSnapshot() {
          return emptySnapshot(() => { closed += 1; });
        },
      },
      builder: {
        async build() {
          resolveBuilderEntered();
          try { return await blockedBuild; } finally { resolveBuildReturned(); }
        },
      },
      now: () => 0,
    });

    const publication = coordinator.ensurePublished(BINDING, 1n, 5);
    await builderEntered;
    await assert.rejects(publication, (error: unknown) => error instanceof ProjectionLagError);
    assert.equal(closed, 1);
    resolveBuild(undefined as unknown as BuiltProjectionGeneration);
    await buildReturned;
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it("does not publish a build that completes after its caller deadline", async () => {
    const root = fixtureRoot("projection-slow-build-", "native");
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
    closeOwned(source);
  });

  it("returns V2 projection lag at a zero deadline when a sufficient generation exists", async () => {
    const fixture = await v2DeadlineFixture();
    try {
      const manifest = readFileSync(join(fixture.projectionDirectory, "projection-manifest.json"), "utf8");
      const calls = fixture.calls;
      fixture.setNow(() => 50);

      await assert.rejects(
        () => fixture.coordinator.ensurePublished(BINDING, 1n, 0),
        (error: unknown) => error instanceof ProjectionLagError
          && error.requiredEventPosition === 1n
          && error.availableEventPosition === 1n,
      );
      assert.deepEqual(fixture.calls, calls);
      assert.equal(readFileSync(join(fixture.projectionDirectory, "projection-manifest.json"), "utf8"), manifest);
    } finally {
      closeOwned(fixture.source);
    }
  });

  it("releases the V2 publication lock after an expired sufficient-generation request", async () => {
    const fixture = await v2DeadlineFixture();
    try {
      const calls = fixture.calls;
      fixture.setNow(() => 50);

      await assert.rejects(
        () => fixture.coordinator.ensurePublished(BINDING, 1n, 0),
        (error: unknown) => error instanceof ProjectionLagError
          && error.requiredEventPosition === 1n
          && error.availableEventPosition === 1n,
      );
      fixture.setNow(() => 0);

      const published = await fixture.coordinator.ensurePublished(
        BINDING,
        1n,
        FUNCTIONAL_TEST_DEADLINE_MS,
      );
      assert.equal(published.manifest.terminalEventPosition, "1");
      assert.deepEqual(fixture.calls, calls);
    } finally {
      closeOwned(fixture.source);
    }
  });

  it("returns V2 projection lag when a positive deadline elapses before its current-generation return", async () => {
    const fixture = await v2DeadlineFixture();
    try {
      const manifest = readFileSync(join(fixture.projectionDirectory, "projection-manifest.json"), "utf8");
      const calls = fixture.calls;
      const ticks = [100, 101];
      fixture.setNow(() => ticks.shift() ?? 101);

      await assert.rejects(
        () => fixture.coordinator.ensurePublished(BINDING, 1n, 1),
        (error: unknown) => error instanceof ProjectionLagError
          && error.requiredEventPosition === 1n
          && error.availableEventPosition === 1n,
      );
      assert.deepEqual(fixture.calls, calls);
      assert.equal(readFileSync(join(fixture.projectionDirectory, "projection-manifest.json"), "utf8"), manifest);
    } finally {
      closeOwned(fixture.source);
    }
  });

  it("rejects a symlink-shaped projection directory before cleanup traversal", () => {
    const root = fixtureRoot("projection-path-safety-", "native");
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
    const root = fixtureRoot("projection-cleanup-swap-", "native");
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
      () => coordinator.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS),
      /PROJECTION_PATH_INVALID/u,
    );
    assert.equal(readFileSync(join(projectionDirectory, knownName), "utf8"), "outside victim");
    assert.equal(readFileSync(join(originalDirectory, knownName), "utf8"), "owned stale temp");
  });

  it("never reclaims through a replaced parent and retries against the pinned directory", async () => {
    const root = fixtureRoot("projection-reclaim-parent-swap-", "native");
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
    const published = await coordinator.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS);
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
    assert.equal(existsSync(published.databasePath), true);
    assert.equal(
      readFileSync(join(displacedAttackerDirectory, published.manifest.databaseFile), "utf8"),
      "outside victim",
    );
    assert.deepEqual(
      leases.reclamationIssues().map((issue) => issue.errorCode),
      ["PROJECTION_RECLAMATION_DEFERRED"],
    );
    closeOwned(source);
  });

  it("keeps publication successful while retaining retired files for audited reclamation", async () => {
    const root = fixtureRoot("projection-reclaim-retry-", "native");
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const source = sourceDatabase(sourcePath);
    append(source, 1);
    const driver = new NodeSqliteDriver({ DatabaseSync });
    const eventReader = new SqliteProjectionEventReader({ driver, eventStorePath: sourcePath });
    const builder = new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW });
    const leases = new ProjectionReaderLeaseRegistry();
    const coordinator = new DefaultProjectionBuildCoordinator({
      projectionDirectory,
      eventReader,
      builder,
      leases,
    });

    const first = await coordinator.ensurePublished(BINDING, 1n, FUNCTIONAL_TEST_DEADLINE_MS);
    append(source, 2);
    const second = await coordinator.ensurePublished(BINDING, 2n, FUNCTIONAL_TEST_DEADLINE_MS);
    assert.equal(second.manifest.terminalEventPosition, "2");
    assert.equal(
      parseProjectionManifest(
        JSON.parse(readFileSync(join(projectionDirectory, "projection-manifest.json"), "utf8")),
        BINDING,
      ).generation,
      second.manifest.generation,
    );
    assert.equal(existsSync(first.databasePath), true);
    assert.deepEqual(
      leases.reclamationIssues().map((issue) => [issue.errorCode, issue.attempts]),
      [["PROJECTION_RECLAMATION_DEFERRED", 1]],
    );
    leases.retryReclamation();
    assert.equal(existsSync(first.databasePath), true);
    assert.deepEqual(
      leases.reclamationIssues().map((issue) => [issue.errorCode, issue.attempts]),
      [["PROJECTION_RECLAMATION_DEFERRED", 2]],
    );
    closeOwned(source);
  });

  it("has no stable V2 orphan deletion operation", () => {
    const stableDirectory = readFileSync(
      join(process.cwd(), "src", "orchestrator", "projections", "stable-directory.ts"),
      "utf8",
    );
    assert.doesNotMatch(
      stableDirectory,
      /remove-quarantined-generation|removeQuarantinedGeneration/u,
    );
  });
});
