import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { FreshStartError } from "../src/orchestrator/fresh-start/contracts.js";
import type { FreshStartPaths } from "../src/orchestrator/fresh-start/fresh-start-paths.js";
import { OperationalKeyCustodyProvider } from "../src/orchestrator/keys/operational-key-custody.js";
import {
  ALL_CAPABILITY_KEY_PURPOSES,
  ALL_EVIDENCE_KEY_PURPOSES,
} from "../src/orchestrator/keys/operational-key-custody.js";
import {
  decodeRetainEvidenceBatch,
  RETAINED_EVIDENCE_LIMITS,
  RetainedEvidenceError,
} from "../src/orchestrator/privacy/evidence-contracts.js";
import {
  openEvidenceItem,
  sealEvidenceItem,
  type EvidenceItemBindingV1,
} from "../src/orchestrator/privacy/evidence-envelope.js";
import {
  prepareLargeEvidenceFrames,
  reassembleChunkedEvidenceFrames,
} from "../src/orchestrator/privacy/large-frame-chunking.js";
import {
  redactEvidence,
  type RedactedEvidenceFrameV1,
  type TrustedRedactionPolicyV1,
} from "../src/orchestrator/privacy/redaction.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";

function makeTempWorkspace() {
  const baseDir = realpathSync.native(mkdtempSync(join(tmpdir(), "v2-key-custody-")));
  const projectRoot = join(baseDir, "project");
  const v2VaultRoot = join(projectRoot, ".memory-v2");
  const storeRoot = join(v2VaultRoot, "stores", "store-01");
  const v1ArchiveRoot = join(baseDir, "v1-archive");
  const externalSecretsDir = join(baseDir, "external-secrets");
  mkdirSync(storeRoot, { recursive: true });
  mkdirSync(v1ArchiveRoot, { recursive: true });
  mkdirSync(externalSecretsDir, { recursive: true });
  const paths: FreshStartPaths = Object.freeze({
    projectRoot,
    v2VaultRoot,
    v1ArchiveRoot,
  });
  return {
    baseDir,
    projectRoot,
    v2VaultRoot,
    storeRoot,
    v1ArchiveRoot,
    externalSecretsDir,
    paths,
    cleanup() {
      rmSync(baseDir, { recursive: true, force: true });
    },
  };
}

const TEST_PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const TEST_VAULT_ID = "22222222-2222-4222-8222-222222222222";
const TEST_STORE_ID = "33333333-3333-4333-8333-333333333333";
const TEST_SCOPE = Object.freeze({ projectId: TEST_PROJECT_ID, storeId: TEST_STORE_ID });

const TEST_POLICY: TrustedRedactionPolicyV1 = Object.freeze({
  policyId: "operational-custody-policy",
  policyVersion: "1",
  rules: Object.freeze([
    Object.freeze({ kind: "token" as const, ruleId: "synthetic-token", prefix: "fixture_secret_" }),
    Object.freeze({ kind: "literal" as const, ruleId: "literal-secret", value: "TOP_SECRET_LITERAL_VALUE_99" }),
  ]),
});

function createBinding(overrides: Partial<EvidenceItemBindingV1> = {}): EvidenceItemBindingV1 {
  return Object.freeze({
    formatVersion: 1 as const,
    projectId: TEST_PROJECT_ID,
    vaultId: TEST_VAULT_ID,
    storeId: TEST_STORE_ID,
    evidenceId: randomUUID(),
    eventId: randomUUID(),
    targetSessionId: randomUUID(),
    conversationId: randomUUID(),
    frameId: randomUUID(),
    mediaType: "text/plain; charset=utf-8" as const,
    policyId: TEST_POLICY.policyId,
    policyVersion: TEST_POLICY.policyVersion,
    ...overrides,
  });
}

