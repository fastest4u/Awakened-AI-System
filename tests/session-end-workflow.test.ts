import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import {
  LifecycleOperationalStore,
  type LifecycleOperationalRepositorySet,
  type WorkflowSelectionOperationalWorkIdentity,
} from "../src/orchestrator/lifecycle/lifecycle-operational.store.js";
import {
  ConnectionBoundSessionEndWorkflowOperations,
  requestedSessionEndStatusV2,
  SessionEndWorkflowService,
} from "../src/orchestrator/lifecycle/session-end-workflow.service.js";
import type { SessionEndStatusV2 } from "../src/orchestrator/lifecycle/contracts/session-end.js";
import type { LifecycleFaultInjector } from "../src/orchestrator/lifecycle/lifecycle-faults.js";
import {
  SessionEndWorkflowRepository,
  type SessionEndWorkflowRequestedInputV1,
} from "../src/orchestrator/storage/session-end.repository.js";
import { sessionEndEffectiveStateHashV1 } from "../src/orchestrator/lifecycle/session-end-effective-state.js";
import type { SessionEndEffectiveStateV1 } from "../src/orchestrator/lifecycle/session-end-effective-state.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import type {
  SqliteConnection,
  SqliteParams,
  SqliteRow,
  SqliteRunResult,
  SqliteStatement,
} from "../src/orchestrator/storage/sqlite-driver.js";
import { lifecycleUuid } from "./support/lifecycle-fixtures.js";

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

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WORKFLOW_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ROOT_COMMAND_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RUN_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const RESULT_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const COMMAND_ID = "11111111-2222-4333-8444-555555555555";

const REQUEST = Object.freeze({
  requestVersion: 1 as const,
  sessionId: SESSION_ID,
  childEndPolicy: "require-completed" as const,
  finalCheckpoint: Object.freeze({
    checkpointVersion: 1 as const,
    taskSummary: "done",
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
  }),
  validationProfileIds: ["profile-a"],
  requestedQualityThreshold: 1,
  requireFullEvidence: false,
  requireMaterialization: false,
});

const EFFECTIVE_STATE_WITHOUT_HASH = Object.freeze({
  effectiveStateVersion: 1 as const,
  effectiveStateDomain: "project-memory/session-end-effective-state/v1" as const,
  request: REQUEST,
  effectivePolicy: Object.freeze({
    qualityPolicyVersion: 1 as const,
    profiles: [{ profileId: "profile-a", profileVersion: 1, required: true, weight: 1 }],
    qualityThreshold: 1,
    requireFullEvidence: false,
    requireMaterialization: false,
  }),
  effectiveFinalCheckpoint: REQUEST.finalCheckpoint,
});
const EFFECTIVE_STATE = Object.freeze({
  ...EFFECTIVE_STATE_WITHOUT_HASH,
  effectiveStateHash: sessionEndEffectiveStateHashV1(EFFECTIVE_STATE_WITHOUT_HASH),
}) as unknown as SessionEndEffectiveStateV1;

