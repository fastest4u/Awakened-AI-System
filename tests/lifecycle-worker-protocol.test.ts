import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JsonValue } from "../src/orchestrator/contracts/event.js";
import type { ProjectContext } from "../src/orchestrator/identity/contracts.js";
import type {
  CapabilityProofV1,
  ChildBindingGrantV1,
  InternalWorkflowExecutionPlan,
  InternalWorkflowPhaseCommand,
  PreparedLifecycleWorkerCommand,
  SemanticCommandAuthorization,
} from "../src/orchestrator/lifecycle/contracts/commands.js";
import {
  LIFECYCLE_ERROR_CODES,
  LifecycleError,
} from "../src/orchestrator/lifecycle/errors.js";
import {
  MAX_LIFECYCLE_WIRE_CANONICAL_BYTES,
  assertLifecycleWireCanonicalSize,
  decodeLifecycleWorkerOperationWire,
  decodeLifecycleWorkerSuccessForOperation,
  lifecycleInternalWorkVersionBinding,
  lifecycleNestedContractVersion,
  materializeLifecycleWorkerOperation,
  type BoundedOperationAuthorizationWire,
  type CheckpointResultWire,
  type CheckpointWire,
  type LifecycleBoundedMutationForInput,
  type LifecycleBoundedMutationInput,
  type LifecycleBoundedOperationWire,
  type LifecycleBoundedResultFor,
  type LifecycleFencedInput,
  type LifecycleFencedOperationForInput,
  type LifecycleFencedOperationWire,
  type LifecycleFencedResultFor,
  type LifecycleInternalOperationWire,
  type LifecycleInternalResultFor,
  type LifecycleInternalWorkVersionBinding,
  type LifecycleOutboxClaimWireV1,
  type LifecycleQueryForInput,
  type LifecycleQueryInput,
  type LifecycleQueryOperationWire,
  type LifecycleQueryResultFor,
  type LifecycleRecoveryScanResultWireV1,
  type LifecycleResultFor,
  type LifecycleSemanticOperationWire,
  type LifecycleWorkerOperation,
  type LifecycleWorkerOperationName,
  type LifecycleWorkerOperationWire,
  type LifecycleWorkerSuccessWire,
  type MaterializationFingerprintWireV1,
  type MaterializationResultWireV1,
  type RootSuspendWire,
  type SessionEndAmendWire,
  type SessionEndRequestWire,
  type SessionEndWorkflowClaimWireV1,
} from "../src/orchestrator/runtime/lifecycle-worker-protocol.js";
import {
  decodeWorkerRequest,
  decodeWorkerResponseForRequest,
  WorkerProtocolError,
  type WorkerRequest,
} from "../src/orchestrator/runtime/worker-protocol.js";

const IDS = {
  project: "11111111-1111-4111-8111-111111111111",
  vault: "22222222-2222-4222-8222-222222222222",
  store: "33333333-3333-4333-8333-333333333333",
  command: "44444444-4444-4444-8444-444444444444",
  session: "55555555-5555-4555-8555-555555555555",
  workflow: "66666666-6666-4666-8666-666666666666",
  work: "77777777-7777-4777-8777-777777777777",
  nonce: "88888888-8888-4888-8888-888888888888",
  grant: "99999999-9999-4999-8999-999999999999",
} as const;
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const IDEMPOTENCY_KEY = `lifecycle-phase-v1/${"c".repeat(64)}`;

const proof: CapabilityProofV1 = {
  proofVersion: 1,
  target: "semantic-command",
  proofNonce: IDS.nonce,
  proofFingerprint: HASH,
};

const boundedProof: CapabilityProofV1 = {
  ...proof,
  target: "bounded-operation",
};

const boundedInput = {
  operation: "renew-root-lease",
  operationId: IDS.command,
  requestId: IDS.work,
  authorization: {
    kind: "bounded-operation",
    authoritySessionId: IDS.session as never,
    targetSessionId: IDS.session as never,
    proof: boundedProof,
  },
  sessionId: IDS.session as never,
  expectedOwnerGeneration: 1,
} satisfies LifecycleBoundedMutationInput;

const queryInput = {
  operation: "read-session-status",
  operationId: IDS.command,
  requestId: IDS.work,
  authorization: boundedInput.authorization,
  sessionId: IDS.session as never,
} satisfies LifecycleQueryInput;

const fencedInput = {
  operation: "outbox-failure",
  workId: IDS.work,
  ownerId: "materializer-a",
  fencingToken: "7",
  targetKey: "memory/session.md",
  materializationRevision: "3",
  retryable: true,
  safeErrorCode: "STORE_UNAVAILABLE",
  attempt: 1,
  nextAttemptAt: null,
} satisfies LifecycleFencedInput;

const materializationInput = {
  operation: "outbox-materialize",
  workId: IDS.work,
  ownerId: "materializer-a",
  fencingToken: "7",
  targetKey: "memory/session.md",
  materializationRevision: "3",
} satisfies LifecycleFencedInput;

const invalidLegacyMaterialization = {
  ...materializationInput,
  // @ts-expect-error Materialization bytes are worker-owned and never cross this wire.
  materializedBytes: new Uint8Array([1]),
} satisfies LifecycleFencedInput;
const invalidLegacyCurrentFingerprint = {
  ...materializationInput,
  // @ts-expect-error Fingerprints are computed by the worker-owned materializer.
  expectedCurrentFingerprint: null,
} satisfies LifecycleFencedInput;
const invalidLegacyNextFingerprint = {
  ...materializationInput,
  // @ts-expect-error Fingerprints are computed by the worker-owned materializer.
  nextFingerprint: HASH,
} satisfies LifecycleFencedInput;
const invalidLegacyAcknowledgement = {
  ...materializationInput,
  // @ts-expect-error Acknowledgement is not a standalone wire capability.
  acknowledgement: { ownerId: "materializer-a" },
} satisfies LifecycleFencedInput;

void invalidLegacyMaterialization;
void invalidLegacyCurrentFingerprint;
void invalidLegacyNextFingerprint;
void invalidLegacyAcknowledgement;

const invalidBoundedContext = {
  ...boundedInput,
  // @ts-expect-error ProjectContext must never cross the lifecycle wire.
  context: {} as ProjectContext,
} satisfies LifecycleBoundedMutationInput;
const invalidBoundedAudience = {
  ...boundedInput,
  authorization: {
    ...boundedInput.authorization,
    // @ts-expect-error The active worker derives the audience.
    audience: {},
  },
} satisfies LifecycleBoundedMutationInput;
const invalidQueryContext = {
  ...queryInput,
  // @ts-expect-error ProjectContext must never cross a query wire.
  context: {} as ProjectContext,
} satisfies LifecycleQueryInput;
const invalidQueryAudience = {
  ...queryInput,
  authorization: {
    ...queryInput.authorization,
    // @ts-expect-error The active worker derives the audience.
    audience: {},
  },
} satisfies LifecycleQueryInput;
const invalidFencedContext = {
  ...fencedInput,
  // @ts-expect-error ProjectContext must never cross an operational wire.
  context: {} as ProjectContext,
} satisfies LifecycleFencedInput;

void invalidBoundedContext;
void invalidBoundedAudience;
void invalidQueryContext;
void invalidQueryAudience;
void invalidFencedContext;

void MAX_LIFECYCLE_WIRE_CANONICAL_BYTES;
void assertLifecycleWireCanonicalSize;
void decodeLifecycleWorkerOperationWire;
void decodeLifecycleWorkerSuccessForOperation;
void lifecycleInternalWorkVersionBinding;
void lifecycleNestedContractVersion;
void materializeLifecycleWorkerOperation;

type RequiredProtocolSurface = readonly [
  BoundedOperationAuthorizationWire,
  CheckpointResultWire,
  CheckpointWire,
  LifecycleBoundedMutationForInput<LifecycleBoundedMutationInput>,
  LifecycleBoundedOperationWire,
  LifecycleBoundedResultFor<never>,
  LifecycleFencedOperationForInput<LifecycleFencedInput>,
  LifecycleFencedOperationWire,
  LifecycleFencedResultFor<never>,
  LifecycleInternalOperationWire,
  LifecycleInternalResultFor<never>,
  LifecycleInternalWorkVersionBinding,
  LifecycleOutboxClaimWireV1,
  LifecycleQueryForInput<LifecycleQueryInput>,
  LifecycleQueryOperationWire,
  LifecycleQueryResultFor<never>,
  LifecycleRecoveryScanResultWireV1,
  LifecycleResultFor<never>,
  LifecycleSemanticOperationWire,
  LifecycleWorkerOperation,
  LifecycleWorkerOperationName,
  LifecycleWorkerOperationWire,
  LifecycleWorkerSuccessWire,
  MaterializationFingerprintWireV1,
  MaterializationResultWireV1,
  RootSuspendWire,
  SessionEndAmendWire,
  SessionEndRequestWire,
  SessionEndWorkflowClaimWireV1,
];

void (undefined as unknown as RequiredProtocolSurface);

function commandBase(commandType: string): Record<string, unknown> {
  return {
    commandType,
    commandId: IDS.command,
    idempotencyKey: IDEMPOTENCY_KEY,
    agentId: "agent-primary",
    expectedProjectId: IDS.project,
    expectedVaultId: IDS.vault,
    expectedWorkspaceId: HASH,
    expectedBranchRef: "refs/heads/main",
  };
}

function checkpointDraft(version: 1 | 2): Record<string, unknown> {
  return {
    checkpointVersion: version,
    taskSummary: `Checkpoint Version ${version}`,
    completedItems: [],
    inProgressItems: [],
    blockers: [],
    nextActions: [],
    decisions: [],
    assumptions: [],
    unresolvedConflicts: [],
    filesTouched: [],
    artifactReferences: [],
    sourceReferences: [],
    commandResults: [],
    testResults: [],
    materialClaims: [],
  };
}

function reportDraft(): Record<string, unknown> {
  return {
    reportVersion: 1,
    outcomeSummary: "Completed the assigned lifecycle analysis",
    findings: [],
    proposedDecisions: [],
    filesObservedOrChanged: [],
    verificationPerformed: [],
    openFollowUps: [],
    blockers: [],
    evidenceFingerprints: [],
  };
}

function acceptedDisposition(): Record<string, unknown> {
  return {
    dispositionVersion: 1,
    reportId: IDS.grant,
    kind: "accepted",
    acceptedItemIds: [IDS.nonce],
    rejectedItemIds: [],
    deferredItemIds: [],
    supersededByReportId: null,
    explanation: "Accepted the report item",
    allReportItemIds: [IDS.nonce],
  };
}

function endRequest(version: 1 | 2): Record<string, unknown> {
  return {
    requestVersion: version,
    sessionId: IDS.session,
    childEndPolicy: "require-completed",
    finalCheckpoint: checkpointDraft(version),
    validationProfileIds: [],
    requestedQualityThreshold: 8_000,
    requireFullEvidence: false,
    requireMaterialization: true,
  };
}

function endAmendment(version: 1 | 2): Record<string, unknown> {
  return {
    amendmentVersion: version,
    childEndPolicy: null,
    finalCheckpoint: null,
    validationProfileIds: null,
    requestedQualityThreshold: null,
    requireFullEvidence: null,
    requireMaterialization: false,
    ...(version === 2 ? { evidenceWindowAction: "unchanged" } : {}),
  };
}

function validChildBindingGrant(): ChildBindingGrantV1 {
  return {
    grantVersion: 1,
    grantId: IDS.grant,
    projectId: IDS.project,
    storeId: IDS.store,
    parentSessionId: IDS.session,
    targetActorRole: "untrusted",
    targetClientInstanceId: "child/client-a",
    issuedAt: "2026-07-17T00:00:00.000Z",
    expiresAt: "2026-07-17T00:10:00.000Z",
    bindingFingerprint: HASH,
    mac: "A".repeat(43),
  };
}

function lifecycleApproval(
  action: "recover-root-authority" | "abandon-root",
): Record<string, unknown> {
  return {
    approvalVersion: 1,
    approvalId: IDS.grant,
    action,
    reasonCode: action === "recover-root-authority" ? "credential-loss" : "explicit-user-approval",
    approvalFingerprint: HASH,
    nonceDigest: OTHER_HASH,
    projectId: IDS.project,
    vaultId: IDS.vault,
    storeId: IDS.store,
    workspaceId: HASH,
    sessionId: IDS.session,
    expectedOwnerGeneration: "1",
    commandId: IDS.command,
    idempotencyKey: IDEMPOTENCY_KEY,
    intentHash: OTHER_HASH,
    executorActorRole: "primary",
    executorClientInstanceId: "codex/client-a",
    targetActorRole: "primary",
    targetClientInstanceId: "codex/client-a",
    issuedAt: "2026-07-17T00:00:00.000Z",
    expiresAt: "2026-07-17T00:10:00.000Z",
    redactedApprovalReference: "approval/redacted",
  };
}

function semanticAuthorizationFor(
  command: Readonly<Record<string, unknown>>,
  childBindingGrant: ChildBindingGrantV1 | null = null,
): SemanticCommandAuthorization {
  const commandType = command.commandType;
  if (commandType === "root-start") return initialAuthorization();

  let authoritySessionId: string = IDS.session;
  let targetSessionId: string = IDS.session;
  if ([
    "amend-child-assignment",
    "disposition-child-report",
    "complete-child-session",
    "suspend-child-session",
    "create-child-transfer",
  ].includes(String(commandType))) {
    targetSessionId = IDS.work;
  } else if (["record-child-report", "propose-child-completion"].includes(String(commandType))) {
    authoritySessionId = IDS.work;
    targetSessionId = IDS.work;
  }

  const authorization = {
    kind: "protected" as const,
    authoritySessionId: authoritySessionId as never,
    targetSessionId: targetSessionId as never,
    proof,
    approval: null,
    childBindingGrant,
  };
  if (commandType === "root-recovery") {
    return {
      ...authorization,
      proof: null,
      approval: lifecycleApproval("recover-root-authority") as never,
    };
  }
  if (commandType === "abandon-session") {
    return {
      ...authorization,
      approval: lifecycleApproval("abandon-root") as never,
    };
  }
  return authorization;
}

