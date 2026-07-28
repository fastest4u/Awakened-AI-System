import type {
  ProjectId,
  StoreId,
  VaultId,
  WorkspaceId,
} from "../../src/orchestrator/identity/contracts.js";
import {
  foldSession,
  type ChildAggregateState,
  type RootAggregateState,
  type SessionAggregateState,
  type SessionAuthorityMirror,
} from "../../src/orchestrator/lifecycle/session-aggregate.js";
import type {
  CheckpointV1,
  CheckpointV2,
} from "../../src/orchestrator/lifecycle/contracts/checkpoint.js";
import type {
  ChildDispositionV1,
  ChildReportV1,
} from "../../src/orchestrator/lifecycle/contracts/child.js";
import type {
  LifecycleAssignmentV1,
  LifecycleEventBaseV1,
  LifecycleEventPayloadMapV1,
  LifecycleEventPayloadV1,
  LifecycleEventType,
} from "../../src/orchestrator/lifecycle/contracts/events.js";
import type {
  ApprovalId,
  CheckpointId,
  EvidenceBatchId,
  EvidenceFrameId,
  ReportId,
  ReportItemId,
  SessionId,
  TransferTicketId,
  ValidationResultId,
  WorkflowId,
} from "../../src/orchestrator/lifecycle/contracts/identifiers.js";
import type { ValidationResultV1 } from "../../src/orchestrator/lifecycle/contracts/session-end.js";

export const PROJECT_ID = lifecycleUuid<ProjectId>(1);
export const VAULT_ID = lifecycleUuid<VaultId>(2);
export const STORE_ID = lifecycleUuid<StoreId>(3);
export const ROOT_SESSION_ID = lifecycleUuid<SessionId>(10);
export const CHILD_SESSION_ID = lifecycleUuid<SessionId>(11);
export const OTHER_SESSION_ID = lifecycleUuid<SessionId>(12);
export const WORKFLOW_ID = lifecycleUuid<WorkflowId>(20);
export const CHECKPOINT_ID = lifecycleUuid<CheckpointId>(30);
export const REPORT_ID = lifecycleUuid<ReportId>(40);
export const REPORT_ITEM_ID = lifecycleUuid<ReportItemId>(41);
export const SECOND_REPORT_ITEM_ID = lifecycleUuid<ReportItemId>(42);
export const TRANSFER_TICKET_ID = lifecycleUuid<TransferTicketId>(50);
export const APPROVAL_ID = lifecycleUuid<ApprovalId>(60);
export const VALIDATION_RESULT_ID = lifecycleUuid<ValidationResultId>(70);
export const EVIDENCE_BATCH_ID = lifecycleUuid<EvidenceBatchId>(80);
export const WORKSPACE_ID = "1".repeat(64) as WorkspaceId;
export const AUTHORITY_A = "a".repeat(64);
export const AUTHORITY_B = "b".repeat(64);
export const AUTHORITY_C = "c".repeat(64);
export const AUTHORITY_D = "d".repeat(64);

const ROOT_ONLY_EVENTS = new Set<LifecycleEventType>([
  "SessionStarted",
  "SessionOwnerTransferred",
  "SessionOwnershipRecovered",
  "SessionSuspendRequested",
  "SessionSuspended",
  "SessionResumed",
  "SessionEndRequested",
  "SessionEndAmended",
  "SessionValidationResultRecorded",
  "SessionEndVerificationPassed",
  "SessionEndVerificationFailed",
  "SessionEndVerificationInvalidated",
  "SessionEndCancelled",
  "SessionAbandoned",
  "SessionEnded",
]);

export function lifecycleUuid<T extends string = string>(ordinal: number): T {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal > 999_999_999_999) {
    throw new TypeError("fixture UUID ordinal must be a nonnegative safe integer");
  }
  return `00000000-0000-4000-8000-${ordinal.toString().padStart(12, "0")}` as T;
}

export function lifecycleTimestamp(ordinal = 0): string {
  return new Date(Date.UTC(2026, 6, 14, 0, 0, 0, ordinal)).toISOString();
}

export function lifecycleAuthority(character: string): string {
  if (!/^[0-9a-f]$/.test(character)) throw new TypeError("fixture authority seed must be one lowercase hex character");
  return character.repeat(64);
}

export const DEFAULT_ASSIGNMENT: LifecycleAssignmentV1 = Object.freeze({
  assignmentId: lifecycleUuid(90),
  summary: "Deterministic child assignment",
  scope: "tests/session-aggregate.test.ts",
});

