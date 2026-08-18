import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import type { ProjectContext } from "../src/orchestrator/identity/contracts.js";
import type { CheckpointDraftV1, CheckpointV1 } from "../src/orchestrator/lifecycle/contracts/checkpoint.js";
import type {
  CheckpointId,
  SessionId,
  ValidationResultId,
  WorkflowId,
} from "../src/orchestrator/lifecycle/contracts/identifiers.js";
import type { SessionEndRequestV1 } from "../src/orchestrator/lifecycle/contracts/session-end.js";
import type { SessionAggregateState } from "../src/orchestrator/lifecycle/session-aggregate.js";
import {
  SessionEndCoordinator,
  normalizeCoverageOnlyTerminalPhasePlanIdentityV1,
  type SessionEndCoordinatorDriveInput,
} from "../src/orchestrator/lifecycle/session-end.coordinator.js";
import { sessionEndPhaseIdentityV1 } from "../src/orchestrator/lifecycle/session-end-identifiers.js";
import {
  ConnectionBoundSessionEndWorkflowOperations,
  requestedSessionEndStatusV2,
  sessionEndGenerationStatusV2,
} from "../src/orchestrator/lifecycle/session-end-workflow.service.js";
import type { LifecycleOperationalStore } from "../src/orchestrator/lifecycle/lifecycle-operational.store.js";
import {
  createSessionEndEffectiveStateV1,
} from "../src/orchestrator/lifecycle/session-end-effective-state.js";
import {
  SessionEndWorkflowRepository,
  type SessionEndWorkflowClaimV1,
} from "../src/orchestrator/storage/session-end.repository.js";
import type { SessionAuthorityRecord } from "../src/orchestrator/storage/lifecycle-storage.types.js";
import type { LifecycleOutboxPlannedRevision } from "../src/orchestrator/lifecycle/materialization-queue.port.js";
import type {
  SqliteConnection,
  SqliteParams,
  SqliteRow,
  SqliteRunResult,
  SqliteStatement,
} from "../src/orchestrator/storage/sqlite-driver.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import {
  checkpointFixture,
  lifecycleUuid,
  lifecycleTimestamp,
  PROJECT_ID,
  ROOT_SESSION_ID,
  WORKSPACE_ID,
  VAULT_ID,
  STORE_ID,
} from "./support/lifecycle-fixtures.js";
import { applyCurrentProjectStoreSchema } from "./support/current-project-store-schema.js";

const WORKFLOW_ID = lifecycleUuid<WorkflowId>(20_100);
const ROOT_COMMAND_ID = lifecycleUuid(20_101);
const CHILD_SESSION_ID = lifecycleUuid<SessionId>(20_102);
const CHECKPOINT_ID = lifecycleUuid<CheckpointId>(20_103);
const OWNER_ID = "coordinator-test";
const NOW_MS = 1_785_081_600_000n;
const NOW = new Date(Number(NOW_MS)).toISOString();
const AUTHORITY_COMMITMENT = "a".repeat(64);

class NativeStatement implements SqliteStatement {
  constructor(private readonly statement: import("node:sqlite").StatementSync) {
    statement.setReadBigInts(true);
  }

  run(params?: SqliteParams): SqliteRunResult {
    const result = params === undefined ? this.statement.run() : this.statement.run(params);
    return { changes: result.changes as bigint, lastInsertRowid: result.lastInsertRowid as bigint };
  }

  get(params?: SqliteParams): SqliteRow | undefined {
    return (params === undefined ? this.statement.get() : this.statement.get(params)) as SqliteRow | undefined;
  }

  all(params?: SqliteParams): SqliteRow[] {
    return (params === undefined ? this.statement.all() : this.statement.all(params)) as SqliteRow[];
  }

  iterate(params?: SqliteParams): IterableIterator<SqliteRow> {
    return (params === undefined ? this.statement.iterate() : this.statement.iterate(params)) as IterableIterator<SqliteRow>;
  }
}

class NativeConnection implements SqliteConnection {
  readonly database = new DatabaseSync(":memory:");

  exec(sql: string): void { this.database.exec(sql); }
  prepare(sql: string): SqliteStatement { return new NativeStatement(this.database.prepare(sql)); }
  close(): void { this.database.close(); }
}

