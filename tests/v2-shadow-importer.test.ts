import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { StoredEvent } from "../src/orchestrator/contracts/event.js";
import { authenticateStoredEvent } from "../src/orchestrator/integrity/stored-event-authenticator.js";
import { verifyV1SourceCopy } from "../src/orchestrator/migration/v1-source-copy.js";
import { sealV2MigrationPackage, type SealedV2MigrationPackage, type V2MigrationPackageRecordV1 } from "../src/orchestrator/migration/v2-migration-package.js";
import { V2ShadowImporter } from "../src/orchestrator/migration/v2-shadow-importer.js";
import { deterministicMigrationUuid, ShadowMigrationError, shadowMigrationPolicyChecksum, type ShadowMigrationPolicyV1 } from "../src/orchestrator/migration/v2-shadow-migration.contracts.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { BranchScopeRepository } from "../src/orchestrator/storage/branch-scope.repository.js";
import { GENESIS_GLOBAL_HASH, MAX_CANONICAL_COMMAND_BYTES, SqliteEventStoreStatements, type EventAppendStatements, type EventStoreFaultInjector } from "../src/orchestrator/storage/event-store.js";
import { MaintenanceFence } from "../src/orchestrator/storage/maintenance-fence.js";
import { v2ShadowMigration } from "../src/orchestrator/storage/migrations/0007-v2-shadow-migration.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import type { SqliteConnection } from "../src/orchestrator/storage/sqlite-driver.js";
import { SqliteV2ShadowMigrationRepository } from "../src/orchestrator/storage/v2-shadow-migration.repository.js";
import type { ProjectContext } from "../src/orchestrator/identity/contracts.js";
import { applyCurrentProjectStoreSchema } from "./support/current-project-store-schema.js";
import { createV2ShadowMigrationFixture } from "./support/v2-shadow-migration-fixture.js";

const driver = new NodeSqliteDriver({ DatabaseSync }); const NOW = "2026-09-10T00:00:00.000Z";
const PACKAGE_CREATED_AT = "2026-09-10T00:00:10.000Z";
async function fixture(t: test.TestContext, faultInjector?: EventStoreFaultInjector) {
  const sourceFixture = await createV2ShadowMigrationFixture(t);
  sourceFixture.writeManifest({ ...sourceFixture.manifest, createdAt: PACKAGE_CREATED_AT });
  const source = await verifyV1SourceCopy(sourceFixture.verificationInput);
  const sealedPackage = await sealV2MigrationPackage({ ...sourceFixture.packageInput, source, packageRoot: sourceFixture.packageRootA });
  const connection = driver.open(`${sourceFixture.root}/target.sqlite`, { mode: "create", busyTimeoutMs: 5000 }); applyCurrentProjectStoreSchema(connection, sourceFixture.projectionBinding, NOW); connection.exec(v2ShadowMigration.sql);
  const workspace = { kind: "non-git" as const, workspaceRoot: sourceFixture.root, workspaceId: sourceFixture.projectionBinding.workspaceId };
  const context = { workspace, checkedAt: NOW, binding: { ...sourceFixture.projectionBinding, projectBindingId: randomUUID(), generation: 1, contextFingerprint: "shadow", source: "explicit-cli", clientNamespace: "shadow-test", clientInstanceId: randomUUID(), actorRole: "primary", projectRoot: sourceFixture.root, vaultRoot: sourceFixture.liveVaultRoot, descriptorPath: `${sourceFixture.liveVaultRoot}/.project-memory.json`, storeRoute: { kind: "vault-local", storeRoot: sourceFixture.root, eventsPath: `${sourceFixture.root}/target.sqlite`, storeManifestPath: `${sourceFixture.root}/store.json`, projectionManifestPath: `${sourceFixture.root}/projection.json` }, workspace, establishedAt: NOW } } as unknown as ProjectContext;
  const revisionId = randomUUID(); connection.prepare("INSERT INTO rollout_revisions(project_id,revision_id,parent_revision_id,build_identity_hash,migration_identity_hash,configuration_checksum,v1_baseline_checksum,cohort_algorithm_version,cohort_salt,cohort_basis_points,created_at) VALUES ($p,$r,NULL,$h,$h,$h,$h,1,$h,0,$n)").run({ $p: context.binding.projectId, $r: revisionId, $h: "a".repeat(64), $n: NOW });
  const repository = new SqliteV2ShadowMigrationRepository(connection); repository.transact(context.binding.projectId, sealedPackage.migrationIdentity, tx => tx.insertRun({ projectId: context.binding.projectId, migrationIdentity: sealedPackage.migrationIdentity, rolloutRevisionId: revisionId, packageChecksum: sealedPackage.manifest.packageChecksum, sourceManifestChecksum: sealedPackage.manifest.sourceManifestChecksum, sourceTerminalPosition: BigInt(sealedPackage.manifest.terminalEventPosition), sourceTerminalHash: sealedPackage.manifest.terminalEventHash, configurationChecksum: sealedPackage.manifest.configurationChecksum, policyChecksum: shadowMigrationPolicyChecksum(sourceFixture.policy), buildIdentityHash: sealedPackage.manifest.buildIdentityHash, createdAt: NOW }));
  return { connection, context, sealedPackage, repository, policy: sourceFixture.policy, sourceFixture, close: () => { sealedPackage.close(); source.close(); connection.close(); }, importer: new V2ShadowImporter({ connection, statements: new SqliteEventStoreStatements(connection), maintenance: new MaintenanceFence(), branchScopes: new BranchScopeRepository(), repository, policy: sourceFixture.policy, faultInjector }) };
}
const unknown = (error: unknown) => error instanceof ShadowMigrationError && error.code === "MIGRATION_OUTCOME_UNKNOWN";
const limitExceeded = (error: unknown) => error instanceof ShadowMigrationError && error.code === "MIGRATION_LIMIT_EXCEEDED";

