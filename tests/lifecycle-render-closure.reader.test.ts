import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { JsonValue, StoredEvent } from "../src/orchestrator/contracts/event.js";
import { eventHash, payloadHash } from "../src/orchestrator/crypto/event-hash.js";
import type {
  BranchScopeId,
  ProjectId,
  StoreId,
  VaultId,
  WorkspaceId,
} from "../src/orchestrator/identity/contracts.js";
import type {
  ClaimChildTransferCommandV2,
  CreateChildTransferCommandV2,
  ForkChildCommandV2,
  LifecycleSemanticCommandDraft,
  RootStartCommandV2,
} from "../src/orchestrator/lifecycle/contracts/commands.js";
import type {
  SessionId,
  TransferTicketId,
} from "../src/orchestrator/lifecycle/contracts/identifiers.js";
import { LifecycleError } from "../src/orchestrator/lifecycle/errors.js";
import {
  buildLifecycleIntentWitness,
  type BuiltLifecycleIntentWitnessV1,
  type TrustedLifecycleIntentAssertionsV1,
} from "../src/orchestrator/lifecycle/lifecycle-intent-witness.js";
import { SqliteLifecycleRenderClosureReader } from "../src/orchestrator/materialization/sqlite-lifecycle-render-closure.reader.js";
import { deriveCompatibilityLogTarget } from "../src/orchestrator/materialization/vault-artifact-path.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import type {
  SqliteConnection,
  SqliteParams,
  SqliteValue,
} from "../src/orchestrator/storage/sqlite-driver.js";
import { applyCurrentProjectStoreSchema } from "./support/current-project-store-schema.js";
import {
  AUTHORITY_A,
  CHECKPOINT_ID,
  DEFAULT_ASSIGNMENT,
  PROJECT_ID,
  STORE_ID,
  VAULT_ID,
  lifecycleEvent,
  lifecycleTimestamp,
  lifecycleUuid,
} from "./support/lifecycle-fixtures.js";

const NOW = "2026-08-09T00:00:00.000Z";
const SOURCE_ROOT_ID = lifecycleUuid<SessionId>(10);
const SOURCE_CHILD_ID = lifecycleUuid<SessionId>(11);
const FOREIGN_ROOT_ID = lifecycleUuid<SessionId>(12);
const FOREIGN_CHILD_ID = lifecycleUuid<SessionId>(13);
const TRANSFER_TICKET_ID = lifecycleUuid<TransferTicketId>(50);
const SOURCE_WORKSPACE_ID = "1".repeat(64) as WorkspaceId;
const FOREIGN_WORKSPACE_ID = "2".repeat(64) as WorkspaceId;
const SOURCE_BRANCH_SCOPE_ID = lifecycleUuid<BranchScopeId>(70);
const FOREIGN_BRANCH_SCOPE_ID = lifecycleUuid<BranchScopeId>(71);
const SOURCE_BRANCH_REF = "refs/heads/source";
const FOREIGN_BRANCH_REF = "refs/heads/foreign";
const SOURCE_CLIENT_ID = "source-primary-client";
const SOURCE_CHILD_CLIENT_ID = "source-child-client";
const FOREIGN_CLIENT_ID = "foreign-primary-client";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const driver = new NodeSqliteDriver({ DatabaseSync });

interface CommandFixture {
  readonly command: LifecycleSemanticCommandDraft;
  readonly witness: BuiltLifecycleIntentWitnessV1;
  readonly assertions: TrustedLifecycleIntentAssertionsV1;
}

interface EventInput {
  readonly globalPosition: bigint;
  readonly streamVersion: bigint;
  readonly eventId: string;
  readonly eventType: StoredEvent["eventType"];
  readonly sessionId: SessionId;
  readonly parentSessionId: SessionId | null;
  readonly workspaceId: WorkspaceId;
  readonly branchScopeId: BranchScopeId;
  readonly branchRef: string;
  readonly clientInstanceId: string;
  readonly correlationId?: string;
  readonly causationId: string | null;
  readonly commandEventIndex: number;
  readonly command: CommandFixture;
  readonly payload: JsonValue;
}

