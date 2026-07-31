import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, it } from "node:test";
import type {
  AppendCommand,
  JsonValue,
  LifecycleReplayExpectation,
  PersistedLifecycleAuthorizationRecord,
  StoredEvent,
} from "../src/orchestrator/contracts/event.js";
import type {
  ProjectContext,
  ProjectId,
  StoreId,
  VaultId,
  WorkspaceId,
} from "../src/orchestrator/identity/contracts.js";
import { DEFAULT_BUSY_TIMEOUT_MS } from "../src/orchestrator/runtime/runtime-capabilities.js";
import type { RootStartCommandV2 } from "../src/orchestrator/lifecycle/contracts/commands.js";
import { decodeLifecycleEvent } from "../src/orchestrator/lifecycle/contracts/events.js";
import { buildLifecycleIntentWitness } from "../src/orchestrator/lifecycle/lifecycle-intent-witness.js";
import {
  LifecycleCommandStore,
  type LifecycleCommandTransaction,
} from "../src/orchestrator/lifecycle/lifecycle-command.store.js";
import { BranchScopeRepository } from "../src/orchestrator/storage/branch-scope.repository.js";
import {
  type EventAppendBatch,
  EventAppendTransaction,
  EventStoreError,
  SqliteEventAppendStatements,
  matchesLifecycleReplayAuthorization,
} from "../src/orchestrator/storage/event-append-transaction.js";
import { MaintenanceFence } from "../src/orchestrator/storage/maintenance-fence.js";
import { MigrationRunner } from "../src/orchestrator/storage/migration-runner.js";
import { eventCoreMigration } from "../src/orchestrator/storage/migrations/0001-event-core.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import type {
  SqliteConnection,
  SqliteParams,
  SqliteStatement,
  SqliteValue,
} from "../src/orchestrator/storage/sqlite-driver.js";
import {
  SqliteLifecycleProjectionRepository,
} from "../src/orchestrator/storage/lifecycle-projection.repository.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { applyCurrentProjectStoreSchema } from "./support/current-project-store-schema.js";
import {
  CHILD_SESSION_ID as PROJECTION_CHILD_ID,
  APPROVAL_ID as PROJECTION_APPROVAL_ID,
  CHECKPOINT_ID as PROJECTION_CHECKPOINT_ID,
  PROJECT_ID as PROJECTION_PROJECT_ID,
  ROOT_SESSION_ID as PROJECTION_ROOT_ID,
  STORE_ID as PROJECTION_STORE_ID,
  VAULT_ID as PROJECTION_VAULT_ID,
  WORKFLOW_ID as PROJECTION_WORKFLOW_ID,
  WORKSPACE_ID as PROJECTION_WORKSPACE_ID,
  childReportFixture,
  lifecycleEvent,
  lifecycleUuid,
  qualifiedCheckpointFixture,
} from "./support/lifecycle-fixtures.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111" as ProjectId;
const VAULT_ID = "22222222-2222-4222-8222-222222222222" as VaultId;
const STORE_ID = "33333333-3333-4333-8333-333333333333" as StoreId;
const WORKSPACE_ID = "workspace-primary" as WorkspaceId;
const LIFECYCLE_WORKSPACE_ID = "1".repeat(64) as WorkspaceId;
const ROOT_SESSION_ID = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-07-13T01:00:00.000Z";
const roots: string[] = [];
const connections: SqliteConnection[] = [];
const driver = new NodeSqliteDriver({ DatabaseSync });

function healthyCoverageFacade() {
  return {
    assertEvidenceWindowWritable: () => undefined,
    assertQuickHealthy: () => undefined,
    registerAffectedExistingSessions: () => undefined,
    assertVersion1Eligible: () => undefined,
    prepareBatch: () => { throw new Error("evidence coverage not used"); },
    persistPrepared: () => undefined,
    snapshotV2: () => { throw new Error("evidence coverage not used"); },
    minimumCheckpointUpperBound: () => 0,
    minimumFinalEndingScopeBindingsUpperBound: () => 0,
  };
}

class RecordingConnection implements SqliteConnection {
  readonly transactionStatements: string[] = [];

  constructor(readonly inner: SqliteConnection) {}

  exec(sql: string): void {
    const normalized = sql.trim().replace(/\s+/g, " ").toUpperCase();
    if (["BEGIN IMMEDIATE", "COMMIT", "ROLLBACK"].includes(normalized)) {
      this.transactionStatements.push(normalized);
    }
    this.inner.exec(sql);
  }

  prepare(sql: string): SqliteStatement { return this.inner.prepare(sql); }
  close(): void { this.inner.close(); }
}

function context(): ProjectContext {
  const workspace = {
    kind: "git" as const,
    worktreeRoot: "C:\\project",
    gitDir: "C:\\project\\.git\\worktrees\\primary",
    gitCommonDir: "C:\\project\\.git",
    headCommit: "0123456789abcdef0123456789abcdef01234567",
    branchRef: "refs/heads/main",
    detached: false,
    workspaceId: WORKSPACE_ID,
  };
  return {
    binding: {
      projectBindingId: "binding-primary",
      generation: 1,
      contextFingerprint: "fingerprint-primary",
      source: "explicit-cli",
      projectId: PROJECT_ID,
      vaultId: VAULT_ID,
      storeId: STORE_ID,
      workspaceId: WORKSPACE_ID,
      clientNamespace: "tests",
      clientInstanceId: "client-primary",
      actorRole: "primary",
      projectRoot: "C:\\project",
      vaultRoot: "C:\\project\\memory",
      descriptorPath: "C:\\project\\memory\\.project-memory.json",
      storeRoute: {
        kind: "git-common",
        storeRoot: "C:\\project\\.git\\project-memory",
        eventsPath: "C:\\project\\.git\\project-memory\\events.sqlite",
        storeManifestPath: "C:\\project\\.git\\project-memory\\store.json",
        projectionManifestPath: "C:\\project\\.git\\project-memory\\projection.json",
      },
      workspace,
      establishedAt: "2026-07-13T00:00:00.000Z",
    },
    workspace,
    checkedAt: "2026-07-13T00:30:00.000Z",
  };
}

function command(): AppendCommand<JsonValue> {
  return {
    context: context(),
    commandId: "33333333-3333-4333-8333-333333333333",
    idempotencyKey: "client-a:command-1",
    commandType: "RecordPair",
    correlationId: "correlation-1",
    agentId: "agent-primary",
    expectedStreamVersion: 0n,
    streamId: "stream-1",
    streamType: "test",
    events: [{
      eventType: "Recorded",
      eventSchemaVersion: 1,
      occurredAt: "2026-07-13T00:59:00.000Z",
      visibilityScope: "project",
      confidence: "high",
      verificationStatus: "verified",
      payload: { accepted: true },
      sourceRefs: [],
      evidenceRefs: [],
      evidenceDigests: [],
    }],
    outbox: [],
    publicResponse: { accepted: true },
  };
}

