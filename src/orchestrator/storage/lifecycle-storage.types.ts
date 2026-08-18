import type {
  ChildSessionState,
  RootSessionState,
  SessionId,
  WorkflowId,
} from "../lifecycle/contracts/identifiers.js";
import type { CheckpointEvidenceCoverageV2 } from "../lifecycle/contracts/checkpoint.js";
import type { Checkpoint } from "../lifecycle/contracts/checkpoint.js";
import type { SessionAggregateState } from "../lifecycle/session-aggregate.js";
import type { TerminalLifecycleEventType } from "../lifecycle/session-aggregate.js";
import type {
  PersistedValidationAttemptPlansWriteV1,
  SessionEndWorkflowClaimInputV1,
  SessionEndWorkflowClaimNextInputV1,
  SessionEndWorkflowClaimV1,
  SessionEndWorkflowEventlessPhaseInputV1,
  SessionEndWorkflowEventfulPhaseInputV1,
  SessionEndWorkflowFinalCheckpointInputV1,
  SessionEndWorkflowAbandonmentInputV1,
  SessionEndWorkflowRecoveryInputV1,
  SessionEndWorkflowRecoveryResultV1,
  SessionEndWorkflowRecordV1,
  SessionEndWorkflowReleaseInputV1,
  SessionEndWorkflowRenewInputV1,
  StoredValidationAttemptPlansV1,
} from "./session-end.repository.js";
import type {
  KeyedFingerprintV1,
  LifecycleOutboxPlannedRevision,
} from "../lifecycle/materialization-queue.port.js";

/**
 * The only session-end workflow capabilities that may cross a transaction
 * boundary.  The implementation is connection-bound, but the connection
 * itself is intentionally absent from this contract.
 */
export interface SessionEndWorkflowOperations {
  read(projectId: string, workflowId: string): SessionEndWorkflowRecordV1 | null;
  claimNext(input: SessionEndWorkflowClaimNextInputV1): SessionEndWorkflowClaimV1 | null;
  claim(input: SessionEndWorkflowClaimInputV1): SessionEndWorkflowClaimV1 | null;
  renew(input: SessionEndWorkflowRenewInputV1): SessionEndWorkflowClaimV1 | null;
  release(input: SessionEndWorkflowReleaseInputV1): boolean;
  advanceEventlessPhase(input: SessionEndWorkflowEventlessPhaseInputV1): boolean;
  readonly advanceEventfulPhase?: (input: SessionEndWorkflowEventfulPhaseInputV1) => boolean;
  readonly recover?: (input: SessionEndWorkflowRecoveryInputV1) => SessionEndWorkflowRecoveryResultV1;
  readonly abandonGeneration?: (input: SessionEndWorkflowAbandonmentInputV1) => void;
  readonly recordFinalCheckpoint?: (input: SessionEndWorkflowFinalCheckpointInputV1) => void;
  readPersistedValidationAttemptPlansV1(
    projectId: string,
    workflowId: string,
  ): StoredValidationAttemptPlansV1 | null;
  writePersistedValidationAttemptPlansV1(input: PersistedValidationAttemptPlansWriteV1): void;
}

/** Read-only validation-plan capability for an active operational transaction. */
export interface LifecycleValidationPlanReadOperations {
  readPersistedValidationAttemptPlansV1(
    projectId: string,
    workflowId: string,
  ): StoredValidationAttemptPlansV1 | null;
  writePersistedValidationAttemptPlansV1(input: PersistedValidationAttemptPlansWriteV1): void;
}

/** Narrow authority reads exposed to operational callbacks; no mutation or transaction control. */
export interface LifecycleSessionAuthorityReadOperations {
  get(projectId: string, sessionId: string): SessionAuthorityRecord | null;
  listNonterminalChildren(
    projectId: string,
    rootSessionId: string,
  ): readonly SessionAuthorityRecord[];
  listChildHistoryBounded(
    projectId: string,
    rootSessionId: string,
    limit: number,
  ): readonly SessionAuthorityRecord[];
  requireFoldMatch(authority: SessionAuthorityRecord): SessionAggregateState;
  latestCheckpoint(authority: SessionAuthorityRecord): Checkpoint | null;
  requireCheckpointAtEventPosition(input: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly checkpointId: string;
    readonly checkpointEventPosition: bigint;
  }): Checkpoint;
}

/** Narrow transfer-ticket reads exposed to operational callbacks. */
export interface LifecycleChildTransferReadOperations {
  get(projectId: string, transferTicketId: string): ChildTransferTicketRecord | null;
  listUnclaimedBySourceRoot(
    projectId: string,
    sourceParentSessionId: string,
    limit: number,
  ): readonly ChildTransferTicketRecord[];
  listBySourceRoot(
    projectId: string,
    sourceParentSessionId: string,
    limit: number,
  ): readonly ChildTransferTicketRecord[];
  listUnclaimedEndingScopeProjectionsBySourceRoot(
    projectId: string,
    sourceParentSessionId: string,
    limit: number,
  ): readonly CarryForwardEndingScopeProjectionRecord[];
}