function semanticCommandCases(version: 1 | 2 = 1): readonly Readonly<Record<string, unknown>>[] {
  return [
    { ...commandBase("root-start"), continuityKey: "thread:stable", resumePolicy: "new" },
    {
      ...commandBase("root-resume"),
      sessionId: IDS.session,
      continuityKey: "thread:stable",
      resumePolicy: "exact",
      expectedOwnerGeneration: "1",
    },
    {
      ...commandBase("root-recovery"),
      sessionId: IDS.session,
      expectedOwnerGeneration: "1",
      preTransitionCheckpointId: IDS.grant,
      reasonCode: "credential-loss",
    },
    {
      ...commandBase("root-suspend"),
      sessionId: IDS.session,
      expectedStreamVersion: "1",
      checkpoint: checkpointDraft(version),
    },
    {
      ...commandBase("fork-child"),
      parentSessionId: IDS.session,
      expectedStreamVersion: "1",
      assignment: { assignmentId: IDS.work, summary: "Inspect lifecycle", scope: "src/orchestrator" },
      directAccessRequested: false,
    },
    {
      ...commandBase("amend-child-assignment"),
      parentSessionId: IDS.session,
      childSessionId: IDS.work,
      expectedStreamVersion: "2",
      expectedAssignmentRevision: "1",
      assignment: { assignmentId: IDS.work, summary: "Inspect strict protocol", scope: "src/orchestrator" },
      reasonCode: "scope-refined",
    },
    {
      ...commandBase("record-checkpoint"),
      sessionId: IDS.session,
      expectedStreamVersion: "2",
      expectedBaseEventPosition: "4",
      draft: checkpointDraft(version),
    },
    {
      ...commandBase("record-evidence-batch"),
      adapterSessionId: IDS.work,
      batchId: IDS.grant,
      sessionId: IDS.session,
      firstOrdinal: "0",
      lastOrdinal: "0",
      fingerprintSchemaVersion: 1,
      fingerprintKeyId: "evidence-key-1",
      fingerprintDomain: "pm-evidence-frame-v1",
      redactionStatus: "content-not-retained",
      frames: [{
        frameId: IDS.nonce,
        ordinal: "0",
        sourceKind: "tool-result",
        observedAt: "2026-07-17T00:00:00.000Z",
        contentFingerprint: HASH,
      }],
    },
    {
      ...commandBase("record-child-report"),
      parentSessionId: IDS.session,
      childSessionId: IDS.work,
      childAuthorAgentId: "agent-child",
      expectedStreamVersion: "2",
      report: reportDraft(),
    },
    {
      ...commandBase("disposition-child-report"),
      parentSessionId: IDS.session,
      childSessionId: IDS.work,
      expectedStreamVersion: "2",
      disposition: acceptedDisposition(),
    },
    {
      ...commandBase("propose-child-completion"),
      childSessionId: IDS.work,
      expectedStreamVersion: "2",
      reportId: IDS.grant,
    },
    {
      ...commandBase("complete-child-session"),
      parentSessionId: IDS.session,
      childSessionId: IDS.work,
      expectedStreamVersion: "2",
      reportId: IDS.grant,
    },
    {
      ...commandBase("suspend-child-session"),
      parentSessionId: IDS.session,
      childSessionId: IDS.work,
      expectedStreamVersion: "2",
      checkpointId: IDS.grant,
      blockers: [],
      followUps: [],
    },
    {
      ...commandBase("create-child-transfer"),
      parentSessionId: IDS.session,
      childSessionId: IDS.work,
      expectedStreamVersion: "2",
      checkpointId: IDS.grant,
    },
    {
      ...commandBase("claim-child-transfer"),
      rootSessionId: IDS.session,
      transferTicketId: IDS.work,
      expectedStreamVersion: "2",
    },
    { ...commandBase("request-session-end"), request: endRequest(version) },
    {
      ...commandBase("amend-session-end"),
      sessionId: IDS.session,
      workflowId: IDS.workflow,
      expectedStreamVersion: "2",
      amendment: endAmendment(version),
    },
    {
      ...commandBase("cancel-session-end"),
      sessionId: IDS.session,
      workflowId: IDS.workflow,
      expectedStreamVersion: "2",
      preTransitionCheckpointId: IDS.grant,
    },
    {
      ...commandBase("abandon-session"),
      sessionId: IDS.session,
      expectedStreamVersion: "2",
      preTransitionCheckpointId: IDS.grant,
      reasonCode: "explicit-user-approval",
    },
  ];
}

function initialAuthorization(): SemanticCommandAuthorization {
  return {
    kind: "initial-authority",
    authoritySessionId: null,
    targetSessionId: null,
    proof: null,
    approval: null,
    childBindingGrant: null,
  };
}

function protectedAuthorization(
  childBindingGrant: ChildBindingGrantV1 | null = null,
): SemanticCommandAuthorization {
  return {
    kind: "protected",
    authoritySessionId: IDS.session as never,
    targetSessionId: IDS.session as never,
    proof,
    approval: null,
    childBindingGrant,
  };
}

function prepared(
  command: Record<string, unknown>,
  authorization: SemanticCommandAuthorization,
): Record<string, unknown> {
  return { command, candidateIntentHash: OTHER_HASH, authorization };
}

function bindingAssertion(): Record<string, unknown> {
  return {
    projectId: IDS.project,
    vaultId: IDS.vault,
    storeId: IDS.store,
    bindingGeneration: 1,
    contextFingerprint: HASH,
  };
}

function activeContext(): ProjectContext {
  const workspace = {
    kind: "non-git" as const,
    workspaceRoot: "C:\\runtime-project",
    workspaceId: HASH as never,
  };
  return {
    binding: {
      projectBindingId: IDS.grant,
      generation: 1,
      contextFingerprint: HASH,
      source: "explicit-cli",
      projectId: IDS.project,
      vaultId: IDS.vault,
      storeId: IDS.store,
      workspaceId: HASH,
      clientNamespace: "codex",
      actorRole: "primary",
      clientInstanceId: "codex/client-a",
      projectRoot: "C:\\runtime-project",
      vaultRoot: "C:\\runtime-project\\memory",
      descriptorPath: "C:\\runtime-project\\memory\\.project-memory.json",
      storeRoute: {
        kind: "vault-local",
        storeRoot: "C:\\runtime-project\\memory\\.memory-mcp",
        eventsPath: "C:\\runtime-project\\memory\\.memory-mcp\\events.sqlite",
        storeManifestPath: "C:\\runtime-project\\memory\\.memory-mcp\\store.json",
        projectionManifestPath: "C:\\runtime-project\\memory\\.memory-mcp\\projection.json",
      },
      workspace,
      establishedAt: "2026-07-17T00:00:00.000Z",
    },
    workspace,
    checkedAt: "2026-07-17T00:00:00.000Z",
  } as unknown as ProjectContext;
}

function checkpointResult(version: 1 | 2): Record<string, unknown> {
  return {
    checkpointVersion: version,
    checkpointId: IDS.work,
    sessionId: IDS.session,
    baseEventPosition: "4",
    checkpointEventPosition: "5",
    finalStreamVersion: "3",
    checkpointRequiredCleared: true,
  };
}

function endStatus(): Record<string, unknown> {
  return {
    resultVersion: 2,
    sessionId: IDS.session,
    workflowId: IDS.workflow,
    workflowGeneration: 1,
    phase: "requested",
    priorRootState: "active",
    triggeringEventPosition: "4",
    finalCheckpointId: null,
    finalCheckpointEventPosition: null,
    evidenceWindow: {
      evidenceWindowState: "sealed",
      evidenceFrozenCheckpointEventPosition: null,
      evidenceFrozenGeneration: null,
    },
    validationPlansReady: false,
    qualityScore: null,
    safeFailureCode: null,
    materializationRequired: true,
  };
}

function rootResult(operation = "root-start"): Record<string, unknown> {
  const suspended = operation === "root-suspend";
  return {
    resultVersion: 2,
    project: {
      projectId: IDS.project,
      vaultId: IDS.vault,
      storeId: IDS.store,
      workspaceId: HASH,
      clientNamespace: "codex",
    },
    sessionId: IDS.session,
    ownerGeneration: operation === "root-resume" || operation === "root-recovery" ? "2" : "1",
    continuityKey: "thread:stable",
    state: suspended ? "suspended" : "active",
    resumedFromSessionId: operation === "root-resume" ? IDS.session : null,
    latestCheckpointEventPosition: suspended ? "3" : null,
    eventPosition: suspended ? "5" : "1",
    handleIssued: true,
    resumeTokenIssued: true,
    contextPackUnavailable: true,
  };
}

function semanticSuccess(publicResult: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: "success",
    publicResult,
    authorityMaterial: {
      status: "not-issued",
      target: null,
      authorityCommitment: null,
      capabilityGeneration: null,
      descriptor: null,
      recoveryCode: null,
    },
  };
}

function checkpointRequested(version: 1 | 2): LifecycleWorkerOperationWire {
  return {
    kind: "semantic",
    operation: "record-checkpoint",
    prepared: {
      command: {
        ...commandBase("record-checkpoint"),
        sessionId: IDS.session,
        expectedStreamVersion: "2",
        expectedBaseEventPosition: "4",
        draft: { checkpointVersion: version },
      },
      candidateIntentHash: OTHER_HASH,
      authorization: protectedAuthorization(),
    },
  } as unknown as LifecycleWorkerOperationWire;
}

function requestEndRequested(version: 1 | 2): LifecycleWorkerOperationWire {
  return {
    kind: "semantic",
    operation: "request-session-end",
    prepared: {
      command: {
        ...commandBase("request-session-end"),
        request: endRequest(version),
      },
      candidateIntentHash: OTHER_HASH,
      authorization: protectedAuthorization(),
    },
  } as unknown as LifecycleWorkerOperationWire;
}

function internalValidationCommand(): Record<string, unknown> {
  const plannedWorkId = HASH;
  const finalCheckpointFingerprint = OTHER_HASH;
  const profileConfigurationHash = "c".repeat(64);
  const sourceState = {
    sourceStateScopeVersion: 1,
    workspaceId: HASH,
    branchRef: "refs/heads/main",
    headCommit: "d".repeat(40),
    dirtyWorktreeFingerprint: "e".repeat(64),
  };
  const attemptPlan = {
    attemptPlanVersion: 1,
    projectId: IDS.project,
    vaultId: IDS.vault,
    storeId: IDS.store,
    workspaceId: HASH,
    sessionId: IDS.session,
    workflowId: IDS.workflow,
    workflowGeneration: 1,
    plannedWorkId,
    finalCheckpointId: IDS.work,
    finalCheckpointFingerprint,
    profileId: "vault-gate",
    profileVersion: 1,
    profileConfigurationHash,
    runId: IDS.nonce,
    resultId: IDS.grant,
    resultCommandId: IDS.command,
    resultIdempotencyKey: IDEMPOTENCY_KEY,
  };
  return {
    ...commandBase("internal-validation-result"),
    workflowId: IDS.workflow,
    workflowGeneration: 1,
    plannedWorkId,
    attemptPlan,
    claim: {
      workflowId: IDS.workflow,
      workflowGeneration: 1,
      claimOwnerId: IDS.work,
      claimToken: "1",
      claimExpiresAt: "2026-07-17T00:10:00.000Z",
    },
    result: {
      validationResultVersion: 1,
      resultId: IDS.grant,
      projectId: IDS.project,
      vaultId: IDS.vault,
      storeId: IDS.store,
      workspaceId: HASH,
      sessionId: IDS.session,
      workflowId: IDS.workflow,
      workflowGeneration: 1,
      finalCheckpointId: IDS.work,
      finalCheckpointFingerprint,
      profileId: "vault-gate",
      profileVersion: 1,
      profileConfigurationHash,
      runId: IDS.nonce,
      runnerId: IDS.work,
      sourceStateAtStart: sourceState,
      sourceStateAtCompletion: sourceState,
      startedAt: "2026-07-17T00:00:00.000Z",
      completedAt: "2026-07-17T00:00:01.000Z",
      status: "pass",
      exitClassification: "passed",
      summary: "Trusted validation passed",
      outputFingerprint: {
        fingerprintSchemaVersion: 1,
        fingerprintKeyId: "validation-key-1",
        fingerprintDomain: "pm-validation-output-v1",
        fingerprint: HASH,
      },
      artifactReferences: [],
      fresh: true,
    },
  };
}

type TestCapabilityKind =
  | "root-session-handle"
  | "root-resume-token"
  | "child-session-handle";

interface TestAuthorityScope {
  readonly projectId: string;
  readonly vaultId: string;
  readonly storeId: string;
  readonly workspaceId: string;
  readonly clientNamespace: string;
  readonly sessionId: string;
  readonly capabilityGeneration: string;
}

const EXPECTED_ROOT_AUTHORITY_SCOPE: TestAuthorityScope = Object.freeze({
  projectId: IDS.project,
  vaultId: IDS.vault,
  storeId: IDS.store,
  workspaceId: HASH,
  clientNamespace: "codex",
  sessionId: IDS.session,
  capabilityGeneration: "1",
});

function currentAuthorityMaterial(
  scope: TestAuthorityScope,
  kinds: readonly TestCapabilityKind[],
): Record<string, unknown> {
  const target = kinds.includes("child-session-handle")
    ? { actorRole: "untrusted", clientInstanceId: "child/client-a" }
    : { actorRole: "primary", clientInstanceId: "codex/client-a" };
  const materials = kinds.map((kind, index) => ({
    claims: {
      capabilityVersion: 1,
      keyId: `capability-key-${index + 1}`,
      ...scope,
      kind,
      issuedAt: "2026-07-17T00:00:00.000Z",
      policyCode: kind === "child-session-handle" ? "child-default-v1" : "root-current",
      expiryKind: "until-revoked",
      expiresAt: null,
      issueNonce: index === 0 ? HASH : OTHER_HASH,
      actorRole: kind === "child-session-handle" ? "untrusted" : "primary",
      clientInstanceId: kind === "root-resume-token" ? null : target.clientInstanceId,
    },
    verifier: index === 0 ? HASH : OTHER_HASH,
  }));
  return {
    status: "current",
    target,
    authorityCommitment: OTHER_HASH,
    capabilityGeneration: scope.capabilityGeneration,
    descriptor: {
      descriptorVersion: 1,
      authorityCommitment: OTHER_HASH,
      capabilityGeneration: scope.capabilityGeneration,
      target,
      materials,
    },
    recoveryCode: null,
  };
}

function rootStartOperationWire(): Record<string, unknown> {
  const command = semanticCommandCases().find((candidate) => candidate.commandType === "root-start");
  assert.ok(command);
  return {
    kind: "semantic",
    operation: "root-start",
    prepared: prepared(command as Record<string, unknown>, initialAuthorization()),
  };
}

function lifecycleRequestEnvelope(
  id: string = IDS.work,
  operation: Record<string, unknown> = rootStartOperationWire(),
): Record<string, unknown> {
  return {
    id,
    type: "lifecycle",
    binding: bindingAssertion(),
    operation,
  };
}

