import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, describe, it } from "node:test";
import type {
  AppendCommand,
  JsonValue,
} from "../src/orchestrator/contracts/event.js";
import type {
  ProjectBinding,
  ProjectContext,
  ProjectId,
  StoreId,
  VaultId,
} from "../src/orchestrator/identity/contracts.js";
import { deriveNonGitWorkspaceId } from "../src/orchestrator/identity/git-workspace.resolver.js";
import {
  computeProjectContextFingerprint,
  ProjectBindingError,
} from "../src/orchestrator/identity/project-binding.service.js";
import {
  decodeAppendCommandWire,
  decodeWorkerRequest,
  decodeWorkerResponse,
  encodeAppendCommandWire,
  encodeMaintenanceLeaseWire,
  encodeWorkerBinding,
  encodeWorkerBindingAssertion,
  type WorkerBinding,
  type WorkerOpenResult,
  type WorkerRequest,
  type WorkerResponse,
  type WorkerSuccessData,
} from "../src/orchestrator/runtime/worker-protocol.js";
import {
  WorkerProjectStoreIdentityProbe,
} from "../src/orchestrator/runtime/project-store-identity-probe.js";
import {
  DEFAULT_MAX_PENDING,
  ProjectStoreExecutor,
  ProjectStoreExecutorRegistry,
  ProjectStoreWorkerError,
  projectStoreExecutorKey,
  type ExecutorScheduler,
  type ProjectStoreExecutorDependencies,
  type WorkerFactory,
  type WorkerLike,
} from "../src/orchestrator/runtime/project-store-executor.js";
import {
  ProjectStoreWorkerRuntime,
  type WorkerRuntimeBackend,
  type WorkerRuntimePort,
  type WorkerRuntimeScheduler,
} from "../src/orchestrator/runtime/project-store-worker-runtime.js";
import {
  ProjectStoreWorkerBackend,
  ProjectStoreWorkerBackendError,
  retryPrimarySqliteBusy,
} from "../src/orchestrator/runtime/project-store-worker-backend.js";
import {
  DefaultProjectStoreBootstrapService,
} from "../src/orchestrator/storage/project-store-bootstrap.service.js";
import { MaintenanceFence } from "../src/orchestrator/storage/maintenance-fence.js";
import { EventStore, EventStoreError } from "../src/orchestrator/storage/event-store.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import { DEFAULT_BUSY_TIMEOUT_MS } from "../src/orchestrator/runtime/runtime-capabilities.js";

const roots: string[] = [];
const PROJECT_ID = "11111111-1111-4111-8111-111111111111" as ProjectId;
const VAULT_ID = "22222222-2222-4222-8222-222222222222" as VaultId;
const STORE_ID = "33333333-3333-4333-8333-333333333333" as StoreId;
const BINDING_ID = "44444444-4444-4444-8444-444444444444";
const COMMAND_ID = "55555555-5555-4555-8555-555555555555";
const NOW = "2026-07-13T02:03:04.000Z";
const WORKER_URL = new URL("../src/workers/project-store.worker.js", import.meta.url);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "project-store-executor-"));
  roots.push(root);
  return root;
}

function contextFixture(root = temporaryRoot()): ProjectContext {
  const projectRoot = resolve(root, "project");
  const vaultRoot = resolve(projectRoot, "memory");
  const storeRoot = resolve(vaultRoot, ".memory-mcp", "v2");
  mkdirSync(storeRoot, { recursive: true });
  const workspace = {
    kind: "non-git" as const,
    workspaceRoot: projectRoot,
    workspaceId: deriveNonGitWorkspaceId(PROJECT_ID, VAULT_ID),
  };
  const withoutPrivate: Omit<
    ProjectBinding,
    "contextFingerprint" | "projectBindingId" | "establishedAt"
  > = {
    generation: 7,
    source: "explicit-cli",
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: workspace.workspaceId,
    clientNamespace: "codex",
    clientInstanceId: "client-1",
    actorRole: "primary",
    projectRoot,
    vaultRoot,
    descriptorPath: join(vaultRoot, ".memory-mcp", "project-identity.json"),
    storeRoute: {
      kind: "vault-local",
      storeRoot,
      eventsPath: join(storeRoot, "events.sqlite"),
      storeManifestPath: join(storeRoot, "store-manifest.json"),
      projectionManifestPath: join(storeRoot, "current-projection.json"),
    },
    workspace,
  };
  const binding: ProjectBinding = {
    ...withoutPrivate,
    projectBindingId: BINDING_ID,
    contextFingerprint: computeProjectContextFingerprint(withoutPrivate),
    establishedAt: NOW,
  };
  return { binding, workspace, checkedAt: NOW };
}

function appendCommand(context: ProjectContext): AppendCommand<{ accepted: true }> {
  return {
    context,
    commandId: COMMAND_ID,
    idempotencyKey: "task-11-command",
    commandType: "memory.record",
    correlationId: "task-11-correlation",
    agentId: "primary-agent",
    expectedStreamVersion: 0n,
    streamId: "project:task-11",
    streamType: "task",
    events: [{
      eventType: "TaskRecorded",
      eventSchemaVersion: 1,
      occurredAt: NOW,
      visibilityScope: "project",
      confidence: "high",
      verificationStatus: "verified",
      payload: { task: 11 },
      sourceRefs: [],
      evidenceRefs: [],
      evidenceDigests: [],
    }],
    outbox: [],
    publicResponse: { accepted: true },
  };
}

function workerBinding(context: ProjectContext): WorkerBinding {
  return encodeWorkerBinding(context);
}

class ManualScheduler implements ExecutorScheduler {
  readonly #timeouts = new Map<object, () => void>();

  setTimeout(callback: () => void, _milliseconds: number): object {
    const handle = {};
    this.#timeouts.set(handle, callback);
    return handle;
  }

  clearTimeout(handle: object): void {
    this.#timeouts.delete(handle);
  }

  runNext(): void {
    const next = this.#timeouts.entries().next();
    if (next.done) throw new Error("NO_TIMER_AVAILABLE");
    const [handle, callback] = next.value;
    this.#timeouts.delete(handle);
    callback();
  }

  runAll(): void {
    while (this.#timeouts.size > 0) this.runNext();
  }
}

class FakeWorker extends EventEmitter implements WorkerLike {
  readonly posted: WorkerRequest[] = [];
  readonly lifecycle: string[] = [];
  terminateCalls = 0;
  throwOnPost = false;

  postMessage(value: unknown): void {
    if (this.throwOnPost) throw new Error("post failed");
    this.lifecycle.push("post");
    this.posted.push(value as WorkerRequest);
  }

  async terminate(): Promise<number> {
    this.lifecycle.push("terminate");
    this.terminateCalls += 1;
    return 1;
  }

  respond(request: WorkerRequest, data: WorkerResponse extends infer _T ? unknown : never): void {
    this.emit("message", { id: request.id, ok: true, data });
  }

  fail(request: WorkerRequest, code: string): void {
    this.emit("message", {
      id: request.id,
      ok: false,
      error: { code, message: code, details: {} },
    });
  }
}

class DeferredTerminationWorker extends FakeWorker {
  readonly termination = deferred<number>();

  override terminate(): Promise<number> {
    this.lifecycle.push("terminate");
    this.terminateCalls += 1;
    return this.termination.promise;
  }
}

class RejectingTerminationWorker extends FakeWorker {
  override async terminate(): Promise<number> {
    this.lifecycle.push("terminate");
    this.terminateCalls += 1;
    throw new Error("worker termination secret");
  }
}

class DropCommittedAppendResponseWorker extends EventEmitter implements WorkerLike {
  readonly #worker: Worker;
  readonly #requestTypes = new Map<string, WorkerRequest["type"]>();
  dropped = false;

  constructor(workerUrl: URL, workerData: Record<string, JsonValue>) {
    super();
    this.#worker = new Worker(workerUrl, { workerData });
    this.#worker.on("message", (value: unknown) => {
      const id = typeof value === "object" && value !== null && "id" in value
        && typeof value.id === "string" ? value.id : undefined;
      if (
        !this.dropped
        && id !== undefined
        && this.#requestTypes.get(id) === "append"
        && "ok" in (value as object)
        && (value as { ok?: unknown }).ok === true
      ) {
        this.dropped = true;
        void this.#worker.terminate();
        return;
      }
      this.emit("message", value);
    });
    this.#worker.on("messageerror", (error) => this.emit("messageerror", error));
    this.#worker.on("error", (error) => this.emit("error", error));
    this.#worker.on("exit", (exitCode) => this.emit("exit", exitCode));
  }

  postMessage(value: unknown): void {
    const request = value as WorkerRequest;
    this.#requestTypes.set(request.id, request.type);
    this.#worker.postMessage(value);
  }

  terminate(): Promise<number> {
    return this.#worker.terminate();
  }
}

function openResult(context: ProjectContext): WorkerOpenResult {
  return {
    projectId: context.binding.projectId,
    vaultId: context.binding.vaultId,
    storeId: context.binding.storeId,
    bindingGeneration: context.binding.generation,
    contextFingerprint: context.binding.contextFingerprint,
    executorId: "66666666-6666-4666-8666-666666666666",
  };
}

async function turn(): Promise<void> {
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolvePromise = resolveValue;
    rejectPromise = rejectValue;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function fakeExecutor(
  options: Partial<ConstructorParameters<typeof ProjectStoreExecutor>[0]> = {},
  dependencies: Partial<ProjectStoreExecutorDependencies> = {},
): Promise<{
  executor: ProjectStoreExecutor;
  worker: FakeWorker;
  scheduler: ManualScheduler;
  context: ProjectContext;
}> {
  const context = contextFixture();
  writeFileSync(context.binding.storeRoute.eventsPath, "fixture", "utf8");
  const worker = new FakeWorker();
  const scheduler = new ManualScheduler();
  const factory: WorkerFactory = () => worker;
  const executor = new ProjectStoreExecutor({
    workerUrl: WORKER_URL,
    context,
    maxPending: DEFAULT_MAX_PENDING,
    requestTimeoutMs: 10_000,
    closeTimeoutMs: 5_000,
    executorLeaseMs: 15_000,
    heartbeatIntervalMs: 5_000,
    ...options,
  }, {
    workerFactory: factory,
    scheduler,
    randomId: () => "77777777-7777-4777-8777-777777777777",
    ...dependencies,
  });
  const opening = executor.open();
  const request = worker.posted.at(-1);
  assert.equal(request?.type, "open");
  worker.respond(request!, openResult(context));
  await opening;
  return { executor, worker, scheduler, context };
}

function errorCode(expected: string): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof ProjectStoreWorkerError);
    assert.equal(error.code, expected);
    return true;
  };
}

const CALLBACK_SECRET = "owner-callback-secret-must-not-escape";

function hostileConfirmationFailure(
  trap: "prototype" | "code" | "details",
): object {
  const target = {};
  return new Proxy(target, {
    getPrototypeOf(observed) {
      if (trap === "prototype") throw new Error(CALLBACK_SECRET);
      return Reflect.getPrototypeOf(observed);
    },
    get(observed, property, receiver) {
      if (property === "code") {
        if (trap === "code") throw new Error(CALLBACK_SECRET);
        return "MAINTENANCE_LEASE_STALE";
      }
      if (property === "details") {
        if (trap === "details") throw new Error(CALLBACK_SECRET);
        return { secret: CALLBACK_SECRET };
      }
      return Reflect.get(observed, property, receiver);
    },
  });
}

function acquireAcknowledgedMaintenanceLease(
  connection: ReturnType<NodeSqliteDriver["open"]>,
  fence: MaintenanceFence,
  context: ProjectContext,
  executorId: string,
): ReturnType<MaintenanceFence["acquire"]> {
  const registeredAt = new Date().toISOString();
  connection.exec("BEGIN IMMEDIATE");
  fence.registerExecutor(
    connection,
    context.binding.projectId,
    executorId,
    context.binding.generation,
    context.binding.contextFingerprint,
    new Date(Date.now() + 60_000).toISOString(),
    registeredAt,
  );
  connection.exec("COMMIT");
  const acquiredAt = new Date().toISOString();
  connection.exec("BEGIN IMMEDIATE");
  const lease = fence.acquire(
    connection,
    "owner-confirmation",
    new Date(Date.now() + 120_000).toISOString(),
    acquiredAt,
  );
  connection.exec("COMMIT");
  connection.exec("BEGIN IMMEDIATE");
  fence.acknowledge(
    connection,
    lease,
    executorId,
    new Date().toISOString(),
  );
  connection.exec("COMMIT");
  return lease;
}

