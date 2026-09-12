import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, linkSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { LifecycleFixtureClient, type LifecycleFixtureJsonValue } from "./lifecycle-fixture-client.js";
import { LifecycleTestKeyBroker } from "./lifecycle-test-key-broker.js";
import { decodeCheckpointDraft } from "../../src/orchestrator/lifecycle/contracts/checkpoint.js";
import type { ProjectContext } from "../../src/orchestrator/identity/contracts.js";
import type { StoredEvent, PendingEvent, JsonValue } from "../../src/orchestrator/contracts/event.js";
import type { ProjectBinding } from "../../src/orchestrator/projections/contracts.js";
import { replayCommittedProjectionEvents } from "../../src/orchestrator/projections/event-reader.js";
import { decodeProjectionEvent } from "../../src/orchestrator/projections/source-event-codec.js";
import { canonicalJson } from "../../src/orchestrator/serialization/canonical-json.js";
import { EventStore, MAX_EVENTS_PER_COMMAND, SqliteEventStoreStatements } from "../../src/orchestrator/storage/event-store.js";
import { BranchScopeRepository } from "../../src/orchestrator/storage/branch-scope.repository.js";
import { MaintenanceFence } from "../../src/orchestrator/storage/maintenance-fence.js";
import { NodeSqliteDriver } from "../../src/orchestrator/storage/node-sqlite-driver.js";
import { CURRENT_PROJECT_STORE_SCHEMA_VERSION } from "../../src/orchestrator/storage/migrations/registry.js";
import { v2ShadowMigration } from "../../src/orchestrator/storage/migrations/0007-v2-shadow-migration.js";
import {
  decodeShadowMigrationConfigurationV1,
  decodeShadowMigrationPolicyV1,
  shadowMigrationConfigurationChecksum,
  shadowMigrationPolicyChecksum,
} from "../../src/orchestrator/migration/v2-shadow-migration.contracts.js";
import type { SourceFileDescriptorV1, V1SourceCopyManifestV1 } from "../../src/orchestrator/migration/v1-source-copy.js";
import { applyCurrentProjectStoreSchema } from "./current-project-store-schema.js";
import { canonicalMkdtemp } from "./canonical-temp.js";
import { verifyV1SourceCopy } from "../../src/orchestrator/migration/v1-source-copy.js";
import { sealV2MigrationPackage } from "../../src/orchestrator/migration/v2-migration-package.js";
import { V2ShadowProjectionPublisher } from "../../src/orchestrator/migration/v2-shadow-projection.js";
import { V2ShadowImporter } from "../../src/orchestrator/migration/v2-shadow-importer.js";
import { SqliteV2ShadowMigrationRepository } from "../../src/orchestrator/storage/v2-shadow-migration.repository.js";
import { SqliteRolloutControlPlaneRepository } from "../../src/orchestrator/storage/rollout-control-plane.repository.js";
import { RolloutControlPlane } from "../../src/orchestrator/rollout/rollout-control-plane.js";
import { DefaultProjectionBuildCoordinator, V2ProjectionBuildCoordinator } from "../../src/orchestrator/projections/coordinator.js";
import { V2ImportedProjectionEventReader } from "../../src/orchestrator/migration/v2-imported-event-reader.js";
import { ImmutableProjectionBuilder } from "../../src/orchestrator/projections/builder.js";
import { SqliteProjectionEventReader } from "../../src/orchestrator/projections/event-reader.js";
import { InternalRetrievalService } from "../../src/orchestrator/retrieval/service.js";
import { SqliteRetrievalCandidateRepository } from "../../src/orchestrator/retrieval/candidates.js";
import { evaluateRetrievalQueries, evaluateSealedRetrieval, parseSealedRetrievalEvaluationBundle, type RetrievalEvaluationQueryV1 } from "../../src/orchestrator/retrieval/evaluation.js";
import { expectedDifferenceRuleChecksum, type ExpectedDifferenceRuleV1 } from "../../src/orchestrator/parity/v2-expected-difference.js";
import { createV2ParityRetrievalBridge, parityRowIdentityHash, parityValueHash, type SnapshotParityInput } from "../../src/orchestrator/parity/v2-snapshot-parity.js";

const ORDER_PAIR_IDS = ["90000000-0000-4000-8000-000000000901", "90000000-0000-4000-8000-000000000902"] as const;
const ORDER_PAIR_QUERY = "parityorderpairtoken";

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

