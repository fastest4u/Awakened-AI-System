import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, unlinkSync, writeFileSync, type BigIntStats } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { FreshStartGenesis, FreshStartIdentity, FreshStartRelease } from "../../src/orchestrator/fresh-start/contracts.js";
import { PROJECTION_NAMES, projectionCoreChecksum } from "../../src/orchestrator/projections/checksum.js";
import { GENESIS_GLOBAL_HASH } from "../../src/orchestrator/storage/event-append-transaction.js";
import { NodeSqliteDriver } from "../../src/orchestrator/storage/node-sqlite-driver.js";
import type { SqliteConnection } from "../../src/orchestrator/storage/sqlite-driver.js";
import { applyCurrentProjectStoreSchema } from "./current-project-store-schema.js";
import { expectedSchemaFingerprint } from "../../src/orchestrator/storage/schema-fingerprint.js";
import { PROJECT_STORE_MIGRATIONS } from "../../src/orchestrator/storage/migrations/registry.js";
import { SqliteFreshStartRepository } from "../../src/orchestrator/fresh-start/fresh-start.repository.js";
import { FreshStartControlPlane } from "../../src/orchestrator/fresh-start/fresh-start-control-plane.js";
import { TrustedFreshStartEvidenceVerifier, TrustedOperatorApprovalVerifier } from "../../src/orchestrator/fresh-start/operator-approval.js";
import { bindFreshStartAdmissionContext } from "../../src/orchestrator/fresh-start/fresh-start-admission.js";

/** Owned-test verifier only. Production promotion remains closed. */
export async function activateFreshTestStore(connection: SqliteConnection, identity: FreshStartIdentity = FRESH_IDENTITY) {
  const release = freshRelease({ ...identity, schemaIdentityHash: expectedSchemaFingerprint(PROJECT_STORE_MIGRATIONS) });
  const genesis = freshGenesis({ ...identity, projectionChecksums: Object.fromEntries(PROJECTION_NAMES.map(name => [name, projectionCoreChecksum(name, 2, identity.projectId, 0n, [])])) });
  const repository = new SqliteFreshStartRepository(connection);
  repository.transact(identity, tx => tx.install(genesis, release));
  const approvals = new TrustedOperatorApprovalVerifier(async (_bytes, requestDigest) => ({ identity,
    approvalId: randomUUID(), nonceDigest: createHash("sha256").update(randomUUID()).digest("hex"),
    actorFingerprint: "2".repeat(64), requestDigest, evidenceDigest: release.evidenceDigest }));
  const control = new FreshStartControlPlane(repository, approvals, new TrustedFreshStartEvidenceVerifier(async value => value));
  await control.transition({ identity, expectedGeneration: 0n, expectedMode: "prepared", expectedReleaseId: release.releaseId,
    nextMode: "active", nextRelease: release, approvalEnvelope: new Uint8Array([1]) });
  const trusted = { identity, releaseId: release.releaseId, measuredBuildHash: release.buildIdentityHash, generation: 1n };
  bindFreshStartAdmissionContext(connection, trusted);
  return { control, repository, release, trusted };
}

export const FRESH_NOW = "2026-09-29T00:00:00.000Z";
export const FRESH_IDENTITY = Object.freeze({
  projectId: "11111111-1111-4111-8111-111111111111",
  vaultId: "22222222-2222-4222-8222-222222222222",
  storeId: "33333333-3333-4333-8333-333333333333",
}) as FreshStartIdentity;
export const FRESH_RELEASE_ID = "44444444-4444-4444-8444-444444444444";

export function freshRelease(overrides: Partial<FreshStartRelease> = {}): FreshStartRelease {
  return Object.freeze({
    ...FRESH_IDENTITY,
    profileVersion: 1,
    releaseId: FRESH_RELEASE_ID,
    buildIdentityHash: "a".repeat(64),
    schemaIdentityHash: "b".repeat(64),
    configurationHash: "c".repeat(64),
    capabilityManifestHash: "d".repeat(64),
    recoveryPolicyHash: "e".repeat(64),
    evidenceDigest: "f".repeat(64),
    createdAt: FRESH_NOW,
    ...overrides,
  }) as FreshStartRelease;
}

