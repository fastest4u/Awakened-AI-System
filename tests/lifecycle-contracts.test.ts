import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProjectId, VaultId, WorkspaceId } from "../src/orchestrator/identity/contracts.js";
import {
  parseCanonicalTimestamp,
  parseCanonicalUuid,
  parseUnsignedDecimal,
  type AdapterSessionId,
  type ApprovalId,
  type CheckpointId,
  type ChildEndPolicy,
  type ChildSessionState,
  type EvidenceBatchId,
  type EvidenceFrameId,
  type ReportId,
  type ReportItemId,
  type ResumePolicy,
  type RootSessionState,
  type SessionId,
  type TransferTicketId,
  type ValidationResultId,
  type WorkflowId,
} from "../src/orchestrator/lifecycle/contracts/identifiers.js";
import {
  CHECKPOINT_MAX_CANONICAL_BYTES,
  decodeCheckpointDraftV1,
  decodeCheckpointV1,
  type CheckpointDraftV1,
} from "../src/orchestrator/lifecycle/contracts/checkpoint.js";
import {
  decodeChildDispositionV1,
  decodeChildReportDraftV1,
  decodeChildReportV1,
  type ChildReportDraftV1,
} from "../src/orchestrator/lifecycle/contracts/child.js";
import {
  assertInternalValidationResultBinding,
  assertSemanticCommandAuthorization,
  decodeLifecycleSemanticCommandDraft,
  type CapabilityProofV1,
  type BoundedLifecycleOperation,
  type BoundedOperationAuthorization,
  type InternalValidationResultCommand,
  type InternalWorkflowPhaseCommand,
  type InternalWorkflowSemanticCommand,
  type LifecycleAudience,
  type LifecycleFencedOperation,
  type LifecycleSemanticCommandDraft,
  type PreparedLifecycleWorkerCommand,
  type RedactedChildBindingGrant,
  type RedactedLifecycleApproval,
  type SemanticCommandAuthorization,
  type SemanticSessionEndAction,
  type ValidationAttemptPlanIdentityV1,
} from "../src/orchestrator/lifecycle/contracts/commands.js";
import {
  decodeLifecycleEventV1,
  LIFECYCLE_EVENT_TYPES,
  type LifecycleEventV1,
} from "../src/orchestrator/lifecycle/contracts/events.js";
import {
  decodeQualityPolicyV1,
  decodeSessionEndRequestV1,
  decodeValidationResultV1,
  type QualityPolicyV1,
  type SessionEndRequestV1,
  type ValidationResultV1,
} from "../src/orchestrator/lifecycle/contracts/session-end.js";
import {
  LIFECYCLE_ERROR_CODES,
  LifecycleError,
  type LifecycleErrorCode,
} from "../src/orchestrator/lifecycle/errors.js";

type RequiredContractSurface = readonly [
  SessionId,
  CheckpointId,
  ReportId,
  ReportItemId,
  WorkflowId,
  ApprovalId,
  AdapterSessionId,
  EvidenceBatchId,
  EvidenceFrameId,
  TransferTicketId,
  ValidationResultId,
  RootSessionState,
  ChildSessionState,
  ResumePolicy,
  ChildEndPolicy,
  LifecycleAudience,
  SemanticCommandAuthorization,
  BoundedOperationAuthorization,
  LifecycleSemanticCommandDraft,
  InternalWorkflowSemanticCommand,
  InternalValidationResultCommand,
  InternalWorkflowPhaseCommand,
  ValidationAttemptPlanIdentityV1,
  SemanticSessionEndAction,
  PreparedLifecycleWorkerCommand<LifecycleSemanticCommandDraft>,
  BoundedLifecycleOperation,
  LifecycleFencedOperation,
  LifecycleEventV1,
  SessionEndRequestV1,
  QualityPolicyV1,
  CheckpointDraftV1,
  ChildReportDraftV1,
  LifecycleErrorCode,
];

const UUIDS = {
  session: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  parent: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  checkpoint: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  report: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  item1: "11111111-1111-4111-8111-111111111111",
  item2: "22222222-2222-4222-8222-222222222222",
  item3: "33333333-3333-4333-8333-333333333333",
  command: "44444444-4444-4444-8444-444444444444",
  idempotency: "55555555-5555-4555-8555-555555555555",
  client: "66666666-6666-4666-8666-666666666666",
  workflow: "77777777-7777-4777-8777-777777777777",
} as const;

const DETERMINISTIC_IDEMPOTENCY_KEY = `lifecycle-phase-v1/${"5".repeat(64)}`;
const OPAQUE_CLIENT_INSTANCE_ID = "codex-desktop/client-primary";
const CANONICAL_CLAIM_TOKEN = "42";

function indexedUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function expectCode(code: string, action: () => unknown): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof LifecycleError);
    assert.equal(error.code, code);
    assert.match(error.message, new RegExp(code));
    return true;
  });
}

function textItem(summary = "done") {
  return { summary, confidence: "high" };
}

function validCheckpoint(): Record<string, unknown> {
  return {
    checkpointVersion: 1,
    checkpointId: UUIDS.checkpoint,
    sessionId: UUIDS.session,
    parentSessionId: null,
    baseEventPosition: "12",
    checkpointEventPosition: "13",
    createdAt: "2026-07-14T10:11:12.123Z",
    creatorAgentId: "agent-primary",
    creatorClientInstanceId: OPAQUE_CLIENT_INSTANCE_ID,
    taskSummary: "Bounded checkpoint",
    completedItems: [textItem()],
    inProgressItems: [],
    blockers: [],
    nextActions: [],
    decisions: [],
    assumptions: [],
    unresolvedConflicts: [],
    filesTouched: [{
      path: "src/example.ts",
      action: "modified",
      contentHash: null,
      branchRef: "refs/heads/main",
      confidence: "high",
    }],
    artifactReferences: [],
    sourceReferences: [],
    commandResults: [],
    testResults: [],
    materialClaims: [],
    sourceState: {
      sourceStateScopeVersion: 1,
      workspaceId: "a".repeat(64),
      branchRef: "refs/heads/main",
      headCommit: "a".repeat(40),
      dirtyWorktreeFingerprint: "b".repeat(64),
    },
    childSummaries: [],
    evidenceCoverage: {
      captureMode: "coverage-only",
      highestContiguousOrdinal: "3",
      missingIntervals: [{ firstOrdinal: "4", lastOrdinal: "5" }],
    },
  };
}

function validCheckpointDraft(): Record<string, unknown> {
  const draft = validCheckpoint();
  for (const serverField of [
    "checkpointId",
    "sessionId",
    "parentSessionId",
    "baseEventPosition",
    "checkpointEventPosition",
    "createdAt",
    "creatorAgentId",
    "creatorClientInstanceId",
    "sourceState",
    "childSummaries",
    "evidenceCoverage",
  ]) delete draft[serverField];
  return draft;
}

function reportItem(itemId: string, summary = "finding") {
  return {
    itemId,
    summary,
    evidenceReferences: ["fingerprint:sha256:abc"],
    confidence: "high",
  };
}

function validReport(): Record<string, unknown> {
  return {
    reportVersion: 1,
    reportId: UUIDS.report,
    childSessionId: UUIDS.session,
    parentSessionId: UUIDS.parent,
    assignmentId: UUIDS.item3,
    createdAt: "2026-07-14T10:11:12.123Z",
    outcomeSummary: "Child completed its assigned analysis",
    findings: [reportItem(UUIDS.item1)],
    proposedDecisions: [reportItem(UUIDS.item2)],
    filesObservedOrChanged: [],
    verificationPerformed: [],
    openFollowUps: [],
    blockers: [],
    evidenceFingerprints: [{
      fingerprintSchemaVersion: 1,
      fingerprintKeyId: "evidence-key-1",
      fingerprintDomain: "pm-evidence-frame-v1",
      fingerprint: "c".repeat(64),
    }],
  };
}

function validReportDraft(): Record<string, unknown> {
  const report = validReport();
  for (const serverField of [
    "reportId",
    "childSessionId",
    "parentSessionId",
    "assignmentId",
    "createdAt",
  ]) delete report[serverField];
  for (const field of [
    "findings",
    "proposedDecisions",
    "filesObservedOrChanged",
    "verificationPerformed",
    "openFollowUps",
    "blockers",
  ]) {
    report[field] = (report[field] as Array<Record<string, unknown>>).map(({ itemId: _itemId, ...item }) => item);
  }
  return report;
}

function validQualityPolicy(): Record<string, unknown> {
  return {
    qualityPolicyVersion: 1,
    profiles: [{
      profileId: "vault-gate",
      profileVersion: 1,
      required: true,
      weight: 100,
    }],
    qualityThreshold: 8_000,
    requireFullEvidence: false,
    requireMaterialization: true,
  };
}

function validEndRequest(): Record<string, unknown> {
  return {
    requestVersion: 1,
    sessionId: UUIDS.session,
    childEndPolicy: "require-completed",
    finalCheckpoint: validCheckpointDraft(),
    validationProfileIds: ["vault-gate"],
    requestedQualityThreshold: 8_000,
    requireFullEvidence: false,
    requireMaterialization: true,
  };
}

function validCommandBase(): Record<string, unknown> {
  return {
    commandId: UUIDS.command,
    idempotencyKey: DETERMINISTIC_IDEMPOTENCY_KEY,
    agentId: "agent-primary",
    expectedProjectId: UUIDS.item1,
    expectedVaultId: UUIDS.item2,
    expectedWorkspaceId: "a".repeat(64),
    expectedBranchRef: "refs/heads/main",
  };
}

function validAcceptedDisposition(): Record<string, unknown> {
  return {
    dispositionVersion: 1,
    reportId: UUIDS.report,
    kind: "accepted",
    acceptedItemIds: [UUIDS.item1, UUIDS.item2],
    rejectedItemIds: [],
    deferredItemIds: [],
    supersededByReportId: null,
    explanation: "Accepted all report items",
    allReportItemIds: [UUIDS.item1, UUIDS.item2],
  };
}

function validAmendment(): Record<string, unknown> {
  return {
    amendmentVersion: 1,
    childEndPolicy: null,
    finalCheckpoint: null,
    validationProfileIds: null,
    requestedQualityThreshold: null,
    requireFullEvidence: null,
    requireMaterialization: false,
  };
}

function validInternalValidationResultCommand(): InternalValidationResultCommand {
  const projectId = UUIDS.item1 as ProjectId;
  const vaultId = UUIDS.item2 as VaultId;
  const storeId = UUIDS.item3;
  const workspaceId = "a".repeat(64) as WorkspaceId;
  const finalCheckpointFingerprint = "b".repeat(64);
  const profileConfigurationHash = "c".repeat(64);
  const plannedWorkId = "0".repeat(64);
  const sourceState = {
    sourceStateScopeVersion: 1 as const,
    workspaceId,
    branchRef: "refs/heads/main",
    headCommit: "d".repeat(40),
    dirtyWorktreeFingerprint: "e".repeat(64),
  };
  const attemptPlan: ValidationAttemptPlanIdentityV1 = Object.freeze({
    attemptPlanVersion: 1,
    projectId,
    vaultId,
    storeId: storeId as never,
    workspaceId,
    sessionId: UUIDS.session as SessionId,
    workflowId: UUIDS.workflow as WorkflowId,
    workflowGeneration: 1,
    plannedWorkId,
    finalCheckpointId: UUIDS.checkpoint as CheckpointId,
    finalCheckpointFingerprint,
    profileId: "vault-gate",
    profileVersion: 1,
    profileConfigurationHash,
    runId: UUIDS.parent,
    resultId: UUIDS.report as ValidationResultId,
    resultCommandId: UUIDS.command,
    resultIdempotencyKey: DETERMINISTIC_IDEMPOTENCY_KEY,
  });
  const result: ValidationResultV1 = Object.freeze({
    validationResultVersion: 1,
    resultId: attemptPlan.resultId,
    projectId: attemptPlan.projectId,
    vaultId: attemptPlan.vaultId,
    storeId: attemptPlan.storeId,
    workspaceId: attemptPlan.workspaceId,
    sessionId: attemptPlan.sessionId,
    workflowId: attemptPlan.workflowId,
    workflowGeneration: attemptPlan.workflowGeneration,
    finalCheckpointId: attemptPlan.finalCheckpointId,
    finalCheckpointFingerprint: attemptPlan.finalCheckpointFingerprint,
    profileId: attemptPlan.profileId,
    profileVersion: attemptPlan.profileVersion,
    profileConfigurationHash: attemptPlan.profileConfigurationHash,
    runId: attemptPlan.runId,
    runnerId: UUIDS.client,
    sourceStateAtStart: Object.freeze({ ...sourceState }),
    sourceStateAtCompletion: Object.freeze({ ...sourceState }),
    startedAt: "2026-07-14T10:11:12.123Z",
    completedAt: "2026-07-14T10:11:13.123Z",
    status: "pass",
    exitClassification: "passed",
    summary: "Trusted validation passed",
    outputFingerprint: Object.freeze({
      fingerprintSchemaVersion: 1,
      fingerprintKeyId: "validation-key-1",
      fingerprintDomain: "pm-validation-output-v1",
      fingerprint: "f".repeat(64),
    }),
    artifactReferences: Object.freeze([]),
    fresh: true,
  });
  return Object.freeze({
    commandType: "internal-validation-result",
    commandId: attemptPlan.resultCommandId,
    idempotencyKey: attemptPlan.resultIdempotencyKey,
    agentId: "trusted-validation-coordinator",
    expectedProjectId: projectId,
    expectedVaultId: vaultId,
    expectedWorkspaceId: workspaceId,
    expectedBranchRef: "refs/heads/main",
    workflowId: attemptPlan.workflowId,
    workflowGeneration: attemptPlan.workflowGeneration,
    plannedWorkId,
    attemptPlan,
    claim: Object.freeze({
      workflowId: attemptPlan.workflowId,
      workflowGeneration: attemptPlan.workflowGeneration,
      claimOwnerId: UUIDS.client,
      claimToken: CANONICAL_CLAIM_TOKEN,
      claimExpiresAt: "2026-07-14T10:12:12.123Z",
    }),
    result,
  });
}