function recordBytes(record: V2MigrationPackageRecordV1): Buffer { return Buffer.concat([...record.readChunks()].map(chunk => Buffer.from(chunk))); }
function packageFromRecords(base: SealedV2MigrationPackage, records: readonly V2MigrationPackageRecordV1[]): SealedV2MigrationPackage {
  return { rootPath: base.rootPath, migrationIdentity: base.migrationIdentity, manifest: { ...base.manifest,
    eventCount: records.filter(record => record.descriptor.kind === "source-event").length,
    legacyArtifactCount: records.filter(record => record.descriptor.kind === "legacy-artifact").length,
    aggregateSourceBytes: records.reduce((sum, record) => sum + record.descriptor.byteLength, 0),
    recordDescriptors: records.map(record => record.descriptor) }, *records() { yield* records; }, assertUnchanged() {}, close() {} };
}
function repeatedSourcePackage(base: SealedV2MigrationPackage, count: number): SealedV2MigrationPackage {
  const source = [...base.records()].find(record => record.descriptor.kind === "source-event")!; const bytes = recordBytes(source);
  return packageFromRecords(base, Array.from({ length: count }, (_, ordinal) => ({ descriptor: { ...source.descriptor, ordinal,
    sourceIdentity: deterministicMigrationUuid("event", base.migrationIdentity, 10_000 + ordinal) }, *readChunks() { yield bytes; } })));
}
function artifactPackage(base: SealedV2MigrationPackage, bytes: Uint8Array, override: { byteLength?: number; contentSha256?: string } = {}): SealedV2MigrationPackage {
  const hash = createHash("sha256").update(bytes).digest("hex");
  return packageFromRecords(base, [{ descriptor: { schemaVersion: 1, ordinal: 0, kind: "legacy-artifact", sourceIdentity: hash,
    relativePath: "legacy/large.md", byteLength: override.byteLength ?? bytes.length, contentSha256: override.contentSha256 ?? hash }, *readChunks() { yield bytes; } }]);
}
function streamingPackage(base: SealedV2MigrationPackage, connection: SqliteConnection): SealedV2MigrationPackage {
  const package_ = repeatedSourcePackage(base, 2); const records = [...package_.records()];
  return { ...package_, *records() { yield records[0]!;
    if (Number(connection.prepare("SELECT count(*) AS count FROM events").get()?.count) === 0) throw new Error("EAGER_PACKAGE_MATERIALIZATION");
    yield records[1]!; } };
}
function importerWithPolicy(f: Awaited<ReturnType<typeof fixture>>, policy: ShadowMigrationPolicyV1): V2ShadowImporter {
  return new V2ShadowImporter({ connection: f.connection, statements: new SqliteEventStoreStatements(f.connection), maintenance: new MaintenanceFence(),
    branchScopes: new BranchScopeRepository(), repository: f.repository, policy });
}
function commandGroupSizes(f: Awaited<ReturnType<typeof fixture>>): number[] {
  return f.connection.prepare("SELECT count(*) AS count FROM events GROUP BY command_id ORDER BY min(global_position)").all().map(row => Number(row.count));
}
function field(row: Record<string, unknown>, key: string): string { assert.equal(typeof row[key], "string"); return row[key] as string; }
function canonicalCommandBytes(f: Awaited<ReturnType<typeof fixture>>): number {
  const rows = f.connection.prepare("SELECT * FROM events ORDER BY global_position").all(); assert.ok(rows.length > 0); const first = rows[0]!;
  const stored = f.connection.prepare("SELECT response_json FROM command_dedup WHERE command_id=$id").get({ $id: field(first, "command_id") }); assert.ok(stored);
  const response = (JSON.parse(field(stored!, "response_json")) as { response: unknown }).response;
  const material = { commandId: field(first, "command_id"), commandType: "ImportV2ShadowBatch", projectId: field(first, "project_id"),
    storeId: field(first, "store_id"), workspaceId: field(first, "workspace_id"), git: null, streamId: field(first, "stream_id"), streamType: field(first, "stream_type"),
    expectedStreamVersion: ((first.stream_version as bigint) - 1n).toString(), correlationId: field(first, "correlation_id"), agentId: field(first, "agent_id"),
    events: rows.map(row => ({ eventType: field(row, "event_type"), eventSchemaVersion: Number(row.event_schema_version), occurredAt: field(row, "occurred_at"),
      visibilityScope: field(row, "visibility_scope"), sessionId: row.session_id, parentSessionId: row.parent_session_id, causationId: row.causation_id,
      confidence: field(row, "confidence"), verificationStatus: field(row, "verification_status"), payload: JSON.parse(field(row, "payload_json")),
      sourceRefs: JSON.parse(field(row, "source_refs_json")), evidenceRefs: [], evidenceDigests: [] })), outbox: [],
    idempotencyKey: field(first, "idempotency_key"), publicResponse: response };
  return Buffer.byteLength(canonicalJson(material), "utf8");
}
function siblingTarget(f: Awaited<ReturnType<typeof fixture>>, name: string) {
  const path = `${f.sourceFixture.root}/${name}.sqlite`; const connection = driver.open(path, { mode: "create", busyTimeoutMs: 5000 });
  applyCurrentProjectStoreSchema(connection, f.sourceFixture.projectionBinding, NOW); connection.exec(v2ShadowMigration.sql);
  const context = { ...f.context, binding: { ...f.context.binding, storeRoute: { ...f.context.binding.storeRoute, eventsPath: path } } } as ProjectContext;
  const revisionId = randomUUID(); connection.prepare("INSERT INTO rollout_revisions(project_id,revision_id,parent_revision_id,build_identity_hash,migration_identity_hash,configuration_checksum,v1_baseline_checksum,cohort_algorithm_version,cohort_salt,cohort_basis_points,created_at) VALUES ($p,$r,NULL,$h,$h,$h,$h,1,$h,0,$n)").run({ $p: context.binding.projectId, $r: revisionId, $h: "a".repeat(64), $n: NOW });
  const repository = new SqliteV2ShadowMigrationRepository(connection); repository.transact(context.binding.projectId, f.sealedPackage.migrationIdentity, tx => tx.insertRun({
    projectId: context.binding.projectId, migrationIdentity: f.sealedPackage.migrationIdentity, rolloutRevisionId: revisionId,
    packageChecksum: f.sealedPackage.manifest.packageChecksum, sourceManifestChecksum: f.sealedPackage.manifest.sourceManifestChecksum,
    sourceTerminalPosition: BigInt(f.sealedPackage.manifest.terminalEventPosition), sourceTerminalHash: f.sealedPackage.manifest.terminalEventHash,
    configurationChecksum: f.sealedPackage.manifest.configurationChecksum, policyChecksum: shadowMigrationPolicyChecksum(f.policy),
    buildIdentityHash: f.sealedPackage.manifest.buildIdentityHash, createdAt: NOW }));
  return { connection, context, importer: new V2ShadowImporter({ connection, statements: new SqliteEventStoreStatements(connection),
    maintenance: new MaintenanceFence(), branchScopes: new BranchScopeRepository(), repository, policy: f.policy }), close: () => connection.close() };
}
function storedEvents(connection: SqliteConnection): StoredEvent[] {
  return connection.prepare("SELECT * FROM events ORDER BY global_position").all().map((row: Record<string, unknown>) => ({
    globalPosition: row.global_position as bigint, eventId: field(row, "event_id"), projectId: field(row, "project_id") as StoredEvent["projectId"],
    vaultId: field(row, "vault_id") as StoredEvent["vaultId"], storeId: field(row, "store_id") as StoredEvent["storeId"], workspaceId: field(row, "workspace_id") as StoredEvent["workspaceId"],
    branchScopeId: row.branch_scope_id as StoredEvent["branchScopeId"], branchRef: row.branch_ref as string | null, streamId: field(row, "stream_id"), streamType: field(row, "stream_type"),
    streamVersion: row.stream_version as bigint, eventType: field(row, "event_type"), eventSchemaVersion: Number(row.event_schema_version), sessionId: row.session_id as string | null,
    parentSessionId: row.parent_session_id as string | null, actorRole: field(row, "actor_role") as StoredEvent["actorRole"], agentId: field(row, "agent_id"),
    clientInstanceId: field(row, "client_instance_id"), correlationId: field(row, "correlation_id"), causationId: row.causation_id as string | null,
    commandId: field(row, "command_id"), idempotencyKey: field(row, "idempotency_key"), commandEventIndex: Number(row.command_event_index),
    occurredAt: field(row, "occurred_at"), recordedAt: field(row, "recorded_at"), visibilityScope: field(row, "visibility_scope") as StoredEvent["visibilityScope"],
    confidence: field(row, "confidence") as StoredEvent["confidence"], verificationStatus: field(row, "verification_status") as StoredEvent["verificationStatus"],
    sourceRefs: JSON.parse(field(row, "source_refs_json")), evidenceRefs: JSON.parse(field(row, "evidence_refs_json")), evidenceDigests: JSON.parse(field(row, "evidence_digests_json")),
    payload: JSON.parse(field(row, "payload_json")), payloadJson: field(row, "payload_json"), payloadHash: field(row, "payload_hash"),
    previousGlobalHash: field(row, "previous_global_hash"), eventHash: field(row, "event_hash"), lifecycleIntentJson: row.lifecycle_intent_json as string | null }));
}
test("uses manifest creation time plus batch ordinal for every package shape and replay", async t => {
  // Reintroducing source-event time or an epoch fallback makes at least one package shape store the wrong deterministic clock.
  for (const shape of ["source-only", "artifact-only", "mixed", "multi-batch"] as const) await t.test(shape, async child => {
    const f = await fixture(child);
    try {
      const allRecords = [...f.sealedPackage.records()];
      const package_ = shape === "source-only" ? packageFromRecords(f.sealedPackage, [allRecords[0]!])
        : shape === "artifact-only" ? artifactPackage(f.sealedPackage, Buffer.from("clock"))
        : shape === "multi-batch" ? repeatedSourcePackage(f.sealedPackage, 3)
        : f.sealedPackage;
      const importer = shape === "multi-batch"
        ? importerWithPolicy(f, { ...f.policy, maxBatchEvents: 2 } as ShadowMigrationPolicyV1)
        : f.importer;
      const first = importer.import({ context: f.context, sealedPackage: package_ });
      const expected = shape === "multi-batch"
        ? ["2026-09-10T00:00:10.000Z", "2026-09-10T00:00:10.000Z", "2026-09-10T00:00:10.001Z"]
        : Array(first.recordCount).fill("2026-09-10T00:00:10.000Z");
      assert.deepEqual(storedEvents(f.connection).map(event => event.occurredAt), expected);
      assert.deepEqual(storedEvents(f.connection).map(event => event.recordedAt), expected);
      assert.deepEqual(importer.import({ context: f.context, sealedPackage: package_ }), { ...first, deduplicated: true });
      assert.deepEqual(storedEvents(f.connection).map(event => [event.occurredAt, event.recordedAt]), expected.map(value => [value, value]));
    } finally { f.close(); }
  });
});
test("commits exact wrapper payloads and metadata and replays as a no-op", async t => {
  const f = await fixture(t);
  try {
    const first = f.importer.import({ context: f.context, sealedPackage: f.sealedPackage });
    assert.deepEqual(f.importer.import({ context: f.context, sealedPackage: f.sealedPackage }), { ...first, deduplicated: true });
    const events = storedEvents(f.connection); assert.deepEqual(events.map(event => event.eventId), first.eventIds);
    for (const [ordinal, event] of events.entries()) {
      const descriptor = f.sealedPackage.manifest.recordDescriptors[ordinal]!; const payload = event.payload as Record<string, unknown>;
      assert.equal(event.streamId, `v2-shadow-import/${f.sealedPackage.migrationIdentity}`); assert.equal(event.streamType, "migration");
      assert.equal(event.visibilityScope, "project"); assert.equal(event.confidence, "high"); assert.equal(event.verificationStatus, "verified");
      assert.deepEqual(event.sourceRefs, [`migration:${f.sealedPackage.migrationIdentity}:${ordinal}`]); assert.deepEqual(event.evidenceRefs, []); assert.deepEqual(event.evidenceDigests, []);
      assert.equal(payload.schemaVersion, 1); assert.equal(payload.migrationIdentity, f.sealedPackage.migrationIdentity); assert.equal(payload.sourceOrdinal, ordinal); assert.equal(payload.sourceRecordHash, descriptor.contentSha256);
      if (descriptor.kind === "source-event") { assert.equal(event.eventType, "V1ProjectionSourceImported");
        assert.deepEqual(Object.keys(payload).sort(), ["migrationIdentity","schemaVersion","sourceEvent","sourceOrdinal","sourceRecordHash"].sort());
        assert.equal(Object.hasOwn(payload.sourceEvent as object, "payload"), false); assert.equal(Object.hasOwn(payload.sourceEvent as object, "payloadJson"), true);
      } else { assert.equal(event.eventType, "V1LegacyArtifactImported");
        assert.deepEqual(Object.keys(payload).sort(), ["contentSha256","contentUtf8","migrationIdentity","relativePath","schemaVersion","sourceOrdinal","sourceRecordHash"].sort()); }
    }
  } finally { f.close(); }
});
test("produces identical authenticated event chains and results in three isolated stores", async t => {
  const first = await fixture(t); const second = siblingTarget(first, "determinism-b"); const third = siblingTarget(first, "determinism-c");
  try {
    const targets = [first, second, third]; const results = targets.map(target => target.importer.import({ context: target.context, sealedPackage: first.sealedPackage }));
    assert.deepEqual(results[1], results[0]); assert.deepEqual(results[2], results[0]);
    const chains = targets.map(target => storedEvents(target.connection));
    const signature = (events: readonly StoredEvent[]) => events.map(event => ({ position: event.globalPosition, eventId: event.eventId,
      payloadHash: event.payloadHash, previousGlobalHash: event.previousGlobalHash, eventHash: event.eventHash }));
    assert.deepEqual(signature(chains[1]!), signature(chains[0]!)); assert.deepEqual(signature(chains[2]!), signature(chains[0]!));
    for (const events of chains) { let cursor = { expectedPosition: 1n, previousEventHash: GENESIS_GLOBAL_HASH };
      for (const event of events) cursor = authenticateStoredEvent(event, cursor).nextCursor; }
  } finally { third.close(); second.close(); first.close(); }
});
test("reconciles commit-before-receipt unknown outcome with the original command and no duplicate", async t => { let failed=false; const faults: EventStoreFaultInjector={hit(boundary){if(!failed&&boundary==="after-commit-before-response"){failed=true;throw Error("lost")}}}; const f=await fixture(t,faults); try { assert.throws(()=>f.importer.import({context:f.context,sealedPackage:f.sealedPackage}),unknown); const recovered=f.importer.import({context:f.context,sealedPackage:f.sealedPackage}); assert.equal(Number(f.connection.prepare("SELECT count(*) AS count FROM events").get()?.count),recovered.recordCount); assert.equal(new Set(recovered.eventIds).size,recovered.eventIds.length); } finally { f.close(); } });
test("fails the same migration/package identity with changed bytes before writing", async t => { const f=await fixture(t); try {
  appendFileSync(join(f.sealedPackage.rootPath, "events.ndjson"), " ");
  assert.throws(()=>f.importer.import({context:f.context,sealedPackage:f.sealedPackage}),e=>e instanceof ShadowMigrationError&&e.code==="MIGRATION_IDENTITY_CONFLICT");
  assert.equal(Number(f.connection.prepare("SELECT count(*) AS count FROM events").get()?.count),0); } finally { f.close(); } });

