import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import type {
  AppendCommand,
  DeepReadonlyJson,
  JsonValue,
  LifecycleReplayExpectation,
  PersistedLifecycleAuthorizationRecord,
  ReadonlyJsonValue,
  StoredEvent,
} from "../src/orchestrator/contracts/event.js";
import type {
  EventAppendBatch,
  PlannedEventAppend,
  PreparedEventAppend,
} from "../src/orchestrator/storage/event-append-transaction.js";
import type { ProjectContext } from "../src/orchestrator/identity/contracts.js";
import {
  connectionBoundEvidenceCoverage,
  LifecycleCommandStore,
  LifecycleCommandStoreError,
  type LifecycleCommandEnvelope,
  type LifecycleCommandTransaction,
  type LifecycleEventAppendPort,
  type PreparedLifecycleCommit,
} from "../src/orchestrator/lifecycle/lifecycle-command.store.js";
import type {
  ClaimChildTransferCommandV2,
  InternalWorkflowPhaseCommand,
  RecordEvidenceBatchCommandV2,
  RecordCheckpointCommandV2,
  RecordCheckpointCommandV3,
  RootResumeCommandV2,
} from "../src/orchestrator/lifecycle/contracts/commands.js";
import { buildLifecycleIntentWitness } from "../src/orchestrator/lifecycle/lifecycle-intent-witness.js";
import type {
  EventAppendReplay,
} from "../src/orchestrator/storage/event-append-transaction.js";
import type {
  SqliteConnection,
  SqliteStatement,
} from "../src/orchestrator/storage/sqlite-driver.js";
import {
  internalPhasePlannedWorkId,
  internalValidationPlannedWorkId,
} from "../src/orchestrator/crypto/event-hash.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import type { LifecycleFaultContext } from "../src/orchestrator/lifecycle/lifecycle-faults.js";
import type {
  LifecycleProjectionWriter,
} from "../src/orchestrator/storage/lifecycle-projection.repository.js";

const NOW = "2026-07-14T00:00:00.000Z";
const CONTEXT = {
  binding: {
    projectId: "00000000-0000-4000-8000-000000000001",
    vaultId: "00000000-0000-4000-8000-000000000002",
    storeId: "00000000-0000-4000-8000-000000000003",
    workspaceId: "1".repeat(64),
    clientNamespace: "tests",
  },
} as unknown as ProjectContext;
const SEMANTIC_COMMAND = {
  commandType: "root-resume",
  commandId: "00000000-0000-4000-8000-000000000100",
  idempotencyKey: "lifecycle:test:100",
  agentId: "agent",
  expectedProjectId: CONTEXT.binding.projectId,
  expectedVaultId: CONTEXT.binding.vaultId,
  expectedWorkspaceId: CONTEXT.binding.workspaceId,
  expectedBranchRef: null,
  sessionId: "00000000-0000-4000-8000-000000000010",
  continuityKey: "lifecycle:test",
  resumePolicy: "exact",
  expectedOwnerGeneration: "1",
} as RootResumeCommandV2;
const INTENT_WITNESS = buildLifecycleIntentWitness(SEMANTIC_COMMAND, {
  authorizationKind: "protected",
  authorizationSessionId: "00000000-0000-4000-8000-000000000010",
  targetSessionId: "00000000-0000-4000-8000-000000000010",
  projectId: CONTEXT.binding.projectId,
  vaultId: CONTEXT.binding.vaultId,
  storeId: CONTEXT.binding.storeId,
  workspaceId: CONTEXT.binding.workspaceId,
  clientNamespace: CONTEXT.binding.clientNamespace,
  capabilityKind: "root-session-handle",
  capabilityGeneration: "1",
  presentingActorRole: "primary",
  presentingClientInstanceId: "primary-a",
  targetActorRole: "primary",
  targetClientInstanceId: "primary-a",
  internalWorkflowId: null,
  internalWorkflowGeneration: null,
  internalPlannedWorkId: null,
});
const HASH_A = INTENT_WITNESS.intentHash;

function recordCheckpointCommand(checkpointVersion: 1 | 2): RecordCheckpointCommandV2 | RecordCheckpointCommandV3 {
  return {
    commandType: "record-checkpoint",
    commandId: SEMANTIC_COMMAND.commandId,
    idempotencyKey: SEMANTIC_COMMAND.idempotencyKey,
    agentId: SEMANTIC_COMMAND.agentId,
    expectedProjectId: CONTEXT.binding.projectId,
    expectedVaultId: CONTEXT.binding.vaultId,
    expectedWorkspaceId: CONTEXT.binding.workspaceId,
    expectedBranchRef: null,
    sessionId: SEMANTIC_COMMAND.sessionId,
    expectedStreamVersion: "1",
    expectedBaseEventPosition: null,
    draft: {
      checkpointVersion,
      taskSummary: "same command identity, different nested version",
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
    },
  } as RecordCheckpointCommandV2 | RecordCheckpointCommandV3;
}

function checkpointIntent(command: RecordCheckpointCommandV2 | RecordCheckpointCommandV3) {
  return buildLifecycleIntentWitness(command, {
    authorizationKind: "protected",
    authorizationSessionId: command.sessionId,
    targetSessionId: command.sessionId,
    projectId: CONTEXT.binding.projectId,
    vaultId: CONTEXT.binding.vaultId,
    storeId: CONTEXT.binding.storeId,
    workspaceId: CONTEXT.binding.workspaceId,
    clientNamespace: CONTEXT.binding.clientNamespace,
    capabilityKind: "root-session-handle",
    capabilityGeneration: "1",
    presentingActorRole: "primary",
    presentingClientInstanceId: "primary-a",
    targetActorRole: "primary",
    targetClientInstanceId: "primary-a",
    internalWorkflowId: null,
    internalWorkflowGeneration: null,
    internalPlannedWorkId: null,
  });
}

class TransactionConnection implements SqliteConnection {
  readonly statements: string[] = [];
  readonly committed: string[] = [];
  #pending: string[] = [];

  constructor(
    readonly failCommit = false,
    readonly order?: string[],
  ) {}

