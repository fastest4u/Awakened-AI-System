import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import test from "node:test";
import type { ProjectContext } from "../src/orchestrator/identity/contracts.js";
import { verifyV1SourceCopy } from "../src/orchestrator/migration/v1-source-copy.js";
import { sealV2MigrationPackage } from "../src/orchestrator/migration/v2-migration-package.js";
import { V2ShadowImporter } from "../src/orchestrator/migration/v2-shadow-importer.js";
import { V2ShadowProjectionPublisher, v1ProjectionBaselineChecksum } from "../src/orchestrator/migration/v2-shadow-projection.js";
import { ShadowMigrationError, shadowMigrationPolicyChecksum } from "../src/orchestrator/migration/v2-shadow-migration.contracts.js";
import { createShadowMigrationInvocationDeadline, shadowMigrationPhaseMetadata } from "../src/orchestrator/migration/v2-shadow-migration-runtime.js";
import { ImmutableProjectionBuilder } from "../src/orchestrator/projections/builder.js";
import { V2ProjectionBuildCoordinator } from "../src/orchestrator/projections/coordinator.js";
import { V2ImportedProjectionEventReader } from "../src/orchestrator/migration/v2-imported-event-reader.js";
import type { ProjectionEventSnapshot } from "../src/orchestrator/projections/event-reader.js";
import { ProjectionIntegrityService } from "../src/orchestrator/projections/integrity.js";
import { LifecycleError } from "../src/orchestrator/lifecycle/errors.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { BranchScopeRepository } from "../src/orchestrator/storage/branch-scope.repository.js";
import { SqliteEventStoreStatements } from "../src/orchestrator/storage/event-store.js";
import { MaintenanceFence } from "../src/orchestrator/storage/maintenance-fence.js";
import { v2ShadowMigration } from "../src/orchestrator/storage/migrations/0007-v2-shadow-migration.js";
import { SqliteV2ShadowMigrationRepository } from "../src/orchestrator/storage/v2-shadow-migration.repository.js";
import type { SqliteConnection, SqliteStatement } from "../src/orchestrator/storage/sqlite-driver.js";
import { applyCurrentProjectStoreSchema } from "./support/current-project-store-schema.js";
import { createV2ShadowMigrationFixture, digest } from "./support/v2-shadow-migration-fixture.js";

async function fixture(t: test.TestContext, corruptV2 = false, crashV1 = false, revisionBaseline?: string,
  mismatchedRevision?: "build" | "migration" | "configuration") {
  let cleanup = () => {};
  t.after(() => cleanup());
  const f = await createV2ShadowMigrationFixture(t);
  const source = await verifyV1SourceCopy(f.verificationInput);
  const sealedPackage = await sealV2MigrationPackage({ ...f.packageInput, source, packageRoot: f.packageRootA });
  const v1Directory = join(f.root, "v1-reference");
  const v2Directory = join(f.root, "v2-shadow");
  mkdirSync(v1Directory); mkdirSync(v2Directory);
  const eventStorePath = join(f.root, "target.sqlite");
  let connection = f.driver.open(eventStorePath, { mode: "create", busyTimeoutMs: 5000 });
  cleanup = () => { connection.close(); sealedPackage.close(); source.close(); };
  applyCurrentProjectStoreSchema(connection, f.projectionBinding, f.manifest.createdAt);
  connection.exec(v2ShadowMigration.sql);
  connection.close();
  connection = f.driver.open(eventStorePath, { mode: "existing", busyTimeoutMs: 5000, bindFileIdentity: true });
  const repository = new SqliteV2ShadowMigrationRepository(connection);
  let crashPending = crashV1;
  const publisherOptions = { driver: f.driver, connection, eventStorePath,
    liveEventStorePath: f.liveEventStorePath, liveVaultRoot: f.liveVaultRoot,
    v1ProjectionDirectory: v1Directory, v2ProjectionDirectory: v2Directory, policy: f.policy,
    faultInjector: { hit(boundary: string, path: string) {
      if (corruptV2 && boundary === "before-v2-integrity") writeFileSync(path, "tampered");
      if (crashPending && boundary === "before-v1-manifest") { crashPending = false; throw new Error("crash"); }
    } } };
  const publisher = new V2ShadowProjectionPublisher(publisherOptions);
  const baselineInput = { source, sealedPackage };
  const sourceBytes = readFileSync(f.sourceDatabasePath);
  let orphanBytes: Buffer | undefined;
  if (crashV1) {
    await assert.rejects(publisher.prepareV1Baseline(baselineInput));
    assert.equal(existsSync(join(v1Directory, "projection-manifest.json")), false);
    orphanBytes = readFileSync(join(v1Directory, "projections-1-1.sqlite"));
  }
  const preparedV1 = await publisher.prepareV1Baseline(baselineInput);
  if (orphanBytes) assert.deepEqual(readFileSync(preparedV1.generation.databasePath), orphanBytes);
  assert.deepEqual(readFileSync(f.sourceDatabasePath), sourceBytes);
  const revisionId = randomUUID();
  connection.prepare("INSERT INTO rollout_revisions(project_id,revision_id,parent_revision_id,build_identity_hash,migration_identity_hash,configuration_checksum,v1_baseline_checksum,cohort_algorithm_version,cohort_salt,cohort_basis_points,created_at) VALUES ($p,$r,NULL,$build,$migration,$configuration,$b,1,$h,0,$n)")
    .run({ $p: f.projectionBinding.projectId, $r: revisionId, $h: "a".repeat(64), $b: revisionBaseline ?? preparedV1.baselineChecksum, $n: f.manifest.createdAt,
      $build: mismatchedRevision === "build" ? digest("unrelated-build") : sealedPackage.manifest.buildIdentityHash,
      $migration: mismatchedRevision === "migration" ? digest("unrelated-migration") : sealedPackage.migrationIdentity,
      $configuration: mismatchedRevision === "configuration" ? digest("unrelated-configuration") : sealedPackage.manifest.configurationChecksum });
  repository.transact(f.projectionBinding.projectId, sealedPackage.migrationIdentity, tx => {
    tx.insertRun({ projectId: f.projectionBinding.projectId, migrationIdentity: sealedPackage.migrationIdentity, rolloutRevisionId: revisionId,
      packageChecksum: sealedPackage.manifest.packageChecksum, sourceManifestChecksum: source.manifest.manifestChecksum,
      sourceTerminalPosition: BigInt(source.manifest.terminalEventPosition), sourceTerminalHash: source.manifest.terminalEventHash,
      configurationChecksum: sealedPackage.manifest.configurationChecksum, policyChecksum: shadowMigrationPolicyChecksum(f.policy),
      buildIdentityHash: sealedPackage.manifest.buildIdentityHash, createdAt: f.manifest.createdAt });
    let priorTransitionHash = "0".repeat(64);
    for (const [ordinal, phase] of (["snapshot-verified", "package-sealed"] as const).entries()) {
      const body = { projectId: f.projectionBinding.projectId, migrationIdentity: sealedPackage.migrationIdentity, ordinal,
        attemptId: randomUUID(), phase, priorTransitionHash, evidenceDigest: digest(phase), recordedAt: f.manifest.createdAt };
      const transitionHash = digest(`project-memory/v2-shadow-migration-transition/v1\n${canonicalJson(body)}`);
      tx.appendTransition({ ...body, transitionHash }); priorTransitionHash = transitionHash;
    }
  });
  const workspace = { kind: "non-git", workspaceRoot: f.root, workspaceId: f.projectionBinding.workspaceId };
  const context = { workspace, checkedAt: f.manifest.createdAt, binding: { ...f.projectionBinding, projectBindingId: randomUUID(), generation: 1,
    contextFingerprint: "shadow", source: "explicit-cli", clientNamespace: "shadow-test", clientInstanceId: randomUUID(), actorRole: "primary",
    projectRoot: f.root, vaultRoot: f.liveVaultRoot, descriptorPath: join(f.liveVaultRoot, ".project-memory.json"), workspace, establishedAt: f.manifest.createdAt,
    storeRoute: { kind: "vault-local", storeRoot: f.root, eventsPath: eventStorePath, storeManifestPath: join(f.root, "store.json"), projectionManifestPath: join(f.root, "projection.json") } } } as ProjectContext;
  new V2ShadowImporter({ connection, statements: new SqliteEventStoreStatements(connection), maintenance: new MaintenanceFence(),
    branchScopes: new BranchScopeRepository(), policy: f.policy }).import({ context, sealedPackage });
  repository.transact(f.projectionBinding.projectId, sealedPackage.migrationIdentity, tx => {
    const body = { projectId: f.projectionBinding.projectId, migrationIdentity: sealedPackage.migrationIdentity, ordinal: 2,
      attemptId: randomUUID(), phase: "import-committed" as const, priorTransitionHash: tx.readTransitions().at(-1)!.transitionHash,
      evidenceDigest: digest("import"), recordedAt: f.manifest.createdAt };
    tx.appendTransition({ ...body, transitionHash: digest(`project-memory/v2-shadow-migration-transition/v1\n${canonicalJson(body)}`) });
  });
  return { ...f, source, sealedPackage, connection, preparedV1, publisher, publisherOptions,
    input: { ...baselineInput, preparedV1, rolloutRevisionId: revisionId },
    phases: () => repository.transact(f.projectionBinding.projectId, sealedPackage.migrationIdentity, tx => tx.readTransitions().map(v => v.phase)) };
}