test("uses the policy event-count boundary exactly and starts a new batch at plus one", async t => {
  const exact = await fixture(t); const over = await fixture(t);
  try {
    const exactPackage = repeatedSourcePackage(exact.sealedPackage, 2); const overPackage = repeatedSourcePackage(over.sealedPackage, 3);
    const exactImporter = importerWithPolicy(exact, { ...exact.policy, maxBatchEvents: 2 } as ShadowMigrationPolicyV1);
    const overImporter = importerWithPolicy(over, { ...over.policy, maxBatchEvents: 2 } as ShadowMigrationPolicyV1);
    exactImporter.import({ context: exact.context, sealedPackage: exactPackage }); overImporter.import({ context: over.context, sealedPackage: overPackage });
    assert.deepEqual(commandGroupSizes(exact), [2]); assert.deepEqual(commandGroupSizes(over), [2, 1]);
  } finally { over.close(); exact.close(); }
});

test("streams one bounded batch before consuming the next package record", async t => { const f=await fixture(t); try {
  const package_=streamingPackage(f.sealedPackage,f.connection); const importer=importerWithPolicy(f,{...f.policy,maxBatchEvents:1} as ShadowMigrationPolicyV1);
  assert.equal(importer.import({context:f.context,sealedPackage:package_}).recordCount,2); assert.deepEqual(commandGroupSizes(f),[1,1]);
} finally { f.close(); } });