  stage(effect: string): void { this.#pending.push(effect); }

  exec(sql: string): void {
    const normalized = sql.trim().replace(/\s+/g, " ").toUpperCase();
    this.statements.push(normalized);
    if (normalized === "BEGIN IMMEDIATE") {
      this.#pending = [];
    } else if (normalized === "COMMIT") {
      if (this.failCommit) throw { errcode: 10 };
      this.committed.push(...this.#pending);
      this.#pending = [];
      this.order?.push("commit");
    } else if (normalized === "ROLLBACK") {
      this.#pending = [];
    }
  }

  prepare(_sql: string): SqliteStatement { throw new Error("raw SQL must remain private"); }
  close(): void {}
}

class FrozenWorkflowProbeConnection implements SqliteConnection {
  readonly statements: string[] = [];

  exec(_sql: string): void {}

  prepare(sql: string): SqliteStatement {
    this.statements.push(sql);
    const get = () => {
      if (/FROM project_meta/i.test(sql)) {
        return { project_id: CONTEXT.binding.projectId };
      }
      if (/FROM session_authority/i.test(sql)) {
        return {
          stream_id: `session/${SEMANTIC_COMMAND.sessionId}`,
          session_kind: "root",
          parent_session_id: null,
          workspace_id: CONTEXT.binding.workspaceId,
          client_namespace: CONTEXT.binding.clientNamespace,
          owner_generation: 1n,
          child_capability_generation: null,
        };
      }
      if (/FROM workflow_instances/i.test(sql) && /bindings_is_null/i.test(sql)) {
        return {
          workflow_type: "session-end",
          generation: 2n,
          phase: "validating",
          session_id: SEMANTIC_COMMAND.sessionId,
          evidence_frozen_checkpoint_event_position: 4n,
          evidence_frozen_generation: 1n,
          evidence_window_state: "sealed",
          bindings_is_null: 0n,
        };
      }
      return undefined;
    };
    return { get } as unknown as SqliteStatement;
  }

  close(): void {}
}

function principal(clientInstanceId: string) {
  return { actorRole: "primary" as const, clientInstanceId };
}

function expectation(): LifecycleReplayExpectation {
  return {
    kind: "protected",
    proof: { version: 1, nonce: "00000000-0000-4000-8000-000000000001", digest: "1".repeat(64) },
    approval: null,
    authorizationSessionId: "00000000-0000-4000-8000-000000000010",
    targetSessionId: "00000000-0000-4000-8000-000000000010",
    presenting: principal("primary-a"),
    target: principal("primary-a"),
  };
}

function authorization(): PersistedLifecycleAuthorizationRecord {
  return expectation() as PersistedLifecycleAuthorizationRecord;
}

function envelope(overrides: Partial<LifecycleCommandEnvelope> = {}): LifecycleCommandEnvelope {
  return {
    context: CONTEXT,
    commandId: "00000000-0000-4000-8000-000000000100",
    idempotencyKey: "lifecycle:test:100",
    commandType: "root-resume",
    candidateIntentHash: HASH_A,
    authoritativeIntentHash: HASH_A,
    semanticCommand: SEMANTIC_COMMAND,
    capabilityKind: "root-session-handle",
    capabilityGeneration: "1",
    replayExpectation: expectation(),
    ...overrides,
  };
}

function appendCommand(): PreparedLifecycleCommit<JsonValue>["append"] {
  return {
    context: CONTEXT,
    commandId: "00000000-0000-4000-8000-000000000100",
    idempotencyKey: "lifecycle:test:100",
    commandType: "root-resume",
    correlationId: "correlation",
    agentId: "agent",
    expectedStreamVersion: 1n,
    streamId: "session/00000000-0000-4000-8000-000000000010",
    streamType: "session",
    events: [],
    outbox: [],
    publicResponse: { eventPosition: "2" },
  };
}

function replayResult(
  record: PersistedLifecycleAuthorizationRecord = authorization(),
): EventAppendReplay<JsonValue> {
  return {
    deduplicated: true,
    firstGlobalPosition: 2n,
    lastGlobalPosition: 2n,
    finalStreamVersion: 2n,
    eventIds: ["00000000-0000-4000-8000-000000000200"],
    response: { eventPosition: "2" },
    responseHash: "2".repeat(64),
    authorizationRecord: record,
  };
}

class FakeEvents implements LifecycleEventAppendPort {
  readonly calls: string[] = [];
  readonly insertedAuthorizations: PersistedLifecycleAuthorizationRecord[] = [];
  replay: EventAppendReplay<JsonValue> | null = null;

  constructor(
    readonly connection: TransactionConnection,
    readonly order?: string[],
  ) {}

  findLifecycleReplay<T extends JsonValue>(
    _command: LifecycleCommandEnvelope,
  ): EventAppendReplay<T> | null {
    this.calls.push("find-replay");
    return this.replay as EventAppendReplay<T> | null;
  }

  assertCommandIdentityAvailable(_command: LifecycleCommandEnvelope): void {
    this.calls.push("assert-command-id");
  }

  assertAppendAllowed(): void { this.calls.push("assert-maintenance"); }

  prepare<T extends JsonValue>(
    command: AppendCommand<T>,
    _recordedAt: string,
    _commandHashOverride: string,
  ): PreparedEventAppend<T> {
    this.calls.push("prepare");
    return { command, recordedAt: NOW, commandHash: HASH_A, storedEventIds: [] };
  }

  planPrepared<T extends JsonValue>(_prepared: PreparedEventAppend<T>): PlannedEventAppend<T> {
    this.calls.push("plan");
    return {
      plannedOnly: true,
      events: [],
      storedResponse: {
        eventIds: ["00000000-0000-4000-8000-000000000200"],
        firstGlobalPosition: "2",
        lastGlobalPosition: "2",
        finalStreamVersion: "2",
        response: { eventPosition: "2" } as unknown as DeepReadonlyJson<T>,
      },
      responseHash: "2".repeat(64),
    };
  }

  appendPlanned<T extends JsonValue>(planned: PlannedEventAppend<T>): EventAppendBatch<T> {
    this.calls.push("append");
    this.order?.push("append");
    this.connection.stage("event");
    return planned;
  }

  insertDedup<T extends JsonValue>(
    _prepared: PreparedEventAppend<T>,
    _batch: EventAppendBatch<T>,
    record: PersistedLifecycleAuthorizationRecord,
  ): void {
    this.calls.push("dedup");
    this.order?.push("dedup");
    this.insertedAuthorizations.push(record);
    this.connection.stage("dedup");
  }

  result<T extends JsonValue>(batch: EventAppendBatch<T>): EventAppendReplay<T> {
    return {
      deduplicated: false,
      firstGlobalPosition: BigInt(batch.storedResponse.firstGlobalPosition),
      lastGlobalPosition: BigInt(batch.storedResponse.lastGlobalPosition),
      finalStreamVersion: BigInt(batch.storedResponse.finalStreamVersion),
      eventIds: [...batch.storedResponse.eventIds],
      response: batch.storedResponse.response as unknown as T,
      responseHash: batch.responseHash,
      authorizationRecord: authorization(),
    };
  }
}

class PersistedIntentReplayEvents extends FakeEvents {
  #storedIntentHash: string | null = null;
  #pendingIntentHash: string | null = null;
  #pendingAuthorization: PersistedLifecycleAuthorizationRecord | null = null;

  override findLifecycleReplay<T extends JsonValue>(
    command: LifecycleCommandEnvelope,
  ): EventAppendReplay<T> | null {
    this.calls.push("find-replay");
    if (this.replay === null) return null;
    if (this.#storedIntentHash !== command.authoritativeIntentHash) {
      throw new LifecycleCommandStoreError("IDEMPOTENCY_CONFLICT");
    }
    return this.replay as EventAppendReplay<T>;
  }

  override prepare<T extends JsonValue>(
    command: AppendCommand<T>,
    recordedAt: string,
    commandHashOverride: string,
  ): PreparedEventAppend<T> {
    const prepared = super.prepare(command, recordedAt, commandHashOverride);
    return { ...prepared, recordedAt, commandHash: commandHashOverride };
  }

  override insertDedup<T extends JsonValue>(
    prepared: PreparedEventAppend<T>,
    batch: EventAppendBatch<T>,
    record: PersistedLifecycleAuthorizationRecord,
  ): void {
    super.insertDedup(prepared, batch, record);
    this.#pendingIntentHash = prepared.commandHash;
    this.#pendingAuthorization = record;
  }

  override result<T extends JsonValue>(batch: EventAppendBatch<T>): EventAppendReplay<T> {
    const result = super.result(batch);
    if (this.#pendingIntentHash === null || this.#pendingAuthorization === null) {
      throw new Error("committed dedup identity was not staged");
    }
    this.#storedIntentHash = this.#pendingIntentHash;
    this.replay = replayResult(this.#pendingAuthorization);
    this.#pendingIntentHash = null;
    this.#pendingAuthorization = null;
    return result;
  }
}

class DriftedCommitEvents extends FakeEvents {
  override appendPlanned<T extends JsonValue>(
    planned: PlannedEventAppend<T>,
  ): EventAppendBatch<T> {
    const committed = super.appendPlanned(planned);
    return {
      ...committed,
      storedResponse: {
        ...committed.storedResponse,
        finalStreamVersion: "3",
      },
    };
  }
}

class BusyResultEvents extends FakeEvents {
  override result<T extends JsonValue>(_batch: EventAppendBatch<T>): never {
    throw { errcode: 5 };
  }
}

function nestedStoredEvent(): StoredEvent {
  return {
    globalPosition: 2n,
    eventId: "00000000-0000-4000-8000-000000000200",
    projectId: CONTEXT.binding.projectId,
    vaultId: CONTEXT.binding.vaultId,
    storeId: CONTEXT.binding.storeId,
    workspaceId: CONTEXT.binding.workspaceId,
    branchScopeId: null,
    branchRef: null,
    streamId: "session/00000000-0000-4000-8000-000000000010",
    streamType: "session",
    streamVersion: 2n,
    eventType: "NestedRecorded",
    eventSchemaVersion: 1,
    sessionId: "00000000-0000-4000-8000-000000000010",
    parentSessionId: null,
    actorRole: "primary",
    agentId: "agent",
    clientInstanceId: "primary-a",
    correlationId: "correlation",
    causationId: null,
    commandId: "00000000-0000-4000-8000-000000000100",
    idempotencyKey: "lifecycle:test:100",
    commandEventIndex: 0,
    occurredAt: NOW,
    recordedAt: NOW,
    visibilityScope: "session",
    confidence: "high",
    verificationStatus: "verified",
    sourceRefs: ["source-a"],
    evidenceRefs: [],
    evidenceDigests: [],
    payload: { nested: { accepted: true } },
    payloadJson: '{"nested":{"accepted":true}}',
    payloadHash: "3".repeat(64),
    previousGlobalHash: "4".repeat(64),
    eventHash: "5".repeat(64),
    lifecycleIntentJson: null,
  };
}

class MutableNestedBatchEvents extends FakeEvents {
  override planPrepared<T extends JsonValue>(
    _prepared: PreparedEventAppend<T>,
  ): PlannedEventAppend<T> {
    this.calls.push("plan");
    return {
      plannedOnly: true,
      events: [nestedStoredEvent()],
      storedResponse: {
        eventIds: ["00000000-0000-4000-8000-000000000200"],
        firstGlobalPosition: "2",
        lastGlobalPosition: "2",
        finalStreamVersion: "2",
        response: { nested: { eventPosition: "2" } } as unknown as DeepReadonlyJson<T>,
      },
      responseHash: "2".repeat(64),
    };
  }
}

class ExternallyMutableCommitEvents extends MutableNestedBatchEvents {
  committed: EventAppendBatch<JsonValue> | undefined;

  override appendPlanned<T extends JsonValue>(
    planned: PlannedEventAppend<T>,
  ): EventAppendBatch<T> {
    const committed = super.appendPlanned(planned);
    this.committed = committed as EventAppendBatch<JsonValue>;
    return committed;
  }

  corruptCommittedResponse(): void {
    const response = this.committed?.storedResponse.response as {
      nested: { eventPosition: string };
    };
    response.nested.eventPosition = "corrupt-after-hook-entry";
  }
}

function transaction(connection: TransactionConnection): LifecycleCommandTransaction {
  const stage = (name: string) => connection.stage(name);
  return {
    authority: { stage },
    leases: { stage },
    approvals: { stage },
    transfers: { stage },
    coverage: {
      assertEvidenceWindowWritable: () => undefined,
      assertQuickHealthy: () => undefined,
      registerAffectedExistingSessions: () => undefined,
      assertVersion1Eligible: () => undefined,
      prepareBatch: () => { throw new Error("not used"); },
      persistPrepared: () => undefined,
      snapshotV2: () => { throw new Error("not used"); },
      minimumCheckpointUpperBound: () => 0,
      minimumFinalEndingScopeBindingsUpperBound: () => 0,
    },
    workflows: { stage } as never,
    validation: { stage },
    outbox: { stage },
  };
}

function recordingProjectionWriter(
  append: LifecycleProjectionWriter["append"] = () => undefined,
): LifecycleProjectionWriter {
  return Object.freeze({ append });
}

function stage(facade: object, effect: string): void {
  (facade as { stage(value: string): void }).stage(effect);
}

type StagingFacade = { stage(value: string): void };

function assertDeeplyFrozen(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  assert.equal(Object.isFrozen(value), true);
  for (const nested of Object.values(value)) assertDeeplyFrozen(nested);
}

function isLifecycleInputInvalid(error: unknown): boolean {
  return error instanceof LifecycleCommandStoreError
    && error.code === "LIFECYCLE_INPUT_INVALID";
}

describe("LifecycleCommandStore", () => {
  it("treats only Version 3 checkpoint markers as frozen final state", () => {
    const connection = new FrozenWorkflowProbeConnection();
    const coverage = connectionBoundEvidenceCoverage(connection, {} as never);
    assert.throws(() => coverage.assertEvidenceWindowWritable(
      SEMANTIC_COMMAND.sessionId as never,
    ));
    const frozenQuery = connection.statements.find((sql) => (
      /FROM workflow_instances AS workflow/i.test(sql)
      && /frozen_valid/i.test(sql)
    ));
    assert.ok(frozenQuery);
    assert.match(frozenQuery, /event\.event_schema_version = 3/);
  });

  it("carries an earlier final marker only through marker-preserving amendments", () => {
    const connection = new FrozenWorkflowProbeConnection();
    const coverage = connectionBoundEvidenceCoverage(connection, {} as never);
    assert.throws(() => coverage.assertEvidenceWindowWritable(
      SEMANTIC_COMMAND.sessionId as never,
    ));
    const frozenQuery = connection.statements.find((sql) => (
      /FROM workflow_instances AS workflow/i.test(sql)
      && /frozen_valid/i.test(sql)
    ));
    assert.ok(frozenQuery);
    assert.match(frozenQuery, /NOT EXISTS \(\s*SELECT 1\s*FROM events AS carried_event/s);
    assert.match(
      frozenQuery,
      /\$\.evidenceWindowAction'\s*\)\s+IN \('unchanged', 'seal'\)/,
    );
    assert.match(frozenQuery, /FROM events AS duplicate_generation/);
  });

  it("lifecycle command store writes projections after service postwrites and before dedup", () => {
    const order: string[] = [];
    const connection = new TransactionConnection(false, order);
    const events = new FakeEvents(connection, order);
    const projectionWriter = recordingProjectionWriter((committed, current) => {
      order.push("projection append");
      assertDeeplyFrozen(committed);
      stage(current.authority, "projection");
    });
    const store = new LifecycleCommandStore({
      connection,
      events,
      projectionWriter,
      transaction: () => transaction(connection),
      now: () => NOW,
    });

    store.execute(envelope(), () => ({
      append: appendCommand(),
      authorizationRecord: authorization(),
      beforeAppend: () => {
        order.push("beforeAppend");
        return undefined;
      },
      afterAppend: (_committed, current) => {
        order.push("service afterAppend");
        stage(current.authority, "service");
      },
    }));

    assert.deepEqual(order, [
      "beforeAppend",
      "append",
      "service afterAppend",
      "projection append",
      "dedup",
      "commit",
    ]);
    assert.deepEqual(connection.committed, ["event", "service", "projection", "dedup"]);
  });

  it("exposes the semantic before-write fault boundary with identity context", () => {
    const connection = new TransactionConnection();
    const events = new FakeEvents(connection);
    const hits: LifecycleFaultContext[] = [];
    const store = new LifecycleCommandStore({
      connection,
      events,
      projectionWriter: recordingProjectionWriter(),
      transaction: () => transaction(connection),
      now: () => NOW,
      faultInjector: {
        hit(boundary, point, context): void {
          assert.equal(boundary, "event-append");
          assert.equal(point, "before-write");
          hits.push(context);
          throw new Error("fixture crash");
        },
      },
    });

    assert.throws(() => store.execute(envelope(), () => ({
      append: appendCommand(),
      authorizationRecord: authorization(),
      afterAppend: () => undefined,
    })), /fixture crash/);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.projectId, CONTEXT.binding.projectId);
    assert.equal(hits[0]?.commandId, SEMANTIC_COMMAND.commandId);
    assert.deepEqual(connection.committed, []);
    assert.deepEqual(connection.statements.slice(-2), ["BEGIN IMMEDIATE", "ROLLBACK"]);
  });

  it("lifecycle command replay performs no projection write", () => {
    const connection = new TransactionConnection();
    const events = new FakeEvents(connection);
    let projectionCalls = 0;
    const store = new LifecycleCommandStore({
      connection,
      events,
      projectionWriter: recordingProjectionWriter(() => {
        projectionCalls += 1;
      }),
      transaction: () => transaction(connection),
      now: () => NOW,
    });
    store.execute(envelope(), () => ({
      append: appendCommand(),
      authorizationRecord: authorization(),
      afterAppend: () => undefined,
    }));
    assert.equal(projectionCalls, 1);

    events.replay = replayResult();
    store.execute(envelope(), () => {
      throw new Error("replay must not enter fresh work");
    });
    assert.equal(projectionCalls, 1);
  });

  it("lifecycle projection failure rolls back events service state and dedup atomically", () => {
    const connection = new TransactionConnection();
    const events = new FakeEvents(connection);
    const store = new LifecycleCommandStore({
      connection,
      events,
      projectionWriter: recordingProjectionWriter((_committed, current) => {
        stage(current.authority, "projection");
        throw new LifecycleCommandStoreError("INTEGRITY_FAILURE");
      }),
      transaction: () => transaction(connection),
      now: () => NOW,
    });

    assert.throws(
      () => store.execute(envelope(), () => ({
        append: appendCommand(),
        authorizationRecord: authorization(),
        afterAppend: (_committed, current) => {
          stage(current.authority, "service");
        },
      })),
      (error: unknown) => error instanceof LifecycleCommandStoreError
        && error.code === "INTEGRITY_FAILURE",
    );
    assert.deepEqual(connection.committed, []);
    assert.equal(events.calls.includes("dedup"), false);
    assert.deepEqual(connection.statements.slice(-2), ["BEGIN IMMEDIATE", "ROLLBACK"]);
  });

  it("returns replay before window health provider or repository access", () => {
    const evidenceCommand: RecordEvidenceBatchCommandV2 = {
      commandType: "record-evidence-batch",
      commandId: SEMANTIC_COMMAND.commandId,
      idempotencyKey: SEMANTIC_COMMAND.idempotencyKey,
      agentId: SEMANTIC_COMMAND.agentId,
      expectedProjectId: CONTEXT.binding.projectId,
      expectedVaultId: CONTEXT.binding.vaultId,
      expectedWorkspaceId: CONTEXT.binding.workspaceId,
      expectedBranchRef: null,
      adapterSessionId: "00000000-0000-4000-8000-000000000030" as never,
      batchId: "00000000-0000-4000-8000-000000000031" as never,
      sessionId: SEMANTIC_COMMAND.sessionId as never,
      firstOrdinal: "0",
      lastOrdinal: "0",
      fingerprintSchemaVersion: 1,
      fingerprintKeyId: "evidence-key-1",
      fingerprintDomain: "pm-evidence-frame-v1",
      redactionStatus: "content-not-retained",
      frames: [{
        frameId: "00000000-0000-4000-8000-000000000032" as never,
        ordinal: "0",
        sourceKind: "tool-result",
        observedAt: NOW,
        contentFingerprint: "a".repeat(64),
      }],
    };
    const built = buildLifecycleIntentWitness(evidenceCommand, {
      ...INTENT_WITNESS.witness.persistedAssertions,
      targetSessionId: evidenceCommand.sessionId,
    });
    const evidenceEnvelope = envelope({
      commandType: evidenceCommand.commandType,
      semanticCommand: evidenceCommand,
      candidateIntentHash: built.intentHash,
      authoritativeIntentHash: built.intentHash,
    });
    const order: string[] = [];
    const connection = new TransactionConnection();
    const events = new FakeEvents(connection);
    const store = new LifecycleCommandStore({
      connection,
      events,
      projectionWriter: recordingProjectionWriter(),
      transaction: () => {
        const tx = transaction(connection);
        return {
          ...tx,
          coverage: {
            ...tx.coverage,
            assertEvidenceWindowWritable: () => { order.push("window"); },
            assertQuickHealthy: () => { order.push("health"); },
          },
        };
      },
      now: () => NOW,
    });

    store.execute(evidenceEnvelope, () => {
      order.push("callback");
      return {
        append: { ...appendCommand(), commandType: evidenceCommand.commandType },
        authorizationRecord: authorization(),
        afterAppend: () => undefined,
      };
    });
    assert.deepEqual(order, ["window", "health", "callback"]);

    events.replay = replayResult();
    order.length = 0;
    store.execute(evidenceEnvelope, () => {
      throw new Error("replay must not enter fresh work");
    });
    assert.deepEqual(order, []);
  });

  it("fails closed before a fresh non-evidence callback when quick health is absent", () => {
    const connection = new TransactionConnection();
    const events = new FakeEvents(connection);
    let callbackCalls = 0;
    const store = new LifecycleCommandStore({
      connection,
      events,
      projectionWriter: recordingProjectionWriter(),
      transaction: () => ({
        ...transaction(connection),
        coverage: {} as never,
      }),
      now: () => NOW,
    });

    assert.throws(
      () => store.execute(envelope(), () => {
        callbackCalls += 1;
        return {
          append: appendCommand(),
          authorizationRecord: authorization(),
          afterAppend: () => undefined,
        };
      }),
      (error: unknown) => error instanceof LifecycleCommandStoreError
        && error.code === "INTEGRITY_FAILURE",
    );
    assert.equal(callbackCalls, 0);
    assert.deepEqual(connection.committed, []);
  });

  it("skips quick health for a root start with no existing session", () => {
    const connection = new TransactionConnection();
    const events = new FakeEvents(connection);
    let healthCalls = 0;
    let callbackCalls = 0;
    const store = new LifecycleCommandStore({
      connection,
      events,
      projectionWriter: recordingProjectionWriter(),
      transaction: () => {
        const tx = transaction(connection);
        return {
          ...tx,
          coverage: {
            ...tx.coverage,
            assertQuickHealthy: () => { healthCalls += 1; },
          },
        };
      },
      now: () => NOW,
    });
    const rootStartEnvelope = envelope({
      commandType: "root-start",
      semanticCommand: {
        commandType: "root-start",
        commandId: SEMANTIC_COMMAND.commandId,
        idempotencyKey: SEMANTIC_COMMAND.idempotencyKey,
        agentId: SEMANTIC_COMMAND.agentId,
        expectedProjectId: CONTEXT.binding.projectId,
        expectedVaultId: CONTEXT.binding.vaultId,
        expectedWorkspaceId: CONTEXT.binding.workspaceId,
        expectedBranchRef: null,
        continuityKey: "new-root",
        resumePolicy: "new",
      } as never,
    });

    assert.throws(
      () => store.execute(rootStartEnvelope, () => {
        callbackCalls += 1;
        throw new Error("stop-after-fresh-gate");
      }),
      /stop-after-fresh-gate/,
    );
    assert.equal(healthCalls, 0);
    assert.equal(callbackCalls, 1);
  });

  it("quick-checks a callback-selected null-session resume root synchronously", () => {
    const selectedRootSessionId = "00000000-0000-4000-8000-000000000010";
    const semantic = {
      ...SEMANTIC_COMMAND,
      sessionId: null,
    } as RootResumeCommandV2;
    const witness = buildLifecycleIntentWitness(semantic, {
      ...INTENT_WITNESS.witness.persistedAssertions,
      targetSessionId: selectedRootSessionId,
    });
    const resumeEnvelope = envelope({
      semanticCommand: semantic,
      candidateIntentHash: witness.intentHash,
      authoritativeIntentHash: witness.intentHash,
    });
    const connection = new TransactionConnection();
    const events = new FakeEvents(connection);
    const order: string[] = [];
    const store = new LifecycleCommandStore({
      connection,
      events,
      projectionWriter: recordingProjectionWriter(),
      transaction: () => {
        const tx = transaction(connection);
        return {
          ...tx,
          coverage: {
            ...tx.coverage,
            assertQuickHealthy: (sessionIds: readonly string[]) => {
              order.push(`health/${sessionIds.join(",")}`);
            },
          },
        };
      },
      now: () => NOW,
    });

    store.execute(resumeEnvelope, (current) => {
      order.push("selected");
      current.coverage.registerAffectedExistingSessions([
        selectedRootSessionId as never,
      ]);
      order.push("semantic-mutation");
      return {
        append: appendCommand(),
        authorizationRecord: authorization(),
        afterAppend: () => undefined,
      };
    });

    assert.deepEqual(order, [
      "selected",
      `health/${selectedRootSessionId}`,
      "semantic-mutation",
    ]);
  });

  it("quick-checks a callback-registered existing descendant before semantic writes", () => {
    const descendantSessionId = "00000000-0000-4000-8000-000000000099";
    const connection = new TransactionConnection();
    const events = new FakeEvents(connection);
    const healthCalls: readonly string[][] = [];
    let semanticWrites = 0;
    const store = new LifecycleCommandStore({
      connection,
      events,
      projectionWriter: recordingProjectionWriter(),
      transaction: () => {
        const tx = transaction(connection);
        return {
          ...tx,
          coverage: {
            ...tx.coverage,
            assertQuickHealthy: (sessionIds: readonly string[]) => {
              (healthCalls as string[][]).push([...sessionIds]);
              if (sessionIds.includes(descendantSessionId)) {
                throw new LifecycleCommandStoreError("INTEGRITY_FAILURE");
              }
            },
          },
        };
      },
      now: () => NOW,
    });

    assert.throws(
      () => store.execute(envelope(), (current) => {
        (
          current.coverage as unknown as {
            registerAffectedExistingSessions(sessionIds: readonly string[]): void;
          }
        ).registerAffectedExistingSessions([descendantSessionId]);
        semanticWrites += 1;
        return {
          append: appendCommand(),
          authorizationRecord: authorization(),
          afterAppend: () => undefined,
        };
      }),
      (error: unknown) => error instanceof LifecycleCommandStoreError
        && error.code === "INTEGRITY_FAILURE",
    );
    assert.deepEqual(healthCalls, [
      [SEMANTIC_COMMAND.sessionId],
      [descendantSessionId],
    ]);
    assert.equal(semanticWrites, 0);
    assert.deepEqual(connection.committed, []);
  });

  it("requires claim-transfer callbacks to register the discovered source child", () => {
    const sourceChildSessionId = "00000000-0000-4000-8000-000000000098";
    const claimedChildSessionId = "00000000-0000-4000-8000-000000000099";
    const semantic: ClaimChildTransferCommandV2 = {
      commandType: "claim-child-transfer",
      commandId: SEMANTIC_COMMAND.commandId,
      idempotencyKey: SEMANTIC_COMMAND.idempotencyKey,
      agentId: SEMANTIC_COMMAND.agentId,
      expectedProjectId: CONTEXT.binding.projectId,
      expectedVaultId: CONTEXT.binding.vaultId,
      expectedWorkspaceId: CONTEXT.binding.workspaceId,
      expectedBranchRef: null,
      rootSessionId: SEMANTIC_COMMAND.sessionId,
      transferTicketId: "00000000-0000-4000-8000-000000000097",
      expectedStreamVersion: "1",
    } as ClaimChildTransferCommandV2;
    const witness = buildLifecycleIntentWitness(semantic, {
      ...INTENT_WITNESS.witness.persistedAssertions,
      targetSessionId: semantic.rootSessionId,
    });
    const claimEnvelope = envelope({
      commandType: semantic.commandType,
      semanticCommand: semantic,
      candidateIntentHash: witness.intentHash,
      authoritativeIntentHash: witness.intentHash,
    });
    const pending = (
      eventType: "SessionForked" | "ChildWorkTransferClaimed",
      payload: JsonValue,
    ) => ({
      eventType,
      eventSchemaVersion: 1,
      occurredAt: NOW,
      visibilityScope: "session" as const,
      sessionId: claimedChildSessionId,
      parentSessionId: semantic.rootSessionId,
      confidence: "high" as const,
      verificationStatus: "verified" as const,
      payload,
      sourceRefs: [],
      evidenceRefs: [],
      evidenceDigests: [],
    });
    const append = {
      ...appendCommand(),
      commandType: semantic.commandType,
      expectedStreamVersion: 0n,
      streamId: `session/${claimedChildSessionId}`,
      events: [
        pending("SessionForked", { parentSessionId: semantic.rootSessionId }),
        pending("ChildWorkTransferClaimed", { previousChildSessionId: sourceChildSessionId }),
      ],
    };

    const connection = new TransactionConnection();
    const events = new FakeEvents(connection);
    const store = new LifecycleCommandStore({
      connection,
      events,
      projectionWriter: recordingProjectionWriter(),
      transaction: () => transaction(connection),
      now: () => NOW,
    });
    assert.throws(
      () => store.execute(claimEnvelope, () => ({
        append,
        authorizationRecord: authorization(),
        afterAppend: () => undefined,
      })),
      (error: unknown) => error instanceof LifecycleCommandStoreError
        && error.code === "INTEGRITY_FAILURE",
    );
    assert.equal(events.calls.includes("prepare"), false);

    const registered = store.execute(claimEnvelope, (current) => {
      current.coverage.registerAffectedExistingSessions([
        sourceChildSessionId as never,
      ]);
      return {
        append,
        authorizationRecord: authorization(),
        afterAppend: () => undefined,
      };
    });
    assert.equal(registered.deduplicated, false);
  });

  it("constructs typed store errors without redefining the base sanitized details", () => {
    const error = new LifecycleCommandStoreError("COMMAND_OUTCOME_UNKNOWN", {
      commandId: SEMANTIC_COMMAND.commandId,
      idempotencyKey: SEMANTIC_COMMAND.idempotencyKey,
    });
    assert.equal(error.code, "COMMAND_OUTCOME_UNKNOWN");
    assert.deepEqual(error.details, {
      commandId: SEMANTIC_COMMAND.commandId,
      idempotencyKey: SEMANTIC_COMMAND.idempotencyKey,
    });
    assert.equal(Object.isFrozen(error.details), true);
    assert.equal(Object.prototype.propertyIsEnumerable.call(error, "details"), false);
  });

  it("derives stable internal planned-work IDs from exact domain-separated identities", () => {
    const validation = {
      workflowId: "00000000-0000-4000-8000-000000000020",
      workflowGeneration: 3n,
      resultId: "00000000-0000-4000-8000-000000000021",
      commandId: "00000000-0000-4000-8000-000000000022",
      idempotencyKey: "validation:3:result",
    };
    const validationMaterial = {
      workflowId: validation.workflowId,
      workflowGeneration: "3",
      resultId: validation.resultId,
      commandId: validation.commandId,
      idempotencyKey: validation.idempotencyKey,
    };
    const expectedValidation = createHash("sha256")
      .update(`pm-lifecycle-internal-validation-work-v1\n${canonicalJson(validationMaterial)}`, "utf8")
      .digest("hex");
    assert.equal(internalValidationPlannedWorkId(validation), expectedValidation);
    assert.notEqual(internalValidationPlannedWorkId({
      ...validation,
      resultId: "00000000-0000-4000-8000-000000000023",
    }), expectedValidation);

    const phase = {
      workflowId: validation.workflowId,
      workflowGeneration: 3n,
      sourcePhase: "validate",
      action: "record-result",
      commandId: validation.commandId,
      idempotencyKey: "phase:3:record-result",
    };
    const phaseMaterial = {
      workflowId: phase.workflowId,
      workflowGeneration: "3",
      sourcePhase: phase.sourcePhase,
      action: phase.action,
      commandId: phase.commandId,
      idempotencyKey: phase.idempotencyKey,
    };
    const expectedPhase = createHash("sha256")
      .update(`pm-lifecycle-internal-phase-work-v1\n${canonicalJson(phaseMaterial)}`, "utf8")
      .digest("hex");
    assert.equal(internalPhasePlannedWorkId(phase), expectedPhase);
  });
  it("rejects a candidate/authoritative intent mismatch before opening SQLite", () => {
    const connection = new TransactionConnection();
    const events = new FakeEvents(connection);
    const store = new LifecycleCommandStore({
      connection,
      events,
      projectionWriter: recordingProjectionWriter(),
      transaction: () => transaction(connection),
      now: () => NOW,
    });

    assert.throws(
      () => store.execute(envelope({ authoritativeIntentHash: "b".repeat(64) }), () => {
        throw new Error("must not run");
      }),
      (error: unknown) => error instanceof LifecycleCommandStoreError
        && error.code === "IDEMPOTENCY_CONFLICT",
    );
    assert.deepEqual(connection.statements, []);
    assert.deepEqual(events.calls, []);
  });

  it("rejects callback-owned lifecycle intent witnesses before event preparation", () => {
    const connection = new TransactionConnection();
    const events = new FakeEvents(connection);
    const store = new LifecycleCommandStore({
      connection,
      events,
      projectionWriter: recordingProjectionWriter(),
      transaction: () => transaction(connection),
      now: () => NOW,
    });

    assert.throws(
      () => store.execute(envelope(), () => ({
        append: {
          ...appendCommand(),
          lifecycleIntentWitness: INTENT_WITNESS.source,
        } as unknown as PreparedLifecycleCommit<JsonValue>["append"],
        authorizationRecord: authorization(),
        afterAppend: () => undefined,
      })),
      (error: unknown) => error instanceof LifecycleCommandStoreError
        && error.code === "LIFECYCLE_INPUT_INVALID",
    );
    assert.equal(events.calls.includes("prepare"), false);
    assert.deepEqual(connection.statements.at(-1), "ROLLBACK");
  });

  it("returns exact replay before fresh authority work and reports advisory staleness", () => {
    const connection = new TransactionConnection();
    const events = new FakeEvents(connection);
    events.replay = replayResult();
    const store = new LifecycleCommandStore({
      connection,
      events,
      projectionWriter: recordingProjectionWriter(),
      transaction: () => {
        assert.deepEqual(events.calls, ["find-replay"]);
        return transaction(connection);
      },
      now: () => NOW,
      authorityMaterialStatus: () => {
        assert.deepEqual(connection.statements, ["BEGIN IMMEDIATE"]);
        return "stale";
      },
    });
    let freshCalls = 0;

    const result = store.execute(envelope(), () => {
      freshCalls += 1;
      throw new Error("fresh path must not run");
    });

    assert.equal(result.deduplicated, true);
    assert.deepEqual(result.publicResult, { eventPosition: "2" });
    assert.equal(result.authorityMaterialStatus, "stale");
    assert.equal(freshCalls, 0);
    assert.deepEqual(events.calls, ["find-replay"]);
    assert.deepEqual(connection.statements, ["BEGIN IMMEDIATE", "ROLLBACK"]);
  });

  it("replays an exact Version 1 command but rejects same-identity nested Version 2 reuse", () => {
    const version1 = recordCheckpointCommand(1);
    const version2 = recordCheckpointCommand(2);
    const version1Intent = checkpointIntent(version1);
    const version2Intent = checkpointIntent(version2);
    assert.notEqual(version1Intent.intentHash, version2Intent.intentHash);

    const connection = new TransactionConnection();
    const events = new PersistedIntentReplayEvents(connection);
    const store = new LifecycleCommandStore({
      connection,
      events,
      projectionWriter: recordingProjectionWriter(),
      transaction: () => transaction(connection),
      now: () => NOW,
    });
    const version1Envelope = envelope({
      commandType: version1.commandType,
      candidateIntentHash: version1Intent.intentHash,
      authoritativeIntentHash: version1Intent.intentHash,
      semanticCommand: version1,
    });
    const committed = store.execute(version1Envelope, () => ({
      append: { ...appendCommand(), commandType: version1.commandType },
      authorizationRecord: authorization(),
      afterAppend: () => undefined,
    }));
    assert.equal(committed.deduplicated, false);

    let replayFreshCalls = 0;
    const replayed = store.execute(version1Envelope, () => {
      replayFreshCalls += 1;
      throw new Error("exact Version 1 replay must not enter the fresh path");
    });
    assert.equal(replayed.deduplicated, true);
    assert.equal(replayFreshCalls, 0);

    const callsBeforeConflict = [...events.calls];
    const statementsBeforeConflict = [...connection.statements];
    let conflictFreshCalls = 0;
    assert.throws(
      () => store.execute(envelope({
        commandType: version2.commandType,
        candidateIntentHash: version2Intent.intentHash,
        authoritativeIntentHash: version2Intent.intentHash,
        semanticCommand: version2,
      }), () => {
        conflictFreshCalls += 1;
        throw new Error("cross-version reuse must fail before fresh work");
      }),
      (error: unknown) => error instanceof LifecycleCommandStoreError
        && error.code === "IDEMPOTENCY_CONFLICT",
    );
    assert.equal(conflictFreshCalls, 0);
    assert.deepEqual(events.calls, [...callsBeforeConflict, "find-replay"]);
    assert.deepEqual(connection.statements, [
      ...statementsBeforeConflict,
      "BEGIN IMMEDIATE",
      "ROLLBACK",
    ]);
  });

  it("deduplicates before resolving a fresh protected capability generation", () => {
    const replayConnection = new TransactionConnection();
    const replayEvents = new FakeEvents(replayConnection);
    replayEvents.replay = replayResult();
    let replayTransactionFactoryCalls = 0;
    const replayStore = new LifecycleCommandStore({
      connection: replayConnection,
      events: replayEvents,
      projectionWriter: recordingProjectionWriter(),
      transaction: () => {
        replayTransactionFactoryCalls += 1;
        return transaction(replayConnection);
      },
      now: () => NOW,
    });
    const deferredEnvelope = {
      ...envelope(),
      capabilityGeneration: null,
      capabilityGenerationResolution: "fresh-commit",
    } as unknown as LifecycleCommandEnvelope;
    let replayFreshCalls = 0;

    const replayed = replayStore.execute(deferredEnvelope, () => {
      replayFreshCalls += 1;
      throw new Error("replay must not resolve current authority generation");
    });

    assert.equal(replayed.deduplicated, true);
    assert.equal(replayFreshCalls, 0);
    assert.equal(replayTransactionFactoryCalls, 0);
    assert.deepEqual(replayEvents.calls, ["find-replay"]);

    const freshConnection = new TransactionConnection();
    const freshEvents = new FakeEvents(freshConnection);
    const freshStore = new LifecycleCommandStore({
      connection: freshConnection,
      events: freshEvents,
      projectionWriter: recordingProjectionWriter(),
      transaction: () => transaction(freshConnection),
      now: () => NOW,
    });
    let generationResolvedInsideFreshCallback = false;

    const fresh = freshStore.execute(deferredEnvelope, () => {
      generationResolvedInsideFreshCallback = true;
      return {
        append: appendCommand(),
        authorizationRecord: authorization(),
        freshCapabilityGeneration: "1",
        afterAppend: () => undefined,
      } as unknown as PreparedLifecycleCommit<JsonValue>;
    });

    assert.equal(fresh.deduplicated, false);
    assert.equal(generationResolvedInsideFreshCallback, true);
    assert.deepEqual(freshConnection.committed, ["event", "dedup"]);
  });

  it("commits event and focused repository effects in one semantic transaction", () => {
    const connection = new TransactionConnection();
    const events = new FakeEvents(connection);
    const tx = transaction(connection);
    const store = new LifecycleCommandStore({
      connection,
      events,
      projectionWriter: recordingProjectionWriter(),
      transaction: () => tx,
      now: () => NOW,
      authorityMaterialStatus: () => "current",
    });

    const result = store.execute(envelope(), (received) => {
      assert.notEqual(received, tx);
      stage(received.authority, "authority");
      stage(received.leases, "lease");
      return {
        append: appendCommand(),
        authorizationRecord: authorization(),
        beforeAppend: (_planned, current) => {
          stage(current.approvals, "approval");
          return undefined;
        },
        afterAppend: (_committed, current) => {
          stage(current.workflows, "workflow");
          stage(current.outbox, "outbox");
        },
      };
    });

    assert.equal(result.deduplicated, false);
    assert.deepEqual(result.publicResult, { eventPosition: "2" });
    assert.deepEqual(connection.statements, ["BEGIN IMMEDIATE", "COMMIT"]);
    assert.deepEqual(connection.committed, [
      "authority", "lease", "approval", "event", "workflow", "outbox", "dedup",
    ]);
    assert.deepEqual(events.calls, [
      "find-replay", "assert-command-id", "assert-maintenance", "prepare", "plan", "append", "dedup",
    ]);
  });

  it("projects only declared command facades from the transaction factory", () => {
    const connection = new TransactionConnection();
    const events = new FakeEvents(connection);
    const raw = Object.assign(transaction(connection), { connection, arbitrarySql: () => undefined });
    const store = new LifecycleCommandStore({
      connection,
      events,
      projectionWriter: recordingProjectionWriter(),
      transaction: () => raw,
      now: () => NOW,
    });

    store.execute(envelope(), (received) => {
      assert.equal("connection" in received, false);
      assert.equal("arbitrarySql" in received, false);
      assert.equal((received as unknown as { connection?: unknown }).connection, undefined);
      return {
        append: appendCommand(),
        authorizationRecord: authorization(),
        afterAppend: () => undefined,
      };
    });
  });

  it("rejects a beforeAppend PromiseLike before append or commit", () => {
    const connection = new TransactionConnection();
    const events = new FakeEvents(connection);
    const store = new LifecycleCommandStore({
      connection,
      events,
      projectionWriter: recordingProjectionWriter(),
      transaction: () => transaction(connection),
      now: () => NOW,
    });

    assert.throws(
      () => store.execute(envelope(), () => ({
        append: appendCommand(),
        authorizationRecord: authorization(),
        beforeAppend: (() => ({ then() { /* PromiseLike escape */ } })) as unknown as (
          planned: PlannedEventAppend<JsonValue>,
          transaction: LifecycleCommandTransaction,
        ) => undefined,
        afterAppend: () => undefined,
      })),
      (error: unknown) => error instanceof LifecycleCommandStoreError
        && error.code === "LIFECYCLE_INPUT_INVALID",
    );
    assert.deepEqual(connection.statements, ["BEGIN IMMEDIATE", "ROLLBACK"]);
    assert.doesNotMatch(events.calls.join(","), /append|dedup/);
  });

  it("rejects an onNew PromiseLike before preparing, appending, or committing", () => {
    const connection = new TransactionConnection();
    const events = new FakeEvents(connection);
    const store = new LifecycleCommandStore({
      connection,
      events,
      projectionWriter: recordingProjectionWriter(),
      transaction: () => transaction(connection),
      now: () => NOW,
    });
    const thenable = { then() { /* synchronous escape */ } };
    const onNew = (() => thenable) as unknown as (
      transaction: LifecycleCommandTransaction,
    ) => PreparedLifecycleCommit<JsonValue>;

    assert.throws(() => store.execute(envelope(), onNew), isLifecycleInputInvalid);
    assert.deepEqual(connection.statements, ["BEGIN IMMEDIATE", "ROLLBACK"]);
    assert.doesNotMatch(events.calls.join(","), /prepare|plan|append|dedup/);
  });

  it("rejects an afterAppend PromiseLike before dedup or commit", () => {
    const connection = new TransactionConnection();
    const events = new FakeEvents(connection);
    const store = new LifecycleCommandStore({
      connection,
      events,
      projectionWriter: recordingProjectionWriter(),
      transaction: () => transaction(connection),
      now: () => NOW,
    });

    assert.throws(
      () => store.execute(envelope(), () => ({
        append: appendCommand(),
        authorizationRecord: authorization(),
        afterAppend: (() => ({ then() { /* PromiseLike escape */ } })) as unknown as (
          committed: EventAppendBatch<JsonValue>,
          transaction: LifecycleCommandTransaction,
        ) => undefined,
      })),
      isLifecycleInputInvalid,
    );
    assert.deepEqual(connection.statements, ["BEGIN IMMEDIATE", "ROLLBACK"]);
    assert.match(events.calls.join(","), /append/);
    assert.doesNotMatch(events.calls.join(","), /dedup/);
    assert.deepEqual(connection.committed, []);
  });

  it("revokes facades and captured method references when onNew exits", () => {
    const connection = new TransactionConnection();
    const events = new FakeEvents(connection);
    const store = new LifecycleCommandStore({
      connection,
      events,
      projectionWriter: recordingProjectionWriter(),
      transaction: () => transaction(connection),
      now: () => NOW,
    });
    let capturedFacade: StagingFacade | undefined;
    let capturedMethod: StagingFacade["stage"] | undefined;

    store.execute(envelope(), (tx) => {
      capturedFacade = tx.authority as StagingFacade;
      capturedMethod = capturedFacade.stage;
      return {
        append: appendCommand(),
        authorizationRecord: authorization(),
        beforeAppend: () => {
          assert.throws(() => capturedFacade!.stage("late-on-new-facade"), isLifecycleInputInvalid);
          assert.throws(() => capturedMethod!("late-on-new-method"), isLifecycleInputInvalid);
        },
        afterAppend: () => undefined,
      };
    });

    assert.deepEqual(connection.committed, ["event", "dedup"]);
  });

  it("revokes facades and captured method references when beforeAppend exits", () => {
    const connection = new TransactionConnection();
    const events = new FakeEvents(connection);
    const store = new LifecycleCommandStore({
      connection,
      events,
      projectionWriter: recordingProjectionWriter(),
      transaction: () => transaction(connection),
      now: () => NOW,
    });
    let capturedFacade: StagingFacade | undefined;
    let capturedMethod: StagingFacade["stage"] | undefined;

    store.execute(envelope(), () => ({
      append: appendCommand(),
      authorizationRecord: authorization(),
      beforeAppend: (_planned, tx) => {
        capturedFacade = tx.approvals as StagingFacade;
        capturedMethod = capturedFacade.stage;
      },
      afterAppend: () => {
        assert.throws(() => capturedFacade!.stage("late-before-facade"), isLifecycleInputInvalid);
        assert.throws(() => capturedMethod!("late-before-method"), isLifecycleInputInvalid);
      },
    }));

    assert.deepEqual(connection.committed, ["event", "dedup"]);
  });

  it("revokes facades and captured method references when afterAppend exits", () => {
    const connection = new TransactionConnection();
    const events = new FakeEvents(connection);
    const store = new LifecycleCommandStore({
      connection,
      events,
      projectionWriter: recordingProjectionWriter(),
      transaction: () => transaction(connection),
      now: () => NOW,
    });
    let capturedFacade: StagingFacade | undefined;
    let capturedMethod: StagingFacade["stage"] | undefined;

    store.execute(envelope(), () => ({
      append: appendCommand(),
      authorizationRecord: authorization(),
      afterAppend: (_committed, tx) => {
        capturedFacade = tx.workflows as StagingFacade;
        capturedMethod = capturedFacade.stage;
      },
    }));

    assert.throws(() => capturedFacade!.stage("post-commit-facade"), isLifecycleInputInvalid);
    assert.throws(() => capturedMethod!("post-commit-method"), isLifecycleInputInvalid);
    assert.deepEqual(connection.committed, ["event", "dedup"]);
  });

  it("guards object-valued method results so explicit self returns cannot expose a raw facade", () => {
    const connection = new TransactionConnection();
    const events = new FakeEvents(connection);
    const tx = transaction(connection);
    (tx.authority as StagingFacade & { returnSelf?: () => StagingFacade }).returnSelf =
      function(this: StagingFacade) { return this; };
    const store = new LifecycleCommandStore({
      connection,
      events,
      projectionWriter: recordingProjectionWriter(),
      transaction: () => tx,
      now: () => NOW,
    });
    let escapedAuthority: StagingFacade | undefined;

    store.execute(envelope(), (received) => {
      escapedAuthority = (
        received.authority as StagingFacade & { returnSelf(): StagingFacade }
      ).returnSelf();
      return {
        append: appendCommand(),
        authorizationRecord: authorization(),
        afterAppend: () => undefined,
      };
    });

    assert.throws(() => escapedAuthority!.stage("escaped-authority"), isLifecycleInputInvalid);
  });

  it("blocks inherited accessor mutators from leaking the raw command repository", () => {
    const connection = new TransactionConnection();
    const events = new FakeEvents(connection);
    const store = new LifecycleCommandStore({
      connection,
      events,
      projectionWriter: recordingProjectionWriter(),
      transaction: () => transaction(connection),
      now: () => NOW,
    });
    let leaked: StagingFacade | undefined;

    assert.throws(
      () => store.execute(envelope(), (tx) => {
        const facade = tx.authority as unknown as {
          __defineGetter__(property: string, getter: () => unknown): void;
          readonly leak: unknown;
        };
        facade.__defineGetter__("leak", function(this: StagingFacade) {
          leaked = this;
          return 1;
        });
        void facade.leak;
        return {
          append: appendCommand(),
          authorizationRecord: authorization(),
          afterAppend: () => undefined,
        };
      }),
      isLifecycleInputInvalid,
    );
    assert.equal(leaked, undefined);
    assert.deepEqual(connection.statements, ["BEGIN IMMEDIATE", "ROLLBACK"]);
  });

  it("rejects a Promise returned by a connection-bound facade method", () => {
    const connection = new TransactionConnection();
    const events = new FakeEvents(connection);
    const tx = transaction(connection);
    (tx.authority as { readLater?: () => Promise<PersistedLifecycleAuthorizationRecord> }).readLater =
      () => Promise.resolve(authorization());
    const store = new LifecycleCommandStore({
      connection,
      events,
      projectionWriter: recordingProjectionWriter(),
      transaction: () => tx,
      now: () => NOW,
    });

    assert.throws(
      () => store.execute(envelope(), (received) => {
        void (received.authority as { readLater(): Promise<unknown> }).readLater();
        return {
          append: appendCommand(),
          authorizationRecord: authorization(),
          afterAppend: () => undefined,
        };
      }),
      isLifecycleInputInvalid,
    );
    assert.deepEqual(connection.statements, ["BEGIN IMMEDIATE", "ROLLBACK"]);
  });

  it("snapshots a plain authorization DTO returned by a guarded facade method", () => {
    const connection = new TransactionConnection();
    const events = new FakeEvents(connection);
    const tx = transaction(connection);
    const expected = authorization();
    (tx.authority as { readCurrent?: () => PersistedLifecycleAuthorizationRecord }).readCurrent =
      () => expected;
    const store = new LifecycleCommandStore({
      connection,
      events,
      projectionWriter: recordingProjectionWriter(),
      transaction: () => tx,
      now: () => NOW,
    });

    const result = store.execute(envelope(), (received) => ({
      append: appendCommand(),
      authorizationRecord: (
        received.authority as { readCurrent(): PersistedLifecycleAuthorizationRecord }
      ).readCurrent(),
      afterAppend: () => undefined,
    }));

    assert.deepEqual(result.authorizationRecord, expected);
    assertDeeplyFrozen(result.authorizationRecord);
  });

  it("evaluates authority material status synchronously inside the transaction", () => {
    const connection = new TransactionConnection();
    const events = new FakeEvents(connection);
    const store = new LifecycleCommandStore({
      connection,
      events,
      projectionWriter: recordingProjectionWriter(),
      transaction: () => transaction(connection),
      now: () => NOW,
      authorityMaterialStatus: () => {
        assert.deepEqual(connection.statements, ["BEGIN IMMEDIATE"]);
        return "current";
      },
    });

    const result = store.execute(envelope(), () => ({
      append: appendCommand(),
      authorizationRecord: authorization(),
      afterAppend: () => undefined,
    }));

    assert.equal(result.authorityMaterialStatus, "current");
    assert.deepEqual(connection.statements, ["BEGIN IMMEDIATE", "COMMIT"]);
  });

  it("rejects a PromiseLike authority material status before commit", () => {
    const connection = new TransactionConnection();
    const events = new FakeEvents(connection);
    const store = new LifecycleCommandStore({
      connection,
      events,
      projectionWriter: recordingProjectionWriter(),
      transaction: () => transaction(connection),
      now: () => NOW,
      authorityMaterialStatus: (() => ({ then() { /* PromiseLike escape */ } })) as unknown as (
        authorization: PersistedLifecycleAuthorizationRecord,
      ) => "current",
    });

    assert.throws(
      () => store.execute(envelope(), () => ({
        append: appendCommand(),
        authorizationRecord: authorization(),
        afterAppend: () => undefined,
      })),
      isLifecycleInputInvalid,
    );
    assert.deepEqual(connection.statements, ["BEGIN IMMEDIATE", "ROLLBACK"]);
    assert.deepEqual(connection.committed, []);
  });

  it("snapshots protected authorization before external aliases mutate proof and approval", () => {
    const connection = new TransactionConnection();
    const events = new FakeEvents(connection);
    const store = new LifecycleCommandStore({
      connection,
      events,
      projectionWriter: recordingProjectionWriter(),
      transaction: () => transaction(connection),
      now: () => NOW,
    });
    const original: Extract<PersistedLifecycleAuthorizationRecord, { kind: "protected" }> = {
      kind: "protected",
      proof: {
        version: 1,
        nonce: "00000000-0000-4000-8000-000000000001",
        digest: "1".repeat(64),
      },
      approval: {
        approvalId: "00000000-0000-4000-8000-000000000030",
        digest: "2".repeat(64),
      },
      authorizationSessionId: "00000000-0000-4000-8000-000000000010",
      targetSessionId: "00000000-0000-4000-8000-000000000010",
      presenting: principal("primary-a"),
      target: principal("primary-a"),
    };
    const expected = structuredClone(original);
    const replayExpectation = structuredClone(original);

    const result = store.execute(envelope({ replayExpectation }), () => ({
      append: appendCommand(),
      authorizationRecord: original,
      beforeAppend: () => {
        original.proof!.digest = "8".repeat(64);
        original.approval!.digest = "9".repeat(64);
        original.presenting.clientInstanceId = "mutated-presenter";
      },
      afterAppend: () => undefined,
    }));

    assert.notDeepEqual(original, expected);
    assert.deepEqual(events.insertedAuthorizations, [expected]);
    assert.deepEqual(result.authorizationRecord, expected);
    assert.equal(result.authorizationRecord, events.insertedAuthorizations[0]);
    assertDeeplyFrozen(result.authorizationRecord);
  });

  it("snapshots complete internal authorization before claim aliases mutate", () => {
    const connection = new TransactionConnection();
    const events = new FakeEvents(connection);
    const store = new LifecycleCommandStore({
      connection,
      events,
      projectionWriter: recordingProjectionWriter(),
      transaction: () => transaction(connection),
      now: () => NOW,
    });
    const original: Extract<PersistedLifecycleAuthorizationRecord, { kind: "internal-workflow" }> = {
      kind: "internal-workflow",
      workflowId: "00000000-0000-4000-8000-000000000020",
      workflowGeneration: 3n,
      plannedWorkId: "3".repeat(64),
      claimOwnerId: "00000000-0000-4000-8000-000000000030",
      claimToken: 7n,
      authorizationSessionId: "00000000-0000-4000-8000-000000000010",
      targetSessionId: "00000000-0000-4000-8000-000000000010",
      presenting: principal("primary-a"),
      target: principal("primary-a"),
    };
    const expected = structuredClone(original);
    const replayExpectation: LifecycleReplayExpectation = {
      kind: "internal-workflow",
      workflowId: original.workflowId as InternalWorkflowPhaseCommand["workflowId"],
      workflowGeneration: original.workflowGeneration,
      plannedWorkId: original.plannedWorkId,
      authorizationSessionId: original.authorizationSessionId,
      targetSessionId: original.targetSessionId,
      presenting: structuredClone(original.presenting),
      target: structuredClone(original.target),
    };
    const semanticCommand: InternalWorkflowPhaseCommand = {
      commandType: "internal-workflow-phase",
      commandId: "00000000-0000-4000-8000-000000000100",
      idempotencyKey: "lifecycle:test:100",
      agentId: "agent",
      expectedProjectId: CONTEXT.binding.projectId,
      expectedVaultId: CONTEXT.binding.vaultId,
      expectedWorkspaceId: CONTEXT.binding.workspaceId,
      expectedBranchRef: null,
      workflowId: original.workflowId as InternalWorkflowPhaseCommand["workflowId"],
      workflowGeneration: Number(original.workflowGeneration),
      plannedWorkId: original.plannedWorkId,
      sourcePhase: "validate",
      claim: {
        workflowId: original.workflowId as InternalWorkflowPhaseCommand["workflowId"],
        workflowGeneration: Number(original.workflowGeneration),
        claimOwnerId: original.claimOwnerId,
        claimToken: original.claimToken.toString(),
        claimExpiresAt: "2026-07-14T00:10:00.000Z",
      },
      action: {
        action: "invalidate-verification",
        safeFailureCode: "SESSION_SOURCE_STATE_CONFLICT",
      },
    };
    const intent = buildLifecycleIntentWitness(semanticCommand, {
      authorizationKind: "internal-workflow",
      authorizationSessionId: original.authorizationSessionId,
      targetSessionId: original.targetSessionId,
      projectId: CONTEXT.binding.projectId,
      vaultId: CONTEXT.binding.vaultId,
      storeId: CONTEXT.binding.storeId,
      workspaceId: CONTEXT.binding.workspaceId,
      clientNamespace: CONTEXT.binding.clientNamespace,
      capabilityKind: null,
      capabilityGeneration: null,
      presentingActorRole: original.presenting.actorRole,
      presentingClientInstanceId: original.presenting.clientInstanceId,
      targetActorRole: original.target.actorRole,
      targetClientInstanceId: original.target.clientInstanceId,
      internalWorkflowId: original.workflowId,
      internalWorkflowGeneration: Number(original.workflowGeneration),
      internalPlannedWorkId: original.plannedWorkId,
    });

    const result = store.execute(envelope({
      commandType: "internal-workflow-phase",
      candidateIntentHash: intent.intentHash,
      authoritativeIntentHash: intent.intentHash,
      semanticCommand,
      capabilityKind: null,
      capabilityGeneration: null,
      replayExpectation,
    }), () => ({
      append: { ...appendCommand(), commandType: "internal-workflow-phase" },
      authorizationRecord: original,
      beforeAppend: () => {
        original.claimOwnerId = "attacker";
        original.claimToken = 999n;
        original.target.clientInstanceId = "mutated-target";
      },
      afterAppend: () => undefined,
    }));

    assert.notDeepEqual(original, expected);
    assert.deepEqual(events.insertedAuthorizations, [expected]);
    assert.deepEqual(result.authorizationRecord, expected);
    assert.equal(result.authorizationRecord, events.insertedAuthorizations[0]);
    assertDeeplyFrozen(result.authorizationRecord);
  });

  it("rolls back all staged effects when the semantic callback fails", () => {
    const connection = new TransactionConnection();
    const events = new FakeEvents(connection);
    const store = new LifecycleCommandStore({
      connection,
      events,
      projectionWriter: recordingProjectionWriter(),
      transaction: () => transaction(connection),
      now: () => NOW,
    });

    assert.throws(() => store.execute(envelope(), (tx) => {
      stage(tx.authority, "authority");
      throw new Error("injected");
    }), /injected/);
    assert.deepEqual(connection.statements, ["BEGIN IMMEDIATE", "ROLLBACK"]);
    assert.deepEqual(connection.committed, []);
  });

  it("rejects a committed batch whose positions drift from the private plan", () => {
    const connection = new TransactionConnection();
    const events = new DriftedCommitEvents(connection);
    const store = new LifecycleCommandStore({
      connection,
      events,
      projectionWriter: recordingProjectionWriter(),
      transaction: () => transaction(connection),
      now: () => NOW,
    });

    assert.throws(
      () => store.execute(envelope(), () => ({
        append: appendCommand(),
        authorizationRecord: authorization(),
        afterAppend: () => undefined,
      })),
      (error: unknown) => error instanceof LifecycleCommandStoreError
        && error.code === "INTEGRITY_FAILURE",
    );
    assert.deepEqual(connection.statements, ["BEGIN IMMEDIATE", "ROLLBACK"]);
    assert.deepEqual(connection.committed, []);
  });

  it("rejects a beforeAppend mutation of the planned nested response snapshot", () => {
    const connection = new TransactionConnection();
    const events = new FakeEvents(connection);
    const store = new LifecycleCommandStore({
      connection,
      events,
      projectionWriter: recordingProjectionWriter(),
      transaction: () => transaction(connection),
      now: () => NOW,
    });

    assert.throws(
      () => store.execute(envelope(), () => ({
        append: appendCommand(),
        authorizationRecord: authorization(),
        beforeAppend: (planned) => {
          (planned.storedResponse.response as { eventPosition: string }).eventPosition = "999";
        },
        afterAppend: () => undefined,
      })),
    );
    assert.deepEqual(connection.statements, ["BEGIN IMMEDIATE", "ROLLBACK"]);
    assert.deepEqual(connection.committed, []);
    assert.doesNotMatch(events.calls.join(","), /dedup/);
  });

  const hookMutations: ReadonlyArray<readonly [
    name: string,
    mutate: (batch: EventAppendBatch<JsonValue>) => void,
  ]> = [
    ["event identity", (batch) => {
      (batch.events[0] as { globalPosition: bigint; eventHash: string }).globalPosition = 99n;
      (batch.events[0] as { eventHash: string }).eventHash = "9".repeat(64);
    }],
    ["nested payload", (batch) => {
      const payload = batch.events[0]!.payload as { nested: { accepted: boolean } };
      payload.nested.accepted = false;
    }],
    ["nested response", (batch) => {
      const response = batch.storedResponse.response as { nested: { eventPosition: string } };
      response.nested.eventPosition = "999";
    }],
  ];

  for (const [name, mutate] of hookMutations) {
    for (const hook of ["beforeAppend", "afterAppend"] as const) {
      it(`fails closed when ${hook} casts mutate ${name}`, () => {
        const connection = new TransactionConnection();
        const events = new MutableNestedBatchEvents(connection);
        const store = new LifecycleCommandStore({
          connection,
          events,
          projectionWriter: recordingProjectionWriter(),
          transaction: () => transaction(connection),
          now: () => NOW,
        });
        const beforeAppend = hook === "beforeAppend"
          ? (planned: PlannedEventAppend<JsonValue>) => {
            mutate(planned);
            return undefined;
          }
          : undefined;
        const afterAppend = hook === "afterAppend"
          ? (committed: EventAppendBatch<JsonValue>) => {
            mutate(committed);
            return undefined;
          }
          : () => undefined;

        assert.throws(() => store.execute(envelope(), () => ({
          append: appendCommand(),
          authorizationRecord: authorization(),
          beforeAppend,
          afterAppend,
        })));
        assert.deepEqual(connection.statements, ["BEGIN IMMEDIATE", "ROLLBACK"]);
        assert.deepEqual(connection.committed, []);
        assert.doesNotMatch(events.calls.join(","), /dedup/);
      });
    }
  }

  it("revalidates the trusted committed batch after afterAppend and before dedup", () => {
    const connection = new TransactionConnection();
    const events = new ExternallyMutableCommitEvents(connection);
    const store = new LifecycleCommandStore({
      connection,
      events,
      projectionWriter: recordingProjectionWriter(),
      transaction: () => transaction(connection),
      now: () => NOW,
    });

    assert.throws(
      () => store.execute(envelope(), () => ({
        append: appendCommand(),
        authorizationRecord: authorization(),
        afterAppend: () => {
          events.corruptCommittedResponse();
          return undefined;
        },
      })),
      (error: unknown) => error instanceof LifecycleCommandStoreError
        && error.code === "INTEGRITY_FAILURE",
    );
    assert.deepEqual(connection.statements, ["BEGIN IMMEDIATE", "ROLLBACK"]);
    assert.doesNotMatch(events.calls.join(","), /dedup/);
  });

  it("maps an uncertain commit to the original command identity", () => {
    const connection = new TransactionConnection(true);
    const events = new FakeEvents(connection);
    const store = new LifecycleCommandStore({
      connection,
      events,
      projectionWriter: recordingProjectionWriter(),
      transaction: () => transaction(connection),
      now: () => NOW,
    });
    const command = envelope();

    assert.throws(
      () => store.execute(command, () => ({
        append: appendCommand(),
        authorizationRecord: authorization(),
        afterAppend: () => undefined,
      })),
      (error: unknown) => error instanceof LifecycleCommandStoreError
        && error.code === "COMMAND_OUTCOME_UNKNOWN"
        && error.details.commandId === command.commandId
        && error.details.idempotencyKey === command.idempotencyKey,
    );
    assert.deepEqual(connection.statements, ["BEGIN IMMEDIATE", "COMMIT", "ROLLBACK"]);
  });

  it("maps a busy-shaped post-COMMIT result failure to command outcome unknown", () => {
    const connection = new TransactionConnection();
    const events = new BusyResultEvents(connection);
    const store = new LifecycleCommandStore({
      connection,
      events,
      projectionWriter: recordingProjectionWriter(),
      transaction: () => transaction(connection),
      now: () => NOW,
    });

    assert.throws(
      () => store.execute(envelope(), () => ({
        append: appendCommand(),
        authorizationRecord: authorization(),
        afterAppend: () => undefined,
      })),
      (error: unknown) => error instanceof LifecycleCommandStoreError
        && error.code === "COMMAND_OUTCOME_UNKNOWN",
    );
    assert.deepEqual(connection.statements, ["BEGIN IMMEDIATE", "COMMIT"]);
  });
});

function compileTimeTransactionBoundary(tx: LifecycleCommandTransaction): void {
  // @ts-expect-error lifecycle callbacks never receive the raw connection
  void tx.connection;
  // @ts-expect-error lifecycle callbacks cannot execute arbitrary SQL
  tx.exec("DELETE FROM events");
  // @ts-expect-error lifecycle callbacks have no event append seam
  void tx.events;
  // @ts-expect-error lifecycle callbacks cannot perform a second append
  tx.events.append({});
}

void compileTimeTransactionBoundary;

function compileTimeSynchronousCommandCallbacks(store: LifecycleCommandStore): void {
  // @ts-expect-error onNew must return a prepared commit synchronously
  store.execute(envelope(), async () => ({
    append: appendCommand(),
    authorizationRecord: authorization(),
    afterAppend: () => undefined,
  }));
  store.execute(envelope(), () => ({
    append: appendCommand(),
    authorizationRecord: authorization(),
    // @ts-expect-error beforeAppend cannot return a Promise
    beforeAppend: async () => undefined,
    afterAppend: () => undefined,
  }));
  store.execute(envelope(), () => ({
    append: appendCommand(),
    authorizationRecord: authorization(),
    // @ts-expect-error afterAppend cannot return a Promise
    afterAppend: async () => undefined,
  }));
}

void compileTimeSynchronousCommandCallbacks;

function compileTimeAuthorityStatusHasNoTransaction(
  connection: SqliteConnection,
  events: LifecycleEventAppendPort,
): void {
  new LifecycleCommandStore({
    connection,
    events,
    projectionWriter: recordingProjectionWriter(),
    transaction: () => ({} as LifecycleCommandTransaction),
    // @ts-expect-error material status cannot receive a transaction facade
    authorityMaterialStatus: (_authorization, transactionFacade) => {
      void transactionFacade;
      return "current";
    },
  });
}

void compileTimeAuthorityStatusHasNoTransaction;

type NestedLifecycleResponse = {
  nested: { eventPosition: string };
};

function compileTimeImmutableBatchBoundary(
  planned: PlannedEventAppend<NestedLifecycleResponse>,
  committed: EventAppendBatch<NestedLifecycleResponse>,
): void {
  // @ts-expect-error planned event identity is immutable
  planned.events[0]!.eventHash = "9".repeat(64);
  // @ts-expect-error planned response is deeply immutable
  planned.storedResponse.response.nested.eventPosition = "999";
  // @ts-expect-error planned stored response arrays are immutable
  planned.storedResponse.eventIds.push("00000000-0000-4000-8000-000000000999");
  // @ts-expect-error committed event identity is immutable
  committed.events[0]!.globalPosition = 99n;
  // @ts-expect-error committed response is deeply immutable
  committed.storedResponse.response.nested.eventPosition = "999";
  // @ts-expect-error committed stored response arrays are immutable
  committed.storedResponse.eventIds.push("00000000-0000-4000-8000-000000000999");
}

function isReadonlyJsonObject(
  value: ReadonlyJsonValue,
): value is { readonly [key: string]: ReadonlyJsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compileTimeImmutablePayloadBoundary(event: StoredEvent): void {
  const payload = event.payload;
  if (!isReadonlyJsonObject(payload)) return;
  // @ts-expect-error stored event payload objects are immutable
  payload.nested = { accepted: false };
  const nested = payload.nested;
  if (!isReadonlyJsonObject(nested)) return;
  // @ts-expect-error stored event nested payload objects are immutable
  nested.accepted = false;
}

void compileTimeImmutableBatchBoundary;
void compileTimeImmutablePayloadBoundary;