function maintenanceReady(
  connection: ReturnType<NodeSqliteDriver["open"]>,
  fence: MaintenanceFence,
  lease: ReturnType<MaintenanceFence["acquire"]>,
): boolean {
  connection.exec("BEGIN DEFERRED");
  try {
    return fence.allRequiredExecutorsAcknowledged(connection, lease);
  } finally {
    connection.exec("ROLLBACK");
  }
}

describe("worker protocol", () => {
  it("strictly decodes exact JSON-safe variants and rejects extras", () => {
    assert.deepEqual(decodeWorkerRequest({ id: "1", type: "ping" }), { id: "1", type: "ping" });
    assert.throws(
      () => decodeWorkerRequest({ id: "1", type: "ping", extra: true }),
      /WORKER_PROTOCOL_INVALID/,
    );
    assert.throws(
      () => decodeWorkerResponse({ id: "1", ok: true, data: { closed: true }, extra: true }),
      /WORKER_PROTOCOL_INVALID/,
    );
  });

  it("round-trips authority-free append decimals and rejects noncanonical or out-of-range values", () => {
    const context = contextFixture();
    const encoded = encodeAppendCommandWire(appendCommand(context));
    assert.equal(encoded.expectedStreamVersion, "0");
    assert.equal("context" in encoded, false);
    const decoded = decodeAppendCommandWire(encoded, context);
    assert.equal(decoded.expectedStreamVersion, 0n);
    assert.equal(decoded.context, context);

    assert.throws(
      () => decodeAppendCommandWire({ ...encoded, expectedStreamVersion: "00" }, context),
      /WORKER_PROTOCOL_INVALID/,
    );
    assert.throws(
      () => decodeAppendCommandWire({
        ...encoded,
        expectedStreamVersion: "9223372036854775808",
      }, context),
      /WORKER_PROTOCOL_INVALID/,
    );
  });

  it("maps the complete revalidated ProjectContext losslessly", () => {
    const context = contextFixture();
    const encoded = workerBinding(context);
    assert.equal(encoded.bindingGeneration, context.binding.generation);
    assert.equal(encoded.checkedAt, context.checkedAt);
    assert.deepEqual(encoded.workspace, context.workspace);
    assert.deepEqual(encoded.storeRoute, context.binding.storeRoute);
  });
});

describe("MaintenanceFence worker heartbeat", () => {
  it("atomically renews idle leases or returns the exact foreign maintenance epoch", async () => {
    const root = temporaryRoot();
    const projectRoot = resolve(root, "project");
    const vaultRoot = resolve(projectRoot, "memory");
    mkdirSync(vaultRoot, { recursive: true });
    const initialized = await new DefaultProjectStoreBootstrapService().initialize({
      projectRoot,
      vaultRoot,
    });
    const driver = new NodeSqliteDriver({ DatabaseSync });
    const connection = driver.open(initialized.route.eventsPath, {
      mode: "existing",
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    });
    const fence = new MaintenanceFence();
    const executorId = "88888888-8888-4888-8888-888888888888";
    connection.exec("BEGIN IMMEDIATE");
    fence.registerExecutor(
      connection,
      initialized.descriptor.projectId,
      executorId,
      1,
      "f".repeat(64),
      "2026-07-13T02:04:00.000Z",
      NOW,
    );
    connection.exec("COMMIT");

    const idle = fence.heartbeatExecutor(
      connection,
      initialized.descriptor.projectId,
      executorId,
      "2026-07-13T02:04:30.000Z",
      "2026-07-13T02:03:30.000Z",
    );
    assert.deepEqual(idle, { mode: "idle", renewed: true });

    connection.exec("BEGIN IMMEDIATE");
    const lease = fence.acquire(
      connection,
      "maintenance-owner",
      "2026-07-13T02:05:00.000Z",
      "2026-07-13T02:03:40.000Z",
    );
    connection.exec("COMMIT");
    const observed = fence.heartbeatExecutor(
      connection,
      initialized.descriptor.projectId,
      executorId,
      "2026-07-13T02:04:40.000Z",
      "2026-07-13T02:03:45.000Z",
    );
    assert.deepEqual(observed, { mode: "quiescing", lease });

    connection.exec("BEGIN IMMEDIATE");
    fence.acknowledge(
      connection,
      lease,
      executorId,
      "2026-07-13T02:03:46.000Z",
    );
    connection.exec("COMMIT");
    connection.exec("BEGIN IMMEDIATE");
    assert.equal(fence.allRequiredExecutorsAcknowledged(connection, lease), false);
    connection.exec("ROLLBACK");

    connection.exec("BEGIN IMMEDIATE");
    fence.closeExecutor(
      connection,
      initialized.descriptor.projectId,
      executorId,
      "2026-07-13T02:03:47.000Z",
    );
    connection.exec("COMMIT");
    connection.exec("BEGIN IMMEDIATE");
    assert.equal(fence.allRequiredExecutorsAcknowledged(connection, lease), true);
    connection.exec("ROLLBACK");
    connection.close();
  });
});

