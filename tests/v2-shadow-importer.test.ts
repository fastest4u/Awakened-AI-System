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
import { createShadowMigrationInvocationDeadline } from "../src/orchestrator/migration/v2-shadow-migration-runtime.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { BranchScopeRepository } from "../src/orchestrator/storage/branch-scope.repository.js";
import { GENESIS_GLOBAL_HASH, MAX_CANONICAL_COMMAND_BYTES, MAX_EVENTS_PER_COMMAND, SqliteEventStoreStatements, type EventAppendStatements, type EventStoreFaultInjector } from "../src/orchestrator/storage/event-store.js";
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
async function fixture(t: test.TestContext, faultInjector?: EventStoreFaultInjector, bindTarget = false,
  sourceOptions: Parameters<typeof createV2ShadowMigrationFixture>[1] = {}) {
  const sourceFixture = await createV2ShadowMigrationFixture(t, sourceOptions);
  sourceFixture.writeManifest({ ...sourceFixture.manifest, createdAt: PACKAGE_CREATED_AT });
  const source = await verifyV1SourceCopy(sourceFixture.verificationInput);
  const sealedPackage = await sealV2MigrationPackage({ ...sourceFixture.packageInput, source, packageRoot: sourceFixture.packageRootA });
  const eventStorePath = join(sourceFixture.root, "target.sqlite");
  let connection = driver.open(eventStorePath, { mode: "create", busyTimeoutMs: 5000 }); applyCurrentProjectStoreSchema(connection, sourceFixture.projectionBinding, NOW); connection.exec(v2ShadowMigration.sql);
  if (bindTarget) { connection.close(); connection = driver.open(eventStorePath, { mode: "existing", busyTimeoutMs: 5000, bindFileIdentity: true }); }
  const workspace = { kind: "non-git" as const, workspaceRoot: sourceFixture.root, workspaceId: sourceFixture.projectionBinding.workspaceId };
  const context = { workspace, checkedAt: NOW, binding: { ...sourceFixture.projectionBinding, projectBindingId: randomUUID(), generation: 1, contextFingerprint: "shadow", source: "explicit-cli", clientNamespace: "shadow-test", clientInstanceId: randomUUID(), actorRole: "primary", projectRoot: sourceFixture.root, vaultRoot: sourceFixture.liveVaultRoot, descriptorPath: `${sourceFixture.liveVaultRoot}/.project-memory.json`, storeRoute: { kind: "vault-local", storeRoot: sourceFixture.root, eventsPath: `${sourceFixture.root}/target.sqlite`, storeManifestPath: `${sourceFixture.root}/store.json`, projectionManifestPath: `${sourceFixture.root}/projection.json` }, workspace, establishedAt: NOW } } as unknown as ProjectContext;
  const revisionId = randomUUID(); connection.prepare("INSERT INTO rollout_revisions(project_id,revision_id,parent_revision_id,build_identity_hash,migration_identity_hash,configuration_checksum,v1_baseline_checksum,cohort_algorithm_version,cohort_salt,cohort_basis_points,created_at) VALUES ($p,$r,NULL,$b,$m,$c,$h,1,$h,0,$n)").run({
    $p: context.binding.projectId, $r: revisionId, $b: sealedPackage.manifest.buildIdentityHash,
    $m: sealedPackage.migrationIdentity, $c: sealedPackage.manifest.configurationChecksum, $h: "a".repeat(64), $n: NOW });
  const repository = new SqliteV2ShadowMigrationRepository(connection); repository.transact(context.binding.projectId, sealedPackage.migrationIdentity, tx => tx.insertRun({ projectId: context.binding.projectId, migrationIdentity: sealedPackage.migrationIdentity, rolloutRevisionId: revisionId, packageChecksum: sealedPackage.manifest.packageChecksum, sourceManifestChecksum: sealedPackage.manifest.sourceManifestChecksum, sourceTerminalPosition: BigInt(sealedPackage.manifest.terminalEventPosition), sourceTerminalHash: sealedPackage.manifest.terminalEventHash, configurationChecksum: sealedPackage.manifest.configurationChecksum, policyChecksum: shadowMigrationPolicyChecksum(sourceFixture.policy), buildIdentityHash: sealedPackage.manifest.buildIdentityHash, createdAt: NOW }));
  return { connection, context, eventStorePath, sealedPackage, repository, policy: sourceFixture.policy, sourceFixture, close: () => { sealedPackage.close(); source.close(); connection.close(); }, importer: new V2ShadowImporter({ connection, statements: new SqliteEventStoreStatements(connection), maintenance: new MaintenanceFence(), branchScopes: new BranchScopeRepository(), policy: sourceFixture.policy, faultInjector, ...(bindTarget ? { eventStorePath } : {}) }) };
}
const unknown = (error: unknown) => error instanceof ShadowMigrationError && error.code === "MIGRATION_OUTCOME_UNKNOWN";

