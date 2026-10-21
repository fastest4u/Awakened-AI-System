import { strict as assert } from "node:assert";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import {
  advanceEvidenceCoverageIntervals,
  assertEvidenceCoverageProjectionBounds,
} from "../src/orchestrator/lifecycle/evidence-coverage-accumulator.js";
import type { CheckpointEvidenceCoverageV2 } from "../src/orchestrator/lifecycle/contracts/checkpoint.js";
import type { RecordEvidenceBatchCommandV2 } from "../src/orchestrator/lifecycle/contracts/commands.js";
import type { FinalEndingScopeBindingV1 } from "../src/orchestrator/lifecycle/contracts/session-end.js";
import type { ProjectContext } from "../src/orchestrator/identity/contracts.js";
import type {
  LifecycleReplayExpectation,
  PersistedLifecycleAuthorizationRecord,
  StoredEvent,
} from "../src/orchestrator/contracts/event.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import {
  authorityCommitment,
  type CommittedAuthorityV1,
} from "../src/orchestrator/lifecycle/authority/authority-commitment.js";
import { EvidenceCoverageRepository } from "../src/orchestrator/storage/evidence-coverage.repository.js";
import { ChildTransferRepository } from "../src/orchestrator/storage/child-transfer.repository.js";
import { SessionAuthorityRepository } from "../src/orchestrator/storage/session-authority.repository.js";
import {
  EvidenceCoverageService,
} from "../src/orchestrator/lifecycle/evidence-coverage.service.js";
import {
  connectionBoundEvidenceCoverage,
  LifecycleCommandStore,
  type LifecycleCommandEnvelope,
  type LifecycleCommandTransaction,
} from "../src/orchestrator/lifecycle/lifecycle-command.store.js";
import { buildLifecycleIntentWitness } from "../src/orchestrator/lifecycle/lifecycle-intent-witness.js";
import { BranchScopeRepository } from "../src/orchestrator/storage/branch-scope.repository.js";
import {
  EventAppendTransaction,
  SqliteEventAppendStatements,
} from "../src/orchestrator/storage/event-append-transaction.js";
import { MaintenanceFence } from "../src/orchestrator/storage/maintenance-fence.js";
import type {
  ChildAuthorityInsert,
  RootAuthorityInsert,
  SessionAuthorityRecord,
} from "../src/orchestrator/storage/lifecycle-storage.types.js";
import type { SessionAggregateState } from "../src/orchestrator/lifecycle/session-aggregate.js";
import type { LifecycleEventV1 } from "../src/orchestrator/lifecycle/contracts/events.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import type {
  SqliteConnection,
  SqliteParams,
  SqliteStatement,
  SqliteValue,
} from "../src/orchestrator/storage/sqlite-driver.js";
import { applyCurrentProjectStoreSchema } from "./support/current-project-store-schema.js";
import {
  SqliteLifecycleProjectionRepository,
} from "../src/orchestrator/storage/lifecycle-projection.repository.js";
import {
  checkpointFixture,
  lifecycleEvent,
} from "./support/lifecycle-fixtures.js";
import { sessionEndWorkflowId } from "../src/orchestrator/lifecycle/session-end-identifiers.js";

const NOW = "2026-07-27T00:00:00.000Z";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const VAULT_ID = "22222222-2222-4222-8222-222222222222";
const STORE_ID = "33333333-3333-4333-8333-333333333333";
const SESSION_ID = "44444444-4444-4444-8444-444444444444";
const ADAPTER_ID = "55555555-5555-4555-8555-555555555555";
const BATCH_ID = "66666666-6666-4666-8666-666666666666";
const FRAME_ID = "77777777-7777-4777-8777-777777777777";
const H64 = "a".repeat(64);
const FRAME_H64 = "b".repeat(64);
const roots: string[] = [];
const connections: SqliteConnection[] = [];

function projectionSeedTransaction(): LifecycleCommandTransaction {
  return {
    authority: {},
    leases: {},
    approvals: {},
    transfers: {},
    coverage: {} as LifecycleCommandTransaction["coverage"],
    workflows: {},
    validation: {},
    outbox: {},
  };
}

