import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { FreshStartRelease, FreshStartTransitionRequest } from "../src/orchestrator/fresh-start/contracts.js";
import { FreshStartControlPlane } from "../src/orchestrator/fresh-start/fresh-start-control-plane.js";
import { SqliteFreshStartRepository } from "../src/orchestrator/fresh-start/fresh-start.repository.js";
import * as operatorApprovalModule from "../src/orchestrator/fresh-start/operator-approval.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { PROJECT_STORE_MIGRATIONS } from "../src/orchestrator/storage/migrations/registry.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import { expectedSchemaFingerprint } from "../src/orchestrator/storage/schema-fingerprint.js";
import {
  V2_PRODUCTION_CAPABILITIES,
  V2_PRODUCTION_RECOVERY_POLICY,
  loadV2LaunchConfig,
} from "../src/v2/config.js";
import { applyCurrentProjectStoreSchema } from "./support/current-project-store-schema.js";
import {
  FRESH_IDENTITY,
  FRESH_NOW,
  FRESH_RELEASE_ID,
  freshGenesis,
  freshRelease,
} from "./support/fresh-start-fixture.js";

const ROOT = resolve(".");
const DIST_V2 = resolve("dist/v2.js");
const DIST_V2_ADMIN = resolve("dist/v2-admin.js");
const RELEASE_SCRIPT = resolve("scripts/run-v2-fresh-start-release.js");

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function makeDirectoriesWritableRecursive(dirPath: string): void {
  if (!existsSync(dirPath)) return;
  try {
    chmodSync(dirPath, 0o777);
  } catch {
    // Ignore permission errors during cleanup
  }
}