test("read-only reconciliation classifies a genuinely bound empty target as absent", async t => {
  // Consulting caller-supplied statements or entering a semantic write path breaks checked-target-only absence proof.
  const f = await fixture(t, undefined, true);
  try {
    const result = f.importer.reconcile({ context: f.context, sealedPackage: f.sealedPackage });
    assert.deepEqual(result, { status: "absent" });
    assert.equal(Number(f.connection.prepare("SELECT count(*) AS n FROM events").get()!.n), 0);
    assert.equal(Number(f.connection.prepare("SELECT count(*) AS n FROM v2_shadow_imported_records").get()!.n), 0);
    assert.equal(Number(f.connection.prepare("SELECT count(*) AS n FROM v2_shadow_compatibility_outbox").get()!.n), 0);
  } finally { f.close(); }
});

test("read-only reconciliation returns the exact deterministic committed result without writes", async t => {
  // Recomputing a different result or repairing evidence during reconciliation breaks whole-import idempotency.
  const f = await fixture(t, undefined, true);
  try {
    const imported = f.importer.import({ context: f.context, sealedPackage: f.sealedPackage });
    const before = f.connection.prepare("SELECT (SELECT count(*) FROM events) AS events,(SELECT count(*) FROM command_dedup) AS dedup,(SELECT count(*) FROM v2_shadow_imported_records) AS receipts,(SELECT count(*) FROM v2_shadow_compatibility_outbox) AS outboxes").get();
    const reconciled = f.importer.reconcile({ context: f.context, sealedPackage: f.sealedPackage });
    assert.deepEqual(reconciled, { status: "committed", result: { ...imported, deduplicated: true } });
    const after = f.connection.prepare("SELECT (SELECT count(*) FROM events) AS events,(SELECT count(*) FROM command_dedup) AS dedup,(SELECT count(*) FROM v2_shadow_imported_records) AS receipts,(SELECT count(*) FROM v2_shadow_compatibility_outbox) AS outboxes").get();
    assert.deepEqual(after, before);
    assert.equal(Object.isFrozen(reconciled), true);
    if (reconciled.status === "committed") {
      assert.equal(Object.isFrozen(reconciled.result), true);
      assert.equal(Object.isFrozen(reconciled.result.eventIds), true);
    }
  } finally { f.close(); }
});

test("reconciliation authenticates a valid empty package as committed", async t => {
  // Treating zero expected effects as absent loses the distinction between a valid no-op import and a missing import.
  const f = await fixture(t, undefined, true, { sourceEventCount: 0, legacyArtifacts: false });
  try {
    const reconciled = f.importer.reconcile({ context: f.context, sealedPackage: f.sealedPackage });
    assert.deepEqual(reconciled, { status: "committed", result: {
      schemaVersion: 1, migrationIdentity: f.sealedPackage.migrationIdentity,
      packageChecksum: f.sealedPackage.manifest.packageChecksum, recordCount: 0, eventIds: [],
      firstImportedPosition: null, terminalImportedPosition: null, terminalImportedEventHash: "0".repeat(64),
      importedEventsChecksum: createHash("sha256").update(canonicalJson([])).digest("hex"), deduplicated: true } });
    assert.equal(Number(f.connection.prepare("SELECT count(*) AS n FROM events").get()!.n), 0);
  } finally { f.close(); }
});

test("reconciliation ignores a distinct real foreign statement set", async t => {
  // Consulting injectable statements lets a checked empty target inherit committed proof from another native store.
  const target = await fixture(t, undefined, true);
  const foreign = await fixture(t);
  try {
    foreign.importer.import({ context: foreign.context, sealedPackage: foreign.sealedPackage });
    const importer = new V2ShadowImporter({ connection: target.connection,
      statements: new SqliteEventStoreStatements(foreign.connection), maintenance: new MaintenanceFence(),
      branchScopes: new BranchScopeRepository(), policy: target.policy, eventStorePath: target.eventStorePath });
    assert.deepEqual(importer.reconcile({ context: target.context, sealedPackage: target.sealedPackage }), { status: "absent" });
    assert.equal(Number(target.connection.prepare("SELECT count(*) AS n FROM events").get()!.n), 0);
  } finally { foreign.close(); target.close(); }
});