test("OperationalKeyCustodyProvider provisions all 11 capability and 3 evidence key purposes, persists across restarts, and rejects overlapping MEMORY_V2_KEYRING_PATH", async () => {
  const ws = makeTempWorkspace();
  try {
    const externalKeyPath = join(ws.externalSecretsDir, "master.key");
    writeFileSync(externalKeyPath, randomBytes(48));

    const custody1 = new OperationalKeyCustodyProvider({
      storeRoot: ws.storeRoot,
      projectId: TEST_PROJECT_ID,
      storeId: TEST_STORE_ID,
      paths: ws.paths,
      env: { MEMORY_V2_KEYRING_PATH: externalKeyPath },
    });

    assert.equal(ALL_CAPABILITY_KEY_PURPOSES.length, 11);
    assert.equal(ALL_EVIDENCE_KEY_PURPOSES.length, 3);

    const capRefs1 = new Map<string, string>();
    for (const purpose of ALL_CAPABILITY_KEY_PURPOSES) {
      const ref = custody1.capability.currentKey(TEST_SCOPE, purpose);
      assert.equal(custody1.capability.status(TEST_SCOPE, purpose, ref.keyId), "available");
      capRefs1.set(purpose, ref.keyId);

      const payload = Buffer.from(`test-payload-${purpose}`, "utf8");
      const mac = custody1.capability.mac({
        ...TEST_SCOPE,
        purpose,
        keyId: ref.keyId,
        domain: "test-domain-v1",
        bytes: payload,
      });
      assert.equal(
        custody1.capability.verify({
          ...TEST_SCOPE,
          purpose,
          keyId: ref.keyId,
          domain: "test-domain-v1",
          bytes: payload,
          mac,
        }),
        true,
      );
      const sealed = custody1.capability.seal({
        ...TEST_SCOPE,
        purpose,
        keyId: ref.keyId,
        domain: "test-seal-v1",
        bytes: payload,
      });
      const opened = custody1.capability.open({
        ...TEST_SCOPE,
        purpose,
        keyId: ref.keyId,
        domain: "test-seal-v1",
        sealed,
      });
      assert.deepEqual(Buffer.from(opened), payload);
    }

    for (const purpose of ALL_EVIDENCE_KEY_PURPOSES) {
      const ref = custody1.evidence.currentKey(TEST_SCOPE, purpose);
      assert.equal(custody1.evidence.status(TEST_SCOPE, purpose, ref), "available");
    }

    const histKeyId = capRefs1.get("evidence-fingerprint")!;
    assert.equal(await custody1.status(histKeyId), "available");
    const histFp1 = await custody1.fingerprint(histKeyId, Buffer.from("coverage-accumulator-bytes", "utf8"));
    assert.match(histFp1, /^[0-9a-f]{64}$/);

    const receipt = {
      backupId: randomUUID(),
      projectId: TEST_PROJECT_ID,
      storeId: TEST_STORE_ID,
      releaseId: randomUUID(),
      backupPath: join(ws.baseDir, "backups", "b1"),
      terminalEventPosition: "42",
      terminalEventHash: "a".repeat(64),
      manifestSha256: "b".repeat(64),
      createdAt: "2026-10-19T12:00:00.000Z",
    };
    custody1.recordBackupReceipt(receipt);
    assert.deepEqual(custody1.latestBackupReceipt(), receipt);
    custody1.close();

    // Reopen on same storeRoot and verify deterministic keys and persisted state
    const custody2 = new OperationalKeyCustodyProvider({
      storeRoot: ws.storeRoot,
      projectId: TEST_PROJECT_ID,
      storeId: TEST_STORE_ID,
      paths: ws.paths,
      env: { MEMORY_V2_KEYRING_PATH: externalKeyPath },
    });
    try {
      for (const purpose of ALL_CAPABILITY_KEY_PURPOSES) {
        assert.equal(custody2.capability.currentKey(TEST_SCOPE, purpose).keyId, capRefs1.get(purpose));
      }
      assert.equal(
        await custody2.fingerprint(histKeyId, Buffer.from("coverage-accumulator-bytes", "utf8")),
        histFp1,
      );
      assert.deepEqual(custody2.latestBackupReceipt(), receipt);
    } finally {
      custody2.close();
    }

    // Reject overlapping MEMORY_V2_KEYRING_PATH inside projectRoot, v2VaultRoot, v1ArchiveRoot, or storeRoot
    for (const forbiddenDir of [ws.projectRoot, ws.v2VaultRoot, ws.v1ArchiveRoot, ws.storeRoot]) {
      const overlappingKeyPath = join(forbiddenDir, "leaked-keyring.key");
      assert.throws(
        () =>
          new OperationalKeyCustodyProvider({
            storeRoot: ws.storeRoot,
            projectId: TEST_PROJECT_ID,
            storeId: TEST_STORE_ID,
            paths: ws.paths,
            env: { MEMORY_V2_KEYRING_PATH: overlappingKeyPath },
          }),
        (err: unknown) => err instanceof FreshStartError && err.code === "FRESH_START_PATH_OVERLAP",
      );
    }

    // Also reject symlink / junction inside externalSecretsDir pointing into projectRoot
    const targetInProject = join(ws.projectRoot, "secret-target.key");
    writeFileSync(targetInProject, randomBytes(48));
    const symlinkKeyPath = join(ws.externalSecretsDir, "symlink-to-project.key");
    let symlinkCreated = false;
    try {
      symlinkSync(targetInProject, symlinkKeyPath);
      symlinkCreated = true;
    } catch {
      // Windows without developer mode may disallow file symlinks; directory junction test is still covered if skipped
    }
    if (symlinkCreated) {
      assert.throws(
        () =>
          new OperationalKeyCustodyProvider({
            storeRoot: ws.storeRoot,
            projectId: TEST_PROJECT_ID,
            storeId: TEST_STORE_ID,
            paths: ws.paths,
            env: { MEMORY_V2_KEYRING_PATH: symlinkKeyPath },
          }),
        (err: unknown) => err instanceof FreshStartError && err.code === "FRESH_START_PATH_OVERLAP",
      );
    }
  } finally {
    ws.cleanup();
  }
});

