import { randomBytes, randomUUID } from "node:crypto";
import { MessageChannel, Worker, type MessagePort } from "node:worker_threads";
import type { ProjectContext } from "../../src/orchestrator/identity/contracts.js";
import {
  GitWorkspaceResolutionError,
  GitWorkspaceResolver,
  type GitWorkspaceResolutionReason,
} from "../../src/orchestrator/identity/git-workspace.resolver.js";
import {
  ProjectBindingService,
} from "../../src/orchestrator/identity/project-binding.service.js";
import { WorkerProjectStoreIdentityProbe } from "../../src/orchestrator/runtime/project-store-identity-probe.js";
import { ProjectStoreWorkerBackend } from "../../src/orchestrator/runtime/project-store-worker-backend.js";
import {
  encodeWorkerBinding,
  encodeWorkerBindingAssertion,
} from "../../src/orchestrator/runtime/worker-protocol.js";
import { LifecycleWorkerRuntimeFactory } from "../../src/orchestrator/runtime/lifecycle-worker-runtime.factory.js";
import type {
  LifecycleDurableBoundary,
  LifecycleFaultInjector,
  LifecycleFaultPoint,
} from "../../src/orchestrator/lifecycle/lifecycle-faults.js";
import { ChildTransferRepository } from "../../src/orchestrator/storage/child-transfer.repository.js";
import { EvidenceCoverageRepository } from "../../src/orchestrator/storage/evidence-coverage.repository.js";
import { LifecycleApprovalRepository } from "../../src/orchestrator/storage/lifecycle-approval.repository.js";
import { SessionAuthorityRepository } from "../../src/orchestrator/storage/session-authority.repository.js";
import { SessionLeaseRepository } from "../../src/orchestrator/storage/session-lease.repository.js";
import { SqliteLifecycleProjectionRepository } from "../../src/orchestrator/storage/lifecycle-projection.repository.js";
import { DefaultProjectStoreBootstrapService } from "../../src/orchestrator/storage/project-store-bootstrap.service.js";
import {
  assertLifecycleFixtureChildMessage,
  isLifecycleFixtureParentMessage,
  type LifecycleFixtureBarrierTarget,
  type LifecycleFixtureParentMessage,
} from "../support/lifecycle-fixture-client.js";
import { RecordingGitCommandRunner, type GitProbeDiagnostic } from "../support/recording-git-command-runner.js";

type JsonRecord = Record<string, unknown>;
type FixtureMessage = {
  readonly type?: unknown;
  readonly requestId?: unknown;
  readonly payload?: unknown;
};

type FixtureGitProbeFailure = Error & {
  readonly code: "GIT_PROBE_FAILED";
  readonly gitProbeDiagnostic: GitProbeDiagnostic;
};

function gitProbeFailure(
  phase: GitProbeDiagnostic["phase"],
  runner: RecordingGitCommandRunner,
  failure: unknown,
): FixtureGitProbeFailure | undefined {
  if (failure instanceof GitWorkspaceResolutionError && failure.code === "GIT_PROBE_FAILED") {
    const error = new Error(failure.message) as FixtureGitProbeFailure;
    Object.assign(error, {
      code: "GIT_PROBE_FAILED" as const,
      gitProbeDiagnostic: runner.diagnostic(phase, failure.reason),
    });
    return error;
  }
  if (
    typeof failure === "object" && failure !== null
    && "code" in failure && (failure as { readonly code?: unknown }).code === "GIT_PROBE_FAILED"
  ) {
    const reason = (failure as { readonly reason?: unknown }).reason;
    const error = new Error(errorCode(failure)) as FixtureGitProbeFailure;
    Object.assign(error, {
      code: "GIT_PROBE_FAILED" as const,
      gitProbeDiagnostic: runner.diagnostic(
        phase,
        typeof reason === "string" ? reason as GitWorkspaceResolutionReason : null,
      ),
    });
    return error;
  }
  return undefined;
}

