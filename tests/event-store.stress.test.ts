import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import type { ProjectContext } from "../src/orchestrator/identity/contracts.js";
import type { TrustedProjectBindingRequest } from "../src/orchestrator/identity/project-binding.request.js";
import { ProjectBindingService } from "../src/orchestrator/identity/project-binding.service.js";
import { parseProjectDescriptor } from "../src/orchestrator/identity/project-descriptor.schema.js";
import { parseStoreManifest } from "../src/orchestrator/identity/store-manifest.schema.js";
import { WorkerProjectStoreIdentityProbe } from "../src/orchestrator/runtime/project-store-identity-probe.js";
import { DEFAULT_MAX_PENDING, ProjectStoreExecutor } from "../src/orchestrator/runtime/project-store-executor.js";
import type {
  AppendCommandWire,
  AppendResultWire,
  ProjectStoreRouteWire,
  StoreIdentityWire,
  WorkerBinding,
} from "../src/orchestrator/runtime/worker-protocol.js";

const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/project-store-child.js", import.meta.url));
const WORKER_URL = new URL("../src/workers/project-store.worker.js", import.meta.url);
const STRESS_ENABLED = process.env.MEMORY_EVENT_STRESS === "1";
const SEEDS = 10;
const PROCESS_COUNT = 16;
const COMMANDS_PER_PROCESS = 250;
const EVENTS_PER_SEED = PROCESS_COUNT * COMMANDS_PER_PROCESS;
const BARRIER_TIMEOUT_MS = 60_000;
const roots = new Set<string>();
const activeClients = new Set<FixtureClient>();

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
  timer: NodeJS.Timeout | undefined;
}

interface FixtureExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

class FixtureClient {
  readonly child: ChildProcess;
  readonly stderr: string[] = [];
  readonly #label: string;
  readonly #messages: ChildMessage[] = [];
  readonly #waiters: MessageWaiter[] = [];
  readonly #disconnectPromise: Promise<void>;
  readonly #exitPromise: Promise<FixtureExit>;
  readonly #shutdownEvents: string[] = [];
  #resolveDisconnect!: () => void;
  #resolveExit!: (exit: FixtureExit) => void;
  #exit: FixtureExit | undefined;
  #killRequested = false;

