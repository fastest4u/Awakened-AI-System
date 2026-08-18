import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ProjectContext, ProjectId } from "../src/orchestrator/identity/contracts.js";
import type { SessionId, WorkflowId } from "../src/orchestrator/lifecycle/contracts/identifiers.js";
import type {
  LifecycleOutboxClaimV1,
  LifecycleOutboxMaterializationResultV1,
} from "../src/orchestrator/storage/lifecycle-storage.types.js";
import type { LifecycleOutboxPlannedRevision, KeyedFingerprintV1 } from "../src/orchestrator/lifecycle/materialization-queue.port.js";
import { LifecycleError } from "../src/orchestrator/lifecycle/errors.js";
import {
  CompatibilityLogMaterializer,
  type LifecycleOutboxMaterializationOperations,
} from "../src/orchestrator/materialization/compatibility-log.materializer.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111" as ProjectId;
const SESSION_ID = "44444444-4444-4444-8444-444444444444" as SessionId;
const WORKFLOW_ID = "55555555-5555-4555-8555-555555555555" as WorkflowId;
const BYTES = Buffer.from("# deterministic\n", "utf8");
const FINGERPRINT_KEY = "materialization-key";
const ARTIFACT_PATH = `05_Agent_Session_Logs/2026-08-09-session-${SESSION_ID}.md`;
const TARGET_KEY = `lifecycle-log/${SESSION_ID}/7`;

function fingerprint(bytes: Uint8Array, keyId = FINGERPRINT_KEY): KeyedFingerprintV1 {
  return Object.freeze({
    algorithm: "hmac-sha256",
    schemaVersion: 1,
    keyId,
    domain: "pm-materialization-fingerprint-v1",
    value: createHmac("sha256", keyId).update(bytes).digest("hex"),
  });
}

function context(vaultRoot: string): ProjectContext {
  return {
    binding: {
      projectId: PROJECT_ID,
      vaultRoot,
      storeId: "33333333-3333-4333-8333-333333333333",
    },
  } as unknown as ProjectContext;
}

function claim(status: "claimed" | "completed", plan: LifecycleOutboxPlannedRevision): LifecycleOutboxClaimV1 {
  return Object.freeze({
    planned: plan,
    status,
    attemptCount: 1n,
    claimOwner: "materializer-a",
    claimToken: 1n,
    claimExpiresAt: status === "claimed" ? "2026-08-09T00:10:30.000Z" : null,
  });
}

function plan(): LifecycleOutboxPlannedRevision {
  return Object.freeze({
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    artifactKind: "compatibility-session-log",
    materializationRevision: 7n,
    triggeringEventPosition: 7n,
    origin: { kind: "workflow", workflowId: WORKFLOW_ID, workflowGeneration: 1 } as const,
    triggeringEventType: "SessionEndVerificationFailed",
    targetKey: TARGET_KEY,
    artifactPath: ARTIFACT_PATH,
    triggeringPayloadHash: "b".repeat(64),
    expectedPriorFingerprint: null,
    nextFingerprint: fingerprint(BYTES),
    createdAt: "2026-08-09T00:10:00.000Z",
  });
}

function operations(initial: LifecycleOutboxClaimV1, latest = true): LifecycleOutboxMaterializationOperations & {
  readonly calls: { acknowledge: number };
  setClaim(next: LifecycleOutboxClaimV1): void;
} {
  let current = initial;
  const calls = { acknowledge: 0 };
  return {
    calls,
    setClaim(next) { current = next; },
    getExactClaim() { return current; },
    isLatestRevision() { return latest; },
    isCurrentWorkflowGeneration() { return true; },
    listCommittedLowerRevisionFingerprints() { return []; },
    acknowledgeAfterReplacement(input): LifecycleOutboxMaterializationResultV1 {
      calls.acknowledge += 1;
      const completed = claim("completed", current.planned);
      current = completed;
      assert.equal(input.targetFingerprint.value, current.planned.nextFingerprint.value);
      return { status: "completed", claim: completed };
    },
  };
}

