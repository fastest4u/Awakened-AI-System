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
import { buildLifecycleIntentWitness } from "../src/orchestrator/lifecycle/lifecycle-intent-witness.js";
import {
  LifecycleCommandStore,
  type LifecycleCommandTransaction,
} from "../src/orchestrator/lifecycle/lifecycle-command.store.js";
import { BranchScopeRepository } from "../src/orchestrator/storage/branch-scope.repository.js";
import {
  EventAppendTransaction,
  EventStoreError,
  SqliteEventAppendStatements,
  matchesLifecycleReplayAuthorization,
} from "../src/orchestrator/storage/event-append-transaction.js";
import { MaintenanceFence } from "../src/orchestrator/storage/maintenance-fence.js";
import { MigrationRunner } from "../src/orchestrator/storage/migration-runner.js";
import { eventCoreMigration } from "../src/orchestrator/storage/migrations/0001-event-core.js";
import { PROJECT_STORE_MIGRATIONS } from "../src/orchestrator/storage/migrations/registry.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import type {
  SqliteConnection,
  SqliteStatement,
} from "../src/orchestrator/storage/sqlite-driver.js";

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
  new MigrationRunner().apply(connection, [eventCoreMigration], NOW, { kind: "bootstrap-empty" });
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
  new MigrationRunner().apply(connection, PROJECT_STORE_MIGRATIONS, NOW, { kind: "bootstrap-empty" });
  connection.exec("BEGIN IMMEDIATE");
  connection.prepare(`
    INSERT INTO project_meta(singleton, project_id, vault_id, store_id, schema_version, created_at)
    VALUES (1, $projectId, $vaultId, $storeId, 2, $createdAt)
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
    transaction: () => {
      facadeCalls += 1;
      return {
        authority: {}, leases: {}, approvals: {}, transfers: {},
        coverage: {}, workflows: {}, validation: {}, outbox: {},
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
    coverage: {},
    workflows: {},
    validation: {},
    outbox: {},
  };
  const store = new LifecycleCommandStore({
    connection,
    events: tx,
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
    replayExpectation: command.expectation,
  };
  let newCalls = 0;
  const first = store.execute(envelope, () => {
    newCalls += 1;
    return {
      append: command.append,
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
