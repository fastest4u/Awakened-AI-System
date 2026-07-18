import type { JsonValue } from "../../contracts/event.js";
import type {
  ProjectContext,
  ProjectId,
  StoreId,
  VaultId,
  WorkspaceId,
} from "../../identity/contracts.js";
import type { TrustedActorRole } from "../../identity/project-binding.request.js";
import {
  LIFECYCLE_IDEMPOTENCY_KEY_MAX_SCALARS,
  LifecycleError,
} from "../errors.js";
import {
  decodeCheckpointDraftV1,
  type CheckpointDraftV1,
  type CheckpointV1,
} from "./checkpoint.js";
import {
  decodeChildDispositionV1,
  decodeChildReportDraftV1,
  type ChildDispositionV1,
  type ChildReportDraftV1,
} from "./child.js";
import {
  exactRecord,
  parseBoolean,
  parseBoundedString,
  parseCanonicalTimestamp,
  parseDecimalString,
  parseEnum,
  parseInteger,
  parseLifecycleId,
  parseNullableBoundedString,
  parseNullableUuid,
  strictArray,
  strictRecord,
  type AdapterSessionId,
  type ApprovalId,
  type CheckpointId,
  type EvidenceBatchId,
  type EvidenceFrameId,
  type ReportId,
  type ResumePolicy,
  type SessionId,
  type TransferTicketId,
  type ValidationResultId,
  type WorkflowId,
} from "./identifiers.js";
import {
  decodeSessionEndAmendmentV1,
  decodeSessionEndRequestV1,
  decodeValidationResultV1,
  type SessionEndAmendmentV1,
  type SessionEndRequestV1,
  type ValidationResultV1,
} from "./session-end.js";

const LOWER_HASH = /^[0-9a-f]{64}$/;
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_32_BYTE_BASE64URL = /^[A-Za-z0-9_-]{43}$/;
const APPROVAL_MAX_LIFETIME_MS = 600_000;
const APPROVAL_REASON_CODES = new Set([
  "explicit-user-approval",
  "credential-loss",
  "suspected-compromise",
  "irrecoverable-session",
]);
const RESUME_POLICIES = ["exact", "latest-safe"] as const;
const EVIDENCE_SOURCE_KINDS = [
  "model-turn",
  "tool-request",
  "tool-result",
  "adapter-event",
  "external-observation",
] as const;
const BASE_KEYS = [
  "commandType",
  "commandId",
  "idempotencyKey",
  "agentId",
  "expectedProjectId",
  "expectedVaultId",
  "expectedWorkspaceId",
  "expectedBranchRef",
] as const;

export interface LifecycleCommandBase {
  commandId: string;
  idempotencyKey: string;
  agentId: string;
  expectedProjectId: ProjectId;
  expectedVaultId: VaultId;
  expectedWorkspaceId: WorkspaceId;
  expectedBranchRef: string | null;
}

export interface LifecycleAudience {
  presentingActorRole: "primary" | "maintenance" | "untrusted";
  presentingClientInstanceId: string;
  targetActorRole: "primary" | "maintenance" | "untrusted";
  targetClientInstanceId: string;
}

export interface CapabilityProofV1 {
  readonly proofVersion: 1;
  readonly target: "semantic-command" | "bounded-operation";
  readonly proofNonce: string;
  readonly proofFingerprint: string;
}

export interface RedactedLifecycleApproval {
  readonly approvalVersion: 1;
  readonly approvalId: ApprovalId;
  readonly action: "recover-root-authority" | "abandon-root";
  readonly reasonCode: string;
  readonly approvalFingerprint: string;
  readonly nonceDigest: string;
  readonly projectId: ProjectId;
  readonly vaultId: VaultId;
  readonly storeId: StoreId;
  readonly workspaceId: WorkspaceId;
  readonly sessionId: SessionId;
  readonly expectedOwnerGeneration: string;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly intentHash: string;
  readonly executorActorRole: "primary" | "maintenance";
  readonly executorClientInstanceId: string;
  readonly targetActorRole: "primary";
  readonly targetClientInstanceId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly redactedApprovalReference: string;
}

export interface RedactedChildBindingGrant {
  readonly grantVersion: 1;
  readonly grantId: string;
  readonly projectId: ProjectId;
  readonly storeId: StoreId;
  readonly parentSessionId: SessionId;
  readonly targetActorRole: "untrusted";
  readonly targetClientInstanceId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly bindingFingerprint: string;
  readonly grantFingerprint: string;
}

/** Transport-private fork authorization. This value must never be persisted. */
export interface ChildBindingGrantV1 {
  readonly grantVersion: 1;
  readonly grantId: string;
  readonly projectId: string;
  readonly storeId: string;
  readonly parentSessionId: string;
  readonly targetActorRole: "untrusted";
  readonly targetClientInstanceId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly bindingFingerprint: string;
  readonly mac: string;
}

export type SemanticCommandAuthorization =
  | {
      kind: "initial-authority";
      authoritySessionId: null;
      targetSessionId: null;
      proof: null;
      approval: null;
      childBindingGrant: null;
    }
  | {
      kind: "protected";
      authoritySessionId: SessionId;
      targetSessionId: SessionId;
      proof: CapabilityProofV1 | null;
      approval: RedactedLifecycleApproval | null;
      childBindingGrant: ChildBindingGrantV1 | null;
    };

export interface BoundedOperationAuthorization {
  readonly kind: "bounded-operation";
  readonly authoritySessionId: SessionId;
  readonly targetSessionId: SessionId;
  readonly proof: CapabilityProofV1;
  readonly audience: LifecycleAudience;
}

export interface PreparedLifecycleWorkerCommand<C extends LifecycleSemanticCommandDraft> {
  command: C;
  candidateIntentHash: string;
  authorization: SemanticCommandAuthorization;
}

export interface RootStartCommandV2 extends LifecycleCommandBase {
  readonly commandType: "root-start";
  readonly continuityKey: string;
  readonly resumePolicy: "new";
}

export interface RootResumeCommandV2 extends LifecycleCommandBase {
  readonly commandType: "root-resume";
  readonly sessionId: SessionId | null;
  readonly continuityKey: string | null;
  readonly resumePolicy: Exclude<ResumePolicy, "new">;
  readonly expectedOwnerGeneration: string;
}

export interface RootRecoveryCommandV2 extends LifecycleCommandBase {
  readonly commandType: "root-recovery";
  readonly sessionId: SessionId;
  readonly expectedOwnerGeneration: string;
  readonly preTransitionCheckpointId: CheckpointId;
  readonly reasonCode: string;
}

export interface RootSuspendCommandV2 extends LifecycleCommandBase {
  readonly commandType: "root-suspend";
  readonly sessionId: SessionId;
  readonly expectedStreamVersion: string;
  readonly checkpoint: CheckpointDraftV1;
}

