import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, linkSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import type { ProjectContext } from "../../src/orchestrator/identity/contracts.js";
import type { StoredEvent } from "../../src/orchestrator/contracts/event.js";
import type { ProjectBinding } from "../../src/orchestrator/projections/contracts.js";
import { replayCommittedProjectionEvents } from "../../src/orchestrator/projections/event-reader.js";
import { decodeProjectionEvent } from "../../src/orchestrator/projections/source-event-codec.js";
import { canonicalJson } from "../../src/orchestrator/serialization/canonical-json.js";
import { EventStore, SqliteEventStoreStatements } from "../../src/orchestrator/storage/event-store.js";
import { BranchScopeRepository } from "../../src/orchestrator/storage/branch-scope.repository.js";
import { MaintenanceFence } from "../../src/orchestrator/storage/maintenance-fence.js";
import { NodeSqliteDriver } from "../../src/orchestrator/storage/node-sqlite-driver.js";
import { CURRENT_PROJECT_STORE_SCHEMA_VERSION } from "../../src/orchestrator/storage/migrations/registry.js";
import { decodeShadowMigrationPolicyV1 } from "../../src/orchestrator/migration/v2-shadow-migration.contracts.js";
import type { SourceFileDescriptorV1, V1SourceCopyManifestV1 } from "../../src/orchestrator/migration/v1-source-copy.js";
import { applyCurrentProjectStoreSchema } from "./current-project-store-schema.js";
import { canonicalMkdtemp } from "./canonical-temp.js";

export function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function describeSourceFile(root: string, relativePath: string): SourceFileDescriptorV1 {
  const path = join(root, relativePath);
  const stat = lstatSync(path, { bigint: true });
  return { relativePath, device: String(stat.dev), inode: String(stat.ino), size: Number(stat.size),
    ctimeNs: String(stat.ctimeNs), sha256: digest(readFileSync(path)) };
}

export function sealManifest(value: Omit<V1SourceCopyManifestV1, "manifestChecksum"> | V1SourceCopyManifestV1): V1SourceCopyManifestV1 {
  const { manifestChecksum: _checksum, ...body } = value as V1SourceCopyManifestV1;
  return { ...body, manifestChecksum: digest(canonicalJson(body)) };
}

