import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import type { JsonValue, StoredEvent } from "../src/orchestrator/contracts/event.js";
import { eventHash, payloadHash } from "../src/orchestrator/crypto/event-hash.js";
import type {
  AmendSessionEndCommandV2,
  AmendSessionEndCommandV3,
  RequestSessionEndCommandV2,
  RequestSessionEndCommandV3,
  RootStartCommandV2,
} from "../src/orchestrator/lifecycle/contracts/commands.js";
import type {
  ProjectId,
  StoreId,
  VaultId,
  WorkspaceId,
} from "../src/orchestrator/identity/contracts.js";
import type { WorkflowId } from "../src/orchestrator/lifecycle/contracts/identifiers.js";
import type { SessionEndEffectiveStateV1 } from "../src/orchestrator/lifecycle/session-end-effective-state.js";
import {
  buildLifecycleIntentWitness,
  type BuiltLifecycleIntentWitnessV1,
  type TrustedLifecycleIntentAssertionsV1,
} from "../src/orchestrator/lifecycle/lifecycle-intent-witness.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { SqliteLifecycleRenderClosureReader } from "../src/orchestrator/materialization/sqlite-lifecycle-render-closure.reader.js";
import {
  persistLegacySessionEndEffectiveStateSourceV1,
  readLegacySessionEndEffectiveStateSourceV1,
} from "../src/orchestrator/storage/legacy-session-end-effective-state-source.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import type {
  SqliteConnection,
  SqliteParams,
  SqliteValue,
} from "../src/orchestrator/storage/sqlite-driver.js";
import { applyCurrentProjectStoreSchema } from "./support/current-project-store-schema.js";
import {
  EFFECTIVE_STATE_SESSION_ID,
  sessionEndEffectiveStateFixture,
} from "./support/session-end-effective-state-reference.js";
import { lifecycleEvent } from "./support/lifecycle-fixtures.js";

const NOW = "2026-08-14T00:00:00.000Z";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111" as ProjectId;
const VAULT_ID = "22222222-2222-4222-8222-222222222222" as VaultId;
const STORE_ID = "33333333-3333-4333-8333-333333333333" as StoreId;
const SESSION_ID = EFFECTIVE_STATE_SESSION_ID;
const WORKFLOW_ID = "44444444-4444-4444-8444-444444444444" as WorkflowId;
const SOURCE_EVENT_ID = "55555555-5555-4555-8555-555555555555";
const COMMAND_ID = "66666666-6666-4666-8666-666666666666";
const ROOT_COMMAND_ID = "99999999-9999-4999-8999-999999999999";
const ROOT_EVENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AMEND_COMMAND_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AMEND_EVENT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PRETRANSITION_CHECKPOINT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const WORKSPACE_ID = "a".repeat(64) as WorkspaceId;
const CLIENT_ID = "legacy-sidecar-client";
const HASH_ZERO = "0".repeat(64);
const LEGACY_EFFECTIVE_STATE_SOURCE_TABLE =
  "lifecycle_legacy_effective_state_sources";
const driver = new NodeSqliteDriver({ DatabaseSync });
const connections: SqliteConnection[] = [];
const roots: string[] = [];

