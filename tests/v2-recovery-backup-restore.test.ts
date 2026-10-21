import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { FreshStartRelease } from "../src/orchestrator/fresh-start/contracts.js";
import { FreshStartError } from "../src/orchestrator/fresh-start/genesis-codec.js";
import { FreshStartInitializer } from "../src/orchestrator/fresh-start/fresh-start-initializer.js";
import { OperationalKeyCustodyProvider } from "../src/orchestrator/keys/operational-key-custody.js";
import { RetainedEvidenceError } from "../src/orchestrator/privacy/evidence-contracts.js";
import {
  openEvidenceItem,
  type EncryptedEvidenceItemV1,
} from "../src/orchestrator/privacy/evidence-envelope.js";
import { MaintenanceFence, MaintenanceFenceError } from "../src/orchestrator/storage/maintenance-fence.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import { PROJECT_STORE_MIGRATIONS } from "../src/orchestrator/storage/migrations/registry.js";
import { expectedSchemaFingerprint } from "../src/orchestrator/storage/schema-fingerprint.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { V2BackupScheduler, V2BackupService } from "../src/orchestrator/recovery/backup.service.js";
import { V2RestoreService, V2RollbackService } from "../src/orchestrator/recovery/restore.service.js";
import { inspectV2Build } from "../src/v2/build-identity.js";
import { createV2Foundation } from "../src/v2/composition.js";
import {
  V2_PRODUCTION_CAPABILITIES,
  V2_PRODUCTION_RECOVERY_POLICY,
  loadV2LaunchConfig,
} from "../src/v2/config.js";
import { activateFreshTestStore } from "./support/fresh-start-fixture.js";