test("publishes both projection generations at the exact source position", async t => {
  const f = await fixture(t);
  const bytes = readFileSync(f.preparedV1.generation.databasePath);
  const result = await f.publisher.publishV2(f.input);
  for (const manifest of [result.v1.generation.manifest, result.v2.manifest]) {
    assert.equal(manifest.terminalEventPosition, f.sealedPackage.manifest.terminalEventPosition);
    assert.equal(manifest.terminalEventHash, f.sealedPackage.manifest.terminalEventHash);
    assert.equal(manifest.createdAt, f.sealedPackage.manifest.createdAt);
  }
  assert.equal(result.v1BaselineChecksum, f.preparedV1.baselineChecksum);
  assert.equal(v1ProjectionBaselineChecksum(result.v1.generation.manifest), f.preparedV1.baselineChecksum);
  assert.deepEqual(readFileSync(f.preparedV1.generation.databasePath), bytes);
  assert.deepEqual(f.phases(), ["snapshot-verified", "package-sealed", "import-committed", "projection-verified"]);
});

test("adopts a prepared V1 baseline without rewriting its published bytes", async t => {
  const f = await fixture(t);
  const before = readFileSync(f.preparedV1.generation.databasePath);
  const identity = lstatSync(f.preparedV1.generation.databasePath, { bigint: true });
  const repeated = await f.publisher.prepareV1Baseline(f.input);
  assert.deepEqual(repeated, f.preparedV1);
  assert.deepEqual(readFileSync(repeated.generation.databasePath), before);
  assert.equal(lstatSync(repeated.generation.databasePath, { bigint: true }).ctimeNs, identity.ctimeNs);
});

test("recovers after generation installation before baseline manifest without rewriting the image", async t => {
  const f = await fixture(t, false, true);
  assert.equal((await f.publisher.publishV2(f.input)).v1BaselineChecksum, f.preparedV1.baselineChecksum);
});

for (const sql of ["UPDATE canonical_items SET summary='tampered'", "CREATE TABLE unexpected(value TEXT)", "UPDATE projection_metadata SET created_at='2026-09-11T00:00:00.000Z'"]) {
  test(`refuses orphan adoption after ${sql.split(" ")[0]} corruption`, async t => {
    const f = await fixture(t);
    const manifestPath = join(f.preparedV1.generation.projectionDirectory, "projection-manifest.json");
    rmSync(manifestPath);
    const database = new DatabaseSync(f.preparedV1.generation.databasePath);
    try { database.exec(sql); } finally { database.close(); }
    await assert.rejects(f.publisher.prepareV1Baseline(f.input), (e: unknown) => e instanceof ShadowMigrationError && e.code === "PROJECTION_INTEGRITY_FAILURE");
    assert.equal(existsSync(manifestPath), false);
    assert.equal(f.phases().includes("projection-verified"), false);
  });
}