export interface CheckpointFixtureOptions {
  readonly sessionId?: SessionId;
  readonly parentSessionId?: SessionId | null;
  readonly checkpointId?: CheckpointId;
  readonly baseEventPosition?: bigint | number | string;
  readonly checkpointEventPosition?: bigint | number | string;
}

function decimal(value: bigint | number | string): string {
  return typeof value === "string" ? value : value.toString();
}

export function checkpointFixture(options: CheckpointFixtureOptions = {}): CheckpointV1 {
  const sessionId = options.sessionId ?? ROOT_SESSION_ID;
  const parentSessionId = options.parentSessionId ?? null;
  const baseEventPosition = decimal(options.baseEventPosition ?? 1);
  const checkpointEventPosition = decimal(options.checkpointEventPosition ?? 2);
  return Object.freeze({
    checkpointVersion: 1,
    checkpointId: options.checkpointId ?? CHECKPOINT_ID,
    sessionId,
    parentSessionId,
    baseEventPosition,
    checkpointEventPosition,
    createdAt: lifecycleTimestamp(2),
    creatorAgentId: "agent-primary",
    creatorClientInstanceId: "client-primary",
    taskSummary: "Deterministic checkpoint",
    completedItems: Object.freeze([]),
    inProgressItems: Object.freeze([]),
    blockers: Object.freeze([]),
    nextActions: Object.freeze([]),
    decisions: Object.freeze([]),
    assumptions: Object.freeze([]),
    unresolvedConflicts: Object.freeze([]),
    filesTouched: Object.freeze([]),
    artifactReferences: Object.freeze([]),
    sourceReferences: Object.freeze([]),
    commandResults: Object.freeze([]),
    testResults: Object.freeze([]),
    materialClaims: Object.freeze([]),
    sourceState: Object.freeze({
      sourceStateScopeVersion: 1,
      workspaceId: WORKSPACE_ID,
      branchRef: "refs/heads/codex/subproject-2-lifecycle-spec",
      headCommit: "1".repeat(40),
      dirtyWorktreeFingerprint: "2".repeat(64),
    }),
    childSummaries: Object.freeze([]),
    evidenceCoverage: Object.freeze({
      captureMode: "coverage-only",
      contentRetained: false,
      highestContiguousOrdinal: null,
      missingIntervals: Object.freeze([]),
    }),
  });
}

export function qualifiedCheckpointFixture(
  options: CheckpointFixtureOptions = {},
): CheckpointV2 {
  return Object.freeze({
    ...checkpointFixture(options),
    checkpointVersion: 2,
    evidenceCoverage: Object.freeze({
      coverageVersion: 2,
      captureMode: "coverage-only",
      contentRetained: false,
      adapterSessions: Object.freeze([]),
    }),
  });
}

export interface ChildReportFixtureOptions {
  readonly reportId?: ReportId;
  readonly childSessionId?: SessionId;
  readonly parentSessionId?: SessionId;
  readonly assignmentId?: string;
  readonly itemIds?: readonly [ReportItemId, ReportItemId];
}

export function childReportFixture(options: ChildReportFixtureOptions = {}): ChildReportV1 {
  const itemIds = options.itemIds ?? [REPORT_ITEM_ID, SECOND_REPORT_ITEM_ID];
  const finding = Object.freeze({
    itemId: itemIds[0],
    summary: "Deterministic finding",
    evidenceReferences: Object.freeze(["evidence:coverage-only"]),
    confidence: "high" as const,
  });
  const proposedDecision = Object.freeze({
    itemId: itemIds[1],
    summary: "Deterministic proposed decision",
    evidenceReferences: Object.freeze(["evidence:coverage-only"]),
    confidence: "high" as const,
  });
  return Object.freeze({
    reportVersion: 1,
    reportId: options.reportId ?? REPORT_ID,
    childSessionId: options.childSessionId ?? CHILD_SESSION_ID,
    parentSessionId: options.parentSessionId ?? ROOT_SESSION_ID,
    assignmentId: options.assignmentId ?? DEFAULT_ASSIGNMENT.assignmentId,
    createdAt: lifecycleTimestamp(3),
    outcomeSummary: "Deterministic child result",
    findings: Object.freeze([finding]),
    proposedDecisions: Object.freeze([proposedDecision]),
    filesObservedOrChanged: Object.freeze([]),
    verificationPerformed: Object.freeze([]),
    openFollowUps: Object.freeze([]),
    blockers: Object.freeze([]),
    evidenceFingerprints: Object.freeze([]),
    allReportItemIds: Object.freeze([...itemIds]),
  });
}