test("reconciliation reports a real commit-before-receipt outcome as unknown and never repairs it", async t => {
  // Missing receipts/outboxes after an authenticated EventStore commit is partial evidence, not committed or absent.
  let lost = false;
  const f = await fixture(t, { hit(boundary) { if (!lost && boundary === "after-commit-before-response") {
    lost = true; throw new Error("lost-import-response"); } } }, true);
  try {
    assert.throws(() => f.importer.import({ context: f.context, sealedPackage: f.sealedPackage }), unknown);
    const beforeEvents = Number(f.connection.prepare("SELECT count(*) AS n FROM events").get()!.n);
    assert.deepEqual(f.importer.reconcile({ context: f.context, sealedPackage: f.sealedPackage }),
      { status: "unknown", safeErrorCode: "MIGRATION_OUTCOME_UNKNOWN" });
    assert.equal(Number(f.connection.prepare("SELECT count(*) AS n FROM events").get()!.n), beforeEvents);
    assert.equal(Number(f.connection.prepare("SELECT count(*) AS n FROM v2_shadow_imported_records").get()!.n), 0);
    assert.equal(Number(f.connection.prepare("SELECT count(*) AS n FROM v2_shadow_compatibility_outbox").get()!.n), 0);
    const recovered = f.importer.import({ context: f.context, sealedPackage: f.sealedPackage });
    assert.equal(Number(f.connection.prepare("SELECT count(*) AS n FROM events").get()!.n), recovered.recordCount);
    assert.equal(Number(f.connection.prepare("SELECT count(*) AS n FROM v2_shadow_compatibility_outbox").get()!.n), 2);
  } finally { f.close(); }
});

test("reconciliation requires genuine matching open-time target provenance before reads", async t => {
  // Path text, wrappers, unbound opens, closed handles, and a different target must not authorize SQL evidence reads.
  for (const variant of ["missing", "unbound", "forged", "wrong-target", "closed"] as const) await t.test(variant, async child => {
    const f = await fixture(child, undefined, variant !== "unbound");
    const other = variant === "wrong-target" ? await fixture(child, undefined, true) : undefined;
    const statements = new SqliteEventStoreStatements(f.connection);
    let connection: SqliteConnection = f.connection;
    let eventStorePath: string | undefined = f.eventStorePath;
    if (variant === "missing") eventStorePath = undefined;
    if (variant === "forged") connection = { exec: sql => f.connection.exec(sql), prepare: sql => f.connection.prepare(sql), close() {} };
    if (variant === "wrong-target") eventStorePath = other!.eventStorePath;
    if (variant === "closed") f.connection.close();
    const importer = new V2ShadowImporter({ connection, statements,
      maintenance: new MaintenanceFence(), branchScopes: new BranchScopeRepository(), policy: f.policy,
      ...(eventStorePath === undefined ? {} : { eventStorePath }) });
    try {
      assert.throws(() => importer.reconcile({ context: f.context, sealedPackage: f.sealedPackage }));
      if (variant !== "closed") assert.equal(Number(f.connection.prepare("SELECT count(*) AS n FROM events").get()!.n), 0);
    } finally {
      other?.close();
      if (variant === "closed") { try { f.close(); } catch { /* the native handle was deliberately closed */ } }
      else f.close();
    }
  });
});

test("append-then-shared-deadline expiry stays unknown without receipts and a fresh invocation completes once", async t => {
  // Resetting the deadline or continuing after the committed append would write receipts/outbox or another batch after expiry.
  let now = 0;
  const f = await fixture(t, { hit(boundary) { if (boundary === "after-commit-before-response") now = 10; } }, true);
  const deadline = createShadowMigrationInvocationDeadline(10, () => now);
  try {
    assert.throws(() => f.importer.import({ context: f.context, sealedPackage: f.sealedPackage,
      invocationDeadline: deadline }), unknown);
    assert.equal(Number(f.connection.prepare("SELECT count(*) AS n FROM events").get()!.n), 4);
    assert.equal(Number(f.connection.prepare("SELECT count(*) AS n FROM v2_shadow_imported_records").get()!.n), 0);
    assert.equal(Number(f.connection.prepare("SELECT count(*) AS n FROM v2_shadow_compatibility_outbox").get()!.n), 0);
    assert.deepEqual(f.importer.reconcile({ context: f.context, sealedPackage: f.sealedPackage,
      invocationDeadline: deadline }), { status: "unknown", safeErrorCode: "MIGRATION_RETRY_EXHAUSTED" });
    const fresh = createShadowMigrationInvocationDeadline(100_000);
    const recovered = f.importer.import({ context: f.context, sealedPackage: f.sealedPackage, invocationDeadline: fresh });
    assert.equal(recovered.recordCount, 4);
    assert.equal(Number(f.connection.prepare("SELECT count(*) AS n FROM events").get()!.n), 4);
    assert.equal(Number(f.connection.prepare("SELECT count(*) AS n FROM v2_shadow_compatibility_outbox").get()!.n), 2);
    fresh.dispose();
  } finally { deadline.dispose(); f.close(); }
});