test("uses the EventStore event-count boundary exactly and starts a new batch at plus one", async t => {
  const exact = await fixture(t); const over = await fixture(t);
  try {
    const exactPackage = repeatedSourcePackage(exact.sealedPackage, 128); const overPackage = repeatedSourcePackage(over.sealedPackage, 129);
    exact.importer.import({ context: exact.context, sealedPackage: exactPackage }); over.importer.import({ context: over.context, sealedPackage: overPackage });
    assert.deepEqual(commandGroupSizes(exact), [128]); assert.deepEqual(commandGroupSizes(over), [128, 1]);
  } finally { over.close(); exact.close(); }
});

test("uses full canonical-command bytes for the policy exact and plus-one boundary", async t => {
  const probe = await fixture(t); const exact = await fixture(t); const over = await fixture(t);
  try {
    const probePackage = artifactPackage(probe.sealedPackage, Buffer.from("x"));
    importerWithPolicy(probe, { ...probe.policy, maxBatchBytes: MAX_CANONICAL_COMMAND_BYTES } as ShadowMigrationPolicyV1)
      .import({ context: probe.context, sealedPackage: probePackage });
    const exactBytes = canonicalCommandBytes(probe);
    const exactPackage = artifactPackage(exact.sealedPackage, Buffer.from("x"));
    const overPackage = artifactPackage(over.sealedPackage, Buffer.from("x"));
    assert.equal(importerWithPolicy(exact, { ...exact.policy, maxBatchBytes: exactBytes } as ShadowMigrationPolicyV1)
      .import({ context: exact.context, sealedPackage: exactPackage }).recordCount, 1);
    assert.throws(() => importerWithPolicy(over, { ...over.policy, maxBatchBytes: exactBytes - 1 } as ShadowMigrationPolicyV1)
      .import({ context: over.context, sealedPackage: overPackage }), limitExceeded);
    assert.equal(Number(over.connection.prepare("SELECT count(*) AS count FROM events").get()?.count), 0);
  } finally { over.close(); exact.close(); probe.close(); }
});