export async function createV2ShadowMigrationFixture(t: TestContext,
  options: { aliasLiveStore?: boolean; sourceEventCount?: number; legacyArtifacts?: boolean;
    parityCorpus?: boolean; artifactMetadata?: boolean; checkpointHistory?: boolean; rankingPair?: boolean } = {}) {
  const root = canonicalMkdtemp("v2-shadow-source-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceRoot = join(root, "copy");
  const liveStoreRoot = join(root, "live-store");
  const liveVaultRoot = options.parityCorpus ? join(liveStoreRoot, "memory") : join(root, "live-vault");
  const packageRootA = join(root, "package-root-a");
  const packageRootB = join(root, "package-root-b");
  for (const path of [sourceRoot, liveStoreRoot, liveVaultRoot, packageRootA, packageRootB, join(sourceRoot, "legacy")]) mkdirSync(path);
  let liveEventStorePath = join(liveStoreRoot, "events.sqlite");
  const sourceDatabasePath = join(sourceRoot, "events.sqlite");
  const manifestPath = join(sourceRoot, "manifest.json");
  const driver = new NodeSqliteDriver({ DatabaseSync });
  let sourceEventCount: number = options.sourceEventCount ?? 2;
  const now = "2026-09-10T00:00:00.000Z";
  let projectionBinding = { projectId: "11111111-1111-4111-8111-111111111111",
    vaultId: "22222222-2222-4222-8222-222222222222", storeId: "33333333-3333-4333-8333-333333333333",
    workspaceId: "a".repeat(64), branchScopeId: null, branchRef: null, sessionId: null } as ProjectBinding;
  let lifecycle: LifecycleFixtureClient | undefined;
  let sessionId: string | undefined;
  let checkpointDraft: ReturnType<typeof decodeCheckpointDraft> | undefined;
  const identities = new Map<string, string | null>();
  const insertedCheckpoint = Boolean(options.parityCorpus && (options.artifactMetadata || options.checkpointHistory));
  const fixturePosition = (position: string | null): string | null => position === null ? null
    : insertedCheckpoint && BigInt(position) >= 3n ? String(BigInt(position) + 1n) : position;
  const fixtureScope = (value: unknown): unknown => {
    if (typeof value === "string") return identities.has(value) ? identities.get(value) : value;
    if (Array.isArray(value)) return value.map(fixtureScope);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, fixtureScope(v)]));
  };
  if (options.parityCorpus) {
    lifecycle = new LifecycleFixtureClient({ fixturePath: new URL("../fixtures/project-store-lifecycle-child.js", import.meta.url),
      timeoutMs: 15000, cleanupTimeoutMs: 15000, keyBroker: new LifecycleTestKeyBroker() });
    try {
      await lifecycle.ready();
      const started = await lifecycle.start({ projectRoot: liveStoreRoot, vaultRoot: liveVaultRoot,
        clientInstanceId: "parity-lifecycle", useParentKeyBroker: true });
      if (started.type !== "started") {
        const diagnostic = started.gitProbeDiagnostic;
        if (diagnostic) t.diagnostic(JSON.stringify({ phase: diagnostic.phase, reason: diagnostic.reason,
          probes: diagnostic.probes.map(probe => ({ status: probe.status,
            spawnErrorCode: probe.spawnError === null ? null
              : ["ETIMEDOUT", "ENOENT", "EACCES", "EPERM"].includes(probe.spawnError.code ?? "") ? probe.spawnError.code : "OTHER" })) }));
        throw new Error(`PARITY_FIXTURE_START_FAILED:${started.code}`);
      }
      const startedPayload = started.payload as Record<string, unknown> | undefined;
      if (typeof started.payload !== "object" || started.payload === null || Array.isArray(started.payload)
        || typeof startedPayload?.eventsPath !== "string") throw new Error("PARITY_FIXTURE_START_FAILED");
      liveEventStorePath = startedPayload.eventsPath;
      const begun = await lifecycle.mutation({ operation: "root-start", continuityKey: "retrieval-evaluation-v2-primary", idempotencyKey: "parity-start" });
      if (begun.type !== "result") throw new Error("PARITY_FIXTURE_ROOT_FAILED");
      const probe = driver.open(liveEventStorePath, { mode: "read-only-existing", busyTimeoutMs: 5000 });
      try {
        const event = probe.prepare("SELECT project_id,vault_id,store_id,workspace_id,branch_scope_id,branch_ref,session_id FROM events ORDER BY global_position LIMIT 1").get()!;
        projectionBinding = { projectId: String(event.project_id), vaultId: String(event.vault_id), storeId: String(event.store_id),
          workspaceId: String(event.workspace_id), branchScopeId: event.branch_scope_id as string | null, branchRef: event.branch_ref as string | null, sessionId: null } as ProjectBinding;
        sessionId = String(event.session_id);
      } finally { probe.close(); }
      const original = JSON.parse(readFileSync(new URL("../../../tests/fixtures/retrieval-evaluation/v2/source-events.json", import.meta.url), "utf8"));
      for (const key of ["projectId", "vaultId", "storeId", "workspaceId", "branchScopeId", "branchRef"] as const) {
        identities.set(original.sources[0].binding[key], projectionBinding[key]);
      }
      identities.set("50000000-0000-4000-8000-000000000701", sessionId);
      const oldCheckpoint = original.sources[0].events[1].payload.checkpoint;
      checkpointDraft = decodeCheckpointDraft(Object.fromEntries(["checkpointVersion", "taskSummary", "completedItems", "inProgressItems", "blockers",
        "nextActions", "decisions", "assumptions", "unresolvedConflicts", "filesTouched", "artifactReferences", "sourceReferences", "commandResults", "testResults", "materialClaims"]
        .map(key => [key, fixtureScope(oldCheckpoint[key])])));
      const checkpoint = await lifecycle.mutation(JSON.parse(JSON.stringify({ operation: "record-root-checkpoint", draft: checkpointDraft })) as LifecycleFixtureJsonValue);
      if (checkpoint.type !== "result") throw new Error("PARITY_FIXTURE_CHECKPOINT_FAILED");
      const reader = driver.open(liveEventStorePath, { mode: "read-only-existing", busyTimeoutMs: 5000 });
      try {
        const payload = JSON.parse(String(reader.prepare("SELECT payload_json FROM events WHERE event_type='SessionCheckpointRecorded'").get()!.payload_json));
        identities.set(oldCheckpoint.checkpointId, payload.checkpoint.checkpointId);
      } finally { reader.close(); }
    } catch (error) { await lifecycle.dispose(); throw error; }
  }
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
    if (!options.parityCorpus) applyCurrentProjectStoreSchema(connection, projectionBinding, now);
    const store = new EventStore(connection, new SqliteEventStoreStatements(connection), new MaintenanceFence(), new BranchScopeRepository(), () => now);
    if (options.parityCorpus) {
      const original = JSON.parse(readFileSync(new URL("../../../tests/fixtures/retrieval-evaluation/v2/source-events.json", import.meta.url), "utf8")) as { sources: { events: Record<string, unknown>[] }[] };
      const events = original.sources[0]!.events.slice(2).map(value => fixtureScope(value) as Record<string, unknown>);
      if (options.rankingPair) {
        if (events.some(event => JSON.stringify(event).includes(ORDER_PAIR_QUERY))) throw new Error("PARITY_FIXTURE_ORDER_TOKEN_COLLISION");
        for (const [ordinal, itemId] of ORDER_PAIR_IDS.entries()) {
          const summary = `${ORDER_PAIR_QUERY} independently specified source ${ordinal + 1}`;
          events.push({ eventId: randomUUID(), eventType: "MemorySourceRecorded", eventSchemaVersion: 2, occurredAt: now,
            visibilityScope: "session", sessionId, confidence: "high", verificationStatus: "verified", sourceRefs: [],
            payload: { sourceVersion: 2, binding: { ...projectionBinding, sessionId }, itemId, normalizedKey: `decision:parity-order-${ordinal + 1}`,
              status: "verified", confidence: "high", verificationMethod: "production-event-writer", validFrom: "2026-08-01T00:00:00.000Z", validTo: null,
              summary, contentHash: digest(summary), conflictGroupId: null, supersedingItemId: null } });
        }
      }
      // Complete authorized lifecycle history before the legacy material stream.
      // Session-scoped memory records retain their original session stream semantics.
      if (insertedCheckpoint) {
        const draft = { ...checkpointDraft!, ...(options.artifactMetadata ? { artifactReferences: [{ artifactId: "70000000-0000-4000-8000-000000000701",
          path: "src/parity-fixture.ts", summary: "Sensitive parity metadata sentinel", contentHash: digest("fixture-artifact"), confidence: "high" }] } : {}) };
        const result = await lifecycle!.mutation(JSON.parse(JSON.stringify({ operation: "record-root-checkpoint", expectedStreamVersion: "2",
          expectedBaseEventPosition: "2", draft })) as LifecycleFixtureJsonValue);
        if (result.type !== "result") throw new Error(`PARITY_FIXTURE_HISTORY_FAILED:${result.type === "error" ? result.code : "PROTOCOL"}`);
      }
      const sourceContext: ProjectContext = { ...context, binding: { ...context.binding, clientInstanceId: "retrieval-evaluation-fixture-client" } };
      let ordinal = 0;
      const writer = new EventStore(connection, new SqliteEventStoreStatements(connection), new MaintenanceFence(), new BranchScopeRepository(), () => now,
        () => String(events[ordinal++]!.eventId));
      // The sealed evaluator requires distinct command idempotency keys per event.
      for (let offset = 0; offset < events.length; offset += 1) {
        const batch = events.slice(offset, offset + 1);
        writer.append({ context: sourceContext, commandId: randomUUID(), idempotencyKey: `parity-source-${offset}`, commandType: "RecordProjectionSources",
          correlationId: randomUUID(), agentId: "retrieval-evaluation-fixture", expectedStreamVersion: BigInt(offset + 2 + Number(insertedCheckpoint)),
          streamId: `session/${sessionId}`, streamType: "session", outbox: [], publicResponse: { recorded: true },
          events: batch.map(raw => ({ eventType: raw.eventType, eventSchemaVersion: raw.eventSchemaVersion, occurredAt: raw.occurredAt,
            visibilityScope: raw.visibilityScope, sessionId: raw.sessionId, confidence: raw.confidence, verificationStatus: raw.verificationStatus,
            payload: raw.payload, sourceRefs: raw.sourceRefs, evidenceRefs: [], evidenceDigests: [] }) as PendingEvent) });
      }
      sourceEventCount = Number(connection.prepare("SELECT count(*) AS count FROM events").get()!.count);
      await lifecycle!.dispose(); lifecycle = undefined;
    } else if (sourceEventCount > 0) {
      if (!Number.isSafeInteger(sourceEventCount) || sourceEventCount > 100_000) throw new Error("FIXTURE_SOURCE_EVENT_COUNT_INVALID");
      const events = Array.from({ length: sourceEventCount }, (_, ordinal) => {
        const summary = `Production fixture source ${ordinal + 1}`;
        return { eventType: "MemorySourceRecorded", eventSchemaVersion: 1, occurredAt: now,
          visibilityScope: "project" as const, confidence: "high" as const, verificationStatus: "verified" as const,
          payload: { sourceVersion: 1, binding: { ...projectionBinding }, itemId: randomUUID(), normalizedKey: `decision:fixture-${ordinal}`,
            status: "verified", confidence: "high", verificationMethod: "production-event-writer", validFrom: now, validTo: null,
            summary, contentHash: digest(summary) }, sourceRefs: [], evidenceRefs: [], evidenceDigests: [] };
      });
      for (let offset = 0; offset < events.length; offset += MAX_EVENTS_PER_COMMAND) {
        const batch = events.slice(offset, offset + MAX_EVENTS_PER_COMMAND);
        store.append({ context, commandId: randomUUID(), idempotencyKey: `migration-fixture-${offset}`,
          commandType: "RecordProjectionSources", correlationId: randomUUID(), agentId: "migration-fixture",
          expectedStreamVersion: BigInt(offset), streamId: "migration-fixture", streamType: "memory",
          events: batch, outbox: [], publicResponse: { recorded: true } });
      }
    }
    const checkpoint = connection.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (checkpoint?.busy !== 0n) throw new Error("Fixture checkpoint did not complete");
    if (options.aliasLiveStore) linkSync(liveEventStorePath, sourceDatabasePath);
    else copyFileSync(liveEventStorePath, sourceDatabasePath);
    for (const suffix of ["-wal", "-shm"]) copyFileSync(`${liveEventStorePath}${suffix}`, `${sourceDatabasePath}${suffix}`);
  } finally { try { connection.close(); } finally { await lifecycle?.dispose(); } }
  const sourceEvents: StoredEvent[] = [];
  replayCommittedProjectionEvents(projectionBinding, { driver, eventStorePath: liveEventStorePath, terminalEventPosition: BigInt(sourceEventCount) }, (event) => {
    decodeProjectionEvent(event);
    sourceEvents.push(event);
  });
  writeFileSync(join(sourceRoot, "legacy", "one.md"), "# Decision\nKeep V1 authoritative.\n", "utf8");
  writeFileSync(join(sourceRoot, "legacy", "two.md"), "# Insight\nตรวจสอบ immutable copy.\n", "utf8");
  const legacyArtifacts = (options.legacyArtifacts === false ? [] : ["legacy/one.md", "legacy/two.md"]).map((path) => ({
    ...describeSourceFile(sourceRoot, path), mediaType: "text/markdown; charset=utf-8" as const,
  }));
  const manifest = sealManifest({ schemaVersion: 1, copyFormatVersion: 1,
    projectId: projectionBinding.projectId, vaultId: projectionBinding.vaultId, storeId: projectionBinding.storeId,
    workspaceId: projectionBinding.workspaceId, branchScopeId: null, branchRef: null,
    sourceSchemaVersion: CURRENT_PROJECT_STORE_SCHEMA_VERSION, database: describeSourceFile(sourceRoot, "events.sqlite"),
    sqliteSidecars: ["events.sqlite-wal", "events.sqlite-shm"].map((path) => describeSourceFile(sourceRoot, path)), legacyArtifacts,
    eventCount: sourceEvents.length, aggregateSourceBytes: sourceEvents.reduce((sum, event) => sum + Buffer.byteLength(event.payloadJson), 0)
      + legacyArtifacts.reduce((sum, artifact) => sum + artifact.size, 0),
    terminalEventPosition: String(sourceEventCount), terminalEventHash: sourceEvents.at(-1)?.eventHash ?? "0".repeat(64), createdAt: now, authorizedActorFingerprint: digest("fixture-actor") });
  writeFileSync(manifestPath, canonicalJson(manifest));
  const policy = decodeShadowMigrationPolicyV1({ schemaVersion: 1, maxEvents: 100_000, maxAggregateBytes: 67_108_864,
    maxEventBytes: 1_048_576, maxBatchEvents: 1000, maxBatchBytes: 8_388_608, deadlineMs: 300_000, maxRetries: 3,
    initialBackoffMs: 500, maxBackoffMs: 2000, expectedDifferencePolicyVersion: 1, maxExpectedDifferenceRuleAgeMs: 604_800_000 });
  const verificationInput = { driver, sourceRoot, manifestPath, liveEventStorePath, liveLegacyArtifactRoot: liveVaultRoot,
    expectedBinding: projectionBinding, policy };
  const configurationChecksum = shadowMigrationConfigurationChecksum(decodeShadowMigrationConfigurationV1({
    schemaVersion: 1,
    policyChecksum: shadowMigrationPolicyChecksum(policy),
    packageFormatVersion: 1,
    migrationAlgorithmVersion: 1,
    expectedDifferencePolicyVersion: policy.expectedDifferencePolicyVersion,
  }));
  return { root, sourceRoot, manifestPath, sourceDatabasePath, liveEventStorePath, liveVaultRoot, projectionBinding,
    sourceEvents, manifest, driver, policy, verificationInput, packageRootA, packageRootB, fixtureScope, fixturePosition, identityMapping: Object.fromEntries(identities),
    packageInput: Object.freeze({ policy, buildIdentityHash: digest("fixture-build-identity"), configurationChecksum }),
    writeManifest(value: V1SourceCopyManifestV1) { writeFileSync(manifestPath, canonicalJson(sealManifest(value))); },
  };
}