test("one completed batch of a real multi-batch import reconciles as unknown", async t => {
  // Classifying each batch independently would report committed even though the whole import stopped before its terminal batch.
  let lost = false;
  const f = await fixture(t, { hit(boundary) { if (!lost && boundary === "after-commit-before-response") {
    lost = true; throw new Error("lost-first-batch-response"); } } }, true,
  { sourceEventCount: MAX_EVENTS_PER_COMMAND + 1, legacyArtifacts: false });
  try {
    assert.throws(() => f.importer.import({ context: f.context, sealedPackage: f.sealedPackage }), unknown);
    assert.equal(Number(f.connection.prepare("SELECT count(*) AS n FROM events").get()!.n), MAX_EVENTS_PER_COMMAND);
    assert.deepEqual(f.importer.reconcile({ context: f.context, sealedPackage: f.sealedPackage }),
      { status: "unknown", safeErrorCode: "MIGRATION_OUTCOME_UNKNOWN" });
    assert.equal(Number(f.connection.prepare("SELECT count(*) AS n FROM v2_shadow_imported_records").get()!.n), 0);
    const recovered = f.importer.import({ context: f.context, sealedPackage: f.sealedPackage });
    assert.equal(recovered.recordCount, MAX_EVENTS_PER_COMMAND + 1);
    assert.equal(Number(f.connection.prepare("SELECT count(*) AS n FROM events").get()!.n), MAX_EVENTS_PER_COMMAND + 1);
  } finally { f.close(); }
});

test("reconciliation rejects contradictory command, response, event, receipt, and outbox evidence", async t => {
  // Any authenticated-looking but contradictory present value must fail terminally instead of becoming absent or retryable.
  for (const variant of ["command", "response", "event", "receipt", "outbox"] as const) await t.test(variant, async child => {
    const f = await fixture(child, undefined, true);
    try {
      f.importer.import({ context: f.context, sealedPackage: f.sealedPackage });
      const table = variant === "command" || variant === "response" ? "command_dedup"
        : variant === "event" ? "events" : variant === "receipt" ? "v2_shadow_imported_records"
        : "v2_shadow_compatibility_outbox";
      const triggers = f.connection.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=$table").all({ $table: table });
      for (const trigger of triggers) f.connection.exec(`DROP TRIGGER "${String(trigger.name).replaceAll('"', '""')}"`);
      if (variant === "command") f.connection.prepare("UPDATE command_dedup SET command_id=$id WHERE project_id=$p")
        .run({ $id: randomUUID(), $p: f.context.binding.projectId });
      else if (variant === "response") f.connection.prepare("UPDATE command_dedup SET response_hash=$h WHERE project_id=$p")
        .run({ $h: "f".repeat(64), $p: f.context.binding.projectId });
      else if (variant === "event") f.connection.prepare("UPDATE events SET payload_hash=$h WHERE project_id=$p AND global_position=1")
        .run({ $h: "f".repeat(64), $p: f.context.binding.projectId });
      else if (variant === "receipt") f.connection.prepare("UPDATE v2_shadow_imported_records SET source_record_hash=$h WHERE project_id=$p AND source_ordinal=0")
        .run({ $h: "f".repeat(64), $p: f.context.binding.projectId });
      else f.connection.prepare("UPDATE v2_shadow_compatibility_outbox SET content_sha256=$h WHERE project_id=$p AND outbox_id=(SELECT outbox_id FROM v2_shadow_compatibility_outbox WHERE project_id=$p ORDER BY source_ordinal LIMIT 1)")
        .run({ $h: "f".repeat(64), $p: f.context.binding.projectId });
      assert.throws(() => f.importer.reconcile({ context: f.context, sealedPackage: f.sealedPackage }),
        error => error instanceof ShadowMigrationError && error.code === "MIGRATION_IDENTITY_CONFLICT");
    } finally { f.close(); }
  });
});

test("a real SQLite transaction-entry read uncertainty returns unknown without writes", async t => {
  // Treating a busy/ambiguous read as stable absence would authorize an unsafe retry.
  const f = await fixture(t, undefined, true);
  const blocker = driver.open(f.eventStorePath, { mode: "existing", busyTimeoutMs: 5000 });
  try {
    blocker.exec("BEGIN IMMEDIATE");
    const result = f.importer.reconcile({ context: f.context, sealedPackage: f.sealedPackage });
    assert.deepEqual(result, { status: "unknown", safeErrorCode: "MIGRATION_OUTCOME_UNKNOWN" });
    assert.equal(Number(f.connection.prepare("SELECT count(*) AS n FROM events").get()!.n), 0);
    assert.equal(Number(f.connection.prepare("SELECT count(*) AS n FROM v2_shadow_imported_records").get()!.n), 0);
  } finally { try { blocker.exec("ROLLBACK"); } finally { blocker.close(); f.close(); } }
});

