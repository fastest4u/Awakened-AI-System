import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { ProjectContext } from "../src/orchestrator/identity/contracts.js";
import type { JsonValue, PendingEvent, StoredEvent } from "../src/orchestrator/contracts/event.js";
import { verifyV1SourceCopy } from "../src/orchestrator/migration/v1-source-copy.js";
import { sealV2MigrationPackage } from "../src/orchestrator/migration/v2-migration-package.js";
import { V2ImportedProjectionEventReader } from "../src/orchestrator/migration/v2-imported-event-reader.js";
import { V2ShadowImporter } from "../src/orchestrator/migration/v2-shadow-importer.js";
import { deterministicMigrationUuid, ShadowMigrationError, shadowMigrationPolicyChecksum } from "../src/orchestrator/migration/v2-shadow-migration.contracts.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { BranchScopeRepository } from "../src/orchestrator/storage/branch-scope.repository.js";
import { EventStore, SqliteEventStoreStatements } from "../src/orchestrator/storage/event-store.js";
import type { SqliteDriver } from "../src/orchestrator/storage/sqlite-driver.js";
import { MaintenanceFence } from "../src/orchestrator/storage/maintenance-fence.js";
import { v2ShadowMigration } from "../src/orchestrator/storage/migrations/0007-v2-shadow-migration.js";
import { SqliteV2ShadowMigrationRepository } from "../src/orchestrator/storage/v2-shadow-migration.repository.js";
import { applyCurrentProjectStoreSchema } from "./support/current-project-store-schema.js";
import { createV2ShadowMigrationFixture, sealManifest } from "./support/v2-shadow-migration-fixture.js";

const NOW = "2026-09-10T00:00:00.000Z";
const integrity = (error: unknown): boolean => error instanceof ShadowMigrationError
  && error.code === "MIGRATION_LEDGER_INTEGRITY_FAILURE"
  && error.message === "MIGRATION_LEDGER_INTEGRITY_FAILURE";

async function importedPackageFixture(t: test.TestContext, importRecords = true,
  shape: { sourceEventCount?: 0 | 2; legacyArtifacts?: boolean; corruptSource?: (event: StoredEvent) => StoredEvent } = {}) {
  let cleanup: (() => void) | undefined;
  // node:test after hooks run in registration order; close handles before root cleanup on Windows.
  t.after(() => cleanup?.());
  const f = await createV2ShadowMigrationFixture(t, shape);
  const source = await verifyV1SourceCopy(f.verificationInput);
  const packageSource = shape.corruptSource === undefined ? source : { ...source,
    *events() { for (const event of source.events()) yield shape.corruptSource!(event); } };
  const sealedPackage = await sealV2MigrationPackage({ ...f.packageInput, source: packageSource, packageRoot: f.packageRootA });
  const eventStorePath = `${f.root}/target.sqlite`;
  const connection = f.driver.open(eventStorePath, { mode: "create", busyTimeoutMs: 5000 });
  applyCurrentProjectStoreSchema(connection, f.projectionBinding, NOW);
  connection.exec(v2ShadowMigration.sql);
  const workspace = { kind: "non-git" as const, workspaceRoot: f.root, workspaceId: f.projectionBinding.workspaceId };
  const context = { workspace, checkedAt: NOW, binding: { ...f.projectionBinding, projectBindingId: randomUUID(),
    generation: 1, contextFingerprint: "shadow", source: "explicit-cli", clientNamespace: "shadow-test",
    clientInstanceId: randomUUID(), actorRole: "primary", projectRoot: f.root, vaultRoot: f.liveVaultRoot,
    descriptorPath: `${f.liveVaultRoot}/.project-memory.json`, workspace, establishedAt: NOW,
    storeRoute: { kind: "vault-local", storeRoot: f.root, eventsPath: eventStorePath,
      storeManifestPath: `${f.root}/store.json`, projectionManifestPath: `${f.root}/projection.json` } } } as ProjectContext;
  const revisionId = randomUUID();
  connection.prepare("INSERT INTO rollout_revisions(project_id,revision_id,parent_revision_id,build_identity_hash,migration_identity_hash,configuration_checksum,v1_baseline_checksum,cohort_algorithm_version,cohort_salt,cohort_basis_points,created_at) VALUES ($p,$r,NULL,$h,$h,$h,$h,1,$h,0,$n)")
    .run({ $p: context.binding.projectId, $r: revisionId, $h: "a".repeat(64), $n: NOW });
  const repository = new SqliteV2ShadowMigrationRepository(connection);
  repository.transact(context.binding.projectId, sealedPackage.migrationIdentity, tx => tx.insertRun({
    projectId: context.binding.projectId, migrationIdentity: sealedPackage.migrationIdentity, rolloutRevisionId: revisionId,
    packageChecksum: sealedPackage.manifest.packageChecksum, sourceManifestChecksum: sealedPackage.manifest.sourceManifestChecksum,
    sourceTerminalPosition: BigInt(sealedPackage.manifest.terminalEventPosition), sourceTerminalHash: sealedPackage.manifest.terminalEventHash,
    configurationChecksum: sealedPackage.manifest.configurationChecksum, policyChecksum: shadowMigrationPolicyChecksum(f.policy),
    buildIdentityHash: sealedPackage.manifest.buildIdentityHash, createdAt: NOW }));
  const importer = new V2ShadowImporter({ connection, statements: new SqliteEventStoreStatements(connection),
    maintenance: new MaintenanceFence(), branchScopes: new BranchScopeRepository(), repository, policy: f.policy });
  if (importRecords) importer.import({ context, sealedPackage });
  cleanup = () => { connection.close(); sealedPackage.close(); source.close(); };
  const options = { driver: f.driver, eventStorePath, sealedPackage, sourceManifest: source.manifest };
  return { ...f, connection, context, sealedPackage, source, options, importer,
    reader: new V2ImportedProjectionEventReader(options) };
}

