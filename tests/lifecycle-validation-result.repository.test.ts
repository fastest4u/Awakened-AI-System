import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import type { StoredEvent } from "../src/orchestrator/contracts/event.js";
import type { ValidationResultV1 } from "../src/orchestrator/lifecycle/contracts/session-end.js";
import { LifecycleError } from "../src/orchestrator/lifecycle/errors.js";
import type { ProjectId, StoreId, VaultId, WorkspaceId } from "../src/orchestrator/identity/contracts.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { LifecycleValidationResultRepository } from "../src/orchestrator/storage/lifecycle-validation-result.repository.js";
import type { SqliteConnection } from "../src/orchestrator/storage/sqlite-driver.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111" as ProjectId;
const VAULT_ID = "22222222-2222-4222-8222-222222222222" as VaultId;
const STORE_ID = "33333333-3333-4333-8333-333333333333" as StoreId;
const WORKSPACE_ID = "a".repeat(64) as WorkspaceId;
const SESSION_ID = "44444444-4444-4444-8444-444444444444";
const WORKFLOW_ID = "55555555-5555-4555-8555-555555555555";
const CHECKPOINT_ID = "66666666-6666-4666-8666-666666666666";
const RESULT_ID = "77777777-7777-4777-8777-777777777777";
const RUN_ID = "88888888-8888-4888-8888-888888888888";
const RUNNER_ID = "99999999-9999-4999-8999-999999999999";
const EVENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMMAND_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = "2026-08-16T00:00:00.000Z";
const LATER = "2026-08-16T00:00:01.000Z";
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

function db(): SqliteConnection {
  const connection = new DatabaseSync(":memory:") as unknown as SqliteConnection;
  connection.exec(`
    CREATE TABLE events (
      global_position INTEGER PRIMARY KEY,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE lifecycle_validation_results (
      project_id TEXT NOT NULL,
      vault_id TEXT NOT NULL,
      store_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      result_id TEXT NOT NULL,
      validation_result_version INTEGER NOT NULL,
      workflow_id TEXT NOT NULL,
      workflow_generation INTEGER NOT NULL,
      profile_id TEXT NOT NULL,
      profile_version INTEGER NOT NULL,
      profile_configuration_hash TEXT NOT NULL,
      run_id TEXT NOT NULL,
      runner_id TEXT NOT NULL,
      final_checkpoint_id TEXT NOT NULL,
      final_checkpoint_fingerprint TEXT NOT NULL,
      validation_start_scope_version INTEGER NOT NULL,
      validation_start_project_id TEXT NOT NULL,
      validation_start_workspace_id TEXT NOT NULL,
      validation_start_branch_ref TEXT,
      validation_start_head_commit TEXT,
      validation_start_dirty_fingerprint TEXT NOT NULL,
      validation_completion_scope_version INTEGER NOT NULL,
      validation_completion_project_id TEXT NOT NULL,
      validation_completion_workspace_id TEXT NOT NULL,
      validation_completion_branch_ref TEXT,
      validation_completion_head_commit TEXT,
      validation_completion_dirty_fingerprint TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      status TEXT NOT NULL,
      exit_classification TEXT NOT NULL,
      redacted_summary TEXT NOT NULL,
      output_fingerprint_algorithm TEXT NOT NULL,
      output_fingerprint_schema_version INTEGER NOT NULL,
      output_fingerprint_key_id TEXT NOT NULL,
      output_fingerprint_domain TEXT NOT NULL,
      output_fingerprint_value TEXT NOT NULL,
      artifact_references_json TEXT NOT NULL,
      fresh INTEGER NOT NULL,
      recorded_event_position INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, result_id)
    ) STRICT;
  `);
  return connection;
}