interface ReaderFixture {
  readonly connection: SqliteConnection;
  readonly tempRoot: string;
  readonly reader: SqliteLifecycleRenderClosureReader;
  readonly sourceTransferEventId: string;
  readonly foreignForkEventId: string;
}

interface ReaderFixtureOptions {
  readonly foreignForkCausationId?: string;
  readonly mutate?: (
    connection: SqliteConnection,
    ids: Readonly<{ sourceTransferEventId: string; foreignForkEventId: string }>,
  ) => void;
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

function dropFixtureWriteTriggers(connection: SqliteConnection): void {
  const triggerRows = connection.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name
  `).all();
  for (const row of triggerRows) {
    if (typeof row.name !== "string" || !/^[a-z0-9_]+$/u.test(row.name)) {
      throw new TypeError("unexpected fixture trigger name");
    }
    connection.exec(`DROP TRIGGER ${row.name}`);
  }
}

function assertions(input: {
  readonly authorizationKind: "initial-authority" | "protected";
  readonly authorizationSessionId: SessionId | null;
  readonly targetSessionId: SessionId;
  readonly workspaceId: WorkspaceId;
  readonly presentingClientInstanceId: string;
  readonly targetClientInstanceId: string;
}): TrustedLifecycleIntentAssertionsV1 {
  return Object.freeze({
    authorizationKind: input.authorizationKind,
    authorizationSessionId: input.authorizationSessionId,
    targetSessionId: input.targetSessionId,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: input.workspaceId,
    clientNamespace: "tests/lifecycle-render-closure.reader",
    capabilityKind: null,
    capabilityGeneration: null,
    presentingActorRole: "primary",
    presentingClientInstanceId: input.presentingClientInstanceId,
    targetActorRole: "primary",
    targetClientInstanceId: input.targetClientInstanceId,
    internalWorkflowId: null,
    internalWorkflowGeneration: null,
    internalPlannedWorkId: null,
  });
}

function commandFixture(
  command: LifecycleSemanticCommandDraft,
  commandAssertions: TrustedLifecycleIntentAssertionsV1,
): CommandFixture {
  return Object.freeze({
    command,
    assertions: commandAssertions,
    witness: buildLifecycleIntentWitness(command, commandAssertions),
  });
}

function storedEvent(input: EventInput): StoredEvent {
  const payloadJson = canonicalJson(input.payload);
  const lifecycleIntentJson = input.commandEventIndex === 0
    ? input.command.witness.source
    : null;
  const eventWithoutHash = {
    globalPosition: input.globalPosition,
    eventId: input.eventId,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: input.workspaceId,
    branchScopeId: input.branchScopeId,
    branchRef: input.branchRef,
    streamId: `session/${input.sessionId}`,
    streamType: "session",
    streamVersion: input.streamVersion,
    eventType: input.eventType,
    eventSchemaVersion: 1,
    sessionId: input.sessionId,
    parentSessionId: input.parentSessionId,
    actorRole: "primary",
    agentId: input.command.command.agentId,
    clientInstanceId: input.clientInstanceId,
    correlationId: input.correlationId ?? lifecycleUuid(800 + Number(input.globalPosition)),
    causationId: input.causationId,
    commandId: input.command.command.commandId,
    idempotencyKey: input.command.command.idempotencyKey,
    commandEventIndex: input.commandEventIndex,
    occurredAt: lifecycleTimestamp(Number(input.globalPosition)),
    recordedAt: NOW,
    visibilityScope: "session",
    confidence: "high",
    verificationStatus: "verified",
    sourceRefs: Object.freeze([]) as readonly string[],
    evidenceRefs: Object.freeze([]) as readonly [],
    evidenceDigests: Object.freeze([]) as readonly [],
    payload: input.payload,
    payloadJson,
    payloadHash: payloadHash(input.payload),
    previousGlobalHash: HASH_A,
    lifecycleIntentJson,
  } as const;
  const hashMaterial: Record<string, unknown> = {
    ...eventWithoutHash,
    globalPosition: input.globalPosition.toString(),
    streamVersion: input.streamVersion.toString(),
    sourceRefs: [],
  };
  delete hashMaterial.payload;
  delete hashMaterial.payloadJson;
  delete hashMaterial.lifecycleIntentJson;
  if (input.commandEventIndex === 0) {
    hashMaterial.lifecycleIntent = input.command.witness.witness;
  }
  return Object.freeze({
    ...eventWithoutHash,
    eventHash: eventHash(hashMaterial),
  });
}

function insertStoredEvent(connection: SqliteConnection, event: StoredEvent): void {
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
    source_refs_json: canonicalJson(event.sourceRefs),
    evidence_refs_json: "[]",
    evidence_digests_json: "[]",
    payload_json: event.payloadJson,
    payload_hash: event.payloadHash,
    previous_global_hash: event.previousGlobalHash,
    event_hash: event.eventHash,
    lifecycle_intent_json: event.lifecycleIntentJson ?? null,
  });
}

function insertCommand(
  connection: SqliteConnection,
  fixture: CommandFixture,
  events: readonly StoredEvent[],
  proofOrdinal: number | null,
): void {
  const first = events[0]!;
  const last = events.at(-1)!;
  const protectedCommand = fixture.assertions.authorizationKind === "protected";
  rawInsert(connection, "command_dedup", {
    project_id: PROJECT_ID,
    idempotency_key: fixture.command.idempotencyKey,
    command_id: fixture.command.commandId,
    command_type: fixture.command.commandType,
    command_hash: fixture.witness.intentHash,
    workspace_head_commit: null,
    outbox_order_json: "[]",
    state: "committed",
    first_global_position: first.globalPosition,
    last_global_position: last.globalPosition,
    final_stream_version: last.streamVersion,
    event_ids_json: canonicalJson(events.map((event) => event.eventId)),
    response_json: "{}",
    response_hash: HASH_B,
    committed_at: NOW,
    lifecycle_authorization_kind: fixture.assertions.authorizationKind,
    authorization_proof_version: protectedCommand ? 1 : null,
    authorization_proof_nonce: protectedCommand ? lifecycleUuid(proofOrdinal ?? 900) : null,
    authorization_proof_digest: protectedCommand ? HASH_C : null,
    authorization_approval_id: null,
    authorization_approval_digest: null,
    authorization_session_id: fixture.assertions.authorizationSessionId,
    target_session_id: fixture.assertions.targetSessionId,
    presenting_actor_role: fixture.assertions.presentingActorRole,
    presenting_client_instance_id: fixture.assertions.presentingClientInstanceId,
    target_actor_role: fixture.assertions.targetActorRole,
    target_client_instance_id: fixture.assertions.targetClientInstanceId,
    internal_workflow_id: null,
    internal_workflow_generation: null,
    internal_planned_work_id: null,
    internal_claim_owner_id: null,
    internal_claim_token: null,
  });
}

function createReaderFixture(options: ReaderFixtureOptions = {}): ReaderFixture {
  const tempRoot = mkdtempSync(join(tmpdir(), "awakened-q2b-reader-"));
  const connection = driver.open(join(tempRoot, "events.sqlite"), { mode: "create", busyTimeoutMs: 1_000 });
  applyCurrentProjectStoreSchema(connection, {
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
  }, NOW);
  connection.exec("PRAGMA foreign_keys = OFF");
  dropFixtureWriteTriggers(connection);

  const rootCommand = commandFixture({
    commandType: "root-start",
    commandId: lifecycleUuid(100),
    idempotencyKey: "reader/root-start",
    agentId: "agent-source",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: SOURCE_WORKSPACE_ID,
    expectedBranchRef: SOURCE_BRANCH_REF,
    continuityKey: "reader-root",
    resumePolicy: "new",
  } satisfies RootStartCommandV2, assertions({
    authorizationKind: "initial-authority",
    authorizationSessionId: null,
    targetSessionId: SOURCE_ROOT_ID,
    workspaceId: SOURCE_WORKSPACE_ID,
    presentingClientInstanceId: SOURCE_CLIENT_ID,
    targetClientInstanceId: SOURCE_CLIENT_ID,
  }));
  const forkCommand = commandFixture({
    commandType: "fork-child",
    commandId: lifecycleUuid(101),
    idempotencyKey: "reader/source-fork",
    agentId: "agent-source",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: SOURCE_WORKSPACE_ID,
    expectedBranchRef: SOURCE_BRANCH_REF,
    parentSessionId: SOURCE_ROOT_ID,
    expectedStreamVersion: "0",
    assignment: DEFAULT_ASSIGNMENT,
    directAccessRequested: true,
  } satisfies ForkChildCommandV2, assertions({
    authorizationKind: "protected",
    authorizationSessionId: SOURCE_ROOT_ID,
    targetSessionId: SOURCE_ROOT_ID,
    workspaceId: SOURCE_WORKSPACE_ID,
    presentingClientInstanceId: SOURCE_CLIENT_ID,
    targetClientInstanceId: SOURCE_CHILD_CLIENT_ID,
  }));
  const transferCommand = commandFixture({
    commandType: "create-child-transfer",
    commandId: lifecycleUuid(102),
    idempotencyKey: "reader/source-transfer",
    agentId: "agent-source",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: SOURCE_WORKSPACE_ID,
    expectedBranchRef: SOURCE_BRANCH_REF,
    parentSessionId: SOURCE_ROOT_ID,
    childSessionId: SOURCE_CHILD_ID,
    expectedStreamVersion: "1",
    checkpointId: CHECKPOINT_ID,
  } satisfies CreateChildTransferCommandV2, assertions({
    authorizationKind: "protected",
    authorizationSessionId: SOURCE_ROOT_ID,
    targetSessionId: SOURCE_CHILD_ID,
    workspaceId: SOURCE_WORKSPACE_ID,
    presentingClientInstanceId: SOURCE_CLIENT_ID,
    targetClientInstanceId: SOURCE_CHILD_CLIENT_ID,
  }));
  const claimCommand = commandFixture({
    commandType: "claim-child-transfer",
    commandId: lifecycleUuid(103),
    idempotencyKey: "reader/foreign-claim",
    agentId: "agent-foreign",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: FOREIGN_WORKSPACE_ID,
    expectedBranchRef: FOREIGN_BRANCH_REF,
    rootSessionId: FOREIGN_ROOT_ID,
    transferTicketId: TRANSFER_TICKET_ID,
    expectedStreamVersion: "0",
  } satisfies ClaimChildTransferCommandV2, assertions({
    authorizationKind: "protected",
    authorizationSessionId: FOREIGN_ROOT_ID,
    targetSessionId: FOREIGN_ROOT_ID,
    workspaceId: FOREIGN_WORKSPACE_ID,
    presentingClientInstanceId: FOREIGN_CLIENT_ID,
    targetClientInstanceId: FOREIGN_CLIENT_ID,
  }));

  const sourceTransferEventId = lifecycleUuid(205);
  const foreignForkEventId = lifecycleUuid(210);
  const root = storedEvent({
    globalPosition: 1n,
    streamVersion: 1n,
    eventId: lifecycleUuid(201),
    eventType: "SessionStarted",
    sessionId: SOURCE_ROOT_ID,
    parentSessionId: null,
    workspaceId: SOURCE_WORKSPACE_ID,
    branchScopeId: SOURCE_BRANCH_SCOPE_ID,
    branchRef: SOURCE_BRANCH_REF,
    clientInstanceId: SOURCE_CLIENT_ID,
    causationId: null,
    commandEventIndex: 0,
    command: rootCommand,
    payload: lifecycleEvent(1, "SessionStarted", {}, {
      sessionId: SOURCE_ROOT_ID,
      parentSessionId: null,
      workspaceId: SOURCE_WORKSPACE_ID,
    }).payload as unknown as JsonValue,
  });
  const sourceFork = storedEvent({
    globalPosition: 3n,
    streamVersion: 1n,
    eventId: lifecycleUuid(203),
    eventType: "SessionForked",
    sessionId: SOURCE_CHILD_ID,
    parentSessionId: SOURCE_ROOT_ID,
    workspaceId: SOURCE_WORKSPACE_ID,
    branchScopeId: SOURCE_BRANCH_SCOPE_ID,
    branchRef: SOURCE_BRANCH_REF,
    clientInstanceId: SOURCE_CHILD_CLIENT_ID,
    causationId: root.eventId,
    commandEventIndex: 0,
    command: forkCommand,
    payload: lifecycleEvent(1, "SessionForked", {
      parentSessionId: SOURCE_ROOT_ID,
      sourceTransferTicketId: null,
    }, {
      sessionId: SOURCE_CHILD_ID,
      parentSessionId: SOURCE_ROOT_ID,
      workspaceId: SOURCE_WORKSPACE_ID,
    }).payload as unknown as JsonValue,
  });
  const sourceTransfer = storedEvent({
    globalPosition: 5n,
    streamVersion: 2n,
    eventId: sourceTransferEventId,
    eventType: "ChildWorkTransferCreated",
    sessionId: SOURCE_CHILD_ID,
    parentSessionId: SOURCE_ROOT_ID,
    workspaceId: SOURCE_WORKSPACE_ID,
    branchScopeId: SOURCE_BRANCH_SCOPE_ID,
    branchRef: SOURCE_BRANCH_REF,
    clientInstanceId: SOURCE_CHILD_CLIENT_ID,
    causationId: sourceFork.eventId,
    commandEventIndex: 0,
    command: transferCommand,
    payload: lifecycleEvent(2, "ChildWorkTransferCreated", {
      transferTicketId: TRANSFER_TICKET_ID,
      checkpointId: CHECKPOINT_ID,
      authorityCommitment: AUTHORITY_A,
    }, {
      sessionId: SOURCE_CHILD_ID,
      parentSessionId: SOURCE_ROOT_ID,
      workspaceId: SOURCE_WORKSPACE_ID,
      globalPosition: 5,
      streamVersion: 2,
    }).payload as unknown as JsonValue,
  });
  const foreignFork = storedEvent({
    globalPosition: 10n,
    streamVersion: 1n,
    eventId: foreignForkEventId,
    eventType: "SessionForked",
    sessionId: FOREIGN_CHILD_ID,
    parentSessionId: FOREIGN_ROOT_ID,
    workspaceId: FOREIGN_WORKSPACE_ID,
    branchScopeId: FOREIGN_BRANCH_SCOPE_ID,
    branchRef: FOREIGN_BRANCH_REF,
    clientInstanceId: FOREIGN_CLIENT_ID,
    correlationId: lifecycleUuid(810),
    causationId: options.foreignForkCausationId ?? sourceTransfer.eventId,
    commandEventIndex: 0,
    command: claimCommand,
    payload: lifecycleEvent(1, "SessionForked", {
      parentSessionId: FOREIGN_ROOT_ID,
      sourceTransferTicketId: TRANSFER_TICKET_ID,
    }, {
      sessionId: FOREIGN_CHILD_ID,
      parentSessionId: FOREIGN_ROOT_ID,
      workspaceId: FOREIGN_WORKSPACE_ID,
      globalPosition: 10,
      streamVersion: 1,
    }).payload as unknown as JsonValue,
  });
  const foreignClaim = storedEvent({
    globalPosition: 11n,
    streamVersion: 2n,
    eventId: lifecycleUuid(211),
    eventType: "ChildWorkTransferClaimed",
    sessionId: FOREIGN_CHILD_ID,
    parentSessionId: FOREIGN_ROOT_ID,
    workspaceId: FOREIGN_WORKSPACE_ID,
    branchScopeId: FOREIGN_BRANCH_SCOPE_ID,
    branchRef: FOREIGN_BRANCH_REF,
    clientInstanceId: FOREIGN_CLIENT_ID,
    correlationId: lifecycleUuid(810),
    causationId: foreignFork.eventId,
    commandEventIndex: 1,
    command: claimCommand,
    payload: lifecycleEvent(2, "ChildWorkTransferClaimed", {
      transferTicketId: TRANSFER_TICKET_ID,
      previousChildSessionId: SOURCE_CHILD_ID,
      previousTransferEventPosition: sourceTransfer.globalPosition.toString(),
    }, {
      sessionId: FOREIGN_CHILD_ID,
      parentSessionId: FOREIGN_ROOT_ID,
      workspaceId: FOREIGN_WORKSPACE_ID,
      globalPosition: 11,
      streamVersion: 2,
    }).payload as JsonValue,
  });

  for (const event of [root, sourceFork, sourceTransfer, foreignFork, foreignClaim]) {
    insertStoredEvent(connection, event);
  }
  insertCommand(connection, rootCommand, [root], null);
  insertCommand(connection, forkCommand, [sourceFork], 901);
  insertCommand(connection, transferCommand, [sourceTransfer], 902);
  insertCommand(connection, claimCommand, [foreignFork, foreignClaim], 903);
  rawInsert(connection, "child_transfer_tickets", {
    project_id: PROJECT_ID,
    transfer_ticket_id: TRANSFER_TICKET_ID,
    source_parent_session_id: SOURCE_ROOT_ID,
    source_child_session_id: SOURCE_CHILD_ID,
    source_assignment_json: canonicalJson(DEFAULT_ASSIGNMENT),
    source_scope_json: "{}",
    checkpoint_id: CHECKPOINT_ID,
    follow_ups_json: "[]",
    source_state_json: "{}",
    lineage_json: "{}",
    created_event_position: sourceTransfer.globalPosition,
    created_at: sourceTransfer.occurredAt,
    claimed_by_root_session_id: FOREIGN_ROOT_ID,
    claimed_child_session_id: FOREIGN_CHILD_ID,
    claimed_event_position: foreignClaim.globalPosition,
    claimed_at: foreignClaim.occurredAt,
  });
  options.mutate?.(connection, { sourceTransferEventId, foreignForkEventId });

  return Object.freeze({
    connection,
    tempRoot,
    reader: new SqliteLifecycleRenderClosureReader(connection),
    sourceTransferEventId,
    foreignForkEventId,
  });
}

function assertIntegrityFailure(action: () => unknown): void {
  assert.throws(action, (error: unknown) =>
    error instanceof LifecycleError && error.code === "INTEGRITY_FAILURE");
}

test("derives one canonical path and revision-bearing target", () => {
  const target = deriveCompatibilityLogTarget("2026-08-09T00:00:00.000Z", "44444444-4444-4444-8444-444444444444" as any, 7n);
  assert.deepEqual(target, { artifactPath: "05_Agent_Session_Logs/2026-08-09-session-44444444-4444-4444-8444-444444444444.md", targetKey: "lifecycle-log/44444444-4444-4444-8444-444444444444/7", materializationRevision: "7" });
});

test("authenticates an exact cross-workspace foreign fork claim pair", (t) => {
  const fixture = createReaderFixture();
  t.after(() => { fixture.connection.close(); rmSync(fixture.tempRoot, { recursive: true, force: true }); });

  const closure = fixture.reader.readStrictLifecycleClosure(
    PROJECT_ID as ProjectId,
    SOURCE_ROOT_ID,
    20n,
  );

  assert.equal(closure.root.length, 1);
  assert.deepEqual(closure.directChildren.map((child) => child.childSessionId), [SOURCE_CHILD_ID]);
  assert.equal(closure.foreignClaims.length, 1);
  assert.deepEqual(closure.foreignClaims[0], {
    fork: {
      projectId: PROJECT_ID,
      vaultId: VAULT_ID,
      storeId: STORE_ID,
      workspaceId: FOREIGN_WORKSPACE_ID,
      branchScopeId: FOREIGN_BRANCH_SCOPE_ID,
      branchRef: FOREIGN_BRANCH_REF,
      streamId: `session/${FOREIGN_CHILD_ID}`,
      streamVersion: "1",
      globalPosition: "10",
      sessionId: FOREIGN_CHILD_ID,
      parentSessionId: FOREIGN_ROOT_ID,
      eventType: "SessionForked",
      eventSchemaVersion: 1,
      occurredAt: lifecycleTimestamp(10),
      payload: lifecycleEvent(1, "SessionForked", {
        parentSessionId: FOREIGN_ROOT_ID,
        sourceTransferTicketId: TRANSFER_TICKET_ID,
      }, {
        sessionId: FOREIGN_CHILD_ID,
        parentSessionId: FOREIGN_ROOT_ID,
        workspaceId: FOREIGN_WORKSPACE_ID,
        globalPosition: 10,
        streamVersion: 1,
      }).payload,
      materializationOrigin: null,
      legacyIntentSemantics: null,
    },
    claim: {
      projectId: PROJECT_ID,
      vaultId: VAULT_ID,
      storeId: STORE_ID,
      workspaceId: FOREIGN_WORKSPACE_ID,
      branchScopeId: FOREIGN_BRANCH_SCOPE_ID,
      branchRef: FOREIGN_BRANCH_REF,
      streamId: `session/${FOREIGN_CHILD_ID}`,
      streamVersion: "2",
      globalPosition: "11",
      sessionId: FOREIGN_CHILD_ID,
      parentSessionId: FOREIGN_ROOT_ID,
      eventType: "ChildWorkTransferClaimed",
      eventSchemaVersion: 1,
      occurredAt: lifecycleTimestamp(11),
      payload: lifecycleEvent(2, "ChildWorkTransferClaimed", {
        transferTicketId: TRANSFER_TICKET_ID,
        previousChildSessionId: SOURCE_CHILD_ID,
        previousTransferEventPosition: "5",
      }, {
        sessionId: FOREIGN_CHILD_ID,
        parentSessionId: FOREIGN_ROOT_ID,
        workspaceId: FOREIGN_WORKSPACE_ID,
        globalPosition: 11,
        streamVersion: 2,
      }).payload,
      materializationOrigin: null,
      legacyIntentSemantics: null,
    },
  });
});

test("rejects every malformed foreign fork claim pair", (t) => {
  const fixture = createReaderFixture({
    foreignForkCausationId: lifecycleUuid(999),
  });
  t.after(() => { fixture.connection.close(); rmSync(fixture.tempRoot, { recursive: true, force: true }); });

  assert.notEqual(fixture.sourceTransferEventId, lifecycleUuid(999));
  assertIntegrityFailure(() => fixture.reader.readStrictLifecycleClosure(
    PROJECT_ID as ProjectId,
    SOURCE_ROOT_ID,
    20n,
  ));
});

test("accepts global gaps and rejects incomplete lifecycle closure", (t) => {
  const complete = createReaderFixture();
  t.after(() => { complete.connection.close(); rmSync(complete.tempRoot, { recursive: true, force: true }); });
  const closure = complete.reader.readStrictLifecycleClosure(PROJECT_ID as ProjectId, SOURCE_ROOT_ID, 20n);
  assert.equal(closure.root[0]?.globalPosition, "1");
  assert.equal(closure.directChildren[0]?.events.at(-1)?.globalPosition, "5");

  const incomplete = createReaderFixture({
    mutate(connection, ids) {
      connection.prepare("DELETE FROM events WHERE event_id = $eventId").run({ $eventId: ids.sourceTransferEventId });
    },
  });
  t.after(() => { incomplete.connection.close(); rmSync(incomplete.tempRoot, { recursive: true, force: true }); });
  assertIntegrityFailure(() => incomplete.reader.readStrictLifecycleClosure(
    PROJECT_ID as ProjectId,
    SOURCE_ROOT_ID,
    20n,
  ));
});

test("authenticates a multi-event command from its event-zero intent witness", (t) => {
  const fixture = createReaderFixture();
  t.after(() => { fixture.connection.close(); rmSync(fixture.tempRoot, { recursive: true, force: true }); });
  const closure = fixture.reader.readStrictLifecycleClosure(PROJECT_ID as ProjectId, SOURCE_ROOT_ID, 20n);
  assert.equal(closure.foreignClaims.length, 1);
  assert.equal(closure.foreignClaims[0]?.claim.eventType, "ChildWorkTransferClaimed");
});

test("discovers post-cutoff claims for pointer proof but excludes them from the closure", (t) => {
  const fixture = createReaderFixture();
  t.after(() => { fixture.connection.close(); rmSync(fixture.tempRoot, { recursive: true, force: true }); });
  const closure = fixture.reader.readStrictLifecycleClosure(PROJECT_ID as ProjectId, SOURCE_ROOT_ID, 10n);
  assert.equal(closure.root.length, 1);
  assert.equal(closure.directChildren.length, 1);
  assert.equal(closure.foreignClaims.length, 0);
});
