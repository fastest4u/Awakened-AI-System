import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  LifecycleOperationalStore,
  LifecycleOperationalStoreError,
  type LifecycleOperationalRepositorySet,
  type LifecycleOperationalTransaction,
  type OutboxOperationalWorkIdentity,
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

function outboxWork(): OutboxOperationalWorkIdentity {
  return {
    kind: "outbox",
    projectId: "00000000-0000-4000-8000-000000000001",
    targetKey: "memory/session.md",
    materializationRevision: 4n,
    operation: "materialize",
    ownerId: "materializer-a",
    claimToken: 8n,
  };
}

function transaction(connection: OperationalConnection): LifecycleOperationalRepositorySet {
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
  it("projects only the workflow facade for workflow work", () => {
    const connection = new OperationalConnection();
    const repositories = new Proxy(transaction(connection), {
      get(target, property, receiver) {
        if (property === "outbox") throw new Error("workflow path read outbox repository");
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const store = new LifecycleOperationalStore({
      connection,
      transaction: () => repositories,
    });

    store.execute(work(), (received) => {
      assert.deepEqual(Object.keys(received), ["workflows"]);
      assert.equal("outbox" in received, false);
      stage(received.workflows, "workflow-only");
      return null;
    });

    assert.deepEqual(connection.committed, ["workflow-only"]);
  });

  it("commits focused workflow CAS work with exactly one boundary", () => {
    const connection = new OperationalConnection();
    const tx = transaction(connection);
    const store = new LifecycleOperationalStore({
      connection,
      transaction: () => tx,
    });

    const result = store.execute(work(), (received) => {
      assert.notEqual(received, tx);
      assert.deepEqual(Object.keys(received), ["workflows"]);
      stage(received.workflows, "workflow-renew");
      return { renewed: true };
    });

    assert.deepEqual(result.publicResult, { renewed: true });
    assert.deepEqual(result.work, work());
    assert.deepEqual(connection.statements, ["BEGIN IMMEDIATE", "COMMIT"]);
    assert.deepEqual(connection.committed, ["workflow-renew"]);
  });

  it("projects only the outbox facade for materialization work", () => {
    const connection = new OperationalConnection();
    const repositories = new Proxy(transaction(connection), {
      get(target, property, receiver) {
        if (property === "workflows") throw new Error("outbox path read workflow repository");
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const store = new LifecycleOperationalStore({
      connection,
      transaction: () => repositories,
    });

    const result = store.execute(outboxWork(), (received) => {
      assert.deepEqual(Object.keys(received), ["outbox"]);
      assert.equal("workflows" in received, false);
      stage(received.outbox, "materialize-and-ack");
      return { materialized: true };
    });

    assert.deepEqual(result.publicResult, { materialized: true });
    assert.deepEqual(connection.committed, ["materialize-and-ack"]);
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

function compileTimeKindSpecificOperationalBoundary(store: LifecycleOperationalStore): void {
  store.execute(work(), (tx) => {
    void tx.workflows;
    // @ts-expect-error workflow work cannot access the outbox facade
    void tx.outbox;
    return null;
  });
  store.execute(outboxWork(), (tx) => {
    void tx.outbox;
    // @ts-expect-error outbox work cannot access the workflow facade
    void tx.workflows;
    return null;
  });
}

void compileTimeKindSpecificOperationalBoundary;
