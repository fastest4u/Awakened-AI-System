import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, describe, it } from "node:test";
import type { JsonValue } from "../src/orchestrator/contracts/event.js";
import type { ProjectContext } from "../src/orchestrator/identity/contracts.js";
import type { TrustedProjectBindingRequest } from "../src/orchestrator/identity/project-binding.request.js";
import { ProjectBindingService } from "../src/orchestrator/identity/project-binding.service.js";
import { WorkerProjectStoreIdentityProbe } from "../src/orchestrator/runtime/project-store-identity-probe.js";
import {
  DEFAULT_MAX_PENDING,
  ProjectStoreExecutor,
  ProjectStoreWorkerError,
  type WorkerLike,
} from "../src/orchestrator/runtime/project-store-executor.js";
import {
  decodeAppendCommandWire,
  type AppendCommandWire,
  type AppendResultWire,
  type ProjectStoreRouteWire,
  type StoreIdentityWire,
  type WorkerBinding,
  type WorkerRequest,
} from "../src/orchestrator/runtime/worker-protocol.js";
import { DEFAULT_BUSY_TIMEOUT_MS } from "../src/orchestrator/runtime/runtime-capabilities.js";
import { MaintenanceFence } from "../src/orchestrator/storage/maintenance-fence.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";

const NORMAL_FIXTURE_PATH = fileURLToPath(new URL("./fixtures/project-store-child.js", import.meta.url));
const CRASH_FIXTURE_PATH = fileURLToPath(new URL("./fixtures/project-store-crash-child.js", import.meta.url));
const WORKER_URL = new URL("../src/workers/project-store.worker.js", import.meta.url);
const FIXTURE_TIMEOUT_MS = 30_000;
const roots: string[] = [];
const activeClients = new Set<FixtureClient>();

type EventStoreFaultBoundary =
  | "before-begin"
  | "after-first-insert-before-commit"
  | "after-commit-before-response";

type FixtureStartAction =
  | { kind: "initialize"; request: TrustedProjectBindingRequest; replicaDecision?: "initialize-local" }
  | { kind: "open"; route: ProjectStoreRouteWire; binding: WorkerBinding };

type ParentMessage =
  | { type: "start"; action: FixtureStartAction }
  | { type: "append"; command: AppendCommandWire }
  | { type: "close" };

type ChildMessage =
  | { type: "ready"; childId: string }
  | {
      type: "started";
      childId: string;
      result:
        | {
            kind: "initialized";
            route: ProjectStoreRouteWire;
            createdDescriptor: boolean;
            createdStore: boolean;
            recoveredManifest: boolean;
          }
        | { kind: "opened"; identity: StoreIdentityWire; executorId: string };
    }
  | { type: "result"; commandId: string; result: AppendResultWire }
  | { type: "error"; commandId?: string; code: string; message: string }
  | { type: "closed"; childId: string };

interface Waiter {
  predicate(message: ChildMessage): boolean;
  resolve(message: ChildMessage): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

class FixtureClient {
  readonly child: ChildProcess;
  readonly stderr: string[] = [];
  readonly #messages: ChildMessage[] = [];
  readonly #waiters: Waiter[] = [];
  #exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  #disconnected = false;