export interface ChildAssignmentV1 {
  readonly assignmentId: string;
  readonly summary: string;
  readonly scope: string;
}

export interface ForkChildCommandV2 extends LifecycleCommandBase {
  readonly commandType: "fork-child";
  readonly parentSessionId: SessionId;
  readonly expectedStreamVersion: string;
  readonly assignment: ChildAssignmentV1;
  readonly directAccessRequested: boolean;
}

export interface AmendChildAssignmentCommandV2 extends LifecycleCommandBase {
  readonly commandType: "amend-child-assignment";
  readonly parentSessionId: SessionId;
  readonly childSessionId: SessionId;
  readonly expectedStreamVersion: string;
  readonly expectedAssignmentRevision: string;
  readonly assignment: ChildAssignmentV1;
  readonly reasonCode: string;
}

export interface RecordCheckpointCommandV2 extends LifecycleCommandBase {
  readonly commandType: "record-checkpoint";
  readonly sessionId: SessionId;
  readonly expectedStreamVersion: string;
  readonly expectedBaseEventPosition: string | null;
  readonly draft: CheckpointDraftV1;
}

export interface EvidenceCoverageFrameV1 {
  readonly frameId: EvidenceFrameId;
  readonly ordinal: string;
  readonly sourceKind: (typeof EVIDENCE_SOURCE_KINDS)[number];
  readonly observedAt: string;
  readonly contentFingerprint: string;
}

export interface RecordEvidenceBatchCommandV2 extends LifecycleCommandBase {
  readonly commandType: "record-evidence-batch";
  readonly adapterSessionId: AdapterSessionId;
  readonly batchId: EvidenceBatchId;
  readonly sessionId: SessionId;
  readonly firstOrdinal: string;
  readonly lastOrdinal: string;
  readonly fingerprintSchemaVersion: 1;
  readonly fingerprintKeyId: string;
  readonly fingerprintDomain: "pm-evidence-frame-v1";
  readonly redactionStatus: "content-not-retained";
  readonly frames: readonly EvidenceCoverageFrameV1[];
}

export interface RecordChildReportCommandV2 extends LifecycleCommandBase {
  readonly commandType: "record-child-report";
  readonly parentSessionId: SessionId;
  readonly childSessionId: SessionId;
  readonly childAuthorAgentId: string;
  readonly expectedStreamVersion: string;
  readonly report: ChildReportDraftV1;
}

export interface DispositionChildReportCommandV2 extends LifecycleCommandBase {
  readonly commandType: "disposition-child-report";
  readonly parentSessionId: SessionId;
  readonly childSessionId: SessionId;
  readonly expectedStreamVersion: string;
  readonly disposition: ChildDispositionV1;
}

export interface ProposeChildCompletionCommandV2 extends LifecycleCommandBase {
  readonly commandType: "propose-child-completion";
  readonly childSessionId: SessionId;
  readonly expectedStreamVersion: string;
  readonly reportId: ReportId;
}

export interface CompleteChildSessionCommandV2 extends LifecycleCommandBase {
  readonly commandType: "complete-child-session";
  readonly parentSessionId: SessionId;
  readonly childSessionId: SessionId;
  readonly expectedStreamVersion: string;
  readonly reportId: ReportId;
}

export interface SuspendChildSessionCommandV2 extends LifecycleCommandBase {
  readonly commandType: "suspend-child-session";
  readonly parentSessionId: SessionId;
  readonly childSessionId: SessionId;
  readonly expectedStreamVersion: string;
  readonly checkpointId: CheckpointId;
  readonly blockers: readonly string[];
  readonly followUps: readonly string[];
}

export interface CreateChildTransferCommandV2 extends LifecycleCommandBase {
  readonly commandType: "create-child-transfer";
  readonly parentSessionId: SessionId;
  readonly childSessionId: SessionId;
  readonly expectedStreamVersion: string;
  readonly checkpointId: CheckpointId;
}

export interface ClaimChildTransferCommandV2 extends LifecycleCommandBase {
  readonly commandType: "claim-child-transfer";
  readonly rootSessionId: SessionId;
  readonly transferTicketId: TransferTicketId;
  readonly expectedStreamVersion: string;
}

export interface RequestSessionEndCommandV2 extends LifecycleCommandBase {
  readonly commandType: "request-session-end";
  readonly request: SessionEndRequestV1;
}

export interface AmendSessionEndCommandV2 extends LifecycleCommandBase {
  readonly commandType: "amend-session-end";
  readonly sessionId: SessionId;
  readonly workflowId: WorkflowId;
  readonly expectedStreamVersion: string;
  readonly amendment: SessionEndAmendmentV1;
}

export interface CancelSessionEndCommandV2 extends LifecycleCommandBase {
  readonly commandType: "cancel-session-end";
  readonly sessionId: SessionId;
  readonly workflowId: WorkflowId;
  readonly expectedStreamVersion: string;
  readonly preTransitionCheckpointId: CheckpointId;
}

export interface AbandonSessionCommandV2 extends LifecycleCommandBase {
  readonly commandType: "abandon-session";
  readonly sessionId: SessionId;
  readonly expectedStreamVersion: string;
  readonly preTransitionCheckpointId: CheckpointId;
  readonly reasonCode: string;
}

export type LifecycleSemanticCommandDraft =
  | RootStartCommandV2
  | RootResumeCommandV2
  | RootRecoveryCommandV2
  | RootSuspendCommandV2
  | ForkChildCommandV2
  | AmendChildAssignmentCommandV2
  | RecordCheckpointCommandV2
  | RecordEvidenceBatchCommandV2
  | RecordChildReportCommandV2
  | DispositionChildReportCommandV2
  | ProposeChildCompletionCommandV2
  | CompleteChildSessionCommandV2
  | SuspendChildSessionCommandV2
  | CreateChildTransferCommandV2
  | ClaimChildTransferCommandV2
  | RequestSessionEndCommandV2
  | AmendSessionEndCommandV2
  | CancelSessionEndCommandV2
  | AbandonSessionCommandV2;

export interface WorkflowClaimAssertionV1 {
  readonly workflowId: WorkflowId;
  readonly workflowGeneration: number;
  readonly claimOwnerId: string;
  readonly claimToken: string;
  readonly claimExpiresAt: string;
}

export type SemanticSessionEndAction =
  | {
      readonly action: "record-final-checkpoint-and-queue-ending";
      readonly finalCheckpoint: CheckpointV1;
      readonly materializationTarget: string;
    }
  | {
      readonly action: "record-verification-failed";
      readonly validationResultIds: readonly ValidationResultId[];
      readonly safeFailureCode: string;
    }
  | {
      readonly action: "record-verification-passed";
      readonly validationResultIds: readonly ValidationResultId[];
      readonly qualityScore: number;
    }
  | {
      readonly action: "invalidate-verification";
      readonly safeFailureCode: "SESSION_SOURCE_STATE_CONFLICT";
    }
  | {
      readonly action: "append-terminal-completion";
      readonly verificationEventPosition: string;
      readonly materializationTarget: string;
    };