test("rotateEvidenceWrapKey rewraps stored data-key envelopes to version 2 and retires version 1 without mutating EncryptedEvidenceItemV1", () => {
  const ws = makeTempWorkspace();
  const seed = randomBytes(32);
  try {
    const custody = new OperationalKeyCustodyProvider({
      storeRoot: ws.storeRoot,
      projectId: TEST_PROJECT_ID,
      storeId: TEST_STORE_ID,
      paths: ws.paths,
      masterSeed: seed,
    });

    const frameId = randomUUID();
    const binding = createBinding({ frameId });
    const redactedFrame: RedactedEvidenceFrameV1 = Object.freeze({
      frameId,
      ordinal: "0",
      role: "user",
      category: "user-message",
      occurredAt: "2026-10-19T12:00:00.000Z",
      mediaType: "text/plain; charset=utf-8",
      content: "Hello with [REDACTED] secret",
      previousFrameId: null,
      toolCorrelationId: null,
      artifactHashes: Object.freeze([]),
      manifest: Object.freeze([{ ruleId: "synthetic-token", startByte: 11, endByte: 21 }]),
    });

    const sealedItem = sealEvidenceItem(binding, redactedFrame, custody.evidence);
    const sealedCanonicalBefore = canonicalJson(sealedItem);
    assert.equal(sealedItem.wrapKeyRef.version, "1");

    const rotated = custody.rotateEvidenceWrapKey("2", "2026-10-19T12:05:00.000Z");
    assert.equal(rotated.rotatedEnvelopes, 1);
    assert.deepEqual(rotated.activeKeyRef, { keyId: "op-ev-data-key-wrap", version: "2" });
    assert.deepEqual(custody.evidence.currentKey(TEST_SCOPE, "data-key-wrap"), {
      keyId: "op-ev-data-key-wrap",
      version: "2",
    });

    // Verify EncryptedEvidenceItemV1 is completely untouched
    assert.equal(canonicalJson(sealedItem), sealedCanonicalBefore);

    // Verify version 1 KEK material was shredded in custody-recovery.sqlite
    const db = new DatabaseSync(join(ws.storeRoot, "custody-recovery.sqlite"));
    try {
      const v1Row = db
        .prepare(
          "SELECT is_current, secret_material_b64, retired_at FROM key_versions WHERE family = 'evidence' AND purpose = 'data-key-wrap' AND version = '1'",
        )
        .get() as { is_current: number | bigint; secret_material_b64: string | null; retired_at: string | null };
      assert.equal(Number(v1Row.is_current), 0);
      assert.equal(v1Row.secret_material_b64, null);
      assert.equal(v1Row.retired_at, "2026-10-19T12:05:00.000Z");
    } finally {
      db.close();
    }

    // Opening the historical item succeeds using the rewrapped version 2 envelope
    const opened = openEvidenceItem(binding, sealedItem, custody.evidence);
    assert.deepEqual(opened, redactedFrame);
    custody.close();

    // Also verify after provider restart
    const custodyReopened = new OperationalKeyCustodyProvider({
      storeRoot: ws.storeRoot,
      projectId: TEST_PROJECT_ID,
      storeId: TEST_STORE_ID,
      paths: ws.paths,
      masterSeed: seed,
    });
    try {
      const openedAfterRestart = openEvidenceItem(binding, sealedItem, custodyReopened.evidence);
      assert.deepEqual(openedAfterRestart, redactedFrame);
    } finally {
      custodyReopened.close();
    }
  } finally {
    ws.cleanup();
  }
});