  constructor(path = NORMAL_FIXTURE_PATH, args: string[] = []) {
    this.child = fork(path, args, {
      serialization: "json",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    activeClients.add(this);
    this.child.stderr?.on("data", (chunk: Buffer | string) => this.stderr.push(String(chunk)));
    this.child.on("message", (message: unknown) => this.push(message as ChildMessage));
    this.child.on("disconnect", () => { this.#disconnected = true; });
    this.child.on("exit", (code, signal) => {
      activeClients.delete(this);
      this.#exit = { code, signal };
      const error = new Error(`fixture exited before barrier: ${code ?? signal ?? "unknown"}\n${this.stderr.join("")}`);
      for (const waiter of this.#waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    });
  }

  waitFor(predicate: (message: ChildMessage) => boolean, label: string): Promise<ChildMessage> {
    const queuedIndex = this.#messages.findIndex(predicate);
    if (queuedIndex >= 0) return Promise.resolve(this.#messages.splice(queuedIndex, 1)[0]!);
    if (this.#exit !== undefined) return Promise.reject(new Error(`fixture exited before ${label}`));
    return new Promise<ChildMessage>((resolve, reject) => {
      const waiter: Waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(new Error(`fixture ${label} barrier timed out\n${this.stderr.join("")}`));
        }, FIXTURE_TIMEOUT_MS),
      };
      this.#waiters.push(waiter);
    });
  }

  async ready(): Promise<void> {
    assert.equal((await this.waitFor((message) => message.type === "ready", "ready")).type, "ready");
  }

  send(message: ParentMessage): void {
    assert.equal(this.child.connected, true);
    this.child.send(message);
  }

  async start(action: FixtureStartAction): Promise<Extract<ChildMessage, { type: "started" }>> {
    this.send({ type: "start", action });
    const message = await this.waitFor(
      (candidate) => candidate.type === "started" || (candidate.type === "error" && candidate.commandId === undefined),
      "started",
    );
    if (message.type === "error") assert.fail(`${message.code}: ${message.message}`);
    assert.equal(message.type, "started");
    return message;
  }

  async append(command: AppendCommandWire): Promise<Extract<ChildMessage, { type: "result" | "error" }>> {
    this.send({ type: "append", command });
    const message = await this.waitFor(
      (candidate) => (candidate.type === "result" || candidate.type === "error")
        && candidate.commandId === command.commandId,
      `append:${command.commandId}`,
    );
    assert.ok(message.type === "result" || message.type === "error");
    return message;
  }

  async crashOnAppend(command: AppendCommandWire): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    const disconnected = this.#disconnected
      ? Promise.resolve()
      : new Promise<void>((resolve) => this.child.once("disconnect", resolve));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      this.child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    this.send({ type: "append", command });
    const [exit] = await Promise.all([exited, disconnected]);
    return exit;
  }

  async close(): Promise<void> {
    if (this.#exit !== undefined) return;
    const disconnected = this.#disconnected
      ? Promise.resolve()
      : new Promise<void>((resolve) => this.child.once("disconnect", resolve));
    const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    this.send({ type: "close" });
    assert.equal((await this.waitFor((message) => message.type === "closed", "closed")).type, "closed");
    await Promise.all([disconnected, exited]);
  }

  async forceCleanup(): Promise<void> {
    if (this.#exit !== undefined) return;
    const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    this.child.kill();
    await exited;
  }

  private push(message: ChildMessage): void {
    const index = this.#waiters.findIndex((waiter) => waiter.predicate(message));
    if (index < 0) {
      this.#messages.push(message);
      return;
    }
    const [waiter] = this.#waiters.splice(index, 1);
    clearTimeout(waiter!.timer);
    waiter!.resolve(message);
  }
}

class ParentForcedLossWorker extends EventEmitter implements WorkerLike {
  readonly #worker: Worker;
  readonly #requestTypes = new Map<string, WorkerRequest["type"]>();
  readonly responseHeld: Promise<void>;
  #resolveResponseHeld!: () => void;
  #termination: Promise<number> | undefined;

  constructor(workerUrl: URL, workerData: Record<string, JsonValue>) {
    super();
    this.responseHeld = new Promise<void>((resolve) => { this.#resolveResponseHeld = resolve; });
    this.#worker = new Worker(workerUrl, { workerData });
    this.#worker.on("message", (value: unknown) => {
      const id = typeof value === "object" && value !== null && "id" in value
        && typeof value.id === "string" ? value.id : undefined;
      if (
        id !== undefined
        && this.#requestTypes.get(id) === "append"
        && "ok" in (value as object)
      ) {
        this.#resolveResponseHeld();
        return;
      }
      this.emit("message", value);
    });
    this.#worker.on("messageerror", (error) => this.emit("messageerror", error));
    this.#worker.on("error", (error) => this.emit("error", error));
    this.#worker.on("exit", (code) => this.emit("exit", code));
  }

  postMessage(value: unknown): void {
    const request = value as WorkerRequest;
    this.#requestTypes.set(request.id, request.type);
    this.#worker.postMessage(value);
  }

  forceLoss(): Promise<number> {
    this.#termination ??= this.#worker.terminate();
    return this.#termination;
  }

  terminate(): Promise<number> {
    return this.forceLoss();
  }
}

interface ProjectFixture {
  root: string;
  projectRoot: string;
  vaultRoot: string;
  request: TrustedProjectBindingRequest;
}

function projectFixture(name: string): ProjectFixture {
  const root = mkdtempSync(join(tmpdir(), `memory-crash-${name}-`));
  roots.push(root);
  const projectRoot = join(root, "project");
  const vaultRoot = join(projectRoot, "memory");
  mkdirSync(vaultRoot, { recursive: true });
  return {
    root,
    projectRoot,
    vaultRoot,
    request: {
      source: "explicit-cli",
      projectRoot,
      vaultRoot,
      clientNamespace: "task-13",
      clientInstanceId: `${name}-client`,
      actorRole: "primary",
      generation: 1,
    },
  };
}

function crashCommand(): AppendCommandWire {
  return {
    commandId: "20000000-0000-4000-8000-000000000001",
    idempotencyKey: "task13-original-crash-key",
    commandType: "task13.crash",
    correlationId: "task13-crash-correlation",
    agentId: "task-13",
    expectedStreamVersion: "0",
    streamId: "crash-stream",
    streamType: "task13-stream",
    events: [0, 1].map((index) => ({
      eventType: "Task13CrashEvent",
      eventSchemaVersion: 1,
      occurredAt: "2026-07-13T00:00:00.000Z",
      visibilityScope: "project" as const,
      sessionId: null,
      parentSessionId: null,
      causationId: null,
      confidence: "high" as const,
      verificationStatus: "verified" as const,
      payload: { index },
      sourceRefs: [],
      evidenceRefs: [] as [],
      evidenceDigests: [] as [],
    })),
    outbox: [{
      targetKey: "task13-crash-outbox",
      kind: "task13",
      eventIndex: 1,
      payload: { delivery: "required" },
    }],
    publicResponse: { accepted: true },
  };
}

async function contextFor(request: TrustedProjectBindingRequest): Promise<ProjectContext> {
  const service = new ProjectBindingService({
    identityProbe: new WorkerProjectStoreIdentityProbe({ workerUrl: WORKER_URL }),
  });
  const resolution = await service.establish(request);
  if (!resolution.ok) assert.fail(`${resolution.code}: ${resolution.message}`);
  return {
    binding: resolution.binding,
    workspace: resolution.binding.workspace,
    checkedAt: new Date().toISOString(),
  };
}

async function verifyIntegrity(context: ProjectContext): Promise<void> {
  const executor = new ProjectStoreExecutor({
    workerUrl: WORKER_URL,
    context,
    maxPending: DEFAULT_MAX_PENDING,
    requestTimeoutMs: 20_000,
    closeTimeoutMs: 10_000,
    executorLeaseMs: 20_000,
    heartbeatIntervalMs: 5_000,
  });
  await executor.open();
  try {
    assert.equal((await executor.quickIntegrity()).ok, true);
    assert.equal((await executor.fullIntegrity()).ok, true);
  } finally {
    await executor.close();
  }
}

function counts(path: string): { events: number; commands: number; outbox: number } {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(database.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
    assert.equal(database.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    return {
      events: Number(database.prepare("SELECT count(*) AS count FROM events").get()?.count),
      commands: Number(database.prepare("SELECT count(*) AS count FROM command_dedup").get()?.count),
      outbox: Number(database.prepare("SELECT count(*) AS count FROM outbox").get()?.count),
    };
  } finally {
    database.close();
  }
}

function proveHandleRelease(path: string): void {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    if (!existsSync(candidate)) continue;
    const moved = `${candidate}.handle-release`;
    renameSync(candidate, moved);
    renameSync(moved, candidate);
  }
}

function transaction<T>(connection: ReturnType<NodeSqliteDriver["open"]>, operation: () => T): T {
  connection.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    connection.exec("COMMIT");
    return result;
  } catch (error) {
    try { connection.exec("ROLLBACK"); } catch { /* preserve original */ }
    throw error;
  }
}

afterEach(async () => {
  await Promise.allSettled([...activeClients].map(async (client) => client.forceCleanup()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("event store crash recovery", () => {
  it("recovers each exact transaction boundary with the original command identity", async () => {
    for (const boundary of [
      "before-begin",
      "after-first-insert-before-commit",
      "after-commit-before-response",
    ] satisfies EventStoreFaultBoundary[]) {
      const project = projectFixture(boundary);
      const command = crashCommand();
      const crashing = new FixtureClient(CRASH_FIXTURE_PATH, [boundary]);
      await crashing.ready();
      const started = await crashing.start({ kind: "initialize", request: project.request });
      assert.equal(started.result.kind, "initialized");
      const route = started.result.route;
      const exit = await crashing.crashOnAppend(command);
      assert.equal(exit.code, 137, `${boundary}: ${crashing.stderr.join("")}`);

      const beforeRetry = counts(route.eventsPath);
      assert.deepEqual(beforeRetry, boundary === "after-commit-before-response"
        ? { events: 2, commands: 1, outbox: 1 }
        : { events: 0, commands: 0, outbox: 0 });

      const recovery = new FixtureClient();
      await recovery.ready();
      await recovery.start({
        kind: "initialize",
        request: { ...project.request, clientInstanceId: `${boundary}-recovery`, generation: 2 },
      });
      const result = await recovery.append(command);
      if (result.type === "error") assert.fail(`${result.code}: ${result.message}`);
      assert.equal(result.result.deduplicated, boundary === "after-commit-before-response");
      assert.equal(result.result.eventIds.length, 2);
      await recovery.close();

      assert.deepEqual(counts(route.eventsPath), { events: 2, commands: 1, outbox: 1 });
      await verifyIntegrity(await contextFor({
        ...project.request,
        clientInstanceId: `${boundary}-integrity`,
        generation: 3,
      }));
      proveHandleRelease(route.eventsPath);
    }
  });

  it("reports a parent-forced lost mutation response as COMMAND_OUTCOME_UNKNOWN and replays original IDs", async () => {
    const project = projectFixture("forced-loss");
    const initializer = new FixtureClient();
    await initializer.ready();
    const started = await initializer.start({ kind: "initialize", request: project.request });
    assert.equal(started.result.kind, "initialized");
    const route = started.result.route;
    await initializer.close();
    const context = await contextFor(project.request);
    let transport!: ParentForcedLossWorker;
    const uncertain = new ProjectStoreExecutor({
      workerUrl: WORKER_URL,
      context,
      maxPending: DEFAULT_MAX_PENDING,
      requestTimeoutMs: 20_000,
      closeTimeoutMs: 10_000,
      executorLeaseMs: 20_000,
      heartbeatIntervalMs: 5_000,
    }, {
      workerFactory(workerUrl, options) {
        transport = new ParentForcedLossWorker(workerUrl, options.workerData);
        return transport;
      },
    });
    await uncertain.open();
    const command = crashCommand();
    const decodedCommand = decodeAppendCommandWire(command, context);
    const mutation = uncertain.append(decodedCommand);
    await transport.responseHeld;
    const forcedExit = transport.forceLoss();
    await assert.rejects(mutation, (error) => {
      assert.ok(error instanceof ProjectStoreWorkerError);
      assert.equal(error.code, "COMMAND_OUTCOME_UNKNOWN");
      assert.deepEqual(error.details, {
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
      });
      return true;
    });
    await forcedExit;
    await uncertain.close();
    assert.deepEqual(counts(route.eventsPath), { events: 2, commands: 1, outbox: 1 });

    const recovered = new ProjectStoreExecutor({
      workerUrl: WORKER_URL,
      context,
      maxPending: DEFAULT_MAX_PENDING,
      requestTimeoutMs: 20_000,
      closeTimeoutMs: 10_000,
      executorLeaseMs: 20_000,
      heartbeatIntervalMs: 5_000,
    });
    await recovered.open();
    const replay = await recovered.append(decodedCommand);
    assert.equal(replay.deduplicated, true);
    await recovered.close();
    assert.deepEqual(counts(route.eventsPath), { events: 2, commands: 1, outbox: 1 });
    await verifyIntegrity(context);
    proveHandleRelease(route.eventsPath);
  });

  it("prevents a crashed maintenance owner from releasing a newer fencing token", async () => {
    const project = projectFixture("maintenance-owner");
    const initializer = new FixtureClient();
    await initializer.ready();
    const started = await initializer.start({ kind: "initialize", request: project.request });
    assert.equal(started.result.kind, "initialized");
    const path = started.result.route.eventsPath;
    await initializer.close();

    const driver = new NodeSqliteDriver({ DatabaseSync });
    const fence = new MaintenanceFence();
    const firstConnection = driver.open(path, { mode: "existing", busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS });
    const stale = transaction(firstConnection, () => fence.acquire(
      firstConnection,
      "crashed-owner",
      "2026-07-13T02:00:00.000Z",
      "2026-07-13T01:00:00.000Z",
    ));
    firstConnection.close();

    const secondConnection = driver.open(path, { mode: "existing", busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS });
    try {
      const current = transaction(secondConnection, () => fence.acquire(
        secondConnection,
        "new-owner",
        "2026-07-13T05:00:00.000Z",
        "2026-07-13T03:00:00.000Z",
      ));
      assert.deepEqual([current.epoch, current.fencingToken], [2n, 2n]);
      assert.throws(
        () => transaction(secondConnection, () => fence.release(
          secondConnection,
          stale,
          false,
          "2026-07-13T03:01:00.000Z",
        )),
        (error) => error instanceof Error && "code" in error
          && (error as Error & { code: unknown }).code === "MAINTENANCE_LEASE_STALE",
      );
      const state = secondConnection.prepare(`
        SELECT epoch, fencing_token AS fencingToken, owner_id AS ownerId, mode
        FROM maintenance_state WHERE singleton = 1
      `).get();
      assert.deepEqual({ ...state }, {
        epoch: 2n,
        fencingToken: 2n,
        ownerId: "new-owner",
        mode: "quiescing",
      });
      transaction(secondConnection, () => fence.release(
        secondConnection,
        current,
        false,
        "2026-07-13T03:02:00.000Z",
      ));
    } finally {
      secondConnection.close();
    }
    assert.deepEqual(counts(path), { events: 0, commands: 0, outbox: 0 });
    await verifyIntegrity(await contextFor(project.request));
    proveHandleRelease(path);
  });
});