export function freshGenesis(overrides: Partial<FreshStartGenesis> = {}): FreshStartGenesis {
  const projectionChecksums = Object.fromEntries(PROJECTION_NAMES.map((name) => [
    name, projectionCoreChecksum(name, 2, FRESH_IDENTITY.projectId, 0n, []),
  ]));
  return Object.freeze({
    ...FRESH_IDENTITY,
    initializationId: "55555555-5555-4555-8555-555555555555",
    releaseId: FRESH_RELEASE_ID,
    semanticPosition: "0",
    terminalHash: GENESIS_GLOBAL_HASH,
    projectionChecksums: Object.freeze(projectionChecksums),
    preparationIntentDigest: "1".repeat(64),
    actorFingerprint: "2".repeat(64),
    createdAt: FRESH_NOW,
    ...overrides,
  }) as FreshStartGenesis;
}

export function freshStore(): { connection: SqliteConnection; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), `fresh-start-${randomUUID()}-`));
  const connection = new NodeSqliteDriver({ DatabaseSync }).open(join(root, "events.sqlite"), {
    mode: "create", busyTimeoutMs: 1_000,
  });
  applyCurrentProjectStoreSchema(connection, FRESH_IDENTITY, FRESH_NOW);
  return { connection, cleanup(): void { connection.close(); rmSync(root, { recursive: true, force: true }); } };
}

/** Opt-in owned spelling experiment only; the default fixtures retain their behavior. */
export function freshStoreSpellingFixture(spelling: "raw" | "native"): {
  connection: SqliteConnection; rawRoot: string; nativeRoot: string; openedRoot: string;
  rawIsNative: boolean; closeConnection(): void; cleanup(): void;
} {
  const setupCode = "CI_FRESH_SPELLING_SETUP_INCOMPLETE";
  const cleanupCode = "CI_FRESH_SPELLING_CLEANUP_INCOMPLETE";
  const fixedError = (code: string) => Object.assign(new Error(code), { code });
  let rawRoot: string | undefined, nativeRoot: string | undefined, created: BigIntStats | undefined;
  let connection: SqliteConnection | undefined;
  let closed = false, removed = false, incomplete = false;
  const equalSpelling = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  function sameOwner(current: BigIntStats): boolean {
    return created !== undefined && current.isDirectory() && !current.isSymbolicLink()
      && current.dev === created.dev && current.ino === created.ino && current.birthtimeNs === created.birthtimeNs;
  }
  function assertOwner(): void {
    if (rawRoot === undefined || nativeRoot === undefined
      || !sameOwner(lstatSync(rawRoot, { bigint: true })) || !sameOwner(lstatSync(nativeRoot, { bigint: true }))
      || !equalSpelling(resolve(realpathSync.native(rawRoot)), nativeRoot)
      || !equalSpelling(resolve(realpathSync.native(nativeRoot)), nativeRoot)) throw fixedError(cleanupCode);
  }
  function closeConnection(): void {
    if (incomplete) throw fixedError(cleanupCode);
    if (closed) return;
    // A failed open gives no positively acquired connection and cannot grant a close receipt.
    if (connection === undefined) { incomplete = true; throw fixedError(cleanupCode); }
    try { connection.close(); closed = true; }
    catch { incomplete = true; throw fixedError(cleanupCode); }
  }
  function cleanup(): void {
    if (incomplete) throw fixedError(cleanupCode);
    if (removed) return;
    try {
      closeConnection();
      assertOwner();
      const root = rawRoot!;
      // This fixture creates only SQLite leaves. Refuse descendants and links rather than traverse them.
      const leaves = readdirSync(root).map(name => {
        if (!["events.sqlite", "events.sqlite-wal", "events.sqlite-shm"].includes(name)) throw fixedError(cleanupCode);
        const path = join(root, name), identity = lstatSync(path, { bigint: true });
        if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1n) throw fixedError(cleanupCode);
        return { path, identity };
      });
      for (const leaf of leaves) {
        assertOwner();
        const current = lstatSync(leaf.path, { bigint: true });
        if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n
          || current.dev !== leaf.identity.dev || current.ino !== leaf.identity.ino
          || current.birthtimeNs !== leaf.identity.birthtimeNs) throw fixedError(cleanupCode);
        unlinkSync(leaf.path);
      }
      assertOwner();
      rmdirSync(root);
      removed = true;
    } catch { incomplete = true; throw fixedError(cleanupCode); }
  }
  try {
    if (spelling !== "raw" && spelling !== "native") throw fixedError(setupCode);
    rawRoot = mkdtempSync(join(tmpdir(), `fresh-start-${randomUUID()}-`));
    // Capture precise creation authority before any native lookup or database descendant exists.
    created = lstatSync(rawRoot, { bigint: true });
    if (!created.isDirectory() || created.isSymbolicLink()) throw fixedError(setupCode);
    nativeRoot = resolve(realpathSync.native(rawRoot));
    assertOwner();
    const openedRoot = spelling === "native" ? nativeRoot : rawRoot;
    connection = new NodeSqliteDriver({ DatabaseSync }).open(join(openedRoot, "events.sqlite"), {
      mode: "create", busyTimeoutMs: 1_000,
    });
    applyCurrentProjectStoreSchema(connection, FRESH_IDENTITY, FRESH_NOW);
    assertOwner();
    return { connection, rawRoot, nativeRoot, openedRoot,
      rawIsNative: equalSpelling(resolve(rawRoot), nativeRoot), closeConnection, cleanup };
  } catch {
    // Keep the setup refusal primary; only a separately returned close receipt permits removal.
    if (connection !== undefined) {
      try { closeConnection(); cleanup(); } catch { incomplete = true; }
    } else incomplete = true;
    throw Object.assign(fixedError(setupCode), { cleanupCode: incomplete ? cleanupCode : "none" });
  }
}