function schema4Connection(): SqliteConnection {
  const root = mkdtempSync(join(tmpdir(), "legacy-effective-state-source-"));
  roots.push(root);
  const connection = driver.open(join(root, "events.sqlite"), {
    mode: "create",
    busyTimeoutMs: 1_000,
  });
  connections.push(connection);
  applyCurrentProjectStoreSchema(connection, {
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
  }, NOW);
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

function requestAssertions(): TrustedLifecycleIntentAssertionsV1 {
  return Object.freeze({
    authorizationKind: "protected",
    authorizationSessionId: SESSION_ID,
    targetSessionId: SESSION_ID,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    clientNamespace: "tests/legacy-effective-state-source",
    capabilityKind: "root-session-handle",
    capabilityGeneration: "1",
    presentingActorRole: "primary",
    presentingClientInstanceId: CLIENT_ID,
    targetActorRole: "primary",
    targetClientInstanceId: CLIENT_ID,
    internalWorkflowId: null,
    internalWorkflowGeneration: null,
    internalPlannedWorkId: null,
  });
}

interface LegacyRequestFixture {
  readonly state: SessionEndEffectiveStateV1;
  readonly command: RequestSessionEndCommandV2 | RequestSessionEndCommandV3;
  readonly witness: BuiltLifecycleIntentWitnessV1;
  readonly event: StoredEvent;
}

interface LegacyAmendmentFixture {
  readonly state: SessionEndEffectiveStateV1;
  readonly command: AmendSessionEndCommandV2 | AmendSessionEndCommandV3;
  readonly witness: BuiltLifecycleIntentWitnessV1;
  readonly event: StoredEvent;
}

function legacyRequestFixture(requestVersion: 1 | 2 = 1): LegacyRequestFixture {
  const state = sessionEndEffectiveStateFixture({ requestVersion });
  const request = state.request;
  const actualRequestVersion = request.requestVersion;
  const command = actualRequestVersion === 1
    ? ({
      commandType: "request-session-end",
      commandId: COMMAND_ID,
      idempotencyKey: "legacy-sidecar/request-v1",
      agentId: "legacy-sidecar-agent",
      expectedProjectId: PROJECT_ID,
      expectedVaultId: VAULT_ID,
      expectedWorkspaceId: WORKSPACE_ID,
      expectedBranchRef: null,
      request,
    } satisfies RequestSessionEndCommandV2)
    : ({
      commandType: "request-session-end",
      commandId: COMMAND_ID,
      idempotencyKey: "legacy-sidecar/request-v2",
      agentId: "legacy-sidecar-agent",
      expectedProjectId: PROJECT_ID,
      expectedVaultId: VAULT_ID,
      expectedWorkspaceId: WORKSPACE_ID,
      expectedBranchRef: null,
      request,
    } satisfies RequestSessionEndCommandV3);
  const assertions = requestAssertions();
  const witness = buildLifecycleIntentWitness(command, assertions);
  const payload = {
    workflowId: WORKFLOW_ID,
    workflowGeneration: 1,
    previousState: "active",
    childEndPolicy: state.request.childEndPolicy,
    qualityThreshold: state.request.requestedQualityThreshold,
    requireFullEvidence: state.request.requireFullEvidence,
    requireMaterialization: state.request.requireMaterialization,
    ...(actualRequestVersion === 2 ? { requestVersion: 2 } : {}),
  } as const satisfies JsonValue;
  const payloadJson = canonicalJson(payload);
  const eventWithoutHash = {
    globalPosition: 1n,
    eventId: SOURCE_EVENT_ID,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    branchScopeId: null,
    branchRef: null,
    streamId: `session/${SESSION_ID}`,
    streamType: "session",
    streamVersion: 1n,
    eventType: "SessionEndRequested" as StoredEvent["eventType"],
    eventSchemaVersion: actualRequestVersion,
    sessionId: SESSION_ID,
    parentSessionId: null,
    actorRole: "primary",
    agentId: command.agentId,
    clientInstanceId: CLIENT_ID,
    correlationId: "77777777-7777-4777-8777-777777777777",
    causationId: null,
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    commandEventIndex: 0,
    occurredAt: NOW,
    recordedAt: NOW,
    visibilityScope: "session",
    confidence: "high",
    verificationStatus: "verified",
    sourceRefs: Object.freeze([]) as readonly string[],
    evidenceRefs: Object.freeze([]) as readonly [],
    evidenceDigests: Object.freeze([]) as readonly [],
    payload,
    payloadJson,
    payloadHash: payloadHash(payload),
    previousGlobalHash: HASH_ZERO,
    lifecycleIntentJson: witness.source,
  } as const;
  const hashMaterial: Record<string, unknown> = {
    ...eventWithoutHash,
    globalPosition: eventWithoutHash.globalPosition.toString(),
    streamVersion: eventWithoutHash.streamVersion.toString(),
    sourceRefs: [],
    lifecycleIntent: witness.witness,
  };
  delete hashMaterial.payload;
  delete hashMaterial.payloadJson;
  delete hashMaterial.lifecycleIntentJson;
  const event = Object.freeze({
    ...eventWithoutHash,
    eventHash: eventHash(hashMaterial),
  }) as StoredEvent;
  return { state, command, witness, event };
}

function legacyAmendmentFixture(amendmentVersion: 1 | 2 = 2): LegacyAmendmentFixture {
  const state = sessionEndEffectiveStateFixture({
    requestVersion: amendmentVersion === 1 ? 1 : 2,
  });
  const command = amendmentVersion === 1
    ? ({
      commandType: "amend-session-end",
      commandId: AMEND_COMMAND_ID,
      idempotencyKey: "legacy-sidecar/amend-v1",
      agentId: "legacy-sidecar-agent",
      expectedProjectId: PROJECT_ID,
      expectedVaultId: VAULT_ID,
      expectedWorkspaceId: WORKSPACE_ID,
      expectedBranchRef: null,
      sessionId: SESSION_ID,
      workflowId: WORKFLOW_ID,
      expectedStreamVersion: "1",
      amendment: {
        amendmentVersion: 1,
        childEndPolicy: state.request.childEndPolicy,
        finalCheckpoint: null,
        validationProfileIds: null,
        requestedQualityThreshold: null,
        requireFullEvidence: null,
        requireMaterialization: null,
      },
    } satisfies AmendSessionEndCommandV2)
    : ({
      commandType: "amend-session-end",
      commandId: AMEND_COMMAND_ID,
      idempotencyKey: "legacy-sidecar/amend-v2",
      agentId: "legacy-sidecar-agent",
      expectedProjectId: PROJECT_ID,
      expectedVaultId: VAULT_ID,
      expectedWorkspaceId: WORKSPACE_ID,
      expectedBranchRef: null,
      sessionId: SESSION_ID,
      workflowId: WORKFLOW_ID,
      expectedStreamVersion: "1",
      amendment: {
        amendmentVersion: 2,
        childEndPolicy: null,
        finalCheckpoint: state.request.requestVersion === 2
          ? state.request.finalCheckpoint
          : null,
        validationProfileIds: null,
        requestedQualityThreshold: null,
        requireFullEvidence: null,
        requireMaterialization: null,
        evidenceWindowAction: "open",
      },
    } satisfies AmendSessionEndCommandV3);
  const witness = buildLifecycleIntentWitness(command, requestAssertions());
  const payload = {
    workflowId: WORKFLOW_ID,
    previousWorkflowGeneration: 1,
    workflowGeneration: 2,
    preTransitionCheckpointId: PRETRANSITION_CHECKPOINT_ID,
    ...(amendmentVersion === 2
      ? { amendmentVersion: 2, finalCheckpointVersion: 2, evidenceWindowAction: "open" }
      : {}),
  } as const satisfies JsonValue;
  const payloadJson = canonicalJson(payload);
  const eventWithoutHash = {
    globalPosition: 2n,
    eventId: AMEND_EVENT_ID,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    branchScopeId: null,
    branchRef: null,
    streamId: `session/${SESSION_ID}`,
    streamType: "session",
    streamVersion: 2n,
    eventType: "SessionEndAmended" as StoredEvent["eventType"],
    eventSchemaVersion: amendmentVersion,
    sessionId: SESSION_ID,
    parentSessionId: null,
    actorRole: "primary",
    agentId: command.agentId,
    clientInstanceId: CLIENT_ID,
    correlationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    causationId: SOURCE_EVENT_ID,
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    commandEventIndex: 0,
    occurredAt: NOW,
    recordedAt: NOW,
    visibilityScope: "session",
    confidence: "high",
    verificationStatus: "verified",
    sourceRefs: Object.freeze([]) as readonly string[],
    evidenceRefs: Object.freeze([]) as readonly [],
    evidenceDigests: Object.freeze([]) as readonly [],
    payload,
    payloadJson,
    payloadHash: payloadHash(payload),
    previousGlobalHash: HASH_ZERO,
    lifecycleIntentJson: witness.source,
  } as const;
  const hashMaterial: Record<string, unknown> = {
    ...eventWithoutHash,
    globalPosition: "2",
    streamVersion: "2",
    sourceRefs: [],
    lifecycleIntent: witness.witness,
  };
  delete hashMaterial.payload;
  delete hashMaterial.payloadJson;
  delete hashMaterial.lifecycleIntentJson;
  return {
    state,
    command,
    witness,
    event: Object.freeze({
      ...eventWithoutHash,
      eventHash: eventHash(hashMaterial),
    }) as StoredEvent,
  };
}

function rootAssertions(): TrustedLifecycleIntentAssertionsV1 {
  return Object.freeze({
    authorizationKind: "initial-authority",
    authorizationSessionId: null,
    targetSessionId: SESSION_ID,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    clientNamespace: "tests/legacy-effective-state-source",
    capabilityKind: null,
    capabilityGeneration: null,
    presentingActorRole: "primary",
    presentingClientInstanceId: CLIENT_ID,
    targetActorRole: "primary",
    targetClientInstanceId: CLIENT_ID,
    internalWorkflowId: null,
    internalWorkflowGeneration: null,
    internalPlannedWorkId: null,
  });
}

function rootStartFixture(): {
  readonly command: RootStartCommandV2;
  readonly witness: BuiltLifecycleIntentWitnessV1;
  readonly event: StoredEvent;
} {
  const command = {
    commandType: "root-start",
    commandId: ROOT_COMMAND_ID,
    idempotencyKey: "legacy-sidecar/root-start",
    agentId: "legacy-sidecar-agent",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: null,
    continuityKey: "legacy-sidecar-root",
    resumePolicy: "new",
  } satisfies RootStartCommandV2;
  const witness = buildLifecycleIntentWitness(command, rootAssertions());
  const payload = lifecycleEvent(1, "SessionStarted", {}, {
    eventId: ROOT_EVENT_ID,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    parentSessionId: null,
  }).payload as JsonValue;
  const payloadJson = canonicalJson(payload);
  const eventWithoutHash = {
    globalPosition: 1n,
    eventId: ROOT_EVENT_ID,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    branchScopeId: null,
    branchRef: null,
    streamId: `session/${SESSION_ID}`,
    streamType: "session",
    streamVersion: 1n,
    eventType: "SessionStarted" as StoredEvent["eventType"],
    eventSchemaVersion: 1,
    sessionId: SESSION_ID,
    parentSessionId: null,
    actorRole: "primary",
    agentId: command.agentId,
    clientInstanceId: CLIENT_ID,
    correlationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    causationId: null,
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    commandEventIndex: 0,
    occurredAt: NOW,
    recordedAt: NOW,
    visibilityScope: "session",
    confidence: "high",
    verificationStatus: "verified",
    sourceRefs: Object.freeze([]) as readonly string[],
    evidenceRefs: Object.freeze([]) as readonly [],
    evidenceDigests: Object.freeze([]) as readonly [],
    payload,
    payloadJson,
    payloadHash: payloadHash(payload),
    previousGlobalHash: HASH_ZERO,
    lifecycleIntentJson: witness.source,
  } as const;
  const hashMaterial: Record<string, unknown> = {
    ...eventWithoutHash,
    globalPosition: "1",
    streamVersion: "1",
    sourceRefs: [],
    lifecycleIntent: witness.witness,
  };
  delete hashMaterial.payload;
  delete hashMaterial.payloadJson;
  delete hashMaterial.lifecycleIntentJson;
  return {
    command,
    witness,
    event: Object.freeze({
      ...eventWithoutHash,
      eventHash: eventHash(hashMaterial),
    }) as StoredEvent,
  };
}

function rebaseLegacyRequestEvent(
  fixture: LegacyRequestFixture,
  rootEventId: string,
): StoredEvent {
  const eventWithoutHash = {
    ...fixture.event,
    globalPosition: 2n,
    streamVersion: 2n,
    causationId: rootEventId,
    occurredAt: NOW,
  };
  const hashMaterial: Record<string, unknown> = {
    ...eventWithoutHash,
    globalPosition: "2",
    streamVersion: "2",
    sourceRefs: [],
    lifecycleIntent: fixture.witness.witness,
  };
  delete hashMaterial.eventHash;
  delete hashMaterial.payload;
  delete hashMaterial.payloadJson;
  delete hashMaterial.lifecycleIntentJson;
  return Object.freeze({
    ...eventWithoutHash,
    eventHash: eventHash(hashMaterial),
  }) as StoredEvent;
}

function rebaseLegacyAmendmentEvent(
  fixture: LegacyAmendmentFixture,
  predecessorEventId: string,
): StoredEvent {
  const eventWithoutHash = {
    ...fixture.event,
    globalPosition: 3n,
    streamVersion: 3n,
    causationId: predecessorEventId,
    occurredAt: NOW,
  };
  const hashMaterial: Record<string, unknown> = {
    ...eventWithoutHash,
    globalPosition: "3",
    streamVersion: "3",
    sourceRefs: [],
    lifecycleIntent: fixture.witness.witness,
  };
  delete hashMaterial.eventHash;
  delete hashMaterial.payload;
  delete hashMaterial.payloadJson;
  delete hashMaterial.lifecycleIntentJson;
  return Object.freeze({
    ...eventWithoutHash,
    eventHash: eventHash(hashMaterial),
  }) as StoredEvent;
}

function insertRootCommand(
  connection: SqliteConnection,
  fixture: ReturnType<typeof rootStartFixture>,
): void {
  const event = fixture.event;
  rawInsert(connection, "events", {
    global_position: event.globalPosition,
    event_id: event.eventId,
    project_id: event.projectId,
    vault_id: event.vaultId,
    store_id: event.storeId,
    workspace_id: event.workspaceId,
    branch_scope_id: event.branchScopeId,
    branch_ref: event.branchRef,
    stream_id: event.streamId,
    stream_type: event.streamType,
    stream_version: event.streamVersion,
    event_type: event.eventType,
    event_schema_version: event.eventSchemaVersion,
    session_id: event.sessionId,
    parent_session_id: event.parentSessionId,
    actor_role: event.actorRole,
    agent_id: event.agentId,
    client_instance_id: event.clientInstanceId,
    correlation_id: event.correlationId,
    causation_id: event.causationId,
    command_id: event.commandId,
    idempotency_key: event.idempotencyKey,
    command_event_index: event.commandEventIndex,
    occurred_at: event.occurredAt,
    recorded_at: event.recordedAt,
    visibility_scope: event.visibilityScope,
    confidence: event.confidence,
    verification_status: event.verificationStatus,
    source_refs_json: "[]",
    evidence_refs_json: "[]",
    evidence_digests_json: "[]",
    payload_json: event.payloadJson,
    payload_hash: event.payloadHash,
    previous_global_hash: event.previousGlobalHash,
    event_hash: event.eventHash,
    lifecycle_intent_json: event.lifecycleIntentJson ?? null,
  });
  rawInsert(connection, "command_dedup", {
    project_id: PROJECT_ID,
    idempotency_key: fixture.command.idempotencyKey,
    command_id: fixture.command.commandId,
    command_type: fixture.command.commandType,
    command_hash: fixture.witness.intentHash,
    workspace_head_commit: null,
    outbox_order_json: "[]",
    state: "committed",
    first_global_position: event.globalPosition,
    last_global_position: event.globalPosition,
    final_stream_version: event.streamVersion,
    event_ids_json: canonicalJson([event.eventId]),
    response_json: "{}",
    response_hash: HASH_ZERO,
    committed_at: NOW,
    lifecycle_authorization_kind: "initial-authority",
    authorization_proof_version: null,
    authorization_proof_nonce: null,
    authorization_proof_digest: null,
    authorization_approval_id: null,
    authorization_approval_digest: null,
    authorization_session_id: null,
    target_session_id: SESSION_ID,
    presenting_actor_role: "primary",
    presenting_client_instance_id: CLIENT_ID,
    target_actor_role: "primary",
    target_client_instance_id: CLIENT_ID,
    internal_workflow_id: null,
    internal_workflow_generation: null,
    internal_planned_work_id: null,
    internal_claim_owner_id: null,
    internal_claim_token: null,
  });
}

function readerLegacyFixture(options: { readonly includeSource?: boolean } = {}): {
  readonly connection: SqliteConnection;
  readonly reader: SqliteLifecycleRenderClosureReader;
} {
  const connection = schema4Connection();
  const original = legacyRequestFixture();
  const root = rootStartFixture();
  const fixture = { ...original, event: rebaseLegacyRequestEvent(original, root.event.eventId) };
  insertLegacyRequestFixture(connection, fixture);
  insertRootCommand(connection, root);
  connection.prepare(`
    UPDATE streams
    SET current_version = 2, updated_at = $updatedAt
    WHERE project_id = $projectId AND stream_id = $streamId
  `).run({
    $updatedAt: NOW,
    $projectId: PROJECT_ID,
    $streamId: `session/${SESSION_ID}`,
  });
  if (options.includeSource ?? true) {
    persistLegacySessionEndEffectiveStateSourceV1(connection, sourceInput(fixture));
  }
  return { connection, reader: new SqliteLifecycleRenderClosureReader(connection) };
}

function readerLegacyAmendmentFixture(): {
  readonly connection: SqliteConnection;
  readonly reader: SqliteLifecycleRenderClosureReader;
  readonly amendment: LegacyAmendmentFixture;
} {
  const connection = schema4Connection();
  const originalRequest = legacyRequestFixture();
  const originalAmendment = legacyAmendmentFixture();
  const root = rootStartFixture();
  const request = {
    ...originalRequest,
    event: rebaseLegacyRequestEvent(originalRequest, root.event.eventId),
  };
  const amendment = {
    ...originalAmendment,
    event: rebaseLegacyAmendmentEvent(originalAmendment, request.event.eventId),
  };
  insertLegacyRequestFixture(connection, request);
  insertSourceRow(connection, request);
  insertLegacyAmendmentFixture(connection, amendment);
  insertRootCommand(connection, root);
  connection.prepare(`
    UPDATE streams
    SET current_version = 3, updated_at = $updatedAt
    WHERE project_id = $projectId AND stream_id = $streamId
  `).run({
    $updatedAt: NOW,
    $projectId: PROJECT_ID,
    $streamId: `session/${SESSION_ID}`,
  });
  persistLegacySessionEndEffectiveStateSourceV1(
    connection,
    amendmentSourceInput(amendment, request),
  );
  return {
    connection,
    reader: new SqliteLifecycleRenderClosureReader(connection),
    amendment,
  };
}

function insertLegacyRequestFixture(
  connection: SqliteConnection,
  fixture: LegacyRequestFixture,
): void {
  rawInsert(connection, "streams", {
    project_id: PROJECT_ID,
    stream_id: `session/${SESSION_ID}`,
    stream_type: "session",
    current_version: 1,
    created_at: NOW,
    updated_at: NOW,
  });
  const event = fixture.event;
  rawInsert(connection, "events", {
    global_position: event.globalPosition,
    event_id: event.eventId,
    project_id: event.projectId,
    vault_id: event.vaultId,
    store_id: event.storeId,
    workspace_id: event.workspaceId,
    branch_scope_id: event.branchScopeId,
    branch_ref: event.branchRef,
    stream_id: event.streamId,
    stream_type: event.streamType,
    stream_version: event.streamVersion,
    event_type: event.eventType,
    event_schema_version: event.eventSchemaVersion,
    session_id: event.sessionId,
    parent_session_id: event.parentSessionId,
    actor_role: event.actorRole,
    agent_id: event.agentId,
    client_instance_id: event.clientInstanceId,
    correlation_id: event.correlationId,
    causation_id: event.causationId,
    command_id: event.commandId,
    idempotency_key: event.idempotencyKey,
    command_event_index: event.commandEventIndex,
    occurred_at: event.occurredAt,
    recorded_at: event.recordedAt,
    visibility_scope: event.visibilityScope,
    confidence: event.confidence,
    verification_status: event.verificationStatus,
    source_refs_json: "[]",
    evidence_refs_json: "[]",
    evidence_digests_json: "[]",
    payload_json: event.payloadJson,
    payload_hash: event.payloadHash,
    previous_global_hash: event.previousGlobalHash,
    event_hash: event.eventHash,
    lifecycle_intent_json: event.lifecycleIntentJson ?? null,
  });
  rawInsert(connection, "command_dedup", {
    project_id: PROJECT_ID,
    idempotency_key: fixture.command.idempotencyKey,
    command_id: fixture.command.commandId,
    command_type: fixture.command.commandType,
    command_hash: fixture.witness.intentHash,
    workspace_head_commit: null,
    outbox_order_json: "[]",
    state: "committed",
    first_global_position: event.globalPosition,
    last_global_position: event.globalPosition,
    final_stream_version: event.streamVersion,
    event_ids_json: canonicalJson([event.eventId]),
    response_json: "{}",
    response_hash: HASH_ZERO,
    committed_at: NOW,
    lifecycle_authorization_kind: "protected",
    authorization_proof_version: 1,
    authorization_proof_nonce: "88888888-8888-4888-8888-888888888888",
    authorization_proof_digest: HASH_ZERO,
    authorization_approval_id: null,
    authorization_approval_digest: null,
    authorization_session_id: SESSION_ID,
    target_session_id: SESSION_ID,
    presenting_actor_role: "primary",
    presenting_client_instance_id: CLIENT_ID,
    target_actor_role: "primary",
    target_client_instance_id: CLIENT_ID,
    internal_workflow_id: null,
    internal_workflow_generation: null,
    internal_planned_work_id: null,
    internal_claim_owner_id: null,
    internal_claim_token: null,
  });
}

function insertLegacyAmendmentFixture(
  connection: SqliteConnection,
  fixture: LegacyAmendmentFixture,
): void {
  const event = fixture.event;
  rawInsert(connection, "events", {
    global_position: event.globalPosition,
    event_id: event.eventId,
    project_id: event.projectId,
    vault_id: event.vaultId,
    store_id: event.storeId,
    workspace_id: event.workspaceId,
    branch_scope_id: event.branchScopeId,
    branch_ref: event.branchRef,
    stream_id: event.streamId,
    stream_type: event.streamType,
    stream_version: event.streamVersion,
    event_type: event.eventType,
    event_schema_version: event.eventSchemaVersion,
    session_id: event.sessionId,
    parent_session_id: event.parentSessionId,
    actor_role: event.actorRole,
    agent_id: event.agentId,
    client_instance_id: event.clientInstanceId,
    correlation_id: event.correlationId,
    causation_id: event.causationId,
    command_id: event.commandId,
    idempotency_key: event.idempotencyKey,
    command_event_index: event.commandEventIndex,
    occurred_at: event.occurredAt,
    recorded_at: event.recordedAt,
    visibility_scope: event.visibilityScope,
    confidence: event.confidence,
    verification_status: event.verificationStatus,
    source_refs_json: "[]",
    evidence_refs_json: "[]",
    evidence_digests_json: "[]",
    payload_json: event.payloadJson,
    payload_hash: event.payloadHash,
    previous_global_hash: event.previousGlobalHash,
    event_hash: event.eventHash,
    lifecycle_intent_json: event.lifecycleIntentJson ?? null,
  });
  rawInsert(connection, "command_dedup", {
    project_id: PROJECT_ID,
    idempotency_key: fixture.command.idempotencyKey,
    command_id: fixture.command.commandId,
    command_type: fixture.command.commandType,
    command_hash: fixture.witness.intentHash,
    workspace_head_commit: null,
    outbox_order_json: "[]",
    state: "committed",
    first_global_position: event.globalPosition,
    last_global_position: event.globalPosition,
    final_stream_version: event.streamVersion,
    event_ids_json: canonicalJson([event.eventId]),
    response_json: "{}",
    response_hash: HASH_ZERO,
    committed_at: NOW,
    lifecycle_authorization_kind: "protected",
    authorization_proof_version: 1,
    authorization_proof_nonce: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    authorization_proof_digest: HASH_ZERO,
    authorization_approval_id: null,
    authorization_approval_digest: null,
    authorization_session_id: SESSION_ID,
    target_session_id: SESSION_ID,
    presenting_actor_role: "primary",
    presenting_client_instance_id: CLIENT_ID,
    target_actor_role: "primary",
    target_client_instance_id: CLIENT_ID,
    internal_workflow_id: null,
    internal_workflow_generation: null,
    internal_planned_work_id: null,
    internal_claim_owner_id: null,
    internal_claim_token: null,
  });
}

function amendmentSourceInput(
  fixture: LegacyAmendmentFixture,
  predecessor: LegacyRequestFixture,
): Parameters<typeof persistLegacySessionEndEffectiveStateSourceV1>[1] {
  const effectiveCheckpointVersion = fixture.state.request.requestVersion;
  return {
    projectId: PROJECT_ID,
    sourceEventPosition: fixture.event.globalPosition,
    sourceEventHash: fixture.event.eventHash,
    commandId: fixture.command.commandId,
    commandHash: fixture.witness.intentHash,
    sessionId: SESSION_ID,
    workflowId: WORKFLOW_ID,
    workflowGeneration: 2,
    effectiveState: fixture.state,
    evidenceWindowState: effectiveCheckpointVersion === 1 ? "sealed" : "open",
    effectiveCheckpointVersion,
    predecessorEventPosition: predecessor.event.globalPosition,
    predecessorEventHash: predecessor.event.eventHash,
  };
}

function sourceRow(
  fixture: LegacyRequestFixture,
  overrides: Readonly<Record<string, SqliteValue>> = {},
): Record<string, SqliteValue> {
  return {
    project_id: PROJECT_ID,
    source_event_position: fixture.event.globalPosition,
    source_event_hash: fixture.event.eventHash,
    command_id: fixture.command.commandId,
    command_hash: fixture.witness.intentHash,
    session_id: SESSION_ID,
    workflow_id: WORKFLOW_ID,
    workflow_generation: 1,
    effective_state_json: canonicalJson(fixture.state),
    effective_state_hash: fixture.state.effectiveStateHash,
    evidence_window_state: "sealed",
    effective_checkpoint_version: 1,
    predecessor_event_position: null,
    predecessor_event_hash: null,
    source_contract_version: 1,
    ...overrides,
  };
}

function insertSourceRow(
  connection: SqliteConnection,
  fixture: LegacyRequestFixture,
  overrides: Readonly<Record<string, SqliteValue>> = {},
): void {
  const values = sourceRow(fixture, overrides);
  rawInsert(connection, LEGACY_EFFECTIVE_STATE_SOURCE_TABLE, values);
}

function sourceInput(
  fixture: LegacyRequestFixture,
  overrides: Readonly<Record<string, unknown>> = {},
): Parameters<typeof persistLegacySessionEndEffectiveStateSourceV1>[1] {
  const effectiveCheckpointVersion = fixture.state.request.requestVersion;
  return {
    projectId: PROJECT_ID,
    sourceEventPosition: fixture.event.globalPosition,
    sourceEventHash: fixture.event.eventHash,
    commandId: fixture.command.commandId,
    commandHash: fixture.witness.intentHash,
    sessionId: SESSION_ID,
    workflowId: WORKFLOW_ID,
    workflowGeneration: 1,
    effectiveState: fixture.state,
    evidenceWindowState: effectiveCheckpointVersion === 1 ? "sealed" : "open",
    effectiveCheckpointVersion,
    predecessorEventPosition: null,
    predecessorEventHash: null,
    ...overrides,
  } as Parameters<typeof persistLegacySessionEndEffectiveStateSourceV1>[1];
}

afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("legacy effective-state source sidecar", () => {
  it("exposes the exact sidecar table at schema 4", () => {
    const connection = schema4Connection();

    const table = connection.prepare(`
        SELECT type, name, tbl_name
        FROM sqlite_schema
        WHERE type = 'table' AND name = $name
      `).get({ $name: LEGACY_EFFECTIVE_STATE_SOURCE_TABLE });
    assert.deepEqual(
      table === undefined ? undefined : { ...table },
      {
        type: "table",
        name: LEGACY_EFFECTIVE_STATE_SOURCE_TABLE,
        tbl_name: LEGACY_EFFECTIVE_STATE_SOURCE_TABLE,
      },
    );
  });

  it("accepts a production-decoded request source with exact immutable bindings", () => {
    const connection = schema4Connection();
    const fixture = legacyRequestFixture();
    insertLegacyRequestFixture(connection, fixture);

    insertSourceRow(connection, fixture);

    const source = connection.prepare(`
        SELECT project_id, source_event_position, source_event_hash,
               command_id, command_hash, session_id, workflow_id,
               workflow_generation, effective_state_json, effective_state_hash,
               evidence_window_state, effective_checkpoint_version,
        predecessor_event_position, predecessor_event_hash,
               source_contract_version
        FROM ${LEGACY_EFFECTIVE_STATE_SOURCE_TABLE}
      `).get();
    assert.deepEqual(
      source === undefined ? undefined : { ...source },
      {
        project_id: PROJECT_ID,
        source_event_position: 1n,
        source_event_hash: fixture.event.eventHash,
        command_id: fixture.command.commandId,
        command_hash: fixture.witness.intentHash,
        session_id: SESSION_ID,
        workflow_id: WORKFLOW_ID,
        workflow_generation: 1n,
        effective_state_json: canonicalJson(fixture.state),
        effective_state_hash: fixture.state.effectiveStateHash,
        evidence_window_state: "sealed",
        effective_checkpoint_version: 1n,
        predecessor_event_position: null,
        predecessor_event_hash: null,
        source_contract_version: 1n,
      },
    );
  });

  it("persists and reads a fully authenticated immutable request source", () => {
    const connection = schema4Connection();
    const fixture = legacyRequestFixture();
    insertLegacyRequestFixture(connection, fixture);

    const persisted = persistLegacySessionEndEffectiveStateSourceV1(
      connection,
      sourceInput(fixture),
    );
    const read = readLegacySessionEndEffectiveStateSourceV1(connection, {
      projectId: PROJECT_ID,
      sourceEventPosition: fixture.event.globalPosition,
    });

    assert.equal(persisted.effectiveState.effectiveStateHash, fixture.state.effectiveStateHash);
    assert.deepEqual({ ...read }, { ...persisted });
    assert.equal(Object.isFrozen(read), true);
    assert.equal(Object.isFrozen(read.effectiveState), true);
  });

  it("persists and reads an outer V2 request source", () => {
    const connection = schema4Connection();
    const fixture = legacyRequestFixture(2);
    insertLegacyRequestFixture(connection, fixture);

    const source = persistLegacySessionEndEffectiveStateSourceV1(
      connection,
      sourceInput(fixture),
    );
    assert.equal(fixture.event.eventSchemaVersion, 2);
    assert.equal(source.effectiveCheckpointVersion, 2);
    assert.equal(source.evidenceWindowState, "open");
    assert.equal(source.effectiveState.request.requestVersion, 2);
  });

  it("persists and reads a V2 amendment with an exact predecessor sidecar", () => {
    const connection = schema4Connection();
    const predecessor = legacyRequestFixture();
    const amendment = legacyAmendmentFixture();
    insertLegacyRequestFixture(connection, predecessor);
    insertSourceRow(connection, predecessor);
    insertLegacyAmendmentFixture(connection, amendment);
    connection.prepare(`
      UPDATE streams
      SET current_version = 2, updated_at = $updatedAt
      WHERE project_id = $projectId AND stream_id = $streamId
    `).run({
      $updatedAt: NOW,
      $projectId: PROJECT_ID,
      $streamId: `session/${SESSION_ID}`,
    });

    const persisted = persistLegacySessionEndEffectiveStateSourceV1(
      connection,
      amendmentSourceInput(amendment, predecessor),
    );
    const read = readLegacySessionEndEffectiveStateSourceV1(connection, {
      projectId: PROJECT_ID,
      sourceEventPosition: amendment.event.globalPosition,
    });

    assert.equal(persisted.workflowGeneration, 2);
    assert.equal(persisted.evidenceWindowState, "open");
    assert.equal(persisted.effectiveCheckpointVersion, 2);
    assert.equal(persisted.predecessorEventPosition, predecessor.event.globalPosition);
    assert.equal(persisted.predecessorEventHash, predecessor.event.eventHash);
    assert.deepEqual({ ...read }, { ...persisted });
  });

  it("persists and reads a V1 amendment with an unchanged predecessor state", () => {
    const connection = schema4Connection();
    const predecessor = legacyRequestFixture();
    const amendment = legacyAmendmentFixture(1);
    insertLegacyRequestFixture(connection, predecessor);
    insertSourceRow(connection, predecessor);
    insertLegacyAmendmentFixture(connection, amendment);

    const persisted = persistLegacySessionEndEffectiveStateSourceV1(
      connection,
      amendmentSourceInput(amendment, predecessor),
    );
    assert.equal(amendment.event.eventSchemaVersion, 1);
    assert.equal(persisted.effectiveCheckpointVersion, 1);
    assert.equal(persisted.evidenceWindowState, "sealed");
    assert.equal(persisted.predecessorEventPosition, predecessor.event.globalPosition);
  });

  it("fails closed when the immutable source is missing", () => {
    const connection = schema4Connection();
    assert.throws(
      () => readLegacySessionEndEffectiveStateSourceV1(connection, {
        projectId: PROJECT_ID,
        sourceEventPosition: 1n,
      }),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "INTEGRITY_FAILURE"
      ),
    );
  });

  it("rejects source-position, session, and workflow identity drift", () => {
    const cases: ReadonlyArray<Readonly<Record<string, unknown>>> = [
      { sourceEventPosition: 2n },
      { sessionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" },
      { workflowId: "ffffffff-ffff-4fff-8fff-ffffffffffff" },
    ];
    for (const overrides of cases) {
      const connection = schema4Connection();
      const fixture = legacyRequestFixture();
      insertLegacyRequestFixture(connection, fixture);
      assert.throws(
        () => persistLegacySessionEndEffectiveStateSourceV1(
          connection,
          sourceInput(fixture, overrides),
        ),
        (error: unknown) => (
          error instanceof Error
          && "code" in error
          && error.code === "INTEGRITY_FAILURE"
        ),
      );
    }
  });

  it("rejects source, command, and state hash divergence", () => {
    for (const [field, value] of [
      ["source_event_hash", HASH_ZERO],
      ["command_hash", HASH_ZERO],
      ["effective_state_hash", HASH_ZERO],
    ] as const) {
      const connection = schema4Connection();
      const fixture = legacyRequestFixture();
      insertLegacyRequestFixture(connection, fixture);
      assert.throws(
        () => insertSourceRow(connection, fixture, { [field]: value }),
        /LEGACY_EFFECTIVE_STATE_SOURCE|CHECK constraint failed/,
      );
    }
  });

  it("rejects amendment predecessor and evidence-window tampering", () => {
    const cases: ReadonlyArray<Readonly<Record<string, unknown>>> = [
      { predecessorEventPosition: 2n },
      { predecessorEventHash: HASH_ZERO },
      { evidenceWindowState: "sealed" },
    ];
    for (const overrides of cases) {
      const connection = schema4Connection();
      const predecessor = legacyRequestFixture();
      const amendment = legacyAmendmentFixture();
      insertLegacyRequestFixture(connection, predecessor);
      insertSourceRow(connection, predecessor);
      insertLegacyAmendmentFixture(connection, amendment);
      assert.throws(
        () => persistLegacySessionEndEffectiveStateSourceV1(
          connection,
          {
            ...amendmentSourceInput(amendment, predecessor),
            ...overrides,
          } as Parameters<typeof persistLegacySessionEndEffectiveStateSourceV1>[1],
        ),
        (error: unknown) => (
          error instanceof Error
          && "code" in error
          && error.code === "INTEGRITY_FAILURE"
        ),
      );
    }
  });

  it("rejects non-canonical effective JSON and explicit-null state tampering", () => {
    const fixture = legacyRequestFixture();
    const nonCanonical = schema4Connection();
    insertLegacyRequestFixture(nonCanonical, fixture);
    assert.throws(
      () => insertSourceRow(nonCanonical, fixture, {
        effective_state_json: `${canonicalJson(fixture.state)} `,
      }),
      /LEGACY_EFFECTIVE_STATE_SOURCE|CHECK constraint failed/,
    );
    const reorderedStateJson = JSON.stringify({
      request: fixture.state.request,
      effectiveStateHash: fixture.state.effectiveStateHash,
      effectiveStateVersion: fixture.state.effectiveStateVersion,
      effectiveStateDomain: fixture.state.effectiveStateDomain,
      effectiveFinalCheckpoint: fixture.state.effectiveFinalCheckpoint,
      effectivePolicy: fixture.state.effectivePolicy,
    });
    assert.throws(
      () => insertSourceRow(nonCanonical, fixture, {
        effective_state_json: reorderedStateJson,
      }),
      /LEGACY_EFFECTIVE_STATE_SOURCE|CHECK constraint failed/,
    );
    const extraKeyState = schema4Connection();
    insertLegacyRequestFixture(extraKeyState, fixture);
    assert.throws(
      () => insertSourceRow(extraKeyState, fixture, {
        effective_state_json: canonicalJson({
          ...fixture.state,
          unexpected: true,
        }),
      }),
      /LEGACY_EFFECTIVE_STATE_SOURCE|CHECK constraint failed/,
    );
    const malformedArray = schema4Connection();
    insertLegacyRequestFixture(malformedArray, fixture);
    assert.throws(
      () => insertSourceRow(malformedArray, fixture, {
        effective_state_json: canonicalJson({
          ...fixture.state,
          effectiveFinalCheckpoint: {
            ...fixture.state.effectiveFinalCheckpoint,
            completedItems: {},
          },
        }),
      }),
      /LEGACY_EFFECTIVE_STATE_SOURCE|CHECK constraint failed/,
    );
    const malformedNestedObject = schema4Connection();
    insertLegacyRequestFixture(malformedNestedObject, fixture);
    assert.throws(
      () => insertSourceRow(malformedNestedObject, fixture, {
        effective_state_json: canonicalJson({
          ...fixture.state,
          effectiveFinalCheckpoint: {
            ...fixture.state.effectiveFinalCheckpoint,
            commandResults: [{
              label: "invalid fingerprint",
              result: "invalid",
              exitClassification: "passed",
              outputFingerprint: "not-an-object-or-null",
              artifactReference: null,
              confidence: "high",
            }],
          },
        }),
      }),
      /LEGACY_EFFECTIVE_STATE_SOURCE|CHECK constraint failed/,
    );

    const explicitNull = schema4Connection();
    insertLegacyRequestFixture(explicitNull, fixture);
    const tamperedState = {
      ...fixture.state,
      effectivePolicy: null,
    };
    assert.throws(
      () => insertSourceRow(explicitNull, fixture, {
        effective_state_json: canonicalJson(tamperedState),
      }),
      /LEGACY_EFFECTIVE_STATE_SOURCE|CHECK constraint failed/,
    );
  });

  it("requires generation-one metadata and paired predecessor nullability", () => {
    const invalidOverrides: ReadonlyArray<Readonly<Record<string, SqliteValue>>> = [
      { workflow_generation: 0 },
      { evidence_window_state: "open" },
      { effective_checkpoint_version: 2 },
      { predecessor_event_position: 0n },
      { predecessor_event_hash: HASH_ZERO },
      { source_contract_version: 2 },
    ];
    for (const overrides of invalidOverrides) {
      const connection = schema4Connection();
      const fixture = legacyRequestFixture();
      insertLegacyRequestFixture(connection, fixture);
      assert.throws(
        () => insertSourceRow(connection, fixture, overrides),
        /LEGACY_EFFECTIVE_STATE_SOURCE|CHECK constraint failed/,
      );
    }
  });

  it("rejects update and delete attempts after an accepted source row", () => {
    const connection = schema4Connection();
    const fixture = legacyRequestFixture();
    insertLegacyRequestFixture(connection, fixture);
    insertSourceRow(connection, fixture);

    assert.throws(
      () => connection.prepare(`
        UPDATE ${LEGACY_EFFECTIVE_STATE_SOURCE_TABLE}
        SET evidence_window_state = 'open'
        WHERE project_id = $projectId AND source_event_position = $position
      `).run({ $projectId: PROJECT_ID, $position: 1n }),
        /LEGACY_EFFECTIVE_STATE_SOURCE|CHECK constraint failed/,
    );
    assert.throws(
      () => connection.prepare(`
        DELETE FROM ${LEGACY_EFFECTIVE_STATE_SOURCE_TABLE}
        WHERE project_id = $projectId AND source_event_position = $position
      `).run({ $projectId: PROJECT_ID, $position: 1n }),
      /LEGACY_EFFECTIVE_STATE_SOURCE/,
    );
  });

  it("normalizes a legacy closure from the immutable sidecar state", () => {
    const { reader } = readerLegacyFixture();

    const closure = reader.readStrictLifecycleClosure(PROJECT_ID, SESSION_ID, 3n);
    const legacyEvent = closure.root.at(-1);
    assert.equal(legacyEvent?.eventType, "SessionEndRequested");
    assert.deepEqual(legacyEvent?.legacyIntentSemantics, {
      effectiveState: sessionEndEffectiveStateFixture({ requestVersion: 1 }),
      evidenceWindowAction: null,
    });
  });

  it("normalizes a V2 legacy amendment from its predecessor-linked sidecar", () => {
    const fixture = readerLegacyAmendmentFixture();

    const closure = fixture.reader.readStrictLifecycleClosure(PROJECT_ID, SESSION_ID, 4n);
    const legacyEvent = closure.root.at(-1);
    assert.equal(legacyEvent?.eventType, "SessionEndAmended");
    assert.deepEqual(legacyEvent?.legacyIntentSemantics, {
      effectiveState: fixture.amendment.state,
      evidenceWindowAction: "open",
    });
  });

  it("fails closed when a legacy closure has no sidecar source", () => {
    const { reader } = readerLegacyFixture({ includeSource: false });

    assert.throws(
      () => reader.readStrictLifecycleClosure(PROJECT_ID, SESSION_ID, 3n),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "INTEGRITY_FAILURE"
      ),
    );
  });
});