const WORKER_URL = new URL("../../src/workers/project-store.worker.js", import.meta.url);
const RUNTIME_WORKER_URL = new URL("./project-store-lifecycle-runtime-worker.js", import.meta.url);
const childId = randomUUID();
let context: ProjectContext | undefined;
let backend: ProjectStoreWorkerBackend | undefined;
let nestedRuntime: NestedLifecycleRuntime | undefined;
let bindingPayload: JsonRecord | undefined;
let opened = false;
let started = false;
let closing = false;
let closeResourcesPromise: Promise<void> | undefined;
let queue = Promise.resolve();
let directFault: {
  readonly boundary: "ownership-recovery" | "workflow-phase";
  readonly point: LifecycleFaultPoint;
} | undefined;
let responseDeliveryFault: {
  readonly boundary: "response-delivery";
  readonly point: "after-commit-before-response";
} | undefined;
const heldBarriers = new Map<string, HeldBarrier>();
const injectCloseResourcesFailure = process.env.LIFECYCLE_FIXTURE_TEST_CLOSE_FAILURE === "1";

const SQLITE_FAULT_POINTS = new Set<LifecycleFaultPoint>([
  "before-write",
  "after-write-before-commit",
  "after-commit-before-response",
]);

const DIRECT_FAULT_INJECTOR: LifecycleFaultInjector = Object.freeze({
  hit(boundary: LifecycleDurableBoundary, point: LifecycleFaultPoint): void {
    if (directFault === undefined || boundary !== directFault.boundary || point !== directFault.point) return;
    directFault = undefined;
    process.exit(137);
  },
});

const NO_KEY_PROVIDER = Object.freeze({
  currentKey: () => { throw new Error("TASK18_KEY_OPERATION_NOT_REQUIRED"); },
  status: () => "unavailable",
  mac: () => { throw new Error("TASK18_KEY_OPERATION_NOT_REQUIRED"); },
  verify: () => false,
  fingerprint: () => { throw new Error("TASK18_KEY_OPERATION_NOT_REQUIRED"); },
  seal: () => { throw new Error("TASK18_KEY_OPERATION_NOT_REQUIRED"); },
  open: () => { throw new Error("TASK18_KEY_OPERATION_NOT_REQUIRED"); },
});

interface RuntimePending {
  readonly resolve: (value: JsonRecord) => void;
  readonly reject: (error: Error) => void;
}

interface HeldBarrier {
  readonly name: LifecycleFixtureBarrierTarget;
  readonly release: () => void;
  readonly released: Promise<void>;
  reached: boolean;
}

class NestedLifecycleRuntime {
  readonly #worker: Worker;
  readonly #keyPort: MessagePort;
  readonly #pending = new Map<string, RuntimePending>();
  readonly #ready: Promise<void>;
  #resolveReady!: () => void;
  #rejectReady!: (error: Error) => void;
  #isReady = false;
  #closed = false;
  #faultArmed = false;