test("reconstructs source events only when wrapper and ledger receipts agree", async t => {
  const f = await importedPackageFixture(t);
  const snapshot = await f.reader.openCommittedSnapshot(f.projectionBinding);
  try {
    assert.deepEqual([...snapshot.events()], f.sourceEvents);
    assert.deepEqual(snapshot.binding, f.projectionBinding);
    assert.equal(snapshot.eventCount, f.sourceEvents.length);
    assert.equal(snapshot.aggregateBytes, f.source.projectionSnapshot.aggregateBytes);
    assert.equal(snapshot.terminalEventPosition, BigInt(f.sealedPackage.manifest.terminalEventPosition));
    assert.equal(snapshot.terminalEventHash, f.sealedPackage.manifest.terminalEventHash);
  } finally { snapshot.close(); }
});

test("rejects package bytes that were never committed as wrapper events", async t => {
  const f = await importedPackageFixture(t, false);
  await assert.rejects(f.reader.openCommittedSnapshot(f.projectionBinding), integrity);
});

test("rejects missing source and artifact receipts", async t => {
  for (const ordinal of [0, 1, 2, 3]) await t.test(`ordinal ${ordinal}`, async child => {
    const f = await importedPackageFixture(child);
    f.connection.exec("DROP TRIGGER v2_shadow_imported_records_no_delete");
    f.connection.prepare("DELETE FROM v2_shadow_imported_records WHERE source_ordinal=$o").run({ $o: ordinal });
    await assert.rejects(f.reader.openCommittedSnapshot(f.projectionBinding), integrity);
  });
});

test("snapshot is frozen, repeatable, and rejects lazy iteration after idempotent close", async t => {
  const f = await importedPackageFixture(t);
  const snapshot = await f.reader.openSnapshot(f.projectionBinding);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.binding));
  const first = [...snapshot.events()];
  assert.ok(Object.isFrozen(first[0]));
  assert.ok(Object.isFrozen(first[0]!.payload));
  assert.ok(Object.isFrozen(first[0]!.sourceRefs));
  assert.throws(() => { (first[0]!.payload as Record<string, unknown>).injected = true; }, TypeError);
  assert.deepEqual([...snapshot.events()], first);
  const lazy = snapshot.events()[Symbol.iterator]();
  snapshot.close();
  snapshot.close();
  assert.throws(() => lazy.next(), integrity);
  assert.throws(() => snapshot.events(), integrity);
});

