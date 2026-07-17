import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inspect } from "node:util";
import { describe, it } from "node:test";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { LifecycleError } from "../src/orchestrator/lifecycle/errors.js";
import {
  ABANDONMENT_APPROVAL_DOMAIN,
  MAX_APPROVAL_LIFETIME_MS,
  RECOVERY_APPROVAL_DOMAIN,
  issueAbandonmentApproval,
  issueRecoveryApproval,
  verifyAbandonmentApproval,
  verifyRecoveryApproval,
  type AbandonmentApprovalClaimsV1,
  type ApprovalVerificationExpectationV1,
  type RecoveryApprovalClaimsV1,
} from "../src/orchestrator/lifecycle/authority/approval-codec.js";
import {
  authorityCommitment,
  type CommittedAuthorityV1,
} from "../src/orchestrator/lifecycle/authority/authority-commitment.js";
import { SecretString } from "../src/orchestrator/lifecycle/authority/redacted-secret.js";
import { DeterministicCapabilityKeyProvider } from "./support/lifecycle-authority-reference.js";

const UUID = {
  project: "00000000-0000-4000-8000-000000000001",
  vault: "00000000-0000-4000-8000-000000000002",
  store: "00000000-0000-4000-8000-000000000003",
  session: "00000000-0000-4000-8000-000000000010",
  command: "00000000-0000-4000-8000-000000000020",
  approval: "00000000-0000-4000-8000-000000000030",
} as const;

const WORKSPACE_ID = "1".repeat(64);
const ISSUED_AT = "2026-07-14T00:00:00.000Z";
const EXPIRES_AT = "2026-07-14T00:10:00.000Z";
const ISSUED_AT_MS = BigInt(Date.parse(ISSUED_AT));

function recoveryClaims(
  provider: DeterministicCapabilityKeyProvider,
  overrides: Partial<RecoveryApprovalClaimsV1> = {},
): RecoveryApprovalClaimsV1 {
  const keyId = provider.currentKey(
    { projectId: UUID.project, storeId: UUID.store },
    "recovery-approval",
  ).keyId;
  return {
    approvalVersion: 1,
    approvalId: UUID.approval,
    action: "recover-root-authority",
    projectId: UUID.project,
    vaultId: UUID.vault,
    storeId: UUID.store,
    workspaceId: WORKSPACE_ID,
    sessionId: UUID.session,
    expectedOwnerGeneration: "7",
    commandId: UUID.command,
    idempotencyKey: "recover/root/20",
    intentHash: "a".repeat(64),
    executorActorRole: "maintenance",
    executorClientInstanceId: "maintenance-a",
    targetActorRole: "primary",
    targetClientInstanceId: "primary-a",
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    approvalNonce: "b".repeat(64),
    reasonCode: "explicit-user-approval",
    redactedApprovalReference: "approval/ticket-42",
    ...overrides,
    keyId: overrides.keyId ?? keyId,
  };
}

function abandonmentClaims(
  provider: DeterministicCapabilityKeyProvider,
  overrides: Partial<AbandonmentApprovalClaimsV1> = {},
): AbandonmentApprovalClaimsV1 {
  const keyId = provider.currentKey(
    { projectId: UUID.project, storeId: UUID.store },
    "abandonment-approval",
  ).keyId;
  return {
    ...recoveryClaims(provider),
    action: "abandon-root",
    executorActorRole: "primary",
    executorClientInstanceId: "primary-a",
    targetActorRole: "primary",
    targetClientInstanceId: "primary-a",
    reasonCode: "explicit-user-approval",
    ...overrides,
    keyId: overrides.keyId ?? keyId,
  };
}

function expectation(
  claims: RecoveryApprovalClaimsV1 | AbandonmentApprovalClaimsV1,
  overrides: Partial<ApprovalVerificationExpectationV1> = {},
): ApprovalVerificationExpectationV1 {
  return {
    action: claims.action,
    projectId: claims.projectId,
    vaultId: claims.vaultId,
    storeId: claims.storeId,
    workspaceId: claims.workspaceId,
    sessionId: claims.sessionId,
    expectedOwnerGeneration: claims.expectedOwnerGeneration,
    commandId: claims.commandId,
    idempotencyKey: claims.idempotencyKey,
    intentHash: claims.intentHash,
    executorActorRole: claims.executorActorRole,
    executorClientInstanceId: claims.executorClientInstanceId,
    targetActorRole: claims.targetActorRole,
    targetClientInstanceId: claims.targetClientInstanceId,
    ...overrides,
  };
}