/** Narrow evidence-coverage reads/assertions exposed to operational callbacks. */
export interface LifecycleEvidenceCoverageReadOperations {
  assertQuickHealthy(sessionIds: readonly SessionId[]): void;
  assertVersion1Eligible(sessionIds: readonly SessionId[]): void;
  snapshotV2(sessionId: SessionId, baseEventPosition: bigint): CheckpointEvidenceCoverageV2;
}

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

export interface CheckpointIndexCompareAndSwap {
  readonly projectId: string;
  readonly sessionId: string;
  readonly expectedLatestCheckpointId: string | null;
  readonly expectedLatestCheckpointEventPosition: bigint | null;
  readonly expectedLatestCheckpointFingerprint: string | null;
  readonly checkpointId: string;
  readonly checkpointEventPosition: bigint;
  readonly checkpointFingerprint: string;
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
  readonly blockers: readonly string[];
  readonly followUps: readonly string[];
  readonly sourceState: LifecycleJsonValue;
  readonly lineage: LifecycleJsonValue;
  readonly createdEventPosition: bigint;
  readonly createdAtMs: bigint;
}

/**
 * The immutable lineage carried by an automatic session-end transfer ticket.
 * Positions are decimal strings at this boundary because the value is also
 * persisted inside canonical JSON and later compared with immutable events.
 */