export function childDispositionFixture(
  kind: ChildDispositionV1["kind"] = "accepted",
  reportId: ReportId = REPORT_ID,
): ChildDispositionV1 {
  const allReportItemIds = Object.freeze([REPORT_ITEM_ID, SECOND_REPORT_ITEM_ID]);
  const accepted = kind === "accepted"
    ? allReportItemIds
    : kind === "partially-accepted"
      ? Object.freeze([REPORT_ITEM_ID])
    : Object.freeze([] as ReportItemId[]);
  const rejected = kind === "rejected" || kind === "superseded"
    ? allReportItemIds
    : Object.freeze([] as ReportItemId[]);
  return Object.freeze({
    dispositionVersion: 1,
    reportId,
    kind,
    acceptedItemIds: accepted,
    rejectedItemIds: rejected,
    deferredItemIds: kind === "partially-accepted"
      ? Object.freeze([SECOND_REPORT_ITEM_ID])
      : Object.freeze([]),
    supersededByReportId: kind === "superseded" ? lifecycleUuid<ReportId>(43) : null,
    explanation: `Fixture disposition: ${kind}`,
    allReportItemIds,
  });
}

export interface ValidationResultFixtureOptions {
  readonly sessionId?: SessionId;
  readonly workflowId?: WorkflowId;
  readonly workflowGeneration?: number;
  readonly resultId?: ValidationResultId;
}

export function validationResultFixture(options: ValidationResultFixtureOptions = {}): ValidationResultV1 {
  const sourceState = Object.freeze({
    sourceStateScopeVersion: 1 as const,
    workspaceId: WORKSPACE_ID,
    branchRef: "refs/heads/codex/subproject-2-lifecycle-spec",
    headCommit: "1".repeat(40),
    dirtyWorktreeFingerprint: "2".repeat(64),
  });
  return Object.freeze({
    validationResultVersion: 1,
    resultId: options.resultId ?? VALIDATION_RESULT_ID,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    sessionId: options.sessionId ?? ROOT_SESSION_ID,
    workflowId: options.workflowId ?? WORKFLOW_ID,
    workflowGeneration: options.workflowGeneration ?? 1,
    finalCheckpointId: CHECKPOINT_ID,
    finalCheckpointFingerprint: "3".repeat(64),
    profileId: "vault-gate",
    profileVersion: 1,
    profileConfigurationHash: "4".repeat(64),
    runId: lifecycleUuid(71),
    runnerId: "trusted-runner",
    sourceStateAtStart: sourceState,
    sourceStateAtCompletion: sourceState,
    startedAt: lifecycleTimestamp(4),
    completedAt: lifecycleTimestamp(5),
    status: "pass",
    exitClassification: "passed",
    summary: "Fixture validation passed",
    outputFingerprint: Object.freeze({
      fingerprintSchemaVersion: 1,
      fingerprintKeyId: "validation-key-v1",
      fingerprintDomain: "pm-validation-output-v1",
      fingerprint: "5".repeat(64),
    }),
    artifactReferences: Object.freeze([]),
    fresh: true,
  });
}

export interface LifecycleEventFixtureOptions {
  readonly sessionId?: SessionId;
  readonly parentSessionId?: SessionId | null;
  readonly streamId?: string;
  readonly streamVersion?: bigint | number | string;
  readonly globalPosition?: bigint | number | string;
  readonly correlationId?: string;
  readonly causationId?: string | null;
  readonly authorityCommitment?: string;
  readonly projectId?: ProjectId;
  readonly vaultId?: VaultId;
  readonly storeId?: StoreId;
  readonly workspaceId?: WorkspaceId;
  readonly eventId?: string;
}