function lifecycleContext(): ProjectContext {
  const workspace = {
    kind: "non-git" as const,
    workspaceRoot: "C:\\project",
    workspaceId: LIFECYCLE_WORKSPACE_ID,
  };
  return {
    binding: {
      ...context().binding,
      workspaceId: LIFECYCLE_WORKSPACE_ID,
      clientNamespace: "lifecycle-tests",
      workspace,
    },
    workspace,
    checkedAt: "2026-07-14T00:00:00.000Z",
  };
}

function initialAuthorization(): PersistedLifecycleAuthorizationRecord {
  return {
    kind: "initial-authority",
    authorizationSessionId: null,
    targetSessionId: ROOT_SESSION_ID,
    proof: null,
    approval: null,
    presenting: { actorRole: "primary", clientInstanceId: "client-primary" },
    target: { actorRole: "primary", clientInstanceId: "client-primary" },
  };
}

function lifecycleCommand(): {
  append: AppendCommand<JsonValue>;
  intentHash: string;
  semantic: RootStartCommandV2;
  expectation: LifecycleReplayExpectation;
} {
  const semantic = {
    commandType: "root-start",
    commandId: "55555555-5555-4555-8555-555555555555",
    idempotencyKey: "lifecycle:root-start:1",
    agentId: "agent-primary",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: LIFECYCLE_WORKSPACE_ID,
    expectedBranchRef: null,
    continuityKey: "continuity:root",
    resumePolicy: "new",
  } as RootStartCommandV2;
  const built = buildLifecycleIntentWitness(semantic, {
    authorizationKind: "initial-authority",
    authorizationSessionId: null,
    targetSessionId: ROOT_SESSION_ID,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: LIFECYCLE_WORKSPACE_ID,
    clientNamespace: "lifecycle-tests",
    capabilityKind: null,
    capabilityGeneration: null,
    presentingActorRole: "primary",
    presentingClientInstanceId: "client-primary",
    targetActorRole: "primary",
    targetClientInstanceId: "client-primary",
    internalWorkflowId: null,
    internalWorkflowGeneration: null,
    internalPlannedWorkId: null,
  });
  const record = initialAuthorization();
  return {
    intentHash: built.intentHash,
    semantic,
    expectation: {
      kind: "initial-authority",
      presenting: record.presenting,
      target: record.target,
    },
    append: {
      context: lifecycleContext(),
      commandId: semantic.commandId,
      idempotencyKey: semantic.idempotencyKey,
      commandType: semantic.commandType,
      correlationId: "correlation-root-start",
      agentId: semantic.agentId,
      expectedStreamVersion: 0n,
      streamId: `session/${ROOT_SESSION_ID}`,
      streamType: "session",
      events: [{
        eventType: "SessionStarted",
        eventSchemaVersion: 1,
        occurredAt: NOW,
        visibilityScope: "session",
        sessionId: ROOT_SESSION_ID,
        confidence: "high",
        verificationStatus: "verified",
        payload: {
          sessionId: ROOT_SESSION_ID,
          clientNamespace: "lifecycle-tests",
        },
        sourceRefs: [],
        evidenceRefs: [],
        evidenceDigests: [],
      }],
      outbox: [],
      publicResponse: { sessionId: ROOT_SESSION_ID },
      lifecycleIntentWitness: built.source,
    },
  };
}

function fixture(): { connection: RecordingConnection; tx: EventAppendTransaction } {
  const root = mkdtempSync(join(tmpdir(), "event-append-transaction-"));
  roots.push(root);
  const connection = new RecordingConnection(driver.open(join(root, "events.sqlite"), {
    mode: "create",
    busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
  }));
  connections.push(connection);
  new MigrationRunner().apply(connection, [eventCoreMigration], NOW, {
    kind: "bootstrap-empty", beforeMigration: () => undefined,
  });
  connection.exec("BEGIN IMMEDIATE");
  connection.prepare(`
    INSERT INTO project_meta(singleton, project_id, vault_id, store_id, schema_version, created_at)
    VALUES (1, $projectId, $vaultId, $storeId, 1, $createdAt)
  `).run({
    $projectId: PROJECT_ID,
    $vaultId: VAULT_ID,
    $storeId: STORE_ID,
    $createdAt: NOW,
  });
  connection.exec(`
    INSERT INTO maintenance_state(
      singleton, epoch, mode, owner_id, fencing_token, lease_expires_at, requested_at
    ) VALUES (1, 0, 'idle', NULL, 0, NULL, NULL)
  `);
  connection.exec("COMMIT");
  connection.transactionStatements.length = 0;
  return {
    connection,
    tx: new EventAppendTransaction(
      connection,
      new SqliteEventAppendStatements(connection),
      new MaintenanceFence(),
      new BranchScopeRepository(),
      () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ),
  };
}

function lifecycleFixture(): {
  connection: RecordingConnection;
  statements: SqliteEventAppendStatements;
  tx: EventAppendTransaction;
} {
  const root = mkdtempSync(join(tmpdir(), "event-append-lifecycle-"));
  roots.push(root);
  const connection = new RecordingConnection(driver.open(join(root, "events.sqlite"), {
    mode: "create",
    busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
  }));
  connections.push(connection);
  applyCurrentProjectStoreSchema(connection, {
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
  }, NOW);
  connection.transactionStatements.length = 0;
  const statements = new SqliteEventAppendStatements(connection);
  return {
    connection,
    statements,
    tx: new EventAppendTransaction(
      connection,
      statements,
      new MaintenanceFence(),
      new BranchScopeRepository(),
      () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ),
  };
}

function projectionFixture(): SqliteConnection {
  const root = mkdtempSync(join(tmpdir(), "lifecycle-projection-writer-"));
  roots.push(root);
  const connection = new RecordingConnection(driver.open(join(root, "events.sqlite"), {
    mode: "create",
    busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
  }));
  connections.push(connection);
  applyCurrentProjectStoreSchema(connection, {
    projectId: PROJECTION_PROJECT_ID,
    vaultId: PROJECTION_VAULT_ID,
    storeId: PROJECTION_STORE_ID,
  }, NOW);
  connection.exec("PRAGMA foreign_keys = OFF");
  connection.transactionStatements.length = 0;
  return connection;
}