function childResult(operation: string): Record<string, unknown> {
  const state = operation === "propose-child-completion"
    ? "completion-proposed"
    : operation === "complete-child-session"
      ? "completed"
      : operation === "suspend-child-session"
        ? "transferred"
        : "active";
  const finalStreamVersion = operation === "fork-child"
    ? "1"
    : operation === "suspend-child-session"
      ? "4"
      : operation === "claim-child-transfer"
        ? "2"
        : "3";
  const common = {
    resultVersion: 2,
    operation,
    childSessionId: IDS.work,
    parentSessionId: IDS.session,
    state,
    eventPosition: "2",
    finalStreamVersion,
  };
  const assignment = operation === "fork-child"
    ? {
        assignmentId: IDS.work,
        summary: "Inspect lifecycle",
        scope: "src/orchestrator",
      }
    : operation === "amend-child-assignment"
      ? {
          assignmentId: IDS.work,
          summary: "Inspect strict protocol",
          scope: "src/orchestrator",
        }
      : {
          assignmentId: IDS.nonce,
          summary: "Inspect lifecycle protocol",
          scope: "src/orchestrator/runtime",
        };
  switch (operation) {
    case "fork-child":
      return { ...common, directAccessEnabled: false, rootOwnerGeneration: "1", assignment, assignmentRevision: "1" };
    case "amend-child-assignment":
      return { ...common, assignment, assignmentRevision: "2" };
    case "record-child-report":
      return { ...common, assignmentRevision: "1", reportId: IDS.grant, reportItemIds: [] };
    case "disposition-child-report":
      return { ...common, disposition: { kind: "accepted", reportId: IDS.grant } };
    case "propose-child-completion":
    case "complete-child-session":
      return { ...common, reportId: IDS.grant };
    case "suspend-child-session":
      return { ...common, assignment, assignmentRevision: "1", transferTicketId: IDS.grant };
    case "claim-child-transfer":
      return {
        ...common,
        previousChildSessionId: IDS.nonce,
        transferTicketId: IDS.work,
        assignment,
        assignmentRevision: "1",
        directAccessEnabled: false,
        rootOwnerGeneration: "1",
      };
    default:
      throw new Error(`Unknown child result operation: ${operation}`);
  }
}

function evidenceResult(): Record<string, unknown> {
  return {
    resultVersion: 2,
    operation: "record-evidence-batch",
    sessionId: IDS.session,
    adapterSessionId: IDS.work,
    batchId: IDS.grant,
    batchFirstOrdinal: "0",
    batchLastOrdinal: "0",
    coverageFirstOrdinal: "0",
    coverageLastOrdinal: "0",
    highestContiguousOrdinal: "0",
    missingIntervals: [],
    captureMode: "coverage-only",
    contentRetained: false,
    eventPosition: "2",
    finalStreamVersion: "2",
  };
}

function validationRecordedResult(): Record<string, unknown> {
  return {
    resultVersion: 1,
    resultId: IDS.grant,
    workflowId: IDS.workflow,
    workflowGeneration: 1,
    eventPosition: "2",
    finalStreamVersion: "2",
  };
}

function phaseResult(): Record<string, unknown> {
  return {
    resultVersion: 2,
    action: "mark-children-resolved",
    progressed: true,
    previousPhase: "requested",
    status: endStatus(),
  };
}

function leaseResult(): Record<string, unknown> {
  return {
    resultVersion: 1,
    operationId: IDS.command,
    requestId: IDS.work,
    sessionId: IDS.session,
    ownerGeneration: "1",
    lastObservedAt: "2026-07-17T00:00:00.000Z",
    expiresAt: "2026-07-17T00:10:00.000Z",
  };
}

function sessionSummary(kind: "root" | "child" = "root"): Record<string, unknown> {
  return {
    sessionId: kind === "root" ? IDS.session : IDS.work,
    sessionKind: kind,
    parentSessionId: kind === "root" ? null : IDS.session,
    state: "active",
    ownerGeneration: kind === "root" ? "1" : null,
    childCapabilityGeneration: kind === "child" ? "1" : null,
    authorityClientInstanceId: "codex/client-a",
    directAccessEnabled: false,
    streamVersion: "1",
    eventPosition: "1",
    latestCheckpointEventPosition: null,
    checkpointRequired: false,
  };
}

function queryResult(operation: string): Record<string, unknown> {
  if (operation === "read-session-tree") {
    return {
      resultVersion: 1,
      operation,
      operationId: IDS.command,
      requestId: IDS.work,
      root: sessionSummary(),
      children: [sessionSummary("child")],
      childrenTruncated: false,
    };
  }
  if (operation === "read-session-status") {
    return {
      resultVersion: 1,
      operation,
      operationId: IDS.command,
      requestId: IDS.work,
      session: sessionSummary(),
    };
  }
  return {
    resultVersion: 1,
    operation: "read-session-association",
    operationId: IDS.command,
    requestId: IDS.work,
    associated: true,
    sessionId: IDS.work,
    rootSessionId: IDS.session,
  };
}

function workflowClaimResult(): Record<string, unknown> {
  return {
    resultVersion: 1,
    projectId: IDS.project,
    workflowId: IDS.workflow,
    sessionId: IDS.session,
    workflowGeneration: 2,
    phase: "requested",
    ownerId: "coordinator-a",
    claimToken: "7",
    claimExpiresAt: "2026-07-17T00:10:00.000Z",
    triggeringEventPosition: "1",
    attemptCount: 0,
  };
}

function recoveryResult(): Record<string, unknown> {
  return {
    resultVersion: 1,
    integrityOk: true,
    readOnly: false,
    workflowCandidateCount: 0,
    outboxCandidateCount: 0,
    endingSessionCount: 0,
    expiredRootLeaseCount: 0,
    invariantFailureCodes: [],
  };
}

function outboxClaimResult(): Record<string, unknown> {
  return {
    resultVersion: 1,
    projectId: IDS.project,
    targetKey: "memory/session.md",
    sessionId: IDS.session,
    artifactPath: "memory/session.md",
    originKind: "workflow",
    workflowId: IDS.workflow,
    workflowGeneration: 2,
    materializationRevision: "3",
    triggeringEventPosition: "3",
    ownerId: "materializer-a",
    claimToken: "7",
    claimExpiresAt: "2026-07-17T00:10:00.000Z",
    attemptCount: 0,
  };
}

function materializationResult(): Record<string, unknown> {
  return {
    resultVersion: 1,
    status: "completed",
    targetKey: "memory/session.md",
    artifactPath: "memory/session.md",
    materializationRevision: "3",
    fingerprint: {
      algorithm: "hmac-sha256",
      schemaVersion: 1,
      keyId: "materialization-key-1",
      domain: "pm-materialization-fingerprint-v1",
      value: HASH,
    },
    acknowledged: true,
  };
}

function semanticPublicResult(operation: string): Record<string, unknown> {
  if (["root-start", "root-resume", "root-recovery", "root-suspend"].includes(operation)) {
    return rootResult(operation);
  }
  if ([
    "fork-child",
    "amend-child-assignment",
    "record-child-report",
    "disposition-child-report",
    "propose-child-completion",
    "complete-child-session",
    "suspend-child-session",
    "claim-child-transfer",
  ].includes(operation)) return childResult(operation);
  if (operation === "record-checkpoint") return checkpointResult(1);
  if (operation === "record-evidence-batch") return evidenceResult();
  if (["request-session-end", "amend-session-end", "cancel-session-end", "abandon-session"].includes(operation)) {
    return endStatus();
  }
  throw new Error(`Unknown executable semantic result operation: ${operation}`);
}

function resultForOperation(operation: string): Record<string, unknown> | boolean | null {
  if (["root-start", "root-resume", "root-recovery", "root-suspend"].includes(operation)) {
    return semanticSuccess(rootResult(operation));
  }
  if ([
    "fork-child",
    "amend-child-assignment",
    "record-child-report",
    "disposition-child-report",
    "propose-child-completion",
    "complete-child-session",
    "suspend-child-session",
    "claim-child-transfer",
  ].includes(operation)) return semanticSuccess(childResult(operation));
  if (operation === "create-child-transfer") {
    return { kind: "rejected", errorCode: "LIFECYCLE_OPERATION_UNAVAILABLE" };
  }
  if (operation === "record-checkpoint") return semanticSuccess(checkpointResult(1));
  if (operation === "record-evidence-batch") return semanticSuccess(evidenceResult());
  if (["request-session-end", "amend-session-end", "cancel-session-end", "abandon-session"].includes(operation)) {
    return semanticSuccess(endStatus());
  }
  if (operation === "internal-validation-result") return validationRecordedResult();
  if (operation === "internal-workflow-phase") return phaseResult();
  if (operation === "workflow-eventless-phase") {
    return {
      ...phaseResult(),
      status: {
        ...endStatus(),
        workflowGeneration: 2,
        phase: "children-resolved",
      },
    };
  }
  if (operation === "renew-root-lease") return leaseResult();
  if (operation.startsWith("read-session-")) return queryResult(operation);
  if (["workflow-claim-next", "workflow-claim", "workflow-renew"].includes(operation)) {
    return workflowClaimResult();
  }
  if (operation === "workflow-release" || operation === "outbox-failure") return true;
  if (operation === "workflow-recovery") return recoveryResult();
  if (["outbox-claim-next", "outbox-claim", "outbox-renew"].includes(operation)) {
    return outboxClaimResult();
  }
  if (operation === "outbox-materialize") return materializationResult();
  throw new Error(`Unknown result operation: ${operation}`);
}

function internalPhasePlan(
  version: 1 | 2 = 1,
  checkpoint = true,
): Record<string, unknown> {
  return {
    ...commandBase("internal-workflow-phase"),
    workflowId: IDS.workflow,
    workflowGeneration: 2,
    sourcePhase: "children-resolved",
    plannedWorkId: HASH,
    claim: {
      workflowId: IDS.workflow,
      workflowGeneration: 2,
      claimOwnerId: IDS.work,
      claimToken: "7",
      claimExpiresAt: "2026-07-17T00:10:00.000Z",
    },
    plannedAction: checkpoint
      ? {
          action: "prepare-final-checkpoint-and-queue-ending",
          finalCheckpointDraft: checkpointDraft(version),
          materializationTarget: "memory/session.md",
        }
      : {
          action: "record-verification-failed",
          validationResultIds: [],
          safeFailureCode: "SESSION_VALIDATION_RESULT_INVALID",
        },
  };
}

function authoritativePhaseCommand(
  version: 1 | 2 = 1,
  checkpoint = true,
): Record<string, unknown> {
  const plan = internalPhasePlan(version, checkpoint);
  const { plannedAction: _plannedAction, ...command } = plan;
  return {
    ...command,
    action: checkpoint
      ? {
          action: "record-final-checkpoint-and-queue-ending",
          finalCheckpoint: { checkpointVersion: version },
          materializationTarget: "memory/session.md",
        }
      : {
          action: "record-verification-failed",
          validationResultIds: [],
          safeFailureCode: "SESSION_VALIDATION_RESULT_INVALID",
        },
  };
}

function fencedOperationInputs(): readonly Readonly<Record<string, unknown>>[] {
  const workflowTarget = {
    workId: IDS.work,
    ownerId: "coordinator-a",
    fencingToken: "7",
    workflowId: IDS.workflow,
    workflowGeneration: 2,
  };
  const outboxTarget = {
    workId: IDS.work,
    ownerId: "materializer-a",
    fencingToken: "7",
    targetKey: "memory/session.md",
    materializationRevision: "3",
  };
  return [
    {
      operation: "workflow-claim-next",
      workId: IDS.work,
      ownerId: "coordinator-a",
      observedNowMs: "1",
      ttlMs: "30",
    },
    { operation: "workflow-claim", ...workflowTarget, leaseUntil: "2026-07-17T00:10:00.000Z" },
    { operation: "workflow-renew", ...workflowTarget, leaseUntil: "2026-07-17T00:10:00.000Z" },
    { operation: "workflow-release", ...workflowTarget },
    {
      operation: "workflow-eventless-phase",
      ...workflowTarget,
      expectedPhase: "requested",
      nextPhase: "children-resolved",
    },
    {
      operation: "workflow-recovery",
      workId: IDS.work,
      ownerId: "coordinator-a",
      fencingToken: "7",
      dueBefore: "2026-07-17T00:10:00.000Z",
      limit: 10,
    },
    {
      operation: "outbox-claim-next",
      workId: IDS.work,
      ownerId: "materializer-a",
      observedNowMs: "1",
      ttlMs: "30",
    },
    { operation: "outbox-claim", ...outboxTarget, leaseUntil: "2026-07-17T00:10:00.000Z" },
    { operation: "outbox-renew", ...outboxTarget, leaseUntil: "2026-07-17T00:10:00.000Z" },
    { operation: "outbox-materialize", ...outboxTarget },
    {
      operation: "outbox-failure",
      ...outboxTarget,
      retryable: true,
      safeErrorCode: "STORE_UNAVAILABLE",
      attempt: 1,
      nextAttemptAt: null,
    },
  ];
}

function allOperationWireCases(): readonly Readonly<Record<string, unknown>>[] {
  const semantic = semanticCommandCases().map((command) => ({
    kind: "semantic",
    operation: command.commandType,
    prepared: prepared(command as Record<string, unknown>, semanticAuthorizationFor(command)),
  }));
  const boundedAndQueries = [boundedInput, queryInput, {
    ...queryInput,
    operation: "read-session-tree",
  }, {
    ...queryInput,
    operation: "read-session-association",
    authorization: {
      ...queryInput.authorization,
      authoritySessionId: IDS.work,
      targetSessionId: IDS.work,
    },
    sessionId: IDS.work,
  }].map((input) => ({
    kind: input.operation === "renew-root-lease" ? "bounded" : "query",
    operation: input.operation,
    input,
  }));
  return [
    ...semantic,
    {
      kind: "internal-semantic",
      operation: "internal-validation-result",
      command: internalValidationCommand(),
    },
    {
      kind: "internal-semantic",
      operation: "internal-workflow-phase",
      command: internalPhasePlan(),
    },
    ...boundedAndQueries,
    ...fencedOperationInputs().map((input) => ({
      kind: "fenced",
      operation: input.operation,
      input,
    })),
  ];
}

function expectSafeFailure(action: () => unknown, canaries: readonly string[] = []): void {
  assert.throws(action, (error: unknown) => {
    const rendered = `${String(error)} ${JSON.stringify(error)}`;
    for (const canary of canaries) assert.equal(rendered.includes(canary), false);
    return error instanceof Error;
  });
}

function expectSafeLifecycleFailure(
  code: string,
  action: () => unknown,
  canaries: readonly string[],
): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof LifecycleError);
    assert.equal(error.code, code);
    const surfaces = [
      String(error),
      JSON.stringify(error.details),
      JSON.stringify(error.toJSON()),
      JSON.stringify({ id: IDS.work, ok: false, error: error.toJSON() }),
    ];
    for (const surface of surfaces) {
      for (const canary of canaries) assert.equal(surface.includes(canary), false);
    }
    return true;
  });
}

function expectLifecycleField(action: () => unknown, field: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof LifecycleError);
    assert.equal(error.code, "WORKER_PROTOCOL_ERROR");
    assert.equal(error.details.field, field);
    return true;
  });
}

function canonicalJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function exactByteEnvelope<T>(factory: (padding: string) => T): readonly [T, string] {
  const emptyBytes = canonicalJsonBytes(factory(""));
  const padding = "x".repeat(MAX_LIFECYCLE_WIRE_CANONICAL_BYTES - emptyBytes);
  const envelope = factory(padding);
  assert.equal(canonicalJsonBytes(envelope), MAX_LIFECYCLE_WIRE_CANONICAL_BYTES);
  return [envelope, padding] as const;
}