function materializer(): CompatibilityLogMaterializer {
  return new CompatibilityLogMaterializer({
    keyProvider: {
      status: () => "available",
      fingerprint: ({ keyId, bytes }) => createHmac("sha256", keyId).update(bytes).digest("hex"),
    },
    nowMs: () => BigInt(Date.parse("2026-08-09T00:10:01.000Z")),
    render: () => Buffer.from(BYTES),
    syncDirectory: () => undefined,
  });
}

describe("CompatibilityLogMaterializer", () => {
  it("replaces an absent target and acknowledges the exact planned fingerprint", () => {
    const root = mkdtempSync(join(tmpdir(), "compat-materializer-"));
    try {
      const current = claim("claimed", plan());
      const ops = operations(current);
      const result = materializer().materialize({
        context: context(root),
        projectId: PROJECT_ID,
        targetKey: TARGET_KEY,
        materializationRevision: 7n,
        ownerId: "materializer-a",
        claimToken: 1n,
      }, ops);
      assert.equal(result.status, "completed");
      assert.equal(ops.calls.acknowledge, 1);
      assert.deepEqual(
        readFileSync(join(root, ARTIFACT_PATH)),
        BYTES,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts a completed replay before lease expiry and does not acknowledge twice", () => {
    const root = mkdtempSync(join(tmpdir(), "compat-materializer-"));
    try {
      const target = join(root, ARTIFACT_PATH);
      const ops = operations(claim("completed", plan()));
      mkdirSync(join(root, "05_Agent_Session_Logs"), { recursive: true });
      writeFileSync(target, BYTES);
      const result = materializer().materialize({
        context: context(root),
        projectId: PROJECT_ID,
        targetKey: TARGET_KEY,
        materializationRevision: 7n,
        ownerId: "materializer-a",
        claimToken: 1n,
      }, ops);
      assert.equal(result.status, "completed");
      assert.equal(ops.calls.acknowledge, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns superseded-after-completion without changing bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "compat-materializer-"));
    try {
      const target = join(root, ARTIFACT_PATH);
      const ops = operations(claim("completed", plan()), false);
      mkdirSync(join(root, "05_Agent_Session_Logs"), { recursive: true });
      writeFileSync(target, BYTES);
      const result = materializer().materialize({
        context: context(root),
        projectId: PROJECT_ID,
        targetKey: TARGET_KEY,
        materializationRevision: 7n,
        ownerId: "materializer-a",
        claimToken: 1n,
      }, ops);
      assert.equal(result.status, "superseded-after-completion");
      assert.deepEqual(readFileSync(target), BYTES);
      assert.equal(ops.calls.acknowledge, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an expired unacknowledged claim and an unproven target", () => {
    const root = mkdtempSync(join(tmpdir(), "compat-materializer-"));
    try {
      const expired = Object.freeze({
        ...claim("claimed", plan()),
        claimExpiresAt: "2026-08-09T00:10:00.000Z",
      });
      const expiredOps = operations(expired);
      assert.throws(() => materializer().materialize({
        context: context(root),
        projectId: PROJECT_ID,
        targetKey: TARGET_KEY,
        materializationRevision: 7n,
        ownerId: "materializer-a",
        claimToken: 1n,
      }, expiredOps), (error: unknown) => error instanceof LifecycleError && error.code === "EVENT_CONFLICT");

      const target = join(root, ARTIFACT_PATH);
      mkdirSync(join(root, "05_Agent_Session_Logs"), { recursive: true });
      writeFileSync(target, "untrusted\n");
      const liveOps = operations(claim("claimed", plan()));
      assert.throws(() => materializer().materialize({
        context: context(root),
        projectId: PROJECT_ID,
        targetKey: TARGET_KEY,
        materializationRevision: 7n,
        ownerId: "materializer-a",
        claimToken: 1n,
      }, liveOps), (error: unknown) => error instanceof LifecycleError && error.code === "MATERIALIZATION_CONFLICT");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