function projectionStored(
  event: ReturnType<typeof lifecycleEvent>,
  overrides: Partial<StoredEvent> = {},
): StoredEvent {
  return Object.freeze({
    globalPosition: BigInt(event.globalPosition),
    eventId: event.eventId,
    projectId: event.projectId,
    vaultId: event.vaultId,
    storeId: event.storeId,
    workspaceId: event.workspaceId,
    branchScopeId: null,
    branchRef: null,
    streamId: event.streamId,
    streamType: "session",
    streamVersion: BigInt(event.streamVersion),
    eventType: event.eventType,
    eventSchemaVersion: event.eventSchemaVersion,
    sessionId: event.sessionId,
    parentSessionId: event.parentSessionId,
    actorRole: "primary",
    agentId: "agent-primary",
    clientInstanceId: "client-primary",
    correlationId: event.correlationId,
    causationId: event.causationId,
    commandId: event.commandId,
    idempotencyKey: event.idempotencyKey,
    commandEventIndex: 0,
    occurredAt: event.occurredAt,
    recordedAt: event.occurredAt,
    visibilityScope: "session",
    confidence: "high",
    verificationStatus: "verified",
    sourceRefs: Object.freeze([]),
    evidenceRefs: Object.freeze([]),
    evidenceDigests: Object.freeze([]),
    payload: event.payload,
    payloadJson: canonicalJson(event.payload),
    payloadHash: "a".repeat(64),
    previousGlobalHash: "b".repeat(64),
    eventHash: "c".repeat(64),
    lifecycleIntentJson: null,
    ...overrides,
  } as StoredEvent);
}

function insertProjectionEvent(
  connection: SqliteConnection,
  event: StoredEvent,
): void {
  const values: Readonly<Record<string, SqliteValue>> = {
    global_position: event.globalPosition,
    event_id: event.eventId,
    project_id: event.projectId,
    vault_id: event.vaultId,
    store_id: event.storeId,
    workspace_id: event.workspaceId,
    branch_scope_id: null,
    branch_ref: null,
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
    source_refs_json: canonicalJson(event.sourceRefs),
    evidence_refs_json: canonicalJson(event.evidenceRefs),
    evidence_digests_json: canonicalJson(event.evidenceDigests),
    payload_json: event.payloadJson,
    payload_hash: event.payloadHash,
    previous_global_hash: event.previousGlobalHash,
    event_hash: event.eventHash,
    lifecycle_intent_json: event.lifecycleIntentJson ?? null,
  };
  const columns = Object.keys(values);
  connection.prepare(`
    INSERT INTO events(${columns.join(", ")})
    VALUES (${columns.map((column) => `$${column}`).join(", ")})
  `).run(Object.fromEntries(
    columns.map((column) => [`$${column}`, values[column]!]),
  ) as SqliteParams);
}

function immutableProjectionBatch(
  events: readonly StoredEvent[],
): EventAppendBatch<JsonValue> {
  const ordered = [...events].sort((left, right) =>
    left.globalPosition < right.globalPosition ? -1 : 1);
  return Object.freeze({
    events: Object.freeze([...events]),
    storedResponse: Object.freeze({
      eventIds: Object.freeze(ordered.map((event) => event.eventId)),
      firstGlobalPosition: ordered[0]!.globalPosition.toString(),
      lastGlobalPosition: ordered.at(-1)!.globalPosition.toString(),
      finalStreamVersion: ordered.at(-1)!.streamVersion.toString(),
      response: Object.freeze({ projected: true }),
    }),
    responseHash: "d".repeat(64),
  }) as EventAppendBatch<JsonValue>;
}

function projectionTransaction(): LifecycleCommandTransaction {
  return {
    authority: {},
    leases: {},
    approvals: {},
    transfers: {},
    coverage: healthyCoverageFacade(),
    workflows: {},
    validation: {},
    outbox: {},
  };
}

function workflowCheckpointDraft(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    checkpointVersion: 2,
    taskSummary: "projection writer",
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
  });
}

function workflowIntentSource(
  command: Parameters<typeof buildLifecycleIntentWitness>[0],
): string {
  return buildLifecycleIntentWitness(command, {
    authorizationKind: "protected",
    authorizationSessionId: PROJECTION_ROOT_ID,
    targetSessionId: PROJECTION_ROOT_ID,
    projectId: PROJECTION_PROJECT_ID,
    vaultId: PROJECTION_VAULT_ID,
    storeId: PROJECTION_STORE_ID,
    workspaceId: PROJECTION_WORKSPACE_ID,
    clientNamespace: "tests",
    capabilityKind: "root-session-handle",
    capabilityGeneration: "1",
    presentingActorRole: "primary",
    presentingClientInstanceId: "client-primary",
    targetActorRole: "primary",
    targetClientInstanceId: "client-primary",
    internalWorkflowId: null,
    internalWorkflowGeneration: null,
    internalPlannedWorkId: null,
  }).source;
}

function workflowProjectionEvent(
  position: number,
  streamVersion: number,
  eventType:
    | "SessionEndRequested"
    | "SessionEndAmended"
    | "SessionEndCancelled"
    | "SessionAbandoned",
  eventSchemaVersion: 1 | 2,
  payload: Readonly<Record<string, JsonValue>>,
  command: Parameters<typeof buildLifecycleIntentWitness>[0],
): StoredEvent {
  const immutablePayload = Object.freeze({ ...payload });
  const source = lifecycleEvent(position, eventType, immutablePayload as never, {
    globalPosition: position,
    streamVersion,
    sessionId: PROJECTION_ROOT_ID,
    parentSessionId: null,
    workspaceId: PROJECTION_WORKSPACE_ID,
  });
  return projectionStored(source, {
    eventType,
    eventSchemaVersion,
    streamId: `session/${PROJECTION_ROOT_ID}`,
    streamVersion: BigInt(streamVersion),
    sessionId: PROJECTION_ROOT_ID,
    parentSessionId: null,
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    payload: immutablePayload as never,
    payloadJson: canonicalJson(immutablePayload),
    lifecycleIntentJson: workflowIntentSource(command),
  });
}

function reportEvent(position: number, reportOrdinal: number): {
  readonly event: StoredEvent;
  readonly reportId: ReturnType<typeof childReportFixture>["reportId"];
} {
  const report = childReportFixture({
    reportId: lifecycleUuid<ReturnType<typeof childReportFixture>["reportId"]>(
      reportOrdinal,
    ),
    childSessionId: PROJECTION_CHILD_ID,
    parentSessionId: PROJECTION_ROOT_ID,
  });
  const { allReportItemIds: _derived, ...unfrozenPersistedReport } = report;
  const persistedReport = Object.freeze(unfrozenPersistedReport);
  return {
    event: projectionStored(lifecycleEvent(position, "ChildWorkReported", {
      report: persistedReport as never,
    }, {
      streamVersion: position,
      globalPosition: position,
      sessionId: PROJECTION_CHILD_ID,
      parentSessionId: PROJECTION_ROOT_ID,
      workspaceId: PROJECTION_WORKSPACE_ID,
    })),
    reportId: report.reportId,
  };
}