function validValidationResultInput(): Record<string, unknown> {
  const result = validInternalValidationResultCommand().result;
  return {
    ...result,
    sourceStateAtStart: { ...result.sourceStateAtStart },
    sourceStateAtCompletion: { ...result.sourceStateAtCompletion },
    outputFingerprint: { ...result.outputFingerprint },
    artifactReferences: [...result.artifactReferences],
  };
}

function lifecycleEventPayloadCases(): Array<readonly [string, Record<string, unknown>]> {
  const authorityCommitment = "a".repeat(64);
  return [
    ["SessionStarted", {
      sessionKind: "root",
      ownerGeneration: 1,
      continuityKey: "thread:stable-key",
      clientNamespace: "codex-desktop",
      creatingAgentId: "agent-primary",
      creatingClientInstanceId: OPAQUE_CLIENT_INSTANCE_ID,
      authorityCommitment,
    }],
    ["SessionOwnerTransferred", {
      previousOwnerGeneration: 1,
      ownerGeneration: 2,
      authorityCommitment,
    }],
    ["SessionOwnershipRecovered", {
      previousOwnerGeneration: 1,
      ownerGeneration: 2,
      approvalId: UUIDS.item1,
      authorityCommitment,
    }],
    ["SessionSuspendRequested", { checkpointId: UUIDS.checkpoint }],
    ["SessionSuspended", { authorityCommitment }],
    ["SessionResumed", { ownerGeneration: 2 }],
    ["SessionCheckpointRecorded", {
      checkpoint: validCheckpoint(),
      baseEventPosition: "12",
      checkpointEventPosition: "13",
    }],
    ["EvidenceCoverageRecorded", {
      adapterSessionId: UUIDS.parent,
      batchId: UUIDS.report,
      firstOrdinal: "0",
      lastOrdinal: "0",
      highestContiguousOrdinal: "0",
      missingIntervals: [],
      fingerprintSchemaVersion: 1,
      fingerprintKeyId: "evidence-key-1",
      fingerprintDomain: "pm-evidence-frame-v1",
      coverageFingerprint: "b".repeat(64),
      captureMode: "coverage-only",
      contentRetained: false,
      frames: [{
        frameId: UUIDS.item3,
        ordinal: "0",
        sourceKind: "tool-result",
        observedAt: "2026-07-14T10:11:12.123Z",
        contentFingerprint: "c".repeat(64),
      }],
    }],
    ["SessionForked", {
      parentSessionId: UUIDS.parent,
      assignment: { assignmentId: UUIDS.item1, summary: "Investigate", scope: "src/orchestrator" },
      rootOwnerGeneration: 1,
      directAccessEnabled: false,
      authorityCommitment,
      sourceTransferTicketId: null,
    }],
    ["ChildAssignmentAmended", {
      previousAssignmentRevision: 1,
      assignmentRevision: 2,
      assignment: { assignmentId: UUIDS.item1, summary: "Investigate more", scope: "src/orchestrator" },
      reasonCode: "scope-clarified",
    }],
    ["ChildWorkReported", {
      report: validReport(),
      childAuthorAgentId: "agent-child",
      primaryRecorderAgentId: "agent-primary",
    }],
    ["ChildWorkDispositioned", { disposition: validAcceptedDisposition() }],
    ["ChildCompletionProposed", { reportId: UUIDS.report }],
    ["ChildSessionCompleted", { reportId: UUIDS.report, authorityCommitment }],
    ["ChildSessionSuspended", {
      checkpointId: UUIDS.checkpoint,
      blockers: ["Awaiting review"],
      followUps: ["Resume later"],
      authorityCommitment,
    }],
    ["ChildWorkTransferCreated", {
      transferTicketId: UUIDS.item3,
      checkpointId: UUIDS.checkpoint,
      authorityCommitment,
    }],
    ["ChildWorkTransferClaimed", {
      transferTicketId: UUIDS.item3,
      previousChildSessionId: UUIDS.parent,
      previousTransferEventPosition: "11",
    }],
    ["SessionEndRequested", {
      workflowId: UUIDS.workflow,
      workflowGeneration: 1,
      previousState: "active",
      childEndPolicy: "require-completed",
      qualityThreshold: 8_000,
      requireFullEvidence: false,
      requireMaterialization: true,
    }],
    ["SessionEndAmended", {
      workflowId: UUIDS.workflow,
      previousWorkflowGeneration: 1,
      workflowGeneration: 2,
      preTransitionCheckpointId: UUIDS.checkpoint,
    }],
    ["SessionValidationResultRecorded", {
      workflowId: UUIDS.workflow,
      workflowGeneration: 1,
      plannedWorkId: "0".repeat(64),
      validationResult: validValidationResultInput(),
    }],
    ["SessionEndVerificationPassed", {
      workflowId: UUIDS.workflow,
      workflowGeneration: 1,
      validationResultIds: [UUIDS.report],
      qualityScore: 10_000,
    }],
    ["SessionEndVerificationFailed", {
      workflowId: UUIDS.workflow,
      workflowGeneration: 1,
      validationResultIds: [UUIDS.report],
      safeFailureCode: "SESSION_VALIDATION_RESULT_INVALID",
    }],
    ["SessionEndVerificationInvalidated", {
      workflowId: UUIDS.workflow,
      workflowGeneration: 1,
      previousVerificationEventPosition: "18",
      safeFailureCode: "SESSION_SOURCE_STATE_CONFLICT",
    }],
    ["SessionEndCancelled", {
      workflowId: UUIDS.workflow,
      workflowGeneration: 2,
      restoredState: "active",
      preTransitionCheckpointId: UUIDS.checkpoint,
    }],
    ["SessionAbandoned", {
      workflowId: UUIDS.workflow,
      workflowGeneration: 2,
      approvalId: UUIDS.item1,
      preTransitionCheckpointId: UUIDS.checkpoint,
      reasonCode: "explicit-user-approval",
      authorityCommitment,
    }],
    ["SessionEnded", {
      workflowId: UUIDS.workflow,
      workflowGeneration: 1,
      verificationEventPosition: "20",
      authorityCommitment,
    }],
  ];
}

function validLifecycleEvent(
  eventType = "SessionStarted",
  payload: Record<string, unknown> = lifecycleEventPayloadCases()[0]![1],
): Record<string, unknown> {
  const childEventTypes = new Set([
    "SessionForked",
    "ChildAssignmentAmended",
    "ChildWorkReported",
    "ChildWorkDispositioned",
    "ChildCompletionProposed",
    "ChildSessionCompleted",
    "ChildSessionSuspended",
    "ChildWorkTransferCreated",
    "ChildWorkTransferClaimed",
  ]);
  return {
    eventSchemaVersion: 1,
    eventId: UUIDS.item3,
    projectId: UUIDS.item1,
    vaultId: UUIDS.item2,
    storeId: UUIDS.item3,
    workspaceId: "a".repeat(64),
    streamId: `session/${UUIDS.session}`,
    streamVersion: "1",
    globalPosition: eventType === "SessionCheckpointRecorded" ? "13" : "1",
    sessionId: UUIDS.session,
    parentSessionId: childEventTypes.has(eventType) ? UUIDS.parent : null,
    eventType,
    correlationId: UUIDS.parent,
    causationId: null,
    commandId: UUIDS.command,
    idempotencyKey: DETERMINISTIC_IDEMPOTENCY_KEY,
    occurredAt: "2026-07-14T10:11:12.123Z",
    authorityCommitment: "a".repeat(64),
    payload,
  };
}

function semanticCommandCases(): Array<readonly [string, Record<string, unknown>]> {
  const base = validCommandBase();
  return [
    ["root-start", { ...base, commandType: "root-start", continuityKey: "thread:key", resumePolicy: "new" }],
    ["root-resume", {
      ...base,
      commandType: "root-resume",
      sessionId: UUIDS.session,
      continuityKey: "thread:key",
      resumePolicy: "exact",
      expectedOwnerGeneration: "1",
    }],
    ["root-recovery", {
      ...base,
      commandType: "root-recovery",
      sessionId: UUIDS.session,
      expectedOwnerGeneration: "1",
      preTransitionCheckpointId: UUIDS.checkpoint,
      reasonCode: "capability-lost",
    }],
    ["root-suspend", {
      ...base,
      commandType: "root-suspend",
      sessionId: UUIDS.session,
      expectedStreamVersion: "1",
      checkpoint: validCheckpointDraft(),
    }],
    ["fork-child", {
      ...base,
      commandType: "fork-child",
      parentSessionId: UUIDS.session,
      expectedStreamVersion: "1",
      assignment: { assignmentId: UUIDS.item1, summary: "Investigate", scope: "src/orchestrator" },
      directAccessRequested: false,
    }],
    ["amend-child-assignment", {
      ...base,
      commandType: "amend-child-assignment",
      parentSessionId: UUIDS.parent,
      childSessionId: UUIDS.session,
      expectedStreamVersion: "2",
      assignment: { assignmentId: UUIDS.item1, summary: "Investigate more", scope: "src/orchestrator" },
    }],
    ["record-checkpoint", {
      ...base,
      commandType: "record-checkpoint",
      sessionId: UUIDS.session,
      expectedStreamVersion: "2",
      expectedBaseEventPosition: "12",
      draft: validCheckpointDraft(),
    }],
    ["record-evidence-batch", {
      ...base,
      commandType: "record-evidence-batch",
      adapterSessionId: UUIDS.parent,
      batchId: UUIDS.report,
      sessionId: UUIDS.session,
      firstOrdinal: "0",
      lastOrdinal: "0",
      fingerprintSchemaVersion: 1,
      fingerprintKeyId: "evidence-key-1",
      fingerprintDomain: "pm-evidence-frame-v1",
      redactionStatus: "content-not-retained",
      frames: [{
        frameId: UUIDS.item3,
        ordinal: "0",
        sourceKind: "tool-result",
        observedAt: "2026-07-14T10:11:12.123Z",
        contentFingerprint: "a".repeat(64),
      }],
    }],
    ["record-child-report", {
      ...base,
      commandType: "record-child-report",
      childSessionId: UUIDS.session,
      expectedStreamVersion: "2",
      report: validReportDraft(),
    }],
    ["disposition-child-report", {
      ...base,
      commandType: "disposition-child-report",
      parentSessionId: UUIDS.parent,
      childSessionId: UUIDS.session,
      expectedStreamVersion: "2",
      disposition: validAcceptedDisposition(),
    }],
    ["propose-child-completion", {
      ...base,
      commandType: "propose-child-completion",
      childSessionId: UUIDS.session,
      expectedStreamVersion: "2",
      reportId: UUIDS.report,
    }],
    ["complete-child-session", {
      ...base,
      commandType: "complete-child-session",
      parentSessionId: UUIDS.parent,
      childSessionId: UUIDS.session,
      expectedStreamVersion: "2",
      reportId: UUIDS.report,
    }],
    ["suspend-child-session", {
      ...base,
      commandType: "suspend-child-session",
      parentSessionId: UUIDS.parent,
      childSessionId: UUIDS.session,
      expectedStreamVersion: "2",
      checkpointId: UUIDS.checkpoint,
      blockers: ["Awaiting review"],
      followUps: ["Resume later"],
    }],
    ["create-child-transfer", {
      ...base,
      commandType: "create-child-transfer",
      parentSessionId: UUIDS.parent,
      childSessionId: UUIDS.session,
      expectedStreamVersion: "2",
      checkpointId: UUIDS.checkpoint,
    }],
    ["claim-child-transfer", {
      ...base,
      commandType: "claim-child-transfer",
      rootSessionId: UUIDS.parent,
      transferTicketId: UUIDS.item3,
      expectedStreamVersion: "2",
    }],
    ["request-session-end", { ...base, commandType: "request-session-end", request: validEndRequest() }],
    ["amend-session-end", {
      ...base,
      commandType: "amend-session-end",
      sessionId: UUIDS.session,
      workflowId: UUIDS.workflow,
      expectedStreamVersion: "2",
      amendment: validAmendment(),
    }],
    ["cancel-session-end", {
      ...base,
      commandType: "cancel-session-end",
      sessionId: UUIDS.session,
      workflowId: UUIDS.workflow,
      expectedStreamVersion: "2",
      preTransitionCheckpointId: UUIDS.checkpoint,
    }],
    ["abandon-session", {
      ...base,
      commandType: "abandon-session",
      sessionId: UUIDS.session,
      expectedStreamVersion: "2",
      preTransitionCheckpointId: UUIDS.checkpoint,
      reasonCode: "explicit-user-approval",
    }],
  ];
}

