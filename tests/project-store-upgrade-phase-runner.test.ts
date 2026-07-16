import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { it } from "node:test";
import type { ProjectContext } from "../src/orchestrator/identity/contracts.js";
import {
  ProjectStoreUpgradePhaseRunner,
  type UpgradePhaseWorkerLike,
} from "../src/orchestrator/runtime/project-store-upgrade-phase-runner.js";

const CONTEXT = {
  binding: {
    projectId: "11111111-1111-4111-8111-111111111111",
    vaultId: "22222222-2222-4222-8222-222222222222",
    storeId: "33333333-3333-4333-8333-333333333333",
    generation: 1,
    contextFingerprint: "a".repeat(64),
    projectBindingId: "phase-runner-binding",
    source: "explicit-cli",
    projectRoot: "C:\\project",
    vaultRoot: "C:\\project\\memory",
    descriptorPath: "C:\\project\\memory\\.memory-mcp\\project-identity.json",
    storeRoute: { kind: "vault-local" },
    workspaceId: "phase-runner-workspace",
    workspace: {
      kind: "non-git",
      workspaceRoot: "C:\\project",
      workspaceId: "phase-runner-workspace",
    },
    clientNamespace: "phase-runner-tests",
    clientInstanceId: "phase-runner-client",
    actorRole: "maintenance",
    establishedAt: "2026-07-16T00:00:00.000Z",
  },
  workspace: {
    kind: "non-git",
    workspaceRoot: "C:\\project",
    workspaceId: "phase-runner-workspace",
  },
  checkedAt: "2026-07-16T00:00:00.000Z",
} as unknown as ProjectContext;

class FakeWorker extends EventEmitter implements UpgradePhaseWorkerLike {
  terminateCalls = 0;

  async terminate(): Promise<number> {
    this.terminateCalls += 1;
    return 1;
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class RejectingTerminationWorker extends FakeWorker {
  override async terminate(): Promise<number> {
    this.terminateCalls += 1;
    throw new Error("termination cleanup failed");
  }
}

class DeferredTerminationWorker extends FakeWorker {
  readonly termination = deferred<number>();

  override terminate(): Promise<number> {
    this.terminateCalls += 1;
    return this.termination.promise;
  }
}

async function outcomeByNextTurn(promise: Promise<unknown>): Promise<string> {
  return Promise.race([
    promise.then(
      () => "resolved",
      (error: unknown) => error instanceof Error && "code" in error
        ? String((error as Error & { code: unknown }).code)
        : String(error),
    ),
    new Promise<string>((resolve) => setImmediate(() => resolve("pending"))),
  ]);
}

it("settles a failure response when termination completes without an exit event", async () => {
  const worker = new FakeWorker();
  const runner = new ProjectStoreUpgradePhaseRunner({
    workerUrl: new URL("file:///fake-upgrade-phase-worker.js"),
    workerFactory: () => worker,
  });
  const phase = runner.fullIntegrity(CONTEXT, new AbortController().signal);

  worker.emit("message", {
    ok: false,
    error: { code: "STORE_INTEGRITY_FAILED" },
  });

  assert.equal(await outcomeByNextTurn(phase), "STORE_INTEGRITY_FAILED");
  assert.equal(worker.terminateCalls, 1);
});

it("preserves a protocol error when termination rejects without an exit event", async () => {
  const worker = new RejectingTerminationWorker();
  const runner = new ProjectStoreUpgradePhaseRunner({
    workerUrl: new URL("file:///fake-upgrade-phase-worker.js"),
    workerFactory: () => worker,
  });
  const phase = runner.fullIntegrity(CONTEXT, new AbortController().signal);

  worker.emit("messageerror", new Error("malformed clone"));

  assert.equal(await outcomeByNextTurn(phase), "WORKER_PROTOCOL_ERROR");
  assert.equal(worker.terminateCalls, 1);
});

it("settles races once with the first error and contains late termination rejection", async () => {
  const worker = new DeferredTerminationWorker();
  const controller = new AbortController();
  const runner = new ProjectStoreUpgradePhaseRunner({
    workerUrl: new URL("file:///fake-upgrade-phase-worker.js"),
    workerFactory: () => worker,
  });
  let settlements = 0;
  const phase = runner.fullIntegrity(CONTEXT, controller.signal).then(
    () => {
      settlements += 1;
      return "resolved";
    },
    (error: unknown) => {
      settlements += 1;
      return error instanceof Error && "code" in error
        ? String((error as Error & { code: unknown }).code)
        : String(error);
    },
  );
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown): void => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);

  try {
    controller.abort();
    worker.emit("error", new Error("late worker failure"));
    worker.emit("messageerror", new Error("late protocol failure"));
    worker.emit("exit", 1);

    assert.equal(await phase, "WORKER_CLOSED");
    worker.termination.reject(new Error("late termination cleanup failure"));
    worker.emit("message", { ok: true, data: { late: true } });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(settlements, 1);
    assert.equal(worker.terminateCalls, 1);
    assert.deepEqual(unhandled, []);
    assert.deepEqual(
      ["message", "messageerror", "error", "exit"].map((event) => (
        worker.listenerCount(event)
      )),
      [0, 0, 0, 0],
    );
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