type Fixture = Awaited<ReturnType<typeof importedPackageFixture>>;
function appendUnrelated(f: Fixture, workspaceId = f.projectionBinding.workspaceId): void {
  const workspace = { ...f.context.workspace, workspaceId } as ProjectContext["workspace"];
  const context = { ...f.context, workspace, binding: { ...f.context.binding, workspaceId, workspace } };
  new EventStore(f.connection, new SqliteEventStoreStatements(f.connection), new MaintenanceFence(), new BranchScopeRepository(), () => NOW)
    .append({ context, commandId: randomUUID(), idempotencyKey: randomUUID(), commandType: "Unrelated",
      correlationId: randomUUID(), agentId: "test", expectedStreamVersion: 0n, streamId: randomUUID(), streamType: "memory",
      events: [{ eventType: "UnrelatedEvent", eventSchemaVersion: 1, occurredAt: NOW, visibilityScope: "project",
        confidence: "high", verificationStatus: "verified", payload: { note: "unrelated" }, sourceRefs: [], evidenceRefs: [], evidenceDigests: [] }],
      outbox: [], publicResponse: { ok: true } });
}

/** Malformed imports still get authentic outer chains and real durable receipts. */
function commitWrappers(f: Fixture, mutate: (event: PendingEvent, ordinal: number) => void): void {
  const records = [...f.sealedPackage.records()];
  const identity = f.sealedPackage.migrationIdentity;
  const events: PendingEvent[] = records.map(record => {
    const d = record.descriptor;
    const bytes = Buffer.concat([...record.readChunks()].map(chunk => Buffer.from(chunk)));
    const base = { schemaVersion: 1, migrationIdentity: identity, sourceOrdinal: d.ordinal, sourceRecordHash: d.contentSha256 };
    let payload: JsonValue;
    if (d.kind === "source-event") {
      const { payload: _cache, ...sourceEvent } = JSON.parse(bytes.toString("utf8")) as Record<string, JsonValue>;
      payload = { ...base, sourceEvent };
    } else payload = { ...base, relativePath: d.relativePath, contentSha256: d.contentSha256, contentUtf8: bytes.toString("utf8") };
    const event: PendingEvent = { eventType: d.kind === "source-event" ? "V1ProjectionSourceImported" : "V1LegacyArtifactImported",
      eventSchemaVersion: 1, occurredAt: NOW, visibilityScope: "project", confidence: "high", verificationStatus: "verified",
      payload, sourceRefs: [`migration:${identity}:${d.ordinal}`], evidenceRefs: [], evidenceDigests: [] };
    mutate(event, d.ordinal);
    return event;
  });
  let ordinal = 0;
  const store = new EventStore(f.connection, new SqliteEventStoreStatements(f.connection), new MaintenanceFence(), new BranchScopeRepository(),
    () => NOW, () => deterministicMigrationUuid("event", identity, ordinal++));
  store.append({ context: f.context, commandId: randomUUID(), idempotencyKey: randomUUID(), commandType: "ImportV2ShadowBatch",
    correlationId: randomUUID(), agentId: "test", expectedStreamVersion: 0n, streamId: `v2-shadow-import/${identity}`,
    streamType: "migration", events, outbox: [], publicResponse: { ok: true } });
  const repository = new SqliteV2ShadowMigrationRepository(f.connection);
  repository.transact(f.projectionBinding.projectId, identity, tx => tx.insertImportedRecords(
    f.connection.prepare("SELECT event_id,global_position,event_hash,recorded_at FROM events WHERE stream_id=$s ORDER BY global_position")
      .all({ $s: `v2-shadow-import/${identity}` }).map((row, index) => ({ projectId: f.projectionBinding.projectId,
        migrationIdentity: identity, sourceOrdinal: index, sourceKind: records[index]!.descriptor.kind,
        sourceRecordHash: records[index]!.descriptor.contentSha256, importedEventId: row.event_id as string,
        importedGlobalPosition: row.global_position as bigint, importedEventHash: row.event_hash as string, recordedAt: row.recorded_at as string }))));
}

test("rejects receipt identity, position, hash, kind, ordinal, and timestamp disagreement", async t => {
  const mutations = [
    "imported_event_id='99999999-9999-4999-8999-999999999999'", "imported_global_position=99",
    `imported_event_hash='${"0".repeat(64)}'`, `source_record_hash='${"0".repeat(64)}'`,
    "source_kind='legacy-artifact'", "source_ordinal=9", "recorded_at='2026-09-11T00:00:00.000Z'",
  ];
  for (const mutation of mutations) await t.test(mutation.split("=")[0]!, async child => {
    const f = await importedPackageFixture(child);
    f.connection.exec("DROP TRIGGER v2_shadow_imported_records_no_update");
    f.connection.exec(`UPDATE v2_shadow_imported_records SET ${mutation} WHERE source_ordinal=0`);
    await assert.rejects(f.reader.openCommittedSnapshot(f.projectionBinding), integrity);
  });
});