test("recordErasureFence computes deterministic tombstoneHash, shreds the envelope in custody-recovery.sqlite, and prevents decryption", () => {
  const ws = makeTempWorkspace();
  const seed = randomBytes(32);
  try {
    const custody = new OperationalKeyCustodyProvider({
      storeRoot: ws.storeRoot,
      projectId: TEST_PROJECT_ID,
      storeId: TEST_STORE_ID,
      paths: ws.paths,
      masterSeed: seed,
    });

    const frameId = randomUUID();
    const evidenceId = randomUUID();
    const binding = createBinding({ frameId, evidenceId });
    const redactedFrame: RedactedEvidenceFrameV1 = Object.freeze({
      frameId,
      ordinal: "0",
      role: "user",
      category: "user-message",
      occurredAt: "2026-10-19T12:10:00.000Z",
      mediaType: "text/plain; charset=utf-8",
      content: "Sensitive retained evidence frame to be erased",
      previousFrameId: null,
      toolCorrelationId: null,
      artifactHashes: Object.freeze([]),
      manifest: Object.freeze([]),
    });

    const sealedItem = sealEvidenceItem(binding, redactedFrame, custody.evidence);
    assert.deepEqual(openEvidenceItem(binding, sealedItem, custody.evidence), redactedFrame);
    assert.equal(custody.isEvidenceErased(evidenceId), false);

    const fenceInput = {
      erasureId: randomUUID(),
      projectId: TEST_PROJECT_ID,
      storeId: TEST_STORE_ID,
      evidenceId,
      sourceEventId: binding.eventId,
      erasureEventId: randomUUID(),
      reason: "user-requested-privacy-erasure",
      erasedAt: "2026-10-19T12:15:00.000Z",
    };
    const fence1 = custody.recordErasureFence(fenceInput);
    const fence2 = custody.recordErasureFence(fenceInput);
    assert.match(fence1.tombstoneHash, /^[0-9a-f]{64}$/);
    assert.equal(fence1.tombstoneHash, fence2.tombstoneHash);
    assert.equal(custody.isEvidenceErased(evidenceId), true);
    assert.deepEqual(custody.listErasureFences(), [fence1]);

    // Check custody-recovery.sqlite envelope is shredded
    const db = new DatabaseSync(join(ws.storeRoot, "custody-recovery.sqlite"));
    try {
      const envRow = db
        .prepare("SELECT status, wrapped_data_key_json FROM evidence_key_envelopes WHERE evidence_id = ?")
        .get(evidenceId) as { status: string; wrapped_data_key_json: string | null };
      assert.equal(envRow.status, "erased");
      assert.equal(envRow.wrapped_data_key_json, null);
    } finally {
      db.close();
    }

    const aad = Buffer.from(canonicalJson(binding), "utf8");
    assert.throws(
      () => custody.evidence.unwrap(TEST_SCOPE, sealedItem.wrappedKey, aad),
      (err: unknown) =>
        err instanceof RetainedEvidenceError && err.code === "RETAINED_EVIDENCE_KEY_UNAVAILABLE",
    );
    assert.throws(
      () => openEvidenceItem(binding, sealedItem, custody.evidence),
      (err: unknown) =>
        err instanceof RetainedEvidenceError &&
        (err.code === "INTEGRITY_FAILURE" || err.code === "RETAINED_EVIDENCE_KEY_UNAVAILABLE"),
    );

    custody.close();
  } finally {
    ws.cleanup();
  }
});