function persistRootAuthority(
  connection: SqliteConnection,
  eventPosition: bigint,
  overrides: {
    workspaceId?: WorkspaceId;
    clientNamespace?: string;
  } = {},
): void {
  connection.prepare(`
    INSERT INTO session_authority(
      project_id, session_id, stream_id, session_kind, parent_session_id,
      workspace_id, client_namespace, semantic_state, owner_generation,
      child_capability_generation, direct_access_enabled,
      continuity_fingerprint_algorithm, continuity_fingerprint_schema_version,
      continuity_fingerprint_key_id, continuity_fingerprint_domain,
      continuity_fingerprint, root_handle_capability_version, root_handle_key_id,
      root_handle_issue_nonce, root_handle_issued_at, root_handle_policy_code,
      root_handle_expiry_kind, root_handle_expires_at, root_handle_actor_role,
      root_handle_client_instance_id, root_handle_verifier, root_handle_issuance_id,
      resume_token_capability_version, resume_token_key_id, resume_token_issue_nonce,
      resume_token_issued_at, resume_token_policy_code, resume_token_expiry_kind,
      resume_token_expires_at, resume_token_actor_role, resume_token_verifier,
      resume_token_issuance_id, child_handle_capability_version,
      child_handle_key_id, child_handle_issue_nonce, child_handle_issued_at,
      child_handle_policy_code, child_handle_expiry_kind, child_handle_expires_at,
      child_handle_actor_role, child_handle_client_instance_id,
      child_handle_verifier, child_handle_issuance_id, authority_commitment,
      authority_event_position, latest_checkpoint_id,
      latest_checkpoint_event_position, latest_checkpoint_fingerprint,
      checkpoint_required_reason, checkpoint_required_event_position,
      revocation_reason_code, revocation_event_position, revoked_at,
      terminal_event_position, terminal_event_type, terminal_at, created_at, updated_at
    ) VALUES (
      $projectId, $sessionId, $streamId, 'root', NULL, $workspaceId,
      $clientNamespace, 'active', 1, NULL, 0, 'hmac-sha256', 1,
      'continuity-key-1', 'pm-continuity-v1', $authorityCommitment, 1,
      'capability-key-1', $nonce, $now, 'root-default-v1', 'until-revoked',
      NULL, 'primary', 'client-primary', $verifier, $handleIssuanceId,
      1, 'capability-key-1', $resumeNonce, $now, 'resume-default-v1',
      'until-revoked', NULL, 'primary', $resumeVerifier, $resumeIssuanceId,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      $authorityCommitment, $eventPosition, NULL, NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL, NULL, NULL, $now, $now
    )
  `).run({
    $projectId: PROJECT_ID,
    $sessionId: ROOT_SESSION_ID,
    $streamId: `session/${ROOT_SESSION_ID}`,
    $workspaceId: overrides.workspaceId ?? LIFECYCLE_WORKSPACE_ID,
    $clientNamespace: overrides.clientNamespace ?? "lifecycle-tests",
    $authorityCommitment: "a".repeat(64),
    $nonce: "b".repeat(64),
    $verifier: "c".repeat(64),
    $handleIssuanceId: "77777777-7777-4777-8777-777777777777",
    $resumeNonce: "d".repeat(64),
    $resumeVerifier: "e".repeat(64),
    $resumeIssuanceId: "88888888-8888-4888-8888-888888888888",
    $eventPosition: eventPosition,
    $now: NOW,
  });
}

