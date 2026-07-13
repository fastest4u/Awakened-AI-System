import assert from "node:assert/strict";
import { fork, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import type { TrustedProjectBindingRequest } from "../src/orchestrator/identity/project-binding.request.js";
import {
  computeProjectContextFingerprint,
  ProjectBindingService,
} from "../src/orchestrator/identity/project-binding.service.js";
import { WorkerProjectStoreIdentityProbe } from "../src/orchestrator/runtime/project-store-identity-probe.js";
import { DEFAULT_MAX_PENDING, ProjectStoreExecutor } from "../src/orchestrator/runtime/project-store-executor.js";
import {
  decodeWorkerBinding,
  encodeWorkerBinding,
  type AppendCommandWire,
  type AppendResultWire,
  type ProjectStoreRouteWire,
  type StoreIdentityWire,
  type WorkerBinding,
} from "../src/orchestrator/runtime/worker-protocol.js";

const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/project-store-child.js", import.meta.url));
const WORKER_URL = new URL("../src/workers/project-store.worker.js", import.meta.url);
const roots: string[] = [];
const activeClients = new Set<FixtureClient>();
const FIXTURE_TIMEOUT_MS = 30_000;

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

interface MessageWaiter {
  predicate(message: ChildMessage): boolean;
  resolve(message: ChildMessage): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

class FixtureClient {
  readonly child: ChildProcess;
  readonly stderr: string[] = [];
  readonly #messages: ChildMessage[] = [];
  readonly #waiters: MessageWaiter[] = [];
  #disconnected = false;
  #exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;

  constructor(args: string[] = []) {
    this.child = fork(FIXTURE_PATH, args, {
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

  async ready(): Promise<string> {
    const message = await this.waitFor((candidate) => candidate.type === "ready", "ready");
    assert.equal(message.type, "ready");
    return message.childId;
  }

  send(message: ParentMessage): void {
    assert.equal(this.child.connected, true, "fixture IPC must remain connected");
    this.child.send(message);
  }

  waitFor(
    predicate: (message: ChildMessage) => boolean,
    label: string,
  ): Promise<ChildMessage> {
    const queuedIndex = this.#messages.findIndex(predicate);
    if (queuedIndex >= 0) return Promise.resolve(this.#messages.splice(queuedIndex, 1)[0]!);
    if (this.#exit !== undefined) {
      return Promise.reject(new Error(`fixture already exited before ${label}: ${this.#exit.code ?? this.#exit.signal}`));
    }
    return new Promise<ChildMessage>((resolve, reject) => {
      const waiter: MessageWaiter = {
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

  async start(action: FixtureStartAction): Promise<Extract<ChildMessage, { type: "started" }> | Extract<ChildMessage, { type: "error" }>> {
    this.send({ type: "start", action });
    const message = await this.waitFor(
      (candidate) => candidate.type === "started" || (candidate.type === "error" && candidate.commandId === undefined),
      "started",
    );
    assert.ok(message.type === "started" || message.type === "error");
    return message;
  }

  async append(command: AppendCommandWire): Promise<Extract<ChildMessage, { type: "result" | "error" }>> {
    this.send({ type: "append", command });
    const message = await this.waitFor(
      (candidate) => (candidate.type === "result" || candidate.type === "error")
        && candidate.commandId === command.commandId,
      `result:${command.commandId}`,
    );
    assert.ok(message.type === "result" || message.type === "error");
    return message;
  }

  async close(): Promise<void> {
    if (this.#exit !== undefined) return;
    const disconnected = this.#disconnected
      ? Promise.resolve()
      : new Promise<void>((resolve) => this.child.once("disconnect", resolve));
    const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    this.send({ type: "close" });
    const message = await this.waitFor((candidate) => candidate.type === "closed", "closed");
    assert.equal(message.type, "closed");
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

interface ProjectFixture {
  root: string;
  projectRoot: string;
  vaultRoot: string;
  request: TrustedProjectBindingRequest;
}

function projectFixture(name: string): ProjectFixture {
  const root = mkdtempSync(join(tmpdir(), `memory-event-${name}-`));
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

function commandId(worker: number, sequence: number): string {
  const suffix = String(worker * 1_000 + sequence + 1).padStart(12, "0");
  return `10000000-0000-4000-8000-${suffix}`;
}

function appendCommand(worker: number, sequence: number, expected: number, stream = `shared-stream-${worker}`): AppendCommandWire {
  const id = commandId(worker, sequence);
  return {
    commandId: id,
    idempotencyKey: `shared-key-${worker}-${sequence}`,
    commandType: "task13.concurrent",
    correlationId: `correlation-${worker}`,
    agentId: "task-13",
    expectedStreamVersion: String(expected),
    streamId: stream,
    streamType: "task13-stream",
    events: [{
      eventType: "Task13ConcurrentEvent",
      eventSchemaVersion: 1,
      occurredAt: "2026-07-13T00:00:00.000Z",
      visibilityScope: "project",
      sessionId: null,
      parentSessionId: null,
      causationId: null,
      confidence: "high",
      verificationStatus: "verified",
      payload: { worker, sequence },
      sourceRefs: [],
      evidenceRefs: [],
      evidenceDigests: [],
    }],
    outbox: [],
    publicResponse: { worker, sequence },
  };
}

async function startAll(clients: FixtureClient[], actions: FixtureStartAction[]): Promise<Extract<ChildMessage, { type: "started" }>[]> {
  assert.equal(clients.length, actions.length);
  await Promise.all(clients.map((client) => client.ready()));
  const pending = clients.map((client, index) => client.start(actions[index]!));
  const messages = await Promise.all(pending);
  for (const message of messages) {
    if (message.type === "error") assert.fail(`${message.code}: ${message.message}`);
  }
  return messages as Extract<ChildMessage, { type: "started" }>[];
}

async function closeAll(clients: FixtureClient[]): Promise<void> {
  await Promise.all(clients.map((client) => client.close().catch(async (error: unknown) => {
    await client.forceCleanup();
    throw error;
  })));
}

async function bindingFor(request: TrustedProjectBindingRequest): Promise<WorkerBinding> {
  const service = new ProjectBindingService({
    identityProbe: new WorkerProjectStoreIdentityProbe({ workerUrl: WORKER_URL }),
  });
  const resolution = await service.establish(request);
  if (!resolution.ok) assert.fail(`${resolution.code}: ${resolution.message}`);
  return encodeWorkerBinding({
    binding: resolution.binding,
    workspace: resolution.binding.workspace,
    checkedAt: new Date().toISOString(),
  });
}

async function verifyWorkerIntegrity(binding: WorkerBinding): Promise<void> {
  const context = decodeWorkerBinding(binding);
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

function inspectStore(route: ProjectStoreRouteWire, expectedEvents: number, expectedStreams: number): StoreIdentityWire {
  const database = new DatabaseSync(route.eventsPath, { readOnly: true });
  try {
    const identity = database.prepare(`
      SELECT project_id AS projectId, vault_id AS vaultId, store_id AS storeId
      FROM project_meta WHERE singleton = 1
    `).get() as StoreIdentityWire | undefined;
    assert.ok(identity);
    assert.equal(database.prepare("SELECT count(*) AS count FROM events").get()?.count, expectedEvents);
    assert.equal(database.prepare("SELECT count(*) AS count FROM command_dedup").get()?.count, expectedEvents);
    assert.equal(database.prepare("SELECT count(DISTINCT command_id) AS count FROM events").get()?.count, expectedEvents);
    assert.equal(database.prepare("SELECT count(DISTINCT idempotency_key) AS count FROM events").get()?.count, expectedEvents);
    assert.deepEqual(
      database.prepare("SELECT global_position AS position FROM events ORDER BY global_position").all()
        .map((row) => Number(row.position)),
      Array.from({ length: expectedEvents }, (_, index) => index + 1),
    );
    const versions = database.prepare(`
      SELECT stream_id AS streamId, stream_version AS version
      FROM events ORDER BY stream_id, stream_version
    `).all() as Array<{ streamId: string; version: number | bigint }>;
    const byStream = new Map<string, number[]>();
    for (const row of versions) {
      const values = byStream.get(row.streamId) ?? [];
      values.push(Number(row.version));
      byStream.set(row.streamId, values);
    }
    assert.equal(byStream.size, expectedStreams);
    for (const values of byStream.values()) {
      assert.deepEqual(values, Array.from({ length: values.length }, (_, index) => index + 1));
    }
    assert.deepEqual(database.prepare(`
      SELECT DISTINCT project_id AS projectId, vault_id AS vaultId, store_id AS storeId
      FROM events
    `).all(), [identity]);
    for (const table of [
      "streams",
      "command_dedup",
      "outbox",
      "branch_scopes",
      "executor_leases",
    ]) {
      const rows = database.prepare(`SELECT DISTINCT project_id AS projectId FROM ${table}`).all();
      assert.equal(rows.every((row) => row.projectId === identity.projectId), true, table);
    }
    assert.equal(database.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(database.prepare("SELECT count(*) AS count FROM schema_migrations").get()?.count, 1);
    return identity;
  } finally {
    database.close();
  }
}

function eventCount(path: string): number {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return Number(database.prepare("SELECT count(*) AS count FROM events").get()?.count);
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

async function linkedWorktreeProof(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "memory-event-linked-"));
  roots.push(root);
  const mainRoot = join(root, "main");
  const linkedRoot = join(root, "linked");
  mkdirSync(mainRoot, { recursive: true });
  const git = (args: string[], cwd = mainRoot): void => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  };
  git(["init"]);
  git(["config", "user.email", "task13@example.invalid"]);
  git(["config", "user.name", "Task 13"]);
  writeFileSync(join(mainRoot, "README.md"), "task 13\n");
  git(["add", "README.md"]);
  git(["commit", "-m", "initial"]);

  const mainVault = join(mainRoot, "memory");
  mkdirSync(mainVault, { recursive: true });
  const mainRequest: TrustedProjectBindingRequest = {
    source: "explicit-cli",
    projectRoot: mainRoot,
    vaultRoot: mainVault,
    clientNamespace: "task-13",
    clientInstanceId: "linked-main",
    actorRole: "primary",
    generation: 1,
  };
  const main = new FixtureClient();
  const [mainStarted] = await startAll([main], [{ kind: "initialize", request: mainRequest }]);
  assert.equal(mainStarted.result.kind, "initialized");
  const mainRoute = mainStarted.result.route;
  await closeAll([main]);

  git(["worktree", "add", "-b", "task-13-linked", linkedRoot]);
  const linkedVault = join(linkedRoot, "memory");
  mkdirSync(join(linkedVault, ".memory-mcp"), { recursive: true });
  copyFileSync(
    join(mainVault, ".memory-mcp", "project-identity.json"),
    join(linkedVault, ".memory-mcp", "project-identity.json"),
  );
  const linkedRequest: TrustedProjectBindingRequest = {
    ...mainRequest,
    projectRoot: linkedRoot,
    vaultRoot: linkedVault,
    clientInstanceId: "linked-secondary",
  };
  const linked = new FixtureClient();
  const [linkedStarted] = await startAll([linked], [{
    kind: "initialize",
    request: linkedRequest,
    replicaDecision: "initialize-local",
  }]);
  assert.equal(linkedStarted.result.kind, "initialized");
  assert.equal(linkedStarted.result.route.eventsPath, mainRoute.eventsPath);
  await closeAll([linked]);

  const [mainBinding, linkedBinding] = await Promise.all([
    bindingFor(mainRequest),
    bindingFor(linkedRequest),
  ]);
  assert.equal(mainBinding.storeId, linkedBinding.storeId);
  assert.equal(mainBinding.projectId, linkedBinding.projectId);
  assert.equal(mainBinding.storeRoute.eventsPath, linkedBinding.storeRoute.eventsPath);
  assert.notEqual(mainBinding.workspaceId, linkedBinding.workspaceId);
  assert.notDeepEqual(mainBinding.workspace, linkedBinding.workspace);
  proveHandleRelease(mainRoute.eventsPath);
}

afterEach(async () => {
  await Promise.allSettled([...activeClients].map(async (client) => client.forceCleanup()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("event store process isolation", () => {
  it("serializes virgin initialization and isolates real multi-process projects", async () => {
    const projectP = projectFixture("project-p");
    const projectQ = projectFixture("project-q");

    const firstOpen = [new FixtureClient(), new FixtureClient()];
    const firstStarted = await startAll(firstOpen, firstOpen.map(() => ({
      kind: "initialize" as const,
      request: projectP.request,
      replicaDecision: "initialize-local" as const,
    })));
    const initialized = firstStarted.map((message) => {
      assert.equal(message.result.kind, "initialized");
      return message.result;
    });
    assert.equal(initialized.filter((result) => result.createdDescriptor).length, 1);
    assert.equal(initialized.filter((result) => result.createdStore).length, 1);
    assert.deepEqual(initialized[0]!.route, initialized[1]!.route);
    await closeAll(firstOpen);
    const routeP = initialized[0]!.route;

    const qInitializer = new FixtureClient();
    const [qStarted] = await startAll([qInitializer], [{ kind: "initialize", request: projectQ.request }]);
    assert.equal(qStarted.result.kind, "initialized");
    const routeQ = qStarted.result.route;
    await closeAll([qInitializer]);

    const pClients = Array.from({ length: 4 }, () => new FixtureClient());
    const qClients = Array.from({ length: 2 }, () => new FixtureClient());
    const writers = [...pClients, ...qClients];
    const actions: FixtureStartAction[] = [
      ...pClients.map((_, index) => ({
        kind: "initialize" as const,
        request: { ...projectP.request, clientInstanceId: `p-${index}` },
      })),
      ...qClients.map((_, index) => ({
        kind: "initialize" as const,
        request: { ...projectQ.request, clientInstanceId: `q-${index}` },
      })),
    ];
    await startAll(writers, actions);

    for (let sequence = 0; sequence < 25; sequence += 1) {
      const round = [
        ...pClients.map((client, worker) => client.append(appendCommand(worker, sequence, sequence))),
        ...qClients.map((client, worker) => client.append(appendCommand(worker, sequence, sequence))),
      ];
      const results = await Promise.all(round);
      for (const result of results) {
        if (result.type === "error") assert.fail(`${result.code}: ${result.message}`);
        assert.equal(result.result.finalStreamVersion, String(sequence + 1));
      }
    }
    await closeAll(writers);

    const pBinding = await bindingFor(projectP.request);
    const qBinding = await bindingFor(projectQ.request);
    const pBeforeAuthorityProbe = eventCount(routeP.eventsPath);
    const foreignRoute = new FixtureClient();
    await foreignRoute.ready();
    const foreignStarted = await foreignRoute.start({ kind: "open", route: routeP, binding: qBinding });
    assert.equal(foreignStarted.type, "error");
    if (foreignStarted.type === "error") assert.equal(foreignStarted.code, "PROJECT_ID_MISMATCH");
    await foreignRoute.close();
    const foreignStore = new FixtureClient();
    await foreignStore.ready();
    const pContext = decodeWorkerBinding(pBinding);
    const qContext = decodeWorkerBinding(qBinding);
    const foreignBindingWithoutFingerprint = {
      ...pContext.binding,
      storeId: qContext.binding.storeId,
    };
    const internallyValidForeignBinding = encodeWorkerBinding({
      ...pContext,
      binding: {
        ...foreignBindingWithoutFingerprint,
        contextFingerprint: computeProjectContextFingerprint(foreignBindingWithoutFingerprint),
      },
    });
    const foreignStoreStarted = await foreignStore.start({
      kind: "open",
      route: routeP,
      binding: internallyValidForeignBinding,
    });
    assert.equal(foreignStoreStarted.type, "error");
    if (foreignStoreStarted.type === "error") assert.equal(foreignStoreStarted.code, "STORE_ID_MISMATCH");
    await foreignStore.close();
    const pAfterAuthorityProbe = eventCount(routeP.eventsPath);
    assert.equal(pAfterAuthorityProbe, pBeforeAuthorityProbe);

    const pIdentity = inspectStore(routeP, 100, 4);
    const qIdentity = inspectStore(routeQ, 50, 2);
    assert.notEqual(pIdentity.projectId, qIdentity.projectId);
    assert.notEqual(pIdentity.vaultId, qIdentity.vaultId);
    assert.notEqual(pIdentity.storeId, qIdentity.storeId);
    assert.equal(JSON.parse(readFileSync(join(projectP.vaultRoot, ".memory-mcp", "project-identity.json"), "utf8")).projectId, pIdentity.projectId);
    assert.equal(JSON.parse(readFileSync(routeP.storeManifestPath, "utf8")).storeId, pIdentity.storeId);
    assert.equal(JSON.parse(readFileSync(join(projectQ.vaultRoot, ".memory-mcp", "project-identity.json"), "utf8")).projectId, qIdentity.projectId);
    assert.equal(JSON.parse(readFileSync(routeQ.storeManifestPath, "utf8")).storeId, qIdentity.storeId);
    await verifyWorkerIntegrity(pBinding);
    await verifyWorkerIntegrity(qBinding);
    proveHandleRelease(routeP.eventsPath);
    proveHandleRelease(routeQ.eventsPath);
    await linkedWorktreeProof();
  });

  it("resolves deterministic same-stream process contention with one CAS winner", async () => {
    const project = projectFixture("same-stream-cas");
    const clients = [new FixtureClient(), new FixtureClient()];
    await startAll(clients, clients.map((_, index) => ({
      kind: "initialize" as const,
      request: { ...project.request, clientInstanceId: `cas-${index}` },
      replicaDecision: "initialize-local" as const,
    })));
    const left = appendCommand(20, 0, 0, "contended-stream");
    const right = { ...appendCommand(21, 0, 0, "contended-stream"), idempotencyKey: "cas-right" };
    const [leftResult, rightResult] = await Promise.all([
      clients[0]!.append(left),
      clients[1]!.append(right),
    ]);
    const results = [leftResult, rightResult];
    assert.equal(results.filter((result) => result.type === "result").length, 1);
    const failure = results.find((result) => result.type === "error");
    assert.ok(failure);
    assert.equal(failure.code, "EVENT_CONFLICT");
    await closeAll(clients);
    const route = (await bindingFor(project.request)).storeRoute;
    inspectStore(route, 1, 1);
    proveHandleRelease(route.eventsPath);
  });
});