function defaultPayload(
  eventType: LifecycleEventType,
  sessionId: SessionId,
  parentSessionId: SessionId | null,
  globalPosition: string,
  authorityCommitment: string,
): LifecycleEventPayloadV1 {
  switch (eventType) {
    case "SessionStarted":
      return {
        sessionKind: "root",
        ownerGeneration: 1,
        continuityKey: "fixture-continuity",
        clientNamespace: "fixture-client",
        creatingAgentId: "agent-primary",
        creatingClientInstanceId: "client-primary",
        authorityCommitment,
      };
    case "SessionOwnerTransferred":
      return { previousOwnerGeneration: 1, ownerGeneration: 2, authorityCommitment };
    case "SessionOwnershipRecovered":
      return { previousOwnerGeneration: 1, ownerGeneration: 2, approvalId: APPROVAL_ID, authorityCommitment };
    case "SessionSuspendRequested":
      return { checkpointId: CHECKPOINT_ID };
    case "SessionSuspended":
      return { authorityCommitment };
    case "SessionResumed":
      return { ownerGeneration: 1 };
    case "SessionCheckpointRecorded": {
      const baseEventPosition = (BigInt(globalPosition) - 1n).toString();
      return {
        checkpoint: checkpointFixture({
          sessionId,
          parentSessionId,
          baseEventPosition,
          checkpointEventPosition: globalPosition,
        }),
        baseEventPosition,
        checkpointEventPosition: globalPosition,
      };
    }
    case "EvidenceCoverageRecorded":
      return {
        adapterSessionId: lifecycleUuid(81),
        batchId: EVIDENCE_BATCH_ID,
        firstOrdinal: "0",
        lastOrdinal: "0",
        highestContiguousOrdinal: "0",
        missingIntervals: Object.freeze([]),
        fingerprintSchemaVersion: 1,
        fingerprintKeyId: "evidence-key-v1",
        fingerprintDomain: "pm-evidence-frame-v1",
        coverageFingerprint: "6".repeat(64),
        captureMode: "coverage-only",
        contentRetained: false,
        frames: Object.freeze([{
          frameId: lifecycleUuid<EvidenceFrameId>(82),
          ordinal: "0",
          sourceKind: "adapter-event",
          observedAt: lifecycleTimestamp(6),
          contentFingerprint: "7".repeat(64),
        }]),
      };
    case "SessionForked":
      return {
        parentSessionId: parentSessionId ?? ROOT_SESSION_ID,
        assignment: DEFAULT_ASSIGNMENT,
        rootOwnerGeneration: 1,
        directAccessEnabled: true,
        authorityCommitment,
        sourceTransferTicketId: null,
      };
    case "ChildAssignmentAmended":
      return {
        previousAssignmentRevision: 1,
        assignmentRevision: 2,
        assignment: DEFAULT_ASSIGNMENT,
        reasonCode: "scope-clarified",
      };
    case "ChildWorkReported":
      return {
        report: childReportFixture({ childSessionId: sessionId, parentSessionId: parentSessionId ?? ROOT_SESSION_ID }),
        childAuthorAgentId: "agent-child",
        primaryRecorderAgentId: "agent-primary",
      };
    case "ChildWorkDispositioned":
      return { disposition: childDispositionFixture() };
    case "ChildCompletionProposed":
      return { reportId: REPORT_ID };
    case "ChildSessionCompleted":
      return { reportId: REPORT_ID, authorityCommitment };
    case "ChildSessionSuspended":
      return { checkpointId: CHECKPOINT_ID, blockers: Object.freeze([]), followUps: Object.freeze([]), authorityCommitment };
    case "ChildWorkTransferCreated":
      return { transferTicketId: TRANSFER_TICKET_ID, checkpointId: CHECKPOINT_ID, authorityCommitment };
    case "ChildWorkTransferClaimed":
      return {
        transferTicketId: TRANSFER_TICKET_ID,
        previousChildSessionId: OTHER_SESSION_ID,
        previousTransferEventPosition: (BigInt(globalPosition) - 2n).toString(),
      };
    case "SessionEndRequested":
      return {
        workflowId: WORKFLOW_ID,
        workflowGeneration: 1,
        previousState: "active",
        childEndPolicy: "require-completed",
        qualityThreshold: 10_000,
        requireFullEvidence: false,
        requireMaterialization: true,
      };
    case "SessionEndAmended":
      return {
        workflowId: WORKFLOW_ID,
        previousWorkflowGeneration: 1,
        workflowGeneration: 2,
        preTransitionCheckpointId: CHECKPOINT_ID,
      };
    case "SessionValidationResultRecorded":
      return {
        workflowId: WORKFLOW_ID,
        workflowGeneration: 1,
        plannedWorkId: "8".repeat(64),
        validationResult: validationResultFixture({ sessionId }),
      };
    case "SessionEndVerificationPassed":
      return {
        workflowId: WORKFLOW_ID,
        workflowGeneration: 1,
        validationResultIds: Object.freeze([VALIDATION_RESULT_ID]),
        qualityScore: 10_000,
      };
    case "SessionEndVerificationFailed":
      return {
        workflowId: WORKFLOW_ID,
        workflowGeneration: 1,
        validationResultIds: Object.freeze([VALIDATION_RESULT_ID]),
        safeFailureCode: "SESSION_VALIDATION_RESULT_INVALID",
      };
    case "SessionEndVerificationInvalidated":
      return {
        workflowId: WORKFLOW_ID,
        workflowGeneration: 1,
        previousVerificationEventPosition: (BigInt(globalPosition) - 1n).toString(),
        safeFailureCode: "SESSION_SOURCE_STATE_CONFLICT",
      };
    case "SessionEndCancelled":
      return {
        workflowId: WORKFLOW_ID,
        workflowGeneration: 1,
        restoredState: "active",
        preTransitionCheckpointId: CHECKPOINT_ID,
      };
    case "SessionAbandoned":
      return {
        workflowId: null,
        workflowGeneration: null,
        approvalId: APPROVAL_ID,
        preTransitionCheckpointId: CHECKPOINT_ID,
        reasonCode: "approved-abandonment",
        authorityCommitment,
      };
    case "SessionEnded":
      return {
        workflowId: WORKFLOW_ID,
        workflowGeneration: 1,
        verificationEventPosition: (BigInt(globalPosition) - 1n).toString(),
        authorityCommitment,
      };
  }
}

