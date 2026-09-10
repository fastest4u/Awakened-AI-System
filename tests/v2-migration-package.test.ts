import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { verifyV1SourceCopy } from "../src/orchestrator/migration/v1-source-copy.js";
import {
  openSealedV2MigrationPackage,
  sealV2MigrationPackage,
} from "../src/orchestrator/migration/v2-migration-package.js";
import { ShadowMigrationError } from "../src/orchestrator/migration/v2-shadow-migration.contracts.js";
import { createV2ShadowMigrationFixture } from "./support/v2-shadow-migration-fixture.js";

function identityConflict(error: unknown): boolean {
  return error instanceof ShadowMigrationError && error.code === "MIGRATION_IDENTITY_CONFLICT";
}

test("seals identical logical packages independent of absolute path", async (t) => {
  // Removing global-position ordering or including a source path in logical bytes breaks this invariant.
  const fixture = await createV2ShadowMigrationFixture(t);
  const source = await verifyV1SourceCopy(fixture.verificationInput);
  const left = await sealV2MigrationPackage({ ...fixture.packageInput, source, packageRoot: fixture.packageRootA });
  const right = await sealV2MigrationPackage({ ...fixture.packageInput, source, packageRoot: fixture.packageRootB });
  assert.equal(left.manifest.packageChecksum, right.manifest.packageChecksum);
  assert.equal(left.migrationIdentity, right.migrationIdentity);
  assert.deepEqual([...left.records()].map((record) => record.descriptor), [...right.records()].map((record) => record.descriptor));
  assert.deepEqual([...left.records()].map((record) => record.descriptor.kind), ["source-event", "source-event", "legacy-artifact", "legacy-artifact"]);
  source.assertUnchanged();
  left.close();
  right.close();
  source.close();
});

test("rejects a package whose event bytes were replaced", async (t) => {
  // Removing record-content verification would allow this changed package to open.
  const fixture = await createV2ShadowMigrationFixture(t);
  const source = await verifyV1SourceCopy(fixture.verificationInput);
  const sealed = await sealV2MigrationPackage({ ...fixture.packageInput, source, packageRoot: fixture.packageRootA });
  const eventPath = join(sealed.rootPath, "events.ndjson");
  const eventBytes = readFileSync(eventPath);
  eventBytes[0] = eventBytes[0] === 0x7b ? 0x5b : 0x7b;
  writeFileSync(eventPath, eventBytes);
  assert.throws(() => openSealedV2MigrationPackage({ rootPath: sealed.rootPath, expectedMigrationIdentity: sealed.migrationIdentity }), identityConflict);
  sealed.close();
  source.close();
});

test("rejects a package whose descriptor manifest was replaced", async (t) => {
  // Removing manifest checksum verification would allow this altered descriptor to open.
  const fixture = await createV2ShadowMigrationFixture(t);
  const source = await verifyV1SourceCopy(fixture.verificationInput);
  const sealed = await sealV2MigrationPackage({ ...fixture.packageInput, source, packageRoot: fixture.packageRootA });
  const manifestPath = join(sealed.rootPath, "package-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { recordDescriptors: Array<{ byteLength: number }> };
  manifest.recordDescriptors[0]!.byteLength += 1;
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => openSealedV2MigrationPackage({ rootPath: sealed.rootPath, expectedMigrationIdentity: sealed.migrationIdentity }), identityConflict);
  sealed.close();
  source.close();
});