test("reconciliation spends the supplied deadline again immediately before returning", async t => {
  // An early-only budget check would return stable absence after the invocation expired during proof construction.
  const f = await fixture(t, undefined, true);
  try {
    let probes = 0;
    const counting = { signal: new AbortController().signal, remainingMs(): number { probes += 1; return 1000; } };
    assert.deepEqual(f.importer.reconcile({ context: f.context, sealedPackage: f.sealedPackage,
      invocationDeadline: counting }), { status: "absent" });
    assert.ok(probes > 3);
    let lateProbes = 0;
    const expiresAtReturn = { signal: new AbortController().signal, remainingMs(): number {
      lateProbes += 1;
      if (lateProbes === probes) throw new ShadowMigrationError("MIGRATION_RETRY_EXHAUSTED");
      return 1000;
    } };
    assert.deepEqual(f.importer.reconcile({ context: f.context, sealedPackage: f.sealedPackage,
      invocationDeadline: expiresAtReturn }), { status: "unknown", safeErrorCode: "MIGRATION_RETRY_EXHAUSTED" });
    assert.equal(lateProbes, probes);
  } finally { f.close(); }
});

test("enqueues one exact immutable outbox per committed artifact in the receipt store", async t => {
  const f = await fixture(t);
  try {
    f.importer.import({ context: f.context, sealedPackage: f.sealedPackage });
    const rows = f.repository.transact(f.context.binding.projectId, f.sealedPackage.migrationIdentity, tx => tx.readPendingCompatibility());
    assert.equal(rows.length, 2);
    for (const row of rows) {
      const descriptor = f.sealedPackage.manifest.recordDescriptors[row.sourceOrdinal]!;
      const event = f.connection.prepare("SELECT * FROM events WHERE global_position=$p").get({ $p: row.importedGlobalPosition })!;
      assert.deepEqual(row, { projectId: f.context.binding.projectId, migrationIdentity: f.sealedPackage.migrationIdentity,
        outboxId: deterministicMigrationUuid("claim", f.sealedPackage.migrationIdentity, row.sourceOrdinal), sourceOrdinal: row.sourceOrdinal,
        importedEventId: event.event_id, importedGlobalPosition: event.global_position, importedEventHash: event.event_hash,
        triggeringPayloadHash: event.payload_hash, relativePath: descriptor.relativePath, byteLength: descriptor.byteLength,
        contentSha256: descriptor.contentSha256, materializationRevision: BigInt(row.sourceOrdinal + 1), recordedAt: event.recorded_at });
      assert.ok(Object.isFrozen(row));
    }
    assert.ok(Object.isFrozen(rows));
  } finally { f.close(); }
});

test("ignores an independently supplied repository and writes only the committed event store", async t => {
  const f = await fixture(t); const other = await fixture(t);
  try {
    const dependencies = { connection: f.connection, statements: new SqliteEventStoreStatements(f.connection),
      maintenance: new MaintenanceFence(), branchScopes: new BranchScopeRepository(), policy: f.policy, repository: other.repository };
    new V2ShadowImporter(dependencies).import({ context: f.context, sealedPackage: f.sealedPackage });
    assert.equal(f.repository.transact(f.context.binding.projectId, f.sealedPackage.migrationIdentity, tx => tx.readImportedRecords()).length, 4);
    assert.equal(Number(other.connection.prepare("SELECT count(*) AS n FROM v2_shadow_imported_records").get()!.n), 0);
    assert.equal(Number(other.connection.prepare("SELECT count(*) AS n FROM v2_shadow_compatibility_outbox").get()!.n), 0);
  } finally { other.close(); f.close(); }
});

test("rolls back receipts with outbox failure and reconciles the committed EventStore replay", async t => {
  const f = await fixture(t); let failOutbox = true;
  const connection: SqliteConnection = { close: () => f.connection.close(), exec: sql => f.connection.exec(sql),
    prepare(sql) { if (failOutbox && sql.startsWith("INSERT INTO v2_shadow_compatibility_outbox")) throw new Error("receipt-outbox-test-failure");
      return f.connection.prepare(sql); } };
  const importer = new V2ShadowImporter({ connection, statements: new SqliteEventStoreStatements(connection),
    maintenance: new MaintenanceFence(), branchScopes: new BranchScopeRepository(), policy: f.policy });
  try {
    assert.throws(() => importer.import({ context: f.context, sealedPackage: f.sealedPackage }), /receipt-outbox-test-failure/);
    assert.equal(Number(f.connection.prepare("SELECT count(*) AS n FROM events").get()!.n), 4);
    assert.equal(Number(f.connection.prepare("SELECT count(*) AS n FROM v2_shadow_imported_records").get()!.n), 0);
    assert.equal(Number(f.connection.prepare("SELECT count(*) AS n FROM v2_shadow_compatibility_outbox").get()!.n), 0);
    failOutbox = false;
    importer.import({ context: f.context, sealedPackage: f.sealedPackage });
    assert.equal(Number(f.connection.prepare("SELECT count(*) AS n FROM events").get()!.n), 4);
    assert.equal(Number(f.connection.prepare("SELECT count(*) AS n FROM v2_shadow_compatibility_outbox").get()!.n), 2);
  } finally { f.close(); }
});