export function lifecycleEvent<T extends LifecycleEventType>(
  sequence: bigint | number,
  eventType: T,
  payload: Partial<LifecycleEventPayloadMapV1[T]> = {},
  options: LifecycleEventFixtureOptions = {},
): LifecycleEventBaseV1<T> {
  const rootEvent = ROOT_ONLY_EVENTS.has(eventType);
  const sessionId = options.sessionId ?? (rootEvent ? ROOT_SESSION_ID : CHILD_SESSION_ID);
  const parentSessionId = options.parentSessionId === undefined
    ? (rootEvent ? null : ROOT_SESSION_ID)
    : options.parentSessionId;
  const streamVersion = decimal(options.streamVersion ?? sequence);
  const globalPosition = decimal(options.globalPosition ?? sequence);
  const authorityCommitment = options.authorityCommitment ?? AUTHORITY_A;
  const mergedPayload = Object.freeze({
    ...defaultPayload(eventType, sessionId, parentSessionId, globalPosition, authorityCommitment),
    ...payload,
  }) as LifecycleEventPayloadMapV1[T];
  return Object.freeze({
    eventSchemaVersion: 1,
    eventId: options.eventId ?? lifecycleUuid(1_000 + Number(sequence)),
    projectId: options.projectId ?? PROJECT_ID,
    vaultId: options.vaultId ?? VAULT_ID,
    storeId: options.storeId ?? STORE_ID,
    workspaceId: options.workspaceId ?? WORKSPACE_ID,
    streamId: options.streamId ?? `session/${sessionId}`,
    streamVersion,
    globalPosition,
    sessionId,
    parentSessionId,
    eventType,
    correlationId: options.correlationId ?? lifecycleUuid(100),
    causationId: options.causationId === undefined
      ? (sequence === 1 || sequence === 1n ? null : lifecycleUuid(999 + Number(sequence)))
      : options.causationId,
    commandId: lifecycleUuid(2_000 + Number(sequence)),
    idempotencyKey: `fixture-command-${sequence.toString()}`,
    occurredAt: lifecycleTimestamp(Number(sequence)),
    authorityCommitment,
    payload: mergedPayload,
  });
}

export function rootAggregate(events: readonly LifecycleEventBaseV1[] = [
  lifecycleEvent(1, "SessionStarted"),
]): RootAggregateState {
  const aggregate = foldSession(events as readonly import("../../src/orchestrator/lifecycle/contracts/events.js").LifecycleEventV1[]);
  if (aggregate.kind !== "root") throw new TypeError("fixture did not fold to a root aggregate");
  return aggregate;
}

export function childAggregate(events: readonly LifecycleEventBaseV1[] = [
  lifecycleEvent(1, "SessionForked"),
]): ChildAggregateState {
  const aggregate = foldSession(events as readonly import("../../src/orchestrator/lifecycle/contracts/events.js").LifecycleEventV1[]);
  if (aggregate.kind !== "child") throw new TypeError("fixture did not fold to a child aggregate");
  return aggregate;
}

export function authorityMirror(
  aggregate: SessionAggregateState,
  overrides: Partial<SessionAuthorityMirror> = {},
): SessionAuthorityMirror {
  return Object.freeze({
    sessionKind: aggregate.kind,
    parentSessionId: aggregate.parentSessionId,
    semanticState: aggregate.state,
    ownerGeneration: aggregate.kind === "root" ? BigInt(aggregate.ownerGeneration) : null,
    childCapabilityGeneration: aggregate.kind === "child"
      ? aggregate.childCapabilityGeneration === null
        ? null
        : BigInt(aggregate.childCapabilityGeneration)
      : null,
    authorityCommitment: aggregate.authorityCommitment,
    latestCheckpointEventPosition: aggregate.latestCheckpointEventPosition,
    terminalEventPosition: aggregate.terminalEventPosition,
    ...overrides,
  });
}