describe("lifecycle Version 1 contracts", () => {
  it("exports the complete lifecycle contract type surface", () => {
    const surface = null as unknown as RequiredContractSurface;
    assert.equal(surface, null);
  });

  it("accepts only canonical identities and SQLite-safe decimal positions", () => {
    assert.equal(parseCanonicalUuid(UUIDS.session, "sessionId"), UUIDS.session);
    assert.equal(parseUnsignedDecimal("0", "position"), 0n);
    assert.equal(
      parseUnsignedDecimal("9223372036854775807", "position"),
      9_223_372_036_854_775_807n,
    );

    for (const value of [
      UUIDS.session.toUpperCase(),
      "aaaaaaaa-aaaa-6aaa-8aaa-aaaaaaaaaaaa",
      "aaaaaaaa-aaaa-4aaa-7aaa-aaaaaaaaaaaa",
      "{aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa}",
      "",
      null,
    ]) {
      expectCode("LIFECYCLE_INPUT_INVALID", () => parseCanonicalUuid(value, "sessionId"));
    }

    for (const value of ["01", "-1", "+1", "1.0", " 1", "9223372036854775808", 1]) {
      expectCode("LIFECYCLE_INPUT_INVALID", () => parseUnsignedDecimal(value, "position"));
    }
  });

  it("accepts canonical UUID versions 1 through 5 and every RFC variant nibble", () => {
    for (const version of ["1", "2", "3", "4", "5"]) {
      for (const variant of ["8", "9", "a", "b"]) {
        const value = `aaaaaaaa-aaaa-${version}aaa-${variant}aaa-aaaaaaaaaaaa`;
        assert.equal(parseCanonicalUuid(value, "id"), value);
      }
    }
  });

  it("rejects impossible decimal lengths before invoking BigInt", () => {
    const globals = globalThis as unknown as { BigInt: BigIntConstructor };
    const original = globals.BigInt;
    let invoked = false;
    globals.BigInt = ((value: string | number | bigint | boolean) => {
      invoked = true;
      return original(value);
    }) as BigIntConstructor;
    try {
      expectCode("LIFECYCLE_INPUT_INVALID", () =>
        parseUnsignedDecimal("9".repeat(100_000), "position"));
      assert.equal(invoked, false);
    } finally {
      globals.BigInt = original;
    }
  });

  it("accepts only real millisecond-precision UTC timestamps", () => {
    const value = "2024-02-29T23:59:59.000Z";
    assert.equal(parseCanonicalTimestamp(value, "createdAt"), value);
    for (const candidate of [
      "2024-02-29T23:59:59Z",
      "2024-02-29t23:59:59.000z",
      "2024-02-29T23:59:59.000+00:00",
      "2023-02-29T23:59:59.000Z",
      "2024-02-29T24:00:00.000Z",
      new Date(),
    ]) {
      expectCode("LIFECYCLE_INPUT_INVALID", () => parseCanonicalTimestamp(candidate, "createdAt"));
    }
  });

  it("strictly decodes and freezes a checkpoint", () => {
    const decoded = decodeCheckpointV1(validCheckpoint());
    assert.equal(decoded.taskSummary, "Bounded checkpoint");
    assert.equal(decoded.creatorClientInstanceId, OPAQUE_CLIENT_INSTANCE_ID);
    assert.ok(Object.isFrozen(decoded));
    assert.ok(Object.isFrozen(decoded.completedItems));
    assert.ok(Object.isFrozen(decoded.completedItems[0]));
    assert.ok(Object.isFrozen(decoded.sourceState));
    assert.ok(Object.isFrozen(decoded.evidenceCoverage.missingIntervals));

    const unknown = { ...validCheckpoint(), rawOutput: "private output" };
    expectCode("LIFECYCLE_INPUT_INVALID", () => decodeCheckpointV1(unknown));
  });

  it("keeps checkpoint creator client instance identity opaque and bounded", () => {
    for (const creatorClientInstanceId of ["", "x".repeat(257), 42]) {
      expectCode("LIFECYCLE_INPUT_INVALID", () => decodeCheckpointV1({
        ...validCheckpoint(),
        creatorClientInstanceId,
      }));
    }

    const accessor = validCheckpoint();
    Object.defineProperty(accessor, "creatorClientInstanceId", {
      enumerable: true,
      get: () => OPAQUE_CLIENT_INSTANCE_ID,
    });
    expectCode("LIFECYCLE_INPUT_INVALID", () => decodeCheckpointV1(accessor));
  });

  it("rejects symbol and non-enumerable array properties", () => {
    const withSymbol = [textItem()];
    Object.defineProperty(withSymbol, Symbol("hidden"), { value: "unsafe", enumerable: true });
    const withHidden = [textItem()];
    Object.defineProperty(withHidden, "hidden", { value: "unsafe", enumerable: false });
    for (const completedItems of [withSymbol, withHidden]) {
      const input = validCheckpoint();
      input.completedItems = completedItems;
      expectCode("LIFECYCLE_INPUT_INVALID", () => decodeCheckpointV1(input));
    }
  });

  it("strictly decodes caller-only checkpoint drafts and rejects server-derived assertions", () => {
    const decoded = decodeCheckpointDraftV1(validCheckpointDraft());
    assert.equal(decoded.taskSummary, "Bounded checkpoint");
    assert.ok(Object.isFrozen(decoded));
    for (const serverField of [
      "checkpointId",
      "sessionId",
      "parentSessionId",
      "baseEventPosition",
      "checkpointEventPosition",
      "createdAt",
      "creatorAgentId",
      "creatorClientInstanceId",
      "sourceState",
      "childSummaries",
      "evidenceCoverage",
    ]) {
      expectCode("LIFECYCLE_INPUT_INVALID", () => decodeCheckpointDraftV1({
        ...validCheckpointDraft(),
        [serverField]: (validCheckpoint() as Record<string, unknown>)[serverField] ?? "caller-selected",
      }));
    }
  });

  it("rejects a checkpoint base later than its committed event", () => {
    const input = validCheckpoint();
    input.baseEventPosition = "14";
    input.checkpointEventPosition = "13";
    expectCode("CHECKPOINT_BASE_INVALID", () => decodeCheckpointV1(input));
  });

  it("enforces every checkpoint scalar and list bound", () => {
    const scalarCases: Array<[string, (input: Record<string, unknown>) => void]> = [
      ["taskSummary", (input) => { input.taskSummary = "x".repeat(2_001); }],
      ["individual summary", (input) => {
        input.completedItems = [textItem("x".repeat(4_001))];
      }],
      ["individual result", (input) => {
        input.commandResults = [{
          label: "build",
          result: "x".repeat(4_001),
          exitClassification: "passed",
          outputFingerprint: null,
          artifactReference: null,
          confidence: "high",
        }];
      }],
    ];
    for (const [name, mutate] of scalarCases) {
      const input = validCheckpoint();
      mutate(input);
      assert.throws(() => decodeCheckpointV1(input), { message: /LIFECYCLE_INPUT_INVALID/ }, name);
    }

    for (const field of [
      "completedItems",
      "inProgressItems",
      "blockers",
      "nextActions",
      "decisions",
      "assumptions",
      "unresolvedConflicts",
    ]) {
      const input = validCheckpoint();
      input[field] = Array.from({ length: 101 }, () => textItem());
      expectCode("LIFECYCLE_INPUT_INVALID", () => decodeCheckpointV1(input));
    }

    const combined = validCheckpoint();
    combined.filesTouched = Array.from({ length: 200 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      action: "observed",
      contentHash: null,
      branchRef: null,
      confidence: "high",
    }));
    assert.equal(decodeCheckpointV1(combined).filesTouched.length, 200);
    (combined.artifactReferences as unknown[]) = [{
      artifactId: UUIDS.item1,
      path: "artifacts/result.json",
      summary: "retained result",
      contentHash: "a".repeat(64),
      confidence: "high",
    }];
    expectCode("LIFECYCLE_INPUT_INVALID", () => decodeCheckpointV1(combined));

    const intervals = validCheckpoint();
    intervals.evidenceCoverage = {
      captureMode: "coverage-only",
      highestContiguousOrdinal: null,
      missingIntervals: Array.from({ length: 201 }, (_, index) => ({
        firstOrdinal: String(index * 2),
        lastOrdinal: String(index * 2),
      })),
    };
    expectCode("EVIDENCE_COVERAGE_TOO_FRAGMENTED", () => decodeCheckpointV1(intervals));
  });

  it("counts Unicode scalar values and rejects unsafe project paths", () => {
    const scalar = "🧠";
    const boundary = validCheckpoint();
    boundary.taskSummary = scalar.repeat(2_000);
    assert.equal(decodeCheckpointV1(boundary).taskSummary, scalar.repeat(2_000));
    boundary.taskSummary = scalar.repeat(2_001);
    expectCode("LIFECYCLE_INPUT_INVALID", () => decodeCheckpointV1(boundary));

    const pathBoundary = validCheckpoint();
    pathBoundary.filesTouched = [{
      path: `${scalar.repeat(508)}.txt`,
      action: "observed",
      contentHash: null,
      branchRef: null,
      confidence: "high",
    }];
    assert.equal(decodeCheckpointV1(pathBoundary).filesTouched.length, 1);

    for (const path of [
      "",
      ".",
      "..",
      "../outside",
      "src/../outside",
      "src/./file.ts",
      "/absolute/file.ts",
      "\\\\server\\share\\file.ts",
      "C:\\absolute\\file.ts",
      "C:/absolute/file.ts",
      `${scalar.repeat(509)}.txt`,
    ]) {
      const input = validCheckpoint();
      input.filesTouched = [{
        path,
        action: "observed",
        contentHash: null,
        branchRef: null,
        confidence: "high",
      }];
      expectCode("LIFECYCLE_INPUT_INVALID", () => decodeCheckpointV1(input));
    }
  });

  it("counts all six material-entry categories in one shared limit", () => {
    const input = validCheckpoint();
    input.filesTouched = Array.from({ length: 195 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      action: "observed",
      contentHash: null,
      branchRef: null,
      confidence: "high",
    }));
    input.artifactReferences = [{
      artifactId: UUIDS.item1,
      path: "artifacts/result.json",
      summary: "retained artifact",
      contentHash: "a".repeat(64),
      confidence: "high",
    }];
    input.sourceReferences = [{
      sourceId: UUIDS.item2,
      path: "src/source.ts",
      summary: "source reference",
      contentHash: null,
      confidence: "high",
    }];
    const execution = {
      label: "verification",
      result: "passed",
      exitClassification: "passed",
      outputFingerprint: null,
      artifactReference: null,
      confidence: "high",
    };
    input.commandResults = [execution];
    input.testResults = [execution];
    input.materialClaims = [{
      claimId: UUIDS.item3,
      summary: "material claim",
      evidenceReferences: ["fingerprint:claim"],
      confidence: "high",
    }];
    assert.equal(decodeCheckpointV1(input).filesTouched.length, 195);
    input.materialClaims = [
      ...(input.materialClaims as unknown[]),
      {
        claimId: UUIDS.report,
        summary: "one too many",
        evidenceReferences: [],
        confidence: "high",
      },
    ];
    expectCode("LIFECYCLE_INPUT_INVALID", () => decodeCheckpointV1(input));
  });

  it("strictly validates trusted source-state, child-summary, hash, and fingerprint shapes", () => {
    const input = validCheckpoint();
    input.childSummaries = [{
      childSessionId: UUIDS.parent,
      state: "active",
      lastEventPosition: "11",
      streamVersion: "2",
      latestCheckpointId: null,
    }];
    input.commandResults = [{
      label: "build",
      result: "passed",
      exitClassification: "passed",
      outputFingerprint: {
        fingerprintSchemaVersion: 1,
        fingerprintKeyId: "validation-key-1",
        fingerprintDomain: "pm-validation-output-v1",
        fingerprint: "d".repeat(64),
      },
      artifactReference: null,
      confidence: "high",
    }];
    const decoded = decodeCheckpointV1(input);
    assert.ok(Object.isFrozen(decoded.childSummaries));
    assert.ok(Object.isFrozen(decoded.childSummaries[0]));
    assert.ok(Object.isFrozen(decoded.commandResults[0]?.outputFingerprint));

    for (const mutate of [
      (candidate: Record<string, unknown>) => {
        candidate.sourceState = { ...(candidate.sourceState as object), excludedPath: "caller/chosen" };
      },
      (candidate: Record<string, unknown>) => {
        candidate.sourceState = { ...(candidate.sourceState as object), dirtyWorktreeFingerprint: "not-a-hash" };
      },
      (candidate: Record<string, unknown>) => {
        candidate.sourceState = { ...(candidate.sourceState as object), workspaceId: "not-a-workspace-id" };
      },
      (candidate: Record<string, unknown>) => {
        candidate.sourceState = { ...(candidate.sourceState as object), workspaceId: "A".repeat(64) };
      },
      (candidate: Record<string, unknown>) => {
        candidate.childSummaries = [{
          childSessionId: UUIDS.parent.toUpperCase(),
          state: "active",
          lastEventPosition: "11",
          streamVersion: "2",
          latestCheckpointId: null,
        }];
      },
      (candidate: Record<string, unknown>) => {
        candidate.filesTouched = [{
          path: "src/example.ts",
          action: "modified",
          contentHash: "plain-content-hash",
          branchRef: null,
          confidence: "high",
        }];
      },
    ]) {
      const candidate = validCheckpoint();
      mutate(candidate);
      expectCode("LIFECYCLE_INPUT_INVALID", () => decodeCheckpointV1(candidate));
    }

    const accessor = validCheckpoint();
    const sourceState = { ...(accessor.sourceState as object) };
    Object.defineProperty(sourceState, "workspaceId", {
      enumerable: true,
      get: () => "a".repeat(64),
    });
    accessor.sourceState = sourceState;
    expectCode("LIFECYCLE_INPUT_INVALID", () => decodeCheckpointV1(accessor));
  });

  it("keeps Version 1 evidence capture honestly coverage-only", () => {
    assert.equal(decodeCheckpointV1(validCheckpoint()).evidenceCoverage.captureMode, "coverage-only");
    for (const captureMode of ["none", "partial", "tool-only", "full-adapter"]) {
      const input = validCheckpoint();
      input.evidenceCoverage = {
        ...(input.evidenceCoverage as object),
        captureMode,
      };
      expectCode("LIFECYCLE_INPUT_INVALID", () => decodeCheckpointV1(input));
    }
  });

  it("enforces the canonical checkpoint JSON byte limit", () => {
    function withExactBytes(target: number): Record<string, unknown> {
      const input = validCheckpoint();
      input.completedItems = Array.from({ length: 100 }, () => textItem("x"));
      let remaining = target - Buffer.byteLength(JSON.stringify(input), "utf8");
      assert.ok(remaining >= 0);
      for (const item of input.completedItems as Array<{ summary: string }>) {
        const added = Math.min(remaining, 3_999);
        item.summary += "x".repeat(added);
        remaining -= added;
      }
      assert.equal(remaining, 0);
      assert.equal(Buffer.byteLength(JSON.stringify(input), "utf8"), target);
      return input;
    }

    const exact = withExactBytes(CHECKPOINT_MAX_CANONICAL_BYTES);
    assert.equal(
      Buffer.byteLength(JSON.stringify(decodeCheckpointV1(exact)), "utf8"),
      CHECKPOINT_MAX_CANONICAL_BYTES,
    );
    expectCode(
      "LIFECYCLE_INPUT_INVALID",
      () => decodeCheckpointV1(withExactBytes(CHECKPOINT_MAX_CANONICAL_BYTES + 1)),
    );
  });

  it("requires canonical ordered, separated missing-ordinal intervals", () => {
    for (const missingIntervals of [
      [
        { firstOrdinal: "5", lastOrdinal: "6" },
        { firstOrdinal: "4", lastOrdinal: "4" },
      ],
      [
        { firstOrdinal: "4", lastOrdinal: "5" },
        { firstOrdinal: "5", lastOrdinal: "6" },
      ],
      [
        { firstOrdinal: "4", lastOrdinal: "5" },
        { firstOrdinal: "6", lastOrdinal: "7" },
      ],
      [{ firstOrdinal: "5", lastOrdinal: "4" }],
    ]) {
      const input = validCheckpoint();
      input.evidenceCoverage = {
        captureMode: "coverage-only",
        highestContiguousOrdinal: "3",
        missingIntervals,
      };
      expectCode("LIFECYCLE_INPUT_INVALID", () => decodeCheckpointV1(input));
    }

    for (const [highestContiguousOrdinal, missingIntervals] of [
      ["10", [{ firstOrdinal: "4", lastOrdinal: "5" }]],
      [null, [{ firstOrdinal: "1", lastOrdinal: "2" }]],
      ["3", [{ firstOrdinal: "5", lastOrdinal: "6" }]],
    ] as const) {
      const input = validCheckpoint();
      input.evidenceCoverage = {
        captureMode: "coverage-only",
        highestContiguousOrdinal,
        missingIntervals,
      };
      expectCode("LIFECYCLE_INPUT_INVALID", () => decodeCheckpointV1(input));
    }
  });

  it("strictly decodes reports and rejects duplicate report item identities", () => {
    const decoded = decodeChildReportV1(validReport());
    assert.deepEqual(decoded.allReportItemIds, [UUIDS.item1, UUIDS.item2]);
    assert.ok(Object.isFrozen(decoded));
    assert.ok(Object.isFrozen(decoded.findings));
    assert.ok(Object.isFrozen(decoded.findings[0]));

    const duplicate = validReport();
    duplicate.proposedDecisions = [reportItem(UUIDS.item1)];
    expectCode("CHILD_REPORT_INVALID", () => decodeChildReportV1(duplicate));

    expectCode("CHILD_REPORT_INVALID", () => decodeChildReportV1({
      ...validReport(),
      plaintextEvidence: "must never be retained",
    }));
  });

  it("strictly decodes caller-only report drafts without generated identity or lineage", () => {
    const decoded = decodeChildReportDraftV1(validReportDraft());
    assert.equal(decoded.outcomeSummary, "Child completed its assigned analysis");
    assert.ok(Object.isFrozen(decoded));
    assert.ok(Object.isFrozen(decoded.findings[0]));
    for (const serverField of ["reportId", "childSessionId", "parentSessionId", "assignmentId", "createdAt"]) {
      expectCode("CHILD_REPORT_INVALID", () => decodeChildReportDraftV1({
        ...validReportDraft(),
        [serverField]: validReport()[serverField],
      }));
    }
    const itemIdentity = validReportDraft();
    itemIdentity.findings = [{
      ...(itemIdentity.findings as Array<Record<string, unknown>>)[0],
      itemId: UUIDS.item1,
    }];
    expectCode("CHILD_REPORT_INVALID", () => decodeChildReportDraftV1(itemIdentity));
  });

  it("enforces report bounds, recursive exactness, uniqueness, freezing, and input detachment", () => {
    const exact = validReport();
    exact.outcomeSummary = "x".repeat(4_000);
    exact.findings = [reportItem(UUIDS.item1, "x".repeat(4_000))];
    const decoded = decodeChildReportV1(exact);
    assert.ok(Object.isFrozen(decoded.findings[0]?.evidenceReferences));
    assert.ok(Object.isFrozen(decoded.evidenceFingerprints));
    (exact.findings as Array<Record<string, unknown>>)[0]!.summary = "mutated after decode";
    assert.equal(decoded.findings[0]?.summary, "x".repeat(4_000));

    for (const mutate of [
      (input: Record<string, unknown>) => { input.outcomeSummary = "x".repeat(4_001); },
      (input: Record<string, unknown>) => {
        input.findings = [{ ...reportItem(UUIDS.item1), unexpected: true }];
      },
      (input: Record<string, unknown>) => {
        input.evidenceFingerprints = [{
          ...((input.evidenceFingerprints as Array<Record<string, unknown>>)[0] ?? {}),
          unexpected: true,
        }];
      },
      (input: Record<string, unknown>) => { input.createdAt = "2026-07-14T10:11:12Z"; },
      (input: Record<string, unknown>) => { input.childSessionId = UUIDS.session.toUpperCase(); },
    ]) {
      const input = validReport();
      mutate(input);
      expectCode("CHILD_REPORT_INVALID", () => decodeChildReportV1(input));
    }

    const categories = [
      "findings",
      "proposedDecisions",
      "filesObservedOrChanged",
      "verificationPerformed",
      "openFollowUps",
      "blockers",
    ];
    for (const field of categories) {
      const input = validReport();
      for (const category of categories) input[category] = [];
      input[field] = [reportItem(UUIDS.item1), reportItem(UUIDS.item1)];
      expectCode("CHILD_REPORT_INVALID", () => decodeChildReportV1(input));
    }

    const bounded = validReport();
    for (const category of categories) bounded[category] = [];
    const items = Array.from({ length: 200 }, (_, index) => reportItem(indexedUuid(index + 1)));
    bounded.findings = items.slice(0, 34);
    bounded.proposedDecisions = items.slice(34, 68);
    bounded.filesObservedOrChanged = items.slice(68, 101);
    bounded.verificationPerformed = items.slice(101, 134);
    bounded.openFollowUps = items.slice(134, 167);
    bounded.blockers = items.slice(167, 200);
    assert.equal(decodeChildReportV1(bounded).allReportItemIds.length, 200);
    bounded.blockers = [...(bounded.blockers as unknown[]), reportItem(indexedUuid(201))];
    expectCode("CHILD_REPORT_INVALID", () => decodeChildReportV1(bounded));
  });

  it("requires a complete, pairwise-disjoint disposition partition", () => {
    const base = {
      dispositionVersion: 1,
      reportId: UUIDS.report,
      explanation: "Reviewed every report item",
      allReportItemIds: [UUIDS.item1, UUIDS.item2, UUIDS.item3],
    };

    const valid = [
      {
        ...base,
        kind: "accepted",
        acceptedItemIds: [...base.allReportItemIds],
        rejectedItemIds: [],
        deferredItemIds: [],
        supersededByReportId: null,
      },
      {
        ...base,
        kind: "rejected",
        acceptedItemIds: [],
        rejectedItemIds: [...base.allReportItemIds],
        deferredItemIds: [],
        supersededByReportId: null,
      },
      {
        ...base,
        kind: "partially-accepted",
        acceptedItemIds: [UUIDS.item1],
        rejectedItemIds: [UUIDS.item2],
        deferredItemIds: [UUIDS.item3],
        supersededByReportId: null,
      },
      {
        ...base,
        kind: "superseded",
        acceptedItemIds: [],
        rejectedItemIds: [...base.allReportItemIds],
        deferredItemIds: [],
        supersededByReportId: UUIDS.parent,
      },
    ];
    for (const input of valid) {
      const decoded = decodeChildDispositionV1(input);
      assert.equal(decoded.kind, input.kind);
      assert.ok(Object.isFrozen(decoded));
      assert.ok(Object.isFrozen(decoded.allReportItemIds));
    }

    const invalid = [
      { ...valid[0], acceptedItemIds: [UUIDS.item1] },
      { ...valid[1], rejectedItemIds: [UUIDS.item1, UUIDS.item2] },
      { ...valid[2], acceptedItemIds: [], rejectedItemIds: [UUIDS.item1, UUIDS.item2] },
      { ...valid[2], acceptedItemIds: [UUIDS.item1], rejectedItemIds: [], deferredItemIds: [] },
      { ...valid[2], acceptedItemIds: [UUIDS.item1], rejectedItemIds: [UUIDS.item1, UUIDS.item2] },
      { ...valid[3], supersededByReportId: null },
      { ...valid[3], acceptedItemIds: [UUIDS.item1], rejectedItemIds: [UUIDS.item2, UUIDS.item3] },
      { ...valid[0], unknown: true },
    ];
    for (const input of invalid) {
      expectCode("CHILD_DISPOSITION_INVALID", () => decodeChildDispositionV1(input));
    }
  });

  it("rejects every duplicate, overlap pair, stray supersession, and malformed disposition identity", () => {
    const invalid = [
      { ...validAcceptedDisposition(), acceptedItemIds: [UUIDS.item1, UUIDS.item1] },
      { ...validAcceptedDisposition(), allReportItemIds: [UUIDS.item1, UUIDS.item1] },
      {
        ...validAcceptedDisposition(),
        kind: "partially-accepted",
        acceptedItemIds: [UUIDS.item1],
        rejectedItemIds: [UUIDS.item1],
        deferredItemIds: [UUIDS.item2],
      },
      {
        ...validAcceptedDisposition(),
        kind: "partially-accepted",
        acceptedItemIds: [UUIDS.item1],
        rejectedItemIds: [UUIDS.item2],
        deferredItemIds: [UUIDS.item1],
      },
      {
        ...validAcceptedDisposition(),
        kind: "partially-accepted",
        acceptedItemIds: [UUIDS.item2],
        rejectedItemIds: [UUIDS.item1],
        deferredItemIds: [UUIDS.item1],
      },
      { ...validAcceptedDisposition(), supersededByReportId: UUIDS.parent },
      { ...validAcceptedDisposition(), reportId: UUIDS.report.toUpperCase() },
      {
        ...validAcceptedDisposition(),
        acceptedItemIds: [UUIDS.session.toUpperCase(), UUIDS.item2],
        allReportItemIds: [UUIDS.session, UUIDS.item2],
      },
    ];
    for (const input of invalid) {
      expectCode("CHILD_DISPOSITION_INVALID", () => decodeChildDispositionV1(input));
    }
  });

  it("enforces integer quality policy weights, thresholds, order, and cardinality", () => {
    const decoded = decodeQualityPolicyV1(validQualityPolicy());
    assert.equal(decoded.profiles[0]?.weight, 100);
    assert.ok(Object.isFrozen(decoded.profiles));

    for (const mutate of [
      (input: Record<string, unknown>) => { input.qualityThreshold = -1; },
      (input: Record<string, unknown>) => { input.qualityThreshold = 10_001; },
      (input: Record<string, unknown>) => { input.qualityThreshold = 1.5; },
      (input: Record<string, unknown>) => {
        input.profiles = [{ profileId: "vault-gate", profileVersion: 1, required: true, weight: 0 }];
      },
      (input: Record<string, unknown>) => {
        input.profiles = [{ profileId: "vault-gate", profileVersion: 1, required: true, weight: 1_000_001 }];
      },
      (input: Record<string, unknown>) => {
        input.profiles = Array.from({ length: 65 }, (_, index) => ({
          profileId: `profile-${String(index).padStart(2, "0")}`,
          profileVersion: 1,
          required: false,
          weight: 1,
        }));
      },
      (input: Record<string, unknown>) => {
        input.profiles = [
          { profileId: "z", profileVersion: 1, required: false, weight: 1 },
          { profileId: "a", profileVersion: 1, required: false, weight: 1 },
        ];
      },
    ]) {
      const input = validQualityPolicy();
      mutate(input);
      expectCode("LIFECYCLE_INPUT_INVALID", () => decodeQualityPolicyV1(input));
    }
  });

  it("accepts exact quality boundaries and rejects fractional, duplicate, empty, and nested-unknown profiles", () => {
    for (const [qualityThreshold, weight] of [[0, 1], [10_000, 1_000_000]]) {
      const input = validQualityPolicy();
      input.qualityThreshold = qualityThreshold;
      input.profiles = [{ profileId: "vault-gate", profileVersion: 1, required: true, weight }];
      assert.equal(decodeQualityPolicyV1(input).qualityThreshold, qualityThreshold);
    }
    const full = validQualityPolicy();
    full.profiles = Array.from({ length: 64 }, (_, index) => ({
      profileId: `profile-${String(index).padStart(2, "0")}`,
      profileVersion: 1,
      required: index === 0,
      weight: 1_000_000,
    }));
    assert.equal(decodeQualityPolicyV1(full).profiles.length, 64);

    const versions = validQualityPolicy();
    versions.profiles = [
      { profileId: "same", profileVersion: 1, required: true, weight: 1 },
      { profileId: "same", profileVersion: 2, required: false, weight: 1 },
    ];
    assert.equal(decodeQualityPolicyV1(versions).profiles.length, 2);

    for (const profiles of [
      [],
      [{ profileId: "a", profileVersion: 1.5, required: true, weight: 1 }],
      [{ profileId: "a", profileVersion: 1, required: true, weight: 1.5 }],
      [
        { profileId: "a", profileVersion: 1, required: true, weight: 1 },
        { profileId: "a", profileVersion: 1, required: false, weight: 1 },
      ],
      [
        { profileId: "a", profileVersion: 2, required: true, weight: 1 },
        { profileId: "a", profileVersion: 1, required: false, weight: 1 },
      ],
      [{ profileId: "a", profileVersion: 1, required: true, weight: 1, command: "caller-selected" }],
    ]) {
      const input = validQualityPolicy();
      input.profiles = profiles;
      expectCode("LIFECYCLE_INPUT_INVALID", () => decodeQualityPolicyV1(input));
    }
  });

  it("strictly decodes end requests without accepting validation results or observations", () => {
    const decoded = decodeSessionEndRequestV1(validEndRequest());
    assert.equal(decoded.childEndPolicy, "require-completed");
    assert.ok(Object.isFrozen(decoded));
    assert.ok(Object.isFrozen(decoded.validationProfileIds));

    for (const forbidden of [
      { validationResultId: UUIDS.workflow },
      { validationResultIds: [UUIDS.workflow] },
      { validationObservation: "passed" },
      { rawValidationOutput: "secret output" },
    ]) {
      expectCode("LIFECYCLE_INPUT_INVALID", () => decodeSessionEndRequestV1({
        ...validEndRequest(),
        ...forbidden,
      }));
    }
  });

  it("allows an empty caller profile selection for trusted defaults to populate", () => {
    const request = validEndRequest();
    request.validationProfileIds = [];
    assert.deepEqual(decodeSessionEndRequestV1(request).validationProfileIds, []);
  });

  it("strictly decodes every external semantic command variant", () => {
    for (const [commandType, input] of semanticCommandCases()) {
      const decoded = decodeLifecycleSemanticCommandDraft(input);
      assert.equal(decoded.commandType, commandType);
      assert.equal(decoded.idempotencyKey, DETERMINISTIC_IDEMPOTENCY_KEY);
      assert.ok(Object.isFrozen(decoded));
      expectCode("LIFECYCLE_INPUT_INVALID", () => decodeLifecycleSemanticCommandDraft({
        ...input,
        callerSelectedAudience: "primary",
      }));
    }
  });

  it("accepts exact bounded opaque semantic idempotency keys", () => {
    const start = semanticCommandCases().find(([type]) => type === "root-start")![1];
    for (const idempotencyKey of ["", "x".repeat(513), 42]) {
      expectCode("LIFECYCLE_INPUT_INVALID", () => decodeLifecycleSemanticCommandDraft({
        ...start,
        idempotencyKey,
      }));
    }

    const accessor = { ...start };
    Object.defineProperty(accessor, "idempotencyKey", {
      enumerable: true,
      get: () => DETERMINISTIC_IDEMPOTENCY_KEY,
    });
    expectCode("LIFECYCLE_INPUT_INVALID", () => decodeLifecycleSemanticCommandDraft(accessor));
  });

  it("enforces canonical semantic project, vault, and workspace identities", () => {
    const start = semanticCommandCases().find(([type]) => type === "root-start")![1];
    const decoded = decodeLifecycleSemanticCommandDraft(start);
    assert.equal(decoded.expectedProjectId, UUIDS.item1);
    assert.equal(decoded.expectedVaultId, UUIDS.item2);
    assert.equal(decoded.expectedWorkspaceId, "a".repeat(64));

    for (const [field, value] of [
      ["expectedProjectId", "not-a-project-id"],
      ["expectedProjectId", UUIDS.session.toUpperCase()],
      ["expectedVaultId", "not-a-vault-id"],
      ["expectedVaultId", UUIDS.parent.toUpperCase()],
      ["expectedWorkspaceId", "not-a-workspace-id"],
      ["expectedWorkspaceId", "A".repeat(64)],
    ] as const) {
      expectCode("LIFECYCLE_INPUT_INVALID", () => decodeLifecycleSemanticCommandDraft({
        ...start,
        [field]: value,
      }));
    }
  });

  it("recursively rejects nested command extras and malformed frame identity, position, or time", () => {
    const fork = semanticCommandCases().find(([type]) => type === "fork-child")?.[1];
    assert.ok(fork);
    expectCode("LIFECYCLE_INPUT_INVALID", () => decodeLifecycleSemanticCommandDraft({
      ...fork,
      assignment: { ...(fork.assignment as object), authorization: "caller-selected" },
    }));

    const evidence = semanticCommandCases().find(([type]) => type === "record-evidence-batch")?.[1];
    assert.ok(evidence);
    for (const frame of [
      { ...((evidence.frames as Array<object>)[0] ?? {}), unknown: true },
      { ...((evidence.frames as Array<object>)[0] ?? {}), frameId: UUIDS.session.toUpperCase() },
      { ...((evidence.frames as Array<object>)[0] ?? {}), ordinal: "01" },
      { ...((evidence.frames as Array<object>)[0] ?? {}), observedAt: "2026-07-14T10:11:12Z" },
    ]) {
      expectCode("LIFECYCLE_INPUT_INVALID", () => decodeLifecycleSemanticCommandDraft({
        ...evidence,
        frames: [frame],
      }));
    }
  });

  it("keeps raw drafts separate from trusted audience and authorization", () => {
    const start = decodeLifecycleSemanticCommandDraft({
      ...validCommandBase(),
      commandType: "root-start",
      continuityKey: "thread:stable-key",
      resumePolicy: "new",
    });
    assert.equal(start.commandType, "root-start");
    assert.ok(Object.isFrozen(start));

    for (const extra of [
      { authorization: { kind: "initial-authority" } },
      { audience: { presentingActorRole: "primary" } },
      { handle: "pmcap1.private" },
      { resumeToken: "pmcap1.private" },
      { proofMac: "private" },
      { approval: "private" },
      { environment: { SECRET: "private" } },
    ]) {
      expectCode("LIFECYCLE_INPUT_INVALID", () => decodeLifecycleSemanticCommandDraft({
        ...validCommandBase(),
        commandType: "root-start",
        continuityKey: "thread:stable-key",
        resumePolicy: "new",
        ...extra,
      }));
    }

    for (const commandType of [
      "internal-validation-result",
      "internal-workflow-phase",
      "workflow-claim",
      "outbox-materialize",
      "renew-lease",
      "protected-read",
    ]) {
      expectCode("LIFECYCLE_INPUT_INVALID", () => decodeLifecycleSemanticCommandDraft({
        ...validCommandBase(),
        commandType,
      }));
    }
  });

  it("binds an internal validation result to one exact durable attempt plan", () => {
    const command = validInternalValidationResultCommand();
    assert.ok(Object.isFrozen(command.attemptPlan));
    assert.doesNotThrow(() => assertInternalValidationResultBinding(command));

    const otherUuid = indexedUuid(999);
    const otherWorkflowId = indexedUuid(998) as WorkflowId;
    const mismatches: Array<readonly [string, InternalValidationResultCommand]> = [
      ["commandId", { ...command, commandId: otherUuid }],
      ["idempotencyKey", { ...command, idempotencyKey: otherUuid }],
      ["idempotencyKey empty", {
        ...command,
        idempotencyKey: "",
        attemptPlan: { ...command.attemptPlan, resultIdempotencyKey: "" },
      }],
      ["idempotencyKey bound", {
        ...command,
        idempotencyKey: "x".repeat(513),
        attemptPlan: { ...command.attemptPlan, resultIdempotencyKey: "x".repeat(513) },
      }],
      ["expectedProjectId", { ...command, expectedProjectId: otherUuid as ProjectId }],
      ["expectedVaultId", { ...command, expectedVaultId: otherUuid as VaultId }],
      ["expectedWorkspaceId", { ...command, expectedWorkspaceId: "9".repeat(64) as WorkspaceId }],
      ["workflowId", { ...command, workflowId: otherWorkflowId }],
      ["workflowGeneration", { ...command, workflowGeneration: 2 }],
      ["command plannedWorkId format", { ...command, plannedWorkId: "not-a-hash" }],
      ["attempt plan plannedWorkId format", {
        ...command,
        attemptPlan: { ...command.attemptPlan, plannedWorkId: "not-a-hash" },
      }],
      ["plannedWorkId mismatch", {
        ...command,
        plannedWorkId: "1".repeat(64),
      }],
      ["claim.workflowId", { ...command, claim: { ...command.claim, workflowId: otherWorkflowId } }],
      ["claim.workflowGeneration", {
        ...command,
        claim: { ...command.claim, workflowGeneration: 2 },
      }],
      ["resultId", { ...command, result: { ...command.result, resultId: otherUuid as ValidationResultId } }],
      ["projectId", { ...command, result: { ...command.result, projectId: otherUuid as never } }],
      ["vaultId", { ...command, result: { ...command.result, vaultId: otherUuid as never } }],
      ["storeId", { ...command, result: { ...command.result, storeId: otherUuid as never } }],
      ["workspaceId", {
        ...command,
        result: { ...command.result, workspaceId: "8".repeat(64) as never },
      }],
      ["sessionId", { ...command, result: { ...command.result, sessionId: otherUuid as SessionId } }],
      ["result.workflowId", {
        ...command,
        result: { ...command.result, workflowId: otherWorkflowId },
      }],
      ["result.workflowGeneration", {
        ...command,
        result: { ...command.result, workflowGeneration: 2 },
      }],
      ["finalCheckpointId", {
        ...command,
        result: { ...command.result, finalCheckpointId: otherUuid as CheckpointId },
      }],
      ["finalCheckpointFingerprint", {
        ...command,
        result: { ...command.result, finalCheckpointFingerprint: "7".repeat(64) },
      }],
      ["profileId", { ...command, result: { ...command.result, profileId: "other-profile" } }],
      ["profileVersion", { ...command, result: { ...command.result, profileVersion: 2 } }],
      ["profileConfigurationHash", {
        ...command,
        result: { ...command.result, profileConfigurationHash: "6".repeat(64) },
      }],
      ["runId", { ...command, result: { ...command.result, runId: otherUuid } }],
      ["attemptPlanVersion", {
        ...command,
        attemptPlan: { ...command.attemptPlan, attemptPlanVersion: 2 as 1 },
      }],
      ["attemptPlan exact keys", {
        ...command,
        attemptPlan: { ...command.attemptPlan, rawOutput: "must not enter the plan" } as ValidationAttemptPlanIdentityV1,
      }],
    ];
    for (const [field, mismatch] of mismatches) {
      assert.throws(
        () => assertInternalValidationResultBinding(mismatch),
        (error: unknown) => error instanceof LifecycleError
          && error.code === "SESSION_VALIDATION_RESULT_INVALID",
        field,
      );
    }
  });

  it("strictly decodes, freezes, and detaches trusted validation results", () => {
    const input = validValidationResultInput();
    input.artifactReferences = ["artifacts/validation-result.json"];
    const decoded = decodeValidationResultV1(input);
    assert.ok(Object.isFrozen(decoded));
    assert.ok(Object.isFrozen(decoded.sourceStateAtStart));
    assert.ok(Object.isFrozen(decoded.sourceStateAtCompletion));
    assert.ok(Object.isFrozen(decoded.outputFingerprint));
    assert.ok(Object.isFrozen(decoded.artifactReferences));
    assert.notEqual(decoded.sourceStateAtStart, input.sourceStateAtStart);
    assert.notEqual(decoded.outputFingerprint, input.outputFingerprint);
    assert.notEqual(decoded.artifactReferences, input.artifactReferences);

    input.summary = "mutated after decode";
    (input.sourceStateAtStart as Record<string, unknown>).workspaceId = "9".repeat(64);
    (input.outputFingerprint as Record<string, unknown>).fingerprint = "9".repeat(64);
    (input.artifactReferences as string[])[0] = "mutated/private-output.txt";
    assert.equal(decoded.summary, "Trusted validation passed");
    assert.equal(decoded.sourceStateAtStart.workspaceId, "a".repeat(64));
    assert.equal(decoded.outputFingerprint.fingerprint, "f".repeat(64));
    assert.deepEqual(decoded.artifactReferences, ["artifacts/validation-result.json"]);
  });

  it("rejects malformed, nonexact, or secret-bearing validation result data", () => {
    const invalid: Array<readonly [string, Record<string, unknown>]> = [];
    for (const key of [
      "rawOutput",
      "stdout",
      "stderr",
      "environment",
      "command",
      "evidence",
      "bearerToken",
      "proofMac",
      "approval",
    ]) {
      invalid.push([`result.${key}`, { ...validValidationResultInput(), [key]: "private" }]);
    }
    invalid.push(
      ["resultId", { ...validValidationResultInput(), resultId: UUIDS.report.toUpperCase() }],
      ["projectId", { ...validValidationResultInput(), projectId: UUIDS.session.toUpperCase() }],
      ["vaultId", { ...validValidationResultInput(), vaultId: UUIDS.session.toUpperCase() }],
      ["storeId", { ...validValidationResultInput(), storeId: UUIDS.session.toUpperCase() }],
      ["workspaceId", { ...validValidationResultInput(), workspaceId: "not-a-workspace" }],
      ["sessionId", { ...validValidationResultInput(), sessionId: UUIDS.session.toUpperCase() }],
      ["workflowId", { ...validValidationResultInput(), workflowId: UUIDS.session.toUpperCase() }],
      ["workflowGeneration", { ...validValidationResultInput(), workflowGeneration: 1.5 }],
      ["finalCheckpointId", {
        ...validValidationResultInput(),
        finalCheckpointId: UUIDS.checkpoint.toUpperCase(),
      }],
      ["finalCheckpointFingerprint", {
        ...validValidationResultInput(),
        finalCheckpointFingerprint: "not-a-fingerprint",
      }],
      ["profileId", { ...validValidationResultInput(), profileId: "x".repeat(257) }],
      ["profileVersion", { ...validValidationResultInput(), profileVersion: 1.5 }],
      ["profileConfigurationHash", {
        ...validValidationResultInput(),
        profileConfigurationHash: "not-a-hash",
      }],
      ["runId", { ...validValidationResultInput(), runId: UUIDS.parent.toUpperCase() }],
      ["startedAt", { ...validValidationResultInput(), startedAt: "2026-07-14T10:11:12Z" }],
      ["completed before start", {
        ...validValidationResultInput(),
        completedAt: "2026-07-14T10:11:11.123Z",
      }],
      ["status", { ...validValidationResultInput(), status: "maybe" }],
      ["exitClassification", { ...validValidationResultInput(), exitClassification: "unknown" }],
      ["summary", { ...validValidationResultInput(), summary: "x".repeat(4_001) }],
      ["fresh", { ...validValidationResultInput(), fresh: "true" }],
      ["sourceState extra", {
        ...validValidationResultInput(),
        sourceStateAtStart: {
          ...(validValidationResultInput().sourceStateAtStart as object),
          environment: "private",
        },
      }],
      ["sourceState workspace mismatch", {
        ...validValidationResultInput(),
        sourceStateAtCompletion: {
          ...(validValidationResultInput().sourceStateAtCompletion as object),
          workspaceId: "9".repeat(64),
        },
      }],
      ["output fingerprint extra", {
        ...validValidationResultInput(),
        outputFingerprint: {
          ...(validValidationResultInput().outputFingerprint as object),
          stdout: "private",
        },
      }],
      ["output fingerprint schema", {
        ...validValidationResultInput(),
        outputFingerprint: {
          ...(validValidationResultInput().outputFingerprint as object),
          fingerprintSchemaVersion: 2,
        },
      }],
      ["output fingerprint domain", {
        ...validValidationResultInput(),
        outputFingerprint: {
          ...(validValidationResultInput().outputFingerprint as object),
          fingerprintDomain: "caller-selected",
        },
      }],
      ["artifact reference length", {
        ...validValidationResultInput(),
        artifactReferences: ["x".repeat(513)],
      }],
      ["artifact reference type", {
        ...validValidationResultInput(),
        artifactReferences: [{ evidence: "private" }],
      }],
    );

    const accessorResult = validValidationResultInput();
    Object.defineProperty(accessorResult, "summary", {
      enumerable: true,
      get: () => "accessor summary",
    });
    invalid.push(["result accessor", accessorResult]);
    const accessorSource = validValidationResultInput();
    const sourceState = { ...(accessorSource.sourceStateAtStart as object) };
    Object.defineProperty(sourceState, "workspaceId", {
      enumerable: true,
      get: () => "a".repeat(64),
    });
    accessorSource.sourceStateAtStart = sourceState;
    invalid.push(["sourceState accessor", accessorSource]);
    const accessorOutput = validValidationResultInput();
    const output = { ...(accessorOutput.outputFingerprint as object) };
    Object.defineProperty(output, "fingerprint", {
      enumerable: true,
      get: () => "f".repeat(64),
    });
    accessorOutput.outputFingerprint = output;
    invalid.push(["output accessor", accessorOutput]);
    const accessorArtifacts = validValidationResultInput();
    const references = ["artifacts/result.json"];
    Object.defineProperty(references, "0", {
      enumerable: true,
      get: () => "artifacts/result.json",
    });
    accessorArtifacts.artifactReferences = references;
    invalid.push(["artifact array accessor", accessorArtifacts]);

    for (const [field, candidate] of invalid) {
      assert.throws(
        () => decodeValidationResultV1(candidate),
        (error: unknown) => error instanceof LifecycleError
          && error.code === "SESSION_VALIDATION_RESULT_INVALID",
        field,
      );
    }
  });

  it("exact-checks internal validation commands and volatile workflow claims", () => {
    const command = validInternalValidationResultCommand();
    assert.equal(command.idempotencyKey, DETERMINISTIC_IDEMPOTENCY_KEY);
    assert.equal(command.claim.claimToken, CANONICAL_CLAIM_TOKEN);
    for (const key of ["rawOutput", "environment", "proofMac", "approval"]) {
      const candidate = { ...command, [key]: "private" } as unknown as InternalValidationResultCommand;
      expectCode("SESSION_VALIDATION_RESULT_INVALID", () =>
        assertInternalValidationResultBinding(candidate));
    }
    for (const key of ["stdout", "command", "bearerToken", "evidence"]) {
      const candidate = {
        ...command,
        claim: { ...command.claim, [key]: "private" },
      } as unknown as InternalValidationResultCommand;
      expectCode("SESSION_VALIDATION_RESULT_INVALID", () =>
        assertInternalValidationResultBinding(candidate));
    }
    for (const claimToken of ["", "-1", "01", "9223372036854775808", 1, 1n]) {
      expectCode("SESSION_VALIDATION_RESULT_INVALID", () =>
        assertInternalValidationResultBinding({
          ...command,
          claim: { ...command.claim, claimToken } as unknown as typeof command.claim,
        }));
    }

    const accessorCommand = { ...command };
    Object.defineProperty(accessorCommand, "plannedWorkId", {
      enumerable: true,
      get: () => "0".repeat(64),
    });
    expectCode("SESSION_VALIDATION_RESULT_INVALID", () =>
      assertInternalValidationResultBinding(accessorCommand));

    const accessorClaim = { ...command.claim };
    Object.defineProperty(accessorClaim, "claimToken", {
      enumerable: true,
      get: () => CANONICAL_CLAIM_TOKEN,
    });
    expectCode("SESSION_VALIDATION_RESULT_INVALID", () =>
      assertInternalValidationResultBinding({ ...command, claim: accessorClaim }));
  });

  it("enforces semantic authorization shapes and command-specific authority", () => {
    const start = decodeLifecycleSemanticCommandDraft({
      ...validCommandBase(),
      commandType: "root-start",
      continuityKey: "thread:stable-key",
      resumePolicy: "new",
    });
    assert.doesNotThrow(() => assertSemanticCommandAuthorization(start, {
      kind: "initial-authority",
      authoritySessionId: null,
      targetSessionId: null,
      proof: null,
      approval: null,
      childBindingGrant: null,
    }));
    expectCode("SESSION_CAPABILITY_INVALID", () => assertSemanticCommandAuthorization(start, {
      kind: "protected",
      authoritySessionId: UUIDS.session as SessionId,
      targetSessionId: UUIDS.session as SessionId,
      proof: null,
      approval: null,
      childBindingGrant: null,
    }));
  });

  it("rejects nonexact or malformed semantic authorization records", () => {
    const commands = new Map(semanticCommandCases().map(([type, input]) => [
      type,
      decodeLifecycleSemanticCommandDraft(input),
    ]));
    const start = commands.get("root-start")!;
    const resume = commands.get("root-resume")!;
    const recovery = commands.get("root-recovery")!;
    const directFork = decodeLifecycleSemanticCommandDraft({
      ...(semanticCommandCases().find(([type]) => type === "fork-child")?.[1] ?? {}),
      directAccessRequested: true,
    });
    const proof: CapabilityProofV1 = {
      proofVersion: 1,
      target: "semantic-command",
      proofNonce: UUIDS.item2,
      proofFingerprint: "a".repeat(64),
    };
    const recoveryApproval: RedactedLifecycleApproval = {
      approvalVersion: 1,
      approvalId: UUIDS.item1 as ApprovalId,
      action: "recover-root-authority",
      approvalFingerprint: "b".repeat(64),
    };
    const grant: RedactedChildBindingGrant = {
      grantVersion: 1,
      grantId: UUIDS.item3,
      targetClientInstanceId: UUIDS.client,
      grantFingerprint: "c".repeat(64),
    };
    const initial = {
      kind: "initial-authority" as const,
      authoritySessionId: null,
      targetSessionId: null,
      proof: null,
      approval: null,
      childBindingGrant: null,
    };
    const protectedProof = {
      kind: "protected" as const,
      authoritySessionId: UUIDS.session as SessionId,
      targetSessionId: UUIDS.session as SessionId,
      proof,
      approval: null,
      childBindingGrant: null,
    };
    const protectedApproval = {
      ...protectedProof,
      proof: null,
      approval: recoveryApproval,
    };
    const protectedGrant = {
      ...protectedProof,
      childBindingGrant: grant,
    };

    const accessorAuthorization = { ...protectedProof };
    Object.defineProperty(accessorAuthorization, "targetSessionId", {
      enumerable: true,
      get: () => UUIDS.session,
    });
    const accessorProof = { ...proof };
    Object.defineProperty(accessorProof, "proofNonce", {
      enumerable: true,
      get: () => UUIDS.item2,
    });
    const accessorApproval = { ...recoveryApproval };
    Object.defineProperty(accessorApproval, "approvalId", {
      enumerable: true,
      get: () => UUIDS.item1,
    });
    const accessorGrant = { ...grant };
    Object.defineProperty(accessorGrant, "grantId", {
      enumerable: true,
      get: () => UUIDS.item3,
    });

    const invalid: Array<readonly [string, LifecycleSemanticCommandDraft, SemanticCommandAuthorization]> = [
      ["initial extra", start, { ...initial, rawOutput: "private" } as unknown as SemanticCommandAuthorization],
      ["protected extra", resume, { ...protectedProof, proofMac: "private" } as unknown as SemanticCommandAuthorization],
      ["authorization kind", resume, { ...protectedProof, kind: "bearer" } as unknown as SemanticCommandAuthorization],
      ["authority id", resume, {
        ...protectedProof,
        authoritySessionId: UUIDS.session.toUpperCase() as SessionId,
      }],
      ["target id", resume, {
        ...protectedProof,
        targetSessionId: "not-a-session" as SessionId,
      }],
      ["authorization accessor", resume, accessorAuthorization],
      ["proof extra", resume, {
        ...protectedProof,
        proof: { ...proof, bearerToken: "private" } as unknown as CapabilityProofV1,
      }],
      ["proof version", resume, {
        ...protectedProof,
        proof: { ...proof, proofVersion: 2 } as unknown as CapabilityProofV1,
      }],
      ["proof nonce", resume, { ...protectedProof, proof: { ...proof, proofNonce: "not-a-uuid" } }],
      ["proof fingerprint", resume, { ...protectedProof, proof: { ...proof, proofFingerprint: "short" } }],
      ["proof accessor", resume, { ...protectedProof, proof: accessorProof }],
      ["approval extra", recovery, {
        ...protectedApproval,
        approval: { ...recoveryApproval, approvalToken: "private" } as unknown as RedactedLifecycleApproval,
      }],
      ["approval version", recovery, {
        ...protectedApproval,
        approval: { ...recoveryApproval, approvalVersion: 2 } as unknown as RedactedLifecycleApproval,
      }],
      ["approval id", recovery, {
        ...protectedApproval,
        approval: { ...recoveryApproval, approvalId: "not-a-uuid" as ApprovalId },
      }],
      ["approval fingerprint", recovery, {
        ...protectedApproval,
        approval: { ...recoveryApproval, approvalFingerprint: "short" },
      }],
      ["approval accessor", recovery, { ...protectedApproval, approval: accessorApproval }],
      ["grant extra", directFork, {
        ...protectedGrant,
        childBindingGrant: { ...grant, childHandle: "private" } as unknown as RedactedChildBindingGrant,
      }],
      ["grant version", directFork, {
        ...protectedGrant,
        childBindingGrant: { ...grant, grantVersion: 2 } as unknown as RedactedChildBindingGrant,
      }],
      ["grant id", directFork, {
        ...protectedGrant,
        childBindingGrant: { ...grant, grantId: "not-a-uuid" },
      }],
      ["grant client", directFork, {
        ...protectedGrant,
        childBindingGrant: { ...grant, targetClientInstanceId: "x".repeat(257) },
      }],
      ["grant fingerprint", directFork, {
        ...protectedGrant,
        childBindingGrant: { ...grant, grantFingerprint: "short" },
      }],
      ["grant accessor", directFork, { ...protectedGrant, childBindingGrant: accessorGrant }],
    ];
    for (const [field, command, authorization] of invalid) {
      expectCode("SESSION_CAPABILITY_INVALID", () =>
        assertSemanticCommandAuthorization(command, authorization));
    }
  });

  it("binds semantic authorization sessions to every command target", () => {
    const commands = new Map(semanticCommandCases().map(([type, input]) => [
      type,
      decodeLifecycleSemanticCommandDraft(input),
    ]));
    const proof: CapabilityProofV1 = {
      proofVersion: 1,
      target: "semantic-command",
      proofNonce: UUIDS.item2,
      proofFingerprint: "a".repeat(64),
    };
    const recoveryApproval: RedactedLifecycleApproval = {
      approvalVersion: 1,
      approvalId: UUIDS.item1 as ApprovalId,
      action: "recover-root-authority",
      approvalFingerprint: "b".repeat(64),
    };
    const abandonmentApproval: RedactedLifecycleApproval = {
      ...recoveryApproval,
      action: "abandon-root",
    };
    const expected = new Map<string, readonly [SessionId | null, SessionId]>([
      ["root-resume", [UUIDS.session as SessionId, UUIDS.session as SessionId]],
      ["root-recovery", [UUIDS.session as SessionId, UUIDS.session as SessionId]],
      ["root-suspend", [UUIDS.session as SessionId, UUIDS.session as SessionId]],
      ["fork-child", [UUIDS.session as SessionId, UUIDS.session as SessionId]],
      ["amend-child-assignment", [UUIDS.parent as SessionId, UUIDS.session as SessionId]],
      ["record-checkpoint", [UUIDS.session as SessionId, UUIDS.session as SessionId]],
      ["record-evidence-batch", [null, UUIDS.session as SessionId]],
      ["record-child-report", [UUIDS.session as SessionId, UUIDS.session as SessionId]],
      ["disposition-child-report", [UUIDS.parent as SessionId, UUIDS.session as SessionId]],
      ["propose-child-completion", [UUIDS.session as SessionId, UUIDS.session as SessionId]],
      ["complete-child-session", [UUIDS.parent as SessionId, UUIDS.session as SessionId]],
      ["suspend-child-session", [UUIDS.parent as SessionId, UUIDS.session as SessionId]],
      ["create-child-transfer", [UUIDS.parent as SessionId, UUIDS.session as SessionId]],
      ["claim-child-transfer", [UUIDS.parent as SessionId, UUIDS.parent as SessionId]],
      ["request-session-end", [UUIDS.session as SessionId, UUIDS.session as SessionId]],
      ["amend-session-end", [UUIDS.session as SessionId, UUIDS.session as SessionId]],
      ["cancel-session-end", [UUIDS.session as SessionId, UUIDS.session as SessionId]],
      ["abandon-session", [UUIDS.session as SessionId, UUIDS.session as SessionId]],
    ]);
    assert.equal(expected.size, commands.size - 1);

    for (const [commandType, [exactAuthority, targetSessionId]] of expected) {
      const command = commands.get(commandType)!;
      const authoritySessionId = exactAuthority ?? UUIDS.parent as SessionId;
      const authorization: SemanticCommandAuthorization = {
        kind: "protected",
        authoritySessionId,
        targetSessionId,
        proof: commandType === "root-recovery" ? null : proof,
        approval: commandType === "root-recovery"
          ? recoveryApproval
          : commandType === "abandon-session" ? abandonmentApproval : null,
        childBindingGrant: null,
      };
      assert.doesNotThrow(
        () => assertSemanticCommandAuthorization(command, authorization),
        commandType,
      );
      expectCode("SESSION_CAPABILITY_INVALID", () => assertSemanticCommandAuthorization(command, {
        ...authorization,
        targetSessionId: UUIDS.report as SessionId,
      }));
      if (exactAuthority !== null) {
        expectCode("SESSION_CAPABILITY_INVALID", () => assertSemanticCommandAuthorization(command, {
          ...authorization,
          authoritySessionId: UUIDS.report as SessionId,
        }));
      }
    }

    const latestSafe = decodeLifecycleSemanticCommandDraft({
      ...(semanticCommandCases().find(([type]) => type === "root-resume")?.[1] ?? {}),
      sessionId: null,
      resumePolicy: "latest-safe",
    });
    expectCode("SESSION_CAPABILITY_INVALID", () => assertSemanticCommandAuthorization(latestSafe, {
      kind: "protected",
      authoritySessionId: UUIDS.parent as SessionId,
      targetSessionId: UUIDS.session as SessionId,
      proof,
      approval: null,
      childBindingGrant: null,
    }));
  });

  it("allows a fork grant only when direct child access was requested", () => {
    const fork = decodeLifecycleSemanticCommandDraft({
      ...validCommandBase(),
      commandType: "fork-child",
      parentSessionId: UUIDS.session,
      expectedStreamVersion: "1",
      assignment: {
        assignmentId: UUIDS.item1,
        summary: "Inspect lifecycle boundaries",
        scope: "src/orchestrator/lifecycle",
      },
      directAccessRequested: false,
    });
    const proof: CapabilityProofV1 = {
      proofVersion: 1,
      target: "semantic-command",
      proofNonce: UUIDS.item2,
      proofFingerprint: "a".repeat(64),
    };
    const grant: RedactedChildBindingGrant = {
      grantVersion: 1,
      grantId: UUIDS.item3,
      targetClientInstanceId: UUIDS.client,
      grantFingerprint: "b".repeat(64),
    };
    expectCode("SESSION_CAPABILITY_INVALID", () => assertSemanticCommandAuthorization(fork, {
      kind: "protected",
      authoritySessionId: UUIDS.session as SessionId,
      targetSessionId: UUIDS.session as SessionId,
      proof,
      approval: null,
      childBindingGrant: grant,
    }));
    expectCode("SESSION_CAPABILITY_INVALID", () => assertSemanticCommandAuthorization(fork, {
      kind: "protected",
      authoritySessionId: UUIDS.session as SessionId,
      targetSessionId: UUIDS.session as SessionId,
      proof: { ...proof, target: "bounded-operation" },
      approval: null,
      childBindingGrant: null,
    }));
  });

  it("does not interchange recovery and abandonment approval actions", () => {
    const recovery = decodeLifecycleSemanticCommandDraft({
      ...validCommandBase(),
      commandType: "root-recovery",
      sessionId: UUIDS.session,
      expectedOwnerGeneration: "1",
      preTransitionCheckpointId: UUIDS.checkpoint,
      reasonCode: "capability-lost",
    });
    const wrongApproval: RedactedLifecycleApproval = {
      approvalVersion: 1,
      approvalId: UUIDS.item1 as never,
      action: "abandon-root",
      approvalFingerprint: "c".repeat(64),
    };
    expectCode("SESSION_CAPABILITY_INVALID", () => assertSemanticCommandAuthorization(recovery, {
      kind: "protected",
      authoritySessionId: UUIDS.session as SessionId,
      targetSessionId: UUIDS.session as SessionId,
      proof: null,
      approval: wrongApproval,
      childBindingGrant: null,
    }));
  });

  it("enforces the complete semantic authorization matrix", () => {
    const commands = new Map(semanticCommandCases().map(([type, input]) => [
      type,
      decodeLifecycleSemanticCommandDraft(input),
    ]));
    const proof: CapabilityProofV1 = {
      proofVersion: 1,
      target: "semantic-command",
      proofNonce: UUIDS.item2,
      proofFingerprint: "a".repeat(64),
    };
    const recoveryApproval: RedactedLifecycleApproval = {
      approvalVersion: 1,
      approvalId: UUIDS.item1 as ApprovalId,
      action: "recover-root-authority",
      approvalFingerprint: "b".repeat(64),
    };
    const abandonmentApproval: RedactedLifecycleApproval = {
      ...recoveryApproval,
      action: "abandon-root",
    };
    const protectedBase = {
      kind: "protected" as const,
      authoritySessionId: UUIDS.session as SessionId,
      targetSessionId: UUIDS.session as SessionId,
    };

    const resume = commands.get("root-resume")!;
    assert.doesNotThrow(() => assertSemanticCommandAuthorization(resume, {
      ...protectedBase,
      proof,
      approval: null,
      childBindingGrant: null,
    }));
    expectCode("SESSION_CAPABILITY_INVALID", () => assertSemanticCommandAuthorization(resume, {
      ...protectedBase,
      proof: null,
      approval: null,
      childBindingGrant: null,
    }));
    expectCode("SESSION_CAPABILITY_INVALID", () => assertSemanticCommandAuthorization(resume, {
      ...protectedBase,
      proof,
      approval: recoveryApproval,
      childBindingGrant: null,
    }));
    expectCode("SESSION_CAPABILITY_INVALID", () => assertSemanticCommandAuthorization(resume, {
      kind: "initial-authority",
      authoritySessionId: null,
      targetSessionId: null,
      proof: null,
      approval: null,
      childBindingGrant: null,
    }));

    const recovery = commands.get("root-recovery")!;
    assert.doesNotThrow(() => assertSemanticCommandAuthorization(recovery, {
      ...protectedBase,
      proof: null,
      approval: recoveryApproval,
      childBindingGrant: null,
    }));
    const abandon = commands.get("abandon-session")!;
    assert.doesNotThrow(() => assertSemanticCommandAuthorization(abandon, {
      ...protectedBase,
      proof,
      approval: abandonmentApproval,
      childBindingGrant: null,
    }));
    for (const missing of [
      { proof: null, approval: abandonmentApproval },
      { proof, approval: null },
    ]) {
      expectCode("SESSION_CAPABILITY_INVALID", () => assertSemanticCommandAuthorization(abandon, {
        ...protectedBase,
        ...missing,
        childBindingGrant: null,
      }));
    }

    const directFork = decodeLifecycleSemanticCommandDraft({
      ...(semanticCommandCases().find(([type]) => type === "fork-child")?.[1] ?? {}),
      directAccessRequested: true,
    });
    const grant: RedactedChildBindingGrant = {
      grantVersion: 1,
      grantId: UUIDS.item3,
      targetClientInstanceId: UUIDS.client,
      grantFingerprint: "c".repeat(64),
    };
    assert.doesNotThrow(() => assertSemanticCommandAuthorization(directFork, {
      ...protectedBase,
      proof,
      approval: null,
      childBindingGrant: grant,
    }));
  });

  it("freezes the exhaustive Version 1 event discriminator", () => {
    const expected = [
      "SessionStarted",
      "SessionOwnerTransferred",
      "SessionOwnershipRecovered",
      "SessionSuspendRequested",
      "SessionSuspended",
      "SessionResumed",
      "SessionCheckpointRecorded",
      "EvidenceCoverageRecorded",
      "SessionForked",
      "ChildAssignmentAmended",
      "ChildWorkReported",
      "ChildWorkDispositioned",
      "ChildCompletionProposed",
      "ChildSessionCompleted",
      "ChildSessionSuspended",
      "ChildWorkTransferCreated",
      "ChildWorkTransferClaimed",
      "SessionEndRequested",
      "SessionEndAmended",
      "SessionValidationResultRecorded",
      "SessionEndVerificationPassed",
      "SessionEndVerificationFailed",
      "SessionEndVerificationInvalidated",
      "SessionEndCancelled",
      "SessionAbandoned",
      "SessionEnded",
    ];
    assert.deepEqual(LIFECYCLE_EVENT_TYPES, expected);
    assert.ok(Object.isFrozen(LIFECYCLE_EVENT_TYPES));
    assert.equal(null as LifecycleEventV1 | null, null);
  });

  it("strictly decodes every typed lifecycle event as JSON-safe data", () => {
    const cases = lifecycleEventPayloadCases();
    assert.equal(cases.length, LIFECYCLE_EVENT_TYPES.length);
    for (const [eventType, payload] of cases) {
      const decoded = decodeLifecycleEventV1(validLifecycleEvent(eventType, payload));
      assert.equal(decoded.eventType, eventType);
      assert.equal(decoded.idempotencyKey, DETERMINISTIC_IDEMPOTENCY_KEY);
      assert.equal(typeof decoded.streamVersion, "string");
      assert.equal(typeof decoded.globalPosition, "string");
      assert.ok(Object.isFrozen(decoded));
      assert.ok(Object.isFrozen(decoded.payload));
      const serialized = JSON.stringify(decoded);
      assert.equal(JSON.parse(serialized).eventType, eventType);
      assert.doesNotMatch(serialized, /rawOutput|stdout|stderr|environment|bearer|proofMac|approvalToken/i);
    }
  });

  it("rejects wrong, noncanonical, or secret-bearing lifecycle event data", () => {
    const startedPayload = lifecycleEventPayloadCases()[0]![1];
    for (const [field, mutate] of [
      ["event identity", (event: Record<string, unknown>) => { event.eventId = UUIDS.session.toUpperCase(); }],
      ["project identity", (event: Record<string, unknown>) => { event.projectId = UUIDS.session.toUpperCase(); }],
      ["workspace identity", (event: Record<string, unknown>) => { event.workspaceId = "not-a-hash"; }],
      ["stream version", (event: Record<string, unknown>) => { event.streamVersion = "01"; }],
      ["global position", (event: Record<string, unknown>) => { event.globalPosition = 1n; }],
      ["timestamp", (event: Record<string, unknown>) => { event.occurredAt = "2026-07-14T10:11:12Z"; }],
      ["authority commitment", (event: Record<string, unknown>) => { event.authorityCommitment = "not-a-hash"; }],
      ["empty idempotency key", (event: Record<string, unknown>) => { event.idempotencyKey = ""; }],
      ["oversized idempotency key", (event: Record<string, unknown>) => { event.idempotencyKey = "x".repeat(513); }],
      ["non-string idempotency key", (event: Record<string, unknown>) => { event.idempotencyKey = 42; }],
      ["wrong discriminator payload", (event: Record<string, unknown>) => {
        event.eventType = "SessionResumed";
      }],
    ] as const) {
      const event = validLifecycleEvent("SessionStarted", { ...startedPayload });
      mutate(event);
      assert.throws(() => decodeLifecycleEventV1(event), { message: /LIFECYCLE_INPUT_INVALID/ }, field);
    }

    for (const key of [
      "rawOutput",
      "stdout",
      "stderr",
      "environment",
      "command",
      "evidence",
      "bearerToken",
      "proofMac",
      "approvalToken",
    ]) {
      const event = validLifecycleEvent("SessionStarted", { ...startedPayload, [key]: "private" });
      assert.throws(() => decodeLifecycleEventV1(event), { message: /LIFECYCLE_INPUT_INVALID/ }, key);
    }

    const accessorPayload = { ...startedPayload };
    Object.defineProperty(accessorPayload, "authorityCommitment", {
      enumerable: true,
      get: () => "a".repeat(64),
    });
    assert.throws(
      () => decodeLifecycleEventV1(validLifecycleEvent("SessionStarted", accessorPayload)),
      { message: /LIFECYCLE_INPUT_INVALID/ },
    );

    const accessorEvent = validLifecycleEvent("SessionStarted", { ...startedPayload });
    Object.defineProperty(accessorEvent, "idempotencyKey", {
      enumerable: true,
      get: () => DETERMINISTIC_IDEMPOTENCY_KEY,
    });
    assert.throws(() => decodeLifecycleEventV1(accessorEvent), { message: /LIFECYCLE_INPUT_INVALID/ });

    const checkpointPayload = lifecycleEventPayloadCases()
      .find(([eventType]) => eventType === "SessionCheckpointRecorded")![1];
    assert.throws(() => decodeLifecycleEventV1(validLifecycleEvent("SessionCheckpointRecorded", {
      ...checkpointPayload,
      checkpointEventPosition: "14",
    })), { message: /LIFECYCLE_INPUT_INVALID/ });
    const checkpoint = checkpointPayload.checkpoint as Record<string, unknown>;
    assert.throws(() => decodeLifecycleEventV1(validLifecycleEvent("SessionCheckpointRecorded", {
      ...checkpointPayload,
      checkpoint: {
        ...checkpoint,
        sourceState: {
          ...(checkpoint.sourceState as object),
          workspaceId: "9".repeat(64),
        },
      },
    })), { message: /LIFECYCLE_INPUT_INVALID/ });

    const coveragePayload = lifecycleEventPayloadCases()
      .find(([eventType]) => eventType === "EvidenceCoverageRecorded")![1];
    assert.throws(() => decodeLifecycleEventV1(validLifecycleEvent("EvidenceCoverageRecorded", {
      ...coveragePayload,
      highestContiguousOrdinal: "3",
      missingIntervals: [{ firstOrdinal: "5", lastOrdinal: "6" }],
    })), { message: /LIFECYCLE_INPUT_INVALID/ });
  });

  it("publishes the complete frozen typed-error vocabulary", () => {
    const expected = [
      "PROJECT_BINDING_REQUIRED",
      "PROJECT_ID_MISMATCH",
      "VAULT_ID_MISMATCH",
      "WORKSPACE_AMBIGUOUS",
      "STORE_UNAVAILABLE",
      "SQLITE_CAPABILITY_MISSING",
      "EVENT_CONFLICT",
      "IDEMPOTENCY_CONFLICT",
      "COMMAND_OUTCOME_UNKNOWN",
      "OPERATION_OUTCOME_UNKNOWN",
      "SESSION_NOT_FOUND",
      "SESSION_AMBIGUOUS",
      "SESSION_ALREADY_OWNED",
      "SESSION_HANDLE_STALE",
      "SESSION_OWNERSHIP_MISMATCH",
      "CONTINUITY_CONFLICT",
      "SESSION_STATE_CONFLICT",
      "SESSION_CHILDREN_ACTIVE",
      "SESSION_END_INCOMPLETE",
      "SESSION_CAPABILITY_INVALID",
      "SESSION_CAPABILITY_KEY_UNAVAILABLE",
      "SESSION_CAPABILITY_EXPIRED",
      "SESSION_RECOVERY_APPROVAL_REQUIRED",
      "LIFECYCLE_APPROVAL_INVALID",
      "LIFECYCLE_APPROVAL_EXPIRED",
      "LIFECYCLE_APPROVAL_REPLAYED",
      "SESSION_SOURCE_STATE_CONFLICT",
      "SESSION_VALIDATION_RESULT_INVALID",
      "CHECKPOINT_BASE_INVALID",
      "EVIDENCE_CAPTURE_INCOMPLETE",
      "EVIDENCE_COVERAGE_TOO_FRAGMENTED",
      "MATERIALIZATION_CONFLICT",
      "SCHEMA_UPGRADE_REQUIRED",
      "SCHEMA_TOO_NEW",
      "MIGRATION_CHECKSUM_MISMATCH",
      "SCHEMA_FINGERPRINT_MISMATCH",
      "INTEGRITY_FAILURE",
      "CHILD_REPORT_INVALID",
      "CHILD_DISPOSITION_INVALID",
      "LIFECYCLE_INPUT_INVALID",
      "LIFECYCLE_V2_DISABLED",
      "STORE_ID_MISMATCH",
      "WORKER_PROTOCOL_ERROR",
    ];
    assert.equal(new Set(LIFECYCLE_ERROR_CODES).size, LIFECYCLE_ERROR_CODES.length);
    assert.deepEqual([...LIFECYCLE_ERROR_CODES].sort(), [...expected].sort());
    assert.ok(Object.isFrozen(LIFECYCLE_ERROR_CODES));
    const metadata: Record<LifecycleErrorCode, readonly [string, boolean, readonly string[]]> = {
      PROJECT_BINDING_REQUIRED: ["A trusted project binding is required", false, ["establish-project-binding"]],
      PROJECT_ID_MISMATCH: ["Project identity does not match the bound store", false, ["select-intended-project"]],
      VAULT_ID_MISMATCH: ["Vault identity does not match the bound store", false, ["select-intended-vault"]],
      WORKSPACE_AMBIGUOUS: ["The bound workspace identity is unavailable or changed", false, ["select-intended-workspace"]],
      STORE_UNAVAILABLE: ["The authoritative project store is unavailable", true, ["verify-store-and-retry"]],
      SQLITE_CAPABILITY_MISSING: ["The runtime lacks a required SQLite capability", false, ["install-supported-runtime"]],
      EVENT_CONFLICT: ["Lifecycle state changed before the operation committed", true, ["reload-and-retry"]],
      IDEMPOTENCY_CONFLICT: ["The retry identity is already bound to different input", false, ["resolve-session-state"]],
      COMMAND_OUTCOME_UNKNOWN: ["The lifecycle command outcome is unknown", true, ["retry-original-command"]],
      OPERATION_OUTCOME_UNKNOWN: ["The lifecycle operation outcome is unknown", true, ["retry-original-operation"]],
      SESSION_NOT_FOUND: ["The requested session was not found", false, ["select-session-explicitly"]],
      SESSION_AMBIGUOUS: ["More than one session matches the requested continuity", false, ["select-session-explicitly"]],
      SESSION_ALREADY_OWNED: ["The session currently has another active owner", true, ["resume-with-current-authority"]],
      SESSION_HANDLE_STALE: ["Session authority is stale", false, ["request-authorized-recovery"]],
      SESSION_OWNERSHIP_MISMATCH: ["Session ownership does not match the trusted caller", false, ["request-authorized-recovery"]],
      CONTINUITY_CONFLICT: ["The lifecycle continuity key is already in use", false, ["resolve-continuity-conflict"]],
      SESSION_STATE_CONFLICT: ["The requested lifecycle transition is not valid", false, ["resolve-session-state"]],
      SESSION_CHILDREN_ACTIVE: ["One or more child sessions still require disposition", false, ["resolve-active-children"]],
      SESSION_END_INCOMPLETE: ["Session end is already in progress or requires amendment", false, ["amend-or-cancel-session-end"]],
      SESSION_CAPABILITY_INVALID: ["Session authority could not be verified", false, ["request-authorized-recovery"]],
      SESSION_CAPABILITY_KEY_UNAVAILABLE: ["The session authority key is unavailable", false, ["restore-capability-key"]],
      SESSION_CAPABILITY_EXPIRED: ["Session authority has expired", false, ["request-authorized-recovery"]],
      SESSION_RECOVERY_APPROVAL_REQUIRED: ["Explicit recovery approval is required", false, ["request-new-approval"]],
      LIFECYCLE_APPROVAL_INVALID: ["Lifecycle approval could not be verified", false, ["request-new-approval"]],
      LIFECYCLE_APPROVAL_EXPIRED: ["Lifecycle approval has expired", false, ["request-new-approval"]],
      LIFECYCLE_APPROVAL_REPLAYED: ["Lifecycle approval has already been consumed", false, ["request-new-approval"]],
      SESSION_SOURCE_STATE_CONFLICT: ["Project source state changed during finalization", true, ["refresh-source-state"]],
      SESSION_VALIDATION_RESULT_INVALID: ["A trusted validation result is missing or incompatible", false, ["rerun-trusted-validation"]],
      CHECKPOINT_BASE_INVALID: ["The checkpoint base does not match current lifecycle state", true, ["record-current-checkpoint"]],
      EVIDENCE_CAPTURE_INCOMPLETE: ["Required evidence coverage is incomplete", false, ["record-required-evidence"]],
      EVIDENCE_COVERAGE_TOO_FRAGMENTED: ["Evidence coverage contains too many missing intervals", false, ["reduce-evidence-fragmentation"]],
      MATERIALIZATION_CONFLICT: ["Compatibility materialization could not be reconciled", true, ["reconcile-materialization"]],
      SCHEMA_UPGRADE_REQUIRED: ["The project store schema must be upgraded", false, ["upgrade-store-schema"]],
      SCHEMA_TOO_NEW: ["The project store schema requires newer software", false, ["upgrade-runtime"]],
      MIGRATION_CHECKSUM_MISMATCH: ["A recorded migration does not match the approved migration", false, ["restore-approved-migration"]],
      SCHEMA_FINGERPRINT_MISMATCH: ["The project store schema fingerprint is invalid", false, ["run-integrity-recovery"]],
      INTEGRITY_FAILURE: ["Lifecycle integrity verification failed", false, ["run-integrity-recovery"]],
      CHILD_REPORT_INVALID: ["The child report is invalid", false, ["correct-lifecycle-input"]],
      CHILD_DISPOSITION_INVALID: ["The child report disposition is invalid", false, ["correct-lifecycle-input"]],
      LIFECYCLE_INPUT_INVALID: ["Lifecycle input is invalid", false, ["correct-lifecycle-input"]],
      LIFECYCLE_V2_DISABLED: ["Lifecycle Version 2 is disabled", false, ["enable-lifecycle-v2"]],
      STORE_ID_MISMATCH: ["Store identity does not match the manifest", false, ["attach-intended-store"]],
      WORKER_PROTOCOL_ERROR: ["The lifecycle worker protocol rejected the message", false, ["restart-trusted-worker"]],
    };
    for (const code of LIFECYCLE_ERROR_CODES) {
      const error = new LifecycleError(code);
      const [safeMessage, retryable, recoveryActions] = metadata[code];
      assert.equal(error.code, code);
      assert.equal(error.retryable, retryable);
      assert.equal(error.safeMessage, safeMessage);
      assert.deepEqual(error.recoveryActions, recoveryActions);
      assert.ok(Object.isFrozen(error.recoveryActions));
      assert.deepEqual(Object.keys(error.toJSON()).sort(), [
        "code",
        "recoveryActions",
        "retryable",
        "safeMessage",
      ]);
    }
  });

  it("never serializes unsafe error material", () => {
    const contextFree = new LifecycleError("SESSION_CAPABILITY_INVALID");
    assert.deepEqual(Object.keys(contextFree).sort(), [
      "code",
      "recoveryActions",
      "retryable",
      "safeMessage",
    ]);
    const error = new LifecycleError("SESSION_CAPABILITY_INVALID", {
      projectId: "11111111-1111-4111-8111-111111111111",
      sessionId: UUIDS.session,
    });
    assert.deepEqual(error.toJSON(), {
      code: "SESSION_CAPABILITY_INVALID",
      retryable: false,
      safeMessage: "Session authority could not be verified",
      projectId: "11111111-1111-4111-8111-111111111111",
      sessionId: UUIDS.session,
      recoveryActions: ["request-authorized-recovery"],
    });
    assert.doesNotMatch(JSON.stringify(error), /details|stack|pmcap1|proof|approval/i);

    assert.doesNotThrow(() => new LifecycleError("EVENT_CONFLICT", {
      workspaceId: "a".repeat(64),
      globalPosition: "9223372036854775807",
      phase: "final-checkpoint-recorded",
    }));

    for (const details of [
      { handle: "pmcap1.secret" },
      { resumeToken: "pmcap1.secret" },
      { proofMac: "secret" },
      { rawApproval: "secret" },
      { rawOutput: "secret" },
      { environment: "secret" },
      { field: { nested: "not a scalar" } },
      { sessionId: "secret-token" },
      { projectId: "secret-token" },
      { globalPosition: "01" },
      { ownerGeneration: -1 },
    ]) {
      assert.throws(() => new LifecycleError("LIFECYCLE_INPUT_INVALID", details));
    }
    assert.throws(() => new LifecycleError("UNKNOWN_CODE" as LifecycleErrorCode));
  });
});
