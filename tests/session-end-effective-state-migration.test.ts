import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import type { ProjectContext } from "../src/orchestrator/identity/contracts.js";
import type { LifecycleSemanticCommandDraft } from "../src/orchestrator/lifecycle/contracts/commands.js";
import { decodeLifecycleEvent } from "../src/orchestrator/lifecycle/contracts/events.js";
import { buildLifecycleIntentWitness } from "../src/orchestrator/lifecycle/lifecycle-intent-witness.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { MigrationRunner, migrationChecksum } from "../src/orchestrator/storage/migration-runner.js";
import { eventCoreMigration } from "../src/orchestrator/storage/migrations/0001-event-core.js";
import { sessionLifecycleMigration } from "../src/orchestrator/storage/migrations/0002-session-lifecycle.js";
import { qualifiedCheckpointCoverageMigration } from "../src/orchestrator/storage/migrations/0003-qualified-checkpoint-coverage.js";
import { sessionEndEffectiveStateMigration } from "../src/orchestrator/storage/migrations/0004-session-end-effective-state.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import { SqliteQualifiedCheckpointMigrationPreflight } from "../src/orchestrator/storage/qualified-checkpoint-migration-preflight.js";
import {
  SqliteSessionEndEffectiveStateMigrationPreflight,
} from "../src/orchestrator/storage/session-end-effective-state-migration-preflight.js";
import {
  CURRENT_PROJECT_STORE_SCHEMA_VERSION,
  PROJECT_STORE_MIGRATIONS,
} from "../src/orchestrator/storage/migrations/registry.js";
import type {
  SqliteConnection,
  SqliteParams,
  SqliteValue,
} from "../src/orchestrator/storage/sqlite-driver.js";
import { SchemaCompatibilityError } from "../src/orchestrator/storage/schema-compatibility.js";
import {
  sessionEndEffectiveStateFixture,
} from "./support/session-end-effective-state-reference.js";
import {
  checkpointFixture,
  qualifiedCheckpointFixture,
} from "./support/lifecycle-fixtures.js";

const NOW = "2026-08-09T00:00:00.000Z";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const VAULT_ID = "22222222-2222-4222-8222-222222222222";
const STORE_ID = "33333333-3333-4333-8333-333333333333";
const ROOT_ID = "44444444-4444-4444-8444-444444444444";
const CHILD_ID = "55555555-5555-4555-8555-555555555555";
const FOREIGN_ROOT_ID = "66666666-6666-4666-8666-666666666666";
const FOREIGN_CHILD_ID = "77777777-7777-4777-8777-777777777777";
const TRANSFER_TICKET_ID = "88888888-8888-4888-8888-888888888888";
const WORKFLOW_ID = "b6c2d359-82a6-567e-86c7-bf9e780cf20b";
const H64 = "a".repeat(64);
const driver = new NodeSqliteDriver({ DatabaseSync });
const connections: SqliteConnection[] = [];
const roots: string[] = [];
const context = {
  binding: {
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
  },
} as ProjectContext;

