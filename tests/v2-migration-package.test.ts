import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { verifyV1SourceCopy } from "../src/orchestrator/migration/v1-source-copy.js";
import {
  openSealedV2MigrationPackage,
  sealV2MigrationPackage,
  type V2MigrationPackageManifestV1,
} from "../src/orchestrator/migration/v2-migration-package.js";
import { decodeShadowMigrationPolicyV1, ShadowMigrationError, shadowMigrationConfigurationChecksum, shadowMigrationIdentity, shadowMigrationPolicyChecksum } from "../src/orchestrator/migration/v2-shadow-migration.contracts.js";
import { createV2ShadowMigrationFixture } from "./support/v2-shadow-migration-fixture.js";

function identityConflict(error: unknown): boolean {
  return error instanceof ShadowMigrationError && error.code === "MIGRATION_IDENTITY_CONFLICT";
}

function rewriteManifest(
  manifestPath: string,
  mutate: (manifest: Record<string, unknown>) => void,
  rechecksum: boolean,
): V2MigrationPackageManifestV1 {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  mutate(manifest);
  if (rechecksum) {
    const { packageChecksum: ignored, ...body } = manifest;
    void ignored;
    manifest.packageChecksum = createHash("sha256")
      .update(`project-memory/v2-shadow-migration-package/v1\n${canonicalJson(body)}`, "utf8")
      .digest("hex");
  }
  writeFileSync(manifestPath, canonicalJson(manifest));
  return manifest as unknown as V2MigrationPackageManifestV1;
}

function identityFor(manifest: V2MigrationPackageManifestV1): string {
  return shadowMigrationIdentity({ projectId: manifest.projectId, storeId: manifest.storeId,
    sourceManifestChecksum: manifest.sourceManifestChecksum, terminalEventHash: manifest.terminalEventHash,
    packageChecksum: manifest.packageChecksum, migrationAlgorithmVersion: 1, buildIdentityHash: manifest.buildIdentityHash,
    configurationChecksum: manifest.configurationChecksum });
}

test("seals identical logical packages independent of absolute path", async (t) => {
  // Removing global-position ordering or including a source path in logical bytes breaks this invariant.
  const fixture = await createV2ShadowMigrationFixture(t);
  const source = await verifyV1SourceCopy(fixture.verificationInput);
  const left = await sealV2MigrationPackage({ ...fixture.packageInput, source, packageRoot: fixture.packageRootA });
  const right = await sealV2MigrationPackage({ ...fixture.packageInput, source, packageRoot: fixture.packageRootB });
  assert.equal(left.manifest.createdAt, fixture.manifest.createdAt);
  assert.equal(right.manifest.createdAt, fixture.manifest.createdAt);
  assert.equal(left.manifest.packageChecksum, right.manifest.packageChecksum);
  assert.equal(left.migrationIdentity, right.migrationIdentity);
  assert.deepEqual([...left.records()].map((record) => record.descriptor), [...right.records()].map((record) => record.descriptor));
  assert.deepEqual([...left.records()].map((record) => record.descriptor.kind), ["source-event", "source-event", "legacy-artifact", "legacy-artifact"]);
  assert.deepEqual([...left.records()].map((record) => record.descriptor.sourceIdentity), fixture.sourceEvents.map((event) => event.eventId).concat(fixture.manifest.legacyArtifacts.map((artifact) => artifact.sha256)));
  assert.deepEqual([...source.events()].map((event) => event.globalPosition), [1n, 2n]);
  assert.deepEqual([...left.records()].slice(2).map((record) => record.descriptor.relativePath), ["legacy/one.md", "legacy/two.md"]);
  source.assertUnchanged();
  left.close();
  right.close();
  const reopened = openSealedV2MigrationPackage({ rootPath: left.rootPath, expectedMigrationIdentity: left.migrationIdentity });
  assert.equal(reopened.manifest.createdAt, fixture.manifest.createdAt);
  reopened.close();
  source.close();
});