test("applies maxEventBytes to authenticated source-record bytes at exact and plus-one boundaries", async t => {
  const exact=await fixture(t); const over=await fixture(t); const bytes=Buffer.from("x".repeat(64));
  try { const exactPackage=artifactPackage(exact.sealedPackage,bytes); const overPackage=artifactPackage(over.sealedPackage,bytes);
    assert.equal(importerWithPolicy(exact,{...exact.policy,maxEventBytes:64} as ShadowMigrationPolicyV1).import({context:exact.context,sealedPackage:exactPackage}).recordCount,1);
    assert.throws(()=>importerWithPolicy(over,{...over.policy,maxEventBytes:63} as ShadowMigrationPolicyV1).import({context:over.context,sealedPackage:overPackage}),limitExceeded);
    assert.equal(Number(over.connection.prepare("SELECT count(*) AS count FROM events").get()?.count),0);
  } finally { over.close(); exact.close(); }
});

test("uses the EventStore canonical-byte boundary exactly and classifies plus one as a migration limit", async t => {
  const probe = await fixture(t); const exact = await fixture(t); const over = await fixture(t);
  try {
    const probePackage = artifactPackage(probe.sealedPackage, Buffer.from("x")); probe.importer.import({ context: probe.context, sealedPackage: probePackage });
    const fixedBytes = canonicalCommandBytes(probe) - 1; const exactContentBytes = MAX_CANONICAL_COMMAND_BYTES - fixedBytes;
    const exactPackage = artifactPackage(exact.sealedPackage, Buffer.alloc(exactContentBytes, 0x78));
    const overPackage = artifactPackage(over.sealedPackage, Buffer.alloc(exactContentBytes + 1, 0x78));
    const wide = { ...exact.policy, maxEventBytes: MAX_CANONICAL_COMMAND_BYTES + 1,
      maxBatchBytes: MAX_CANONICAL_COMMAND_BYTES + 1, maxAggregateBytes: MAX_CANONICAL_COMMAND_BYTES * 2 } as ShadowMigrationPolicyV1;
    assert.equal(importerWithPolicy(exact, wide).import({ context: exact.context, sealedPackage: exactPackage }).recordCount, 1);
    assert.equal(canonicalCommandBytes(exact), MAX_CANONICAL_COMMAND_BYTES);
    assert.throws(() => importerWithPolicy(over, wide).import({ context: over.context, sealedPackage: overPackage }), limitExceeded);
    assert.equal(Number(over.connection.prepare("SELECT count(*) AS count FROM events").get()?.count), 0);
  } finally { over.close(); exact.close(); probe.close(); }
});

