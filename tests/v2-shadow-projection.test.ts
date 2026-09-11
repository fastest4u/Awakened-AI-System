import assert from "node:assert/strict";
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
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { BranchScopeRepository } from "../src/orchestrator/storage/branch-scope.repository.js";
import { SqliteEventStoreStatements } from "../src/orchestrator/storage/event-store.js";
import { MaintenanceFence } from "../src/orchestrator/storage/maintenance-fence.js";
import { v2ShadowMigration } from "../src/orchestrator/storage/migrations/0007-v2-shadow-migration.js";
import { SqliteV2ShadowMigrationRepository } from "../src/orchestrator/storage/v2-shadow-migration.repository.js";
import { applyCurrentProjectStoreSchema } from "./support/current-project-store-schema.js";
import { createV2ShadowMigrationFixture, digest } from "./support/v2-shadow-migration-fixture.js";

async function fixture(t: test.TestContext, corruptV2 = false, crashV1 = false, revisionBaseline?: string) {
  let cleanup = () => {};
  t.after(() => cleanup());
  const f = await createV2ShadowMigrationFixture(t);
  const source = await verifyV1SourceCopy(f.verificationInput);
  const sealedPackage = await sealV2MigrationPackage({ ...f.packageInput, source, packageRoot: f.packageRootA });
  const v1Directory = join(f.root, "v1-reference");
  const v2Directory = join(f.root, "v2-shadow");
  mkdirSync(v1Directory); mkdirSync(v2Directory);
  const eventStorePath = join(f.root, "target.sqlite");
  const connection = f.driver.open(eventStorePath, { mode: "create", busyTimeoutMs: 5000 });
  cleanup = () => { connection.close(); sealedPackage.close(); source.close(); };
  applyCurrentProjectStoreSchema(connection, f.projectionBinding, f.manifest.createdAt);
  connection.exec(v2ShadowMigration.sql);
  const repository = new SqliteV2ShadowMigrationRepository(connection);
  let crashPending = crashV1;
  const publisher = new V2ShadowProjectionPublisher({ driver: f.driver, connection, repository, eventStorePath,
    liveEventStorePath: f.liveEventStorePath, liveVaultRoot: f.liveVaultRoot,
    v1ProjectionDirectory: v1Directory, v2ProjectionDirectory: v2Directory, policy: f.policy,
    faultInjector: { hit(boundary: string, path: string) {
      if (corruptV2 && boundary === "before-v2-integrity") writeFileSync(path, "tampered");
      if (crashPending && boundary === "before-v1-manifest") { crashPending = false; throw new Error("crash"); }
    } } });
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
  connection.prepare("INSERT INTO rollout_revisions(project_id,revision_id,parent_revision_id,build_identity_hash,migration_identity_hash,configuration_checksum,v1_baseline_checksum,cohort_algorithm_version,cohort_salt,cohort_basis_points,created_at) VALUES ($p,$r,NULL,$h,$h,$h,$b,1,$h,0,$n)")
    .run({ $p: f.projectionBinding.projectId, $r: revisionId, $h: "a".repeat(64), $b: revisionBaseline ?? preparedV1.baselineChecksum, $n: f.manifest.createdAt });
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
    branchScopes: new BranchScopeRepository(), repository, policy: f.policy }).import({ context, sealedPackage });
  repository.transact(f.projectionBinding.projectId, sealedPackage.migrationIdentity, tx => {
    const body = { projectId: f.projectionBinding.projectId, migrationIdentity: sealedPackage.migrationIdentity, ordinal: 2,
      attemptId: randomUUID(), phase: "import-committed" as const, priorTransitionHash: tx.readTransitions().at(-1)!.transitionHash,
      evidenceDigest: digest("import"), recordedAt: f.manifest.createdAt };
    tx.appendTransition({ ...body, transitionHash: digest(`project-memory/v2-shadow-migration-transition/v1\n${canonicalJson(body)}`) });
  });
  return { ...f, source, sealedPackage, connection, preparedV1, publisher,
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

test("rejects a protected source destination before consulting the target connection", async t => {
  const f = await fixture(t);
  let queries = 0;
  const connection = { exec: (sql: string) => f.connection.exec(sql), close() {},
    prepare(sql: string) { queries++; return f.connection.prepare(sql); } };
  const publisher = new V2ShadowProjectionPublisher({ driver: f.driver, connection,
    repository: new SqliteV2ShadowMigrationRepository(connection), eventStorePath: f.sourceDatabasePath,
    liveEventStorePath: f.liveEventStorePath, liveVaultRoot: f.liveVaultRoot,
    v1ProjectionDirectory: f.preparedV1.generation.projectionDirectory, v2ProjectionDirectory: join(f.root, "v2-shadow"), policy: f.policy });
  await assert.rejects(publisher.publishV2(f.input), (error: unknown) => error instanceof ShadowMigrationError);
  assert.equal(queries, 0);
});
