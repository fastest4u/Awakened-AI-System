import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import type { ProjectContext } from "../src/orchestrator/identity/contracts.js";
import {
  decodeLifecycleSemanticCommandDraft,
  type InternalWorkflowExecutionPlan,
  type InternalWorkflowSemanticCommand,
  type LifecycleAudience,
  type LifecycleSemanticCommandDraft,
} from "../src/orchestrator/lifecycle/contracts/commands.js";
import {
  buildLifecycleIntentWitness,
  lifecycleIntentHashFromWitnessSource,
  type TrustedLifecycleIntentAssertionsV1,
} from "../src/orchestrator/lifecycle/lifecycle-intent-witness.js";
import {
  lifecycleIntentCanonicalJson,
  lifecycleIntentHash,
  lifecycleIntentPreimage,
  type LifecycleIntentInputV1,
} from "../src/orchestrator/lifecycle/lifecycle-intent.js";

const UUID = {
  project: "00000000-0000-4000-8000-000000000001",
  vault: "00000000-0000-4000-8000-000000000002",
  store: "00000000-0000-4000-8000-000000000003",
  session: "00000000-0000-4000-8000-000000000010",
  otherSession: "00000000-0000-4000-8000-000000000011",
  command: "00000000-0000-4000-8000-000000000020",
  binding: "00000000-0000-4000-8000-000000000030",
} as const;

const WORKSPACE_ID = "1".repeat(64);
const OTHER_WORKSPACE_ID = "2".repeat(64);

function context(overrides: Partial<ProjectContext["binding"]> = {}): ProjectContext {
  const workspace = {
    kind: "git" as const,
    worktreeRoot: "C:/workspace/project",
    gitDir: "C:/workspace/project/.git/worktrees/current",
    gitCommonDir: "C:/workspace/project/.git",
    headCommit: "a".repeat(40),
    branchRef: "refs/heads/current",
    detached: false,
    workspaceId: WORKSPACE_ID,
  };
  return {
    binding: {
      projectBindingId: UUID.binding,
      generation: 7,
      contextFingerprint: "f".repeat(64),
    source: "mcp-roots",
      projectId: UUID.project,
      vaultId: UUID.vault,
      storeId: UUID.store,
      workspaceId: WORKSPACE_ID,
      clientNamespace: "desktop/tests",
      clientInstanceId: "primary-a",
      actorRole: "primary",
      projectRoot: "C:/workspace/project",
      vaultRoot: "C:/workspace/project/memory",
      descriptorPath: "C:/workspace/project/memory/.project.json",
      storeRoute: {
        kind: "git-common",
        storeRoot: "C:/workspace/project/.git/project-memory",
        eventsPath: "C:/workspace/project/.git/project-memory/events.sqlite",
        storeManifestPath: "C:/workspace/project/.git/project-memory/store.json",
        projectionManifestPath: "C:/workspace/project/.git/project-memory/projection.json",
      },
      workspace,
      establishedAt: "2026-07-14T00:00:00.000Z",
      ...overrides,
    } as ProjectContext["binding"],
    workspace: workspace as ProjectContext["workspace"],
    checkedAt: "2026-07-14T00:00:01.000Z",
  };
}

function command(overrides: Record<string, unknown> = {}): LifecycleSemanticCommandDraft {
  return decodeLifecycleSemanticCommandDraft({
    commandType: "root-resume",
    commandId: UUID.command,
    idempotencyKey: "resume/thread-alpha/7",
    agentId: "agent-primary",
    expectedProjectId: UUID.project,
    expectedVaultId: UUID.vault,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: "refs/heads/expected",
    sessionId: UUID.session,
    continuityKey: "thread-alpha",
    resumePolicy: "exact",
    expectedOwnerGeneration: "7",
    ...overrides,
  });
}

function audience(overrides: Partial<LifecycleAudience> = {}): LifecycleAudience {
  return {
    presentingActorRole: "primary",
    presentingClientInstanceId: "primary-a",
    targetActorRole: "primary",
    targetClientInstanceId: "primary-a",
    ...overrides,
  };
}

function intent(overrides: Partial<LifecycleIntentInputV1> = {}): LifecycleIntentInputV1 {
  return {
    context: context(),
    command: command(),
    authorizationKind: "protected",
    authoritySessionId: UUID.session,
    targetSessionId: UUID.session,
    capabilityKind: "root-resume-token",
    capabilityGeneration: "7",
    audience: audience(),
    internalWorkflowId: null,
    internalWorkflowGeneration: null,
    internalPlannedWorkId: null,
    ...overrides,
  };
}