it("preserves migration 0004 and registers schema-7 shadow migration", () => {
  assert.equal(CURRENT_PROJECT_STORE_SCHEMA_VERSION, 7);
  assert.deepEqual(PROJECT_STORE_MIGRATIONS.map((migration) => migration.version), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(migrationChecksum(sessionLifecycleMigration), "85666a0bdee4455068f03a81e9d3720df172d15fce6d8e6f0cb3f5f7d0a81293");
  assert.equal(
    createHash("sha256").update(readFileSync(resolve(
      "src/orchestrator/storage/migrations/0002-session-lifecycle.ts",
    ))).digest("hex").toUpperCase(),
    "68B4039048A359C523B7842F6D17BAA5760E9760D2B4E9F80BB8A48DC339EB06",
  );
  assert.equal(
    createHash("sha256").update(readFileSync(resolve(
      "src/orchestrator/storage/migrations/0003-qualified-checkpoint-coverage.ts",
    ))).digest("hex").toUpperCase(),
    "C023A8EDB88A94B749D4837F7300A76D081C843BF41BE058C3AA4AD5D6A158C4",
  );
  assert.equal(sessionEndEffectiveStateMigration.version, 4);
});

function emptyConnection(): SqliteConnection {
  const root = mkdtempSync(join(tmpdir(), "session-end-migration-"));
  roots.push(root);
  const connection = driver.open(join(root, "events.sqlite"), {
    mode: "create",
    busyTimeoutMs: 1_000,
  });
  connections.push(connection);
  return connection;
}

function rawInsert(
  connection: SqliteConnection,
  table: string,
  values: Readonly<Record<string, SqliteValue>>,
): void {
  const columns = Object.keys(values);
  connection.prepare(`
    INSERT INTO ${table}(${columns.join(", ")})
    VALUES (${columns.map((column) => `$${column}`).join(", ")})
  `).run(Object.fromEntries(
    columns.map((column) => [`$${column}`, values[column]!]),
  ) as SqliteParams);
}

function withTriggersTemporarilyDropped(
  connection: SqliteConnection,
  triggerNames: readonly string[],
  action: () => void,
): void {
  const triggers = triggerNames.map((name) => {
    const row = connection.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = $name
    `).get({ $name: name });
    if (typeof row?.sql !== "string") throw new Error(`Missing fixture trigger: ${name}`);
    return { name, sql: row.sql };
  });
  for (const trigger of triggers) {
    connection.exec(`DROP TRIGGER ${trigger.name}`);
  }
  try {
    action();
  } finally {
    for (const trigger of triggers) connection.exec(trigger.sql);
  }
}

function schema3Connection(): SqliteConnection {
  return sourceConnection(3);
}

function sourceConnection(version: 1 | 2 | 3): SqliteConnection {
  const connection = emptyConnection();
  const runner = new MigrationRunner();
  runner.apply(connection, [eventCoreMigration], NOW, {
    kind: "bootstrap-empty",
    beforeMigration: () => undefined,
  });
  rawInsert(connection, "project_meta", {
    singleton: 1,
    project_id: PROJECT_ID,
    vault_id: VAULT_ID,
    store_id: STORE_ID,
    schema_version: 1,
    created_at: NOW,
  });
  rawInsert(connection, "maintenance_state", {
    singleton: 1,
    epoch: 0,
    mode: "idle",
    owner_id: null,
    fencing_token: 0,
    lease_expires_at: null,
    requested_at: null,
  });
  if (version >= 2) {
    runner.apply(connection, [
      eventCoreMigration,
      sessionLifecycleMigration,
      ...(version === 3 ? [qualifiedCheckpointCoverageMigration] : []),
    ], NOW, {
      kind: "explicit-upgrade",
      expectedAppliedVersion: 1,
      beforeMigration(migrationConnection, migration): void {
        if (migration.version === 3) {
          new SqliteQualifiedCheckpointMigrationPreflight()
            .assertEligibleAndStage(migrationConnection, context);
        }
      },
    });
  }
  return connection;
}

function schema4Connection(): SqliteConnection {
  const connection = schema3Connection();
  new MigrationRunner().apply(connection, [
    eventCoreMigration,
    sessionLifecycleMigration,
    qualifiedCheckpointCoverageMigration,
    sessionEndEffectiveStateMigration,
  ], NOW, {
    kind: "explicit-upgrade",
    expectedAppliedVersion: 3,
    beforeMigration(migrationConnection, migration): void {
      if (migration.version === 4) {
        new SqliteSessionEndEffectiveStateMigrationPreflight()
          .assertEligible(migrationConnection, context);
      }
    },
  });
  return connection;
}

function workflowValues(
  phase: string,
  overrides: Readonly<Record<string, SqliteValue>> = {},
): Record<string, SqliteValue> {
  return {
    project_id: PROJECT_ID,
    workflow_id: WORKFLOW_ID,
    workflow_type: "session-end",
    generation: 1,
    state: "active",
    phase,
    root_command_id: "root-command",
    result_json: null,
    error_code: null,
    created_at: NOW,
    updated_at: NOW,
    session_id: ROOT_ID,
    triggering_event_position: 1,
    expected_authority_commitment: H64,
    coordinator_owner_id: null,
    coordinator_claim_token: null,
    coordinator_claim_expires_at: null,
    coordinator_attempt_count: 0,
    coordinator_failure_class: null,
    coordinator_error_code: null,
    coordinator_next_attempt_at: null,
    validation_attempt_plan_generation: null,
    validation_attempt_plans_json: null,
    evidence_frozen_checkpoint_event_position: null,
    evidence_frozen_generation: null,
    evidence_window_state: "sealed",
    final_ending_scope_bindings_json: null,
    ...overrides,
  };
}

function seedWorkflow(
  connection: SqliteConnection,
  phase: string,
  overrides: Readonly<Record<string, SqliteValue>> = {},
): void {
  withTriggersTemporarilyDropped(connection, [
    "workflow_instances_lifecycle_insert_guard",
    "workflow_instances_evidence_v3_insert_guard",
  ], () => rawInsert(
    connection,
    "workflow_instances",
    workflowValues(phase, overrides),
  ));
}

function seedStrictValidDisallowedV3Event(connection: SqliteConnection): void {
  const payload = {
    cancellationVersion: 1,
    workflowId: WORKFLOW_ID,
    previousWorkflowGeneration: 1,
    workflowGeneration: 2,
    restoredState: "active",
    preTransitionCheckpointId: "55555555-5555-4555-8555-555555555555",
  } as const;
  const event = {
    eventSchemaVersion: 3,
    eventId: "66666666-6666-4666-8666-666666666666",
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: H64,
    streamId: `session/${ROOT_ID}`,
    streamVersion: "1",
    globalPosition: "1",
    sessionId: ROOT_ID,
    parentSessionId: null,
    eventType: "SessionEndCancelled",
    correlationId: "77777777-7777-4777-8777-777777777777",
    causationId: null,
    commandId: "88888888-8888-4888-8888-888888888888",
    idempotencyKey: "strict-valid-v3",
    occurredAt: NOW,
    authorityCommitment: H64,
    payload,
  } as const;
  assert.equal(decodeLifecycleEvent(event).eventSchemaVersion, 3);
  rawInsert(connection, "streams", {
    project_id: PROJECT_ID,
    stream_id: event.streamId,
    stream_type: "session",
    current_version: 1,
    created_at: NOW,
    updated_at: NOW,
  });
  connection.exec("DROP TRIGGER events_lifecycle_version_v3_guard");
  rawInsert(connection, "events", {
    global_position: 1,
    event_id: event.eventId,
    project_id: PROJECT_ID,
    vault_id: VAULT_ID,
    store_id: STORE_ID,
    workspace_id: H64,
    branch_scope_id: null,
    branch_ref: null,
    stream_id: event.streamId,
    stream_type: "session",
    stream_version: 1,
    event_type: event.eventType,
    event_schema_version: 3,
    session_id: ROOT_ID,
    parent_session_id: null,
    actor_role: "primary",
    agent_id: "agent",
    client_instance_id: "client",
    correlation_id: event.correlationId,
    causation_id: null,
    command_id: event.commandId,
    idempotency_key: event.idempotencyKey,
    command_event_index: 0,
    occurred_at: NOW,
    recorded_at: NOW,
    visibility_scope: "session",
    confidence: "high",
    verification_status: "verified",
    source_refs_json: "[]",
    evidence_refs_json: "[]",
    evidence_digests_json: "[]",
    payload_json: canonicalJson(payload),
    payload_hash: H64,
    previous_global_hash: "0".repeat(64),
    event_hash: H64,
    lifecycle_intent_json: null,
  });
}

function insertRawV3Request(
  connection: SqliteConnection,
  payload: unknown,
): void {
  rawInsert(connection, "streams", {
    project_id: PROJECT_ID,
    stream_id: `session/${ROOT_ID}`,
    stream_type: "session",
    current_version: 1,
    created_at: NOW,
    updated_at: NOW,
  });
  rawInsert(connection, "events", {
    global_position: 1,
    event_id: "66666666-6666-4666-8666-666666666666",
    project_id: PROJECT_ID,
    vault_id: VAULT_ID,
    store_id: STORE_ID,
    workspace_id: H64,
    branch_scope_id: null,
    branch_ref: null,
    stream_id: `session/${ROOT_ID}`,
    stream_type: "session",
    stream_version: 1,
    event_type: "SessionEndRequested",
    event_schema_version: 3,
    session_id: ROOT_ID,
    parent_session_id: null,
    actor_role: "primary",
    agent_id: "agent",
    client_instance_id: "client",
    correlation_id: "77777777-7777-4777-8777-777777777777",
    causation_id: null,
    command_id: "88888888-8888-4888-8888-888888888888",
    idempotency_key: "raw-v3-request",
    command_event_index: 0,
    occurred_at: NOW,
    recorded_at: NOW,
    visibility_scope: "session",
    confidence: "high",
    verification_status: "verified",
    source_refs_json: "[]",
    evidence_refs_json: "[]",
    evidence_digests_json: "[]",
    payload_json: canonicalJson(payload),
    payload_hash: H64,
    previous_global_hash: "0".repeat(64),
    event_hash: H64,
    lifecycle_intent_json: null,
  });
}

function rawSessionEventValues(input: {
  readonly globalPosition: number;
  readonly streamVersion: number;
  readonly eventType: string;
  readonly eventSchemaVersion: number;
  readonly sessionId: string;
  readonly parentSessionId: string | null;
  readonly commandId: string;
  readonly commandEventIndex?: number;
  readonly payload: unknown;
  readonly lifecycleIntent?: unknown;
}): Record<string, SqliteValue> {
  return {
    global_position: input.globalPosition,
    event_id: historyUuid("e", input.globalPosition),
    project_id: PROJECT_ID,
    vault_id: VAULT_ID,
    store_id: STORE_ID,
    workspace_id: H64,
    branch_scope_id: null,
    branch_ref: null,
    stream_id: `session/${input.sessionId}`,
    stream_type: "session",
    stream_version: input.streamVersion,
    event_type: input.eventType,
    event_schema_version: input.eventSchemaVersion,
    session_id: input.sessionId,
    parent_session_id: input.parentSessionId,
    actor_role: "primary",
    agent_id: "agent",
    client_instance_id: "client",
    correlation_id: "77777777-7777-4777-8777-777777777777",
    causation_id: null,
    command_id: input.commandId,
    idempotency_key: `raw/${input.commandId}`,
    command_event_index: input.commandEventIndex ?? 0,
    occurred_at: NOW,
    recorded_at: NOW,
    visibility_scope: "session",
    confidence: "high",
    verification_status: "verified",
    source_refs_json: "[]",
    evidence_refs_json: "[]",
    evidence_digests_json: "[]",
    payload_json: canonicalJson(input.payload),
    payload_hash: H64,
    previous_global_hash: "0".repeat(64),
    event_hash: H64,
    lifecycle_intent_json: input.lifecycleIntent === undefined
      ? null
      : canonicalJson(input.lifecycleIntent),
  };
}

function internalCarryForwardIntent(input: {
  readonly suspensionEventPosition: string | null;
  readonly checkpointId: string;
  readonly checkpointEventPosition: string;
  readonly expectedChildState?: "active" | "completion-proposed" | "suspended";
  readonly expectedChildHeadEventPosition?: string;
  readonly expectedChildStreamVersion?: string;
  readonly workflowGeneration?: number;
  readonly sourcePhase?: string;
  readonly plannedWorkId?: string;
}): Readonly<Record<string, unknown>> {
  const workflowGeneration = input.workflowGeneration ?? 1;
  const plannedWorkId = input.plannedWorkId ?? H64;
  const plannedAction = {
    action: "carry-forward-child",
    actionVersion: 1,
    rootSessionId: ROOT_ID,
    childSessionId: CHILD_ID,
    expectedChildState: input.expectedChildState ?? "suspended",
    expectedChildHeadEventPosition: input.expectedChildHeadEventPosition ?? "2",
    expectedChildStreamVersion: input.expectedChildStreamVersion ?? "2",
    expectedChildAuthorityCommitment: H64,
    expectedChildCapabilityGeneration: "1",
    expectedSuspensionEventPosition: input.suspensionEventPosition,
    checkpointId: input.checkpointId,
    checkpointEventPosition: input.checkpointEventPosition,
    checkpointFingerprint: H64,
  } as const;
  const authorization = {
    authorizationKind: "internal-workflow",
    authorizationSessionId: ROOT_ID,
    targetSessionId: CHILD_ID,
    capabilityKind: null,
    capabilityGeneration: null,
    presentingActorRole: "primary",
    presentingClientInstanceId: "client",
    targetActorRole: "primary",
    targetClientInstanceId: "client",
    internalWorkflowId: WORKFLOW_ID,
    internalWorkflowGeneration: workflowGeneration,
    internalPlannedWorkId: plannedWorkId,
  } as const;
  return {
    lifecycleIntentWitnessVersion: 1,
    intent: {
      lifecycleIntentVersion: 1,
      command: {
        commandType: "internal-workflow-phase",
        commandId: "88888888-8888-4888-8888-888888888888",
        idempotencyKey: "raw/88888888-8888-4888-8888-888888888888",
        agentId: "agent",
        expectedProjectId: PROJECT_ID,
        expectedVaultId: VAULT_ID,
        expectedWorkspaceId: H64,
        expectedBranchRef: null,
        workflowId: WORKFLOW_ID,
        workflowGeneration,
        sourcePhase: input.sourcePhase ?? "requested",
        plannedWorkId,
        plannedAction,
      },
      binding: {
        projectId: PROJECT_ID,
        vaultId: VAULT_ID,
        storeId: STORE_ID,
        workspaceId: H64,
        clientNamespace: "client",
      },
      authorization,
    },
    persistedAssertions: {
      ...authorization,
      projectId: PROJECT_ID,
      vaultId: VAULT_ID,
      storeId: STORE_ID,
      workspaceId: H64,
      clientNamespace: "client",
    },
  };
}

function protectedLifecycleIntent(
  command: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const authorization = {
    authorizationKind: "protected",
    authorizationSessionId: ROOT_ID,
    targetSessionId: ROOT_ID,
    capabilityKind: "root-session-handle",
    capabilityGeneration: "1",
    presentingActorRole: "primary",
    presentingClientInstanceId: "client",
    targetActorRole: "primary",
    targetClientInstanceId: "client",
    internalWorkflowId: null,
    internalWorkflowGeneration: null,
    internalPlannedWorkId: null,
  } as const;
  return {
    lifecycleIntentWitnessVersion: 1,
    intent: {
      lifecycleIntentVersion: 1,
      command: {
        agentId: "agent",
        expectedBranchRef: null,
        ...command,
      },
      binding: {
        projectId: PROJECT_ID,
        vaultId: VAULT_ID,
        storeId: STORE_ID,
        workspaceId: H64,
        clientNamespace: "client",
      },
      authorization,
    },
    persistedAssertions: {
      ...authorization,
      projectId: PROJECT_ID,
      vaultId: VAULT_ID,
      storeId: STORE_ID,
      workspaceId: H64,
      clientNamespace: "client",
    },
  };
}

function seedStrictLegacyCancelledHistory(
  connection: SqliteConnection,
  workflowTriggerPosition = 2,
  workflowOverrides: Readonly<Record<string, SqliteValue>> = {},
): void {
  const requestCommandId = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const cancelCommandId = "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const checkpointId = "33333333-cccc-4ccc-8ccc-cccccccccccc";
  rawInsert(connection, "streams", {
    project_id: PROJECT_ID,
    stream_id: `session/${ROOT_ID}`,
    stream_type: "session",
    current_version: 2,
    created_at: NOW,
    updated_at: NOW,
  });
  rawInsert(connection, "events", rawSessionEventValues({
    globalPosition: 1,
    streamVersion: 1,
    eventType: "SessionEndRequested",
    eventSchemaVersion: 1,
    sessionId: ROOT_ID,
    parentSessionId: null,
    commandId: requestCommandId,
    payload: {
      workflowId: WORKFLOW_ID,
      workflowGeneration: 1,
      previousState: "active",
      childEndPolicy: "require-completed",
      qualityThreshold: 0,
      requireFullEvidence: false,
      requireMaterialization: false,
    },
    lifecycleIntent: protectedLifecycleIntent({
      commandType: "request-session-end",
      commandId: requestCommandId,
      idempotencyKey: `raw/${requestCommandId}`,
      expectedProjectId: PROJECT_ID,
      expectedVaultId: VAULT_ID,
      expectedWorkspaceId: H64,
      request: {
        requestVersion: 1,
        sessionId: ROOT_ID,
        finalCheckpoint: { checkpointVersion: 1 },
      },
    }),
  }));
  rawInsert(connection, "events", rawSessionEventValues({
    globalPosition: 2,
    streamVersion: 2,
    eventType: "SessionEndCancelled",
    eventSchemaVersion: 1,
    sessionId: ROOT_ID,
    parentSessionId: null,
    commandId: cancelCommandId,
    payload: {
      workflowId: WORKFLOW_ID,
      workflowGeneration: 1,
      restoredState: "active",
      preTransitionCheckpointId: checkpointId,
    },
    lifecycleIntent: protectedLifecycleIntent({
      commandType: "cancel-session-end",
      commandId: cancelCommandId,
      idempotencyKey: `raw/${cancelCommandId}`,
      expectedProjectId: PROJECT_ID,
      expectedVaultId: VAULT_ID,
      expectedWorkspaceId: H64,
      sessionId: ROOT_ID,
      workflowId: WORKFLOW_ID,
      preTransitionCheckpointId: checkpointId,
    }),
  }));
  connection.exec(`
    PRAGMA foreign_keys = OFF;
  `);
  withTriggersTemporarilyDropped(connection, [
    "session_authority_insert_guard",
  ], () => rawInsert(connection, "session_authority", {
    project_id: PROJECT_ID,
    session_id: ROOT_ID,
    stream_id: `session/${ROOT_ID}`,
    session_kind: "root",
    parent_session_id: null,
    workspace_id: H64,
    client_namespace: "client",
    semantic_state: "active",
    owner_generation: 1,
    direct_access_enabled: 1,
    authority_commitment: H64,
    authority_event_position: 2,
    created_at: NOW,
    updated_at: NOW,
  }));
  connection.exec("PRAGMA foreign_keys = ON");
  rawInsert(connection, "lifecycle_workflow_generation_folds", {
    project_id: PROJECT_ID,
    workflow_id: WORKFLOW_ID,
    workflow_generation: 1,
    session_id: ROOT_ID,
    trigger_event_position: 2,
    root_command_id: cancelCommandId,
    evidence_window_state: "sealed",
    replacement_checkpoint_version: null,
    effective_checkpoint_version: 1,
    effective_draft_source_event_position: 1,
    previous_fingerprint: null,
    fingerprint: H64,
  });
  seedWorkflow(connection, "cancelled", {
    root_command_id: cancelCommandId,
    triggering_event_position: workflowTriggerPosition,
    ...workflowOverrides,
  });
}

function seedLegacyRequestThenV3Cancellation(
  connection: SqliteConnection,
  cancellationPayloadOverrides: Readonly<Record<string, unknown>> = {},
): void {
  const requestCommandId = "11111111-dddd-4ddd-8ddd-dddddddddddd";
  const cancelCommandId = "22222222-eeee-4eee-8eee-eeeeeeeeeeee";
  const checkpointId = "33333333-ffff-4fff-8fff-ffffffffffff";
  rawInsert(connection, "streams", {
    project_id: PROJECT_ID,
    stream_id: `session/${ROOT_ID}`,
    stream_type: "session",
    current_version: 3,
    created_at: NOW,
    updated_at: NOW,
  });
  rawInsert(connection, "events", rawSessionEventValues({
    globalPosition: 1,
    streamVersion: 1,
    eventType: "SessionEndRequested",
    eventSchemaVersion: 1,
    sessionId: ROOT_ID,
    parentSessionId: null,
    commandId: requestCommandId,
    payload: {
      workflowId: WORKFLOW_ID,
      workflowGeneration: 1,
      previousState: "active",
      childEndPolicy: "require-completed",
      qualityThreshold: 0,
      requireFullEvidence: false,
      requireMaterialization: false,
    },
    lifecycleIntent: protectedLifecycleIntent({
      commandType: "request-session-end",
      commandId: requestCommandId,
      idempotencyKey: `raw/${requestCommandId}`,
      expectedProjectId: PROJECT_ID,
      expectedVaultId: VAULT_ID,
      expectedWorkspaceId: H64,
      request: {
        requestVersion: 1,
        sessionId: ROOT_ID,
        finalCheckpoint: { checkpointVersion: 1 },
      },
    }),
  }));
  rawInsert(connection, "lifecycle_workflow_generation_folds", {
    project_id: PROJECT_ID,
    workflow_id: WORKFLOW_ID,
    workflow_generation: 1,
    session_id: ROOT_ID,
    trigger_event_position: 1,
    root_command_id: requestCommandId,
    evidence_window_state: "sealed",
    replacement_checkpoint_version: 1,
    effective_checkpoint_version: 1,
    effective_draft_source_event_position: 1,
    previous_fingerprint: null,
    fingerprint: H64,
  });
  rawInsert(connection, "events", rawSessionEventValues({
    globalPosition: 2,
    streamVersion: 2,
    eventType: "SessionCheckpointRecorded",
    eventSchemaVersion: 2,
    sessionId: ROOT_ID,
    parentSessionId: null,
    commandId: "11111111-eeee-4eee-8eee-eeeeeeeeeeee",
    payload: {
      checkpoint: { checkpointVersion: 2, checkpointId },
    },
  }));
  connection.exec("PRAGMA foreign_keys = OFF");
  withTriggersTemporarilyDropped(connection, [
    "session_authority_insert_guard",
  ], () => rawInsert(connection, "session_authority", {
    project_id: PROJECT_ID,
    session_id: ROOT_ID,
    stream_id: `session/${ROOT_ID}`,
    session_kind: "root",
    parent_session_id: null,
    workspace_id: H64,
    client_namespace: "client",
    semantic_state: "ending",
    owner_generation: 1,
    direct_access_enabled: 1,
    authority_commitment: H64,
    authority_event_position: 1,
    latest_checkpoint_id: checkpointId,
    latest_checkpoint_event_position: 2,
    latest_checkpoint_fingerprint: H64,
    created_at: NOW,
    updated_at: NOW,
  }));
  connection.exec("PRAGMA foreign_keys = ON");
  seedWorkflow(connection, "requested", {
    root_command_id: requestCommandId,
    triggering_event_position: 1,
    state: "active",
  });
  rawInsert(connection, "events", rawSessionEventValues({
    globalPosition: 3,
    streamVersion: 3,
    eventType: "SessionEndCancelled",
    eventSchemaVersion: 3,
    sessionId: ROOT_ID,
    parentSessionId: null,
    commandId: cancelCommandId,
    payload: {
      cancellationVersion: 1,
      workflowId: WORKFLOW_ID,
      previousWorkflowGeneration: 1,
      workflowGeneration: 2,
      restoredState: "active",
      preTransitionCheckpointId: checkpointId,
      ...cancellationPayloadOverrides,
    },
    lifecycleIntent: protectedLifecycleIntent({
      commandType: "cancel-session-end",
      commandId: cancelCommandId,
      idempotencyKey: `raw/${cancelCommandId}`,
      expectedProjectId: PROJECT_ID,
      expectedVaultId: VAULT_ID,
      expectedWorkspaceId: H64,
      sessionId: ROOT_ID,
      workflowId: WORKFLOW_ID,
      expectedStreamVersion: "2",
      preTransitionCheckpointId: checkpointId,
    }),
  }));
}

function v3ReopenRequestFixture(requestVersion: 1 | 2): {
  readonly commandId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly lifecycleIntent: Readonly<Record<string, unknown>>;
} {
  const commandId = requestVersion === 1
    ? "33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    : "33333333-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const effectiveState = sessionEndEffectiveStateFixture({ requestVersion });
  const lifecycleIntent = buildLifecycleIntentWitness({
    commandType: "request-session-end",
    commandId,
    idempotencyKey: `raw/${commandId}`,
    agentId: "agent",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: H64,
    expectedBranchRef: null,
    request: effectiveState.request,
  } as unknown as LifecycleSemanticCommandDraft, {
    authorizationKind: "protected",
    authorizationSessionId: ROOT_ID,
    targetSessionId: ROOT_ID,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: H64,
    clientNamespace: "client",
    capabilityKind: "root-session-handle",
    capabilityGeneration: "1",
    presentingActorRole: "primary",
    presentingClientInstanceId: "client",
    targetActorRole: "primary",
    targetClientInstanceId: "client",
    internalWorkflowId: null,
    internalWorkflowGeneration: null,
    internalPlannedWorkId: null,
  }).witness;
  return {
    commandId,
    payload: {
      workflowId: WORKFLOW_ID,
      workflowGeneration: 2,
      previousState: "active",
      effectiveState,
    },
    lifecycleIntent: lifecycleIntent as unknown as Readonly<Record<string, unknown>>,
  };
}

function appendV3ReopenRequest(
  connection: SqliteConnection,
  requestVersion: 1 | 2,
  overrides: {
    readonly payload?: unknown;
    readonly lifecycleIntent?: unknown;
    readonly omitLifecycleIntent?: boolean;
    readonly streamHead?: number;
  } = {},
): string {
  const fixture = v3ReopenRequestFixture(requestVersion);
  connection.prepare(`
    UPDATE streams
    SET current_version = $currentVersion, updated_at = $updatedAt
    WHERE project_id = $projectId AND stream_id = $streamId
  `).run({
    $currentVersion: overrides.streamHead ?? 2,
    $updatedAt: NOW,
    $projectId: PROJECT_ID,
    $streamId: `session/${ROOT_ID}`,
  });
  rawInsert(connection, "events", rawSessionEventValues({
    globalPosition: 3,
    streamVersion: 3,
    eventType: "SessionEndRequested",
    eventSchemaVersion: 3,
    sessionId: ROOT_ID,
    parentSessionId: null,
    commandId: fixture.commandId,
    payload: overrides.payload ?? fixture.payload,
    ...(overrides.omitLifecycleIntent
      ? {}
      : { lifecycleIntent: overrides.lifecycleIntent ?? fixture.lifecycleIntent }),
  }));
  connection.prepare(`
    UPDATE streams
    SET current_version = 3, updated_at = $updatedAt
    WHERE project_id = $projectId AND stream_id = $streamId
  `).run({
    $updatedAt: NOW,
    $projectId: PROJECT_ID,
    $streamId: `session/${ROOT_ID}`,
  });
  return fixture.commandId;
}

function seedV3WorkflowMutationPredecessor(connection: SqliteConnection): string {
  const requestCommandId = "44444444-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const checkpointCommandId = "44444444-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const checkpointId = "44444444-cccc-4ccc-8ccc-cccccccccccc";
  const request = sessionEndEffectiveStateFixture({ requestVersion: 1 }).request;
  rawInsert(connection, "streams", {
    project_id: PROJECT_ID,
    stream_id: `session/${ROOT_ID}`,
    stream_type: "session",
    current_version: 3,
    created_at: NOW,
    updated_at: NOW,
  });
  rawInsert(connection, "events", rawSessionEventValues({
    globalPosition: 1,
    streamVersion: 1,
    eventType: "SessionEndRequested",
    eventSchemaVersion: 1,
    sessionId: ROOT_ID,
    parentSessionId: null,
    commandId: requestCommandId,
    payload: {
      workflowId: WORKFLOW_ID,
      workflowGeneration: 1,
      previousState: "active",
      childEndPolicy: request.childEndPolicy,
      qualityThreshold: request.requestedQualityThreshold,
      requireFullEvidence: request.requireFullEvidence,
      requireMaterialization: request.requireMaterialization,
    },
    lifecycleIntent: protectedLifecycleIntent({
      commandType: "request-session-end",
      commandId: requestCommandId,
      idempotencyKey: `raw/${requestCommandId}`,
      expectedProjectId: PROJECT_ID,
      expectedVaultId: VAULT_ID,
      expectedWorkspaceId: H64,
      expectedStreamVersion: "0",
      request,
    }),
  }));
  rawInsert(connection, "events", rawSessionEventValues({
    globalPosition: 2,
    streamVersion: 2,
    eventType: "SessionCheckpointRecorded",
    eventSchemaVersion: 2,
    sessionId: ROOT_ID,
    parentSessionId: null,
    commandId: checkpointCommandId,
    payload: {
      checkpoint: {
        checkpointVersion: 2,
        checkpointId,
      },
    },
  }));
  connection.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TRIGGER session_authority_insert_guard;
  `);
  rawInsert(connection, "session_authority", {
    project_id: PROJECT_ID,
    session_id: ROOT_ID,
    stream_id: `session/${ROOT_ID}`,
    session_kind: "root",
    parent_session_id: null,
    workspace_id: H64,
    client_namespace: "client",
    semantic_state: "ending",
    owner_generation: 1,
    direct_access_enabled: 1,
    authority_commitment: H64,
    authority_event_position: 1,
    latest_checkpoint_id: checkpointId,
    latest_checkpoint_event_position: 2,
    latest_checkpoint_fingerprint: H64,
    created_at: NOW,
    updated_at: NOW,
  });
  connection.exec("PRAGMA foreign_keys = ON");
  seedWorkflow(connection, "requested", {
    root_command_id: requestCommandId,
    triggering_event_position: 1,
    state: "active",
  });
  return checkpointId;
}

function seedSuspendedChildTransferSource(connection: SqliteConnection): void {
  rawInsert(connection, "streams", {
    project_id: PROJECT_ID,
    stream_id: `session/${CHILD_ID}`,
    stream_type: "session",
    current_version: 2,
    created_at: NOW,
    updated_at: NOW,
  });
  rawInsert(connection, "events", rawSessionEventValues({
    globalPosition: 1,
    streamVersion: 1,
    eventType: "ChildSessionSuspended",
    eventSchemaVersion: 1,
    sessionId: CHILD_ID,
    parentSessionId: ROOT_ID,
    commandId: "66666666-6666-4666-8666-666666666661",
    payload: {
      checkpointId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      blockers: [],
      followUps: [],
      authorityCommitment: H64,
    },
  }));
  rawInsert(connection, "events", rawSessionEventValues({
    globalPosition: 2,
    streamVersion: 2,
    eventType: "SessionCheckpointRecorded",
    eventSchemaVersion: 2,
    sessionId: CHILD_ID,
    parentSessionId: ROOT_ID,
    commandId: "66666666-6666-4666-8666-666666666662",
    payload: {
      checkpoint: {
        checkpointVersion: 2,
        checkpointId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      },
    },
  }));
  connection.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TRIGGER session_authority_insert_guard;
  `);
  rawInsert(connection, "session_authority", {
    project_id: PROJECT_ID,
    session_id: CHILD_ID,
    stream_id: `session/${CHILD_ID}`,
    session_kind: "child",
    parent_session_id: ROOT_ID,
    workspace_id: H64,
    client_namespace: "client",
    semantic_state: "suspended",
    child_capability_generation: 1,
    direct_access_enabled: 0,
    authority_commitment: H64,
    authority_event_position: 1,
    latest_checkpoint_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    latest_checkpoint_event_position: 2,
    latest_checkpoint_fingerprint: H64,
    created_at: NOW,
    updated_at: NOW,
  });
  connection.exec("PRAGMA foreign_keys = ON");
  seedWorkflow(connection, "requested", {
    root_command_id: "77777777-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    triggering_event_position: 1,
  });
}

function seedActiveChildTransferSource(
  connection: SqliteConnection,
  childState: "active" | "completion-proposed",
  workflowPhase = "requested",
): void {
  const checkpointId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  rawInsert(connection, "streams", {
    project_id: PROJECT_ID,
    stream_id: `session/${CHILD_ID}`,
    stream_type: "session",
    current_version: 1,
    created_at: NOW,
    updated_at: NOW,
  });
  rawInsert(connection, "events", rawSessionEventValues({
    globalPosition: 1,
    streamVersion: 1,
    eventType: "SessionCheckpointRecorded",
    eventSchemaVersion: 2,
    sessionId: CHILD_ID,
    parentSessionId: ROOT_ID,
    commandId: "66666666-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    payload: {
      checkpoint: { checkpointVersion: 2, checkpointId },
    },
  }));
  connection.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TRIGGER session_authority_insert_guard;
  `);
  rawInsert(connection, "session_authority", {
    project_id: PROJECT_ID,
    session_id: CHILD_ID,
    stream_id: `session/${CHILD_ID}`,
    session_kind: "child",
    parent_session_id: ROOT_ID,
    workspace_id: H64,
    client_namespace: "client",
    semantic_state: childState,
    child_capability_generation: 1,
    direct_access_enabled: 0,
    authority_commitment: H64,
    authority_event_position: 1,
    latest_checkpoint_id: checkpointId,
    latest_checkpoint_event_position: 1,
    latest_checkpoint_fingerprint: H64,
    created_at: NOW,
    updated_at: NOW,
  });
  connection.exec("PRAGMA foreign_keys = ON");
  seedWorkflow(connection, workflowPhase, {
    root_command_id: "77777777-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    triggering_event_position: 1,
  });
}

function seedDirectAbandonedEvent(connection: SqliteConnection): void {
  rawInsert(connection, "streams", {
    project_id: PROJECT_ID,
    stream_id: `session/${ROOT_ID}`,
    stream_type: "session",
    current_version: 2,
    created_at: NOW,
    updated_at: NOW,
  });
  rawInsert(connection, "events", rawSessionEventValues({
    globalPosition: 1,
    streamVersion: 1,
    eventType: "SessionStarted",
    eventSchemaVersion: 1,
    sessionId: ROOT_ID,
    parentSessionId: null,
    commandId: "99999999-9999-4999-8999-999999999998",
    payload: {
      sessionKind: "root",
      ownerGeneration: 1,
      continuityKey: H64,
      clientNamespace: "client",
      creatingAgentId: "agent",
      creatingClientInstanceId: "client",
      authorityCommitment: H64,
    },
  }));
  rawInsert(connection, "events", rawSessionEventValues({
    globalPosition: 2,
    streamVersion: 2,
    eventType: "SessionAbandoned",
    eventSchemaVersion: 1,
    sessionId: ROOT_ID,
    parentSessionId: null,
    commandId: "99999999-9999-4999-8999-999999999999",
    payload: {
      workflowId: null,
      workflowGeneration: null,
      approvalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      preTransitionCheckpointId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      reasonCode: "direct-abandon",
      authorityCommitment: H64,
    },
  }));
}

function lifecycleOutboxValues(
  payloadOverrides: Readonly<Record<string, unknown>> = {},
): Record<string, SqliteValue> {
  const targetKey = `lifecycle-log/${ROOT_ID}/2`;
  const artifactPath = `05_Agent_Session_Logs/2026-08-09-session-${ROOT_ID}.md`;
  return {
    project_id: PROJECT_ID,
    target_key: targetKey,
    event_position: 2,
    kind: "materialize-lifecycle-log",
    payload_json: canonicalJson({
      payloadVersion: 1,
      targetKey,
      sessionId: ROOT_ID,
      artifactKind: "compatibility-session-log",
      artifactPath,
      materializationRevision: "2",
      triggeringPayloadHash: H64,
      nextFingerprint: {
        algorithm: "hmac-sha256",
        schemaVersion: 1,
        keyId: "materialization-key",
        domain: "pm-materialization-fingerprint-v1",
        value: H64,
      },
      origin: {
        kind: "terminal-event",
        workflowId: null,
        workflowGeneration: null,
      },
      triggeringEventType: "SessionAbandoned",
      ...payloadOverrides,
    }),
    content_hash: H64,
    status: "pending",
    attempt_count: 0,
    claim_owner: null,
    claim_token: null,
    claim_expires_at: null,
    created_at: NOW,
    updated_at: NOW,
    session_id: ROOT_ID,
    origin_kind: "terminal-event",
    workflow_id: null,
    workflow_generation: null,
    artifact_kind: "compatibility-session-log",
    artifact_path: artifactPath,
    materialization_revision: 2,
    expected_prior_fingerprint: null,
    next_fingerprint: H64,
    fingerprint_algorithm: "hmac-sha256",
    fingerprint_schema_version: 1,
    fingerprint_key_id: "materialization-key",
    fingerprint_domain: "pm-materialization-fingerprint-v1",
    failure_class: null,
    safe_error_code: null,
    next_attempt_at: null,
  };
}

function finalMarkerOutboxValues(
  workflowGeneration = 1,
): Record<string, SqliteValue> {
  const targetKey = `lifecycle-log/${ROOT_ID}/2`;
  const artifactPath = `05_Agent_Session_Logs/2026-08-09-session-${ROOT_ID}.md`;
  return {
    ...lifecycleOutboxValues(),
    payload_json: canonicalJson({
      payloadVersion: 1,
      targetKey,
      sessionId: ROOT_ID,
      artifactKind: "compatibility-session-log",
      artifactPath,
      materializationRevision: "2",
      triggeringPayloadHash: H64,
      nextFingerprint: {
        algorithm: "hmac-sha256",
        schemaVersion: 1,
        keyId: "materialization-key",
        domain: "pm-materialization-fingerprint-v1",
        value: H64,
      },
      origin: {
        kind: "workflow",
        workflowId: WORKFLOW_ID,
        workflowGeneration,
      },
      triggeringEventType: "SessionCheckpointRecorded",
    }),
    origin_kind: "workflow",
    workflow_id: WORKFLOW_ID,
    workflow_generation: workflowGeneration,
  };
}

function seedGenericSessionEvent(connection: SqliteConnection): void {
  rawInsert(connection, "streams", {
    project_id: PROJECT_ID,
    stream_id: `session/${ROOT_ID}`,
    stream_type: "session",
    current_version: 1,
    created_at: NOW,
    updated_at: NOW,
  });
  rawInsert(connection, "events", {
    global_position: 1,
    event_id: "66666666-6666-4666-8666-666666666666",
    project_id: PROJECT_ID,
    vault_id: VAULT_ID,
    store_id: STORE_ID,
    workspace_id: H64,
    branch_scope_id: null,
    branch_ref: null,
    stream_id: `session/${ROOT_ID}`,
    stream_type: "session",
    stream_version: 1,
    event_type: "GenericRecorded",
    event_schema_version: 1,
    session_id: ROOT_ID,
    parent_session_id: null,
    actor_role: "primary",
    agent_id: "agent",
    client_instance_id: "client",
    correlation_id: "77777777-7777-4777-8777-777777777777",
    causation_id: null,
    command_id: "88888888-8888-4888-8888-888888888888",
    idempotency_key: "generic-terminal-history",
    command_event_index: 0,
    occurred_at: NOW,
    recorded_at: NOW,
    visibility_scope: "session",
    confidence: "high",
    verification_status: "verified",
    source_refs_json: "[]",
    evidence_refs_json: "[]",
    evidence_digests_json: "[]",
    payload_json: canonicalJson({ retained: "é" }),
    payload_hash: "b".repeat(64),
    previous_global_hash: "0".repeat(64),
    event_hash: "c".repeat(64),
    lifecycle_intent_json: null,
  });
}

function finalCheckpointIntent(
  checkpoint: Readonly<Record<string, unknown>>,
  overrides: Readonly<Record<string, unknown>> = {},
): string {
  const command = {
    commandType: "internal-workflow-phase",
    commandId: "88888888-8888-4888-8888-888888888888",
    idempotencyKey: "raw/88888888-8888-4888-8888-888888888888",
    agentId: "agent",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: H64,
    expectedBranchRef: null,
    workflowId: WORKFLOW_ID,
    workflowGeneration: 1,
    plannedWorkId: H64,
    sourcePhase: "children-resolved",
    claim: {
      workflowId: WORKFLOW_ID,
      workflowGeneration: 1,
      claimOwnerId: "99999999-9999-4999-8999-999999999999",
      claimToken: "1",
      claimExpiresAt: "2026-08-09T00:10:00.000Z",
    },
    action: {
      action: "record-final-checkpoint-and-queue-ending",
      finalCheckpoint: checkpoint,
      materializationTarget: "memory/session-end.md",
    },
    ...overrides,
  } as const;
  return buildLifecycleIntentWitness(command as never, {
    authorizationKind: "internal-workflow",
    authorizationSessionId: ROOT_ID,
    targetSessionId: ROOT_ID,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: H64,
    clientNamespace: "client",
    capabilityKind: null,
    capabilityGeneration: null,
    presentingActorRole: "primary",
    presentingClientInstanceId: "client",
    targetActorRole: "primary",
    targetClientInstanceId: "client",
    internalWorkflowId: WORKFLOW_ID,
    internalWorkflowGeneration: 1,
    internalPlannedWorkId: H64,
  }).source;
}

function finalMarkerCheckpoint(version: 1 | 2): Readonly<Record<string, unknown>> {
  const source = version === 1
    ? checkpointFixture({
        sessionId: ROOT_ID as never,
        parentSessionId: null,
        baseEventPosition: 1,
        checkpointEventPosition: 2,
      })
    : qualifiedCheckpointFixture({
        sessionId: ROOT_ID as never,
        parentSessionId: null,
        baseEventPosition: 1,
        checkpointEventPosition: 2,
      });
  return {
    ...source,
    sourceState: {
      ...source.sourceState,
      workspaceId: H64,
    },
  } as unknown as Readonly<Record<string, unknown>>;
}

function seedFinalMarkerContext(connection: SqliteConnection): void {
  rawInsert(connection, "streams", {
    project_id: PROJECT_ID,
    stream_id: `session/${ROOT_ID}`,
    stream_type: "session",
    current_version: 1,
    created_at: NOW,
    updated_at: NOW,
  });
  rawInsert(connection, "events", rawSessionEventValues({
    globalPosition: 1,
    streamVersion: 1,
    eventType: "SessionStarted",
    eventSchemaVersion: 1,
    sessionId: ROOT_ID,
    parentSessionId: null,
    commandId: "77777777-7777-4777-8777-777777777777",
    payload: {
      sessionKind: "root",
      ownerGeneration: 1,
      continuityKey: H64,
      clientNamespace: "client",
      creatingAgentId: "agent",
      creatingClientInstanceId: "client",
      authorityCommitment: H64,
    },
  }));
  withTriggersTemporarilyDropped(connection, ["session_authority_insert_guard"], () => {
    rawInsert(connection, "session_authority", {
      project_id: PROJECT_ID,
      session_id: ROOT_ID,
      stream_id: `session/${ROOT_ID}`,
      session_kind: "root",
      parent_session_id: null,
      workspace_id: H64,
      client_namespace: "client",
      semantic_state: "ending",
      owner_generation: 1,
      direct_access_enabled: 1,
      authority_commitment: H64,
      authority_event_position: 1,
      created_at: NOW,
      updated_at: NOW,
    });
  });
  seedWorkflow(connection, "children-resolved", {
    root_command_id: "77777777-7777-4777-8777-777777777777",
    triggering_event_position: 1,
  });
}

function finalMarkerEventValues(
  checkpointVersion: 1 | 2,
  mutate: (values: Record<string, SqliteValue>, payload: Record<string, unknown>) => void
    = () => undefined,
): Record<string, SqliteValue> {
  const checkpoint = finalMarkerCheckpoint(checkpointVersion);
  const payload: Record<string, unknown> = {
    checkpoint,
    baseEventPosition: "1",
    checkpointEventPosition: "2",
    finalCheckpointBindingVersion: 1,
    workflowId: WORKFLOW_ID,
    workflowGeneration: 1,
  };
  const values = rawSessionEventValues({
    globalPosition: 2,
    streamVersion: 2,
    eventType: "SessionCheckpointRecorded",
    eventSchemaVersion: 3,
    sessionId: ROOT_ID,
    parentSessionId: null,
    commandId: "88888888-8888-4888-8888-888888888888",
    payload,
    lifecycleIntent: JSON.parse(finalCheckpointIntent(checkpoint)),
  });
  mutate(values, payload);
  values.payload_json = canonicalJson(payload);
  return values;
}

function frozenWorkflowStatus(
  generation: number,
  phase: string,
  checkpoint: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    resultVersion: 2,
    sessionId: ROOT_ID,
    workflowId: WORKFLOW_ID,
    workflowGeneration: generation,
    phase,
    priorRootState: "active",
    triggeringEventPosition: "1",
    finalCheckpointId: checkpoint.checkpointId,
    finalCheckpointEventPosition: "2",
    evidenceWindow: {
      evidenceWindowState: "sealed",
      evidenceFrozenCheckpointEventPosition: "2",
      evidenceFrozenGeneration: 1,
    },
    validationPlansReady: false,
    qualityScore: null,
    safeFailureCode: null,
    materializationRequired: true,
  };
}

