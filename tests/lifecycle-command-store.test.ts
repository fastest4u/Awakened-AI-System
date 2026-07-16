import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import type {
  AppendCommand,
  JsonValue,
  LifecycleReplayExpectation,
  PersistedLifecycleAuthorizationRecord,
} from "../src/orchestrator/contracts/event.js";
import type {
  EventAppendBatch,
  PlannedEventAppend,
  PreparedEventAppend,
} from "../src/orchestrator/storage/event-append-transaction.js";
import type { ProjectContext } from "../src/orchestrator/identity/contracts.js";
import {
  LifecycleCommandStore,
  LifecycleCommandStoreError,
  type LifecycleCommandEnvelope,
  type LifecycleCommandTransaction,
  type LifecycleEventAppendPort,
} from "../src/orchestrator/lifecycle/lifecycle-command.store.js";
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

const HASH_A = "a".repeat(64);
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

class TransactionConnection implements SqliteConnection {
  readonly statements: string[] = [];
  readonly committed: string[] = [];
  #pending: string[] = [];

  constructor(readonly failCommit = false) {}

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
    } else if (normalized === "ROLLBACK") {
      this.#pending = [];
    }
  }

  prepare(_sql: string): SqliteStatement { throw new Error("raw SQL must remain private"); }
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
    replayExpectation: expectation(),
    ...overrides,
  };
}

function appendCommand(): AppendCommand<JsonValue> {
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
  replay: EventAppendReplay<JsonValue> | null = null;

  constructor(readonly connection: TransactionConnection) {}

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

  prepare<T extends JsonValue>(command: AppendCommand<T>): PreparedEventAppend<T> {
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
        response: { eventPosition: "2" } as unknown as T,
      },
      responseHash: "2".repeat(64),
    };
  }

  appendPlanned<T extends JsonValue>(planned: PlannedEventAppend<T>): EventAppendBatch<T> {
    this.calls.push("append");
    this.connection.stage("event");
    return planned;
  }

  insertDedup<T extends JsonValue>(
    _prepared: PreparedEventAppend<T>,
    _batch: EventAppendBatch<T>,
    _record: PersistedLifecycleAuthorizationRecord,
  ): void {
    this.calls.push("dedup");
    this.connection.stage("dedup");
  }

  result<T extends JsonValue>(batch: EventAppendBatch<T>): EventAppendReplay<T> {
    return {
      deduplicated: false,
      firstGlobalPosition: BigInt(batch.storedResponse.firstGlobalPosition),
      lastGlobalPosition: BigInt(batch.storedResponse.lastGlobalPosition),
      finalStreamVersion: BigInt(batch.storedResponse.finalStreamVersion),
      eventIds: batch.storedResponse.eventIds,
      response: batch.storedResponse.response,
      responseHash: batch.responseHash,
      authorizationRecord: authorization(),
    };
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

function transaction(connection: TransactionConnection): LifecycleCommandTransaction {
  const stage = (name: string) => connection.stage(name);
  return {
    authority: { stage },
    leases: { stage },
    approvals: { stage },
    transfers: { stage },
    coverage: { stage },
    workflows: { stage },
    validation: { stage },
    outbox: { stage },
  };
}

function stage(facade: object, effect: string): void {
  (facade as { stage(value: string): void }).stage(effect);
}

describe("LifecycleCommandStore", () => {
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

  it("returns exact replay before fresh authority work and reports advisory staleness", () => {
    const connection = new TransactionConnection();
    const events = new FakeEvents(connection);
    events.replay = replayResult();
    const store = new LifecycleCommandStore({
      connection,
      events,
      transaction: () => {
        assert.deepEqual(events.calls, ["find-replay"]);
        return transaction(connection);
      },
      now: () => NOW,
      authorityMaterialStatus: () => "stale",
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

  it("commits event and focused repository effects in one semantic transaction", () => {
    const connection = new TransactionConnection();
    const events = new FakeEvents(connection);
    const tx = transaction(connection);
    const store = new LifecycleCommandStore({
      connection,
      events,
      transaction: () => tx,
      now: () => NOW,
      authorityMaterialStatus: () => "current",
    });

    const result = store.execute(envelope(), (received) => {
      assert.equal(received, tx);
      stage(received.authority, "authority");
      stage(received.leases, "lease");
      return {
        append: appendCommand(),
        authorizationRecord: authorization(),
        beforeAppend: (_planned, current) => stage(current.approvals, "approval"),
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

  it("rolls back all staged effects when the semantic callback fails", () => {
    const connection = new TransactionConnection();
    const events = new FakeEvents(connection);
    const store = new LifecycleCommandStore({
      connection,
      events,
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

  it("maps an uncertain commit to the original command identity", () => {
    const connection = new TransactionConnection(true);
    const events = new FakeEvents(connection);
    const store = new LifecycleCommandStore({
      connection,
      events,
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
