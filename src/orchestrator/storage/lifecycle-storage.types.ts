import type {
  ChildSessionState,
  RootSessionState,
} from "../lifecycle/contracts/identifiers.js";
import type { TerminalLifecycleEventType } from "../lifecycle/session-aggregate.js";

export type LifecycleJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly LifecycleJsonValue[]
  | { readonly [key: string]: LifecycleJsonValue };

export interface SessionAuthorityRecord {
  readonly projectId: string;
  readonly sessionId: string;
  readonly streamId: string;
  readonly sessionKind: "root" | "child";
  readonly parentSessionId: string | null;
  readonly workspaceId: string;
  readonly clientNamespace: string;
  readonly semanticState: RootSessionState | ChildSessionState;
  readonly ownerGeneration: bigint | null;
  readonly childCapabilityGeneration: bigint | null;
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
  readonly rootHandleIssuanceId: string | null;
  readonly resumeTokenCapabilityVersion: number | null;
  readonly resumeTokenKeyId: string | null;
  readonly resumeTokenIssueNonce: string | null;
  readonly resumeTokenIssuedAt: string | null;
  readonly resumeTokenPolicyCode: string | null;
  readonly resumeTokenExpiryKind: "until-revoked" | "absolute" | null;
  readonly resumeTokenExpiresAt: string | null;
  readonly resumeTokenActorRole: "primary" | null;
  readonly resumeTokenVerifier: string | null;
  readonly resumeTokenIssuanceId: string | null;
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
  readonly childHandleIssuanceId: string | null;
  readonly authorityCommitment: string;
  readonly authorityEventPosition: bigint;
  readonly latestCheckpointId: string | null;
  readonly latestCheckpointEventPosition: bigint | null;
  readonly latestCheckpointFingerprint: string | null;
  readonly checkpointRequiredReason: string | null;
  readonly checkpointRequiredEventPosition: bigint | null;
  readonly revocationReasonCode: string | null;
  readonly revocationEventPosition: bigint | null;
  readonly revokedAt: string | null;
  readonly terminalEventPosition: bigint | null;
  readonly terminalEventType: TerminalLifecycleEventType | null;
  readonly terminalAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type RootAuthorityInsert = SessionAuthorityRecord & {
  readonly sessionKind: "root";
  readonly parentSessionId: null;
  readonly semanticState: RootSessionState;
  readonly ownerGeneration: bigint;
  readonly childCapabilityGeneration: null;
};

export type ChildAuthorityInsert = SessionAuthorityRecord & {
  readonly sessionKind: "child";
  readonly parentSessionId: string;
  readonly semanticState: ChildSessionState;
  readonly ownerGeneration: null;
};

export type SessionAuthorityMutation = Omit<
  SessionAuthorityRecord,
  | "projectId"
  | "sessionId"
  | "streamId"
  | "sessionKind"
  | "parentSessionId"
  | "workspaceId"
  | "clientNamespace"
  | "createdAt"
>;

export interface AuthorityCompareAndSwap {
  readonly projectId: string;
  readonly sessionId: string;
  readonly expectedState: RootSessionState | ChildSessionState;
  readonly expectedOwnerGeneration: bigint | null;
  readonly expectedChildCapabilityGeneration: bigint | null;
  readonly expectedAuthorityCommitment: string;
  readonly next: SessionAuthorityMutation;
}

export interface SafeResumeCandidateQuery {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly clientNamespace: string;
  readonly sessionId?: string | null;
  readonly continuityFingerprint?: string | null;
  /** Exclusive deterministic keyset cursor. */
  readonly afterSessionId?: string | null;
  readonly semanticStates: readonly ("active" | "suspended")[];
}

export interface CheckpointRequirement {
  readonly projectId: string;
  readonly sessionId: string;
  readonly reason: string;
  readonly eventPosition: bigint;
  readonly updatedAt: string;
}

export interface CheckpointClear {
  readonly projectId: string;
  readonly sessionId: string;
  readonly checkpointBaseEventPosition: bigint;
  readonly updatedAt: string;
}

export interface RootLeaseRecord {
  readonly projectId: string;
  readonly sessionId: string;
  readonly ownerGeneration: bigint;
  readonly ownerClientInstanceId: string;
  readonly acquiredAtMs: bigint;
  readonly renewedAtMs: bigint;
  readonly lastObservedAtMs: bigint;
  readonly expiresAtMs: bigint;
  readonly releasedAtMs: bigint | null;
}

export interface RootLeaseInsert {
  readonly projectId: string;
  readonly sessionId: string;
  readonly ownerGeneration: bigint;
  readonly ownerClientInstanceId: string;
  readonly observedNowMs: bigint;
  readonly leaseDurationMs: bigint;
}

export interface RootLeaseRenewal extends RootLeaseInsert {}

export interface RootLeaseRelease {
  readonly projectId: string;
  readonly sessionId: string;
  readonly ownerGeneration: bigint;
  readonly ownerClientInstanceId: string;
  readonly expectedLastObservedAtMs: bigint;
  readonly expectedExpiresAtMs: bigint;
  readonly observedNowMs: bigint;
}

export interface ApprovalConsumptionInput {
  readonly approvalId: string;
  readonly nonceDigest: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly action: "recover-root-authority" | "abandon-root";
  readonly commandId: string;
  readonly targetActorRole: "primary";
  readonly targetClientInstanceId: string;
  readonly redactedApprovalReference: string;
  readonly consumedEventPosition: bigint;
  readonly consumedAtMs: bigint;
}

export interface ChildTransferTicketInsert {
  readonly projectId: string;
  readonly transferTicketId: string;
  readonly sourceParentSessionId: string;
  readonly sourceChildSessionId: string;
  readonly sourceAssignment: LifecycleJsonValue;
  readonly sourceScope: LifecycleJsonValue;
  readonly checkpointId: string;
  readonly followUps: readonly string[];
  readonly sourceState: LifecycleJsonValue;
  readonly lineage: LifecycleJsonValue;
  readonly createdEventPosition: bigint;
  readonly createdAtMs: bigint;
}

export interface ChildTransferClaim {
  readonly projectId: string;
  readonly transferTicketId: string;
  readonly expectedCreatedEventPosition: bigint;
  readonly claimedByRootSessionId: string;
  readonly claimedChildSessionId: string;
  readonly claimedEventPosition: bigint;
  readonly claimedAtMs: bigint;
}

export interface ChildTransferTicketRecord {
  readonly projectId: string;
  readonly transferTicketId: string;
  readonly sourceParentSessionId: string;
  readonly sourceChildSessionId: string;
  readonly sourceAssignment: LifecycleJsonValue;
  readonly sourceScope: LifecycleJsonValue;
  readonly checkpointId: string;
  readonly followUps: readonly string[];
  readonly sourceState: LifecycleJsonValue;
  readonly lineage: LifecycleJsonValue;
  readonly createdEventPosition: bigint;
  readonly createdAtMs: bigint;
  readonly claimedByRootSessionId: string | null;
  readonly claimedChildSessionId: string | null;
  readonly claimedEventPosition: bigint | null;
  readonly claimedAtMs: bigint | null;
}