function result(overrides: Partial<ValidationResultV1> = {}): ValidationResultV1 {
  return {
    validationResultVersion: 1,
    resultId: RESULT_ID as ValidationResultV1["resultId"],
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID as ValidationResultV1["sessionId"],
    workflowId: WORKFLOW_ID as ValidationResultV1["workflowId"],
    workflowGeneration: 3,
    finalCheckpointId: CHECKPOINT_ID as ValidationResultV1["finalCheckpointId"],
    finalCheckpointFingerprint: HASH_B,
    profileId: "lint",
    profileVersion: 1,
    profileConfigurationHash: HASH_C,
    runId: RUN_ID,
    runnerId: RUNNER_ID,
    sourceStateAtStart: {
      sourceStateScopeVersion: 1,
      workspaceId: WORKSPACE_ID,
      branchRef: "refs/heads/main",
      headCommit: "a".repeat(40),
      dirtyWorktreeFingerprint: HASH_D,
    },
    sourceStateAtCompletion: {
      sourceStateScopeVersion: 1,
      workspaceId: WORKSPACE_ID,
      branchRef: "refs/heads/main",
      headCommit: "a".repeat(40),
      dirtyWorktreeFingerprint: HASH_D,
    },
    startedAt: NOW,
    completedAt: LATER,
    status: "pass",
    exitClassification: "passed",
    summary: "ok",
    outputFingerprint: {
      fingerprintSchemaVersion: 1,
      fingerprintKeyId: "validation-key-1",
      fingerprintDomain: "pm-validation-output-v1",
      fingerprint: HASH_B,
    },
    artifactReferences: ["artifact://validation/report.json"],
    fresh: true,
    ...overrides,
  };
}

function storedEvent(
  position: bigint,
  validationResult: ValidationResultV1 = result(),
): StoredEvent {
  const payload = {
    workflowId: WORKFLOW_ID,
    workflowGeneration: 3,
    plannedWorkId: HASH_C,
    validationResult,
  };
  return {
    globalPosition: position,
    eventId: EVENT_ID,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    eventType: "SessionValidationResultRecorded",
    eventSchemaVersion: 1,
    recordedAt: NOW,
    payload,
  } as unknown as StoredEvent;
}

function insertEvent(connection: SqliteConnection, event: StoredEvent): void {
  connection.prepare(`
    INSERT INTO events(global_position, event_type, payload_json)
    VALUES ($position, $eventType, $payloadJson)
  `).run({
    $position: event.globalPosition,
    $eventType: event.eventType,
    $payloadJson: canonicalJson(event.payload),
  });
}

describe("LifecycleValidationResultRepository", () => {
  it("persists and hydrates an immutable result against the actual event position", () => {
    const connection = db();
    const repository = new LifecycleValidationResultRepository();
    const event = storedEvent(42n);
    insertEvent(connection, event);

    repository.record(connection, result(), event);
    const hydrated = repository.get(connection, PROJECT_ID, RESULT_ID);

    assert.deepEqual(hydrated, result());
    assert.equal(Object.isFrozen(hydrated), true);
    assert.equal(Object.isFrozen(hydrated?.sourceStateAtStart), true);
    assert.equal(
      connection.prepare("SELECT recorded_event_position FROM lifecycle_validation_results").get()
        ?.recorded_event_position,
      42,
    );
    assert.doesNotThrow(() => repository.record(connection, result(), event));
    assert.throws(
      () => repository.record(connection, result({ summary: "changed" }), event),
      /SESSION_VALIDATION_RESULT_INVALID/,
    );
  });

  it("rejects a foreign or mismatched event before writing a row", () => {
    const connection = db();
    const repository = new LifecycleValidationResultRepository();
    const event = storedEvent(7n);
    insertEvent(connection, event);

    assert.throws(
      () => repository.record(connection, result({ projectId: VAULT_ID as unknown as ProjectId }), event),
      (error: unknown) => error instanceof LifecycleError
        && error.code === "SESSION_VALIDATION_RESULT_INVALID",
    );
    assert.throws(
      () => repository.record(connection, result(), {
        ...event,
        eventType: "SessionEndVerificationPassed",
      } as StoredEvent),
      /SESSION_VALIDATION_RESULT_INVALID/,
    );
    assert.equal(
      connection.prepare("SELECT count(*) AS count FROM lifecycle_validation_results").get()?.count,
      0,
    );
  });

  it("detects tampering in the event-bound row while reading", () => {
    const connection = db();
    const repository = new LifecycleValidationResultRepository();
    const event = storedEvent(9n);
    insertEvent(connection, event);
    repository.record(connection, result(), event);

    connection.prepare(`
      UPDATE lifecycle_validation_results
      SET redacted_summary = 'tampered'
      WHERE project_id = $projectId AND result_id = $resultId
    `).run({ $projectId: PROJECT_ID, $resultId: RESULT_ID });

    assert.throws(() => repository.get(connection, PROJECT_ID, RESULT_ID), /INTEGRITY_FAILURE/);
  });
});