const FAMILY_UUID = {
  parent: "00000000-0000-4000-8000-000000000060",
  checkpoint: "00000000-0000-4000-8000-000000000061",
  report: "00000000-0000-4000-8000-000000000062",
  item1: "00000000-0000-4000-8000-000000000063",
  item2: "00000000-0000-4000-8000-000000000064",
  item3: "00000000-0000-4000-8000-000000000065",
  workflow: "00000000-0000-4000-8000-000000000066",
  alternate: "00000000-0000-4000-8000-000000000067",
} as const;

function familyBase(): Record<string, unknown> {
  return {
    commandId: UUID.command,
    idempotencyKey: "lifecycle-family-matrix/command",
    agentId: "agent-primary",
    expectedProjectId: UUID.project,
    expectedVaultId: UUID.vault,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: "refs/heads/expected",
  };
}

function checkpointDraft(taskSummary = "Bounded checkpoint"): Record<string, unknown> {
  return {
    checkpointVersion: 1,
    taskSummary,
    completedItems: [{ summary: "done", confidence: "high" }],
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
  };
}

function persistedCheckpoint(checkpointVersion: 1 | 2): Record<string, unknown> {
  return {
    ...checkpointDraft(),
    checkpointVersion,
    checkpointId: FAMILY_UUID.checkpoint,
    sessionId: UUID.session,
    parentSessionId: null,
    baseEventPosition: "10",
    checkpointEventPosition: "11",
    createdAt: "2026-07-14T10:11:12.123Z",
    creatorAgentId: "agent-primary",
    creatorClientInstanceId: "primary-a",
    sourceState: {
      sourceStateScopeVersion: 1,
      workspaceId: WORKSPACE_ID,
      branchRef: "refs/heads/expected",
      headCommit: "a".repeat(40),
      dirtyWorktreeFingerprint: "b".repeat(64),
    },
    childSummaries: [],
    evidenceCoverage: checkpointVersion === 1
      ? {
          captureMode: "coverage-only",
          contentRetained: false,
          highestContiguousOrdinal: null,
          missingIntervals: [],
        }
      : {
          coverageVersion: 2,
          captureMode: "coverage-only",
          contentRetained: false,
          adapterSessions: [],
        },
  };
}

function internalPhaseBase(): Record<string, unknown> {
  return {
    ...familyBase(),
    commandType: "internal-workflow-phase",
    workflowId: FAMILY_UUID.workflow,
    workflowGeneration: 1,
    sourcePhase: "children-resolved",
    plannedWorkId: "3".repeat(64),
    claim: {
      workflowId: FAMILY_UUID.workflow,
      workflowGeneration: 1,
      claimOwnerId: FAMILY_UUID.parent,
      claimToken: "1",
      claimExpiresAt: "2026-07-14T10:16:12.123Z",
    },
  };
}

function internalAssertions(): TrustedLifecycleIntentAssertionsV1 {
  return {
    authorizationKind: "internal-workflow",
    authorizationSessionId: UUID.session,
    targetSessionId: UUID.session,
    projectId: UUID.project,
    vaultId: UUID.vault,
    storeId: UUID.store,
    workspaceId: WORKSPACE_ID,
    clientNamespace: "desktop/tests",
    capabilityKind: null,
    capabilityGeneration: null,
    presentingActorRole: "primary",
    presentingClientInstanceId: "primary-a",
    targetActorRole: "primary",
    targetClientInstanceId: "primary-a",
    internalWorkflowId: FAMILY_UUID.workflow,
    internalWorkflowGeneration: 1,
    internalPlannedWorkId: "3".repeat(64),
  };
}