describe("ProjectStoreExecutor bounded lifecycle", () => {
  it("coalesces concurrent open calls into one worker request", async () => {
    const context = contextFixture();
    writeFileSync(context.binding.storeRoute.eventsPath, "fixture", "utf8");
    const worker = new FakeWorker();
    const executor = new ProjectStoreExecutor({
      workerUrl: WORKER_URL,
      context,
      maxPending: DEFAULT_MAX_PENDING,
      requestTimeoutMs: 10_000,
      closeTimeoutMs: 5_000,
      executorLeaseMs: 15_000,
      heartbeatIntervalMs: 5_000,
    }, { workerFactory: () => worker });
    const first = executor.open();
    const second = executor.open();
    assert.equal(first, second);
    assert.equal(worker.posted.length, 1);
    worker.respond(worker.posted[0]!, openResult(context));
    assert.deepEqual(await first, await second);
  });

  it("waits for worker exit before the maintenance owner publishes readiness", async () => {
    const context = await realContext();
    const worker = new FakeWorker();
    const fence = new MaintenanceFence();
    const owner = new NodeSqliteDriver({ DatabaseSync }).open(
      context.binding.storeRoute.eventsPath,
      { mode: "existing", busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS },
    );
    let ownerCalls = 0;
    type OwnerConfirmation = {
      projectId: ProjectId;
      executorId: string;
      lease: ReturnType<MaintenanceFence["acquire"]>;
      connectionClosed: true;
    };
    const dependencies = {
      workerFactory: () => worker,
      confirmMaintenanceClosure: async (confirmation: OwnerConfirmation) => {
        ownerCalls += 1;
        assert.equal(confirmation.projectId, context.binding.projectId);
        assert.equal(confirmation.connectionClosed, true);
        owner.exec("BEGIN IMMEDIATE");
        fence.confirmExecutorClosed(
          owner,
          confirmation.lease,
          confirmation.projectId,
          confirmation.executorId,
          new Date().toISOString(),
        );
        owner.exec("COMMIT");
      },
    } as Partial<ProjectStoreExecutorDependencies> & {
      confirmMaintenanceClosure(confirmation: OwnerConfirmation): Promise<void>;
    };
    const executor = new ProjectStoreExecutor({
      workerUrl: WORKER_URL,
      context,
      maxPending: DEFAULT_MAX_PENDING,
      requestTimeoutMs: 10_000,
      closeTimeoutMs: 5_000,
      executorLeaseMs: 15_000,
      heartbeatIntervalMs: 5_000,
    }, dependencies);
    const opening = executor.open();
    worker.respond(worker.posted[0]!, openResult(context));
    const opened = await opening;
    const lease = acquireAcknowledgedMaintenanceLease(
      owner,
      fence,
      context,
      opened.executorId,
    );

    let settled = false;
    const quiescing = executor.quiesce(lease).finally(() => { settled = true; });
    const request = worker.posted.at(-1)!;
    assert.equal(request.type, "quiesce");
    worker.respond(request, {
      quiesced: true,
      epoch: lease.epoch.toString(),
      connectionClosed: true,
    });
    worker.emit("message", {
      type: "quiesced",
      executorId: opened.executorId,
      epoch: lease.epoch.toString(),
      fencingToken: lease.fencingToken.toString(),
      ownerId: lease.ownerId,
      leaseExpiresAt: lease.leaseExpiresAt,
      connectionClosed: true,
    });
    await turn();
    const settledBeforeExit = settled;
    const ownerCallsBeforeExit = ownerCalls;
    const readyBeforeExit = maintenanceReady(owner, fence, lease);

    worker.emit("exit", 0);
    const outcome = await quiescing.then(
      () => "resolved",
      (error: unknown) => error instanceof ProjectStoreWorkerError ? error.code : "unknown",
    );
    const readyAfterOwnerConfirmation = maintenanceReady(owner, fence, lease);
    owner.close();

    assert.equal(settledBeforeExit, false);
    assert.equal(ownerCallsBeforeExit, 0);
    assert.equal(readyBeforeExit, false);
    assert.equal(ownerCalls, 1);
    assert.equal(outcome, "resolved");
    assert.equal(readyAfterOwnerConfirmation, true);
  });

  it("fails closed after worker exit when no maintenance owner callback exists", async () => {
    const context = await realContext();
    const worker = new FakeWorker();
    const executor = new ProjectStoreExecutor({
      workerUrl: WORKER_URL,
      context,
      maxPending: DEFAULT_MAX_PENDING,
      requestTimeoutMs: 10_000,
      closeTimeoutMs: 5_000,
      executorLeaseMs: 15_000,
      heartbeatIntervalMs: 5_000,
    }, { workerFactory: () => worker });
    const opening = executor.open();
    worker.respond(worker.posted[0]!, openResult(context));
    const opened = await opening;
    const owner = new NodeSqliteDriver({ DatabaseSync }).open(
      context.binding.storeRoute.eventsPath,
      { mode: "existing", busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS },
    );
    const fence = new MaintenanceFence();
    const lease = acquireAcknowledgedMaintenanceLease(
      owner,
      fence,
      context,
      opened.executorId,
    );

    const quiescing = executor.quiesce(lease);
    const request = worker.posted.at(-1)!;
    worker.respond(request, {
      quiesced: true,
      epoch: lease.epoch.toString(),
      connectionClosed: true,
    });
    worker.emit("message", {
      type: "quiesced",
      executorId: opened.executorId,
      epoch: lease.epoch.toString(),
      fencingToken: lease.fencingToken.toString(),
      ownerId: lease.ownerId,
      leaseExpiresAt: lease.leaseExpiresAt,
      connectionClosed: true,
    });
    worker.emit("exit", 0);
    const outcome = await quiescing.then(
      () => "resolved",
      (error: unknown) => error instanceof ProjectStoreWorkerError ? error.code : "unknown",
    );
    const ready = maintenanceReady(owner, fence, lease);
    const closedAt = owner.prepare(`
      SELECT closed_at
      FROM executor_leases
      WHERE project_id = $projectId AND executor_id = $executorId
    `).get({
      $projectId: context.binding.projectId,
      $executorId: opened.executorId,
    })?.closed_at;
    owner.close();

    assert.equal(outcome, "MAINTENANCE_CONFIRMATION_REQUIRED");
    assert.equal(ready, false);
    assert.equal(closedAt, null);
  });

  it("rejects maintenance response or notification evidence that mismatches the requested lease", async () => {
    for (const mismatch of ["response", "notification"] as const) {
      const context = contextFixture();
      writeFileSync(context.binding.storeRoute.eventsPath, "fixture", "utf8");
      const worker = new FakeWorker();
      let ownerCalls = 0;
      const dependencies = {
        workerFactory: () => worker,
        confirmMaintenanceClosure: async () => { ownerCalls += 1; },
      } as Partial<ProjectStoreExecutorDependencies> & {
        confirmMaintenanceClosure(confirmation: unknown): Promise<void>;
      };
      const executor = new ProjectStoreExecutor({
        workerUrl: WORKER_URL,
        context,
        maxPending: DEFAULT_MAX_PENDING,
        requestTimeoutMs: 10_000,
        closeTimeoutMs: 5_000,
        executorLeaseMs: 15_000,
        heartbeatIntervalMs: 5_000,
      }, dependencies);
      const opening = executor.open();
      worker.respond(worker.posted[0]!, openResult(context));
      const opened = await opening;
      const lease = {
        epoch: 31n,
        fencingToken: 31n,
        ownerId: "exact-owner",
        leaseExpiresAt: "2026-07-13T23:59:59.000Z",
      };
      const quiescing = executor.quiesce(lease);
      const request = worker.posted.at(-1)!;
      worker.respond(request, {
        quiesced: true,
        epoch: (mismatch === "response" ? 32n : lease.epoch).toString(),
        connectionClosed: true,
      });
      worker.emit("message", {
        type: "quiesced",
        executorId: opened.executorId,
        epoch: lease.epoch.toString(),
        fencingToken: (
          mismatch === "notification" ? 32n : lease.fencingToken
        ).toString(),
        ownerId: lease.ownerId,
        leaseExpiresAt: lease.leaseExpiresAt,
        connectionClosed: true,
      });
      worker.emit("exit", 0);
      const outcome = await quiescing.then(
        () => "resolved",
        (error: unknown) => error instanceof ProjectStoreWorkerError ? error.code : "unknown",
      );

      assert.equal(outcome, "WORKER_PROTOCOL_ERROR", mismatch);
      assert.equal(ownerCalls, 0, mismatch);
    }
  });

  it("never confirms closure after a negative response or exit without notification", async () => {
    const outcomes: Array<{
      mode: "negative-response" | "exit-without-notification";
      outcome: string;
      ownerCalls: number;
      ready: boolean;
      closedAt: unknown;
    }> = [];

    for (const mode of ["negative-response", "exit-without-notification"] as const) {
      const context = await realContext();
      const worker = new FakeWorker();
      const fence = new MaintenanceFence();
      const owner = new NodeSqliteDriver({ DatabaseSync }).open(
        context.binding.storeRoute.eventsPath,
        { mode: "existing", busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS },
      );
      let ownerCalls = 0;
      const executor = new ProjectStoreExecutor({
        workerUrl: WORKER_URL,
        context,
        maxPending: DEFAULT_MAX_PENDING,
        requestTimeoutMs: 10_000,
        closeTimeoutMs: 5_000,
        executorLeaseMs: 15_000,
        heartbeatIntervalMs: 5_000,
      }, {
        workerFactory: () => worker,
        confirmMaintenanceClosure: async (confirmation) => {
          ownerCalls += 1;
          owner.exec("BEGIN IMMEDIATE");
          fence.confirmExecutorClosed(
            owner,
            confirmation.lease,
            confirmation.projectId,
            confirmation.executorId,
            new Date().toISOString(),
          );
          owner.exec("COMMIT");
        },
      });
      const opening = executor.open();
      worker.respond(worker.posted[0]!, openResult(context));
      const opened = await opening;
      const lease = acquireAcknowledgedMaintenanceLease(
        owner,
        fence,
        context,
        opened.executorId,
      );

      const quiescing = executor.quiesce(lease);
      const request = worker.posted.at(-1)!;
      if (mode === "negative-response") {
        worker.fail(request, "STORE_UNAVAILABLE");
      } else {
        worker.respond(request, {
          quiesced: true,
          epoch: lease.epoch.toString(),
          connectionClosed: true,
        });
      }
      worker.emit("exit", 0);
      const outcome = await quiescing.then(
        () => "resolved",
        (error: unknown) => error instanceof ProjectStoreWorkerError ? error.code : "unknown",
      );
      const ready = maintenanceReady(owner, fence, lease);
      const closedAt = owner.prepare(`
        SELECT closed_at
        FROM executor_leases
        WHERE project_id = $projectId AND executor_id = $executorId
      `).get({
        $projectId: context.binding.projectId,
        $executorId: opened.executorId,
      })?.closed_at;
      outcomes.push({ mode, outcome, ownerCalls, ready, closedAt });
      owner.close();
    }

    assert.deepEqual(outcomes, [{
      mode: "negative-response",
      outcome: "STORE_UNAVAILABLE",
      ownerCalls: 0,
      ready: false,
      closedAt: null,
    }, {
      mode: "exit-without-notification",
      outcome: "WORKER_PROTOCOL_ERROR",
      ownerCalls: 0,
      ready: false,
      closedAt: null,
    }]);
  });

  it("terminates and settles malformed or queue-full quiesce requests before confirmation", async () => {
    let malformedOwnerCalls = 0;
    const malformedExecutor = await fakeExecutor({}, {
      confirmMaintenanceClosure: async () => { malformedOwnerCalls += 1; },
    });
    const malformedPosts = malformedExecutor.worker.posted.length;
    let malformedOutcome = "pending";
    const malformedQuiesce = malformedExecutor.executor.quiesce({
      epoch: 41n,
      fencingToken: 41n,
      ownerId: { invalid: true } as unknown as string,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    }).then(
      () => { malformedOutcome = "resolved"; },
      (error: unknown) => {
        malformedOutcome = error instanceof ProjectStoreWorkerError ? error.code : "unknown";
      },
    );
    await turn();
    await turn();
    const malformedBeforeExternalExit = malformedOutcome;
    const malformedTerminateCalls = malformedExecutor.worker.terminateCalls;
    if (malformedOutcome === "pending") malformedExecutor.worker.emit("exit", 0);
    await malformedQuiesce;

    let queueOwnerCalls = 0;
    const queued = await fakeExecutor({}, {
      confirmMaintenanceClosure: async () => { queueOwnerCalls += 1; },
    });
    const pendingReads = Array.from(
      { length: DEFAULT_MAX_PENDING },
      () => queued.executor.quickIntegrity(),
    );
    const readsSettled = Promise.allSettled(pendingReads);
    const queuePosts = queued.worker.posted.length;
    let queueOutcome = "pending";
    const queueQuiesce = queued.executor.quiesce({
      epoch: 42n,
      fencingToken: 42n,
      ownerId: "queue-owner",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    }).then(
      () => { queueOutcome = "resolved"; },
      (error: unknown) => {
        queueOutcome = error instanceof ProjectStoreWorkerError ? error.code : "unknown";
      },
    );
    await turn();
    await turn();
    const queueBeforeExternalExit = queueOutcome;
    const queueTerminateCalls = queued.worker.terminateCalls;
    if (queueOutcome === "pending") queued.worker.emit("exit", 0);
    await queueQuiesce;
    await readsSettled;

    assert.equal(malformedExecutor.worker.posted.length, malformedPosts);
    assert.equal(malformedBeforeExternalExit, "WORKER_PROTOCOL_ERROR");
    assert.equal(malformedTerminateCalls, 1);
    assert.equal(malformedOwnerCalls, 0);
    assert.equal(queued.worker.posted.length, queuePosts);
    assert.equal(queueBeforeExternalExit, "STORE_QUEUE_FULL");
    assert.equal(queueTerminateCalls, 1);
    assert.equal(queueOwnerCalls, 0);
  });

  it("settles a typed quiesce failure when worker termination rejects without an exit event", async () => {
    const context = contextFixture();
    writeFileSync(context.binding.storeRoute.eventsPath, "fixture", "utf8");
    const worker = new RejectingTerminationWorker();
    let ownerCalls = 0;
    const executor = new ProjectStoreExecutor({
      workerUrl: WORKER_URL,
      context,
      maxPending: DEFAULT_MAX_PENDING,
      requestTimeoutMs: 10_000,
      closeTimeoutMs: 5_000,
      executorLeaseMs: 15_000,
      heartbeatIntervalMs: 5_000,
    }, {
      workerFactory: () => worker,
      confirmMaintenanceClosure: async () => { ownerCalls += 1; },
    });
    const opening = executor.open();
    worker.respond(worker.posted[0]!, openResult(context));
    await opening;
    let outcome = "pending";
    const quiescing = executor.quiesce({
      epoch: 43n,
      fencingToken: 43n,
      ownerId: { invalid: true } as unknown as string,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    }).then(
      () => { outcome = "resolved"; },
      (error: unknown) => {
        outcome = error instanceof ProjectStoreWorkerError ? error.code : "unknown";
      },
    );
    await turn();
    await turn();

    assert.equal(outcome, "WORKER_UNAVAILABLE");
    assert.equal(worker.terminateCalls, 1);
    assert.equal(ownerCalls, 0);
    await quiescing;

    const lateWorker = new RejectingTerminationWorker();
    let lateOwnerCalls = 0;
    const lateExecutor = new ProjectStoreExecutor({
      workerUrl: WORKER_URL,
      context,
      maxPending: DEFAULT_MAX_PENDING,
      requestTimeoutMs: 10_000,
      closeTimeoutMs: 5_000,
      executorLeaseMs: 15_000,
      heartbeatIntervalMs: 5_000,
    }, {
      workerFactory: () => lateWorker,
      confirmMaintenanceClosure: async () => { lateOwnerCalls += 1; },
    });
    const lateOpening = lateExecutor.open();
    lateWorker.respond(lateWorker.posted[0]!, openResult(context));
    const lateOpened = await lateOpening;
    const lateLease = {
      epoch: 44n,
      fencingToken: 44n,
      ownerId: "late-protocol-owner",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    let lateOutcome = "pending";
    const lateQuiescing = lateExecutor.quiesce(lateLease).then(
      () => { lateOutcome = "resolved"; },
      (error: unknown) => {
        lateOutcome = error instanceof ProjectStoreWorkerError ? error.code : "unknown";
      },
    );
    const lateRequest = lateWorker.posted.at(-1)!;
    lateWorker.respond(lateRequest, {
      quiesced: true,
      epoch: lateLease.epoch.toString(),
      connectionClosed: true,
    });
    await turn();
    lateWorker.emit("message", {
      type: "quiesced",
      executorId: lateOpened.executorId,
      epoch: lateLease.epoch.toString(),
      fencingToken: (lateLease.fencingToken + 1n).toString(),
      ownerId: lateLease.ownerId,
      leaseExpiresAt: lateLease.leaseExpiresAt,
      connectionClosed: true,
    });
    await turn();
    await turn();

    assert.equal(lateOutcome, "WORKER_UNAVAILABLE");
    assert.equal(lateWorker.terminateCalls, 1);
    assert.equal(lateOwnerCalls, 0);
    await lateQuiescing;
  });

  it("sanitizes hostile maintenance confirmation failures for explicit quiesce", async () => {
    for (const trap of ["prototype", "code", "details"] as const) {
      let ownerCalls = 0;
      const { executor, worker, context } = await fakeExecutor({}, {
        confirmMaintenanceClosure: async () => {
          ownerCalls += 1;
          throw hostileConfirmationFailure(trap);
        },
      });
      const opened = openResult(context);
      const lease = {
        epoch: 51n,
        fencingToken: 51n,
        ownerId: "hostile-explicit-owner",
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
      const quiescing = executor.quiesce(lease);
      const request = worker.posted.at(-1)!;
      worker.respond(request, {
        quiesced: true,
        epoch: lease.epoch.toString(),
        connectionClosed: true,
      });
      worker.emit("message", {
        type: "quiesced",
        executorId: opened.executorId,
        epoch: lease.epoch.toString(),
        fencingToken: lease.fencingToken.toString(),
        ownerId: lease.ownerId,
        leaseExpiresAt: lease.leaseExpiresAt,
        connectionClosed: true,
      });
      worker.emit("exit", 0);
      const failure = await quiescing.then(
        () => null,
        (error: unknown) => error,
      );

      assert.ok(failure instanceof ProjectStoreWorkerError, trap);
      assert.equal(
        failure.code,
        trap === "details" ? "MAINTENANCE_LEASE_STALE" : "MAINTENANCE_CONFIRMATION_FAILED",
        trap,
      );
      assert.deepEqual(failure.details, {}, trap);
      assert.equal(
        `${failure.name}:${failure.message}:${JSON.stringify(failure.details)}`
          .includes(CALLBACK_SECRET),
        false,
        trap,
      );
      assert.equal(ownerCalls, 1, trap);
    }
  });

  it("contains hostile autonomous confirmation failures without an unhandled rejection", async () => {
    let ownerCalls = 0;
    const { executor, worker, context } = await fakeExecutor({}, {
      confirmMaintenanceClosure: async () => {
        ownerCalls += 1;
        throw hostileConfirmationFailure("prototype");
      },
    });
    const opened = openResult(context);
    const lease = {
      epoch: 52n,
      fencingToken: 52n,
      ownerId: "hostile-autonomous-owner",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const unhandled: unknown[] = [];
    const captureUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", captureUnhandled);
    try {
      worker.emit("message", {
        type: "quiesced",
        executorId: opened.executorId,
        epoch: lease.epoch.toString(),
        fencingToken: lease.fencingToken.toString(),
        ownerId: lease.ownerId,
        leaseExpiresAt: lease.leaseExpiresAt,
        connectionClosed: true,
      });
      worker.emit("exit", 0);
      await turn();
      await turn();
    } finally {
      process.off("unhandledRejection", captureUnhandled);
    }

    assert.equal(ownerCalls, 1);
    assert.deepEqual(unhandled, []);
    assert.throws(
      () => executor.quickIntegrity(),
      errorCode("MAINTENANCE_CONFIRMATION_FAILED"),
    );
  });

  it("keeps autonomous closure fail-closed after a duplicate quiesced notification", async () => {
    const context = await realContext();
    const worker = new FakeWorker();
    const fence = new MaintenanceFence();
    const owner = new NodeSqliteDriver({ DatabaseSync }).open(
      context.binding.storeRoute.eventsPath,
      { mode: "existing", busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS },
    );
    let ownerCalls = 0;
    const executor = new ProjectStoreExecutor({
      workerUrl: WORKER_URL,
      context,
      maxPending: DEFAULT_MAX_PENDING,
      requestTimeoutMs: 10_000,
      closeTimeoutMs: 5_000,
      executorLeaseMs: 15_000,
      heartbeatIntervalMs: 5_000,
    }, {
      workerFactory: () => worker,
      confirmMaintenanceClosure: async (confirmation) => {
        ownerCalls += 1;
        owner.exec("BEGIN IMMEDIATE");
        fence.confirmExecutorClosed(
          owner,
          confirmation.lease,
          confirmation.projectId,
          confirmation.executorId,
          new Date().toISOString(),
        );
        owner.exec("COMMIT");
      },
    });
    const opening = executor.open();
    worker.respond(worker.posted[0]!, openResult(context));
    const opened = await opening;
    const lease = acquireAcknowledgedMaintenanceLease(
      owner,
      fence,
      context,
      opened.executorId,
    );
    const notification = {
      type: "quiesced",
      executorId: opened.executorId,
      epoch: lease.epoch.toString(),
      fencingToken: lease.fencingToken.toString(),
      ownerId: lease.ownerId,
      leaseExpiresAt: lease.leaseExpiresAt,
      connectionClosed: true,
    } as const;

    worker.emit("message", notification);
    worker.emit("message", notification);
    await turn();
    worker.emit("exit", 0);
    await turn();

    const ready = maintenanceReady(owner, fence, lease);
    const closedAt = owner.prepare(`
      SELECT closed_at
      FROM executor_leases
      WHERE project_id = $projectId AND executor_id = $executorId
    `).get({
      $projectId: context.binding.projectId,
      $executorId: opened.executorId,
    })?.closed_at;
    owner.close();

    assert.equal(ownerCalls, 0);
    assert.equal(ready, false);
    assert.equal(closedAt, null);
    assert.throws(() => executor.quickIntegrity(), errorCode("WORKER_PROTOCOL_ERROR"));
  });

  it("rejects and poisons an authority-mismatched open success", async () => {
    const context = contextFixture();
    writeFileSync(context.binding.storeRoute.eventsPath, "fixture", "utf8");
    const worker = new FakeWorker();
    const executor = new ProjectStoreExecutor({
      workerUrl: WORKER_URL,
      context,
      maxPending: DEFAULT_MAX_PENDING,
      requestTimeoutMs: 10_000,
      closeTimeoutMs: 5_000,
      executorLeaseMs: 15_000,
      heartbeatIntervalMs: 5_000,
    }, { workerFactory: () => worker });
    const opening = executor.open();
    worker.respond(worker.posted[0]!, {
      ...openResult(context),
      storeId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    });
    await assert.rejects(opening, errorCode("STORE_ID_MISMATCH"));
    assert.equal(worker.terminateCalls, 1);
  });

  it("rejects pending request 129 before posting it", async () => {
    const { executor, worker } = await fakeExecutor();
    const pending = Array.from({ length: DEFAULT_MAX_PENDING }, () => executor.quickIntegrity());
    const postsBeforeRejected = worker.posted.length;
    await assert.rejects(executor.quickIntegrity(), errorCode("STORE_QUEUE_FULL"));
    assert.equal(worker.posted.length, postsBeforeRejected);
    worker.emit("error", new Error("stop pending requests"));
    await Promise.allSettled(pending);
  });

  it("settles every pending request on messageerror, error, exit, or timeout", async () => {
    const failures = [
      ["messageerror", "WORKER_PROTOCOL_ERROR"],
      ["error", "WORKER_UNAVAILABLE"],
      ["exit", "WORKER_UNAVAILABLE"],
      ["timeout", "WORKER_TIMEOUT"],
    ] as const;
    for (const [failure, expectedCode] of failures) {
      const { executor, worker, scheduler } = await fakeExecutor();
      const first = executor.quickIntegrity();
      const second = executor.fullIntegrity();
      if (failure === "timeout") scheduler.runNext();
      else if (failure === "exit") worker.emit("exit", 9);
      else worker.emit(failure, new Error(`${failure} secret`));
      await assert.rejects(first, errorCode(expectedCode));
      await assert.rejects(second, errorCode(expectedCode));
    }
  });

  it("reports only the original command recovery identity after a posted mutation becomes ambiguous", async () => {
    const { executor, scheduler, context } = await fakeExecutor();
    const command = appendCommand(context);
    const pending = executor.append(command);
    scheduler.runNext();
    await assert.rejects(pending, (error) => {
      assert.ok(error instanceof ProjectStoreWorkerError);
      assert.equal(error.code, "COMMAND_OUTCOME_UNKNOWN");
      assert.deepEqual(error.details, {
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
      });
      return true;
    });
  });

  it("poisons an explicit unknown outcome and requires a newly revalidated executor", async () => {
    const { executor, worker, context } = await fakeExecutor();
    const command = appendCommand(context);
    const mutation = executor.append(command);
    const request = worker.posted.at(-1)!;
    worker.emit("message", {
      id: request.id,
      ok: false,
      error: {
        code: "COMMAND_OUTCOME_UNKNOWN",
        message: "COMMAND_OUTCOME_UNKNOWN",
        details: {
          commandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          idempotencyKey: "untrusted-worker-key",
        },
      },
    });

    await assert.rejects(mutation, (error) => {
      assert.ok(error instanceof ProjectStoreWorkerError);
      assert.equal(error.code, "COMMAND_OUTCOME_UNKNOWN");
      assert.deepEqual(error.details, {
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
      });
      return true;
    });
    await turn();
    assert.equal(worker.terminateCalls, 1);
    const postsAfterPoison = worker.posted.length;
    assert.throws(() => executor.quickIntegrity(), errorCode("COMMAND_OUTCOME_UNKNOWN"));
    assert.equal(worker.posted.length, postsAfterPoison);

    const recovered = await fakeExecutor();
    assert.notEqual(recovered.worker, worker);
    assert.equal(recovered.executor.canReuse(), true);
  });

  it("classifies a read and a posted mutation differently on the same worker death", async () => {
    const { executor, worker, context } = await fakeExecutor();
    const read = executor.quickIntegrity();
    const mutation = executor.append(appendCommand(context));
    worker.emit("error", new Error("worker died after mutation post"));
    await assert.rejects(read, errorCode("WORKER_UNAVAILABLE"));
    await assert.rejects(mutation, errorCode("COMMAND_OUTCOME_UNKNOWN"));
  });

  it("poisons all prior requests when a later postMessage fails before posting", async () => {
    const { executor, worker } = await fakeExecutor();
    const prior = executor.quickIntegrity();
    worker.throwOnPost = true;
    const failedPost = executor.quickIntegrity();
    await assert.rejects(failedPost, errorCode("WORKER_UNAVAILABLE"));
    await assert.rejects(prior, errorCode("WORKER_UNAVAILABLE"));
    assert.equal(worker.terminateCalls, 1);
  });

  it("rejects a stale command context instead of silently replacing its authority", async () => {
    const { executor, worker, context } = await fakeExecutor();
    const staleContext: ProjectContext = {
      ...context,
      binding: {
        ...context.binding,
        generation: context.binding.generation + 1,
        contextFingerprint: "e".repeat(64),
      },
    };
    const posts = worker.posted.length;
    assert.throws(
      () => executor.append({ ...appendCommand(context), context: staleContext }),
      errorCode("PROJECT_BINDING_REQUIRED"),
    );
    assert.equal(worker.posted.length, posts);
  });

  it("poisons malformed, unknown, and duplicate response IDs", async () => {
    for (const kind of ["malformed", "unknown"] as const) {
      const { executor, worker } = await fakeExecutor();
      const pending = executor.quickIntegrity();
      const request = worker.posted.at(-1)!;
      worker.emit("message", kind === "unknown"
        ? { id: "not-pending", ok: true, data: { closed: true } }
        : { id: request.id, ok: true, data: { closed: true }, extra: true });
      await assert.rejects(pending, errorCode("WORKER_PROTOCOL_ERROR"));
      assert.equal(worker.terminateCalls, 1);
    }

    const { executor, worker } = await fakeExecutor();
    const read = executor.quickIntegrity();
    const request = worker.posted.at(-1)!;
    const report = {
      ok: true,
      mode: "quick",
      projectId: PROJECT_ID,
      storeId: STORE_ID,
      firstGlobalPosition: "0",
      lastGlobalPosition: "0",
      eventsVerified: 0,
      streamsVerified: 0,
      commandsVerified: 0,
      schemaFingerprint: "a".repeat(64),
      terminalEventHash: "0".repeat(64),
      issues: [],
    };
    worker.respond(request, report);
    await read;
    worker.respond(request, report);
    await turn();
    assert.throws(() => executor.quickIntegrity(), errorCode("WORKER_PROTOCOL_ERROR"));
  });

  it("poisons every post-open authority assertion failure", async () => {
    for (const code of [
      "PROJECT_ID_MISMATCH",
      "VAULT_ID_MISMATCH",
      "STORE_ID_MISMATCH",
      "PROJECT_BINDING_REQUIRED",
    ]) {
      const { executor, worker } = await fakeExecutor();
      const pending = executor.quickIntegrity();
      worker.fail(worker.posted.at(-1)!, code);
      await assert.rejects(pending, errorCode(code));
      await turn();
      assert.equal(worker.terminateCalls, 1, code);
      assert.throws(() => executor.quickIntegrity(), errorCode(code));
    }
  });

  it("rejects and poisons quick and full integrity reports from a foreign project or store", async () => {
    for (const mode of ["quick", "full"] as const) {
      for (const mismatch of ["projectId", "storeId"] as const) {
        const { executor, worker } = await fakeExecutor();
        const pending = mode === "quick"
          ? executor.quickIntegrity()
          : executor.fullIntegrity();
        const request = worker.posted.at(-1)!;
        worker.respond(request, {
          ok: true,
          mode,
          projectId: mismatch === "projectId"
            ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
            : PROJECT_ID,
          storeId: mismatch === "storeId"
            ? "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
            : STORE_ID,
          firstGlobalPosition: "0",
          lastGlobalPosition: "0",
          eventsVerified: 0,
          streamsVerified: 0,
          commandsVerified: 0,
          schemaFingerprint: "a".repeat(64),
          terminalEventHash: "0".repeat(64),
          issues: [],
        });
        const expectedCode = mismatch === "projectId"
          ? "PROJECT_ID_MISMATCH"
          : "STORE_ID_MISMATCH";

        await assert.rejects(pending, errorCode(expectedCode));
        await turn();
        assert.equal(worker.terminateCalls, 1, `${mode}:${mismatch}`);
        assert.throws(
          () => executor.quickIntegrity(),
          errorCode(expectedCode),
          `${mode}:${mismatch}`,
        );
      }
    }
  });

  it("rejects and poisons integrity reports with a mismatched mode or inconsistent status", async () => {
    const cases = [{
      requestedMode: "quick",
      reportMode: "full",
      ok: true,
      issues: [],
    }, {
      requestedMode: "full",
      reportMode: "quick",
      ok: true,
      issues: [],
    }, {
      requestedMode: "quick",
      reportMode: "quick",
      ok: true,
      issues: [{ code: "PROJECT_ID_MISMATCH", message: "foreign project" }],
    }, {
      requestedMode: "full",
      reportMode: "full",
      ok: false,
      issues: [],
    }] as const;

    for (const testCase of cases) {
      const { executor, worker } = await fakeExecutor();
      const pending = testCase.requestedMode === "quick"
        ? executor.quickIntegrity()
        : executor.fullIntegrity();
      worker.respond(worker.posted.at(-1)!, {
        ok: testCase.ok,
        mode: testCase.reportMode,
        projectId: PROJECT_ID,
        storeId: STORE_ID,
        firstGlobalPosition: "0",
        lastGlobalPosition: "0",
        eventsVerified: 0,
        streamsVerified: 0,
        commandsVerified: 0,
        schemaFingerprint: "a".repeat(64),
        terminalEventHash: "0".repeat(64),
        issues: testCase.issues,
      });

      await assert.rejects(pending, errorCode("WORKER_PROTOCOL_ERROR"));
      await turn();
      assert.equal(
        worker.terminateCalls,
        1,
        `${testCase.requestedMode}:${testCase.reportMode}:${testCase.ok}`,
      );
      assert.throws(
        () => executor.quickIntegrity(),
        errorCode("WORKER_PROTOCOL_ERROR"),
      );
    }
  });

  it("waits for pending reads and worker close acknowledgement before termination", async () => {
    const { executor, worker } = await fakeExecutor();
    const read = executor.quickIntegrity();
    const close = executor.close();
    assert.equal(worker.posted.some((request) => request.type === "close"), false);
    const readRequest = worker.posted.find((request) => request.type === "quickIntegrity")!;
    worker.respond(readRequest, {
      ok: true,
      mode: "quick",
      projectId: PROJECT_ID,
      storeId: STORE_ID,
      firstGlobalPosition: "0",
      lastGlobalPosition: "0",
      eventsVerified: 0,
      streamsVerified: 0,
      commandsVerified: 0,
      schemaFingerprint: "a".repeat(64),
      terminalEventHash: "0".repeat(64),
      issues: [],
    });
    await read;
    await turn();
    const closeRequest = worker.posted.find((request) => request.type === "close")!;
    worker.respond(closeRequest, { closed: true });
    await close;
    assert.equal(worker.terminateCalls, 1);
    assert.ok(worker.lifecycle.lastIndexOf("post") < worker.lifecycle.lastIndexOf("terminate"));
  });

  it("uses one bounded forced termination and makes repeated close idempotent", async () => {
    const { executor, worker, scheduler } = await fakeExecutor();
    const first = executor.close();
    const second = executor.close();
    assert.equal(second, first);
    await turn();
    assert.equal(worker.posted.some((request) => request.type === "close"), true);
    scheduler.runNext();
    await first;
    await executor.close();
    assert.equal(worker.terminateCalls, 1);
  });

  it("terminates and clears the close deadline after a negative close acknowledgement", async () => {
    const { executor, worker } = await fakeExecutor();
    const closing = executor.close();
    await turn();
    const closeRequest = worker.posted.find((request) => request.type === "close")!;
    worker.fail(closeRequest, "STORE_UNAVAILABLE");
    await assert.rejects(closing, errorCode("STORE_UNAVAILABLE"));
    assert.equal(worker.terminateCalls, 1);
    await assert.rejects(executor.close(), errorCode("STORE_UNAVAILABLE"));
  });

  it("never reports normal, forced, or poisoned close after termination rejects without exit", async () => {
    for (const mode of ["normal", "forced", "poisoned"] as const) {
      const context = contextFixture();
      writeFileSync(context.binding.storeRoute.eventsPath, "fixture", "utf8");
      const worker = new RejectingTerminationWorker();
      const scheduler = new ManualScheduler();
      const executor = new ProjectStoreExecutor({
        workerUrl: WORKER_URL,
        context,
        maxPending: DEFAULT_MAX_PENDING,
        requestTimeoutMs: 10_000,
        closeTimeoutMs: 5_000,
        executorLeaseMs: 15_000,
        heartbeatIntervalMs: 5_000,
      }, {
        workerFactory: () => worker,
        scheduler,
      });
      const opening = executor.open();
      worker.respond(worker.posted[0]!, openResult(context));
      await opening;

      let closing: Promise<void>;
      if (mode === "poisoned") {
        worker.emit("messageerror", new Error("malformed worker response"));
        await turn();
        closing = executor.close();
      } else {
        closing = executor.close();
        await turn();
        if (mode === "normal") {
          const closeRequest = worker.posted.find((request) => request.type === "close")!;
          worker.respond(closeRequest, { closed: true });
        } else {
          scheduler.runNext();
        }
      }

      await assert.rejects(closing, (error) => {
        assert.ok(error instanceof ProjectStoreWorkerError, mode);
        assert.equal(error.code, "WORKER_UNAVAILABLE", mode);
        assert.deepEqual(error.details, { terminationFailed: true }, mode);
        assert.equal(error.message, "WORKER_UNAVAILABLE", mode);
        return true;
      });
      assert.equal(worker.terminateCalls, 1, mode);
      assert.equal(executor.canReuse(), false, mode);
    }
  });

  it("keys reuse by canonical path, store, generation, and fingerprint and poisons rebinds", async () => {
    const context = contextFixture();
    writeFileSync(context.binding.storeRoute.eventsPath, "fixture", "utf8");
    const firstKey = projectStoreExecutorKey(context);
    const rebound: ProjectContext = {
      ...context,
      binding: {
        ...context.binding,
        generation: context.binding.generation + 1,
        contextFingerprint: "e".repeat(64),
      },
    };
    assert.notEqual(projectStoreExecutorKey(rebound), firstKey);
    const workers: FakeWorker[] = [];
    const registry = new ProjectStoreExecutorRegistry({
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
    });
    const options = {
      workerUrl: WORKER_URL,
      context,
      maxPending: DEFAULT_MAX_PENDING,
      requestTimeoutMs: 10_000,
      closeTimeoutMs: 5_000,
      executorLeaseMs: 15_000,
      heartbeatIntervalMs: 5_000,
    };
    await registry.acquire(options);
    const reboundStore = {
      ...rebound,
      binding: { ...rebound.binding, storeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as StoreId },
    };
    await registry.acquire({ ...options, context: reboundStore });
    assert.equal(workers.length, 2);
    assert.equal(workers[0]?.terminateCalls, 1);

    workers[1]?.emit("error", new Error("terminal exact-key executor"));
    await turn();
    await registry.acquire({ ...options, context: reboundStore });
    assert.equal(workers.length, 3);
  });
});

describe("primary SQLite busy retry", () => {
  it("retries normalized primary SQLITE_BUSY within the deadline", async () => {
    const sleepGate = deferred<void>();
    const order: string[] = [];
    let attempts = 0;
    const first = retryPrimarySqliteBusy(() => {
      attempts += 1;
      order.push(`first:${attempts}`);
      if (attempts === 1) throw new EventStoreError("SQLITE_BUSY", { retryable: true });
      return "done";
    }, {
      deadlineMs: 1_000,
      now: (() => { let now = 0; return () => now += 10; })(),
      sleep: async () => sleepGate.promise,
    });
    await turn();
    assert.deepEqual(order, ["first:1"]);
    sleepGate.resolve();
    assert.equal(await first, "done");
    assert.deepEqual(order, ["first:1", "first:2"]);
  });

  it("holds a later append behind a busy retry in the runtime FIFO", async () => {
    const context = contextFixture();
    const sleepGate = deferred<void>();
    const order: string[] = [];
    let attempts = 0;
    const backend: WorkerRuntimeBackend = {
      async dispatch(request) {
        if (request.type === "open") return openResult(context);
        if (request.type === "append" && request.command.idempotencyKey === "task-11-command") {
          await retryPrimarySqliteBusy(() => {
            attempts += 1;
            order.push(`first:${attempts}`);
            if (attempts === 1) throw new EventStoreError("SQLITE_BUSY", { retryable: true });
            return true;
          }, {
            deadlineMs: 1_000,
            now: (() => { let now = 0; return () => now += 10; })(),
            sleep: async () => sleepGate.promise,
          });
        } else if (request.type === "append") {
          order.push("second");
        }
        return { closed: true };
      },
      async heartbeat() { return { mode: "idle" }; },
      async quiesceAndClose() { throw new Error("not expected"); },
      async quiesceObservedAndClose() { throw new Error("not expected"); },
      async close() {},
    };
    const runtime = new ProjectStoreWorkerRuntime({
      backend,
      port: { postMessage() {}, close() {} },
      scheduler: { setInterval() { return {}; }, clearInterval() {} },
      heartbeatIntervalMs: 5_000,
    });
    runtime.receive({ id: "open", type: "open", binding: workerBinding(context) });
    await turn();
    const firstCommand = appendCommand(context);
    const secondCommand = {
      ...firstCommand,
      commandId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      idempotencyKey: "task-11-command-second",
    };
    runtime.receive({
      id: "first",
      type: "append",
      binding: encodeWorkerBindingAssertion(context),
      command: encodeAppendCommandWire(firstCommand),
    });
    runtime.receive({
      id: "second",
      type: "append",
      binding: encodeWorkerBindingAssertion(context),
      command: encodeAppendCommandWire(secondCommand),
    });
    await turn();
    assert.deepEqual(order, ["first:1"]);
    sleepGate.resolve();
    await turn();
    await turn();
    assert.deepEqual(order, ["first:1", "first:2", "second"]);
  });

  it("does not retry constraint, corruption, identity, or unknown failures", async () => {
    for (const error of [
      new EventStoreError("IDEMPOTENCY_CONFLICT"),
      new EventStoreError("INTEGRITY_FAILURE"),
      new EventStoreError("PROJECT_IDENTITY_MISMATCH"),
      new Error("unknown"),
    ]) {
      let attempts = 0;
      await assert.rejects(retryPrimarySqliteBusy(() => {
        attempts += 1;
        throw error;
      }, { deadlineMs: 1_000 }), (observed) => observed === error);
      assert.equal(attempts, 1);
    }
  });

  it("stops without sleeping once the busy deadline is exhausted", async () => {
    let attempts = 0;
    let sleeps = 0;
    await assert.rejects(retryPrimarySqliteBusy(() => {
      attempts += 1;
      throw new EventStoreError("SQLITE_BUSY", { retryable: true });
    }, {
      deadlineMs: 20,
      now: (() => { const values = [0, 20]; return () => values.shift() ?? 20; })(),
      sleep: async () => { sleeps += 1; },
    }), (error) => error instanceof EventStoreError && error.code === "SQLITE_BUSY");
    assert.equal(attempts, 1);
    assert.equal(sleeps, 0);
  });
});

describe("ProjectStoreWorkerRuntime FIFO and heartbeat", () => {
  it("keeps heartbeat responsive during stalled full integrity and closes every handle before notification", async () => {
    const context = contextFixture();
    const full = deferred<WorkerSuccessData>();
    const lifecycle: string[] = [];
    const posted: unknown[] = [];
    let heartbeat: (() => void) | undefined;
    const scheduler: WorkerRuntimeScheduler = {
      setInterval(callback) {
        heartbeat = callback;
        return {};
      },
      clearInterval() {},
    };
    const port: WorkerRuntimePort = {
      postMessage(value) {
        posted.push(value);
      },
      close() {
        lifecycle.push("port-close");
      },
    };
    const backend: WorkerRuntimeBackend = {
      async dispatch(request) {
        lifecycle.push(`dispatch:${request.type}`);
        if (request.type === "open") return openResult(context);
        if (request.type === "fullIntegrity") return full.promise;
        return { closed: true };
      },
      async heartbeat() {
        lifecycle.push("heartbeat");
        return {
          mode: "quiescing",
          lease: {
            epoch: "9",
            fencingToken: "9",
            ownerId: "maintenance-owner",
            leaseExpiresAt: "2026-07-13T02:10:00.000Z",
          },
        };
      },
      async quiesceAndClose() {
        lifecycle.push("child-close");
        lifecycle.push("store-close");
        return {
          executorId: openResult(context).executorId,
          epoch: "9",
          fencingToken: "9",
        };
      },
      async quiesceObservedAndClose() {
        lifecycle.push("child-close");
        lifecycle.push("store-close");
        return {
          executorId: openResult(context).executorId,
          epoch: "9",
          fencingToken: "9",
        };
      },
      async close() {
        lifecycle.push("store-close");
      },
    };
    const runtime = new ProjectStoreWorkerRuntime({
      backend,
      port,
      scheduler,
      heartbeatIntervalMs: 5_000,
    });
    runtime.receive({ id: "open", type: "open", binding: workerBinding(context) });
    await turn();
    runtime.receive({
      id: "full",
      type: "fullIntegrity",
      binding: encodeWorkerBindingAssertion(context),
    });
    await turn();
    assert.equal(lifecycle.includes("dispatch:fullIntegrity"), true);
    heartbeat?.();
    await turn();
    assert.equal(lifecycle.includes("heartbeat"), true);
    assert.equal(lifecycle.includes("store-close"), false);
    assert.equal(posted.some((value) => (value as { type?: string }).type === "quiesced"), false);

    full.resolve({
      ok: true,
      mode: "full",
      projectId: PROJECT_ID,
      storeId: STORE_ID,
      firstGlobalPosition: "0",
      lastGlobalPosition: "0",
      eventsVerified: 0,
      streamsVerified: 0,
      commandsVerified: 0,
      schemaFingerprint: "a".repeat(64),
      terminalEventHash: "0".repeat(64),
      issues: [],
    });
    await turn();
    await turn();
    const notificationIndex = posted.findIndex(
      (value) => (value as { type?: string }).type === "quiesced",
    );
    assert.notEqual(notificationIndex, -1);
    assert.ok(lifecycle.indexOf("child-close") < lifecycle.indexOf("store-close"));
    assert.ok(lifecycle.indexOf("store-close") < lifecycle.indexOf("port-close"));
  });

  it("keeps heartbeat responsive while quick integrity is stalled", async () => {
    const context = contextFixture();
    const quick = deferred<WorkerSuccessData>();
    const lifecycle: string[] = [];
    const posted: unknown[] = [];
    let heartbeat: (() => void) | undefined;
    const backend: WorkerRuntimeBackend = {
      async dispatch(request) {
        if (request.type === "open") return openResult(context);
        if (request.type === "quickIntegrity") return quick.promise;
        return { closed: true };
      },
      async heartbeat() {
        lifecycle.push("heartbeat");
        return {
          mode: "quiescing",
          lease: {
            epoch: "10",
            fencingToken: "10",
            ownerId: "maintenance-owner",
            leaseExpiresAt: "2026-07-13T02:10:00.000Z",
          },
        };
      },
      async quiesceAndClose() {
        throw new Error("explicit quiesce not expected");
      },
      async quiesceObservedAndClose() {
        lifecycle.push("closed");
        return {
          executorId: openResult(context).executorId,
          epoch: "10",
          fencingToken: "10",
        };
      },
      async close() {
        lifecycle.push("closed");
      },
    };
    const runtime = new ProjectStoreWorkerRuntime({
      backend,
      port: {
        postMessage(value) { posted.push(value); },
        close() { lifecycle.push("port-close"); },
      },
      scheduler: {
        setInterval(callback) { heartbeat = callback; return {}; },
        clearInterval() {},
      },
      heartbeatIntervalMs: 5_000,
    });
    runtime.receive({ id: "open", type: "open", binding: workerBinding(context) });
    await turn();
    runtime.receive({
      id: "quick",
      type: "quickIntegrity",
      binding: encodeWorkerBindingAssertion(context),
      tailLimit: 256,
    });
    await turn();
    heartbeat?.();
    await turn();
    assert.deepEqual(lifecycle, ["heartbeat"]);
    assert.equal(posted.some((value) => (value as { type?: string }).type === "quiesced"), false);
    quick.resolve({
      ok: true,
      mode: "quick",
      projectId: PROJECT_ID,
      storeId: STORE_ID,
      firstGlobalPosition: "0",
      lastGlobalPosition: "0",
      eventsVerified: 0,
      streamsVerified: 0,
      commandsVerified: 0,
      schemaFingerprint: "a".repeat(64),
      terminalEventHash: "0".repeat(64),
      issues: [],
    });
    await turn();
    await turn();
    assert.equal(lifecycle.includes("closed"), true);
    assert.equal(posted.some((value) => (value as { type?: string }).type === "quiesced"), true);
  });
});

async function realContext(): Promise<ProjectContext> {
  const root = temporaryRoot();
  const projectRoot = resolve(root, "project");
  const vaultRoot = resolve(projectRoot, "memory");
  mkdirSync(vaultRoot, { recursive: true });
  const initialized = await new DefaultProjectStoreBootstrapService().initialize({
    projectRoot,
    vaultRoot,
  });
  const workspace = {
    kind: "non-git" as const,
    workspaceRoot: projectRoot,
    workspaceId: deriveNonGitWorkspaceId(
      initialized.descriptor.projectId,
      initialized.descriptor.vaultId,
    ),
  };
  const withoutPrivate: Omit<
    ProjectBinding,
    "contextFingerprint" | "projectBindingId" | "establishedAt"
  > = {
    generation: 1,
    source: "explicit-cli",
    projectId: initialized.descriptor.projectId,
    vaultId: initialized.descriptor.vaultId,
    storeId: initialized.manifest.storeId,
    workspaceId: workspace.workspaceId,
    clientNamespace: "codex",
    clientInstanceId: "integration-client",
    actorRole: "primary",
    projectRoot,
    vaultRoot,
    descriptorPath: join(vaultRoot, ".memory-mcp", "project-identity.json"),
    storeRoute: initialized.route,
    workspace,
  };
  const binding: ProjectBinding = {
    ...withoutPrivate,
    projectBindingId: randomUUID(),
    contextFingerprint: computeProjectContextFingerprint(withoutPrivate),
    establishedAt: new Date().toISOString(),
  };
  return { binding, workspace, checkedAt: new Date().toISOString() };
}

describe("real project-store worker", () => {
  it("one-shot verify and inspect close their database before resolving", async () => {
    const context = await realContext();
    const probe = new WorkerProjectStoreIdentityProbe({
      workerUrl: WORKER_URL,
      requestTimeoutMs: 10_000,
    });
    await probe.verify(context.binding.storeRoute, {
      projectId: context.binding.projectId,
      vaultId: context.binding.vaultId,
      storeId: context.binding.storeId,
    });
    const inspected = await probe.inspectExisting(context.binding.storeRoute, {
      projectId: context.binding.projectId,
      vaultId: context.binding.vaultId,
    });
    assert.deepEqual(inspected, {
      projectId: context.binding.projectId,
      vaultId: context.binding.vaultId,
      storeId: context.binding.storeId,
    });
    await assert.rejects(probe.verify(context.binding.storeRoute, {
      projectId: context.binding.projectId,
      vaultId: context.binding.vaultId,
      storeId: "99999999-9999-4999-8999-999999999999" as StoreId,
    }));
    const moved = `${context.binding.storeRoute.eventsPath}.moved`;
    renameSync(context.binding.storeRoute.eventsPath, moved);
    renameSync(moved, context.binding.storeRoute.eventsPath);
  });

  it("pings, opens without mutating content, appends/replays decimals, verifies, and releases handles", async () => {
    const context = await realContext();
    const before = new DatabaseSync(context.binding.storeRoute.eventsPath, { readOnly: true });
    const beforeCounts = {
      events: before.prepare("SELECT count(*) AS count FROM events").get()?.count,
      commands: before.prepare("SELECT count(*) AS count FROM command_dedup").get()?.count,
      migrations: before.prepare("SELECT count(*) AS count FROM schema_migrations").get()?.count,
    };
    before.close();

    const executor = new ProjectStoreExecutor({
      workerUrl: WORKER_URL,
      context,
      maxPending: DEFAULT_MAX_PENDING,
      requestTimeoutMs: 15_000,
      closeTimeoutMs: 5_000,
      executorLeaseMs: 15_000,
      heartbeatIntervalMs: 5_000,
    });
    const ping = await executor.ping();
    assert.match(ping.nodeVersion, /^\d+\.\d+\.\d+$/);
    assert.match(ping.sqliteVersion, /^\d+\.\d+\.\d+$/);
    assert.equal(ping.walSafe, true);
    const opened = await executor.open();
    assert.equal(opened.storeId, context.binding.storeId);
    assert.equal(opened.contextFingerprint, context.binding.contextFingerprint);

    const afterOpen = new DatabaseSync(context.binding.storeRoute.eventsPath, { readOnly: true });
    assert.deepEqual({
      events: afterOpen.prepare("SELECT count(*) AS count FROM events").get()?.count,
      commands: afterOpen.prepare("SELECT count(*) AS count FROM command_dedup").get()?.count,
      migrations: afterOpen.prepare("SELECT count(*) AS count FROM schema_migrations").get()?.count,
    }, beforeCounts);
    afterOpen.close();

    const command = appendCommand(context);
    const first = await executor.append(command);
    assert.equal(first.firstGlobalPosition, 1n);
    assert.equal(first.finalStreamVersion, 1n);
    assert.equal((await executor.quickIntegrity()).ok, true);
    assert.equal((await executor.fullIntegrity()).ok, true);
    await executor.close();

    // Recovery after an ambiguous/lost parent response must reuse the exact
    // command identity through a newly revalidated executor.
    const recovered = new ProjectStoreExecutor({
      workerUrl: WORKER_URL,
      context,
      maxPending: DEFAULT_MAX_PENDING,
      requestTimeoutMs: 15_000,
      closeTimeoutMs: 5_000,
      executorLeaseMs: 15_000,
      heartbeatIntervalMs: 5_000,
    });
    await recovered.open();
    const replay = await recovered.append(command);
    assert.equal(replay.deduplicated, true);
    assert.deepEqual(replay.response, first.response);
    assert.equal(replay.responseHash, first.responseHash);
    await recovered.close();

    const moved = `${context.binding.storeRoute.eventsPath}.closed`;
    renameSync(context.binding.storeRoute.eventsPath, moved);
    rmSync(moved, { force: true });
  });

  it("autonomously observes a foreign maintenance epoch, drains, acknowledges, and closes", async () => {
    const context = await realContext();
    const connection = new NodeSqliteDriver({ DatabaseSync }).open(
      context.binding.storeRoute.eventsPath,
      { mode: "existing", busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS },
    );
    const fence = new MaintenanceFence();
    let ownerConfirmations = 0;
    const executor = new ProjectStoreExecutor({
      workerUrl: WORKER_URL,
      context,
      maxPending: DEFAULT_MAX_PENDING,
      requestTimeoutMs: 15_000,
      closeTimeoutMs: 5_000,
      executorLeaseMs: 15_000,
      heartbeatIntervalMs: 25,
    }, {
      confirmMaintenanceClosure: async (confirmation) => {
        ownerConfirmations += 1;
        connection.exec("BEGIN IMMEDIATE");
        try {
          fence.confirmExecutorClosed(
            connection,
            confirmation.lease,
            confirmation.projectId,
            confirmation.executorId,
            new Date().toISOString(),
          );
          connection.exec("COMMIT");
        } catch (error) {
          connection.exec("ROLLBACK");
          throw error;
        }
      },
    });
    await executor.open();
    const acquiredAt = new Date().toISOString();
    connection.exec("BEGIN IMMEDIATE");
    const lease = fence.acquire(
      connection,
      "external-maintenance",
      new Date(Date.now() + 60_000).toISOString(),
      acquiredAt,
    );
    connection.exec("COMMIT");

    let closedAndAcknowledged = false;
    for (let attempt = 0; attempt < 100 && !closedAndAcknowledged; attempt += 1) {
      await delay(20);
      connection.exec("BEGIN DEFERRED");
      try {
        closedAndAcknowledged = fence.allRequiredExecutorsAcknowledged(connection, lease);
        connection.exec("ROLLBACK");
      } catch (error) {
        try { connection.exec("ROLLBACK"); } catch { /* preserve assertion */ }
        throw error;
      }
    }
    assert.equal(closedAndAcknowledged, true);
    assert.equal(ownerConfirmations, 1);
    assert.throws(() => executor.quickIntegrity(), errorCode("WORKER_CLOSED"));

    const releasedAt = new Date().toISOString();
    connection.exec("BEGIN IMMEDIATE");
    fence.release(connection, lease, true, releasedAt);
    connection.exec("COMMIT");
    connection.close();
    await executor.close();
    const moved = `${context.binding.storeRoute.eventsPath}.quiesced`;
    renameSync(context.binding.storeRoute.eventsPath, moved);
    renameSync(moved, context.binding.storeRoute.eventsPath);
  });

  it("recovers a committed append whose parent response was lost using the exact command identity", async () => {
    const context = await realContext();
    let transport!: DropCommittedAppendResponseWorker;
    const uncertain = new ProjectStoreExecutor({
      workerUrl: WORKER_URL,
      context,
      maxPending: DEFAULT_MAX_PENDING,
      requestTimeoutMs: 15_000,
      closeTimeoutMs: 5_000,
      executorLeaseMs: 15_000,
      heartbeatIntervalMs: 5_000,
    }, {
      workerFactory(workerUrl, options) {
        transport = new DropCommittedAppendResponseWorker(workerUrl, options.workerData);
        return transport;
      },
    });
    await uncertain.open();
    const command = appendCommand(context);
    await assert.rejects(uncertain.append(command), (error) => {
      assert.ok(error instanceof ProjectStoreWorkerError);
      assert.equal(error.code, "COMMAND_OUTCOME_UNKNOWN");
      assert.deepEqual(error.details, {
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
      });
      return true;
    });
    assert.equal(transport.dropped, true);

    const committed = new DatabaseSync(context.binding.storeRoute.eventsPath, { readOnly: true });
    const stored = committed.prepare(`
      SELECT response_json, response_hash
      FROM command_dedup
      WHERE project_id = ? AND idempotency_key = ?
    `).get(context.binding.projectId, command.idempotencyKey) as {
      response_json: string;
      response_hash: string;
    } | undefined;
    assert.ok(stored);
    const storedResponse = JSON.parse(stored.response_json) as {
      eventIds: string[];
      response: JsonValue;
    };
    assert.equal(committed.prepare("SELECT count(*) AS count FROM events").get()?.count, 1);
    assert.equal(committed.prepare("SELECT count(*) AS count FROM command_dedup").get()?.count, 1);
    committed.close();

    const recovered = new ProjectStoreExecutor({
      workerUrl: WORKER_URL,
      context,
      maxPending: DEFAULT_MAX_PENDING,
      requestTimeoutMs: 15_000,
      closeTimeoutMs: 5_000,
      executorLeaseMs: 15_000,
      heartbeatIntervalMs: 5_000,
    });
    await recovered.open();
    const replay = await recovered.append(command);
    assert.equal(replay.deduplicated, true);
    assert.deepEqual(replay.eventIds, storedResponse.eventIds);
    assert.deepEqual(replay.response, storedResponse.response);
    assert.equal(replay.responseHash, stored.response_hash);
    await recovered.close();

    const verified = new DatabaseSync(context.binding.storeRoute.eventsPath, { readOnly: true });
    assert.equal(verified.prepare("SELECT count(*) AS count FROM events").get()?.count, 1);
    assert.equal(verified.prepare("SELECT count(*) AS count FROM command_dedup").get()?.count, 1);
    verified.close();
  });
});

describe("ProjectStoreWorkerBackend open identity", () => {
  it("disposes an uncertain append connection before returning exact recovery IDs", async () => {
    const context = await realContext();
    const backend = new ProjectStoreWorkerBackend({
      selfUrl: WORKER_URL,
      executorLeaseMs: 15_000,
      appendRetryDeadlineMs: 10_000,
      eventStoreFactory: () => ({
        append<T extends JsonValue>(command: AppendCommand<T>): never {
          throw new EventStoreError("COMMAND_OUTCOME_UNKNOWN", {
            commandId: command.commandId,
            idempotencyKey: command.idempotencyKey,
          });
        },
      }) as unknown as EventStore,
    });
    await backend.dispatch({
      id: "open-uncertain-append",
      type: "open",
      binding: encodeWorkerBinding(context),
    });
    const command = appendCommand(context);

    await assert.rejects(backend.dispatch({
      id: "uncertain-append",
      type: "append",
      binding: encodeWorkerBindingAssertion(context),
      command: encodeAppendCommandWire(command),
    }), (error) => {
      assert.ok(error instanceof EventStoreError);
      assert.equal(error.code, "COMMAND_OUTCOME_UNKNOWN");
      assert.deepEqual(error.details, {
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
      });
      return true;
    });
    await assert.rejects(backend.heartbeat(), (error) => (
      error instanceof ProjectStoreWorkerBackendError
      && error.code === "WORKER_CLOSED"
    ));
    await backend.close();

    const moved = `${context.binding.storeRoute.eventsPath}.unknown-disposed`;
    renameSync(context.binding.storeRoute.eventsPath, moved);
    renameSync(moved, context.binding.storeRoute.eventsPath);
  });

  async function workerOwnedPublicationFault(
    mode: "transient" | "persistent",
  ): Promise<{
    outcome: string;
    readinessObservations: boolean[];
    closeAttempts: number;
    leakedBeforeCleanup: boolean;
    readyAfterBackendClose: boolean;
  }> {
    const context = await realContext();
    const observer = new NodeSqliteDriver({ DatabaseSync }).open(
      context.binding.storeRoute.eventsPath,
      { mode: "existing", busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS },
    );
    const observerFence = new MaintenanceFence();
    let lease: ReturnType<MaintenanceFence["acquire"]> | undefined;
    class ObservedMarkerCloseFence extends MaintenanceFence {
      readonly readinessObservations: boolean[] = [];
      closeAttempts = 0;
      markerOpen = false;
      forceRelease: (() => void) | undefined;

      override closeExecutor(
        ...parameters: Parameters<MaintenanceFence["closeExecutor"]>
      ): void {
        super.closeExecutor(...parameters);
        const [connection] = parameters;
        const physicalClose = connection.close.bind(connection);
        this.markerOpen = true;
        this.forceRelease = () => {
          this.markerOpen = false;
          physicalClose();
        };
        connection.close = () => {
          this.closeAttempts += 1;
          assert.ok(lease);
          this.readinessObservations.push(maintenanceReady(observer, observerFence, lease));
          if (mode === "transient" && this.closeAttempts > 1) {
            this.markerOpen = false;
            physicalClose();
            return;
          }
          throw new Error(`${mode} marker close failed`);
        };
      }
    }
    const workerFence = new ObservedMarkerCloseFence();
    const backend = new ProjectStoreWorkerBackend({
      selfUrl: WORKER_URL,
      executorLeaseMs: 15_000,
      appendRetryDeadlineMs: 10_000,
      maintenanceFactory: () => workerFence,
    });
    const opened = await backend.dispatch({
      id: `open-${mode}-publisher-close`,
      type: "open",
      binding: encodeWorkerBinding(context),
    }) as WorkerOpenResult;
    const acquiredAt = new Date().toISOString();
    observer.exec("BEGIN IMMEDIATE");
    lease = observerFence.acquire(
      observer,
      `${mode}-publisher-close`,
      new Date(Date.now() + 60_000).toISOString(),
      acquiredAt,
    );
    observer.exec("COMMIT");

    const outcome = await backend.quiesceAndClose(
      encodeMaintenanceLeaseWire(lease),
      encodeWorkerBindingAssertion(context),
    ).then(
      () => "resolved",
      (error: unknown) => error instanceof Error ? error.message : "unknown",
    );
    const readyAfterBackendClose = maintenanceReady(observer, observerFence, lease);
    const leakedBeforeCleanup = workerFence.markerOpen;
    try { workerFence.forceRelease?.(); } catch { /* transient close may already have released it */ }
    observer.close();
    const moved = `${context.binding.storeRoute.eventsPath}.${mode}-publisher-close`;
    renameSync(context.binding.storeRoute.eventsPath, moved);
    renameSync(moved, context.binding.storeRoute.eventsPath);

    assert.equal(opened.executorId.length > 0, true);
    return {
      outcome,
      readinessObservations: workerFence.readinessObservations,
      closeAttempts: workerFence.closeAttempts,
      leakedBeforeCleanup,
      readyAfterBackendClose,
    };
  }

  it("revalidates identity on the actual writable handle after a file swap", async () => {
    const expected = await realContext();
    const foreign = await realContext();
    const expectedPath = expected.binding.storeRoute.eventsPath;
    const backupPath = `${expectedPath}.expected`;
    let swapped = false;
    const backend = new ProjectStoreWorkerBackend({
      selfUrl: WORKER_URL,
      executorLeaseMs: 15_000,
      appendRetryDeadlineMs: 10_000,
      afterReadOnlyIdentityVerified() {
        renameSync(expectedPath, backupPath);
        copyFileSync(foreign.binding.storeRoute.eventsPath, expectedPath);
        swapped = true;
      },
    });
    await assert.rejects(backend.dispatch({
      id: "open-swap",
      type: "open",
      binding: encodeWorkerBinding(expected),
    }), (error) => {
      assert.ok(error instanceof ProjectStoreWorkerBackendError);
      assert.equal(error.code, "PROJECT_ID_MISMATCH");
      return true;
    });
    assert.equal(swapped, true);
    const moved = `${expectedPath}.released`;
    renameSync(expectedPath, moved);
    renameSync(moved, expectedPath);
    await backend.close();
  });

  it("keeps a failing integrity child tracked until termination before closing SQLite", async () => {
    const context = await realContext();
    const child = new DeferredTerminationWorker();
    const backend = new ProjectStoreWorkerBackend({
      selfUrl: WORKER_URL,
      executorLeaseMs: 15_000,
      appendRetryDeadlineMs: 10_000,
      integrityWorkerFactory: () => child,
    });
    await backend.dispatch({
      id: "open-child-failure",
      type: "open",
      binding: encodeWorkerBinding(context),
    });
    const integrity = backend.dispatch({
      id: "full-child-failure",
      type: "fullIntegrity",
      binding: encodeWorkerBindingAssertion(context),
    });
    child.emit("messageerror", new Error("malformed child response"));
    let closeSettled = false;
    const closing = backend.close().finally(() => { closeSettled = true; });
    await turn();
    assert.equal(closeSettled, false);
    child.termination.resolve(1);
    await assert.rejects(integrity, (error) => (
      error instanceof ProjectStoreWorkerBackendError
      && error.code === "WORKER_PROTOCOL_ERROR"
    ));
    await closing;
    const moved = `${context.binding.storeRoute.eventsPath}.child-closed`;
    renameSync(context.binding.storeRoute.eventsPath, moved);
    renameSync(moved, context.binding.storeRoute.eventsPath);
  });

  it("keeps a child tracked and rejects every close retry when termination has no exit proof", async () => {
    const context = await realContext();
    const child = new RejectingTerminationWorker();
    const backend = new ProjectStoreWorkerBackend({
      selfUrl: WORKER_URL,
      executorLeaseMs: 15_000,
      appendRetryDeadlineMs: 10_000,
      integrityWorkerFactory: () => child,
    });
    await backend.dispatch({
      id: "open-rejecting-child",
      type: "open",
      binding: encodeWorkerBinding(context),
    });
    const integrity = backend.dispatch({
      id: "full-rejecting-child",
      type: "fullIntegrity",
      binding: encodeWorkerBindingAssertion(context),
    });

    try {
      child.emit("messageerror", new Error("malformed child response"));
      await assert.rejects(integrity, (error) => {
        assert.ok(error instanceof ProjectStoreWorkerBackendError);
        assert.equal(error.code, "WORKER_UNAVAILABLE");
        assert.deepEqual(error.details, { terminationFailed: true });
        return true;
      });
      assert.equal(child.terminateCalls, 1);

      for (const expectedCalls of [2, 3]) {
        await assert.rejects(backend.close(), (error) => {
          assert.ok(error instanceof ProjectStoreWorkerBackendError);
          assert.equal(error.code, "WORKER_UNAVAILABLE");
          assert.deepEqual(error.details, { terminationFailed: true });
          return true;
        });
        assert.equal(child.terminateCalls, expectedCalls);
      }
    } finally {
      child.emit("exit", 1);
      await backend.close();
    }

    const moved = `${context.binding.storeRoute.eventsPath}.rejecting-child-released`;
    renameSync(context.binding.storeRoute.eventsPath, moved);
    renameSync(moved, context.binding.storeRoute.eventsPath);
  });

  it("emits only failure when quiesce cannot prove integrity-child termination", async () => {
    const context = await realContext();
    const child = new RejectingTerminationWorker();
    const backend = new ProjectStoreWorkerBackend({
      selfUrl: WORKER_URL,
      executorLeaseMs: 15_000,
      appendRetryDeadlineMs: 10_000,
      integrityWorkerFactory: () => child,
    });
    await backend.dispatch({
      id: "open-quiesce-rejecting-child",
      type: "open",
      binding: encodeWorkerBinding(context),
    });
    const integrity = backend.dispatch({
      id: "full-quiesce-rejecting-child",
      type: "fullIntegrity",
      binding: encodeWorkerBindingAssertion(context),
    });
    child.emit("messageerror", new Error("malformed child response"));
    await assert.rejects(integrity, (error) => (
      error instanceof ProjectStoreWorkerBackendError
      && error.code === "WORKER_UNAVAILABLE"
      && error.details.terminationFailed === true
    ));

    const observer = new NodeSqliteDriver({ DatabaseSync }).open(
      context.binding.storeRoute.eventsPath,
      { mode: "existing", busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS },
    );
    const fence = new MaintenanceFence();
    const acquiredAt = new Date().toISOString();
    observer.exec("BEGIN IMMEDIATE");
    const lease = fence.acquire(
      observer,
      "rejecting-child-maintenance",
      new Date(Date.now() + 60_000).toISOString(),
      acquiredAt,
    );
    observer.exec("COMMIT");

    const posted: unknown[] = [];
    const portClosed = deferred<void>();
    const runtime = new ProjectStoreWorkerRuntime({
      backend,
      port: {
        postMessage(value) { posted.push(value); },
        close() { portClosed.resolve(); },
      },
      scheduler: {
        setInterval() { return {}; },
        clearInterval() {},
      },
      heartbeatIntervalMs: 5_000,
    });

    try {
      runtime.receive({
        id: "quiesce-rejecting-child",
        type: "quiesce",
        binding: encodeWorkerBindingAssertion(context),
        lease: encodeMaintenanceLeaseWire(lease),
      });
      await portClosed.promise;

      assert.deepEqual(posted, [{
        id: "quiesce-rejecting-child",
        ok: false,
        error: {
          code: "WORKER_UNAVAILABLE",
          message: "WORKER_UNAVAILABLE",
          details: { terminationFailed: true },
        },
      }]);
      assert.equal(
        posted.some((value) => (
          typeof value === "object"
          && value !== null
          && "connectionClosed" in value
          && value.connectionClosed === true
        )),
        false,
      );
      assert.equal(child.terminateCalls, 2);
    } finally {
      child.emit("exit", 1);
      await backend.close();
      observer.close();
    }

    const moved = `${context.binding.storeRoute.eventsPath}.quiesce-child-released`;
    renameSync(context.binding.storeRoute.eventsPath, moved);
    renameSync(moved, context.binding.storeRoute.eventsPath);
  });

  it("does not publish normal-close readiness before the primary handle is released", async () => {
    const context = await realContext();
    const observer = new NodeSqliteDriver({ DatabaseSync }).open(
      context.binding.storeRoute.eventsPath,
      { mode: "existing", busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS },
    );
    const observerFence = new MaintenanceFence();
    const readinessObservations: boolean[] = [];
    let closeExecutorCalls = 0;
    class ConcurrentAcquireFence extends MaintenanceFence {
      override closeExecutor(
        ...parameters: Parameters<MaintenanceFence["closeExecutor"]>
      ): void {
        closeExecutorCalls += 1;
        super.closeExecutor(...parameters);
        const [connection] = parameters;
        const physicalClose = connection.close.bind(connection);
        connection.close = () => {
          const acquiredAt = new Date().toISOString();
          observer.exec("BEGIN IMMEDIATE");
          const lease = observerFence.acquire(
            observer,
            "concurrent-normal-close",
            new Date(Date.now() + 60_000).toISOString(),
            acquiredAt,
          );
          observer.exec("COMMIT");
          readinessObservations.push(maintenanceReady(observer, observerFence, lease));
          physicalClose();
        };
      }
    }
    const backend = new ProjectStoreWorkerBackend({
      selfUrl: WORKER_URL,
      executorLeaseMs: 15_000,
      appendRetryDeadlineMs: 10_000,
      maintenanceFactory: () => new ConcurrentAcquireFence(),
    });
    await backend.dispatch({
      id: "open-normal-close-ordering",
      type: "open",
      binding: encodeWorkerBinding(context),
    });
    await backend.close();
    observer.close();
    const moved = `${context.binding.storeRoute.eventsPath}.normal-close-ordering`;
    renameSync(context.binding.storeRoute.eventsPath, moved);
    renameSync(moved, context.binding.storeRoute.eventsPath);

    assert.equal(closeExecutorCalls, 0);
    assert.deepEqual(readinessObservations, []);
  });

  it("keeps worker-owned readiness hidden after integrity children and the primary handle close", async () => {
    const context = await realContext();
    const child = new DeferredTerminationWorker();
    const backend = new ProjectStoreWorkerBackend({
      selfUrl: WORKER_URL,
      executorLeaseMs: 15_000,
      appendRetryDeadlineMs: 10_000,
      integrityWorkerFactory: () => child,
    });
    const opened = await backend.dispatch({
      id: "open-maintenance-ordering",
      type: "open",
      binding: encodeWorkerBinding(context),
    }) as WorkerOpenResult;
    const integrity = backend.dispatch({
      id: "full-maintenance-ordering",
      type: "fullIntegrity",
      binding: encodeWorkerBindingAssertion(context),
    });
    const integrityFailure = assert.rejects(integrity, (error) => (
      error instanceof ProjectStoreWorkerBackendError
      && error.code === "WORKER_UNAVAILABLE"
    ));
    const observer = new NodeSqliteDriver({ DatabaseSync }).open(
      context.binding.storeRoute.eventsPath,
      { mode: "existing", busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS },
    );
    const fence = new MaintenanceFence();
    const acquiredAt = new Date().toISOString();
    observer.exec("BEGIN IMMEDIATE");
    const lease = fence.acquire(
      observer,
      "maintenance-ordering",
      new Date(Date.now() + 60_000).toISOString(),
      acquiredAt,
    );
    observer.exec("COMMIT");

    const closing = backend.quiesceAndClose(
      encodeMaintenanceLeaseWire(lease),
      encodeWorkerBindingAssertion(context),
    );
    await turn();
    const terminateCallsWhileClosing = child.terminateCalls;
    const acknowledgementCountWhileClosing = observer.prepare(`
      SELECT count(*) AS count
      FROM maintenance_acknowledgements
      WHERE epoch = $epoch
        AND executor_id = $executorId
        AND fencing_token = $fencingToken
    `).get({
      $epoch: lease.epoch,
      $executorId: opened.executorId,
      $fencingToken: lease.fencingToken,
    })?.count;
    const closedAtWhileClosing = observer.prepare(`
      SELECT closed_at
      FROM executor_leases
      WHERE project_id = $projectId AND executor_id = $executorId
    `).get({
      $projectId: context.binding.projectId,
      $executorId: opened.executorId,
    })?.closed_at;
    observer.exec("BEGIN DEFERRED");
    const readyWhileClosing = fence.allRequiredExecutorsAcknowledged(observer, lease);
    observer.exec("ROLLBACK");

    child.emit("exit", 1);
    child.termination.resolve(1);
    await integrityFailure;
    await closing;

    observer.exec("BEGIN DEFERRED");
    const readyAfterClosing = fence.allRequiredExecutorsAcknowledged(observer, lease);
    observer.exec("ROLLBACK");
    observer.close();

    const moved = `${context.binding.storeRoute.eventsPath}.maintenance-ready`;
    renameSync(context.binding.storeRoute.eventsPath, moved);
    renameSync(moved, context.binding.storeRoute.eventsPath);

    assert.equal(terminateCallsWhileClosing, 1);
    assert.equal(acknowledgementCountWhileClosing, 1n);
    assert.equal(closedAtWhileClosing, null);
    assert.equal(readyWhileClosing, false);
    assert.equal(readyAfterClosing, false);
  });

  it("never exposes worker readiness through a transient publisher close failure", async () => {
    assert.deepEqual(await workerOwnedPublicationFault("transient"), {
      outcome: "resolved",
      readinessObservations: [],
      closeAttempts: 0,
      leakedBeforeCleanup: false,
      readyAfterBackendClose: false,
    });
  });

  it("never creates a persistent publisher handle that requires post-hoc cleanup", async () => {
    assert.deepEqual(await workerOwnedPublicationFault("persistent"), {
      outcome: "resolved",
      readinessObservations: [],
      closeAttempts: 0,
      leakedBeforeCleanup: false,
      readyAfterBackendClose: false,
    });
  });

  it("physically closes SQLite without publishing executor closure on normal close", async () => {
    const context = await realContext();
    let closeExecutorCalls = 0;
    class FailingCloseFence extends MaintenanceFence {
      override closeExecutor(..._arguments: Parameters<MaintenanceFence["closeExecutor"]>): void {
        closeExecutorCalls += 1;
        throw new Error("close bookkeeping failed");
      }
    }
    const backend = new ProjectStoreWorkerBackend({
      selfUrl: WORKER_URL,
      executorLeaseMs: 15_000,
      appendRetryDeadlineMs: 10_000,
      maintenanceFactory: () => new FailingCloseFence(),
    });
    await backend.dispatch({
      id: "open-close-failure",
      type: "open",
      binding: encodeWorkerBinding(context),
    });
    await backend.close();
    const moved = `${context.binding.storeRoute.eventsPath}.bookkeeping-closed`;
    renameSync(context.binding.storeRoute.eventsPath, moved);
    renameSync(moved, context.binding.storeRoute.eventsPath);
    const observer = new DatabaseSync(context.binding.storeRoute.eventsPath, { readOnly: true });
    const closedAt = observer.prepare(`
      SELECT closed_at
      FROM executor_leases
      WHERE project_id = ?
    `).get(context.binding.projectId)?.closed_at;
    observer.close();

    assert.equal(closeExecutorCalls, 0);
    assert.equal(closedAt, null);
  });

  it("does not commit an executor lease before fallible store service construction", async () => {
    const context = await realContext();
    const backend = new ProjectStoreWorkerBackend({
      selfUrl: WORKER_URL,
      executorLeaseMs: 15_000,
      appendRetryDeadlineMs: 10_000,
      eventStoreFactory() {
        throw new Error("statement construction failed");
      },
    });
    await assert.rejects(backend.dispatch({
      id: "open-construction-failure",
      type: "open",
      binding: encodeWorkerBinding(context),
    }), /statement construction failed/);
    const database = new DatabaseSync(context.binding.storeRoute.eventsPath, { readOnly: true });
    assert.equal(
      database.prepare("SELECT count(*) AS count FROM executor_leases WHERE closed_at IS NULL").get()?.count,
      0,
    );
    database.close();
  });

  it("physically closes SQLite when maintenance acknowledgement fails", async () => {
    const context = await realContext();
    const backend = new ProjectStoreWorkerBackend({
      selfUrl: WORKER_URL,
      executorLeaseMs: 15_000,
      appendRetryDeadlineMs: 10_000,
    });
    await backend.dispatch({
      id: "open-stale-quiesce",
      type: "open",
      binding: encodeWorkerBinding(context),
    });
    await assert.rejects(backend.quiesceAndClose({
      epoch: "1",
      fencingToken: "1",
      ownerId: "stale-maintenance",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, encodeWorkerBindingAssertion(context)));
    const moved = `${context.binding.storeRoute.eventsPath}.stale-quiesce-closed`;
    renameSync(context.binding.storeRoute.eventsPath, moved);
    renameSync(moved, context.binding.storeRoute.eventsPath);
  });
});

describe("WorkerProjectStoreIdentityProbe forced settlement", () => {
  it("does not reject a protocol failure until forced termination has completed", async () => {
    const context = contextFixture();
    const worker = new DeferredTerminationWorker();
    const scheduler = new ManualScheduler();
    const probe = new WorkerProjectStoreIdentityProbe({
      workerUrl: WORKER_URL,
      requestTimeoutMs: 1_000,
    }, {
      workerFactory: () => worker,
      scheduler,
      randomId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    let settled = false;
    const result = probe.verify(context.binding.storeRoute, {
      projectId: context.binding.projectId,
      vaultId: context.binding.vaultId,
      storeId: context.binding.storeId,
    }).finally(() => { settled = true; });
    worker.emit("messageerror", new Error("invalid response"));
    await turn();
    assert.equal(settled, false);
    worker.termination.resolve(1);
    await assert.rejects(result);
    assert.equal(worker.terminateCalls, 1);
  });

  it("returns a typed cleanup failure when forced termination rejects without exit", async () => {
    const context = contextFixture();
    const worker = new RejectingTerminationWorker();
    const probe = new WorkerProjectStoreIdentityProbe({
      workerUrl: WORKER_URL,
      requestTimeoutMs: 1_000,
    }, {
      workerFactory: () => worker,
      scheduler: new ManualScheduler(),
      randomId: () => "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    const result = probe.verify(context.binding.storeRoute, {
      projectId: context.binding.projectId,
      vaultId: context.binding.vaultId,
      storeId: context.binding.storeId,
    });

    worker.emit("messageerror", new Error("invalid response"));

    await assert.rejects(result, (error) => {
      assert.ok(error instanceof ProjectBindingError);
      assert.equal(error.code, "STORE_UNAVAILABLE");
      assert.deepEqual(error.details, { terminationFailed: true });
      assert.equal(error.message.includes("worker termination secret"), false);
      return true;
    });
    assert.equal(worker.terminateCalls, 1);
  });
});