test("requires one canonical real source creation timestamp in the sealed manifest", async (t) => {
  // Omitting the package timestamp or accepting malformed/non-canonical/impossible values breaks the deterministic import clock.
  for (const variant of ["missing", "unknown", "malformed", "noncanonical", "impossible"] as const) await t.test(variant, async (child) => {
    const fixture = await createV2ShadowMigrationFixture(child);
    const source = await verifyV1SourceCopy(fixture.verificationInput);
    const sealed = await sealV2MigrationPackage({ ...fixture.packageInput, source, packageRoot: fixture.packageRootA });
    const manifestPath = join(sealed.rootPath, "package-manifest.json");
    sealed.close();
    const changed = rewriteManifest(manifestPath, (manifest) => {
      if (variant === "missing") delete manifest.createdAt;
      else if (variant === "unknown") manifest.unexpectedTimestamp = fixture.manifest.createdAt;
      else if (variant === "malformed") manifest.createdAt = "not-a-timestamp";
      else if (variant === "noncanonical") manifest.createdAt = "2026-09-10T07:00:00.000+07:00";
      else manifest.createdAt = "2026-02-30T00:00:00.000Z";
    }, true);
    assert.throws(() => openSealedV2MigrationPackage({ rootPath: sealed.rootPath, expectedMigrationIdentity: identityFor(changed) }), identityConflict);
    source.close();
  });
});

test("binds createdAt through package checksum and migration identity", async (t) => {
  // Excluding createdAt from the canonical checksum permits a stale-checksum package clock substitution.
  const fixture = await createV2ShadowMigrationFixture(t);
  const source = await verifyV1SourceCopy(fixture.verificationInput);
  const sealed = await sealV2MigrationPackage({ ...fixture.packageInput, source, packageRoot: fixture.packageRootA });
  const manifestPath = join(sealed.rootPath, "package-manifest.json");
  const originalIdentity = sealed.migrationIdentity;
  sealed.close();
  rewriteManifest(manifestPath, (manifest) => { manifest.createdAt = "2026-09-10T00:00:01.000Z"; }, false);
  assert.throws(() => openSealedV2MigrationPackage({ rootPath: sealed.rootPath, expectedMigrationIdentity: originalIdentity }), identityConflict);
  source.close();
});

test("rejects delayed record iteration after package tampering or close", async (t) => {
  // Removing consumption-time authentication/lifecycle checks exposes changed bytes after iterable acquisition.
  const fixture = await createV2ShadowMigrationFixture(t);
  const source = await verifyV1SourceCopy(fixture.verificationInput);
  const sealed = await sealV2MigrationPackage({ ...fixture.packageInput, source, packageRoot: fixture.packageRootA });
  const delayed = [...sealed.records()][0]!.readChunks();
  const eventPath = join(sealed.rootPath, "events.ndjson");
  const bytes = readFileSync(eventPath); bytes[0] ^= 1; writeFileSync(eventPath, bytes);
  assert.throws(() => [...delayed], identityConflict);
  const secondSealed = await sealV2MigrationPackage({ ...fixture.packageInput, source, packageRoot: fixture.packageRootB });
  const second = [...secondSealed.records()][0]!.readChunks();
  secondSealed.close();
  assert.throws(() => [...second], identityConflict);
  const reopened = openSealedV2MigrationPackage({ rootPath: join(fixture.packageRootB, secondSealed.migrationIdentity), expectedMigrationIdentity: secondSealed.migrationIdentity });
  const deferredFailure = [...reopened.records()][0]!.readChunks();
  renameSync(join(reopened.rootPath, "events.ndjson"), join(fixture.root, "removed-events.ndjson"));
  assert.throws(() => [...deferredFailure], identityConflict);
  reopened.close();
  sealed.close();
  source.close();
});

test("redacts a removed package root during deferred record consumption", async (t) => {
  // Native held-handle filesystem failures must never expose the package root.
  const fixture = await createV2ShadowMigrationFixture(t);
  const source = await verifyV1SourceCopy(fixture.verificationInput);
  const sealed = await sealV2MigrationPackage({ ...fixture.packageInput, source, packageRoot: fixture.packageRootA });
  const delayed = [...sealed.records()][0]!.readChunks();
  renameSync(sealed.rootPath, join(fixture.root, "moved-package"));
  assert.throws(() => [...delayed], (error: unknown) => error instanceof ShadowMigrationError
    && error.code === "MIGRATION_IDENTITY_CONFLICT" && !String(error).includes(sealed.rootPath));
  sealed.close(); source.close();
});