export interface ValidationAttemptPlanIdentityV1 {
  readonly attemptPlanVersion: 1;
  readonly projectId: ProjectId;
  readonly vaultId: VaultId;
  readonly storeId: StoreId;
  readonly workspaceId: WorkspaceId;
  readonly sessionId: SessionId;
  readonly workflowId: WorkflowId;
  readonly workflowGeneration: number;
  readonly plannedWorkId: string;
  readonly finalCheckpointId: CheckpointId;
  readonly finalCheckpointFingerprint: string;
  readonly profileId: string;
  readonly profileVersion: number;
  readonly profileConfigurationHash: string;
  readonly runId: string;
  readonly resultId: ValidationResultId;
  readonly resultCommandId: string;
  readonly resultIdempotencyKey: string;
}

export interface InternalValidationResultCommand extends LifecycleCommandBase {
  readonly commandType: "internal-validation-result";
  readonly workflowId: WorkflowId;
  readonly workflowGeneration: number;
  readonly plannedWorkId: string;
  readonly attemptPlan: ValidationAttemptPlanIdentityV1;
  readonly claim: WorkflowClaimAssertionV1;
  readonly result: ValidationResultV1;
}

export interface InternalWorkflowPhaseCommand extends LifecycleCommandBase {
  readonly commandType: "internal-workflow-phase";
  readonly workflowId: WorkflowId;
  readonly workflowGeneration: number;
  readonly sourcePhase: string;
  readonly plannedWorkId: string;
  readonly claim: WorkflowClaimAssertionV1;
  readonly action: SemanticSessionEndAction;
}

export type InternalWorkflowSemanticCommand =
  | InternalValidationResultCommand
  | InternalWorkflowPhaseCommand;

const VALIDATION_ATTEMPT_PLAN_KEYS = [
  "attemptPlanVersion",
  "projectId",
  "vaultId",
  "storeId",
  "workspaceId",
  "sessionId",
  "workflowId",
  "workflowGeneration",
  "plannedWorkId",
  "finalCheckpointId",
  "finalCheckpointFingerprint",
  "profileId",
  "profileVersion",
  "profileConfigurationHash",
  "runId",
  "resultId",
  "resultCommandId",
  "resultIdempotencyKey",
] as const;

const INTERNAL_VALIDATION_RESULT_COMMAND_KEYS = [
  ...BASE_KEYS,
  "workflowId",
  "workflowGeneration",
  "plannedWorkId",
  "attemptPlan",
  "claim",
  "result",
] as const;

const WORKFLOW_CLAIM_KEYS = [
  "workflowId",
  "workflowGeneration",
  "claimOwnerId",
  "claimToken",
  "claimExpiresAt",
] as const;

function invalidValidationResultBinding(): never {
  throw new LifecycleError("SESSION_VALIDATION_RESULT_INVALID");
}