function database(): SqliteConnection {
  const root = mkdtempSync(join(tmpdir(), "evidence-coverage-"));
  roots.push(root);
  const connection = new NodeSqliteDriver({ DatabaseSync }).open(
    join(root, "events.sqlite"),
    { mode: "create", busyTimeoutMs: 1_000 },
  );
  connections.push(connection);
  applyCurrentProjectStoreSchema(connection, {
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
  }, NOW);
  connection.exec("PRAGMA foreign_keys = OFF");
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

function repositoryTableCounts(
  connection: SqliteConnection,
): Readonly<Record<string, bigint>> {
  return Object.freeze(Object.fromEntries([
    "events",
    "session_evidence_coverage_transitions",
    "session_evidence_coverage_transition_heads",
    "session_evidence_coverage",
    "session_evidence_fingerprints",
  ].map((table) => [
    table,
    connection.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count as bigint,
  ])));
}

function atomicStoreState(
  connection: SqliteConnection,
): Readonly<Record<string, bigint>> {
  const counts = repositoryTableCounts(connection);
  const stream = connection.prepare(`
    SELECT current_version
    FROM streams
    WHERE project_id = $projectId
      AND stream_id = $streamId
  `).get({
    $projectId: PROJECT_ID,
    $streamId: `session/${SESSION_ID}`,
  });
  return Object.freeze({
    ...counts,
    command_dedup:
      connection.prepare("SELECT count(*) AS count FROM command_dedup").get()!.count as bigint,
    session_stream_version: stream?.current_version as bigint,
  });
}

function indexedUuid(index: number): string {
  return `${index.toString(16).padStart(8, "0")}-0000-4000-8000-${index
    .toString(16)
    .padStart(12, "0")}`;
}

function committedAuthority(record: SessionAuthorityRecord): CommittedAuthorityV1 {
  return {
    authorityVersion: 1,
    projectId: record.projectId,
    sessionId: record.sessionId,
    sessionKind: record.sessionKind,
    parentSessionId: record.parentSessionId,
    workspaceId: record.workspaceId,
    clientNamespace: record.clientNamespace,
    ownerGeneration: record.ownerGeneration?.toString() ?? null,
    childCapabilityGeneration: record.childCapabilityGeneration?.toString() ?? null,
    directAccessEnabled: record.directAccessEnabled,
    continuityFingerprintAlgorithm: record.continuityFingerprintAlgorithm,
    continuityFingerprintSchemaVersion: record.continuityFingerprintSchemaVersion,
    continuityFingerprintKeyId: record.continuityFingerprintKeyId,
    continuityFingerprintDomain: record.continuityFingerprintDomain,
    continuityFingerprint: record.continuityFingerprint,
    rootHandleCapabilityVersion: record.rootHandleCapabilityVersion,
    rootHandleKeyId: record.rootHandleKeyId,
    rootHandleIssueNonce: record.rootHandleIssueNonce,
    rootHandleIssuedAt: record.rootHandleIssuedAt,
    rootHandlePolicyCode: record.rootHandlePolicyCode,
    rootHandleExpiryKind: record.rootHandleExpiryKind,
    rootHandleExpiresAt: record.rootHandleExpiresAt,
    rootHandleActorRole: record.rootHandleActorRole,
    rootHandleClientInstanceId: record.rootHandleClientInstanceId,
    rootHandleVerifier: record.rootHandleVerifier,
    resumeTokenCapabilityVersion: record.resumeTokenCapabilityVersion,
    resumeTokenKeyId: record.resumeTokenKeyId,
    resumeTokenIssueNonce: record.resumeTokenIssueNonce,
    resumeTokenIssuedAt: record.resumeTokenIssuedAt,
    resumeTokenPolicyCode: record.resumeTokenPolicyCode,
    resumeTokenExpiryKind: record.resumeTokenExpiryKind,
    resumeTokenExpiresAt: record.resumeTokenExpiresAt,
    resumeTokenActorRole: record.resumeTokenActorRole,
    resumeTokenVerifier: record.resumeTokenVerifier,
    childHandleCapabilityVersion: record.childHandleCapabilityVersion,
    childHandleKeyId: record.childHandleKeyId,
    childHandleIssueNonce: record.childHandleIssueNonce,
    childHandleIssuedAt: record.childHandleIssuedAt,
    childHandlePolicyCode: record.childHandlePolicyCode,
    childHandleExpiryKind: record.childHandleExpiryKind,
    childHandleExpiresAt: record.childHandleExpiresAt,
    childHandleActorRole: record.childHandleActorRole,
    childHandleClientInstanceId: record.childHandleClientInstanceId,
    childHandleVerifier: record.childHandleVerifier,
    revocationReasonCode: record.revocationReasonCode,
    revocationEventPosition: record.revocationEventPosition?.toString() ?? null,
    revokedAt: record.revokedAt,
    terminalEventPosition: record.terminalEventPosition?.toString() ?? null,
    terminalEventType: record.terminalEventType,
    terminalAt: record.terminalAt,
  };
}

function withAuthorityCommitment<T extends SessionAuthorityRecord>(record: T): T {
  const next = { ...record } as T;
  return Object.freeze({
    ...next,
    authorityCommitment: authorityCommitment(committedAuthority(next)),
  }) as T;
}

function rootAuthorityFixture(
  overrides: Partial<RootAuthorityInsert> = {},
): RootAuthorityInsert {
  return withAuthorityCommitment({
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    streamId: `session/${SESSION_ID}`,
    sessionKind: "root",
    parentSessionId: null,
    workspaceId: "c".repeat(64),
    clientNamespace: "client-1",
    semanticState: "active",
    ownerGeneration: 1n,
    childCapabilityGeneration: null,
    directAccessEnabled: false,
    continuityFingerprintAlgorithm: "hmac-sha256",
    continuityFingerprintSchemaVersion: 1,
    continuityFingerprintKeyId: "continuity-key-1",
    continuityFingerprintDomain: "pm-continuity-v1",
    continuityFingerprint: H64,
    rootHandleCapabilityVersion: 1,
    rootHandleKeyId: "capability-key-1",
    rootHandleIssueNonce: H64,
    rootHandleIssuedAt: NOW,
    rootHandlePolicyCode: "root-default-v1",
    rootHandleExpiryKind: "until-revoked",
    rootHandleExpiresAt: null,
    rootHandleActorRole: "primary",
    rootHandleClientInstanceId: "client-1",
    rootHandleVerifier: H64,
    rootHandleIssuanceId: indexedUuid(810_001),
    resumeTokenCapabilityVersion: 1,
    resumeTokenKeyId: "capability-key-1",
    resumeTokenIssueNonce: FRAME_H64,
    resumeTokenIssuedAt: NOW,
    resumeTokenPolicyCode: "resume-default-v1",
    resumeTokenExpiryKind: "until-revoked",
    resumeTokenExpiresAt: null,
    resumeTokenActorRole: "primary",
    resumeTokenVerifier: FRAME_H64,
    resumeTokenIssuanceId: indexedUuid(810_002),
    childHandleCapabilityVersion: null,
    childHandleKeyId: null,
    childHandleIssueNonce: null,
    childHandleIssuedAt: null,
    childHandlePolicyCode: null,
    childHandleExpiryKind: null,
    childHandleExpiresAt: null,
    childHandleActorRole: null,
    childHandleClientInstanceId: null,
    childHandleVerifier: null,
    childHandleIssuanceId: null,
    authorityCommitment: H64,
    authorityEventPosition: 1n,
    latestCheckpointId: null,
    latestCheckpointEventPosition: null,
    latestCheckpointFingerprint: null,
    checkpointRequiredReason: null,
    checkpointRequiredEventPosition: null,
    revocationReasonCode: null,
    revocationEventPosition: null,
    revokedAt: null,
    terminalEventPosition: null,
    terminalEventType: null,
    terminalAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

function childAuthorityFixture(
  childSessionId: string,
  rootSessionId = SESSION_ID,
  overrides: Partial<ChildAuthorityInsert> = {},
): ChildAuthorityInsert {
  return withAuthorityCommitment({
    projectId: PROJECT_ID,
    sessionId: childSessionId,
    streamId: `session/${childSessionId}`,
    sessionKind: "child",
    parentSessionId: rootSessionId,
    workspaceId: "c".repeat(64),
    clientNamespace: "client-1",
    semanticState: "active",
    ownerGeneration: null,
    childCapabilityGeneration: 1n,
    directAccessEnabled: true,
    continuityFingerprintAlgorithm: null,
    continuityFingerprintSchemaVersion: null,
    continuityFingerprintKeyId: null,
    continuityFingerprintDomain: null,
    continuityFingerprint: null,
    rootHandleCapabilityVersion: null,
    rootHandleKeyId: null,
    rootHandleIssueNonce: null,
    rootHandleIssuedAt: null,
    rootHandlePolicyCode: null,
    rootHandleExpiryKind: null,
    rootHandleExpiresAt: null,
    rootHandleActorRole: null,
    rootHandleClientInstanceId: null,
    rootHandleVerifier: null,
    rootHandleIssuanceId: null,
    resumeTokenCapabilityVersion: null,
    resumeTokenKeyId: null,
    resumeTokenIssueNonce: null,
    resumeTokenIssuedAt: null,
    resumeTokenPolicyCode: null,
    resumeTokenExpiryKind: null,
    resumeTokenExpiresAt: null,
    resumeTokenActorRole: null,
    resumeTokenVerifier: null,
    resumeTokenIssuanceId: null,
    childHandleCapabilityVersion: 1,
    childHandleKeyId: "capability-key-1",
    childHandleIssueNonce: H64,
    childHandleIssuedAt: NOW,
    childHandlePolicyCode: "child-default-v1",
    childHandleExpiryKind: "absolute",
    childHandleExpiresAt: "2026-07-28T01:00:00.000Z",
    childHandleActorRole: "untrusted",
    childHandleClientInstanceId: "child-client",
    childHandleVerifier: H64,
    childHandleIssuanceId: indexedUuid(810_003),
    authorityCommitment: H64,
    authorityEventPosition: 2n,
    latestCheckpointId: null,
    latestCheckpointEventPosition: null,
    latestCheckpointFingerprint: null,
    checkpointRequiredReason: null,
    checkpointRequiredEventPosition: null,
    revocationReasonCode: null,
    revocationEventPosition: null,
    revokedAt: null,
    terminalEventPosition: null,
    terminalEventType: null,
    terminalAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

function endingBinding(index: number): FinalEndingScopeBindingV1 {
  return {
    bindingVersion: 1,
    bindingKind: "current-child",
    childSessionId: indexedUuid(200_000 + index) as never,
    childState: "active",
    lastEventPosition: "1",
    streamVersion: "1",
    checkpointId: null,
    checkpointEventPosition: null,
    transferTicketId: null,
    transferTicketEventPosition: null,
  };
}

function carryEndingBinding(index: number): FinalEndingScopeBindingV1 {
  return {
    bindingVersion: 1,
    bindingKind: "carry-forward-ticket",
    childSessionId: indexedUuid(400_000 + index) as never,
    childState: "transferred",
    lastEventPosition: "1",
    streamVersion: "1",
    checkpointId: indexedUuid(500_000 + index) as never,
    checkpointEventPosition: "1",
    transferTicketId: indexedUuid(600_000 + index) as never,
    transferTicketEventPosition: "1",
  };
}

function rawGenericSessionEvent(
  connection: SqliteConnection,
  globalPosition: bigint,
): void {
  const index = Number(globalPosition);
  rawInsert(connection, "events", {
    global_position: globalPosition,
    event_id: indexedUuid(10_000 + index),
    project_id: PROJECT_ID,
    vault_id: VAULT_ID,
    store_id: STORE_ID,
    workspace_id: "c".repeat(64),
    branch_scope_id: null,
    branch_ref: null,
    stream_id: `generic/${SESSION_ID}`,
    stream_type: "generic",
    stream_version: globalPosition,
    event_type: "GenericEvent",
    event_schema_version: 1,
    session_id: SESSION_ID,
    parent_session_id: null,
    actor_role: "primary",
    agent_id: "agent-1",
    client_instance_id: "client-1",
    correlation_id: indexedUuid(20_000 + index),
    causation_id: null,
    command_id: indexedUuid(30_000 + index),
    idempotency_key: `generic-${index}`,
    command_event_index: 0,
    occurred_at: NOW,
    recorded_at: NOW,
    visibility_scope: "session",
    confidence: "high",
    verification_status: "verified",
    source_refs_json: "[]",
    evidence_refs_json: "[]",
    evidence_digests_json: "[]",
    payload_json: "{}",
    payload_hash: H64,
    previous_global_hash: "0".repeat(64),
    event_hash: H64,
    lifecycle_intent_json: null,
  });
}

function rawLifecycleSessionEvent(
  connection: SqliteConnection,
  event: LifecycleEventV1,
): void {
  rawInsert(connection, "events", {
    global_position: BigInt(event.globalPosition),
    event_id: event.eventId,
    project_id: event.projectId,
    vault_id: event.vaultId,
    store_id: event.storeId,
    workspace_id: event.workspaceId,
    branch_scope_id: null,
    branch_ref: null,
    stream_id: event.streamId,
    stream_type: "session",
    stream_version: BigInt(event.streamVersion),
    event_type: event.eventType,
    event_schema_version: 1n,
    session_id: event.sessionId,
    parent_session_id: event.parentSessionId,
    actor_role: "primary",
    agent_id: "agent-1",
    client_instance_id: "client-1",
    correlation_id: event.correlationId,
    causation_id: event.causationId,
    command_id: event.commandId,
    idempotency_key: event.idempotencyKey,
    command_event_index: 0n,
    occurred_at: event.occurredAt,
    recorded_at: NOW,
    visibility_scope: "session",
    confidence: "high",
    verification_status: "verified",
    source_refs_json: "[]",
    evidence_refs_json: "[]",
    evidence_digests_json: "[]",
    payload_json: canonicalJson(event.payload),
    payload_hash: H64,
    previous_global_hash: H64,
    event_hash: H64,
    lifecycle_intent_json: null,
  });
}

function seedAuthorityForForeignKeys(
  connection: SqliteConnection,
  eventPosition: bigint,
  latestCheckpoint = false,
): void {
  rawInsert(connection, "streams", {
    project_id: PROJECT_ID,
    stream_id: `session/${SESSION_ID}`,
    stream_type: "session",
    current_version: 1n,
    created_at: NOW,
    updated_at: NOW,
  });
  connection.exec("DROP TRIGGER session_authority_insert_guard");
  new SessionAuthorityRepository().insertRoot(
    connection,
    rootAuthorityFixture({
      authorityEventPosition: eventPosition,
      ...(latestCheckpoint
        ? {
            latestCheckpointId: indexedUuid(400_001),
            latestCheckpointEventPosition: eventPosition,
            latestCheckpointFingerprint: "e".repeat(64),
          }
        : {}),
    }),
  );
}

function seedChildAuthorityForForeignKeys(
  connection: SqliteConnection,
  childSessionId: string,
  rootSessionId = SESSION_ID,
): void {
  const childAuthority = childAuthorityFixture(childSessionId, rootSessionId);
  const fork = lifecycleEvent(1, "SessionForked", {}, {
    projectId: PROJECT_ID as never,
    vaultId: VAULT_ID as never,
    storeId: STORE_ID as never,
    workspaceId: "c".repeat(64) as never,
    sessionId: childSessionId as never,
    parentSessionId: rootSessionId as never,
    streamId: `session/${childSessionId}`,
    streamVersion: 1,
    globalPosition: 2,
    authorityCommitment: childAuthority.authorityCommitment,
  });
  rawInsert(connection, "streams", {
    project_id: PROJECT_ID,
    stream_id: `session/${childSessionId}`,
    stream_type: "session",
    current_version: 1n,
    created_at: NOW,
    updated_at: NOW,
  });
  rawInsert(connection, "events", {
    global_position: 2n,
    event_id: fork.eventId,
    project_id: PROJECT_ID,
    vault_id: VAULT_ID,
    store_id: STORE_ID,
    workspace_id: "c".repeat(64),
    branch_scope_id: null,
    branch_ref: null,
    stream_id: fork.streamId,
    stream_type: "session",
    stream_version: 1n,
    event_type: fork.eventType,
    event_schema_version: 1n,
    session_id: childSessionId,
    parent_session_id: rootSessionId,
    actor_role: "primary",
    agent_id: "agent-1",
    client_instance_id: "client-1",
    correlation_id: fork.correlationId,
    causation_id: null,
    command_id: fork.commandId,
    idempotency_key: fork.idempotencyKey,
    command_event_index: 0n,
    occurred_at: fork.occurredAt,
    recorded_at: NOW,
    visibility_scope: "session",
    confidence: "high",
    verification_status: "verified",
    source_refs_json: "[]",
    evidence_refs_json: "[]",
    evidence_digests_json: "[]",
    payload_json: canonicalJson(fork.payload),
    payload_hash: H64,
    previous_global_hash: H64,
    event_hash: H64,
    lifecycle_intent_json: null,
  });
  new SessionAuthorityRepository().insertChild(
    connection,
    childAuthority,
  );
  const storedFork = Object.freeze({
    globalPosition: 2n,
    eventId: fork.eventId,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: "c".repeat(64),
    branchScopeId: null,
    branchRef: null,
    streamId: fork.streamId,
    streamType: "session",
    streamVersion: 1n,
    eventType: fork.eventType,
    eventSchemaVersion: 1,
    sessionId: childSessionId,
    parentSessionId: rootSessionId,
    actorRole: "primary",
    agentId: "agent-1",
    clientInstanceId: "client-1",
    correlationId: fork.correlationId,
    causationId: null,
    commandId: fork.commandId,
    idempotencyKey: fork.idempotencyKey,
    commandEventIndex: 0,
    occurredAt: fork.occurredAt,
    recordedAt: NOW,
    visibilityScope: "session",
    confidence: "high",
    verificationStatus: "verified",
    sourceRefs: Object.freeze([]),
    evidenceRefs: Object.freeze([]),
    evidenceDigests: Object.freeze([]),
    payload: fork.payload,
    payloadJson: canonicalJson(fork.payload),
    payloadHash: H64,
    previousGlobalHash: H64,
    eventHash: H64,
    lifecycleIntentJson: null,
  }) as unknown as StoredEvent;
  new SqliteLifecycleProjectionRepository(connection).append(Object.freeze({
    events: Object.freeze([storedFork]),
    storedResponse: Object.freeze({
      eventIds: Object.freeze([storedFork.eventId]),
      firstGlobalPosition: "2",
      lastGlobalPosition: "2",
      finalStreamVersion: "1",
      response: Object.freeze({ seeded: true }),
    }),
    responseHash: H64,
  }), projectionSeedTransaction());
}

function seedTransferredChildTicket(
  connection: SqliteConnection,
  claimed = false,
): {
  readonly childSessionId: string;
  readonly checkpointId: string;
  readonly transferTicketId: string;
} {
  const childSessionId = indexedUuid(926_001);
  const checkpointId = indexedUuid(926_002);
  const transferTicketId = indexedUuid(926_003);
  const checkpoint = checkpointFixture({
    checkpointId: checkpointId as never,
    sessionId: childSessionId as never,
    parentSessionId: SESSION_ID as never,
    baseEventPosition: "2",
    checkpointEventPosition: "3",
  });
  const checkpointFingerprint = createHash("sha256")
    .update("project-memory/checkpoint/v1\n", "utf8")
    .update(canonicalJson(checkpoint), "utf8")
    .digest("hex");
  const transferred = childAuthorityFixture(childSessionId, SESSION_ID, {
    semanticState: "transferred",
    childCapabilityGeneration: null,
    directAccessEnabled: false,
    childHandleCapabilityVersion: null,
    childHandleKeyId: null,
    childHandleIssueNonce: null,
    childHandleIssuedAt: null,
    childHandlePolicyCode: null,
    childHandleExpiryKind: null,
    childHandleExpiresAt: null,
    childHandleActorRole: null,
    childHandleClientInstanceId: null,
    childHandleVerifier: null,
    childHandleIssuanceId: null,
    authorityEventPosition: 5n,
    latestCheckpointId: checkpointId,
    latestCheckpointEventPosition: 3n,
    latestCheckpointFingerprint: checkpointFingerprint,
    terminalEventPosition: 5n,
    terminalEventType: "ChildWorkTransferCreated",
    terminalAt: NOW,
  });
  const eventOptions = {
    projectId: PROJECT_ID as never,
    vaultId: VAULT_ID as never,
    storeId: STORE_ID as never,
    workspaceId: "c".repeat(64) as never,
    sessionId: childSessionId as never,
    parentSessionId: SESSION_ID as never,
    streamId: `session/${childSessionId}`,
    correlationId: indexedUuid(926_004),
  };
  const fork = lifecycleEvent(1, "SessionForked", {}, {
    ...eventOptions,
    globalPosition: 2,
    streamVersion: 1,
  });
  const checkpointEvent = lifecycleEvent(2, "SessionCheckpointRecorded", {
    checkpoint,
    baseEventPosition: "2",
    checkpointEventPosition: "3",
  }, {
    ...eventOptions,
    globalPosition: 3,
    streamVersion: 2,
  });
  const suspended = lifecycleEvent(3, "ChildSessionSuspended", {
    checkpointId: checkpointId as never,
    blockers: [],
    followUps: [],
    authorityCommitment: H64,
  }, {
    ...eventOptions,
    globalPosition: 4,
    streamVersion: 3,
    authorityCommitment: H64,
  });
  const transfer = lifecycleEvent(4, "ChildWorkTransferCreated", {
    transferTicketId: transferTicketId as never,
    checkpointId: checkpointId as never,
    authorityCommitment: transferred.authorityCommitment,
  }, {
    ...eventOptions,
    globalPosition: 5,
    streamVersion: 4,
    authorityCommitment: transferred.authorityCommitment,
  });
  rawInsert(connection, "streams", {
    project_id: PROJECT_ID,
    stream_id: `session/${childSessionId}`,
    stream_type: "session",
    current_version: 4n,
    created_at: NOW,
    updated_at: NOW,
  });
  for (const event of [fork, checkpointEvent, suspended, transfer]) {
    rawLifecycleSessionEvent(connection, event);
  }
  new SessionAuthorityRepository().insertChild(connection, transferred);
  rawInsert(connection, "child_transfer_tickets", {
    project_id: PROJECT_ID,
    transfer_ticket_id: transferTicketId,
    source_parent_session_id: SESSION_ID,
    source_child_session_id: childSessionId,
    source_assignment_json: "{}",
    source_scope_json: "{}",
    checkpoint_id: checkpointId,
    follow_ups_json: "[]",
    source_state_json: "{}",
    lineage_json: "{}",
    created_event_position: 5n,
    created_at: NOW,
    claimed_by_root_session_id: claimed ? SESSION_ID : null,
    claimed_child_session_id: claimed ? indexedUuid(926_005) : null,
    claimed_event_position: claimed ? 6n : null,
    claimed_at: claimed ? NOW : null,
  });
  return { childSessionId, checkpointId, transferTicketId };
}

function faultingConnection(
  connection: SqliteConnection,
  sqlMarker: string,
  when: "before" | "after" = "before",
  occurrence = 1,
): SqliteConnection {
  let injected = false;
  let matches = 0;
  return {
    exec(sql) {
      connection.exec(sql);
    },
    prepare(sql) {
      const statement = connection.prepare(sql);
      const wrapped: SqliteStatement = {
        run(params) {
          const matchesBoundary = sql.includes(sqlMarker);
          if (matchesBoundary) matches += 1;
          if (!injected && matchesBoundary && matches === occurrence && when === "before") {
            injected = true;
            throw new Error(`injected:${sqlMarker}`);
          }
          const result = statement.run(params);
          if (!injected && matchesBoundary && matches === occurrence && when === "after") {
            injected = true;
            throw new Error(`injected:${sqlMarker}`);
          }
          return result;
        },
        get(params) {
          return statement.get(params);
        },
        all(params) {
          return statement.all(params);
        },
        iterate(params) {
          return statement.iterate(params);
        },
      };
      return wrapped;
    },
    close() {
      connection.close();
    },
  };
}

function recordingConnection(
  connection: SqliteConnection,
  statements: string[],
): SqliteConnection {
  return {
    exec(sql) {
      connection.exec(sql);
    },
    prepare(sql) {
      statements.push(sql.trim().replace(/\s+/g, " "));
      return connection.prepare(sql);
    },
    close() {
      connection.close();
    },
  };
}

function context(
  actorRole: "primary" | "untrusted" = "primary",
  clientInstanceId = "client-1",
): ProjectContext {
  const workspace = {
    kind: "non-git" as const,
    workspaceRoot: "C:\\evidence-coverage",
    workspaceId: "c".repeat(64) as never,
  };
  return {
    binding: {
      projectBindingId: "evidence-coverage-binding",
      generation: 1,
      contextFingerprint: H64,
      source: "explicit-cli",
      projectId: PROJECT_ID,
      vaultId: VAULT_ID,
      storeId: STORE_ID,
      workspaceId: workspace.workspaceId,
      clientNamespace: "client-1",
      clientInstanceId,
      actorRole,
      projectRoot: "C:\\evidence-coverage",
      vaultRoot: "C:\\evidence-coverage\\memory",
      descriptorPath: "C:\\evidence-coverage\\memory\\.project-memory.json",
      storeRoute: {
        kind: "local",
        storeRoot: "C:\\evidence-coverage\\.project-memory",
        eventsPath: "C:\\evidence-coverage\\.project-memory\\events.sqlite",
        storeManifestPath: "C:\\evidence-coverage\\.project-memory\\store.json",
        projectionManifestPath: "C:\\evidence-coverage\\.project-memory\\projection.json",
      },
      workspace,
      establishedAt: NOW,
    },
    workspace,
    checkedAt: NOW,
  } as unknown as ProjectContext;
}

function command(
  overrides: Partial<RecordEvidenceBatchCommandV2> = {},
): RecordEvidenceBatchCommandV2 {
  return {
    commandType: "record-evidence-batch",
    commandId: "88888888-8888-4888-8888-888888888888",
    idempotencyKey: "evidence-batch-1",
    agentId: "agent-1",
    expectedProjectId: PROJECT_ID as never,
    expectedVaultId: VAULT_ID as never,
    expectedWorkspaceId: "c".repeat(64) as never,
    expectedBranchRef: null,
    adapterSessionId: ADAPTER_ID as never,
    batchId: BATCH_ID as never,
    sessionId: SESSION_ID as never,
    firstOrdinal: "5",
    lastOrdinal: "5",
    fingerprintSchemaVersion: 1,
    fingerprintKeyId: "key-1",
    fingerprintDomain: "pm-evidence-frame-v1",
    redactionStatus: "content-not-retained",
    frames: [{
      frameId: FRAME_ID as never,
      ordinal: "5",
      sourceKind: "model-turn",
      observedAt: NOW,
      contentFingerprint: FRAME_H64,
    }],
    ...overrides,
  };
}

function evidenceAuthorization(
  input: {
    readonly authorizationSessionId?: string;
    readonly targetSessionId?: string;
    readonly actorRole?: "primary" | "untrusted";
    readonly clientInstanceId?: string;
    readonly proofDigest?: string;
  } = {},
): PersistedLifecycleAuthorizationRecord {
  const actorRole = input.actorRole ?? "primary";
  const clientInstanceId = input.clientInstanceId ?? "client-1";
  return {
    kind: "protected",
    proof: {
      version: 1,
      nonce: indexedUuid(900_001),
      digest: input.proofDigest ?? H64,
    },
    approval: null,
    authorizationSessionId: input.authorizationSessionId ?? SESSION_ID,
    targetSessionId: input.targetSessionId ?? SESSION_ID,
    presenting: { actorRole, clientInstanceId },
    target: { actorRole, clientInstanceId },
  };
}

function evidenceEnvelope(
  semantic: RecordEvidenceBatchCommandV2,
  authorization = evidenceAuthorization(),
  capabilityKind: "root-session-handle" | "child-session-handle" = "root-session-handle",
  capabilityGeneration = "1",
  projectContext = context(),
): LifecycleCommandEnvelope {
  const assertions = {
    authorizationKind: "protected" as const,
    authorizationSessionId: authorization.authorizationSessionId,
    targetSessionId: authorization.targetSessionId,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: "c".repeat(64),
    clientNamespace: projectContext.binding.clientNamespace,
    capabilityKind,
    capabilityGeneration,
    presentingActorRole: authorization.presenting.actorRole,
    presentingClientInstanceId: authorization.presenting.clientInstanceId,
    targetActorRole: authorization.target.actorRole,
    targetClientInstanceId: authorization.target.clientInstanceId,
    internalWorkflowId: null,
    internalWorkflowGeneration: null,
    internalPlannedWorkId: null,
  };
  const witness = buildLifecycleIntentWitness(semantic, assertions);
  return {
    context: projectContext,
    commandId: semantic.commandId,
    idempotencyKey: semantic.idempotencyKey,
    commandType: semantic.commandType,
    candidateIntentHash: witness.intentHash,
    authoritativeIntentHash: witness.intentHash,
    semanticCommand: semantic,
    capabilityKind,
    capabilityGeneration: null,
    capabilityGenerationResolution: "fresh-commit",
    replayExpectation: authorization as LifecycleReplayExpectation,
  };
}

function targetAuthority(
  input: {
    readonly sessionId?: string;
    readonly sessionKind?: "root" | "child";
    readonly parentSessionId?: string | null;
    readonly ownerGeneration?: bigint | null;
    readonly childCapabilityGeneration?: bigint | null;
  } = {},
): SessionAuthorityRecord {
  const sessionId = input.sessionId ?? SESSION_ID;
  const sessionKind = input.sessionKind ?? "root";
  const base: SessionAuthorityRecord = sessionKind === "root"
    ? rootAuthorityFixture({
        sessionId,
        streamId: `session/${sessionId}`,
      })
    : childAuthorityFixture(
        sessionId,
        input.parentSessionId ?? SESSION_ID,
      );
  return Object.freeze({
    ...base,
    ...(Object.hasOwn(input, "parentSessionId")
      ? { parentSessionId: input.parentSessionId ?? null }
      : {}),
    ...(Object.hasOwn(input, "ownerGeneration")
      ? { ownerGeneration: input.ownerGeneration ?? null }
      : {}),
    ...(Object.hasOwn(input, "childCapabilityGeneration")
      ? { childCapabilityGeneration: input.childCapabilityGeneration ?? null }
      : {}),
  }) as SessionAuthorityRecord;
}

function targetAggregate(
  authority = targetAuthority(),
  streamVersion = 1n,
  eventPosition = 1n,
): SessionAggregateState {
  const record = authority as unknown as {
    sessionId: string;
    streamId: string;
    sessionKind: "root" | "child";
    parentSessionId: string | null;
    ownerGeneration: bigint | null;
    childCapabilityGeneration: bigint | null;
  };
  return {
    kind: record.sessionKind,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: "c".repeat(64),
    sessionId: record.sessionId,
    streamId: record.streamId,
    parentSessionId: record.parentSessionId,
    streamVersion,
    eventPosition,
    terminalEventPosition: null,
    correlationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ...(record.sessionKind === "root"
      ? { ownerGeneration: Number(record.ownerGeneration) }
      : { childCapabilityGeneration: record.childCapabilityGeneration?.toString() ?? null }),
  } as SessionAggregateState;
}

function frozenCheckpointPayload(
  checkpointId = indexedUuid(710_005),
  childSummaries: readonly unknown[] = [],
  checkpointEventPosition = "2",
): Readonly<Record<string, unknown>> {
  const baseCheckpoint = checkpointFixture({
    sessionId: SESSION_ID as never,
    checkpointId: checkpointId as never,
    baseEventPosition: "1",
    checkpointEventPosition,
  });
  const checkpoint = {
    ...baseCheckpoint,
    sourceState: {
      ...baseCheckpoint.sourceState,
      workspaceId: "c".repeat(64),
    },
    checkpointVersion: 2,
    childSummaries,
    evidenceCoverage: {
      coverageVersion: 2,
      captureMode: "coverage-only",
      contentRetained: false,
      adapterSessions: [],
    },
  };
  return {
    checkpoint,
    baseEventPosition: "1",
    checkpointEventPosition,
    finalCheckpointBindingVersion: 1,
    workflowId: sessionEndWorkflowId(SESSION_ID as never),
    workflowGeneration: 1,
  };
}

function frozenWorkflowResult(
  checkpointId = indexedUuid(710_005),
  checkpointEventPosition = "2",
): Readonly<Record<string, unknown>> {
  return {
    resultVersion: 2,
    sessionId: SESSION_ID,
    workflowId: sessionEndWorkflowId(SESSION_ID as never),
    workflowGeneration: 1,
    phase: "final-checkpoint-recorded",
    priorRootState: "active",
    triggeringEventPosition: "1",
    finalCheckpointId: checkpointId,
    finalCheckpointEventPosition: checkpointEventPosition,
    evidenceWindow: {
      evidenceWindowState: "sealed",
      evidenceFrozenCheckpointEventPosition: checkpointEventPosition,
      evidenceFrozenGeneration: 1,
    },
    validationPlansReady: false,
    qualityScore: null,
    safeFailureCode: null,
    materializationRequired: false,
  };
}

function realEvidenceStoreFixture(
  input: {
    readonly semantic?: RecordEvidenceBatchCommandV2;
    readonly repositoryConnection?: SqliteConnection;
    readonly seed?: boolean;
    readonly streamVersion?: bigint;
    readonly eventPosition?: bigint;
    readonly eventIdStart?: number;
    readonly projectContext?: ProjectContext;
    readonly authorization?: PersistedLifecycleAuthorizationRecord;
    readonly envelopeAuthorization?: PersistedLifecycleAuthorizationRecord;
    readonly authorizationAuthority?: ReturnType<typeof targetAuthority>;
    readonly targetAuthority?: ReturnType<typeof targetAuthority>;
    readonly targetAggregate?: ReturnType<typeof targetAggregate>;
    readonly capabilityKind?: "root-session-handle" | "child-session-handle";
    readonly freshCapabilityGeneration?: string;
    readonly envelopeCapabilityGeneration?: string;
    readonly seedChildSessionId?: string;
  } = {},
) {
  const connection = input.repositoryConnection ?? database();
  if (input.seed !== false) {
    rawGenericSessionEvent(connection, 1n);
    seedAuthorityForForeignKeys(connection, 1n);
    if (input.seedChildSessionId !== undefined) {
      seedChildAuthorityForForeignKeys(connection, input.seedChildSessionId);
    }
  }
  const semantic = input.semantic ?? command();
  const projectContext = input.projectContext ?? context();
  const authorization = input.authorization ?? evidenceAuthorization();
  const target = input.targetAuthority ?? targetAuthority({
    sessionId: semantic.sessionId,
  });
  const authorizationAuthority = input.authorizationAuthority ?? target;
  const aggregate = input.targetAggregate ?? targetAggregate(
    target,
    input.streamVersion ?? 1n,
    input.eventPosition ?? 1n,
  );
  const recorder = providerRecorder();
  const repository = new EvidenceCoverageRepository(recorder.provider);
  const authorityRepository = new SessionAuthorityRepository();
  const transferRepository = new ChildTransferRepository();
  const preparedEndingScopeBindings: FinalEndingScopeBindingV1[][] = [];
  let eventId = input.eventIdStart ?? 950_000;
  const events = new EventAppendTransaction(
    connection,
    new SqliteEventAppendStatements(connection),
    new MaintenanceFence(),
    new BranchScopeRepository(),
    () => indexedUuid(eventId++),
  );
  const service = new EvidenceCoverageService({
    invocationScope: {
      current: () => ({
        context: projectContext,
        authorizationRecord: authorization,
        freshCapabilityGeneration: input.freshCapabilityGeneration ?? "1",
        authorizationAuthority,
        targetAuthority: target,
        targetAggregate: aggregate,
        occurredAt: NOW,
      }),
    },
  });
  const boundCoverage = connectionBoundEvidenceCoverage(connection, repository);
  const store = new LifecycleCommandStore({
    connection,
    events,
    projectionWriter: new SqliteLifecycleProjectionRepository(connection),
    transaction: () => ({
      authority: {
        nextGlobalPosition: () => (
          connection.prepare(
            "SELECT COALESCE(max(global_position), 0) + 1 AS position FROM events",
          ).get()!.position as bigint
        ),
        get: (projectId: string, sessionId: string) =>
          authorityRepository.get(connection, projectId, sessionId),
        listNonterminalChildEndingScopeProjectionsBounded: (
          projectId: string,
          rootSessionId: string,
          limit: number,
        ) => authorityRepository.listNonterminalChildEndingScopeProjectionsBounded(
          connection,
          projectId,
          rootSessionId,
          limit,
        ),
      },
      leases: {},
      approvals: {},
      transfers: {
        listUnclaimedEndingScopeProjectionsBySourceRoot: (
          projectId: string,
          sourceParentSessionId: string,
          limit: number,
        ) => transferRepository.listUnclaimedEndingScopeProjectionsBySourceRoot(
          connection,
          projectId,
          sourceParentSessionId,
          limit,
        ),
      },
      coverage: {
        ...boundCoverage,
        prepareBatch: (
          preparedInput: Parameters<typeof boundCoverage.prepareBatch>[0],
        ) => {
          preparedEndingScopeBindings.push(
            preparedInput.prospectiveEndingScopeBindings.map((binding) => ({
              ...binding,
            })),
          );
          return boundCoverage.prepareBatch(preparedInput);
        },
      },
      workflows: {},
      validation: {},
      outbox: {},
    }),
    now: () => NOW,
  });
  return {
    connection,
    semantic,
    recorder,
    repository,
    preparedEndingScopeBindings,
    service,
    store,
    envelope: evidenceEnvelope(
      semantic,
      input.envelopeAuthorization ?? authorization,
      input.capabilityKind ?? "root-session-handle",
      input.envelopeCapabilityGeneration
        ?? input.freshCapabilityGeneration
        ?? "1",
      projectContext,
    ),
  };
}

function validPreparedEventPayload(
  semantic: RecordEvidenceBatchCommandV2 = command(),
): Readonly<Record<string, unknown>> {
  return {
    adapterSessionId: semantic.adapterSessionId,
    batchId: semantic.batchId,
    batchFirstOrdinal: semantic.firstOrdinal,
    batchLastOrdinal: semantic.lastOrdinal,
    coverageFirstOrdinal: "0",
    coverageLastOrdinal: semantic.lastOrdinal,
    highestContiguousOrdinal: null,
    missingIntervals: [{ firstOrdinal: "0", lastOrdinal: "4" }],
    frameFingerprintAlgorithm: "hmac-sha256",
    frameFingerprintSchemaVersion: 1,
    frameFingerprintKeyId: semantic.fingerprintKeyId,
    frameFingerprintDomain: "pm-evidence-frame-v1",
    coverageFingerprintAlgorithm: "hmac-sha256",
    coverageFingerprintSchemaVersion: 1,
    coverageFingerprintKeyId: semantic.fingerprintKeyId,
    coverageFingerprintDomain: "pm-evidence-coverage-v1",
    coverageFingerprint: H64,
    captureMode: "coverage-only",
    contentRetained: false,
    frames: semantic.frames.map((frame) => ({ ...frame })),
  };
}

function directEvidenceServiceFixture(
  payload: Readonly<Record<string, unknown>>,
  semantic: RecordEvidenceBatchCommandV2 = command(),
) {
  const authority = targetAuthority();
  const aggregate = targetAggregate(authority);
  const handle = Symbol("direct-prepared-evidence");
  let persistCalls = 0;
  const transaction = {
    authority: {
      nextGlobalPosition: () => 2n,
      get: () => authority,
      listNonterminalChildEndingScopeProjectionsBounded: () => [],
    },
    leases: {},
    approvals: {},
    transfers: { listUnclaimedEndingScopeProjectionsBySourceRoot: () => [] },
    coverage: {
      assertEvidenceWindowWritable: () => undefined,
      assertQuickHealthy: () => undefined,
      registerAffectedExistingSessions: () => undefined,
      assertVersion1Eligible: () => undefined,
      prepareBatch: () => ({
        handle,
        sessionId: semantic.sessionId,
        adapterSessionId: semantic.adapterSessionId,
        eventPayload: payload,
      }),
      persistPrepared: () => { persistCalls += 1; },
      snapshotV2: () => { throw new Error("not used"); },
      minimumCheckpointUpperBound: () => 0,
      minimumFinalEndingScopeBindingsUpperBound: () => 0,
    },
    workflows: {},
    validation: {},
    outbox: {},
  } as unknown as LifecycleCommandTransaction;
  const service = new EvidenceCoverageService({
    invocationScope: {
      current: () => ({
        context: context(),
        authorizationRecord: evidenceAuthorization(),
        freshCapabilityGeneration: "1",
        authorizationAuthority: authority,
        targetAuthority: authority,
        targetAggregate: aggregate,
        occurredAt: NOW,
      }),
    },
  });
  return {
    record: () => service.record(transaction, semantic),
    persistCalls: () => persistCalls,
  };
}

interface ProviderRecorder {
  readonly provider: {
    currentKey(
      scope: { projectId: string; storeId: string },
      purpose: "evidence-fingerprint",
    ): { keyId: string };
    status(
      scope: { projectId: string; storeId: string },
      purpose: "evidence-fingerprint",
      keyId: string,
    ): "available" | "revoked" | "unavailable";
    fingerprint(input: {
      projectId: string;
      storeId: string;
      purpose: "evidence-fingerprint";
      keyId: string;
      domain: string;
      bytes: Uint8Array;
    }): string;
  };
  readonly calls: { currentKey: number; status: number; fingerprint: number };
  readonly statusInputs: {
    scope: { projectId: string; storeId: string };
    purpose: string;
    keyId: string;
  }[];
  readonly fingerprintInputs: {
    projectId: string;
    storeId: string;
    purpose: string;
    keyId: string;
    domain: string;
    bytes: Uint8Array;
    body: unknown;
  }[];
}

function providerRecorder(
  fingerprintFailure?: Error,
  statusResult: "available" | "revoked" | "unavailable" = "available",
  currentKeyId = "key-1",
): ProviderRecorder {
  const calls = { currentKey: 0, status: 0, fingerprint: 0 };
  const statusInputs: ProviderRecorder["statusInputs"][number][] = [];
  const fingerprintInputs: ProviderRecorder["fingerprintInputs"][number][] = [];
  return {
    calls,
    statusInputs,
    fingerprintInputs,
    provider: {
      currentKey(scope, purpose) {
        calls.currentKey += 1;
        assert.deepEqual(scope, { projectId: PROJECT_ID, storeId: STORE_ID });
        assert.equal(purpose, "evidence-fingerprint");
        return { keyId: currentKeyId };
      },
      status(scope, purpose, keyId) {
        calls.status += 1;
        statusInputs.push({ scope, purpose, keyId });
        return statusResult;
      },
      fingerprint(input) {
        calls.fingerprint += 1;
        fingerprintInputs.push({
          ...input,
          bytes: input.bytes,
          body: JSON.parse(Buffer.from(input.bytes).toString("utf8")),
        });
        if (fingerprintFailure !== undefined) throw fingerprintFailure;
        return H64;
      },
    },
  };
}

function isDeepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every(isDeepFrozen);
}

function storedEvent(
  connection: SqliteConnection,
  payload: Readonly<Record<string, unknown>>,
  overrides: Partial<StoredEvent> = {},
): StoredEvent {
  const payloadJson = canonicalJson(payload);
  const globalPosition = overrides.globalPosition ?? 1n;
  const sessionId = overrides.sessionId ?? SESSION_ID;
  const streamId = overrides.streamId ?? `session/${sessionId}`;
  const eventId = overrides.eventId
    ?? (globalPosition === 1n
      ? "99999999-9999-4999-8999-999999999999"
      : "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2");
  const commandId = overrides.commandId
    ?? "88888888-8888-4888-8888-888888888888";
  const idempotencyKey = overrides.idempotencyKey ?? "evidence-batch-1";
  const streamVersion = overrides.streamVersion ?? globalPosition;
  rawInsert(connection, "events", {
    global_position: globalPosition,
    event_id: eventId,
    project_id: PROJECT_ID,
    vault_id: VAULT_ID,
    store_id: STORE_ID,
    workspace_id: "c".repeat(64),
    branch_scope_id: null,
    branch_ref: null,
    stream_id: streamId,
    stream_type: "session",
    stream_version: streamVersion,
    event_type: "EvidenceCoverageRecorded",
    event_schema_version: 2,
    session_id: sessionId,
    parent_session_id: null,
    actor_role: "primary",
    agent_id: "agent-1",
    client_instance_id: "client-1",
    correlation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    causation_id: null,
    command_id: commandId,
    idempotency_key: idempotencyKey,
    command_event_index: 0,
    occurred_at: NOW,
    recorded_at: NOW,
    visibility_scope: "session",
    confidence: "high",
    verification_status: "verified",
    source_refs_json: "[]",
    evidence_refs_json: "[]",
    evidence_digests_json: "[]",
    payload_json: payloadJson,
    payload_hash: H64,
    previous_global_hash: "0".repeat(64),
    event_hash: H64,
    lifecycle_intent_json: null,
  });
  return {
    globalPosition,
    eventId,
    projectId: PROJECT_ID as never,
    vaultId: VAULT_ID as never,
    storeId: STORE_ID as never,
    workspaceId: "c".repeat(64) as never,
    branchScopeId: null,
    branchRef: null,
    streamId,
    streamType: "session",
    streamVersion,
    eventType: "EvidenceCoverageRecorded",
    eventSchemaVersion: 2,
    sessionId,
    parentSessionId: null,
    actorRole: "primary",
    agentId: "agent-1",
    clientInstanceId: "client-1",
    correlationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    causationId: null,
    commandId,
    idempotencyKey,
    commandEventIndex: 0,
    occurredAt: NOW,
    recordedAt: NOW,
    visibilityScope: "session",
    confidence: "high",
    verificationStatus: "verified",
    sourceRefs: [],
    evidenceRefs: [],
    evidenceDigests: [],
    payload: payload as never,
    payloadJson,
    payloadHash: H64,
    previousGlobalHash: "0".repeat(64),
    eventHash: H64,
    lifecycleIntentJson: null,
    ...overrides,
  };
}

afterEach(() => {
  while (connections.length > 0) connections.pop()!.close();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("evidence coverage accumulator", () => {
  it("advances one adapter accumulator without rescanning historical ordinals", () => {
    const firstAboveZero = advanceEvidenceCoverageIntervals({
      priorCoverageLastOrdinal: null,
      priorMissingIntervals: [],
      newOrdinals: [5n],
    });

    assert.equal(firstAboveZero.coverageLastOrdinal, "5");
    assert.equal(firstAboveZero.highestContiguousOrdinal, null);
    assert.deepEqual(firstAboveZero.missingIntervals, [
      { firstOrdinal: "0", lastOrdinal: "4" },
    ]);

    const gapFill = advanceEvidenceCoverageIntervals({
      priorCoverageLastOrdinal: 5n,
      priorMissingIntervals: [{ firstOrdinal: 0n, lastOrdinal: 4n }],
      newOrdinals: [0n, 2n, 1n],
    });

    assert.equal(gapFill.coverageLastOrdinal, "5");
    assert.equal(gapFill.highestContiguousOrdinal, "2");
    assert.deepEqual(gapFill.missingIntervals, [
      { firstOrdinal: "3", lastOrdinal: "4" },
    ]);
  });

  it("handles bigint adjacency without converting ordinals to numbers", () => {
    const maximum = 9_223_372_036_854_775_807n;
    const result = advanceEvidenceCoverageIntervals({
      priorCoverageLastOrdinal: maximum - 2n,
      priorMissingIntervals: [{
        firstOrdinal: maximum - 2n,
        lastOrdinal: maximum - 2n,
      }],
      newOrdinals: [maximum - 2n, maximum],
    });

    assert.equal(result.coverageLastOrdinal, maximum.toString());
    assert.deepEqual(result.missingIntervals, [{
      firstOrdinal: (maximum - 1n).toString(),
      lastOrdinal: (maximum - 1n).toString(),
    }]);
  });

  it("preserves a bounded interval projection when a batch adds no ordinals", () => {
    const result = advanceEvidenceCoverageIntervals({
      priorCoverageLastOrdinal: 9n,
      priorMissingIntervals: [
        { firstOrdinal: 2n, lastOrdinal: 3n },
        { firstOrdinal: 7n, lastOrdinal: 8n },
      ],
      newOrdinals: [],
    });

    assert.equal(result.coverageLastOrdinal, "9");
    assert.equal(result.highestContiguousOrdinal, "1");
    assert.deepEqual(result.missingIntervals, [
      { firstOrdinal: "2", lastOrdinal: "3" },
      { firstOrdinal: "7", lastOrdinal: "8" },
    ]);
  });

  it("rejects adapter interval and byte limits before provider work", () => {
    const emptyCoverage: CheckpointEvidenceCoverageV2 = {
      coverageVersion: 2,
      captureMode: "coverage-only",
      contentRetained: false,
      adapterSessions: [],
    };

    assert.throws(
      () => assertEvidenceCoverageProjectionBounds({
        prospectiveAdapterCount: 201,
        prospectiveTotalIntervalCount: 0,
        targetIntervalCount: 0,
        evidenceCoverage: emptyCoverage,
      }),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "EVIDENCE_ADAPTER_SESSION_LIMIT"
      ),
    );

    assert.throws(
      () => assertEvidenceCoverageProjectionBounds({
        prospectiveAdapterCount: 1,
        prospectiveTotalIntervalCount: 201,
        targetIntervalCount: 201,
        evidenceCoverage: emptyCoverage,
      }),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "EVIDENCE_COVERAGE_TOO_FRAGMENTED"
      ),
    );

    const oversizedCoverage: CheckpointEvidenceCoverageV2 = {
      ...emptyCoverage,
      adapterSessions: [{
        adapterSessionId: "11111111-1111-4111-8111-111111111111" as never,
        coverageFirstOrdinal: "0",
        coverageLastOrdinal: "0",
        highestContiguousOrdinal: "0",
        missingIntervals: [],
        frameFingerprintAlgorithm: "hmac-sha256",
        frameFingerprintSchemaVersion: 1,
        frameFingerprintKeyId: "x".repeat(196_608),
        frameFingerprintDomain: "pm-evidence-frame-v1",
        coverageFingerprintAlgorithm: "hmac-sha256",
        coverageFingerprintSchemaVersion: 1,
        coverageFingerprintKeyId: "x".repeat(196_608),
        coverageFingerprintDomain: "pm-evidence-coverage-v1",
        coverageFingerprint: "a".repeat(64),
        latestBatchId: "22222222-2222-4222-8222-222222222222" as never,
        latestBatchEventPosition: "1",
      }],
    };
    assert.throws(
      () => assertEvidenceCoverageProjectionBounds({
        prospectiveAdapterCount: 1,
        prospectiveTotalIntervalCount: 0,
        targetIntervalCount: 0,
        evidenceCoverage: oversizedCoverage,
      }),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "EVIDENCE_COVERAGE_SNAPSHOT_TOO_LARGE"
      ),
    );
  });
});

describe("evidence coverage repository", () => {
  it("allows only strict writable session-end evidence windows for roots and descendants", () => {
    const connection = database();
    rawGenericSessionEvent(connection, 1n);
    seedAuthorityForForeignKeys(connection, 1n);
    const childSessionId = indexedUuid(710_001);
    rawInsert(connection, "session_authority", {
      project_id: PROJECT_ID,
      session_id: childSessionId,
      stream_id: `session/${childSessionId}`,
      session_kind: "child",
      parent_session_id: SESSION_ID,
      workspace_id: "c".repeat(64),
      client_namespace: "client-1",
      semantic_state: "active",
      owner_generation: null,
      child_capability_generation: 1n,
      direct_access_enabled: 1n,
      authority_commitment: "f".repeat(64),
      authority_event_position: 1n,
      created_at: NOW,
      updated_at: NOW,
    });
    const facade = connectionBoundEvidenceCoverage(
      connection,
      new EvidenceCoverageRepository(providerRecorder().provider),
    );
    assert.doesNotThrow(() => facade.assertEvidenceWindowWritable(SESSION_ID as never));
    assert.doesNotThrow(() => facade.assertEvidenceWindowWritable(childSessionId as never));

    connection.exec("DROP TRIGGER workflow_instances_lifecycle_insert_guard");
    connection.exec("DROP TRIGGER workflow_instances_lifecycle_update_guard");
    connection.exec("DROP TRIGGER workflow_instances_evidence_v3_insert_guard");
    connection.exec("DROP TRIGGER events_final_checkpoint_v4_guard");
    connection.exec("DROP TRIGGER workflow_instances_evidence_v3_update_guard");
    rawInsert(connection, "workflow_instances", {
      project_id: PROJECT_ID,
      workflow_id: sessionEndWorkflowId(SESSION_ID as never),
      workflow_type: "session-end",
      generation: 1n,
      state: "active",
      phase: "requested",
      root_command_id: "root-command",
      result_json: null,
      error_code: null,
      created_at: NOW,
      updated_at: NOW,
      session_id: SESSION_ID,
      triggering_event_position: 1n,
      expected_authority_commitment: H64,
      coordinator_owner_id: null,
      coordinator_claim_token: null,
      coordinator_claim_expires_at: null,
      coordinator_attempt_count: 0n,
      coordinator_failure_class: null,
      coordinator_error_code: null,
      coordinator_next_attempt_at: null,
      validation_attempt_plan_generation: null,
      validation_attempt_plans_json: null,
      evidence_frozen_checkpoint_event_position: null,
      evidence_frozen_generation: null,
      evidence_window_state: "open",
      final_ending_scope_bindings_json: null,
    });
    assert.doesNotThrow(() => facade.assertEvidenceWindowWritable(SESSION_ID as never));
    assert.doesNotThrow(() => facade.assertEvidenceWindowWritable(childSessionId as never));
    connection.prepare(`
      UPDATE workflow_instances
      SET evidence_window_state = 'sealed'
    `).run();
    assert.doesNotThrow(() => facade.assertEvidenceWindowWritable(SESSION_ID as never));

    connection.prepare(`
      UPDATE workflow_instances
      SET phase = 'final-checkpoint-recorded'
    `).run();
    assert.throws(
      () => facade.assertEvidenceWindowWritable(SESSION_ID as never),
      (error: unknown) => (error as { code?: string }).code === "INTEGRITY_FAILURE",
    );

    connection.prepare(`
      UPDATE workflow_instances
      SET phase = 'cancelled',
          evidence_window_state = 'sealed'
    `).run();
    assert.doesNotThrow(() => facade.assertEvidenceWindowWritable(childSessionId as never));

    rawInsert(connection, "events", {
      global_position: 2n,
      event_id: indexedUuid(710_002),
      project_id: PROJECT_ID,
      vault_id: VAULT_ID,
      store_id: STORE_ID,
      workspace_id: "c".repeat(64),
      branch_scope_id: null,
      branch_ref: null,
      stream_id: `session/${SESSION_ID}`,
      stream_type: "session",
      stream_version: 2n,
      event_type: "SessionCheckpointRecorded",
      event_schema_version: 3n,
      session_id: SESSION_ID,
      parent_session_id: null,
      actor_role: "primary",
      agent_id: "agent-1",
      client_instance_id: "client-1",
      correlation_id: indexedUuid(710_003),
      causation_id: null,
      command_id: indexedUuid(710_004),
      idempotency_key: "checkpoint-2",
      command_event_index: 0n,
      occurred_at: NOW,
      recorded_at: NOW,
      visibility_scope: "session",
      confidence: "high",
      verification_status: "verified",
      source_refs_json: "[]",
      evidence_refs_json: "[]",
      evidence_digests_json: "[]",
      payload_json: canonicalJson(frozenCheckpointPayload()),
      payload_hash: H64,
      previous_global_hash: "0".repeat(64),
      event_hash: H64,
      lifecycle_intent_json: null,
    });
    connection.prepare(`
      UPDATE workflow_instances
      SET phase = 'final-checkpoint-recorded',
          evidence_frozen_checkpoint_event_position = 2,
          evidence_frozen_generation = generation,
          final_ending_scope_bindings_json = '[]'
    `).run();
    for (const target of [SESSION_ID, childSessionId]) {
      assert.throws(
        () => facade.assertEvidenceWindowWritable(target as never),
        (error: unknown) => (error as { code?: string }).code
          === "INTEGRITY_FAILURE",
      );
    }

    connection.prepare(`
      UPDATE workflow_instances
      SET result_json = $resultJson
    `).run({
      $resultJson: canonicalJson({
        resultVersion: 2,
        action: "malformed-action",
        progressed: true,
        previousPhase: "requested",
        status: frozenWorkflowResult(),
      }),
    });
    assert.throws(
      () => facade.assertEvidenceWindowWritable(SESSION_ID as never),
      (error: unknown) => (error as { code?: string }).code === "INTEGRITY_FAILURE",
    );

    connection.prepare(`
      UPDATE workflow_instances
      SET result_json = $resultJson
    `).run({ $resultJson: canonicalJson(frozenWorkflowResult()) });
    for (const target of [SESSION_ID, childSessionId]) {
      assert.throws(
        () => facade.assertEvidenceWindowWritable(target as never),
        (error: unknown) => (error as { code?: string }).code
          === "SESSION_END_EVIDENCE_FROZEN",
      );
    }

    connection.prepare(`
      UPDATE workflow_instances
      SET phase = 'requested',
          result_json = $resultJson
    `).run({
      $resultJson: canonicalJson({
        ...frozenWorkflowResult(),
        phase: "requested",
      }),
    });
    assert.throws(
      () => facade.assertEvidenceWindowWritable(SESSION_ID as never),
      (error: unknown) => (error as { code?: string }).code === "INTEGRITY_FAILURE",
    );

    connection.prepare(`
      UPDATE workflow_instances
      SET phase = 'final-checkpoint-recorded',
          result_json = $resultJson
    `).run({
      $resultJson: canonicalJson({
        resultVersion: 2,
        action: "record-final-checkpoint-and-queue-ending",
        progressed: true,
        previousPhase: "requested",
        status: frozenWorkflowResult(),
      }),
    });
    assert.throws(
      () => facade.assertEvidenceWindowWritable(SESSION_ID as never),
      (error: unknown) => (error as { code?: string }).code === "INTEGRITY_FAILURE",
    );

    connection.prepare(`
      UPDATE workflow_instances
      SET triggering_event_position = -1,
          result_json = $resultJson
    `).run({
      $resultJson: canonicalJson({
        ...frozenWorkflowResult(),
        triggeringEventPosition: "-1",
      }),
    });
    assert.throws(
      () => facade.assertEvidenceWindowWritable(SESSION_ID as never),
      (error: unknown) => (error as { code?: string }).code === "INTEGRITY_FAILURE",
    );
    connection.prepare(`
      UPDATE workflow_instances
      SET triggering_event_position = 1,
          result_json = $resultJson
    `).run({ $resultJson: canonicalJson(frozenWorkflowResult()) });

    connection.prepare(`
      UPDATE workflow_instances
      SET final_ending_scope_bindings_json = $bindings
    `).run({ $bindings: canonicalJson([endingBinding(0)]) });
    assert.throws(
      () => facade.assertEvidenceWindowWritable(SESSION_ID as never),
      (error: unknown) => (error as { code?: string }).code === "INTEGRITY_FAILURE",
    );
    connection.prepare(`
      UPDATE workflow_instances
      SET final_ending_scope_bindings_json = '[]'
    `).run();

    connection.exec("DROP TRIGGER events_no_update");
    const strictBinding = endingBinding(0);
    connection.prepare(`
      UPDATE workflow_instances
      SET final_ending_scope_bindings_json = $bindings
    `).run({
      $bindings: canonicalJson([{
        ...strictBinding,
        bindingKind: "bogus",
        transferTicketId: "garbage",
        transferTicketEventPosition: "1",
      }]),
    });
    connection.prepare(`
      UPDATE events
      SET payload_json = $payload
      WHERE global_position = 2
    `).run({
      $payload: canonicalJson(frozenCheckpointPayload(
        indexedUuid(710_005),
        [{
          childSessionId: strictBinding.childSessionId,
          state: strictBinding.childState,
          lastEventPosition: strictBinding.lastEventPosition,
          streamVersion: strictBinding.streamVersion,
          latestCheckpointId: strictBinding.checkpointId,
        }],
      )),
    });
    assert.throws(
      () => facade.assertEvidenceWindowWritable(SESSION_ID as never),
      (error: unknown) => (error as { code?: string }).code === "INTEGRITY_FAILURE",
    );
    connection.prepare(`
      UPDATE workflow_instances
      SET final_ending_scope_bindings_json = '[]'
    `).run();
    connection.prepare(`
      UPDATE events
      SET payload_json = $payload
      WHERE global_position = 2
    `).run({ $payload: canonicalJson(frozenCheckpointPayload()) });

    connection.prepare(`
      UPDATE events
      SET stream_id = $streamId,
          stream_type = 'generic'
      WHERE global_position = 2
    `).run({ $streamId: `generic/${SESSION_ID}` });
    assert.throws(
      () => facade.assertEvidenceWindowWritable(SESSION_ID as never),
      (error: unknown) => (error as { code?: string }).code === "INTEGRITY_FAILURE",
    );
    const malformedStrictCheckpoint = frozenCheckpointPayload() as {
      readonly checkpoint: Readonly<Record<string, unknown>>;
      readonly baseEventPosition: string;
      readonly checkpointEventPosition: string;
    };
    connection.prepare(`
      UPDATE events
      SET stream_id = $streamId,
          stream_type = 'session',
          payload_json = $payload
      WHERE global_position = 2
    `).run({
      $streamId: `session/${SESSION_ID}`,
      $payload: canonicalJson({
        ...malformedStrictCheckpoint,
        checkpoint: {
          ...malformedStrictCheckpoint.checkpoint,
          taskSummary: null,
        },
      }),
    });
    assert.throws(
      () => facade.assertEvidenceWindowWritable(SESSION_ID as never),
      (error: unknown) => (error as { code?: string }).code === "INTEGRITY_FAILURE",
    );
    connection.prepare(`
      UPDATE events
      SET stream_id = $streamId,
          stream_type = 'session',
          payload_json = $payload
      WHERE global_position = 2
    `).run({
      $streamId: `session/${SESSION_ID}`,
      $payload: canonicalJson({
        checkpoint: { checkpointVersion: 2 },
        baseEventPosition: "1",
        checkpointEventPosition: "2",
      }),
    });
    assert.throws(
      () => facade.assertEvidenceWindowWritable(SESSION_ID as never),
      (error: unknown) => (error as { code?: string }).code === "INTEGRITY_FAILURE",
    );
  });

  it("rejects missing child roots and child-to-child ancestry before workflow lookup", () => {
    const connection = database();
    rawGenericSessionEvent(connection, 1n);
    seedAuthorityForForeignKeys(connection, 1n);
    const facade = connectionBoundEvidenceCoverage(
      connection,
      new EvidenceCoverageRepository(providerRecorder().provider),
    );
    const malformedParentId = indexedUuid(711_001);
    const targetChildId = indexedUuid(711_002);
    rawInsert(connection, "session_authority", {
      project_id: PROJECT_ID,
      session_id: malformedParentId,
      stream_id: `session/${malformedParentId}`,
      session_kind: "child",
      parent_session_id: SESSION_ID,
      workspace_id: "c".repeat(64),
      client_namespace: "client-1",
      semantic_state: "active",
      owner_generation: null,
      child_capability_generation: 1n,
      direct_access_enabled: 1n,
      authority_commitment: "f".repeat(64),
      authority_event_position: 1n,
      created_at: NOW,
      updated_at: NOW,
    });
    rawInsert(connection, "session_authority", {
      project_id: PROJECT_ID,
      session_id: targetChildId,
      stream_id: `session/${targetChildId}`,
      session_kind: "child",
      parent_session_id: malformedParentId,
      workspace_id: "c".repeat(64),
      client_namespace: "client-1",
      semantic_state: "active",
      owner_generation: null,
      child_capability_generation: 1n,
      direct_access_enabled: 1n,
      authority_commitment: "f".repeat(64),
      authority_event_position: 1n,
      created_at: NOW,
      updated_at: NOW,
    });
    assert.throws(
      () => facade.assertEvidenceWindowWritable(targetChildId as never),
      (error: unknown) => (error as { code?: string }).code === "INTEGRITY_FAILURE",
    );

    const missingRootChildId = indexedUuid(711_004);
    rawInsert(connection, "session_authority", {
      project_id: PROJECT_ID,
      session_id: missingRootChildId,
      stream_id: `session/${missingRootChildId}`,
      session_kind: "child",
      parent_session_id: indexedUuid(711_003),
      workspace_id: "c".repeat(64),
      client_namespace: "client-1",
      semantic_state: "active",
      owner_generation: null,
      child_capability_generation: 1n,
      direct_access_enabled: 1n,
      authority_commitment: "f".repeat(64),
      authority_event_position: 1n,
      created_at: NOW,
      updated_at: NOW,
    });
    assert.throws(
      () => facade.assertEvidenceWindowWritable(missingRootChildId as never),
      (error: unknown) => (error as { code?: string }).code === "INTEGRITY_FAILURE",
    );

    const malformedIdChild = indexedUuid(711_005);
    rawInsert(connection, "session_authority", {
      project_id: PROJECT_ID,
      session_id: "x",
      stream_id: "session/x",
      session_kind: "root",
      parent_session_id: null,
      workspace_id: "c".repeat(64),
      client_namespace: "client-1",
      semantic_state: "active",
      owner_generation: 1n,
      child_capability_generation: null,
      direct_access_enabled: 0n,
      authority_commitment: "f".repeat(64),
      authority_event_position: 1n,
      created_at: NOW,
      updated_at: NOW,
    });
    rawInsert(connection, "session_authority", {
      project_id: PROJECT_ID,
      session_id: malformedIdChild,
      stream_id: `session/${malformedIdChild}`,
      session_kind: "child",
      parent_session_id: "x",
      workspace_id: "c".repeat(64),
      client_namespace: "client-1",
      semantic_state: "active",
      owner_generation: null,
      child_capability_generation: 1n,
      direct_access_enabled: 1n,
      authority_commitment: "f".repeat(64),
      authority_event_position: 1n,
      created_at: NOW,
      updated_at: NOW,
    });
    assert.throws(
      () => facade.assertEvidenceWindowWritable(malformedIdChild as never),
      (error: unknown) => (error as { code?: string }).code === "INTEGRITY_FAILURE",
    );

    const malformedGenerationRoot = indexedUuid(711_006);
    const malformedGenerationChild = indexedUuid(711_007);
    rawInsert(connection, "session_authority", {
      project_id: PROJECT_ID,
      session_id: malformedGenerationRoot,
      stream_id: `session/${malformedGenerationRoot}`,
      session_kind: "root",
      parent_session_id: null,
      workspace_id: "c".repeat(64),
      client_namespace: "client-1",
      semantic_state: "active",
      owner_generation: null,
      child_capability_generation: null,
      direct_access_enabled: 0n,
      authority_commitment: "f".repeat(64),
      authority_event_position: 1n,
      created_at: NOW,
      updated_at: NOW,
    });
    rawInsert(connection, "session_authority", {
      project_id: PROJECT_ID,
      session_id: malformedGenerationChild,
      stream_id: `session/${malformedGenerationChild}`,
      session_kind: "child",
      parent_session_id: malformedGenerationRoot,
      workspace_id: "c".repeat(64),
      client_namespace: "client-1",
      semantic_state: "active",
      owner_generation: null,
      child_capability_generation: 1n,
      direct_access_enabled: 1n,
      authority_commitment: "f".repeat(64),
      authority_event_position: 1n,
      created_at: NOW,
      updated_at: NOW,
    });
    assert.throws(
      () => facade.assertEvidenceWindowWritable(malformedGenerationChild as never),
      (error: unknown) => (error as { code?: string }).code === "INTEGRITY_FAILURE",
    );
  });

  it("keeps a frozen carry-forward baseline frozen after mutable ticket claim drift", () => {
    const connection = database();
    rawGenericSessionEvent(connection, 1n);
    seedAuthorityForForeignKeys(connection, 1n);
    const transfer = seedTransferredChildTicket(connection);
    const finalCheckpointId = indexedUuid(713_000);
    const frozenPosition = 6n;
    const binding: FinalEndingScopeBindingV1 = {
      bindingVersion: 1,
      bindingKind: "carry-forward-ticket",
      childSessionId: transfer.childSessionId as never,
      childState: "transferred",
      lastEventPosition: "5",
      streamVersion: "4",
      checkpointId: transfer.checkpointId as never,
      checkpointEventPosition: "3",
      transferTicketId: transfer.transferTicketId as never,
      transferTicketEventPosition: "5",
    };
    const summaries = [{
      childSessionId: binding.childSessionId,
      state: binding.childState,
      lastEventPosition: binding.lastEventPosition,
      streamVersion: binding.streamVersion,
      latestCheckpointId: binding.checkpointId,
    }];
    connection.exec("DROP TRIGGER workflow_instances_lifecycle_insert_guard");
    connection.exec("DROP TRIGGER workflow_instances_evidence_v3_insert_guard");
    connection.exec("DROP TRIGGER events_final_checkpoint_v4_guard");
    rawInsert(connection, "workflow_instances", {
      project_id: PROJECT_ID,
      workflow_id: sessionEndWorkflowId(SESSION_ID as never),
      workflow_type: "session-end",
      generation: 1n,
      state: "active",
      phase: "final-checkpoint-recorded",
      root_command_id: "root-command",
      result_json: canonicalJson(frozenWorkflowResult(
        finalCheckpointId,
        frozenPosition.toString(),
      )),
      error_code: null,
      created_at: NOW,
      updated_at: NOW,
      session_id: SESSION_ID,
      triggering_event_position: 1n,
      expected_authority_commitment: H64,
      coordinator_owner_id: null,
      coordinator_claim_token: null,
      coordinator_claim_expires_at: null,
      coordinator_attempt_count: 0n,
      coordinator_failure_class: null,
      coordinator_error_code: null,
      coordinator_next_attempt_at: null,
      validation_attempt_plan_generation: null,
      validation_attempt_plans_json: null,
      evidence_frozen_checkpoint_event_position: frozenPosition,
      evidence_frozen_generation: 1n,
      evidence_window_state: "sealed",
      final_ending_scope_bindings_json: canonicalJson([binding]),
    });
    rawInsert(connection, "events", {
      global_position: frozenPosition,
      event_id: indexedUuid(713_001),
      project_id: PROJECT_ID,
      vault_id: VAULT_ID,
      store_id: STORE_ID,
      workspace_id: "c".repeat(64),
      branch_scope_id: null,
      branch_ref: null,
      stream_id: `session/${SESSION_ID}`,
      stream_type: "session",
      stream_version: 2n,
      event_type: "SessionCheckpointRecorded",
      event_schema_version: 3n,
      session_id: SESSION_ID,
      parent_session_id: null,
      actor_role: "primary",
      agent_id: "agent-1",
      client_instance_id: "client-1",
      correlation_id: indexedUuid(713_002),
      causation_id: null,
      command_id: indexedUuid(713_003),
      idempotency_key: "frozen-carry-forward",
      command_event_index: 0n,
      occurred_at: NOW,
      recorded_at: NOW,
      visibility_scope: "session",
      confidence: "high",
      verification_status: "verified",
      source_refs_json: "[]",
      evidence_refs_json: "[]",
      evidence_digests_json: "[]",
      payload_json: canonicalJson(frozenCheckpointPayload(
        finalCheckpointId,
        summaries,
        frozenPosition.toString(),
      )),
      payload_hash: H64,
      previous_global_hash: H64,
      event_hash: H64,
      lifecycle_intent_json: null,
    });
    const facade = connectionBoundEvidenceCoverage(
      connection,
      new EvidenceCoverageRepository(providerRecorder().provider),
    );
    const frozen = (error: unknown) => (error as { code?: string }).code
      === "SESSION_END_EVIDENCE_FROZEN";
    assert.throws(
      () => facade.assertEvidenceWindowWritable(SESSION_ID as never),
      frozen,
    );

    connection.exec("DROP TRIGGER events_no_update");
    connection.prepare(`
      UPDATE events
      SET event_schema_version = 2,
          payload_json = $payload
      WHERE global_position = $transferPosition
    `).run({
      $transferPosition: 5,
      $payload: canonicalJson({
        transferTicketId: transfer.transferTicketId,
        suspensionCheckpointId: transfer.checkpointId,
        checkpointId: transfer.checkpointId,
        authorityCommitment: "f".repeat(64),
      }),
    });
    assert.throws(
      () => facade.assertEvidenceWindowWritable(SESSION_ID as never),
      frozen,
    );

    connection.exec("DROP TRIGGER child_transfer_tickets_update_guard");
    connection.prepare(`
      UPDATE child_transfer_tickets
      SET claimed_by_root_session_id = $rootSessionId,
          claimed_child_session_id = $claimedChildSessionId,
          claimed_event_position = 7,
          claimed_at = $claimedAt
      WHERE project_id = $projectId
        AND transfer_ticket_id = $transferTicketId
    `).run({
      $rootSessionId: SESSION_ID,
      $claimedChildSessionId: indexedUuid(713_004),
      $claimedAt: NOW,
      $projectId: PROJECT_ID,
      $transferTicketId: transfer.transferTicketId,
    });

    assert.throws(
      () => facade.assertEvidenceWindowWritable(SESSION_ID as never),
      frozen,
    );
  });

  it("uses the same indexed query shape for empty and large frozen projections", () => {
    const observedShapes: string[][] = [];
    for (const bindingCount of [0, 605]) {
      const connection = database();
      rawGenericSessionEvent(connection, 1n);
      seedAuthorityForForeignKeys(connection, 1n);
      const frozenPosition = 2n + BigInt(bindingCount);
      const bindings = Array.from(
        { length: bindingCount },
        (_, index) => ({
          ...endingBinding(index),
          lastEventPosition: (index + 2).toString(),
        }),
      );
      const summaries = bindings.map((binding) => ({
        childSessionId: binding.childSessionId,
        state: binding.childState,
        lastEventPosition: binding.lastEventPosition,
        streamVersion: binding.streamVersion,
        latestCheckpointId: binding.checkpointId,
      }));
      if (bindingCount > 0) {
        const authorities = new SessionAuthorityRepository();
        connection.exec("BEGIN IMMEDIATE");
        try {
          for (const [index, binding] of bindings.entries()) {
            const authorityEventPosition = BigInt(index + 2);
            const authority = childAuthorityFixture(
              binding.childSessionId,
              SESSION_ID,
              { authorityEventPosition },
            );
            const fork = lifecycleEvent(index + 1, "SessionForked", {}, {
              projectId: PROJECT_ID as never,
              vaultId: VAULT_ID as never,
              storeId: STORE_ID as never,
              workspaceId: "c".repeat(64) as never,
              sessionId: binding.childSessionId,
              parentSessionId: SESSION_ID as never,
              streamId: `session/${binding.childSessionId}`,
              streamVersion: 1,
              globalPosition: authorityEventPosition,
              authorityCommitment: authority.authorityCommitment,
            });
            rawInsert(connection, "streams", {
              project_id: PROJECT_ID,
              stream_id: authority.streamId,
              stream_type: "session",
              current_version: 1n,
              created_at: NOW,
              updated_at: NOW,
            });
            rawLifecycleSessionEvent(connection, fork);
            authorities.insertChild(connection, authority);
          }
          connection.exec("COMMIT");
        } catch (error) {
          connection.exec("ROLLBACK");
          throw error;
        }
      }
      connection.exec("DROP TRIGGER workflow_instances_lifecycle_insert_guard");
      connection.exec("DROP TRIGGER workflow_instances_evidence_v3_insert_guard");
      connection.exec("DROP TRIGGER events_final_checkpoint_v4_guard");
      rawInsert(connection, "workflow_instances", {
        project_id: PROJECT_ID,
        workflow_id: sessionEndWorkflowId(SESSION_ID as never),
        workflow_type: "session-end",
        generation: 1n,
        state: "active",
        phase: "final-checkpoint-recorded",
        root_command_id: "root-command",
        result_json: canonicalJson(frozenWorkflowResult(
          indexedUuid(710_005),
          frozenPosition.toString(),
        )),
        error_code: null,
        created_at: NOW,
        updated_at: NOW,
        session_id: SESSION_ID,
        triggering_event_position: 1n,
        expected_authority_commitment: H64,
        coordinator_owner_id: null,
        coordinator_claim_token: null,
        coordinator_claim_expires_at: null,
        coordinator_attempt_count: 0n,
        coordinator_failure_class: null,
        coordinator_error_code: null,
        coordinator_next_attempt_at: null,
        validation_attempt_plan_generation: null,
        validation_attempt_plans_json: null,
        evidence_frozen_checkpoint_event_position: frozenPosition,
        evidence_frozen_generation: 1n,
        evidence_window_state: "sealed",
        final_ending_scope_bindings_json: canonicalJson(bindings),
      });
      const payload = frozenCheckpointPayload(
        indexedUuid(710_005),
        summaries,
        frozenPosition.toString(),
      );
      rawInsert(connection, "events", {
        global_position: frozenPosition,
        event_id: indexedUuid(712_001 + bindingCount),
        project_id: PROJECT_ID,
        vault_id: VAULT_ID,
        store_id: STORE_ID,
        workspace_id: "c".repeat(64),
        branch_scope_id: null,
        branch_ref: null,
        stream_id: `session/${SESSION_ID}`,
        stream_type: "session",
        stream_version: 2n,
        event_type: "SessionCheckpointRecorded",
        event_schema_version: 3n,
        session_id: SESSION_ID,
        parent_session_id: null,
        actor_role: "primary",
        agent_id: "agent-1",
        client_instance_id: "client-1",
        correlation_id: indexedUuid(712_301 + bindingCount),
        causation_id: null,
        command_id: indexedUuid(712_401 + bindingCount),
        idempotency_key: `frozen-${bindingCount}`,
        command_event_index: 0n,
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
        previous_global_hash: H64,
        event_hash: H64,
        lifecycle_intent_json: null,
      });
      connection.prepare(`
        UPDATE streams
        SET current_version = 2,
            updated_at = $updatedAt
        WHERE project_id = $projectId
          AND stream_id = $streamId
      `).run({
        $updatedAt: NOW,
        $projectId: PROJECT_ID,
        $streamId: `session/${SESSION_ID}`,
      });
      const sql: string[] = [];
      const inspected = recordingConnection(connection, sql);
      const facade = connectionBoundEvidenceCoverage(
        inspected,
        new EvidenceCoverageRepository(providerRecorder().provider),
      );
      assert.throws(
        () => facade.assertEvidenceWindowWritable(SESSION_ID as never),
        (error: unknown) => (error as { code?: string }).code
          === "SESSION_END_EVIDENCE_FROZEN",
      );
      assert.equal(sql.length, 4);
      assert.match(sql[1]!, /session_authority.*project_id.*session_id/i);
      assert.match(sql[2]!, /workflow_instances.*project_id.*workflow_id/i);
      assert.match(sql[3]!, /JOIN events AS event.*global_position/i);
      assert.doesNotMatch(
        sql[2]!,
        /SELECT\s+final_ending_scope_bindings_json/i,
      );
      observedShapes.push(sql);
    }
    assert.deepEqual(observedShapes[0], observedShapes[1]);
  });

  it("uses bounded projection indexes before limits and excludes terminal children", () => {
    const connection = database();
    rawGenericSessionEvent(connection, 1n);
    seedAuthorityForForeignKeys(connection, 1n);
    const liveChildSessionId = indexedUuid(714_000);
    seedChildAuthorityForForeignKeys(connection, liveChildSessionId);
    rawLifecycleSessionEvent(connection, lifecycleEvent(2, "ChildWorkReported", {}, {
      projectId: PROJECT_ID as never,
      vaultId: VAULT_ID as never,
      storeId: STORE_ID as never,
      workspaceId: "c".repeat(64) as never,
      sessionId: liveChildSessionId as never,
      parentSessionId: SESSION_ID as never,
      streamId: `session/${liveChildSessionId}`,
      streamVersion: 2,
      globalPosition: 3,
    }));
    connection.prepare(`
      UPDATE streams
      SET current_version = 2,
          updated_at = $updatedAt
      WHERE project_id = $projectId
        AND stream_id = $streamId
    `).run({
      $updatedAt: NOW,
      $projectId: PROJECT_ID,
      $streamId: `session/${liveChildSessionId}`,
    });
    connection.exec("BEGIN IMMEDIATE");
    try {
      for (let index = 0; index < 606; index += 1) {
        const terminalChildSessionId = indexedUuid(715_000 + index);
        rawInsert(connection, "session_authority", {
          project_id: PROJECT_ID,
          session_id: terminalChildSessionId,
          stream_id: `session/${terminalChildSessionId}`,
          session_kind: "child",
          parent_session_id: SESSION_ID,
          workspace_id: "c".repeat(64),
          client_namespace: "client-1",
          semantic_state: "completed",
          owner_generation: null,
          child_capability_generation: null,
          direct_access_enabled: 0n,
          authority_commitment: "f".repeat(64),
          authority_event_position: 1n,
          terminal_event_position: 1n,
          terminal_event_type: "ChildSessionCompleted",
          terminal_at: NOW,
          created_at: NOW,
          updated_at: NOW,
        });
      }
      connection.exec("COMMIT");
    } catch (error) {
      connection.exec("ROLLBACK");
      throw error;
    }
    const sql: string[] = [];
    const inspected = recordingConnection(connection, sql);
    const current = new SessionAuthorityRepository()
      .listNonterminalChildEndingScopeProjectionsBounded(
        inspected,
        PROJECT_ID,
        SESSION_ID,
        606,
      );
    const carry = new ChildTransferRepository()
      .listUnclaimedEndingScopeProjectionsBySourceRoot(
        inspected,
        PROJECT_ID,
        SESSION_ID,
        606,
      );
    assert.deepEqual(
      current.map((projection) => projection.childSessionId),
      [liveChildSessionId],
    );
    assert.equal(current[0]?.lastEventPosition, 3n);
    assert.equal(current[0]?.streamVersion, 2n);
    assert.deepEqual(carry, []);
    assert.equal(sql.length, 2);

    const childPlan = connection.prepare(
      `EXPLAIN QUERY PLAN ${sql[0]!}`,
    ).all({
      $projectId: PROJECT_ID,
      $rootSessionId: SESSION_ID,
      $limit: 606n,
    }).map((row) => String(row.detail));
    assert.ok(childPlan.some((detail) =>
      /SEARCH child USING INDEX session_authority_parent_terminal/.test(detail)));
    assert.equal(
      childPlan.some((detail) => /SCAN child|USE TEMP B-TREE/.test(detail)),
      false,
    );

    const ticketPlan = connection.prepare(
      `EXPLAIN QUERY PLAN ${sql[1]!}`,
    ).all({
      $projectId: PROJECT_ID,
      $sourceParentSessionId: SESSION_ID,
      $limit: 606n,
    }).map((row) => String(row.detail));
    assert.ok(ticketPlan.some((detail) =>
      /SEARCH ticket USING INDEX child_transfer_tickets_unclaimed_source_root/
        .test(detail)));
    assert.equal(
      ticketPlan.some((detail) => /SCAN ticket|USE TEMP B-TREE/.test(detail)),
      false,
    );
  });

  it("commits evidence event transition aggregate and ordinals atomically", () => {
    const fixture = realEvidenceStoreFixture();

    const result = fixture.store.execute(
      fixture.envelope,
      (transaction) => fixture.service.record(transaction, fixture.semantic),
    );

    assert.equal(result.deduplicated, false);
    assert.deepEqual(repositoryTableCounts(fixture.connection), {
      events: 2n,
      session_evidence_coverage_transitions: 1n,
      session_evidence_coverage_transition_heads: 1n,
      session_evidence_coverage: 1n,
      session_evidence_fingerprints: 1n,
    });
    assert.equal(
      fixture.connection.prepare("SELECT count(*) AS count FROM command_dedup").get()!.count,
      1n,
    );
  });

  it("rolls back real first-batch store faults before and after every repository write", () => {
    const markers = [
      "INSERT INTO session_evidence_coverage_transitions",
      "INSERT INTO session_evidence_coverage(",
      "INSERT INTO session_evidence_fingerprints",
    ] as const;
    for (const marker of markers) {
      for (const when of ["before", "after"] as const) {
        const connection = database();
        const faulting = faultingConnection(connection, marker, when);
        const fixture = realEvidenceStoreFixture({
          repositoryConnection: faulting,
        });
        const before = atomicStoreState(connection);
        assert.throws(
          () => fixture.store.execute(
            fixture.envelope,
            (transaction) => fixture.service.record(transaction, fixture.semantic),
          ),
          new RegExp(`injected:${marker.replace(/[()]/g, "\\$&")}`),
          `${when}:${marker}`,
        );
        assert.deepEqual(
          atomicStoreState(connection),
          before,
          `${when}:${marker}`,
        );
      }
    }
  });

  it("rolls back real later-batch store faults before and after every repository write", () => {
    const boundaries = [
      {
        marker: "INSERT INTO session_evidence_coverage_transitions",
        occurrence: 2,
      },
      {
        marker: "UPDATE session_evidence_coverage SET",
        occurrence: 1,
      },
      {
        marker: "INSERT INTO session_evidence_fingerprints",
        occurrence: 2,
      },
    ] as const;
    for (const { marker, occurrence } of boundaries) {
      for (const when of ["before", "after"] as const) {
        const connection = database();
        const faulting = faultingConnection(
          connection,
          marker,
          when,
          occurrence,
        );
        const first = realEvidenceStoreFixture({
          repositoryConnection: faulting,
        });
        first.store.execute(
          first.envelope,
          (transaction) => first.service.record(transaction, first.semantic),
        );
        const before = atomicStoreState(connection);
        const laterSemantic = command({
          commandId: indexedUuid(940_001),
          idempotencyKey: "evidence-batch-later",
          batchId: indexedUuid(940_002) as never,
          firstOrdinal: "6",
          lastOrdinal: "6",
          frames: [{
            frameId: indexedUuid(940_003) as never,
            ordinal: "6",
            sourceKind: "tool-result",
            observedAt: NOW,
            contentFingerprint: "e".repeat(64),
          }],
        });
        const later = realEvidenceStoreFixture({
          semantic: laterSemantic,
          repositoryConnection: faulting,
          seed: false,
          streamVersion: 2n,
          eventPosition: 2n,
          eventIdStart: 960_000,
        });
        assert.throws(
          () => later.store.execute(
            later.envelope,
            (transaction) => later.service.record(transaction, later.semantic),
          ),
          new RegExp(`injected:${marker.replace(/[()]/g, "\\$&")}`),
          `${when}:${marker}`,
        );
        assert.deepEqual(
          atomicStoreState(connection),
          before,
          `${when}:${marker}`,
        );
      }
    }
  });

  it("records through the real store for root-to-descendant and child-self scopes", () => {
    const childSessionId = indexedUuid(920_001);
    const child = targetAuthority({
      sessionId: childSessionId,
      sessionKind: "child",
      parentSessionId: SESSION_ID,
      ownerGeneration: null,
      childCapabilityGeneration: 1n,
    });
    const semantic = command({ sessionId: childSessionId as never });
    const cases = [
      {
        name: "root-to-descendant",
        projectContext: context("primary", "client-1"),
        authorization: evidenceAuthorization({
          authorizationSessionId: SESSION_ID,
          targetSessionId: childSessionId,
          actorRole: "primary",
          clientInstanceId: "client-1",
        }),
        authorizationAuthority: targetAuthority(),
        capabilityKind: "root-session-handle" as const,
      },
      {
        name: "child-self",
        projectContext: context("untrusted", "child-client"),
        authorization: evidenceAuthorization({
          authorizationSessionId: childSessionId,
          targetSessionId: childSessionId,
          actorRole: "untrusted",
          clientInstanceId: "child-client",
        }),
        authorizationAuthority: child,
        capabilityKind: "child-session-handle" as const,
      },
    ];
    for (const scope of cases) {
      const fixture = realEvidenceStoreFixture({
        semantic,
        seedChildSessionId: childSessionId,
        projectContext: scope.projectContext,
        authorization: scope.authorization,
        authorizationAuthority: scope.authorizationAuthority,
        targetAuthority: child,
        targetAggregate: targetAggregate(child, 1n, 2n),
        capabilityKind: scope.capabilityKind,
      });
      const result = fixture.store.execute(
        fixture.envelope,
        (transaction) => fixture.service.record(transaction, fixture.semantic),
      );
      assert.equal(result.deduplicated, false, scope.name);
      assert.equal(
        fixture.connection.prepare(`
          SELECT count(*) AS count
          FROM session_evidence_coverage
          WHERE session_id = $sessionId
        `).get({ $sessionId: childSessionId })!.count,
        1n,
        scope.name,
      );
      assert.deepEqual(
        fixture.preparedEndingScopeBindings,
        [[{
          bindingVersion: 1,
          bindingKind: "current-child",
          childSessionId,
          childState: "active",
          lastEventPosition: "2",
          streamVersion: "1",
          checkpointId: null,
          checkpointEventPosition: null,
          transferTicketId: null,
          transferTicketEventPosition: null,
        }]],
        scope.name,
      );
    }
  });

  it("projects a live child checkpoint recorded after its authority event into evidence ending scope", () => {
    const childSessionId = indexedUuid(920_002);
    const checkpointId = indexedUuid(920_003);
    const fixture = realEvidenceStoreFixture({ seedChildSessionId: childSessionId });
    const checkpoint = checkpointFixture({
      checkpointId: checkpointId as never,
      sessionId: childSessionId as never,
      parentSessionId: SESSION_ID as never,
      baseEventPosition: "2",
      checkpointEventPosition: "3",
    });
    const checkpointFingerprint = createHash("sha256")
      .update("project-memory/checkpoint/v1\n", "utf8")
      .update(canonicalJson(checkpoint), "utf8")
      .digest("hex");
    rawLifecycleSessionEvent(fixture.connection, lifecycleEvent(
      2,
      "SessionCheckpointRecorded",
      {
        checkpoint,
        baseEventPosition: "2",
        checkpointEventPosition: "3",
      },
      {
        projectId: PROJECT_ID as never,
        vaultId: VAULT_ID as never,
        storeId: STORE_ID as never,
        workspaceId: "c".repeat(64) as never,
        sessionId: childSessionId as never,
        parentSessionId: SESSION_ID as never,
        streamId: `session/${childSessionId}`,
        streamVersion: 2,
        globalPosition: 3,
      },
    ));
    fixture.connection.prepare(`
      UPDATE streams
      SET current_version = 2,
          updated_at = $updatedAt
      WHERE project_id = $projectId
        AND stream_id = $streamId
    `).run({
      $updatedAt: NOW,
      $projectId: PROJECT_ID,
      $streamId: `session/${childSessionId}`,
    });
    fixture.connection.prepare(`
      UPDATE session_authority
      SET latest_checkpoint_id = $checkpointId,
          latest_checkpoint_event_position = 3,
          latest_checkpoint_fingerprint = $checkpointFingerprint,
          updated_at = $updatedAt
      WHERE project_id = $projectId
        AND session_id = $sessionId
    `).run({
      $checkpointId: checkpointId,
      $checkpointFingerprint: checkpointFingerprint,
      $updatedAt: NOW,
      $projectId: PROJECT_ID,
      $sessionId: childSessionId,
    });

    const result = fixture.store.execute(
      fixture.envelope,
      (transaction) => fixture.service.record(transaction, fixture.semantic),
    );

    assert.equal(result.deduplicated, false);
    assert.deepEqual(fixture.preparedEndingScopeBindings, [[{
      bindingVersion: 1,
      bindingKind: "current-child",
      childSessionId,
      childState: "active",
      lastEventPosition: "3",
      streamVersion: "2",
      checkpointId,
      checkpointEventPosition: "3",
      transferTicketId: null,
      transferTicketEventPosition: null,
    }]]);
  });

  it("derives retained tickets, excludes claimed tickets, and rejects provenance tampering without effects", () => {
    const retained = realEvidenceStoreFixture();
    const retainedFacts = seedTransferredChildTicket(retained.connection);
    retained.store.execute(
      retained.envelope,
      (transaction) => retained.service.record(transaction, retained.semantic),
    );
    assert.deepEqual(retained.preparedEndingScopeBindings, [[{
      bindingVersion: 1,
      bindingKind: "carry-forward-ticket",
      childSessionId: retainedFacts.childSessionId,
      childState: "transferred",
      lastEventPosition: "5",
      streamVersion: "4",
      checkpointId: retainedFacts.checkpointId,
      checkpointEventPosition: "3",
      transferTicketId: retainedFacts.transferTicketId,
      transferTicketEventPosition: "5",
    }]]);

    const claimed = realEvidenceStoreFixture();
    seedTransferredChildTicket(claimed.connection, true);
    claimed.store.execute(
      claimed.envelope,
      (transaction) => claimed.service.record(transaction, claimed.semantic),
    );
    assert.deepEqual(claimed.preparedEndingScopeBindings, [[]]);

    const tampered = realEvidenceStoreFixture();
    const tamperedFacts = seedTransferredChildTicket(tampered.connection);
    tampered.connection.exec("DROP TRIGGER events_no_update");
    tampered.connection.prepare(`
      UPDATE events
      SET payload_json = $payload
      WHERE global_position = 5
    `).run({
      $payload: canonicalJson({
        transferTicketId: indexedUuid(926_099),
        checkpointId: tamperedFacts.checkpointId,
        authorityCommitment: H64,
      }),
    });
    const before = atomicStoreState(tampered.connection);
    assert.throws(
      () => tampered.store.execute(
        tampered.envelope,
        (transaction) => tampered.service.record(transaction, tampered.semantic),
      ),
      (error: unknown) => (error as { code?: string }).code === "INTEGRITY_FAILURE",
    );
    assert.deepEqual(tampered.recorder.calls, {
      currentKey: 0,
      status: 0,
      fingerprint: 0,
    });
    assert.deepEqual(atomicStoreState(tampered.connection), before);
    assert.deepEqual(tampered.preparedEndingScopeBindings, []);
  });

  it("rejects wrong ancestry role and stale generation before provider work or effects", () => {
    const childSessionId = indexedUuid(921_001);
    const semantic = command({ sessionId: childSessionId as never });
    const validEnvelopeAuthorization = evidenceAuthorization({
      authorizationSessionId: SESSION_ID,
      targetSessionId: childSessionId,
    });
    const cases = [
      {
        name: "wrong-parent",
        semantic,
        seedChildSessionId: childSessionId,
        authorization: validEnvelopeAuthorization,
        envelopeAuthorization: validEnvelopeAuthorization,
        authorizationAuthority: targetAuthority(),
        targetAuthority: targetAuthority({
          sessionId: childSessionId,
          sessionKind: "child",
          parentSessionId: indexedUuid(921_002),
          ownerGeneration: null,
          childCapabilityGeneration: 1n,
        }),
        expectedCode: "INTEGRITY_FAILURE",
      },
      {
        name: "wrong-role",
        semantic: command(),
        authorization: evidenceAuthorization({
          actorRole: "untrusted",
          clientInstanceId: "wrong-role-client",
        }),
        envelopeAuthorization: evidenceAuthorization(),
        authorizationAuthority: targetAuthority(),
        targetAuthority: targetAuthority(),
        expectedCode: "SESSION_CAPABILITY_INVALID",
      },
      {
        name: "stale-generation",
        semantic: command(),
        authorization: evidenceAuthorization(),
        envelopeAuthorization: evidenceAuthorization(),
        authorizationAuthority: targetAuthority(),
        targetAuthority: targetAuthority(),
        freshCapabilityGeneration: "2",
        envelopeCapabilityGeneration: "1",
        expectedCode: "SESSION_CAPABILITY_INVALID",
      },
    ];
    for (const testCase of cases) {
      const fixture = realEvidenceStoreFixture({
        semantic: testCase.semantic,
        seedChildSessionId: testCase.seedChildSessionId,
        authorization: testCase.authorization,
        envelopeAuthorization: testCase.envelopeAuthorization,
        authorizationAuthority: testCase.authorizationAuthority,
        targetAuthority: testCase.targetAuthority,
        targetAggregate: targetAggregate(testCase.targetAuthority),
        freshCapabilityGeneration: testCase.freshCapabilityGeneration,
        envelopeCapabilityGeneration: testCase.envelopeCapabilityGeneration,
      });
      const before = atomicStoreState(fixture.connection);
      assert.throws(
        () => fixture.store.execute(
          fixture.envelope,
          (transaction) => fixture.service.record(transaction, fixture.semantic),
        ),
        (error: unknown) => (error as { code?: string }).code === testCase.expectedCode,
        testCase.name,
      );
      assert.deepEqual(fixture.recorder.calls, {
        currentKey: 0,
        status: 0,
        fingerprint: 0,
      }, testCase.name);
      assert.deepEqual(atomicStoreState(fixture.connection), before, testCase.name);
    }
  });

  it("rolls back conflicting proof intent and replays exactly without provider work", () => {
    const first = realEvidenceStoreFixture();
    first.store.execute(
      first.envelope,
      (transaction) => first.service.record(transaction, first.semantic),
    );
    const committed = atomicStoreState(first.connection);
    const providerAfterCommit = { ...first.recorder.calls };
    const replay = first.store.execute(first.envelope, () => {
      throw new Error("exact replay must not enter the semantic callback");
    });
    assert.equal(replay.deduplicated, true);
    assert.deepEqual(first.recorder.calls, providerAfterCommit);
    assert.deepEqual(atomicStoreState(first.connection), committed);

    const conflictingAuthorization = evidenceAuthorization({
      proofDigest: "e".repeat(64),
    });
    const conflicting = realEvidenceStoreFixture({
      repositoryConnection: first.connection,
      seed: false,
      authorization: conflictingAuthorization,
      envelopeAuthorization: conflictingAuthorization,
      streamVersion: 2n,
      eventPosition: 2n,
      eventIdStart: 970_000,
    });
    assert.throws(
      () => conflicting.store.execute(
        conflicting.envelope,
        (transaction) => conflicting.service.record(transaction, conflicting.semantic),
      ),
      (error: unknown) => (error as { code?: string }).code === "IDEMPOTENCY_CONFLICT",
    );
    assert.deepEqual(conflicting.recorder.calls, {
      currentKey: 0,
      status: 0,
      fingerprint: 0,
    });
    assert.deepEqual(atomicStoreState(first.connection), committed);
  });

  it("constructs one coverage-only service effect from a detached prepared payload", () => {
    const serviceContext = {
      binding: {
        projectId: PROJECT_ID,
        vaultId: VAULT_ID,
        storeId: STORE_ID,
        workspaceId: "c".repeat(64),
        clientNamespace: "client-1",
      },
    } as unknown as ProjectContext;
    const targetAuthority = {
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      streamId: `session/${SESSION_ID}`,
      sessionKind: "root",
      parentSessionId: null,
      workspaceId: "c".repeat(64),
      clientNamespace: "client-1",
      ownerGeneration: 1n,
      childCapabilityGeneration: null,
      revocationEventPosition: null,
      revokedAt: null,
      terminalEventPosition: null,
      terminalEventType: null,
      terminalAt: null,
    } as never;
    const targetAggregate = {
      kind: "root",
      projectId: PROJECT_ID,
      vaultId: VAULT_ID,
      storeId: STORE_ID,
      workspaceId: "c".repeat(64),
      sessionId: SESSION_ID,
      streamId: `session/${SESSION_ID}`,
      parentSessionId: null,
      streamVersion: 1n,
      eventPosition: 1n,
      terminalEventPosition: null,
      correlationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      ownerGeneration: 1,
    } as never;
    const preparedHandle = Symbol("test-prepared-evidence-coverage");
    const prepared = {
      handle: preparedHandle,
      sessionId: SESSION_ID,
      adapterSessionId: ADAPTER_ID,
      eventPayload: {
        adapterSessionId: ADAPTER_ID,
        batchId: BATCH_ID,
        batchFirstOrdinal: "5",
        batchLastOrdinal: "5",
        coverageFirstOrdinal: "0",
        coverageLastOrdinal: "5",
        highestContiguousOrdinal: null,
        missingIntervals: [{ firstOrdinal: "0", lastOrdinal: "4" }],
        frameFingerprintAlgorithm: "hmac-sha256",
        frameFingerprintSchemaVersion: 1,
        frameFingerprintKeyId: "key-1",
        frameFingerprintDomain: "pm-evidence-frame-v1",
        coverageFingerprintAlgorithm: "hmac-sha256",
        coverageFingerprintSchemaVersion: 1,
        coverageFingerprintKeyId: "key-1",
        coverageFingerprintDomain: "pm-evidence-coverage-v1",
        coverageFingerprint: H64,
        captureMode: "coverage-only",
        contentRetained: false,
        frames: command().frames,
      },
    } as never;
    const persisted: unknown[] = [];
    const transaction = {
      authority: {
        nextGlobalPosition: () => 2n,
        get: () => targetAuthority,
        listNonterminalChildEndingScopeProjectionsBounded: () => [],
      },
      leases: {},
      approvals: {},
      transfers: { listUnclaimedEndingScopeProjectionsBySourceRoot: () => [] },
      coverage: {
        prepareBatch: () => prepared,
        persistPrepared: (...input: unknown[]) => { persisted.push(input); },
        assertEvidenceWindowWritable: () => undefined,
        assertQuickHealthy: () => undefined,
        registerAffectedExistingSessions: () => undefined,
        assertVersion1Eligible: () => undefined,
        snapshotV2: () => { throw new Error("not used"); },
        minimumCheckpointUpperBound: () => 0,
        minimumFinalEndingScopeBindingsUpperBound: () => 0,
      },
      workflows: {},
      validation: {},
      outbox: {},
    } as unknown as LifecycleCommandTransaction;
    const service = new EvidenceCoverageService({
      invocationScope: {
        current: () => ({
          context: serviceContext,
          authorizationRecord: {
            kind: "protected",
            proof: { version: 1, nonce: indexedUuid(900_001), digest: H64 },
            approval: null,
            authorizationSessionId: SESSION_ID,
            targetSessionId: SESSION_ID,
            presenting: { actorRole: "primary", clientInstanceId: "client-1" },
            target: { actorRole: "primary", clientInstanceId: "client-1" },
          },
          freshCapabilityGeneration: "1",
          authorizationAuthority: targetAuthority,
          targetAuthority,
          targetAggregate,
          occurredAt: NOW,
        }),
      },
    });
    const effect = service.record(transaction, command());
    assert.equal(effect.append.events.length, 1);
    assert.equal(effect.append.events[0]?.eventSchemaVersion, 2);
    assert.equal(effect.append.events[0]?.eventType, "EvidenceCoverageRecorded");
    assert.deepEqual(effect.append.publicResponse, {
      resultVersion: 2,
      operation: "record-evidence-batch",
      sessionId: SESSION_ID,
      adapterSessionId: ADAPTER_ID,
      batchId: BATCH_ID,
      batchFirstOrdinal: "5",
      batchLastOrdinal: "5",
      coverageFirstOrdinal: "0",
      coverageLastOrdinal: "5",
      highestContiguousOrdinal: null,
      missingIntervals: [{ firstOrdinal: "0", lastOrdinal: "4" }],
      captureMode: "coverage-only",
      contentRetained: false,
      eventPosition: "2",
      finalStreamVersion: "2",
    });
    const committed = {
      globalPosition: 2n,
      streamVersion: 2n,
      eventType: "EvidenceCoverageRecorded",
      eventSchemaVersion: 2,
    } as never;
    effect.afterAppend({
      events: [committed],
      storedResponse: {} as never,
      responseHash: H64,
    }, transaction);
    assert.deepEqual(persisted, [[preparedHandle, committed]]);
  });

  it("derives current-child capacity from connection facts and rejects command influence", () => {
    const childSessionId = indexedUuid(925_001);
    const root = {
      ...targetAuthority(),
      semanticState: "active",
      authorityEventPosition: 1n,
      latestCheckpointId: null,
      latestCheckpointEventPosition: null,
      latestCheckpointFingerprint: null,
    } as SessionAuthorityRecord;
    const child = {
      ...targetAuthority({
        sessionId: childSessionId,
        sessionKind: "child",
        parentSessionId: SESSION_ID,
        ownerGeneration: null,
        childCapabilityGeneration: 1n,
      }),
      semanticState: "active",
      authorityEventPosition: 7n,
      latestCheckpointId: null,
      latestCheckpointEventPosition: null,
      latestCheckpointFingerprint: null,
    } as SessionAuthorityRecord;
    let preparedInput: {
      readonly prospectiveEndingScopeBindings: readonly FinalEndingScopeBindingV1[];
    } | undefined;
    const preparedHandle = Symbol("derived-projection");
    const transaction = {
      authority: {
        nextGlobalPosition: () => 8n,
        get: (_projectId: string, sessionId: string) =>
          sessionId === SESSION_ID ? root : sessionId === childSessionId ? child : null,
        listNonterminalChildEndingScopeProjectionsBounded: () => [{
          projectId: PROJECT_ID,
          rootSessionId: SESSION_ID,
          childSessionId,
          childState: "active",
          lastEventPosition: 7n,
          streamVersion: 2n,
          checkpointId: null,
          checkpointEventPosition: null,
        }],
      },
      leases: {},
      approvals: {},
      transfers: {
        listUnclaimedEndingScopeProjectionsBySourceRoot: () => [],
      },
      coverage: {
        assertEvidenceWindowWritable: () => undefined,
        assertQuickHealthy: () => undefined,
        registerAffectedExistingSessions: () => undefined,
        assertVersion1Eligible: () => undefined,
        prepareBatch: (input: {
          readonly prospectiveEndingScopeBindings: readonly FinalEndingScopeBindingV1[];
        }) => {
          preparedInput = input;
          return {
            handle: preparedHandle,
            sessionId: SESSION_ID,
            adapterSessionId: ADAPTER_ID,
            eventPayload: validPreparedEventPayload(),
          };
        },
        persistPrepared: () => undefined,
        snapshotV2: () => { throw new Error("not used"); },
        minimumCheckpointUpperBound: () => 0,
        minimumFinalEndingScopeBindingsUpperBound: () => 0,
      },
      workflows: {},
      validation: {},
      outbox: {},
    } as unknown as LifecycleCommandTransaction;
    const service = new EvidenceCoverageService({
      invocationScope: {
        current: () => ({
          context: context(),
          authorizationRecord: evidenceAuthorization(),
          freshCapabilityGeneration: "1",
          authorizationAuthority: root,
          targetAuthority: root,
          targetAggregate: targetAggregate(root),
          occurredAt: NOW,
        }),
      },
    });

    service.record(transaction, command());

    assert.deepEqual(preparedInput?.prospectiveEndingScopeBindings, [{
      bindingVersion: 1,
      bindingKind: "current-child",
      childSessionId,
      childState: "active",
      lastEventPosition: "7",
      streamVersion: "2",
      checkpointId: null,
      checkpointEventPosition: null,
      transferTicketId: null,
      transferTicketEventPosition: null,
    }]);
    assert.throws(
      () => service.record(transaction, {
        ...command(),
        prospectiveEndingScopeBindings: [endingBinding(1)],
      } as never),
      (error: unknown) => (error as { code?: string }).code
        === "LIFECYCLE_INPUT_INVALID",
    );
    assert.equal(
      preparedInput?.prospectiveEndingScopeBindings[0]?.childSessionId,
      childSessionId,
    );
  });

  it("rejects a combined 606 ending-scope projection before provider work", () => {
    const root = targetAuthority();
    const current = Array.from({ length: 303 }, (_, index) => ({
      projectId: PROJECT_ID,
      rootSessionId: SESSION_ID,
      childSessionId: indexedUuid(930_000 + index),
      childState: "active" as const,
      lastEventPosition: 1n,
      streamVersion: 1n,
      checkpointId: null,
      checkpointEventPosition: null,
    }));
    const carry = Array.from({ length: 303 }, (_, index) => ({
      projectId: PROJECT_ID,
      rootSessionId: SESSION_ID,
      childSessionId: indexedUuid(931_000 + index),
      childState: "transferred" as const,
      lastEventPosition: 1n,
      streamVersion: 1n,
      checkpointId: indexedUuid(932_000 + index),
      checkpointEventPosition: 1n,
      transferTicketId: indexedUuid(933_000 + index),
      transferTicketEventPosition: 1n,
    }));
    const recorder = providerRecorder();
    const coverage = connectionBoundEvidenceCoverage(
      database(),
      new EvidenceCoverageRepository(recorder.provider),
    );
    const transaction = {
      authority: {
        nextGlobalPosition: () => 2n,
        get: () => root,
        listNonterminalChildEndingScopeProjectionsBounded: () => current,
      },
      transfers: {
        listUnclaimedEndingScopeProjectionsBySourceRoot: () => carry,
      },
      coverage,
    } as unknown as LifecycleCommandTransaction;
    const service = new EvidenceCoverageService({
      invocationScope: {
        current: () => ({
          context: context(),
          authorizationRecord: evidenceAuthorization(),
          freshCapabilityGeneration: "1",
          authorizationAuthority: root,
          targetAuthority: root,
          targetAggregate: targetAggregate(root),
          occurredAt: NOW,
        }),
      },
    });

    assert.throws(
      () => service.record(transaction, command()),
      (error: unknown) => (error as { code?: string }).code
        === "CHECKPOINT_CAPACITY_EXCEEDED",
    );
    assert.deepEqual(recorder.calls, {
      currentKey: 0,
      status: 0,
      fingerprint: 0,
    });
  });

  it("rejects every command-authored prepared payload drift before append or result", () => {
    const cases: readonly [
      string,
      (payload: Record<string, unknown>) => void,
    ][] = [
      ["adapter", (payload) => {
        payload.adapterSessionId = indexedUuid(930_001);
      }],
      ["batch ordinals", (payload) => {
        payload.batchFirstOrdinal = "6";
        payload.batchLastOrdinal = "6";
        payload.coverageLastOrdinal = "6";
        payload.missingIntervals = [{ firstOrdinal: "0", lastOrdinal: "5" }];
        payload.frames = [{
          ...command().frames[0]!,
          ordinal: "6",
        }];
      }],
      ["frames", (payload) => {
        payload.frames = [{
          ...command().frames[0]!,
          contentFingerprint: "e".repeat(64),
        }];
      }],
      ["key profile", (payload) => {
        payload.frameFingerprintKeyId = "other-key";
        payload.coverageFingerprintKeyId = "other-key";
      }],
    ];

    for (const [name, mutate] of cases) {
      const payload = JSON.parse(
        JSON.stringify(validPreparedEventPayload()),
      ) as Record<string, unknown>;
      mutate(payload);
      const fixture = directEvidenceServiceFixture(payload);
      assert.throws(
        fixture.record,
        (error: unknown) => (error as { code?: string }).code === "INTEGRITY_FAILURE",
        name,
      );
      assert.equal(fixture.persistCalls(), 0, name);
    }
  });

  it("prepares a deeply frozen authenticated first batch with exact provider framing", () => {
    const connection = database();
    const recorder = providerRecorder();
    const repository = new EvidenceCoverageRepository(recorder.provider);

    const prepared = repository.prepareBatch(connection, {
      context: context(),
      command: command(),
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: null,
    });

    assert.equal(recorder.calls.currentKey, 1);
    assert.equal(recorder.calls.status, 0);
    assert.equal(recorder.calls.fingerprint, 1);
    assert.equal(isDeepFrozen(prepared), true);
    assert.equal(prepared.previousCoverageFingerprint, null);
    assert.deepEqual(prepared.newFrames, command().frames);
    assert.deepEqual(prepared.eventPayload.missingIntervals, [{
      firstOrdinal: "0",
      lastOrdinal: "4",
    }]);
    assert.equal(prepared.eventPayload.highestContiguousOrdinal, null);
    assert.equal(prepared.eventPayload.coverageLastOrdinal, "5");

    const providerInput = recorder.fingerprintInputs[0]!;
    assert.deepEqual(
      {
        projectId: providerInput.projectId,
        storeId: providerInput.storeId,
        purpose: providerInput.purpose,
        keyId: providerInput.keyId,
        domain: providerInput.domain,
      },
      {
        projectId: PROJECT_ID,
        storeId: STORE_ID,
        purpose: "evidence-fingerprint",
        keyId: "key-1",
        domain: "pm-evidence-coverage-v1",
      },
    );
    assert.deepEqual(providerInput.body, {
      coverageAccumulatorVersion: 1,
      projectId: PROJECT_ID,
      storeId: STORE_ID,
      sessionId: SESSION_ID,
      adapterSessionId: ADAPTER_ID,
      previousCoverageFingerprint: null,
      captureMode: "coverage-only",
      contentRetained: false,
      frameFingerprintProfile: {
        algorithm: "hmac-sha256",
        schemaVersion: 1,
        keyId: "key-1",
        domain: "pm-evidence-frame-v1",
      },
      coverageFingerprintProfile: {
        algorithm: "hmac-sha256",
        schemaVersion: 1,
        keyId: "key-1",
        domain: "pm-evidence-coverage-v1",
      },
      coverageFirstOrdinal: "0",
      coverageLastOrdinal: "5",
      highestContiguousOrdinal: null,
      missingIntervals: [{ firstOrdinal: "0", lastOrdinal: "4" }],
      newFrames: command().frames,
    });
    assert.equal(providerInput.bytes.every((byte) => byte === 0), true);
  });

  it("matches a fixed rolling HMAC vector and remains history-sensitive", () => {
    const capturedBodies: string[] = [];
    const provider = {
      currentKey() {
        return { keyId: "key-1" };
      },
      status() {
        return "available" as const;
      },
      fingerprint(input: {
        domain: string;
        bytes: Uint8Array;
      }) {
        const body = Buffer.from(input.bytes);
        capturedBodies.push(body.toString("utf8"));
        return createHmac("sha256", "task-12c-fixed-key")
          .update(Buffer.from(input.domain, "utf8"))
          .update(Buffer.from([0]))
          .update(body)
          .digest("hex");
      },
    };
    const firstConnection = database();
    const firstRepository = new EvidenceCoverageRepository(provider);
    const fixed = firstRepository.prepareBatch(firstConnection, {
      context: context(),
      command: command(),
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: 1n,
    });
    assert.equal(
      fixed.eventPayload.coverageFingerprint,
      "264ab9b80bbb9e89c18f61f559f4703c2e903724dac031783ba16cbdcfe82f34",
    );
    assert.equal(capturedBodies[0]!.startsWith("{"), true);
    assert.equal(capturedBodies[0]!.endsWith("}"), true);
    assert.equal(capturedBodies[0]!.includes("\n"), false);

    const togetherConnection = database();
    const togetherRepository = new EvidenceCoverageRepository(provider);
    const frames = [
      {
        frameId: indexedUuid(90_001) as never,
        ordinal: "0",
        sourceKind: "model-turn" as const,
        observedAt: NOW,
        contentFingerprint: "1".repeat(64),
      },
      {
        frameId: indexedUuid(90_002) as never,
        ordinal: "1",
        sourceKind: "tool-result" as const,
        observedAt: NOW,
        contentFingerprint: "2".repeat(64),
      },
    ];
    const together = togetherRepository.prepareBatch(togetherConnection, {
      context: context(),
      command: command({
        commandId: indexedUuid(90_003),
        idempotencyKey: "history-together",
        batchId: indexedUuid(90_004) as never,
        firstOrdinal: "0",
        lastOrdinal: "1",
        frames,
      }),
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: 1n,
    });

    const splitConnection = database();
    const splitRepository = new EvidenceCoverageRepository(provider);
    const splitFirstCommand = command({
      commandId: indexedUuid(90_005),
      idempotencyKey: "history-split-1",
      batchId: indexedUuid(90_006) as never,
      firstOrdinal: "0",
      lastOrdinal: "0",
      frames: [frames[0]!],
    });
    const splitFirst = splitRepository.prepareBatch(splitConnection, {
      context: context(),
      command: splitFirstCommand,
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: 1n,
    });
    splitRepository.persistPrepared(
      splitConnection,
      splitFirst,
      storedEvent(
        splitConnection,
        splitFirst.eventPayload as unknown as Readonly<Record<string, unknown>>,
        {
          commandId: splitFirstCommand.commandId,
          idempotencyKey: splitFirstCommand.idempotencyKey,
        },
      ),
    );
    const splitSecond = splitRepository.prepareBatch(splitConnection, {
      context: context(),
      command: command({
        commandId: indexedUuid(90_007),
        idempotencyKey: "history-split-2",
        batchId: indexedUuid(90_008) as never,
        firstOrdinal: "1",
        lastOrdinal: "1",
        frames: [frames[1]!],
      }),
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: 2n,
    });
    assert.notEqual(
      together.eventPayload.coverageFingerprint,
      splitSecond.eventPayload.coverageFingerprint,
    );
  });

  it("zeroizes only caller-owned canonical bytes when fingerprinting fails", () => {
    const connection = database();
    const recorder = providerRecorder(new Error("provider unavailable"));
    const repository = new EvidenceCoverageRepository(recorder.provider);

    assert.throws(
      () => repository.prepareBatch(connection, {
        context: context(),
        command: command(),
        prospectiveEndingScopeBindings: [],
        plannedEventPosition: 1n,
      }),
      /provider unavailable/,
    );
    assert.equal(recorder.fingerprintInputs.length, 1);
    assert.equal(
      recorder.fingerprintInputs[0]!.bytes.every((byte) => byte === 0),
      true,
    );
  });

  it("persists transition aggregate and ordinal rows bound to the committed event", () => {
    const connection = database();
    const recorder = providerRecorder();
    const repository = new EvidenceCoverageRepository(recorder.provider);
    const prepared = repository.prepareBatch(connection, {
      context: context(),
      command: command(),
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: 1n,
    });
    const committed = storedEvent(
      connection,
      prepared.eventPayload as unknown as Readonly<Record<string, unknown>>,
    );

    repository.persistPrepared(connection, prepared, committed);

    assert.equal(
      connection.prepare("SELECT count(*) AS count FROM session_evidence_coverage_transitions")
        .get()!.count,
      1n,
    );
    assert.equal(
      connection.prepare("SELECT count(*) AS count FROM session_evidence_coverage")
        .get()!.count,
      1n,
    );
    assert.equal(
      connection.prepare("SELECT count(*) AS count FROM session_evidence_fingerprints")
        .get()!.count,
      1n,
    );
    const snapshot = repository.snapshotV2(
      connection,
      SESSION_ID as never,
      committed.globalPosition,
    );
    assert.deepEqual(snapshot.adapterSessions, [{
      adapterSessionId: ADAPTER_ID,
      coverageFirstOrdinal: "0",
      coverageLastOrdinal: "5",
      highestContiguousOrdinal: null,
      missingIntervals: [{ firstOrdinal: "0", lastOrdinal: "4" }],
      frameFingerprintAlgorithm: "hmac-sha256",
      frameFingerprintSchemaVersion: 1,
      frameFingerprintKeyId: "key-1",
      frameFingerprintDomain: "pm-evidence-frame-v1",
      coverageFingerprintAlgorithm: "hmac-sha256",
      coverageFingerprintSchemaVersion: 1,
      coverageFingerprintKeyId: "key-1",
      coverageFingerprintDomain: "pm-evidence-coverage-v1",
      coverageFingerprint: H64,
      latestBatchId: BATCH_ID,
      latestBatchEventPosition: "1",
    }]);
    assert.deepEqual(
      repository.snapshotFromTransitionsV2(
        connection,
        SESSION_ID as never,
        committed.globalPosition,
      ),
      snapshot,
    );
    assert.throws(
      () => repository.assertVersion1Eligible(connection, [SESSION_ID as never]),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "CHECKPOINT_EVIDENCE_VERSION_REQUIRED"
      ),
    );
  });

  it("uses the recorded profile and fingerprints only genuinely new overlap frames", () => {
    const connection = database();
    const recorder = providerRecorder();
    const repository = new EvidenceCoverageRepository(recorder.provider);
    const first = repository.prepareBatch(connection, {
      context: context(),
      command: command(),
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: 1n,
    });
    repository.persistPrepared(
      connection,
      first,
      storedEvent(
        connection,
        first.eventPayload as unknown as Readonly<Record<string, unknown>>,
      ),
    );

    const secondCommand = command({
      commandId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      idempotencyKey: "evidence-batch-2",
      batchId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as never,
      firstOrdinal: "5",
      lastOrdinal: "6",
      frames: [
        command().frames[0]!,
        {
          frameId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" as never,
          ordinal: "6",
          sourceKind: "tool-result",
          observedAt: NOW,
          contentFingerprint: "d".repeat(64),
        },
      ],
    });
    const second = repository.prepareBatch(connection, {
      context: context(),
      command: secondCommand,
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: 2n,
    });

    assert.equal(recorder.calls.currentKey, 1);
    assert.equal(recorder.calls.status, 1);
    assert.equal(recorder.calls.fingerprint, 2);
    assert.deepEqual(second.newFrames, [secondCommand.frames[1]]);
    assert.equal(second.previousCoverageFingerprint, H64);
    assert.deepEqual(
      (recorder.fingerprintInputs[1]!.body as {
        newFrames: readonly unknown[];
      }).newFrames,
      [secondCommand.frames[1]],
    );
    repository.persistPrepared(
      connection,
      second,
      storedEvent(
        connection,
        second.eventPayload as unknown as Readonly<Record<string, unknown>>,
        {
          globalPosition: 2n,
          commandId: secondCommand.commandId,
          idempotencyKey: secondCommand.idempotencyKey,
          streamVersion: 2n,
        },
      ),
    );

    const callsBeforeZeroNew = { ...recorder.calls };
    const zeroNewCommand = command({
      commandId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      idempotencyKey: "evidence-batch-3",
      batchId: "ffffffff-ffff-4fff-bfff-ffffffffffff" as never,
    });
    const zeroNew = repository.prepareBatch(connection, {
      context: context(),
      command: zeroNewCommand,
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: 3n,
    });
    assert.equal(recorder.calls.currentKey, callsBeforeZeroNew.currentKey);
    assert.equal(recorder.calls.status, callsBeforeZeroNew.status + 1);
    assert.equal(recorder.calls.fingerprint, callsBeforeZeroNew.fingerprint);
    assert.equal(zeroNew.eventPayload.coverageFingerprint, second.eventPayload.coverageFingerprint);
    assert.deepEqual(zeroNew.newFrames, []);
    repository.persistPrepared(
      connection,
      zeroNew,
      storedEvent(
        connection,
        zeroNew.eventPayload as unknown as Readonly<Record<string, unknown>>,
        {
          globalPosition: 3n,
          eventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3",
          commandId: zeroNewCommand.commandId,
          idempotencyKey: zeroNewCommand.idempotencyKey,
          streamVersion: 3n,
        },
      ),
    );
    const latest = connection.prepare(`
      SELECT latest_batch_id, latest_batch_event_position
      FROM session_evidence_coverage
      WHERE project_id = $projectId
        AND session_id = $sessionId
        AND adapter_session_id = $adapterSessionId
    `).get({
      $projectId: PROJECT_ID,
      $sessionId: SESSION_ID,
      $adapterSessionId: ADAPTER_ID,
    });
    assert.deepEqual({ ...latest }, {
      latest_batch_id: zeroNewCommand.batchId,
      latest_batch_event_position: 3n,
    });

    const callsBeforeContradiction = { ...recorder.calls };
    assert.throws(
      () => repository.prepareBatch(connection, {
        context: context(),
        command: command({
          commandId: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          idempotencyKey: "evidence-contradiction",
          batchId: "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as never,
          frames: [{
            ...command().frames[0]!,
            contentFingerprint: "e".repeat(64),
          }],
        }),
        prospectiveEndingScopeBindings: [],
        plannedEventPosition: 3n,
      }),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "LIFECYCLE_INPUT_INVALID"
      ),
    );
    assert.deepEqual(recorder.calls, callsBeforeContradiction);
  });

  it("rolls back the event and every first-batch repository boundary fault", () => {
    const boundaries = [
      "INSERT INTO session_evidence_coverage_transitions",
      "INSERT INTO session_evidence_coverage(",
      "INSERT INTO session_evidence_fingerprints",
    ] as const;
    for (const boundary of boundaries) {
      const connection = database();
      const repository = new EvidenceCoverageRepository(providerRecorder().provider);
      const prepared = repository.prepareBatch(connection, {
        context: context(),
        command: command(),
        prospectiveEndingScopeBindings: [],
        plannedEventPosition: 1n,
      });
      connection.exec("BEGIN IMMEDIATE");
      const committed = storedEvent(
        connection,
        prepared.eventPayload as unknown as Readonly<Record<string, unknown>>,
      );
      assert.throws(
        () => repository.persistPrepared(
          faultingConnection(connection, boundary),
          prepared,
          committed,
        ),
        new RegExp(`injected:${boundary.replace(/[()]/g, "\\$&")}`),
      );
      connection.exec("ROLLBACK");

      for (const table of [
        "events",
        "session_evidence_coverage_transitions",
        "session_evidence_coverage_transition_heads",
        "session_evidence_coverage",
        "session_evidence_fingerprints",
      ]) {
        assert.equal(
          connection.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count,
          0n,
          `${boundary} left a row in ${table}`,
        );
      }
    }
  });

  it("rolls back every later-batch repository boundary fault", () => {
    const boundaries = [
      "INSERT INTO session_evidence_coverage_transitions",
      "UPDATE session_evidence_coverage SET",
      "INSERT INTO session_evidence_fingerprints",
    ] as const;
    for (const boundary of boundaries) {
      const connection = database();
      const repository = new EvidenceCoverageRepository(providerRecorder().provider);
      const first = repository.prepareBatch(connection, {
        context: context(),
        command: command(),
        prospectiveEndingScopeBindings: [],
        plannedEventPosition: 1n,
      });
      repository.persistPrepared(
        connection,
        first,
        storedEvent(
          connection,
          first.eventPayload as unknown as Readonly<Record<string, unknown>>,
        ),
      );
      const laterCommand = command({
        commandId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        idempotencyKey: "later-batch",
        batchId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as never,
        firstOrdinal: "6",
        lastOrdinal: "6",
        frames: [{
          frameId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" as never,
          ordinal: "6",
          sourceKind: "tool-result",
          observedAt: NOW,
          contentFingerprint: "d".repeat(64),
        }],
      });
      const later = repository.prepareBatch(connection, {
        context: context(),
        command: laterCommand,
        prospectiveEndingScopeBindings: [],
        plannedEventPosition: 2n,
      });
      connection.exec("BEGIN IMMEDIATE");
      const committed = storedEvent(
        connection,
        later.eventPayload as unknown as Readonly<Record<string, unknown>>,
        {
          globalPosition: 2n,
          commandId: laterCommand.commandId,
          idempotencyKey: laterCommand.idempotencyKey,
          streamVersion: 2n,
        },
      );
      assert.throws(
        () => repository.persistPrepared(
          faultingConnection(connection, boundary),
          later,
          committed,
        ),
        new RegExp(`injected:${boundary.replace(/[()]/g, "\\$&")}`),
      );
      connection.exec("ROLLBACK");

      assert.equal(
        connection.prepare("SELECT count(*) AS count FROM events").get()!.count,
        1n,
      );
      assert.equal(
        connection.prepare(
          "SELECT count(*) AS count FROM session_evidence_coverage_transitions",
        ).get()!.count,
        1n,
      );
      assert.equal(
        connection.prepare("SELECT count(*) AS count FROM session_evidence_coverage")
          .get()!.count,
        1n,
      );
      assert.equal(
        connection.prepare(
          "SELECT count(*) AS count FROM session_evidence_coverage_transition_heads",
        ).get()!.count,
        1n,
      );
      assert.equal(
        connection.prepare("SELECT count(*) AS count FROM session_evidence_fingerprints")
          .get()!.count,
        1n,
      );
      assert.equal(
        connection.prepare(
          "SELECT latest_batch_event_position FROM session_evidence_coverage",
        ).get()!.latest_batch_event_position,
        1n,
      );
    }
  });

  it("rejects unbranded and event-mismatched persistence plans", () => {
    const connection = database();
    const recorder = providerRecorder();
    const repository = new EvidenceCoverageRepository(recorder.provider);
    const prepared = repository.prepareBatch(connection, {
      context: context(),
      command: command(),
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: 1n,
    });
    const committed = storedEvent(
      connection,
      prepared.eventPayload as unknown as Readonly<Record<string, unknown>>,
    );

    assert.throws(
      () => repository.persistPrepared(
        connection,
        { ...prepared } as typeof prepared,
        committed,
      ),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "INTEGRITY_FAILURE"
      ),
    );
    assert.throws(
      () => repository.persistPrepared(
        connection,
        prepared,
        { ...committed, sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      ),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "INTEGRITY_FAILURE"
      ),
    );
  });

  it("rejects the complete committed-event and prior-CAS mismatch matrix", () => {
    const prepareFirst = (
      plannedEventPosition: bigint | null = 1n,
    ): {
      connection: SqliteConnection;
      repository: EvidenceCoverageRepository;
      prepared: ReturnType<EvidenceCoverageRepository["prepareBatch"]>;
    } => {
      const connection = database();
      const repository = new EvidenceCoverageRepository(providerRecorder().provider);
      const prepared = repository.prepareBatch(connection, {
        context: context(),
        command: command(),
        prospectiveEndingScopeBindings: [],
        plannedEventPosition,
      });
      return { connection, repository, prepared };
    };
    const expectIntegrity = (operation: () => void): void => {
      assert.throws(
        operation,
        (error: unknown) => (
          error instanceof Error
          && "code" in error
          && error.code === "INTEGRITY_FAILURE"
        ),
      );
    };

    {
      const { connection, repository, prepared } = prepareFirst();
      const committed = storedEvent(
        connection,
        prepared.eventPayload as unknown as Readonly<Record<string, unknown>>,
      );
      connection.exec("DROP TRIGGER events_no_delete");
      connection.prepare("DELETE FROM events WHERE global_position = 1").run();
      expectIntegrity(() => repository.persistPrepared(connection, prepared, committed));
    }
    {
      const { connection, repository, prepared } = prepareFirst(2n);
      const committed = storedEvent(
        connection,
        prepared.eventPayload as unknown as Readonly<Record<string, unknown>>,
      );
      expectIntegrity(() => repository.persistPrepared(connection, prepared, committed));
    }
    for (const overrides of [
      { projectId: indexedUuid(91_001) },
      { storeId: indexedUuid(91_002) },
      { sessionId: indexedUuid(91_003) },
    ]) {
      const { connection, repository, prepared } = prepareFirst();
      const committed = storedEvent(
        connection,
        prepared.eventPayload as unknown as Readonly<Record<string, unknown>>,
      );
      expectIntegrity(() => repository.persistPrepared(
        connection,
        prepared,
        { ...committed, ...overrides } as StoredEvent,
      ));
    }
    for (const mutate of [
      (payload: Record<string, unknown>) => {
        payload.batchId = indexedUuid(91_004);
      },
      (payload: Record<string, unknown>) => {
        payload.coverageLastOrdinal = "6";
      },
    ]) {
      const { connection, repository, prepared } = prepareFirst();
      const payload = structuredClone(
        prepared.eventPayload,
      ) as unknown as Record<string, unknown>;
      mutate(payload);
      const committed = storedEvent(connection, payload);
      expectIntegrity(() => repository.persistPrepared(connection, prepared, committed));
    }
    {
      const { connection, repository, prepared } = prepareFirst();
      const committed = storedEvent(
        connection,
        prepared.eventPayload as unknown as Readonly<Record<string, unknown>>,
      );
      connection.exec("DROP TRIGGER events_no_update");
      connection.prepare(`
        UPDATE events SET payload_json = '{}'
        WHERE global_position = 1
      `).run();
      expectIntegrity(() => repository.persistPrepared(connection, prepared, committed));
    }
    for (const drift of ["digest", "position"] as const) {
      const connection = database();
      const repository = new EvidenceCoverageRepository(providerRecorder().provider);
      const first = repository.prepareBatch(connection, {
        context: context(),
        command: command(),
        prospectiveEndingScopeBindings: [],
        plannedEventPosition: 1n,
      });
      repository.persistPrepared(
        connection,
        first,
        storedEvent(
          connection,
          first.eventPayload as unknown as Readonly<Record<string, unknown>>,
        ),
      );
      const laterCommand = command({
        commandId: indexedUuid(91_005),
        idempotencyKey: "cas-drift",
        batchId: indexedUuid(91_006) as never,
        firstOrdinal: "6",
        lastOrdinal: "6",
        frames: [{
          frameId: indexedUuid(91_007) as never,
          ordinal: "6",
          sourceKind: "tool-result",
          observedAt: NOW,
          contentFingerprint: "d".repeat(64),
        }],
      });
      const later = repository.prepareBatch(connection, {
        context: context(),
        command: laterCommand,
        prospectiveEndingScopeBindings: [],
        plannedEventPosition: 2n,
      });
      const committed = storedEvent(
        connection,
        later.eventPayload as unknown as Readonly<Record<string, unknown>>,
        {
          globalPosition: 2n,
          eventId: indexedUuid(91_008),
          commandId: laterCommand.commandId,
          idempotencyKey: laterCommand.idempotencyKey,
          streamVersion: 2n,
        },
      );
      connection.exec("DROP TRIGGER session_evidence_coverage_v3_update_guard");
      if (drift === "digest") {
        connection.prepare(`
          UPDATE session_evidence_coverage
          SET coverage_fingerprint_value = $digest
        `).run({ $digest: "c".repeat(64) });
      } else {
        connection.prepare(`
          UPDATE session_evidence_coverage
          SET latest_batch_event_position = 99
        `).run();
      }
      const stateBeforeRejectedPersist = repositoryTableCounts(connection);
      expectIntegrity(() => repository.persistPrepared(connection, later, committed));
      assert.deepEqual(
        repositoryTableCounts(connection),
        stateBeforeRejectedPersist,
      );
    }
  });

  it("separates current and historical snapshots across ordered independent adapters", () => {
    const connection = database();
    const repository = new EvidenceCoverageRepository(providerRecorder().provider);
    const adapterB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const adapterA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const record = (
      batchCommand: RecordEvidenceBatchCommandV2,
      position: bigint,
      streamVersion: bigint,
    ): void => {
      const prepared = repository.prepareBatch(connection, {
        context: context(),
        command: batchCommand,
        prospectiveEndingScopeBindings: [],
        plannedEventPosition: position,
      });
      repository.persistPrepared(
        connection,
        prepared,
        storedEvent(
          connection,
          prepared.eventPayload as unknown as Readonly<Record<string, unknown>>,
          {
            globalPosition: position,
            eventId: indexedUuid(92_000 + Number(position)),
            commandId: batchCommand.commandId,
            idempotencyKey: batchCommand.idempotencyKey,
            streamVersion,
          },
        ),
      );
    };
    record(command({
      commandId: indexedUuid(92_010),
      idempotencyKey: "adapter-b-1",
      adapterSessionId: adapterB as never,
      batchId: indexedUuid(92_011) as never,
      firstOrdinal: "0",
      lastOrdinal: "0",
      frames: [{
        frameId: indexedUuid(92_012) as never,
        ordinal: "0",
        sourceKind: "model-turn",
        observedAt: NOW,
        contentFingerprint: "1".repeat(64),
      }],
    }), 1n, 1n);
    record(command({
      commandId: indexedUuid(92_020),
      idempotencyKey: "adapter-a-1",
      adapterSessionId: adapterA as never,
      batchId: indexedUuid(92_021) as never,
      firstOrdinal: "0",
      lastOrdinal: "0",
      frames: [{
        frameId: indexedUuid(92_022) as never,
        ordinal: "0",
        sourceKind: "tool-request",
        observedAt: NOW,
        contentFingerprint: "2".repeat(64),
      }],
    }), 2n, 2n);
    record(command({
      commandId: indexedUuid(92_030),
      idempotencyKey: "adapter-b-2",
      adapterSessionId: adapterB as never,
      batchId: indexedUuid(92_031) as never,
      firstOrdinal: "1",
      lastOrdinal: "1",
      frames: [{
        frameId: indexedUuid(92_032) as never,
        ordinal: "1",
        sourceKind: "tool-result",
        observedAt: NOW,
        contentFingerprint: "3".repeat(64),
      }],
    }), 3n, 3n);

    const historical = repository.snapshotFromTransitionsV2(
      connection,
      SESSION_ID as never,
      2n,
    );
    assert.deepEqual(
      historical.adapterSessions.map((entry) => entry.adapterSessionId),
      [adapterA, adapterB],
    );
    assert.deepEqual(
      historical.adapterSessions.map((entry) => entry.latestBatchEventPosition),
      ["2", "1"],
    );
    assert.throws(
      () => repository.snapshotV2(connection, SESSION_ID as never, 2n),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "INTEGRITY_FAILURE"
      ),
    );
    assert.deepEqual(
      repository.snapshotV2(connection, SESSION_ID as never, 3n)
        .adapterSessions.map((entry) => entry.adapterSessionId),
      [adapterA, adapterB],
    );

    const unavailable = new EvidenceCoverageRepository(
      providerRecorder(undefined, "unavailable").provider,
    );
    for (const snapshot of [
      () => unavailable.snapshotV2(connection, SESSION_ID as never, 3n),
      () => unavailable.snapshotFromTransitionsV2(
        connection,
        SESSION_ID as never,
        2n,
      ),
    ]) {
      assert.throws(
        snapshot,
        (error: unknown) => (
          error instanceof Error
          && "code" in error
          && error.code === "EVIDENCE_HISTORICAL_KEY_UNAVAILABLE"
        ),
      );
    }
  });

  it("enforces repository adapter and interval boundaries before provider work", () => {
    const connection = database();
    const recorder = providerRecorder();
    const repository = new EvidenceCoverageRepository(recorder.provider);
    const adapterIds: string[] = [];
    for (let index = 0; index < 200; index += 1) {
      const position = BigInt(index + 1);
      const adapterSessionId = indexedUuid(100_000 + index);
      adapterIds.push(adapterSessionId);
      const batchCommand = command({
        commandId: indexedUuid(101_000 + index),
        idempotencyKey: `adapter-bound-${index}`,
        adapterSessionId: adapterSessionId as never,
        batchId: indexedUuid(102_000 + index) as never,
        firstOrdinal: "1",
        lastOrdinal: "1",
        frames: [{
          frameId: indexedUuid(103_000 + index) as never,
          ordinal: "1",
          sourceKind: "adapter-event",
          observedAt: NOW,
          contentFingerprint: index.toString(16).padStart(64, "0"),
        }],
      });
      const prepared = repository.prepareBatch(connection, {
        context: context(),
        command: batchCommand,
        prospectiveEndingScopeBindings: [],
        plannedEventPosition: position,
      });
      repository.persistPrepared(
        connection,
        prepared,
        storedEvent(
          connection,
          prepared.eventPayload as unknown as Readonly<Record<string, unknown>>,
          {
            globalPosition: position,
            eventId: indexedUuid(104_000 + index),
            commandId: batchCommand.commandId,
            idempotencyKey: batchCommand.idempotencyKey,
            streamVersion: position,
          },
        ),
      );
    }
    assert.equal(
      connection.prepare(
        "SELECT count(*) AS count FROM session_evidence_coverage",
      ).get()!.count,
      200n,
    );
    const providerBeforeAdapter201 = { ...recorder.calls };
    assert.throws(
      () => repository.prepareBatch(connection, {
        context: context(),
        command: command({
          commandId: indexedUuid(105_001),
          idempotencyKey: "adapter-bound-201",
          adapterSessionId: indexedUuid(105_002) as never,
          batchId: indexedUuid(105_003) as never,
          firstOrdinal: "0",
          lastOrdinal: "0",
          frames: [{
            frameId: indexedUuid(105_004) as never,
            ordinal: "0",
            sourceKind: "adapter-event",
            observedAt: NOW,
            contentFingerprint: "a".repeat(64),
          }],
        }),
        prospectiveEndingScopeBindings: [],
        plannedEventPosition: 201n,
      }),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "EVIDENCE_ADAPTER_SESSION_LIMIT"
      ),
    );
    assert.deepEqual(recorder.calls, providerBeforeAdapter201);

    const providerBeforeTotal201 = { ...recorder.calls };
    assert.throws(
      () => repository.prepareBatch(connection, {
        context: context(),
        command: command({
          commandId: indexedUuid(105_011),
          idempotencyKey: "total-interval-bound-201",
          adapterSessionId: adapterIds[0] as never,
          batchId: indexedUuid(105_012) as never,
          firstOrdinal: "3",
          lastOrdinal: "3",
          frames: [{
            frameId: indexedUuid(105_013) as never,
            ordinal: "3",
            sourceKind: "tool-result",
            observedAt: NOW,
            contentFingerprint: "b".repeat(64),
          }],
        }),
        prospectiveEndingScopeBindings: [],
        plannedEventPosition: 201n,
      }),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "EVIDENCE_COVERAGE_TOO_FRAGMENTED"
      ),
    );
    assert.deepEqual(recorder.calls, providerBeforeTotal201);
    assert.equal(
      connection.prepare(
        "SELECT coalesce(sum(json_array_length(missing_intervals_json)), 0) AS count FROM session_evidence_coverage",
      ).get()!.count,
      200n,
    );

    const fragmentedConnection = database();
    const fragmentedRecorder = providerRecorder();
    const fragmentedRepository = new EvidenceCoverageRepository(
      fragmentedRecorder.provider,
    );
    let eventPosition = 1n;
    const firstFragmentCommand = command({
      commandId: indexedUuid(106_001),
      idempotencyKey: "fragment-first",
      batchId: indexedUuid(106_002) as never,
      firstOrdinal: "401",
      lastOrdinal: "401",
      frames: [{
        frameId: indexedUuid(106_003) as never,
        ordinal: "401",
        sourceKind: "external-observation",
        observedAt: NOW,
        contentFingerprint: "c".repeat(64),
      }],
    });
    let fragmentPrepared = fragmentedRepository.prepareBatch(
      fragmentedConnection,
      {
        context: context(),
        command: firstFragmentCommand,
        prospectiveEndingScopeBindings: [],
        plannedEventPosition: eventPosition,
      },
    );
    fragmentedRepository.persistPrepared(
      fragmentedConnection,
      fragmentPrepared,
      storedEvent(
        fragmentedConnection,
        fragmentPrepared.eventPayload as unknown as Readonly<Record<string, unknown>>,
        {
          globalPosition: eventPosition,
          eventId: indexedUuid(106_004),
          commandId: firstFragmentCommand.commandId,
          idempotencyKey: firstFragmentCommand.idempotencyKey,
          streamVersion: eventPosition,
        },
      ),
    );
    for (let ordinal = 1; ordinal <= 397; ordinal += 2) {
      eventPosition += 1n;
      const batchCommand = command({
        commandId: indexedUuid(107_000 + ordinal),
        idempotencyKey: `fragment-${ordinal}`,
        batchId: indexedUuid(108_000 + ordinal) as never,
        firstOrdinal: ordinal.toString(),
        lastOrdinal: ordinal.toString(),
        frames: [{
          frameId: indexedUuid(109_000 + ordinal) as never,
          ordinal: ordinal.toString(),
          sourceKind: "external-observation",
          observedAt: NOW,
          contentFingerprint: ordinal.toString(16).padStart(64, "0"),
        }],
      });
      fragmentPrepared = fragmentedRepository.prepareBatch(
        fragmentedConnection,
        {
          context: context(),
          command: batchCommand,
          prospectiveEndingScopeBindings: [],
          plannedEventPosition: eventPosition,
        },
      );
      fragmentedRepository.persistPrepared(
        fragmentedConnection,
        fragmentPrepared,
        storedEvent(
          fragmentedConnection,
          fragmentPrepared.eventPayload as unknown as Readonly<Record<string, unknown>>,
          {
            globalPosition: eventPosition,
            eventId: indexedUuid(110_000 + ordinal),
            commandId: batchCommand.commandId,
            idempotencyKey: batchCommand.idempotencyKey,
            streamVersion: eventPosition,
          },
        ),
      );
    }
    assert.equal(fragmentPrepared.eventPayload.missingIntervals.length, 200);
    const providerBeforePerAdapter201 = { ...fragmentedRecorder.calls };
    assert.throws(
      () => fragmentedRepository.prepareBatch(fragmentedConnection, {
        context: context(),
        command: command({
          commandId: indexedUuid(111_001),
          idempotencyKey: "fragment-201",
          batchId: indexedUuid(111_002) as never,
          firstOrdinal: "399",
          lastOrdinal: "399",
          frames: [{
            frameId: indexedUuid(111_003) as never,
            ordinal: "399",
            sourceKind: "external-observation",
            observedAt: NOW,
            contentFingerprint: "d".repeat(64),
          }],
        }),
        prospectiveEndingScopeBindings: [],
        plannedEventPosition: eventPosition + 1n,
      }),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "EVIDENCE_COVERAGE_TOO_FRAGMENTED"
      ),
    );
    assert.deepEqual(fragmentedRecorder.calls, providerBeforePerAdapter201);
    assert.equal(
      fragmentedConnection.prepare(
        "SELECT json_array_length(missing_intervals_json) AS count FROM session_evidence_coverage",
      ).get()!.count,
      200n,
    );
  });

  it("enforces exact coverage checkpoint ending-scope and planned-position byte bounds", () => {
    const adapterEntry = (
      index: number,
      keyId: string,
    ): CheckpointEvidenceCoverageV2["adapterSessions"][number] => ({
      adapterSessionId: indexedUuid(300_000 + index) as never,
      coverageFirstOrdinal: "0",
      coverageLastOrdinal: "0",
      highestContiguousOrdinal: "0",
      missingIntervals: [],
      frameFingerprintAlgorithm: "hmac-sha256",
      frameFingerprintSchemaVersion: 1,
      frameFingerprintKeyId: keyId,
      frameFingerprintDomain: "pm-evidence-frame-v1",
      coverageFingerprintAlgorithm: "hmac-sha256",
      coverageFingerprintSchemaVersion: 1,
      coverageFingerprintKeyId: keyId,
      coverageFingerprintDomain: "pm-evidence-coverage-v1",
      coverageFingerprint: "a".repeat(64),
      latestBatchId: indexedUuid(301_000 + index) as never,
      latestBatchEventPosition: "1",
    });
    const exactEntries = Array.from(
      { length: 200 },
      (_, index) => adapterEntry(
        index,
        index === 0
          ? "x".repeat(127)
          : "\u0000".repeat(index === 1 ? 39 : 27),
      ),
    );
    exactEntries[0] = {
      ...exactEntries[0]!,
      coverageLastOrdinal: "1",
      highestContiguousOrdinal: null,
      missingIntervals: [{ firstOrdinal: "0", lastOrdinal: "1" }],
    };
    const exactCoverage: CheckpointEvidenceCoverageV2 = {
      coverageVersion: 2,
      captureMode: "coverage-only",
      contentRetained: false,
      adapterSessions: exactEntries,
    };
    assert.equal(
      Buffer.byteLength(canonicalJson(exactCoverage), "utf8"),
      196_608,
    );
    assert.doesNotThrow(() => assertEvidenceCoverageProjectionBounds({
      prospectiveAdapterCount: 200,
      prospectiveTotalIntervalCount: 1,
      targetIntervalCount: 1,
      evidenceCoverage: exactCoverage,
    }));
    const overCoverage: CheckpointEvidenceCoverageV2 = {
      ...exactCoverage,
      adapterSessions: exactCoverage.adapterSessions.map((entry, index) =>
        index === 2
          ? { ...entry, latestBatchEventPosition: "10" }
          : entry),
    };
    assert.equal(
      Buffer.byteLength(canonicalJson(overCoverage), "utf8"),
      196_609,
    );
    assert.throws(
      () => assertEvidenceCoverageProjectionBounds({
        prospectiveAdapterCount: 200,
        prospectiveTotalIntervalCount: 1,
        targetIntervalCount: 1,
        evidenceCoverage: overCoverage,
      }),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "EVIDENCE_COVERAGE_SNAPSHOT_TOO_LARGE"
      ),
    );

    const coverageConnection = database();
    coverageConnection.exec(`
      DROP TRIGGER IF EXISTS events_no_update;
      DROP TRIGGER IF EXISTS session_evidence_coverage_insert_guard;
      DROP TRIGGER IF EXISTS session_evidence_coverage_v3_insert_guard;
      DROP TRIGGER IF EXISTS session_evidence_coverage_transitions_insert_guard;
      DROP TRIGGER IF EXISTS session_evidence_coverage_transitions_advance_head;
    `);
    const targetAdapterIndex = 199;
    const targetAdapterSessionId = indexedUuid(
      300_000 + targetAdapterIndex,
    );
    const targetBatchId = indexedUuid(301_000 + targetAdapterIndex);
    const maximumOrdinal = "9223372036854775807";
    const maximumMissingOrdinal = "9223372036854775806";
    let exactCoveragePosition = 200n;
    const projections = (keyIds: readonly string[]) => Array.from(
      { length: 200 },
      (_, index) => ({
        ...adapterEntry(index, keyIds[index]!),
        coverageLastOrdinal: maximumOrdinal,
        highestContiguousOrdinal: null,
        missingIntervals: [{
          firstOrdinal: "0",
          lastOrdinal: maximumMissingOrdinal,
        }],
        coverageFingerprint: index === targetAdapterIndex
          ? "0".repeat(64)
          : H64,
        latestBatchEventPosition: index === targetAdapterIndex
          ? exactCoveragePosition.toString()
          : BigInt(index + 1).toString(),
      }),
    );
    const coverageBytes = (keyIds: readonly string[]): number =>
      Buffer.byteLength(canonicalJson({
        coverageVersion: 2,
        captureMode: "coverage-only",
        contentRetained: false,
        adapterSessions: projections(keyIds),
      }), "utf8");
    let keyIds = Array.from({ length: 200 }, () => "k");
    if ((196_608 - coverageBytes(keyIds)) % 2 !== 0) {
      exactCoveragePosition = 1_000n;
    }
    let remainingKeyBytes = (196_608 - coverageBytes(keyIds)) / 2;
    assert.equal(Number.isInteger(remainingKeyBytes), true);
    assert.equal(remainingKeyBytes >= 0, true);
    keyIds = keyIds.map(() => {
      const added = Math.min(127, remainingKeyBytes);
      remainingKeyBytes -= added;
      return "k".repeat(added + 1);
    });
    assert.equal(remainingKeyBytes, 0);
    assert.equal(coverageBytes(keyIds), 196_608);

    for (let index = 0; index < targetAdapterIndex; index += 1) {
      const position = BigInt(index + 1);
      rawGenericSessionEvent(coverageConnection, position);
    }
    coverageConnection.prepare(`
      UPDATE events
      SET stream_id = $streamId,
          stream_type = 'session',
          event_type = 'EvidenceCoverageRecorded',
          event_schema_version = 2
    `).run({ $streamId: `session/${SESSION_ID}` });
    for (let index = 0; index < targetAdapterIndex; index += 1) {
      const entry = projections(keyIds)[index]!;
      const position = BigInt(entry.latestBatchEventPosition);
      rawInsert(coverageConnection, "session_evidence_coverage_transitions", {
        project_id: PROJECT_ID,
        session_id: SESSION_ID,
        adapter_session_id: entry.adapterSessionId,
        batch_id: entry.latestBatchId,
        batch_event_position: position,
        batch_first_ordinal: BigInt(maximumOrdinal),
        batch_last_ordinal: BigInt(maximumOrdinal),
        coverage_first_ordinal: 0n,
        coverage_last_ordinal: BigInt(maximumOrdinal),
        highest_contiguous_ordinal: -1n,
        missing_intervals_json: `[[0,${maximumMissingOrdinal}]]`,
        frame_fingerprint_algorithm: "hmac-sha256",
        frame_fingerprint_schema_version: 1n,
        frame_fingerprint_key_id: entry.frameFingerprintKeyId,
        frame_fingerprint_domain: "pm-evidence-frame-v1",
        previous_coverage_fingerprint_value: null,
        coverage_fingerprint_algorithm: "hmac-sha256",
        coverage_fingerprint_schema_version: 1n,
        coverage_fingerprint_key_id: entry.coverageFingerprintKeyId,
        coverage_fingerprint_domain: "pm-evidence-coverage-v1",
        coverage_fingerprint_value: H64,
        new_frame_count: 1n,
        capture_mode: "coverage-only",
        content_retained: 0n,
        created_at: NOW,
      });
      rawInsert(coverageConnection, "session_evidence_coverage", {
        project_id: PROJECT_ID,
        session_id: SESSION_ID,
        adapter_session_id: entry.adapterSessionId,
        capture_mode: "coverage-only",
        first_ordinal: 0n,
        last_ordinal: BigInt(maximumOrdinal),
        highest_contiguous_ordinal: -1n,
        missing_intervals_json: `[[0,${maximumMissingOrdinal}]]`,
        fingerprint_algorithm: "hmac-sha256",
        fingerprint_schema_version: 1n,
        fingerprint_key_id: entry.frameFingerprintKeyId,
        fingerprint_domain: "pm-evidence-frame-v1",
        latest_batch_id: entry.latestBatchId,
        latest_batch_event_position: position,
        created_at: NOW,
        updated_at: NOW,
        coverage_fingerprint_algorithm: "hmac-sha256",
        coverage_fingerprint_schema_version: 1n,
        coverage_fingerprint_key_id: entry.coverageFingerprintKeyId,
        coverage_fingerprint_domain: "pm-evidence-coverage-v1",
        coverage_fingerprint_value: H64,
      });
      rawInsert(
        coverageConnection,
        "session_evidence_coverage_transition_heads",
        {
          project_id: PROJECT_ID,
          session_id: SESSION_ID,
          adapter_session_id: entry.adapterSessionId,
          batch_event_position: position,
        },
      );
    }
    const coverageCommand = command({
      commandId: indexedUuid(303_000),
      idempotencyKey: "exact-coverage-repository-bound",
      sessionId: SESSION_ID as never,
      adapterSessionId: targetAdapterSessionId as never,
      batchId: targetBatchId as never,
      fingerprintKeyId: keyIds[targetAdapterIndex],
      firstOrdinal: maximumOrdinal,
      lastOrdinal: maximumOrdinal,
      frames: [{
        frameId: indexedUuid(303_001) as never,
        ordinal: maximumOrdinal,
        sourceKind: "external-observation",
        observedAt: NOW,
        contentFingerprint: "f".repeat(64),
      }],
    });
    const exactCoverageRecorder = providerRecorder(
      undefined,
      "available",
      keyIds[targetAdapterIndex],
    );
    const exactCoveragePrepared = new EvidenceCoverageRepository(
      exactCoverageRecorder.provider,
    ).prepareBatch(coverageConnection, {
      context: context(),
      command: coverageCommand,
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: exactCoveragePosition,
    });
    const exactCoverageSnapshot: CheckpointEvidenceCoverageV2 = {
      coverageVersion: 2,
      captureMode: "coverage-only",
      contentRetained: false,
      adapterSessions: projections(keyIds).map((entry, index) =>
        index === targetAdapterIndex
          ? {
            ...entry,
            coverageFingerprint:
              exactCoveragePrepared.eventPayload.coverageFingerprint,
          }
          : entry),
    };
    assert.equal(
      Buffer.byteLength(canonicalJson(exactCoverageSnapshot), "utf8"),
      196_608,
    );
    assert.equal(exactCoverageRecorder.calls.currentKey, 1);
    const coverageState = repositoryTableCounts(coverageConnection);
    const overCoverageRecorder = providerRecorder(
      undefined,
      "available",
      keyIds[targetAdapterIndex],
    );
    const overCoveragePosition = exactCoveragePosition * 10n;
    assert.equal(
      coverageBytes(keyIds) + (
        overCoveragePosition.toString().length
        - exactCoveragePosition.toString().length
      ),
      196_609,
    );
    assert.throws(
      () => new EvidenceCoverageRepository(overCoverageRecorder.provider)
        .prepareBatch(coverageConnection, {
          context: context(),
          command: coverageCommand,
          prospectiveEndingScopeBindings: [],
          plannedEventPosition: overCoveragePosition,
        }),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "EVIDENCE_COVERAGE_SNAPSHOT_TOO_LARGE"
      ),
    );
    assert.deepEqual(
      overCoverageRecorder.calls,
      { currentKey: 0, status: 0, fingerprint: 0 },
    );
    assert.deepEqual(repositoryTableCounts(coverageConnection), coverageState);

    const exactBindings = Array.from({ length: 580 }, (_, index) =>
      endingBinding(index));
    const exactCommand = command({
      fingerprintKeyId: "k",
      firstOrdinal: "1000",
      lastOrdinal: "1000",
      frames: [{
        frameId: indexedUuid(302_001) as never,
        ordinal: "1000",
        sourceKind: "external-observation",
        observedAt: NOW,
        contentFingerprint: "f".repeat(64),
      }],
    });
    const exactConnection = database();
    const exactRecorder = providerRecorder(undefined, "available", "k");
    const exactRepository = new EvidenceCoverageRepository(exactRecorder.provider);
    const exactPrepared = exactRepository.prepareBatch(exactConnection, {
      context: context(),
      command: exactCommand,
      prospectiveEndingScopeBindings: exactBindings,
      plannedEventPosition: 1n,
    });
    const prospectiveCoverage: CheckpointEvidenceCoverageV2 = {
      coverageVersion: 2,
      captureMode: "coverage-only",
      contentRetained: false,
      adapterSessions: [{
        adapterSessionId: exactPrepared.adapterSessionId,
        coverageFirstOrdinal: "0",
        coverageLastOrdinal: exactPrepared.eventPayload.coverageLastOrdinal,
        highestContiguousOrdinal:
          exactPrepared.eventPayload.highestContiguousOrdinal,
        missingIntervals: exactPrepared.eventPayload.missingIntervals,
        frameFingerprintAlgorithm: "hmac-sha256",
        frameFingerprintSchemaVersion: 1,
        frameFingerprintKeyId: "k",
        frameFingerprintDomain: "pm-evidence-frame-v1",
        coverageFingerprintAlgorithm: "hmac-sha256",
        coverageFingerprintSchemaVersion: 1,
        coverageFingerprintKeyId: "k",
        coverageFingerprintDomain: "pm-evidence-coverage-v1",
        coverageFingerprint: exactPrepared.eventPayload.coverageFingerprint,
        latestBatchId: exactPrepared.eventPayload.batchId,
        latestBatchEventPosition: "1",
      }],
    };
    assert.equal(
      exactRepository.minimumCheckpointUpperBound(exactConnection, {
        evidenceCoverage: prospectiveCoverage,
        endingScopeBindings: exactBindings,
      }),
      262_144,
    );
    assert.equal(exactRecorder.calls.currentKey, 1);

    const plusOneConnection = database();
    const plusOneRecorder = providerRecorder(undefined, "available", "k");
    assert.throws(
      () => new EvidenceCoverageRepository(plusOneRecorder.provider)
        .prepareBatch(plusOneConnection, {
          context: context(),
          command: exactCommand,
          prospectiveEndingScopeBindings: exactBindings,
          plannedEventPosition: 10n,
        }),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "CHECKPOINT_CAPACITY_EXCEEDED"
      ),
    );
    assert.deepEqual(
      plusOneRecorder.calls,
      { currentKey: 0, status: 0, fingerprint: 0 },
    );
    assert.deepEqual(
      repositoryTableCounts(plusOneConnection),
      {
        events: 0n,
        session_evidence_coverage_transitions: 0n,
        session_evidence_coverage_transition_heads: 0n,
        session_evidence_coverage: 0n,
        session_evidence_fingerprints: 0n,
      },
    );
    const plusOneCoverage: CheckpointEvidenceCoverageV2 = {
      ...prospectiveCoverage,
      adapterSessions: prospectiveCoverage.adapterSessions.map((entry) => ({
        ...entry,
        latestBatchEventPosition: "10",
      })),
    };
    assert.equal(
      exactRepository.minimumCheckpointUpperBound(plusOneConnection, {
        evidenceCoverage: plusOneCoverage,
        endingScopeBindings: exactBindings,
      }),
      262_145,
    );

    const placeholderConnection = database();
    const placeholderRecorder = providerRecorder(undefined, "available", "k");
    assert.throws(
      () => new EvidenceCoverageRepository(placeholderRecorder.provider)
        .prepareBatch(placeholderConnection, {
          context: context(),
          command: exactCommand,
          prospectiveEndingScopeBindings: exactBindings,
          plannedEventPosition: null,
        }),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "CHECKPOINT_CAPACITY_EXCEEDED"
      ),
    );
    assert.deepEqual(
      placeholderRecorder.calls,
      { currentKey: 0, status: 0, fingerprint: 0 },
    );
    assert.deepEqual(
      repositoryTableCounts(placeholderConnection),
      {
        events: 0n,
        session_evidence_coverage_transitions: 0n,
        session_evidence_coverage_transition_heads: 0n,
        session_evidence_coverage: 0n,
        session_evidence_fingerprints: 0n,
      },
    );
    const finalExactBindings = Array.from({ length: 605 }, (_, index) =>
      carryEndingBinding(index));
    assert.equal(
      exactRepository.minimumFinalEndingScopeBindingsUpperBound(
        exactConnection,
        { endingScopeBindings: finalExactBindings },
      ),
      261_966,
    );
    const finalExactConnection = database();
    const finalExactRecorder = providerRecorder(undefined, "available", "k");
    assert.doesNotThrow(() =>
      new EvidenceCoverageRepository(finalExactRecorder.provider)
        .prepareBatch(finalExactConnection, {
          context: context(),
          command: exactCommand,
          prospectiveEndingScopeBindings: finalExactBindings,
          plannedEventPosition: 1n,
        }));
    assert.equal(finalExactRecorder.calls.currentKey, 1);
    assert.deepEqual(
      repositoryTableCounts(finalExactConnection),
      {
        events: 0n,
        session_evidence_coverage_transitions: 0n,
        session_evidence_coverage_transition_heads: 0n,
        session_evidence_coverage: 0n,
        session_evidence_fingerprints: 0n,
      },
    );

    const finalOverBindings = Array.from({ length: 606 }, (_, index) =>
      carryEndingBinding(index));
    assert.equal(
      exactRepository.minimumFinalEndingScopeBindingsUpperBound(
        exactConnection,
        { endingScopeBindings: finalOverBindings },
      ),
      262_399,
    );
    const finalOverConnection = database();
    const finalOverRecorder = providerRecorder(undefined, "available", "k");
    assert.throws(
      () => new EvidenceCoverageRepository(finalOverRecorder.provider)
        .prepareBatch(finalOverConnection, {
          context: context(),
          command: exactCommand,
          prospectiveEndingScopeBindings: finalOverBindings,
          plannedEventPosition: 1n,
        }),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "CHECKPOINT_CAPACITY_EXCEEDED"
      ),
    );
    assert.deepEqual(
      finalOverRecorder.calls,
      { currentKey: 0, status: 0, fingerprint: 0 },
    );
    assert.deepEqual(
      repositoryTableCounts(finalOverConnection),
      {
        events: 0n,
        session_evidence_coverage_transitions: 0n,
        session_evidence_coverage_transition_heads: 0n,
        session_evidence_coverage: 0n,
        session_evidence_fingerprints: 0n,
      },
    );
  });

  it("persists transition aggregate and ordinal order with real foreign keys", () => {
    const connection = database();
    const repository = new EvidenceCoverageRepository(providerRecorder().provider);
    const prepared = repository.prepareBatch(connection, {
      context: context(),
      command: command(),
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: 1n,
    });
    const committed = storedEvent(
      connection,
      prepared.eventPayload as unknown as Readonly<Record<string, unknown>>,
    );
    seedAuthorityForForeignKeys(connection, committed.globalPosition);
    connection.exec("PRAGMA foreign_keys = ON");
    const order: string[] = [];
    const inspected: SqliteConnection = {
      exec(sql) {
        connection.exec(sql);
      },
      prepare(sql) {
        const statement = connection.prepare(sql);
        return {
          run(params) {
            if (sql.includes("INSERT INTO session_evidence_coverage_transitions")) {
              order.push("transition");
            } else if (sql.includes("INSERT INTO session_evidence_coverage(")) {
              order.push("aggregate");
            } else if (sql.includes("INSERT INTO session_evidence_fingerprints")) {
              order.push("ordinal");
            }
            return statement.run(params);
          },
          get(params) {
            return statement.get(params);
          },
          all(params) {
            return statement.all(params);
          },
          iterate(params) {
            return statement.iterate(params);
          },
        };
      },
      close() {
        connection.close();
      },
    };

    connection.exec("BEGIN IMMEDIATE");
    repository.persistPrepared(inspected, prepared, committed);
    connection.exec("COMMIT");
    assert.deepEqual(order, ["transition", "aggregate", "ordinal"]);
    assert.equal(
      connection.prepare(
        "SELECT count(*) AS count FROM session_evidence_coverage_transition_heads",
      ).get()!.count,
      1n,
    );
    assert.equal(
      connection.prepare("PRAGMA foreign_key_check").all().length,
      0,
    );
  });

  it("checks each distinct current profile once during bounded quick health", () => {
    const connection = database();
    const recorder = providerRecorder();
    const repository = new EvidenceCoverageRepository(recorder.provider);
    const first = repository.prepareBatch(connection, {
      context: context(),
      command: command(),
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: 1n,
    });
    repository.persistPrepared(
      connection,
      first,
      storedEvent(
        connection,
        first.eventPayload as unknown as Readonly<Record<string, unknown>>,
      ),
    );

    const secondCommand = command({
      commandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      idempotencyKey: "evidence-second-adapter",
      adapterSessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as never,
      batchId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as never,
      firstOrdinal: "0",
      lastOrdinal: "0",
      frames: [{
        frameId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" as never,
        ordinal: "0",
        sourceKind: "adapter-event",
        observedAt: NOW,
        contentFingerprint: "d".repeat(64),
      }],
    });
    const second = repository.prepareBatch(connection, {
      context: context(),
      command: secondCommand,
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: 2n,
    });
    repository.persistPrepared(
      connection,
      second,
      storedEvent(
        connection,
        second.eventPayload as unknown as Readonly<Record<string, unknown>>,
        {
          globalPosition: 2n,
          commandId: secondCommand.commandId,
          idempotencyKey: secondCommand.idempotencyKey,
          streamVersion: 2n,
        },
      ),
    );

    const statusCallsBeforeHealth = recorder.calls.status;
    repository.assertQuickHealthy(connection, [SESSION_ID as never]);
    assert.equal(recorder.calls.status, statusCallsBeforeHealth + 1);
    assert.deepEqual(recorder.statusInputs.at(-1), {
      scope: { projectId: PROJECT_ID, storeId: STORE_ID },
      purpose: "evidence-fingerprint",
      keyId: "key-1",
    });

    const unavailable = providerRecorder(undefined, "unavailable");
    assert.throws(
      () => new EvidenceCoverageRepository(unavailable.provider)
        .assertQuickHealthy(connection, [SESSION_ID as never]),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "EVIDENCE_HISTORICAL_KEY_UNAVAILABLE"
      ),
    );
    assert.equal(unavailable.calls.status, 1);
  });

  it("rejects an over-bound historical key in an event-time transition snapshot", () => {
    const connection = database();
    const repository = new EvidenceCoverageRepository(providerRecorder().provider);
    const prepared = repository.prepareBatch(connection, {
      context: context(),
      command: command(),
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: 1n,
    });
    repository.persistPrepared(
      connection,
      prepared,
      storedEvent(
        connection,
        prepared.eventPayload as unknown as Readonly<Record<string, unknown>>,
      ),
    );

    connection.exec("DROP TRIGGER session_evidence_coverage_transitions_no_update");
    connection.prepare(`
      UPDATE session_evidence_coverage_transitions
      SET frame_fingerprint_key_id = $keyId,
          coverage_fingerprint_key_id = $keyId
    `).run({ $keyId: "k".repeat(129) });

    assert.throws(
      () => repository.snapshotFromTransitionsV2(
        connection,
        SESSION_ID as never,
        1n,
      ),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "INTEGRITY_FAILURE"
      ),
    );
  });

  it("counts profile key bounds by Unicode scalar rather than UTF-16 units", () => {
    const connection = database();
    const keyId = "💡".repeat(128);
    const repository = new EvidenceCoverageRepository(
      providerRecorder(undefined, "available", keyId).provider,
    );

    const prepared = repository.prepareBatch(connection, {
      context: context(),
      command: command({ fingerprintKeyId: keyId }),
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: 1n,
    });

    assert.equal(prepared.eventPayload.frameFingerprintKeyId, keyId);
    assert.equal(prepared.eventPayload.coverageFingerprintKeyId, keyId);
  });

  it("deduplicates quick-health status across sessions sharing one profile", () => {
    const connection = database();
    const recorder = providerRecorder();
    const repository = new EvidenceCoverageRepository(recorder.provider);
    const first = repository.prepareBatch(connection, {
      context: context(),
      command: command(),
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: 1n,
    });
    repository.persistPrepared(
      connection,
      first,
      storedEvent(
        connection,
        first.eventPayload as unknown as Readonly<Record<string, unknown>>,
      ),
    );

    const secondSessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const secondCommand = command({
      commandId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      idempotencyKey: "evidence-second-session",
      sessionId: secondSessionId as never,
      adapterSessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as never,
      batchId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" as never,
      firstOrdinal: "0",
      lastOrdinal: "0",
      frames: [{
        frameId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" as never,
        ordinal: "0",
        sourceKind: "external-observation",
        observedAt: NOW,
        contentFingerprint: "e".repeat(64),
      }],
    });
    const second = repository.prepareBatch(connection, {
      context: context(),
      command: secondCommand,
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: 2n,
    });
    repository.persistPrepared(
      connection,
      second,
      storedEvent(
        connection,
        second.eventPayload as unknown as Readonly<Record<string, unknown>>,
        {
          globalPosition: 2n,
          sessionId: secondSessionId,
          streamId: `session/${secondSessionId}`,
          commandId: secondCommand.commandId,
          idempotencyKey: secondCommand.idempotencyKey,
          streamVersion: 1n,
        },
      ),
    );

    const statusCallsBeforeHealth = recorder.calls.status;
    repository.assertQuickHealthy(
      connection,
      [SESSION_ID as never, secondSessionId as never],
    );
    assert.equal(recorder.calls.status, statusCallsBeforeHealth + 1);
  });

  it("counts lifetime adapters before selecting an event-time snapshot", () => {
    const connection = database();
    const repository = new EvidenceCoverageRepository(providerRecorder().provider);
    const prepared = repository.prepareBatch(connection, {
      context: context(),
      command: command(),
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: 1n,
    });
    repository.persistPrepared(
      connection,
      prepared,
      storedEvent(
        connection,
        prepared.eventPayload as unknown as Readonly<Record<string, unknown>>,
      ),
    );

    let lifetimeCountSql = "";
    const inspected: SqliteConnection = {
      exec(sql) {
        connection.exec(sql);
      },
      prepare(sql) {
        if (sql.includes("FROM session_evidence_coverage_transition_heads")) {
          lifetimeCountSql = sql;
        }
        return connection.prepare(sql);
      },
      close() {
        connection.close();
      },
    };
    repository.snapshotFromTransitionsV2(
      inspected,
      SESSION_ID as never,
      1n,
    );

    assert.match(lifetimeCountSql, /session_evidence_coverage_transition_heads/);
    assert.match(lifetimeCountSql, /LIMIT 201/);
    assert.doesNotMatch(lifetimeCountSql, /batch_event_position\s*<=/);
  });

  it("rejects every coverage artifact during Version 1 eligibility", () => {
    const connection = database();
    rawInsert(connection, "session_evidence_coverage_transition_heads", {
      project_id: PROJECT_ID,
      session_id: SESSION_ID,
      adapter_session_id: ADAPTER_ID,
      batch_event_position: 1n,
    });

    assert.throws(
      () => new EvidenceCoverageRepository(providerRecorder().provider)
        .assertVersion1Eligible(connection, [SESSION_ID as never]),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "CHECKPOINT_EVIDENCE_VERSION_REQUIRED"
      ),
    );
  });

  it("rejects the independent Version 1 eligibility artifact matrix", () => {
    const assertRejected = (
      seed: (connection: SqliteConnection) => void,
    ): void => {
      const connection = database();
      seed(connection);
      assert.throws(
        () => new EvidenceCoverageRepository(providerRecorder().provider)
          .assertVersion1Eligible(connection, [SESSION_ID as never]),
        (error: unknown) => (
          error instanceof Error
          && "code" in error
          && error.code === "CHECKPOINT_EVIDENCE_VERSION_REQUIRED"
        ),
      );
    };
    assertRejected((connection) => {
      connection.exec("DROP TRIGGER session_evidence_coverage_v3_insert_guard");
      rawInsert(connection, "session_evidence_coverage", {
        project_id: PROJECT_ID,
        session_id: SESSION_ID,
        adapter_session_id: ADAPTER_ID,
        capture_mode: "coverage-only",
        first_ordinal: 0n,
        last_ordinal: 0n,
        highest_contiguous_ordinal: 0n,
        missing_intervals_json: "[]",
        fingerprint_algorithm: "hmac-sha256",
        fingerprint_schema_version: 1n,
        fingerprint_key_id: "key-1",
        fingerprint_domain: "pm-evidence-frame-v1",
        latest_batch_id: BATCH_ID,
        latest_batch_event_position: 1n,
        created_at: NOW,
        updated_at: NOW,
        coverage_fingerprint_algorithm: "hmac-sha256",
        coverage_fingerprint_schema_version: 1n,
        coverage_fingerprint_key_id: "key-1",
        coverage_fingerprint_domain: "pm-evidence-coverage-v1",
        coverage_fingerprint_value: H64,
      });
    });
    assertRejected((connection) => {
      connection.exec(
        "DROP TRIGGER session_evidence_coverage_transitions_insert_guard",
      );
      connection.exec(
        "DROP TRIGGER session_evidence_coverage_transitions_advance_head",
      );
      rawInsert(connection, "session_evidence_coverage_transitions", {
        project_id: PROJECT_ID,
        session_id: SESSION_ID,
        adapter_session_id: ADAPTER_ID,
        batch_id: BATCH_ID,
        batch_event_position: 1n,
        batch_first_ordinal: 0n,
        batch_last_ordinal: 0n,
        coverage_first_ordinal: 0n,
        coverage_last_ordinal: 0n,
        highest_contiguous_ordinal: 0n,
        missing_intervals_json: "[]",
        frame_fingerprint_algorithm: "hmac-sha256",
        frame_fingerprint_schema_version: 1n,
        frame_fingerprint_key_id: "key-1",
        frame_fingerprint_domain: "pm-evidence-frame-v1",
        previous_coverage_fingerprint_value: null,
        coverage_fingerprint_algorithm: "hmac-sha256",
        coverage_fingerprint_schema_version: 1n,
        coverage_fingerprint_key_id: "key-1",
        coverage_fingerprint_domain: "pm-evidence-coverage-v1",
        coverage_fingerprint_value: H64,
        new_frame_count: 1n,
        capture_mode: "coverage-only",
        content_retained: 0n,
        created_at: NOW,
      });
    });
    assertRejected((connection) => {
      rawInsert(connection, "session_evidence_coverage_transition_heads", {
        project_id: PROJECT_ID,
        session_id: SESSION_ID,
        adapter_session_id: ADAPTER_ID,
        batch_event_position: 1n,
      });
    });
    assertRejected((connection) => {
      rawInsert(connection, "session_evidence_fingerprints", {
        project_id: PROJECT_ID,
        session_id: SESSION_ID,
        adapter_session_id: ADAPTER_ID,
        ordinal: 0n,
        frame_id: FRAME_ID,
        source_kind: "model-turn",
        observed_at: NOW,
        fingerprint_algorithm: "hmac-sha256",
        fingerprint_schema_version: 1n,
        fingerprint_key_id: "key-1",
        fingerprint_domain: "pm-evidence-frame-v1",
        fingerprint_value: FRAME_H64,
        batch_id: BATCH_ID,
        recorded_event_position: 1n,
        created_at: NOW,
      });
    });
    assertRejected((connection) => {
      rawGenericSessionEvent(connection, 1n);
      seedAuthorityForForeignKeys(connection, 1n);
      connection.exec("DROP TRIGGER events_no_update");
      connection.prepare(`
        UPDATE events
        SET stream_id = $streamId,
            stream_type = 'session',
            event_type = 'EvidenceCoverageRecorded'
        WHERE global_position = 1
      `).run({ $streamId: `session/${SESSION_ID}` });
    });
    for (const evidenceCoverage of [
      {
        highestContiguousOrdinal: "0",
        missingIntervals: [],
      },
      {
        adapterSessions: [{
          adapterSessionId: ADAPTER_ID,
        }],
      },
    ]) {
      assertRejected((connection) => {
        rawGenericSessionEvent(connection, 1n);
        seedAuthorityForForeignKeys(connection, 1n, true);
        connection.exec("DROP TRIGGER events_no_update");
        connection.prepare(`
          UPDATE events
          SET stream_id = $streamId,
              stream_type = 'session',
              event_type = 'SessionCheckpointRecorded',
              payload_json = $payloadJson
          WHERE global_position = 1
        `).run({
          $streamId: `session/${SESSION_ID}`,
          $payloadJson: canonicalJson({
            checkpoint: { evidenceCoverage },
          }),
        });
      });
    }
  });

  it("rejects non-current evidence events and superseded coverage checkpoints", () => {
    const assertHistoricalRejected = (
      eventType: string,
      eventSchemaVersion: bigint,
      payload: Readonly<Record<string, unknown>>,
    ): string => {
      const connection = database();
      rawGenericSessionEvent(connection, 1n);
      rawGenericSessionEvent(connection, 2n);
      connection.exec("DROP TRIGGER events_no_update");
      const laterIsCheckpoint = eventType === "SessionCheckpointRecorded";
      const laterPayload = laterIsCheckpoint
        ? {
          checkpoint: {
            checkpointVersion: Number(eventSchemaVersion),
            evidenceCoverage: {
              highestContiguousOrdinal: null,
              missingIntervals: [],
              adapterSessions: [],
            },
          },
        }
        : {};
      connection.prepare(`
        UPDATE events
        SET stream_id = $streamId,
            stream_type = 'session',
            stream_version = global_position,
            event_type = CASE global_position
              WHEN 1 THEN $eventType
              ELSE $laterEventType
            END,
            event_schema_version = CASE global_position
              WHEN 1 THEN $eventSchemaVersion
              ELSE $laterEventSchemaVersion
            END,
            payload_json = CASE global_position
              WHEN 1 THEN $payloadJson
              ELSE $laterPayloadJson
            END
      `).run({
        $streamId: `session/${SESSION_ID}`,
        $eventType: eventType,
        $eventSchemaVersion: eventSchemaVersion,
        $payloadJson: canonicalJson(payload),
        $laterEventType: laterIsCheckpoint
          ? "SessionCheckpointRecorded"
          : "GenericEvent",
        $laterEventSchemaVersion: laterIsCheckpoint
          ? eventSchemaVersion
          : 1n,
        $laterPayloadJson: canonicalJson(laterPayload),
      });
      let artifactSql = "";
      const inspected: SqliteConnection = {
        exec(sql) {
          connection.exec(sql);
        },
        prepare(sql) {
          if (
            sql.includes("FROM events")
            && sql.includes("EvidenceCoverageRecorded")
            && sql.includes("LIMIT 1")
          ) {
            artifactSql = sql;
          }
          return connection.prepare(sql);
        },
        close() {
          connection.close();
        },
      };
      assert.throws(
        () => new EvidenceCoverageRepository(providerRecorder().provider)
          .assertVersion1Eligible(inspected, [SESSION_ID as never]),
        (error: unknown) => (
          error instanceof Error
          && "code" in error
          && error.code === "CHECKPOINT_EVIDENCE_VERSION_REQUIRED"
        ),
      );
      return artifactSql;
    };

    const evidenceSql = assertHistoricalRejected(
      "EvidenceCoverageRecorded",
      99n,
      {},
    );
    const checkpointV1Sql = assertHistoricalRejected(
      "SessionCheckpointRecorded",
      1n,
      {
        checkpoint: {
          checkpointVersion: 1,
          evidenceCoverage: {
            highestContiguousOrdinal: "0",
            missingIntervals: [],
            adapterSessions: [],
          },
        },
      },
    );
    const checkpointV2Sql = assertHistoricalRejected(
      "SessionCheckpointRecorded",
      2n,
      {
        checkpoint: {
          checkpointVersion: 2,
          evidenceCoverage: {
            highestContiguousOrdinal: null,
            missingIntervals: [],
            adapterSessions: [{ adapterSessionId: ADAPTER_ID }],
          },
        },
      },
    );
    assert.equal(evidenceSql, checkpointV1Sql);
    assert.equal(evidenceSql, checkpointV2Sql);
  });

  it("keeps clean missing null and empty historical checkpoint coverage eligible", () => {
    const connection = database();
    for (let position = 1n; position <= 3n; position += 1n) {
      rawGenericSessionEvent(connection, position);
    }
    connection.exec("DROP TRIGGER events_no_update");
    const cleanPayloads = [
      { checkpoint: { checkpointVersion: 1 } },
      {
        checkpoint: {
          checkpointVersion: 1,
          evidenceCoverage: {
            highestContiguousOrdinal: null,
            missingIntervals: [],
            adapterSessions: [],
          },
        },
      },
      {
        checkpoint: {
          checkpointVersion: 2,
          evidenceCoverage: {
            highestContiguousOrdinal: null,
            missingIntervals: [],
            adapterSessions: [],
          },
        },
      },
    ];
    for (let index = 0; index < cleanPayloads.length; index += 1) {
      connection.prepare(`
        UPDATE events
        SET stream_id = $streamId,
            stream_type = 'session',
            stream_version = global_position,
            event_type = 'SessionCheckpointRecorded',
            event_schema_version = $eventSchemaVersion,
            payload_json = $payloadJson
        WHERE global_position = $globalPosition
      `).run({
        $streamId: `session/${SESSION_ID}`,
        $eventSchemaVersion: index === 2 ? 2n : 1n,
        $payloadJson: canonicalJson(cleanPayloads[index]),
        $globalPosition: BigInt(index + 1),
      });
    }
    let artifactSql = "";
    const inspected: SqliteConnection = {
      exec(sql) {
        connection.exec(sql);
      },
      prepare(sql) {
        if (
          sql.includes("FROM events")
          && sql.includes("EvidenceCoverageRecorded")
          && sql.includes("LIMIT 1")
        ) {
          artifactSql = sql;
        }
        return connection.prepare(sql);
      },
      close() {
        connection.close();
      },
    };
    assert.doesNotThrow(() =>
      new EvidenceCoverageRepository(providerRecorder().provider)
        .assertVersion1Eligible(inspected, [SESSION_ID as never]));
    assert.notEqual(artifactSql, "");
    const plan = connection.prepare(
      `EXPLAIN QUERY PLAN ${artifactSql}`,
    ).all({
      $projectId: PROJECT_ID,
      $sessionId: SESSION_ID,
    }).map((row) => String(row.detail));
    assert.equal(
      plan.some((detail) =>
        detail.includes(
          "SEARCH events USING INDEX events_session_evidence_artifacts "
          + "(project_id=? AND session_id=?)",
        )),
      true,
    );
    assert.equal(
      plan.some((detail) =>
        /SCAN events|USE TEMP B-TREE/i.test(detail)),
      false,
    );
  });

  it("bounds event-time snapshot work by adapter identities rather than transition history", () => {
    const connection = database();
    const repository = new EvidenceCoverageRepository(providerRecorder().provider);
    let priorPosition = 0n;
    for (let index = 0; index < 32; index += 1) {
      const position = BigInt(index + 1);
      const ordinal = BigInt(index + 5).toString();
      const batchCommand = command({
        commandId: indexedUuid(40_000 + index),
        idempotencyKey: `deep-batch-${index}`,
        batchId: indexedUuid(50_000 + index) as never,
        firstOrdinal: ordinal,
        lastOrdinal: ordinal,
        frames: [{
          frameId: indexedUuid(60_000 + index) as never,
          ordinal,
          sourceKind: "adapter-event",
          observedAt: NOW,
          contentFingerprint: index.toString(16).padStart(64, "0"),
        }],
      });
      const prepared = repository.prepareBatch(connection, {
        context: context(),
        command: batchCommand,
        prospectiveEndingScopeBindings: [],
        plannedEventPosition: position,
      });
      repository.persistPrepared(
        connection,
        prepared,
        storedEvent(
          connection,
          prepared.eventPayload as unknown as Readonly<Record<string, unknown>>,
          {
            globalPosition: position,
            eventId: indexedUuid(70_000 + index),
            commandId: batchCommand.commandId,
            idempotencyKey: batchCommand.idempotencyKey,
            streamVersion: position,
          },
        ),
      );
      priorPosition = position;
    }
    assert.equal(priorPosition, 32n);

    let headEnumerations = 0;
    let indexedTransitionSeeks = 0;
    let unboundedTransitionQueries = 0;
    let headEnumerationSql = "";
    const inspected: SqliteConnection = {
      exec(sql) {
        connection.exec(sql);
      },
      prepare(sql) {
        if (sql.includes("FROM session_evidence_coverage_transition_heads")) {
          headEnumerations += 1;
          headEnumerationSql = sql;
        }
        if (
          sql.includes("FROM session_evidence_coverage_transitions")
          && sql.includes("ORDER BY batch_event_position DESC")
          && sql.includes("LIMIT 1")
        ) {
          indexedTransitionSeeks += 1;
        }
        if (
          sql.includes("count(DISTINCT adapter_session_id)")
          || sql.includes("SELECT max(candidate.batch_event_position)")
        ) {
          unboundedTransitionQueries += 1;
        }
        return connection.prepare(sql);
      },
      close() {
        connection.close();
      },
    };

    const historical = repository.snapshotFromTransitionsV2(
      inspected,
      SESSION_ID as never,
      16n,
    );
    assert.equal(historical.adapterSessions[0]!.latestBatchEventPosition, "16");
    assert.equal(headEnumerations, 1);
    assert.equal(indexedTransitionSeeks, 1);
    assert.equal(unboundedTransitionQueries, 0);
    assert.doesNotMatch(headEnumerationSql, /ORDER BY|CAST\s*\(/i);
    const headPlan = connection.prepare(
      `EXPLAIN QUERY PLAN ${headEnumerationSql}`,
    ).all({
      $projectId: PROJECT_ID,
      $sessionId: SESSION_ID,
    }).map((row) => String(row.detail));
    assert.equal(
      headPlan.some((detail) =>
        detail.includes(
          "SEARCH session_evidence_coverage_transition_heads "
          + "USING COVERING INDEX sqlite_autoindex_"
          + "session_evidence_coverage_transition_heads_1 "
          + "(project_id=? AND session_id=?)",
        )),
      true,
    );
    assert.equal(
      headPlan.some((detail) =>
        /SCAN|USE TEMP B-TREE/i.test(detail)),
      false,
    );
  });

  it("keeps Version 1 eligibility independent of deep event history", () => {
    const connection = database();
    for (let position = 1n; position <= 512n; position += 1n) {
      rawGenericSessionEvent(connection, position);
    }
    let historyJsonQueries = 0;
    const inspected: SqliteConnection = {
      exec(sql) {
        connection.exec(sql);
      },
      prepare(sql) {
        if (
          sql.includes("SELECT 1 FROM events")
          && sql.includes("json_array_length")
        ) {
          historyJsonQueries += 1;
        }
        return connection.prepare(sql);
      },
      close() {
        connection.close();
      },
    };

    new EvidenceCoverageRepository(providerRecorder().provider)
      .assertVersion1Eligible(inspected, [SESSION_ID as never]);
    assert.equal(historyJsonQueries, 0);
  });

  it("detaches the complete batch before re-entrant provider alias mutation", () => {
    const connection = database();
    const mutableCommand = command() as RecordEvidenceBatchCommandV2 & {
      batchId: string;
      frames: {
        frameId: string;
        ordinal: string;
        sourceKind: "model-turn";
        observedAt: string;
        contentFingerprint: string;
      }[];
    };
    const originalBatchId = mutableCommand.batchId;
    const originalFingerprint = mutableCommand.frames[0]!.contentFingerprint;
    const recorder = providerRecorder();
    const provider = {
      ...recorder.provider,
      currentKey(
        scope: { projectId: string; storeId: string },
        purpose: "evidence-fingerprint",
      ) {
        mutableCommand.batchId = "ffffffff-ffff-4fff-bfff-ffffffffffff" as never;
        mutableCommand.frames[0]!.contentFingerprint = "e".repeat(64);
        return recorder.provider.currentKey(scope, purpose);
      },
    };

    const prepared = new EvidenceCoverageRepository(provider).prepareBatch(
      connection,
      {
        context: context(),
        command: mutableCommand,
        prospectiveEndingScopeBindings: [],
        plannedEventPosition: 1n,
      },
    );

    assert.equal(prepared.eventPayload.batchId, originalBatchId);
    assert.equal(
      prepared.eventPayload.frames[0]!.contentFingerprint,
      originalFingerprint,
    );
    assert.equal(prepared.newFrames[0]!.contentFingerprint, originalFingerprint);
    assert.equal(
      (recorder.fingerprintInputs[0]!.body as {
        newFrames: readonly { contentFingerprint: string }[];
      }).newFrames[0]!.contentFingerprint,
      originalFingerprint,
    );
  });

  it("matches only incoming ordinal and frame IDs without scanning deep ordinal history", () => {
    const connection = database();
    const repository = new EvidenceCoverageRepository(providerRecorder().provider);
    const frames = Array.from({ length: 2_000 }, (_, index) => ({
      frameId: indexedUuid(500_000 + index) as never,
      ordinal: index.toString(),
      sourceKind: "adapter-event" as const,
      observedAt: NOW,
      contentFingerprint: index.toString(16).padStart(64, "0"),
    }));
    const initialCommand = command({
      commandId: indexedUuid(502_001),
      idempotencyKey: "deep-ordinal-initial",
      batchId: indexedUuid(502_002) as never,
      firstOrdinal: "0",
      lastOrdinal: "1999",
      frames,
    });
    const initial = repository.prepareBatch(connection, {
      context: context(),
      command: initialCommand,
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: 1n,
    });
    repository.persistPrepared(
      connection,
      initial,
      storedEvent(
        connection,
        initial.eventPayload as unknown as Readonly<Record<string, unknown>>,
        {
          commandId: initialCommand.commandId,
          idempotencyKey: initialCommand.idempotencyKey,
        },
      ),
    );

    const ordinalQueries: string[] = [];
    const inspected: SqliteConnection = {
      exec(sql) {
        connection.exec(sql);
      },
      prepare(sql) {
        if (sql.includes("FROM session_evidence_fingerprints")) {
          ordinalQueries.push(sql);
        }
        return connection.prepare(sql);
      },
      close() {
        connection.close();
      },
    };
    const overlap = repository.prepareBatch(inspected, {
      context: context(),
      command: command({
        commandId: indexedUuid(502_003),
        idempotencyKey: "deep-ordinal-overlap",
        batchId: indexedUuid(502_004) as never,
        firstOrdinal: "0",
        lastOrdinal: "0",
        frames: [frames[0]!],
      }),
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: 2n,
    });

    assert.deepEqual(overlap.newFrames, []);
    assert.equal(ordinalQueries.length, 1);
    assert.match(ordinalQueries[0]!, /ordinal IN \(\$ordinal0\)/);
    assert.match(ordinalQueries[0]!, /frame_id IN \(\$frame0\)/);
    assert.doesNotMatch(ordinalQueries[0]!, /ORDER BY|LIMIT 2000\b/);
  });

  it("rejects a missing immutable row for an ordinal projected as covered", () => {
    const connection = database();
    const recorder = providerRecorder();
    const repository = new EvidenceCoverageRepository(recorder.provider);
    const prepared = repository.prepareBatch(connection, {
      context: context(),
      command: command(),
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: 1n,
    });
    repository.persistPrepared(
      connection,
      prepared,
      storedEvent(
        connection,
        prepared.eventPayload as unknown as Readonly<Record<string, unknown>>,
      ),
    );
    connection.exec("DROP TRIGGER session_evidence_fingerprints_no_delete");
    connection.prepare(`
      DELETE FROM session_evidence_fingerprints
      WHERE project_id = $projectId
        AND session_id = $sessionId
        AND adapter_session_id = $adapterSessionId
        AND ordinal = 5
    `).run({
      $projectId: PROJECT_ID,
      $sessionId: SESSION_ID,
      $adapterSessionId: ADAPTER_ID,
    });
    const callsBefore = { ...recorder.calls };

    assert.throws(
      () => repository.prepareBatch(connection, {
        context: context(),
        command: command({
          commandId: indexedUuid(80_001),
          idempotencyKey: "covered-row-missing",
          batchId: indexedUuid(80_002) as never,
        }),
        prospectiveEndingScopeBindings: [],
        plannedEventPosition: 2n,
      }),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "INTEGRITY_FAILURE"
      ),
    );
    assert.deepEqual(recorder.calls, callsBefore);
  });

  it("rejects an immutable row for an ordinal projected as missing", () => {
    const connection = database();
    const recorder = providerRecorder();
    const repository = new EvidenceCoverageRepository(recorder.provider);
    const prepared = repository.prepareBatch(connection, {
      context: context(),
      command: command(),
      prospectiveEndingScopeBindings: [],
      plannedEventPosition: 1n,
    });
    repository.persistPrepared(
      connection,
      prepared,
      storedEvent(
        connection,
        prepared.eventPayload as unknown as Readonly<Record<string, unknown>>,
      ),
    );
    const missingFrame = {
      frameId: indexedUuid(81_001) as never,
      ordinal: "2",
      sourceKind: "tool-request" as const,
      observedAt: NOW,
      contentFingerprint: "e".repeat(64),
    };
    rawInsert(connection, "session_evidence_fingerprints", {
      project_id: PROJECT_ID,
      session_id: SESSION_ID,
      adapter_session_id: ADAPTER_ID,
      ordinal: 2n,
      frame_id: missingFrame.frameId,
      source_kind: missingFrame.sourceKind,
      observed_at: missingFrame.observedAt,
      fingerprint_algorithm: "hmac-sha256",
      fingerprint_schema_version: 1,
      fingerprint_key_id: "key-1",
      fingerprint_domain: "pm-evidence-frame-v1",
      fingerprint_value: missingFrame.contentFingerprint,
      batch_id: indexedUuid(81_002),
      recorded_event_position: 1n,
      created_at: NOW,
    });
    const callsBefore = { ...recorder.calls };

    assert.throws(
      () => repository.prepareBatch(connection, {
        context: context(),
        command: command({
          commandId: indexedUuid(81_003),
          idempotencyKey: "missing-row-present",
          batchId: indexedUuid(81_004) as never,
          firstOrdinal: "2",
          lastOrdinal: "2",
          frames: [missingFrame],
        }),
        prospectiveEndingScopeBindings: [],
        plannedEventPosition: 2n,
      }),
      (error: unknown) => (
        error instanceof Error
        && "code" in error
        && error.code === "INTEGRITY_FAILURE"
      ),
    );
    assert.deepEqual(recorder.calls, callsBefore);
  });

});