test("classifies expiry during named existing-target final adoption", async (t) => {
  // A deadline crossing after the exact target is reopened must remain a limit error, not an identity conflict.
  const fixture = await createV2ShadowMigrationFixture(t);
  const source = await verifyV1SourceCopy(fixture.verificationInput);
  const initial = await sealV2MigrationPackage({ ...fixture.packageInput, source, packageRoot: fixture.packageRootA });
  let now = 0;
  await assert.rejects(sealV2MigrationPackage({ ...fixture.packageInput, source, packageRoot: fixture.packageRootA, now: () => now,
    onPhase: (phase: string) => { if (phase === "existing-target-final-open") now = 300_001; },
  }), (error: unknown) => error instanceof ShadowMigrationError && error.code === "MIGRATION_LIMIT_EXCEEDED");
  assert.equal(existsSync(join(fixture.packageRootA, initial.migrationIdentity)), true);
  openSealedV2MigrationPackage({ rootPath: join(fixture.packageRootA, initial.migrationIdentity), expectedMigrationIdentity: initial.migrationIdentity }).close();
  initial.close(); source.close();
});

test("classifies expiry during named fresh-target final completion", async (t) => {
  // Publication is durable before final open, but the caller still receives the deadline result.
  const fixture = await createV2ShadowMigrationFixture(t);
  const source = await verifyV1SourceCopy(fixture.verificationInput);
  const identitySource = await sealV2MigrationPackage({ ...fixture.packageInput, source, packageRoot: fixture.packageRootA });
  let now = 0;
  await assert.rejects(sealV2MigrationPackage({ ...fixture.packageInput, source, packageRoot: fixture.packageRootB, now: () => now,
    onPhase: (phase: string) => { if (phase === "fresh-target-final-open") now = 300_001; },
  }), (error: unknown) => error instanceof ShadowMigrationError && error.code === "MIGRATION_LIMIT_EXCEEDED");
  assert.equal(existsSync(join(fixture.packageRootB, identitySource.migrationIdentity)), true);
  openSealedV2MigrationPackage({ rootPath: join(fixture.packageRootB, identitySource.migrationIdentity), expectedMigrationIdentity: identitySource.migrationIdentity }).close();
  identitySource.close(); source.close();
});

test("held assertion rejects same-size events content tampering", async (t) => {
  const fixture = await createV2ShadowMigrationFixture(t);
  const source = await verifyV1SourceCopy(fixture.verificationInput);
  const sealed = await sealV2MigrationPackage({ ...fixture.packageInput, source, packageRoot: fixture.packageRootA });
  const path = join(sealed.rootPath, "events.ndjson");
  const bytes = readFileSync(path); bytes[0] ^= 1; writeFileSync(path, bytes);
  assert.throws(() => sealed.assertUnchanged(), identityConflict);
  sealed.close(); source.close();
});

test("held assertion rejects same-size artifact content tampering", async (t) => {
  const fixture = await createV2ShadowMigrationFixture(t);
  const source = await verifyV1SourceCopy(fixture.verificationInput);
  const sealed = await sealV2MigrationPackage({ ...fixture.packageInput, source, packageRoot: fixture.packageRootA });
  const path = join(sealed.rootPath, "artifacts", "legacy", "one.md");
  const bytes = readFileSync(path); bytes[0] ^= 1; writeFileSync(path, bytes);
  assert.throws(() => sealed.assertUnchanged(), identityConflict);
  sealed.close(); source.close();
});

test("held assertion rejects same-size manifest content tampering", async (t) => {
  const fixture = await createV2ShadowMigrationFixture(t);
  const source = await verifyV1SourceCopy(fixture.verificationInput);
  const sealed = await sealV2MigrationPackage({ ...fixture.packageInput, source, packageRoot: fixture.packageRootA });
  const path = join(sealed.rootPath, "package-manifest.json");
  const bytes = readFileSync(path); bytes[0] ^= 1; writeFileSync(path, bytes);
  assert.throws(() => sealed.assertUnchanged(), identityConflict);
  sealed.close(); source.close();
});

test("pins sealed package filesystem identities across byte-identical replacement", async (t) => {
  // Reopening by logical checksum alone misses pathname replacement of a held package.
  const fixture = await createV2ShadowMigrationFixture(t);
  const source = await verifyV1SourceCopy(fixture.verificationInput);
  const sealed = await sealV2MigrationPackage({ ...fixture.packageInput, source, packageRoot: fixture.packageRootA });
  const path = join(sealed.rootPath, "events.ndjson");
  const moved = join(fixture.root, "same-events.ndjson");
  renameSync(path, moved); copyFileSync(moved, path);
  assert.throws(() => sealed.assertUnchanged(), identityConflict);
  sealed.close(); source.close();
});