function reportDraft(outcomeSummary = "Child completed its analysis"): Record<string, unknown> {
  const item = (summary: string): Record<string, unknown> => ({
    summary,
    evidenceReferences: ["fingerprint:sha256:abc"],
    confidence: "high",
  });
  return {
    reportVersion: 1,
    outcomeSummary,
    findings: [item("finding")],
    proposedDecisions: [item("decision")],
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

function acceptedDisposition(explanation = "Accepted all report items"): Record<string, unknown> {
  return {
    dispositionVersion: 1,
    reportId: FAMILY_UUID.report,
    kind: "accepted",
    acceptedItemIds: [FAMILY_UUID.item1, FAMILY_UUID.item2],
    rejectedItemIds: [],
    deferredItemIds: [],
    supersededByReportId: null,
    explanation,
    allReportItemIds: [FAMILY_UUID.item1, FAMILY_UUID.item2],
  };
}

function endRequest(threshold = 8_000): Record<string, unknown> {
  return {
    requestVersion: 1,
    sessionId: UUID.session,
    childEndPolicy: "require-completed",
    finalCheckpoint: checkpointDraft(),
    validationProfileIds: ["vault-gate"],
    requestedQualityThreshold: threshold,
    requireFullEvidence: false,
    requireMaterialization: true,
  };
}

function endAmendment(requireMaterialization = false): Record<string, unknown> {
  return {
    amendmentVersion: 1,
    childEndPolicy: null,
    finalCheckpoint: null,
    validationProfileIds: null,
    requestedQualityThreshold: null,
    requireFullEvidence: null,
    requireMaterialization,
  };
}

function semanticFamilyCases(): readonly (readonly [
  string,
  Record<string, unknown>,
  Record<string, unknown>,
])[] {
  const base = familyBase();
  return [
    ["root-start", {
      ...base, commandType: "root-start", continuityKey: "thread:key", resumePolicy: "new",
    }, {
      ...base, commandType: "root-start", continuityKey: "thread:changed", resumePolicy: "new",
    }],
    ["root-resume", {
      ...base, commandType: "root-resume", sessionId: UUID.session,
      continuityKey: "thread:key", resumePolicy: "exact", expectedOwnerGeneration: "7",
    }, {
      ...base, commandType: "root-resume", sessionId: UUID.session,
      continuityKey: "thread:key", resumePolicy: "exact", expectedOwnerGeneration: "8",
    }],
    ["root-recovery", {
      ...base, commandType: "root-recovery", sessionId: UUID.session,
      expectedOwnerGeneration: "7", preTransitionCheckpointId: FAMILY_UUID.checkpoint,
      reasonCode: "capability-lost",
    }, {
      ...base, commandType: "root-recovery", sessionId: UUID.session,
      expectedOwnerGeneration: "7", preTransitionCheckpointId: FAMILY_UUID.checkpoint,
      reasonCode: "credential-loss",
    }],
    ["root-suspend", {
      ...base, commandType: "root-suspend", sessionId: UUID.session,
      expectedStreamVersion: "1", checkpoint: checkpointDraft(),
    }, {
      ...base, commandType: "root-suspend", sessionId: UUID.session,
      expectedStreamVersion: "1", checkpoint: checkpointDraft("Changed checkpoint"),
    }],
    ["fork-child", {
      ...base, commandType: "fork-child", parentSessionId: UUID.session,
      expectedStreamVersion: "1",
      assignment: { assignmentId: FAMILY_UUID.item1, summary: "Investigate", scope: "src" },
      directAccessRequested: false,
    }, {
      ...base, commandType: "fork-child", parentSessionId: UUID.session,
      expectedStreamVersion: "1",
      assignment: { assignmentId: FAMILY_UUID.item1, summary: "Investigate", scope: "src" },
      directAccessRequested: true,
    }],
    ["amend-child-assignment", {
      ...base, commandType: "amend-child-assignment", parentSessionId: FAMILY_UUID.parent,
      childSessionId: UUID.session, expectedStreamVersion: "2", expectedAssignmentRevision: "1",
      assignment: { assignmentId: FAMILY_UUID.item1, summary: "Investigate", scope: "src" },
      reasonCode: "scope-refined",
    }, {
      ...base, commandType: "amend-child-assignment", parentSessionId: FAMILY_UUID.parent,
      childSessionId: UUID.session, expectedStreamVersion: "2", expectedAssignmentRevision: "1",
      assignment: { assignmentId: FAMILY_UUID.item1, summary: "Investigate more", scope: "src" },
      reasonCode: "scope-refined",
    }],
    ["record-checkpoint", {
      ...base, commandType: "record-checkpoint", sessionId: UUID.session,
      expectedStreamVersion: "2", expectedBaseEventPosition: "12", draft: checkpointDraft(),
    }, {
      ...base, commandType: "record-checkpoint", sessionId: UUID.session,
      expectedStreamVersion: "2", expectedBaseEventPosition: "12",
      draft: checkpointDraft("Changed checkpoint"),
    }],
    ["record-evidence-batch", {
      ...base, commandType: "record-evidence-batch", adapterSessionId: FAMILY_UUID.parent,
      batchId: FAMILY_UUID.report, sessionId: UUID.session, firstOrdinal: "0", lastOrdinal: "0",
      fingerprintSchemaVersion: 1, fingerprintKeyId: "evidence-key-1",
      fingerprintDomain: "pm-evidence-frame-v1", redactionStatus: "content-not-retained",
      frames: [{ frameId: FAMILY_UUID.item3, ordinal: "0", sourceKind: "tool-result",
        observedAt: "2026-07-14T10:11:12.123Z", contentFingerprint: "a".repeat(64) }],
    }, {
      ...base, commandType: "record-evidence-batch", adapterSessionId: FAMILY_UUID.parent,
      batchId: FAMILY_UUID.report, sessionId: UUID.session, firstOrdinal: "0", lastOrdinal: "0",
      fingerprintSchemaVersion: 1, fingerprintKeyId: "evidence-key-1",
      fingerprintDomain: "pm-evidence-frame-v1", redactionStatus: "content-not-retained",
      frames: [{ frameId: FAMILY_UUID.item3, ordinal: "0", sourceKind: "tool-result",
        observedAt: "2026-07-14T10:11:12.123Z", contentFingerprint: "b".repeat(64) }],
    }],
    ["record-child-report", {
      ...base, commandType: "record-child-report", parentSessionId: FAMILY_UUID.parent,
      childSessionId: UUID.session, childAuthorAgentId: "agent-child",
      expectedStreamVersion: "2", report: reportDraft(),
    }, {
      ...base, commandType: "record-child-report", parentSessionId: FAMILY_UUID.parent,
      childSessionId: UUID.session, childAuthorAgentId: "agent-child",
      expectedStreamVersion: "2", report: reportDraft("Changed outcome"),
    }],
    ["disposition-child-report", {
      ...base, commandType: "disposition-child-report", parentSessionId: FAMILY_UUID.parent,
      childSessionId: UUID.session, expectedStreamVersion: "2",
      disposition: acceptedDisposition(),
    }, {
      ...base, commandType: "disposition-child-report", parentSessionId: FAMILY_UUID.parent,
      childSessionId: UUID.session, expectedStreamVersion: "2",
      disposition: acceptedDisposition("Changed explanation"),
    }],
    ["propose-child-completion", {
      ...base, commandType: "propose-child-completion", childSessionId: UUID.session,
      expectedStreamVersion: "2", reportId: FAMILY_UUID.report,
    }, {
      ...base, commandType: "propose-child-completion", childSessionId: UUID.session,
      expectedStreamVersion: "2", reportId: FAMILY_UUID.alternate,
    }],
    ["complete-child-session", {
      ...base, commandType: "complete-child-session", parentSessionId: FAMILY_UUID.parent,
      childSessionId: UUID.session, expectedStreamVersion: "2", reportId: FAMILY_UUID.report,
    }, {
      ...base, commandType: "complete-child-session", parentSessionId: FAMILY_UUID.parent,
      childSessionId: UUID.session, expectedStreamVersion: "2", reportId: FAMILY_UUID.alternate,
    }],
    ["suspend-child-session", {
      ...base, commandType: "suspend-child-session", parentSessionId: FAMILY_UUID.parent,
      childSessionId: UUID.session, expectedStreamVersion: "2",
      checkpointId: FAMILY_UUID.checkpoint, blockers: ["Awaiting review"], followUps: ["Resume later"],
    }, {
      ...base, commandType: "suspend-child-session", parentSessionId: FAMILY_UUID.parent,
      childSessionId: UUID.session, expectedStreamVersion: "2",
      checkpointId: FAMILY_UUID.checkpoint, blockers: ["Awaiting approval"], followUps: ["Resume later"],
    }],
    ["create-child-transfer", {
      ...base, commandType: "create-child-transfer", parentSessionId: FAMILY_UUID.parent,
      childSessionId: UUID.session, expectedStreamVersion: "2", checkpointId: FAMILY_UUID.checkpoint,
    }, {
      ...base, commandType: "create-child-transfer", parentSessionId: FAMILY_UUID.parent,
      childSessionId: UUID.session, expectedStreamVersion: "2", checkpointId: FAMILY_UUID.alternate,
    }],
    ["claim-child-transfer", {
      ...base, commandType: "claim-child-transfer", rootSessionId: FAMILY_UUID.parent,
      transferTicketId: FAMILY_UUID.item3, expectedStreamVersion: "2",
    }, {
      ...base, commandType: "claim-child-transfer", rootSessionId: FAMILY_UUID.parent,
      transferTicketId: FAMILY_UUID.alternate, expectedStreamVersion: "2",
    }],
    ["request-session-end", {
      ...base, commandType: "request-session-end", request: endRequest(),
    }, {
      ...base, commandType: "request-session-end", request: endRequest(8_001),
    }],
    ["amend-session-end", {
      ...base, commandType: "amend-session-end", sessionId: UUID.session,
      workflowId: FAMILY_UUID.workflow, expectedStreamVersion: "2", amendment: endAmendment(),
    }, {
      ...base, commandType: "amend-session-end", sessionId: UUID.session,
      workflowId: FAMILY_UUID.workflow, expectedStreamVersion: "2", amendment: endAmendment(true),
    }],
    ["cancel-session-end", {
      ...base, commandType: "cancel-session-end", sessionId: UUID.session,
      workflowId: FAMILY_UUID.workflow, expectedStreamVersion: "2",
      preTransitionCheckpointId: FAMILY_UUID.checkpoint,
    }, {
      ...base, commandType: "cancel-session-end", sessionId: UUID.session,
      workflowId: FAMILY_UUID.alternate, expectedStreamVersion: "2",
      preTransitionCheckpointId: FAMILY_UUID.checkpoint,
    }],
    ["abandon-session", {
      ...base, commandType: "abandon-session", sessionId: UUID.session,
      expectedStreamVersion: "2", preTransitionCheckpointId: FAMILY_UUID.checkpoint,
      reasonCode: "explicit-user-approval",
    }, {
      ...base, commandType: "abandon-session", sessionId: UUID.session,
      expectedStreamVersion: "2", preTransitionCheckpointId: FAMILY_UUID.checkpoint,
      reasonCode: "irrecoverable-session",
    }],
  ];
}

const EXPECTED_INTENT_JSON = '{"authorization":{"authorizationKind":"protected","authorizationSessionId":"00000000-0000-4000-8000-000000000010","capabilityGeneration":"7","capabilityKind":"root-resume-token","internalPlannedWorkId":null,"internalWorkflowGeneration":null,"internalWorkflowId":null,"presentingActorRole":"primary","presentingClientInstanceId":"primary-a","targetActorRole":"primary","targetClientInstanceId":"primary-a","targetSessionId":"00000000-0000-4000-8000-000000000010"},"binding":{"clientNamespace":"desktop/tests","projectId":"00000000-0000-4000-8000-000000000001","storeId":"00000000-0000-4000-8000-000000000003","vaultId":"00000000-0000-4000-8000-000000000002","workspaceId":"1111111111111111111111111111111111111111111111111111111111111111"},"command":{"agentId":"agent-primary","commandId":"00000000-0000-4000-8000-000000000020","commandType":"root-resume","continuityKey":"thread-alpha","expectedBranchRef":"refs/heads/expected","expectedOwnerGeneration":"7","expectedProjectId":"00000000-0000-4000-8000-000000000001","expectedVaultId":"00000000-0000-4000-8000-000000000002","expectedWorkspaceId":"1111111111111111111111111111111111111111111111111111111111111111","idempotencyKey":"resume/thread-alpha/7","resumePolicy":"exact","sessionId":"00000000-0000-4000-8000-000000000010"},"lifecycleIntentVersion":1}';
const EXPECTED_INTENT_HASH = "d139825eeb740dc08a706aa5e5a56901b10aae00cda4610a5eac7f6c9ade828c";

function changedHash(base: LifecycleIntentInputV1, changed: LifecycleIntentInputV1): void {
  assert.notEqual(lifecycleIntentHash(changed), lifecycleIntentHash(base));
}

describe("lifecycle intent", () => {
  it("matches the nonsecret canonical golden vector with raw unprefixed SHA-256", () => {
    const input = intent();
    assert.equal(lifecycleIntentCanonicalJson(input), EXPECTED_INTENT_JSON);
    assert.equal(lifecycleIntentHash(input), EXPECTED_INTENT_HASH);
    assert.equal(
      lifecycleIntentHash(input),
      createHash("sha256").update(EXPECTED_INTENT_JSON, "utf8").digest("hex"),
    );
  });

  it("separates nested checkpoint versions while preserving the Version 1 intent vector", () => {
    const version1 = decodeLifecycleSemanticCommandDraft({
      ...familyBase(),
      commandType: "record-checkpoint",
      sessionId: UUID.session,
      expectedStreamVersion: "3",
      expectedBaseEventPosition: null,
      draft: checkpointDraft(),
    });
    const version2 = decodeLifecycleSemanticCommandDraft({
      ...familyBase(),
      commandType: "record-checkpoint",
      sessionId: UUID.session,
      expectedStreamVersion: "3",
      expectedBaseEventPosition: null,
      draft: { ...checkpointDraft(), checkpointVersion: 2 },
    });
    const version1Hash = lifecycleIntentHash(intent({ command: version1 }));
    const version2Hash = lifecycleIntentHash(intent({ command: version2 }));
    assert.notEqual(version1Hash, version2Hash);
    assert.equal(
      buildLifecycleIntentWitness(version2, {
        authorizationKind: "protected",
        authorizationSessionId: UUID.session,
        targetSessionId: UUID.session,
        projectId: UUID.project,
        vaultId: UUID.vault,
        storeId: UUID.store,
        workspaceId: WORKSPACE_ID,
        clientNamespace: "desktop/tests",
        capabilityKind: "root-resume-token",
        capabilityGeneration: "7",
        presentingActorRole: "primary",
        presentingClientInstanceId: "primary-a",
        targetActorRole: "primary",
        targetClientInstanceId: "primary-a",
        internalWorkflowId: null,
        internalWorkflowGeneration: null,
        internalPlannedWorkId: null,
      }).intentHash,
      version2Hash,
    );
    assert.equal(lifecycleIntentHash(intent()), EXPECTED_INTENT_HASH);
  });

  it("strictly separates planned final-checkpoint drafts from persisted internal actions", () => {
    const planned = ([1, 2] as const).map((checkpointVersion) => ({
      ...internalPhaseBase(),
      plannedAction: {
        action: "prepare-final-checkpoint-and-queue-ending",
        finalCheckpointDraft: { ...checkpointDraft(), checkpointVersion },
        materializationTarget: "memory/session-end.md",
      },
    }));
    const plannedWitnesses = planned.map((candidate) => buildLifecycleIntentWitness(
      candidate as unknown as InternalWorkflowExecutionPlan,
      internalAssertions(),
    ));
    assert.notEqual(plannedWitnesses[0]?.intentHash, plannedWitnesses[1]?.intentHash);
    const plannedVersion = (index: number): unknown => {
      const stable = plannedWitnesses[index]?.witness.intent.command as Readonly<Record<string, unknown>>;
      assert.equal(stable.commandType, "internal-workflow-phase");
      assert.equal(Object.hasOwn(stable, "action"), false);
      const plannedAction = stable.plannedAction as Readonly<Record<string, unknown>>;
      assert.equal(plannedAction.action, "prepare-final-checkpoint-and-queue-ending");
      return (plannedAction.finalCheckpointDraft as Readonly<Record<string, unknown>>).checkpointVersion;
    };
    assert.equal(
      plannedVersion(0),
      1,
    );
    assert.equal(
      plannedVersion(1),
      2,
    );

    for (const checkpointVersion of [1, 2] as const) {
      const persistedAsPlan = {
        ...internalPhaseBase(),
        plannedAction: {
          action: "record-final-checkpoint-and-queue-ending",
          finalCheckpoint: persistedCheckpoint(checkpointVersion),
          materializationTarget: "memory/session-end.md",
        },
      };
      assert.throws(() => buildLifecycleIntentWitness(
        persistedAsPlan as unknown as InternalWorkflowExecutionPlan,
        internalAssertions(),
      ));

      const plannedAsPersisted = {
        ...internalPhaseBase(),
        action: {
          action: "prepare-final-checkpoint-and-queue-ending",
          finalCheckpointDraft: { ...checkpointDraft(), checkpointVersion },
          materializationTarget: "memory/session-end.md",
        },
      };
      assert.throws(() => buildLifecycleIntentWitness(
        plannedAsPersisted as unknown as InternalWorkflowSemanticCommand,
        internalAssertions(),
      ));
    }
  });

  it("binds every decoded semantic field", () => {
    const base = intent();
    const variants: readonly Record<string, unknown>[] = [
      { commandId: "00000000-0000-4000-8000-000000000021" },
      { idempotencyKey: "resume/thread-alpha/8" },
      { agentId: "agent-primary-2" },
      { expectedProjectId: "00000000-0000-4000-8000-000000000004" },
      { expectedVaultId: "00000000-0000-4000-8000-000000000005" },
      { expectedWorkspaceId: OTHER_WORKSPACE_ID },
      { expectedBranchRef: "refs/heads/other-expected" },
      { sessionId: UUID.otherSession },
      { continuityKey: "thread-beta" },
      { resumePolicy: "latest-safe", sessionId: null },
      { expectedOwnerGeneration: "8" },
    ];
    for (const variant of variants) {
      changedHash(base, intent({ command: command(variant) }));
    }
  });

  it("retains the complete decoded command and changes hash across all semantic command families", () => {
    const cases = semanticFamilyCases();
    assert.equal(cases.length, 19);
    for (const [name, originalSource, changedSource] of cases) {
      const original = decodeLifecycleSemanticCommandDraft(originalSource);
      const changed = decodeLifecycleSemanticCommandDraft(changedSource);
      const originalInput = name === "root-start"
        ? intent({
          command: original,
          authorizationKind: "initial-authority",
          authoritySessionId: null,
          targetSessionId: null,
          capabilityKind: null,
          capabilityGeneration: null,
        })
        : name === "root-recovery"
          ? intent({
            command: original,
            capabilityKind: null,
            capabilityGeneration: null,
          })
          : intent({ command: original });
      const changedInput: LifecycleIntentInputV1 = {
        ...originalInput,
        command: changed,
      };
      assert.deepEqual(lifecycleIntentPreimage(originalInput).command, original, name);
      assert.notEqual(lifecycleIntentHash(changedInput), lifecycleIntentHash(originalInput), name);
    }
  });

  it("binds resolved identity, authority, capability, and both server-derived audiences", () => {
    const base = intent();
    const stableBindingChanges: readonly Partial<ProjectContext["binding"]>[] = [
      { projectId: "00000000-0000-4000-8000-000000000004" as ProjectContext["binding"]["projectId"] },
      { vaultId: "00000000-0000-4000-8000-000000000005" as ProjectContext["binding"]["vaultId"] },
      { storeId: "00000000-0000-4000-8000-000000000006" as ProjectContext["binding"]["storeId"] },
      { workspaceId: OTHER_WORKSPACE_ID as ProjectContext["binding"]["workspaceId"] },
      { clientNamespace: "desktop/other" },
    ];
    for (const change of stableBindingChanges) {
      changedHash(base, intent({ context: context(change) }));
    }

    changedHash(base, intent({ authoritySessionId: UUID.otherSession }));
    changedHash(base, intent({ targetSessionId: UUID.otherSession }));
    changedHash(base, intent({ capabilityKind: "root-session-handle" }));
    changedHash(base, intent({ capabilityGeneration: "8" }));
    changedHash(base, intent({ audience: audience({ presentingActorRole: "maintenance" }) }));
    changedHash(base, intent({ audience: audience({ presentingClientInstanceId: "maintenance-a" }) }));
    changedHash(base, intent({ audience: audience({ targetActorRole: "untrusted" }) }));
    changedHash(base, intent({ audience: audience({ targetClientInstanceId: "child-a" }) }));
  });

  it("excludes authorization material, volatile bindings, current Git state, and raw evidence", () => {
    const base = intent();
    const changedContext = context({
      projectBindingId: "00000000-0000-4000-8000-000000000031",
      generation: 99,
      contextFingerprint: "e".repeat(64),
    });
    changedContext.checkedAt = "2026-07-15T00:00:00.000Z";
    if (changedContext.workspace.kind !== "git" || changedContext.binding.workspace.kind !== "git") {
      assert.fail("expected git context");
    }
    changedContext.workspace.headCommit = "b".repeat(40);
    changedContext.workspace.branchRef = "refs/heads/live-other";
    changedContext.binding.workspace.headCommit = "b".repeat(40);
    changedContext.binding.workspace.branchRef = "refs/heads/live-other";

    const withPrivateMaterial = {
      ...base,
      context: changedContext,
      proof: { proofNonce: UUID.command, proofFingerprint: "a".repeat(64) },
      proofDigest: "b".repeat(64),
      bearer: "not-a-real-bearer",
      approval: "not-a-real-approval",
      rawEvidence: "not-retained",
    } as unknown as LifecycleIntentInputV1;
    assert.equal(lifecycleIntentHash(withPrivateMaterial), lifecycleIntentHash(base));
    assert.equal(lifecycleIntentCanonicalJson(withPrivateMaterial), lifecycleIntentCanonicalJson(base));
  });

  it("uses null semantic target for initial authority while event-binding the generated target separately", () => {
    const start = decodeLifecycleSemanticCommandDraft({
      commandType: "root-start",
      commandId: UUID.command,
      idempotencyKey: "start/thread-alpha",
      agentId: "agent-primary",
      expectedProjectId: UUID.project,
      expectedVaultId: UUID.vault,
      expectedWorkspaceId: WORKSPACE_ID,
      expectedBranchRef: "refs/heads/expected",
      continuityKey: "thread-alpha",
      resumePolicy: "new",
    });
    const generatedTarget = UUID.session;
    const assertions: TrustedLifecycleIntentAssertionsV1 = {
      authorizationKind: "initial-authority",
      authorizationSessionId: null,
      targetSessionId: generatedTarget,
      projectId: UUID.project,
      vaultId: UUID.vault,
      storeId: UUID.store,
      workspaceId: WORKSPACE_ID,
      clientNamespace: "desktop/tests",
      capabilityKind: null,
      capabilityGeneration: null,
      presentingActorRole: "primary",
      presentingClientInstanceId: "primary-a",
      targetActorRole: "primary",
      targetClientInstanceId: "primary-a",
      internalWorkflowId: null,
      internalWorkflowGeneration: null,
      internalPlannedWorkId: null,
    };

    const built = buildLifecycleIntentWitness(start, assertions);
    assert.equal(built.witness.intent.authorization.targetSessionId, null);
    assert.equal(built.witness.persistedAssertions.targetSessionId, generatedTarget);
    assert.equal(lifecycleIntentHashFromWitnessSource(built.source), built.intentHash);
    assert.equal(
      built.intentHash,
      lifecycleIntentHash({
        context: context(),
        command: start,
        authorizationKind: "initial-authority",
        authoritySessionId: null,
        targetSessionId: null,
        capabilityKind: null,
        capabilityGeneration: null,
        audience: audience(),
        internalWorkflowId: null,
        internalWorkflowGeneration: null,
        internalPlannedWorkId: null,
      }),
    );

    const otherGeneratedTarget = buildLifecycleIntentWitness(start, {
      ...assertions,
      targetSessionId: UUID.otherSession,
    });
    assert.equal(otherGeneratedTarget.intentHash, built.intentHash);
    assert.notEqual(otherGeneratedTarget.source, built.source);
  });

  it("makes the Task 5 witness reuse the complete Task 6 authoritative preimage", () => {
    const input = intent();
    const built = buildLifecycleIntentWitness(input.command, {
      authorizationKind: input.authorizationKind,
      authorizationSessionId: input.authoritySessionId,
      targetSessionId: input.targetSessionId!,
      projectId: input.context.binding.projectId,
      vaultId: input.context.binding.vaultId,
      storeId: input.context.binding.storeId,
      workspaceId: input.context.binding.workspaceId,
      clientNamespace: input.context.binding.clientNamespace,
      capabilityKind: input.capabilityKind,
      capabilityGeneration: input.capabilityGeneration,
      presentingActorRole: input.audience.presentingActorRole,
      presentingClientInstanceId: input.audience.presentingClientInstanceId,
      targetActorRole: input.audience.targetActorRole,
      targetClientInstanceId: input.audience.targetClientInstanceId,
      internalWorkflowId: null,
      internalWorkflowGeneration: null,
      internalPlannedWorkId: null,
    });

    assert.deepEqual(built.witness.intent, lifecycleIntentPreimage(input));
    assert.equal(built.intentHash, lifecycleIntentHash(input));
    assert.equal(lifecycleIntentHashFromWitnessSource(built.source), lifecycleIntentHash(input));
  });

  it("rejects missing protected session bindings and oversized stable namespaces", () => {
    assert.throws(() => lifecycleIntentHash(intent({ authoritySessionId: null })));
    assert.throws(() => lifecycleIntentHash(intent({ targetSessionId: null })));
    assert.throws(() => lifecycleIntentHash(intent({ capabilityGeneration: "0" })));
    assert.throws(() => lifecycleIntentHash(intent({
      capabilityGeneration: "9223372036854775808",
    })));
    assert.throws(() => lifecycleIntentHash(intent({
      context: context({ clientNamespace: "n".repeat(257) }),
    })));
  });
});