function expectCode(code: string, action: () => unknown): LifecycleError {
  let captured: LifecycleError | undefined;
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof LifecycleError);
    captured = error;
    assert.equal(error.code, code);
    assert.doesNotMatch(String(error), /pmrap1|approvalNonce|approval\/ticket/i);
    return true;
  });
  return captured!;
}

function committedAuthority(): CommittedAuthorityV1 {
  return {
    authorityVersion: 1,
    projectId: UUID.project,
    sessionId: UUID.session,
    sessionKind: "root",
    parentSessionId: null,
    workspaceId: WORKSPACE_ID,
    clientNamespace: "desktop/tests",
    ownerGeneration: "7",
    childCapabilityGeneration: "3",
    directAccessEnabled: true,
    continuityFingerprintAlgorithm: "hmac-sha256",
    continuityFingerprintSchemaVersion: 1,
    continuityFingerprintKeyId: "continuity-key-v1",
    continuityFingerprintDomain: "pm-continuity-v1",
    continuityFingerprint: "1".repeat(64),
    rootHandleCapabilityVersion: 1,
    rootHandleKeyId: "root-key-v1",
    rootHandleIssueNonce: "2".repeat(64),
    rootHandleIssuedAt: ISSUED_AT,
    rootHandlePolicyCode: "root-default-v1",
    rootHandleExpiryKind: "until-revoked",
    rootHandleExpiresAt: null,
    rootHandleActorRole: "primary",
    rootHandleClientInstanceId: "primary-a",
    rootHandleVerifier: "3".repeat(64),
    resumeTokenCapabilityVersion: 1,
    resumeTokenKeyId: "resume-key-v1",
    resumeTokenIssueNonce: "4".repeat(64),
    resumeTokenIssuedAt: ISSUED_AT,
    resumeTokenPolicyCode: "resume-default-v1",
    resumeTokenExpiryKind: "until-revoked",
    resumeTokenExpiresAt: null,
    resumeTokenActorRole: "primary",
    resumeTokenVerifier: "5".repeat(64),
    childHandleCapabilityVersion: 1,
    childHandleKeyId: "child-key-v1",
    childHandleIssueNonce: "6".repeat(64),
    childHandleIssuedAt: ISSUED_AT,
    childHandlePolicyCode: "child-default-v1",
    childHandleExpiryKind: "absolute",
    childHandleExpiresAt: "2026-07-14T01:00:00.000Z",
    childHandleActorRole: "untrusted",
    childHandleClientInstanceId: "child-a",
    childHandleVerifier: "7".repeat(64),
    revocationReasonCode: "compromise-recovery",
    revocationEventPosition: "41",
    revokedAt: "2026-07-14T00:20:00.000Z",
    terminalEventPosition: "42",
    terminalEventType: "SessionAbandoned",
    terminalAt: "2026-07-14T00:21:00.000Z",
  };
}