function context(): ProjectContext {
  const workspace = {
    kind: "non-git" as const,
    workspaceRoot: "C:\\project",
    workspaceId: WORKSPACE_ID,
  };
  return {
    binding: {
      projectBindingId: "coordinator-test-binding",
      generation: 1,
      contextFingerprint: "b".repeat(64),
      source: "explicit-cli",
      projectId: PROJECT_ID,
      vaultId: VAULT_ID,
      storeId: STORE_ID,
      workspaceId: WORKSPACE_ID,
      clientNamespace: "tests",
      clientInstanceId: "coordinator-client",
      actorRole: "maintenance",
      projectRoot: "C:\\project",
      vaultRoot: "C:\\project\\memory",
      descriptorPath: "C:\\project\\memory\\.project-memory.json",
      storeRoute: {
        kind: "vault-local",
        storeRoot: "C:\\project\\memory\\.memory-mcp",
        eventsPath: "C:\\project\\memory\\.memory-mcp\\events.sqlite",
        storeManifestPath: "C:\\project\\memory\\.memory-mcp\\store.json",
        projectionManifestPath: "C:\\project\\memory\\.memory-mcp\\projection.json",
      },
      workspace,
      establishedAt: NOW,
    },
    workspace,
    checkedAt: NOW,
  };
}

function draft(checkpoint: CheckpointV1): CheckpointDraftV1 {
  return Object.freeze({
    checkpointVersion: 1,
    taskSummary: checkpoint.taskSummary,
    completedItems: checkpoint.completedItems,
    inProgressItems: checkpoint.inProgressItems,
    blockers: checkpoint.blockers,
    nextActions: checkpoint.nextActions,
    decisions: checkpoint.decisions,
    assumptions: checkpoint.assumptions,
    unresolvedConflicts: checkpoint.unresolvedConflicts,
    filesTouched: checkpoint.filesTouched,
    artifactReferences: checkpoint.artifactReferences,
    sourceReferences: checkpoint.sourceReferences,
    commandResults: checkpoint.commandResults,
    testResults: checkpoint.testResults,
    materialClaims: checkpoint.materialClaims,
  });
}

function seedWorkflow(
  connection: SqliteConnection,
  requireMaterialization = false,
  triggeringEventPosition = 7n,
): SessionEndWorkflowRepository {
  const checkpoint = checkpointFixture({
    sessionId: ROOT_SESSION_ID,
    checkpointId: CHECKPOINT_ID,
  });
  const finalCheckpoint = draft(checkpoint);
  const request: SessionEndRequestV1 = Object.freeze({
    requestVersion: 1,
    sessionId: ROOT_SESSION_ID,
    childEndPolicy: "suspend-and-carry-forward",
    finalCheckpoint,
    validationProfileIds: ["profile-a"],
    requestedQualityThreshold: 1,
    requireFullEvidence: false,
    requireMaterialization,
  });
  const effectiveState = createSessionEndEffectiveStateV1({
    request,
    effectivePolicy: {
      qualityPolicyVersion: 1,
      profiles: [{ profileId: "profile-a", profileVersion: 1, required: true, weight: 1 }],
      qualityThreshold: 1,
      requireFullEvidence: false,
      requireMaterialization,
    },
  });
  const status = requestedSessionEndStatusV2({
    sessionId: ROOT_SESSION_ID,
    workflowId: WORKFLOW_ID,
    workflowGeneration: 1,
    priorRootState: "active",
    triggeringEventPosition,
    evidenceWindowState: "sealed",
    materializationRequired: requireMaterialization,
  });
  const repository = new SessionEndWorkflowRepository(connection);
  repository.createRequested({
    projectId: PROJECT_ID,
    workflowId: WORKFLOW_ID,
    workflowGeneration: 1,
    rootCommandId: ROOT_COMMAND_ID,
    sessionId: ROOT_SESSION_ID,
    triggeringEventPosition,
    expectedAuthorityCommitment: AUTHORITY_COMMITMENT,
    priorRootState: "active",
    resultJson: canonicalJson(status),
    evidenceWindowState: "sealed",
    now: NOW,
    effectiveState,
  });
  return repository;
}

function claimWorkflow(repository: SessionEndWorkflowRepository): SessionEndWorkflowClaimV1 {
  const claim = repository.claim({
    projectId: PROJECT_ID,
    workflowId: WORKFLOW_ID,
    workflowGeneration: 1,
    ownerId: OWNER_ID,
    observedNowMs: NOW_MS,
    leaseDurationMs: 60_000n,
  });
  assert.ok(claim !== null);
  return claim;
}