export function assertInternalValidationResultBinding(
  command: InternalValidationResultCommand,
): void {
  try {
    const commandRecord = exactRecord(
      command,
      INTERNAL_VALIDATION_RESULT_COMMAND_KEYS,
      "internalValidationResultCommand",
      "SESSION_VALIDATION_RESULT_INVALID",
    );
    if (commandRecord.commandType !== "internal-validation-result") {
      invalidValidationResultBinding();
    }
    parseLifecycleId(commandRecord.commandId, "internalValidationResultCommand.commandId");
    parseBoundedString(
      commandRecord.idempotencyKey,
      "internalValidationResultCommand.idempotencyKey",
      LIFECYCLE_IDEMPOTENCY_KEY_MAX_SCALARS,
    );
    parseBoundedString(commandRecord.agentId, "internalValidationResultCommand.agentId", 256);
    parseLifecycleId<ProjectId>(
      commandRecord.expectedProjectId,
      "internalValidationResultCommand.expectedProjectId",
    );
    parseLifecycleId<VaultId>(
      commandRecord.expectedVaultId,
      "internalValidationResultCommand.expectedVaultId",
    );
    if (
      typeof commandRecord.expectedWorkspaceId !== "string"
      || !LOWER_HASH.test(commandRecord.expectedWorkspaceId)
    ) invalidValidationResultBinding();
    parseNullableBoundedString(
      commandRecord.expectedBranchRef,
      "internalValidationResultCommand.expectedBranchRef",
      1_024,
    );
    parseLifecycleId<WorkflowId>(commandRecord.workflowId, "internalValidationResultCommand.workflowId");
    parseInteger(
      commandRecord.workflowGeneration,
      "internalValidationResultCommand.workflowGeneration",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    if (typeof commandRecord.plannedWorkId !== "string" || !LOWER_HASH.test(commandRecord.plannedWorkId)) {
      invalidValidationResultBinding();
    }
    const claimRecord = exactRecord(
      commandRecord.claim,
      WORKFLOW_CLAIM_KEYS,
      "internalValidationResultCommand.claim",
      "SESSION_VALIDATION_RESULT_INVALID",
    );
    parseLifecycleId<WorkflowId>(claimRecord.workflowId, "internalValidationResultCommand.claim.workflowId");
    parseInteger(
      claimRecord.workflowGeneration,
      "internalValidationResultCommand.claim.workflowGeneration",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    parseLifecycleId(claimRecord.claimOwnerId, "internalValidationResultCommand.claim.claimOwnerId");
    parseDecimalString(claimRecord.claimToken, "internalValidationResultCommand.claim.claimToken");
    parseCanonicalTimestamp(
      claimRecord.claimExpiresAt,
      "internalValidationResultCommand.claim.claimExpiresAt",
    );
    const planRecord = exactRecord(
      commandRecord.attemptPlan,
      VALIDATION_ATTEMPT_PLAN_KEYS,
      "validationAttemptPlan",
      "SESSION_VALIDATION_RESULT_INVALID",
    );
    if (planRecord.attemptPlanVersion !== 1) invalidValidationResultBinding();
    parseLifecycleId<ProjectId>(planRecord.projectId, "attemptPlan.projectId");
    parseLifecycleId<VaultId>(planRecord.vaultId, "attemptPlan.vaultId");
    parseLifecycleId<StoreId>(planRecord.storeId, "attemptPlan.storeId");
    if (typeof planRecord.workspaceId !== "string" || !LOWER_HASH.test(planRecord.workspaceId)) {
      invalidValidationResultBinding();
    }
    parseLifecycleId<SessionId>(planRecord.sessionId, "attemptPlan.sessionId");
    parseLifecycleId<WorkflowId>(planRecord.workflowId, "attemptPlan.workflowId");
    parseInteger(
      planRecord.workflowGeneration,
      "attemptPlan.workflowGeneration",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    if (typeof planRecord.plannedWorkId !== "string" || !LOWER_HASH.test(planRecord.plannedWorkId)) {
      invalidValidationResultBinding();
    }
    parseLifecycleId<CheckpointId>(planRecord.finalCheckpointId, "attemptPlan.finalCheckpointId");
    if (
      typeof planRecord.finalCheckpointFingerprint !== "string"
      || !LOWER_HASH.test(planRecord.finalCheckpointFingerprint)
    ) invalidValidationResultBinding();
    parseBoundedString(planRecord.profileId, "attemptPlan.profileId", 256);
    parseInteger(planRecord.profileVersion, "attemptPlan.profileVersion", 1, Number.MAX_SAFE_INTEGER);
    if (
      typeof planRecord.profileConfigurationHash !== "string"
      || !LOWER_HASH.test(planRecord.profileConfigurationHash)
    ) invalidValidationResultBinding();
    parseLifecycleId(planRecord.runId, "attemptPlan.runId");
    parseLifecycleId<ValidationResultId>(planRecord.resultId, "attemptPlan.resultId");
    parseLifecycleId(planRecord.resultCommandId, "attemptPlan.resultCommandId");
    parseBoundedString(
      planRecord.resultIdempotencyKey,
      "attemptPlan.resultIdempotencyKey",
      LIFECYCLE_IDEMPOTENCY_KEY_MAX_SCALARS,
    );
    const result = decodeValidationResultV1(commandRecord.result);

    const plan = commandRecord.attemptPlan as unknown as ValidationAttemptPlanIdentityV1;
    if (
      commandRecord.commandId !== plan.resultCommandId
      || commandRecord.idempotencyKey !== plan.resultIdempotencyKey
      || commandRecord.expectedProjectId !== plan.projectId
      || commandRecord.expectedVaultId !== plan.vaultId
      || commandRecord.expectedWorkspaceId !== plan.workspaceId
      || commandRecord.workflowId !== plan.workflowId
      || commandRecord.workflowGeneration !== plan.workflowGeneration
      || commandRecord.plannedWorkId !== plan.plannedWorkId
      || claimRecord.workflowId !== plan.workflowId
      || claimRecord.workflowGeneration !== plan.workflowGeneration
      || result.resultId !== plan.resultId
      || result.projectId !== plan.projectId
      || result.vaultId !== plan.vaultId
      || result.storeId !== plan.storeId
      || result.workspaceId !== plan.workspaceId
      || result.sourceStateAtStart.workspaceId !== plan.workspaceId
      || result.sourceStateAtCompletion.workspaceId !== plan.workspaceId
      || result.sessionId !== plan.sessionId
      || result.workflowId !== plan.workflowId
      || result.workflowGeneration !== plan.workflowGeneration
      || result.finalCheckpointId !== plan.finalCheckpointId
      || result.finalCheckpointFingerprint !== plan.finalCheckpointFingerprint
      || result.profileId !== plan.profileId
      || result.profileVersion !== plan.profileVersion
      || result.profileConfigurationHash !== plan.profileConfigurationHash
      || result.runId !== plan.runId
    ) invalidValidationResultBinding();
  } catch {
    invalidValidationResultBinding();
  }
}

interface BoundedLifecycleOperationBase {
  readonly context: ProjectContext;
  readonly operationId: string;
  readonly requestId: string;
  readonly authorization: BoundedOperationAuthorization;
}

export type BoundedLifecycleOperation =
  | (BoundedLifecycleOperationBase & {
      readonly operation: "renew-root-lease";
      readonly sessionId: SessionId;
      readonly expectedOwnerGeneration: number;
    })
  | (BoundedLifecycleOperationBase & {
      readonly operation: "read-session-tree" | "read-session-status" | "read-session-association";
      readonly sessionId: SessionId;
    });

interface LifecycleFencedOperationBase {
  readonly context: ProjectContext;
  readonly workId: string;
  readonly ownerId: string;
  readonly fencingToken: string;
}

interface WorkflowFencedIdentity extends LifecycleFencedOperationBase {
  readonly workflowId: WorkflowId;
  readonly workflowGeneration: number;
}

interface OutboxFencedIdentity extends LifecycleFencedOperationBase {
  readonly targetKey: string;
  readonly materializationRevision: string;
}

export type LifecycleFencedOperation =
  | (WorkflowFencedIdentity & { readonly operation: "workflow-claim"; readonly leaseUntil: string })
  | (WorkflowFencedIdentity & { readonly operation: "workflow-renew"; readonly leaseUntil: string })
  | (WorkflowFencedIdentity & { readonly operation: "workflow-release" })
  | (WorkflowFencedIdentity & {
      readonly operation: "workflow-eventless-phase";
      readonly expectedPhase: string;
      readonly nextPhase: string;
    })
  | (LifecycleFencedOperationBase & {
      readonly operation: "workflow-recovery";
      readonly dueBefore: string;
      readonly limit: number;
    })
  | (OutboxFencedIdentity & { readonly operation: "outbox-claim"; readonly leaseUntil: string })
  | (OutboxFencedIdentity & { readonly operation: "outbox-renew"; readonly leaseUntil: string })
  | (OutboxFencedIdentity & {
      readonly operation: "outbox-materialize";
      readonly expectedCurrentFingerprint: string | null;
      readonly nextFingerprint: string;
      readonly materializedBytes: Uint8Array;
      readonly acknowledgement: {
        readonly ownerId: string;
        readonly fencingToken: string;
        readonly materializationRevision: string;
        readonly nextFingerprint: string;
      };
    })
  | (OutboxFencedIdentity & {
      readonly operation: "outbox-failure";
      readonly retryable: boolean;
      readonly safeErrorCode: string;
      readonly attempt: number;
      readonly nextAttemptAt: string | null;
    });

function invalid(field: string): never {
  throw new LifecycleError("LIFECYCLE_INPUT_INVALID", { field });
}

function exactCommand(value: unknown, extraKeys: readonly string[]): Record<string, unknown> {
  return exactRecord(value, [...BASE_KEYS, ...extraKeys], "lifecycleCommand");
}

function base(command: Record<string, unknown>): LifecycleCommandBase {
  const expectedWorkspaceId = command.expectedWorkspaceId;
  if (typeof expectedWorkspaceId !== "string" || !LOWER_HASH.test(expectedWorkspaceId)) {
    invalid("expectedWorkspaceId");
  }
  return {
    commandId: parseLifecycleId(command.commandId, "commandId"),
    idempotencyKey: parseBoundedString(
      command.idempotencyKey,
      "idempotencyKey",
      LIFECYCLE_IDEMPOTENCY_KEY_MAX_SCALARS,
    ),
    agentId: parseBoundedString(command.agentId, "agentId", 256),
    expectedProjectId: parseLifecycleId<ProjectId>(command.expectedProjectId, "expectedProjectId"),
    expectedVaultId: parseLifecycleId<VaultId>(command.expectedVaultId, "expectedVaultId"),
    expectedWorkspaceId: expectedWorkspaceId as WorkspaceId,
    expectedBranchRef: parseNullableBoundedString(command.expectedBranchRef, "expectedBranchRef", 1_024),
  };
}

function assignment(value: unknown): ChildAssignmentV1 {
  const input = exactRecord(value, ["assignmentId", "summary", "scope"], "assignment");
  return Object.freeze({
    assignmentId: parseLifecycleId(input.assignmentId, "assignment.assignmentId"),
    summary: parseBoundedString(input.summary, "assignment.summary", 4_000),
    scope: parseBoundedString(input.scope, "assignment.scope", 4_000),
  });
}

function stringList(value: unknown, field: string, maximum = 100): readonly string[] {
  const source = strictArray(value, field);
  if (source.length > maximum) invalid(field);
  return Object.freeze(source.map((item, index) =>
    parseBoundedString(item, `${field}[${index}]`, 4_000)));
}

function evidenceFrame(value: unknown, field: string): EvidenceCoverageFrameV1 {
  const frame = exactRecord(value, ["frameId", "ordinal", "sourceKind", "observedAt", "contentFingerprint"], field);
  if (typeof frame.contentFingerprint !== "string" || !LOWER_HASH.test(frame.contentFingerprint)) {
    invalid(`${field}.contentFingerprint`);
  }
  return Object.freeze({
    frameId: parseLifecycleId<EvidenceFrameId>(frame.frameId, `${field}.frameId`),
    ordinal: parseDecimalString(frame.ordinal, `${field}.ordinal`),
    sourceKind: parseEnum(frame.sourceKind, EVIDENCE_SOURCE_KINDS, `${field}.sourceKind`),
    observedAt: parseCanonicalTimestamp(frame.observedAt, `${field}.observedAt`),
    contentFingerprint: frame.contentFingerprint,
  });
}

function nullableDecimal(value: unknown, field: string): string | null {
  return value === null ? null : parseDecimalString(value, field);
}

export function decodeLifecycleSemanticCommandDraft(value: unknown): LifecycleSemanticCommandDraft {
  const candidate = strictRecord(value, "lifecycleCommand");
  const commandType = parseBoundedString(candidate.commandType, "commandType", 64);
  switch (commandType) {
    case "root-start": {
      const command = exactCommand(value, ["continuityKey", "resumePolicy"]);
      if (command.resumePolicy !== "new") invalid("resumePolicy");
      return Object.freeze({
        ...base(command),
        commandType,
        continuityKey: parseBoundedString(command.continuityKey, "continuityKey", 1_024),
        resumePolicy: "new",
      });
    }
    case "root-resume": {
      const command = exactCommand(value, ["sessionId", "continuityKey", "resumePolicy", "expectedOwnerGeneration"]);
      const resumePolicy = parseEnum(command.resumePolicy, RESUME_POLICIES, "resumePolicy");
      const sessionId = parseNullableUuid<SessionId>(command.sessionId, "sessionId");
      const continuityKey = parseNullableBoundedString(command.continuityKey, "continuityKey", 1_024);
      if (resumePolicy === "exact" && sessionId === null && continuityKey === null) invalid("sessionId");
      return Object.freeze({
        ...base(command),
        commandType,
        sessionId,
        continuityKey,
        resumePolicy,
        expectedOwnerGeneration: parseDecimalString(command.expectedOwnerGeneration, "expectedOwnerGeneration"),
      });
    }
    case "root-recovery": {
      const command = exactCommand(value, ["sessionId", "expectedOwnerGeneration", "preTransitionCheckpointId", "reasonCode"]);
      return Object.freeze({
        ...base(command),
        commandType,
        sessionId: parseLifecycleId<SessionId>(command.sessionId, "sessionId"),
        expectedOwnerGeneration: parseDecimalString(command.expectedOwnerGeneration, "expectedOwnerGeneration"),
        preTransitionCheckpointId: parseLifecycleId<CheckpointId>(command.preTransitionCheckpointId, "preTransitionCheckpointId"),
        reasonCode: parseBoundedString(command.reasonCode, "reasonCode", 128),
      });
    }
    case "root-suspend": {
      const command = exactCommand(value, ["sessionId", "expectedStreamVersion", "checkpoint"]);
      return Object.freeze({
        ...base(command),
        commandType,
        sessionId: parseLifecycleId<SessionId>(command.sessionId, "sessionId"),
        expectedStreamVersion: parseDecimalString(command.expectedStreamVersion, "expectedStreamVersion"),
        checkpoint: decodeCheckpointDraftV1(command.checkpoint),
      });
    }
    case "fork-child": {
      const command = exactCommand(value, ["parentSessionId", "expectedStreamVersion", "assignment", "directAccessRequested"]);
      return Object.freeze({
        ...base(command),
        commandType,
        parentSessionId: parseLifecycleId<SessionId>(command.parentSessionId, "parentSessionId"),
        expectedStreamVersion: parseDecimalString(command.expectedStreamVersion, "expectedStreamVersion"),
        assignment: assignment(command.assignment),
        directAccessRequested: parseBoolean(command.directAccessRequested, "directAccessRequested"),
      });
    }
    case "amend-child-assignment": {
      const command = exactCommand(value, [
        "parentSessionId",
        "childSessionId",
        "expectedStreamVersion",
        "expectedAssignmentRevision",
        "assignment",
        "reasonCode",
      ]);
      return Object.freeze({
        ...base(command),
        commandType,
        parentSessionId: parseLifecycleId<SessionId>(command.parentSessionId, "parentSessionId"),
        childSessionId: parseLifecycleId<SessionId>(command.childSessionId, "childSessionId"),
        expectedStreamVersion: parseDecimalString(command.expectedStreamVersion, "expectedStreamVersion"),
        expectedAssignmentRevision: parseDecimalString(
          command.expectedAssignmentRevision,
          "expectedAssignmentRevision",
        ),
        assignment: assignment(command.assignment),
        reasonCode: parseBoundedString(command.reasonCode, "reasonCode", 128),
      });
    }
    case "record-checkpoint": {
      const command = exactCommand(value, ["sessionId", "expectedStreamVersion", "expectedBaseEventPosition", "draft"]);
      return Object.freeze({
        ...base(command),
        commandType,
        sessionId: parseLifecycleId<SessionId>(command.sessionId, "sessionId"),
        expectedStreamVersion: parseDecimalString(command.expectedStreamVersion, "expectedStreamVersion"),
        expectedBaseEventPosition: nullableDecimal(command.expectedBaseEventPosition, "expectedBaseEventPosition"),
        draft: decodeCheckpointDraftV1(command.draft),
      });
    }
    case "record-evidence-batch": {
      const command = exactCommand(value, [
        "adapterSessionId",
        "batchId",
        "sessionId",
        "firstOrdinal",
        "lastOrdinal",
        "fingerprintSchemaVersion",
        "fingerprintKeyId",
        "fingerprintDomain",
        "redactionStatus",
        "frames",
      ]);
      if (
        command.fingerprintSchemaVersion !== 1
        || command.fingerprintDomain !== "pm-evidence-frame-v1"
        || command.redactionStatus !== "content-not-retained"
      ) invalid("recordEvidenceBatch");
      const firstOrdinal = parseDecimalString(command.firstOrdinal, "firstOrdinal");
      const lastOrdinal = parseDecimalString(command.lastOrdinal, "lastOrdinal");
      if (BigInt(firstOrdinal) > BigInt(lastOrdinal)) invalid("recordEvidenceBatch.ordinals");
      const source = strictArray(command.frames, "frames");
      if (source.length === 0 || source.length > 2_000) invalid("frames");
      const frames = source.map((item, index) => evidenceFrame(item, `frames[${index}]`));
      if (frames[0]?.ordinal !== firstOrdinal || frames.at(-1)?.ordinal !== lastOrdinal) invalid("frames");
      for (let index = 1; index < frames.length; index += 1) {
        const previous = frames[index - 1];
        const current = frames[index];
        if (previous === undefined || current === undefined || BigInt(current.ordinal) !== BigInt(previous.ordinal) + 1n) {
          invalid("frames");
        }
      }
      if (new Set(frames.map((frame) => frame.frameId)).size !== frames.length) invalid("frames");
      return Object.freeze({
        ...base(command),
        commandType,
        adapterSessionId: parseLifecycleId<AdapterSessionId>(command.adapterSessionId, "adapterSessionId"),
        batchId: parseLifecycleId<EvidenceBatchId>(command.batchId, "batchId"),
        sessionId: parseLifecycleId<SessionId>(command.sessionId, "sessionId"),
        firstOrdinal,
        lastOrdinal,
        fingerprintSchemaVersion: 1,
        fingerprintKeyId: parseBoundedString(command.fingerprintKeyId, "fingerprintKeyId", 128),
        fingerprintDomain: "pm-evidence-frame-v1",
        redactionStatus: "content-not-retained",
        frames: Object.freeze(frames),
      });
    }
    case "record-child-report": {
      const command = exactCommand(value, [
        "parentSessionId",
        "childSessionId",
        "childAuthorAgentId",
        "expectedStreamVersion",
        "report",
      ]);
      const parentSessionId = parseLifecycleId<SessionId>(command.parentSessionId, "parentSessionId");
      const childSessionId = parseLifecycleId<SessionId>(command.childSessionId, "childSessionId");
      if (parentSessionId === childSessionId) invalid("parentSessionId");
      const report = decodeChildReportDraftV1(command.report);
      return Object.freeze({
        ...base(command),
        commandType,
        parentSessionId,
        childSessionId,
        childAuthorAgentId: parseBoundedString(command.childAuthorAgentId, "childAuthorAgentId", 256),
        expectedStreamVersion: parseDecimalString(command.expectedStreamVersion, "expectedStreamVersion"),
        report,
      });
    }
    case "disposition-child-report": {
      const command = exactCommand(value, ["parentSessionId", "childSessionId", "expectedStreamVersion", "disposition"]);
      return Object.freeze({
        ...base(command),
        commandType,
        parentSessionId: parseLifecycleId<SessionId>(command.parentSessionId, "parentSessionId"),
        childSessionId: parseLifecycleId<SessionId>(command.childSessionId, "childSessionId"),
        expectedStreamVersion: parseDecimalString(command.expectedStreamVersion, "expectedStreamVersion"),
        disposition: decodeChildDispositionV1(command.disposition),
      });
    }
    case "propose-child-completion":
    case "complete-child-session": {
      const complete = commandType === "complete-child-session";
      const extraKeys = complete
        ? ["parentSessionId", "childSessionId", "expectedStreamVersion", "reportId"]
        : ["childSessionId", "expectedStreamVersion", "reportId"];
      const command = exactCommand(value, extraKeys);
      const common = {
        ...base(command),
        childSessionId: parseLifecycleId<SessionId>(command.childSessionId, "childSessionId"),
        expectedStreamVersion: parseDecimalString(command.expectedStreamVersion, "expectedStreamVersion"),
        reportId: parseLifecycleId<ReportId>(command.reportId, "reportId"),
      };
      return complete
        ? Object.freeze({
            ...common,
            commandType: "complete-child-session" as const,
            parentSessionId: parseLifecycleId<SessionId>(command.parentSessionId, "parentSessionId"),
          })
        : Object.freeze({ ...common, commandType: "propose-child-completion" as const });
    }
    case "suspend-child-session": {
      const command = exactCommand(value, [
        "parentSessionId",
        "childSessionId",
        "expectedStreamVersion",
        "checkpointId",
        "blockers",
        "followUps",
      ]);
      return Object.freeze({
        ...base(command),
        commandType,
        parentSessionId: parseLifecycleId<SessionId>(command.parentSessionId, "parentSessionId"),
        childSessionId: parseLifecycleId<SessionId>(command.childSessionId, "childSessionId"),
        expectedStreamVersion: parseDecimalString(command.expectedStreamVersion, "expectedStreamVersion"),
        checkpointId: parseLifecycleId<CheckpointId>(command.checkpointId, "checkpointId"),
        blockers: stringList(command.blockers, "blockers"),
        followUps: stringList(command.followUps, "followUps"),
      });
    }
    case "create-child-transfer": {
      const command = exactCommand(value, ["parentSessionId", "childSessionId", "expectedStreamVersion", "checkpointId"]);
      return Object.freeze({
        ...base(command),
        commandType,
        parentSessionId: parseLifecycleId<SessionId>(command.parentSessionId, "parentSessionId"),
        childSessionId: parseLifecycleId<SessionId>(command.childSessionId, "childSessionId"),
        expectedStreamVersion: parseDecimalString(command.expectedStreamVersion, "expectedStreamVersion"),
        checkpointId: parseLifecycleId<CheckpointId>(command.checkpointId, "checkpointId"),
      });
    }
    case "claim-child-transfer": {
      const command = exactCommand(value, ["rootSessionId", "transferTicketId", "expectedStreamVersion"]);
      return Object.freeze({
        ...base(command),
        commandType,
        rootSessionId: parseLifecycleId<SessionId>(command.rootSessionId, "rootSessionId"),
        transferTicketId: parseLifecycleId<TransferTicketId>(command.transferTicketId, "transferTicketId"),
        expectedStreamVersion: parseDecimalString(command.expectedStreamVersion, "expectedStreamVersion"),
      });
    }
    case "request-session-end": {
      const command = exactCommand(value, ["request"]);
      return Object.freeze({ ...base(command), commandType, request: decodeSessionEndRequestV1(command.request) });
    }
    case "amend-session-end": {
      const command = exactCommand(value, ["sessionId", "workflowId", "expectedStreamVersion", "amendment"]);
      return Object.freeze({
        ...base(command),
        commandType,
        sessionId: parseLifecycleId<SessionId>(command.sessionId, "sessionId"),
        workflowId: parseLifecycleId<WorkflowId>(command.workflowId, "workflowId"),
        expectedStreamVersion: parseDecimalString(command.expectedStreamVersion, "expectedStreamVersion"),
        amendment: decodeSessionEndAmendmentV1(command.amendment),
      });
    }
    case "cancel-session-end": {
      const command = exactCommand(value, ["sessionId", "workflowId", "expectedStreamVersion", "preTransitionCheckpointId"]);
      return Object.freeze({
        ...base(command),
        commandType,
        sessionId: parseLifecycleId<SessionId>(command.sessionId, "sessionId"),
        workflowId: parseLifecycleId<WorkflowId>(command.workflowId, "workflowId"),
        expectedStreamVersion: parseDecimalString(command.expectedStreamVersion, "expectedStreamVersion"),
        preTransitionCheckpointId: parseLifecycleId<CheckpointId>(command.preTransitionCheckpointId, "preTransitionCheckpointId"),
      });
    }
    case "abandon-session": {
      const command = exactCommand(value, ["sessionId", "expectedStreamVersion", "preTransitionCheckpointId", "reasonCode"]);
      return Object.freeze({
        ...base(command),
        commandType,
        sessionId: parseLifecycleId<SessionId>(command.sessionId, "sessionId"),
        expectedStreamVersion: parseDecimalString(command.expectedStreamVersion, "expectedStreamVersion"),
        preTransitionCheckpointId: parseLifecycleId<CheckpointId>(command.preTransitionCheckpointId, "preTransitionCheckpointId"),
        reasonCode: parseBoundedString(command.reasonCode, "reasonCode", 128),
      });
    }
    default:
      invalid("commandType");
  }
}

function invalidAuthorization(): never {
  throw new LifecycleError("SESSION_CAPABILITY_INVALID");
}

const AUTHORIZATION_KEYS = [
  "kind",
  "authoritySessionId",
  "targetSessionId",
  "proof",
  "approval",
  "childBindingGrant",
] as const;

function canonicalAuthorizationId(value: unknown): value is string {
  return typeof value === "string" && LOWER_UUID.test(value);
}

function positiveAuthorizationGeneration(value: unknown): value is string {
  try {
    return parseDecimalString(
      value,
      "authorization.approval.expectedOwnerGeneration",
      "SESSION_CAPABILITY_INVALID",
    ) !== "0";
  } catch {
    return false;
  }
}

function canonicalAuthorizationTimestamp(value: unknown, field: string): value is string {
  try {
    parseCanonicalTimestamp(value, field);
    return true;
  } catch {
    return false;
  }
}

function decodeCapabilityProof(value: unknown): CapabilityProofV1 | null {
  if (value === null) return null;
  const proof = exactRecord(
    value,
    ["proofVersion", "target", "proofNonce", "proofFingerprint"],
    "authorization.proof",
    "SESSION_CAPABILITY_INVALID",
  );
  if (
    proof.proofVersion !== 1
    || proof.target !== "semantic-command"
    || !canonicalAuthorizationId(proof.proofNonce)
    || typeof proof.proofFingerprint !== "string"
    || !LOWER_HASH.test(proof.proofFingerprint)
  ) invalidAuthorization();
  return proof as unknown as CapabilityProofV1;
}

function decodeLifecycleApproval(value: unknown): RedactedLifecycleApproval | null {
  if (value === null) return null;
  const approval = exactRecord(
    value,
    [
      "approvalVersion",
      "approvalId",
      "action",
      "reasonCode",
      "approvalFingerprint",
      "nonceDigest",
      "projectId",
      "vaultId",
      "storeId",
      "workspaceId",
      "sessionId",
      "expectedOwnerGeneration",
      "commandId",
      "idempotencyKey",
      "intentHash",
      "executorActorRole",
      "executorClientInstanceId",
      "targetActorRole",
      "targetClientInstanceId",
      "issuedAt",
      "expiresAt",
      "redactedApprovalReference",
    ],
    "authorization.approval",
    "SESSION_CAPABILITY_INVALID",
  );
  if (
    approval.approvalVersion !== 1
    || !canonicalAuthorizationId(approval.approvalId)
    || (approval.action !== "recover-root-authority" && approval.action !== "abandon-root")
    || typeof approval.reasonCode !== "string"
    || !APPROVAL_REASON_CODES.has(approval.reasonCode)
    || typeof approval.approvalFingerprint !== "string"
    || !LOWER_HASH.test(approval.approvalFingerprint)
    || typeof approval.nonceDigest !== "string"
    || !LOWER_HASH.test(approval.nonceDigest)
    || !canonicalAuthorizationId(approval.projectId)
    || !canonicalAuthorizationId(approval.vaultId)
    || !canonicalAuthorizationId(approval.storeId)
    || typeof approval.workspaceId !== "string"
    || !LOWER_HASH.test(approval.workspaceId)
    || !canonicalAuthorizationId(approval.sessionId)
    || !positiveAuthorizationGeneration(approval.expectedOwnerGeneration)
    || !canonicalAuthorizationId(approval.commandId)
    || typeof approval.intentHash !== "string"
    || !LOWER_HASH.test(approval.intentHash)
    || (approval.executorActorRole !== "primary" && approval.executorActorRole !== "maintenance")
    || approval.targetActorRole !== "primary"
    || !canonicalAuthorizationTimestamp(approval.issuedAt, "authorization.approval.issuedAt")
    || !canonicalAuthorizationTimestamp(approval.expiresAt, "authorization.approval.expiresAt")
    || Date.parse(approval.expiresAt as string) - Date.parse(approval.issuedAt as string) <= 0
    || Date.parse(approval.expiresAt as string) - Date.parse(approval.issuedAt as string) > APPROVAL_MAX_LIFETIME_MS
    || (
      approval.action === "abandon-root"
      && (
        approval.executorActorRole !== "primary"
        || approval.executorClientInstanceId !== approval.targetClientInstanceId
      )
    )
  ) invalidAuthorization();
  parseBoundedString(
    approval.idempotencyKey,
    "authorization.approval.idempotencyKey",
    LIFECYCLE_IDEMPOTENCY_KEY_MAX_SCALARS,
    { code: "SESSION_CAPABILITY_INVALID" },
  );
  parseBoundedString(
    approval.executorClientInstanceId,
    "authorization.approval.executorClientInstanceId",
    256,
    { code: "SESSION_CAPABILITY_INVALID" },
  );
  parseBoundedString(
    approval.targetClientInstanceId,
    "authorization.approval.targetClientInstanceId",
    256,
    { code: "SESSION_CAPABILITY_INVALID" },
  );
  parseBoundedString(
    approval.redactedApprovalReference,
    "authorization.approval.redactedApprovalReference",
    512,
    { code: "SESSION_CAPABILITY_INVALID" },
  );
  return approval as unknown as RedactedLifecycleApproval;
}

function decodeChildBindingGrant(value: unknown): ChildBindingGrantV1 | null {
  if (value === null) return null;
  const grant = exactRecord(
    value,
    [
      "grantVersion",
      "grantId",
      "projectId",
      "storeId",
      "parentSessionId",
      "targetActorRole",
      "targetClientInstanceId",
      "issuedAt",
      "expiresAt",
      "bindingFingerprint",
      "mac",
    ],
    "authorization.childBindingGrant",
    "SESSION_CAPABILITY_INVALID",
  );
  if (
    grant.grantVersion !== 1
    || !canonicalAuthorizationId(grant.grantId)
    || !canonicalAuthorizationId(grant.projectId)
    || !canonicalAuthorizationId(grant.storeId)
    || !canonicalAuthorizationId(grant.parentSessionId)
    || grant.targetActorRole !== "untrusted"
    || !canonicalAuthorizationTimestamp(grant.issuedAt, "authorization.childBindingGrant.issuedAt")
    || !canonicalAuthorizationTimestamp(grant.expiresAt, "authorization.childBindingGrant.expiresAt")
    || Date.parse(grant.expiresAt as string) <= Date.parse(grant.issuedAt as string)
    || typeof grant.bindingFingerprint !== "string"
    || !LOWER_HASH.test(grant.bindingFingerprint)
    || typeof grant.mac !== "string"
    || !CANONICAL_32_BYTE_BASE64URL.test(grant.mac)
  ) invalidAuthorization();
  const mac = Buffer.from(grant.mac as string, "base64url");
  try {
    if (mac.length !== 32 || mac.toString("base64url") !== grant.mac) invalidAuthorization();
  } finally {
    mac.fill(0);
  }
  parseBoundedString(
    grant.targetClientInstanceId,
    "authorization.childBindingGrant.targetClientInstanceId",
    256,
    { code: "SESSION_CAPABILITY_INVALID" },
  );
  return grant as unknown as ChildBindingGrantV1;
}

function assertSemanticAuthorizationSessionBinding(
  command: Exclude<LifecycleSemanticCommandDraft, RootStartCommandV2>,
  authoritySessionId: string,
  targetSessionId: string,
): void {
  switch (command.commandType) {
    case "root-resume":
      if (command.sessionId === null) {
        if (authoritySessionId !== targetSessionId) invalidAuthorization();
      } else if (
        authoritySessionId !== command.sessionId
        || targetSessionId !== command.sessionId
      ) invalidAuthorization();
      return;
    case "root-recovery":
    case "root-suspend":
    case "amend-session-end":
    case "cancel-session-end":
    case "abandon-session":
      if (
        authoritySessionId !== command.sessionId
        || targetSessionId !== command.sessionId
      ) invalidAuthorization();
      return;
    case "fork-child":
      if (
        authoritySessionId !== command.parentSessionId
        || targetSessionId !== command.parentSessionId
      ) invalidAuthorization();
      return;
    case "amend-child-assignment":
    case "disposition-child-report":
    case "complete-child-session":
    case "suspend-child-session":
    case "create-child-transfer":
      if (
        authoritySessionId !== command.parentSessionId
        || targetSessionId !== command.childSessionId
      ) invalidAuthorization();
      return;
    case "record-checkpoint":
      if (
        authoritySessionId !== command.sessionId
        || targetSessionId !== command.sessionId
      ) invalidAuthorization();
      return;
    case "record-evidence-batch":
      if (targetSessionId !== command.sessionId) invalidAuthorization();
      return;
    case "record-child-report":
      if (
        targetSessionId !== command.childSessionId
        || (
          authoritySessionId !== command.childSessionId
          && authoritySessionId !== command.parentSessionId
        )
      ) invalidAuthorization();
      return;
    case "propose-child-completion":
      if (
        authoritySessionId !== command.childSessionId
        || targetSessionId !== command.childSessionId
      ) invalidAuthorization();
      return;
    case "claim-child-transfer":
      if (
        authoritySessionId !== command.rootSessionId
        || targetSessionId !== command.rootSessionId
      ) invalidAuthorization();
      return;
    case "request-session-end":
      if (
        authoritySessionId !== command.request.sessionId
        || targetSessionId !== command.request.sessionId
      ) invalidAuthorization();
      return;
  }
}

export function assertSemanticCommandAuthorization(
  command: LifecycleSemanticCommandDraft,
  authorization: SemanticCommandAuthorization,
): void {
  const authorizationRecord = exactRecord(
    authorization,
    AUTHORIZATION_KEYS,
    "authorization",
    "SESSION_CAPABILITY_INVALID",
  );
  if (authorizationRecord.kind === "initial-authority") {
    if (
      command.commandType !== "root-start"
      || authorizationRecord.authoritySessionId !== null
      || authorizationRecord.targetSessionId !== null
      || authorizationRecord.proof !== null
      || authorizationRecord.approval !== null
      || authorizationRecord.childBindingGrant !== null
    ) invalidAuthorization();
    return;
  }

  if (
    authorizationRecord.kind !== "protected"
    || command.commandType === "root-start"
    || !canonicalAuthorizationId(authorizationRecord.authoritySessionId)
    || !canonicalAuthorizationId(authorizationRecord.targetSessionId)
  ) invalidAuthorization();
  const proof = decodeCapabilityProof(authorizationRecord.proof);
  const approval = decodeLifecycleApproval(authorizationRecord.approval);
  const childBindingGrant = decodeChildBindingGrant(authorizationRecord.childBindingGrant);
  assertSemanticAuthorizationSessionBinding(
    command,
    authorizationRecord.authoritySessionId,
    authorizationRecord.targetSessionId,
  );
  if (
    proof === null
    && approval === null
    && childBindingGrant === null
  ) invalidAuthorization();

  if (command.commandType === "root-recovery") {
    if (
      proof !== null
      || approval === null
      || approval.action !== "recover-root-authority"
      || childBindingGrant !== null
    ) {
      invalidAuthorization();
    }
    return;
  }
  if (command.commandType === "abandon-session") {
    if (
      proof === null
      || approval === null
      || approval.action !== "abandon-root"
      || childBindingGrant !== null
    ) {
      invalidAuthorization();
    }
    return;
  }
  if (command.commandType === "fork-child") {
    if (
      proof === null
      || approval !== null
      || (childBindingGrant !== null) !== command.directAccessRequested
    ) invalidAuthorization();
    return;
  }
  if (proof === null || approval !== null || childBindingGrant !== null) {
    invalidAuthorization();
  }
}

export type LifecycleContractContext = {
  readonly context: ProjectContext;
  readonly projectId: ProjectId;
  readonly vaultId: VaultId;
  readonly storeId: StoreId;
  readonly workspaceId: WorkspaceId;
  readonly actorRole: TrustedActorRole;
  readonly metadata: Readonly<Record<string, JsonValue>>;
};