test("rejects fatal-invalid artifact UTF-8 and byte/hash mismatches before writes", async t => {
  const utf8 = await fixture(t); const length = await fixture(t); const hash = await fixture(t);
  try {
    const cases = [[utf8, artifactPackage(utf8.sealedPackage, Uint8Array.from([0xc3, 0x28]))],
      [length, artifactPackage(length.sealedPackage, Buffer.from("valid"), { byteLength: 6 })],
      [hash, artifactPackage(hash.sealedPackage, Buffer.from("valid"), { contentSha256: "f".repeat(64) })]] as const;
    for (const [target, package_] of cases) { assert.throws(() => target.importer.import({ context: target.context, sealedPackage: package_ }),
      error => error instanceof ShadowMigrationError && error.code === "MIGRATION_SOURCE_INVALID");
      assert.equal(Number(target.connection.prepare("SELECT count(*) AS count FROM events").get()?.count), 0); }
  } finally { hash.close(); length.close(); utf8.close(); }
});

test("rejects a tampered committed response while reconciling unknown outcome", async t => {
  let failed=false; const faults: EventStoreFaultInjector={hit(boundary){if(!failed&&boundary==="after-commit-before-response"){failed=true;throw Error("lost")}}};
  const f = await fixture(t, faults);
  try {
    assert.throws(() => f.importer.import({ context: f.context, sealedPackage: f.sealedPackage }), unknown);
    const real = new SqliteEventStoreStatements(f.connection);
    const statements = new Proxy(real, { get(target, property) { if (property === "findDedup") return (projectId: string, idempotencyKey: string) => {
      const found = target.findDedup(projectId, idempotencyKey); if (!found) return found; const stored = JSON.parse(found.responseJson) as Record<string, unknown>;
      stored.response = { schemaVersion: 1, tampered: true }; return { ...found, responseJson: canonicalJson(stored) }; };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value; } }) as EventAppendStatements;
    const importer = new V2ShadowImporter({ connection: f.connection, statements, maintenance: new MaintenanceFence(),
      branchScopes: new BranchScopeRepository(), repository: f.repository, policy: f.policy, faultInjector: faults });
    assert.throws(() => importer.import({ context: f.context, sealedPackage: f.sealedPackage }),
      error => error instanceof ShadowMigrationError && error.code === "MIGRATION_IDENTITY_CONFLICT");
    assert.equal(Number(f.connection.prepare("SELECT count(*) AS count FROM events").get()?.count), f.sealedPackage.manifest.recordDescriptors.length);
  } finally { f.close(); }
});