export interface SessionEndCarryForwardTicketLineageV1 {
  readonly lineageKind: "session-end-carry-forward-v1";
  readonly workflowId: WorkflowId;
  readonly workflowGeneration: number;
  readonly plannedWorkId: string;
  readonly previousParentSessionId: SessionId;
  readonly previousChildSessionId: SessionId;
  readonly correlationId: string;
  readonly suspensionEventPosition: string;
  readonly checkpointEventPosition: string;
  readonly transferEventPosition: string;
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
  readonly blockers: readonly string[];
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

export interface CurrentChildEndingScopeProjectionRecord {
  readonly projectId: string;
  readonly rootSessionId: string;
  readonly childSessionId: string;
  readonly childState: Exclude<ChildSessionState, "completed" | "transferred">;
  readonly lastEventPosition: bigint;
  readonly streamVersion: bigint;
  readonly checkpointId: string | null;
  readonly checkpointEventPosition: bigint | null;
}

export interface CarryForwardEndingScopeProjectionRecord {
  readonly projectId: string;
  readonly rootSessionId: string;
  readonly childSessionId: string;
  readonly childState: "transferred";
  readonly lastEventPosition: bigint;
  readonly streamVersion: bigint;
  readonly checkpointId: string;
  readonly checkpointEventPosition: bigint;
  readonly transferTicketId: string;
  readonly transferTicketEventPosition: bigint;
}

export interface EvidenceCoverageStorageInterval {
  readonly firstOrdinal: bigint;
  readonly lastOrdinal: bigint;
}

export interface EvidenceCoverageAggregateRecord {
  readonly projectId: string;
  readonly sessionId: string;
  readonly adapterSessionId: string;
  readonly captureMode: "coverage-only";
  readonly firstOrdinal: 0n;
  readonly lastOrdinal: bigint;
  /** SQLite stores the public `null` sentinel as `-1`. */
  readonly highestContiguousOrdinal: bigint;
  readonly missingIntervals: readonly EvidenceCoverageStorageInterval[];
  readonly frameFingerprintAlgorithm: "hmac-sha256";
  readonly frameFingerprintSchemaVersion: 1;
  readonly frameFingerprintKeyId: string;
  readonly frameFingerprintDomain: "pm-evidence-frame-v1";
  readonly coverageFingerprintAlgorithm: "hmac-sha256";
  readonly coverageFingerprintSchemaVersion: 1;
  readonly coverageFingerprintKeyId: string;
  readonly coverageFingerprintDomain: "pm-evidence-coverage-v1";
  readonly coverageFingerprint: string;
  readonly latestBatchId: string;
  readonly latestBatchEventPosition: bigint;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EvidenceCoverageTransitionRecord {
  readonly projectId: string;
  readonly sessionId: string;
  readonly adapterSessionId: string;
  readonly batchId: string;
  readonly batchEventPosition: bigint;
  readonly batchFirstOrdinal: bigint;
  readonly batchLastOrdinal: bigint;
  readonly coverageFirstOrdinal: 0n;
  readonly coverageLastOrdinal: bigint;
  readonly highestContiguousOrdinal: bigint;
  readonly missingIntervals: readonly EvidenceCoverageStorageInterval[];
  readonly frameFingerprintAlgorithm: "hmac-sha256";
  readonly frameFingerprintSchemaVersion: 1;
  readonly frameFingerprintKeyId: string;
  readonly frameFingerprintDomain: "pm-evidence-frame-v1";
  readonly previousCoverageFingerprint: string | null;
  readonly coverageFingerprintAlgorithm: "hmac-sha256";
  readonly coverageFingerprintSchemaVersion: 1;
  readonly coverageFingerprintKeyId: string;
  readonly coverageFingerprintDomain: "pm-evidence-coverage-v1";
  readonly coverageFingerprint: string;
  readonly newFrameCount: number;
  readonly captureMode: "coverage-only";
  readonly contentRetained: false;
  readonly createdAt: string;
}

export interface EvidenceFingerprintRecord {
  readonly projectId: string;
  readonly sessionId: string;
  readonly adapterSessionId: string;
  readonly ordinal: bigint;
  readonly frameId: string;
  readonly sourceKind:
    | "model-turn"
    | "tool-request"
    | "tool-result"
    | "adapter-event"
    | "external-observation";
  readonly observedAt: string;
  readonly fingerprintAlgorithm: "hmac-sha256";
  readonly fingerprintSchemaVersion: 1;
  readonly fingerprintKeyId: string;
  readonly fingerprintDomain: "pm-evidence-frame-v1";
  readonly fingerprintValue: string;
  readonly batchId: string;
  readonly recordedEventPosition: bigint;
  readonly createdAt: string;
}

export type LifecycleOutboxStatus = "pending" | "claimed" | "completed" | "failed";

export interface LifecycleOutboxStorageRecord {
  readonly projectId: string;
  readonly targetKey: string;
  readonly eventPosition: bigint;
  readonly kind: "materialize-lifecycle-log";
  readonly payloadJson: string;
  readonly contentHash: string;
  readonly status: LifecycleOutboxStatus;
  readonly attemptCount: bigint;
  readonly claimOwner: string | null;
  readonly claimToken: bigint | null;
  readonly claimExpiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sessionId: string;
  readonly originKind: "workflow" | "terminal-event";
  readonly workflowId: string | null;
  readonly workflowGeneration: bigint | null;
  readonly artifactKind: "compatibility-session-log";
  readonly artifactPath: string;
  readonly materializationRevision: bigint;
  readonly expectedPriorFingerprint: string | null;
  readonly nextFingerprint: string;
  readonly fingerprintAlgorithm: "hmac-sha256";
  readonly fingerprintSchemaVersion: bigint;
  readonly fingerprintKeyId: string;
  readonly fingerprintDomain: "pm-materialization-fingerprint-v1";
  readonly failureClass: "retryable" | "permanent" | null;
  readonly safeErrorCode: string | null;
  readonly nextAttemptAt: string | null;
}

export interface LifecycleOutboxClaimV1 {
  readonly planned: LifecycleOutboxPlannedRevision;
  readonly status: "claimed" | "completed";
  readonly attemptCount: bigint;
  readonly claimOwner: string;
  readonly claimToken: bigint;
  readonly claimExpiresAt: string | null;
}

export interface LifecycleOutboxClaimNextInputV1 {
  readonly projectId: string;
  readonly ownerId: string;
  readonly observedNowMs: bigint;
  readonly leaseDurationMs: bigint;
}

export interface LifecycleOutboxClaimIdentityV1 {
  readonly targetKey: string;
  readonly materializationRevision: bigint;
  readonly ownerId: string;
  readonly claimToken: bigint;
}

export interface LifecycleOutboxExactClaimInputV1 extends LifecycleOutboxClaimIdentityV1 {
  readonly projectId: string;
}

export interface LifecycleOutboxCompletionQueryV1 {
  readonly projectId: string;
  readonly targetKey: string;
  readonly materializationRevision: bigint;
}

export interface LifecycleOutboxRenewInputV1 extends LifecycleOutboxExactClaimInputV1 {
  readonly observedNowMs: bigint;
  readonly leaseDurationMs: bigint;
}

export interface LifecycleOutboxFailureInputV1 extends LifecycleOutboxExactClaimInputV1 {
  readonly observedNowMs: bigint;
  readonly failureClass: "retryable" | "permanent";
  readonly safeErrorCode: string;
  readonly nextAttemptAt: string | null;
  readonly attemptCount?: bigint;
}

export interface LifecycleOutboxAcknowledgementInputV1 {
  readonly projectId: string;
  readonly targetKey: string;
  readonly materializationRevision: bigint;
  readonly ownerId: string;
  readonly claimToken: bigint;
  readonly completedAt: string;
  readonly targetPath: string;
  readonly targetFingerprint: KeyedFingerprintV1;
}

export interface LifecycleOutboxMaterializationResultV1 {
  readonly status: "completed" | "superseded-after-completion";
  readonly claim: LifecycleOutboxClaimV1;
}