function freezeWorkflowAtFinalMarker(connection: SqliteConnection): void {
  const checkpoint = finalMarkerCheckpoint(1);
  seedFinalMarkerContext(connection);
  rawInsert(connection, "events", finalMarkerEventValues(1));
  connection.prepare(`
    UPDATE workflow_instances
    SET phase = 'final-checkpoint-recorded',
        result_json = $resultJson,
        evidence_frozen_checkpoint_event_position = 2,
        evidence_frozen_generation = 1,
        final_ending_scope_bindings_json = '[]',
        updated_at = $updatedAt
    WHERE project_id = $projectId AND workflow_id = $workflowId
  `).run({
    $resultJson: canonicalJson({
      resultVersion: 2,
      action: "record-final-checkpoint-and-queue-ending",
      progressed: true,
      previousPhase: "children-resolved",
      status: frozenWorkflowStatus(1, "final-checkpoint-recorded", checkpoint),
    }),
    $updatedAt: NOW,
    $projectId: PROJECT_ID,
    $workflowId: WORKFLOW_ID,
  });
}

function rawSnapshotAtBytes(targetBytes: number): Readonly<Record<string, unknown>> {
  const shellBytes = Buffer.byteLength(canonicalJson({ padding: "" }), "utf8");
  const payloadBytes = targetBytes - shellBytes;
  const multibyteCount = Math.floor(payloadBytes / 2);
  const padding = `${"é".repeat(multibyteCount)}${payloadBytes % 2 === 0 ? "" : "x"}`;
  const value = { padding };
  assert.equal(Buffer.byteLength(canonicalJson(value), "utf8"), targetBytes);
  return value;
}

