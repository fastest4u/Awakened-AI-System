import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  LifecycleOperationalStore,
  LifecycleOperationalStoreError,
  type LifecycleOperationalRepositorySet,
  type LifecycleOperationalStoreOptions,
  type LifecycleOperationalTransaction,
  type LifecycleOperationalWorkIdentity,
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

type StagingFacade = { stage(value: string): void };

function assertDeeplyFrozen(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  assert.equal(Object.isFrozen(value), true);
  for (const nested of Object.values(value)) assertDeeplyFrozen(nested);
}

function isLifecycleInputInvalid(error: unknown): boolean {
  return error instanceof LifecycleOperationalStoreError
    && error.code === "LIFECYCLE_INPUT_INVALID";
}

describe("LifecycleOperationalStore", () => {
  it("preserves claim-next identities before a target row exists", () => {
    const connection = new OperationalConnection();
    const store = new LifecycleOperationalStore({
      connection,
      transaction: () => transaction(connection),
    });
    const selections = [
      {
        kind: "workflow-selection",
        projectId: "00000000-0000-4000-8000-000000000001",
        workId: "workflow-scan-1",
        operation: "claim-next",
        ownerId: "coordinator-a",
      },
      {
        kind: "outbox-selection",
        projectId: "00000000-0000-4000-8000-000000000001",
        workId: "outbox-scan-1",
        operation: "claim-next",
        ownerId: "materializer-a",
      },
    ] as const;
    for (const selection of selections) {
      const result = store.execute(
        selection as unknown as LifecycleOperationalWorkIdentity,
        () => ({ selected: false }),
      );
      assert.deepEqual(result.work, selection);
      assert.equal(Object.isFrozen(result.work), true);
      assert.equal("workflowId" in result.work, false);
      assert.equal("targetKey" in result.work, false);
      assert.equal("claimToken" in result.work, false);
    }
  });

  const malformedWork: ReadonlyArray<readonly [name: string, value: unknown]> = [
    ["unknown kind", { ...work(), kind: "timer" }],
    ["unknown workflow operation", { ...work(), operation: "delete" }],
    ["unknown outbox operation", { ...outboxWork(), operation: "delete" }],
    ["malformed project UUID", { ...work(), projectId: "not-a-uuid" }],
    ["malformed workflow UUID", { ...work(), workflowId: "workflow-20" }],
    ["non-string owner", { ...work(), ownerId: 7 }],
    ["non-bigint claim token", { ...work(), claimToken: 7 }],
    ["claim token outside SQLite int64", { ...work(), claimToken: 9_223_372_036_854_775_808n }],
    ["revision outside SQLite int64", {
      ...outboxWork(), materializationRevision: 9_223_372_036_854_775_808n,
    }],
    ["unexpected discriminator field", { ...work(), targetKey: "memory/session.md" }],
  ];

  for (const [name, malformed] of malformedWork) {
    it(`rejects ${name} before BEGIN`, () => {
      const connection = new OperationalConnection();
      const store = new LifecycleOperationalStore({
        connection,
        transaction: () => transaction(connection),
      });
      let callbackCalls = 0;

      assert.throws(
        () => store.execute(
          malformed as WorkflowOperationalWorkIdentity,
          () => {
            callbackCalls += 1;
            return null;
          },
        ),
        isLifecycleInputInvalid,
      );
      assert.equal(callbackCalls, 0);
      assert.deepEqual(connection.statements, []);
    });
  }

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

  it("rejects a callback PromiseLike before commit", () => {
    const connection = new OperationalConnection();
    const store = new LifecycleOperationalStore({
      connection,
      transaction: () => transaction(connection),
    });
    const callback = (() => ({ then() { /* PromiseLike escape */ } })) as unknown as (
      tx: LifecycleOperationalTransaction,
    ) => string;

    assert.throws(() => store.execute(work(), callback), isLifecycleInputInvalid);
    assert.deepEqual(connection.statements, ["BEGIN IMMEDIATE", "ROLLBACK"]);
    assert.deepEqual(connection.committed, []);
  });

  it("revokes operational facades and captured method references when the callback exits", () => {
    const connection = new OperationalConnection();
    const store = new LifecycleOperationalStore({
      connection,
      transaction: () => transaction(connection),
    });
    let capturedFacade: StagingFacade | undefined;
    let capturedMethod: StagingFacade["stage"] | undefined;

    store.execute(work(), (tx) => {
      capturedFacade = tx.workflows as StagingFacade;
      capturedMethod = capturedFacade.stage;
      stage(tx.workflows, "during-callback");
      return null;
    });

    assert.throws(() => capturedFacade!.stage("post-commit-facade"), isLifecycleInputInvalid);
    assert.throws(() => capturedMethod!("post-commit-method"), isLifecycleInputInvalid);
    assert.deepEqual(connection.committed, ["during-callback"]);
  });

  it("guards object-valued method results so explicit self returns cannot expose a raw repository", () => {
    const connection = new OperationalConnection();
    const repositories = transaction(connection);
    (repositories.workflows as StagingFacade & { returnSelf?: () => StagingFacade }).returnSelf =
      function(this: StagingFacade) { return this; };
    const store = new LifecycleOperationalStore({
      connection,
      transaction: () => repositories,
    });
    let escaped: StagingFacade | undefined;

    store.execute(work(), (tx) => {
      escaped = (tx.workflows as StagingFacade & { returnSelf(): StagingFacade }).returnSelf();
      return null;
    });

    assert.throws(() => escaped!.stage("escaped-repository"), isLifecycleInputInvalid);
  });

  it("blocks inherited accessor mutators from leaking the raw operational repository", () => {
    const connection = new OperationalConnection();
    const store = new LifecycleOperationalStore({
      connection,
      transaction: () => transaction(connection),
    });
    let leaked: StagingFacade | undefined;

    assert.throws(
      () => store.execute(work(), (tx) => {
        const facade = tx.workflows as unknown as {
          __defineGetter__(property: string, getter: () => unknown): void;
          readonly leak: unknown;
        };
        facade.__defineGetter__("leak", function(this: StagingFacade) {
          leaked = this;
          return 1;
        });
        void facade.leak;
        return null;
      }),
      isLifecycleInputInvalid,
    );
    assert.equal(leaked, undefined);
    assert.deepEqual(connection.statements, ["BEGIN IMMEDIATE", "ROLLBACK"]);
  });

  it("rejects a Promise returned by a connection-bound repository method", () => {
    const connection = new OperationalConnection();
    const repositories = transaction(connection);
    (repositories.workflows as { readLater?: () => Promise<{ renewed: boolean }> }).readLater =
      () => Promise.resolve({ renewed: true });
    const store = new LifecycleOperationalStore({
      connection,
      transaction: () => repositories,
    });

    assert.throws(
      () => store.execute(work(), (tx) => {
        void (tx.workflows as { readLater(): Promise<unknown> }).readLater();
        return null;
      }),
      isLifecycleInputInvalid,
    );
    assert.deepEqual(connection.statements, ["BEGIN IMMEDIATE", "ROLLBACK"]);
  });

  it("snapshots a plain public DTO returned by a guarded repository method", () => {
    const connection = new OperationalConnection();
    const repositories = transaction(connection);
    (repositories.workflows as { readCurrent?: () => { renewed: boolean } }).readCurrent =
      () => ({ renewed: true });
    const store = new LifecycleOperationalStore({
      connection,
      transaction: () => repositories,
    });

    const result = store.execute(work(), (tx) =>
      (tx.workflows as { readCurrent(): { renewed: boolean } }).readCurrent());

    assert.deepEqual(result.publicResult, { renewed: true });
    assertDeeplyFrozen(result.publicResult);
  });

  it("snapshots and freezes work identity before caller mutation", () => {
    const connection = new OperationalConnection();
    const store = new LifecycleOperationalStore({
      connection,
      transaction: () => transaction(connection),
    });
    const identity = work();
    const expected = structuredClone(identity);

    const result = store.execute(identity, () => ({ renewed: true }));
    (identity as { ownerId: string }).ownerId = "mutated-owner";
    (identity as { claimToken: bigint }).claimToken = 999n;

    assert.notEqual(result.work, identity);
    assert.deepEqual(result.work, expected);
    assertDeeplyFrozen(result.work);
    assert.throws(() => {
      (result.work as { ownerId: string }).ownerId = "second-mutation";
    }, TypeError);
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
    const expected = structuredClone(identity);
    let observed: LifecycleOperationalStoreError | undefined;

    assert.throws(
      () => store.execute(identity, (tx) => {
        stage(tx.workflows, "renew");
        return { renewed: true };
      }),
      (error: unknown) => {
        if (!(error instanceof LifecycleOperationalStoreError)
          || error.code !== "OPERATION_OUTCOME_UNKNOWN") return false;
        observed = error;
        return true;
      },
    );
    assert.notEqual(observed!.work, identity);
    assert.deepEqual(observed!.work, expected);
    assertDeeplyFrozen(observed!.work);
    assert.deepEqual(connection.statements, ["BEGIN IMMEDIATE", "COMMIT", "ROLLBACK"]);
  });

  it("reports the immutable entry snapshot when caller identity mutates after COMMIT", () => {
    const connection = new OperationalConnection();
    const identity = work();
    const expected = structuredClone(identity);
    let afterCommitWork: LifecycleOperationalWorkIdentity | undefined;
    const store = new LifecycleOperationalStore({
      connection,
      transaction: () => transaction(connection),
      afterCommit: (received) => {
        afterCommitWork = received;
        (identity as { ownerId: string }).ownerId = "mutated-owner";
        (identity as { claimToken: bigint }).claimToken = 999n;
        throw new Error("lost response");
      },
    });
    let observed: LifecycleOperationalStoreError | undefined;

    assert.throws(
      () => store.execute(identity, () => ({ renewed: true })),
      (error: unknown) => {
        if (!(error instanceof LifecycleOperationalStoreError)
          || error.code !== "OPERATION_OUTCOME_UNKNOWN") return false;
        observed = error;
        return true;
      },
    );
    assert.notEqual(observed!.work, identity);
    assert.equal(observed!.work, afterCommitWork);
    assert.deepEqual(observed!.work, expected);
    assertDeeplyFrozen(observed!.work);
    assert.deepEqual(connection.statements, ["BEGIN IMMEDIATE", "COMMIT"]);
  });

  it("maps a PromiseLike afterCommit result to outcome unknown", () => {
    const connection = new OperationalConnection();
    const store = new LifecycleOperationalStore({
      connection,
      transaction: () => transaction(connection),
      afterCommit: (() => ({ then() { /* PromiseLike lost response */ } })) as unknown as (
        work: LifecycleOperationalWorkIdentity,
      ) => undefined,
    });

    assert.throws(
      () => store.execute(work(), () => ({ renewed: true })),
      (error: unknown) => error instanceof LifecycleOperationalStoreError
        && error.code === "OPERATION_OUTCOME_UNKNOWN",
    );
    assert.deepEqual(connection.statements, ["BEGIN IMMEDIATE", "COMMIT"]);
  });

  it("maps a busy-shaped afterCommit failure to outcome unknown", () => {
    const connection = new OperationalConnection();
    const store = new LifecycleOperationalStore({
      connection,
      transaction: () => transaction(connection),
      afterCommit: () => { throw { errcode: 5 }; },
    });

    assert.throws(
      () => store.execute(work(), () => ({ renewed: true })),
      (error: unknown) => error instanceof LifecycleOperationalStoreError
        && error.code === "OPERATION_OUTCOME_UNKNOWN",
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

function compileTimeSynchronousOperationalCallback(store: LifecycleOperationalStore): void {
  // @ts-expect-error operational transaction callbacks cannot return a Promise
  store.execute(work(), async (tx) => {
    void tx.workflows;
    return { renewed: true };
  });
}

void compileTimeSynchronousOperationalCallback;

function compileTimeSynchronousAfterCommit(options: LifecycleOperationalStoreOptions): void {
  const invalid: LifecycleOperationalStoreOptions = {
    ...options,
    // @ts-expect-error afterCommit cannot return a Promise
    afterCommit: async () => undefined,
  };
  void invalid;
}

void compileTimeSynchronousAfterCommit;

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