export async function createV2ShadowMigrationFixture(t: TestContext, options: { aliasLiveStore?: boolean } = {}) {
  const root = canonicalMkdtemp("v2-shadow-source-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceRoot = join(root, "copy");
  const liveStoreRoot = join(root, "live-store");
  const liveVaultRoot = join(root, "live-vault");
  for (const path of [sourceRoot, liveStoreRoot, liveVaultRoot, join(sourceRoot, "legacy")]) mkdirSync(path);
  const liveEventStorePath = join(liveStoreRoot, "events.sqlite");
  const sourceDatabasePath = join(sourceRoot, "events.sqlite");
  const manifestPath = join(sourceRoot, "manifest.json");
  const driver = new NodeSqliteDriver({ DatabaseSync });
  const now = "2026-09-10T00:00:00.000Z";
  const projectionBinding = { projectId: "11111111-1111-4111-8111-111111111111",
    vaultId: "22222222-2222-4222-8222-222222222222", storeId: "33333333-3333-4333-8333-333333333333",
    workspaceId: "a".repeat(64), branchScopeId: null, branchRef: null, sessionId: null } as ProjectBinding;
  const workspace = { kind: "non-git" as const, workspaceRoot: root, workspaceId: projectionBinding.workspaceId };
  const context: ProjectContext = { workspace, checkedAt: now, binding: {
    ...projectionBinding, projectBindingId: randomUUID(), generation: 1, contextFingerprint: "fixture",
    source: "explicit-cli", clientNamespace: "migration-tests", clientInstanceId: randomUUID(), actorRole: "primary",
    projectRoot: root, vaultRoot: liveVaultRoot, descriptorPath: join(liveVaultRoot, ".project-memory.json"),
    storeRoute: { kind: "vault-local", storeRoot: liveStoreRoot, eventsPath: liveEventStorePath,
      storeManifestPath: join(liveStoreRoot, "store.json"), projectionManifestPath: join(liveStoreRoot, "projection.json") },
    workspace, establishedAt: now,
  } };
  const connection = driver.open(liveEventStorePath, { mode: "create", busyTimeoutMs: 5000 });
  try {
    applyCurrentProjectStoreSchema(connection, projectionBinding, now);
    const store = new EventStore(connection, new SqliteEventStoreStatements(connection), new MaintenanceFence(), new BranchScopeRepository(), () => now);
    store.append({ context, commandId: randomUUID(), idempotencyKey: "migration-fixture", commandType: "RecordProjectionSources",
      correlationId: randomUUID(), agentId: "migration-fixture", expectedStreamVersion: 0n, streamId: "migration-fixture", streamType: "memory",
      events: ["First source", "Second source"].map((summary, ordinal) => ({
        eventType: "MemorySourceRecorded", eventSchemaVersion: 1, occurredAt: now, visibilityScope: "project" as const,
        confidence: "high" as const, verificationStatus: "verified" as const,
        payload: { sourceVersion: 1, binding: { ...projectionBinding }, itemId: randomUUID(), normalizedKey: `decision:fixture-${ordinal}`,
          status: "verified", confidence: "high", verificationMethod: "production-event-writer", validFrom: now, validTo: null,
          summary, contentHash: digest(summary) }, sourceRefs: [], evidenceRefs: [], evidenceDigests: [],
      })), outbox: [], publicResponse: { recorded: true } });
    const checkpoint = connection.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (checkpoint?.busy !== 0n) throw new Error("Fixture checkpoint did not complete");
    if (options.aliasLiveStore) linkSync(liveEventStorePath, sourceDatabasePath);
    else copyFileSync(liveEventStorePath, sourceDatabasePath);
    for (const suffix of ["-wal", "-shm"]) copyFileSync(`${liveEventStorePath}${suffix}`, `${sourceDatabasePath}${suffix}`);
  } finally { connection.close(); }
  const sourceEvents: StoredEvent[] = [];
  replayCommittedProjectionEvents(projectionBinding, { driver, eventStorePath: liveEventStorePath, terminalEventPosition: 2n }, (event) => {
    decodeProjectionEvent(event);
    sourceEvents.push(event);
  });
  writeFileSync(join(sourceRoot, "legacy", "one.md"), "# Decision\nKeep V1 authoritative.\n", "utf8");
  writeFileSync(join(sourceRoot, "legacy", "two.md"), "# Insight\nตรวจสอบ immutable copy.\n", "utf8");
  const legacyArtifacts = ["legacy/one.md", "legacy/two.md"].map((path) => ({
    ...describeSourceFile(sourceRoot, path), mediaType: "text/markdown; charset=utf-8" as const,
  }));
  const manifest = sealManifest({ schemaVersion: 1, copyFormatVersion: 1,
    projectId: projectionBinding.projectId, vaultId: projectionBinding.vaultId, storeId: projectionBinding.storeId,
    workspaceId: projectionBinding.workspaceId, branchScopeId: null, branchRef: null,
    sourceSchemaVersion: CURRENT_PROJECT_STORE_SCHEMA_VERSION, database: describeSourceFile(sourceRoot, "events.sqlite"),
    sqliteSidecars: ["events.sqlite-wal", "events.sqlite-shm"].map((path) => describeSourceFile(sourceRoot, path)), legacyArtifacts,
    eventCount: sourceEvents.length, aggregateSourceBytes: sourceEvents.reduce((sum, event) => sum + Buffer.byteLength(event.payloadJson), 0)
      + legacyArtifacts.reduce((sum, artifact) => sum + artifact.size, 0),
    terminalEventPosition: "2", terminalEventHash: sourceEvents.at(-1)!.eventHash, createdAt: now, authorizedActorFingerprint: digest("fixture-actor") });
  writeFileSync(manifestPath, canonicalJson(manifest));
  const policy = decodeShadowMigrationPolicyV1({ schemaVersion: 1, maxEvents: 100_000, maxAggregateBytes: 67_108_864,
    maxEventBytes: 1_048_576, maxBatchEvents: 1000, maxBatchBytes: 8_388_608, deadlineMs: 300_000, maxRetries: 3,
    initialBackoffMs: 500, maxBackoffMs: 2000, expectedDifferencePolicyVersion: 1, maxExpectedDifferenceRuleAgeMs: 604_800_000 });
  const verificationInput = { driver, sourceRoot, manifestPath, liveEventStorePath, liveLegacyArtifactRoot: liveVaultRoot,
    expectedBinding: projectionBinding, policy };
  return { root, sourceRoot, manifestPath, sourceDatabasePath, liveEventStorePath, liveVaultRoot, projectionBinding,
    sourceEvents, manifest, driver, policy, verificationInput,
    writeManifest(value: V1SourceCopyManifestV1) { writeFileSync(manifestPath, canonicalJson(sealManifest(value))); },
  };
}