  constructor(context: ProjectContext, childContext: ProjectContext) {
    const channel = new MessageChannel();
    this.#keyPort = channel.port1;
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    this.#keyPort.on("message", (value: unknown) => {
      const message = record(value);
      if (message.type !== "key-request" || typeof message.requestId !== "string") return;
      send({ type: "key-request", requestId: message.requestId, payload: message.payload });
    });
    this.#worker = new Worker(RUNTIME_WORKER_URL, {
      workerData: { context, childContext, keyPort: channel.port2 },
      transferList: [channel.port2],
    });
    this.#worker.on("message", (value: unknown) => this.#receive(value));
    this.#worker.on("error", (error: Error) => this.#fail(error));
    this.#worker.on("exit", (code) => {
      if (!this.#closed && code !== 0) {
        if (this.#faultArmed) process.exit(code);
        this.#fail(new Error(`TASK18_RUNTIME_EXIT_${code}`));
      }
    });
  }

  async open(): Promise<void> {
    await this.#ready;
    await this.#request("open");
  }

  rootStart(payload: JsonRecord): Promise<JsonRecord> {
    return this.#request("root-start", payload);
  }

  executorRootStart(payload: JsonRecord): Promise<JsonRecord> {
    return this.#request("executor-root-start", payload);
  }

  forkChildren(payload: JsonRecord): Promise<JsonRecord> {
    return this.#request("fork-children", payload);
  }

  recordRootCheckpoint(payload: JsonRecord): Promise<JsonRecord> {
    return this.#request("record-root-checkpoint", payload);
  }

  requestSessionEnd(payload: JsonRecord): Promise<JsonRecord> {
    return this.#request("request-session-end", payload);
  }

  sealSessionEnd(payload: JsonRecord): Promise<JsonRecord> {
    return this.#request("seal-session-end", payload);
  }

  unchangedSessionEnd(payload: JsonRecord): Promise<JsonRecord> {
    return this.#request("unchanged-session-end", payload);
  }

  driveSessionEnd(payload: JsonRecord): Promise<JsonRecord> {
    return this.#request("drive-session-end", payload);
  }

  outboxClaimNext(payload: JsonRecord): Promise<JsonRecord> {
    return this.#request("outbox-claim-next", payload);
  }

  outboxMaterialize(payload: JsonRecord): Promise<JsonRecord> {
    return this.#request("outbox-materialize", payload);
  }

  childWorkflow(payload: JsonRecord): Promise<JsonRecord> {
    return this.#request("child-workflow", payload);
  }

  async fault(payload: JsonRecord): Promise<JsonRecord> {
    const selected = await this.#request("fault", payload);
    this.#faultArmed = true;
    return selected;
  }

  acceptKeyResponse(value: unknown): boolean {
    const message = record(value);
    if (message.type !== "key-response" || typeof message.requestId !== "string") return false;
    this.#keyPort.postMessage(message);
    return true;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#request("close");
    } finally {
      this.#keyPort.close();
      await this.#worker.terminate();
    }
  }

  #request(type: string, payload?: JsonRecord): Promise<JsonRecord> {
    if (this.#closed && type !== "close") return Promise.reject(new Error("TASK18_RUNTIME_CLOSED"));
    const requestId = randomUUID();
    return new Promise<JsonRecord>((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject });
      this.#worker.postMessage({
        type,
        requestId,
        ...(payload === undefined ? {} : { payload }),
      });
    });
  }

  #receive(value: unknown): void {
    const message = record(value);
    if (message.type === "ready") {
      if (!this.#isReady) {
        this.#isReady = true;
        this.#resolveReady();
      }
      return;
    }
    if (typeof message.requestId !== "string") return;
    const pending = this.#pending.get(message.requestId);
    if (pending === undefined) return;
    this.#pending.delete(message.requestId);
    if (message.type === "result") {
      try { pending.resolve(record(message.value)); } catch (error) {
        pending.reject(error instanceof Error ? error : new Error("TASK18_RUNTIME_PROTOCOL_ERROR"));
      }
      return;
    }
    if (message.type === "error" && typeof message.code === "string") {
      pending.reject(new Error(message.code));
      return;
    }
    pending.reject(new Error("TASK18_RUNTIME_PROTOCOL_ERROR"));
  }

  #fail(error: Error): void {
    if (!this.#isReady) this.#rejectReady(error);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

function record(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as JsonRecord;
}

function send(message: JsonRecord): void {
  if (process.send === undefined) throw new Error("IPC_UNAVAILABLE");
  assertLifecycleFixtureChildMessage(message);
  process.send(message);
}

function requestId(message: FixtureMessage): string | undefined {
  return typeof message.requestId === "string" ? message.requestId : undefined;
}

function projectId(message: FixtureMessage): string | null {
  const payload = record(message.payload);
  return typeof payload.projectId === "string" ? payload.projectId : null;
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error
    && typeof (error as { readonly code?: unknown }).code === "string") {
    return (error as { readonly code: string }).code;
  }
  return error instanceof Error && error.message.length > 0 ? error.message : "FIXTURE_ERROR";
}