test("replays acknowledged outboxes exactly without new events or revisions", async t => {
  const f = await fixture(t);
  try {
    const first = f.importer.import({ context: f.context, sealedPackage: f.sealedPackage });
    f.repository.transact(f.context.binding.projectId, f.sealedPackage.migrationIdentity, tx => {
      for (const row of tx.readPendingCompatibility()) {
        const time = new Date(Date.parse(f.sealedPackage.manifest.createdAt) + row.sourceOrdinal).toISOString();
        tx.claimCompatibility({ projectId: row.projectId, migrationIdentity: row.migrationIdentity, outboxId: row.outboxId,
          claimId: row.outboxId, claimOwnerFingerprint: createHash("sha256").update(`project-memory/v2-shadow-compatibility-owner/v1\n${row.migrationIdentity}`).digest("hex"), claimedAt: time });
        const body = { projectId: row.projectId, migrationIdentity: row.migrationIdentity, outboxId: row.outboxId,
          acknowledgementId: row.outboxId, claimId: row.outboxId, acknowledgedImportedPosition: row.importedGlobalPosition,
          materializationRevision: row.materializationRevision, targetContentSha256: row.contentSha256, acknowledgedAt: time };
        tx.acknowledgeCompatibility({ ...body, acknowledgementChecksum: createHash("sha256").update(canonicalJson({ ...body,
          acknowledgedImportedPosition: body.acknowledgedImportedPosition.toString(), materializationRevision: body.materializationRevision.toString() })).digest("hex") });
      }
    });
    assert.deepEqual(f.importer.import({ context: f.context, sealedPackage: f.sealedPackage }), { ...first, deduplicated: true });
    assert.equal(Number(f.connection.prepare("SELECT count(*) AS n FROM events").get()!.n), 4);
    assert.equal(Number(f.connection.prepare("SELECT count(*) AS n FROM v2_shadow_compatibility_outbox").get()!.n), 2);
    assert.equal(Number(f.connection.prepare("SELECT count(*) AS n FROM rollout_revisions").get()!.n), 1);
  } finally { f.close(); }
});

test("refuses receipt replay with missing or conflicting artifact outbox without backfill", async t => {
  for (const variant of ["missing", "conflicting", "source-kind"] as const) await t.test(variant, async child => {
    let interrupted = false;
    const f = await fixture(child, { hit(boundary) { if (!interrupted && boundary === "after-commit-before-response") {
      interrupted = true; throw new Error("lost"); } } });
    try {
      assert.throws(() => f.importer.import({ context: f.context, sealedPackage: f.sealedPackage }), unknown);
      const events = storedEvents(f.connection);
      f.repository.transact(f.context.binding.projectId, f.sealedPackage.migrationIdentity, tx => {
        tx.insertImportedRecords(events.map((event, ordinal) => ({ projectId: event.projectId, migrationIdentity: f.sealedPackage.migrationIdentity,
          sourceOrdinal: ordinal, sourceKind: f.sealedPackage.manifest.recordDescriptors[ordinal]!.kind,
          sourceRecordHash: f.sealedPackage.manifest.recordDescriptors[ordinal]!.contentSha256,
          importedEventId: event.eventId, importedGlobalPosition: event.globalPosition, importedEventHash: event.eventHash, recordedAt: event.recordedAt })));
        if (variant !== "missing") {
          const ordinal = variant === "source-kind" ? 0 : 2, event = events[ordinal]!;
          tx.enqueueCompatibility([{ projectId: event.projectId, migrationIdentity: f.sealedPackage.migrationIdentity,
            sourceOrdinal: ordinal, outboxId: deterministicMigrationUuid("claim", f.sealedPackage.migrationIdentity, ordinal),
            importedEventId: event.eventId, importedGlobalPosition: event.globalPosition, importedEventHash: event.eventHash,
            triggeringPayloadHash: event.payloadHash, relativePath: "legacy/conflict.md", byteLength: 1, contentSha256: "f".repeat(64),
            materializationRevision: BigInt(ordinal + 1), recordedAt: event.recordedAt }]);
        }
      });
      assert.throws(() => f.importer.import({ context: f.context, sealedPackage: f.sealedPackage }),
        error => error instanceof ShadowMigrationError && error.code === "MIGRATION_IDENTITY_CONFLICT");
      assert.equal(Number(f.connection.prepare("SELECT count(*) AS n FROM events").get()!.n), 4);
      assert.equal(Number(f.connection.prepare("SELECT count(*) AS n FROM v2_shadow_compatibility_outbox").get()!.n), variant === "missing" ? 0 : 1);
    } finally { f.close(); }
  });
});