function historyUuid(prefix: string, index: number): string {
  return `${prefix}0000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function seedHistoryRows(
  connection: SqliteConnection,
  directChildren: number,
  sourceTickets: number,
): void {
  connection.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TRIGGER session_authority_insert_guard;
    DROP TRIGGER child_transfer_tickets_insert_guard;
  `);
  const eventTriggerNames = connection.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'trigger' AND tbl_name = 'events'
    ORDER BY name
  `).all().map((row) => String(row.name));
  withTriggersTemporarilyDropped(connection, eventTriggerNames, () => {
    for (let index = 1; index <= directChildren; index += 1) {
      const sessionId = historyUuid("a", index);
      rawInsert(connection, "events", rawSessionEventValues({
        globalPosition: index,
        streamVersion: 1,
        eventType: "SessionForked",
        eventSchemaVersion: 1,
        sessionId,
        parentSessionId: ROOT_ID,
        commandId: historyUuid("6", index),
        payload: {
          parentSessionId: ROOT_ID,
          assignment: {
            assignmentId: historyUuid("d", index),
            summary: "capacity fixture",
            scope: "migration preflight",
          },
          rootOwnerGeneration: 1,
          directAccessEnabled: false,
          authorityCommitment: H64,
          sourceTransferTicketId: null,
        },
      }));
    }
    for (let index = 1; index <= sourceTickets; index += 1) {
      const childIndex = ((index - 1) % Math.max(1, directChildren)) + 1;
      rawInsert(connection, "events", rawSessionEventValues({
        globalPosition: directChildren + index,
        streamVersion: 2 + Math.floor((index - 1) / Math.max(1, directChildren)),
        eventType: "ChildWorkTransferCreated",
        eventSchemaVersion: 1,
        sessionId: historyUuid("a", childIndex),
        parentSessionId: ROOT_ID,
        commandId: historyUuid("7", index),
        payload: {
          transferTicketId: historyUuid("b", index),
          checkpointId: historyUuid("c", index),
          authorityCommitment: H64,
        },
      }));
    }
  });
  const insertChild = connection.prepare(`
    INSERT INTO session_authority(
      project_id, session_id, stream_id, session_kind, parent_session_id,
      workspace_id, client_namespace, semantic_state, direct_access_enabled,
      authority_commitment, authority_event_position, created_at, updated_at
    ) VALUES (
      $projectId, $sessionId, $streamId, 'child', $parentSessionId,
      $workspaceId, 'client', $semanticState, 0,
      $authorityCommitment, $authorityEventPosition, $createdAt, $updatedAt
    )
  `);
  for (let index = 1; index <= directChildren; index += 1) {
    const sessionId = historyUuid("a", index);
    const authorityEventPosition = index <= sourceTickets
      ? directChildren + index
      : index;
    insertChild.run({
      $projectId: PROJECT_ID,
      $sessionId: sessionId,
      $streamId: `session/${sessionId}`,
      $parentSessionId: ROOT_ID,
      $workspaceId: H64,
      $semanticState: index <= sourceTickets ? "transferred" : "completed",
      $authorityCommitment: H64,
      $authorityEventPosition: authorityEventPosition,
      $createdAt: NOW,
      $updatedAt: NOW,
    });
  }
  const insertTicket = connection.prepare(`
    INSERT INTO child_transfer_tickets(
      project_id, transfer_ticket_id, source_parent_session_id,
      source_child_session_id, source_assignment_json, source_scope_json,
      checkpoint_id, follow_ups_json, source_state_json, lineage_json,
      created_event_position, created_at
    ) VALUES (
      $projectId, $ticketId, $parentSessionId, $childSessionId,
      '{}', '{}', $checkpointId, '[]', '{}', '{}', $eventPosition, $createdAt
    )
  `);
  for (let index = 1; index <= sourceTickets; index += 1) {
    const childIndex = ((index - 1) % Math.max(1, directChildren)) + 1;
    insertTicket.run({
      $projectId: PROJECT_ID,
      $ticketId: historyUuid("b", index),
      $parentSessionId: ROOT_ID,
      $childSessionId: historyUuid("a", childIndex),
      $checkpointId: historyUuid("c", index),
      $eventPosition: directChildren + index,
      $createdAt: NOW,
    });
  }
  connection.exec("PRAGMA foreign_keys = ON");
}

function seedAuthenticatedForeignClaimHistory(
  connection: SqliteConnection,
  claimed = true,
): void {
  const foreignWorkspace = "b".repeat(64);
  connection.exec("PRAGMA foreign_keys = OFF");
  const eventTriggerNames = connection.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'trigger' AND tbl_name = 'events'
    ORDER BY name
  `).all().map((row) => String(row.name));
  withTriggersTemporarilyDropped(connection, eventTriggerNames, () => {
    const sourceFork = rawSessionEventValues({
      globalPosition: 1,
      streamVersion: 1,
      eventType: "SessionForked",
      eventSchemaVersion: 1,
      sessionId: CHILD_ID,
      parentSessionId: ROOT_ID,
      commandId: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      payload: {
        parentSessionId: ROOT_ID,
        assignment: {
          assignmentId: "11111111-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          summary: "source child",
          scope: "migration preflight",
        },
        rootOwnerGeneration: 1,
        directAccessEnabled: false,
        authorityCommitment: H64,
        sourceTransferTicketId: null,
      },
    });
    const sourceTransfer = rawSessionEventValues({
      globalPosition: 2,
      streamVersion: 2,
      eventType: "ChildWorkTransferCreated",
      eventSchemaVersion: 1,
      sessionId: CHILD_ID,
      parentSessionId: ROOT_ID,
      commandId: "22222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      payload: {
        transferTicketId: TRANSFER_TICKET_ID,
        checkpointId: "99999999-9999-4999-8999-999999999999",
        authorityCommitment: H64,
      },
    });
    const claimCommandId = "33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const foreignFork = rawSessionEventValues({
      globalPosition: 3,
      streamVersion: 1,
      eventType: "SessionForked",
      eventSchemaVersion: 1,
      sessionId: FOREIGN_CHILD_ID,
      parentSessionId: FOREIGN_ROOT_ID,
      commandId: claimCommandId,
      payload: {
        parentSessionId: FOREIGN_ROOT_ID,
        assignment: {
          assignmentId: "33333333-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          summary: "claimed child",
          scope: "migration preflight",
        },
        rootOwnerGeneration: 1,
        directAccessEnabled: false,
        authorityCommitment: H64,
        sourceTransferTicketId: TRANSFER_TICKET_ID,
      },
    });
    foreignFork.workspace_id = foreignWorkspace;
    foreignFork.causation_id = sourceTransfer.event_id!;
    const claim = rawSessionEventValues({
      globalPosition: 4,
      streamVersion: 2,
      eventType: "ChildWorkTransferClaimed",
      eventSchemaVersion: 1,
      sessionId: FOREIGN_CHILD_ID,
      parentSessionId: FOREIGN_ROOT_ID,
      commandId: claimCommandId,
      commandEventIndex: 1,
      payload: {
        transferTicketId: TRANSFER_TICKET_ID,
        previousChildSessionId: CHILD_ID,
        previousTransferEventPosition: "2",
      },
    });
    claim.workspace_id = foreignWorkspace;
    claim.causation_id = foreignFork.event_id!;
    rawInsert(connection, "events", sourceFork);
    rawInsert(connection, "events", sourceTransfer);
    rawInsert(connection, "events", foreignFork);
    rawInsert(connection, "events", claim);
  });
  withTriggersTemporarilyDropped(connection, ["session_authority_insert_guard"], () => {
    for (const child of [
      {
        id: CHILD_ID,
        parentId: ROOT_ID,
        workspaceId: H64,
        state: "transferred",
        authorityPosition: 2,
      },
      {
        id: FOREIGN_CHILD_ID,
        parentId: FOREIGN_ROOT_ID,
        workspaceId: foreignWorkspace,
        state: "active",
        authorityPosition: 3,
      },
    ] as const) {
      rawInsert(connection, "session_authority", {
        project_id: PROJECT_ID,
        session_id: child.id,
        stream_id: `session/${child.id}`,
        session_kind: "child",
        parent_session_id: child.parentId,
        workspace_id: child.workspaceId,
        client_namespace: "client",
        semantic_state: child.state,
        direct_access_enabled: 0,
        authority_commitment: H64,
        authority_event_position: child.authorityPosition,
        created_at: NOW,
        updated_at: NOW,
      });
    }
    for (const root of [
      { id: ROOT_ID, workspaceId: H64, authorityPosition: 1 },
      { id: FOREIGN_ROOT_ID, workspaceId: foreignWorkspace, authorityPosition: 3 },
    ] as const) {
      rawInsert(connection, "session_authority", {
        project_id: PROJECT_ID,
        session_id: root.id,
        stream_id: `session/${root.id}`,
        session_kind: "root",
        parent_session_id: null,
        workspace_id: root.workspaceId,
        client_namespace: "client",
        semantic_state: "active",
        owner_generation: 1,
        direct_access_enabled: 1,
        authority_commitment: H64,
        authority_event_position: root.authorityPosition,
        created_at: NOW,
        updated_at: NOW,
      });
    }
  });
  withTriggersTemporarilyDropped(connection, ["child_transfer_tickets_insert_guard"], () => {
    rawInsert(connection, "child_transfer_tickets", {
      project_id: PROJECT_ID,
      transfer_ticket_id: TRANSFER_TICKET_ID,
      source_parent_session_id: ROOT_ID,
      source_child_session_id: CHILD_ID,
      source_assignment_json: "{}",
      source_scope_json: "{}",
      checkpoint_id: "99999999-9999-4999-8999-999999999999",
      follow_ups_json: "[]",
      source_state_json: "{}",
      lineage_json: "{}",
      created_event_position: 2,
      created_at: NOW,
      claimed_by_root_session_id: claimed ? FOREIGN_ROOT_ID : null,
      claimed_child_session_id: claimed ? FOREIGN_CHILD_ID : null,
      claimed_event_position: claimed ? 4 : null,
      claimed_at: claimed ? NOW : null,
    });
  });
  connection.exec("PRAGMA foreign_keys = ON");
}

function snapshotDatabase(connection: SqliteConnection): string {
  const snapshot = {
    migrations: connection.prepare(
      "SELECT * FROM schema_migrations ORDER BY version",
    ).all(),
    meta: connection.prepare("SELECT * FROM project_meta").all(),
    workflows: connection.prepare(
      "SELECT * FROM workflow_instances ORDER BY workflow_id",
    ).all(),
    schema: connection.prepare(`
      SELECT type, name, tbl_name, sql FROM sqlite_schema
      WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name
    `).all(),
  };
  return JSON.stringify(snapshot, (_key, value) => (
    typeof value === "bigint" ? value.toString() : value
  ));
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof Error
    && "code" in error
    && Reflect.get(error, "code") === code;
}

afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("indexes direct-child forks and transfer claims as immutable event witnesses", () => {
  assert.match(sessionEndEffectiveStateMigration.sql, /CREATE INDEX events_lifecycle_direct_child_v4/);
  assert.match(sessionEndEffectiveStateMigration.sql, /CREATE INDEX events_lifecycle_transfer_claim_v4/);
  const connection = schema4Connection();
  const directPlan = connection.prepare(`
    EXPLAIN QUERY PLAN
    SELECT global_position FROM events
    WHERE project_id = $projectId
      AND parent_session_id = $rootSessionId
      AND stream_type = 'session'
      AND event_type = 'SessionForked'
      AND event_schema_version = 1
      AND global_position < $cutoff
    ORDER BY global_position
  `).all({
    $projectId: PROJECT_ID,
    $rootSessionId: ROOT_ID,
    $cutoff: 10,
  });
  const claimPlan = connection.prepare(`
    EXPLAIN QUERY PLAN
    SELECT global_position FROM events
    WHERE project_id = $projectId
      AND json_extract(payload_json, '$.transferTicketId') = $ticketId
      AND stream_type = 'session'
      AND event_type = 'ChildWorkTransferClaimed'
      AND event_schema_version = 1
    ORDER BY global_position
  `).all({ $projectId: PROJECT_ID, $ticketId: TRANSFER_TICKET_ID });
  assert.match(directPlan.map((row) => String(row.detail)).join("\n"), /events_lifecycle_direct_child_v4/u);
  assert.match(claimPlan.map((row) => String(row.detail)).join("\n"), /events_lifecycle_transfer_claim_v4/u);
});

it("requires Version 3 markers in schema-4 lifecycle event guards", () => {
  const sql = sessionEndEffectiveStateMigration.sql;
  assert.match(sql, /SessionCheckpointRecorded[\s\S]{0,500}NEW\.event_schema_version = 3/);
  assert.match(sql, /finalCheckpointBindingVersion/);
  assert.match(sql, /workflowGeneration/);
});

it("admits only authenticated Version 3 final markers at schema 4", () => {
  for (const checkpointVersion of [1, 2] as const) {
    const accepted = schema4Connection();
    seedFinalMarkerContext(accepted);
    assert.doesNotThrow(() => rawInsert(
      accepted,
      "events",
      finalMarkerEventValues(checkpointVersion),
    ));
  }

  const mutations: readonly ((
    values: Record<string, SqliteValue>,
    payload: Record<string, unknown>,
  ) => void)[] = [
    (_values, payload) => { delete payload.finalCheckpointBindingVersion; },
    (_values, payload) => { payload.extra = true; },
    (_values, payload) => { payload.checkpoint = null; },
    (_values, payload) => { payload.baseEventPosition = null; },
    (_values, payload) => { payload.checkpointEventPosition = null; },
    (_values, payload) => { payload.finalCheckpointBindingVersion = null; },
    (_values, payload) => { payload.workflowId = null; },
    (_values, payload) => { payload.workflowGeneration = null; },
    (_values, payload) => { payload.workflowGeneration = 0; },
    (_values, payload) => { payload.baseEventPosition = "2"; },
    (_values, payload) => { payload.checkpointEventPosition = "3"; },
    (_values, payload) => {
      const checkpoint = payload.checkpoint as Record<string, unknown>;
      payload.checkpoint = { ...checkpoint, sessionId: CHILD_ID };
    },
    (_values, payload) => {
      const checkpoint = payload.checkpoint as Record<string, unknown>;
      payload.checkpoint = { ...checkpoint, parentSessionId: CHILD_ID };
    },
    (_values, payload) => {
      const checkpoint = payload.checkpoint as Record<string, unknown>;
      payload.checkpoint = {
        ...checkpoint,
        sourceState: {
          ...(checkpoint.sourceState as Record<string, unknown>),
          workspaceId: "b".repeat(64),
        },
      };
    },
    (values) => { values.parent_session_id = CHILD_ID; },
    (values) => { values.stream_id = `session/${CHILD_ID}`; },
    (values) => { values.command_event_index = 1; },
    (values) => { values.lifecycle_intent_json = null; },
    (values) => {
      const witness = JSON.parse(String(values.lifecycle_intent_json)) as Record<string, unknown>;
      const intent = witness.intent as Record<string, unknown>;
      const command = intent.command as Record<string, unknown>;
      command.sourcePhase = "requested";
      values.lifecycle_intent_json = canonicalJson(witness);
    },
    (values) => {
      const witness = JSON.parse(String(values.lifecycle_intent_json)) as Record<string, unknown>;
      const intent = witness.intent as Record<string, unknown>;
      const command = intent.command as Record<string, unknown>;
      command.workflowGeneration = 2;
      values.lifecycle_intent_json = canonicalJson(witness);
    },
    (values) => {
      const witness = JSON.parse(String(values.lifecycle_intent_json)) as Record<string, unknown>;
      const intent = witness.intent as Record<string, unknown>;
      const command = intent.command as Record<string, unknown>;
      const action = command.action as Record<string, unknown>;
      action.action = "mark-children-resolved";
      values.lifecycle_intent_json = canonicalJson(witness);
    },
  ];

  for (const [mutationIndex, mutation] of mutations.entries()) {
    const rejected = schema4Connection();
    seedFinalMarkerContext(rejected);
    assert.throws(
      () => rawInsert(rejected, "events", finalMarkerEventValues(1, mutation)),
      /FINAL_CHECKPOINT_V4_INVALID|LIFECYCLE_EVENT_VERSION_INVALID|LIFECYCLE_INTENT_WITNESS_INVALID/,
      `final marker mutation ${mutationIndex} must fail`,
    );
    assert.equal(
      rejected.prepare("SELECT count(*) AS count FROM events").get()?.count,
      1n,
    );
  }

  for (const workflowMutation of [
    "phase = 'requested'",
    "evidence_window_state = 'open'",
    "evidence_frozen_checkpoint_event_position = 1, evidence_frozen_generation = 1, final_ending_scope_bindings_json = '[]'",
  ]) {
    const rejected = schema4Connection();
    seedFinalMarkerContext(rejected);
    withTriggersTemporarilyDropped(
      rejected,
      ["workflow_instances_evidence_v3_update_guard"],
      () => rejected.prepare(`
        UPDATE workflow_instances SET ${workflowMutation}
        WHERE project_id = $projectId AND workflow_id = $workflowId
      `).run({ $projectId: PROJECT_ID, $workflowId: WORKFLOW_ID }),
    );
    assert.throws(
      () => rawInsert(rejected, "events", finalMarkerEventValues(1)),
      /FINAL_CHECKPOINT_V4_INVALID/,
    );
  }
});