function gitProbeFailureDiagnostic(error: unknown): GitProbeDiagnostic | undefined {
  if (
    typeof error === "object" && error !== null
    && "gitProbeDiagnostic" in error
  ) {
    return (error as { readonly gitProbeDiagnostic?: GitProbeDiagnostic }).gitProbeDiagnostic;
  }
  return undefined;
}

function error(message: FixtureMessage, code: string, gitProbeDiagnostic?: GitProbeDiagnostic): void {
  const id = requestId(message);
  if (id === undefined) {
    process.exitCode = 1;
    process.disconnect?.();
    return;
  }
  send({
    type: "error",
    requestId: id,
    code,
    message: code,
    ...(code === "GIT_PROBE_FAILED" && gitProbeDiagnostic !== undefined ? { gitProbeDiagnostic } : {}),
  });
}

function selectDirectFault(payload: JsonRecord): {
  readonly boundary: "ownership-recovery" | "workflow-phase";
  readonly point: LifecycleFaultPoint;
} {
  const keys = Object.keys(payload);
  if (keys.length !== 2 || keys.some((key) => key !== "boundary" && key !== "point")) {
    throw new Error("FIXTURE_PROTOCOL_ERROR");
  }
  const boundary = requiredString(payload, "boundary");
  const point = requiredString(payload, "point") as LifecycleFaultPoint;
  if (
    (boundary !== "ownership-recovery" || !SQLITE_FAULT_POINTS.has(point))
    && (boundary !== "workflow-phase" || point !== "after-commit-before-response")
  ) {
    throw new Error("FIXTURE_PROTOCOL_ERROR");
  }
  return Object.freeze({ boundary, point });
}

function selectResponseDeliveryFault(payload: JsonRecord): {
  readonly boundary: "response-delivery";
  readonly point: "after-commit-before-response";
} {
  const keys = Object.keys(payload);
  if (keys.length !== 2 || keys.some((key) => key !== "boundary" && key !== "point")) {
    throw new Error("FIXTURE_PROTOCOL_ERROR");
  }
  const boundary = requiredString(payload, "boundary");
  const point = requiredString(payload, "point");
  if (boundary !== "response-delivery" || point !== "after-commit-before-response") {
    throw new Error("FIXTURE_PROTOCOL_ERROR");
  }
  return Object.freeze({ boundary: "response-delivery", point: "after-commit-before-response" });
}

function isRealStart(payload: JsonRecord): payload is JsonRecord & {
  readonly projectRoot: string;
  readonly vaultRoot: string;
  readonly clientInstanceId: string;
} {
  return typeof payload.projectRoot === "string" && payload.projectRoot.length > 0
    && typeof payload.vaultRoot === "string" && payload.vaultRoot.length > 0
    && typeof payload.clientInstanceId === "string" && payload.clientInstanceId.length > 0;
}

async function establish(
  payload: JsonRecord,
  actorRole: "primary" | "untrusted" = "primary",
  clientInstanceId = payload.clientInstanceId,
): Promise<ProjectContext> {
  if (!isRealStart(payload)) throw new Error("FIXTURE_PROTOCOL_ERROR");
  if (typeof clientInstanceId !== "string" || clientInstanceId.length === 0) {
    throw new Error("FIXTURE_PROTOCOL_ERROR");
  }
  const gitRunner = new RecordingGitCommandRunner();
  const workspaceResolver = new GitWorkspaceResolver(gitRunner);
  try {
    await new DefaultProjectStoreBootstrapService({ workspaceResolver }).initialize({
      projectRoot: payload.projectRoot,
      vaultRoot: payload.vaultRoot,
    });
  } catch (failure) {
    throw gitProbeFailure("bootstrap", gitRunner, failure) ?? failure;
  }
  const service = new ProjectBindingService({
    // Real-process concurrency deliberately starts 32 independent fixtures at
    // once.  Let the identity probe share the fixture's bounded startup budget
    // so host scheduling pressure does not turn a valid store into a false
    // STORE_UNAVAILABLE result at the probe's 10-second production default.
    identityProbe: new WorkerProjectStoreIdentityProbe({
      workerUrl: WORKER_URL,
      requestTimeoutMs: 45_000,
    }),
    workspaceResolver,
  });
  const resolution = await service.establish({
    source: "explicit-cli",
    projectRoot: payload.projectRoot,
    vaultRoot: payload.vaultRoot,
    clientNamespace: "task18-lifecycle-fixture",
    clientInstanceId,
    actorRole,
    generation: 1,
  });
  if (!resolution.ok) {
    const failure = new Error(resolution.message) as Error & { code: string };
    failure.code = resolution.code;
    const reason = resolution.details.reason;
    if (typeof reason === "string") Object.assign(failure, { reason });
    throw gitProbeFailure("binding", gitRunner, failure) ?? failure;
  }
  return {
    binding: resolution.binding,
    workspace: resolution.binding.workspace,
    checkedAt: new Date().toISOString(),
  };
}