describe("lifecycle approvals", () => {
  it("pins separate recovery and abandonment domains and the ten-minute maximum", () => {
    assert.equal(RECOVERY_APPROVAL_DOMAIN, "pm-lifecycle-recovery-approval-v1");
    assert.equal(ABANDONMENT_APPROVAL_DOMAIN, "pm-lifecycle-abandonment-approval-v1");
    assert.equal(MAX_APPROVAL_LIFETIME_MS, 600_000n);

    const provider = new DeterministicCapabilityKeyProvider();
    expectCode("LIFECYCLE_APPROVAL_INVALID", () => issueRecoveryApproval(provider, recoveryClaims(provider, {
      expiresAt: "2026-07-14T00:10:00.001Z",
    })));
  });

  it("strictly verifies recovery approval and returns only redacted/digested witnesses", () => {
    const provider = new DeterministicCapabilityKeyProvider();
    const claims = recoveryClaims(provider);
    const approval = issueRecoveryApproval(provider, claims);
    try {
      approval.withValue((value: string) => {
        assert.equal(value.split(".").length, 4);
        assert.equal(value.startsWith("pmrap1."), true);
        assert.equal(value.includes("="), false);
      });
      const verified = verifyRecoveryApproval(
        provider,
        approval,
        expectation(claims),
        ISSUED_AT_MS,
      );
      assert.equal(verified.claims.approvalId, UUID.approval);
      assert.deepEqual(verified.redacted, {
        approvalVersion: 1,
        approvalId: UUID.approval,
        action: "recover-root-authority",
        approvalFingerprint: verified.approvalDigest,
      });
      assert.match(verified.approvalDigest, /^[0-9a-f]{64}$/);
      assert.match(verified.nonceDigest, /^[0-9a-f]{64}$/);
      assert.notEqual(verified.approvalDigest, claims.approvalNonce);
    } finally {
      approval.destroy();
    }
  });

  it("rejects the strict approval wire negative matrix", () => {
    const provider = new DeterministicCapabilityKeyProvider();
    const claims = recoveryClaims(provider);
    const valid = issueRecoveryApproval(provider, claims);
    const invalidApprovals = valid.withValue((value) => {
      const segments = value.split(".");
      const parsed = JSON.parse(
        Buffer.from(segments[2]!, "base64url").toString("utf8"),
      ) as Record<string, unknown>;
      const claimsSegment = (claimsValue: unknown): string => Buffer.from(
        canonicalJson(claimsValue),
        "utf8",
      ).toString("base64url");
      return [
        SecretString.from([segments[0], `${segments[1]}=`, segments[2], segments[3]].join(".")),
        SecretString.from([
          segments[0],
          Buffer.from("different-key-id", "utf8").toString("base64url"),
          segments[2],
          segments[3],
        ].join(".")),
        SecretString.from([
          segments[0],
          segments[1],
          Buffer.from([0xc3, 0x28]).toString("base64url"),
          segments[3],
        ].join(".")),
        SecretString.from([
          segments[0],
          segments[1],
          Buffer.from(JSON.stringify(parsed, null, 2), "utf8").toString("base64url"),
          segments[3],
        ].join(".")),
        SecretString.from([
          segments[0], segments[1], claimsSegment({ ...parsed, unknownClaim: true }), segments[3],
        ].join(".")),
        SecretString.from([
          segments[0], segments[1], claimsSegment({ ...parsed, expectedOwnerGeneration: "01" }), segments[3],
        ].join(".")),
        SecretString.from([
          segments[0], segments[1], claimsSegment({
            ...parsed,
            projectId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
          }), segments[3],
        ].join(".")),
        SecretString.from([
          segments[0], segments[1], claimsSegment({
            ...parsed,
            issuedAt: "2026-07-14T00:00:00Z",
          }), segments[3],
        ].join(".")),
        SecretString.from(`pmrap1.${"A".repeat(50_000)}.A.A`),
      ];
    });
    try {
      for (const approval of invalidApprovals) {
        expectCode("LIFECYCLE_APPROVAL_INVALID", () => verifyRecoveryApproval(
          provider,
          approval,
          expectation(claims),
          ISSUED_AT_MS,
        ));
      }
    } finally {
      valid.destroy();
      for (const approval of invalidApprovals) approval.destroy();
    }
  });

  it("does not interchange recovery and abandonment actions", () => {
    const provider = new DeterministicCapabilityKeyProvider();
    const recovery = recoveryClaims(provider);
    const abandonment = abandonmentClaims(provider);
    const recoveryWire = issueRecoveryApproval(provider, recovery);
    const abandonmentWire = issueAbandonmentApproval(provider, abandonment);
    try {
      expectCode("LIFECYCLE_APPROVAL_INVALID", () => verifyRecoveryApproval(
        provider,
        abandonmentWire,
        expectation(recovery),
        ISSUED_AT_MS,
      ));
      expectCode("LIFECYCLE_APPROVAL_INVALID", () => verifyAbandonmentApproval(
        provider,
        recoveryWire,
        expectation(abandonment),
        ISSUED_AT_MS,
      ));
      assert.equal(
        verifyAbandonmentApproval(
          provider,
          abandonmentWire,
          expectation(abandonment),
          ISSUED_AT_MS,
        ).claims.action,
        "abandon-root",
      );
    } finally {
      recoveryWire.destroy();
      abandonmentWire.destroy();
    }
  });

  it("expires under an injected clock and verifies the MAC before safe semantic mismatch rejection", () => {
    const provider = new DeterministicCapabilityKeyProvider();
    const claims = recoveryClaims(provider);
    const approval = issueRecoveryApproval(provider, claims);
    try {
      expectCode("LIFECYCLE_APPROVAL_INVALID", () => verifyRecoveryApproval(
        provider,
        approval,
        expectation(claims),
        ISSUED_AT_MS - 1n,
      ));
      expectCode("LIFECYCLE_APPROVAL_EXPIRED", () => verifyRecoveryApproval(
        provider,
        approval,
        expectation(claims),
        BigInt(Date.parse(EXPIRES_AT)),
      ));

      const mismatches: readonly Partial<ApprovalVerificationExpectationV1>[] = [
        { executorClientInstanceId: "maintenance-b" },
        { targetClientInstanceId: "primary-b" },
        { intentHash: "c".repeat(64) },
      ];
      for (const mismatch of mismatches) {
        const before = provider.calls.filter((call) => call.operation === "verify").length;
        expectCode("LIFECYCLE_APPROVAL_INVALID", () => verifyRecoveryApproval(
          provider,
          approval,
          expectation(claims, mismatch),
          ISSUED_AT_MS,
        ));
        const after = provider.calls.filter((call) => call.operation === "verify").length;
        assert.equal(after, before + 1, "semantic mismatch still takes the provider verify path");
      }
    } finally {
      approval.destroy();
    }
  });

  it("fails closed when the recorded historical approval key is unavailable or revoked", () => {
    for (const status of ["unavailable", "revoked"] as const) {
      const provider = new DeterministicCapabilityKeyProvider();
      const claims = recoveryClaims(provider);
      const approval = issueRecoveryApproval(provider, claims);
      provider.setStatus("recovery-approval", claims.keyId, status);
      try {
        expectCode("SESSION_CAPABILITY_KEY_UNAVAILABLE", () => verifyRecoveryApproval(
          provider,
          approval,
          expectation(claims),
          ISSUED_AT_MS,
        ));
      } finally {
        approval.destroy();
      }
    }
  });
});