test("does not backfill an outbox when an exact receipt appears after EventStore commit readback", async t => {
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(t, { hit(boundary) {
    if (boundary !== "after-commit-before-response") return;
    const events = storedEvents(f.connection);
    f.repository.transact(f.context.binding.projectId, f.sealedPackage.migrationIdentity, tx => {
      tx.insertImportedRecords(events.map((event, ordinal) => ({ projectId: event.projectId,
        migrationIdentity: f.sealedPackage.migrationIdentity, sourceOrdinal: ordinal,
        sourceKind: f.sealedPackage.manifest.recordDescriptors[ordinal]!.kind,
        sourceRecordHash: f.sealedPackage.manifest.recordDescriptors[ordinal]!.contentSha256,
        importedEventId: event.eventId, importedGlobalPosition: event.globalPosition, importedEventHash: event.eventHash, recordedAt: event.recordedAt })));
    });
  } });
  try {
    assert.throws(() => f.importer.import({ context: f.context, sealedPackage: f.sealedPackage }),
      error => error instanceof ShadowMigrationError && error.code === "MIGRATION_IDENTITY_CONFLICT");
    assert.equal(Number(f.connection.prepare("SELECT count(*) AS n FROM events").get()!.n), 4);
    assert.equal(Number(f.connection.prepare("SELECT count(*) AS n FROM v2_shadow_compatibility_outbox").get()!.n), 0);
  } finally { f.close(); }
});
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
    branchScopes: new BranchScopeRepository(), policy });
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
function variedCallerContext(
  base: ProjectContext,
  root: string,
  name: string,
  options: Readonly<{ actorRole: ProjectContext["binding"]["actorRole"]; clientInstanceId: string; git: boolean }>,
): ProjectContext {
  const workspace = options.git ? { kind: "git" as const, worktreeRoot: `${root}/${name}-worktree`,
    gitDir: `${root}/${name}-git`, gitCommonDir: `${root}/${name}-common`, headCommit: "b".repeat(40),
    branchRef: `refs/heads/${name}`, detached: false, workspaceId: base.binding.workspaceId }
    : { kind: "non-git" as const, workspaceRoot: `${root}/${name}-non-git`, workspaceId: base.binding.workspaceId };
  return { ...base, workspace, branchScopeId: randomUUID(), binding: { ...base.binding,
    actorRole: options.actorRole, clientInstanceId: options.clientInstanceId, workspace } } as ProjectContext;
}
function siblingTarget(
  f: Awaited<ReturnType<typeof fixture>>,
  name: string,
  options: Readonly<{ actorRole: ProjectContext["binding"]["actorRole"]; clientInstanceId: string; git: boolean }>,
) {
  const path = `${f.sourceFixture.root}/${name}.sqlite`; const connection = driver.open(path, { mode: "create", busyTimeoutMs: 5000 });
  applyCurrentProjectStoreSchema(connection, f.sourceFixture.projectionBinding, NOW); connection.exec(v2ShadowMigration.sql);
  const context = variedCallerContext({ ...f.context, binding: { ...f.context.binding,
    storeRoute: { ...f.context.binding.storeRoute, eventsPath: path } } } as ProjectContext, f.sourceFixture.root, name, options);
  const revisionId = randomUUID(); connection.prepare("INSERT INTO rollout_revisions(project_id,revision_id,parent_revision_id,build_identity_hash,migration_identity_hash,configuration_checksum,v1_baseline_checksum,cohort_algorithm_version,cohort_salt,cohort_basis_points,created_at) VALUES ($p,$r,NULL,$h,$h,$h,$h,1,$h,0,$n)").run({ $p: context.binding.projectId, $r: revisionId, $h: "a".repeat(64), $n: NOW });
  const repository = new SqliteV2ShadowMigrationRepository(connection); repository.transact(context.binding.projectId, f.sealedPackage.migrationIdentity, tx => tx.insertRun({
    projectId: context.binding.projectId, migrationIdentity: f.sealedPackage.migrationIdentity, rolloutRevisionId: revisionId,
    packageChecksum: f.sealedPackage.manifest.packageChecksum, sourceManifestChecksum: f.sealedPackage.manifest.sourceManifestChecksum,
    sourceTerminalPosition: BigInt(f.sealedPackage.manifest.terminalEventPosition), sourceTerminalHash: f.sealedPackage.manifest.terminalEventHash,
    configurationChecksum: f.sealedPackage.manifest.configurationChecksum, policyChecksum: shadowMigrationPolicyChecksum(f.policy),
    buildIdentityHash: f.sealedPackage.manifest.buildIdentityHash, createdAt: NOW }));
  return { connection, context, importer: new V2ShadowImporter({ connection, statements: new SqliteEventStoreStatements(connection),
    maintenance: new MaintenanceFence(), branchScopes: new BranchScopeRepository(), policy: f.policy }), close: () => connection.close() };
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
    const originalCaller = structuredClone(f.context);
    const first = f.importer.import({ context: f.context, sealedPackage: f.sealedPackage });
    const replayContext = variedCallerContext(f.context, f.sourceFixture.root, "replay", {
      actorRole: "maintenance", clientInstanceId: randomUUID(), git: true });
    const originalReplayCaller = structuredClone(replayContext);
    assert.deepEqual(f.importer.import({ context: replayContext, sealedPackage: f.sealedPackage }), { ...first, deduplicated: true });
    assert.deepEqual(f.context, originalCaller); assert.deepEqual(replayContext, originalReplayCaller);
    const events = storedEvents(f.connection); assert.deepEqual(events.map(event => event.eventId), first.eventIds);
    for (const [ordinal, event] of events.entries()) {
      const descriptor = f.sealedPackage.manifest.recordDescriptors[ordinal]!; const payload = event.payload as Record<string, unknown>;
      assert.equal(event.streamId, `v2-shadow-import/${f.sealedPackage.migrationIdentity}`); assert.equal(event.streamType, "migration");
      assert.equal(event.actorRole, "untrusted"); assert.equal(event.clientInstanceId, `v2-shadow-importer:${f.sealedPackage.migrationIdentity}`);
      assert.equal(event.branchScopeId, null); assert.equal(event.branchRef, null);
      assert.equal(event.visibilityScope, "project"); assert.equal(event.confidence, "high"); assert.equal(event.verificationStatus, "verified");
      assert.deepEqual(event.sourceRefs, [`migration:${f.sealedPackage.migrationIdentity}:${ordinal}`]); assert.deepEqual(event.evidenceRefs, []); assert.deepEqual(event.evidenceDigests, []);
      assert.equal(payload.schemaVersion, 1); assert.equal(payload.migrationIdentity, f.sealedPackage.migrationIdentity); assert.equal(payload.sourceOrdinal, ordinal); assert.equal(payload.sourceRecordHash, descriptor.contentSha256);
      if (descriptor.kind === "source-event") { assert.equal(event.eventType, "V1ProjectionSourceImported");
        assert.deepEqual(Object.keys(payload).sort(), ["migrationIdentity","schemaVersion","sourceEvent","sourceOrdinal","sourceRecordHash"].sort());
        const sourceEvent = payload.sourceEvent as Record<string, unknown>; const original = f.sourceFixture.sourceEvents[ordinal]!;
        assert.equal(Object.hasOwn(sourceEvent, "payload"), false); assert.equal(Object.hasOwn(sourceEvent, "payloadJson"), true);
        assert.equal(sourceEvent.actorRole, original.actorRole); assert.equal(sourceEvent.clientInstanceId, original.clientInstanceId);
        assert.equal(sourceEvent.branchScopeId, original.branchScopeId); assert.equal(sourceEvent.branchRef, original.branchRef);
      } else { assert.equal(event.eventType, "V1LegacyArtifactImported");
        assert.deepEqual(Object.keys(payload).sort(), ["contentSha256","contentUtf8","migrationIdentity","relativePath","schemaVersion","sourceOrdinal","sourceRecordHash"].sort()); }
    }
  } finally { f.close(); }
});
test("produces identical authenticated event chains and results in three isolated stores", async t => {
  // Feeding caller principal or checkout metadata into wrapper events changes authenticated migration evidence across targets.
  const first = await fixture(t);
  const second = siblingTarget(first, "determinism-b", { actorRole: "maintenance", clientInstanceId: randomUUID(), git: true });
  const third = siblingTarget(first, "determinism-c", { actorRole: "untrusted", clientInstanceId: randomUUID(), git: false });
  try {
    const targets = [first, second, third]; const results = targets.map(target => target.importer.import({ context: target.context, sealedPackage: first.sealedPackage }));
    assert.deepEqual(results[1], results[0]); assert.deepEqual(results[2], results[0]);
    const chains = targets.map(target => storedEvents(target.connection));
    assert.deepEqual(chains[1], chains[0]); assert.deepEqual(chains[2], chains[0]);
    for (const events of chains) { let cursor = { expectedPosition: 1n, previousEventHash: GENESIS_GLOBAL_HASH };
      for (const event of events) cursor = authenticateStoredEvent(event, cursor).nextCursor; }
  } finally { third.close(); second.close(); first.close(); }
});
test("reconciles commit-before-receipt unknown outcome with the original command and no duplicate", async t => { let failed=false; const faults: EventStoreFaultInjector={hit(boundary){if(!failed&&boundary==="after-commit-before-response"){failed=true;throw Error("lost")}}}; const f=await fixture(t,faults); try { assert.throws(()=>f.importer.import({context:f.context,sealedPackage:f.sealedPackage}),unknown); const retryContext=variedCallerContext(f.context,f.sourceFixture.root,"unknown-retry",{actorRole:"maintenance",clientInstanceId:randomUUID(),git:true}); const recovered=f.importer.import({context:retryContext,sealedPackage:f.sealedPackage}); assert.equal(Number(f.connection.prepare("SELECT count(*) AS count FROM events").get()?.count),recovered.recordCount); assert.equal(new Set(recovered.eventIds).size,recovered.eventIds.length); } finally { f.close(); } });
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
      branchScopes: new BranchScopeRepository(), policy: f.policy, faultInjector: faults });
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