function createLifecycleRuntimeFactory(): LifecycleWorkerRuntimeFactory {
  return new LifecycleWorkerRuntimeFactory({
    clock: {
      now: () => new Date().toISOString(),
      nowMs: () => BigInt(Date.now()),
    },
    identitySource: {
      uuid: () => randomUUID(),
      bytes: (length: number) => randomBytes(length),
    },
    integrity: { assertQuickHealthy: () => undefined },
    resumeSourceState: {
      captureCurrent: () => { throw new Error("TASK18_RESUME_SOURCE_NOT_REQUIRED"); },
    },
    checkpointSourceStateProvider: {
      capture: async (active) => ({
        sourceStateScopeVersion: 1,
        workspaceId: active.binding.workspaceId,
        branchRef: null,
        headCommit: null,
        dirtyWorktreeFingerprint: "0".repeat(64),
      }),
      captureForCheckpoint: (active) => ({
        sourceStateScopeVersion: 1,
        workspaceId: active.binding.workspaceId,
        branchRef: null,
        headCommit: null,
        dirtyWorktreeFingerprint: "0".repeat(64),
      }),
      captureForFinalization: (active) => ({
        sourceStateScopeVersion: 1,
        workspaceId: active.binding.workspaceId,
        branchRef: null,
        headCommit: null,
        dirtyWorktreeFingerprint: "0".repeat(64),
      }),
    },
    checkpointSourceStateScopeResolver: {
      resolve: (_connection, active) => ({
        scopeVersion: 1,
        descriptorPath: active.binding.descriptorPath,
        storeRoot: active.binding.storeRoute.storeRoot,
        privateStateRoot: active.binding.projectRoot,
        exactMaterializationTargets: [],
        exactCommittedTempPaths: [],
      }),
    },
    childBindingFingerprint: () => null,
    faultInjector: DIRECT_FAULT_INJECTOR,
    repositories: {
      authority: () => new SessionAuthorityRepository(),
      leases: () => new SessionLeaseRepository(),
      approvals: () => new LifecycleApprovalRepository(),
      transfers: () => new ChildTransferRepository(),
      coverage: (provider) => new EvidenceCoverageRepository(provider),
      projection: (connection) => new SqliteLifecycleProjectionRepository(connection),
    },
    transactionFacades: {
      command: () => ({} as never),
      operational: () => ({ workflows: {}, outbox: {} } as never),
    },
  });
}

async function bind(payload: JsonRecord): Promise<void> {
  if (context !== undefined || started || closing || !isRealStart(payload)) {
    throw new Error("FIXTURE_PROTOCOL_ERROR");
  }
  context = await establish(payload);
  bindingPayload = payload;
}