test("rejects an immutable revision with a different baseline", async t => {
  const f = await fixture(t, false, false, "b".repeat(64));
  await assert.rejects(f.publisher.publishV2(f.input), (e: unknown) => e instanceof ShadowMigrationError && e.code === "PROJECTION_INTEGRITY_FAILURE");
  assert.equal(f.phases().includes("projection-verified"), false);
});

for (const generation of ["V1", "V2"]) test(`does not record projection-verified after ${generation} generation tamper`, async t => {
  const f = await fixture(t, generation === "V2");
  if (generation === "V1") writeFileSync(f.preparedV1.generation.databasePath, "tampered");
  await assert.rejects(f.publisher.publishV2(f.input), (e: unknown) => e instanceof ShadowMigrationError && e.code === "PROJECTION_INTEGRITY_FAILURE");
  assert.equal(f.phases().includes("projection-verified"), false);
});

test("rejects committed wrapper tamper before projection verification", async t => {
  const f = await fixture(t);
  f.connection.exec("DROP TRIGGER events_no_update");
  f.connection.exec("UPDATE events SET payload_json='{}' WHERE global_position=1");
  await assert.rejects(f.publisher.publishV2(f.input), (e: unknown) => e instanceof ShadowMigrationError && e.code === "MIGRATION_LEDGER_INTEGRITY_FAILURE");
  assert.equal(f.phases().includes("projection-verified"), false);
});

for (const identity of ["build", "migration", "configuration"] as const) test(`rejects unrelated revision ${identity} identity`, async t => {
  const f = await fixture(t, false, false, undefined, identity);
  await assert.rejects(f.publisher.publishV2(f.input), (error: unknown) => error instanceof ShadowMigrationError && error.code === "PROJECTION_INTEGRITY_FAILURE");
  assert.equal(f.phases().includes("projection-verified"), false);
  assert.equal(existsSync(join(f.root, "v2-shadow", "projection-manifest.json")), false);
});

for (const destination of ["unrelated", "protected"] as const) test(`never transacts through an injected ${destination} repository`, async t => {
  const f = await fixture(t);
  const path = destination === "protected" ? f.liveEventStorePath : join(f.root, "unrelated.sqlite");
  const other = f.driver.open(path, { mode: destination === "protected" ? "read-only-existing" : "create", busyTimeoutMs: 5000 });
  const before = readFileSync(path);
  let transactions = 0;
  const repository = new SqliteV2ShadowMigrationRepository({
    prepare: sql => other.prepare(sql), close() {},
    exec(sql) { if (/BEGIN/i.test(sql)) transactions++; other.exec(sql); },
  });
  try {
    const options = { ...f.publisherOptions, repository };
    await new V2ShadowProjectionPublisher(options).publishV2(f.input);
    assert.equal(transactions, 0);
    assert.deepEqual(readFileSync(path), before);
    assert.equal(f.phases().includes("projection-verified"), true);
  } finally { other.close(); }
});