test("prepareLargeEvidenceFrames redacts >64 KiB payloads before compression/chunking and reassembleChunkedEvidenceFrames verifies integrity", () => {
  const ws = makeTempWorkspace();
  const seed = randomBytes(32);
  try {
    const custody = new OperationalKeyCustodyProvider({
      storeRoot: ws.storeRoot,
      projectId: TEST_PROJECT_ID,
      storeId: TEST_STORE_ID,
      paths: ws.paths,
      masterSeed: seed,
    });

    // Construct a ~180 KiB payload with secrets placed at the start, across a ~48 KiB boundary, and near the end (~160 KiB)
    const secretToken1 = "fixture_secret_alpha9876543210";
    const secretToken2 = "TOP_SECRET_LITERAL_VALUE_99";
    const secretToken3 = "fixture_secret_omega1122334455";
    const blockA = randomBytes(36_000).toString("base64url"); // ~48,000 chars
    const blockB = randomBytes(84_000).toString("base64url"); // ~112,000 chars
    const blockC = randomBytes(18_000).toString("base64url"); // ~24,000 chars
    const largeContent = [
      `Header token=${secretToken1}`,
      blockA,
      `BoundarySecret:${secretToken2}`,
      blockB,
      `TailSecret=${secretToken3}`,
      blockC,
    ].join("\n");
    assert.ok(Buffer.byteLength(largeContent, "utf8") > 180_000);

    const rootFrameId = randomUUID();
    const priorFrameId = randomUUID();
    const chunks = prepareLargeEvidenceFrames({
      frameId: rootFrameId,
      startOrdinal: 5n,
      previousFrameId: priorFrameId,
      role: "tool",
      category: "tool-output",
      occurredAt: "2026-10-19T12:20:00.000Z",
      mediaType: "text/plain; charset=utf-8",
      content: largeContent,
      toolCorrelationId: randomUUID(),
      artifactHashes: [createHash("sha256").update("artifact-1").digest("hex")],
      policy: TEST_POLICY,
    });

    assert.ok(chunks.length >= 2, `expected multiple chunks, got ${chunks.length}`);
    assert.equal(chunks[0]!.frameId, rootFrameId);
    assert.equal(chunks[0]!.previousFrameId, priorFrameId);
    assert.equal(chunks[0]!.ordinal, "5");

    // Verify all chunks pass decodeRetainEvidenceBatch and contain zero raw secret bytes
    const batchDecoded = decodeRetainEvidenceBatch({
      version: 1,
      commandType: "retain-evidence-batch",
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      targetSessionId: randomUUID(),
      conversationId: randomUUID(),
      frames: chunks,
    });
    const redactedBatch = redactEvidence(batchDecoded, TEST_POLICY);
    batchDecoded.canonicalOriginalBytes.fill(0);

    for (let i = 0; i < chunks.length; i++) {
      const chunkJson = canonicalJson(chunks[i]);
      assert.ok(Buffer.byteLength(chunkJson, "utf8") <= RETAINED_EVIDENCE_LIMITS.frameBytes);
      assert.equal(chunkJson.includes(secretToken1), false);
      assert.equal(chunkJson.includes(secretToken2), false);
      assert.equal(chunkJson.includes(secretToken3), false);
      if (i > 0) {
        assert.equal(chunks[i]!.ordinal, String(5n + BigInt(i)));
        assert.equal(chunks[i]!.previousFrameId, chunks[i - 1]!.frameId);
      }
    }

    // Seal and open each chunk through sealEvidenceItem / openEvidenceItem
    const openedChunks: RedactedEvidenceFrameV1[] = redactedBatch.frames.map((redactedChunk) => {
      const binding = createBinding({
        frameId: redactedChunk.frameId,
        mediaType: redactedChunk.mediaType,
      });
      const sealed = sealEvidenceItem(binding, redactedChunk, custody.evidence);
      return openEvidenceItem(binding, sealed, custody.evidence);
    });

    const reassembled = reassembleChunkedEvidenceFrames(openedChunks);
    assert.equal(reassembled.frameId, rootFrameId);
    assert.equal(reassembled.ordinal, "5");
    assert.equal(reassembled.previousFrameId, priorFrameId);
    assert.equal(reassembled.mediaType, "text/plain; charset=utf-8");
    assert.equal(typeof reassembled.content, "string");
    assert.equal((reassembled.content as string).includes(secretToken1), false);
    assert.equal((reassembled.content as string).includes(secretToken2), false);
    assert.equal((reassembled.content as string).includes(secretToken3), false);
    assert.equal((reassembled.content as string).includes("[REDACTED]"), true);
    assert.equal(reassembled.manifest.length, 3);

    // Reject missing chunk
    assert.throws(
      () => reassembleChunkedEvidenceFrames(openedChunks.slice(0, -1)),
      (err: unknown) => err instanceof RetainedEvidenceError && err.code === "INTEGRITY_FAILURE",
    );

    // Reject reordered chunks
    assert.throws(
      () => reassembleChunkedEvidenceFrames([openedChunks[1]!, openedChunks[0]!, ...openedChunks.slice(2)]),
      (err: unknown) => err instanceof RetainedEvidenceError && err.code === "INTEGRITY_FAILURE",
    );

    // Reject tampered chunk payload
    const tamperedFirst: RedactedEvidenceFrameV1 = Object.freeze({
      ...openedChunks[0]!,
      mediaType: "application/json",
      content: Object.freeze({
        ...(openedChunks[0]!.content as Record<string, unknown>),
        compressedSha256: "f".repeat(64),
      }),
    });
    assert.throws(
      () => reassembleChunkedEvidenceFrames([tamperedFirst, ...openedChunks.slice(1)]),
      (err: unknown) => err instanceof RetainedEvidenceError && err.code === "INTEGRITY_FAILURE",
    );

    // Reject > 1 MiB input
    const oversized = "x".repeat(RETAINED_EVIDENCE_LIMITS.batchBytes + 10);
    assert.throws(
      () =>
        prepareLargeEvidenceFrames({
          frameId: randomUUID(),
          startOrdinal: 0n,
          previousFrameId: null,
          role: "user",
          category: "user-message",
          occurredAt: "2026-10-19T12:25:00.000Z",
          mediaType: "text/plain; charset=utf-8",
          content: oversized,
          toolCorrelationId: null,
          artifactHashes: [],
          policy: TEST_POLICY,
        }),
      (err: unknown) =>
        err instanceof RetainedEvidenceError && err.code === "RETAINED_EVIDENCE_LIMIT_EXCEEDED",
    );

    custody.close();
  } finally {
    ws.cleanup();
  }
});