test("rejects duplicate ledger ordinals even when a damaged schema allows them", async t => {
  const f = await importedPackageFixture(t);
  f.connection.exec("PRAGMA foreign_keys=OFF; CREATE TABLE corrupt_receipts AS SELECT * FROM v2_shadow_imported_records; DROP TABLE v2_shadow_imported_records; ALTER TABLE corrupt_receipts RENAME TO v2_shadow_imported_records; INSERT INTO v2_shadow_imported_records SELECT * FROM v2_shadow_imported_records WHERE source_ordinal=0");
  await assert.rejects(f.reader.openCommittedSnapshot(f.projectionBinding), integrity);
});

test("rejects tampered stored wrapper payload bytes", async t => {
  const f = await importedPackageFixture(t);
  f.connection.exec("DROP TRIGGER events_no_update; UPDATE events SET payload_json='{}' WHERE global_position=1");
  await assert.rejects(f.reader.openCommittedSnapshot(f.projectionBinding), integrity);
});

test("rejects authentic malformed wrappers and source envelopes", async t => {
  const mutations: Record<string, (event: PendingEvent, ordinal: number) => void> = {
    "duplicate ordinal": (event, ordinal) => { if (ordinal === 1) (event.payload as Record<string, JsonValue>).sourceOrdinal = 0; },
    "reordered ordinal": (event, ordinal) => { if (ordinal < 2) (event.payload as Record<string, JsonValue>).sourceOrdinal = 1 - ordinal; },
    "wrong migration identity": event => { (event.payload as Record<string, JsonValue>).migrationIdentity = "f".repeat(64); },
    "unknown wrapper": event => { event.eventType = "UnexpectedImport"; },
    "artifact presented as source": (event, ordinal) => { if (ordinal === 2) event.eventType = "V1ProjectionSourceImported"; },
    "extra wrapper field": event => { (event.payload as Record<string, JsonValue>).extra = true; },
    "artifact content": (event, ordinal) => { if (ordinal === 2) (event.payload as Record<string, JsonValue>).contentUtf8 = "tampered"; },
    "source hash": (event, ordinal) => { if (ordinal === 0) (event.payload as Record<string, JsonValue>).sourceRecordHash = "f".repeat(64); },
  };
  const sourceMutations: Record<string, (source: Record<string, JsonValue>) => void> = {
    "nested source import": source => { source.eventType = "V1ProjectionSourceImported"; },
    "nested artifact import": source => { source.eventType = "V1LegacyArtifactImported"; },
    "wrong source binding": source => { source.workspaceId = "f".repeat(64); },
    "broken source chain": source => { source.previousGlobalHash = "f".repeat(64); },
    "source extra field": source => { source.unexpected = true; },
    "source missing field": source => { delete source.commandId; },
    "noncanonical payload": source => { source.payloadJson = ` ${String(source.payloadJson)}`; },
    "payload hash": source => { source.payloadHash = "f".repeat(64); },
    "UUID": source => { source.eventId = "not-a-uuid"; },
    "timestamp": source => { source.occurredAt = "2026-02-30T00:00:00.000Z"; },
    "int64 overflow": source => { source.globalPosition = "9223372036854775808"; },
    "noncanonical int64": source => { source.streamVersion = "01"; },
    "event schema": source => { source.eventSchemaVersion = 0; },
  };
  for (const [name, mutate] of Object.entries(sourceMutations)) mutations[name] = (event, ordinal) => {
    if (ordinal === 0) mutate((event.payload as Record<string, JsonValue>).sourceEvent as Record<string, JsonValue>);
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async child => {
    const f = await importedPackageFixture(child, false);
    commitWrappers(f, mutate);
    await assert.rejects(f.reader.openCommittedSnapshot(f.projectionBinding), integrity);
  });
});