async function openRuntime(): Promise<void> {
  if (context === undefined || bindingPayload === undefined || opened || closing) {
    throw new Error("FIXTURE_PROTOCOL_ERROR");
  }
  if (bindingPayload.useParentKeyBroker === true) {
    const childContext = await establish(
      bindingPayload,
      "untrusted",
      `${bindingPayload.clientInstanceId}-untrusted-child`,
    );
    nestedRuntime = new NestedLifecycleRuntime(context, childContext);
    await nestedRuntime.open();
  } else {
    backend = new ProjectStoreWorkerBackend({
      selfUrl: WORKER_URL,
      executorLeaseMs: 20_000,
      appendRetryDeadlineMs: 10_000,
      keyProvider: NO_KEY_PROVIDER as never,
      lifecycleRuntimeFactory: createLifecycleRuntimeFactory(),
    });
    await backend.dispatch({
      id: randomUUID(),
      type: "open",
      binding: encodeWorkerBinding(context),
    });
  }
  opened = true;
}

function sendStarted(message: FixtureMessage): void {
  if (context === undefined) {
    send({
      type: "started",
      requestId: requestId(message),
      childId,
      payload: { projectId: projectId(message), childId },
    });
    return;
  }
  send({
    type: "started",
    requestId: requestId(message),
    childId,
    payload: {
      projectId: context.binding.projectId,
      vaultId: context.binding.vaultId,
      storeId: context.binding.storeId,
      eventsPath: context.binding.storeRoute.eventsPath,
    },
  });
}

async function binding(message: FixtureMessage): Promise<void> {
  await bind(record(message.payload));
  send({ type: "result", requestId: requestId(message), operation: "binding", value: { phase: "bound" } });
}

async function open(message: FixtureMessage): Promise<void> {
  if (Object.keys(record(message.payload)).length !== 0) throw new Error("FIXTURE_PROTOCOL_ERROR");
  await openRuntime();
  send({ type: "result", requestId: requestId(message), operation: "open", value: { phase: "open" } });
}

async function start(message: FixtureMessage): Promise<void> {
  if (started || closing || context === undefined || !opened || Object.keys(record(message.payload)).length !== 0) {
    throw new Error("FIXTURE_PROTOCOL_ERROR");
  }
  started = true;
  sendStarted(message);
}

function requiredString(payload: JsonRecord, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) throw new Error("FIXTURE_PROTOCOL_ERROR");
  return value;
}

function requiredInteger(payload: JsonRecord, key: string): number {
  const value = payload[key];
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error("FIXTURE_PROTOCOL_ERROR");
  return Number(value);
}

function exactFields(payload: JsonRecord, expected: readonly string[]): void {
  const keys = Object.keys(payload);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw new Error("FIXTURE_PROTOCOL_ERROR");
  }
}

function barrierTarget(payload: JsonRecord): LifecycleFixtureBarrierTarget {
  const name = requiredString(payload, "name");
  if (name !== "mutation" && name !== "bounded" && name !== "query"
    && name !== "validation" && name !== "fault") {
    throw new Error("FIXTURE_PROTOCOL_ERROR");
  }
  return name;
}

function armBarrier(message: FixtureMessage): void {
  const payload = record(message.payload);
  exactFields(payload, ["name", "barrierId"]);
  const name = barrierTarget(payload);
  const barrierId = requiredString(payload, "barrierId");
  if (heldBarriers.has(barrierId) || [...heldBarriers.values()].some((candidate) => candidate.name === name)) {
    throw new Error("FIXTURE_PROTOCOL_ERROR");
  }
  let resolveRelease!: () => void;
  const released = new Promise<void>((resolve) => { resolveRelease = resolve; });
  heldBarriers.set(barrierId, { name, release: resolveRelease, released, reached: false });
  send({
    type: "result",
    requestId: requestId(message),
    operation: "barrier-arm",
    value: { armed: true, name, barrierId },
  });
}

async function waitAtBarrier(name: LifecycleFixtureBarrierTarget, message: FixtureMessage): Promise<void> {
  const candidate = [...heldBarriers.entries()].find(([, held]) => held.name === name);
  if (candidate === undefined) return;
  const [barrierId, held] = candidate;
  held.reached = true;
  send({ type: "barrier-reached", requestId: requestId(message), payload: { name, barrierId } });
  await held.released;
  heldBarriers.delete(barrierId);
}