it("requires Version 3 markers in both workflow evidence guards", () => {
  for (const name of [
    "workflow_instances_evidence_v3_insert_guard",
    "workflow_instances_evidence_v3_update_guard",
  ] as const) {
    const trigger = new RegExp(`CREATE TRIGGER ${name}[\\s\\S]*?\\nEND;`, "u")
      .exec(sessionEndEffectiveStateMigration.sql)?.[0];
    assert.equal(typeof trigger, "string", `missing ${name}`);
    assert.match(trigger!, /final_checkpoint_event\.event_schema_version = 3/u);
    assert.match(trigger!, /\$\.workflowId'[\s\S]*?NEW\.workflow_id/u);
    assert.match(trigger!, /\$\.workflowGeneration'[\s\S]*?NEW\.evidence_frozen_generation/u);
    assert.doesNotMatch(trigger!, /final_checkpoint_event\.event_schema_version IN \(1, 2\)/u);
  }
});

it("amend unchanged preserves phase and frozen bytes", () => {
  const connection = schema4Connection();
  freezeWorkflowAtFinalMarker(connection);
  const checkpoint = finalMarkerCheckpoint(1);

  assert.doesNotThrow(() => connection.prepare(`
    UPDATE workflow_instances
    SET generation = 2,
        result_json = $resultJson,
        updated_at = $updatedAt
    WHERE project_id = $projectId AND workflow_id = $workflowId
  `).run({
    $resultJson: canonicalJson(
      frozenWorkflowStatus(2, "final-checkpoint-recorded", checkpoint),
    ),
    $updatedAt: NOW,
    $projectId: PROJECT_ID,
    $workflowId: WORKFLOW_ID,
  }));
  const row = connection.prepare(`
    SELECT generation, phase, evidence_frozen_checkpoint_event_position,
           evidence_frozen_generation, final_ending_scope_bindings_json
    FROM workflow_instances
    WHERE project_id = $projectId AND workflow_id = $workflowId
  `).get({ $projectId: PROJECT_ID, $workflowId: WORKFLOW_ID });
  assert.deepEqual({ ...row }, {
    generation: 2n,
    phase: "final-checkpoint-recorded",
    evidence_frozen_checkpoint_event_position: 2n,
    evidence_frozen_generation: 1n,
    final_ending_scope_bindings_json: "[]",
  });
});

it("rejects frozen marker rewrite during unchanged workflow carry", () => {
  const connection = schema4Connection();
  freezeWorkflowAtFinalMarker(connection);
  const checkpoint = finalMarkerCheckpoint(1);
  const before = connection.prepare(`
    SELECT * FROM workflow_instances
    WHERE project_id = $projectId AND workflow_id = $workflowId
  `).get({ $projectId: PROJECT_ID, $workflowId: WORKFLOW_ID });

  assert.throws(() => connection.prepare(`
    UPDATE workflow_instances
    SET generation = 2,
        evidence_frozen_generation = 2,
        result_json = $resultJson,
        updated_at = $updatedAt
    WHERE project_id = $projectId AND workflow_id = $workflowId
  `).run({
    $resultJson: canonicalJson({
      ...frozenWorkflowStatus(2, "final-checkpoint-recorded", checkpoint),
      evidenceWindow: {
        evidenceWindowState: "sealed",
        evidenceFrozenCheckpointEventPosition: "2",
        evidenceFrozenGeneration: 2,
      },
    }),
    $updatedAt: NOW,
    $projectId: PROJECT_ID,
    $workflowId: WORKFLOW_ID,
  }), /WORKFLOW_EVIDENCE_STATE_INVALID/);
  assert.deepEqual(connection.prepare(`
    SELECT * FROM workflow_instances
    WHERE project_id = $projectId AND workflow_id = $workflowId
  `).get({ $projectId: PROJECT_ID, $workflowId: WORKFLOW_ID }), before);
});

it("binds Version 3 checkpoint outbox origin directly to payload workflow identity", () => {
  const accepted = schema4Connection();
  seedFinalMarkerContext(accepted);
  rawInsert(accepted, "events", finalMarkerEventValues(1));
  assert.doesNotThrow(() => rawInsert(accepted, "outbox", finalMarkerOutboxValues()));

  const rejected = schema4Connection();
  seedFinalMarkerContext(rejected);
  rawInsert(rejected, "events", finalMarkerEventValues(1));
  withTriggersTemporarilyDropped(
    rejected,
    ["workflow_instances_evidence_v3_update_guard"],
    () => rejected.prepare(`
      UPDATE workflow_instances SET generation = 2
      WHERE project_id = $projectId AND workflow_id = $workflowId
    `).run({ $projectId: PROJECT_ID, $workflowId: WORKFLOW_ID }),
  );
  assert.throws(
    () => rawInsert(rejected, "outbox", finalMarkerOutboxValues(2)),
    /OUTBOX_LIFECYCLE_DESCRIPTOR_V4_INVALID/,
  );
});

describe("session-end effective-state migration", () => {
  it("adds the immutable legacy effective-state sidecar without a new schema version", () => {
    const connection = schema4Connection();

    const table = connection.prepare(`
      SELECT type, name, sql
      FROM sqlite_schema
      WHERE type = 'table'
        AND name = 'lifecycle_legacy_effective_state_sources'
    `).get();
    assert.equal(table?.type, "table");
    assert.equal(table?.name, "lifecycle_legacy_effective_state_sources");
    assert.match(String(table?.sql), /STRICT/u);
    assert.equal(
      connection.prepare(`
        SELECT version FROM schema_migrations WHERE version = 4
      `).get()?.version,
      4n,
    );
    const indexes = connection.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'index'
        AND name LIKE 'lifecycle_legacy_effective_state_sources_%'
      ORDER BY name
    `).all().map((row) => row.name);
    assert.deepEqual(indexes, [
      "lifecycle_legacy_effective_state_sources_command_lookup",
      "lifecycle_legacy_effective_state_sources_event_lookup",
    ]);
  });

  it("rejects schema-3 ticket claim pointer drift before schema 4", () => {
    const connection = schema3Connection();
    seedHistoryRows(connection, 1, 1);
    connection.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TRIGGER child_transfer_tickets_update_guard;
      UPDATE child_transfer_tickets
      SET claimed_by_root_session_id = '${ROOT_ID}',
          claimed_child_session_id = '${CHILD_ID}',
          claimed_event_position = 1,
          claimed_at = '${NOW}';
      PRAGMA foreign_keys = ON;
    `);
    const before = snapshotDatabase(connection);
    assert.throws(
      () => new SqliteSessionEndEffectiveStateMigrationPreflight()
        .assertEligible(connection, context),
      hasCode("MIGRATION_SESSION_END_EFFECTIVE_STATE_PRECONDITION_FAILED"),
    );
    assert.equal(snapshotDatabase(connection), before);
  });

  it("rejects schema-3 fork authority drift before schema 4", () => {
    const connection = schema3Connection();
    seedHistoryRows(connection, 1, 0);
    connection.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TRIGGER events_no_update;
      UPDATE events
      SET parent_session_id = '${CHILD_ID}'
      WHERE event_type = 'SessionForked';
      PRAGMA foreign_keys = ON;
    `);
    const before = snapshotDatabase(connection);
    assert.throws(
      () => new SqliteSessionEndEffectiveStateMigrationPreflight()
        .assertEligible(connection, context),
      hasCode("MIGRATION_SESSION_END_EFFECTIVE_STATE_PRECONDITION_FAILED"),
    );
    assert.equal(snapshotDatabase(connection), before);
  });

  it("rejects schema-3 legacy final pointers before schema 4", () => {
    const connection = schema3Connection();
    seedStrictLegacyCancelledHistory(connection);
    withTriggersTemporarilyDropped(
      connection,
      ["workflow_instances_evidence_v3_update_guard"],
      () => connection.prepare(`
        UPDATE workflow_instances
        SET evidence_frozen_checkpoint_event_position = 1,
            evidence_frozen_generation = 1,
            final_ending_scope_bindings_json = '[]'
      `).run(),
    );
    const before = snapshotDatabase(connection);
    assert.throws(
      () => new SqliteSessionEndEffectiveStateMigrationPreflight()
        .assertEligible(connection, context),
      hasCode("MIGRATION_SESSION_END_EFFECTIVE_STATE_PRECONDITION_FAILED"),
    );
    assert.equal(snapshotDatabase(connection), before);
  });

  it("upgrades an authenticated cross-workspace foreign claim pair", () => {
    const connection = schema3Connection();
    seedAuthenticatedForeignClaimHistory(connection);
    const before = snapshotDatabase(connection);
    new SqliteSessionEndEffectiveStateMigrationPreflight()
      .assertEligible(connection, context);
    assert.equal(snapshotDatabase(connection), before);

    new MigrationRunner().apply(connection, [
      eventCoreMigration,
      sessionLifecycleMigration,
      qualifiedCheckpointCoverageMigration,
      sessionEndEffectiveStateMigration,
    ], NOW, {
      kind: "explicit-upgrade",
      expectedAppliedVersion: 3,
      beforeMigration: () => undefined,
    });
    assert.equal(
      connection.prepare("SELECT schema_version FROM project_meta WHERE singleton = 1")
        .get()?.schema_version,
      4n,
    );
  });

  it("binds null-to-claimed ticket updates to immutable fork claim witnesses", () => {
    const accepted = schema4Connection();
    seedAuthenticatedForeignClaimHistory(accepted, false);
    assert.doesNotThrow(() => accepted.prepare(`
      UPDATE child_transfer_tickets
      SET claimed_by_root_session_id = $claimedRoot,
          claimed_child_session_id = $claimedChild,
          claimed_event_position = 4,
          claimed_at = $claimedAt
      WHERE project_id = $projectId AND transfer_ticket_id = $ticketId
    `).run({
      $claimedRoot: FOREIGN_ROOT_ID,
      $claimedChild: FOREIGN_CHILD_ID,
      $claimedAt: NOW,
      $projectId: PROJECT_ID,
      $ticketId: TRANSFER_TICKET_ID,
    }));

    const rejected = schema4Connection();
    seedAuthenticatedForeignClaimHistory(rejected, false);
    assert.throws(() => rejected.prepare(`
      UPDATE child_transfer_tickets
      SET claimed_by_root_session_id = $claimedRoot,
          claimed_child_session_id = $claimedChild,
          claimed_event_position = 4,
          claimed_at = $claimedAt
      WHERE project_id = $projectId AND transfer_ticket_id = $ticketId
    `).run({
      $claimedRoot: FOREIGN_ROOT_ID,
      $claimedChild: CHILD_ID,
      $claimedAt: NOW,
      $projectId: PROJECT_ID,
      $ticketId: TRANSFER_TICKET_ID,
    }), /CHILD_TRANSFER_TICKET_IMMUTABLE/);
  });

  it("rejects schema-3 nonterminal workflows with zero writes", () => {
    const connection = schema3Connection();
    seedWorkflow(connection, "requested");
    const before = snapshotDatabase(connection);

    assert.throws(
      () => new SqliteSessionEndEffectiveStateMigrationPreflight()
        .assertEligible(connection, context),
      hasCode("MIGRATION_SESSION_END_EFFECTIVE_STATE_PRECONDITION_FAILED"),
    );
    assert.equal(snapshotDatabase(connection), before);
  });

  it("rejects terminal workflow lineage mismatch with zero writes", () => {
    const valid = schema3Connection();
    seedStrictLegacyCancelledHistory(valid);
    new SqliteSessionEndEffectiveStateMigrationPreflight()
      .assertEligible(valid, context);

    const hostile = schema3Connection();
    seedStrictLegacyCancelledHistory(hostile, 1);
    const before = snapshotDatabase(hostile);
    assert.throws(
      () => new SqliteSessionEndEffectiveStateMigrationPreflight()
        .assertEligible(hostile, context),
      hasCode("MIGRATION_SESSION_END_EFFECTIVE_STATE_PRECONDITION_FAILED"),
    );
    assert.equal(snapshotDatabase(hostile), before);
  });

  it("rejects strict-valid disallowed outer versions before schema 4", () => {
    const connection = schema3Connection();
    seedStrictValidDisallowedV3Event(connection);
    const before = snapshotDatabase(connection);

    assert.throws(
      () => new SqliteSessionEndEffectiveStateMigrationPreflight()
        .assertEligible(connection, context),
      hasCode("MIGRATION_SESSION_END_EFFECTIVE_STATE_PRECONDITION_FAILED"),
    );
    assert.equal(snapshotDatabase(connection), before);
  });

  it("rejects every independent schema-4 validation-plan preflight violation", () => {
    const first = {
      profileId: "alpha",
      profileVersion: 1,
      runId: "10000000-0000-4000-8000-000000000001",
      resultId: "20000000-0000-4000-8000-000000000001",
      commandId: "30000000-0000-4000-8000-000000000001",
      idempotencyKey: "plan/alpha",
    };
    const second = {
      profileId: "beta",
      profileVersion: 1,
      runId: "10000000-0000-4000-8000-000000000002",
      resultId: "20000000-0000-4000-8000-000000000002",
      commandId: "30000000-0000-4000-8000-000000000002",
      idempotencyKey: "plan/beta",
    };
    const violations: readonly unknown[] = [
      [second, first],
      [first, { ...second, profileId: first.profileId }],
      [first, { ...second, runId: first.runId }],
      [first, { ...second, resultId: first.resultId }],
      [first, { ...second, commandId: first.commandId }],
      [first, { ...second, idempotencyKey: first.idempotencyKey }],
      [{ ...first, extra: true }],
      [{ ...first, profileVersion: 0 }],
      [{ ...first, idempotencyKey: "x".repeat(262_145) }],
    ];

    const valid = schema3Connection();
    seedStrictLegacyCancelledHistory(valid, 2, {
      validation_attempt_plan_generation: 1,
      validation_attempt_plans_json: canonicalJson([first, second]),
    });
    const validBefore = snapshotDatabase(valid);
    new SqliteSessionEndEffectiveStateMigrationPreflight()
      .assertEligible(valid, context);
    assert.equal(snapshotDatabase(valid), validBefore);

    for (const plans of violations) {
      const connection = schema3Connection();
      seedStrictLegacyCancelledHistory(connection, 2, {
        validation_attempt_plan_generation: 1,
        validation_attempt_plans_json: canonicalJson(plans),
      });
      const before = snapshotDatabase(connection);
      assert.throws(
        () => new SqliteSessionEndEffectiveStateMigrationPreflight()
          .assertEligible(connection, context),
        hasCode("MIGRATION_SESSION_END_EFFECTIVE_STATE_PRECONDITION_FAILED"),
      );
      assert.equal(snapshotDatabase(connection), before);
    }
  });

  it("accepts exactly 1000 and rejects 1001 lifetime child and ticket rows", () => {
    const accepted = schema3Connection();
    seedHistoryRows(accepted, 1_000, 1_000);
    new SqliteSessionEndEffectiveStateMigrationPreflight()
      .assertEligible(accepted, context);

    for (const [directChildren, sourceTickets] of [
      [1_001, 1_000],
      [1_000, 1_001],
    ] as const) {
      const rejected = schema3Connection();
      seedHistoryRows(rejected, directChildren, sourceTickets);
      const before = snapshotDatabase(rejected);
      assert.throws(
        () => new SqliteSessionEndEffectiveStateMigrationPreflight()
          .assertEligible(rejected, context),
        hasCode("MIGRATION_SESSION_END_EFFECTIVE_STATE_PRECONDITION_FAILED"),
      );
      assert.equal(snapshotDatabase(rejected), before);
    }
  });

  it("rejects duplicate and invalid legacy transfer-ticket lineage", () => {
    const duplicate = schema3Connection();
    seedHistoryRows(duplicate, 2, 2);
    duplicate.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TRIGGER child_transfer_tickets_update_guard;
      UPDATE child_transfer_tickets
      SET source_child_session_id = '${historyUuid("a", 1)}'
      WHERE transfer_ticket_id = '${historyUuid("b", 2)}';
      PRAGMA foreign_keys = ON;
    `);
    assert.throws(
      () => new SqliteSessionEndEffectiveStateMigrationPreflight()
        .assertEligible(duplicate, context),
      hasCode("MIGRATION_SESSION_END_EFFECTIVE_STATE_PRECONDITION_FAILED"),
    );

    const invalid = schema3Connection();
    seedHistoryRows(invalid, 1, 1);
    invalid.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TRIGGER child_transfer_tickets_update_guard;
      UPDATE child_transfer_tickets
      SET source_child_session_id = '${historyUuid("d", 1)}';
      PRAGMA foreign_keys = ON;
    `);
    assert.throws(
      () => new SqliteSessionEndEffectiveStateMigrationPreflight()
        .assertEligible(invalid, context),
      hasCode("MIGRATION_SESSION_END_EFFECTIVE_STATE_PRECONDITION_FAILED"),
    );
  });

  it("measures schema-4 effective snapshots by exact UTF-8 bytes", () => {
    const exact = schema4Connection();
    assert.throws(
      () => insertRawV3Request(exact, {
        workflowId: WORKFLOW_ID,
        workflowGeneration: 1,
        previousState: "active",
        effectiveState: rawSnapshotAtBytes(1_048_576),
      }),
      /SESSION_END_EVENT_V3_INVALID/,
    );

    const over = schema4Connection();
    assert.throws(
      () => insertRawV3Request(over, {
        workflowId: WORKFLOW_ID,
        workflowGeneration: 1,
        previousState: "active",
        effectiveState: rawSnapshotAtBytes(1_048_577),
      }),
      /SESSION_END_EFFECTIVE_STATE_SIZE_INVALID/,
    );
  });

  it("rolls schema 1 2 and 3 back when migration-4 preflight fails", () => {
    for (const sourceVersion of [1, 2, 3] as const) {
      const connection = sourceConnection(sourceVersion);
      const before = snapshotDatabase(connection);
      const sqliteAbort = Object.assign(
        new Error("MIGRATION_SESSION_END_EFFECTIVE_STATE_PRECONDITION_FAILED"),
        { code: "ERR_SQLITE_ERROR", errcode: 1811 },
      );

      assert.throws(
        () => new MigrationRunner().apply(connection, [
          eventCoreMigration,
          sessionLifecycleMigration,
          qualifiedCheckpointCoverageMigration,
          sessionEndEffectiveStateMigration,
        ], NOW, {
          kind: "explicit-upgrade",
          expectedAppliedVersion: sourceVersion,
          beforeMigration(migrationConnection, migration): void {
            if (migration.version === 3) {
              new SqliteQualifiedCheckpointMigrationPreflight()
                .assertEligibleAndStage(migrationConnection, context);
            }
            if (migration.version === 4) throw sqliteAbort;
          },
        }),
        (error: unknown) => error instanceof SchemaCompatibilityError
          && error.code === "MIGRATION_SESSION_END_EFFECTIVE_STATE_PRECONDITION_FAILED",
      );
      assert.equal(snapshotDatabase(connection), before);
    }
  });

  it("runs every generic migration-4 fault boundary", () => {
    for (const boundary of [
      "after-ddl-before-migration-row",
      "after-migration-row-before-project-version",
      "after-project-version-before-commit",
    ] as const) {
      const connection = sourceConnection(3);
      const before = snapshotDatabase(connection);
      const injected = new Error(`INJECTED:${boundary}`);

      assert.throws(
        () => new MigrationRunner().apply(connection, [
          eventCoreMigration,
          sessionLifecycleMigration,
          qualifiedCheckpointCoverageMigration,
          sessionEndEffectiveStateMigration,
        ], NOW, {
          kind: "explicit-upgrade",
          expectedAppliedVersion: 3,
          beforeMigration(migrationConnection, migration): void {
            if (migration.version === 4) {
              new SqliteSessionEndEffectiveStateMigrationPreflight()
                .assertEligible(migrationConnection, context);
            }
          },
          faultInjector: {
            hit(observed, migration): void {
              if (migration.version === 4 && observed === boundary) throw injected;
            },
          },
        }),
        (error: unknown) => error === injected,
      );
      assert.equal(snapshotDatabase(connection), before);
    }
  });

  it("blocks hostile raw SQL from schema-4 lifecycle guards", () => {
    const connection = schema4Connection();
    rawInsert(connection, "workflow_instances", workflowValues("cancelled"));
    const duplicatedRunPlans = canonicalJson([{
      profileId: "alpha",
      profileVersion: 1,
      runId: "10000000-0000-4000-8000-000000000001",
      resultId: "20000000-0000-4000-8000-000000000001",
      commandId: "30000000-0000-4000-8000-000000000001",
      idempotencyKey: "plan/alpha",
    }, {
      profileId: "beta",
      profileVersion: 1,
      runId: "10000000-0000-4000-8000-000000000001",
      resultId: "20000000-0000-4000-8000-000000000002",
      commandId: "30000000-0000-4000-8000-000000000002",
      idempotencyKey: "plan/beta",
    }]);

    assert.throws(
      () => connection.prepare(`
        UPDATE workflow_instances
        SET validation_attempt_plan_generation = 1,
            validation_attempt_plans_json = $plans
        WHERE project_id = $projectId AND workflow_id = $workflowId
      `).run({
        $plans: duplicatedRunPlans,
        $projectId: PROJECT_ID,
        $workflowId: WORKFLOW_ID,
      }),
      /WORKFLOW_VALIDATION_PLAN_V4_INVALID/,
    );
    assert.equal(
      connection.prepare(`
        SELECT validation_attempt_plans_json AS plans
        FROM workflow_instances
        WHERE project_id = $projectId AND workflow_id = $workflowId
      `).get({ $projectId: PROJECT_ID, $workflowId: WORKFLOW_ID })?.plans,
      null,
    );
  });

  it("enforces canonical validation-plan identities at schema 4", () => {
    const validPlan = {
      profileId: "alpha",
      profileVersion: 1,
      runId: "10000000-0000-4000-8000-000000000001",
      resultId: "20000000-0000-4000-8000-000000000001",
      commandId: "30000000-0000-4000-8000-000000000001",
      idempotencyKey: "plan/alpha",
    } as const;
    const persistPlan = (
      connection: SqliteConnection,
      plan: Readonly<Record<string, unknown>>,
    ): void => {
      rawInsert(connection, "workflow_instances", workflowValues("cancelled"));
      connection.prepare(`
        UPDATE workflow_instances
        SET validation_attempt_plan_generation = 1,
            validation_attempt_plans_json = $plans
        WHERE project_id = $projectId AND workflow_id = $workflowId
      `).run({
        $plans: canonicalJson([plan]),
        $projectId: PROJECT_ID,
        $workflowId: WORKFLOW_ID,
      });
    };

    const valid = schema4Connection();
    persistPlan(valid, validPlan);
    assert.equal(
      valid.prepare(`
        SELECT validation_attempt_plans_json AS plans
        FROM workflow_instances
        WHERE project_id = $projectId AND workflow_id = $workflowId
      `).get({ $projectId: PROJECT_ID, $workflowId: WORKFLOW_ID })?.plans,
      canonicalJson([validPlan]),
    );

    for (const invalidPlan of [
      { ...validPlan, profileId: "" },
      { ...validPlan, runId: "not-a-canonical-uuid" },
      { ...validPlan, resultId: "not-a-canonical-uuid" },
      { ...validPlan, commandId: "not-a-canonical-uuid" },
      { ...validPlan, idempotencyKey: "" },
    ]) {
      const hostile = schema4Connection();
      assert.throws(
        () => persistPlan(hostile, invalidPlan),
        /WORKFLOW_VALIDATION_PLAN_V4_INVALID/,
      );
      assert.equal(
        hostile.prepare(`SELECT count(*) AS count FROM workflow_instances`)
          .get()?.count,
        1n,
      );
      assert.equal(
        hostile.prepare(`
          SELECT validation_attempt_plans_json AS plans
          FROM workflow_instances
        `).get()?.plans,
        null,
      );
    }
  });

  it("dispatches legacy and schema-2 workflow fold structure", () => {
    const connection = schema4Connection();
    seedLegacyRequestThenV3Cancellation(connection);

    rawInsert(connection, "lifecycle_workflow_generation_folds", {
      project_id: PROJECT_ID,
      workflow_id: WORKFLOW_ID,
      workflow_generation: 2,
      session_id: ROOT_ID,
      trigger_event_position: 3,
      root_command_id: "22222222-eeee-4eee-8eee-eeeeeeeeeeee",
      evidence_window_state: "sealed",
      replacement_checkpoint_version: null,
      effective_checkpoint_version: 1,
      effective_draft_source_event_position: 1,
      previous_fingerprint: H64,
      fingerprint: "b".repeat(64),
      fingerprint_schema_version: 2,
      effective_state_source_event_position: null,
      effective_state_version: null,
      effective_state_hash: null,
    });

    assert.deepEqual(connection.prepare(`
      SELECT workflow_generation, fingerprint_schema_version,
             effective_state_source_event_position, effective_state_version,
             effective_state_hash
      FROM lifecycle_workflow_generation_folds
      ORDER BY workflow_generation
    `).all().map((row) => ({ ...row })), [{
      workflow_generation: 1n,
      fingerprint_schema_version: 1n,
      effective_state_source_event_position: null,
      effective_state_version: null,
      effective_state_hash: null,
    }, {
      workflow_generation: 2n,
      fingerprint_schema_version: 2n,
      effective_state_source_event_position: null,
      effective_state_version: null,
      effective_state_hash: null,
    }]);
  });

  it("dispatches cancelled reopen evidence state by request version", () => {
    const reopen = (
      connection: SqliteConnection,
      requestVersion: 1 | 2,
      evidenceWindowState: "open" | "sealed",
    ): void => {
      seedStrictLegacyCancelledHistory(connection);
      const commandId = appendV3ReopenRequest(connection, requestVersion);
      connection.prepare(`
        UPDATE workflow_instances
        SET generation = 2,
            phase = 'requested',
            root_command_id = $rootCommandId,
            triggering_event_position = 3,
            evidence_window_state = $evidenceWindowState,
            updated_at = $updatedAt
        WHERE project_id = $projectId AND workflow_id = $workflowId
      `).run({
        $rootCommandId: commandId,
        $evidenceWindowState: evidenceWindowState,
        $updatedAt: NOW,
        $projectId: PROJECT_ID,
        $workflowId: WORKFLOW_ID,
      });
    };

    const legacy = schema4Connection();
    reopen(legacy, 1, "sealed");
    assert.equal(
      legacy.prepare(`SELECT evidence_window_state AS state FROM workflow_instances`)
        .get()?.state,
      "sealed",
    );

    const current = schema4Connection();
    reopen(current, 2, "open");
    assert.equal(
      current.prepare(`SELECT evidence_window_state AS state FROM workflow_instances`)
        .get()?.state,
      "open",
    );

    const hostile = schema4Connection();
    assert.throws(
      () => reopen(hostile, 2, "sealed"),
      /WORKFLOW_EVIDENCE_STATE_INVALID/,
    );
  });

  it("binds V3 requests to event-zero intent and durable root state", () => {
    type MutableIntent = {
      intent: {
        command: Record<string, unknown>;
        binding: Record<string, unknown>;
        authorization: Record<string, unknown>;
      };
      persistedAssertions: Record<string, unknown>;
    };
    const fixture = v3ReopenRequestFixture(2);
    const mutateIntent = (
      mutation: (intent: MutableIntent) => void,
    ): Readonly<Record<string, unknown>> => {
      const intent = structuredClone(fixture.lifecycleIntent) as MutableIntent;
      mutation(intent);
      return intent as unknown as Readonly<Record<string, unknown>>;
    };

    const valid = schema4Connection();
    seedStrictLegacyCancelledHistory(valid);
    appendV3ReopenRequest(valid, 2);
    assert.equal(
      valid.prepare(`
        SELECT count(*) AS count FROM events
        WHERE event_type = 'SessionEndRequested' AND event_schema_version = 3
      `).get()?.count,
      1n,
    );

    const hostiles: readonly {
      readonly name: string;
      readonly overrides: Parameters<typeof appendV3ReopenRequest>[2];
    }[] = [
      { name: "missing event-zero intent", overrides: { omitLifecycleIntent: true } },
      {
        name: "wrong command type",
        overrides: {
          lifecycleIntent: mutateIntent((intent) => {
            intent.intent.command.commandType = "cancel-session-end";
          }),
        },
      },
      {
        name: "wrong command id",
        overrides: {
          lifecycleIntent: mutateIntent((intent) => {
            intent.intent.command.commandId = "99999999-9999-4999-8999-999999999999";
          }),
        },
      },
      {
        name: "wrong idempotency key",
        overrides: {
          lifecycleIntent: mutateIntent((intent) => {
            intent.intent.command.idempotencyKey = "wrong/idempotency";
          }),
        },
      },
      {
        name: "wrong agent",
        overrides: {
          lifecycleIntent: mutateIntent((intent) => {
            intent.intent.command.agentId = "different-agent";
          }),
        },
      },
      {
        name: "wrong project context",
        overrides: {
          lifecycleIntent: mutateIntent((intent) => {
            intent.intent.command.expectedProjectId = VAULT_ID;
          }),
        },
      },
      {
        name: "wrong presenting identity",
        overrides: {
          lifecycleIntent: mutateIntent((intent) => {
            intent.intent.authorization.presentingClientInstanceId = "other-client";
            intent.persistedAssertions.presentingClientInstanceId = "other-client";
          }),
        },
      },
      {
        name: "request snapshot differs from intent",
        overrides: {
          lifecycleIntent: mutateIntent((intent) => {
            intent.intent.command.request = sessionEndEffectiveStateFixture({
              requestVersion: 1,
            }).request;
          }),
        },
      },
      {
        name: "generation skips durable cancelled predecessor",
        overrides: {
          payload: { ...fixture.payload, workflowGeneration: 3 },
        },
      },
      {
        name: "previous state differs from root authority",
        overrides: {
          payload: { ...fixture.payload, previousState: "suspended" },
        },
      },
    ];

    for (const hostile of hostiles) {
      const connection = schema4Connection();
      seedStrictLegacyCancelledHistory(connection);
      assert.throws(
        () => appendV3ReopenRequest(connection, 2, hostile.overrides),
        /SESSION_END_EVENT_V3_INVALID/,
        hostile.name,
      );
      assert.equal(
        connection.prepare(`
          SELECT count(*) AS count FROM events
          WHERE event_type = 'SessionEndRequested' AND event_schema_version = 3
        `).get()?.count,
        0n,
        hostile.name,
      );
    }
  });

  it("admits a production-builder-valid V3 RequestSessionEnd witness", () => {
    const valid = schema4Connection();
    seedStrictLegacyCancelledHistory(valid);
    appendV3ReopenRequest(valid, 2);
    assert.equal(
      valid.prepare(`
        SELECT count(*) AS count FROM events WHERE global_position = 3
      `).get()?.count,
      1n,
    );
    assert.equal(
      valid.prepare(`
        SELECT current_version AS currentVersion FROM streams
        WHERE project_id = $projectId AND stream_id = $streamId
      `).get({
        $projectId: PROJECT_ID,
        $streamId: `session/${ROOT_ID}`,
      })?.currentVersion,
      3n,
    );
  });

  it("rejects V3 RequestSessionEnd when the durable stream head is not its predecessor", () => {
    const hostile = schema4Connection();
    seedStrictLegacyCancelledHistory(hostile);
    assert.throws(
      () => appendV3ReopenRequest(hostile, 2, { streamHead: 1 }),
      /SESSION_END_EVENT_V3_INVALID/,
    );
    assert.equal(
      hostile.prepare(`
        SELECT count(*) AS count FROM events WHERE global_position = 3
      `).get()?.count,
      0n,
    );
    assert.equal(
      hostile.prepare(`
        SELECT current_version AS currentVersion FROM streams
        WHERE project_id = $projectId AND stream_id = $streamId
      `).get({
        $projectId: PROJECT_ID,
        $streamId: `session/${ROOT_ID}`,
      })?.currentVersion,
      1n,
    );
  });

  it("binds V3 amendments and cancellations to durable predecessor state", () => {
    const effectiveState = sessionEndEffectiveStateFixture({ requestVersion: 2 });
    const appendMutation = (
      connection: SqliteConnection,
      eventType: "SessionEndAmended" | "SessionEndCancelled",
      overrides: {
        readonly payload?: Readonly<Record<string, unknown>>;
        readonly lifecycleIntent?: Readonly<Record<string, unknown>>;
        readonly omitLifecycleIntent?: boolean;
      } = {},
    ): void => {
      const checkpointId = "44444444-cccc-4ccc-8ccc-cccccccccccc";
      const commandId = eventType === "SessionEndAmended"
        ? "55555555-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        : "55555555-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const amendment = {
        amendmentVersion: 2,
        childEndPolicy: null,
        finalCheckpoint: effectiveState.effectiveFinalCheckpoint,
        validationProfileIds: null,
        requestedQualityThreshold: null,
        requireFullEvidence: null,
        requireMaterialization: null,
        evidenceWindowAction: "open",
      } as const;
      const payload = eventType === "SessionEndAmended"
        ? {
            workflowId: WORKFLOW_ID,
            previousWorkflowGeneration: 1,
            workflowGeneration: 2,
            preTransitionCheckpointId: checkpointId,
            evidenceWindowAction: "open",
            effectiveState,
          }
        : {
            cancellationVersion: 1,
            workflowId: WORKFLOW_ID,
            previousWorkflowGeneration: 1,
            workflowGeneration: 2,
            restoredState: "active",
            preTransitionCheckpointId: checkpointId,
          };
      const lifecycleIntent = eventType === "SessionEndAmended"
        ? protectedLifecycleIntent({
            commandType: "amend-session-end",
            commandId,
            idempotencyKey: `raw/${commandId}`,
            expectedProjectId: PROJECT_ID,
            expectedVaultId: VAULT_ID,
            expectedWorkspaceId: H64,
            sessionId: ROOT_ID,
            workflowId: WORKFLOW_ID,
            expectedStreamVersion: "2",
            amendment,
          })
        : protectedLifecycleIntent({
            commandType: "cancel-session-end",
            commandId,
            idempotencyKey: `raw/${commandId}`,
            expectedProjectId: PROJECT_ID,
            expectedVaultId: VAULT_ID,
            expectedWorkspaceId: H64,
            sessionId: ROOT_ID,
            workflowId: WORKFLOW_ID,
            expectedStreamVersion: "2",
            preTransitionCheckpointId: checkpointId,
          });
      rawInsert(connection, "events", rawSessionEventValues({
        globalPosition: 3,
        streamVersion: 3,
        eventType,
        eventSchemaVersion: 3,
        sessionId: ROOT_ID,
        parentSessionId: null,
        commandId,
        payload: overrides.payload ?? payload,
        ...(overrides.omitLifecycleIntent
          ? {}
          : { lifecycleIntent: overrides.lifecycleIntent ?? lifecycleIntent }),
      }));
    };

    for (const eventType of [
      "SessionEndAmended",
      "SessionEndCancelled",
    ] as const) {
      const valid = schema4Connection();
      seedV3WorkflowMutationPredecessor(valid);
      appendMutation(valid, eventType);
      assert.equal(
        valid.prepare(`SELECT count(*) AS count FROM events WHERE event_type = $type`)
          .get({ $type: eventType })?.count,
        1n,
      );
    }

    const hostileCheckpointId = "66666666-cccc-4ccc-8ccc-cccccccccccc";
    const amendedCommandId = "55555555-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const cancelledCommandId = "55555555-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const hostiles = [
      {
        name: "amendment missing event-zero intent",
        eventType: "SessionEndAmended" as const,
        overrides: { omitLifecycleIntent: true },
      },
      {
        name: "amendment command type mismatch",
        eventType: "SessionEndAmended" as const,
        overrides: {
          lifecycleIntent: protectedLifecycleIntent({
            commandType: "cancel-session-end",
            commandId: amendedCommandId,
            idempotencyKey: `raw/${amendedCommandId}`,
            expectedProjectId: PROJECT_ID,
            expectedVaultId: VAULT_ID,
            expectedWorkspaceId: H64,
            sessionId: ROOT_ID,
            workflowId: WORKFLOW_ID,
            expectedStreamVersion: "2",
            preTransitionCheckpointId: "44444444-cccc-4ccc-8ccc-cccccccccccc",
          }),
        },
      },
      {
        name: "amendment skips predecessor generation",
        eventType: "SessionEndAmended" as const,
        overrides: {
          payload: {
            workflowId: WORKFLOW_ID,
            previousWorkflowGeneration: 2,
            workflowGeneration: 3,
            preTransitionCheckpointId: "44444444-cccc-4ccc-8ccc-cccccccccccc",
            evidenceWindowAction: "open",
            effectiveState,
          },
        },
      },
      {
        name: "amendment checkpoint differs from authority",
        eventType: "SessionEndAmended" as const,
        overrides: {
          payload: {
            workflowId: WORKFLOW_ID,
            previousWorkflowGeneration: 1,
            workflowGeneration: 2,
            preTransitionCheckpointId: hostileCheckpointId,
            evidenceWindowAction: "open",
            effectiveState,
          },
        },
      },
      {
        name: "amendment action differs from intent",
        eventType: "SessionEndAmended" as const,
        overrides: {
          payload: {
            workflowId: WORKFLOW_ID,
            previousWorkflowGeneration: 1,
            workflowGeneration: 2,
            preTransitionCheckpointId: "44444444-cccc-4ccc-8ccc-cccccccccccc",
            evidenceWindowAction: "unchanged",
            effectiveState,
          },
        },
      },
      {
        name: "cancellation missing event-zero intent",
        eventType: "SessionEndCancelled" as const,
        overrides: { omitLifecycleIntent: true },
      },
      {
        name: "cancellation skips predecessor generation",
        eventType: "SessionEndCancelled" as const,
        overrides: {
          payload: {
            cancellationVersion: 1,
            workflowId: WORKFLOW_ID,
            previousWorkflowGeneration: 2,
            workflowGeneration: 3,
            restoredState: "active",
            preTransitionCheckpointId: "44444444-cccc-4ccc-8ccc-cccccccccccc",
          },
        },
      },
      {
        name: "cancellation checkpoint differs from authority",
        eventType: "SessionEndCancelled" as const,
        overrides: {
          payload: {
            cancellationVersion: 1,
            workflowId: WORKFLOW_ID,
            previousWorkflowGeneration: 1,
            workflowGeneration: 2,
            restoredState: "active",
            preTransitionCheckpointId: hostileCheckpointId,
          },
          lifecycleIntent: protectedLifecycleIntent({
            commandType: "cancel-session-end",
            commandId: cancelledCommandId,
            idempotencyKey: `raw/${cancelledCommandId}`,
            expectedProjectId: PROJECT_ID,
            expectedVaultId: VAULT_ID,
            expectedWorkspaceId: H64,
            sessionId: ROOT_ID,
            workflowId: WORKFLOW_ID,
            expectedStreamVersion: "2",
            preTransitionCheckpointId: hostileCheckpointId,
          }),
        },
      },
      {
        name: "cancellation restored state differs from workflow",
        eventType: "SessionEndCancelled" as const,
        overrides: {
          payload: {
            cancellationVersion: 1,
            workflowId: WORKFLOW_ID,
            previousWorkflowGeneration: 1,
            workflowGeneration: 2,
            restoredState: "suspended",
            preTransitionCheckpointId: "44444444-cccc-4ccc-8ccc-cccccccccccc",
          },
        },
      },
    ] as const;

    for (const hostile of hostiles) {
      const connection = schema4Connection();
      seedV3WorkflowMutationPredecessor(connection);
      assert.throws(
        () => appendMutation(connection, hostile.eventType, hostile.overrides),
        /SESSION_END_EVENT_V3_INVALID/,
        hostile.name,
      );
      assert.equal(
        connection.prepare(`SELECT count(*) AS count FROM events WHERE global_position = 3`)
          .get()?.count,
        0n,
        hostile.name,
      );
    }
  });

  it("rejects explicit null for every required V3 scalar", () => {
    type MutableJsonObject = Record<string, unknown>;
    type RequestMutationTarget = {
      readonly effectiveState: MutableJsonObject;
      readonly request: MutableJsonObject;
      readonly effectivePolicy: MutableJsonObject;
    };
    const asObject = (value: unknown): MutableJsonObject => {
      assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
      return value as MutableJsonObject;
    };
    const requestFixture = v3ReopenRequestFixture(2);
    const mutatedRequest = (
      mutation: (target: RequestMutationTarget) => void,
    ): Parameters<typeof appendV3ReopenRequest>[2] => {
      const payload = structuredClone(requestFixture.payload) as MutableJsonObject;
      const effectiveState = asObject(payload.effectiveState);
      const request = asObject(effectiveState.request);
      const effectivePolicy = asObject(effectiveState.effectivePolicy);
      mutation({ effectiveState, request, effectivePolicy });
      const lifecycleIntent = structuredClone(
        requestFixture.lifecycleIntent,
      ) as MutableJsonObject;
      const command = asObject(asObject(lifecycleIntent.intent).command);
      command.request = structuredClone(request);
      return { payload, lifecycleIntent };
    };

    const validRequest = schema4Connection();
    seedStrictLegacyCancelledHistory(validRequest);
    appendV3ReopenRequest(validRequest, 2);
    assert.equal(
      validRequest.prepare(`
        SELECT count(*) AS count FROM events WHERE global_position = 3
      `).get()?.count,
      1n,
    );

    const validCancellation = schema4Connection();
    seedLegacyRequestThenV3Cancellation(validCancellation);
    assert.equal(
      validCancellation.prepare(`
        SELECT count(*) AS count FROM events WHERE global_position = 3
      `).get()?.count,
      1n,
    );

    const requestHostiles = [
      {
        name: "null effective state version",
        overrides: mutatedRequest(({ effectiveState }) => {
          effectiveState.effectiveStateVersion = null;
        }),
      },
      {
        name: "null effective state domain",
        overrides: mutatedRequest(({ effectiveState }) => {
          effectiveState.effectiveStateDomain = null;
        }),
      },
      {
        name: "null child end policy",
        overrides: mutatedRequest(({ request }) => {
          request.childEndPolicy = null;
        }),
      },
      {
        name: "null quality policy version",
        overrides: mutatedRequest(({ effectivePolicy }) => {
          effectivePolicy.qualityPolicyVersion = null;
        }),
      },
    ] as const;

    for (const hostile of requestHostiles) {
      const connection = schema4Connection();
      seedStrictLegacyCancelledHistory(connection);
      assert.throws(
        () => appendV3ReopenRequest(connection, 2, hostile.overrides),
        /SESSION_END_EVENT_V3_INVALID/,
        hostile.name,
      );
      assert.equal(
        connection.prepare(`
          SELECT count(*) AS count FROM events WHERE global_position = 3
        `).get()?.count,
        0n,
        hostile.name,
      );
    }

    const nullCancellationVersion = schema4Connection();
    assert.throws(
      () => seedLegacyRequestThenV3Cancellation(nullCancellationVersion, {
        cancellationVersion: null,
      }),
      /SESSION_END_EVENT_V3_INVALID/,
    );
    assert.equal(
      nullCancellationVersion.prepare(`
        SELECT count(*) AS count FROM events WHERE global_position = 3
      `).get()?.count,
      0n,
    );
  });

  it("makes nested schema-4 JSON guards missing-key and duplicate-key total", () => {
    const effectiveState = sessionEndEffectiveStateFixture({ requestVersion: 2 });
    const requestFixture = v3ReopenRequestFixture(2);
    const insertRequestPayload = (
      connection: SqliteConnection,
      payloadJson: string,
    ): void => {
      seedStrictLegacyCancelledHistory(connection);
      connection.prepare(`
        UPDATE streams
        SET current_version = 2, updated_at = $updatedAt
        WHERE project_id = $projectId AND stream_id = $streamId
      `).run({
        $updatedAt: NOW,
        $projectId: PROJECT_ID,
        $streamId: `session/${ROOT_ID}`,
      });
      rawInsert(connection, "events", {
        ...rawSessionEventValues({
          globalPosition: 3,
          streamVersion: 3,
          eventType: "SessionEndRequested",
          eventSchemaVersion: 3,
          sessionId: ROOT_ID,
          parentSessionId: null,
          commandId: requestFixture.commandId,
          payload: requestFixture.payload,
          lifecycleIntent: requestFixture.lifecycleIntent,
        }),
        payload_json: payloadJson,
      });
      connection.prepare(`
        UPDATE streams
        SET current_version = 3, updated_at = $updatedAt
        WHERE project_id = $projectId AND stream_id = $streamId
      `).run({
        $updatedAt: NOW,
        $projectId: PROJECT_ID,
        $streamId: `session/${ROOT_ID}`,
      });
    };

    const validRequest = schema4Connection();
    insertRequestPayload(validRequest, canonicalJson(requestFixture.payload));

    const missingPolicyKey = schema4Connection();
    assert.throws(
      () => insertRequestPayload(missingPolicyKey, canonicalJson({
        ...requestFixture.payload,
        effectiveState: {
          ...effectiveState,
          effectivePolicy: {},
        },
      })),
      /SESSION_END_EVENT_V3_INVALID/,
    );

    const canonicalPayload = canonicalJson(requestFixture.payload);
    const canonicalPolicy = canonicalJson(effectiveState.effectivePolicy);
    const duplicatedPolicy = canonicalPolicy.replace(
      /\}$/u,
      ',"qualityPolicyVersion":1}',
    );
    assert.notEqual(duplicatedPolicy, canonicalPolicy);
    const duplicatePolicyKey = schema4Connection();
    assert.throws(
      () => insertRequestPayload(
        duplicatePolicyKey,
        canonicalPayload.replace(canonicalPolicy, duplicatedPolicy),
      ),
      /SESSION_END_EVENT_V3_INVALID/,
    );

    const transfer = schema4Connection();
    seedSuspendedChildTransferSource(transfer);
    const transferPayload = canonicalJson({
      transferTicketId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      suspensionCheckpointId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      checkpointId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      authorityCommitment: H64,
    });
    const duplicateTransferPayload = transferPayload.replace(
      `"authorityCommitment":"${H64}"`,
      '"checkpointId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"',
    );
    assert.throws(
      () => rawInsert(transfer, "events", {
        ...rawSessionEventValues({
          globalPosition: 3,
          streamVersion: 3,
          eventType: "ChildWorkTransferCreated",
          eventSchemaVersion: 2,
          sessionId: CHILD_ID,
          parentSessionId: ROOT_ID,
          commandId: "88888888-8888-4888-8888-888888888888",
          payload: {},
          lifecycleIntent: internalCarryForwardIntent({
            suspensionEventPosition: "1",
            checkpointId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            checkpointEventPosition: "2",
          }),
        }),
        payload_json: duplicateTransferPayload,
      }),
      /CHILD_WORK_TRANSFER_V2_INVALID/,
    );

    const outbox = schema4Connection();
    seedDirectAbandonedEvent(outbox);
    const outboxValues = lifecycleOutboxValues();
    const outboxPayload = String(outboxValues.payload_json);
    const duplicateOutboxPayload = outboxPayload.replace(
      '"payloadVersion":1',
      `"sessionId":"${ROOT_ID}"`,
    );
    assert.throws(
      () => rawInsert(outbox, "outbox", {
        ...outboxValues,
        payload_json: duplicateOutboxPayload,
      }),
      /OUTBOX_LIFECYCLE_DESCRIPTOR_V4_INVALID/,
    );
  });

  it("admits only internal transfer V2 with exact dual-checkpoint lineage", () => {
    const publicRoute = schema4Connection();
    seedSuspendedChildTransferSource(publicRoute);
    assert.throws(
      () => rawInsert(publicRoute, "events", rawSessionEventValues({
        globalPosition: 3,
        streamVersion: 3,
        eventType: "ChildWorkTransferCreated",
        eventSchemaVersion: 2,
        sessionId: CHILD_ID,
        parentSessionId: ROOT_ID,
        commandId: "88888888-8888-4888-8888-888888888888",
        payload: {
          transferTicketId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          suspensionCheckpointId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          checkpointId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          authorityCommitment: H64,
        },
      })),
      /CHILD_WORK_TRANSFER_V2_INVALID/,
    );
    assert.equal(
      publicRoute.prepare("SELECT count(*) AS count FROM events").get()?.count,
      2n,
    );

    const malformed = schema4Connection();
    seedSuspendedChildTransferSource(malformed);
    assert.throws(
      () => rawInsert(malformed, "events", rawSessionEventValues({
        globalPosition: 3,
        streamVersion: 3,
        eventType: "ChildWorkTransferCreated",
        eventSchemaVersion: 2,
        sessionId: CHILD_ID,
        parentSessionId: ROOT_ID,
        commandId: "88888888-8888-4888-8888-888888888888",
        lifecycleIntent: internalCarryForwardIntent({
          suspensionEventPosition: "1",
          checkpointId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          checkpointEventPosition: "2",
        }),
        payload: {
          transferTicketId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          suspensionCheckpointId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          checkpointId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          authorityCommitment: H64,
        },
      })),
      /CHILD_WORK_TRANSFER_V2_INVALID/,
    );
    assert.equal(
      malformed.prepare("SELECT count(*) AS count FROM events").get()?.count,
      2n,
    );

    const internalRoute = schema4Connection();
    seedSuspendedChildTransferSource(internalRoute);
    rawInsert(internalRoute, "events", rawSessionEventValues({
      globalPosition: 3,
      streamVersion: 3,
      eventType: "ChildWorkTransferCreated",
      eventSchemaVersion: 2,
      sessionId: CHILD_ID,
      parentSessionId: ROOT_ID,
      commandId: "88888888-8888-4888-8888-888888888888",
      lifecycleIntent: internalCarryForwardIntent({
        suspensionEventPosition: "1",
        checkpointId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        checkpointEventPosition: "2",
      }),
      payload: {
        transferTicketId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        suspensionCheckpointId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        checkpointId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        authorityCommitment: H64,
      },
    }));
    assert.equal(
      internalRoute.prepare("SELECT count(*) AS count FROM events").get()?.count,
      3n,
    );
  });

  it("binds internal V2 transfers to workflow and exact stream arithmetic", () => {
    const appendActiveTransfer = (
      connection: SqliteConnection,
      childState: "active" | "completion-proposed",
      intentOverrides: Partial<Parameters<typeof internalCarryForwardIntent>[0]> = {},
    ): void => {
      const intent = internalCarryForwardIntent({
        suspensionEventPosition: null,
        checkpointId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        checkpointEventPosition: "1",
        expectedChildState: childState,
        expectedChildHeadEventPosition: "1",
        expectedChildStreamVersion: "1",
        ...intentOverrides,
      });
      rawInsert(connection, "events", rawSessionEventValues({
        globalPosition: 2,
        streamVersion: 2,
        eventType: "ChildSessionSuspended",
        eventSchemaVersion: 1,
        sessionId: CHILD_ID,
        parentSessionId: ROOT_ID,
        commandId: "88888888-8888-4888-8888-888888888888",
        commandEventIndex: 0,
        payload: {
          checkpointId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          blockers: [],
          followUps: [],
          authorityCommitment: H64,
        },
        lifecycleIntent: intent,
      }));
      rawInsert(connection, "events", rawSessionEventValues({
        globalPosition: 3,
        streamVersion: 3,
        eventType: "ChildWorkTransferCreated",
        eventSchemaVersion: 2,
        sessionId: CHILD_ID,
        parentSessionId: ROOT_ID,
        commandId: "88888888-8888-4888-8888-888888888888",
        commandEventIndex: 1,
        payload: {
          transferTicketId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          suspensionCheckpointId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          checkpointId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          authorityCommitment: H64,
        },
      }));
    };

    for (const childState of ["active", "completion-proposed"] as const) {
      const valid = schema4Connection();
      seedActiveChildTransferSource(valid, childState);
      appendActiveTransfer(valid, childState);
      assert.equal(
        valid.prepare(`
          SELECT count(*) AS count FROM events
          WHERE command_id = '88888888-8888-4888-8888-888888888888'
        `).get()?.count,
        2n,
      );
    }

    const mismatchedAuthority = schema4Connection();
    seedSuspendedChildTransferSource(mismatchedAuthority);
    assert.throws(
      () => rawInsert(mismatchedAuthority, "events", rawSessionEventValues({
        globalPosition: 3,
        streamVersion: 3,
        eventType: "ChildWorkTransferCreated",
        eventSchemaVersion: 2,
        sessionId: CHILD_ID,
        parentSessionId: ROOT_ID,
        commandId: "88888888-8888-4888-8888-888888888888",
        payload: {
          transferTicketId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          suspensionCheckpointId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          checkpointId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          authorityCommitment: "b".repeat(64),
        },
        lifecycleIntent: internalCarryForwardIntent({
          suspensionEventPosition: "1",
          checkpointId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          checkpointEventPosition: "2",
        }),
      })),
      /CHILD_WORK_TRANSFER_V2_INVALID/,
    );

    const wrongStreamVersion = schema4Connection();
    seedSuspendedChildTransferSource(wrongStreamVersion);
    assert.throws(
      () => rawInsert(wrongStreamVersion, "events", rawSessionEventValues({
        globalPosition: 3,
        streamVersion: 4,
        eventType: "ChildWorkTransferCreated",
        eventSchemaVersion: 2,
        sessionId: CHILD_ID,
        parentSessionId: ROOT_ID,
        commandId: "88888888-8888-4888-8888-888888888888",
        payload: {
          transferTicketId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          suspensionCheckpointId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          checkpointId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          authorityCommitment: H64,
        },
        lifecycleIntent: internalCarryForwardIntent({
          suspensionEventPosition: "1",
          checkpointId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          checkpointEventPosition: "2",
        }),
      })),
      /CHILD_WORK_TRANSFER_V2_INVALID/,
    );

    const wrongGeneration = schema4Connection();
    seedSuspendedChildTransferSource(wrongGeneration);
    assert.throws(
      () => rawInsert(wrongGeneration, "events", rawSessionEventValues({
        globalPosition: 3,
        streamVersion: 3,
        eventType: "ChildWorkTransferCreated",
        eventSchemaVersion: 2,
        sessionId: CHILD_ID,
        parentSessionId: ROOT_ID,
        commandId: "88888888-8888-4888-8888-888888888888",
        payload: {
          transferTicketId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          suspensionCheckpointId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          checkpointId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          authorityCommitment: H64,
        },
        lifecycleIntent: internalCarryForwardIntent({
          suspensionEventPosition: "1",
          checkpointId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          checkpointEventPosition: "2",
          workflowGeneration: 2,
        }),
      })),
      /CHILD_WORK_TRANSFER_V2_INVALID/,
    );

    const wrongSourcePhase = schema4Connection();
    seedSuspendedChildTransferSource(wrongSourcePhase);
    assert.throws(
      () => rawInsert(wrongSourcePhase, "events", rawSessionEventValues({
        globalPosition: 3,
        streamVersion: 3,
        eventType: "ChildWorkTransferCreated",
        eventSchemaVersion: 2,
        sessionId: CHILD_ID,
        parentSessionId: ROOT_ID,
        commandId: "88888888-8888-4888-8888-888888888888",
        payload: {
          transferTicketId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          suspensionCheckpointId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          checkpointId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          authorityCommitment: H64,
        },
        lifecycleIntent: internalCarryForwardIntent({
          suspensionEventPosition: "1",
          checkpointId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          checkpointEventPosition: "2",
          sourcePhase: "children-resolved",
        }),
      })),
      /CHILD_WORK_TRANSFER_V2_INVALID/,
    );

    const wrongWorkflowPhase = schema4Connection();
    seedActiveChildTransferSource(wrongWorkflowPhase, "active", "children-resolved");
    assert.throws(
      () => appendActiveTransfer(wrongWorkflowPhase, "active"),
      /CHILD_WORK_TRANSFER_V2_INVALID/,
    );
  });

  it("reserves lifecycle materialization outbox descriptors at schema 4", () => {
    const generic = schema4Connection();
    seedGenericSessionEvent(generic);
    rawInsert(generic, "outbox", {
      project_id: PROJECT_ID,
      target_key: "generic/1",
      event_position: 1,
      kind: "generic-test-work",
      payload_json: "{}",
      content_hash: H64,
      status: "pending",
      attempt_count: 0,
      claim_owner: null,
      claim_token: null,
      claim_expires_at: null,
      created_at: NOW,
      updated_at: NOW,
    });
    assert.equal(
      generic.prepare("SELECT count(*) AS count FROM outbox").get()?.count,
      1n,
    );

    const hostile = schema4Connection();
    seedGenericSessionEvent(hostile);
    assert.throws(
      () => rawInsert(hostile, "outbox", {
        project_id: PROJECT_ID,
        target_key: "generic/1",
        event_position: 1,
        kind: "materialize-lifecycle-log",
        payload_json: "{}",
        content_hash: H64,
        status: "pending",
        attempt_count: 0,
        claim_owner: null,
        claim_token: null,
        claim_expires_at: null,
        created_at: NOW,
        updated_at: NOW,
      }),
      /OUTBOX_LIFECYCLE_DESCRIPTOR_V4_INVALID/,
    );
    assert.equal(
      hostile.prepare("SELECT count(*) AS count FROM outbox").get()?.count,
      0n,
    );
  });

  it("blocks generic outbox updates into reserved lifecycle descriptors", () => {
    const valid = schema4Connection();
    seedDirectAbandonedEvent(valid);
    rawInsert(valid, "outbox", lifecycleOutboxValues());
    valid.prepare(`
      UPDATE outbox
      SET status = 'claimed',
          attempt_count = 1,
          claim_owner = 'materializer',
          claim_token = 1,
          claim_expires_at = $claimExpiresAt,
          updated_at = $updatedAt
      WHERE project_id = $projectId AND target_key = $targetKey
    `).run({
      $claimExpiresAt: "2026-08-09T00:01:00.000Z",
      $updatedAt: NOW,
      $projectId: PROJECT_ID,
      $targetKey: `lifecycle-log/${ROOT_ID}/2`,
    });
    assert.equal(
      valid.prepare(`
        SELECT status FROM outbox
        WHERE project_id = $projectId AND target_key = $targetKey
      `).get({
        $projectId: PROJECT_ID,
        $targetKey: `lifecycle-log/${ROOT_ID}/2`,
      })?.status,
      "claimed",
    );

    const connection = schema4Connection();
    seedGenericSessionEvent(connection);
    rawInsert(connection, "outbox", {
      project_id: PROJECT_ID,
      target_key: "generic/1",
      event_position: 1,
      kind: "generic-test-work",
      payload_json: "{}",
      content_hash: H64,
      status: "pending",
      attempt_count: 0,
      claim_owner: null,
      claim_token: null,
      claim_expires_at: null,
      created_at: NOW,
      updated_at: NOW,
    });
    const before = connection.prepare(`
      SELECT kind, payload_json, session_id, origin_kind
      FROM outbox
      WHERE project_id = $projectId AND target_key = $targetKey
    `).get({ $projectId: PROJECT_ID, $targetKey: "generic/1" });

    assert.throws(
      () => connection.prepare(`
        UPDATE outbox
        SET kind = 'materialize-lifecycle-log'
        WHERE project_id = $projectId AND target_key = $targetKey
      `).run({ $projectId: PROJECT_ID, $targetKey: "generic/1" }),
      /OUTBOX_LIFECYCLE_DESCRIPTOR_V4_INVALID/,
    );
    assert.deepEqual(
      connection.prepare(`
        SELECT kind, payload_json, session_id, origin_kind
        FROM outbox
        WHERE project_id = $projectId AND target_key = $targetKey
      `).get({ $projectId: PROJECT_ID, $targetKey: "generic/1" }),
      before,
    );
  });

  it("cross-binds exact lifecycle outbox descriptors at schema 4", () => {
    const accepted = schema4Connection();
    seedDirectAbandonedEvent(accepted);
    rawInsert(accepted, "outbox", lifecycleOutboxValues());
    assert.equal(
      accepted.prepare("SELECT count(*) AS count FROM outbox").get()?.count,
      1n,
    );

    const hostile = schema4Connection();
    seedDirectAbandonedEvent(hostile);
    assert.throws(
      () => rawInsert(hostile, "outbox", lifecycleOutboxValues({
        targetKey: "lifecycle-log/hostile/1",
      })),
      /OUTBOX_LIFECYCLE_DESCRIPTOR_V4_INVALID/,
    );
    assert.equal(
      hostile.prepare("SELECT count(*) AS count FROM outbox").get()?.count,
      0n,
    );
  });

  it("rejects incompatible legacy lifecycle outbox rows with zero writes", () => {
    const connection = schema3Connection();
    seedGenericSessionEvent(connection);
    rawInsert(connection, "outbox", {
      project_id: PROJECT_ID,
      target_key: "generic/1",
      event_position: 1,
      kind: "materialize-lifecycle-log",
      payload_json: "{}",
      content_hash: H64,
      status: "pending",
      attempt_count: 0,
      claim_owner: null,
      claim_token: null,
      claim_expires_at: null,
      created_at: NOW,
      updated_at: NOW,
    });
    const before = snapshotDatabase(connection);
    assert.throws(
      () => new SqliteSessionEndEffectiveStateMigrationPreflight()
        .assertEligible(connection, context),
      hasCode("MIGRATION_SESSION_END_EFFECTIVE_STATE_PRECONDITION_FAILED"),
    );
    assert.equal(snapshotDatabase(connection), before);
  });

  it("validates complete legacy lifecycle outbox descriptors with zero writes", () => {
    const compatible = schema3Connection();
    seedDirectAbandonedEvent(compatible);
    rawInsert(compatible, "outbox", lifecycleOutboxValues());
    const compatibleBefore = snapshotDatabase(compatible);
    new SqliteSessionEndEffectiveStateMigrationPreflight()
      .assertEligible(compatible, context);
    assert.equal(snapshotDatabase(compatible), compatibleBefore);

    const hostile = schema3Connection();
    seedDirectAbandonedEvent(hostile);
    rawInsert(hostile, "outbox", lifecycleOutboxValues({
      targetKey: "lifecycle-log/hostile/2",
    }));
    const hostileBefore = snapshotDatabase(hostile);
    assert.throws(
      () => new SqliteSessionEndEffectiveStateMigrationPreflight()
        .assertEligible(hostile, context),
      hasCode("MIGRATION_SESSION_END_EFFECTIVE_STATE_PRECONDITION_FAILED"),
    );
    assert.equal(snapshotDatabase(hostile), hostileBefore);
  });

  it("blocks the 1001st schema-4 child and source-ticket insert", () => {
    const children = schema3Connection();
    seedHistoryRows(children, 1_000, 0);
    children.exec(sessionEndEffectiveStateMigration.sql);
    children.exec("PRAGMA foreign_keys = OFF");
    assert.throws(
      () => rawInsert(children, "session_authority", {
        project_id: PROJECT_ID,
        session_id: historyUuid("a", 1_001),
        stream_id: `session/${historyUuid("a", 1_001)}`,
        session_kind: "child",
        parent_session_id: ROOT_ID,
        workspace_id: H64,
        client_namespace: "client",
        semantic_state: "completed",
        direct_access_enabled: 0,
        authority_commitment: H64,
        authority_event_position: 1_001,
        created_at: NOW,
        updated_at: NOW,
      }),
      /SESSION_CHILD_HISTORY_CAPACITY_EXCEEDED/,
    );
    assert.equal(
      children.prepare(`
        SELECT count(*) AS count FROM session_authority
        WHERE parent_session_id = $rootId
      `).get({ $rootId: ROOT_ID })?.count,
      1_000n,
    );

    const tickets = schema3Connection();
    seedHistoryRows(tickets, 1_000, 1_000);
    tickets.exec(sessionEndEffectiveStateMigration.sql);
    tickets.exec("PRAGMA foreign_keys = OFF");
    assert.throws(
      () => rawInsert(tickets, "child_transfer_tickets", {
        project_id: PROJECT_ID,
        transfer_ticket_id: historyUuid("b", 1_001),
        source_parent_session_id: ROOT_ID,
        source_child_session_id: historyUuid("d", 1_001),
        source_assignment_json: "{}",
        source_scope_json: "{}",
        checkpoint_id: historyUuid("c", 1_001),
        follow_ups_json: "[]",
        source_state_json: "{}",
        lineage_json: "{}",
        created_event_position: 1_001,
        created_at: NOW,
      }),
      /SESSION_CHILD_HISTORY_CAPACITY_EXCEEDED/,
    );
    assert.equal(
      tickets.prepare(`
        SELECT count(*) AS count FROM child_transfer_tickets
        WHERE source_parent_session_id = $rootId
      `).get({ $rootId: ROOT_ID })?.count,
      1_000n,
    );
  });

  it("upgrades compatible terminal history without rewriting events", () => {
    const connection = schema3Connection();
    seedStrictLegacyCancelledHistory(connection);
    const beforeEvents = connection.prepare(`
      SELECT payload_json, payload_hash, previous_global_hash, event_hash
      FROM events ORDER BY global_position
    `).all();

    const applied = new MigrationRunner().apply(connection, [
      eventCoreMigration,
      sessionLifecycleMigration,
      qualifiedCheckpointCoverageMigration,
      sessionEndEffectiveStateMigration,
    ], NOW, {
      kind: "explicit-upgrade",
      expectedAppliedVersion: 3,
      beforeMigration(migrationConnection, migration): void {
        if (migration.version === 4) {
          new SqliteSessionEndEffectiveStateMigrationPreflight()
            .assertEligible(migrationConnection, context);
        }
      },
    });

    assert.deepEqual(applied, [4]);
    assert.deepEqual(connection.prepare(`
      SELECT payload_json, payload_hash, previous_global_hash, event_hash
      FROM events ORDER BY global_position
    `).all(), beforeEvents);
  });
});