/** All content here is owned synthetic test data, including the archive sentinel. */
export function freshInitializationFixture() {
  const projectRoot = mkdtempSync(join(tmpdir(), "fresh-initialization-"));
  const v2VaultRoot = join(projectRoot, "v2-vault");
  const v1ArchiveRoot = join(projectRoot, "v1-archive");
  mkdirSync(v2VaultRoot); mkdirSync(v1ArchiveRoot);
  const sentinel = join(v1ArchiveRoot, "sentinel.txt");
  writeFileSync(sentinel, "synthetic archive must remain untouched");
  const artifact = join(projectRoot, "owned-test-build.js");
  writeFileSync(artifact, "export const fixtureBuild = 'foundation-owned-artifact';\n");
  const inspectBuild = () => createHash("sha256").update(readFileSync(artifact)).digest("hex");
  const { projectId: _projectId, vaultId: _vaultId, storeId: _storeId, ...release } = freshRelease({
    buildIdentityHash: inspectBuild(), schemaIdentityHash: expectedSchemaFingerprint(PROJECT_STORE_MIGRATIONS),
  });
  return {
    input: { projectRoot, v2VaultRoot, v1ArchiveRoot, initializationId: randomUUID(), release },
    dependencies: { inspectBuild, actorFingerprint: createHash("sha256").update("owned-local-test-operator").digest("hex") },
    sentinel, artifact,
    journalPath: join(v2VaultRoot, ".memory-mcp", "fresh-start-init.json"),
    databasePath: join(v2VaultRoot, ".memory-mcp", "v2", "events.sqlite"),
    cleanup: () => rmSync(projectRoot, { recursive: true, force: true }),
  };
}