function releaseBarrier(message: FixtureMessage): void {
  const payload = record(message.payload);
  exactFields(payload, ["barrierId"]);
  const barrierId = requiredString(payload, "barrierId");
  const held = heldBarriers.get(barrierId);
  if (held === undefined || !held.reached) throw new Error("FIXTURE_PROTOCOL_ERROR");
  held.release();
  send({
    type: "result",
    requestId: requestId(message),
    operation: "barrier-release",
    value: { released: true, barrierId },
  });
}

async function mutation(message: FixtureMessage): Promise<void> {
  if (!started || closing) throw new Error("FIXTURE_PROTOCOL_ERROR");
  await waitAtBarrier("mutation", message);
  const payload = record(message.payload);
  if (nestedRuntime !== undefined) {
    if (payload.operation === "executor-root-start" && responseDeliveryFault !== undefined) {
      const fault = responseDeliveryFault;
      responseDeliveryFault = undefined;
      await nestedRuntime.fault(fault);
    }
    const value = payload.operation === "root-start"
      ? await nestedRuntime.rootStart(payload)
      : payload.operation === "executor-root-start"
        ? await nestedRuntime.executorRootStart(payload)
      : payload.operation === "fork-children"
        ? await nestedRuntime.forkChildren(payload)
        : payload.operation === "record-root-checkpoint"
          ? await nestedRuntime.recordRootCheckpoint(payload)
          : payload.operation === "request-session-end"
            ? await nestedRuntime.requestSessionEnd(payload)
            : payload.operation === "seal-session-end"
              ? await nestedRuntime.sealSessionEnd(payload)
            : payload.operation === "unchanged-session-end"
              ? await nestedRuntime.unchangedSessionEnd(payload)
            : payload.operation === "drive-session-end"
              ? await nestedRuntime.driveSessionEnd(payload)
              : payload.operation === "outbox-claim-next"
                ? await nestedRuntime.outboxClaimNext(payload)
                : payload.operation === "outbox-materialize"
                  ? await nestedRuntime.outboxMaterialize(payload)
                  : payload.operation === "child-workflow"
                    ? await nestedRuntime.childWorkflow(payload)
                    : (() => { throw new Error("FIXTURE_PROTOCOL_ERROR"); })();
    if (responseDeliveryFault !== undefined) {
      responseDeliveryFault = undefined;
      process.exit(137);
    }
    send({ type: "result", requestId: requestId(message), operation: "mutation", value });
    return;
  }
  if (context === undefined || backend === undefined) {
    throw new Error("FIXTURE_PROTOCOL_ERROR");
  }
  if (payload.operation !== "workflow-recovery") {
    throw new Error("FIXTURE_PROTOCOL_ERROR");
  }
  const result = await backend.dispatch({
    id: randomUUID(),
    type: "lifecycle",
    binding: encodeWorkerBindingAssertion(context),
    operation: {
      kind: "fenced",
      operation: "workflow-recovery",
      input: {
        operation: "workflow-recovery",
        workId: requiredString(payload, "workId"),
        ownerId: requiredString(payload, "ownerId"),
        fencingToken: requiredString(payload, "fencingToken"),
        dueBefore: requiredString(payload, "dueBefore"),
        limit: requiredInteger(payload, "limit"),
      },
    },
  });
  send({
    type: "result",
    requestId: requestId(message),
    operation: "mutation",
    value: result as JsonRecord,
  });
}

function closeResources(): Promise<void> {
  if (closeResourcesPromise !== undefined) return closeResourcesPromise;
  closing = true;
  closeResourcesPromise = (async () => {
    const failures: unknown[] = injectCloseResourcesFailure ? [new Error("FIXTURE_CLOSE_FAILURE")] : [];
    const cleanups = await Promise.allSettled([
      Promise.resolve().then(() => nestedRuntime?.close()),
      Promise.resolve().then(() => backend?.close()),
    ]);
    for (const cleanup of cleanups) {
      if (cleanup.status === "rejected") failures.push(cleanup.reason);
    }
    if (failures.length > 0) throw failures[0];
  })();
  return closeResourcesPromise;
}