function workflowConnection(): NativeConnection {
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
    INSERT INTO workflow_instances(
      project_id, workflow_id, workflow_type, generation, state, phase,
      root_command_id, result_json, error_code, created_at, updated_at,
      session_id, triggering_event_position, expected_authority_commitment,
      coordinator_owner_id, coordinator_claim_token, coordinator_claim_expires_at,
      coordinator_attempt_count, coordinator_failure_class, coordinator_error_code,
      coordinator_next_attempt_at, validation_attempt_plan_generation,
      validation_attempt_plans_json, evidence_frozen_checkpoint_event_position,
      evidence_frozen_generation, evidence_window_state, final_ending_scope_bindings_json
    ) VALUES (
      '${PROJECT_ID}', '${WORKFLOW_ID}', 'session-end', 1, 'active', 'requested',
      '${ROOT_COMMAND_ID}', NULL, NULL, '2026-08-15T00:00:00.000Z',
      '2026-08-15T00:00:00.000Z', '${SESSION_ID}', 7, '${"a".repeat(64)}',
      NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'sealed', NULL
    );
  `);
  return connection;
}

function workflowWork(): WorkflowSelectionOperationalWorkIdentity {
  return {
    kind: "workflow-selection",
    projectId: PROJECT_ID,
    workId: "workflow-scan",
    operation: "claim-next",
    ownerId: "coordinator-a",
  };
}

function repositorySet(workflows: object): LifecycleOperationalRepositorySet {
  return {
    workflows: workflows as LifecycleOperationalRepositorySet["workflows"],
    outbox: {},
  };
}

describe("SessionEndWorkflowService", () => {
  it("emits workflow-create before writing a requested workflow row", () => {
    const connection = workflowConnection();
    connection.prepare("DELETE FROM workflow_instances WHERE project_id = $projectId AND workflow_id = $workflowId").run({
      $projectId: PROJECT_ID,
      $workflowId: WORKFLOW_ID,
    });
    const hits: Array<{
      readonly boundary: string;
      readonly point: string;
      readonly context: unknown;
    }> = [];
    const faultInjector: LifecycleFaultInjector = {
      hit(boundary, point, context): void {
        hits.push({ boundary, point, context });
        throw new Error("INJECTED_WORKFLOW_CREATE_FAULT");
      },
    };
    const repository = new SessionEndWorkflowRepository(connection, { faultInjector });
    const requested = requestedSessionEndStatusV2({
      sessionId: SESSION_ID,
      workflowId: WORKFLOW_ID,
      workflowGeneration: 1,
      priorRootState: "active",
      triggeringEventPosition: 8n,
      evidenceWindowState: "sealed",
      materializationRequired: false,
    });

    assert.throws(
      () => repository.createRequested({
        projectId: PROJECT_ID,
        workflowId: WORKFLOW_ID,
        workflowGeneration: 1,
        rootCommandId: ROOT_COMMAND_ID,
        sessionId: SESSION_ID,
        triggeringEventPosition: 8n,
        expectedAuthorityCommitment: "a".repeat(64),
        priorRootState: "active",
        resultJson: canonicalJson(requested),
        evidenceWindowState: "sealed",
        now: "2026-08-15T00:00:00.000Z",
        effectiveState: EFFECTIVE_STATE,
      }),
      (error: unknown): boolean => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "INJECTED_WORKFLOW_CREATE_FAULT");
        return true;
      },
    );
    assert.deepEqual(hits, [{
      boundary: "workflow-create",
      point: "before-write",
      context: {
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        workflowId: WORKFLOW_ID,
        commandId: ROOT_COMMAND_ID,
        idempotencyKeyHash: null,
        workId: null,
        eventPosition: "8",
        materializationRevision: null,
      },
    }]);
    assert.equal(
      connection.prepare("SELECT count(*) AS count FROM workflow_instances WHERE project_id = $projectId AND workflow_id = $workflowId").get({
        $projectId: PROJECT_ID,
        $workflowId: WORKFLOW_ID,
      })?.count,
      0n,
    );
    connection.close();
  });

  it("emits cancellation-rewrite before rewriting an eligible workflow row", () => {
    const connection = workflowConnection();
    const hits: Array<{
      readonly boundary: string;
      readonly point: string;
      readonly context: unknown;
    }> = [];
    const faultInjector: LifecycleFaultInjector = {
      hit(boundary, point, context): void {
        hits.push({ boundary, point, context });
        throw new Error("INJECTED_CANCELLATION_REWRITE_FAULT");
      },
    };
    const repository = new SessionEndWorkflowRepository(connection, { faultInjector });

    assert.throws(
      () => repository.cancelGeneration({
        projectId: PROJECT_ID,
        workflowId: WORKFLOW_ID,
        previousWorkflowGeneration: 1,
        workflowGeneration: 2,
        rootCommandId: COMMAND_ID,
        sessionId: SESSION_ID,
        triggeringEventPosition: 8n,
        expectedAuthorityCommitment: "a".repeat(64),
        restoredState: "active",
        resultJson: canonicalJson({ phase: "cancelled", workflowGeneration: 2 }),
        now: "2026-08-15T00:00:01.000Z",
      }),
      (error: unknown): boolean => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "INJECTED_CANCELLATION_REWRITE_FAULT");
        return true;
      },
    );
    assert.deepEqual(hits, [{
      boundary: "cancellation-rewrite",
      point: "before-write",
      context: {
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        workflowId: WORKFLOW_ID,
        commandId: COMMAND_ID,
        idempotencyKeyHash: null,
        workId: null,
        eventPosition: "8",
        materializationRevision: null,
      },
    }]);
    const after = repository.read(PROJECT_ID, WORKFLOW_ID);
    assert.equal(after?.generation, 1);
    assert.equal(after?.phase, "requested");
    connection.close();
  });

  it("emits abandonment-rewrite before abandoning an eligible workflow row", () => {
    const connection = workflowConnection();
    const hits: Array<{
      readonly boundary: string;
      readonly point: string;
      readonly context: unknown;
    }> = [];
    const faultInjector: LifecycleFaultInjector = {
      hit(boundary, point, context): void {
        hits.push({ boundary, point, context });
        throw new Error("INJECTED_ABANDONMENT_REWRITE_FAULT");
      },
    };
    const repository = new SessionEndWorkflowRepository(connection, { faultInjector });

    assert.throws(
      () => repository.abandonGeneration({
        projectId: PROJECT_ID,
        workflowId: WORKFLOW_ID,
        workflowGeneration: 1,
        rootCommandId: COMMAND_ID,
        sessionId: SESSION_ID,
        triggeringEventPosition: 8n,
        expectedAuthorityCommitment: "a".repeat(64),
        resultJson: canonicalJson({ phase: "abandoned", workflowGeneration: 1 }),
        now: "2026-08-15T00:00:01.000Z",
      }),
      (error: unknown): boolean => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "INJECTED_ABANDONMENT_REWRITE_FAULT");
        return true;
      },
    );
    assert.deepEqual(hits, [{
      boundary: "abandonment-rewrite",
      point: "before-write",
      context: {
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        workflowId: WORKFLOW_ID,
        commandId: COMMAND_ID,
        idempotencyKeyHash: null,
        workId: null,
        eventPosition: "8",
        materializationRevision: null,
      },
    }]);
    const after = repository.read(PROJECT_ID, WORKFLOW_ID);
    assert.equal(after?.state, "active");
    assert.equal(after?.phase, "requested");
    connection.close();
  });

  it("emits final-checkpoint before recording an eligible checkpoint", () => {
    const connection = workflowConnection();
    connection.prepare(`
      UPDATE workflow_instances
      SET phase = 'children-resolved',
          coordinator_owner_id = 'coordinator-a',
          coordinator_claim_token = 1,
          coordinator_claim_expires_at = '2026-08-15T00:01:00.000Z',
          coordinator_attempt_count = 1,
          evidence_window_state = 'sealed',
          evidence_frozen_checkpoint_event_position = NULL,
          evidence_frozen_generation = NULL,
          final_ending_scope_bindings_json = NULL
      WHERE project_id = $projectId AND workflow_id = $workflowId
    `).run({
      $projectId: PROJECT_ID,
      $workflowId: WORKFLOW_ID,
    });
    const hits: Array<{
      readonly boundary: string;
      readonly point: string;
      readonly context: unknown;
    }> = [];
    const injected = new Error("INJECTED_FINAL_CHECKPOINT_FAULT");
    const faultInjector: LifecycleFaultInjector = {
      hit(boundary, point, context): void {
        hits.push({ boundary, point, context });
        throw injected;
      },
    };
    const repository = new SessionEndWorkflowRepository(connection, { faultInjector });

    assert.throws(
      () => repository.recordFinalCheckpoint({
        projectId: PROJECT_ID,
        workflowId: WORKFLOW_ID,
        workflowGeneration: 1,
        sessionId: SESSION_ID,
        rootCommandId: COMMAND_ID,
        ownerId: "coordinator-a",
        claimToken: 1n,
        checkpointId: RESULT_ID,
        checkpointEventPosition: 8n,
        checkpointFingerprint: "b".repeat(64),
        finalEndingScopeBindingsJson: canonicalJson([]),
        resultJson: canonicalJson({ phase: "final-checkpoint-recorded" }),
        now: "2026-08-15T00:00:01.000Z",
      }),
      (error: unknown): boolean => {
        assert.equal(error, injected);
        return true;
      },
    );
    assert.deepEqual(hits, [{
      boundary: "final-checkpoint",
      point: "before-write",
      context: {
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        workflowId: WORKFLOW_ID,
        commandId: COMMAND_ID,
        idempotencyKeyHash: null,
        workId: null,
        eventPosition: "8",
        materializationRevision: null,
      },
    }]);
    const after = repository.read(PROJECT_ID, WORKFLOW_ID);
    assert.equal(after?.phase, "children-resolved");
    assert.equal(after?.evidenceFrozenCheckpointEventPosition, null);
    assert.equal(after?.evidenceFrozenGeneration, null);
    assert.equal(after?.finalEndingScopeBindingsJson, null);
    assert.equal(after?.coordinatorOwnerId, "coordinator-a");
    assert.equal(after?.coordinatorClaimToken, 1n);
    assert.equal(after?.coordinatorClaimExpiresAt, "2026-08-15T00:01:00.000Z");
    connection.close();
  });

  it("anchors requested status and reopens one cancelled row at the next generation", () => {
    const connection = workflowConnection();
    const repository = new SessionEndWorkflowRepository(connection);
    connection.prepare("DELETE FROM workflow_instances WHERE project_id = $projectId AND workflow_id = $workflowId").run({
      $projectId: PROJECT_ID,
      $workflowId: WORKFLOW_ID,
    });
    const first = requestedSessionEndStatusV2({
      sessionId: SESSION_ID,
      workflowId: WORKFLOW_ID,
      workflowGeneration: 1,
      priorRootState: "active",
      triggeringEventPosition: 8n,
      evidenceWindowState: "sealed",
      materializationRequired: false,
    });
    const input: SessionEndWorkflowRequestedInputV1 = {
      projectId: PROJECT_ID,
      workflowId: WORKFLOW_ID,
      workflowGeneration: 1,
      rootCommandId: ROOT_COMMAND_ID,
      sessionId: SESSION_ID,
      triggeringEventPosition: 8n,
      expectedAuthorityCommitment: "a".repeat(64),
      priorRootState: "active",
      resultJson: canonicalJson(first),
      evidenceWindowState: "sealed",
      now: "2026-08-15T00:00:00.000Z",
      effectiveState: EFFECTIVE_STATE,
    };
    repository.createRequested(input);
    connection.prepare(`UPDATE workflow_instances SET phase = 'cancelled', generation = 2, result_json = NULL, evidence_window_state = 'sealed' WHERE project_id = $projectId AND workflow_id = $workflowId`).run({
      $projectId: PROJECT_ID,
      $workflowId: WORKFLOW_ID,
    });
    repository.reopenCancelled({
      ...input,
      workflowGeneration: 3,
      rootCommandId: COMMAND_ID,
      triggeringEventPosition: 12n,
      resultJson: null,
    });
    const row = repository.read(PROJECT_ID, WORKFLOW_ID);
    assert.equal(row?.generation, 3);
    assert.equal(row?.phase, "requested");
    assert.equal(row?.rootCommandId, COMMAND_ID);
    assert.equal(row?.triggeringEventPosition, 12n);
    assert.equal(row?.resultJson, null);
    connection.close();
  });

  it("fences amendment and cancellation generations while clearing stale operational state", () => {
    const connection = workflowConnection();
    const repository = new SessionEndWorkflowRepository(connection);
    connection.prepare("DELETE FROM workflow_instances WHERE project_id = $projectId AND workflow_id = $workflowId").run({
      $projectId: PROJECT_ID,
      $workflowId: WORKFLOW_ID,
    });
    const requested = requestedSessionEndStatusV2({
      sessionId: SESSION_ID,
      workflowId: WORKFLOW_ID,
      workflowGeneration: 1,
      priorRootState: "active",
      triggeringEventPosition: 8n,
      evidenceWindowState: "sealed",
      materializationRequired: false,
    });
    const requestedObject = JSON.parse(canonicalJson(requested)) as Record<string, unknown>;
    repository.createRequested({
      projectId: PROJECT_ID,
      workflowId: WORKFLOW_ID,
      workflowGeneration: 1,
      rootCommandId: ROOT_COMMAND_ID,
      sessionId: SESSION_ID,
      triggeringEventPosition: 8n,
      expectedAuthorityCommitment: "a".repeat(64),
      priorRootState: "active",
      resultJson: canonicalJson(requested),
      evidenceWindowState: "sealed",
      now: "2026-08-15T00:00:00.000Z",
      effectiveState: EFFECTIVE_STATE,
    });
    connection.prepare(`
      UPDATE workflow_instances
      SET coordinator_owner_id = 'old-coordinator', coordinator_claim_token = 1,
          coordinator_claim_expires_at = '2026-08-15T00:01:00.000Z',
          coordinator_attempt_count = 1, validation_attempt_plan_generation = 1,
          validation_attempt_plans_json = '[]', error_code = 'OLD_FAILURE'
      WHERE project_id = $projectId AND workflow_id = $workflowId
    `).run({ $projectId: PROJECT_ID, $workflowId: WORKFLOW_ID });
    const amended = {
      ...requestedObject,
      workflowGeneration: 2,
      phase: "requested" as const,
      triggeringEventPosition: "9",
      evidenceWindow: {
        evidenceWindowState: "open" as const,
        evidenceFrozenCheckpointEventPosition: null,
        evidenceFrozenGeneration: null,
      },
    } as unknown as SessionEndStatusV2;
    repository.amendGeneration({
      projectId: PROJECT_ID,
      workflowId: WORKFLOW_ID,
      previousWorkflowGeneration: 1,
      workflowGeneration: 2,
      rootCommandId: COMMAND_ID,
      sessionId: SESSION_ID,
      triggeringEventPosition: 9n,
      expectedAuthorityCommitment: "a".repeat(64),
      phase: "requested",
      resultJson: canonicalJson(amended),
      evidenceWindowState: "open",
      clearFrozenGroup: true,
      now: "2026-08-15T00:00:01.000Z",
    });
    const afterAmendment = repository.read(PROJECT_ID, WORKFLOW_ID);
    assert.equal(afterAmendment?.generation, 2);
    assert.equal(afterAmendment?.rootCommandId, COMMAND_ID);
    assert.equal(afterAmendment?.coordinatorOwnerId, null);
    assert.equal(afterAmendment?.coordinatorAttemptCount, 0n);
    assert.equal(afterAmendment?.validationAttemptPlansJson, null);
    assert.equal(afterAmendment?.evidenceWindowState, "open");
    assert.equal(afterAmendment?.errorCode, null);

    const cancelled = {
      ...(JSON.parse(canonicalJson(amended)) as Record<string, unknown>),
      workflowGeneration: 3,
      phase: "cancelled" as const,
      triggeringEventPosition: "10",
      evidenceWindow: {
        evidenceWindowState: "sealed" as const,
        evidenceFrozenCheckpointEventPosition: null,
        evidenceFrozenGeneration: null,
      },
    } as unknown as SessionEndStatusV2;
    repository.cancelGeneration({
      projectId: PROJECT_ID,
      workflowId: WORKFLOW_ID,
      previousWorkflowGeneration: 2,
      workflowGeneration: 3,
      rootCommandId: lifecycleUuid(12),
      sessionId: SESSION_ID,
      triggeringEventPosition: 10n,
      expectedAuthorityCommitment: "a".repeat(64),
      restoredState: "active",
      resultJson: canonicalJson(cancelled),
      now: "2026-08-15T00:00:02.000Z",
    });
    const afterCancellation = repository.read(PROJECT_ID, WORKFLOW_ID);
    assert.equal(afterCancellation?.generation, 3);
    assert.equal(afterCancellation?.phase, "cancelled");
    assert.equal(afterCancellation?.evidenceWindowState, "sealed");
    assert.equal(afterCancellation?.coordinatorOwnerId, null);
    assert.equal(afterCancellation?.validationAttemptPlanGeneration, null);
    assert.equal(afterCancellation?.evidenceFrozenCheckpointEventPosition, null);
    connection.close();
  });

  it("exposes only connection-bound workflow capabilities and persists immutable validation plans", () => {
    const connection = workflowConnection();
    const service = new SessionEndWorkflowService({ connection });
    const operations = service.operations;

    assert.equal(operations instanceof ConnectionBoundSessionEndWorkflowOperations, true);
    assert.equal("connection" in operations, false);
    assert.deepEqual(Object.keys(operations), [
      "read",
      "claimNext",
      "claim",
      "renew",
      "release",
      "advanceEventlessPhase",
      "readPersistedValidationAttemptPlansV1",
      "writePersistedValidationAttemptPlansV1",
    ]);
    assert.equal(operations.read(PROJECT_ID, WORKFLOW_ID)?.sessionId, SESSION_ID);

    operations.writePersistedValidationAttemptPlansV1({
      projectId: PROJECT_ID,
      workflowId: WORKFLOW_ID,
      workflowGeneration: 1,
      plans: [{
        profileId: "profile-a",
        profileVersion: 1,
        runId: RUN_ID,
        resultId: RESULT_ID,
        commandId: COMMAND_ID,
        idempotencyKey: "validation/profile-a/1",
      }],
    });
    assert.deepEqual(
      operations.readPersistedValidationAttemptPlansV1(PROJECT_ID, WORKFLOW_ID)?.plans.map((plan) => plan.profileId),
      ["profile-a"],
    );
    connection.close();
  });

  it("revokes workflow capabilities captured from the operational callback", () => {
    const connection = workflowConnection();
    const service = new SessionEndWorkflowService({ connection });
    const store = new LifecycleOperationalStore({
      connection,
      transaction: () => repositorySet(service.operations),
    });
    let capturedRead: (() => unknown) | undefined;
    const result = store.execute(workflowWork(), (transaction) => {
      capturedRead = () => transaction.workflows.read(PROJECT_ID, WORKFLOW_ID);
      return { phase: transaction.workflows.read(PROJECT_ID, WORKFLOW_ID)?.phase ?? null };
    });
    assert.deepEqual(result.publicResult, { phase: "requested" });
    assert.throws(() => capturedRead?.(), /LIFECYCLE_INPUT_INVALID/);
    connection.close();
  });
});