function withOwnProtoDataProperty<T extends object>(target: T, value: unknown): T {
  Object.defineProperty(target, "__proto__", {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return target;
}

describe("lifecycle worker protocol", () => {
  it("rejects mixed nested checkpoint and request versions", () => {
    const expectedOperations = [
      "abandon-session",
      "amend-child-assignment",
      "amend-session-end",
      "cancel-session-end",
      "claim-child-transfer",
      "complete-child-session",
      "create-child-transfer",
      "disposition-child-report",
      "fork-child",
      "internal-validation-result",
      "internal-workflow-phase",
      "outbox-claim",
      "outbox-claim-next",
      "outbox-failure",
      "outbox-materialize",
      "outbox-renew",
      "propose-child-completion",
      "read-session-association",
      "read-session-status",
      "read-session-tree",
      "record-checkpoint",
      "record-child-report",
      "record-evidence-batch",
      "renew-root-lease",
      "request-session-end",
      "root-recovery",
      "root-resume",
      "root-start",
      "root-suspend",
      "suspend-child-session",
      "workflow-claim",
      "workflow-claim-next",
      "workflow-eventless-phase",
      "workflow-recovery",
      "workflow-release",
      "workflow-renew",
    ];
    const decodedOperations = allOperationWireCases().map((wire) =>
      decodeLifecycleWorkerOperationWire(wire).operation);
    assert.deepEqual([...decodedOperations].sort(), expectedOperations);

    const decodedRequests = allOperationWireCases().map((wire) =>
      decodeLifecycleWorkerOperationWire(wire));
    for (const requested of decodedRequests) {
      const decoded = decodeLifecycleWorkerSuccessForOperation({
        operation: requested.operation,
        nestedContractVersion: lifecycleNestedContractVersion(requested),
        result: resultForOperation(requested.operation),
      }, requested);
      assert.equal(decoded.operation, requested.operation);
    }

    for (const operation of [
      "workflow-claim-next",
      "workflow-claim",
      "outbox-claim-next",
      "outbox-claim",
    ]) {
      const requested = decodedRequests.find((candidate) => candidate.operation === operation);
      assert.ok(requested);
      assert.equal(decodeLifecycleWorkerSuccessForOperation({
        operation,
        nestedContractVersion: null,
        result: null,
      }, requested).result, null);
    }
    for (const operation of ["workflow-renew", "outbox-renew"]) {
      const requested = decodedRequests.find((candidate) => candidate.operation === operation);
      assert.ok(requested);
      assert.throws(() => decodeLifecycleWorkerSuccessForOperation({
        operation,
        nestedContractVersion: null,
        result: null,
      }, requested));
    }

    const nestedVersionOperations = new Set([
      "root-suspend",
      "record-checkpoint",
      "request-session-end",
      "amend-session-end",
    ]);
    for (const command of semanticCommandCases(2)) {
      if (!nestedVersionOperations.has(String(command.commandType))) continue;
      const wire = decodeLifecycleWorkerOperationWire({
        kind: "semantic",
        operation: command.commandType,
        prepared: prepared(command as Record<string, unknown>, semanticAuthorizationFor(command)),
      });
      assert.equal(lifecycleNestedContractVersion(wire), 2, String(command.commandType));
      assert.doesNotThrow(() => decodeLifecycleWorkerSuccessForOperation({
        operation: wire.operation,
        nestedContractVersion: 2,
        result: wire.operation === "record-checkpoint"
          ? semanticSuccess(checkpointResult(2))
          : resultForOperation(wire.operation),
      }, wire));
    }

    for (const [requestVersion, checkpointVersion] of [[1, 2], [2, 1]] as const) {
      const inputCanary = `pmcap1.mixed-request-${requestVersion}-checkpoint-${checkpointVersion}`;
      const command = {
        ...commandBase("request-session-end"),
        agentId: inputCanary,
        request: {
          ...endRequest(requestVersion),
          finalCheckpoint: checkpointDraft(checkpointVersion),
        },
      };
      expectSafeLifecycleFailure(
        "LIFECYCLE_INPUT_INVALID",
        () => decodeLifecycleWorkerOperationWire({
          kind: "semantic",
          operation: "request-session-end",
          prepared: prepared(command, semanticAuthorizationFor(command)),
        }),
        [inputCanary],
      );
    }

    const unsupportedCheckpointCommand = {
      ...commandBase("record-checkpoint"),
      sessionId: IDS.session,
      expectedStreamVersion: "2",
      expectedBaseEventPosition: "1",
      draft: { ...checkpointDraft(1), checkpointVersion: 3 },
    };
    expectSafeLifecycleFailure(
      "LIFECYCLE_INPUT_INVALID",
      () => decodeLifecycleWorkerOperationWire({
        kind: "semantic",
        operation: "record-checkpoint",
        prepared: prepared(
          unsupportedCheckpointCommand,
          semanticAuthorizationFor(unsupportedCheckpointCommand),
        ),
      }),
      [],
    );

    const checkpointV1 = checkpointRequested(1);
    assert.deepEqual(
      decodeLifecycleWorkerSuccessForOperation({
        operation: "record-checkpoint",
        nestedContractVersion: 1,
        result: semanticSuccess(checkpointResult(1)),
      }, checkpointV1).result,
      semanticSuccess(checkpointResult(1)),
    );
    assert.throws(() => decodeLifecycleWorkerSuccessForOperation({
      operation: "record-checkpoint",
      nestedContractVersion: 2,
      result: semanticSuccess(checkpointResult(2)),
    }, checkpointV1));
    assert.throws(() => decodeLifecycleWorkerSuccessForOperation({
      operation: "record-checkpoint",
      nestedContractVersion: 3,
      result: semanticSuccess(checkpointResult(1)),
    }, checkpointV1));
    assert.throws(() => decodeLifecycleWorkerSuccessForOperation({
      operation: "record-checkpoint",
      nestedContractVersion: 1,
      result: semanticSuccess(checkpointResult(2)),
    }, checkpointV1));
    assert.throws(() => decodeLifecycleWorkerSuccessForOperation({
      operation: "record-checkpoint",
      nestedContractVersion: 1,
      result: checkpointResult(1),
    }, checkpointV1));
    assert.deepEqual(decodeLifecycleWorkerSuccessForOperation({
      operation: "record-checkpoint",
      nestedContractVersion: 1,
      result: { kind: "rejected", errorCode: "LIFECYCLE_OPERATION_UNAVAILABLE" },
    }, checkpointV1).result, {
      kind: "rejected",
      errorCode: "LIFECYCLE_OPERATION_UNAVAILABLE",
    });
    assert.deepEqual(decodeLifecycleWorkerSuccessForOperation({
      operation: "record-checkpoint",
      nestedContractVersion: 1,
      result: { kind: "unknown", errorCode: "COMMAND_OUTCOME_UNKNOWN" },
    }, checkpointV1).result, {
      kind: "unknown",
      errorCode: "COMMAND_OUTCOME_UNKNOWN",
    });
    assert.throws(() => decodeLifecycleWorkerSuccessForOperation({
      operation: "record-checkpoint",
      nestedContractVersion: 1,
      result: { kind: "unknown", errorCode: "OPERATION_OUTCOME_UNKNOWN" },
    }, checkpointV1));
    assert.throws(() => decodeLifecycleWorkerSuccessForOperation({
      operation: "record-checkpoint",
      nestedContractVersion: 1,
      result: { kind: "rejected", errorCode: "WORKER_PROTOCOL_ERROR" },
    }, checkpointV1));

    const requestV1 = requestEndRequested(1);
    assert.deepEqual(decodeLifecycleWorkerSuccessForOperation({
      operation: "request-session-end",
      nestedContractVersion: 1,
      result: semanticSuccess(endStatus()),
    }, requestV1).result, semanticSuccess(endStatus()));
    assert.throws(() => decodeLifecycleWorkerSuccessForOperation({
      operation: "request-session-end",
      nestedContractVersion: 2,
      result: semanticSuccess(endStatus()),
    }, requestV1));
    assert.throws(() => decodeLifecycleWorkerSuccessForOperation({
      operation: "root-suspend",
      nestedContractVersion: 1,
      result: checkpointResult(1),
    }, checkpointV1));
  });

  it("rejects caller project context on lifecycle operation wires", () => {
    const bounded = decodeLifecycleWorkerOperationWire({
      kind: "bounded",
      operation: "renew-root-lease",
      input: boundedInput,
    });
    const suppliedContext = activeContext();
    const materialized = materializeLifecycleWorkerOperation(bounded, suppliedContext);
    assert.equal("context" in materialized, true);
    const materializedContext = (materialized as { context: ProjectContext }).context;
    assert.notEqual(materializedContext, suppliedContext);
    assert.notEqual(materializedContext.binding, suppliedContext.binding);
    assert.notEqual(materializedContext.workspace, suppliedContext.workspace);
    assert.notEqual(materializedContext.binding.storeRoute, suppliedContext.binding.storeRoute);
    assert.equal(Object.isFrozen(materializedContext), true);
    assert.equal(Object.isFrozen(materializedContext.binding), true);
    assert.equal(Object.isFrozen(materializedContext.workspace), true);
    assert.equal(Object.isFrozen(materializedContext.binding.storeRoute), true);
    suppliedContext.binding.projectId = IDS.work as never;
    suppliedContext.binding.storeRoute.eventsPath = "C:\\attacker\\events.sqlite";
    suppliedContext.workspace.workspaceId = IDS.work as never;
    assert.equal(materializedContext.binding.projectId, IDS.project);
    assert.equal(
      materializedContext.binding.storeRoute.eventsPath,
      "C:\\runtime-project\\memory\\.memory-mcp\\events.sqlite",
    );
    assert.equal(materializedContext.workspace.workspaceId, HASH);
    assert.deepEqual(
      (materialized as { authorization: { audience: unknown } }).authorization.audience,
      {
        presentingActorRole: "primary",
        presentingClientInstanceId: "codex/client-a",
        targetActorRole: "primary",
        targetClientInstanceId: "codex/client-a",
      },
    );

    for (const field of ["context", "binding", "actorRole", "clientInstanceId", "path", "provider"] as const) {
      assert.throws(() => decodeLifecycleWorkerOperationWire({
        kind: "bounded",
        operation: "renew-root-lease",
        input: { ...boundedInput, [field]: "caller-controlled" },
      }), field);
    }
    assert.throws(() => decodeLifecycleWorkerOperationWire({
      kind: "bounded",
      operation: "renew-root-lease",
      input: {
        ...boundedInput,
        authorization: { ...boundedInput.authorization, audience: {} },
      },
    }));
    assert.throws(() => decodeLifecycleWorkerOperationWire({
      kind: "query",
      operation: "read-session-status",
      input: { ...queryInput, context: activeContext() },
    }));
    assert.throws(() => decodeLifecycleWorkerOperationWire({
      kind: "fenced",
      operation: "outbox-materialize",
      input: { ...materializationInput, context: activeContext() },
    }));

    for (const rawWire of allOperationWireCases().filter((wire) =>
      wire.kind === "bounded" || wire.kind === "query" || wire.kind === "fenced")) {
      const rawInput = rawWire.input as Readonly<Record<string, unknown>>;
      for (const field of [
        "context",
        "binding",
        "audience",
        "actorRole",
        "clientInstanceId",
        "path",
        "provider",
      ]) {
        assert.throws(() => decodeLifecycleWorkerOperationWire({
          ...rawWire,
          input: { ...rawInput, [field]: "caller-controlled" },
        }), `${String(rawWire.operation)} rejects ${field}`);
      }
      if (rawWire.kind === "bounded" || rawWire.kind === "query") {
        assert.throws(() => decodeLifecycleWorkerOperationWire({
          ...rawWire,
          input: {
            ...rawInput,
            authorization: {
              ...(rawInput.authorization as Readonly<Record<string, unknown>>),
              audience: { presentingActorRole: "primary" },
            },
          },
        }), `${String(rawWire.operation)} rejects nested audience`);
      }

      const decoded = decodeLifecycleWorkerOperationWire(rawWire);
      const domain = materializeLifecycleWorkerOperation(decoded, activeContext());
      assert.equal(Object.isFrozen(domain), true, `${String(rawWire.operation)} frozen`);
      assert.equal("context" in domain, true, `${String(rawWire.operation)} active context`);
      if (decoded.kind === "bounded" || decoded.kind === "query") {
        assert.deepEqual((domain as { authorization: { audience: unknown } }).authorization.audience, {
          presentingActorRole: "primary",
          presentingClientInstanceId: "codex/client-a",
          targetActorRole: "primary",
          targetClientInstanceId: "codex/client-a",
        });
      }
    }

    const detachedInput = { ...materializationInput };
    const detachedWire = decodeLifecycleWorkerOperationWire({
      kind: "fenced",
      operation: "outbox-materialize",
      input: detachedInput,
    });
    detachedInput.ownerId = "mutated-after-decode";
    if (detachedWire.kind !== "fenced") assert.fail("Expected fenced materialization wire");
    assert.equal(detachedWire.input.ownerId, "materializer-a");

    for (const rawWire of allOperationWireCases()) {
      const payloadKey = rawWire.kind === "semantic"
        ? "prepared"
        : rawWire.kind === "internal-semantic" ? "command" : "input";
      assert.throws(
        () => decodeLifecycleWorkerOperationWire({ ...rawWire, unexpected: true }),
        `${String(rawWire.operation)} unknown outer field`,
      );
      const missingPayload = { ...rawWire };
      delete missingPayload[payloadKey];
      assert.throws(
        () => decodeLifecycleWorkerOperationWire(missingPayload),
        `${String(rawWire.operation)} missing ${payloadKey}`,
      );
      assert.throws(
        () => decodeLifecycleWorkerOperationWire({
          ...rawWire,
          operation: rawWire.operation === "root-start" ? "root-resume" : "root-start",
        }),
        `${String(rawWire.operation)} outer/inner operation mismatch`,
      );
    }

    for (const command of semanticCommandCases()) {
      assert.throws(() => decodeLifecycleWorkerOperationWire({
        kind: "semantic",
        operation: command.commandType,
        prepared: prepared(
          { ...command, unexpected: true },
          semanticAuthorizationFor(command),
        ),
      }), `${String(command.commandType)} command exactness`);
    }

    const selectionOperations = new Set(["workflow-claim-next", "outbox-claim-next"]);
    for (const input of fencedOperationInputs()) {
      const decoded = decodeLifecycleWorkerOperationWire({
        kind: "fenced",
        operation: input.operation,
        input,
      });
      assert.equal(decoded.kind, "fenced");
      if (selectionOperations.has(String(input.operation))) {
        for (const forbidden of [
          "fencingToken",
          "workflowId",
          "workflowGeneration",
          "targetKey",
          "materializationRevision",
        ]) {
          assert.equal(forbidden in decoded.input, false, `${String(input.operation)} ${forbidden}`);
          assert.throws(() => decodeLifecycleWorkerOperationWire({
            kind: "fenced",
            operation: input.operation,
            input: { ...input, [forbidden]: forbidden === "workflowGeneration" ? 1 : "caller-value" },
          }), `${String(input.operation)} forbids ${forbidden}`);
        }
      } else {
        assert.equal("fencingToken" in decoded.input, true, `${String(input.operation)} fencingToken`);
        if (String(input.operation).startsWith("workflow-") && input.operation !== "workflow-recovery") {
          assert.equal("workflowId" in decoded.input, true, `${String(input.operation)} workflowId`);
          assert.equal("workflowGeneration" in decoded.input, true, `${String(input.operation)} generation`);
        }
        if (String(input.operation).startsWith("outbox-")) {
          assert.equal("targetKey" in decoded.input, true, `${String(input.operation)} targetKey`);
          assert.equal(
            "materializationRevision" in decoded.input,
            true,
            `${String(input.operation)} materializationRevision`,
          );
        }
      }
    }

    const validRequest = lifecycleRequestEnvelope();
    const malformedBindings = [
      { ...bindingAssertion(), unexpected: true },
      { ...bindingAssertion(), contextFingerprint: undefined },
      { ...bindingAssertion(), bindingGeneration: 0 },
      { ...bindingAssertion(), bindingGeneration: 1.5 },
      { ...bindingAssertion(), bindingGeneration: Number.MAX_SAFE_INTEGER + 1 },
      { ...bindingAssertion(), projectId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" },
      { ...bindingAssertion(), contextFingerprint: HASH.toUpperCase() },
    ];
    for (const binding of malformedBindings) {
      assert.throws(() => decodeWorkerRequest({ ...validRequest, binding }));
    }

    const malformedOperations: readonly Readonly<Record<string, unknown>>[] = [
      {
        kind: "bounded",
        operation: "renew-root-lease",
        input: { ...boundedInput, expectedOwnerGeneration: Number.MAX_SAFE_INTEGER + 1 },
      },
      {
        kind: "bounded",
        operation: "renew-root-lease",
        input: { ...boundedInput, expectedOwnerGeneration: 1.5 },
      },
      {
        kind: "bounded",
        operation: "renew-root-lease",
        input: { ...boundedInput, operationId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" },
      },
      {
        kind: "fenced",
        operation: "workflow-claim-next",
        input: {
          operation: "workflow-claim-next",
          workId: IDS.work,
          ownerId: "coordinator-a",
          observedNowMs: "01",
          ttlMs: "30",
        },
      },
      {
        kind: "fenced",
        operation: "workflow-claim",
        input: {
          ...(fencedOperationInputs().find((input) => input.operation === "workflow-claim") ?? {}),
          leaseUntil: "2026-07-17T00:10:00Z",
        },
      },
      {
        kind: "fenced",
        operation: "workflow-renew",
        input: {
          ...(fencedOperationInputs().find((input) => input.operation === "workflow-renew") ?? {}),
          workflowGeneration: Number.MAX_SAFE_INTEGER + 1,
        },
      },
    ];
    for (const malformed of malformedOperations) {
      assert.throws(() => decodeLifecycleWorkerOperationWire(malformed));
    }
  });

  it("enforces internal workflow phase and status domain bounds", () => {
    const validationId = (index: number): string =>
      `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
    const validationIds = Array.from({ length: 65 }, (_, index) => validationId(index + 1));
    const phaseWire = (plannedAction: Readonly<Record<string, unknown>>): Record<string, unknown> => ({
      kind: "internal-semantic",
      operation: "internal-workflow-phase",
      command: { ...internalPhasePlan(), plannedAction },
    });

    for (const plannedAction of [
      {
        action: "record-verification-failed",
        validationResultIds: [],
        safeFailureCode: "SESSION_VALIDATION_RESULT_INVALID",
      },
      {
        action: "record-verification-failed",
        validationResultIds: [IDS.work, IDS.work],
        safeFailureCode: "SESSION_VALIDATION_RESULT_INVALID",
      },
      {
        action: "record-verification-failed",
        validationResultIds: validationIds,
        safeFailureCode: "SESSION_VALIDATION_RESULT_INVALID",
      },
    ]) {
      expectLifecycleField(
        () => decodeLifecycleWorkerOperationWire(phaseWire(plannedAction)),
        "operation.command.plannedAction.validationResultIds",
      );
    }
    expectLifecycleField(
      () => decodeLifecycleWorkerOperationWire(phaseWire({
        action: "record-verification-passed",
        validationResultIds: [IDS.work],
        qualityScore: 10_001,
      })),
      "operation.command.plannedAction.qualityScore",
    );
    assert.doesNotThrow(() => decodeLifecycleWorkerOperationWire(phaseWire({
      action: "record-verification-passed",
      validationResultIds: validationIds.slice(0, 64),
      qualityScore: 10_000,
    })));

    const requestedPhase = decodeLifecycleWorkerOperationWire({
      kind: "internal-semantic",
      operation: "internal-workflow-phase",
      command: internalPhasePlan(),
    });
    expectLifecycleField(() => decodeLifecycleWorkerSuccessForOperation({
      operation: "internal-workflow-phase",
      nestedContractVersion: 1,
      result: { ...phaseResult(), status: { ...endStatus(), qualityScore: 10_001 } },
    }, requestedPhase), "success.result.qualityScore");

    const requestCommand = semanticCommandCases().find(
      (command) => command.commandType === "request-session-end",
    );
    assert.ok(requestCommand !== undefined);
    const requestedStatus = decodeLifecycleWorkerOperationWire({
      kind: "semantic",
      operation: "request-session-end",
      prepared: prepared(requestCommand, semanticAuthorizationFor(requestCommand)),
    });
    expectLifecycleField(() => decodeLifecycleWorkerSuccessForOperation({
      operation: "request-session-end",
      nestedContractVersion: 1,
      result: semanticSuccess({ ...endStatus(), qualityScore: 10_001 }),
    }, requestedStatus), "success.result.qualityScore");
  });

  it("enforces child result domain bounds", () => {
    const requestedChild = (
      operation: string,
      suppliedCommand?: Readonly<Record<string, unknown>>,
    ): LifecycleWorkerOperationWire => {
      const command = suppliedCommand ?? semanticCommandCases().find(
        (candidate) => candidate.commandType === operation,
      );
      assert.ok(command !== undefined);
      return decodeLifecycleWorkerOperationWire({
        kind: "semantic",
        operation,
        prepared: prepared(command, semanticAuthorizationFor(command)),
      });
    };
    const decodeChildSuccess = (
      operation: string,
      result: Readonly<Record<string, unknown>>,
      command?: Readonly<Record<string, unknown>>,
    ): LifecycleWorkerSuccessWire => decodeLifecycleWorkerSuccessForOperation({
      operation,
      nestedContractVersion: null,
      result: semanticSuccess(result as Record<string, unknown>),
    }, requestedChild(operation, command));

    for (const field of ["summary", "scope"] as const) {
      const result = childResult("fork-child");
      result.assignment = {
        ...(result.assignment as Readonly<Record<string, unknown>>),
        [field]: "x".repeat(4_001),
      };
      expectLifecycleField(
        () => decodeChildSuccess("fork-child", result),
        `success.result.assignment.${field}`,
      );
    }
    const assignmentBoundary = childResult("fork-child");
    assignmentBoundary.assignment = {
      ...(assignmentBoundary.assignment as Readonly<Record<string, unknown>>),
      summary: "x".repeat(4_000),
      scope: "x".repeat(4_000),
    };
    const forkCommand = semanticCommandCases().find(
      (candidate) => candidate.commandType === "fork-child",
    );
    assert.ok(forkCommand !== undefined);
    assert.doesNotThrow(() => decodeChildSuccess("fork-child", assignmentBoundary, {
      ...forkCommand,
      assignment: assignmentBoundary.assignment,
    }));

    const reportId = (index: number): string =>
      `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
    const reportIds = Array.from({ length: 201 }, (_, index) => reportId(index + 1));
    for (const invalidIds of [reportIds, [IDS.nonce, IDS.nonce]]) {
      expectLifecycleField(
        () => decodeChildSuccess("record-child-report", {
          ...childResult("record-child-report"),
          reportItemIds: invalidIds,
        }),
        "success.result.reportItemIds",
      );
    }
    const reportCommand = semanticCommandCases().find(
      (candidate) => candidate.commandType === "record-child-report",
    );
    assert.ok(reportCommand !== undefined);
    const boundaryReportItem = {
      summary: "Boundary report item",
      evidenceReferences: [],
      confidence: "high",
    };
    assert.doesNotThrow(() => decodeChildSuccess("record-child-report", {
      ...childResult("record-child-report"),
      reportItemIds: reportIds.slice(0, 200),
    }, {
      ...reportCommand,
      report: {
        ...reportDraft(),
        findings: Array.from({ length: 200 }, () => boundaryReportItem),
      },
    }));

    expectLifecycleField(
      () => decodeChildSuccess("fork-child", {
        ...childResult("fork-child"),
        state: "invented-child-state",
      }),
      "success.result.state",
    );
    for (const state of [
      "active",
      "completion-proposed",
      "completed",
      "suspended",
      "transferred",
    ]) {
      assert.doesNotThrow(() => decodeChildSuccess("amend-child-assignment", {
        ...childResult("amend-child-assignment"),
        state,
      }));
    }

    expectLifecycleField(
      () => decodeChildSuccess("disposition-child-report", {
        ...childResult("disposition-child-report"),
        disposition: { kind: "invented-disposition", reportId: IDS.grant },
      }),
      "success.result.disposition.kind",
    );
    const dispositionCommand = semanticCommandCases().find(
      (candidate) => candidate.commandType === "disposition-child-report",
    );
    assert.ok(dispositionCommand !== undefined);
    const dispositionByKind = {
      accepted: acceptedDisposition(),
      "partially-accepted": {
        ...acceptedDisposition(),
        kind: "partially-accepted",
        acceptedItemIds: [IDS.nonce],
        rejectedItemIds: [IDS.work],
        allReportItemIds: [IDS.nonce, IDS.work],
      },
      rejected: {
        ...acceptedDisposition(),
        kind: "rejected",
        acceptedItemIds: [],
        rejectedItemIds: [IDS.nonce],
      },
      superseded: {
        ...acceptedDisposition(),
        kind: "superseded",
        acceptedItemIds: [],
        rejectedItemIds: [IDS.nonce],
        supersededByReportId: IDS.work,
      },
    } as const;
    for (const [kind, disposition] of Object.entries(dispositionByKind)) {
      assert.doesNotThrow(() => decodeChildSuccess("disposition-child-report", {
        ...childResult("disposition-child-report"),
        disposition: { kind, reportId: IDS.grant },
      }, {
        ...dispositionCommand,
        disposition,
      }));
    }
  });

  it("rejects accessor-bearing arrays without invocation or echo", () => {
    const canary = "SECRET_FROM_LIFECYCLE_ARRAY_GETTER";
    let getterCalls = 0;
    const accessorArray = [1];
    Object.defineProperty(accessorArray, "0", {
      enumerable: true,
      configurable: true,
      get: () => {
        getterCalls += 1;
        throw new Error(canary);
      },
    });
    const recovery = fencedOperationInputs().find(
      (input) => input.operation === "workflow-recovery",
    );
    assert.ok(recovery !== undefined);
    expectSafeLifecycleFailure(
      "WORKER_PROTOCOL_ERROR",
      () => decodeLifecycleWorkerOperationWire({
        kind: "fenced",
        operation: "workflow-recovery",
        input: { ...recovery, limit: accessorArray },
      }),
      [canary],
    );
    assert.equal(getterCalls, 0);
  });

  // Production mutation caught: accept shape-valid semantic success with identity from another command.
  it("correlates executable semantic success identities to the requested command", () => {
    const otherId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    type CorrelationCase = Readonly<{
      name: string;
      operation: string;
      field: string;
      mutate: (result: Record<string, unknown>) => Record<string, unknown>;
    }>;
    const cases: readonly CorrelationCase[] = [
      {
        name: "root project",
        operation: "root-start",
        field: "success.result.project.projectId",
        mutate: (result) => ({
          ...result,
          project: { ...(result.project as Record<string, unknown>), projectId: otherId },
        }),
      },
      {
        name: "root vault",
        operation: "root-start",
        field: "success.result.project.vaultId",
        mutate: (result) => ({
          ...result,
          project: { ...(result.project as Record<string, unknown>), vaultId: otherId },
        }),
      },
      {
        name: "root workspace",
        operation: "root-start",
        field: "success.result.project.workspaceId",
        mutate: (result) => ({
          ...result,
          project: { ...(result.project as Record<string, unknown>), workspaceId: OTHER_HASH },
        }),
      },
      {
        name: "root-start continuity",
        operation: "root-start",
        field: "success.result.continuityKey",
        mutate: (result) => ({ ...result, continuityKey: "thread:other" }),
      },
      {
        name: "root-start resume source",
        operation: "root-start",
        field: "success.result.resumedFromSessionId",
        mutate: (result) => ({ ...result, resumedFromSessionId: otherId }),
      },
      {
        name: "root-resume selected session",
        operation: "root-resume",
        field: "success.result.sessionId",
        mutate: (result) => ({ ...result, sessionId: otherId }),
      },
      {
        name: "root-resume source session",
        operation: "root-resume",
        field: "success.result.resumedFromSessionId",
        mutate: (result) => ({ ...result, resumedFromSessionId: otherId }),
      },
      {
        name: "root-resume continuity",
        operation: "root-resume",
        field: "success.result.continuityKey",
        mutate: (result) => ({ ...result, continuityKey: "thread:other" }),
      },
      {
        name: "root-recovery session",
        operation: "root-recovery",
        field: "success.result.sessionId",
        mutate: (result) => ({ ...result, sessionId: otherId }),
      },
      {
        name: "root-suspend session",
        operation: "root-suspend",
        field: "success.result.sessionId",
        mutate: (result) => ({ ...result, sessionId: otherId }),
      },
      {
        name: "fork parent",
        operation: "fork-child",
        field: "success.result.parentSessionId",
        mutate: (result) => ({ ...result, parentSessionId: otherId }),
      },
      {
        name: "fork assignment id",
        operation: "fork-child",
        field: "success.result.assignment.assignmentId",
        mutate: (result) => ({
          ...result,
          assignment: { ...(result.assignment as Record<string, unknown>), assignmentId: otherId },
        }),
      },
      {
        name: "fork assignment summary",
        operation: "fork-child",
        field: "success.result.assignment.summary",
        mutate: (result) => ({
          ...result,
          assignment: { ...(result.assignment as Record<string, unknown>), summary: "Other assignment" },
        }),
      },
      {
        name: "fork assignment scope",
        operation: "fork-child",
        field: "success.result.assignment.scope",
        mutate: (result) => ({
          ...result,
          assignment: { ...(result.assignment as Record<string, unknown>), scope: "tests/other" },
        }),
      },
      {
        name: "fork direct access",
        operation: "fork-child",
        field: "success.result.directAccessEnabled",
        mutate: (result) => ({ ...result, directAccessEnabled: true }),
      },
      {
        name: "amend parent",
        operation: "amend-child-assignment",
        field: "success.result.parentSessionId",
        mutate: (result) => ({ ...result, parentSessionId: otherId }),
      },
      {
        name: "amend child",
        operation: "amend-child-assignment",
        field: "success.result.childSessionId",
        mutate: (result) => ({ ...result, childSessionId: otherId }),
      },
      {
        name: "amend assignment",
        operation: "amend-child-assignment",
        field: "success.result.assignment.summary",
        mutate: (result) => ({
          ...result,
          assignment: { ...(result.assignment as Record<string, unknown>), summary: "Other amendment" },
        }),
      },
      {
        name: "report parent",
        operation: "record-child-report",
        field: "success.result.parentSessionId",
        mutate: (result) => ({ ...result, parentSessionId: otherId }),
      },
      {
        name: "report child",
        operation: "record-child-report",
        field: "success.result.childSessionId",
        mutate: (result) => ({ ...result, childSessionId: otherId }),
      },
      {
        name: "disposition parent",
        operation: "disposition-child-report",
        field: "success.result.parentSessionId",
        mutate: (result) => ({ ...result, parentSessionId: otherId }),
      },
      {
        name: "disposition child",
        operation: "disposition-child-report",
        field: "success.result.childSessionId",
        mutate: (result) => ({ ...result, childSessionId: otherId }),
      },
      {
        name: "disposition kind",
        operation: "disposition-child-report",
        field: "success.result.disposition.kind",
        mutate: (result) => ({
          ...result,
          disposition: { ...(result.disposition as Record<string, unknown>), kind: "rejected" },
        }),
      },
      {
        name: "disposition report",
        operation: "disposition-child-report",
        field: "success.result.disposition.reportId",
        mutate: (result) => ({
          ...result,
          disposition: { ...(result.disposition as Record<string, unknown>), reportId: otherId },
        }),
      },
      {
        name: "proposal child",
        operation: "propose-child-completion",
        field: "success.result.childSessionId",
        mutate: (result) => ({ ...result, childSessionId: otherId }),
      },
      {
        name: "proposal report",
        operation: "propose-child-completion",
        field: "success.result.reportId",
        mutate: (result) => ({ ...result, reportId: otherId }),
      },
      {
        name: "completion parent",
        operation: "complete-child-session",
        field: "success.result.parentSessionId",
        mutate: (result) => ({ ...result, parentSessionId: otherId }),
      },
      {
        name: "completion child",
        operation: "complete-child-session",
        field: "success.result.childSessionId",
        mutate: (result) => ({ ...result, childSessionId: otherId }),
      },
      {
        name: "completion report",
        operation: "complete-child-session",
        field: "success.result.reportId",
        mutate: (result) => ({ ...result, reportId: otherId }),
      },
      {
        name: "suspension parent",
        operation: "suspend-child-session",
        field: "success.result.parentSessionId",
        mutate: (result) => ({ ...result, parentSessionId: otherId }),
      },
      {
        name: "suspension child",
        operation: "suspend-child-session",
        field: "success.result.childSessionId",
        mutate: (result) => ({ ...result, childSessionId: otherId }),
      },
      {
        name: "transfer parent",
        operation: "claim-child-transfer",
        field: "success.result.parentSessionId",
        mutate: (result) => ({ ...result, parentSessionId: otherId }),
      },
      {
        name: "transfer ticket",
        operation: "claim-child-transfer",
        field: "success.result.transferTicketId",
        mutate: (result) => ({ ...result, transferTicketId: otherId }),
      },
      {
        name: "checkpoint session",
        operation: "record-checkpoint",
        field: "success.result.sessionId",
        mutate: (result) => ({ ...result, sessionId: otherId }),
      },
      {
        name: "checkpoint base position",
        operation: "record-checkpoint",
        field: "success.result.baseEventPosition",
        mutate: (result) => ({
          ...result,
          baseEventPosition: "5",
          checkpointEventPosition: "6",
        }),
      },
      {
        name: "evidence session",
        operation: "record-evidence-batch",
        field: "success.result.sessionId",
        mutate: (result) => ({ ...result, sessionId: otherId }),
      },
      {
        name: "evidence adapter session",
        operation: "record-evidence-batch",
        field: "success.result.adapterSessionId",
        mutate: (result) => ({ ...result, adapterSessionId: otherId }),
      },
      {
        name: "evidence batch",
        operation: "record-evidence-batch",
        field: "success.result.batchId",
        mutate: (result) => ({ ...result, batchId: otherId }),
      },
      {
        name: "evidence first ordinal",
        operation: "record-evidence-batch",
        field: "success.result.batchFirstOrdinal",
        mutate: (result) => ({
          ...result,
          batchFirstOrdinal: "1",
          batchLastOrdinal: "1",
          coverageLastOrdinal: "1",
          highestContiguousOrdinal: "1",
        }),
      },
      {
        name: "evidence last ordinal",
        operation: "record-evidence-batch",
        field: "success.result.batchLastOrdinal",
        mutate: (result) => ({
          ...result,
          batchLastOrdinal: "1",
          coverageLastOrdinal: "1",
          highestContiguousOrdinal: "1",
        }),
      },
      {
        name: "root-start initial owner generation",
        operation: "root-start",
        field: "success.result.ownerGeneration",
        mutate: (result) => ({ ...result, ownerGeneration: "2" }),
      },
      {
        name: "root-start active state",
        operation: "root-start",
        field: "success.result.state",
        mutate: (result) => ({ ...result, state: "suspended" }),
      },
      {
        name: "root-start empty checkpoint history",
        operation: "root-start",
        field: "success.result.latestCheckpointEventPosition",
        mutate: (result) => ({ ...result, latestCheckpointEventPosition: "1" }),
      },
      {
        name: "root-start handle issuance",
        operation: "root-start",
        field: "success.result.handleIssued",
        mutate: (result) => ({ ...result, handleIssued: false }),
      },
      {
        name: "root-start resume-token issuance",
        operation: "root-start",
        field: "success.result.resumeTokenIssued",
        mutate: (result) => ({ ...result, resumeTokenIssued: false }),
      },
      {
        name: "root-resume owner increment",
        operation: "root-resume",
        field: "success.result.ownerGeneration",
        mutate: (result) => ({ ...result, ownerGeneration: "3" }),
      },
      {
        name: "root-resume active state",
        operation: "root-resume",
        field: "success.result.state",
        mutate: (result) => ({ ...result, state: "suspended" }),
      },
      {
        name: "root-resume handle issuance",
        operation: "root-resume",
        field: "success.result.handleIssued",
        mutate: (result) => ({ ...result, handleIssued: false }),
      },
      {
        name: "root-resume resume-token issuance",
        operation: "root-resume",
        field: "success.result.resumeTokenIssued",
        mutate: (result) => ({ ...result, resumeTokenIssued: false }),
      },
      {
        name: "root-recovery owner increment",
        operation: "root-recovery",
        field: "success.result.ownerGeneration",
        mutate: (result) => ({ ...result, ownerGeneration: "3" }),
      },
      {
        name: "root-recovery handle issuance",
        operation: "root-recovery",
        field: "success.result.handleIssued",
        mutate: (result) => ({ ...result, handleIssued: false }),
      },
      {
        name: "root-recovery resume-token issuance",
        operation: "root-recovery",
        field: "success.result.resumeTokenIssued",
        mutate: (result) => ({ ...result, resumeTokenIssued: false }),
      },
      {
        name: "root-suspend state",
        operation: "root-suspend",
        field: "success.result.state",
        mutate: (result) => ({ ...result, state: "active" }),
      },
      {
        name: "root-suspend event position",
        operation: "root-suspend",
        field: "success.result.eventPosition",
        mutate: (result) => ({ ...result, eventPosition: "6" }),
      },
      {
        name: "root-suspend handle issuance",
        operation: "root-suspend",
        field: "success.result.handleIssued",
        mutate: (result) => ({ ...result, handleIssued: false }),
      },
      {
        name: "root-suspend resume-token issuance",
        operation: "root-suspend",
        field: "success.result.resumeTokenIssued",
        mutate: (result) => ({ ...result, resumeTokenIssued: false }),
      },
      {
        name: "fork initial assignment revision",
        operation: "fork-child",
        field: "success.result.assignmentRevision",
        mutate: (result) => ({ ...result, assignmentRevision: "2" }),
      },
      {
        name: "fork active state",
        operation: "fork-child",
        field: "success.result.state",
        mutate: (result) => ({ ...result, state: "completed" }),
      },
      {
        name: "fork initial stream version",
        operation: "fork-child",
        field: "success.result.finalStreamVersion",
        mutate: (result) => ({ ...result, finalStreamVersion: "2" }),
      },
      {
        name: "amend assignment revision increment",
        operation: "amend-child-assignment",
        field: "success.result.assignmentRevision",
        mutate: (result) => ({ ...result, assignmentRevision: "3" }),
      },
      {
        name: "amend stream increment",
        operation: "amend-child-assignment",
        field: "success.result.finalStreamVersion",
        mutate: (result) => ({ ...result, finalStreamVersion: "4" }),
      },
      {
        name: "report stream increment",
        operation: "record-child-report",
        field: "success.result.finalStreamVersion",
        mutate: (result) => ({ ...result, finalStreamVersion: "4" }),
      },
      {
        name: "report item count",
        operation: "record-child-report",
        field: "success.result.reportItemIds",
        mutate: (result) => ({ ...result, reportItemIds: [IDS.nonce] }),
      },
      {
        name: "disposition stream increment",
        operation: "disposition-child-report",
        field: "success.result.finalStreamVersion",
        mutate: (result) => ({ ...result, finalStreamVersion: "4" }),
      },
      {
        name: "proposal stream increment",
        operation: "propose-child-completion",
        field: "success.result.finalStreamVersion",
        mutate: (result) => ({ ...result, finalStreamVersion: "4" }),
      },
      {
        name: "proposal state",
        operation: "propose-child-completion",
        field: "success.result.state",
        mutate: (result) => ({ ...result, state: "active" }),
      },
      {
        name: "completion stream increment",
        operation: "complete-child-session",
        field: "success.result.finalStreamVersion",
        mutate: (result) => ({ ...result, finalStreamVersion: "4" }),
      },
      {
        name: "completion state",
        operation: "complete-child-session",
        field: "success.result.state",
        mutate: (result) => ({ ...result, state: "active" }),
      },
      {
        name: "suspension two-event stream increment",
        operation: "suspend-child-session",
        field: "success.result.finalStreamVersion",
        mutate: (result) => ({ ...result, finalStreamVersion: "5" }),
      },
      {
        name: "suspension transferred state",
        operation: "suspend-child-session",
        field: "success.result.state",
        mutate: (result) => ({ ...result, state: "suspended" }),
      },
      {
        name: "claim initial assignment revision",
        operation: "claim-child-transfer",
        field: "success.result.assignmentRevision",
        mutate: (result) => ({ ...result, assignmentRevision: "2" }),
      },
      {
        name: "claim local-only direct access",
        operation: "claim-child-transfer",
        field: "success.result.directAccessEnabled",
        mutate: (result) => ({ ...result, directAccessEnabled: true }),
      },
      {
        name: "claim active state",
        operation: "claim-child-transfer",
        field: "success.result.state",
        mutate: (result) => ({ ...result, state: "transferred" }),
      },
      {
        name: "claim two-event stream version",
        operation: "claim-child-transfer",
        field: "success.result.finalStreamVersion",
        mutate: (result) => ({ ...result, finalStreamVersion: "3" }),
      },
      {
        name: "checkpoint stream increment",
        operation: "record-checkpoint",
        field: "success.result.finalStreamVersion",
        mutate: (result) => ({ ...result, finalStreamVersion: "4" }),
      },
      {
        name: "end request session",
        operation: "request-session-end",
        field: "success.result.sessionId",
        mutate: (result) => ({ ...result, sessionId: otherId }),
      },
      {
        name: "end amendment session",
        operation: "amend-session-end",
        field: "success.result.sessionId",
        mutate: (result) => ({ ...result, sessionId: otherId }),
      },
      {
        name: "end amendment workflow",
        operation: "amend-session-end",
        field: "success.result.workflowId",
        mutate: (result) => ({ ...result, workflowId: otherId }),
      },
      {
        name: "end cancellation session",
        operation: "cancel-session-end",
        field: "success.result.sessionId",
        mutate: (result) => ({ ...result, sessionId: otherId }),
      },
      {
        name: "end cancellation workflow",
        operation: "cancel-session-end",
        field: "success.result.workflowId",
        mutate: (result) => ({ ...result, workflowId: otherId }),
      },
      {
        name: "abandonment session",
        operation: "abandon-session",
        field: "success.result.sessionId",
        mutate: (result) => ({ ...result, sessionId: otherId }),
      },
    ];

    assert.equal(cases.length, 81);
    assert.equal(new Set(cases.map((entry) => entry.operation)).size, 18);
    const requestedByOperation = new Map<string, LifecycleWorkerOperationWire>();
    const requestedFor = (operation: string): LifecycleWorkerOperationWire => {
      const cached = requestedByOperation.get(operation);
      if (cached !== undefined) return cached;
      const command = semanticCommandCases().find(
        (candidate) => candidate.commandType === operation,
      );
      assert.ok(command !== undefined, operation);
      const requested = decodeLifecycleWorkerOperationWire({
        kind: "semantic",
        operation,
        prepared: prepared(
          command as Record<string, unknown>,
          semanticAuthorizationFor(command),
        ),
      });
      requestedByOperation.set(operation, requested);
      return requested;
    };
    const decodeSuccess = (
      requested: LifecycleWorkerOperationWire,
      publicResult: Record<string, unknown>,
    ): LifecycleWorkerSuccessWire => decodeLifecycleWorkerSuccessForOperation({
      operation: requested.operation,
      nestedContractVersion: lifecycleNestedContractVersion(requested),
      result: semanticSuccess(publicResult),
    }, requested);

    for (const operation of new Set(cases.map((entry) => entry.operation))) {
      const requested = requestedFor(operation);
      assert.doesNotThrow(
        () => decodeSuccess(requested, semanticPublicResult(operation)),
        `${operation} correlated baseline`,
      );
    }
    for (const entry of cases) {
      const requested = requestedFor(entry.operation);
      expectLifecycleField(
        () => decodeSuccess(
          requested,
          entry.mutate(semanticPublicResult(entry.operation)),
        ),
        entry.field,
      );
    }
    const checkpoint = requestedFor("record-checkpoint");
    expectSafeLifecycleFailure(
      "LIFECYCLE_INPUT_INVALID",
      () => decodeSuccess(checkpoint, {
        ...checkpointResult(1),
        checkpointEventPosition: "6",
      }),
      [],
    );
  });

  // Production mutation caught: retain an undocumented optional third focused-decoder argument.
  it("exposes the exact two-input lifecycle success decoder", () => {
    assert.equal(decodeLifecycleWorkerSuccessForOperation.length, 2);
  });

  // Production mutation caught: decode current authority material independently from its semantic result and request.
  it("binds current authority material to the semantic result and issuance family", () => {
    const commandFor = (operation: string): Readonly<Record<string, unknown>> => {
      const command = semanticCommandCases().find((candidate) => candidate.commandType === operation);
      assert.ok(command !== undefined, operation);
      return command;
    };
    const requestedFor = (
      command: Readonly<Record<string, unknown>>,
      childBindingGrant: ChildBindingGrantV1 | null = null,
    ): LifecycleWorkerOperationWire => decodeLifecycleWorkerOperationWire({
      kind: "semantic",
      operation: command.commandType,
      prepared: prepared(
        command as Record<string, unknown>,
        semanticAuthorizationFor(command, childBindingGrant),
      ),
    });
    const decodeCurrent = (
      requested: LifecycleWorkerOperationWire,
      publicResult: Record<string, unknown>,
      authorityMaterial: Record<string, unknown>,
    ): LifecycleWorkerSuccessWire => decodeLifecycleWorkerSuccessForOperation({
      operation: requested.operation,
      nestedContractVersion: lifecycleNestedContractVersion(requested),
      result: {
        ...semanticSuccess(publicResult),
        authorityMaterial,
      },
    }, requested);

    const rootOperations = [
      "root-start",
      "root-resume",
      "root-recovery",
      "root-suspend",
    ] as const;
    assert.equal(rootOperations.length, 4);
    for (const operation of rootOperations) {
      const publicResult = rootResult(operation);
      assert.doesNotThrow(() => decodeCurrent(
        requestedFor(commandFor(operation)),
        publicResult,
        currentAuthorityMaterial(
          {
            ...EXPECTED_ROOT_AUTHORITY_SCOPE,
            capabilityGeneration: publicResult.ownerGeneration as string,
          },
          ["root-session-handle", "root-resume-token"],
        ),
      ), operation);
    }
    const rootRequested = requestedFor(commandFor("root-start"));
    const rootCases: ReadonlyArray<{
      readonly name: string;
      readonly material: Record<string, unknown>;
    }> = [
      {
        name: "project",
        material: currentAuthorityMaterial(
          { ...EXPECTED_ROOT_AUTHORITY_SCOPE, projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
          ["root-session-handle", "root-resume-token"],
        ),
      },
      {
        name: "vault",
        material: currentAuthorityMaterial(
          { ...EXPECTED_ROOT_AUTHORITY_SCOPE, vaultId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
          ["root-session-handle", "root-resume-token"],
        ),
      },
      {
        name: "store",
        material: currentAuthorityMaterial(
          { ...EXPECTED_ROOT_AUTHORITY_SCOPE, storeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
          ["root-session-handle", "root-resume-token"],
        ),
      },
      {
        name: "workspace",
        material: currentAuthorityMaterial(
          { ...EXPECTED_ROOT_AUTHORITY_SCOPE, workspaceId: OTHER_HASH },
          ["root-session-handle", "root-resume-token"],
        ),
      },
      {
        name: "client namespace",
        material: currentAuthorityMaterial(
          { ...EXPECTED_ROOT_AUTHORITY_SCOPE, clientNamespace: "other-client" },
          ["root-session-handle", "root-resume-token"],
        ),
      },
      {
        name: "session",
        material: currentAuthorityMaterial(
          { ...EXPECTED_ROOT_AUTHORITY_SCOPE, sessionId: IDS.work },
          ["root-session-handle", "root-resume-token"],
        ),
      },
      {
        name: "generation",
        material: currentAuthorityMaterial(
          { ...EXPECTED_ROOT_AUTHORITY_SCOPE, capabilityGeneration: "2" },
          ["root-session-handle", "root-resume-token"],
        ),
      },
      {
        name: "missing resume token",
        material: currentAuthorityMaterial(
          EXPECTED_ROOT_AUTHORITY_SCOPE,
          ["root-session-handle"],
        ),
      },
      {
        name: "duplicate root handle",
        material: currentAuthorityMaterial(
          EXPECTED_ROOT_AUTHORITY_SCOPE,
          ["root-session-handle", "root-session-handle"],
        ),
      },
    ];
    assert.equal(rootCases.length, 9);
    for (const entry of rootCases) {
      expectLifecycleField(
        () => decodeCurrent(rootRequested, rootResult(), entry.material),
        "success.result.authorityMaterial",
      );
    }

    const directForkCommand = {
      ...commandFor("fork-child"),
      directAccessRequested: true,
    };
    const directForkRequested = requestedFor(directForkCommand, validChildBindingGrant());
    const directForkResult = {
      ...childResult("fork-child"),
      directAccessEnabled: true,
    };
    const expectedChildScope: TestAuthorityScope = {
      ...EXPECTED_ROOT_AUTHORITY_SCOPE,
      sessionId: IDS.work,
    };
    assert.doesNotThrow(() => decodeCurrent(
      directForkRequested,
      directForkResult,
      currentAuthorityMaterial(expectedChildScope, ["child-session-handle"]),
    ));
    const forkCases: ReadonlyArray<{
      readonly name: string;
      readonly material: Record<string, unknown>;
    }> = [
      {
        name: "project",
        material: currentAuthorityMaterial(
          { ...expectedChildScope, projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
          ["child-session-handle"],
        ),
      },
      {
        name: "vault",
        material: currentAuthorityMaterial(
          { ...expectedChildScope, vaultId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
          ["child-session-handle"],
        ),
      },
      {
        name: "workspace",
        material: currentAuthorityMaterial(
          { ...expectedChildScope, workspaceId: OTHER_HASH },
          ["child-session-handle"],
        ),
      },
      {
        name: "session",
        material: currentAuthorityMaterial(
          { ...expectedChildScope, sessionId: IDS.nonce },
          ["child-session-handle"],
        ),
      },
      {
        name: "generation",
        material: currentAuthorityMaterial(
          { ...expectedChildScope, capabilityGeneration: "2" },
          ["child-session-handle"],
        ),
      },
      {
        name: "kind",
        material: currentAuthorityMaterial(
          expectedChildScope,
          ["root-session-handle"],
        ),
      },
    ];
    assert.equal(forkCases.length, 6);
    for (const entry of forkCases) {
      expectLifecycleField(
        () => decodeCurrent(directForkRequested, directForkResult, entry.material),
        "success.result.authorityMaterial",
      );
    }

    const nonIssuingCases: ReadonlyArray<{
      readonly requested: LifecycleWorkerOperationWire;
      readonly publicResult: Record<string, unknown>;
      readonly material: Record<string, unknown>;
    }> = [
      {
        requested: requestedFor(commandFor("fork-child")),
        publicResult: childResult("fork-child"),
        material: currentAuthorityMaterial(expectedChildScope, ["child-session-handle"]),
      },
      {
        requested: requestedFor(commandFor("amend-child-assignment")),
        publicResult: childResult("amend-child-assignment"),
        material: currentAuthorityMaterial(expectedChildScope, ["child-session-handle"]),
      },
    ];
    assert.equal(nonIssuingCases.length, 2);
    for (const entry of nonIssuingCases) {
      expectLifecycleField(
        () => decodeCurrent(entry.requested, entry.publicResult, entry.material),
        "success.result.authorityMaterial",
      );
    }

    const nonCurrentCases = [
      { status: "stale", recoveryCode: "SESSION_HANDLE_STALE" },
      { status: "unavailable", recoveryCode: null },
      { status: "not-issued", recoveryCode: null },
    ] as const;
    assert.equal(nonCurrentCases.length, 3);
    for (const entry of nonCurrentCases) {
      const decoded = decodeCurrent(rootRequested, rootResult(), {
        status: entry.status,
        target: null,
        authorityCommitment: null,
        capabilityGeneration: null,
        descriptor: null,
        recoveryCode: entry.recoveryCode,
      });
      const result = decoded.result as Readonly<Record<string, JsonValue>>;
      const authorityMaterial = result.authorityMaterial as Readonly<Record<string, JsonValue>>;
      assert.equal(authorityMaterial.status, entry.status);
      assert.equal(authorityMaterial.recoveryCode, entry.recoveryCode);
    }
  });

  // Production mutation caught: bind only operation-known top-level claim project identities.
  it("binds every decoded lifecycle result project identity to the outer request", () => {
    const input = fencedOperationInputs().find(
      (candidate) => candidate.operation === "workflow-claim-next",
    );
    assert.ok(input !== undefined);
    const request = decodeWorkerRequest({
      id: IDS.work,
      type: "lifecycle",
      binding: bindingAssertion(),
      operation: { kind: "fenced", operation: "workflow-claim-next", input },
    });
    assert.equal(request.type, "lifecycle");
    const data = {
      operation: "workflow-claim-next",
      nestedContractVersion: null,
      result: {
        ...workflowClaimResult(),
        projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
    };
    assert.doesNotThrow(() => decodeLifecycleWorkerSuccessForOperation(
      data,
      request.operation,
    ));
    assert.throws(
      () => decodeWorkerResponseForRequest({
        id: IDS.work,
        ok: true,
        data,
      }, request),
      (error: unknown) => error instanceof WorkerProtocolError,
    );
  });

  // Production mutation caught: bind decoded project identities but ignore an active-store identity.
  it("binds every decoded lifecycle result store identity to the outer request", () => {
    const request = decodeWorkerRequest(lifecycleRequestEnvelope());
    assert.equal(request.type, "lifecycle");
    const publicResult = rootResult();
    const project = publicResult.project as Readonly<Record<string, unknown>>;
    const data = {
      operation: "root-start",
      nestedContractVersion: null,
      result: semanticSuccess({
        ...publicResult,
        project: {
          ...project,
          storeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        },
      }),
    };
    assert.doesNotThrow(() => decodeLifecycleWorkerSuccessForOperation(
      data,
      request.operation,
    ));
    assert.throws(
      () => decodeWorkerResponseForRequest({
        id: IDS.work,
        ok: true,
        data,
      }, request),
      (error: unknown) => error instanceof WorkerProtocolError,
    );
  });

  it("correlates bounded query and fenced success identities", () => {
    const otherId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const decodeSuccess = (
      requested: LifecycleWorkerOperationWire,
      result: JsonValue,
    ): LifecycleWorkerSuccessWire => decodeLifecycleWorkerSuccessForOperation({
      operation: requested.operation,
      nestedContractVersion: lifecycleNestedContractVersion(requested),
      result,
    }, requested);

    for (const authorizationField of ["authoritySessionId", "targetSessionId"] as const) {
      expectLifecycleField(() => decodeLifecycleWorkerOperationWire({
        kind: "bounded",
        operation: "renew-root-lease",
        input: {
          ...boundedInput,
          authorization: {
            ...boundedInput.authorization,
            [authorizationField]: otherId,
          },
        },
      }), "operation.input.authorization");
    }

    const requestedLease = decodeLifecycleWorkerOperationWire({
      kind: "bounded",
      operation: "renew-root-lease",
      input: boundedInput,
    });
    for (const [field, value] of [
      ["operationId", otherId],
      ["requestId", otherId],
      ["sessionId", otherId],
      ["ownerGeneration", "2"],
    ] as const) {
      expectLifecycleField(
        () => decodeSuccess(requestedLease, { ...leaseResult(), [field]: value } as JsonValue),
        `success.result.${field}`,
      );
    }

    for (const operation of [
      "read-session-tree",
      "read-session-status",
      "read-session-association",
    ] as const) {
      const input = operation === "read-session-association"
        ? {
            ...queryInput,
            operation,
            authorization: {
              ...queryInput.authorization,
              authoritySessionId: IDS.work,
              targetSessionId: IDS.work,
            },
            sessionId: IDS.work,
          }
        : { ...queryInput, operation };
      const requested = decodeLifecycleWorkerOperationWire({ kind: "query", operation, input });
      assert.doesNotThrow(() => decodeSuccess(
        requested,
        queryResult(operation) as JsonValue,
      ));
      for (const field of ["operationId", "requestId"] as const) {
        expectLifecycleField(
          () => decodeSuccess(requested, {
            ...queryResult(operation),
            [field]: otherId,
          } as JsonValue),
          `success.result.${field}`,
        );
      }
      const result = queryResult(operation);
      if (operation === "read-session-tree") {
        expectLifecycleField(() => decodeSuccess(requested, {
          ...result,
          root: { ...(result.root as Readonly<Record<string, unknown>>), sessionId: otherId },
        } as JsonValue), "success.result.root.sessionId");
        expectLifecycleField(() => decodeSuccess(requested, {
          ...result,
          root: { ...(result.root as Readonly<Record<string, unknown>>), sessionKind: "child" },
        } as JsonValue), "success.result.root.sessionKind");
        expectLifecycleField(() => decodeSuccess(requested, {
          ...result,
          children: [{
            ...((result.children as ReadonlyArray<Readonly<Record<string, unknown>>>)[0]),
            parentSessionId: otherId,
          }],
        } as JsonValue), "success.result.children[0].parentSessionId");
      } else if (operation === "read-session-status") {
        expectLifecycleField(() => decodeSuccess(requested, {
          ...result,
          session: { ...(result.session as Readonly<Record<string, unknown>>), sessionId: otherId },
        } as JsonValue), "success.result.session.sessionId");
      } else {
        expectLifecycleField(() => decodeSuccess(requested, {
          ...result,
          sessionId: otherId,
        } as JsonValue), "success.result.sessionId");
      }
    }

    const fencedRequest = (operation: string): LifecycleWorkerOperationWire => {
      const input = fencedOperationInputs().find((candidate) => candidate.operation === operation);
      assert.ok(input !== undefined);
      return decodeLifecycleWorkerOperationWire({ kind: "fenced", operation, input });
    };
    const workflowSelection = fencedRequest("workflow-claim-next");
    expectLifecycleField(() => decodeSuccess(workflowSelection, {
      ...workflowClaimResult(),
      ownerId: "wrong-owner",
    } as JsonValue), "success.result.ownerId");
    assert.equal(decodeSuccess(workflowSelection, null).result, null);

    for (const operation of ["workflow-claim", "workflow-renew"] as const) {
      const requested = fencedRequest(operation);
      for (const [field, value] of [
        ["workflowId", otherId],
        ["workflowGeneration", 3],
        ["ownerId", "wrong-owner"],
        ["claimToken", "8"],
        ["claimExpiresAt", "2026-07-17T00:11:00.000Z"],
      ] as const) {
        expectLifecycleField(
          () => decodeSuccess(requested, {
            ...workflowClaimResult(),
            [field]: value,
          } as JsonValue),
          `success.result.${field}`,
        );
      }
    }
    assert.equal(decodeSuccess(fencedRequest("workflow-claim"), null).result, null);

    const eventless = fencedRequest("workflow-eventless-phase");
    const eventlessResult = {
      ...phaseResult(),
      status: {
        ...endStatus(),
        workflowGeneration: 2,
        phase: "children-resolved",
      },
    };
    for (const [path, result] of [
      ["success.result.status.workflowId", {
        ...eventlessResult,
        status: { ...eventlessResult.status, workflowId: otherId },
      }],
      ["success.result.status.workflowGeneration", {
        ...eventlessResult,
        status: { ...eventlessResult.status, workflowGeneration: 3 },
      }],
      ["success.result.previousPhase", { ...eventlessResult, previousPhase: "validating" }],
      ["success.result.status.phase", {
        ...eventlessResult,
        status: { ...eventlessResult.status, phase: "validating" },
      }],
    ] as const) {
      expectLifecycleField(() => decodeSuccess(eventless, result as JsonValue), path);
    }
    assert.doesNotThrow(() => decodeSuccess(eventless, eventlessResult as JsonValue));

    const outboxSelection = fencedRequest("outbox-claim-next");
    expectLifecycleField(() => decodeSuccess(outboxSelection, {
      ...outboxClaimResult(),
      ownerId: "wrong-owner",
    } as JsonValue), "success.result.ownerId");
    assert.equal(decodeSuccess(outboxSelection, null).result, null);

    for (const operation of ["outbox-claim", "outbox-renew"] as const) {
      const requested = fencedRequest(operation);
      for (const [field, value] of [
        ["targetKey", "memory/other.md"],
        ["materializationRevision", "4"],
        ["ownerId", "wrong-owner"],
        ["claimToken", "8"],
        ["claimExpiresAt", "2026-07-17T00:11:00.000Z"],
      ] as const) {
        expectLifecycleField(
          () => decodeSuccess(requested, {
            ...outboxClaimResult(),
            [field]: value,
          } as JsonValue),
          `success.result.${field}`,
        );
      }
    }
    assert.equal(decodeSuccess(fencedRequest("outbox-claim"), null).result, null);

    const materialize = fencedRequest("outbox-materialize");
    for (const [field, value] of [
      ["targetKey", "memory/other.md"],
      ["materializationRevision", "4"],
    ] as const) {
      expectLifecycleField(
        () => decodeSuccess(materialize, {
          ...materializationResult(),
          [field]: value,
        } as JsonValue),
        `success.result.${field}`,
      );
    }

    for (const operation of ["workflow-claim-next", "outbox-renew"] as const) {
      const input = fencedOperationInputs().find((candidate) => candidate.operation === operation);
      assert.ok(input !== undefined);
      const request = decodeWorkerRequest({
        id: IDS.work,
        type: "lifecycle",
        binding: bindingAssertion(),
        operation: { kind: "fenced", operation, input },
      });
      const result = operation === "workflow-claim-next"
        ? workflowClaimResult()
        : outboxClaimResult();
      assert.throws(() => decodeWorkerResponseForRequest({
        id: IDS.work,
        ok: true,
        data: {
          operation,
          nestedContractVersion: null,
          result: { ...result, projectId: otherId },
        },
      }, request), (error: unknown) => {
        assert.ok(error instanceof WorkerProtocolError);
        assert.equal(error.message, "WORKER_PROTOCOL_INVALID");
        assert.equal(JSON.stringify(error).includes(otherId), false);
        return true;
      });
    }
  });

  // Production mutation caught: copy own JSON keys through inherited __proto__ assignment semantics.
  it("counts own __proto__ data properties at the lifecycle 4 MiB guard", () => {
    const [exact, padding] = exactByteEnvelope((value) =>
      withOwnProtoDataProperty({}, value));
    assert.equal(Object.prototype.hasOwnProperty.call(exact, "__proto__"), true);
    assert.doesNotThrow(() => assertLifecycleWireCanonicalSize(exact));

    const plusOne = withOwnProtoDataProperty({}, `${padding}x`);
    assert.equal(canonicalJsonBytes(plusOne), MAX_LIFECYCLE_WIRE_CANONICAL_BYTES + 1);
    expectLifecycleField(() => assertLifecycleWireCanonicalSize(plusOne), "lifecycleWire");
  });

  // Production mutation caught: drop an unknown own __proto__ field before exact request validation.
  it("rejects rather than drops own __proto__ data properties during lifecycle request decode", () => {
    const input = fencedOperationInputs().find(
      (candidate) => candidate.operation === "workflow-claim-next",
    );
    assert.ok(input !== undefined);
    const request = lifecycleRequestEnvelope(IDS.work, {
      kind: "fenced",
      operation: "workflow-claim-next",
      input: withOwnProtoDataProperty({ ...input }, "request-canary"),
    });
    assert.equal(JSON.parse(JSON.stringify(request)).operation.input.__proto__, "request-canary");
    expectLifecycleField(() => decodeWorkerRequest(request), "operation.input");
  });

  // Production mutation caught: drop an unknown own __proto__ field before exact success validation.
  it("rejects rather than drops own __proto__ data properties during lifecycle success decode", () => {
    const input = fencedOperationInputs().find(
      (candidate) => candidate.operation === "workflow-claim-next",
    );
    assert.ok(input !== undefined);
    const request = decodeWorkerRequest(lifecycleRequestEnvelope(IDS.work, {
      kind: "fenced",
      operation: "workflow-claim-next",
      input,
    }));
    const result = withOwnProtoDataProperty(workflowClaimResult(), "success-canary");
    assert.equal(JSON.parse(JSON.stringify(result)).__proto__, "success-canary");
    expectLifecycleField(() => decodeWorkerResponseForRequest({
      id: IDS.work,
      ok: true,
      data: {
        operation: "workflow-claim-next",
        nestedContractVersion: null,
        result,
      },
    }, request), "success.result");
  });

  it("caps lifecycle wire JSON at the exact UTF-8 boundary", () => {
    assert.doesNotThrow(() => assertLifecycleWireCanonicalSize(
      "x".repeat(MAX_LIFECYCLE_WIRE_CANONICAL_BYTES - 2),
    ));
    assert.throws(() => assertLifecycleWireCanonicalSize(
      "x".repeat(MAX_LIFECYCLE_WIRE_CANONICAL_BYTES - 1),
    ));

    const [exactRequestEnvelope, requestPadding] = exactByteEnvelope((id) =>
      lifecycleRequestEnvelope(id));
    assert.doesNotThrow(() => assertLifecycleWireCanonicalSize(exactRequestEnvelope));
    assert.equal(decodeWorkerRequest(exactRequestEnvelope).type, "lifecycle");
    const requestPlusOne = lifecycleRequestEnvelope(`${requestPadding}x`);
    assert.throws(() => assertLifecycleWireCanonicalSize(requestPlusOne));
    expectLifecycleField(() => decodeWorkerRequest(requestPlusOne), "lifecycleWire");

    const [exactSuccessEnvelope, successPadding] = exactByteEnvelope((errorCode) => ({
      operation: "root-start",
      nestedContractVersion: null,
      result: { kind: "rejected", errorCode },
    }));
    assert.doesNotThrow(() => assertLifecycleWireCanonicalSize(exactSuccessEnvelope));
    const successPlusOne = {
      operation: "root-start",
      nestedContractVersion: null,
      result: { kind: "rejected", errorCode: `${successPadding}x` },
    };
    assert.throws(() => assertLifecycleWireCanonicalSize(successPlusOne));

    const outer = decodeWorkerRequest({
      id: IDS.work,
      type: "lifecycle",
      binding: bindingAssertion(),
      operation: {
        kind: "semantic",
        operation: "root-start",
        prepared: prepared({
          ...commandBase("root-start"),
          continuityKey: "thread:stable",
          resumePolicy: "new",
        }, initialAuthorization()),
      },
    });
    assert.equal(outer.type, "lifecycle");
    const response = decodeWorkerResponseForRequest({
      id: IDS.work,
      ok: true,
      data: {
        operation: "root-start",
        nestedContractVersion: null,
        result: semanticSuccess(rootResult()),
      },
    }, outer);
    assert.equal(response.ok, true);

    expectLifecycleField(() => decodeWorkerResponseForRequest({
      id: IDS.work,
      ok: true,
      data: exactSuccessEnvelope,
    }, outer), "success.result.errorCode");
    expectLifecycleField(() => decodeWorkerResponseForRequest({
      id: IDS.work,
      ok: true,
      data: successPlusOne,
    }, outer), "lifecycleWire");
  });

  it("enforces fork-only child-binding grants without echo", () => {
    const grant = validChildBindingGrant();
    const fork = {
      ...commandBase("fork-child"),
      parentSessionId: IDS.session,
      expectedStreamVersion: "1",
      assignment: {
        assignmentId: IDS.work,
        summary: "Inspect lifecycle boundary",
        scope: "src/orchestrator/runtime",
      },
      directAccessRequested: true,
    };
    const valid = decodeLifecycleWorkerOperationWire({
      kind: "semantic",
      operation: "fork-child",
      prepared: prepared(fork, protectedAuthorization(grant)),
    });
    assert.equal(valid.operation, "fork-child");

    for (const authorization of [
      { ...protectedAuthorization(grant), proof: null },
      protectedAuthorization(null),
    ]) {
      expectSafeFailure(() => decodeLifecycleWorkerOperationWire({
        kind: "semantic",
        operation: "fork-child",
        prepared: prepared(fork, authorization as SemanticCommandAuthorization),
      }), [grant.mac, proof.proofFingerprint]);
    }
    expectSafeFailure(() => decodeLifecycleWorkerOperationWire({
      kind: "semantic",
      operation: "fork-child",
      prepared: prepared({ ...fork, directAccessRequested: false }, protectedAuthorization(grant)),
    }), [grant.mac]);
    expectSafeFailure(() => decodeLifecycleWorkerOperationWire({
      kind: "semantic",
      operation: "create-child-transfer",
      prepared: prepared({
        ...commandBase("create-child-transfer"),
        parentSessionId: IDS.session,
        childSessionId: IDS.work,
        expectedStreamVersion: "1",
        checkpointId: IDS.grant,
      }, {
        ...protectedAuthorization(grant),
        targetSessionId: IDS.work as never,
      }),
    }), [grant.mac]);
    const malformedCanary = "grant-canary-do-not-echo";
    expectSafeFailure(() => decodeLifecycleWorkerOperationWire({
      kind: "semantic",
      operation: "fork-child",
      prepared: prepared(fork, protectedAuthorization({
        ...grant,
        mac: malformedCanary,
      })),
    }), [malformedCanary]);

    for (const source of semanticCommandCases()) {
      if (source.commandType === "fork-child") continue;
      const inputCanary = `pmcap1.${String(source.commandType)}.decoded-input-canary`;
      const command: Record<string, unknown> = { ...source, agentId: inputCanary };
      const authorization = {
        ...semanticAuthorizationFor(command),
        childBindingGrant: grant,
      } as SemanticCommandAuthorization;
      expectSafeLifecycleFailure(
        "SESSION_CAPABILITY_INVALID",
        () => decodeLifecycleWorkerOperationWire({
          kind: "semantic",
          operation: command.commandType,
          prepared: prepared(command, authorization),
        }),
        [inputCanary, grant.mac, proof.proofFingerprint],
      );
    }

    const bearerCanary = "pmcap1.transport-bearer-must-not-cross";
    const rootStart = semanticCommandCases().find((command) => command.commandType === "root-start");
    assert.ok(rootStart);
    expectSafeLifecycleFailure(
      "LIFECYCLE_INPUT_INVALID",
      () => decodeLifecycleWorkerOperationWire({
        kind: "semantic",
        operation: "root-start",
        prepared: prepared(
          { ...rootStart, handle: bearerCanary },
          initialAuthorization(),
        ),
      }),
      [bearerCanary],
    );

    for (const invalidMac of ["A".repeat(42), `${"A".repeat(42)}=`, "A".repeat(44)]) {
      expectSafeLifecycleFailure(
        "SESSION_CAPABILITY_INVALID",
        () => decodeLifecycleWorkerOperationWire({
          kind: "semantic",
          operation: "fork-child",
          prepared: prepared(fork, protectedAuthorization({ ...grant, mac: invalidMac })),
        }),
        [invalidMac],
      );
    }
  });

  it("materialization wire carries identity only", () => {
    const decoded = decodeLifecycleWorkerOperationWire({
      kind: "fenced",
      operation: "outbox-materialize",
      input: materializationInput,
    });
    assert.deepEqual(decoded, {
      kind: "fenced",
      operation: "outbox-materialize",
      input: materializationInput,
    });
    for (const [field, value] of [
      ["expectedCurrentFingerprint", null],
      ["nextFingerprint", HASH],
      ["materializedBytes", new Uint8Array([1, 2, 3])],
      ["acknowledgement", { ownerId: "materializer-a" }],
    ] as const) {
      assert.throws(() => decodeLifecycleWorkerOperationWire({
        kind: "fenced",
        operation: "outbox-materialize",
        input: { ...materializationInput, [field]: value },
      }), field);
    }
    assert.equal(
      LIFECYCLE_ERROR_CODES.includes("LIFECYCLE_OPERATION_UNAVAILABLE" as never),
      true,
    );
    const unavailable = new LifecycleError("LIFECYCLE_OPERATION_UNAVAILABLE" as never);
    assert.equal(unavailable.safeMessage, "The lifecycle operation is not available in this runtime");
    assert.equal(unavailable.retryable, false);
    assert.deepEqual(unavailable.recoveryActions, ["upgrade-runtime"]);
  });

  it("derives internal final checkpoint version from plan and authoritative command", () => {
    for (const version of [1, 2] as const) {
      const plan = internalPhasePlan(version) as unknown as InternalWorkflowExecutionPlan;
      const command = authoritativePhaseCommand(version) as unknown as InternalWorkflowPhaseCommand;
      assert.equal(lifecycleNestedContractVersion(plan), version);
      assert.equal(lifecycleNestedContractVersion(command), version);
      assert.deepEqual(lifecycleInternalWorkVersionBinding(plan), {
        commandType: "internal-workflow-phase",
        workflowId: IDS.workflow,
        workflowGeneration: 2,
        plannedWorkId: HASH,
        nestedContractVersion: version,
      });
      assert.deepEqual(lifecycleInternalWorkVersionBinding(command), lifecycleInternalWorkVersionBinding(plan));
    }

    const noncheckpointPlan = internalPhasePlan(1, false) as unknown as InternalWorkflowExecutionPlan;
    const noncheckpointCommand = authoritativePhaseCommand(1, false) as unknown as InternalWorkflowPhaseCommand;
    assert.equal(lifecycleNestedContractVersion(noncheckpointPlan), null);
    assert.equal(lifecycleNestedContractVersion(noncheckpointCommand), null);
    const nullVersionBinding = {
      commandType: "internal-workflow-phase",
      workflowId: IDS.workflow,
      workflowGeneration: 2,
      plannedWorkId: HASH,
      nestedContractVersion: null,
    };
    assert.deepEqual(lifecycleInternalWorkVersionBinding(noncheckpointPlan), nullVersionBinding);
    assert.deepEqual(lifecycleInternalWorkVersionBinding(noncheckpointCommand), nullVersionBinding);

    const validation = internalValidationCommand() as unknown as InternalWorkflowExecutionPlan;
    assert.deepEqual(lifecycleInternalWorkVersionBinding(validation), {
      commandType: "internal-validation-result",
      workflowId: IDS.workflow,
      workflowGeneration: 1,
      plannedWorkId: HASH,
      nestedContractVersion: null,
    });
  });
});