test("authenticates unrelated target streams and workspaces through the last receipt", async t => {
  const f = await importedPackageFixture(t, false);
  appendUnrelated(f, "b".repeat(64) as typeof f.projectionBinding.workspaceId);
  f.importer.import({ context: f.context, sealedPackage: f.sealedPackage });
  const snapshot = await f.reader.openCommittedSnapshot(f.projectionBinding);
  assert.deepEqual([...snapshot.events()], f.sourceEvents);
  snapshot.close();
  f.connection.exec("DROP TRIGGER events_no_update; UPDATE events SET payload_json='{}' WHERE global_position=1");
  await assert.rejects(f.reader.openCommittedSnapshot(f.projectionBinding), integrity);
});

test("rejects wrong requested binding and package-unbound source branch manifest", async t => {
  const f = await importedPackageFixture(t);
  for (const changed of [{ workspaceId: "f".repeat(64) }, { projectId: randomUUID() },
    { branchScopeId: randomUUID(), branchRef: "refs/heads/foreign" }, { sessionId: randomUUID() }]) {
    await assert.rejects(f.reader.openCommittedSnapshot({ ...f.projectionBinding, ...changed } as typeof f.projectionBinding), integrity);
  }
  const reader = new V2ImportedProjectionEventReader({ ...f.options, sourceManifest: sealManifest({
    ...f.source.manifest, branchScopeId: randomUUID(), branchRef: "refs/heads/foreign" }) });
  await assert.rejects(reader.openCommittedSnapshot(f.projectionBinding), integrity);
});

test("reads no package records and pins source rows against later target writes", async t => {
  const f = await importedPackageFixture(t);
  const reader = new V2ImportedProjectionEventReader({ ...f.options, sealedPackage: { ...f.sealedPackage,
    records() { throw new Error("UNCOMMITTED_PACKAGE_INPUT"); } } });
  const snapshot = await reader.openCommittedSnapshot(f.projectionBinding);
  appendUnrelated(f);
  assert.deepEqual([...snapshot.events()], f.sourceEvents);
  snapshot.close();
});

test("closes its SQLite snapshot exactly once before and during lazy iteration", async t => {
  for (const started of [false, true]) await t.test(`started=${started}`, async child => {
    const f = await importedPackageFixture(child);
    let opens = 0; let closes = 0;
    const driver: SqliteDriver = { open(path, options) {
      opens++;
      const connection = f.driver.open(path, options);
      return { exec: sql => connection.exec(sql), prepare: sql => connection.prepare(sql), close() { closes++; connection.close(); } };
    } };
    const snapshot = await new V2ImportedProjectionEventReader({ ...f.options, driver }).openCommittedSnapshot(f.projectionBinding);
    const iterator = snapshot.events()[Symbol.iterator]();
    if (started) assert.equal(iterator.next().done, false);
    snapshot.close(); snapshot.close();
    assert.throws(() => iterator.next(), integrity);
    assert.equal(opens, 1); assert.equal(closes, 1);
  });
});

test("rejects broken original chains even when descriptors and committed wrappers authenticate", async t => {
  const f = await importedPackageFixture(t, true, { corruptSource: event => event.globalPosition === 1n
    ? { ...event, previousGlobalHash: "f".repeat(64) } : event });
  await assert.rejects(f.reader.openCommittedSnapshot(f.projectionBinding), integrity);
});

test("empty and artifact-only packages preserve package-bound source scope", async t => {
  for (const legacyArtifacts of [false, true]) await t.test(`artifacts=${legacyArtifacts}`, async child => {
    const f = await importedPackageFixture(child, true, { sourceEventCount: 0, legacyArtifacts });
    const snapshot = await f.reader.openCommittedSnapshot(f.projectionBinding);
    assert.deepEqual([...snapshot.events()], []);
    assert.equal(snapshot.eventCount, 0);
    assert.equal(snapshot.aggregateBytes, 0);
    assert.equal(snapshot.terminalEventPosition, 0n);
    assert.equal(snapshot.terminalEventHash, "0".repeat(64));
    snapshot.close();
    const sourceManifest = sealManifest({ ...f.source.manifest, branchScopeId: randomUUID(), branchRef: "refs/heads/unbound" });
    const reader = new V2ImportedProjectionEventReader({ ...f.options, sourceManifest });
    await assert.rejects(reader.openCommittedSnapshot({ ...f.projectionBinding,
      branchScopeId: sourceManifest.branchScopeId, branchRef: sourceManifest.branchRef } as typeof f.projectionBinding), integrity);
  });
});