async function close(message: FixtureMessage): Promise<void> {
  await closeResources();
  send({ type: "close", requestId: requestId(message), childId });
}

async function handle(value: unknown): Promise<void> {
  if (!isLifecycleFixtureParentMessage(value)) {
    error(record(value) as FixtureMessage, "FIXTURE_PROTOCOL_ERROR");
    return;
  }
  const message = record(value) as FixtureMessage;
  const type = message.type;
  if (typeof type !== "string") return error(message, "FIXTURE_PROTOCOL_ERROR");
  if (type === "start") {
    try { await start(message); } catch (failure) { error(message, errorCode(failure), gitProbeFailureDiagnostic(failure)); }
    return;
  }
  if (type === "binding") {
    try { await binding(message); } catch (failure) { error(message, errorCode(failure), gitProbeFailureDiagnostic(failure)); }
    return;
  }
  if (type === "open") {
    try { await open(message); } catch (failure) { error(message, errorCode(failure), gitProbeFailureDiagnostic(failure)); }
    return;
  }
  if (type === "barrier-arm") {
    try { armBarrier(message); } catch (failure) { error(message, errorCode(failure)); }
    return;
  }
  if (type === "close") {
    try { await close(message); } catch (failure) { error(message, errorCode(failure)); }
    return;
  }
  if (!started || closing) return error(message, "FIXTURE_PROTOCOL_ERROR");
  if (type === "mutation") {
    try { await mutation(message); } catch (failure) { error(message, errorCode(failure)); }
    return;
  }
  if (type === "bounded" || type === "query" || type === "validation") {
    try {
      await waitAtBarrier(type, message);
      error(message, "FIXTURE_PROTOCOL_ERROR");
    } catch (failure) {
      error(message, errorCode(failure));
    }
    return;
  }
  if (type === "fault") {
    try {
      await waitAtBarrier("fault", message);
      const payload = record(message.payload);
      if (payload.boundary === "response-delivery") {
        responseDeliveryFault = selectResponseDeliveryFault(payload);
        send({
          type: "result",
          requestId: requestId(message),
          operation: "fault",
          value: { boundary: responseDeliveryFault.boundary, point: responseDeliveryFault.point, armed: true },
        });
        return;
      }
      if (nestedRuntime !== undefined) {
        const selected = await nestedRuntime.fault(payload);
        send({ type: "result", requestId: requestId(message), operation: "fault", value: selected });
        return;
      }
      if (backend !== undefined) {
        directFault = selectDirectFault(record(message.payload));
        send({
          type: "result",
          requestId: requestId(message),
          operation: "fault",
          value: { boundary: directFault.boundary, point: directFault.point, armed: true },
        });
        return;
      }
      if (payload.crash === true) process.exit(137);
    } catch (failure) {
      error(message, errorCode(failure));
      return;
    }
  }
  return error(message, "FIXTURE_PROTOCOL_ERROR");
}

process.on("message", (message: unknown) => {
  if (!isLifecycleFixtureParentMessage(message)) {
    error(record(message) as FixtureMessage, "FIXTURE_PROTOCOL_ERROR");
    return;
  }
  if (message.type === "key-response") {
    nestedRuntime?.acceptKeyResponse(message);
    return;
  }
  if (message.type === "barrier-release") {
    try { releaseBarrier(message); } catch (failure) { error(message, errorCode(failure)); }
    return;
  }
  if (message.type === "close") {
    for (const held of heldBarriers.values()) held.release();
  }
  queue = queue.then(() => handle(message)).catch(() => {
    error({}, "FIXTURE_ERROR");
  });
});

process.on("disconnect", () => {
  const cooperative = closing;
  void closeResources()
    .catch(() => undefined)
    .finally(() => {
      if (!cooperative) process.exitCode = 1;
    });
});

send({ type: "ready", childId, pid: process.pid });
