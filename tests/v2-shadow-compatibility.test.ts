import assert from "node:assert/strict";
import { lstatSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ShadowMigrationError } from "../src/orchestrator/migration/v2-shadow-migration.contracts.js";
import { createCompatibilityFixture } from "./support/v2-shadow-migration-fixture.js";
import { createHash } from "node:crypto";
import { deterministicMigrationUuid } from "../src/orchestrator/migration/v2-shadow-migration.contracts.js";
import type { SqliteConnection } from "../src/orchestrator/storage/sqlite-driver.js";

const moduleUrl = new URL("../src/orchestrator/materialization/v2-shadow-compatibility.materializer.js", import.meta.url).href;
test("publishes exact committed artifact bytes below only the isolated root and proves a complete no-op", async t => {
  const { V2ShadowCompatibilityMaterializer } = await import(moduleUrl);
  const f = await createCompatibilityFixture(t), materializer = new V2ShadowCompatibilityMaterializer(f.materializerOptions);
  const liveIdentity = lstatSync(f.liveVaultRoot, { bigint: true }), before = readdirSync(f.liveVaultRoot);
  const result = await materializer.materializePending(f.input);
  assert.equal(result.acknowledgedCount, 2); assert.equal(result.highestAcknowledgedSourceOrdinal, 3);
  assert.equal(result.acknowledgedImportedPosition, 4n); assert.equal(result.materializationRevision, 4n);
  assert.equal(readFileSync(join(f.isolatedRoot, "legacy/one.md"), "utf8"), "# Decision\nKeep V1 authoritative.\n");
  assert.equal(readFileSync(join(f.isolatedRoot, "legacy/two.md"), "utf8"), "# Insight\nตรวจสอบ immutable copy.\n");
  const inode = lstatSync(join(f.isolatedRoot, "legacy/one.md"), { bigint: true }).ino;
  const replay = await materializer.materializePending(f.input);
  assert.deepEqual(replay, { ...result, deduplicated: true });
  assert.equal(lstatSync(join(f.isolatedRoot, "legacy/one.md"), { bigint: true }).ino, inode);
  assert.deepEqual(f.repository.transact(f.projectionBinding.projectId, f.sealedPackage.migrationIdentity, tx => tx.readPendingCompatibility()), []);
  assert.deepEqual(readdirSync(f.liveVaultRoot), before); assert.equal(lstatSync(f.liveVaultRoot, { bigint: true }).ino, liveIdentity.ino);
});

test("rejects the live vault and refuses a lagged completed target without restoring deleted bytes", async t => {
  const { V2ShadowCompatibilityMaterializer } = await import(moduleUrl);
  const f = await createCompatibilityFixture(t);
  await assert.rejects(new V2ShadowCompatibilityMaterializer({ ...f.materializerOptions, isolatedRoot: f.liveVaultRoot }).materializePending(f.input),
    (error: unknown) => error instanceof ShadowMigrationError && error.code === "COMPATIBILITY_INTEGRITY_FAILURE");
  const materializer = new V2ShadowCompatibilityMaterializer(f.materializerOptions);
  await materializer.materializePending(f.input); unlinkSync(join(f.isolatedRoot, "legacy/one.md"));
  await assert.rejects(materializer.materializePending(f.input));
  assert.deepEqual(readdirSync(join(f.isolatedRoot, "legacy")), ["two.md"]);
});

test("authenticates zero-artifact imports and returns null maxima and an empty-set checksum", async t => {
  const { V2ShadowCompatibilityMaterializer } = await import(moduleUrl);
  const f = await createCompatibilityFixture(t, { legacyArtifacts: false });
  const materializer = new V2ShadowCompatibilityMaterializer(f.materializerOptions);
  const result = await materializer.materializePending(f.input);
  assert.equal(result.acknowledgedCount, 0); assert.equal(result.aggregateBytes, 0);
  assert.equal(result.highestAcknowledgedSourceOrdinal, null); assert.equal(result.acknowledgedImportedPosition, null);
  assert.equal(result.materializationRevision, null); assert.equal(result.artifactSetChecksum, "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945");
  assert.deepEqual(await materializer.materializePending(f.input), result);
});