test("rejects an unreceipted unknown migration-stream event after the last receipt", async t => {
  const f = await importedPackageFixture(t);
  new EventStore(f.connection, new SqliteEventStoreStatements(f.connection), new MaintenanceFence(), new BranchScopeRepository(), () => NOW)
    .append({ context: f.context, commandId: randomUUID(), idempotencyKey: randomUUID(), commandType: "Unexpected",
      correlationId: randomUUID(), agentId: "test", expectedStreamVersion: 4n,
      streamId: `v2-shadow-import/${f.sealedPackage.migrationIdentity}`, streamType: "migration",
      events: [{ eventType: "UnknownMigrationEvent", eventSchemaVersion: 1, occurredAt: NOW, visibilityScope: "project",
        confidence: "high", verificationStatus: "verified", payload: {}, sourceRefs: [], evidenceRefs: [], evidenceDigests: [] }],
      outbox: [], publicResponse: { ok: true } });
  await assert.rejects(f.reader.openCommittedSnapshot(f.projectionBinding), integrity);
});

test("rejects missing committed wrappers while package and receipts remain present", async t => {
  const f = await importedPackageFixture(t);
  f.connection.exec("DROP TRIGGER events_no_delete; DELETE FROM events WHERE global_position=2");
  await assert.rejects(f.reader.openCommittedSnapshot(f.projectionBinding), integrity);
});

test("rejects an authentic wrapper stored in a foreign workspace", async t => {
  const f = await importedPackageFixture(t, false);
  const workspaceId = "b".repeat(64) as typeof f.projectionBinding.workspaceId;
  const workspace = { ...f.context.workspace, workspaceId } as ProjectContext["workspace"];
  commitWrappers({ ...f, context: { ...f.context, workspace, binding: { ...f.context.binding, workspaceId, workspace } } }, () => {});
  await assert.rejects(f.reader.openCommittedSnapshot(f.projectionBinding), integrity);
});

test("streams validation and reads only one source row per iterator advance", async t => {
  const f = await importedPackageFixture(t);
  let rowReads = 0;
  const driver: SqliteDriver = { open(path, options) {
    const connection = f.driver.open(path, options);
    return { exec: sql => connection.exec(sql), close: () => connection.close(), prepare(sql) {
      const statement = connection.prepare(sql);
      return { run: params => statement.run(params), iterate: params => statement.iterate(params),
        all() { throw new Error("EAGER_SQLITE_PAYLOAD_ARRAY"); }, get(params) {
          if (sql.includes("FROM events WHERE global_position=$position")) rowReads++;
          return statement.get(params);
        } };
    } };
  } };
  const snapshot = await new V2ImportedProjectionEventReader({ ...f.options, driver }).openCommittedSnapshot(f.projectionBinding);
  assert.equal(rowReads, 0);
  const iterator = snapshot.events()[Symbol.iterator]();
  assert.equal(rowReads, 0);
  assert.equal(iterator.next().value?.eventId, f.sourceEvents[0]!.eventId);
  assert.equal(rowReads, 1);
  snapshot.close();
});

test("redacts open failures and closes failed SQLite snapshots exactly once", async t => {
  const f = await importedPackageFixture(t);
  let closes = 0;
  const driver: SqliteDriver = { open(path, options) {
    const connection = f.driver.open(path, options);
    return { exec: sql => connection.exec(sql), close() { closes++; connection.close(); }, prepare() {
      throw new Error("PRIVATE_DATABASE_PATH_AND_PAYLOAD");
    } };
  } };
  await assert.rejects(new V2ImportedProjectionEventReader({ ...f.options, driver }).openCommittedSnapshot(f.projectionBinding), integrity);
  assert.equal(closes, 1);
});

test("does not normalize malformed reference arrays from authenticated package records", async t => {
  for (const field of ["sourceRefs", "evidenceRefs", "evidenceDigests"] as const) await t.test(field, async child => {
    const f = await importedPackageFixture(child, true, { corruptSource: event => ({ ...event, [field]: "" }) as unknown as StoredEvent });
    await assert.rejects(f.reader.openCommittedSnapshot(f.projectionBinding), integrity);
  });
});