test("rejects source-overlapping staging roots before creating a package", async (t) => {
  // Removing source/package root separation writes a new package into the immutable source copy.
  const fixture = await createV2ShadowMigrationFixture(t);
  const source = await verifyV1SourceCopy(fixture.verificationInput);
  const baseline = await sealV2MigrationPackage({ ...fixture.packageInput, source, packageRoot: fixture.packageRootA });
  baseline.close();
  await assert.rejects(sealV2MigrationPackage({ ...fixture.packageInput, source, packageRoot: fixture.sourceRoot }), (error: unknown) => error instanceof ShadowMigrationError && error.code === "MIGRATION_SOURCE_INVALID");
  assert.equal(readdirSync(fixture.sourceRoot).some((entry) => entry.startsWith(".v2-migration-package-") || entry.startsWith(".quarantine-")), false);
  assert.equal(existsSync(join(fixture.sourceRoot, baseline.migrationIdentity)), false);
  source.close();
});

test("rejects records that cannot fit the sealed batch limits", async (t) => {
  // Removing pre-write batch accounting accepts a package record larger than maxBatchBytes.
  const fixture = await createV2ShadowMigrationFixture(t);
  const source = await verifyV1SourceCopy(fixture.verificationInput);
  const policy = decodeShadowMigrationPolicyV1({ ...fixture.policy, maxBatchEvents: 1, maxBatchBytes: 1 });
  const configurationChecksum = shadowMigrationConfigurationChecksum({ schemaVersion: 1, policyChecksum: shadowMigrationPolicyChecksum(policy), packageFormatVersion: 1, migrationAlgorithmVersion: 1, expectedDifferencePolicyVersion: 1 });
  await assert.rejects(sealV2MigrationPackage({ ...fixture.packageInput, policy, configurationChecksum, source, packageRoot: fixture.packageRootA }), (error: unknown) => error instanceof ShadowMigrationError && error.code === "MIGRATION_LIMIT_EXCEEDED");
  source.close();
});

test("rejects expiry during artifact copying before publication", async (t) => {
  // Removing bounded-copy deadline checks permits final artifact fsync/publication after expiry.
  const fixture = await createV2ShadowMigrationFixture(t);
  const source = await verifyV1SourceCopy(fixture.verificationInput);
  const baseline = await sealV2MigrationPackage({ ...fixture.packageInput, source, packageRoot: fixture.packageRootB });
  baseline.close();
  const originalNow = Date.now;
  let now = 0;
  Date.now = () => now;
  const originalArtifacts = [...source.legacyArtifacts()];
  const delayedSource = { ...source, legacyArtifacts() {
    return originalArtifacts.map((artifact, index) => index === originalArtifacts.length - 1 ? {
      ...artifact,
      readChunks(): Iterable<Uint8Array> { return (function* () { for (const chunk of artifact.readChunks()) { yield chunk; now = 300_001; } })(); },
    } : artifact).values();
  } };
  try {
    await assert.rejects(sealV2MigrationPackage({ ...fixture.packageInput, source: delayedSource, packageRoot: fixture.packageRootA }), (error: unknown) => error instanceof ShadowMigrationError && error.code === "MIGRATION_LIMIT_EXCEEDED");
    assert.equal(existsSync(join(fixture.packageRootA, baseline.migrationIdentity)), false);
  } finally { Date.now = originalNow; source.close(); }
});

test("rejects unexpected empty artifact directories on open and held handles", async (t) => {
  // Treating directories as traversal-only lets a non-exact existing target be adopted.
  const fixture = await createV2ShadowMigrationFixture(t);
  const source = await verifyV1SourceCopy(fixture.verificationInput);
  const sealed = await sealV2MigrationPackage({ ...fixture.packageInput, source, packageRoot: fixture.packageRootA });
  mkdirSync(join(sealed.rootPath, "artifacts", "unexpected-empty"));
  assert.throws(() => openSealedV2MigrationPackage({ rootPath: sealed.rootPath, expectedMigrationIdentity: sealed.migrationIdentity }), identityConflict);
  assert.throws(() => sealed.assertUnchanged(), identityConflict);
  sealed.close(); source.close();
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