test("createSignedOperatorApprovalEnvelope, createHmacOperatorApprovalVerifier, and createReleaseEvidenceReportVerifier enforce cryptographic proofs and replay protection in FreshStartControlPlane", async () => {
  const {
    createSignedOperatorApprovalEnvelope,
    serializeOperatorApprovalEnvelope,
    createHmacOperatorApprovalVerifier,
    computeReleaseEvidenceReportDigest,
    createReleaseEvidenceReportVerifier,
    freshStartRequestDigest,
  } = operatorApprovalModule as Record<string, any>;

  assert.equal(typeof createSignedOperatorApprovalEnvelope, "function");
  assert.equal(typeof serializeOperatorApprovalEnvelope, "function");
  assert.equal(typeof createHmacOperatorApprovalVerifier, "function");
  assert.equal(typeof computeReleaseEvidenceReportDigest, "function");
  assert.equal(typeof createReleaseEvidenceReportVerifier, "function");

  const tempDir = realpathSync.native(mkdtempSync(join(tmpdir(), "v2-approval-test-")));
  const driver = new NodeSqliteDriver({ DatabaseSync });
  const dbPath = join(tempDir, "events.sqlite");
  const connection = driver.open(dbPath, { mode: "create", busyTimeoutMs: 1_000 });

  try {
    applyCurrentProjectStoreSchema(connection, FRESH_IDENTITY, FRESH_NOW);
    const repository = new SqliteFreshStartRepository(connection);

    const unsignedEvidenceReport = {
      schemaVersion: 1 as const,
      status: "ready-for-activation" as const,
      productionReady: true as const,
      releaseId: FRESH_RELEASE_ID,
      buildIdentityHash: "a".repeat(64),
      schemaIdentityHash: "b".repeat(64),
      capabilityManifestHash: sha256(V2_PRODUCTION_CAPABILITIES),
      recoveryPolicyHash: sha256(V2_PRODUCTION_RECOVERY_POLICY),
      scenarios: [
        { id: "scenario-1-empty-start-write-restart-retrieval", passed: true as const },
        { id: "scenario-2-public-workflows-and-governance", passed: true as const },
        { id: "scenario-3-v1-archive-isolation-and-path-overlap", passed: true as const },
        { id: "scenario-4-binding-capability-and-generation-refusals", passed: true as const },
        { id: "scenario-5-crash-recovery-and-idempotent-fencing", passed: true as const },
        { id: "scenario-6-verified-backup-isolated-restore-replay-and-rollback", passed: true as const },
        { id: "scenario-7-privacy-redaction-encryption-key-rotation-and-erasure-after-restore", passed: true as const },
        { id: "scenario-8-bounded-failures-and-operational-limits", passed: true as const },
      ],
      generatedAt: "2026-10-20T00:00:00.000Z",
    };
    const reportDigest = computeReleaseEvidenceReportDigest(unsignedEvidenceReport);
    const evidenceReport = {
      ...unsignedEvidenceReport,
      reportDigest,
    };

    const release: FreshStartRelease = freshRelease({
      capabilityManifestHash: unsignedEvidenceReport.capabilityManifestHash,
      recoveryPolicyHash: unsignedEvidenceReport.recoveryPolicyHash,
      evidenceDigest: reportDigest,
    });
    repository.transact(FRESH_IDENTITY, (tx) => tx.install(freshGenesis(), release));

    const secret = "operator-secret-key-for-v2-cutover-2026";
    const nowIso = "2026-10-20T00:05:00.000Z";
    const issuedAt = "2026-10-20T00:00:00.000Z";
    const expiresAt = "2026-10-20T00:10:00.000Z";

    const baseRequest: FreshStartTransitionRequest = {
      identity: FRESH_IDENTITY,
      expectedGeneration: 0n,
      expectedMode: "prepared",
      expectedReleaseId: FRESH_RELEASE_ID,
      nextMode: "active",
      nextRelease: release,
      approvalEnvelope: new Uint8Array([0]),
    };
    const requestDigest = freshStartRequestDigest(baseRequest);
    const approvalId = randomUUID();
    const nonceDigest = "1".repeat(64);
    const actorFingerprint = "2".repeat(64);

    const envelope = createSignedOperatorApprovalEnvelope({
      identity: FRESH_IDENTITY,
      approvalId,
      nonceDigest,
      actorFingerprint,
      requestDigest,
      evidenceDigest: reportDigest,
      issuedAt,
      expiresAt,
      secret,
    });
    const envelopeBytes = serializeOperatorApprovalEnvelope(envelope);

    const approvalVerifier = createHmacOperatorApprovalVerifier(secret, { now: () => nowIso });
    const evidenceVerifier = createReleaseEvidenceReportVerifier(evidenceReport);

    // 1. Wrong secret is rejected
    const wrongSecretVerifier = createHmacOperatorApprovalVerifier(
      "wrong-operator-secret-key-000000000",
      { now: () => nowIso },
    );
    await assert.rejects(
      new FreshStartControlPlane(repository, wrongSecretVerifier, evidenceVerifier).transition({
        ...baseRequest,
        approvalEnvelope: envelopeBytes,
      }),
      { code: "FRESH_START_APPROVAL_INVALID" },
    );

    // 2. Expired TTL is rejected
    const expiredVerifier = createHmacOperatorApprovalVerifier(secret, {
      now: () => "2026-10-20T00:20:00.000Z",
    });
    await assert.rejects(
      new FreshStartControlPlane(repository, expiredVerifier, evidenceVerifier).transition({
        ...baseRequest,
        approvalEnvelope: envelopeBytes,
      }),
      { code: "FRESH_START_APPROVAL_INVALID" },
    );

    // 3. Tampered requestDigest is rejected
    const tamperedEnvelope = {
      ...envelope,
      requestDigest: "9".repeat(64),
    };
    await assert.rejects(
      new FreshStartControlPlane(repository, approvalVerifier, evidenceVerifier).transition({
        ...baseRequest,
        approvalEnvelope: new Uint8Array(Buffer.from(canonicalJson(tamperedEnvelope), "utf8")),
      }),
      { code: "FRESH_START_APPROVAL_INVALID" },
    );

    // 4. Tampered evidence report is rejected
    const tamperedEvidenceVerifier = createReleaseEvidenceReportVerifier({
      ...evidenceReport,
      buildIdentityHash: "0".repeat(64),
    });
    await assert.rejects(
      new FreshStartControlPlane(repository, approvalVerifier, tamperedEvidenceVerifier).transition({
        ...baseRequest,
        approvalEnvelope: envelopeBytes,
      }),
      { code: "FRESH_START_EVIDENCE_INVALID" },
    );

    // 5. Valid approval and evidence transition prepared -> active
    const controlPlane = new FreshStartControlPlane(repository, approvalVerifier, evidenceVerifier);
    const activeState = await controlPlane.transition({
      ...baseRequest,
      approvalEnvelope: envelopeBytes,
    });
    assert.equal(activeState.mode, "active");
    assert.equal(activeState.generation, 1n);

    // 6. Replayed approvalId or nonceDigest is rejected by FreshStartControlPlane
    const disableReqBase: FreshStartTransitionRequest = {
      identity: FRESH_IDENTITY,
      expectedGeneration: 1n,
      expectedMode: "active",
      expectedReleaseId: FRESH_RELEASE_ID,
      nextMode: "disabled",
      nextRelease: release,
      approvalEnvelope: new Uint8Array([0]),
    };
    const disableRequestDigest = freshStartRequestDigest(disableReqBase);
    const replayIdEnvelope = createSignedOperatorApprovalEnvelope({
      identity: FRESH_IDENTITY,
      approvalId, // Reused approvalId
      nonceDigest: "3".repeat(64),
      actorFingerprint,
      requestDigest: disableRequestDigest,
      evidenceDigest: reportDigest,
      issuedAt,
      expiresAt,
      secret,
    });
    await assert.rejects(
      controlPlane.transition({
        ...disableReqBase,
        approvalEnvelope: serializeOperatorApprovalEnvelope(replayIdEnvelope),
      }),
      { code: "FRESH_START_APPROVAL_REUSED" },
    );

    const replayNonceEnvelope = createSignedOperatorApprovalEnvelope({
      identity: FRESH_IDENTITY,
      approvalId: randomUUID(),
      nonceDigest, // Reused nonceDigest
      actorFingerprint,
      requestDigest: disableRequestDigest,
      evidenceDigest: reportDigest,
      issuedAt,
      expiresAt,
      secret,
    });
    await assert.rejects(
      controlPlane.transition({
        ...disableReqBase,
        approvalEnvelope: serializeOperatorApprovalEnvelope(replayNonceEnvelope),
      }),
      { code: "FRESH_START_APPROVAL_REUSED" },
    );
  } finally {
    connection.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("v2-admin.js freeze-v1-archive and verify-v1-archive write cryptographic manifest, enforce read-only permissions, and detect tampering", () => {
  const rootDir = realpathSync.native(mkdtempSync(join(tmpdir(), "v2-archive-freeze-")));
  const projectRoot = join(rootDir, "project");
  const v1ArchiveRoot = join(projectRoot, "v1-archive");
  const v2VaultRoot = join(projectRoot, "memory-v2");
  mkdirSync(join(v1ArchiveRoot, "nested"), { recursive: true });
  mkdirSync(v2VaultRoot, { recursive: true });

  const fileA = join(v1ArchiveRoot, "note-a.md");
  const fileB = join(v1ArchiveRoot, "nested", "note-b.md");
  writeFileSync(fileA, "# Archive Note A\nImmutable V1 content.\n", "utf8");
  writeFileSync(fileB, "# Archive Note B\nNested immutable V1 content.\n", "utf8");

  try {
    const freezeRes = spawnSync(
      process.execPath,
      [
        DIST_V2_ADMIN,
        "freeze-v1-archive",
        "--project-root",
        projectRoot,
        "--v2-vault-root",
        v2VaultRoot,
        "--v1-archive-root",
        v1ArchiveRoot,
      ],
      { cwd: ROOT, encoding: "utf8", timeout: 20_000 },
    );
    assert.equal(freezeRes.status, 0, freezeRes.stderr);
    const freezeJson = JSON.parse(freezeRes.stdout) as {
      ok: boolean;
      fileCount: number;
      manifestSha256: string;
    };
    assert.equal(freezeJson.ok, true);
    assert.equal(freezeJson.fileCount, 2);
    assert.match(freezeJson.manifestSha256, /^[0-9a-f]{64}$/u);

    const manifestPath = join(v2VaultRoot, ".memory-mcp", "v1-archive-manifest.json");
    assert.equal(existsSync(manifestPath), true);

    const verifyRes = spawnSync(
      process.execPath,
      [
        DIST_V2_ADMIN,
        "verify-v1-archive",
        "--project-root",
        projectRoot,
        "--v2-vault-root",
        v2VaultRoot,
        "--v1-archive-root",
        v1ArchiveRoot,
      ],
      { cwd: ROOT, encoding: "utf8", timeout: 20_000 },
    );
    assert.equal(verifyRes.status, 0, verifyRes.stderr);
    const verifyJson = JSON.parse(verifyRes.stdout) as {
      ok: boolean;
      verifiedFiles: number;
      writeDenied: boolean;
      manifestSha256: string;
    };
    assert.equal(verifyJson.ok, true);
    assert.equal(verifyJson.verifiedFiles, 2);
    assert.equal(verifyJson.writeDenied, true);
    assert.equal(verifyJson.manifestSha256, freezeJson.manifestSha256);

    // Tamper with a file inside the archive and verify detection
    chmodSync(fileA, 0o666);
    writeFileSync(fileA, "# Tampered Archive Note A\n", "utf8");
    chmodSync(fileA, 0o444);

    const tamperedVerifyRes = spawnSync(
      process.execPath,
      [
        DIST_V2_ADMIN,
        "verify-v1-archive",
        "--project-root",
        projectRoot,
        "--v2-vault-root",
        v2VaultRoot,
        "--v1-archive-root",
        v1ArchiveRoot,
      ],
      { cwd: ROOT, encoding: "utf8", timeout: 20_000 },
    );
    assert.equal(tamperedVerifyRes.status, 1);
    assert.match(tamperedVerifyRes.stderr, /FRESH_START_RECOVERY_CORRUPT/);
  } finally {
    try {
      chmodSync(fileA, 0o666);
      chmodSync(fileB, 0o666);
    } catch {
      // Ignore
    }
    makeDirectoriesWritableRecursive(rootDir);
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("v2-admin.js generate-client-configs outputs valid V2 client configurations for all 7 clients", () => {
  const rootDir = realpathSync.native(mkdtempSync(join(tmpdir(), "v2-client-configs-")));
  const projectRoot = join(rootDir, "project");
  const v1ArchiveRoot = join(projectRoot, "archive");
  const v2VaultRoot = join(projectRoot, "memory-v2");
  const outputDir = join(rootDir, "generated-configs");
  mkdirSync(v1ArchiveRoot, { recursive: true });
  mkdirSync(v2VaultRoot, { recursive: true });
  const releaseId = randomUUID();

  try {
    const res = spawnSync(
      process.execPath,
      [
        DIST_V2_ADMIN,
        "generate-client-configs",
        "--project-root",
        projectRoot,
        "--v2-vault-root",
        v2VaultRoot,
        "--v1-archive-root",
        v1ArchiveRoot,
        "--release-id",
        releaseId,
        "--output-dir",
        outputDir,
      ],
      { cwd: ROOT, encoding: "utf8", timeout: 20_000 },
    );
    assert.equal(res.status, 0, res.stderr);
    const payload = JSON.parse(res.stdout) as {
      ok: boolean;
      v2EntryPath: string;
      env: Record<string, string>;
      clients: Record<
        string,
        {
          configPath: string;
          command: string;
          args: string[];
          env: Record<string, string>;
        }
      >;
      writtenFiles: string[];
    };

    assert.equal(payload.ok, true);
    assert.equal(payload.v2EntryPath, DIST_V2);
    const validatedTopEnv = loadV2LaunchConfig(payload.env);
    assert.equal(validatedTopEnv.releaseId, releaseId);

    const expectedClients = [
      "codex",
      "opencode",
      "antigravity",
      "cursor",
      "zed",
      "windsurf",
      "claudeCode",
    ];
    for (const clientName of expectedClients) {
      const clientConfig = payload.clients[clientName];
      assert.ok(clientConfig, `Missing client config for ${clientName}`);
      assert.ok(clientConfig.args.includes(DIST_V2), `${clientName} args must point to dist/v2.js`);
      const parsedEnv = loadV2LaunchConfig(clientConfig.env);
      assert.equal(parsedEnv.projectRoot, projectRoot);
      assert.equal(parsedEnv.v2VaultRoot, v2VaultRoot);
      assert.equal(parsedEnv.v1ArchiveRoot, v1ArchiveRoot);
      assert.equal(parsedEnv.releaseId, releaseId);
    }

    for (const relFile of [
      ".codex/config.toml",
      "opencode.json",
      ".antigravity/mcp.json",
      ".cursor/mcp.json",
      ".zed/settings.json",
      ".windsurf/mcp.json",
      ".mcp.json",
      ".claude/settings.local.json",
    ]) {
      assert.equal(existsSync(join(outputDir, relFile)), true, `Expected written file ${relFile}`);
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("v2-admin.js operator cutover lifecycle (sign-approval, activate, backup, enter-recovery, rebuild-projections, verify-recovery, exit-recovery, restore, disable)", () => {
  const rootDir = realpathSync.native(mkdtempSync(join(tmpdir(), "v2-admin-lifecycle-")));
  const projectRoot = join(rootDir, "project");
  const v1ArchiveRoot = join(projectRoot, "archive");
  const v2VaultRoot = join(projectRoot, "memory-v2");
  const backupRoot = join(rootDir, "backup-1");
  const restoredProjectRoot = join(rootDir, "restored-project");
  const restoredVaultRoot = join(restoredProjectRoot, "memory-v2");
  mkdirSync(v1ArchiveRoot, { recursive: true });
  writeFileSync(join(v1ArchiveRoot, "sentinel.txt"), "v1-sentinel");

  const releaseId = randomUUID();
  const approvalSecret = "operator-approval-secret-key-2026-prod";
  const build = JSON.parse(readFileSync(resolve("dist/v2-build.json"), "utf8")) as {
    buildIdentityHash: string;
  };
  const schemaIdentityHash = expectedSchemaFingerprint(PROJECT_STORE_MIGRATIONS);

  const { computeReleaseEvidenceReportDigest } = operatorApprovalModule as Record<string, any>;
  const unsignedEvidence = {
    schemaVersion: 1 as const,
    status: "ready-for-activation" as const,
    productionReady: true as const,
    releaseId,
    buildIdentityHash: build.buildIdentityHash,
    schemaIdentityHash,
    capabilityManifestHash: sha256(V2_PRODUCTION_CAPABILITIES),
    recoveryPolicyHash: sha256(V2_PRODUCTION_RECOVERY_POLICY),
    scenarios: [
      { id: "scenario-1-empty-start-write-restart-retrieval", passed: true as const },
      { id: "scenario-2-public-workflows-and-governance", passed: true as const },
      { id: "scenario-3-v1-archive-isolation-and-path-overlap", passed: true as const },
      { id: "scenario-4-binding-capability-and-generation-refusals", passed: true as const },
      { id: "scenario-5-crash-recovery-and-idempotent-fencing", passed: true as const },
      { id: "scenario-6-verified-backup-isolated-restore-replay-and-rollback", passed: true as const },
      { id: "scenario-7-privacy-redaction-encryption-key-rotation-and-erasure-after-restore", passed: true as const },
      { id: "scenario-8-bounded-failures-and-operational-limits", passed: true as const },
    ],
    generatedAt: new Date().toISOString(),
  };
  const evidenceDigest = computeReleaseEvidenceReportDigest(unsignedEvidence);
  const evidencePath = join(rootDir, "release-evidence.json");
  writeFileSync(
    evidencePath,
    JSON.stringify({ ...unsignedEvidence, reportDigest: evidenceDigest }),
    "utf8",
  );

  const releaseManifestPath = join(rootDir, "release-manifest.json");
  writeFileSync(
    releaseManifestPath,
    JSON.stringify({
      initializationId: randomUUID(),
      release: {
        profileVersion: 1,
        releaseId,
        buildIdentityHash: build.buildIdentityHash,
        schemaIdentityHash,
        configurationHash: sha256({
          projectRoot,
          v2VaultRoot,
          v1ArchiveRoot,
          releaseId,
        }),
        capabilityManifestHash: unsignedEvidence.capabilityManifestHash,
        recoveryPolicyHash: unsignedEvidence.recoveryPolicyHash,
        evidenceDigest,
        createdAt: new Date().toISOString(),
      },
    }),
    "utf8",
  );

  const baseFlags = [
    "--project-root",
    projectRoot,
    "--v2-vault-root",
    v2VaultRoot,
    "--v1-archive-root",
    v1ArchiveRoot,
    "--release-manifest",
    releaseManifestPath,
  ];
  const env = {
    ...process.env,
    MEMORY_V2_OPERATOR_APPROVAL_KEY: approvalSecret,
  };

  try {
    // 1. initialize-fresh
    const initRes = spawnSync(process.execPath, [DIST_V2_ADMIN, "initialize-fresh", ...baseFlags], {
      cwd: ROOT,
      env,
      encoding: "utf8",
      timeout: 20_000,
    });
    assert.equal(initRes.status, 0, initRes.stderr);
    const initStatus = JSON.parse(initRes.stdout);
    assert.equal(initStatus.mode, "prepared");
    assert.equal(initStatus.productionReady, false);

    // 2. activate without approval/evidence still fails with FRESH_START_RELEASE_NOT_READY
    const noApprovalActivate = spawnSync(
      process.execPath,
      [DIST_V2_ADMIN, "activate", ...baseFlags],
      { cwd: ROOT, env, encoding: "utf8", timeout: 20_000 },
    );
    assert.equal(noApprovalActivate.status, 1);
    assert.match(noApprovalActivate.stderr, /FRESH_START_RELEASE_NOT_READY/);

    // 3. sign-approval + activate
    const approvalActivatePath = join(rootDir, "approval-activate.json");
    const signActRes = spawnSync(
      process.execPath,
      [
        DIST_V2_ADMIN,
        "sign-approval",
        ...baseFlags,
        "--next-mode",
        "active",
        "--output",
        approvalActivatePath,
      ],
      { cwd: ROOT, env, encoding: "utf8", timeout: 20_000 },
    );
    assert.equal(signActRes.status, 0, signActRes.stderr);

    const actRes = spawnSync(
      process.execPath,
      [
        DIST_V2_ADMIN,
        "activate",
        ...baseFlags,
        "--operator-approval",
        approvalActivatePath,
        "--release-evidence",
        evidencePath,
      ],
      { cwd: ROOT, env, encoding: "utf8", timeout: 20_000 },
    );
    assert.equal(actRes.status, 0, actRes.stderr);
    const activeStatus = JSON.parse(actRes.stdout);
    assert.equal(activeStatus.mode, "active");
    assert.equal(activeStatus.productionReady, true);
    assert.equal(activeStatus.generation, "1");

    // 4. backup + verify-recovery + rebuild-projections + restore
    const backupRes = spawnSync(
      process.execPath,
      [
        DIST_V2_ADMIN,
        "backup",
        "--project-root",
        projectRoot,
        "--v2-vault-root",
        v2VaultRoot,
        "--v1-archive-root",
        v1ArchiveRoot,
        "--backup-root",
        backupRoot,
      ],
      { cwd: ROOT, env, encoding: "utf8", timeout: 20_000 },
    );
    assert.equal(backupRes.status, 0, backupRes.stderr);
    const backupManifest = JSON.parse(backupRes.stdout);
    assert.equal(backupManifest.manifestVersion, 1);

    const verifyRecRes = spawnSync(
      process.execPath,
      [
        DIST_V2_ADMIN,
        "verify-recovery",
        "--project-root",
        projectRoot,
        "--v2-vault-root",
        v2VaultRoot,
        "--v1-archive-root",
        v1ArchiveRoot,
      ],
      { cwd: ROOT, env, encoding: "utf8", timeout: 20_000 },
    );
    assert.equal(verifyRecRes.status, 0, verifyRecRes.stderr);
    const verifyRecJson = JSON.parse(verifyRecRes.stdout);
    assert.equal(verifyRecJson.ok, true);

    const rebuildProjRes = spawnSync(
      process.execPath,
      [
        DIST_V2_ADMIN,
        "rebuild-projections",
        "--project-root",
        projectRoot,
        "--v2-vault-root",
        v2VaultRoot,
        "--v1-archive-root",
        v1ArchiveRoot,
      ],
      { cwd: ROOT, env, encoding: "utf8", timeout: 20_000 },
    );
    assert.equal(rebuildProjRes.status, 0, rebuildProjRes.stderr);
    assert.equal(JSON.parse(rebuildProjRes.stdout).ok, true);

    const restoreRes = spawnSync(
      process.execPath,
      [
        DIST_V2_ADMIN,
        "restore",
        "--project-root",
        restoredProjectRoot,
        "--v2-vault-root",
        restoredVaultRoot,
        "--v1-archive-root",
        v1ArchiveRoot,
        "--backup-root",
        backupRoot,
      ],
      { cwd: ROOT, env, encoding: "utf8", timeout: 20_000 },
    );
    assert.equal(restoreRes.status, 0, restoreRes.stderr);
    assert.equal(JSON.parse(restoreRes.stdout).status, "active");

    // 5. enter-recovery -> exit-recovery -> disable
    const approvalRecPath = join(rootDir, "approval-recovery.json");
    assert.equal(
      spawnSync(
        process.execPath,
        [
          DIST_V2_ADMIN,
          "sign-approval",
          ...baseFlags,
          "--next-mode",
          "read-only-recovery",
          "--output",
          approvalRecPath,
        ],
        { cwd: ROOT, env, encoding: "utf8", timeout: 20_000 },
      ).status,
      0,
    );
    const enterRecRes = spawnSync(
      process.execPath,
      [
        DIST_V2_ADMIN,
        "enter-recovery",
        ...baseFlags,
        "--operator-approval",
        approvalRecPath,
        "--release-evidence",
        evidencePath,
      ],
      { cwd: ROOT, env, encoding: "utf8", timeout: 20_000 },
    );
    assert.equal(enterRecRes.status, 0, enterRecRes.stderr);
    assert.equal(JSON.parse(enterRecRes.stdout).mode, "read-only-recovery");

    const approvalExitRecPath = join(rootDir, "approval-exit-recovery.json");
    assert.equal(
      spawnSync(
        process.execPath,
        [
          DIST_V2_ADMIN,
          "sign-approval",
          ...baseFlags,
          "--next-mode",
          "active",
          "--output",
          approvalExitRecPath,
        ],
        { cwd: ROOT, env, encoding: "utf8", timeout: 20_000 },
      ).status,
      0,
    );
    const exitRecRes = spawnSync(
      process.execPath,
      [
        DIST_V2_ADMIN,
        "exit-recovery",
        ...baseFlags,
        "--operator-approval",
        approvalExitRecPath,
        "--release-evidence",
        evidencePath,
      ],
      { cwd: ROOT, env, encoding: "utf8", timeout: 20_000 },
    );
    assert.equal(exitRecRes.status, 0, exitRecRes.stderr);
    assert.equal(JSON.parse(exitRecRes.stdout).mode, "active");

    const approvalDisablePath = join(rootDir, "approval-disable.json");
    assert.equal(
      spawnSync(
        process.execPath,
        [
          DIST_V2_ADMIN,
          "sign-approval",
          ...baseFlags,
          "--next-mode",
          "disabled",
          "--output",
          approvalDisablePath,
        ],
        { cwd: ROOT, env, encoding: "utf8", timeout: 20_000 },
      ).status,
      0,
    );
    const disableRes = spawnSync(
      process.execPath,
      [
        DIST_V2_ADMIN,
        "disable",
        ...baseFlags,
        "--operator-approval",
        approvalDisablePath,
        "--release-evidence",
        evidencePath,
      ],
      { cwd: ROOT, env, encoding: "utf8", timeout: 20_000 },
    );
    assert.equal(disableRes.status, 0, disableRes.stderr);
    assert.equal(JSON.parse(disableRes.stdout).mode, "disabled");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("scripts/run-v2-fresh-start-release.js executes all 8 compiled public-service scenarios and emits verified release evidence", () => {
  assert.equal(existsSync(RELEASE_SCRIPT), true, "scripts/run-v2-fresh-start-release.js must exist");
  const tempDir = realpathSync.native(mkdtempSync(join(tmpdir(), "v2-release-gate-out-")));
  const outputPath = join(tempDir, "release-evidence.json");
  try {
    const res = spawnSync(process.execPath, [RELEASE_SCRIPT, "--output", outputPath], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 300_000,
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(existsSync(outputPath), true);
    const report = JSON.parse(readFileSync(outputPath, "utf8")) as {
      schemaVersion: number;
      status: string;
      productionReady: boolean;
      buildIdentityHash: string;
      schemaIdentityHash: string;
      capabilityManifestHash: string;
      recoveryPolicyHash: string;
      scenarios: Array<{ id: string; passed: boolean }>;
      generatedAt: string;
      reportDigest: string;
    };
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.status, "ready-for-activation");
    assert.equal(report.productionReady, true);
    assert.equal(report.scenarios.length, 8);
    assert.equal(
      report.scenarios.every((s) => s.passed === true),
      true,
    );
    const { computeReleaseEvidenceReportDigest } = operatorApprovalModule as Record<string, any>;
    const { reportDigest, ...withoutDigest } = report;
    assert.equal(reportDigest, computeReleaseEvidenceReportDigest(withoutDigest));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
