import type { EvidenceKeyProvider, EvidenceKeyRefV1 } from "./evidence-key-provider.js";
import type { EvidenceFrameMetadataV1 } from "./evidence-envelope.js";
import type { TrustedRedactionPolicyV1 } from "./redaction.js";
import { boundedRetainedJson, retainedExactRecord, RETAINED_EVIDENCE_LIMITS, RetainedEvidenceError, type BoundedEvidenceInputV1 } from "./evidence-contracts.js";
import { decodeRetainedEvidenceAuthority, decodeRetainedEvidenceIntentWitness, retainedIdentifier } from "./retained-evidence-codec.js";
import { evidenceMac, evidenceMacInput, requireEvidenceKey } from "./evidence-key-provider.js";
import { createHash } from "node:crypto";
export const RETAINED_EVIDENCE_COMMAND_DOMAIN = "project-memory/retained-evidence-command/v1";
export const RETAINED_EVIDENCE_ORIGINAL_DOMAIN = "retained-evidence-original-input/v1";
export const RETAINED_EVIDENCE_REDACTED_DOMAIN = "retained-evidence-redacted-content/v1";
/** Nonsecret snapshot only; not an authorization handle. */
export type RetainedEvidenceAuthoritySnapshotV1 = {
  readonly projectId: string; readonly vaultId: string; readonly storeId: string; readonly workspaceId: string; readonly clientNamespace: string;
  readonly presentingActorRole: "primary" | "maintenance" | "untrusted"; readonly presentingClientInstanceId: string;
  readonly targetActorRole: "primary" | "maintenance" | "untrusted"; readonly targetClientInstanceId: string;
  readonly authorizationSessionId: string; readonly targetSessionId: string; readonly parentSessionId: string | null;
  readonly rootSessionId: string; readonly rootOwnerGeneration: string;
  readonly authorizingOwnerGeneration: string | null; readonly authorizingCapabilityGeneration: string | null;
  readonly targetOwnerGeneration: string | null; readonly targetCapabilityGeneration: string | null;
  readonly capabilityKind: "root-session-handle" | "root-resume-token" | "child-session-handle";
};
export type RetainedEvidenceIntentKeysV1 = { readonly originalCommitmentKeyRef: EvidenceKeyRefV1; readonly fingerprintKeyRef: EvidenceKeyRefV1 };
export type RetainedEvidenceIntentWitnessV1 = {
  readonly witnessVersion: 1; readonly commandType: "retain-evidence-batch"; readonly authority: RetainedEvidenceAuthoritySnapshotV1;
  readonly commandId: string; readonly idempotencyKey: string; readonly targetSessionId: string; readonly conversationId: string;
  readonly frames: EvidenceFrameMetadataV1[]; readonly policyId: string; readonly policyVersion: string;
  readonly originalCommitmentKeyRef: EvidenceKeyRefV1; readonly fingerprintKeyRef: EvidenceKeyRefV1; readonly originalInputCommitment: string;
};
export function buildRetainedEvidenceIntent(input: BoundedEvidenceInputV1, admitted: RetainedEvidenceAuthoritySnapshotV1, policy: TrustedRedactionPolicyV1, keys: RetainedEvidenceIntentKeysV1, provider: EvidenceKeyProvider): RetainedEvidenceIntentWitnessV1 {
  const authority = decodeRetainedEvidenceAuthority(admitted); const scope = Object.freeze({ projectId: authority.projectId, storeId: authority.storeId });
  const refs = retainedExactRecord(keys, ["originalCommitmentKeyRef", "fingerprintKeyRef"]);
  const originalCommitmentKeyRef = requireEvidenceKey(provider, scope, "original-input-commitment", refs.originalCommitmentKeyRef as EvidenceKeyRefV1);
  const fingerprintKeyRef = requireEvidenceKey(provider, scope, "redacted-content-fingerprint", refs.fingerprintKeyRef as EvidenceKeyRefV1);
  const config = retainedExactRecord(policy, ["policyId", "policyVersion", "rules"], "RETAINED_EVIDENCE_POLICY_UNAVAILABLE");
  if (!Object.isFrozen(policy) || !Object.isFrozen(config.rules)) throw new RetainedEvidenceError("RETAINED_EVIDENCE_POLICY_UNAVAILABLE");
  const policyId = retainedIdentifier(config.policyId); const policyVersion = retainedIdentifier(config.policyVersion);
  if (authority.targetSessionId !== input.command.targetSessionId) throw new RetainedEvidenceError("RETAINED_EVIDENCE_INPUT_INVALID");
  let canonical: Buffer | undefined; let macInput: Buffer | undefined;
  try {
    canonical = Buffer.from(boundedRetainedJson(input.command, RETAINED_EVIDENCE_LIMITS.batchBytes).canonical);
    if (!canonical.equals(input.canonicalOriginalBytes)) throw new RetainedEvidenceError("RETAINED_EVIDENCE_INPUT_INVALID");
    macInput = evidenceMacInput(scope, originalCommitmentKeyRef, canonical.toString("utf8"));
    const originalInputCommitment = evidenceMac(provider, scope, "original-input-commitment", originalCommitmentKeyRef, RETAINED_EVIDENCE_ORIGINAL_DOMAIN, macInput);
    const frames = input.command.frames.map(({ content: _content, ...frame }) => ({ ...frame, artifactHashes: [...frame.artifactHashes] }));
    return decodeRetainedEvidenceIntentWitness({ witnessVersion: 1, commandType: "retain-evidence-batch", authority, commandId: input.command.commandId, idempotencyKey: input.command.idempotencyKey, targetSessionId: input.command.targetSessionId, conversationId: input.command.conversationId, frames, policyId, policyVersion, originalCommitmentKeyRef, fingerprintKeyRef, originalInputCommitment });
  } finally { canonical?.fill(0); macInput?.fill(0); }
}
export function retainedEvidenceIntentHash(witness: RetainedEvidenceIntentWitnessV1): string {
  const decoded = decodeRetainedEvidenceIntentWitness(witness);
  return createHash("sha256").update(RETAINED_EVIDENCE_COMMAND_DOMAIN).update("\n").update(boundedRetainedJson(decoded, RETAINED_EVIDENCE_LIMITS.batchBytes).canonical).digest("hex");
}
