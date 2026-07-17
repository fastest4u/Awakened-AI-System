import { createHash } from "node:crypto";
import { canonicalJson } from "../../serialization/canonical-json.js";

export interface CommittedAuthorityV1 {
  readonly authorityVersion: 1;
  readonly projectId: string;
  readonly sessionId: string;
  readonly sessionKind: "root" | "child";
  readonly parentSessionId: string | null;
  readonly workspaceId: string;
  readonly clientNamespace: string;
  readonly ownerGeneration: string | null;
  readonly childCapabilityGeneration: string | null;
  readonly directAccessEnabled: boolean;
  readonly continuityFingerprintAlgorithm: string | null;
  readonly continuityFingerprintSchemaVersion: number | null;
  readonly continuityFingerprintKeyId: string | null;
  readonly continuityFingerprintDomain: string | null;
  readonly continuityFingerprint: string | null;
  readonly rootHandleCapabilityVersion: number | null;
  readonly rootHandleKeyId: string | null;
  readonly rootHandleIssueNonce: string | null;
  readonly rootHandleIssuedAt: string | null;
  readonly rootHandlePolicyCode: string | null;
  readonly rootHandleExpiryKind: "until-revoked" | "absolute" | null;
  readonly rootHandleExpiresAt: string | null;
  readonly rootHandleActorRole: "primary" | null;
  readonly rootHandleClientInstanceId: string | null;
  readonly rootHandleVerifier: string | null;
  readonly resumeTokenCapabilityVersion: number | null;
  readonly resumeTokenKeyId: string | null;
  readonly resumeTokenIssueNonce: string | null;
  readonly resumeTokenIssuedAt: string | null;
  readonly resumeTokenPolicyCode: string | null;
  readonly resumeTokenExpiryKind: "until-revoked" | "absolute" | null;
  readonly resumeTokenExpiresAt: string | null;
  readonly resumeTokenActorRole: "primary" | null;
  readonly resumeTokenVerifier: string | null;
  readonly childHandleCapabilityVersion: number | null;
  readonly childHandleKeyId: string | null;
  readonly childHandleIssueNonce: string | null;
  readonly childHandleIssuedAt: string | null;
  readonly childHandlePolicyCode: string | null;
  readonly childHandleExpiryKind: "until-revoked" | "absolute" | null;
  readonly childHandleExpiresAt: string | null;
  readonly childHandleActorRole: "untrusted" | null;
  readonly childHandleClientInstanceId: string | null;
  readonly childHandleVerifier: string | null;
  readonly revocationReasonCode: string | null;
  readonly revocationEventPosition: string | null;
  readonly revokedAt: string | null;
  readonly terminalEventPosition: string | null;
  readonly terminalEventType: string | null;
  readonly terminalAt: string | null;
}

function committed(authority: CommittedAuthorityV1): CommittedAuthorityV1 {
  return {
    authorityVersion: authority.authorityVersion,
    projectId: authority.projectId,
    sessionId: authority.sessionId,
    sessionKind: authority.sessionKind,
    parentSessionId: authority.parentSessionId,
    workspaceId: authority.workspaceId,
    clientNamespace: authority.clientNamespace,
    ownerGeneration: authority.ownerGeneration,
    childCapabilityGeneration: authority.childCapabilityGeneration,
    directAccessEnabled: authority.directAccessEnabled,
    continuityFingerprintAlgorithm: authority.continuityFingerprintAlgorithm,
    continuityFingerprintSchemaVersion: authority.continuityFingerprintSchemaVersion,
    continuityFingerprintKeyId: authority.continuityFingerprintKeyId,
    continuityFingerprintDomain: authority.continuityFingerprintDomain,
    continuityFingerprint: authority.continuityFingerprint,
    rootHandleCapabilityVersion: authority.rootHandleCapabilityVersion,
    rootHandleKeyId: authority.rootHandleKeyId,
    rootHandleIssueNonce: authority.rootHandleIssueNonce,
    rootHandleIssuedAt: authority.rootHandleIssuedAt,
    rootHandlePolicyCode: authority.rootHandlePolicyCode,
    rootHandleExpiryKind: authority.rootHandleExpiryKind,
    rootHandleExpiresAt: authority.rootHandleExpiresAt,
    rootHandleActorRole: authority.rootHandleActorRole,
    rootHandleClientInstanceId: authority.rootHandleClientInstanceId,
    rootHandleVerifier: authority.rootHandleVerifier,
    resumeTokenCapabilityVersion: authority.resumeTokenCapabilityVersion,
    resumeTokenKeyId: authority.resumeTokenKeyId,
    resumeTokenIssueNonce: authority.resumeTokenIssueNonce,
    resumeTokenIssuedAt: authority.resumeTokenIssuedAt,
    resumeTokenPolicyCode: authority.resumeTokenPolicyCode,
    resumeTokenExpiryKind: authority.resumeTokenExpiryKind,
    resumeTokenExpiresAt: authority.resumeTokenExpiresAt,
    resumeTokenActorRole: authority.resumeTokenActorRole,
    resumeTokenVerifier: authority.resumeTokenVerifier,
    childHandleCapabilityVersion: authority.childHandleCapabilityVersion,
    childHandleKeyId: authority.childHandleKeyId,
    childHandleIssueNonce: authority.childHandleIssueNonce,
    childHandleIssuedAt: authority.childHandleIssuedAt,
    childHandlePolicyCode: authority.childHandlePolicyCode,
    childHandleExpiryKind: authority.childHandleExpiryKind,
    childHandleExpiresAt: authority.childHandleExpiresAt,
    childHandleActorRole: authority.childHandleActorRole,
    childHandleClientInstanceId: authority.childHandleClientInstanceId,
    childHandleVerifier: authority.childHandleVerifier,
    revocationReasonCode: authority.revocationReasonCode,
    revocationEventPosition: authority.revocationEventPosition,
    revokedAt: authority.revokedAt,
    terminalEventPosition: authority.terminalEventPosition,
    terminalEventType: authority.terminalEventType,
    terminalAt: authority.terminalAt,
  };
}

export function authorityCommitment(authority: CommittedAuthorityV1): string {
  return createHash("sha256")
    .update(`project-memory/authority-commitment/v1\n${canonicalJson(committed(authority))}`, "utf8")
    .digest("hex");
}
