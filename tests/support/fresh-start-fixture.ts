import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { FreshStartGenesis, FreshStartIdentity, FreshStartRelease } from "../../src/orchestrator/fresh-start/contracts.js";
import { PROJECTION_NAMES, projectionCoreChecksum } from "../../src/orchestrator/projections/checksum.js";
import { GENESIS_GLOBAL_HASH } from "../../src/orchestrator/storage/event-append-transaction.js";
import { NodeSqliteDriver } from "../../src/orchestrator/storage/node-sqlite-driver.js";
import type { SqliteConnection } from "../../src/orchestrator/storage/sqlite-driver.js";
import { applyCurrentProjectStoreSchema } from "./current-project-store-schema.js";

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