afterEach(() => {
  for (const connection of connections.splice(0)) {
    try { connection.close(); } catch { /* cleanup continues */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("lifecycle projection writer processes a multi-event batch in ascending position", () => {
  const connection = projectionFixture();
  const commandId = lifecycleUuid(91_000);
  const idempotencyKey = "projection/multi-event";
  const fork = projectionStored(lifecycleEvent(1, "SessionForked"), {
    commandId,
    idempotencyKey,
    commandEventIndex: 0,
  });
  const amended = projectionStored(lifecycleEvent(2, "ChildAssignmentAmended"), {
    commandId,
    idempotencyKey,
    commandEventIndex: 1,
  });
  insertProjectionEvent(connection, fork);
  insertProjectionEvent(connection, amended);
  const repository = new SqliteLifecycleProjectionRepository(connection);

  connection.exec("BEGIN IMMEDIATE");
  repository.append(
    immutableProjectionBatch([amended, fork]),
    projectionTransaction(),
  );
  connection.exec("COMMIT");

  assert.deepEqual(
    connection.prepare(`
      SELECT event_position, stream_version
      FROM lifecycle_child_event_folds
      ORDER BY event_position
    `).all().map((row) => ({
      event_position: row.event_position,
      stream_version: row.stream_version,
    })),
    [
      { event_position: 1n, stream_version: 1n },
      { event_position: 2n, stream_version: 2n },
    ],
  );
  assert.equal(
    repository.findChildByStreamVersion(
      PROJECTION_PROJECT_ID,
      PROJECTION_CHILD_ID,
      2n,
    )?.eventPosition,
    2n,
  );
});

it("lifecycle projection writer resolves a non-latest report witness by its partial-unique key", () => {
  const connection = projectionFixture();
  const fork = projectionStored(lifecycleEvent(1, "SessionForked"));
  const reportA = reportEvent(2, 90_001);
  const reportB = reportEvent(3, 90_002);
  const reportC = reportEvent(4, 90_003);
  const proposal = projectionStored(lifecycleEvent(5, "ChildCompletionProposed", {
    reportId: reportA.reportId as never,
  }));
  const events = [fork, reportA.event, reportB.event, reportC.event, proposal];
  for (const event of events) insertProjectionEvent(connection, event);
  const repository = new SqliteLifecycleProjectionRepository(connection);

  for (const event of events) {
    connection.exec("BEGIN IMMEDIATE");
    repository.append(immutableProjectionBatch([event]), projectionTransaction());
    connection.exec("COMMIT");
  }

  const projected = repository.findChildAtEvent(
    PROJECTION_PROJECT_ID,
    PROJECTION_CHILD_ID,
    5n,
  );
  assert.equal(projected?.completionReportId, reportA.reportId);
  assert.equal(projected?.latestReportId, reportC.reportId);
  assert.equal(
    repository.findReportWitness(
      PROJECTION_PROJECT_ID,
      PROJECTION_CHILD_ID,
      reportA.reportId,
    )?.eventPosition,
    2n,
  );
});

it("lifecycle projection writer persists every workflow generation and unchanged null carry", () => {
  const base = (commandId: string, idempotencyKey: string) => ({
    commandId,
    idempotencyKey,
    agentId: "agent-primary",
    expectedProjectId: PROJECTION_PROJECT_ID,
    expectedVaultId: PROJECTION_VAULT_ID,
    expectedWorkspaceId: PROJECTION_WORKSPACE_ID,
    expectedBranchRef: null,
  });
  const requestOne = {
    ...base(lifecycleUuid(92_001), "projection/workflow/request-1"),
    commandType: "request-session-end" as const,
    request: {
      requestVersion: 2 as const,
      sessionId: PROJECTION_ROOT_ID,
      childEndPolicy: "require-completed" as const,
      finalCheckpoint: workflowCheckpointDraft() as never,
      validationProfileIds: Object.freeze([]),
      requestedQualityThreshold: 0,
      requireFullEvidence: false,
      requireMaterialization: false,
    },
  };
  const amendment = {
    ...base(lifecycleUuid(92_002), "projection/workflow/amend"),
    commandType: "amend-session-end" as const,
    sessionId: PROJECTION_ROOT_ID,
    workflowId: PROJECTION_WORKFLOW_ID,
    expectedStreamVersion: "2",
    amendment: {
      amendmentVersion: 2 as const,
      childEndPolicy: null,
      finalCheckpoint: null,
      validationProfileIds: null,
      requestedQualityThreshold: null,
      requireFullEvidence: null,
      requireMaterialization: true,
      evidenceWindowAction: "unchanged" as const,
    },
  };
  const cancel = {
    ...base(lifecycleUuid(92_003), "projection/workflow/cancel"),
    commandType: "cancel-session-end" as const,
    sessionId: PROJECTION_ROOT_ID,
    workflowId: PROJECTION_WORKFLOW_ID,
    expectedStreamVersion: "3",
    preTransitionCheckpointId: PROJECTION_CHECKPOINT_ID,
  };
  const requestTwo = {
    ...base(lifecycleUuid(92_004), "projection/workflow/request-2"),
    commandType: "request-session-end" as const,
    request: {
      ...requestOne.request,
      finalCheckpoint: workflowCheckpointDraft() as never,
    },
  };
  const abandon = {
    ...base(lifecycleUuid(92_005), "projection/workflow/abandon"),
    commandType: "abandon-session" as const,
    sessionId: PROJECTION_ROOT_ID,
    expectedStreamVersion: "5",
    preTransitionCheckpointId: PROJECTION_CHECKPOINT_ID,
    reasonCode: "explicit-user-approval",
  };
  const events = [
    workflowProjectionEvent(10, 2, "SessionEndRequested", 2, {
      workflowId: PROJECTION_WORKFLOW_ID,
      workflowGeneration: 1,
      previousState: "active",
      childEndPolicy: "require-completed",
      qualityThreshold: 0,
      requireFullEvidence: false,
      requireMaterialization: false,
      requestVersion: 2,
    }, requestOne),
    workflowProjectionEvent(11, 3, "SessionEndAmended", 2, {
      workflowId: PROJECTION_WORKFLOW_ID,
      previousWorkflowGeneration: 1,
      workflowGeneration: 2,
      preTransitionCheckpointId: PROJECTION_CHECKPOINT_ID,
      amendmentVersion: 2,
      finalCheckpointVersion: null,
      evidenceWindowAction: "unchanged",
    }, amendment),
    workflowProjectionEvent(12, 4, "SessionEndCancelled", 1, {
      workflowId: PROJECTION_WORKFLOW_ID,
      workflowGeneration: 3,
      restoredState: "active",
      preTransitionCheckpointId: PROJECTION_CHECKPOINT_ID,
    }, cancel),
    workflowProjectionEvent(13, 5, "SessionEndRequested", 2, {
      workflowId: PROJECTION_WORKFLOW_ID,
      workflowGeneration: 4,
      previousState: "active",
      childEndPolicy: "require-completed",
      qualityThreshold: 0,
      requireFullEvidence: false,
      requireMaterialization: false,
      requestVersion: 2,
    }, requestTwo),
    workflowProjectionEvent(14, 6, "SessionAbandoned", 1, {
      workflowId: PROJECTION_WORKFLOW_ID,
      workflowGeneration: 5,
      approvalId: PROJECTION_APPROVAL_ID,
      preTransitionCheckpointId: PROJECTION_CHECKPOINT_ID,
      reasonCode: "explicit-user-approval",
      authorityCommitment: "a".repeat(64),
    }, abandon),
  ];
  const connection = projectionFixture();
  const repository = new SqliteLifecycleProjectionRepository(connection);
  for (const event of events) insertProjectionEvent(connection, event);

  for (const event of events) {
    connection.exec("BEGIN IMMEDIATE");
    repository.append(immutableProjectionBatch([event]), projectionTransaction());
    connection.exec("COMMIT");
  }

  assert.deepEqual(connection.prepare(`
    SELECT workflow_generation, evidence_window_state,
           replacement_checkpoint_version, effective_checkpoint_version,
           effective_draft_source_event_position
    FROM lifecycle_workflow_generation_folds
    ORDER BY workflow_generation
  `).all().map((row) => ({
    generation: Number(row.workflow_generation),
    state: row.evidence_window_state,
    replacement: row.replacement_checkpoint_version === null
      ? null
      : Number(row.replacement_checkpoint_version),
    effective: Number(row.effective_checkpoint_version),
    source: row.effective_draft_source_event_position,
  })), [
    { generation: 1, state: "open", replacement: 2, effective: 2, source: 10n },
    { generation: 2, state: "open", replacement: null, effective: 2, source: 10n },
    { generation: 3, state: "sealed", replacement: null, effective: 2, source: 10n },
    { generation: 4, state: "open", replacement: 2, effective: 2, source: 13n },
    { generation: 5, state: "sealed", replacement: null, effective: 2, source: 13n },
  ]);
});

it("schema 3 projects existing version 1 lifecycle writes", () => {
  const connection = projectionFixture();
  const fork = projectionStored(lifecycleEvent(1, "SessionForked"));
  insertProjectionEvent(connection, fork);
  const repository = new SqliteLifecycleProjectionRepository(connection);
  connection.exec("BEGIN IMMEDIATE");
  repository.append(immutableProjectionBatch([fork]), projectionTransaction());
  connection.exec("COMMIT");
  assert.equal(
    connection.prepare("SELECT schema_version FROM project_meta").get()?.schema_version,
    3n,
  );
  assert.equal(
    connection.prepare("SELECT count(*) AS count FROM lifecycle_child_event_folds").get()?.count,
    1n,
  );
});

it("lifecycle projection writer rejects committed drift from the persisted event", () => {
  const connection = projectionFixture();
  const persisted = projectionStored(lifecycleEvent(1, "SessionForked"));
  const drifted = Object.freeze({
    ...persisted,
    eventHash: "d".repeat(64),
  });
  insertProjectionEvent(connection, persisted);
  const repository = new SqliteLifecycleProjectionRepository(connection);

  connection.exec("BEGIN IMMEDIATE");
  assert.throws(
    () => repository.append(
      immutableProjectionBatch([drifted]),
      projectionTransaction(),
    ),
    (error: unknown) => typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "INTEGRITY_FAILURE",
  );
  connection.exec("ROLLBACK");
  assert.equal(
    connection.prepare(
      "SELECT count(*) AS count FROM lifecycle_child_event_folds",
    ).get()?.count,
    0n,
  );
});

function executeRootShapedLifecycleEvent(
  eventType:
    | "SessionForked"
    | "ChildAssignmentAmended"
    | "ChildWorkReported"
    | "ChildWorkDispositioned"
    | "ChildCompletionProposed"
    | "ChildSessionCompleted"
    | "ChildSessionSuspended"
    | "ChildWorkTransferCreated"
    | "ChildWorkTransferClaimed"
    | "SessionCheckpointRecorded"
    | "EvidenceCoverageRecorded",
): {
  readonly connection: RecordingConnection;
  readonly execute: () => ReturnType<LifecycleCommandStore["execute"]>;
} {
  const { connection, tx } = lifecycleFixture();
  const command = lifecycleCommand();
  const authorization = initialAuthorization();
  const source = lifecycleEvent(1, eventType, {}, {
    sessionId: ROOT_SESSION_ID as never,
    parentSessionId: null,
    workspaceId: LIFECYCLE_WORKSPACE_ID,
  });
  const sourcePayload = source.payload as unknown as Readonly<
    Record<string, JsonValue>
  >;
  const payload = eventType === "SessionCheckpointRecorded"
    ? Object.freeze({
        checkpoint: qualifiedCheckpointFixture({
          sessionId: ROOT_SESSION_ID as never,
          parentSessionId: null,
          baseEventPosition: 0,
          checkpointEventPosition: 1,
        }),
        baseEventPosition: "0",
        checkpointEventPosition: "1",
      })
    : eventType === "EvidenceCoverageRecorded"
      ? Object.freeze({
          adapterSessionId: sourcePayload.adapterSessionId,
          batchId: sourcePayload.batchId,
          batchFirstOrdinal: "0",
          batchLastOrdinal: "0",
          coverageFirstOrdinal: "0",
          coverageLastOrdinal: "0",
          highestContiguousOrdinal: "0",
          missingIntervals: Object.freeze([]),
          frameFingerprintAlgorithm: "hmac-sha256",
          frameFingerprintSchemaVersion: 1,
          frameFingerprintKeyId: "evidence-key-v1",
          frameFingerprintDomain: "pm-evidence-frame-v1",
          coverageFingerprintAlgorithm: "hmac-sha256",
          coverageFingerprintSchemaVersion: 1,
          coverageFingerprintKeyId: "evidence-key-v1",
          coverageFingerprintDomain: "pm-evidence-coverage-v1",
          coverageFingerprint: sourcePayload.coverageFingerprint,
          captureMode: "coverage-only",
          contentRetained: false,
          frames: sourcePayload.frames,
        })
      : source.payload;
  const eventSchemaVersion = eventType === "SessionCheckpointRecorded"
      || eventType === "EvidenceCoverageRecorded"
    ? 2
    : source.eventSchemaVersion;
  if (
    eventType === "SessionCheckpointRecorded"
    || eventType === "EvidenceCoverageRecorded"
  ) {
    decodeLifecycleEvent({ ...source, eventSchemaVersion, payload });
  }
  const { lifecycleIntentWitness: _privateWitness, ...baseAppend } = command.append;
  const append = {
    ...baseAppend,
    events: [{
      eventType,
      eventSchemaVersion,
      occurredAt: source.occurredAt,
      visibilityScope: "session",
      sessionId: ROOT_SESSION_ID,
      confidence: "high",
      verificationStatus: "verified",
      payload: payload as JsonValue,
      sourceRefs: [],
      evidenceRefs: [],
      evidenceDigests: [],
    }],
  } satisfies Omit<AppendCommand<JsonValue>, "lifecycleIntentWitness">;
  const focused: LifecycleCommandTransaction = {
    authority: {
      persist(eventPosition: bigint) {
        persistRootAuthority(connection, eventPosition);
      },
    },
    leases: {},
    approvals: {},
    transfers: {},
    coverage: healthyCoverageFacade(),
    workflows: {},
    validation: {},
    outbox: {},
  };
  const store = new LifecycleCommandStore({
    connection,
    events: tx,
    projectionWriter: new SqliteLifecycleProjectionRepository(connection),
    transaction: () => focused,
    now: () => NOW,
  });
  return {
    connection,
    execute: () => store.execute({
      context: command.append.context,
      commandId: command.append.commandId,
      idempotencyKey: command.append.idempotencyKey,
      commandType: command.append.commandType,
      candidateIntentHash: command.intentHash,
      authoritativeIntentHash: command.intentHash,
      semanticCommand: command.semantic,
      capabilityKind: null,
      capabilityGeneration: null,
      replayExpectation: command.expectation,
    }, () => ({
      append,
      authorizationRecord: authorization,
      afterAppend: (committed, current) => {
        (current.authority as { persist(eventPosition: bigint): void })
          .persist(committed.events[0]!.globalPosition);
      },
    })),
  };
}

it("lifecycle projection writer rejects every null-parent child-only event atomically", () => {
  const childOnlyTypes = [
    "SessionForked",
    "ChildAssignmentAmended",
    "ChildWorkReported",
    "ChildWorkDispositioned",
    "ChildCompletionProposed",
    "ChildSessionCompleted",
    "ChildSessionSuspended",
    "ChildWorkTransferCreated",
    "ChildWorkTransferClaimed",
  ] as const;

  for (const eventType of childOnlyTypes) {
    const { connection, execute } = executeRootShapedLifecycleEvent(eventType);
    assert.throws(
      execute,
      (error: unknown) => typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "INTEGRITY_FAILURE",
      eventType,
    );
    assert.deepEqual({
      events: connection.prepare("SELECT count(*) AS count FROM events").get()?.count,
      dedup: connection.prepare(
        "SELECT count(*) AS count FROM command_dedup",
      ).get()?.count,
      projections: connection.prepare(
        "SELECT count(*) AS count FROM lifecycle_child_event_folds",
      ).get()?.count,
    }, { events: 0n, dedup: 0n, projections: 0n }, eventType);
    assert.deepEqual(
      connection.transactionStatements.slice(-2),
      ["BEGIN IMMEDIATE", "ROLLBACK"],
      eventType,
    );
  }
});

it("lifecycle projection writer leaves valid root checkpoint and evidence events unprojected", () => {
  for (const eventType of [
    "SessionCheckpointRecorded",
    "EvidenceCoverageRecorded",
  ] as const) {
    const { connection, execute } = executeRootShapedLifecycleEvent(eventType);
    assert.equal(execute().deduplicated, false, eventType);
    assert.deepEqual({
      events: connection.prepare("SELECT count(*) AS count FROM events").get()?.count,
      dedup: connection.prepare(
        "SELECT count(*) AS count FROM command_dedup",
      ).get()?.count,
      projections: connection.prepare(
        "SELECT count(*) AS count FROM lifecycle_child_event_folds",
      ).get()?.count,
    }, { events: 1n, dedup: 1n, projections: 0n }, eventType);
    assert.deepEqual(
      connection.transactionStatements.slice(-2),
      ["BEGIN IMMEDIATE", "COMMIT"],
      eventType,
    );
  }
});

it("never owns transaction statements while appending a prepared Version 1 batch", () => {
  const { connection, tx } = fixture();
  const append = command();

  connection.exec("BEGIN IMMEDIATE");
  const baseline = [...connection.transactionStatements];
  const prepared = tx.prepare(append, NOW);
  assert.equal(tx.findReplay(prepared, null), null);
  const planned = tx.planPrepared(prepared);
  const committed = tx.appendPlanned(planned);
  assert.notEqual(committed.events, planned.events);
  assert.notEqual(committed.events[0], planned.events[0]);
  assert.notEqual(committed.storedResponse, planned.storedResponse);
  assert.notEqual(committed.storedResponse.response, planned.storedResponse.response);
  assert.equal(Object.isFrozen(planned.events[0]), true);
  assert.equal(Object.isFrozen(planned.events[0]!.payload), true);
  assert.equal(Object.isFrozen(planned.storedResponse.response), true);
  assert.equal(Object.isFrozen(committed.events[0]), true);
  assert.equal(Object.isFrozen(committed.events[0]!.payload), true);
  assert.equal(Object.isFrozen(committed.storedResponse.response), true);
  tx.insertDedup(prepared, committed, null);

  assert.deepEqual(connection.transactionStatements, baseline);
  connection.exec("COMMIT");
  assert.deepEqual(connection.transactionStatements, ["BEGIN IMMEDIATE", "COMMIT"]);
});

it("rejects lifecycle dedup when the persisted target authority is missing", () => {
  const { connection, tx } = lifecycleFixture();
  const command = lifecycleCommand();

  connection.exec("BEGIN IMMEDIATE");
  const prepared = tx.prepare(command.append, NOW, command.intentHash);
  const planned = tx.planPrepared(prepared);
  const committed = tx.appendPlanned(planned);
  assert.throws(
    () => tx.insertDedup(prepared, committed, initialAuthorization()),
    (error: unknown) => error instanceof EventStoreError
      && error.code === "INTEGRITY_FAILURE",
  );
  connection.exec("ROLLBACK");
});

it("rejects lifecycle dedup when event zero targets a different session", () => {
  const { connection, tx } = lifecycleFixture();
  const command = lifecycleCommand();
  const otherSessionId = "99999999-9999-4999-8999-999999999999";
  const malformed = {
    ...command.append,
    streamId: `session/${otherSessionId}`,
    events: command.append.events.map((event) => ({
      ...event,
      sessionId: otherSessionId,
    })),
  };

  connection.exec("BEGIN IMMEDIATE");
  const prepared = tx.prepare(malformed, NOW, command.intentHash);
  const planned = tx.planPrepared(prepared);
  const committed = tx.appendPlanned(planned);
  assert.throws(
    () => tx.insertDedup(prepared, committed, initialAuthorization()),
    (error: unknown) => error instanceof EventStoreError
      && error.code === "INTEGRITY_FAILURE",
  );
  connection.exec("ROLLBACK");
});

for (const [name, authorityBinding] of [
  ["workspace", { workspaceId: "2".repeat(64) as WorkspaceId }],
  ["namespace", { clientNamespace: "wrong-lifecycle-client" }],
] as const) {
  it(`rejects lifecycle dedup when persisted authority ${name} differs from append context`, () => {
    const { connection, tx } = lifecycleFixture();
    const command = lifecycleCommand();

    connection.exec("BEGIN IMMEDIATE");
    const prepared = tx.prepare(command.append, NOW, command.intentHash);
    const planned = tx.planPrepared(prepared);
    const committed = tx.appendPlanned(planned);
    persistRootAuthority(connection, committed.events[0]!.globalPosition, authorityBinding);
    assert.throws(
      () => tx.insertDedup(prepared, committed, initialAuthorization()),
      (error: unknown) => error instanceof EventStoreError
        && error.code === "IDEMPOTENCY_CONFLICT",
    );
    connection.exec("ROLLBACK");
  });
}

it("treats historical lifecycle dedup without target authority as integrity failure before facades", () => {
  const { connection, statements, tx } = lifecycleFixture();
  const command = lifecycleCommand();
  const authorization = initialAuthorization();

  connection.exec("BEGIN IMMEDIATE");
  const prepared = tx.prepare(command.append, NOW, command.intentHash);
  const planned = tx.planPrepared(prepared);
  const committed = tx.appendPlanned(planned);
  statements.insertDedup(
    prepared.command,
    prepared.commandHash,
    committed.storedResponse,
    committed.responseHash,
    NOW,
    authorization,
  );
  connection.exec("COMMIT");

  let facadeCalls = 0;
  let newCalls = 0;
  const store = new LifecycleCommandStore({
    connection,
    events: tx,
    projectionWriter: new SqliteLifecycleProjectionRepository(connection),
    transaction: () => {
      facadeCalls += 1;
      return {
        authority: {}, leases: {}, approvals: {}, transfers: {},
        coverage: healthyCoverageFacade(), workflows: {}, validation: {}, outbox: {},
      };
    },
    now: () => NOW,
  });
  assert.throws(
    () => store.execute({
      context: command.append.context,
      commandId: command.append.commandId,
      idempotencyKey: command.append.idempotencyKey,
      commandType: command.append.commandType,
      candidateIntentHash: command.intentHash,
      authoritativeIntentHash: command.intentHash,
      semanticCommand: command.semantic,
      capabilityKind: null,
      capabilityGeneration: null,
      replayExpectation: command.expectation,
    }, () => {
      newCalls += 1;
      throw new Error("corrupt replay must not enter fresh path");
    }),
    (error: unknown) => error instanceof EventStoreError
      && error.code === "INTEGRITY_FAILURE",
  );
  assert.equal(facadeCalls, 0);
  assert.equal(newCalls, 0);
  assert.deepEqual(connection.transactionStatements.at(-2), "BEGIN IMMEDIATE");
  assert.deepEqual(connection.transactionStatements.at(-1), "ROLLBACK");
});

it("persists Version 2 authorization and replays an initial command with its generated target", () => {
  const { connection, tx } = lifecycleFixture();
  const command = lifecycleCommand();
  const record = initialAuthorization();

  connection.exec("BEGIN IMMEDIATE");
  assert.equal(tx.findLifecycleReplay({
    context: command.append.context,
    commandId: command.append.commandId,
    idempotencyKey: command.append.idempotencyKey,
    authoritativeIntentHash: command.intentHash,
    replayExpectation: command.expectation,
  }), null);
  const prepared = tx.prepare(command.append, NOW, command.intentHash);
  const planned = tx.planPrepared(prepared);
  const committed = tx.appendPlanned(planned);
  persistRootAuthority(connection, committed.events[0]!.globalPosition);
  tx.insertDedup(prepared, committed, record);
  connection.exec("COMMIT");

  connection.exec("BEGIN IMMEDIATE");
  const replay = tx.findLifecycleReplay<JsonValue>({
    context: command.append.context,
    commandId: command.append.commandId,
    idempotencyKey: command.append.idempotencyKey,
    authoritativeIntentHash: command.intentHash,
    replayExpectation: command.expectation,
  });
  connection.exec("ROLLBACK");
  assert.equal(replay?.deduplicated, true);
  assert.deepEqual(replay?.authorizationRecord, record);
  assert.deepEqual(replay?.response, { sessionId: ROOT_SESSION_ID });
  const row = connection.prepare(`
    SELECT lifecycle_authorization_kind, target_session_id,
           presenting_client_instance_id, target_client_instance_id, response_json
    FROM command_dedup
  `).get();
  assert.equal(row?.lifecycle_authorization_kind, "initial-authority");
  assert.equal(row?.target_session_id, ROOT_SESSION_ID);
  assert.equal(row?.presenting_client_instance_id, "client-primary");
  assert.equal(row?.target_client_instance_id, "client-primary");
  assert.doesNotMatch(String(row?.response_json), /pmcap1|pmrap1|proofMac|bearer/i);
});

it("matches the complete protected replay tuple and both audiences", () => {
  const base: PersistedLifecycleAuthorizationRecord = {
    kind: "protected",
    proof: { version: 1, nonce: "11111111-1111-4111-8111-111111111111", digest: "1".repeat(64) },
    approval: { approvalId: "22222222-2222-4222-8222-222222222222", digest: "2".repeat(64) },
    authorizationSessionId: ROOT_SESSION_ID,
    targetSessionId: ROOT_SESSION_ID,
    presenting: { actorRole: "maintenance", clientInstanceId: "maintenance-a" },
    target: { actorRole: "primary", clientInstanceId: "primary-a" },
  };
  assert.equal(matchesLifecycleReplayAuthorization(base, base), true);
  for (const changed of [
    { ...base, proof: { ...base.proof!, nonce: "33333333-3333-4333-8333-333333333333" } },
    { ...base, proof: { ...base.proof!, digest: "3".repeat(64) } },
    { ...base, approval: { ...base.approval!, digest: "3".repeat(64) } },
    { ...base, authorizationSessionId: "33333333-3333-4333-8333-333333333333" },
    { ...base, presenting: { ...base.presenting, clientInstanceId: "maintenance-b" } },
    { ...base, target: { ...base.target, clientInstanceId: "primary-b" } },
  ]) {
    assert.equal(matchesLifecycleReplayAuthorization(base, changed), false);
  }
});

it("matches stable internal work while requiring the stored original claim fence", () => {
  const record: PersistedLifecycleAuthorizationRecord = {
    kind: "internal-workflow",
    workflowId: "66666666-6666-4666-8666-666666666666",
    workflowGeneration: 4n,
    plannedWorkId: "4".repeat(64),
    claimOwnerId: "worker-original",
    claimToken: 9n,
    authorizationSessionId: ROOT_SESSION_ID,
    targetSessionId: ROOT_SESSION_ID,
    presenting: { actorRole: "primary", clientInstanceId: "primary-a" },
    target: { actorRole: "primary", clientInstanceId: "primary-a" },
  };
  const { claimOwnerId: _owner, claimToken: _token, ...stable } = record;
  assert.equal(matchesLifecycleReplayAuthorization(record, stable), true);
  assert.equal(matchesLifecycleReplayAuthorization(record, {
    ...stable,
    plannedWorkId: "5".repeat(64),
  }), false);
  assert.equal(matchesLifecycleReplayAuthorization({ ...record, claimOwnerId: "" }, stable), false);
  assert.equal(matchesLifecycleReplayAuthorization({ ...record, claimToken: 0n }, stable), false);
});

it("runs LifecycleCommandStore through the real primitive and replays before onNew", () => {
  const { connection, tx } = lifecycleFixture();
  const command = lifecycleCommand();
  const authorization = initialAuthorization();
  const focused: LifecycleCommandTransaction = {
    authority: {
      persist(eventPosition: bigint) {
        persistRootAuthority(connection, eventPosition);
      },
    },
    leases: {},
    approvals: {},
    transfers: {},
    coverage: healthyCoverageFacade(),
    workflows: {},
    validation: {},
    outbox: {},
  };
  const store = new LifecycleCommandStore({
    connection,
    events: tx,
    projectionWriter: new SqliteLifecycleProjectionRepository(connection),
    transaction: () => focused,
    now: () => NOW,
    authorityMaterialStatus: () => "stale",
  });
  const envelope = {
    context: command.append.context,
    commandId: command.append.commandId,
    idempotencyKey: command.append.idempotencyKey,
    commandType: command.append.commandType,
    candidateIntentHash: command.intentHash,
    authoritativeIntentHash: command.intentHash,
    semanticCommand: command.semantic,
    capabilityKind: null,
    capabilityGeneration: null,
    replayExpectation: command.expectation,
  };
  let newCalls = 0;
  const first = store.execute(envelope, () => {
    newCalls += 1;
    const { lifecycleIntentWitness: _privateWitness, ...append } = command.append;
    return {
      append,
      authorizationRecord: authorization,
      afterAppend: (committed, current) => {
        (current.authority as { persist(eventPosition: bigint): void })
          .persist(committed.events[0]!.globalPosition);
      },
    };
  });
  const replay = store.execute({
    ...envelope,
    context: {
      ...envelope.context,
      binding: {
        ...envelope.context.binding,
        generation: envelope.context.binding.generation + 99,
        contextFingerprint: "changed-after-commit",
      },
      checkedAt: "2026-07-15T00:00:00.000Z",
    },
  }, () => {
    newCalls += 1;
    throw new Error("replay must not enter fresh path");
  });

  for (const changedBinding of [
    {
      ...envelope.context,
      binding: {
        ...envelope.context.binding,
        workspaceId: "2".repeat(64) as WorkspaceId,
      },
      workspace: {
        ...envelope.context.workspace,
        workspaceId: "2".repeat(64) as WorkspaceId,
      },
    },
    {
      ...envelope.context,
      binding: {
        ...envelope.context.binding,
        clientNamespace: "other-lifecycle-client",
      },
    },
  ]) {
    let facadeCalls = 0;
    let changedNewCalls = 0;
    const guardedStore = new LifecycleCommandStore({
      connection,
      events: tx,
      projectionWriter: new SqliteLifecycleProjectionRepository(connection),
      transaction: () => {
        facadeCalls += 1;
        return focused;
      },
      now: () => NOW,
    });
    assert.throws(
      () => guardedStore.execute({ ...envelope, context: changedBinding }, () => {
        changedNewCalls += 1;
        throw new Error("binding mismatch must not enter fresh path");
      }),
      (error: unknown) => typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "IDEMPOTENCY_CONFLICT",
    );
    assert.equal(facadeCalls, 0);
    assert.equal(changedNewCalls, 0);
  }

  assert.equal(first.deduplicated, false);
  assert.equal(replay.deduplicated, true);
  assert.equal(replay.authorityMaterialStatus, "stale");
  assert.deepEqual(first.publicResult, replay.publicResult);
  assert.equal(newCalls, 1);
  assert.deepEqual(connection.transactionStatements, [
    "BEGIN IMMEDIATE", "COMMIT",
    "BEGIN IMMEDIATE", "ROLLBACK",
    "BEGIN IMMEDIATE", "ROLLBACK",
    "BEGIN IMMEDIATE", "ROLLBACK",
  ]);
});