/** Compatibility source and target produced by the current writers, schema and isolated importer. */
export async function createCompatibilityFixture(t: TestContext, options: { legacyArtifacts?: boolean; database?: typeof DatabaseSync } = {}) {
  let cleanup = () => {}; t.after(() => cleanup());
  const f = await createV2ShadowMigrationFixture(t, options);
  const source = await verifyV1SourceCopy(f.verificationInput); cleanup = () => source.close();
  const sealedPackage = await sealV2MigrationPackage({ ...f.packageInput, source, packageRoot: f.packageRootA });
  cleanup = () => { try { sealedPackage.close(); } finally { source.close(); } };
  const targetDirectory = join(f.root, "compatibility-store"), isolatedRoot = join(f.root, "compatibility"); mkdirSync(isolatedRoot); mkdirSync(targetDirectory);
  const eventStorePath = join(targetDirectory, "events.sqlite");
  let connection = f.driver.open(eventStorePath, { mode: "create", busyTimeoutMs: 5000 }), connectionOpen = true;
  cleanup = () => { try { if (connectionOpen) connection.close(); } finally { try { sealedPackage.close(); } finally { source.close(); } } };
  applyCurrentProjectStoreSchema(connection, f.projectionBinding, f.manifest.createdAt); connection.exec(v2ShadowMigration.sql);
  const repository = new SqliteV2ShadowMigrationRepository(connection), rolloutRevisionId = randomUUID();
  const v1ProjectionDirectory = join(f.root, "compatibility-v1"), v2ProjectionDirectory = join(f.root, "compatibility-v2");
  mkdirSync(v1ProjectionDirectory); mkdirSync(v2ProjectionDirectory);
  const prepared = await new V2ShadowProjectionPublisher({ driver: f.driver, connection, eventStorePath,
    liveEventStorePath: f.liveEventStorePath, liveVaultRoot: f.liveVaultRoot, v1ProjectionDirectory, v2ProjectionDirectory, policy: f.policy })
    .prepareV1Baseline({ source, sealedPackage });
  new RolloutControlPlane(new SqliteRolloutControlPlaneRepository(connection)).createRevision({
    projectId: f.projectionBinding.projectId, revisionId: rolloutRevisionId, parentRevisionId: null,
    buildIdentityHash: sealedPackage.manifest.buildIdentityHash, migrationIdentityHash: sealedPackage.migrationIdentity,
    configurationChecksum: sealedPackage.manifest.configurationChecksum, v1BaselineChecksum: prepared.baselineChecksum,
    cohortAlgorithmVersion: 1, cohortSalt: digest("compatibility-salt"), cohortBasisPoints: 0, createdAt: f.manifest.createdAt });
  repository.transact(f.projectionBinding.projectId, sealedPackage.migrationIdentity, tx => tx.insertRun({
    projectId: f.projectionBinding.projectId, migrationIdentity: sealedPackage.migrationIdentity, rolloutRevisionId,
    packageChecksum: sealedPackage.manifest.packageChecksum, sourceManifestChecksum: f.manifest.manifestChecksum,
    sourceTerminalPosition: BigInt(f.manifest.terminalEventPosition), sourceTerminalHash: f.manifest.terminalEventHash,
    configurationChecksum: sealedPackage.manifest.configurationChecksum, policyChecksum: shadowMigrationPolicyChecksum(f.policy),
    buildIdentityHash: sealedPackage.manifest.buildIdentityHash, createdAt: f.manifest.createdAt }));
  const workspace = { kind: "non-git" as const, workspaceRoot: f.root, workspaceId: f.projectionBinding.workspaceId };
  const context: ProjectContext = { workspace, checkedAt: f.manifest.createdAt, binding: { ...f.projectionBinding,
    projectBindingId: randomUUID(), generation: 1, contextFingerprint: "compatibility", source: "explicit-cli", clientNamespace: "compatibility-test",
    clientInstanceId: randomUUID(), actorRole: "primary", projectRoot: f.root, vaultRoot: f.liveVaultRoot,
    descriptorPath: join(f.liveVaultRoot, ".project-memory.json"), workspace, establishedAt: f.manifest.createdAt,
    storeRoute: { kind: "vault-local", storeRoot: f.root, eventsPath: eventStorePath,
      storeManifestPath: join(f.root, "store.json"), projectionManifestPath: join(f.root, "projection.json") } } };
  new V2ShadowImporter({ connection, statements: new SqliteEventStoreStatements(connection), maintenance: new MaintenanceFence(),
    branchScopes: new BranchScopeRepository(), policy: f.policy }).import({ context, sealedPackage });
  connection.close(); connectionOpen = false;
  connection = new NodeSqliteDriver({ DatabaseSync: options.database ?? DatabaseSync }).open(eventStorePath,
    { mode: "existing", busyTimeoutMs: 5000, bindFileIdentity: true }); connectionOpen = true;
  return { ...f, source, sealedPackage, connection, repository: new SqliteV2ShadowMigrationRepository(connection), rolloutRevisionId, isolatedRoot, eventStorePath,
    input: { source, sealedPackage, rolloutRevisionId },
    materializerOptions: { driver: f.driver, connection, eventStorePath, isolatedRoot,
      liveEventStorePath: f.liveEventStorePath, liveVaultRoot: f.liveVaultRoot, policy: f.policy } };
}