  constructor(label: string) {
    this.#label = label;
    this.child = fork(FIXTURE_PATH, [], {
      serialization: "json",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    this.#disconnectPromise = new Promise<void>((resolve) => { this.#resolveDisconnect = resolve; });
    this.#exitPromise = new Promise<FixtureExit>((resolve) => { this.#resolveExit = resolve; });
    activeClients.add(this);
    this.child.stderr?.on("data", (chunk: Buffer | string) => this.stderr.push(String(chunk)));
    this.child.on("message", (message: unknown) => this.push(message as ChildMessage));
    this.child.on("disconnect", () => {
      this.#shutdownEvents.push("disconnect");
      this.#resolveDisconnect();
    });
    this.child.on("exit", (code, signal) => {
      activeClients.delete(this);
      this.#exit = { code, signal };
      this.#shutdownEvents.push("exit");
      this.#resolveExit(this.#exit);
      const error = this.failure(`exited before barrier: ${code ?? signal ?? "unknown"}`);
      for (const waiter of this.#waiters.splice(0)) {
        if (waiter.timer !== undefined) clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    });
  }

  async ready(): Promise<void> {
    const message = await this.waitFor((candidate) => candidate.type === "ready", "ready");
    assert.equal(message.type, "ready");
  }

  async start(action: FixtureStartAction): Promise<Extract<ChildMessage, { type: "started" }>> {
    this.send({ type: "start", action });
    const message = await this.waitFor(
      (candidate) => candidate.type === "started"
        || (candidate.type === "error" && candidate.commandId === undefined),
      "started",
    );
    if (message.type === "error") {
      assert.fail(`${this.#label} start failed: ${message.code}: ${message.message}`);
    }
    assert.equal(message.type, "started");
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
    if (this.#exit !== undefined) throw this.failure("exited before cooperative close");
    let watchdog!: NodeJS.Timeout;
    const barrier = (async () => {
      this.send({ type: "close" });
      const message = await this.waitFor((candidate) => candidate.type === "closed", "closed", false);
      assert.equal(message.type, "closed");
      await this.#disconnectPromise;
      const exit = await this.#exitPromise;
      assert.deepEqual(exit, { code: 0, signal: null }, this.#label);
      assert.deepEqual(this.#shutdownEvents.slice(-3), ["closed", "disconnect", "exit"], this.#label);
      assert.equal(this.child.connected, false, this.#label);
      assert.equal(this.child.exitCode, 0, this.#label);
    })();
    const timeout = new Promise<never>((_resolve, reject) => {
      watchdog = setTimeout(() => reject(this.failure("cooperative shutdown timed out")), BARRIER_TIMEOUT_MS);
    });
    try {
      await Promise.race([barrier, timeout]);
    } catch (error) {
      if (this.#exit === undefined) await this.forceCleanup();
      throw error;
    } finally {
      clearTimeout(watchdog);
    }
  }

  async forceCleanup(): Promise<FixtureExit> {
    if (this.#exit !== undefined) return this.#exit;
    if (!this.#killRequested) {
      this.#killRequested = true;
      this.child.kill();
    }
    return this.#exitPromise;
  }

  private send(message: ParentMessage): void {
    assert.equal(this.child.connected, true, `${this.#label} IPC must remain connected`);
    this.child.send(message);
  }

  private waitFor(
    predicate: (message: ChildMessage) => boolean,
    label: string,
    bounded = true,
  ): Promise<ChildMessage> {
    const queuedIndex = this.#messages.findIndex(predicate);
    if (queuedIndex >= 0) return Promise.resolve(this.#messages.splice(queuedIndex, 1)[0]!);
    if (this.#exit !== undefined) return Promise.reject(this.failure(`already exited before ${label}`));
    return new Promise<ChildMessage>((resolve, reject) => {
      const waiter: MessageWaiter = { predicate, resolve, reject, timer: undefined };
      if (bounded) {
        waiter.timer = setTimeout(() => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(this.failure(`${label} barrier timed out`));
        }, BARRIER_TIMEOUT_MS);
      }
      this.#waiters.push(waiter);
    });
  }

  private push(message: ChildMessage): void {
    if (message.type === "closed") this.#shutdownEvents.push("closed");
    const index = this.#waiters.findIndex((waiter) => waiter.predicate(message));
    if (index < 0) {
      this.#messages.push(message);
      return;
    }
    const [waiter] = this.#waiters.splice(index, 1);
    if (waiter!.timer !== undefined) clearTimeout(waiter!.timer);
    waiter!.resolve(message);
  }

  private failure(message: string): Error {
    return new Error(`${this.#label} ${message}\n${this.stderr.join("")}`);
  }
}

class DeterministicPrng {
  #state: number;

  constructor(seed: number) {
    this.#state = (seed ^ 0xa5a5_5a5a) >>> 0;
  }

  nextUint32(): number {
    this.#state = (this.#state + 0x6d2b_79f5) >>> 0;
    let value = this.#state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  }
}

interface StressProject {
  root: string;
  projectRoot: string;
  vaultRoot: string;
  request: TrustedProjectBindingRequest;
}

interface Writer {
  worker: number;
  client: FixtureClient;
}

function shuffle<T>(values: readonly T[], prng: DeterministicPrng): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const selected = prng.nextUint32() % (index + 1);
    [result[index], result[selected]] = [result[selected]!, result[index]!];
  }
  return result;
}

function createProject(seed: number): StressProject {
  const root = mkdtempSync(join(tmpdir(), `memory-event-stress-seed-${seed}-`));
  roots.add(root);
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
      clientNamespace: "task-13-stress",
      clientInstanceId: `stress-seed-${seed}`,
      actorRole: "primary",
      generation: 1,
    },
  };
}

function deterministicUuid(seed: number, worker: number, sequence: number, nonce: number): string {
  const prefix = nonce.toString(16).padStart(8, "0");
  const seedGroup = (seed + 1).toString(16).padStart(4, "0");
  const workerGroup = worker.toString(16).padStart(3, "0");
  const sequenceGroup = sequence.toString(16).padStart(3, "0");
  const unique = (seed * EVENTS_PER_SEED + worker * COMMANDS_PER_PROCESS + sequence + 1)
    .toString(16).padStart(12, "0");
  return `${prefix}-${seedGroup}-4${workerGroup}-8${sequenceGroup}-${unique}`;
}

function appendCommand(
  seed: number,
  worker: number,
  sequence: number,
  nonce: number,
): AppendCommandWire {
  const commandId = deterministicUuid(seed, worker, sequence, nonce);
  return {
    commandId,
    idempotencyKey: `stress-${seed}-${worker}-${sequence}-${nonce.toString(16).padStart(8, "0")}`,
    commandType: "task13.stress",
    correlationId: `stress-seed-${seed}-worker-${worker}`,
    agentId: "task-13-stress",
    expectedStreamVersion: String(sequence),
    streamId: `stress-seed-${seed}-stream-${worker}`,
    streamType: "task13-stress-stream",
    events: [{
      eventType: "Task13StressEvent",
      eventSchemaVersion: 1,
      occurredAt: "2026-07-13T00:00:00.000Z",
      visibilityScope: "project",
      sessionId: null,
      parentSessionId: null,
      causationId: null,
      confidence: "high",
      verificationStatus: "verified",
      payload: { seed, worker, sequence, nonce },
      sourceRefs: [],
      evidenceRefs: [],
      evidenceDigests: [],
    }],
    outbox: [],
    publicResponse: { seed, worker, sequence, nonce },
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

async function fullIntegrity(context: ProjectContext) {
  const executor = new ProjectStoreExecutor({
    workerUrl: WORKER_URL,
    context,
    maxPending: DEFAULT_MAX_PENDING,
    requestTimeoutMs: BARRIER_TIMEOUT_MS,
    closeTimeoutMs: BARRIER_TIMEOUT_MS,
    executorLeaseMs: 20_000,
    heartbeatIntervalMs: 5_000,
  });
  await executor.open();
  try {
    return await executor.fullIntegrity();
  } finally {
    await executor.close();
  }
}

function count(database: DatabaseSync, sql: string): number {
  const value = database.prepare(sql).get()?.count;
  assert.ok(typeof value === "number" || typeof value === "bigint", sql);
  return Number(value);
}

function proveHandleRelease(path: string): string[] {
  const renamed: string[] = [];
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    if (!existsSync(candidate)) continue;
    const moved = `${candidate}.handle-release`;
    renameSync(candidate, moved);
    renameSync(moved, candidate);
    renamed.push(candidate);
  }
  assert.ok(renamed.includes(path), "the SQLite database must be renamed and restored");
  return renamed;
}

function inspectStore(
  seed: number,
  project: StressProject,
  route: ProjectStoreRouteWire,
  context: ProjectContext,
  expectedCommandIds: ReadonlySet<string>,
  expectedIdempotencyKeys: ReadonlySet<string>,
  returnedEventIds: ReadonlySet<string>,
  returnedPositions: ReadonlySet<number>,
): string {
  const descriptor = parseProjectDescriptor(JSON.parse(readFileSync(
    join(project.vaultRoot, ".memory-mcp", "project-identity.json"),
    "utf8",
  )) as unknown);
  const manifest = parseStoreManifest(JSON.parse(readFileSync(route.storeManifestPath, "utf8")) as unknown);
  assert.equal(descriptor.projectId, context.binding.projectId, `seed ${seed} descriptor project`);
  assert.equal(descriptor.vaultId, context.binding.vaultId, `seed ${seed} descriptor vault`);
  assert.equal(manifest.projectId, descriptor.projectId, `seed ${seed} manifest project`);
  assert.equal(manifest.vaultId, descriptor.vaultId, `seed ${seed} manifest vault`);
  assert.equal(manifest.storeId, context.binding.storeId, `seed ${seed} manifest store`);
  assert.deepEqual(context.binding.storeRoute, route, `seed ${seed} route identity`);

  const database = new DatabaseSync(route.eventsPath, { readOnly: true });
  try {
    const identityRow = database.prepare(`
      SELECT project_id AS projectId, vault_id AS vaultId, store_id AS storeId
      FROM project_meta WHERE singleton = 1
    `).get() as StoreIdentityWire | undefined;
    assert.ok(identityRow, `seed ${seed} project_meta row`);
    const identity: StoreIdentityWire = {
      projectId: identityRow.projectId,
      vaultId: identityRow.vaultId,
      storeId: identityRow.storeId,
    };
    assert.deepEqual(identity, {
      projectId: descriptor.projectId,
      vaultId: descriptor.vaultId,
      storeId: manifest.storeId,
    }, `seed ${seed} project_meta identity`);

    assert.equal(count(database, "SELECT count(*) AS count FROM events"), EVENTS_PER_SEED);
    assert.equal(count(database, "SELECT count(*) AS count FROM command_dedup"), EVENTS_PER_SEED);
    assert.equal(count(database, "SELECT count(*) AS count FROM streams"), PROCESS_COUNT);
    assert.equal(count(database, "SELECT count(DISTINCT event_id) AS count FROM events"), EVENTS_PER_SEED);
    assert.equal(count(database, "SELECT count(DISTINCT command_id) AS count FROM events"), EVENTS_PER_SEED);
    assert.equal(count(database, "SELECT count(DISTINCT idempotency_key) AS count FROM events"), EVENTS_PER_SEED);
    assert.equal(count(database, "SELECT count(DISTINCT command_id) AS count FROM command_dedup"), EVENTS_PER_SEED);
    assert.equal(count(database, "SELECT count(DISTINCT idempotency_key) AS count FROM command_dedup"), EVENTS_PER_SEED);
    assert.equal(count(database, `
      SELECT count(*) AS count
      FROM command_dedup AS commands
      JOIN events AS effects
        ON effects.project_id = commands.project_id
       AND effects.command_id = commands.command_id
       AND effects.idempotency_key = commands.idempotency_key
      WHERE commands.first_global_position = commands.last_global_position
    `), EVENTS_PER_SEED);

    const positions = database.prepare(
      "SELECT global_position AS position FROM events ORDER BY global_position",
    ).all().map((row) => Number(row.position));
    const exactPositions = Array.from({ length: EVENTS_PER_SEED }, (_, index) => index + 1);
    assert.deepEqual(positions, exactPositions, `seed ${seed} stored positions`);
    assert.deepEqual([...returnedPositions].sort((left, right) => left - right), exactPositions,
      `seed ${seed} returned positions`);

    const streamRows = (database.prepare(`
      SELECT stream_id AS streamId, current_version AS currentVersion
      FROM streams ORDER BY stream_id
    `).all() as Array<{ streamId: string; currentVersion: number | bigint }>).map((row) => ({
      streamId: row.streamId,
      currentVersion: Number(row.currentVersion),
    }));
    assert.deepEqual(
      streamRows,
      Array.from({ length: PROCESS_COUNT }, (_, worker) => ({
        streamId: `stress-seed-${seed}-stream-${worker}`,
        currentVersion: COMMANDS_PER_PROCESS,
      })).sort((left, right) => left.streamId.localeCompare(right.streamId)),
      `seed ${seed} stream heads`,
    );
    const versionRows = database.prepare(`
      SELECT stream_id AS streamId, stream_version AS streamVersion
      FROM events ORDER BY stream_id, stream_version
    `).all() as Array<{ streamId: string; streamVersion: number | bigint }>;
    const versionsByStream = new Map<string, number[]>();
    for (const row of versionRows) {
      const versions = versionsByStream.get(row.streamId) ?? [];
      versions.push(Number(row.streamVersion));
      versionsByStream.set(row.streamId, versions);
    }
    assert.equal(versionsByStream.size, PROCESS_COUNT, `seed ${seed} stream count`);
    for (let worker = 0; worker < PROCESS_COUNT; worker += 1) {
      assert.deepEqual(
        versionsByStream.get(`stress-seed-${seed}-stream-${worker}`),
        Array.from({ length: COMMANDS_PER_PROCESS }, (_, index) => index + 1),
        `seed ${seed} worker ${worker} versions`,
      );
    }

    const storedCommandIds = database.prepare(
      "SELECT command_id AS commandId FROM command_dedup ORDER BY command_id",
    ).all().map((row) => String(row.commandId));
    const storedIdempotencyKeys = database.prepare(
      "SELECT idempotency_key AS idempotencyKey FROM command_dedup ORDER BY idempotency_key",
    ).all().map((row) => String(row.idempotencyKey));
    const storedEventIds = database.prepare(
      "SELECT event_id AS eventId FROM events ORDER BY event_id",
    ).all().map((row) => String(row.eventId));
    assert.deepEqual(storedCommandIds, [...expectedCommandIds].sort(), `seed ${seed} command effects`);
    assert.deepEqual(storedIdempotencyKeys, [...expectedIdempotencyKeys].sort(),
      `seed ${seed} idempotency effects`);
    assert.deepEqual(storedEventIds, [...returnedEventIds].sort(), `seed ${seed} event effects`);

    const eventIdentities = database.prepare(`
      SELECT DISTINCT project_id AS projectId, vault_id AS vaultId, store_id AS storeId
      FROM events
    `).all().map((row) => ({
      projectId: String(row.projectId),
      vaultId: String(row.vaultId),
      storeId: String(row.storeId),
    }));
    assert.deepEqual(eventIdentities, [identity], `seed ${seed} event identity`);
    assert.equal(database.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok",
      `seed ${seed} SQLite integrity`);
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), [],
      `seed ${seed} foreign keys`);
    const terminalHash = database.prepare(`
      SELECT event_hash AS eventHash FROM events ORDER BY global_position DESC LIMIT 1
    `).get()?.eventHash;
    assert.match(String(terminalHash), /^[0-9a-f]{64}$/, `seed ${seed} terminal hash`);
    return String(terminalHash);
  } finally {
    database.close();
  }
}

async function closeAll(clients: readonly FixtureClient[]): Promise<void> {
  const settled = await Promise.allSettled(clients.map(async (client) => client.close()));
  const failures = settled.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (failures.length > 0) throw new AggregateError(failures, "fixture cooperative shutdown failed");
}

async function runSeed(seed: number): Promise<void> {
  const startedAt = Date.now();
  const prng = new DeterministicPrng(seed);
  const project = createProject(seed);
  const launchOrder = shuffle(Array.from({ length: PROCESS_COUNT }, (_, worker) => worker), prng);
  const writers: Writer[] = launchOrder.map((worker) => ({
    worker,
    client: new FixtureClient(`seed ${seed} worker ${worker}`),
  }));
  assert.equal(writers.length, PROCESS_COUNT, `seed ${seed} process count`);

  try {
    await Promise.all(writers.map(async ({ client }) => client.ready()));
    const started: Array<Extract<ChildMessage, { type: "started" }>> = [];
    const first = writers[0]!;
    started.push(await first.client.start({
      kind: "initialize",
      request: { ...project.request, clientInstanceId: `stress-${seed}-${first.worker}` },
      replicaDecision: "initialize-local",
    }));
    started.push(...await Promise.all(writers.slice(1).map(async ({ worker, client }) => client.start({
      kind: "initialize",
      request: { ...project.request, clientInstanceId: `stress-${seed}-${worker}` },
      replicaDecision: "initialize-local",
    }))));
    for (const message of started) assert.equal(message.result.kind, "initialized", `seed ${seed} initialize`);
    const route = started[0]!.result.kind === "initialized" ? started[0]!.result.route : assert.fail();
    for (const message of started) {
      assert.equal(message.result.kind, "initialized");
      if (message.result.kind === "initialized") assert.deepEqual(message.result.route, route, `seed ${seed} route`);
    }

    const commands = new Map<number, AppendCommandWire[]>();
    const expectedCommandIds = new Set<string>();
    const expectedIdempotencyKeys = new Set<string>();
    for (let worker = 0; worker < PROCESS_COUNT; worker += 1) {
      const workerCommands: AppendCommandWire[] = [];
      for (let sequence = 0; sequence < COMMANDS_PER_PROCESS; sequence += 1) {
        const command = appendCommand(seed, worker, sequence, prng.nextUint32());
        workerCommands.push(command);
        assert.equal(expectedCommandIds.has(command.commandId), false, `seed ${seed} command ID collision`);
        assert.equal(expectedIdempotencyKeys.has(command.idempotencyKey), false,
          `seed ${seed} idempotency collision`);
        expectedCommandIds.add(command.commandId);
        expectedIdempotencyKeys.add(command.idempotencyKey);
      }
      commands.set(worker, workerCommands);
    }

    const returnedEventIds = new Set<string>();
    const returnedPositions = new Set<number>();
    for (let sequence = 0; sequence < COMMANDS_PER_PROCESS; sequence += 1) {
      const broadcastOrder = shuffle(writers, prng);
      const round = broadcastOrder.map(({ worker, client }) => {
        const command = commands.get(worker)?.[sequence];
        assert.ok(command, `seed ${seed} worker ${worker} sequence ${sequence} command`);
        return { worker, command, result: client.append(command) };
      });
      const results = await Promise.all(round.map(async (pending) => ({
        ...pending,
        result: await pending.result,
      })));
      assert.equal(results.length, PROCESS_COUNT, `seed ${seed} sequence ${sequence} barrier`);
      for (const { worker, command, result } of results) {
        if (result.type === "error") {
          assert.fail(`seed ${seed} worker ${worker} sequence ${sequence}: ${result.code}: ${result.message}`);
        }
        assert.equal(result.result.deduplicated, false, `seed ${seed} ${command.commandId} dedup`);
        assert.equal(result.result.finalStreamVersion, String(sequence + 1),
          `seed ${seed} worker ${worker} version`);
        assert.equal(result.result.firstGlobalPosition, result.result.lastGlobalPosition,
          `seed ${seed} ${command.commandId} range`);
        assert.equal(result.result.eventIds.length, 1, `seed ${seed} ${command.commandId} event count`);
        assert.deepEqual(result.result.response, command.publicResponse, `seed ${seed} ${command.commandId} response`);
        const eventId = result.result.eventIds[0]!;
        const position = Number(result.result.firstGlobalPosition);
        assert.equal(returnedEventIds.has(eventId), false, `seed ${seed} duplicate event ${eventId}`);
        assert.equal(returnedPositions.has(position), false, `seed ${seed} duplicate position ${position}`);
        returnedEventIds.add(eventId);
        returnedPositions.add(position);
      }
    }
    assert.equal(returnedEventIds.size, EVENTS_PER_SEED, `seed ${seed} returned event count`);
    assert.equal(returnedPositions.size, EVENTS_PER_SEED, `seed ${seed} returned position count`);

    await closeAll(writers.map(({ client }) => client));
    assert.equal(activeClients.size, 0, `seed ${seed} fixture processes must all exit`);
    const context = await contextFor(project.request);
    const report = await fullIntegrity(context);
    const terminalHash = inspectStore(
      seed,
      project,
      route,
      context,
      expectedCommandIds,
      expectedIdempotencyKeys,
      returnedEventIds,
      returnedPositions,
    );
    assert.deepEqual({
      ok: report.ok,
      mode: report.mode,
      projectId: report.projectId,
      storeId: report.storeId,
      firstGlobalPosition: report.firstGlobalPosition,
      lastGlobalPosition: report.lastGlobalPosition,
      eventsVerified: report.eventsVerified,
      streamsVerified: report.streamsVerified,
      commandsVerified: report.commandsVerified,
      terminalEventHash: report.terminalEventHash,
      issues: report.issues,
    }, {
      ok: true,
      mode: "full",
      projectId: context.binding.projectId,
      storeId: context.binding.storeId,
      firstGlobalPosition: "1",
      lastGlobalPosition: String(EVENTS_PER_SEED),
      eventsVerified: EVENTS_PER_SEED,
      streamsVerified: PROCESS_COUNT,
      commandsVerified: EVENTS_PER_SEED,
      terminalEventHash: terminalHash,
      issues: [],
    }, `seed ${seed} full integrity`);
    assert.match(report.schemaFingerprint, /^[0-9a-f]{64}$/, `seed ${seed} schema fingerprint`);

    const renamed = proveHandleRelease(route.eventsPath);
    rmSync(project.root, { recursive: true });
    roots.delete(project.root);
    assert.equal(existsSync(project.root), false, `seed ${seed} temporary root cleanup`);
    const durationMs = Date.now() - startedAt;
    console.log(
      `[event-store-stress] seed=${seed} processes=${PROCESS_COUNT} commandsPerProcess=${COMMANDS_PER_PROCESS}`
      + ` events=${EVENTS_PER_SEED} commands=${EVENTS_PER_SEED} renamed=${renamed.length} durationMs=${durationMs}`,
    );
  } catch (error) {
    console.error(`[event-store-stress] seed=${seed} failed`);
    throw new Error(`event-store stress seed ${seed} failed`, { cause: error });
  }
}

afterEach(async () => {
  const failures: unknown[] = [];
  const leaked = [...activeClients];
  if (leaked.length > 0) failures.push(new Error(`unexpected active stress fixture clients: ${leaked.length}`));
  const cleanup = await Promise.allSettled(leaked.map(async (client) => client.forceCleanup()));
  for (const result of cleanup) {
    if (result.status === "rejected") failures.push(result.reason);
  }
  if (activeClients.size > 0) failures.push(new Error(`stress fixture clients remained active: ${activeClients.size}`));
  for (const root of [...roots]) {
    try {
      rmSync(root, { recursive: true });
      roots.delete(root);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "stress cleanup invariant failed");
});

describe("serialized event-store release stress", { concurrency: false }, () => {
  for (let seed = 0; seed < SEEDS; seed += 1) {
    it(`runs seed ${seed} with 16 processes and 4,000 exact effects`, {
      skip: STRESS_ENABLED ? false : "set MEMORY_EVENT_STRESS=1 to enable the release stress gate",
    }, async () => runSeed(seed));
  }
});
