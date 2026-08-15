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
  SessionEndWorkflowService,
} from "../src/orchestrator/lifecycle/session-end-workflow.service.js";
import type {
  SqliteConnection,
  SqliteParams,
  SqliteRow,
  SqliteRunResult,
  SqliteStatement,
} from "../src/orchestrator/storage/sqlite-driver.js";

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