for (const boundary of ["private-database", "pinned-image", "v1-lease", "committed-snapshot"] as const) test(`redacts ${boundary} cleanup failure and releases remaining resources`, async t => {
  const f = await fixture(t);
  const protectedPaths = [f.sourceDatabasePath, f.liveEventStorePath, f.preparedV1.generation.databasePath]
    .flatMap(path => [path, `${path}-wal`, `${path}-shm`].filter(existsSync));
  const before = protectedPaths.map(path => readFileSync(path));
  let injected = false;
  let databaseClosed = 0;
  let pinnedClosed = 0;
  let rolledBack = false;
  let snapshotClosed = false;
  let leaseReleased = false;
  const imageIdentity = lstatSync(f.preparedV1.generation.databasePath, { bigint: true });
  const nativeClose = DatabaseSync.prototype.close;
  const fileClose = fs.closeSync;
  const spawn = childProcess.spawnSync;
  t.mock.method(DatabaseSync.prototype, "close", function(this: DatabaseSync) {
    let privateV1 = false;
    try { privateV1 = this.prepare("PRAGMA database_list").all().some(row => row.name === "main" && row.file === "")
      && this.prepare("SELECT schema_version FROM projection_metadata WHERE project_id IS NOT NULL").get()?.schema_version === 1; } catch { /* reference schema connection */ }
    nativeClose.call(this);
    if (privateV1) {
      databaseClosed++;
      if (boundary === "private-database" && !injected) { injected = true; throw new Error("sensitive-close-failure"); }
    }
  });
  t.mock.method(fs, "closeSync", (fd: number) => {
    const stat = fs.fstatSync(fd, { bigint: true });
    const pinned = stat.dev === imageIdentity.dev && stat.ino === imageIdentity.ino;
    fileClose(fd);
    if (pinned) {
      pinnedClosed++;
      assert.throws(() => fs.fstatSync(fd));
      if (boundary === "pinned-image" && !injected) { injected = true; throw new Error("sensitive-close-failure"); }
    }
  });
  t.mock.method(childProcess, "spawnSync", (...args: any[]) => {
    const result = Reflect.apply(spawn, childProcess, args);
    if (args[1]?.[2] === "release-manifest-lock" && args[1]?.[3] === f.publisherOptions.v1ProjectionDirectory) {
      assert.equal(result.status, 0);
      leaseReleased = true;
      if (boundary === "v1-lease" && !injected) { injected = true; throw new Error("sensitive-close-failure"); }
    }
    return result;
  });
  syncBuiltinESMExports();
  let armSnapshot = false;
  const publisher = new V2ShadowProjectionPublisher({ ...f.publisherOptions,
    faultInjector: { hit(point) { if (point === "before-v2-integrity") armSnapshot = true; } },
    driver: { open(path, options) {
      const connection = f.driver.open(path, options);
      if (boundary !== "committed-snapshot" || !armSnapshot || path !== f.publisherOptions.eventStorePath) return connection;
      return { prepare: sql => connection.prepare(sql),
        exec(sql) { connection.exec(sql); if (sql === "ROLLBACK") rolledBack = true; },
        close() { connection.close(); snapshotClosed = true; injected = true; throw new Error("sensitive-close-failure"); } };
    } },
  });
  try {
    // Direct integrity calls must redact cleanup errors too, not only the publisher wrapper.
    if (boundary === "private-database" || boundary === "pinned-image") {
      const service = new ProjectionIntegrityService({ driver: f.driver, eventStorePath: f.publisherOptions.eventStorePath,
        projectionDirectory: f.publisherOptions.v1ProjectionDirectory });
      assert.throws(() => service.verifyV1Generation(f.source.projectionSnapshot, f.preparedV1.generation),
        (error: unknown) => error instanceof LifecycleError && error.code === "INTEGRITY_FAILURE" && error.cause === undefined);
      assert.equal(databaseClosed, 1); assert.equal(pinnedClosed, 1);
      injected = false;
    }
    await assert.rejects(publisher.publishV2(f.input), (error: unknown) => error instanceof ShadowMigrationError
      && !JSON.stringify(error).includes("sensitive") && error.cause === undefined);
    assert.equal(injected, true);
    assert.ok(databaseClosed > 0); assert.ok(pinnedClosed > 0); assert.equal(leaseReleased, true);
    assert.equal(existsSync(join(f.publisherOptions.v1ProjectionDirectory, ".projection-manifest.publish.lock")), false);
    if (boundary === "committed-snapshot") { assert.equal(rolledBack, true); assert.equal(snapshotClosed, true); }
    assert.equal(f.phases().includes("projection-verified"), false);
    protectedPaths.forEach((path, i) => assert.deepEqual(readFileSync(path), before[i]));
    f.source.assertUnchanged(); f.sealedPackage.assertUnchanged();
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("rejects a protected source destination before consulting the target connection", async t => {
  const f = await fixture(t);
  let queries = 0;
  const connection = { exec: (sql: string) => f.connection.exec(sql), close() {},
    prepare(sql: string) { queries++; return f.connection.prepare(sql); } };
  const publisher = new V2ShadowProjectionPublisher({ driver: f.driver, connection,
    eventStorePath: f.sourceDatabasePath,
    liveEventStorePath: f.liveEventStorePath, liveVaultRoot: f.liveVaultRoot,
    v1ProjectionDirectory: f.preparedV1.generation.projectionDirectory, v2ProjectionDirectory: join(f.root, "v2-shadow"), policy: f.policy });
  await assert.rejects(publisher.publishV2(f.input), (error: unknown) => error instanceof ShadowMigrationError);
  assert.equal(queries, 0);
});

test("Task11C refuses expired shared baseline budget before semantic publication", async t => {
  const f = await fixture(t);
  const directory = join(f.root, "expired-v1"); mkdirSync(directory);
  let clock = 10;
  const invocationDeadline = createShadowMigrationInvocationDeadline(100, () => clock);
  t.after(() => invocationDeadline.dispose()); clock = 110;
  const publisher = new V2ShadowProjectionPublisher({ ...f.publisherOptions, v1ProjectionDirectory: directory });
  const input = { ...f.input, invocationDeadline };
  await assert.rejects(publisher.prepareV1Baseline(input),
    (error: unknown) => error instanceof ShadowMigrationError && error.code === "MIGRATION_RETRY_EXHAUSTED");
  assert.deepEqual(fs.readdirSync(directory), []);
});

test("Task11C phase3 uses deterministic source plus ordinal metadata", async t => {
  const f = await fixture(t);
  await f.publisher.publishV2(f.input);
  const repository = new SqliteV2ShadowMigrationRepository(f.connection);
  const phase = repository.readVerifiedTransitions(f.projectionBinding.projectId, f.sealedPackage.migrationIdentity)[3]!;
  assert.equal(phase.recordedAt, new Date(Date.parse(f.source.manifest.createdAt) + 3).toISOString());
  assert.equal(phase.attemptId, shadowMigrationPhaseMetadata(f.sealedPackage.migrationIdentity, f.source.manifest.createdAt, 3).attemptId);
});

for (const point of ["before-v1-manifest", "before-v2-integrity"] as const) test(`Task11C expiry at ${point} leaves partial durability unknown and refuses later phase writes`, async t => {
  const f = await fixture(t);
  let clock = 1000;
  const invocationDeadline = createShadowMigrationInvocationDeadline(300000, () => clock);
  t.after(() => invocationDeadline.dispose());
  const directory = join(f.root, "deadline-v1"); mkdirSync(directory);
  const publisher = new V2ShadowProjectionPublisher({ ...f.publisherOptions,
    ...(point === "before-v1-manifest" ? { v1ProjectionDirectory: directory } : {}),
    faultInjector: { hit(boundary) { if (boundary === point) clock += 300000; } } });
  const input = { ...f.input, invocationDeadline };
  await assert.rejects(point === "before-v1-manifest" ? publisher.prepareV1Baseline(input) : publisher.publishV2(input),
    (error: unknown) => error instanceof ShadowMigrationError && error.code === "MIGRATION_OUTCOME_UNKNOWN");
  assert.equal(f.phases().includes("projection-verified"), false);
  if (point === "before-v1-manifest") {
    assert.equal(existsSync(join(directory, "projections-1-1.sqlite")), true);
    assert.equal(existsSync(join(directory, "projection-manifest.json")), false);
    assert.equal(existsSync(join(directory, ".projection-manifest.publish.lock")), false);
  } else assert.equal(existsSync(join(f.publisherOptions.v2ProjectionDirectory, "projection-manifest.json")), true);
  f.source.assertUnchanged(); f.sealedPackage.assertUnchanged();
});

test("Task11C awaits a real pending snapshot then closes it once on expiry", async t => {
  const f = await fixture(t);
  let clock = 0;
  const invocationDeadline = createShadowMigrationInvocationDeadline(300000, () => clock);
  t.after(() => invocationDeadline.dispose());
  let settle!: () => void; let acquired!: () => void;
  const pending = new Promise<void>(resolve => { settle = resolve; });
  const opened = new Promise<void>(resolve => { acquired = resolve; });
  let closes = 0;
  const open = V2ImportedProjectionEventReader.prototype.openCommittedSnapshot;
  t.mock.method(V2ImportedProjectionEventReader.prototype, "openCommittedSnapshot", async function(this: V2ImportedProjectionEventReader, binding: ProjectionEventSnapshot["binding"]) {
    const snapshot = await open.call(this, binding);
    acquired(); await pending;
    return Object.freeze({ ...snapshot, close() { closes++; snapshot.close(); } }) satisfies ProjectionEventSnapshot;
  });
  let completed = false;
  const outcome = f.publisher.publishV2({ ...f.input, invocationDeadline }).finally(() => { completed = true; });
  const refused = assert.rejects(outcome, (error: unknown) => error instanceof ShadowMigrationError && error.code === "MIGRATION_OUTCOME_UNKNOWN");
  await opened; clock = 300000;
  await Promise.resolve(); assert.equal(completed, false); assert.equal(closes, 0);
  settle(); await refused;
  assert.equal(closes, 1); assert.equal(f.phases().includes("projection-verified"), false);
  assert.equal(existsSync(join(f.publisherOptions.v2ProjectionDirectory, "projection-manifest.json")), false);
  assert.equal(existsSync(join(f.publisherOptions.v2ProjectionDirectory, ".projection-manifest.publish.lock")), false);
});

for (const kind of ["unbound", "forged", "closed", "wrong-target"] as const) test(`Task11C shared invocation refuses ${kind} target authority`, async t => {
  const f = await fixture(t);
  const raw = f.driver.open(f.publisherOptions.eventStorePath, { mode: "existing", busyTimeoutMs: 5000,
    ...(kind === "closed" ? { bindFileIdentity: true } : {}) });
  if (kind === "closed") raw.close();
  let queries = 0;
  const forged = { prepare(sql: string) { queries++; return f.connection.prepare(sql); }, exec(sql: string) { queries++; f.connection.exec(sql); }, close() {} };
  const invocationDeadline = createShadowMigrationInvocationDeadline(300000); t.after(() => invocationDeadline.dispose());
  const publisher = new V2ShadowProjectionPublisher({ ...f.publisherOptions,
    connection: kind === "forged" ? forged : kind === "wrong-target" ? f.connection : raw,
    ...(kind === "wrong-target" ? { eventStorePath: f.liveEventStorePath } : {}) });
  try {
    for (const action of [() => publisher.publishV2({ ...f.input, invocationDeadline }),
      () => publisher.prepareV1Baseline({ ...f.input, invocationDeadline }),
      () => publisher.reconcileV1Baseline(f.input), () => publisher.reconcileV2(f.input)]) {
      await assert.rejects(action(), (error: unknown) => error instanceof ShadowMigrationError && error.code === "MIGRATION_IDENTITY_CONFLICT");
    }
    assert.equal(queries, 0); assert.equal(f.phases().includes("projection-verified"), false);
  } finally { if (kind !== "closed") raw.close(); }
});

function projectionEvidence(directory: string) {
  return fs.readdirSync(directory).sort().map(name => {
    const path = join(directory, name); const stat = lstatSync(path, { bigint: true });
    return { name, inode: String(stat.ino), ctime: String(stat.ctimeNs), bytes: stat.isFile() ? digest(readFileSync(path)) : null };
  });
}

function forbidProjectionWrites(t: test.TestContext, publisher: V2ShadowProjectionPublisher, connection?: SqliteConnection): void {
  let writes = 0;
  const forbidden = () => { writes++; assert.fail("read-only proof called a semantic publication/recovery operation"); };
  t.after(() => assert.equal(writes, 0));
  if (connection) {
    const prototype = Object.getPrototypeOf(connection) as SqliteConnection;
    const prepare = prototype.prepare; const exec = prototype.exec;
    const observe = (sql: string) => { if (!/^\s*(SELECT\b|PRAGMA database_list\s*$|BEGIN IMMEDIATE\s*$|COMMIT\s*$|ROLLBACK\s*$)/iu.test(sql)) writes++; };
    t.mock.method(prototype, "prepare", function(this: SqliteConnection, sql: string) {
      if (this === connection) observe(sql);
      return prepare.call(this, sql);
    });
    t.mock.method(prototype, "exec", function(this: SqliteConnection, sql: string) {
      if (this === connection) observe(sql);
      return exec.call(this, sql);
    });
  }
  t.mock.method(publisher, "prepareV1Baseline", forbidden);
  t.mock.method(publisher, "publishV2", forbidden);
  t.mock.method(ImmutableProjectionBuilder.prototype, "build", forbidden);
  t.mock.method(ImmutableProjectionBuilder.prototype, "buildV2", forbidden);
  t.mock.method(V2ProjectionBuildCoordinator.prototype, "ensurePublished", forbidden);
  t.mock.method(ProjectionIntegrityService.prototype, "recoverV1Generation", forbidden);
}

test("Task11C proves existing V1 and V2 publication read-only with frozen complete results", async t => {
  const f = await fixture(t);
  const result = await f.publisher.publishV2(f.input);
  const before = [projectionEvidence(f.publisherOptions.v1ProjectionDirectory), projectionEvidence(f.publisherOptions.v2ProjectionDirectory), f.phases()];
  forbidProjectionWrites(t, f.publisher, f.connection);
  const v1 = await f.publisher.reconcileV1Baseline(f.input);
  assert.deepEqual(v1, { status: "committed", result: f.preparedV1 });
  const v2 = await f.publisher.reconcileV2(f.input);
  assert.deepEqual(v2, { status: "committed", result });
  assert.ok(v1?.status === "committed"); assert.ok(v2?.status === "committed");
  assert.equal(Object.isFrozen(v1), true); assert.equal(Object.isFrozen(v1.result), true);
  assert.equal(Object.isFrozen(v2), true); assert.equal(Object.isFrozen(v2.result), true);
  assert.deepEqual([projectionEvidence(f.publisherOptions.v1ProjectionDirectory), projectionEvidence(f.publisherOptions.v2ProjectionDirectory), f.phases()], before);
});

for (const state of ["absent", "orphan", "manifest-only", "contradictory"] as const) test(`Task11C V1 read-only proof classifies ${state}`, async t => {
  const f = await fixture(t);
  const directory = f.publisherOptions.v1ProjectionDirectory;
  const manifestPath = join(directory, "projection-manifest.json");
  if (state === "absent" || state === "orphan") rmSync(manifestPath);
  if (state === "absent" || state === "manifest-only") rmSync(f.preparedV1.generation.databasePath);
  if (state === "contradictory") writeFileSync(f.preparedV1.generation.databasePath, "contradictory-image");
  const before = projectionEvidence(directory);
  forbidProjectionWrites(t, f.publisher, f.connection);
  const read = () => f.publisher.reconcileV1Baseline(f.input);
  if (state === "contradictory") await assert.rejects(async () => read(), (error: unknown) => error instanceof ShadowMigrationError && error.code === "PROJECTION_INTEGRITY_FAILURE");
  else {
    const result = await read();
    assert.deepEqual(result, state === "absent" ? { status: "absent" } : { status: "unknown", safeErrorCode: "MIGRATION_OUTCOME_UNKNOWN" });
    assert.equal(Object.isFrozen(result), true);
  }
  assert.deepEqual(projectionEvidence(directory), before);
});

test("Task11C V2 read-only proof distinguishes absent from manifest-before-phase3", async t => {
  const f = await fixture(t);
  const publisher = new V2ShadowProjectionPublisher({ ...f.publisherOptions,
    faultInjector: { hit(point) { if (point === "before-v2-integrity") throw new ShadowMigrationError("MIGRATION_OUTCOME_UNKNOWN"); } } });
  assert.deepEqual(await publisher.reconcileV2(f.input), { status: "absent" });
  await assert.rejects(publisher.publishV2(f.input), (error: unknown) => error instanceof ShadowMigrationError && error.code === "MIGRATION_OUTCOME_UNKNOWN");
  const before = projectionEvidence(f.publisherOptions.v2ProjectionDirectory);
  assert.equal(existsSync(join(f.publisherOptions.v2ProjectionDirectory, "projection-manifest.json")), true);
  forbidProjectionWrites(t, publisher, f.connection);
  assert.deepEqual(await publisher.reconcileV2(f.input), { status: "unknown", safeErrorCode: "MIGRATION_OUTCOME_UNKNOWN" });
  assert.deepEqual(projectionEvidence(f.publisherOptions.v2ProjectionDirectory), before);
  assert.equal(f.phases().includes("projection-verified"), false);
});

test("Task11C verifier native read uncertainty stays unknown without semantic writes", async t => {
  const f = await fixture(t);
  const image = lstatSync(f.preparedV1.generation.databasePath, { bigint: true });
  const read = fs.readSync;
  let injected = false; let inVerifier = false;
  const verify = ProjectionIntegrityService.prototype.verifyV1Generation;
  t.mock.method(ProjectionIntegrityService.prototype, "verifyV1Generation", function(this: ProjectionIntegrityService, ...args: Parameters<typeof verify>) {
    inVerifier = true; try { return verify.apply(this, args); } finally { inVerifier = false; }
  });
  t.mock.method(fs, "readSync", (...args: any[]) => {
    const stat = fs.fstatSync(args[0], { bigint: true });
    if (inVerifier && !injected && stat.dev === image.dev && stat.ino === image.ino) {
      injected = true; throw Object.assign(new Error("sensitive native read"), { code: "EIO" });
    }
    return Reflect.apply(read, fs, args);
  });
  syncBuiltinESMExports();
  const before = projectionEvidence(f.publisherOptions.v1ProjectionDirectory);
  forbidProjectionWrites(t, f.publisher, f.connection);
  try {
    assert.deepEqual(await f.publisher.reconcileV1Baseline(f.input), { status: "unknown", safeErrorCode: "MIGRATION_OUTCOME_UNKNOWN" });
    assert.equal(injected, true);
    assert.deepEqual(projectionEvidence(f.publisherOptions.v1ProjectionDirectory), before);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal((await f.publisher.reconcileV1Baseline(f.input)).status, "committed");
});

test("Task11C missing projection roots are observed absent without creation", async t => {
  const f = await fixture(t);
  const missingV1 = join(f.root, "never-created-v1");
  const missingV2 = join(f.root, "never-created-v2");
  const v1 = new V2ShadowProjectionPublisher({ ...f.publisherOptions, v1ProjectionDirectory: missingV1 });
  const v2 = new V2ShadowProjectionPublisher({ ...f.publisherOptions, v2ProjectionDirectory: missingV2 });
  forbidProjectionWrites(t, v1, f.connection); t.mock.method(v2, "publishV2", () => assert.fail("proof published"));
  assert.deepEqual(await v1.reconcileV1Baseline(f.input), { status: "absent" });
  assert.deepEqual(await v2.reconcileV2(f.input), { status: "absent" });
  assert.equal(existsSync(missingV1), false); assert.equal(existsSync(missingV2), false);
});

for (const state of ["orphan", "manifest-only", "phase-only", "contradictory"] as const) test(`Task11C V2 read-only proof preserves ${state} state`, async t => {
  const f = await fixture(t);
  const published = await f.publisher.publishV2(f.input);
  const directory = f.publisherOptions.v2ProjectionDirectory;
  if (state === "orphan" || state === "phase-only") rmSync(join(directory, "projection-manifest.json"));
  if (state === "manifest-only" || state === "phase-only") rmSync(published.v2.databasePath);
  if (state === "contradictory") writeFileSync(published.v2.databasePath, "contradictory-image");
  const before = projectionEvidence(directory); const phases = f.phases();
  forbidProjectionWrites(t, f.publisher, f.connection);
  if (state === "contradictory") await assert.rejects(f.publisher.reconcileV2(f.input),
    (error: unknown) => error instanceof ShadowMigrationError && error.code === "PROJECTION_INTEGRITY_FAILURE");
  else assert.deepEqual(await f.publisher.reconcileV2(f.input), { status: "unknown", safeErrorCode: "MIGRATION_OUTCOME_UNKNOWN" });
  assert.deepEqual(projectionEvidence(directory), before); assert.deepEqual(f.phases(), phases);
});

test("Task11C keeps primary refusal through actual lease release response failure", async t => {
  const f = await fixture(t);
  const directory = join(f.root, "primary-cleanup-v1"); mkdirSync(directory);
  const spawn = childProcess.spawnSync; let released = 0;
  t.mock.method(childProcess, "spawnSync", (...args: any[]) => {
    const result = Reflect.apply(spawn, childProcess, args);
    if (args[1]?.[2] === "release-manifest-lock" && args[1]?.[3] === directory) {
      assert.equal(result.status, 0); released++; throw new Error("secondary cleanup response failure");
    }
    return result;
  });
  syncBuiltinESMExports();
  try {
    const publisher = new V2ShadowProjectionPublisher({ ...f.publisherOptions, v1ProjectionDirectory: directory,
      faultInjector: { hit(point) { if (point === "before-v1-manifest") throw new ShadowMigrationError("MIGRATION_SOURCE_MUTATED"); } } });
    await assert.rejects(publisher.prepareV1Baseline(f.input), (error: unknown) => error instanceof ShadowMigrationError && error.code === "MIGRATION_SOURCE_MUTATED");
    assert.equal(released, 1); assert.equal(existsSync(join(directory, ".projection-manifest.publish.lock")), false);
    assert.equal(existsSync(join(directory, "projection-manifest.json")), false);
    f.source.assertUnchanged(); f.sealedPackage.assertUnchanged();
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("Task11C native snapshot and integrity timeouts use the remaining shared budget", async t => {
  const f = await fixture(t);
  let clock = 4000; let armed = false;
  const invocationDeadline = createShadowMigrationInvocationDeadline(300000, () => clock);
  t.after(() => invocationDeadline.dispose());
  const opened: number[] = []; const nativeTimeouts: number[] = [];
  const exec = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
    if (armed) { const timeout = /PRAGMA busy_timeout\s*=\s*(\d+)/.exec(sql); if (timeout) nativeTimeouts.push(Number(timeout[1])); }
    return exec.call(this, sql);
  });
  const publisher = new V2ShadowProjectionPublisher({ ...f.publisherOptions,
    driver: { open(path, options) {
      if (armed && path === f.publisherOptions.eventStorePath && options.mode === "read-only-existing") opened.push(options.busyTimeoutMs);
      return f.driver.open(path, options);
    } }, faultInjector: { hit(point) { if (point === "before-v2-integrity") { clock = 303877; armed = true; } } } });
  await publisher.publishV2({ ...f.input, invocationDeadline });
  assert.deepEqual(opened, [123]); assert.ok(nativeTimeouts.includes(123));
  assert.ok(nativeTimeouts.every(value => value <= 123));
});

test("Task11C does not replace a captured invocation deadline when caller input changes", async t => {
  const f = await fixture(t);
  let clock = 0;
  const original = createShadowMigrationInvocationDeadline(300000, () => clock);
  const replacement = createShadowMigrationInvocationDeadline(300000);
  t.after(() => { original.dispose(); replacement.dispose(); });
  const input = { ...f.input, invocationDeadline: original };
  const publisher = new V2ShadowProjectionPublisher({ ...f.publisherOptions, faultInjector: { hit(point) {
    if (point === "before-v2-integrity") { clock = 300000; input.invocationDeadline = replacement; }
  } } });
  await assert.rejects(publisher.publishV2(input), (error: unknown) => error instanceof ShadowMigrationError && error.code === "MIGRATION_OUTCOME_UNKNOWN");
  assert.equal(f.phases().includes("projection-verified"), false);
});

test("Task11C phase transaction refuses expiry after reads before append", async t => {
  const f = await fixture(t);
  let clock = 0; let reads = 0; let writes = 0;
  const invocationDeadline = createShadowMigrationInvocationDeadline(300000, () => clock);
  t.after(() => invocationDeadline.dispose());
  const prototype = Object.getPrototypeOf(f.connection) as SqliteConnection;
  const prepare = prototype.prepare;
  const observation = t.mock.method(prototype, "prepare", function (this: SqliteConnection, sql: string) {
    const statement = prepare.call(this, sql);
    if (this !== f.connection) return statement;
    const observed: SqliteStatement = {
      get: params => statement.get(params), iterate: params => statement.iterate(params),
      all(params) { const result = statement.all(params); if (sql.includes("FROM v2_shadow_migration_transitions")) { reads++; if (reads === 3) clock = 300000; } return result; },
      run(params) { if (sql.startsWith("INSERT INTO v2_shadow_migration_transitions")) writes++; return statement.run(params); },
    };
    return observed;
  });
  try {
    await assert.rejects(f.publisher.publishV2({ ...f.input, invocationDeadline }),
    (error: unknown) => error instanceof ShadowMigrationError && error.code === "MIGRATION_OUTCOME_UNKNOWN");
    assert.equal(reads, 3); assert.equal(writes, 0); assert.equal(f.phases().includes("projection-verified"), false);
  } finally { observation.mock.restore(); }
});

test("Task11C lost V1 publication response is unknown with its real orphan preserved", async t => {
  const f = await fixture(t);
  const directory = join(f.root, "lost-response-v1"); mkdirSync(directory);
  const publisher = new V2ShadowProjectionPublisher({ ...f.publisherOptions, v1ProjectionDirectory: directory,
    faultInjector: { hit(point) { if (point === "before-v1-manifest") throw new Error("lost response"); } } });
  await assert.rejects(publisher.prepareV1Baseline(f.input), (error: unknown) => error instanceof ShadowMigrationError && error.code === "MIGRATION_OUTCOME_UNKNOWN");
  const before = projectionEvidence(directory);
  assert.deepEqual(await publisher.reconcileV1Baseline(f.input), { status: "unknown", safeErrorCode: "MIGRATION_OUTCOME_UNKNOWN" });
  assert.deepEqual(projectionEvidence(directory), before);
});

for (const field of ["attemptId", "recordedAt", "evidenceDigest"] as const) test(`Task11C refuses contradictory phase3 ${field} during adoption and proof`, async t => {
  const f = await fixture(t);
  const publisher = new V2ShadowProjectionPublisher({ ...f.publisherOptions,
    faultInjector: { hit(point) { if (point === "before-v2-integrity") throw new ShadowMigrationError("MIGRATION_OUTCOME_UNKNOWN"); } } });
  await assert.rejects(publisher.publishV2(f.input));
  const manifest = JSON.parse(readFileSync(join(f.publisherOptions.v2ProjectionDirectory, "projection-manifest.json"), "utf8"));
  const v2ManifestChecksum = digest(canonicalJson(manifest));
  const evidenceDigest = digest(canonicalJson({ v1ManifestChecksum: digest(canonicalJson(f.preparedV1.generation.manifest)), v2ManifestChecksum, v1BaselineChecksum: f.preparedV1.baselineChecksum }));
  const repository = new SqliteV2ShadowMigrationRepository(f.connection);
  repository.transact(f.projectionBinding.projectId, f.sealedPackage.migrationIdentity, tx => {
    const body = { projectId: f.projectionBinding.projectId, migrationIdentity: f.sealedPackage.migrationIdentity, ordinal: 3,
      ...shadowMigrationPhaseMetadata(f.sealedPackage.migrationIdentity, f.source.manifest.createdAt, 3),
      phase: "projection-verified" as const, priorTransitionHash: tx.readTransitions()[2]!.transitionHash, evidenceDigest,
      [field]: field === "attemptId" ? randomUUID() : field === "recordedAt" ? f.source.manifest.createdAt : digest("wrong-evidence") };
    tx.appendTransition({ ...body, transitionHash: digest(`project-memory/v2-shadow-migration-transition/v1\n${canonicalJson(body)}`) });
  });
  const phases = repository.readVerifiedTransitions(f.projectionBinding.projectId, f.sealedPackage.migrationIdentity);
  for (const [normal, action] of [[true, () => f.publisher.publishV2(f.input)], [false, () => f.publisher.reconcileV2(f.input)]] as const) {
    const before = projectionEvidence(f.publisherOptions.v2ProjectionDirectory);
    await assert.rejects(action(), (error: unknown) => error instanceof ShadowMigrationError && error.code === "PROJECTION_INTEGRITY_FAILURE");
    assert.deepEqual(repository.readVerifiedTransitions(f.projectionBinding.projectId, f.sealedPackage.migrationIdentity), phases);
    const after = projectionEvidence(f.publisherOptions.v2ProjectionDirectory);
    // Normal coordinator adoption may advance its journal; proofs may not.
    const published = (entries: typeof before) => entries.filter(entry => entry.name !== "projection-reconciliation-v2.json");
    assert.deepEqual(normal ? published(after) : after, normal ? published(before) : before);
  }
  rmSync(join(f.publisherOptions.v2ProjectionDirectory, manifest.databaseFile));
  forbidProjectionWrites(t, f.publisher, f.connection);
  await assert.rejects(f.publisher.reconcileV2(f.input), (error: unknown) => error instanceof ShadowMigrationError && error.code === "PROJECTION_INTEGRITY_FAILURE");
  assert.deepEqual(repository.readVerifiedTransitions(f.projectionBinding.projectId, f.sealedPackage.migrationIdentity), phases);
});

test("Task11C refuses retained-input expiry before the next input assertion", async t => {
  const f = await fixture(t);
  let clock = 0; let packageAssertions = 0;
  const invocationDeadline = createShadowMigrationInvocationDeadline(300000, () => clock);
  try {
    const input = { ...f.input, invocationDeadline,
      source: { ...f.source, assertUnchanged() { f.source.assertUnchanged(); clock = 300000; } },
      sealedPackage: { ...f.sealedPackage, assertUnchanged() { packageAssertions++; f.sealedPackage.assertUnchanged(); } } };
    await assert.rejects(f.publisher.prepareV1Baseline(input), (error: unknown) => error instanceof ShadowMigrationError && error.code === "MIGRATION_RETRY_EXHAUSTED");
    assert.equal(packageAssertions, 0);
  } finally { invocationDeadline.dispose(); }
});

test("Task11C identical source and prior chain produce identical phase3 under different monotonic origins", async t => {
  const f = await fixture(t);
  f.connection.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const path = join(f.root, "second-target.sqlite"); fs.copyFileSync(f.publisherOptions.eventStorePath, path);
  const connection = f.driver.open(path, { mode: "existing", busyTimeoutMs: 5000, bindFileIdentity: true });
  try {
    const directory = join(f.root, "second-v2"); mkdirSync(directory);
    const first = new V2ShadowProjectionPublisher({ ...f.publisherOptions, operationNow: () => 100 });
    const second = new V2ShadowProjectionPublisher({ ...f.publisherOptions, connection, eventStorePath: path, v2ProjectionDirectory: directory, operationNow: () => 8000000 });
    const a = await first.publishV2(f.input); const b = await second.publishV2(f.input);
    const aPhase = new SqliteV2ShadowMigrationRepository(f.connection).readVerifiedTransitions(f.projectionBinding.projectId, f.sealedPackage.migrationIdentity)[3];
    const bPhase = new SqliteV2ShadowMigrationRepository(connection).readVerifiedTransitions(f.projectionBinding.projectId, f.sealedPackage.migrationIdentity)[3];
    assert.deepEqual(aPhase, bPhase); assert.deepEqual(a.v2.manifest, b.v2.manifest);
  } finally { connection.close(); }
});