function operationalStore(
  connection: SqliteConnection,
  options: {
    readonly outboxPlans?: {
      assertExactPlannedRevision(query: unknown): LifecycleOutboxPlannedRevision;
    };
    readonly materializations?: { isCompleted(input: unknown): boolean };
  } = {},
): LifecycleOperationalStore {
  const workflows = new ConnectionBoundSessionEndWorkflowOperations(connection);
  return {
    execute(work: never, onCurrent: (transaction: never) => unknown): never {
      void work;
      connection.exec("BEGIN IMMEDIATE");
      try {
        const publicResult = onCurrent({
          workflows,
          outboxPlans: options.outboxPlans ?? {
            assertExactPlannedRevision: () => {
              throw new Error("outbox plan not expected in this proof");
            },
          },
          ...(options.materializations === undefined
            ? {}
            : { materializations: options.materializations }),
        } as never);
        connection.exec("COMMIT");
        return { publicResult } as never;
      } catch (error) {
        connection.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as LifecycleOperationalStore;
}

function driveInput(claim: SessionEndWorkflowClaimV1): SessionEndCoordinatorDriveInput {
  return {
    context: context(),
    ownerId: OWNER_ID,
    observedNowMs: NOW_MS,
    leaseDurationMs: 60_000n,
    claim,
  };
}

function baseCoordinator(
  connection: SqliteConnection,
  authority: Record<string, unknown>,
  childService: Record<string, unknown> = { execute: () => ({}) },
): SessionEndCoordinator {
  return new SessionEndCoordinator({
    connection,
    commandStore: {} as never,
    operationalStore: operationalStore(connection),
    authorityRepository: authority as never,
    transferRepository: {
      listBySourceRoot: () => [],
      listUnclaimedEndingScopeProjectionsBySourceRoot: () => [],
    } as never,
    childService: childService as never,
    clock: { nowMs: () => NOW_MS, now: () => NOW },
    identitySource: { uuid: () => lifecycleUuid(20_200) },
  });
}

function migratedConnection(): NativeConnection {
  const connection = new NativeConnection();
  applyCurrentProjectStoreSchema(connection, {
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
  }, NOW);
  return connection;
}

function workflowOnlyConnection(): NativeConnection {
  const connection = new NativeConnection();
  connection.exec(`
    CREATE TABLE workflow_instances (
      project_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      workflow_type TEXT NOT NULL,
      generation INTEGER NOT NULL,
      state TEXT NOT NULL,
      phase TEXT NOT NULL,
      root_command_id TEXT NOT NULL,
      result_json TEXT,
      error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      session_id TEXT NOT NULL,
      triggering_event_position INTEGER NOT NULL,
      expected_authority_commitment TEXT NOT NULL,
      coordinator_owner_id TEXT,
      coordinator_claim_token INTEGER,
      coordinator_claim_expires_at TEXT,
      coordinator_attempt_count INTEGER NOT NULL,
      coordinator_failure_class TEXT,
      coordinator_error_code TEXT,
      coordinator_next_attempt_at TEXT,
      validation_attempt_plan_generation INTEGER,
      validation_attempt_plans_json TEXT,
      evidence_frozen_checkpoint_event_position INTEGER,
      evidence_frozen_generation INTEGER,
      evidence_window_state TEXT,
      final_ending_scope_bindings_json TEXT,
      PRIMARY KEY(project_id, workflow_id)
    ) STRICT;
  `);
  return connection;
}

function authorityWithChildren(children: readonly SessionAuthorityRecord[]) {
  return {
    listNonterminalChildren: () => children,
    listChildHistoryBounded: () => children,
    get: () => null,
    requireFoldMatch: () => ({}) as SessionAggregateState,
    latestCheckpoint: () => null,
    loadEvents: () => [],
  };
}

describe("SessionEndCoordinator", () => {
  it("regenerates the complete deterministic tuple when coverage-only policy rewrites a passing terminal action", () => {
    const passedAction = {
      action: "record-verification-passed" as const,
      validationResultIds: [lifecycleUuid<ValidationResultId>(20_104)],
      qualityScore: 10_000,
    };
    const original = sessionEndPhaseIdentityV1({
      projectId: PROJECT_ID,
      workflowId: WORKFLOW_ID,
      workflowGeneration: 1,
      sourcePhase: "validating",
      action: passedAction,
    });
    const plan = {
      commandType: "internal-workflow-phase" as const,
      commandId: original.commandId,
      idempotencyKey: original.idempotencyKey,
      agentId: OWNER_ID,
      expectedProjectId: PROJECT_ID,
      expectedVaultId: VAULT_ID,
      expectedWorkspaceId: WORKSPACE_ID,
      expectedBranchRef: null,
      workflowId: WORKFLOW_ID,
      workflowGeneration: 1,
      sourcePhase: "validating",
      plannedWorkId: original.plannedWorkId,
      claim: {
        workflowId: WORKFLOW_ID,
        workflowGeneration: 1,
        claimOwnerId: OWNER_ID,
        claimToken: "1",
        claimExpiresAt: NOW,
      },
      plannedAction: passedAction,
    };
    const first = normalizeCoverageOnlyTerminalPhasePlanIdentityV1(
      { requireFullEvidence: true },
      plan,
    );
    const replay = normalizeCoverageOnlyTerminalPhasePlanIdentityV1(
      { requireFullEvidence: true },
      plan,
    );
    const expected = sessionEndPhaseIdentityV1({
      projectId: PROJECT_ID,
      workflowId: WORKFLOW_ID,
      workflowGeneration: 1,
      sourcePhase: "validating",
      action: first.plannedAction as unknown as import("../src/orchestrator/contracts/event.js").JsonValue,
    });
    assert.equal(first.plannedAction.action, "record-verification-failed");
    assert.deepEqual(
      [first.commandId, first.idempotencyKey, first.plannedWorkId],
      [expected.commandId, expected.idempotencyKey, expected.plannedWorkId],
    );
    assert.deepEqual(
      [replay.commandId, replay.idempotencyKey, replay.plannedWorkId],
      [first.commandId, first.idempotencyKey, first.plannedWorkId],
    );
    assert.notEqual(first.commandId, original.commandId);
  });

  it("proves children resolved from all bounded child and ticket history", () => {
    const connection = migratedConnection();
    try {
      const repository = seedWorkflow(connection);
      const claim = claimWorkflow(repository);
      const coordinator = baseCoordinator(connection, authorityWithChildren([]));
      const result = coordinator.driveOnce(driveInput(claim)) as Record<string, unknown>;
      assert.equal(result.action, "mark-children-resolved");
      assert.equal(result.progressed, true);
      const status = result.status as Record<string, unknown>;
      assert.equal(status.phase, "children-resolved");
      assert.equal(status.materializationRequired, false);
      assert.equal(repository.read(PROJECT_ID, WORKFLOW_ID)?.phase, "children-resolved");
      assert.equal(repository.read(PROJECT_ID, WORKFLOW_ID)?.coordinatorOwnerId, null);
    } finally {
      connection.close();
    }
  });

  it("selects one eligible child by binary UUID order", () => {
    const connection = migratedConnection();
    try {
      const repository = seedWorkflow(connection);
      const claim = claimWorkflow(repository);
      const checkpoint = checkpointFixture({
        sessionId: CHILD_SESSION_ID,
        parentSessionId: ROOT_SESSION_ID,
        checkpointId: CHECKPOINT_ID,
        baseEventPosition: 8n,
        checkpointEventPosition: 9n,
      });
      const child = {
        projectId: PROJECT_ID,
        sessionId: CHILD_SESSION_ID,
        sessionKind: "child",
        parentSessionId: ROOT_SESSION_ID,
        semanticState: "active",
        terminalEventPosition: null,
        authorityEventPosition: 10n,
        authorityCommitment: AUTHORITY_COMMITMENT,
        childCapabilityGeneration: 2n,
      } as unknown as SessionAuthorityRecord;
      const lowerChild = {
        ...child,
        sessionId: lifecycleUuid<SessionId>(20_101),
      } as unknown as SessionAuthorityRecord;
      let selectedChild: string | null = null;
      const authority = {
        ...authorityWithChildren([child, lowerChild]),
        requireFoldMatch: () => ({
          kind: "child",
          state: "active",
          eventPosition: 10n,
          streamVersion: 6n,
        }) as unknown as SessionAggregateState,
        latestCheckpoint: () => checkpoint,
        loadEvents: () => [],
      };
      const childService = {
        execute: (_context: ProjectContext, plan: { plannedAction: { childSessionId: string } }) => {
          selectedChild = plan.plannedAction.childSessionId;
          return { resultVersion: 1, action: "carry-forward-child" };
        },
      };
      const coordinator = baseCoordinator(connection, authority, childService);
      const result = coordinator.driveOnce(driveInput(claim)) as Record<string, unknown>;
      assert.equal(selectedChild, lowerChild.sessionId);
      assert.equal(result.action, "carry-forward-child");
      assert.equal(repository.read(PROJECT_ID, WORKFLOW_ID)?.phase, "requested");
      assert.equal(repository.read(PROJECT_ID, WORKFLOW_ID)?.coordinatorOwnerId, null);
    } finally {
      connection.close();
    }
  });

  it("waits for the exact completed outbox row before completing required materialization", () => {
    const connection = workflowOnlyConnection();
    try {
      const repository = seedWorkflow(connection, true, 9n);
      const terminalPosition = 11n;
      const current = repository.read(PROJECT_ID, WORKFLOW_ID)!;
      const completionStatus = sessionEndGenerationStatusV2({
        current,
        priorRootState: "active",
        workflowGeneration: 1,
        triggeringEventPosition: terminalPosition,
        phase: "completion-appended",
        evidenceWindowState: "sealed",
        materializationRequired: true,
        clearFrozenGroup: false,
      });
      connection.prepare(`
        UPDATE workflow_instances
        SET phase = 'completion-appended', result_json = $resultJson,
            triggering_event_position = $triggeringEventPosition
        WHERE project_id = $projectId AND workflow_id = $workflowId
      `).run({
        $resultJson: canonicalJson({
          resultVersion: 2,
          action: "append-terminal-completion",
          progressed: true,
          previousPhase: "verification-passed",
          status: completionStatus,
        }),
        $triggeringEventPosition: terminalPosition,
        $projectId: PROJECT_ID,
        $workflowId: WORKFLOW_ID,
      });
      const plan: LifecycleOutboxPlannedRevision = Object.freeze({
        projectId: PROJECT_ID,
        sessionId: ROOT_SESSION_ID,
        artifactKind: "compatibility-session-log",
        materializationRevision: terminalPosition,
        triggeringEventPosition: terminalPosition,
        origin: {
          kind: "workflow",
          workflowId: WORKFLOW_ID,
          workflowGeneration: 1,
        } as const,
        triggeringEventType: "SessionEnded" as const,
        targetKey: `lifecycle-log/${ROOT_SESSION_ID}/${terminalPosition.toString()}`,
        artifactPath: `05_Agent_Session_Logs/2026-08-09-session-${ROOT_SESSION_ID}.md`,
        triggeringPayloadHash: "d".repeat(64),
        expectedPriorFingerprint: null,
        nextFingerprint: {
          algorithm: "hmac-sha256",
          schemaVersion: 1,
          keyId: "materialization-key",
          domain: "pm-materialization-fingerprint-v1",
          value: "e".repeat(64),
        } as const,
        createdAt: NOW,
      });
      let completed = false;
      const authority = {
        ...authorityWithChildren([]),
        get: () => ({
          sessionKind: "root",
          semanticState: "ended",
          terminalEventPosition: terminalPosition,
          terminalEventType: "SessionEnded",
        }),
        requireFoldMatch: () => ({ kind: "root", state: "ended" }) as unknown as SessionAggregateState,
      };
      const coordinator = new SessionEndCoordinator({
        connection,
        commandStore: {} as never,
        operationalStore: operationalStore(connection, {
          outboxPlans: {
            assertExactPlannedRevision: (query) => {
              assert.equal((query as { materializationRevision: bigint }).materializationRevision, terminalPosition);
              return plan;
            },
          },
          materializations: {
            isCompleted: () => completed,
          },
        }),
        authorityRepository: authority as never,
        transferRepository: {
          listBySourceRoot: () => [],
          listUnclaimedEndingScopeProjectionsBySourceRoot: () => [],
        } as never,
        childService: { execute: () => ({}) } as never,
        clock: { nowMs: () => NOW_MS, now: () => NOW },
        identitySource: { uuid: () => lifecycleUuid(20_200) },
      });

      let claim = claimWorkflow(repository);
      const pending = coordinator.driveOnce(driveInput(claim)) as Record<string, unknown>;
      assert.equal(pending.progressed, false);
      assert.equal(repository.read(PROJECT_ID, WORKFLOW_ID)?.phase, "completion-appended");

      completed = true;
      const confirmed = coordinator.driveOnce(driveInput(claim)) as Record<string, unknown>;
      assert.equal(confirmed.action, "confirm-completed-materialization");
      assert.equal((confirmed.status as Record<string, unknown>).phase, "completed-materialization-confirmed");

      claim = claimWorkflow(repository);
      const finished = coordinator.driveOnce(driveInput(claim)) as Record<string, unknown>;
      assert.equal(finished.action, "complete-after-materialization");
      assert.equal((finished.status as Record<string, unknown>).phase, "completed");
      assert.equal(repository.read(PROJECT_ID, WORKFLOW_ID)?.phase, "completed");
    } finally {
      connection.close();
    }
  });
});