function sha(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

const V2_DIST_ENTRY_URL = pathToFileURL(resolve("dist/v2.js")).href;
const V2_BUILD_MANIFEST = JSON.parse(readFileSync(resolve("dist/v2-build.json"), "utf8")) as {
  deploymentId: string;
  buildIdentityHash: string;
};
(globalThis as Record<string, unknown>).__V2_DEPLOYMENT_ID__ = V2_BUILD_MANIFEST.deploymentId;

async function createActiveStoreFixture(prefix = "pm-v2-recovery-") {
  const rootDir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  const projectRoot = join(rootDir, "project");
  const v1ArchiveRoot = join(projectRoot, "archive");
  const v2VaultRoot = join(projectRoot, "memory-v2");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(v1ArchiveRoot, { recursive: true });
  writeFileSync(join(v1ArchiveRoot, "sentinel.txt"), "archive-sentinel");

  const releaseId = randomUUID();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MEMORY_PROJECT_ROOT: projectRoot,
    MEMORY_V2_VAULT_PATH: v2VaultRoot,
    MEMORY_V1_ARCHIVE_PATH: v1ArchiveRoot,
    MEMORY_V2_RELEASE_ID: releaseId,
  };
  const config = loadV2LaunchConfig(env);
  const buildIdentityHash = inspectV2Build(V2_DIST_ENTRY_URL);
  const schemaIdentityHash = expectedSchemaFingerprint(PROJECT_STORE_MIGRATIONS);
  const release: Omit<FreshStartRelease, "projectId" | "vaultId" | "storeId"> = Object.freeze({
    profileVersion: 1 as const,
    releaseId,
    buildIdentityHash,
    schemaIdentityHash,
    configurationHash: sha(config),
    capabilityManifestHash: sha(V2_PRODUCTION_CAPABILITIES),
    recoveryPolicyHash: sha(V2_PRODUCTION_RECOVERY_POLICY),
    evidenceDigest: sha({ purpose: "v2-recovery-backup-restore-test" }),
    createdAt: "2026-07-01T00:00:00.000Z",
  });

  const initializer = new FreshStartInitializer({
    projectionSchemaVersion: 3,
    inspectBuild: () => buildIdentityHash,
    actorFingerprint: sha("v2-recovery-test-operator"),
  });
  const initialized = await initializer.initializeFresh({
    projectRoot,
    v2VaultRoot,
    v1ArchiveRoot,
    initializationId: randomUUID(),
    release,
  });

  const storeRoot = join(v2VaultRoot, ".memory-mcp", "v2");
  const eventsPath = join(storeRoot, "events.sqlite");
  const driver = new NodeSqliteDriver({ DatabaseSync });
  const connection = driver.open(eventsPath, { mode: "existing", busyTimeoutMs: 1_000 });
  try {
    await activateFreshTestStore(
      connection,
      {
        projectId: initialized.projectId,
        vaultId: initialized.vaultId,
        storeId: initialized.storeId,
      },
      { alreadyInitialized: true },
    );
  } finally {
    connection.close();
  }

  return {
    rootDir,
    projectRoot,
    v1ArchiveRoot,
    v2VaultRoot,
    storeRoot,
    eventsPath,
    releaseId,
    projectId: initialized.projectId,
    vaultId: initialized.vaultId,
    storeId: initialized.storeId,
    config,
    cleanup(): void {
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

function openStoredEvidenceFromVault(
  v2VaultRoot: string,
  projectId: string,
  storeId: string,
  evidenceId: string,
): string {
  const storeRoot = join(v2VaultRoot, ".memory-mcp", "v2");
  const eventsPath = join(storeRoot, "events.sqlite");
  const db = new DatabaseSync(eventsPath, { open: true });
  let encryptedItemJson: string;
  try {
    const row = db
      .prepare(
        `SELECT encrypted_item_json FROM retained_evidence_blobs
         WHERE project_id = ? AND evidence_id = ?`,
      )
      .get(projectId, evidenceId) as { encrypted_item_json?: string } | undefined;
    if (!row?.encrypted_item_json) {
      throw new RetainedEvidenceError("RETAINED_EVIDENCE_UNAVAILABLE");
    }
    encryptedItemJson = row.encrypted_item_json;
  } finally {
    db.close();
  }

  const item = JSON.parse(encryptedItemJson) as EncryptedEvidenceItemV1;
  const custody = new OperationalKeyCustodyProvider({
    storeRoot,
    projectId,
    storeId,
  });
  try {
    const opened = openEvidenceItem(item.binding, item, custody.evidence);
    return typeof opened.content === "string"
      ? opened.content
      : JSON.stringify(opened.content);
  } finally {
    custody.close();
  }
}

test("V2BackupService creates fenced WAL-free backup with verified manifest, records receipt, and rejects path overlap or fence conflicts", async () => {
  const fixture = await createActiveStoreFixture();
  try {
    const foundation = await createV2Foundation(fixture.config, { entryUrl: V2_DIST_ENTRY_URL });
    try {
      await foundation.content.invoke("memory_sessionStart", {
        agentName: "operator-backup",
        taskDescription: "Backup verification task",
      });

      await foundation.content.invoke("memory_writeInsight", {
        title: "Backup Insight",
        summary: "Insight before backup",
        content: "Detailed body before backup",
        confidence: "high",
      });
    } finally {
      await foundation.close();
    }

    const backupService = new V2BackupService();

    // 1. Reject overlapping backup directories with FRESH_START_PATH_OVERLAP
    for (const overlappingDir of [
      join(fixture.projectRoot, "nested-backup"),
      join(fixture.v2VaultRoot, "nested-backup"),
      join(fixture.v1ArchiveRoot, "nested-backup"),
    ]) {
      await assert.rejects(
        () =>
          backupService.createBackup({
            projectRoot: fixture.projectRoot,
            v2VaultRoot: fixture.v2VaultRoot,
            v1ArchiveRoot: fixture.v1ArchiveRoot,
            outputDirectory: overlappingDir,
            reason: "manual",
            now: "2026-07-01T00:10:00.000Z",
          }),
        (err: unknown) => err instanceof FreshStartError && err.code === "FRESH_START_PATH_OVERLAP",
      );
    }

    // 2. Reject backup when another exclusive MaintenanceFence is active on events.sqlite
    const driver = new NodeSqliteDriver({ DatabaseSync });
    const conn = driver.open(fixture.eventsPath, { mode: "existing", busyTimeoutMs: 1_000 });
    const externalFence = new MaintenanceFence();
    const heldLease = externalFence.acquire(
      conn,
      "external-owner",
      "2026-07-01T00:15:00.000Z",
      "2026-07-01T00:10:00.000Z",
    );
    try {
      await assert.rejects(
        () =>
          backupService.createBackup({
            projectRoot: fixture.projectRoot,
            v2VaultRoot: fixture.v2VaultRoot,
            v1ArchiveRoot: fixture.v1ArchiveRoot,
            outputDirectory: join(fixture.rootDir, "blocked-backup"),
            reason: "manual",
            now: "2026-07-01T00:10:00.000Z",
          }),
        (err: unknown) =>
          err instanceof MaintenanceFenceError && err.code === "MAINTENANCE_ALREADY_ACTIVE",
      );
    } finally {
      externalFence.release(conn, heldLease, false, "2026-07-01T00:10:00.000Z");
      conn.close();
    }

    // 3. Create verified backup
    const backupDir = join(fixture.rootDir, "backups", "b1");
    const manifest = await backupService.createBackup({
      projectRoot: fixture.projectRoot,
      v2VaultRoot: fixture.v2VaultRoot,
      v1ArchiveRoot: fixture.v1ArchiveRoot,
      outputDirectory: backupDir,
      reason: "manual",
      now: "2026-07-01T00:10:00.000Z",
    });

    assert.equal(manifest.manifestVersion, 1);
    assert.equal(manifest.projectId, fixture.projectId);
    assert.equal(manifest.vaultId, fixture.vaultId);
    assert.equal(manifest.storeId, fixture.storeId);
    assert.equal(manifest.reason, "manual");
    assert.equal(manifest.createdAt, "2026-07-01T00:10:00.000Z");
    assert.ok(BigInt(manifest.terminalGlobalPosition) >= 1n);
    assert.match(manifest.terminalGlobalHash, /^[0-9a-f]{64}$/u);
    assert.equal(manifest.eventStoreSchemaVersion, 9);
    assert.equal(manifest.projectionSchemaVersion, 3);
    assert.match(manifest.backupManifestDigest, /^[0-9a-f]{64}$/u);

    // Verify WAL-free snapshot and required files exist on disk
    assert.equal(existsSync(join(backupDir, "events.sqlite")), true);
    assert.equal(existsSync(join(backupDir, "events.sqlite-wal")), false);
    assert.equal(existsSync(join(backupDir, "events.sqlite-shm")), false);
    assert.equal(existsSync(join(backupDir, "fresh-start-release.json")), true);
    assert.equal(existsSync(join(backupDir, "project-identity.json")), true);
    assert.equal(existsSync(join(backupDir, "store-manifest.json")), true);
    assert.equal(existsSync(join(backupDir, "erasure-fences.json")), true);
    assert.equal(existsSync(join(backupDir, "backup-manifest.json")), true);

    // Verify receipt recorded in custody-recovery.sqlite
    const custody = new OperationalKeyCustodyProvider({
      storeRoot: fixture.storeRoot,
      projectId: fixture.projectId,
      storeId: fixture.storeId,
    });
    try {
      const latest = custody.latestBackupReceipt();
      assert.ok(latest);
      assert.equal(latest.backupId, manifest.backupId);
      assert.equal(latest.manifestSha256, manifest.backupManifestDigest);
      assert.equal(latest.terminalEventPosition, manifest.terminalGlobalPosition);
      assert.equal(latest.terminalEventHash, manifest.terminalGlobalHash);
    } finally {
      custody.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test("V2BackupService.inspectHealth and V2BackupScheduler enforce hourly active window, pre-upgrade, and orderly shutdown backups", async () => {
  const fixture = await createActiveStoreFixture("pm-v2-scheduler-");
  try {
    const backupService = new V2BackupService();
    const scheduler = new V2BackupScheduler(backupService);

    // Initial backup at t = 00:00:00
    const initialBackupDir = join(fixture.rootDir, "backups", "initial");
    const initialManifest = await backupService.createBackup({
      projectRoot: fixture.projectRoot,
      v2VaultRoot: fixture.v2VaultRoot,
      v1ArchiveRoot: fixture.v1ArchiveRoot,
      outputDirectory: initialBackupDir,
      reason: "manual",
      now: "2026-07-01T00:00:00.000Z",
    });

    const healthAfterInitial = await backupService.inspectHealth({
      v2VaultRoot: fixture.v2VaultRoot,
      now: "2026-07-01T00:15:00.000Z",
    });
    assert.equal(healthAfterInitial.healthy, true);
    assert.equal(healthAfterInitial.backupOverdue, false);
    assert.equal(healthAfterInitial.hasUnbackedEvents, false);
    assert.equal(healthAfterInitial.lastVerifiedBackupId, initialManifest.backupId);

    // Not due when no unbacked events exist
    const notDueResult = await scheduler.runIfDue({
      projectRoot: fixture.projectRoot,
      v2VaultRoot: fixture.v2VaultRoot,
      v1ArchiveRoot: fixture.v1ArchiveRoot,
      backupRootDirectory: join(fixture.rootDir, "backups"),
      now: "2026-07-01T02:00:00.000Z",
    });
    assert.equal(notDueResult, null);

    // Commit a new event
    const foundation = await createV2Foundation(fixture.config, { entryUrl: V2_DIST_ENTRY_URL });
    try {
      await foundation.content.invoke("memory_sessionStart", {
        agentName: "scheduler-agent",
        taskDescription: "Unbacked work",
      });
    } finally {
      await foundation.close();
    }

    // Within 1 hour window: hasUnbackedEvents is true, but backupOverdue is false
    const healthWithinWindow = await backupService.inspectHealth({
      v2VaultRoot: fixture.v2VaultRoot,
      now: "2026-07-01T00:30:00.000Z",
    });
    assert.equal(healthWithinWindow.hasUnbackedEvents, true);
    assert.equal(healthWithinWindow.backupOverdue, false);
    assert.equal(healthWithinWindow.healthy, true);

    // Exceeding 1 hour window (01:05:00Z > 3_600_000 ms): backupOverdue is true, healthy is false
    const healthOverdue = await backupService.inspectHealth({
      v2VaultRoot: fixture.v2VaultRoot,
      now: "2026-07-01T01:05:00.000Z",
    });
    assert.equal(healthOverdue.hasUnbackedEvents, true);
    assert.equal(healthOverdue.backupOverdue, true);
    assert.equal(healthOverdue.healthy, false);

    // runIfDue triggers hourly-active backup when overdue
    const hourlyManifest = await scheduler.runIfDue({
      projectRoot: fixture.projectRoot,
      v2VaultRoot: fixture.v2VaultRoot,
      v1ArchiveRoot: fixture.v1ArchiveRoot,
      backupRootDirectory: join(fixture.rootDir, "backups"),
      now: "2026-07-01T01:05:00.000Z",
    });
    assert.ok(hourlyManifest);
    assert.equal(hourlyManifest.reason, "hourly-active");

    const healthAfterHourly = await backupService.inspectHealth({
      v2VaultRoot: fixture.v2VaultRoot,
      now: "2026-07-01T01:06:00.000Z",
    });
    assert.equal(healthAfterHourly.healthy, true);
    assert.equal(healthAfterHourly.backupOverdue, false);
    assert.equal(healthAfterHourly.hasUnbackedEvents, false);

    // Commit another event and test onOrderlyShutdown
    const foundation2 = await createV2Foundation(fixture.config, { entryUrl: V2_DIST_ENTRY_URL });
    try {
      await foundation2.content.invoke("memory_sessionStart", {
        agentName: "shutdown-agent",
        taskDescription: "Shutdown unbacked work",
      });
    } finally {
      await foundation2.close();
    }

    const shutdownManifest = await scheduler.onOrderlyShutdown({
      projectRoot: fixture.projectRoot,
      v2VaultRoot: fixture.v2VaultRoot,
      v1ArchiveRoot: fixture.v1ArchiveRoot,
      backupRootDirectory: join(fixture.rootDir, "backups"),
      now: "2026-07-01T01:10:00.000Z",
    });
    assert.ok(shutdownManifest);
    assert.equal(shutdownManifest.reason, "orderly-shutdown");

    // Pre-upgrade backup always runs
    const preUpgradeManifest = await scheduler.onPreUpgrade({
      projectRoot: fixture.projectRoot,
      v2VaultRoot: fixture.v2VaultRoot,
      v1ArchiveRoot: fixture.v1ArchiveRoot,
      backupRootDirectory: join(fixture.rootDir, "backups"),
      now: "2026-07-01T01:15:00.000Z",
    });
    assert.equal(preUpgradeManifest.reason, "pre-upgrade");
  } finally {
    fixture.cleanup();
  }
});

test("V2RestoreService restores into isolated vault, replays post-backup events, and enforces erasure fences BEFORE Projection Schema 3 rebuild", async () => {
  const fixture = await createActiveStoreFixture("pm-v2-restore-erasure-");
  try {
    const foundation = await createV2Foundation(fixture.config, { entryUrl: V2_DIST_ENTRY_URL });
    let erasedEvidenceId = "";
    let survivingEvidenceId = "";
    let erasedNoteId = "";
    let survivingNoteId = "";

    try {
      await foundation.content.invoke("memory_sessionStart", {
        agentName: "operator-restore",
        taskDescription: "Restore and erasure test",
      });

      const secretNote = await foundation.content.invoke("memory_writeInsight", {
        title: "Secret Note To Erase",
        summary: "Contains secret evidence citation",
        content: "Body referencing TOP-SECRET-PII-MUST-BE-ERASED",
        confidence: "high",
      }) as { recordId: string; evidenceId: string };
      erasedNoteId = secretNote.recordId;
      erasedEvidenceId = secretNote.evidenceId;

      const publicNote = await foundation.content.invoke("memory_writeInsight", {
        title: "Public Surviving Note",
        summary: "Contains public evidence citation",
        content: "Body referencing PUBLIC-EVIDENCE-SURVIVES",
        confidence: "high",
      }) as { recordId: string; evidenceId: string };
      survivingNoteId = publicNote.recordId;
      survivingEvidenceId = publicNote.evidenceId;
    } finally {
      await foundation.close();
    }

    // Take backup BEFORE the erasure happens
    const backupService = new V2BackupService();
    const olderBackupDir = join(fixture.rootDir, "backups", "older-pre-erasure");
    await backupService.createBackup({
      projectRoot: fixture.projectRoot,
      v2VaultRoot: fixture.v2VaultRoot,
      v1ArchiveRoot: fixture.v1ArchiveRoot,
      outputDirectory: olderBackupDir,
      reason: "manual",
      now: "2026-07-01T00:10:00.000Z",
    });

    // Now erase the secret evidence item AND write a post-backup note in the source vault
    let postBackupNoteId = "";
    const foundationAfterBackup = await createV2Foundation(fixture.config, { entryUrl: V2_DIST_ENTRY_URL });
    try {
      await foundationAfterBackup.content.invoke("memory_forgetEvidence", {
        evidenceId: erasedEvidenceId,
        recordId: erasedNoteId,
        reason: "GDPR erasure request after backup",
      });

      const postNote = await foundationAfterBackup.content.invoke("memory_writeADR", {
        title: "Post-Backup Architecture Decision",
        summary: "Recorded after backup snapshot",
        content: "# Context\nRecorded after backup\n# Decision\nReplay post-backup events during restore",
        confidence: "high",
      }) as { recordId: string };
      postBackupNoteId = postNote.recordId;
    } finally {
      await foundationAfterBackup.close();
    }

    // Case 1: Restore older backup + replay postBackupSourceVaultRoot
    const restoreService = new V2RestoreService();
    const restoredProjectRoot1 = join(fixture.rootDir, "restored-1");
    const restoredVaultRoot1 = join(restoredProjectRoot1, "memory-v2");

    const receipt1 = await restoreService.restoreToIsolatedVault({
      backupDirectory: olderBackupDir,
      targetProjectRoot: restoredProjectRoot1,
      targetV2VaultRoot: restoredVaultRoot1,
      v1ArchiveRoot: fixture.v1ArchiveRoot,
      postBackupSourceVaultRoot: fixture.v2VaultRoot,
      now: "2026-07-01T00:25:00.000Z",
    });

    assert.equal(receipt1.status, "active");
    assert.equal(receipt1.eventIntegrityVerified, true);
    assert.equal(receipt1.projectionIntegrityVerified, true);
    assert.ok(receipt1.replayedEventsCount >= 2);
    assert.ok(receipt1.erasedEvidenceIdsApplied.includes(erasedEvidenceId));

    // Open foundation on restored vault 1 and verify erased note is NOT readable while surviving + post-backup notes ARE readable
    const restoredConfig1 = loadV2LaunchConfig({
      ...process.env,
      MEMORY_PROJECT_ROOT: restoredProjectRoot1,
      MEMORY_V2_VAULT_PATH: restoredVaultRoot1,
      MEMORY_V1_ARCHIVE_PATH: fixture.v1ArchiveRoot,
      MEMORY_V2_RELEASE_ID: fixture.releaseId,
    });
    const restoredFoundation1 = await createV2Foundation(restoredConfig1, { entryUrl: V2_DIST_ENTRY_URL });
    try {
      const erasedLookup = await restoredFoundation1.content.invoke("memory_get", {
        id: erasedNoteId,
      }) as { ok: boolean; found?: boolean };
      assert.equal(erasedLookup.ok, false);
      assert.equal(erasedLookup.found, false);

      const survivingLookup = await restoredFoundation1.content.invoke("memory_get", {
        id: survivingNoteId,
      }) as { ok: boolean; id?: string; content?: { body?: string } };
      assert.equal(survivingLookup.ok, true);
      assert.equal(survivingLookup.id, survivingNoteId);
      assert.match(survivingLookup.content?.body ?? "", /PUBLIC-EVIDENCE-SURVIVES/u);

      const postBackupLookup = await restoredFoundation1.content.invoke("memory_get", {
        id: postBackupNoteId,
      }) as { ok: boolean; id?: string; content?: { body?: string } };
      assert.equal(postBackupLookup.ok, true);
      assert.equal(postBackupLookup.id, postBackupNoteId);
      assert.match(postBackupLookup.content?.body ?? "", /Replay post-backup events during restore/u);

      assert.throws(
        () =>
          openStoredEvidenceFromVault(
            restoredVaultRoot1,
            fixture.projectId,
            fixture.storeId,
            erasedEvidenceId,
          ),
        (err: unknown) => err instanceof RetainedEvidenceError,
      );

      const survivingPlaintext = openStoredEvidenceFromVault(
        restoredVaultRoot1,
        fixture.projectId,
        fixture.storeId,
        survivingEvidenceId,
      );
      assert.match(survivingPlaintext, /PUBLIC-EVIDENCE-SURVIVES/u);
    } finally {
      await restoredFoundation1.close();
    }

    // Case 2: Restore older backup WITHOUT postBackupSourceVaultRoot, supplying extraErasureFences from newer custody state
    const sourceCustody = new OperationalKeyCustodyProvider({
      storeRoot: fixture.storeRoot,
      projectId: fixture.projectId,
      storeId: fixture.storeId,
    });
    const newerFences = sourceCustody.listErasureFences();
    sourceCustody.close();
    assert.ok(newerFences.some((f) => f.evidenceId === erasedEvidenceId));

    const restoredProjectRoot2 = join(fixture.rootDir, "restored-2");
    const restoredVaultRoot2 = join(restoredProjectRoot2, "memory-v2");
    const receipt2 = await restoreService.restoreToIsolatedVault({
      backupDirectory: olderBackupDir,
      targetProjectRoot: restoredProjectRoot2,
      targetV2VaultRoot: restoredVaultRoot2,
      v1ArchiveRoot: fixture.v1ArchiveRoot,
      extraErasureFences: newerFences,
      now: "2026-07-01T00:30:00.000Z",
    });

    assert.equal(receipt2.status, "active");
    assert.equal(receipt2.eventIntegrityVerified, true);
    assert.equal(receipt2.projectionIntegrityVerified, true);
    assert.ok(receipt2.erasedEvidenceIdsApplied.includes(erasedEvidenceId));

    const restoredConfig2 = loadV2LaunchConfig({
      ...process.env,
      MEMORY_PROJECT_ROOT: restoredProjectRoot2,
      MEMORY_V2_VAULT_PATH: restoredVaultRoot2,
      MEMORY_V1_ARCHIVE_PATH: fixture.v1ArchiveRoot,
      MEMORY_V2_RELEASE_ID: fixture.releaseId,
    });
    const restoredFoundation2 = await createV2Foundation(restoredConfig2, { entryUrl: V2_DIST_ENTRY_URL });
    try {
      const erasedLookup2 = await restoredFoundation2.content.invoke("memory_get", {
        id: erasedNoteId,
      }) as { ok: boolean; found?: boolean };
      assert.equal(erasedLookup2.ok, false);
      assert.equal(erasedLookup2.found, false);

      assert.throws(
        () =>
          openStoredEvidenceFromVault(
            restoredVaultRoot2,
            fixture.projectId,
            fixture.storeId,
            erasedEvidenceId,
          ),
        (err: unknown) => err instanceof RetainedEvidenceError,
      );
    } finally {
      await restoredFoundation2.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test("V2RestoreService reports incomplete-fence in read-only-recovery mode when requiredRecoveryFence exceeds available events, and rejects tampered backups", async () => {
  const fixture = await createActiveStoreFixture("pm-v2-restore-fence-");
  try {
    const foundation = await createV2Foundation(fixture.config, { entryUrl: V2_DIST_ENTRY_URL });
    try {
      await foundation.content.invoke("memory_sessionStart", {
        agentName: "fence-agent",
        taskDescription: "Incomplete fence check",
      });
    } finally {
      await foundation.close();
    }

    const backupService = new V2BackupService();
    const backupDir = join(fixture.rootDir, "backups", "fence-backup");
    const manifest = await backupService.createBackup({
      projectRoot: fixture.projectRoot,
      v2VaultRoot: fixture.v2VaultRoot,
      v1ArchiveRoot: fixture.v1ArchiveRoot,
      outputDirectory: backupDir,
      reason: "manual",
      now: "2026-07-01T00:10:00.000Z",
    });

    const restoreService = new V2RestoreService();
    const incompleteProjectRoot = join(fixture.rootDir, "restored-incomplete");
    const incompleteVaultRoot = join(incompleteProjectRoot, "memory-v2");
    const expectedFencePos = (BigInt(manifest.terminalGlobalPosition) + 5n).toString();
    const expectedFenceHash = "f".repeat(64);

    const incompleteReceipt = await restoreService.restoreToIsolatedVault({
      backupDirectory: backupDir,
      targetProjectRoot: incompleteProjectRoot,
      targetV2VaultRoot: incompleteVaultRoot,
      v1ArchiveRoot: fixture.v1ArchiveRoot,
      requiredRecoveryFence: {
        position: expectedFencePos,
        hash: expectedFenceHash,
      },
      now: "2026-07-01T00:20:00.000Z",
    });

    assert.equal(incompleteReceipt.status, "incomplete-fence");
    assert.deepEqual(incompleteReceipt.missingRange, {
      fromExclusivePosition: manifest.terminalGlobalPosition,
      toInclusivePosition: expectedFencePos,
      expectedHash: expectedFenceHash,
    });

    // Verify restored store is in read-only-recovery mode and denies mutations
    const incompleteConfig = loadV2LaunchConfig({
      ...process.env,
      MEMORY_PROJECT_ROOT: incompleteProjectRoot,
      MEMORY_V2_VAULT_PATH: incompleteVaultRoot,
      MEMORY_V1_ARCHIVE_PATH: fixture.v1ArchiveRoot,
      MEMORY_V2_RELEASE_ID: fixture.releaseId,
    });
    const incompleteFoundation = await createV2Foundation(incompleteConfig, { entryUrl: V2_DIST_ENTRY_URL });
    try {
      await assert.rejects(
        () =>
          incompleteFoundation.content.invoke("memory_sessionStart", {
            agentName: "blocked-agent",
            taskDescription: "Should fail in read-only-recovery mode",
          }),
        (err: unknown) => err instanceof FreshStartError && err.code === "FRESH_START_ADMISSION_DENIED",
      );
    } finally {
      await incompleteFoundation.close();
    }

    // Tamper with a copy of the backup and verify FRESH_START_RECOVERY_CORRUPT
    const tamperedBackupDir = join(fixture.rootDir, "backups", "tampered-backup");
    await backupService.createBackup({
      projectRoot: fixture.projectRoot,
      v2VaultRoot: fixture.v2VaultRoot,
      v1ArchiveRoot: fixture.v1ArchiveRoot,
      outputDirectory: tamperedBackupDir,
      reason: "manual",
      now: "2026-07-01T00:12:00.000Z",
    });
    writeFileSync(join(tamperedBackupDir, "project-identity.json"), "{\"corrupted\":true}\n", "utf8");

    const tamperedTargetProject = join(fixture.rootDir, "restored-tampered");
    const tamperedTargetVault = join(tamperedTargetProject, "memory-v2");
    await assert.rejects(
      () =>
        restoreService.restoreToIsolatedVault({
          backupDirectory: tamperedBackupDir,
          targetProjectRoot: tamperedTargetProject,
          targetV2VaultRoot: tamperedTargetVault,
          v1ArchiveRoot: fixture.v1ArchiveRoot,
          now: "2026-07-01T00:25:00.000Z",
        }),
      (err: unknown) => err instanceof FreshStartError && err.code === "FRESH_START_RECOVERY_CORRUPT",
    );
  } finally {
    fixture.cleanup();
  }
});

test("V2RollbackService verifies schema and migration fingerprint compatibility and flags when restore from pre-upgrade backup is required", async () => {
  const fixture = await createActiveStoreFixture("pm-v2-rollback-");
  try {
    const rollbackService = new V2RollbackService();

    const compatible = await rollbackService.verifyRollbackCompatibility({
      v2VaultRoot: fixture.v2VaultRoot,
      targetEventStoreSchemaVersion: 9,
      targetProjectionSchemaVersion: 3,
    });
    assert.equal(compatible.compatible, true);
    assert.equal(compatible.requiresRestoreFromPreUpgradeBackup, false);
    assert.equal(compatible.currentEventStoreSchemaVersion, 9);
    assert.equal(compatible.currentProjectionSchemaVersion, 3);

    const incompatibleVersion = await rollbackService.verifyRollbackCompatibility({
      v2VaultRoot: fixture.v2VaultRoot,
      targetEventStoreSchemaVersion: 8,
      targetProjectionSchemaVersion: 3,
    });
    assert.equal(incompatibleVersion.compatible, false);
    assert.equal(incompatibleVersion.requiresRestoreFromPreUpgradeBackup, true);

    const incompatibleFingerprint = await rollbackService.verifyRollbackCompatibility({
      v2VaultRoot: fixture.v2VaultRoot,
      targetEventStoreSchemaVersion: 9,
      targetProjectionSchemaVersion: 3,
      targetMigrationFingerprint: "0".repeat(64),
    });
    assert.equal(incompatibleFingerprint.compatible, false);
    assert.equal(incompatibleFingerprint.requiresRestoreFromPreUpgradeBackup, true);
  } finally {
    fixture.cleanup();
  }
});