test("reconciles replacement before acknowledgement failure without rewriting installed bytes or exposing plaintext", async t => {
  const { V2ShadowCompatibilityMaterializer } = await import(moduleUrl);
  const f = await createCompatibilityFixture(t); let interrupt = true;
  const connection: SqliteConnection = { close: () => f.connection.close(), exec: sql => f.connection.exec(sql), prepare(sql) {
    if (interrupt && sql.startsWith("INSERT INTO v2_shadow_compatibility_acknowledgements")) throw new Error("sensitive bytes and absolute target must not escape");
    return f.connection.prepare(sql);
  } };
  const materializer = new V2ShadowCompatibilityMaterializer({ ...f.materializerOptions, connection });
  await assert.rejects(materializer.materializePending(f.input), (error: unknown) => {
    assert.ok(error instanceof ShadowMigrationError); assert.equal(error.code, "MIGRATION_OUTCOME_UNKNOWN");
    assert.doesNotMatch(JSON.stringify(error) + error.message, /sensitive|absolute target|Keep V1|ตรวจสอบ/); return true;
  });
  const target = join(f.isolatedRoot, "legacy/one.md"), inode = lstatSync(target, { bigint: true }).ino;
  assert.equal(f.repository.transact(f.projectionBinding.projectId, f.sealedPackage.migrationIdentity, tx => tx.readCompatibilityAcknowledgements()).length, 0);
  interrupt = false; const recovered = await materializer.materializePending(f.input);
  assert.equal(recovered.acknowledgedCount, 2); assert.equal(lstatSync(target, { bigint: true }).ino, inode);
});

test("rejects wrong deterministic claims and missing targets for prior claims without mutation", async t => {
  for (const variant of ["owner", "claim-id", "time", "missing-target"] as const) await t.test(variant, async child => {
    const { V2ShadowCompatibilityMaterializer } = await import(moduleUrl); const f = await createCompatibilityFixture(child);
    const ordinal = 2, migration = f.sealedPackage.migrationIdentity, id = deterministicMigrationUuid("claim", migration, ordinal);
    f.repository.transact(f.projectionBinding.projectId, migration, tx => tx.claimCompatibility({ projectId: f.projectionBinding.projectId,
      migrationIdentity: migration, outboxId: id, claimId: variant === "claim-id" ? deterministicMigrationUuid("claim", migration, 30) : id,
      claimOwnerFingerprint: variant === "owner" ? "f".repeat(64) : createHash("sha256").update(`project-memory/v2-shadow-compatibility-owner/v1\n${migration}`).digest("hex"),
      claimedAt: variant === "time" ? "2026-09-10T00:00:01.000Z" : "2026-09-10T00:00:00.002Z" }));
    await assert.rejects(new V2ShadowCompatibilityMaterializer(f.materializerOptions).materializePending(f.input));
    assert.deepEqual(readdirSync(f.isolatedRoot), []);
    assert.equal(f.repository.transact(f.projectionBinding.projectId, migration, tx => tx.readCompatibilityAcknowledgements()).length, 0);
  });
});

test("refuses the wrong connected store and a noncanonical acknowledgement clock before claims", async t => {
  const { V2ShadowCompatibilityMaterializer } = await import(moduleUrl); const f = await createCompatibilityFixture(t);
  const other = await createCompatibilityFixture(t);
  for (const options of [{ ...f.materializerOptions, connection: other.connection },
    { ...f.materializerOptions, acknowledgementNow: () => "2026-09-10T00:00:01.000Z" }]) {
    await assert.rejects(new V2ShadowCompatibilityMaterializer(options).materializePending(f.input));
    assert.deepEqual(readdirSync(f.isolatedRoot), []);
    assert.equal(f.repository.transact(f.projectionBinding.projectId, f.sealedPackage.migrationIdentity, tx => tx.readCompatibilityClaims()).length, 0);
  }
});

test("rejects missing and extra complete outbox evidence before publishing any target", async t => {
  for (const variant of ["missing", "extra-source-kind"] as const) await t.test(variant, async child => {
    const { V2ShadowCompatibilityMaterializer } = await import(moduleUrl); const f = await createCompatibilityFixture(child);
    if (variant === "missing") {
      // Simulate a corrupted isolated ledger, preserving authenticated events and import receipts.
      const triggers = f.connection.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='v2_shadow_compatibility_outbox'").all();
      for (const trigger of triggers) f.connection.exec(`DROP TRIGGER "${String(trigger.name).replace(/"/g, '""')}"`);
      f.connection.exec("DELETE FROM v2_shadow_compatibility_outbox WHERE source_ordinal=2");
    } else f.repository.transact(f.projectionBinding.projectId, f.sealedPackage.migrationIdentity, tx => {
      const receipt = tx.readImportedRecords()[0]!, artifact = tx.readCompatibilityOutbox()[0]!;
      tx.enqueueCompatibility([{ ...artifact, outboxId: deterministicMigrationUuid("claim", f.sealedPackage.migrationIdentity, 0),
        sourceOrdinal: 0, importedEventId: receipt.importedEventId, importedGlobalPosition: receipt.importedGlobalPosition,
        importedEventHash: receipt.importedEventHash, relativePath: "extra.md", materializationRevision: 1n }]);
    });
    await assert.rejects(new V2ShadowCompatibilityMaterializer(f.materializerOptions).materializePending(f.input));
    assert.deepEqual(readdirSync(f.isolatedRoot), []);
    assert.equal(f.repository.transact(f.projectionBinding.projectId, f.sealedPackage.migrationIdentity, tx => tx.readCompatibilityClaims()).length, 0);
  });
});