test("accepts exact imported receipts on replay and rejects a conflicting receipt before writes", async t => {
  const exact = await fixture(t); const conflict = await fixture(t);
  try {
    const first = exact.importer.import({ context: exact.context, sealedPackage: exact.sealedPackage });
    assert.deepEqual(exact.importer.import({ context: exact.context, sealedPackage: exact.sealedPackage }), { ...first, deduplicated: true });
    const descriptor = conflict.sealedPackage.manifest.recordDescriptors[0]!;
    conflict.repository.transact(conflict.context.binding.projectId, conflict.sealedPackage.migrationIdentity, tx => tx.insertImportedRecords([{
      projectId: conflict.context.binding.projectId, migrationIdentity: conflict.sealedPackage.migrationIdentity, sourceOrdinal: 0,
      sourceKind: descriptor.kind, sourceRecordHash: descriptor.contentSha256, importedEventId: randomUUID(), importedGlobalPosition: 1n,
      importedEventHash: "f".repeat(64), recordedAt: NOW }]));
    assert.throws(() => conflict.importer.import({ context: conflict.context, sealedPackage: conflict.sealedPackage }),
      error => error instanceof ShadowMigrationError && error.code === "MIGRATION_IDENTITY_CONFLICT");
    assert.equal(Number(conflict.connection.prepare("SELECT count(*) AS count FROM events").get()?.count), 0);
  } finally { conflict.close(); exact.close(); }
});