/** Fresh production UUID fixture, fully written before source-copy verification. */
export async function createSnapshotParityFixture(t: TestContext, options: { artifactMetadata?: boolean; checkpointHistory?: boolean; rankingPair?: boolean } = {}) {
  let cleanup = () => {};
  t.after(() => cleanup());
  const f = await createV2ShadowMigrationFixture(t, { ...options, parityCorpus: true, legacyArtifacts: false });
  const source = await verifyV1SourceCopy(f.verificationInput);
  cleanup = () => source.close();
  const sealedPackage = await sealV2MigrationPackage({ ...f.packageInput, source, packageRoot: f.packageRootA });
  cleanup = () => { try { sealedPackage.close(); } finally { source.close(); } };
  const eventStorePath = join(f.root, "target.sqlite"), v1ProjectionDirectory = join(f.root, "v1"), v2ProjectionDirectory = join(f.root, "v2");
  mkdirSync(v1ProjectionDirectory); mkdirSync(v2ProjectionDirectory);
  const connection = f.driver.open(eventStorePath, { mode: "create", busyTimeoutMs: 5000 });
  cleanup = () => { try { connection.close(); } finally { try { sealedPackage.close(); } finally { source.close(); } } };
  applyCurrentProjectStoreSchema(connection, f.projectionBinding, f.manifest.createdAt);
  connection.exec(v2ShadowMigration.sql);
  const repository = new SqliteV2ShadowMigrationRepository(connection);
  const publisherOptions = { driver: f.driver, connection, eventStorePath, liveEventStorePath: f.liveEventStorePath,
    liveVaultRoot: f.liveVaultRoot, v1ProjectionDirectory, v2ProjectionDirectory, policy: f.policy };
  const publisher = new V2ShadowProjectionPublisher(publisherOptions);
  const preparedV1 = await publisher.prepareV1Baseline({ source, sealedPackage });
  const rolloutRevisionId = randomUUID();
  const control = new RolloutControlPlane(new SqliteRolloutControlPlaneRepository(connection));
  control.createRevision({ projectId: f.projectionBinding.projectId, revisionId: rolloutRevisionId, parentRevisionId: null,
    buildIdentityHash: sealedPackage.manifest.buildIdentityHash, migrationIdentityHash: sealedPackage.migrationIdentity,
    configurationChecksum: sealedPackage.manifest.configurationChecksum, v1BaselineChecksum: preparedV1.baselineChecksum,
    cohortAlgorithmVersion: 1, cohortSalt: digest("salt"), cohortBasisPoints: 0, createdAt: f.manifest.createdAt });
  if (control.state(f.projectionBinding.projectId).mode !== "off") throw new Error("PARITY_FIXTURE_ROLLOUT_NOT_OFF");
  repository.transact(f.projectionBinding.projectId, sealedPackage.migrationIdentity, tx => {
    tx.insertRun({ projectId: f.projectionBinding.projectId, migrationIdentity: sealedPackage.migrationIdentity, rolloutRevisionId,
      packageChecksum: sealedPackage.manifest.packageChecksum, sourceManifestChecksum: f.manifest.manifestChecksum,
      sourceTerminalPosition: BigInt(f.manifest.terminalEventPosition), sourceTerminalHash: f.manifest.terminalEventHash,
      configurationChecksum: sealedPackage.manifest.configurationChecksum, policyChecksum: shadowMigrationPolicyChecksum(f.policy),
      buildIdentityHash: sealedPackage.manifest.buildIdentityHash, createdAt: f.manifest.createdAt });
    for (const [ordinal, phase] of (["snapshot-verified", "package-sealed"] as const).entries()) {
      const body = { projectId: f.projectionBinding.projectId, migrationIdentity: sealedPackage.migrationIdentity, ordinal, attemptId: randomUUID(),
        phase, priorTransitionHash: tx.readTransitions().at(-1)?.transitionHash ?? "0".repeat(64), evidenceDigest: digest(phase), recordedAt: f.manifest.createdAt };
      tx.appendTransition({ ...body, transitionHash: digest("project-memory/v2-shadow-migration-transition/v1\n" + canonicalJson(body)) });
    }
  });
  const workspace = { kind: "non-git" as const, workspaceRoot: f.root, workspaceId: f.projectionBinding.workspaceId };
  const context: ProjectContext = { workspace, checkedAt: f.manifest.createdAt, binding: { ...f.projectionBinding, projectBindingId: randomUUID(), generation: 1,
    contextFingerprint: "parity", source: "explicit-cli", clientNamespace: "parity-test", clientInstanceId: randomUUID(), actorRole: "primary",
    projectRoot: f.root, vaultRoot: f.liveVaultRoot, descriptorPath: join(f.liveVaultRoot, ".project-memory.json"), workspace, establishedAt: f.manifest.createdAt,
    storeRoute: { kind: "vault-local", storeRoot: f.root, eventsPath: eventStorePath, storeManifestPath: join(f.root, "store.json"), projectionManifestPath: join(f.root, "projection.json") } } };
  new V2ShadowImporter({ connection, statements: new SqliteEventStoreStatements(connection), maintenance: new MaintenanceFence(),
    branchScopes: new BranchScopeRepository(), policy: f.policy }).import({ context, sealedPackage });
  repository.transact(f.projectionBinding.projectId, sealedPackage.migrationIdentity, tx => {
    const body = { projectId: f.projectionBinding.projectId, migrationIdentity: sealedPackage.migrationIdentity, ordinal: 2, attemptId: randomUUID(),
      phase: "import-committed" as const, priorTransitionHash: tx.readTransitions().at(-1)!.transitionHash, evidenceDigest: digest("import"), recordedAt: f.manifest.createdAt };
    tx.appendTransition({ ...body, transitionHash: digest("project-memory/v2-shadow-migration-transition/v1\n" + canonicalJson(body)) });
  });
  const projections = await publisher.publishV2({ source, sealedPackage, preparedV1, rolloutRevisionId });
  const rawJudgments = JSON.parse(readFileSync(new URL("../../../tests/fixtures/retrieval-evaluation/v2/judgments.json", import.meta.url), "utf8")) as { queries: RetrievalEvaluationQueryV1[] };
  const seen = new Set<string>();
  const chosen = rawJudgments.queries.filter(q => {
    if (q.queryId === "eval-v2-0170") return true; // Include the next-action denominator as well as every critical class.
    if (seen.has(q.criticalClass)) return false;
    seen.add(q.criticalClass); return true;
  });
  const queries = chosen.map((q, i) => ({ ...(f.fixtureScope(q) as RetrievalEvaluationQueryV1), queryId: `eval-v2-${String(i + 1).padStart(4, "0")}`,
    eligibleScope: { ...(f.fixtureScope(q.eligibleScope) as RetrievalEvaluationQueryV1["eligibleScope"]),
      knownAt: f.fixturePosition(q.eligibleScope.knownAt), requiredEventPosition: f.manifest.terminalEventPosition } }));
  if (options.rankingPair) {
    const relevanceGrades = Object.fromEntries(ORDER_PAIR_IDS.map(id => [id, 3 as const]));
    queries.push({ ...queries[0]!, queryId: "eval-v2-0011", queryText: ORDER_PAIR_QUERY,
      eligibleScope: { ...queries[0]!.eligibleScope, knownAt: f.manifest.terminalEventPosition },
      expectedCitations: ORDER_PAIR_IDS.map(itemId => ({ itemId, anchor: null })), relevanceGrades,
      judgments: [{ judgeId: "judge-v2-a", relevanceGrades }, { judgeId: "judge-v2-b", relevanceGrades }],
      expectations: { exactIdentifierPath: true, currentSessionCheckpoint: false, openFollowUp: false, nextAction: false,
        semanticParaphrase: false, bitemporal: false, conflictGroupIds: [] } });
  }
  const coordinator = new DefaultProjectionBuildCoordinator({ eventReader: new SqliteProjectionEventReader({ driver: f.driver, eventStorePath: f.sourceDatabasePath }),
    projectionDirectory: v1ProjectionDirectory, builder: new ImmutableProjectionBuilder({ driver: f.driver, projectionDirectory: v1ProjectionDirectory }) });
  const service = new InternalRetrievalService({ projections: { pin: binding => coordinator.leasePublished(binding) }, candidates: new SqliteRetrievalCandidateRepository() });
  const metrics = await evaluateRetrievalQueries(queries, "retrieval-evaluation-v1", service);
  const jsonHash = (value: unknown) => digest(JSON.stringify(value));
  const judgments = { schemaVersion: 2, corpusVersion: "retrieval-evaluation-v2", queries };
  const sourceEvents = { schemaVersion: 2, corpusVersion: "retrieval-evaluation-v2", sources: [{ binding: f.projectionBinding,
    events: JSON.parse(JSON.stringify(f.sourceEvents, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value)) as Record<string, unknown>[] }] };
  const baseline = { schemaVersion: 1, v1Version: "parity-subset-v1", judgmentsSha256: jsonHash(queries), metrics, provenanceCommand: "Task9 production V1 subset evaluation" };
  const corpus = parseSealedRetrievalEvaluationBundle({ schemaVersion: 2, corpusVersion: "retrieval-evaluation-v2", files: {
    "source-events.json": jsonHash(sourceEvents), "judgments.json": jsonHash(judgments), "v1-shadow-baseline.json": jsonHash(baseline) } }, sourceEvents, judgments, baseline);
  let rankingPair;
  if (options.rankingPair) {
    const reader = new V2ImportedProjectionEventReader({ driver: f.driver, eventStorePath, sealedPackage, sourceManifest: f.manifest });
    const v2 = new V2ProjectionBuildCoordinator({ eventReader: reader, projectionDirectory: v2ProjectionDirectory,
      builder: new ImmutableProjectionBuilder({ driver: f.driver, projectionDirectory: v2ProjectionDirectory }) });
    const bridge = createV2ParityRetrievalBridge(await v2.leasePublishedForEvaluation(f.projectionBinding));
    try {
      await evaluateSealedRetrieval(corpus, service);
      await evaluateSealedRetrieval(corpus, bridge.service);
      const request = { binding: f.projectionBinding, query: ORDER_PAIR_QUERY, limit: 10, tokenBudget: 32768,
        consistency: { requiredEventPosition: BigInt(f.manifest.terminalEventPosition), deadlineMs: 30000 }, candidateLimit: 512,
        visibility: "session" as const, sessionId: String(f.fixtureScope("50000000-0000-4000-8000-000000000701")),
        validAt: queries[0]!.eligibleScope.validAt!, knownAt: BigInt(f.manifest.terminalEventPosition), vector: { enabled: false } };
      rankingPair = { queryId: "eval-v2-0011", queryText: ORDER_PAIR_QUERY, itemIds: ORDER_PAIR_IDS,
        v1: await service.retrieve(request), v2: await bridge.service.retrieve(request) };
    } finally { bridge.close(); }
  }
  const metadataRules: ExpectedDifferenceRuleV1[] = ["symbol", "commit_hash", "heading"].map(fieldPath => {
    const body = { schemaVersion: 1 as const, ruleId: `metadata-${fieldPath}`, policyVersion: 1, category: "representation" as const, projection: "artifactsFiles" as const,
      rowIdentityHash: parityRowIdentityHash("artifactsFiles", { project_id: f.projectionBinding.projectId, session_id: f.fixtureScope("50000000-0000-4000-8000-000000000701"), artifact_id: "70000000-0000-4000-8000-000000000701" }), fieldPath,
      predicate: { operator: "exact-value-hashes" as const, v1ValueHash: parityValueHash(undefined), v2ValueHash: parityValueHash(null) },
      rationaleDigest: digest("metadata"), approverFingerprint: digest("approver"), approvalReferenceDigest: digest("approval"),
      issuedAt: f.manifest.createdAt, expiresAt: "2026-09-11T00:00:00.000Z", rolloutRevisionId, migrationIdentity: sealedPackage.migrationIdentity };
    return { ...body, ruleChecksum: expectedDifferenceRuleChecksum(body) };
  });
  const input: SnapshotParityInput = { ...publisherOptions, source, sealedPackage, preparedV1, rolloutRevisionId, projections,
    runStartedAt: f.manifest.createdAt, rules: [], sealedRetrieval: { corpus } };
  return { ...f, source, sealedPackage, connection, repository, input, corpus, metadataRules, plaintextSentinel: "Sensitive parity metadata sentinel",
    chosenQueryIds: chosen.map(q => q.queryId), rankingPair,
    phases: () => repository.transact(f.projectionBinding.projectId, sealedPackage.migrationIdentity, tx => tx.readTransitions().map(v => v.phase)),
    storedReport: () => repository.transact(f.projectionBinding.projectId, sealedPackage.migrationIdentity, tx => tx.readParityReport()) };
}