describe("authority commitment", () => {
  it("pins the exact authority commitment prefix and canonical allowlist", () => {
    const authority = committedAuthority();
    assert.equal(
      authorityCommitment(authority),
      createHash("sha256")
        .update(
          `project-memory/authority-commitment/v1\n${canonicalJson(authority)}`,
          "utf8",
        )
        .digest("hex"),
    );
  });

  it("changes for every reconstruction, continuity, audience, revocation, and terminal field", () => {
    const base = committedAuthority();
    const original = authorityCommitment(base);
    const keys = Object.keys(base) as (keyof CommittedAuthorityV1)[];
    for (const key of keys) {
      if (key === "authorityVersion") continue;
      const current = base[key];
      const replacement = typeof current === "boolean"
        ? !current
        : typeof current === "number"
          ? current + 1
          : current === null
            ? "non-null"
            : `${current}-changed`;
      const changed = { ...base, [key]: replacement } as unknown as CommittedAuthorityV1;
      assert.notEqual(authorityCommitment(changed), original, String(key));
    }
  });

  it("excludes audit-only issuance IDs and all non-allowlisted mirrors", () => {
    const base = committedAuthority();
    const withAudit = {
      ...base,
      rootHandleIssuanceId: "00000000-0000-4000-8000-000000000101",
      resumeTokenIssuanceId: "00000000-0000-4000-8000-000000000102",
      childHandleIssuanceId: "00000000-0000-4000-8000-000000000103",
      semanticState: "active",
      authorityCommitment: "f".repeat(64),
      authorityEventPosition: "99",
      latestCheckpointEventPosition: "98",
      createdAt: ISSUED_AT,
      updatedAt: EXPIRES_AT,
    } as CommittedAuthorityV1;
    assert.equal(authorityCommitment(withAudit), authorityCommitment(base));
  });
});

describe("SecretString privacy", () => {
  it("redacts formatting, cloning, spreading, errors, and nonproduction serialization", () => {
    const canary = ["pmcap1", "private", "authority", "canary"].join(".");
    const secret = SecretString.from(canary);
    try {
      assert.equal(String(secret), "[REDACTED]");
      assert.doesNotMatch(inspect(secret), /private|authority|canary/);
      assert.deepEqual({ ...secret }, {});
      assert.deepEqual(structuredClone(secret), {});
      assert.doesNotMatch(inspect({ secret }), /private|authority|canary/);
      assert.doesNotMatch(String(new Error(`failure: ${secret}`)), /private|authority|canary/);
      assert.throws(() => JSON.stringify(secret), /SECRET_SERIALIZATION_BLOCKED/);
      assert.throws(() => JSON.stringify({ secret }), /SECRET_SERIALIZATION_BLOCKED/);
    } finally {
      secret.destroy();
    }
    expectCode("SESSION_CAPABILITY_INVALID", () => secret.withValue(() => undefined));
  });

  it("omits secrets from production JSON without exposing the value", () => {
    const previous = process.env.NODE_ENV;
    const secret = SecretString.from(["pmrap1", "private", "approval"].join("."));
    try {
      process.env.NODE_ENV = "production";
      assert.equal(JSON.stringify({ secret, safe: true }), '{"safe":true}');
    } finally {
      secret.destroy();
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });
});