test("rejects independently mismatched receipt position, hash, time, and missing durable event", async t => {
  for (const variant of ["position","hash","time","missing"] as const) await t.test(variant, async child => {
    let failed=false; const faults: EventStoreFaultInjector={hit(boundary){if(!failed&&boundary==="after-commit-before-response"){failed=true;throw Error("lost")}}};
    const f=await fixture(child,variant==="missing"?undefined:faults); const package_=artifactPackage(f.sealedPackage,Buffer.from("receipt"));
    try {
      if(variant!=="missing") assert.throws(()=>f.importer.import({context:f.context,sealedPackage:package_}),unknown);
      const event=f.connection.prepare("SELECT global_position,event_hash,recorded_at FROM events LIMIT 1").get(); const descriptor=package_.manifest.recordDescriptors[0]!;
      f.repository.transact(f.context.binding.projectId,package_.migrationIdentity,tx=>tx.insertImportedRecords([{projectId:f.context.binding.projectId,
        migrationIdentity:package_.migrationIdentity,sourceOrdinal:0,sourceKind:descriptor.kind,sourceRecordHash:descriptor.contentSha256,
        importedEventId:deterministicMigrationUuid("event",package_.migrationIdentity,0),
        importedGlobalPosition:variant==="position"?2n:(event?.global_position as bigint|undefined)??1n,
        importedEventHash:variant==="hash"?"f".repeat(64):(event?.event_hash as string|undefined)??"f".repeat(64),
        recordedAt:variant==="time"?"2026-09-10T00:00:01.000Z":(event?.recorded_at as string|undefined)??NOW}]));
      assert.throws(()=>f.importer.import({context:f.context,sealedPackage:package_}),error=>error instanceof ShadowMigrationError&&error.code==="MIGRATION_IDENTITY_CONFLICT");
    } finally { f.close(); }
  });
});

test("returns immutable result arrays", async t => { const f=await fixture(t); try {
  const result=f.importer.import({context:f.context,sealedPackage:f.sealedPackage}); assert.equal(Object.isFrozen(result),true);
  assert.equal(Object.isFrozen(result.eventIds),true); assert.throws(()=>(result.eventIds as string[]).push(randomUUID()),TypeError);
} finally { f.close(); } });
