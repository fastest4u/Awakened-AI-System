import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  LifecycleOperationalStore,
  LifecycleOperationalStoreError,
  type LifecycleOperationalTransaction,
  type WorkflowOperationalWorkIdentity,
} from "../src/orchestrator/lifecycle/lifecycle-operational.store.js";
import type {
  SqliteConnection,
  SqliteStatement,
} from "../src/orchestrator/storage/sqlite-driver.js";

class OperationalConnection implements SqliteConnection {
  readonly statements: string[] = [];
  readonly committed: string[] = [];
  #pending: string[] = [];

  constructor(readonly failCommit = false) {}

  stage(value: string): void { this.#pending.push(value); }

  exec(sql: string): void {
    const normalized = sql.trim().replace(/\s+/g, " ").toUpperCase();
    this.statements.push(normalized);
    if (normalized === "BEGIN IMMEDIATE") this.#pending = [];
    if (normalized === "COMMIT") {
      if (this.failCommit) throw { errcode: 10 };
      this.committed.push(...this.#pending);
      this.#pending = [];
    }
    if (normalized === "ROLLBACK") this.#pending = [];
  }

  prepare(sql: string): SqliteStatement {
    throw new Error(`operational store must not prepare arbitrary SQL: ${sql}`);
  }
  close(): void {}
}

function work(): WorkflowOperationalWorkIdentity {
  return {
    kind: "workflow",
    projectId: "00000000-0000-4000-8000-000000000001",
    workflowId: "00000000-0000-4000-8000-000000000020",
    workflowGeneration: 3n,
    operation: "renew",
    ownerId: "coordinator-a",
    claimToken: 7n,
  };
}

function transaction(connection: OperationalConnection): LifecycleOperationalTransaction {
  const stage = (value: string) => connection.stage(value);
  return {
    workflows: { stage },
    outbox: { stage },
  };
}

function stage(facade: object, effect: string): void {
  (facade as { stage(value: string): void }).stage(effect);
}

describe("LifecycleOperationalStore", () => {
  it("commits focused workflow and outbox CAS work with exactly one boundary", () => {
    const connection = new OperationalConnection();
    const tx = transaction(connection);
    const store = new LifecycleOperationalStore({
      connection,
      transaction: () => tx,
    });

    const result = store.execute(work(), (received) => {
      assert.equal(received, tx);
      stage(received.workflows, "workflow-renew");
      stage(received.outbox, "outbox-cas");
      return { renewed: true };
    });

    assert.deepEqual(result.publicResult, { renewed: true });
    assert.deepEqual(result.work, work());
    assert.deepEqual(connection.statements, ["BEGIN IMMEDIATE", "COMMIT"]);
    assert.deepEqual(connection.committed, ["workflow-renew", "outbox-cas"]);
  });

  it("rolls back a failed eventless operation without committing staged rows", () => {
    const connection = new OperationalConnection();
    const store = new LifecycleOperationalStore({
      connection,
      transaction: () => transaction(connection),
    });

    assert.throws(() => store.execute(work(), (tx) => {
      stage(tx.workflows, "claim");
      throw new Error("injected");
    }), /injected/);
    assert.deepEqual(connection.statements, ["BEGIN IMMEDIATE", "ROLLBACK"]);
    assert.deepEqual(connection.committed, []);
  });

  it("reports OPERATION_OUTCOME_UNKNOWN with the unchanged workflow fence", () => {
    const connection = new OperationalConnection(true);
    const store = new LifecycleOperationalStore({
      connection,
      transaction: () => transaction(connection),
    });
    const identity = work();

    assert.throws(
      () => store.execute(identity, (tx) => {
        stage(tx.workflows, "renew");
        return { renewed: true };
      }),
      (error: unknown) => error instanceof LifecycleOperationalStoreError
        && error.code === "OPERATION_OUTCOME_UNKNOWN"
        && error.work === identity,
    );
    assert.deepEqual(connection.statements, ["BEGIN IMMEDIATE", "COMMIT", "ROLLBACK"]);
  });

  it("reports the unchanged identity when success is lost after COMMIT", () => {
    const connection = new OperationalConnection();
    const identity = work();
    const store = new LifecycleOperationalStore({
      connection,
      transaction: () => transaction(connection),
      afterCommit: () => { throw new Error("lost response"); },
    });

    assert.throws(
      () => store.execute(identity, () => ({ renewed: true })),
      (error: unknown) => error instanceof LifecycleOperationalStoreError
        && error.code === "OPERATION_OUTCOME_UNKNOWN"
        && error.work === identity,
    );
    assert.deepEqual(connection.statements, ["BEGIN IMMEDIATE", "COMMIT"]);
  });
});

function compileTimeOperationalBoundary(tx: LifecycleOperationalTransaction): void {
  // @ts-expect-error operational callbacks never receive the raw connection
  void tx.connection;
  // @ts-expect-error operational callbacks cannot execute arbitrary SQL
  tx.exec("SELECT * FROM command_dedup");
  // @ts-expect-error operational callbacks cannot read authority state
  void tx.authority;
  // @ts-expect-error operational callbacks cannot append events
  void tx.events;
  // @ts-expect-error operational callbacks cannot access command dedup
  void tx.commandDedup;
}

void compileTimeOperationalBoundary;
